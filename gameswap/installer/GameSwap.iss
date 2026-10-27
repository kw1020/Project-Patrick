; GameSwap installer (Inno Setup 6). Built by GitHub automatically, or by build_installer.bat.
; Installs for your Windows user only: no administrator password needed.

#ifndef AppVersion
  #define AppVersion "0.0.0"
#endif

[Setup]
AppId={{8F4C2A61-6B0E-4D7B-9C3E-2A1F5D7E9B10}
AppName=GameSwap
AppVersion={#AppVersion}
AppVerName=GameSwap {#AppVersion}
AppPublisher=Krew Sutherland
DefaultDirName={localappdata}\Programs\GameSwap
DefaultGroupName=GameSwap
DisableProgramGroupPage=yes
PrivilegesRequired=lowest
OutputDir=..\dist\installer
OutputBaseFilename=GameSwap-Setup-{#AppVersion}
SetupIconFile=..\gameswap\assets\gameswap.ico
UninstallDisplayIcon={app}\GameSwap.exe
UninstallDisplayName=GameSwap
Compression=lzma2
SolidCompression=yes
WizardStyle=modern
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
; GameSwap must be closed while it's updated.
CloseApplications=yes

[Tasks]
Name: "desktopicon"; Description: "Put a GameSwap icon on the desktop"; GroupDescription: "Shortcuts:"

[Files]
; Your own files (settings, logs, backups) are never part of the installer, so
; installing an update - or uninstalling - leaves them alone.
Source: "..\dist\GameSwap\*"; DestDir: "{app}"; \
  Excludes: "selftest-result.txt,config.json,session.json,logs\*,backups\*,overlay\*"; \
  Flags: ignoreversion recursesubdirs createallsubdirs

[Icons]
Name: "{autoprograms}\GameSwap"; Filename: "{app}\GameSwap.exe"; AppUserModelID: "GameSwap.App"
Name: "{autodesktop}\GameSwap"; Filename: "{app}\GameSwap.exe"; Tasks: desktopicon; AppUserModelID: "GameSwap.App"

[Run]
Filename: "{app}\GameSwap.exe"; Description: "Start GameSwap now"; Flags: nowait postinstall skipifsilent
