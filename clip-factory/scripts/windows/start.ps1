# Clip Factory launcher: update -> start Docker -> build + start in the background -> open the dashboard.
# Visible fallback for troubleshooting: started by "Clip Factory (show details).bat".
# (The normal "Clip Factory" icon starts the tray app, tray.ps1, which does the same steps hidden.)
# PowerShell reads this whole file before running it, so `git pull` replacing this file mid-run is safe.
$ErrorActionPreference = "Continue"
try { $Host.UI.RawUI.WindowTitle = "Clip Factory" } catch {}
$root = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)   # the clip-factory folder
Set-Location $root
. (Join-Path $PSScriptRoot "common.ps1")

function Say($msg, $color = "Gray") { Write-Host $msg -ForegroundColor $color }
function Stop-Here($code) { Read-Host "Press Enter to close"; exit $code }

Say ""
Say "  CLIP FACTORY" Magenta
Say ""

# 1. Update (only works when installed with Git; see README "Install with automatic updates")
$repoRoot = Split-Path -Parent $root
if (-not (Get-Command git -ErrorAction SilentlyContinue)) {
  Say "Git isn't installed, so I can't check for updates. Starting the version you have." Yellow
} elseif (-not (Test-Path (Join-Path $repoRoot ".git"))) {
  Say "This copy was downloaded as a ZIP, so it can't update itself. Starting the version you have." Yellow
} else {
  Say "Checking for updates..."
  $versionBefore = Get-ClipFactoryVersion $root
  $before = (git -C $repoRoot rev-parse HEAD) 2>$null
  $out = (git -C $repoRoot pull --ff-only 2>&1) | Out-String
  $pullCode = $LASTEXITCODE
  $after = (git -C $repoRoot rev-parse HEAD) 2>$null
  if ($pullCode -ne 0) {
    Say "Couldn't update (no internet, or files changed by hand). Starting the version you have." Yellow
    Say $out DarkGray
  } elseif ($before -ne $after) {
    $versionAfter = Get-ClipFactoryVersion $root
    if ($versionAfter -and ($versionAfter -ne $versionBefore)) {
      Say ""
      Say ("Updated to v" + $versionAfter) Green
      foreach ($note in (Get-ClipFactoryNotes $root $versionAfter)) { Say ("  - " + $note) White }
      Say "  (All patch notes: the version badge at the top of the dashboard.)" DarkGray
      Say ""
      Set-SeenVersion $root $versionAfter
    }
    Say "Updated to the newest version. Rebuilding (a few minutes)..." Green
  } else {
    Say "Already up to date." Green
  }
}

# 2. Keys
if (-not (Test-Path ".env")) {
  Copy-Item ".env.example" ".env"
  Say "Made your .env file. Paste your Twitch keys after the = signs, save, then open Clip Factory again." Yellow
  Start-Process notepad ".env"
  Stop-Here 0
}

# 3. Docker
docker info *> $null
if ($LASTEXITCODE -ne 0) {
  Say "Starting Docker Desktop..."
  $dd = Join-Path $env:ProgramFiles "Docker\Docker\Docker Desktop.exe"
  if (Test-Path $dd) { Start-Process $dd } else { Say "Couldn't find Docker Desktop. Open it yourself." Yellow }
  for ($i = 0; $i -lt 90; $i++) {
    Start-Sleep -Seconds 2
    docker info *> $null
    if ($LASTEXITCODE -eq 0) { break }
  }
  if ($LASTEXITCODE -ne 0) {
    Say "Docker didn't start. Open Docker Desktop, wait for 'Engine running', then open Clip Factory again." Red
    Stop-Here 1
  }
}

# 4. Build (cached: only changed parts rebuild) and start in the background
Say "Starting Clip Factory..."
docker compose up -d --build
if ($LASTEXITCODE -ne 0) {
  Say "Something went wrong while starting. Take a screenshot of this window and send it to Claude." Red
  Stop-Here 1
}

# 5. Wait for the dashboard, then open it
Say "Waiting for the dashboard..."
$ready = $false
for ($i = 0; $i -lt 120; $i++) {
  try {
    $r = Invoke-WebRequest -UseBasicParsing -TimeoutSec 2 -Uri "http://localhost:3000/api/health"
    if ($r.StatusCode -eq 200) { $ready = $true; break }
  } catch {}
  Start-Sleep -Seconds 2
}
if ($ready) { Open-ClipFactoryWindow "http://localhost:3000" } else { Say "The dashboard is slow to start. Try http://localhost:3000 in a minute." Yellow }

# 6. Desktop shortcuts: "Clip Factory" starts the tray app (updated if it still points at the old .bat),
#    "Stop Clip Factory" is only added when missing.
$desktop = [Environment]::GetFolderPath("Desktop")
$ico = Join-Path $root "storage\clip-factory.ico"
try {
  if (-not (Test-Path (Join-Path $root "storage"))) { New-Item -ItemType Directory -Path (Join-Path $root "storage") -Force | Out-Null }
  if (-not (Test-Path $ico)) { Save-ClipFactoryIcon $ico }
} catch { Say ("Couldn't make the icon file: " + $_.Exception.Message) DarkGray }
try {
  if (Set-ClipFactoryShortcut (Join-Path $desktop "Clip Factory.lnk") (Join-Path $PSScriptRoot "tray.ps1") $root $ico "") {
    Say "Desktop icon 'Clip Factory' now starts the tray app." Green
  }
} catch { Say ("Couldn't make the desktop icon: " + $_.Exception.Message) DarkGray }
$stopLnk = Join-Path $desktop "Stop Clip Factory.lnk"
if (-not (Test-Path $stopLnk)) {
  $ws = New-Object -ComObject WScript.Shell
  $s = $ws.CreateShortcut($stopLnk)
  $s.TargetPath = Join-Path $root "Stop Clip Factory.bat"
  $s.WorkingDirectory = $root
  $s.Save()
  Say "Added 'Stop Clip Factory' to your desktop." Green
}

Say ""
$runningVersion = Get-ClipFactoryVersion $root
if ($runningVersion) { Say ("Clip Factory v" + $runningVersion + " is running: http://localhost:3000") Green } else { Say "Clip Factory is running: http://localhost:3000" Green }
Say "You can close this window. It keeps running in the background until you use Stop (tray icon) or 'Stop Clip Factory'." Gray
Start-Sleep -Seconds 10
