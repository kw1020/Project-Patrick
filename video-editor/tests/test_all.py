"""Run with:  .venv/bin/python -m unittest discover -s tests -v   (needs ffmpeg installed)"""
import io
import json
import subprocess
import sys
import tempfile
import time
import unittest
from email.message import EmailMessage
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import editor
import email_worker
from app import create_app
from editor import EditError, EditOptions


def ffmpeg(*args):
    subprocess.run(["ffmpeg", "-y", "-hide_banner", "-loglevel", "error", *args], check=True)


def streams(path):
    out = subprocess.run(["ffprobe", "-v", "error", "-print_format", "json", "-show_streams", str(path)],
                         capture_output=True, text=True, check=True).stdout
    return {s["codec_type"]: s for s in json.loads(out)["streams"]}


class Base(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls._tmp = tempfile.TemporaryDirectory()
        cls.tmp = Path(cls._tmp.name)
        cls.video = cls.tmp / "in.mp4"      # 6s landscape with audio
        cls.silent = cls.tmp / "silent.mp4"  # 3s, no audio track
        cls.song = cls.tmp / "chill.mp3"     # 2s, shorter than the video so looping is exercised
        ffmpeg("-f", "lavfi", "-i", "testsrc=size=1280x720:rate=30:duration=6",
               "-f", "lavfi", "-i", "sine=frequency=300:duration=6", "-c:v", "libx264", "-c:a", "aac", "-shortest", str(cls.video))
        ffmpeg("-f", "lavfi", "-i", "testsrc=size=640x480:rate=24:duration=3", "-c:v", "libx264", str(cls.silent))
        ffmpeg("-f", "lavfi", "-i", "sine=frequency=520:duration=2", str(cls.song))
        cls.music_dir = cls.tmp / "music"
        cls.music_dir.mkdir()
        (cls.music_dir / "chill.mp3").write_bytes(cls.song.read_bytes())

    @classmethod
    def tearDownClass(cls):
        cls._tmp.cleanup()


class EditorTests(Base):
    def run_edit(self, src, **kw):
        out = self.tmp / f"out-{time.time_ns()}.mp4"
        result = editor.process(src, out, EditOptions(**kw))
        return out, result

    def test_default_is_vertical_1080x1920_h264_aac(self):
        out, r = self.run_edit(self.video)
        s = streams(out)
        self.assertEqual((s["video"]["width"], s["video"]["height"]), (1080, 1920))
        self.assertEqual((s["video"]["codec_name"], s["audio"]["codec_name"]), ("h264", "aac"))
        self.assertAlmostEqual(r["duration"], 6, delta=0.1)

    def test_crop_mode_is_also_vertical(self):
        out, _ = self.run_edit(self.video, reframe="crop")
        self.assertEqual(streams(out)["video"]["height"], 1920)

    def test_reframe_none_keeps_shape(self):
        out, _ = self.run_edit(self.video, reframe="none")
        self.assertEqual(streams(out)["video"]["width"], 1280)

    def test_trim_and_speed_change_length(self):
        _, r = self.run_edit(self.video, trim_start=1, trim_end=5, speed=2.0)
        self.assertAlmostEqual(r["duration"], 2.0, delta=0.1)

    def test_trim_end_past_video_is_clamped(self):
        _, r = self.run_edit(self.video, trim_start=4, trim_end=999)
        self.assertAlmostEqual(r["duration"], 2.0, delta=0.1)

    def test_mute_without_music_has_no_audio_track(self):
        out, _ = self.run_edit(self.video, audio_mode="mute")
        self.assertNotIn("audio", streams(out))

    def test_music_is_looped_to_cover_whole_video(self):
        out, r = self.run_edit(self.video, audio_mode="mute", music=self.song)
        s = streams(out)
        self.assertIn("audio", s)
        self.assertAlmostEqual(float(s["audio"]["duration"]), r["duration"], delta=0.3)

    def test_music_mixed_over_original_audio_with_denoise(self):
        out, _ = self.run_edit(self.video, audio_mode="denoise", music=self.song)
        self.assertIn("audio", streams(out))

    def test_silent_video_with_music_gets_audio(self):
        out, _ = self.run_edit(self.silent, music=self.song)
        self.assertIn("audio", streams(out))

    def test_silent_video_without_music_stays_silent(self):
        out, _ = self.run_edit(self.silent)
        self.assertNotIn("audio", streams(out))

    def test_bad_options_rejected(self):
        for bad in ({"speed": 5}, {"audio_mode": "x"}, {"trim_start": 3, "trim_end": 2}, {"music_volume": 2}):
            with self.assertRaises(EditError, msg=str(bad)):
                self.run_edit(self.video, **bad)

    def test_trim_start_past_end_rejected(self):
        with self.assertRaises(EditError):
            self.run_edit(self.video, trim_start=60)

    def test_non_video_file_gives_friendly_error(self):
        junk = self.tmp / "junk.mp4"
        junk.write_text("not a video")
        with self.assertRaises(EditError):
            self.run_edit(junk)


class CommandParsingTests(Base):
    def test_full_request(self):
        o, notes = editor.parse_commands("Please mute it, trim 0:03-0:15, music: chill, speed 1.5", self.music_dir)
        self.assertEqual((o.audio_mode, o.trim_start, o.trim_end, o.speed), ("mute", 3, 15, 1.5))
        self.assertEqual(o.music.name, "chill.mp3")
        self.assertEqual(len(notes), 4)

    def test_nothing_requested_gives_defaults(self):
        o, notes = editor.parse_commands("here's my video lol", self.music_dir)
        self.assertEqual((o.audio_mode, o.music, o.trim_end), ("keep", None, None))
        self.assertEqual(notes, [])

    def test_unknown_music_is_reported_not_crashed(self):
        o, notes = editor.parse_commands("music: nonexistent", self.music_dir)
        self.assertIsNone(o.music)
        self.assertIn("chill", notes[0])

    def test_music_name_cannot_escape_library(self):
        self.assertIsNone(editor.find_music("../in", self.music_dir))
        self.assertIsNone(editor.find_music("/etc/passwd", self.music_dir))


class WebAppTests(Base):
    def setUp(self):
        self.app = create_app("secret-pw", data_dir=self.tmp / f"data-{time.time_ns()}", music_dir=self.music_dir)
        self.client = self.app.test_client()

    def login(self):
        self.client.post("/login", data={"password": "secret-pw"})

    def upload(self, **fields):
        data = {"video": (io.BytesIO(self.video.read_bytes()), "dog.mp4"), **fields}
        return self.client.post("/api/jobs", data=data, content_type="multipart/form-data")

    def wait(self, job_id):
        for _ in range(120):
            s = self.client.get(f"/api/jobs/{job_id}").get_json()
            if s["status"] in ("done", "error"):
                return s
            time.sleep(0.25)
        self.fail("job never finished")

    def test_requires_login(self):
        self.assertEqual(self.client.get("/").status_code, 302)
        self.assertEqual(self.client.post("/api/jobs").status_code, 401)
        self.assertEqual(self.client.get("/api/jobs/" + "a" * 32).status_code, 401)

    def test_refuses_to_start_without_password(self):
        with self.assertRaises(SystemExit):
            create_app("")

    def test_wrong_password_rejected(self):
        r = self.client.post("/login", data={"password": "nope"})
        self.assertIn(b"Wrong password", r.data)
        self.assertEqual(self.client.get("/").status_code, 302)

    def test_full_flow_upload_edit_download(self):
        self.login()
        self.assertEqual(self.client.get("/").status_code, 200)
        r = self.upload(audio_mode="mute", music_choice="chill", trim_end="4")
        self.assertEqual(r.status_code, 202, r.data)
        job_id = r.get_json()["id"]
        state = self.wait(job_id)
        self.assertEqual(state["status"], "done", state)
        self.assertAlmostEqual(state["duration"], 4, delta=0.1)
        video = self.client.get(f"/jobs/{job_id}/video")
        self.assertEqual((video.status_code, video.mimetype), (200, "video/mp4"))
        out = self.tmp / "dl.mp4"
        out.write_bytes(video.data)
        self.assertEqual(streams(out)["video"]["height"], 1920)
        self.assertIn("attachment", self.client.get(f"/jobs/{job_id}/video?download=1").headers["Content-Disposition"])

    def test_bad_inputs_get_clear_errors(self):
        self.login()
        self.assertEqual(self.client.post("/api/jobs", data={}).status_code, 400)
        bad_ext = self.client.post("/api/jobs", data={"video": (io.BytesIO(b"x"), "evil.exe")},
                                   content_type="multipart/form-data")
        self.assertEqual(bad_ext.status_code, 400)
        self.assertEqual(self.upload(speed="9").status_code, 400)
        self.assertEqual(self.upload(trim_start="abc").status_code, 400)
        self.assertEqual(self.upload(music_choice="../../etc/passwd").status_code, 400)

    def test_corrupt_video_ends_in_error_state_not_stuck(self):
        self.login()
        r = self.client.post("/api/jobs", data={"video": (io.BytesIO(b"not a video"), "bad.mp4")},
                             content_type="multipart/form-data")
        state = self.wait(r.get_json()["id"])
        self.assertEqual(state["status"], "error")

    def test_job_ids_are_validated(self):
        self.login()
        self.assertEqual(self.client.get("/api/jobs/../../etc/passwd").status_code, 404)
        self.assertEqual(self.client.get("/jobs/zzz/video").status_code, 404)
        self.assertEqual(self.client.get("/jobs/" + "0" * 32 + "/video").status_code, 404)


class EmailTests(Base):
    ALLOWED = {"krew252@gmail.com"}

    def make_email(self, sender="Krew <krew252@gmail.com>", subject="dog video", body="", auth=True,
                   attach_video=True, attach_music=False):
        m = EmailMessage()
        m["From"], m["To"], m["Subject"], m["Message-ID"] = sender, "patrick@example.com", subject, "<abc@x>"
        if auth:
            m["Authentication-Results"] = "mx.google.com; dkim=pass header.i=@gmail.com; spf=pass"
        m.set_content(body or "hi")
        if attach_video:
            m.add_attachment(self.video.read_bytes(), maintype="video", subtype="mp4", filename="dog.mp4")
        if attach_music:
            m.add_attachment(self.song.read_bytes(), maintype="audio", subtype="mpeg", filename="beat.mp3")
        return m

    def handle(self, msg, **kw):
        with tempfile.TemporaryDirectory() as d:
            reply = email_worker.handle_message(msg, Path(d), self.music_dir, self.ALLOWED, **kw)
            if reply is not None:  # read attachments before the temp dir disappears
                reply.attachment_bytes = [p.get_payload(decode=True) for p in reply.iter_attachments()]
            return reply

    def test_edits_and_replies_with_video(self):
        reply = self.handle(self.make_email(subject="mute and add music", body="mute\nmusic: chill\ntrim 0-3"))
        self.assertEqual(reply["To"], "krew252@gmail.com")
        self.assertEqual(reply["In-Reply-To"], "<abc@x>")
        self.assertEqual(len(reply.attachment_bytes), 1)
        body = reply.get_body().get_content()
        self.assertIn("Removed the original audio", body)
        self.assertIn("Added music: chill", body)
        out = self.tmp / "emailed.mp4"
        out.write_bytes(reply.attachment_bytes[0])
        self.assertAlmostEqual(float(streams(out)["video"]["duration"]), 3, delta=0.2)

    def test_attached_music_file_is_used(self):
        reply = self.handle(self.make_email(body="mute", attach_music=True))
        self.assertIn("music file you attached", reply.get_body().get_content())

    def test_stranger_gets_no_reply(self):
        self.assertIsNone(self.handle(self.make_email(sender="evil@spam.com")))

    def test_forged_sender_without_dkim_or_spf_is_ignored(self):
        self.assertIsNone(self.handle(self.make_email(auth=False)))

    def test_missing_attachment_gets_helpful_reply(self):
        reply = self.handle(self.make_email(attach_video=False))
        self.assertIn("didn't find a video", reply.get_body().get_content())

    def test_unreadable_video_gets_friendly_reply(self):
        m = self.make_email(attach_video=False)
        m.add_attachment(b"junk", maintype="video", subtype="mp4", filename="bad.mp4")
        self.assertIn("couldn't edit", self.handle(m).get_body().get_content())


if __name__ == "__main__":
    unittest.main()
