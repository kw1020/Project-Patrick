# Project Patrick - Day 1 setup for Krew's PC (Windows)
# Installs Blender and Claude Desktop, then shows what's eating RAM.
# Run: right-click Start -> "Terminal (Admin)" -> paste this whole file -> Enter.

Write-Host "`n=== 1. Installing Blender ===" -ForegroundColor Cyan
winget install --id BlenderFoundation.Blender -e --accept-source-agreements --accept-package-agreements
if ($LASTEXITCODE -ne 0) { Write-Host "Blender install failed - download it from https://www.blender.org/download/" -ForegroundColor Yellow }

Write-Host "`n=== 2. Installing Claude Desktop ===" -ForegroundColor Cyan
winget install --id Anthropic.Claude -e --accept-source-agreements --accept-package-agreements
if ($LASTEXITCODE -ne 0) { Write-Host "Claude Desktop install failed - download it from https://claude.ai/download" -ForegroundColor Yellow }

Write-Host "`n=== 3. Top 15 apps using RAM ===" -ForegroundColor Cyan
Get-Process | Group-Object ProcessName |
  ForEach-Object { [pscustomobject]@{ App = $_.Name; RAM_MB = [math]::Round(($_.Group | Measure-Object WorkingSet64 -Sum).Sum / 1MB) } } |
  Sort-Object RAM_MB -Descending | Select-Object -First 15 | Format-Table -AutoSize

$os = Get-CimInstance Win32_OperatingSystem
$usedPct = [math]::Round((1 - $os.FreePhysicalMemory / $os.TotalVisibleMemorySize) * 100)
Write-Host "RAM in use: $usedPct%" -ForegroundColor Cyan

Write-Host "`n=== 4. Graphics card ===" -ForegroundColor Cyan
Get-CimInstance Win32_VideoController | Select-Object Name, DriverVersion | Format-Table -AutoSize

Write-Host "`nDone. Next (manual, ~2 min):" -ForegroundColor Green
Write-Host " - Close the big RAM users above that you don't need (browser, Discord, launchers)."
Write-Host " - Open Claude Desktop, sign in, then Customize -> Connectors -> search 'Blender' -> Add."
Write-Host " - Follow the Blender add-on steps in docs/blender-setup-plan.md (section 2)."
