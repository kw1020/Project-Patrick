@echo off
title Patrick Homework Doer
cd /d "%~dp0"

if not exist server.js (
  echo Patrick's files aren't here. You probably opened this from inside the zip.
  echo.
  echo Fix: close this, right-click the downloaded zip, choose "Extract All...",
  echo then open the extracted folder, go into homework-helper, and double-click Start Patrick again.
  pause
  exit /b
)

where node >nul 2>nul
if errorlevel 1 (
  echo Patrick needs Node.js to run. Opening the download page...
  echo Install the "LTS" version, then double-click Start Patrick again.
  start "" https://nodejs.org/en/download
  pause
  exit /b
)

if not exist node_modules (
  echo Setting up Patrick for the first time. This takes about a minute...
  call npm install --no-audit --no-fund
  if errorlevel 1 (
    echo Setup failed. Check your internet and try again.
    pause
    exit /b
  )
)

rem Add your API key on Patrick's Settings page (the gear button).
set PATRICK_OPEN=1
node server.js
pause
