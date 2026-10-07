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
        if request.endpoint not in ("login", "static") and not authed():
            if request.path.startswith("/api/") or request.path.startswith("/jobs/"):
                return jsonify(error="login required"), 401
            return redirect(url_for("login"))

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
                audio_mode=form.get("audio_mode", "keep"),
                music_volume=float(form.get("music_volume", 35)) / 100,
                speed=float(form.get("speed") or 1),
            )
            opts.validate()
        except (ValueError, EditError) as e:
            return jsonify(error=str(e) if isinstance(e, EditError) else "One of the numbers isn't valid."), 400

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
        elif form.get("music_choice"):
            opts.music = editor.find_music(form["music_choice"], music_dir)
            if opts.music is None:
                shutil.rmtree(folder)
                return jsonify(error="That music track doesn't exist."), 400

        cleanup_old_jobs()
        write_state(folder, status="queued")
        pool.submit(run_job, folder, src, opts)
        return jsonify(id=job_id), 202

    @app.get("/api/jobs/<job_id>")
    def job_status(job_id: str):
        return jsonify(read_state(job_path(job_id)))

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
