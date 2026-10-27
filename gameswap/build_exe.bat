@echo off
setlocal
cd /d "%~dp0"
echo.
echo === Build GameSwap.exe ===
echo.
if not exist ".venv\Scripts\python.exe" (
    echo Run install.bat first.
    pause
    exit /b 1
)
echo Installing the EXE builder (PyInstaller)...
".venv\Scripts\python.exe" -m pip install "pyinstaller>=6.6"
if errorlevel 1 goto failed

echo Building (takes a minute or two)...
".venv\Scripts\python.exe" -m PyInstaller --noconfirm --clean GameSwap.spec
if errorlevel 1 goto failed

echo Running the self-test of the new GameSwap.exe...
start "" /wait "dist\GameSwap\GameSwap.exe" --selftest
type "dist\GameSwap\selftest-result.txt"
findstr /c:"ALL PASSED" "dist\GameSwap\selftest-result.txt" >nul
if errorlevel 1 goto failed

if exist config.json copy /y config.json "dist\GameSwap\config.json" >nul
echo.
echo === Done! ===
echo Your app is the folder:  %cd%\dist\GameSwap
echo Start it with:            dist\GameSwap\GameSwap.exe
echo Your settings were copied into that folder. Keep the whole folder together.
pause
exit /b 0

:failed
echo.
echo Building failed. Scroll up for the error and send it to Claude.
pause
exit /b 1
