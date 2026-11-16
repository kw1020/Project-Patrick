"""Tests for autopost.py. Run: python -m unittest test_autopost.py (no Google account needed)."""
import datetime as dt
import json
import shutil
import subprocess
import tempfile
import unittest
from pathlib import Path
from unittest import mock
from zoneinfo import ZoneInfo

import autopost

DEN = ZoneInfo("America/Denver")
CFG = {"timezone": "America/Denver", "post_time": "17:00", "min_lead_minutes": 90}


def at(y, m, d, h, mi=0):
    return dt.datetime(y, m, d, h, mi, tzinfo=DEN)


class Slots(unittest.TestCase):
    def test_today_when_far_enough_ahead(self):
        s = autopost.next_slots([], CFG, at(2026, 11, 16, 9), 3)
        self.assertEqual([x.date().day for x in s], [16, 17, 18])
        self.assertEqual(s[0].hour, 17)

    def test_tomorrow_when_too_close(self):
        s = autopost.next_slots([], CFG, at(2026, 11, 16, 16), 1)
        self.assertEqual(s[0].date(), dt.date(2026, 11, 17))

    def test_continues_after_last_scheduled(self):
        posted = [{"publish_at": at(2026, 11, 20, 17).isoformat()}]
        s = autopost.next_slots(posted, CFG, at(2026, 11, 16, 9), 2)
        self.assertEqual([x.date().day for x in s], [21, 22])

    def test_dst_keeps_local_post_time(self):
        cfg = dict(CFG)
        s = autopost.next_slots([], cfg, at(2027, 3, 13, 9), 2)  # DST starts 14 Mar 2027
        self.assertEqual([x.hour for x in s], [17, 17])

    def test_buffer_count(self):
        now = at(2026, 11, 18, 12)
        posted = [{"publish_at": at(2026, 11, d, 17).isoformat()} for d in (16, 17, 18, 19, 20)]
        self.assertEqual(autopost.days_buffered(posted, now), 3)


class Checks(unittest.TestCase):
    def test_meta(self):
        self.assertEqual(autopost.validate_meta({"title": "ok"}), [])
        self.assertTrue(autopost.validate_meta({"title": "x" * 101}))
        self.assertTrue(autopost.validate_meta({"title": "a <b>"}))
        self.assertTrue(autopost.validate_meta({}))

    def test_shipped_meta_files_are_valid(self):
        for f in (Path(__file__).parent / "meta").glob("*.json"):
            self.assertEqual(autopost.validate_meta(json.loads(f.read_text())), [], f.name)

    def test_short_shape(self):
        self.assertEqual(autopost.short_problems({"width": 1080, "height": 1920, "seconds": 66}), [])
        self.assertTrue(autopost.short_problems({"width": 1920, "height": 1080, "seconds": 66}))
        self.assertTrue(autopost.short_problems({"width": 1080, "height": 1920, "seconds": 200}))

    def test_live(self):
        today = dt.date(2026, 11, 16)
        self.assertTrue(autopost.is_live({"enabled": True}, today))
        self.assertFalse(autopost.is_live({"enabled": False}, today))
        self.assertFalse(autopost.is_live({"enabled": True, "start_date": "2026-11-23"}, today))
        self.assertTrue(autopost.is_live({"enabled": True, "start_date": "2026-11-16"}, today))


@unittest.skipUnless(shutil.which("ffmpeg"), "needs ffmpeg")
class EndToEnd(unittest.TestCase):
    """add -> run with a fake YouTube client: checks scheduling, the request body and bookkeeping."""

    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp())
        src = Path(__file__).parent
        shutil.copy(src / "channels.json", self.tmp)
        self.base = mock.patch.object(autopost, "BASE", self.tmp)
        self.base.start()
        self.vid = self.tmp / "v.mp4"
        subprocess.run(["ffmpeg", "-v", "error", "-f", "lavfi", "-i", "color=c=orange:s=270x480:d=2",
                        "-pix_fmt", "yuv420p", str(self.vid)], check=True)
        self.meta = src / "meta" / "01-emu-war.json"

    def tearDown(self):
        self.base.stop()
        shutil.rmtree(self.tmp)

    def test_add_then_run(self):
        autopost.main(["add", str(self.vid), "--meta", str(self.meta)])
        autopost.main(["add", str(self.vid), "--meta", str(self.meta)])
        self.assertEqual(len(autopost.queue_items("history")), 2)

        bodies = []
        fake = mock.MagicMock()

        def insert(part, body, media_body, notifySubscribers):
            bodies.append(body)
            req = mock.MagicMock()
            req.next_chunk.return_value = (None, {"id": f"VID{len(bodies)}"})
            return req
        fake.videos.return_value.insert.side_effect = insert
        with mock.patch.object(autopost, "youtube", return_value=fake):
            autopost.main(["run"])

        posted = autopost.read_posted("history")
        self.assertEqual([p["video_id"] for p in posted], ["VID1", "VID2"])
        days = [dt.datetime.fromisoformat(p["publish_at"]).date() for p in posted]
        self.assertEqual((days[1] - days[0]).days, 1)
        for b in bodies:
            self.assertEqual(b["status"]["privacyStatus"], "private")
            self.assertTrue(b["status"]["publishAt"].endswith("Z"))
            self.assertFalse(b["status"]["selfDeclaredMadeForKids"])
            self.assertEqual(b["snippet"]["categoryId"], "27")
        self.assertEqual(autopost.queue_items("history"), [])
        self.assertEqual(len(list((self.tmp / "done" / "history").iterdir())), 2)

        # channel2 is off: nothing should happen for it, and a later run continues the calendar
        autopost.main(["add", str(self.vid), "--meta", str(self.meta)])
        with mock.patch.object(autopost, "youtube", return_value=fake):
            autopost.main(["run"])
        posted = autopost.read_posted("history")
        self.assertEqual(dt.datetime.fromisoformat(posted[2]["publish_at"]).date(), days[1] + dt.timedelta(days=1))
        self.assertFalse((self.tmp / "state" / "channel2" / "posted.json").exists())

    def test_rejects_horizontal(self):
        wide = self.tmp / "w.mp4"
        subprocess.run(["ffmpeg", "-v", "error", "-f", "lavfi", "-i", "color=c=blue:s=480x270:d=1",
                        "-pix_fmt", "yuv420p", str(wide)], check=True)
        with self.assertRaises(SystemExit):
            autopost.main(["add", str(wide), "--meta", str(self.meta)])


if __name__ == "__main__":
    unittest.main()
