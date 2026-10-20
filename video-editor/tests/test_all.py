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
sys.path.insert(0, str(Path(__file__).resolve().parent))

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

    def make_big(self, name, size):
        path = self.tmp / name
        ffmpeg("-f", "lavfi", "-i", f"testsrc2=size={size}:rate=30:duration=1", "-f", "lavfi", "-i", "sine=frequency=300:duration=1",
               "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", str(path))
        return path

    def test_4k_phone_videos_come_out_as_1080x1920_in_every_reframe_mode(self):
        portrait, landscape = self.make_big("p4k.mp4", "2160x3840"), self.make_big("l4k.mp4", "3840x2160")
        for src in (portrait, landscape):
            for reframe in ("fit", "crop"):
                out, _ = self.run_edit(src, reframe=reframe)
                v = streams(out)["video"]
                self.assertEqual((v["width"], v["height"]), (1080, 1920), f"{src.name} {reframe}")

    def test_reframe_none_still_shrinks_4k_to_at_most_1920_on_the_long_side(self):
        out, _ = self.run_edit(self.make_big("p4k_none.mp4", "2160x3840"), reframe="none")
        v = streams(out)["video"]
        self.assertEqual((v["width"], v["height"]), (1080, 1920))
        out, _ = self.run_edit(self.make_big("l4k_none.mp4", "3840x2160"), reframe="none")
        v = streams(out)["video"]
        self.assertEqual((v["width"], v["height"]), (1920, 1080))

    def test_small_videos_are_not_enlarged_by_the_size_cap(self):
        out, _ = self.run_edit(self.video, reframe="none")        # 1280x720 source
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

    def test_strongest_is_understood_in_plain_english(self):
        o, notes = editor.parse_commands("my clip strongest", self.music_dir)
        self.assertEqual(o.talking_detection, "strongest")
        self.assertIn("Strongest", notes[0])

    def test_nothing_requested_gives_defaults(self):
        o, notes = editor.parse_commands("here's my video lol", self.music_dir)
        self.assertEqual((o.audio_mode, o.music, o.trim_end), ("dog", None, None))
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
        data = self.tmp / f"data-{time.time_ns()}"
        self.app = create_app("secret-pw", data_dir=data, music_dir=self.music_dir)
        self.app.config["TEST_DATA"] = data
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

    def test_healthz_is_public_but_nothing_else_is(self):
        r = self.client.get("/healthz")
        self.assertEqual((r.status_code, r.data), (200, b"ok"))
        self.assertEqual(self.client.get("/").status_code, 302)

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

    # ---- review screen: detection level in status, one-tap redo from the original upload
    def redo(self, job_id, level):
        return self.client.post(f"/api/jobs/{job_id}/redo", json={"talking_detection": level})

    def test_status_reports_mode_and_strength(self):
        self.login()
        job_id = self.upload(talking_detection="gentle").get_json()["id"]
        state = self.wait(job_id)
        self.assertEqual((state["status"], state["mode"], state["level"]), ("done", "dog", "gentle"))
        self.assertIn("audio_note", state)

    def test_redo_makes_a_new_job_and_keeps_the_original(self):
        self.login()
        first = self.upload().get_json()["id"]
        self.assertEqual(self.wait(first)["level"], "normal")
        r = self.redo(first, "strict")
        self.assertEqual(r.status_code, 202, r.data)
        second = r.get_json()["id"]
        self.assertNotEqual(first, second)
        state = self.wait(second)
        self.assertEqual((state["status"], state["level"]), ("done", "strict"))
        self.assertEqual(self.wait(first)["level"], "normal")  # original untouched
        self.assertEqual(self.client.get(f"/jobs/{first}/video").status_code, 200)
        self.assertEqual(self.client.get(f"/jobs/{second}/video").status_code, 200)

    def test_redo_keeps_the_other_settings_and_the_uploaded_music(self):
        self.login()
        first = self.upload(trim_end="3", speed="1.5",
                            music_file=(io.BytesIO(self.song.read_bytes()), "beat.mp3")).get_json()["id"]
        self.wait(first)
        second = self.redo(first, "gentle").get_json()["id"]
        state = self.wait(second)
        self.assertAlmostEqual(state["duration"], 2.0, delta=0.15)  # 3s trimmed, 1.5x faster
        self.assertTrue((self.app.config["TEST_DATA"] / "jobs" / second / "music.mp3").exists())
        out = self.tmp / "redo-music.mp4"
        out.write_bytes(self.client.get(f"/jobs/{second}/video").data)
        self.assertIn("audio", streams(out))

    def test_redo_rejects_bad_requests(self):
        self.login()
        done = self.upload().get_json()["id"]
        self.wait(done)
        self.assertEqual(self.redo(done, "extreme").status_code, 400)
        self.assertEqual(self.client.post(f"/api/jobs/{done}/redo").status_code, 400)  # no level at all
        self.assertEqual(self.redo("0" * 32, "strict").status_code, 404)
        self.assertEqual(self.redo("not-an-id", "strict").status_code, 404)
        muted = self.upload(audio_mode="mute").get_json()["id"]
        self.wait(muted)
        self.assertEqual(self.redo(muted, "strict").status_code, 400)  # redo is only for dog-sounds edits

    def test_redo_is_refused_while_the_first_edit_is_still_running(self):
        self.login()
        folder = self.app.config["TEST_DATA"] / "jobs" / ("a" * 32)
        folder.mkdir(parents=True)
        (folder / "job.json").write_text('{"status": "processing"}')
        (folder / "options.json").write_text(json.dumps({
            "trim_start": 0, "trim_end": None, "reframe": "fit", "audio_mode": "dog", "talking_detection": "normal",
            "music_volume": 0.35, "speed": 1.0, "music_upload": None, "music_choice": None}))
        self.assertEqual(self.redo("a" * 32, "strict").status_code, 409)

    def test_redo_after_the_original_upload_was_deleted(self):
        self.login()
        first = self.upload().get_json()["id"]
        self.wait(first)
        for f in (self.app.config["TEST_DATA"] / "jobs" / first).glob("input.*"):
            f.unlink()
        self.assertEqual(self.redo(first, "strict").status_code, 410)

    def test_redo_requires_login(self):
        self.assertEqual(self.client.post("/api/jobs/" + "a" * 32 + "/redo", json={"talking_detection": "strict"}).status_code, 401)

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

    def test_background_watcher_stays_off_without_email_settings(self):
        import os
        from unittest import mock
        with mock.patch.dict(os.environ, {}, clear=True):
            self.assertFalse(email_worker.email_configured())
            self.assertIsNone(email_worker.start_background())

    def test_skip_typed_into_settings_counts_as_not_set(self):
        import os
        from unittest import mock
        skipped = {"EMAIL_ADDRESS": "skip", "EMAIL_APP_PASSWORD": " SKIP ", "ALLOWED_SENDERS": "none"}
        with mock.patch.dict(os.environ, skipped, clear=True):
            self.assertFalse(email_worker.email_configured())
            self.assertIsNone(email_worker.start_background())
        real = {"EMAIL_ADDRESS": "a@b.com", "EMAIL_APP_PASSWORD": "pw", "ALLOWED_SENDERS": "c@d.com"}
        with mock.patch.dict(os.environ, real, clear=True):
            self.assertTrue(email_worker.email_configured())

    def test_missing_attachment_gets_helpful_reply(self):
        reply = self.handle(self.make_email(attach_video=False))
        self.assertIn("didn't find a video", reply.get_body().get_content())

    def test_unreadable_video_gets_friendly_reply(self):
        m = self.make_email(attach_video=False)
        m.add_attachment(b"junk", maintype="video", subtype="mp4", filename="bad.mp4")
        self.assertIn("couldn't edit", self.handle(m).get_body().get_content())


try:
    from synth import breathing, resample, speech, whine
    HAVE_SYNTH = True
except Exception:  # espeakng-loader not installed
    HAVE_SYNTH = False

import numpy as np
import dogaudio


class DogAudioLogicTests(unittest.TestCase):
    """Pure logic: turning speech probabilities into "which moments get silenced"."""

    def mask(self, pattern, threshold=0.5, min_talk=5):
        probs = np.array([0.9 if c == "T" else 0.1 for c in pattern])
        return dogaudio.talking_mask(probs, threshold, min_talk)

    def test_short_pause_inside_sentence_is_bridged(self):
        # An 11-frame pause is wider than the padding alone can fill (2 x PAD = 8), so this only passes
        # if bridging really runs. The first version of this test used 6 frames and passed with bridging broken.
        m = self.mask("." * 20 + "T" * 10 + "." * 11 + "T" * 10 + "." * 20)
        self.assertTrue(m[30:41].all())
        self.assertEqual(len(dogaudio._runs(m, True)), 1)

    def test_pause_just_over_the_limit_is_not_bridged(self):
        m = self.mask("." * 20 + "T" * 10 + "." * 13 + "T" * 10 + "." * 20)
        self.assertEqual(len(dogaudio._runs(m, True)), 2)

    def test_runs_finds_both_kinds_of_run_including_at_the_edges(self):
        m = np.array([True, True, False, False, False, True, False])
        self.assertEqual([(int(a), int(b)) for a, b in dogaudio._runs(m, True)], [(0, 2), (5, 6)])
        self.assertEqual([(int(a), int(b)) for a, b in dogaudio._runs(m, False)], [(2, 5), (6, 7)])

    def test_long_gap_between_talking_is_kept(self):
        m = self.mask("." * 20 + "T" * 10 + "." * 40 + "T" * 10 + "." * 20)
        self.assertFalse(m[44:56].any())

    def test_one_frame_blip_is_not_talking(self):
        self.assertFalse(self.mask("." * 30 + "T" + "." * 30).any())

    def test_talking_is_padded_on_both_sides(self):
        m = self.mask("." * 30 + "T" * 10 + "." * 30)
        self.assertTrue(m[30 - dogaudio.PAD:40 + dogaudio.PAD].all())
        self.assertFalse(m[:30 - dogaudio.PAD].any())

    def test_talking_at_very_start_and_end_does_not_crash(self):
        m = self.mask("T" * 10 + "." * 30 + "T" * 10)
        self.assertTrue(m[0] and m[-1])

    def test_no_talking_gives_all_clear(self):
        self.assertFalse(self.mask("." * 50).any())

    def test_sensitivity_levels_order(self):
        probs = np.array([0.1] * 20 + [0.4] * 12 + [0.1] * 20 + [0.6] * 12 + [0.1] * 20)
        counts = {k: dogaudio.talking_mask(probs, *lv).sum() for k, lv in dogaudio.LEVELS.items()}
        self.assertLessEqual(counts["gentle"], counts["normal"])
        self.assertLessEqual(counts["normal"], counts["strict"])
        self.assertLessEqual(counts["strict"], counts["strongest"])
        self.assertLess(counts["gentle"], counts["strict"])

    def test_gain_is_smooth_and_bounded(self):
        mask = np.array([False] * 20 + [True] * 20 + [False] * 20)
        g = dogaudio.gain_curve(mask, 60 * dogaudio.FRAME * 44100 // dogaudio.SR, 44100)
        self.assertTrue(((g >= 0) & (g <= 1)).all())
        self.assertAlmostEqual(float(g[0]), 1.0, places=2)
        self.assertLess(float(g[len(g) // 2]), 0.01)
        self.assertLess(float(np.abs(np.diff(g)).max()), 0.001)  # no clicks: gain never jumps


class BuildCommandTests(Base):
    def test_cleaned_audio_and_music_get_the_right_input_numbers(self):
        info = editor.MediaInfo(6.0, True)
        opts = EditOptions(audio_override=Path("clean.wav"), music=Path("song.mp3"))
        cmd, _ = editor.build_command(Path("v.mp4"), Path("o.mp4"), opts, info)
        inputs = [cmd[i + 1] for i, c in enumerate(cmd) if c == "-i"]
        self.assertEqual(inputs, ["v.mp4", "clean.wav", "song.mp3"])
        graph = cmd[cmd.index("-filter_complex") + 1]
        self.assertIn("[1:a]anull[orig]", graph)   # original-audio slot reads the cleaned wav
        self.assertIn("[2:a]volume=", graph)       # music is the third input
        self.assertNotIn("loudnorm", graph)        # dog mode doesn't boost quiet breathing

    def test_memory_savers_are_in_the_command(self):
        # Regression guard: a 4K phone video made the 512 MB free server run out of memory (measured 774 MB before the fix).
        cmd, _ = editor.build_command(Path("v.mp4"), Path("o.mp4"), EditOptions(audio_mode="keep"), editor.MediaInfo(6.0, True))
        graph = cmd[cmd.index("-filter_complex") + 1]
        self.assertTrue(graph.startswith("[0:v]scale='if(gt(iw,ih)"), "must shrink big videos before any other filter")
        i = cmd.index("-i")
        self.assertEqual(cmd[cmd.index("-threads") + 1], "1")           # decoder threads, set before the input
        self.assertLess(cmd.index("-threads"), i)
        self.assertEqual(cmd[cmd.index("-preset") + 1], "ultrafast")    # small encoder memory
        self.assertEqual(cmd[cmd.index("-filter_threads") + 1], "1")

    def test_other_modes_still_normalize_loudness(self):
        graph = editor.build_command(Path("v.mp4"), Path("o.mp4"), EditOptions(audio_mode="keep"),
                                     editor.MediaInfo(6.0, True))[0]
        self.assertIn("loudnorm", graph[graph.index("-filter_complex") + 1])


@unittest.skipUnless(HAVE_SYNTH, "needs: pip install espeakng-loader (test fixtures only)")
class DogAudioEndToEndTests(Base):
    """Synthetic stand-ins for the real thing: whine, talking, breathing, talking, whine."""

    SR = 44100

    @classmethod
    def setUpClass(cls):
        super().setUpClass()
        sp, rate = speech("Hey, can you pass me the remote? I think the game is about to start, did you see that?")
        talk = resample(sp, rate, cls.SR)
        talk = talk / np.abs(talk).max() * 0.5
        parts = [("dog", whine(cls.SR, 2.5)), ("talk", talk), ("dog", breathing(cls.SR, 3.0)),
                 ("talk", talk), ("dog", whine(cls.SR, 2.5))]
        cls.spans, t, chunks = [], 0.0, []
        for kind, x in parts:
            cls.spans.append((kind, t, t + len(x) / cls.SR))
            chunks.append(x)
            t += len(x) / cls.SR
        cls.audio_wav = cls.tmp / "mix.wav"
        dogaudio._write_wav(cls.audio_wav, np.concatenate(chunks), cls.SR)
        cls.mixed = cls.tmp / "mixed.mp4"
        ffmpeg("-f", "lavfi", "-i", f"testsrc=size=640x360:rate=30:duration={t:.2f}", "-i", str(cls.audio_wav),
               "-c:v", "libx264", "-c:a", "aac", "-shortest", str(cls.mixed))
        cls.total = t

    def rms(self, path, a, b):
        x = dogaudio._decode(path, a, b - a, 16000, 1)
        return float(np.sqrt(np.mean(x ** 2))) if len(x) else 0.0

    def run_mode(self, **kw):
        out = self.tmp / f"dog-{time.time_ns()}.mp4"
        return out, editor.process(self.mixed, out, EditOptions(reframe="none", **kw))

    def test_talking_removed_dog_sounds_kept(self):
        out, result = self.run_mode()
        for kind, a, b in self.spans:
            a, b = a + 0.4, b - 0.4  # skip the fade at each edge
            before, after = self.rms(self.mixed, a, b), self.rms(out, a, b)
            if kind == "talk":
                self.assertLess(after, before * 0.05, f"talking at {a:.1f}-{b:.1f}s still audible")
            else:
                self.assertGreater(after, before * 0.7, f"dog sound at {a:.1f}-{b:.1f}s was cut")
        self.assertIn("Removed", result["audio_note"])

    def test_video_with_no_talking_is_left_alone(self):
        calm = self.tmp / "calm.mp4"
        wav = self.tmp / "calm.wav"
        dogaudio._write_wav(wav, np.concatenate([whine(self.SR, 2), breathing(self.SR, 2)]), self.SR)
        ffmpeg("-f", "lavfi", "-i", "testsrc=size=320x240:rate=30:duration=4", "-i", str(wav),
               "-c:v", "libx264", "-c:a", "aac", "-shortest", str(calm))
        out = self.tmp / "calm-out.mp4"
        result = editor.process(calm, out, EditOptions(reframe="none"))
        self.assertIn("No talking found", result["audio_note"])
        self.assertGreater(self.rms(out, 0.2, 3.8), self.rms(calm, 0.2, 3.8) * 0.7)

    def test_trim_only_looks_at_the_trimmed_part(self):
        # keep only the first whine (0-2.5s): there is no talking in that window
        _, result = self.run_mode(trim_start=0, trim_end=2.0)
        self.assertIn("No talking found", result["audio_note"])

    def test_strict_removes_at_least_as_much_as_gentle(self):
        talk = {}
        for level in ("gentle", "normal", "strict", "strongest"):
            wav = self.tmp / f"{level}.wav"
            talk[level] = dogaudio.isolate(self.mixed, wav, 0, self.total, level)["talking_seconds"]
        self.assertLessEqual(talk["gentle"], talk["normal"])
        self.assertLessEqual(talk["normal"], talk["strict"])
        self.assertLessEqual(talk["strict"], talk["strongest"])
        self.assertGreater(talk["normal"], 3)  # actually found the talking

    def test_redo_buttons_change_how_much_talking_is_removed(self):
        app = create_app("pw", data_dir=self.tmp / f"web-{time.time_ns()}", music_dir=self.music_dir)
        client = app.test_client()
        client.post("/login", data={"password": "pw"})

        def wait(job_id):
            for _ in range(240):
                s = client.get(f"/api/jobs/{job_id}").get_json()
                if s["status"] in ("done", "error"):
                    return s
                time.sleep(0.25)
            self.fail("job never finished")

        first = client.post("/api/jobs", data={"video": (io.BytesIO(self.mixed.read_bytes()), "mixed.mp4"),
                                               "talking_detection": "gentle", "reframe": "none"},
                            content_type="multipart/form-data").get_json()["id"]
        gentle = wait(first)
        strict = wait(client.post(f"/api/jobs/{first}/redo", json={"talking_detection": "strict"}).get_json()["id"])
        self.assertEqual((gentle["level"], strict["level"]), ("gentle", "strict"))
        self.assertLessEqual(gentle["talking_seconds"], strict["talking_seconds"])
        self.assertGreater(gentle["talking_seconds"], 3)  # it found the talking at all

    def test_the_analysis_report_shows_the_talking_where_it_really_is(self):
        a = dogaudio.analyze(self.mixed, 0, self.total)
        rows = {r["t"]: r for r in a["per_second"]}
        talk_secs = [t for t in rows if any(k == "talk" and s + 0.5 <= t <= e - 1.5 for k, s, e in self.spans)]
        dog_secs = [t for t in rows if any(k == "dog" and s + 0.5 <= t <= e - 1.5 for k, s, e in self.spans)]
        self.assertTrue(talk_secs and dog_secs)
        import statistics
        # typical (median) values, because the detector has known blips: it lingers just after speech ends, and the
        # synthetic whine at ~18s sounds voice-like to it
        self.assertGreater(statistics.median(rows[t]["p_max"] for t in talk_secs), 0.9)      # talking scores high
        self.assertLess(statistics.median(rows[t]["p_max"] for t in dog_secs), 0.5)          # dog-like sounds score low
        self.assertGreater(a["percent_of_audio_flagged_at"][">=0.12"], a["percent_of_audio_flagged_at"][">=0.7"] - 1)
        self.assertIn("second | p_max", dogaudio.format_analysis(a))

    def test_keep_mode_does_not_touch_audio(self):
        out, result = self.run_mode(audio_mode="keep")
        self.assertNotIn("audio_note", result)
        a, b = self.spans[1][1] + 0.4, self.spans[1][2] - 0.4
        self.assertGreater(self.rms(out, a, b), self.rms(self.mixed, a, b) * 0.5)

    def test_video_without_audio_track_still_works_in_dog_mode(self):
        out = self.tmp / "silent-dog.mp4"
        result = editor.process(self.silent, out, EditOptions())
        self.assertNotIn("audio", streams(out))
        self.assertNotIn("audio_note", result)

    def test_music_fills_the_silence_in_dog_mode(self):
        out, _ = self.run_mode(music=self.song, music_volume=0.5)
        a, b = self.spans[1][1] + 0.4, self.spans[1][2] - 0.4  # during talking: only music should be left
        self.assertGreater(self.rms(out, a, b), 0.005)

    def test_cleanup_files_are_removed(self):
        out, _ = self.run_mode()
        self.assertFalse(out.with_suffix(".dog.wav").exists())



class FakeDrive:
    """In-memory stand-in for GoogleDrive with the same three methods."""

    def __init__(self):
        self.files = []  # dicts: id, name, mimeType, size, modifiedTime, data

    def add(self, name, data, mime="video/mp4", modified="2026-01-01T00:00:00Z", folder="folder"):
        self.files.append({"id": f"id{len(self.files)}", "name": name, "mimeType": mime,
                           "size": str(len(data)), "modifiedTime": modified, "data": data, "folder": folder})

    def list_children(self, folder_id):
        return [{k: v for k, v in f.items() if k not in ("data", "folder")}
                for f in self.files if f["folder"] == folder_id]

    def download(self, file_id, dest):
        dest.write_bytes(next(f["data"] for f in self.files if f["id"] == file_id))

    def upload(self, folder_id, path, name, mimetype):
        self.add(name, path.read_bytes(), mimetype, folder=folder_id)
        return self.files[-1]["id"]

    def trash(self, file_id):
        self.files = [f for f in self.files if f["id"] != file_id]

    def names(self):
        return [f["name"] for f in self.files]

    def get(self, suffix):
        """The uploaded file whose name ends with `suffix`."""
        return next(f for f in self.files if f["name"].endswith(suffix))


class DriveTests(Base):
    def setUp(self):
        import drive_worker
        self.dw = drive_worker
        self.drive = FakeDrive()

    def poll(self, **kw):
        return self.dw.poll_once(self.drive, "folder", self.music_dir, **kw)

    def test_edits_new_video_using_instructions_in_filename(self):
        self.drive.add("zoomies mute trim 1-4.mp4", self.video.read_bytes())
        self.assertEqual(self.poll(), 1)
        self.assertIn("zoomies mute trim 1-4 [edited].mp4", self.drive.names())
        out = self.tmp / "from-drive.mp4"
        out.write_bytes(self.drive.get("[edited].mp4")["data"])
        s = streams(out)
        self.assertEqual(s["video"]["height"], 1920)
        self.assertNotIn("audio", s)  # "mute" in the name removed the audio
        self.assertAlmostEqual(float(s["video"]["duration"]), 3, delta=0.2)

    def test_music_by_name_from_filename(self):
        self.drive.add("dog music: chill.mp4", self.video.read_bytes())
        self.poll()
        out = self.tmp / "music-drive.mp4"
        out.write_bytes(self.drive.get("[edited].mp4")["data"])
        self.assertIn("audio", streams(out))
        notes = self.drive.get("[notes].txt")["data"].decode()  # a note explaining what was done sits beside the video
        self.assertIn("Added music: chill", notes)
        self.assertIn("talking", notes)

    def test_does_not_redo_finished_work(self):
        self.drive.add("a.mp4", self.video.read_bytes())
        self.assertEqual(self.poll(), 1)
        count = len(self.drive.files)
        self.assertEqual(self.poll(), 0)
        self.assertEqual(len(self.drive.files), count)

    def test_ignores_outputs_non_videos_and_files_still_uploading(self):
        self.drive.add("old [edited].mp4", b"x")
        self.drive.add("notes.txt", b"hi", mime="text/plain")
        self.drive.add("fresh.mp4", self.video.read_bytes(), modified="2026-10-08T12:00:10Z")
        now = self.dw.datetime(2026, 10, 8, 12, 0, 20, tzinfo=self.dw.timezone.utc)  # only 10s after upload
        self.assertEqual(self.poll(now=now), 0)
        self.assertEqual(len(self.drive.files), 3)

    def test_bad_video_gets_error_note_and_is_not_retried(self):
        self.drive.add("broken.mp4", b"not a video")
        self.assertEqual(self.poll(), 1)
        self.assertEqual(self.drive.names()[-1], "broken [error].txt")
        self.assertIn("Couldn't read that video", self.drive.files[-1]["data"].decode())
        self.assertEqual(self.poll(), 0)

    def test_oversized_video_rejected_without_downloading(self):
        self.drive.add("huge.mp4", b"x" * 2_000_000)
        self.drive.download = lambda *a: self.fail("should not download")
        self.poll(max_mb=1)
        self.assertEqual(self.drive.names()[-1], "huge [error].txt")

    # ---- results in a separate "finished" folder + an email when each video is done
    def test_results_go_to_the_finished_folder_and_nothing_is_redone(self):
        self.drive.add("zoomies.mp4", self.video.read_bytes())
        self.assertEqual(self.poll(output_folder_id="out"), 1)
        in_folder = [f["name"] for f in self.drive.files if f["folder"] == "folder"]
        out_folder = [f["name"] for f in self.drive.files if f["folder"] == "out"]
        self.assertEqual(in_folder, ["zoomies.mp4"])                       # the input folder stays clean
        self.assertIn("zoomies [edited].mp4", out_folder)
        self.assertIn("zoomies [notes].txt", out_folder)
        self.assertEqual(self.poll(output_folder_id="out"), 0)             # already done: found by looking in the finished folder

    def test_you_get_told_once_per_video_with_a_link(self):
        sent = []
        self.drive.add("a.mp4", self.video.read_bytes())
        self.poll(output_folder_id="out", notify=lambda subject, body: sent.append((subject, body)))
        self.assertEqual(len(sent), 1)
        subject, body = sent[0]
        self.assertIn("a.mp4", subject)
        edited_id = next(f["id"] for f in self.drive.files if f["name"].endswith("[edited].mp4"))
        self.assertIn(f"https://drive.google.com/file/d/{edited_id}/view", body)
        self.assertIn("talking", body)                                      # includes what was removed
        self.poll(output_folder_id="out", notify=lambda *a: sent.append(a))
        self.assertEqual(len(sent), 1)                                      # no repeat email next time

    def test_a_failed_video_also_tells_you(self):
        sent = []
        self.drive.add("broken.mp4", b"not a video")
        self.poll(output_folder_id="out", notify=lambda subject, body: sent.append((subject, body)))
        self.assertEqual(len(sent), 1)
        self.assertIn("couldn't edit", sent[0][0])
        self.assertEqual([f["name"] for f in self.drive.files if f["folder"] == "out"], ["broken [error].txt"])

    def test_a_broken_email_does_not_stop_the_edit(self):
        def boom(subject, body):
            raise RuntimeError("smtp down")
        self.drive.add("b.mp4", self.video.read_bytes())
        self.assertEqual(self.poll(output_folder_id="out", notify=boom), 1)
        self.assertTrue(any(f["name"] == "b [edited].mp4" for f in self.drive.files))

    # ---- "[working]" notes: visible progress, and no crash loops if the server dies mid-edit
    def test_a_working_note_is_there_during_the_edit_and_gone_after(self):
        seen = []
        original_download = self.drive.download

        def spy(file_id, dest):
            seen.append([f["name"] for f in self.drive.files if f["folder"] == "out"])
            original_download(file_id, dest)
        self.drive.download = spy
        self.drive.add("w.mp4", self.video.read_bytes())
        self.poll(output_folder_id="out")
        self.assertEqual(seen, [["w [working].txt"]])                        # marker visible while it works
        self.assertFalse(any("[working]" in f["name"] for f in self.drive.files))   # and cleaned up afterwards

    def test_working_note_is_also_removed_when_the_edit_fails(self):
        self.drive.add("bad.mp4", b"not a video")
        self.poll(output_folder_id="out")
        self.assertEqual([f["name"] for f in self.drive.files if f["folder"] == "out"], ["bad [error].txt"])

    def test_after_a_crash_the_video_is_marked_failed_instead_of_retried_forever(self):
        self.drive.add("big.mp4", self.video.read_bytes())
        self.drive.add("big [working].txt", b"x", mime="text/plain", folder="out")  # left behind by the killed server
        told = []
        self.assertEqual(self.dw.recover_interrupted(self.drive, "out", lambda s, b: told.append((s, b))), 1)
        out = [f["name"] for f in self.drive.files if f["folder"] == "out"]
        self.assertEqual(out, ["big [error].txt"])                           # marker gone, error note in its place
        self.assertIn("ran out of memory", self.drive.get("[error].txt")["data"].decode())
        self.assertEqual(len(told), 1)
        downloads = []
        self.drive.download = lambda *a: downloads.append(a)
        self.assertEqual(self.poll(output_folder_id="out"), 0)               # the next poll skips it: no loop
        self.assertEqual(downloads, [])

    def test_recovery_leaves_finished_videos_alone(self):
        self.drive.add("ok [working].txt", b"x", mime="text/plain", folder="out")
        self.drive.add("ok [edited].mp4", b"video", folder="out")
        self.assertEqual(self.dw.recover_interrupted(self.drive, "out"), 0)  # nothing to report
        self.assertEqual([f["name"] for f in self.drive.files if f["folder"] == "out"], ["ok [edited].mp4"])

    def test_poll_without_a_finished_folder_still_works_beside_the_original(self):
        self.drive.add("c.mp4", self.video.read_bytes())
        self.assertEqual(self.poll(), 1)
        self.assertTrue(all(f["folder"] == "folder" for f in self.drive.files))

    def test_analyze_in_the_name_writes_a_report_and_does_not_edit_the_video(self):
        self.drive.add("clip analyze.mp4", self.video.read_bytes())
        self.assertEqual(self.poll(output_folder_id="out"), 1)
        out = [f["name"] for f in self.drive.files if f["folder"] == "out"]
        self.assertEqual(out, ["clip analyze [analysis].txt"])             # a report only: no [edited] video, no leftover [working]
        report = self.drive.get("[analysis].txt")["data"].decode()
        self.assertIn("second | p_max | p_mean | db", report)
        self.assertIn("Share of the audio that counts as talking", report)
        self.assertGreaterEqual(len([l for l in report.splitlines() if l.strip().endswith("dB") or "s |" in l]), 5)  # ~1 row per second
        self.assertEqual(self.poll(output_folder_id="out"), 0)             # and it's not redone

    def test_the_finished_folder_setting_really_reaches_the_poller(self):
        """Regression: the logic was tested with an explicit folder, but not the step that reads it from Render's settings."""
        import os, threading
        from unittest import mock
        got = {}
        done = threading.Event()

        def fake_poll(drive, folder_id, music_dir, max_mb=500, now=None, output_folder_id=None, notify=None):
            got.update(folder=folder_id, out=output_folder_id)
            done.set()
            return 0

        env = {"GDRIVE_CLIENT_ID": "id", "GDRIVE_CLIENT_SECRET": "secret", "GDRIVE_REFRESH_TOKEN": "tok",
               "GDRIVE_FOLDER_ID": "dropFolderId123456", "GDRIVE_OUTPUT_FOLDER_ID": "finishedFolderId123456", "POLL_SECONDS": "3600"}
        with mock.patch.dict(os.environ, env, clear=True), \
                mock.patch.object(self.dw, "GoogleDrive", lambda *a: FakeDrive()), \
                mock.patch.object(self.dw, "poll_once", fake_poll):
            self.assertIsNotNone(self.dw.start_background())
            self.assertTrue(done.wait(10), "the watcher never polled")
        self.assertEqual(got, {"folder": "dropFolderId123456", "out": "finishedFolderId123456"})

    def test_without_a_finished_folder_setting_results_stay_beside_the_original(self):
        import os, threading
        from unittest import mock
        got, done = {}, threading.Event()

        def fake_poll(drive, folder_id, music_dir, max_mb=500, now=None, output_folder_id=None, notify=None):
            got["out"] = output_folder_id
            done.set()
            return 0

        env = {"GDRIVE_CLIENT_ID": "id", "GDRIVE_CLIENT_SECRET": "secret", "GDRIVE_REFRESH_TOKEN": "tok",
               "GDRIVE_FOLDER_ID": "dropFolderId123456", "POLL_SECONDS": "3600"}
        with mock.patch.dict(os.environ, env, clear=True), \
                mock.patch.object(self.dw, "GoogleDrive", lambda *a: FakeDrive()), \
                mock.patch.object(self.dw, "poll_once", fake_poll):
            self.dw.start_background()
            self.assertTrue(done.wait(10))
        self.assertIsNone(got["out"])

    def test_skip_typed_into_drive_settings_counts_as_not_set(self):
        import os
        from unittest import mock
        skipped = {k: "skip" for k in ("GDRIVE_CLIENT_ID", "GDRIVE_CLIENT_SECRET", "GDRIVE_REFRESH_TOKEN", "GDRIVE_FOLDER_ID")}
        with mock.patch.dict(os.environ, skipped, clear=True):
            self.assertFalse(self.dw.drive_configured())
            self.assertIsNone(self.dw.start_background())

    def test_watcher_stays_off_without_drive_settings(self):
        import os
        from unittest import mock
        with mock.patch.dict(os.environ, {}, clear=True):
            self.assertFalse(self.dw.drive_configured())
            self.assertIsNone(self.dw.start_background())


if __name__ == "__main__":
    unittest.main()
