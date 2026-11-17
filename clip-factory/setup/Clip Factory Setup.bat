@echo off
setlocal
title Clip Factory Setup
echo.
echo   CLIP FACTORY SETUP
echo   Installs or updates Clip Factory and starts it in your system tray.
echo.
set "REPO=%USERPROFILE%\Documents\Project-Patrick"
set "CF=%REPO%\clip-factory"
set "GIT=%ProgramFiles%\Git\cmd\git.exe"
if exist "%GIT%" goto havegit
where git >nul 2>&1
if not errorlevel 1 (set "GIT=git" & goto havegit)
echo Installing Git (say Yes if Windows asks)...
winget install --id Git.Git -e --source winget --accept-package-agreements --accept-source-agreements
if not exist "%GIT%" (
  echo Couldn't install Git. Take a screenshot of this window and send it to Claude.
  pause
  exit /b 1
)
:havegit
if exist "%REPO%\.git" (
  echo Getting the newest version...
  "%GIT%" -C "%REPO%" pull --ff-only
) else (
  echo Downloading Clip Factory into Documents\Project-Patrick ...
  echo If a GitHub sign-in window opens, sign in and come back here.
  "%GIT%" clone -b claude/adoring-mendel-at7ood https://github.com/kw1020/Project-Patrick.git "%REPO%"
)
if not exist "%CF%\scripts\windows\tray.ps1" (
  echo The download didn't work. Take a screenshot of this window and send it to Claude.
  pause
  exit /b 1
)
if not exist "%CF%\.env" (
  copy "%CF%\.env.example" "%CF%\.env" >nul
  echo.
  echo Notepad is opening your keys file. Paste your Twitch keys after the = signs,
  echo press Ctrl+S, then close Notepad to continue.
  notepad "%CF%\.env"
)
echo.
echo Starting Clip Factory...
start "" powershell -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "%CF%\scripts\windows\tray.ps1"
echo.
echo   Done. Look for the pink CF icon by the clock (bottom right).
echo   If you can't see it, click the ^^ arrow there and drag CF out next to the clock.
echo   The first start after an update takes a few minutes, then the app window opens.
echo   From now on, open it from the "Clip Factory" icon on your desktop or the Start menu.
echo.
pause
