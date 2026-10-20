"""Web app: log in, upload a video, pick edits, download the result.

Run:  PATRICK_PASSWORD=... python app.py
"""
from __future__ import annotations

import hmac
import json
import os
import re
import secrets
import shutil
import time
import uuid
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

from flask import (Flask, abort, jsonify, redirect, render_template, request,
                   send_file, session, url_for)
from werkzeug.utils import secure_filename

import editor
from editor import AUDIO_EXTS, VIDEO_EXTS, EditError, EditOptions

JOB_ID = re.compile(r"^[0-9a-f]{32}$")


def create_app(password: str, data_dir: Path | None = None, music_dir: Path | None = None,
               max_upload_mb: int = 500, job_ttl_hours: int = 72) -> Flask:
    if not password:
        raise SystemExit("Set PATRICK_PASSWORD first. This app runs ffmpeg on uploads, so it must not be open to everyone.")
    base = Path(__file__).parent
    data_dir = Path(data_dir or os.environ.get("DATA_DIR", base / "data"))
    music_dir = Path(music_dir or os.environ.get("MUSIC_DIR", base / "music"))
    jobs_dir = data_dir / "jobs"
    jobs_dir.mkdir(parents=True, exist_ok=True)
    music_dir.mkdir(parents=True, exist_ok=True)

    app = Flask(__name__)
    app.config.update(
        SECRET_KEY=os.environ.get("PATRICK_SECRET") or secrets.token_hex(32),
        MAX_CONTENT_LENGTH=max_upload_mb * 1024 * 1024,
        SESSION_COOKIE_HTTPONLY=True,
        SESSION_COOKIE_SAMESITE="Lax",
    )
    pool = ThreadPoolExecutor(max_workers=1)  # ffmpeg is heavy; one edit at a time

    # ---------------------------------------------------------------- job storage
    def job_path(job_id: str) -> Path:
        if not JOB_ID.match(job_id):
            abort(404)
        return jobs_dir / job_id

    def write_state(folder: Path, **state) -> None:
        tmp = folder / "job.json.tmp"
        tmp.write_text(json.dumps(state))
        tmp.replace(folder / "job.json")

    def read_state(folder: Path) -> dict:
        try:
            return json.loads((folder / "job.json").read_text())
        except (OSError, json.JSONDecodeError):
            abort(404)

    def save_options(folder: Path, saved: dict) -> None:
        (folder / "options.json").write_text(json.dumps(saved))

    def load_options(folder: Path) -> dict:
        try:
            return json.loads((folder / "options.json").read_text())
        except (OSError, json.JSONDecodeError):
            return {}

    def build_options(folder: Path, saved: dict) -> EditOptions:
        opts = EditOptions(
            trim_start=saved["trim_start"], trim_end=saved["trim_end"], reframe=saved["reframe"],
            audio_mode=saved["audio_mode"], talking_detection=saved["talking_detection"],
            music_volume=saved["music_volume"], speed=saved["speed"])
        if saved.get("music_upload"):
            opts.music = folder / saved["music_upload"]
        elif saved.get("music_choice"):
            opts.music = editor.find_music(saved["music_choice"], music_dir)
        opts.validate()
        return opts

    def link_or_copy(src: Path, dst: Path) -> None:
        try:
            os.link(src, dst)  # instant and uses no extra disk when possible
        except OSError:
            shutil.copy2(src, dst)

    def cleanup_old_jobs() -> None:
        cutoff = time.time() - job_ttl_hours * 3600
        for folder in jobs_dir.iterdir():
            if folder.is_dir() and folder.stat().st_mtime < cutoff:
                shutil.rmtree(folder, ignore_errors=True)

    def run_job(folder: Path, src: Path, opts: EditOptions) -> None:
        write_state(folder, status="processing")
        try:
            result = editor.process(src, folder / "output.mp4", opts)
            write_state(folder, status="done", **result)
        except EditError as e:
            write_state(folder, status="error", error=str(e))
        except Exception:  # never leave a job stuck on "processing"
            app.logger.exception("job failed")
            write_state(folder, status="error", error="Something went wrong while editing.")

    # ---------------------------------------------------------------- auth
    def authed() -> bool:
        return session.get("ok") is True

    @app.before_request
    def require_login():
        if request.endpoint not in ("login", "static", "healthz") and not authed():
            if request.path.startswith("/api/") or request.path.startswith("/jobs/"):
                return jsonify(error="login required"), 401
            return redirect(url_for("login"))

    @app.get("/healthz")
    def healthz():
        return "ok"  # for the host's health check and uptime pingers; reveals nothing

    @app.route("/login", methods=["GET", "POST"])
    def login():
        error = None
        if request.method == "POST":
            if hmac.compare_digest(request.form.get("password", "").encode(), password.encode()):
                session["ok"] = True
                return redirect(url_for("index"))
            time.sleep(1)  # slow down password guessing
            error = "Wrong password"
        return render_template("login.html", error=error)

    @app.post("/logout")
    def logout():
        session.clear()
        return redirect(url_for("login"))

    # ---------------------------------------------------------------- pages + API
    @app.get("/")
    def index():
        return render_template("index.html", tracks=editor.list_music(music_dir),
                               max_mb=max_upload_mb)

    @app.post("/api/jobs")
    def create_job():
        video = request.files.get("video")
        if not video or not video.filename:
            return jsonify(error="Choose a video file first."), 400
        ext = Path(secure_filename(video.filename)).suffix.lower()
        if ext not in VIDEO_EXTS:
            return jsonify(error=f"That file type isn't supported. Use one of: {', '.join(sorted(VIDEO_EXTS))}"), 400

        form = request.form
        try:
            opts = EditOptions(
                trim_start=float(form.get("trim_start") or 0),
                trim_end=float(form["trim_end"]) if form.get("trim_end") else None,
                reframe=form.get("reframe", "fit"),
                audio_mode=form.get("audio_mode", "dog"),
                talking_detection=form.get("talking_detection", "normal"),
                music_volume=float(form.get("music_volume", 35)) / 100,
                speed=float(form.get("speed") or 1),
            )
            opts.validate()
        except (ValueError, EditError) as e:
            return jsonify(error=str(e) if isinstance(e, EditError) else "One of the numbers isn't valid."), 400
        saved = {"trim_start": opts.trim_start, "trim_end": opts.trim_end, "reframe": opts.reframe,
                 "audio_mode": opts.audio_mode, "talking_detection": opts.talking_detection,
                 "music_volume": opts.music_volume, "speed": opts.speed,
                 "music_upload": None, "music_choice": None}

        job_id = uuid.uuid4().hex
        folder = jobs_dir / job_id
        folder.mkdir()
        src = folder / f"input{ext}"
        video.save(src)

        music_file = request.files.get("music_file")
        if music_file and music_file.filename:
            m_ext = Path(secure_filename(music_file.filename)).suffix.lower()
            if m_ext not in AUDIO_EXTS | VIDEO_EXTS:
                shutil.rmtree(folder)
                return jsonify(error="That music file type isn't supported."), 400
            opts.music = folder / f"music{m_ext}"
            music_file.save(opts.music)
            saved["music_upload"] = opts.music.name
        elif form.get("music_choice"):
            opts.music = editor.find_music(form["music_choice"], music_dir)
            if opts.music is None:
                shutil.rmtree(folder)
                return jsonify(error="That music track doesn't exist."), 400
            saved["music_choice"] = form["music_choice"]

        cleanup_old_jobs()
        save_options(folder, saved)
        write_state(folder, status="queued")
        pool.submit(run_job, folder, src, opts)
        return jsonify(id=job_id), 202

    @app.get("/api/jobs/<job_id>")
    def job_status(job_id: str):
        folder = job_path(job_id)
        state = read_state(folder)
        saved = load_options(folder)
        if saved:  # lets the page show which strength was used and whether redo makes sense
            state["mode"], state["level"] = saved["audio_mode"], saved["talking_detection"]
        return jsonify(state)

    @app.post("/api/jobs/<job_id>/redo")
    def redo_job(job_id: str):
        """Run the same edit again from the original upload, with a different talking-detection strength."""
        old = job_path(job_id)
        state, saved = read_state(old), load_options(old)
        level = (request.get_json(silent=True) or {}).get("talking_detection")
        if level not in editor.TALKING_LEVELS:
            return jsonify(error=f"Pick one of: {', '.join(editor.TALKING_LEVELS)}."), 400
        if not saved or saved.get("audio_mode") != "dog":
            return jsonify(error="Redo only works for 'Dog sounds only' edits."), 400
        if state.get("status") != "done":
            return jsonify(error="Wait for the current edit to finish first."), 409
        original = next(old.glob("input.*"), None)
        if original is None:
            return jsonify(error="The original video is gone (old uploads are deleted). Upload it again."), 410

        new_id = uuid.uuid4().hex
        folder = jobs_dir / new_id
        folder.mkdir()
        src = folder / original.name
        link_or_copy(original, src)
        music = saved.get("music_upload")
        if music and Path(music).name == music and (old / music).exists():
            link_or_copy(old / music, folder / music)
        saved = {**saved, "talking_detection": level}
        try:
            opts = build_options(folder, saved)
        except EditError as e:
            shutil.rmtree(folder, ignore_errors=True)
            return jsonify(error=str(e)), 400
        save_options(folder, saved)
        write_state(folder, status="queued")
        pool.submit(run_job, folder, src, opts)
        return jsonify(id=new_id), 202

    @app.get("/jobs/<job_id>/video")
    def job_video(job_id: str):
        folder = job_path(job_id)
        out = folder / "output.mp4"
        if read_state(folder).get("status") != "done" or not out.exists():
            abort(404)
        return send_file(out, mimetype="video/mp4", conditional=True,
                         as_attachment=request.args.get("download") == "1",
                         download_name="patrick-edit.mp4")

    return app


if __name__ == "__main__":
    application = create_app(os.environ.get("PATRICK_PASSWORD", ""))
    application.run(host=os.environ.get("HOST", "127.0.0.1"), port=int(os.environ.get("PORT", 8000)))
