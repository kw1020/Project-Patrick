# GameSwap

Automatically alternates between **Minecraft Java** and **Schedule I** for a YouTube challenge.
Each game gets 10 minutes of verified gameplay. Only one game runs at a time, and OBS keeps recording the whole way through.

## Where the project is

| Phase | What it adds | Status |
|---|---|---|
| 1 | App window, timer, state machine, OBS scene switching, overlay, sounds, logs | Built (checklist in section 7) |
| **2** | Launching each game and detecting its process and window; Diagnostics | **Built: test it with the checklist in section 8** |
| 3 | Minecraft: open your world, verify gameplay, Save and Quit, normal exit | Not started |
| 4 | Schedule I: load your save, verify gameplay, verified save, normal exit | Not started |
| 5 | Full automatic run, error recovery polish, one-file `.exe` | Not started |

**What Phase 2 does with the real games:**
- **Schedule I:** GameSwap asks Steam to start it (`steam.exe -applaunch 3164500`, Steam's own command), then detects the game's process and window.
- **Minecraft:** GameSwap opens the Minecraft Launcher, **you click PLAY**, and GameSwap detects the game and its window. The official launcher has no supported way to press Play from outside, so Phase 3 will automate that click only after Diagnostics shows how its buttons look on your PC.
- **Loading your save, saving, and quitting are still done by you.** When GameSwap reaches one of those steps, it stops and tells you what to do. You do it, then press **Continue**. GameSwap checks your answer where it can: it refuses to move on until the game's process has really exited. Phases 3–4 automate these steps.

Each game can also be set to **Simulated** (Settings → Games → Game driver), a pretend game for testing the timer, buttons and OBS without starting anything.

The real automation **will not be called working until it has been tested on your PC with both games.**

---

## 1. Install Python (one time)

1. Go to <https://www.python.org/downloads/windows/>.
2. Under **Python 3.12**, click **Windows installer (64-bit)**. Python 3.13 also works.
3. Run the installer. On the first screen, tick **"Add python.exe to PATH"**, then click **Install Now**.
4. When it finishes, click **Close**.

## 2. Get GameSwap

**Option A: download a ZIP (easiest)**

1. Sign in to GitHub and open <https://github.com/kw1020/Project-Patrick>.
2. Click the branch menu (it says `main`) and choose **`claude/nice-edison-d0wkdf`**.
3. Click the green **Code** button, then **Download ZIP**.
4. Unzip it, then move the **`gameswap`** folder to `C:\GameSwap`.

**Option B: git** (if you have Git installed). Open **Command Prompt** and run:

```
cd C:\
git clone -b claude/nice-edison-d0wkdf https://github.com/kw1020/Project-Patrick.git
xcopy /E /I C:\Project-Patrick\gameswap C:\GameSwap
```

## 3. Install GameSwap's libraries (one time)

Double-click **`C:\GameSwap\install.bat`**. It sets up a private Python environment in `C:\GameSwap\.venv` and installs:
PySide6 (the window), obsws-python (OBS control), psutil and pywin32 (finding the games), uiautomation (Diagnostics), pytest and websockets (for the tests).

**Updating from an earlier phase:** download the ZIP again (step 2), copy the new `gameswap` folder over `C:\GameSwap` and choose **Replace the files**, then run `install.bat` again. Your `config.json` isn't in the download, so your settings are kept.

When it says **Done!**, press a key to close it.

If Windows shows *"Windows protected your PC"*, click **More info** and then **Run anyway**. This happens because the `.bat` files were downloaded.

## 4. Run the automatic tests

Double-click **`run_tests.bat`**. Expected result: **every line says PASSED**, ending with something like `62 passed`.
These tests check the timer, every state change, warnings, pause, stop, Emergency Stop, the error handling, and OBS control. The OBS tests use a fake OBS, so your real OBS isn't affected.

## 5. Set up OBS (one time)

You need **OBS Studio 28 or newer**; it has WebSocket built in. Check with **Help → About**.

**a) Turn on WebSocket**
1. **Tools → WebSocket Server Settings**.
2. Tick **Enable WebSocket server**. Leave the port at **4455** and keep **Enable Authentication** ticked.
3. Click **Show Connect Info** and copy the **Server Password**. You'll paste it into GameSwap in step 6.
4. Click **Apply**, then **OK**.

**b) Create three scenes.** The names must match exactly, including the space and capital I.
- `Minecraft`: add your **Game Capture** for Minecraft here in Phase 3. For now it can be empty.
- `Schedule I`: add its **Game Capture** in Phase 4.
- `Switching`: the loading screen shown between games.

**c) Add the overlays.** GameSwap must be running for these addresses to work.
1. In the **Minecraft** scene: **Sources → + → Browser**, name it `GameSwap Timer`.
   URL `http://127.0.0.1:8765/`, Width `520`, Height `160`. Click OK, then drag it into a corner.
2. In the **Schedule I** scene: **Sources → + → Browser → Add Existing → GameSwap Timer**.
3. In the **Switching** scene: **Sources → + → Browser**, name it `GameSwap Switching`.
   URL `http://127.0.0.1:8765/switching`, Width `1920`, Height `1080`.

The timer's background is see-through, so the game shows behind it. It hides itself when nothing is running.
If you prefer plain text, add a **Text (GDI+)** source, tick **Read from file**, and choose `C:\GameSwap\overlay\timer.txt`.

**d) Recording settings for your RTX 4060 / 4060 Ti** (Settings → Output → Output Mode: Advanced → Recording):
- **Recording Format: Hybrid MP4** (OBS 30.2+) or **MKV**. Unlike plain MP4, these keep the recording safe if OBS or Windows crashes mid-challenge.
- **Video Encoder: NVIDIA NVENC H.264** (or HEVC).
- Leave **Pause recording** alone. GameSwap never stops or pauses the recording.

## 6. First start

1. Open OBS.
2. Double-click **`run.bat`**. A black log window opens, then the GameSwap window.
3. Click **Settings → OBS**, paste the password, and click **Test OBS connection**. It should say **"Connected. All scenes found."**
4. Click **Save**.

Your settings live in `C:\GameSwap\config.json`. It includes your OBS password, so don't share that file.

---

## 7. Phase 1 test checklist (do this on your PC)

These tests use the pretend games: **Settings → Games → Game driver → Simulated** for both games.
Set up for quick testing: **Settings → Timer → Play time 1 min 0 s**, Warnings `30, 10`. Then **Save**.
Keep OBS open, with the Switching scene visible in OBS's preview.

| # | Do this | It PASSES if |
|---|---|---|
| T1 | Press **Start** | The log says "Checks passed". OBS starts recording (red dot) if it wasn't already. OBS shows **Switching**, then **Minecraft** once "gameplay verified" appears. |
| T2 | Watch the countdown | It starts at **1:00** only *after* the "gameplay verified" log line. Loading time is not counted. |
| T3 | Wait | Two beeps and an amber timer at **0:30**. Three beeps and a red timer at **0:10**. Ticks at 3, 2, 1. The OBS overlay changes colour at the same moments. |
| T4 | Wait for 0:00 | OBS switches to **Switching** *before* "Saving Minecraft". Then come "saved", "closed", "Switching to Schedule I", and Schedule I's timer starts at 1:00 in the **Schedule I** scene. |
| T5 | Let it run 4 turns | Order is Minecraft, Schedule I, Minecraft, Schedule I. In the Games box, **never two "running" at once**. OBS stays recording the whole time; check the time counter at the bottom of OBS. |
| T6 | Press **Pause** for 20 s, then **Resume** | The timer freezes on the same second, then carries on from there. |
| T7 | Press **Switch Now** mid-turn | It goes straight to saving, then the next game. |
| T8 | Press **Stop** mid-turn | It saves and closes the current game, then says "Stopped". Recording keeps going. |
| T9 | Start, then press **EMERGENCY STOP** | It stops instantly with "EMERGENCY STOP" in red. The game stays "running" because nothing is force-closed. Recording keeps going. |
| T10 | Settings → Games → Minecraft → **Make a step fail: save**. Start and wait for 0:00. | A red box says the save couldn't be confirmed and Minecraft was **NOT closed**. Nothing else happens, even after a few minutes. **"I saved and closed… continue"** refuses while it's still running. Set the failure back to Nothing, press **Retry**, and it continues. |
| T11 | Fail step **ready**, fallback **off**, Loading timeout 30 s | After 30 s it stops and asks you. It does **not** start the timer by itself. |
| T12 | Same, with **fallback on** and a 2 min cycle | After 30 s the timer starts, marked "FALLBACK". The turn ends 2 min after launch. The save is still checked; with this setting it fails and stops, which is correct. |
| T13 | **Test Load** on Minecraft, then **Test Save** | Both say PASSED in the log. Test Save is greyed out until the game is running. |
| T14 | Click into any full-screen game or video, press **Ctrl+Shift+F7**, then **Ctrl+Shift+F9** | The hotkeys pause/resume and emergency-stop without leaving the game. |
| T15 | Close OBS during a run | The log says "Lost connection to OBS" and the app keeps going. Reopen OBS; it reconnects within about 5 s. |
| T16 | Set Play time back to **10 min** and run 2 full turns | Each turn is 10:00 of countdown. Check against your phone's stopwatch. |
| T17 | Task Manager → Details | `python.exe` uses about 100–200 MB of RAM and almost no CPU. |

After testing, send me:
- which tests passed or failed;
- the log file from `C:\GameSwap\logs\` (click **Open log folder**).

---

## 8. Phase 2 test checklist (do this on your PC)

First: **Settings → Games**, set **Game driver → Real game** for both, and leave the paths blank. Keep Play time at **1 min** for now. Close both games and the Minecraft Launcher.

| # | Do this | It PASSES if |
|---|---|---|
| P1 | Click **Diagnostics** | A report opens. **Launcher** shows a path (not NOT FOUND), and Steam shows `App 3164500 installed in: ...` with `Game program: ....exe`. Your worlds are listed. |
| P2 | Press **Start** | The log says "Checks passed". The Minecraft Launcher opens. The status says **"Click PLAY in the Minecraft Launcher"**. OBS shows **Switching**. |
| P3 | Click **PLAY** in the launcher | When Minecraft's window appears, the log says `Minecraft launched: pid ..., window "Minecraft* 1.21..."` with its size. Then a red box says to load your world by hand. The Games box shows `● running v1.21...`. |
| P4 | Open your world, then press **"Minecraft is in gameplay - start timer"** | The 1:00 timer starts and OBS switches to **Minecraft**. |
| P5 | Wait for 0:00 | OBS shows **Switching** and the red box asks you to save and quit by hand. |
| P6 | **Before** quitting, press **"I saved and closed Minecraft - continue"** | It **refuses**: "Minecraft is still running". Nothing else happens. |
| P7 | Use **Save and Quit to Title**, then **Quit Game**. Press Continue. | The log says "Switching to Schedule I", and **Steam starts Schedule I by itself**. Once its window appears, the log shows its pid and window, and the red box asks you to load your save. |
| P8 | Watch the Games box during P7 | Minecraft shows **○ not running** before Schedule I starts. Never two games at once. |
| P9 | Load your save, press Continue, wait for 0:00, then quit Schedule I normally and press Continue | It goes back to Minecraft and opens the launcher again. |
| P10 | During any "Click PLAY" wait, press **EMERGENCY STOP** | It stops at once. Nothing is closed. |
| P11 | Settings → Timer → Launch timeout **20 s**. Start, but **don't** click PLAY. | After 20 s a red box says Minecraft didn't start in time. Retry waits again. |
| P12 | With both games closed, press **Test Load** on Schedule I | Steam starts it, and the log says `Test Load PASSED ... launch and detection passed`. |
| P13 | Start a game yourself, then press **Start** | Start is refused: "... is already running. Save and close it, then press Start." |
| P14 | Open the Minecraft Launcher, then click **Diagnostics** again | The report's **"Launcher accessibility tree"** section is filled in. **Send me this report**; Phase 3's automatic PLAY click is built from it. |

After testing, send me:
1. which P-tests passed or failed;
2. the **Diagnostics report from P14** (in `C:\GameSwap\logs\`). It contains folder paths with your Windows user name, but no passwords or login tokens;
3. today's log file from the same folder.

## 9. What I still need from you for Phases 3–4

Diagnostics answers most setup questions automatically: launcher, version, worlds, Minecraft options, Steam folders, monitors. Please tell me:

**Minecraft**
1. Which world GameSwap should open (as shown in the Diagnostics world list).
2. Is the game modded (Fabric, Forge, etc.) or vanilla?
3. Your Windows **display scale** (Settings → System → Display → Scale), e.g. 100% or 125%.

**Schedule I**
1. Which **save slot** to load, and what the main menu shows (Continue? Load Game? slot names?).
2. **What you see when you save.** Pause the game and tell me exactly which buttons exist, what happens when you press the save button (any message or icon?), and how you quit to the desktop. I won't assume any keyboard shortcut saves. A screenshot of the pause menu helps a lot.
3. Display mode (fullscreen / borderless / windowed) and resolution.

---

## Files

```
gameswap/
  install.bat, run.bat, run_tests.bat   double-click helpers
  requirements.txt                       libraries
  config.json                            your settings (created on first run, not shared)
  logs/                                  one log file per day
  overlay/timer.txt                      plain-text timer for OBS
  gameswap/
    machine.py         the state machine (IDLE, LAUNCHING ... SWITCHING, ERROR, STOPPED)
    drivers/           one driver per game: minecraft.py, schedule1.py, simulated.py
    procmon.py         finds the games' processes and windows (once a second, in the background)
    steam.py           finds Steam, its libraries, and Schedule I's folder from Steam's own files
    winapi.py          small Windows helpers (windows, registry, shortcuts)
    diagnostics.py     the Diagnostics report
    obs.py             OBS WebSocket control (scenes, recording check)
    overlay.py         local web server for the OBS overlays
    overlay_pages/     the overlay pages (timer + switching screen)
    testrun.py         Test Load / Test Save buttons
    hotkeys.py         in-game hotkeys
    sound.py           warning beeps
    ui/                the window and Settings
  tests/               automatic tests (run_tests.bat)
```

## Safety rules built into the state machine

- The timer starts **only after gameplay is verified** several checks in a row. Loading screens never count.
- Any failure (launch, load, readiness, save, exit, timeout) goes to **ERROR** and **waits for you**. It never guesses or carries on by itself.
- After a failed save or exit the game is **left open**. "Continue" is refused until you've closed it yourself.
- **Nothing is ever force-closed.** Emergency Stop just stops GameSwap from doing anything else.
- Before each launch it checks no other game is running: **only one game at a time**.
- GameSwap **never stops or pauses** the OBS recording, and it warns you if the recording stops.
- Timers use Windows' monotonic clock; changing the clock or a daylight-saving jump can't affect them. Time spent paused is never counted.

## Troubleshooting

| Problem | Fix |
|---|---|
| "the Minecraft Launcher wasn't found" | Settings → Games → Minecraft Launcher → Browse to `MinecraftLauncher.exe` (or `C:\XboxGames\Minecraft Launcher\Content\Minecraft.exe`). |
| "Steam wasn't found" / "isn't installed in any Steam library" | Browse to `steam.exe` in Settings, or set Schedule I's Install folder (Steam → Schedule I → Manage → Browse local files). |
| Steam shows a "choose launch option" box | Pick the normal option. Tell me about it, and Phase 4 will handle it. |
| Minecraft's window appears but GameSwap keeps waiting | Run Diagnostics while it's open and send me the "Game processes" part. |
| "Python 3.12 was not found" | Do step 1 again and make sure **Add python.exe to PATH** is ticked. |
| "OBS isn't answering" | Open OBS and check step 5a. |
| "OBS rejected the password" | Copy it again from **Show Connect Info** into Settings → OBS. |
| "OBS has no scene called …" | Rename your OBS scenes to match, or change the names in Settings. |
| The overlay is blank in OBS | GameSwap must be running. Right-click the Browser source → **Refresh**. |
| "Hotkey … is already used" | Another app owns it. Pick another in Settings → Overlay & Hotkeys. |
| "Overlay server couldn't use port 8765" | Change the port in Settings, then update both Browser source URLs. |
