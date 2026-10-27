@echo off
cd /d "%~dp0"
if not exist ".venv\Scripts\python.exe" (
    echo Run install.bat first.
    pause
    exit /b 1
)
".venv\Scripts\python.exe" -m pytest -v
echo.
echo All tests should say PASSED. If any say FAILED, send this window's text to Claude.
pause
