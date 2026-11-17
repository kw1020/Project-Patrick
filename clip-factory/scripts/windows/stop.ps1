# Stops Clip Factory (your clips, settings and database are kept).
$root = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
Set-Location $root
Write-Host "Stopping Clip Factory..." -ForegroundColor Magenta
docker compose down
# Tell the tray app (if it's running) that Clip Factory was stopped on purpose, so it shows "stopped", not "error".
try {
  if (-not (Test-Path "storage")) { New-Item -ItemType Directory -Path "storage" -Force | Out-Null }
  [System.IO.File]::WriteAllText((Join-Path $root "storage\launcher-stopped.flag"), "stopped")
} catch {}
Write-Host "Stopped. Open 'Clip Factory' to start it again." -ForegroundColor Green
Start-Sleep -Seconds 4
