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
        for level in ("gentle", "normal", "strict"):
            wav = self.tmp / f"{level}.wav"
            talk[level] = dogaudio.isolate(self.mixed, wav, 0, self.total, level)["talking_seconds"]
        self.assertLessEqual(talk["gentle"], talk["normal"])
        self.assertLessEqual(talk["normal"], talk["strict"])
        self.assertGreater(talk["normal"], 3)  # actually found the talking

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

    def add(self, name, data, mime="video/mp4", modified="2026-01-01T00:00:00Z"):
        self.files.append({"id": f"id{len(self.files)}", "name": name, "mimeType": mime,
                           "size": str(len(data)), "modifiedTime": modified, "data": data})

    def list_children(self, folder_id):
        return [{k: v for k, v in f.items() if k != "data"} for f in self.files]

    def download(self, file_id, dest):
        dest.write_bytes(next(f["data"] for f in self.files if f["id"] == file_id))

    def upload(self, folder_id, path, name, mimetype):
        self.add(name, path.read_bytes(), mimetype)

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

    def test_watcher_stays_off_without_drive_settings(self):
        import os
        from unittest import mock
        with mock.patch.dict(os.environ, {}, clear=True):
            self.assertFalse(self.dw.drive_configured())
            self.assertIsNone(self.dw.start_background())


if __name__ == "__main__":
    unittest.main()
