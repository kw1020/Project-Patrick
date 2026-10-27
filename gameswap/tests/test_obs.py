import time

import pytest

pytest.importorskip("websockets")
pytest.importorskip("obsws_python")

from fake_obs_server import FakeObsServer  # noqa: E402

from gameswap.config import ObsConfig  # noqa: E402
from gameswap.obs import ObsController  # noqa: E402

SCENES = ["Switching", "Minecraft", "Schedule I"]


@pytest.fixture
def server():
    s = FakeObsServer()
    yield s
    s.close()


def controller(server, **kw) -> ObsController:
    cfg = ObsConfig(host="127.0.0.1", port=server.port, password=kw.pop("password", "secret"), **kw)
    return ObsController(cfg)


def wait_for(cond, timeout=5.0):
    end = time.monotonic() + timeout
    while time.monotonic() < end:
        if cond():
            return True
        time.sleep(0.05)
    return False


def test_preflight_connects_finds_scenes_and_starts_recording(server):
    ctl = controller(server)
    assert ctl.preflight(SCENES) == []
    assert server.recording
    assert ctl.status.connected
    ctl.close()


def test_preflight_reports_missing_scene(server):
    server.scenes = ["Minecraft", "Switching"]
    ctl = controller(server)
    problems = ctl.preflight(SCENES)
    assert len(problems) == 1 and "Schedule I" in problems[0]
    assert not server.recording, "it must not start recording when it can't run"
    ctl.close()


def test_preflight_wont_start_recording_if_not_allowed(server):
    ctl = controller(server, start_recording_on_start=False)
    problems = ctl.preflight(SCENES)
    assert problems and "isn't recording" in problems[0]
    assert not server.recording
    ctl.close()


def test_wrong_password_is_explained(server):
    ctl = controller(server, password="wrong")
    problems = ctl.preflight(SCENES)
    assert problems and "password" in problems[0].lower()
    ctl.close()


def test_obs_not_running_is_explained():
    ctl = ObsController(ObsConfig(host="127.0.0.1", port=1, password="x"))
    problems = ctl.preflight(SCENES)
    assert problems and "Is OBS open" in problems[0]


def test_scene_switching_in_background_and_never_stops_recording(server):
    ctl = controller(server)
    ctl.start()
    assert ctl.preflight(SCENES) == []
    for scene in ["Switching", "Minecraft", "Switching", "Schedule I"]:
        ctl.set_scene(scene)
        assert wait_for(lambda: server.current == scene), f"OBS never showed {scene}"
    assert server.recording
    assert "StopRecord" not in server.requests
    ctl.close()


def test_status_poll_notices_recording_stopped(server, caplog):
    ctl = controller(server)
    ctl.POLL_SECONDS = 0.1
    ctl.start()
    assert ctl.preflight(SCENES) == []
    server.recording = False  # someone pressed Stop Recording in OBS
    assert wait_for(lambda: not ctl.status.recording)
    assert any("RECORDING STOPPED" in r.message for r in caplog.records)
    ctl.close()


def test_password_never_written_to_logs(server, caplog):
    caplog.set_level("DEBUG")
    ctl = controller(server)
    ctl.preflight(SCENES)
    ctl.close()
    assert "secret" not in caplog.text


def test_recording_clock_for_youtube_chapters(server):
    ctl = controller(server)
    ctl.POLL_SECONDS = 0.1
    ctl.start()
    assert ctl.preflight(SCENES) == []
    assert wait_for(lambda: ctl.recording_seconds() is not None)
    assert 61.4 <= ctl.recording_seconds() < 64
    ctl.close()


def test_test_run_switches_scenes_without_recording(server):
    ctl = controller(server, test_run_no_recording=True)
    ctl.start()
    assert ctl.preflight(SCENES) == []
    ctl.set_scene("Switching")
    assert wait_for(lambda: server.current == "Switching")
    assert not server.recording and "StartRecord" not in server.requests
    ctl.close()
