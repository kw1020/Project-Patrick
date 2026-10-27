@echo off
cd /d "%~dp0"
if not exist ".venv\Scripts\python.exe" (
    echo GameSwap isn't installed yet. Double-click install.bat first.
    pause
    exit /b 1
)
rem This black window shows GameSwap's log. Closing it closes GameSwap.
".venv\Scripts\python.exe" -m gameswap
if errorlevel 1 pause
