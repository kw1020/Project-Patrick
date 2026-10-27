import pytest
from conftest import FakeObs, Rig, make_cfg

from gameswap.machine import State


def start(r: Rig):
    r.m.start()
    r.m.tick()  # finishes the Start checks


def test_full_cycle_alternates_games_with_ten_minutes_of_verified_gameplay(rig):
    start(rig)
    order, play_times = [], []
    for _ in range(4):
        rig.run_until(State.PLAYING)
        order.append(rig.m.driver.name)
        assert rig.m.driver.check_ready().ready, "timer started before gameplay was verified"
        play_times.append(rig.run_until(State.SAVING))
    assert order == ["Minecraft", "Schedule I", "Minecraft", "Schedule I"]
    for t in play_times:
        assert t == pytest.approx(600, abs=0.15)


def test_loading_screen_is_not_counted_as_play_time(rig):
    start(rig)
    rig.run_until(State.VERIFYING_GAMEPLAY)
    rig.advance(10)  # still on the 20 s loading screen
    assert rig.m.state == State.VERIFYING_GAMEPLAY
    assert rig.m.snapshot().remaining is None
    rig.run_until(State.PLAYING)
    assert rig.m.snapshot().remaining == 600


def test_needs_several_ready_checks_in_a_row():
    cfg = make_cfg(ready_stable_checks=3, ready_poll_seconds=1.0)
    r = Rig(cfg)
    start(r)
    r.run_until(State.VERIFYING_GAMEPLAY)
    waited = r.run_until(State.PLAYING)
    # 20 s loading screen, then 3 good checks one second apart.
    assert 21.5 <= waited <= 23.5


def test_only_one_game_runs_at_a_time(rig):
    start(rig)
    for _ in range(600 * 4 * 10 // 10):
        rig.advance(1, step=0.1)
        running = [d for d in rig.drivers.values() if d.is_running()]
        assert len(running) <= 1


def test_warnings_at_30_and_10_seconds_and_obs_scenes(rig):
    start(rig)
    rig.run_until(State.PLAYING)
    rig.sounds.clear()
    rig.advance(569.9)
    assert "warning" not in rig.sounds
    rig.advance(0.2)
    assert rig.sounds.count("warning") == 1
    assert rig.m.snapshot().warning_level == "warning"
    rig.advance(20)
    assert rig.sounds.count("final") == 1
    assert rig.m.snapshot().warning_level == "final"
    rig.run_until(State.SWITCHING)
    rig.run_until(State.PLAYING)
    assert rig.obs.scenes == ["Switching", "Minecraft", "Switching", "Schedule I"]


def test_obs_switches_to_switching_scene_before_saving(rig):
    start(rig)
    rig.run_until(State.PLAYING)
    rig.run_until(State.SAVING)
    assert rig.obs.scenes[-1] == "Switching"


def test_pause_freezes_the_timer_and_resume_continues(rig):
    start(rig)
    rig.run_until(State.PLAYING)
    rig.advance(100)
    rig.m.pause()
    rig.advance(300)
    assert rig.m.snapshot().remaining == 500
    rig.m.resume()
    rig.advance(100)
    assert rig.m.snapshot().remaining == 400


def test_pause_during_loading_holds_the_state(rig):
    start(rig)
    rig.run_until(State.VERIFYING_GAMEPLAY)
    rig.m.pause()
    rig.advance(400)  # longer than the load timeout, but paused time doesn't count
    assert rig.m.state == State.VERIFYING_GAMEPLAY
    rig.m.resume()
    rig.run_until(State.PLAYING)


def test_switch_now_ends_the_turn_through_the_normal_save(rig):
    start(rig)
    rig.run_until(State.PLAYING)
    rig.advance(5)
    rig.m.switch_now()
    rig.m.tick()
    assert rig.m.state == State.SAVING
    rig.run_until(State.PLAYING)
    assert rig.m.driver.name == "Schedule I"


def test_stop_saves_and_closes_then_stops(rig):
    start(rig)
    rig.run_until(State.PLAYING)
    rig.m.stop()
    rig.run_until(State.STOPPED)
    assert not any(d.is_running() for d in rig.drivers.values())
    assert "saved and closed" in rig.m.message


def test_emergency_stop_halts_everything_and_leaves_the_game_open(rig):
    start(rig)
    rig.run_until(State.PLAYING)
    rig.m.emergency_stop()
    rig.advance(1000)
    assert rig.m.state == State.STOPPED
    assert rig.drivers["minecraft"].is_running()  # never closed by force


@pytest.mark.parametrize("step,where", [
    ("launch", State.LAUNCHING), ("load", State.LOADING), ("ready", State.VERIFYING_GAMEPLAY),
    ("save", State.SAVING), ("exit", State.EXITING),
])
def test_any_failed_step_pauses_in_error_and_does_not_continue(step, where):
    cfg = make_cfg()
    cfg.games["minecraft"].simulation.fail_step = step
    r = Rig(cfg)
    start(r)
    r.run_until(State.ERROR)
    assert r.m._error_from == where
    r.advance(2000)
    assert r.m.state == State.ERROR, "it carried on without you"
    assert not r.drivers["schedule1"].is_running(), "next game launched after a failure"
    if step in ("save", "exit"):
        assert r.drivers["minecraft"].is_running(), "the game was closed after a failed save/exit"


def test_load_timeout_without_fallback_asks_you(rig):
    rig.cfg.games["minecraft"].simulation.ready_after_seconds = 10_000
    start(rig)
    t = rig.run_until(State.ERROR)
    assert t == pytest.approx(rig.cfg.load_timeout, abs=1)
    assert "Continue" in rig.m.error


def test_continue_after_readiness_failure_starts_the_full_timer(rig):
    rig.cfg.games["minecraft"].simulation.ready_after_seconds = 10_000
    start(rig)
    rig.run_until(State.ERROR)
    rig.m.continue_manual()
    assert rig.m.state == State.PLAYING
    assert rig.m.snapshot().remaining == 600


def test_continue_after_save_failure_refuses_while_game_still_running():
    cfg = make_cfg()
    cfg.games["minecraft"].simulation.fail_step = "save"
    r = Rig(cfg)
    start(r)
    r.run_until(State.ERROR)
    r.m.continue_manual()
    assert r.m.state == State.ERROR  # Minecraft still open, so it must not move on
    r.drivers["minecraft"]._running = False  # you saved and quit it yourself
    r.m.continue_manual()
    assert r.m.state == State.SWITCHING
    r.run_until(State.PLAYING)
    assert r.m.driver.name == "Schedule I"


def test_retry_after_fixing_the_problem():
    cfg = make_cfg()
    cfg.games["minecraft"].simulation.fail_step = "save"
    r = Rig(cfg)
    start(r)
    r.run_until(State.ERROR)
    cfg.games["minecraft"].simulation.fail_step = ""
    r.m.retry()
    r.run_until(State.SWITCHING)


def test_fallback_cycle_ends_twelve_minutes_after_launch_and_still_saves():
    cfg = make_cfg(fallback_cycle_enabled=True, load_timeout=240)
    cfg.games["minecraft"].simulation.ready_after_seconds = 10_000
    r = Rig(cfg)
    start(r)
    t_loading = r.run_until(State.PLAYING)
    assert t_loading == pytest.approx(240, abs=0.5)  # the load timeout
    assert r.m.unverified
    assert r.m.snapshot().remaining == 480  # 12 min from launch, minus the 4 min of loading
    t_playing = r.run_until(State.SAVING)
    assert t_loading + t_playing == pytest.approx(720, abs=0.5)


def test_fallback_still_stops_if_the_save_cant_be_verified():
    cfg = make_cfg(fallback_cycle_enabled=True)
    g = cfg.games["minecraft"].simulation
    g.fail_step = "ready"
    r = Rig(cfg)
    start(r)
    r.run_until(State.ERROR)  # the simulated save refuses: never verified in gameplay
    assert r.m._error_from == State.SAVING
    assert r.drivers["minecraft"].is_running()


def test_start_refused_if_a_game_is_already_running(rig):
    rig.drivers["schedule1"]._running = True
    start(rig)
    assert rig.m.state == State.IDLE
    assert "already running" in rig.m.message or "Can't start" in rig.m.message


def test_start_refused_when_obs_scene_missing():
    r = Rig(make_cfg(), obs=FakeObs(problems=["OBS has no scene called 'Switching'."]))
    start(r)
    assert r.m.state == State.IDLE
    assert r.obs.scenes == []


def test_game_crash_mid_turn_pauses_for_you(rig):
    start(rig)
    rig.run_until(State.PLAYING)
    rig.advance(50)
    rig.drivers["minecraft"]._running = False
    rig.advance(1.5)
    assert rig.m.state == State.ERROR
    assert "closed or crashed" in rig.m.error


def test_timeout_on_a_hanging_step():
    cfg = make_cfg(save_timeout=30)
    r = Rig(cfg)
    start(r)
    r.run_until(State.PLAYING)
    r.run_until(State.SAVING)
    # Simulate a save that never returns by swapping in a job that never finishes.
    from concurrent.futures import Future
    r.m._job = Future()
    t = r.run_until(State.ERROR)
    assert t == pytest.approx(30, abs=0.3)
    assert r.drivers["minecraft"].is_running()
