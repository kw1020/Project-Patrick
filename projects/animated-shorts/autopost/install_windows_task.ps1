# Registers a Windows scheduled task that runs the autoposter every day at 3 PM.
# If the PC is off at 3 PM it runs as soon as the PC is next on (StartWhenAvailable).
# Posting itself doesn't need the PC: Shorts are uploaded days ahead and YouTube publishes them.
# Run once in PowerShell from this folder:  powershell -ExecutionPolicy Bypass -File install_windows_task.ps1
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$py = (Get-Command python -ErrorAction SilentlyContinue).Source
if (-not $py) { $py = (Get-Command py -ErrorAction Stop).Source }
$log = Join-Path $here "state\autopost.log"
New-Item -ItemType Directory -Force -Path (Join-Path $here "state") | Out-Null
$cmd = "/c cd /d `"$here`" && `"$py`" autopost.py run >> `"$log`" 2>&1"
$action = New-ScheduledTaskAction -Execute "cmd.exe" -Argument $cmd -WorkingDirectory $here
$trigger = New-ScheduledTaskTrigger -Daily -At 3:00PM
$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -RunOnlyIfNetworkAvailable -ExecutionTimeLimit (New-TimeSpan -Hours 3)
Register-ScheduledTask -TaskName "Patrick YouTube Autopost" -Action $action -Trigger $trigger -Settings $settings -Force | Out-Null
Write-Host "Done. Task 'Patrick YouTube Autopost' runs daily at 3 PM. Log: $log"
