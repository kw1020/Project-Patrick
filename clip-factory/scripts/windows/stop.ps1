# Stops Clip Factory (your clips, settings and database are kept).
$root = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
Set-Location $root
Write-Host "Stopping Clip Factory..." -ForegroundColor Magenta
docker compose down
Write-Host "Stopped. Open 'Clip Factory' to start it again." -ForegroundColor Green
Start-Sleep -Seconds 4
