from pathlib import Path

from fakes import MC_CMDLINE, FakeProc, FakeSystem, minecraft_game, minecraft_launcher, window

from gameswap import steam
from gameswap.drivers.minecraft import (
    LauncherMatcher, MinecraftGameMatcher, list_worlds, minecraft_args, pick_minecraft_window,
)
from gameswap.drivers.schedule1 import UnityExeMatcher, pick_unity_window

LIBRARYFOLDERS = r'''
"libraryfolders"
{
	"0"
	{
		"path"		"C:\\Program Files (x86)\\Steam"
		"label"		""
		"apps"
		{
			"228980"		"441000000"
		}
	}
	"1"
	{
		"path"		"D:\\SteamLibrary"
		"apps"
		{
			"3164500"		"2000000000"
		}
	}
}
'''

MANIFEST = r'''
"AppState"
{
	"appid"		"3164500"
	"name"		"Schedule I"
	"installdir"		"Schedule I"
	"StateFlags"		"4"
}
'''


def test_parse_vdf_reads_steam_files():
    data = steam.parse_vdf(LIBRARYFOLDERS)
    assert data["libraryfolders"]["1"]["path"] == r"D:\SteamLibrary"
    assert data["libraryfolders"]["1"]["apps"]["3164500"] == "2000000000"
    assert steam.parse_vdf(MANIFEST)["AppState"]["installdir"] == "Schedule I"


def make_steam(tmp_path: Path, game_in_second_library=True):
    steam_dir = tmp_path / "Steam"
    lib2 = tmp_path / "SteamLibrary"
    (steam_dir / "steamapps").mkdir(parents=True)
    (lib2 / "steamapps").mkdir(parents=True)
    vdf = LIBRARYFOLDERS.replace(r"C:\\Program Files (x86)\\Steam", str(steam_dir).replace("\\", "\\\\"))
    vdf = vdf.replace(r"D:\\SteamLibrary", str(lib2).replace("\\", "\\\\"))
    (steam_dir / "steamapps" / "libraryfolders.vdf").write_text(vdf)
    lib = lib2 if game_in_second_library else steam_dir
    (lib / "steamapps" / "appmanifest_3164500.acf").write_text(MANIFEST)
    game = lib / "steamapps" / "common" / "Schedule I"
    (game / "Schedule I_Data").mkdir(parents=True)
    (game / "Schedule I.exe").write_bytes(b"MZ")
    (game / "UnityCrashHandler64.exe").write_bytes(b"MZ")
    (steam_dir / "steam.exe").write_bytes(b"MZ")
    return steam_dir, game


def test_finds_schedule1_in_any_steam_library(tmp_path):
    steam_dir, game = make_steam(tmp_path)
    assert steam.find_install_dir(steam_dir, "3164500") == game
    assert steam.find_install_dir(steam_dir, "999") is None


def test_unity_exe_skips_crash_handler(tmp_path):
    _, game = make_steam(tmp_path)
    assert [p.name for p in steam.unity_game_exes(game)] == ["Schedule I.exe"]


def test_minecraft_args_keeps_version_and_folder_but_never_the_token():
    info = minecraft_args(MC_CMDLINE)
    assert info == {"version": "1.21.4", "game_dir": r"C:\Users\krew\AppData\Roaming\.minecraft"}
    assert "SECRET" not in repr(info)
    assert minecraft_args(["javaw.exe", "-jar", "some-other-app.jar"]) is None


def test_matchers_only_accept_their_game():
    mc, launcher = MinecraftGameMatcher(), LauncherMatcher()
    assert mc.wants_name("javaw.exe") and not mc.wants_name("chrome.exe")
    assert mc.inspect(minecraft_game()) is not None
    assert mc.inspect(FakeProc("javaw.exe", ["javaw.exe", "-jar", "intellij.jar"])) is None
    assert launcher.inspect(minecraft_launcher()) is not None
    assert launcher.inspect(FakeProc("Minecraft.exe", exe=r"C:\Games\SomethingElse\Minecraft.exe")) is None
    assert launcher.inspect(FakeProc("Minecraft.exe", exe=r"C:\XboxGames\Minecraft Launcher\Content\Minecraft.exe"))


def test_unity_matcher_needs_the_exact_exe(tmp_path):
    _, game = make_steam(tmp_path)
    m = UnityExeMatcher(steam.unity_game_exes(game))
    assert m.wants_name("schedule i.exe")
    assert m.inspect(FakeProc("Schedule I.exe", exe=str(game / "Schedule I.exe")))
    assert m.inspect(FakeProc("Schedule I.exe", exe=r"C:\Other\Schedule I.exe")) is None


def test_window_picking():
    mc = pick_minecraft_window([window("", "GLFW30"), window("Minecraft* 1.21.4 - Singleplayer", "GLFW30")])
    # Minecraft 26.3 and later make their window with SDL3 instead of GLFW.
    assert pick_minecraft_window([window("Minecraft* 26.3 - Singleplayer", "SDL_app")]).class_name == "SDL_app"
    assert pick_minecraft_window([window("", "SunAwtFrame", w=50, h=50),
                                  window("", "SDL_app")]).class_name == "SDL_app"
    assert mc.title.startswith("Minecraft")
    assert pick_minecraft_window([window("Minecraft Launcher", "Chrome_WidgetWin_1")]) is None
    assert pick_unity_window([window("Schedule I", "UnityWndClass")]).class_name == "UnityWndClass"


def test_monitor_finds_games_and_inspects_each_process_once():
    system = FakeSystem()
    mon = system.monitor()
    mon.register("minecraft", MinecraftGameMatcher())
    other = system.add(FakeProc("javaw.exe", ["javaw", "-jar", "x.jar"]))
    game = system.add(minecraft_game())
    for _ in range(5):
        mon.scan_now()
    found = mon.get("minecraft")
    assert [p.pid for p in found] == [game.pid]
    assert found[0].extra["version"] == "1.21.4"
    assert found[0].windows[0].class_name == "GLFW30"
    assert game.inspected == 1 and other.inspected == 1, "command lines should be read once, not every scan"
    system.remove(game)
    mon.scan_now()
    assert mon.get("minecraft") == []


def test_list_worlds(tmp_path):
    for name in ("Challenge World", "Old"):
        (tmp_path / "saves" / name).mkdir(parents=True)
        (tmp_path / "saves" / name / "level.dat").write_bytes(b"")
    (tmp_path / "saves" / "not a world").mkdir()
    assert list_worlds(tmp_path) == ["Challenge World", "Old"]


def test_store_launcher_found_from_windows_start_apps_list():
    from gameswap.drivers.minecraft import pick_launcher_app_id

    out = ('[{"Name":"Minecraft","AppID":"Microsoft.MinecraftUWP_8wekyb3d8bbwe!App"},'
           '{"Name":"Minecraft Launcher","AppID":"Microsoft.4297127D64EC6_8wekyb3d8bbwe!Minecraft"}]')
    assert pick_launcher_app_id(out) == "Microsoft.4297127D64EC6_8wekyb3d8bbwe!Minecraft"
    single = '{"Name":"Minecraft Launcher","AppID":"Some.Package_abc!Launcher"}'
    assert pick_launcher_app_id(single) == "Some.Package_abc!Launcher"
    assert pick_launcher_app_id('{"Name":"Minecraft","AppID":"Microsoft.MinecraftUWP!App"}') == "", "not Bedrock"
    assert pick_launcher_app_id("") == "" and pick_launcher_app_id("not json") == ""
