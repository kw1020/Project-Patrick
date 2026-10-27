# GameSwap

Automatically alternates between **Minecraft Java** and **Schedule I** for a YouTube challenge.
Each game gets 10 minutes of verified gameplay. Only one game runs at a time, and OBS keeps recording the whole way through.

## Where the project is

| Phase | What it adds | Status |
|---|---|---|
| 1 | App window, timer, state machine, OBS scene switching, overlay, sounds, logs | Built (checklist in section 7) |
| 2 | Launching each game and detecting its process and window; Diagnostics | Built (checklist in section 8) |
| 3 | Minecraft: open your world, verify gameplay, verified save, normal exit, world backups | Built (checklist in section 9) |
| 4 | Schedule I: Steam launch, save prompt, save verified on disk, normal exit, save backups | Built (checklist in section 10) |
| **5** | Automatic launch retry, stop after N turns, resume after a crash, session log + YouTube chapters, `GameSwap.exe`, Windows test run | **Built: test it with the checklist in section 12** |

**What GameSwap does with the real games now:**

**Minecraft (Phase 3, automatic).** Every step is checked against something Minecraft itself reports:

| Step | What GameSwap does | How it knows it worked |
|---|---|---|
| Launch | Opens the launcher and presses your world's **Quick Play** entry, or **PLAY** if that entry isn't there. It uses Windows' accessibility system, like a screen reader: no mouse moves, no keys. If it can't find exactly one match, it asks you to click. | Minecraft's process and window appear. |
| Open world | Quick Play opens your world directly. Otherwise the status asks you to open it (Singleplayer → your world → Play Selected World), and GameSwap notices by itself when you do. | Minecraft locks that world's folder (`session.lock`), and GameSwap checks it's your world, not another one. |
| Timer starts | Waits for real gameplay. | The world is open, Minecraft's log says **"*you* joined the game"**, the terrain wait (3 s) has passed, and Minecraft is the active window. |
| Save | Presses **Esc**, but only after confirming Minecraft's window is in front. Never more than twice. | Minecraft's log says **"Saving and pausing game..."**, which it writes when it saves the world on pause. |
| Quit | Asks the window to close, the same as clicking its **X**. Minecraft then saves and unloads the world itself. | The log shows **"Stopping server"** and **"Saving worlds"**, the world folder unlocks, and the Java process exits. |
| Backup | Zips your world into `C:\GameSwap\backups\` before every Start, keeping the last 5. | The zip appears there. |

GameSwap doesn't click Minecraft's "Save and Quit to Title" button. Its position changes with Minecraft version, GUI scale and window size, and GameSwap can't see the screen to confirm it, which would break the no-blind-input rule. Closing the window makes Minecraft run its own save-and-unload, and the log confirms it.

**Schedule I (Phase 4).** Schedule I has **no save key and no pause-menu save**. It saves only when you **sleep in your bed** or use the **save device** by a property's door, and **quitting does not save**. So GameSwap never pretends it can save for you; it makes sure *your* save really happened:

| Step | Who does it | How GameSwap knows it worked |
|---|---|---|
| Launch | GameSwap, through Steam (`steam.exe -applaunch 3164500`) | The game's process and window appear. |
| Load your save | **You:** Continue → your save. The status shows which save to pick. | (see Ready) |
| Ready | **You** press **I'm in the game (Ready)** or **Ctrl+Shift+F10** once you can play. | Schedule I has no known reliable "loaded" signal yet, so GameSwap asks instead of guessing. Each time you press Ready it records the game's `Player.log` lines, so we can make this automatic later (section 11). |
| Save | **You**, when **SAVE NOW** appears (60 s before the end, with a sound and in the OBS overlay). The game stays on screen in OBS while you walk to save. | GameSwap watches your save slot on disk. The files must be **newly written** (within the last 90 s), **stop changing**, and **read back as valid save data**. |
| Quit | GameSwap, **only after a verified save**: it closes the window, the same as clicking its X. | The process exits. If Schedule I asks "are you sure?", you confirm it; GameSwap never clicks it for you. |
| Backup | GameSwap zips your save slot before every Start. | The zip appears in `C:\GameSwap\backups\`. |

If no save is verified when the turn ends, GameSwap **keeps waiting** (up to 5 minutes) with SAVE NOW showing. After that it stops and asks you, and it **never closes Schedule I without a verified save**.

> **Important:** anything you do in Schedule I *after* your save isn't kept, because quitting doesn't save. Save near the end of the turn, then just wait out the last seconds.

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

Double-click **`run_tests.bat`**. Expected result: **every line says PASSED**, ending with something like `104 passed`.
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

> **Since Phase 3, Minecraft's steps are automatic,** so P2–P7 below no longer match what Minecraft does; use section 9 for Minecraft instead. P1 and P8–P14 still apply, and so does the Schedule I part of P7–P9.

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

## 9. Phase 3 test checklist: Minecraft (do this on your PC)

**Before you start:** make your own copy of your world as well, for extra safety. In Minecraft: Singleplayer → select the world → **Edit** → **Make Backup**. GameSwap also zips it before every Start.

Setup: **Settings → Games → Minecraft**:
- Game driver **Real game**.
- **World to open:** pick your world from the list.
- **Press Quick Play / PLAY for me** ticked.

Set Schedule I's driver to **Simulated** so you can test Minecraft on its own. Play time **1 min**. Close Minecraft and the launcher. Open your world once by hand first, so it's in the launcher's Quick Play list, then quit Minecraft.

| # | Do this | It PASSES if |
|---|---|---|
| M1 | Press **Start** | The log shows "Backing up Minecraft world" and a new zip appears in `C:\GameSwap\backups\`. The launcher opens and the log says **Pressed Quick Play '...'** (or **Pressed PLAY**). Minecraft starts **without you touching anything**. |
| M2 | Watch the countdown | It stays at `--:--` through the Mojang screen and the "Loading terrain" screen. It starts at **1:00** only when you can see and move in the world. *Tell me how many seconds after you could move it started.* |
| M3 | If M1 said "Pressed PLAY" | The status says "open your world". Open it yourself; the timer starts by itself, with no Continue. |
| M4 | Open a **different** world instead (repeat M3 with the wrong one) | A red box says the wrong world was opened. The timer does not start. |
| M5 | Let it reach 0:00 while you walk around | OBS shows Switching, the pause menu appears, and the log says **"Minecraft confirmed 'Saving and pausing game' (Esc press 1)"**. Then Minecraft closes and the log says **"world saved and unloaded ('Saving worlds')"**. The Games box shows "not running" **before** the next game starts. |
| M6 | Repeat, but have your **inventory open** at 0:00 | Esc press 2 is used, and the save is still confirmed. |
| M7 | Repeat, but **hold Ctrl (sprint)** at 0:00 | The Start menu does **not** open, and the save is confirmed. |
| M8 | Repeat, but click into **OBS** just before 0:00 | GameSwap brings Minecraft back to the front, *or* stops with "no keys were sent". **Keys never go to OBS.** |
| M9 | Mid-turn, **Test Save** (Games box) | The log says Test Save PASSED and Minecraft is paused, not closed. |
| M10 | Open your world, and while it loads click into another window | Either the timer waits until Minecraft is in front, or a red box says Minecraft paused itself and to press Esc, then Continue. |
| M11 | Run 4 real turns, Minecraft ↔ simulated Schedule I | Every Minecraft turn opens the right world automatically, saves (confirmed) and closes cleanly. Afterwards, open the world by hand: everything you did in each turn is still there. |
| M12 | After testing, look in `C:\GameSwap\backups\minecraft-<your world>\` | It holds at most 5 zips, and the newest opens as a normal world. |

After testing, send me:
1. which M-tests passed or failed;
2. today's log file;
3. a **Diagnostics** report made with the launcher open;
4. your answer to M2 (how long after you could move did the timer start).

## 10. Phase 4 test checklist: Schedule I (do this on your PC)

**Before you start:** copy your Schedule I save folder somewhere safe. Press **Win+R**, paste `%USERPROFILE%\AppData\LocalLow\TVGS\Schedule I\Saves`, press Enter, and copy the folder you see to your Desktop. GameSwap also zips the save before every Start.

Setup: **Settings → Games → Schedule I**:
- Game driver **Real game**.
- **Save to load:** pick your save from the list.
- Leave **Show SAVE NOW at 60 s**, **A save this recent counts 90 s** and **Wait for your save up to 300 s**.

Set Minecraft to **Simulated** for S1–S10. Play time **2 min**.

| # | Do this | It PASSES if |
|---|---|---|
| S1 | Click **Diagnostics** | The Schedule I part lists your saves with their names and "last saved" times, shows **Save to load** = your save, and finds `Player.log`. |
| S2 | Press **Start**. The pretend Minecraft turn runs first; press **Switch Now** to skip it. | The log shows "Backing up Schedule I save" and a new zip appears in `backups\`. Steam starts Schedule I **by itself**, and the status says which save to load. |
| S3 | Load your save. While it loads, **don't** press anything | The timer stays at `--:--`. It never starts by itself. |
| S4 | Once you can move, press **Ctrl+Shift+F10** (or the Ready button) | The timer starts at **2:00**, OBS switches to **Schedule I**, and the log shows "Player.log lines just before you pressed Ready". |
| S5 | Wait for **1:00** | A three-note sound plays, and **SAVE NOW: sleep in bed or use the save device** appears in GameSwap and the OBS overlay (green text). |
| S6 | **Don't** save; let it reach 0:00 | OBS **stays on Schedule I**. The status says SAVE NOW (no save yet). The game is **not** closed. |
| S7 | Now use the save device (or sleep) | Within a few seconds the log says **"save '...' verified on disk"**. Then OBS shows Switching, the log says Schedule I **exited normally after a verified save**, and the game closes by itself. |
| S8 | Next turn: save **right at** SAVE NOW, then wait | At 0:00 the save already counts, so it quits straight away. |
| S9 | Next turn: settings **Wait for your save up to 20 s**. Don't save. | After 20 s a red box says the save wasn't confirmed and the game was NOT closed. Save in-game, press **Retry**, and it continues. |
| S10 | During S7, if Schedule I shows a "quit?" box | Confirm it yourself; GameSwap notices the exit. *Tell me whether a box appeared.* |
| S11 | Turn Minecraft back to **Real** and run **4 turns** at 10 min | Minecraft ↔ Schedule I alternate, only one game runs at a time, and OBS records the whole time. Afterwards, load both games by hand: **all progress up to each save is there**. |
| S12 | Check `C:\GameSwap\backups\` | It has `minecraft-...` and `schedule1-...` folders with at most 5 zips each. |

After testing, send me:
1. which S-tests passed or failed;
2. today's log file. It contains the Player.log lines from S4, which I can use to make Ready automatic;
3. your answer to S10.

## 11. Making Schedule I's Ready automatic (optional, later)

If the log lines from S4 show a line Schedule I always writes once a save has loaded, put a pattern for it in **Settings → Schedule I → Ready log line**. The timer then starts by itself (after the terrain wait) instead of waiting for Ready. Send me the log and I'll tell you the exact pattern. Don't guess one: a wrong pattern could start the timer during a loading screen.

---

## 12. Phase 5: recovery, YouTube chapters, and GameSwap.exe

**What's new**
- **Automatic launch retry.** If a game doesn't start (Steam busy, slow PC), GameSwap waits 20 s and tries **once** more by itself, then asks you. A retry never starts a second copy: if the game is already starting, GameSwap just waits for it. *(Settings → Timer.)*
- **Stop by itself after N turns.** Set **Stop by itself after** in Settings → Timer for an unattended recording; it saves and closes the last game first.
- **Resume after a crash.** If GameSwap or the PC stops mid-challenge, the next time you open GameSwap it asks **"Continue the last challenge?"**. Yes = the next Start continues with the game that was being played (a turn only counts as done once its game was saved and closed).
- **Session log for editing.** Every session writes `logs\session-<date-time>.csv` (opens in Excel): each turn, switch, retry and problem, with the **video time**.
- **YouTube chapters.** `logs\chapters-<date-time>.txt` is ready to paste into your video description, for example:

  ```
  00:00 Turn 1 - Minecraft
  10:52 Turn 2 - Schedule I
  21:40 Turn 3 - Minecraft
  ```

  The times come from **OBS's own recording clock**, so they line up with the video file.
- **`GameSwap.exe`**: a normal Windows app, no Python window needed.

**Get GameSwap.exe: download it (easiest)**

Every update is automatically tested on a Windows PC by GitHub, which then builds `GameSwap.exe`:
1. Open <https://github.com/kw1020/Project-Patrick/actions/workflows/gameswap-windows.yml> (signed in).
2. Click the newest run with a **green tick**, scroll to **Artifacts**, and download **GameSwap-windows** (about 60 MB).
3. Unzip it to e.g. `C:\GameSwap-App`, copy your `config.json` from `C:\GameSwap` into that folder, and double-click `GameSwap.exe`.

Downloads stay available for 30 days after each build.

**Or build GameSwap.exe yourself**
1. Run `install.bat` once (if you haven't since updating).
2. Double-click **`build_exe.bat`**. It builds the app, runs its self-test, and must end with **ALL PASSED**.
3. Your app is the folder `C:\GameSwap\dist\GameSwap`. Keep the **whole folder** together (the `.exe` needs the `_internal` folder next to it). Your `config.json` is copied in for you.
4. Optional: right-click `GameSwap.exe` → **Show more options** → **Send to → Desktop (create shortcut)**.

The EXE keeps its settings, logs, backups and chapters **in its own folder**. If Windows SmartScreen warns about an unknown app, click **More info → Run anyway** (the EXE isn't code-signed).

You can check any copy of the app with **`GameSwap.exe --selftest`** (or `run.bat` users: `.venv\Scripts\python -m gameswap --selftest`). It writes `selftest-result.txt` and never touches your games or OBS.

**Phase 5 checklist**

| # | Do this | It PASSES if |
|---|---|---|
| F1 | Double-click `build_exe.bat` | It ends with **ALL PASSED** and `dist\GameSwap\GameSwap.exe` opens the normal GameSwap window. |
| F2 | Quit Steam completely. Settings → Launch timeout **20 s**. Start, and let it reach Schedule I. | Steam is slow to start, so the first launch times out. The log says **"Trying again by itself in 20 s"**, and the second try starts the game. **Only one** copy runs (Games box). |
| F3 | Settings → **Stop by itself after 2 turns**. Start. | After turn 2 it saves and closes the game and says Stopped. OBS keeps recording. |
| F4 | During turn 2, close GameSwap with Task Manager (**End task** on GameSwap). Close the game normally yourself. Open GameSwap again. | It asks **"Continue the last challenge?"** and names the game that was being played. Press Yes, then Start: it continues with that game, and turns keep counting from where they were. |
| F5 | After a session, open `logs\chapters-....txt` | It starts with `00:00`. Each turn's time matches where that turn starts in your OBS recording (check in a video player, ±2 s). |
| F6 | Open `logs\session-....csv` in Excel | One row per turn, game closed, retry and problem, with video times. |
| F7 | Task Manager → Details while running | GameSwap uses about 150–250 MB of RAM and almost no CPU. |

## 13. Full rehearsal (do this last, before recording for real)

Both games **Real**, Play time **10 min**, OBS recording, **Stop by itself after 6 turns** (one hour).

| # | It PASSES if |
|---|---|
| R1 | 6 turns alternate Minecraft → Schedule I → … with **no** red error boxes. If one appears, note what it said. |
| R2 | Each turn's countdown starts only when you can actually play, and lasts 10:00 (spot-check one turn with a stopwatch). |
| R3 | Every Minecraft turn opens the right world by itself, and every Minecraft save and exit says *confirmed* in the log. |
| R4 | Every Schedule I save is **verified on disk** before the game closes. |
| R5 | OBS recorded continuously for the whole hour (one file, or OBS's own file splitting), and never showed a game during loading. |
| R6 | Afterwards, both games' progress up to each save is there when you load them by hand. |
| R7 | `chapters-....txt` has 6 turns and matches the video. |

**Only when R1–R7 pass is GameSwap ready for a real recording.** Until then, keep your own copies of your world and save.

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
    actions.py         every key press / button press / window close GameSwap can do (with safety checks)
    mclog.py           reads Minecraft's log to confirm joins, saves and world unloads
    mcworld.py         reads world names from level.dat
    backup.py          zips worlds/saves before each Start
    s1saves.py         Schedule I save slots, and the on-disk save check
    logfollow.py       follows a game's log file as it's written
    session.py         session log (CSV), YouTube chapters, resume after a crash
    selftest.py        GameSwap.exe --selftest
  GameSwap.spec        recipe for building GameSwap.exe (build_exe.bat uses it)
  build_exe.bat        builds dist\GameSwap\GameSwap.exe and self-tests it
  session.json         where the current challenge is (for "Continue the last challenge?")
  backups/             your world backups (newest 5 per world)
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
| "Couldn't press PLAY automatically" | Click PLAY yourself; GameSwap carries on. Send me a Diagnostics report made with the launcher open, so I can fix the automatic press. |
| "there is no world called ..." | Pick the world from the list in Settings. If your launcher installation uses its own game folder, set **.minecraft folder** to that folder. |
| Schedule I: "no Schedule I saves found" | Set **Saves folder** in Settings to the folder that has your `SaveGame_...` folders inside a Steam-ID folder. |
| Schedule I: SAVE NOW stays even though you saved | Make sure **Save to load** is the save you're playing. GameSwap only watches that slot. Diagnostics shows each slot's "last saved" time. |
| "pressed Esc twice but Minecraft didn't report saving" | Is the world opened to LAN? Close LAN, then press Retry. GameSwap never closes a game whose save it couldn't confirm. |
| "Python 3.12 was not found" | Do step 1 again and make sure **Add python.exe to PATH** is ticked. |
| "OBS isn't answering" | Open OBS and check step 5a. |
| "OBS rejected the password" | Copy it again from **Show Connect Info** into Settings → OBS. |
| "OBS has no scene called …" | Rename your OBS scenes to match, or change the names in Settings. |
| The overlay is blank in OBS | GameSwap must be running. Right-click the Browser source → **Refresh**. |
| "Hotkey … is already used" | Another app owns it. Pick another in Settings → Overlay & Hotkeys. |
| "Overlay server couldn't use port 8765" | Change the port in Settings, then update both Browser source URLs. |
