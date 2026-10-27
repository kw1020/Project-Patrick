@echo off
setlocal
cd /d "%~dp0"
echo.
echo === GameSwap installer ===
echo.

set "PY="
for %%V in (3.12 3.13) do (
    if not defined PY (
        py -%%V -c "import sys" >nul 2>nul && set "PY=py -%%V"
    )
)
if not defined PY (
    echo Python 3.12 was not found.
    echo Install it from https://www.python.org/downloads/ ^(see README, step 1^), then run this again.
    pause
    exit /b 1
)
echo Using: %PY%

if not exist ".venv\Scripts\python.exe" (
    echo Creating a private Python environment in .venv ...
    %PY% -m venv .venv
    if errorlevel 1 (
        echo Could not create the environment.
        pause
        exit /b 1
    )
)

echo Installing GameSwap's libraries ^(this can take a few minutes the first time^)...
".venv\Scripts\python.exe" -m pip install --upgrade pip
".venv\Scripts\python.exe" -m pip install -r requirements-dev.txt
if errorlevel 1 (
    echo.
    echo Installing failed. Scroll up for the red error text and send it to Claude.
    pause
    exit /b 1
)

echo.
echo === Done! Double-click run.bat to start GameSwap. ===
pause
