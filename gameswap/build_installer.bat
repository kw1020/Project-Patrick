@echo off
setlocal
cd /d "%~dp0"
rem Makes dist\installer\GameSwap-Setup-<version>.exe. Needs Inno Setup 6:
rem   winget install JRSoftware.InnoSetup
call build_exe.bat
if errorlevel 1 exit /b 1
set "ISCC="
for %%P in ("%ProgramFiles(x86)%\Inno Setup 6\ISCC.exe" "%ProgramFiles%\Inno Setup 6\ISCC.exe" "%LOCALAPPDATA%\Programs\Inno Setup 6\ISCC.exe") do (
    if exist %%P set "ISCC=%%~P"
)
if not defined ISCC (
    echo Inno Setup 6 isn't installed. Install it with:  winget install JRSoftware.InnoSetup
    pause
    exit /b 1
)
for /f %%V in ('.venv\Scripts\python.exe -c "import gameswap; print(gameswap.__version__)"') do set "VERSION=%%V"
"%ISCC%" "/DAppVersion=%VERSION%" installer\GameSwap.iss
if errorlevel 1 (
    echo Making the installer failed. Scroll up for the error.
    pause
    exit /b 1
)
echo.
echo === Installer ready: dist\installer\GameSwap-Setup-%VERSION%.exe ===
pause
