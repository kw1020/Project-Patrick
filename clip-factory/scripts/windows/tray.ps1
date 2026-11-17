# Clip Factory tray app: a "CF" icon by the clock that starts, stops and updates Clip Factory
# and opens the dashboard in its own app window.
# Started hidden by "Clip Factory.bat" and by the desktop / Startup shortcuts.
# Windows PowerShell 5.1 + WinForms. Keep this file plain ASCII (PowerShell 5.1 reads BOM-less files as ANSI).
#
# How it works: the tray never waits on anything itself. Each long step (git pull, docker info,
# docker compose up/down) runs as a hidden child process (cmd.exe /c ... > step log), and an HTTP
# health check runs as an async request. A 1-second WinForms timer polls the one running "job" and
# moves a small state machine ($script:phase) on when it finishes. Everything runs on the UI thread.
param(
  [switch]$SkipUpdate,   # skip git pull (used when the tray restarts itself right after updating)
  [switch]$NoOpen        # don't open the app window when ready (used by "Start when Windows starts")
)

$ErrorActionPreference = "Continue"

$script:winDir   = $PSScriptRoot
$script:root     = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)   # the clip-factory folder
$script:repoRoot = Split-Path -Parent $script:root
$script:trayPath = Join-Path $PSScriptRoot "tray.ps1"
$script:storage  = Join-Path $script:root "storage"
$script:logPath  = Join-Path $script:storage "launcher.log"
$script:icoPath  = Join-Path $script:storage "clip-factory.ico"
$script:openFlag = Join-Path $script:storage "launcher-open.flag"      # written by a 2nd launch: "open the window"
$script:stopFlag = Join-Path $script:storage "launcher-stopped.flag"   # written by stop.ps1: "it was stopped"
$script:url      = "http://localhost:3000"
$script:psExe    = Join-Path $env:SystemRoot "System32\WindowsPowerShell\v1.0\powershell.exe"
$script:dash     = [string][char]0x2014
$script:ell      = [string][char]0x2026

$script:state = "starting"     # starting | running | stopping | updating | stopped | error
$script:phase = ""             # git-pull | docker-check | docker-wait | compose-up | health-wait | monitor | compose-down | ""
$script:detail = ""            # extra tooltip text while starting
$script:job = $null            # the one running child process or HTTP request
$script:stepNo = 0
$script:afterStop = "none"     # none | quit | update
$script:openWhenReady = $false
$script:failCount = 0
$script:nextPollAt = Get-Date
$script:deadline = Get-Date
$script:headBefore = ""
$script:lastOpen = (Get-Date).AddMinutes(-1)
$script:ticking = $false
$script:quitting = $false
$script:balloonAction = "none"
$script:openPage = ""          # page to open when the window opens by itself ("" = dashboard, "/whats-new")
$script:version = ""           # from CHANGELOG.md, e.g. "1.6.0"
$script:previousInstall = $false   # Clip Factory ran on this PC before this tray started (not a fresh install)
$script:mutex = $null
$script:notify = $null
$script:timer = $null
$script:ctx = $null

# ---------------------------------------------------------------- logging

function Write-Log([string]$msg) {
  $line = (Get-Date).ToString("yyyy-MM-dd HH:mm:ss") + "  " + $msg + "`r`n"
  try { [System.IO.File]::AppendAllText($script:logPath, $line) } catch {}
}

function Limit-Log {
  try {
    if (Test-Path -LiteralPath $script:logPath) {
      $lines = [System.IO.File]::ReadAllLines($script:logPath)
      if ($lines.Length -gt 2000) {
        $keep = [string[]]($lines[($lines.Length - 2000)..($lines.Length - 1)])
        [System.IO.File]::WriteAllLines($script:logPath, $keep)
      }
    }
  } catch {}
}

function Invoke-Safe([scriptblock]$block) {
  try { & $block } catch { Write-Log ("ERROR: " + $_.Exception.Message + " (line " + $_.InvocationInfo.ScriptLineNumber + ")") }
}

# ---------------------------------------------------------------- tools

function Find-Exe([string]$name, [string]$fallback) {
  $cmd = Get-Command $name -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
  if ($cmd -and $cmd.Path) { return $cmd.Path }
  if ($fallback -and (Test-Path -LiteralPath $fallback)) { return $fallback }
  return $null
}

$script:docker = Find-Exe "docker" (Join-Path $env:ProgramFiles "Docker\Docker\resources\bin\docker.exe")
$script:git = Find-Exe "git" (Join-Path $env:ProgramFiles "Git\cmd\git.exe")

function Get-Head {
  if (-not $script:git) { return "" }
  try {
    $h = & $script:git -C $script:repoRoot rev-parse HEAD 2>$null
    if ($h) { return ([string]$h).Trim() }
  } catch {}
  return ""
}

# ---------------------------------------------------------------- jobs (one at a time)

# Runs a command line hidden; its output goes to a step log that is copied into launcher.log when it ends.
function Start-HiddenStep([string]$commandLine, [int]$timeoutSec, [string]$label) {
  $script:stepNo = $script:stepNo + 1
  $out = Join-Path $script:storage ("launcher-step-" + $script:stepNo + ".log")
  Write-Log ("> " + $label)
  $psi = New-Object System.Diagnostics.ProcessStartInfo
  $psi.FileName = Join-Path $env:SystemRoot "System32\cmd.exe"
  $psi.Arguments = "/d /s /c `"" + $commandLine + " > `"" + $out + "`" 2>&1`""
  $psi.UseShellExecute = $false
  $psi.CreateNoWindow = $true
  $psi.WorkingDirectory = $script:root
  $psi.EnvironmentVariables["GIT_TERMINAL_PROMPT"] = "0"
  $psi.EnvironmentVariables["COMPOSE_ANSI"] = "never"
  $psi.EnvironmentVariables["BUILDKIT_PROGRESS"] = "plain"
  try {
    $p = [System.Diagnostics.Process]::Start($psi)
    $script:job = @{ Kind = "proc"; Proc = $p; Out = $out; Label = $label; Deadline = (Get-Date).AddSeconds($timeoutSec) }
  } catch {
    Write-Log ("Couldn't run " + $label + ": " + $_.Exception.Message)
    $script:job = @{ Kind = "done"; Ok = $false; Out = "" }
  }
}

function Start-HealthCheck {
  try {
    $req = [System.Net.WebRequest]::Create($script:url + "/api/health")
    $req.Proxy = $null
    $req.KeepAlive = $false
    $ar = $req.BeginGetResponse($null, $null)
    $script:job = @{ Kind = "http"; Req = $req; Ar = $ar; Deadline = (Get-Date).AddSeconds(5) }
  } catch {
    $script:job = @{ Kind = "done"; Ok = $false; Out = "" }
  }
}

function Copy-StepOutput([string]$out) {
  if (-not $out) { return }
  try {
    if (Test-Path -LiteralPath $out) {
      $text = [System.IO.File]::ReadAllText($out)
      if ($text) {
        $text = $text.TrimEnd()
        if ($text.Length -gt 0) { [System.IO.File]::AppendAllText($script:logPath, $text + "`r`n") }
      }
      Remove-Item -LiteralPath $out -Force -ErrorAction SilentlyContinue
    }
  } catch {}
}

# Returns $null while the job is still running, else @{ Ok = $true/$false }.
function Get-JobResult {
  $j = $script:job
  if ($null -eq $j) { return $null }
  if ($j.Kind -eq "done") {
    $script:job = $null
    return @{ Ok = $j.Ok }
  }
  if ($j.Kind -eq "proc") {
    if ($j.Proc.HasExited) {
      $code = $j.Proc.ExitCode
      Copy-StepOutput $j.Out
      Write-Log ("  " + $j.Label + " finished (exit code " + $code + ")")
      $script:job = $null
      return @{ Ok = ($code -eq 0) }
    }
    if ((Get-Date) -gt $j.Deadline) {
      Write-Log ("  " + $j.Label + " took too long; stopped it.")
      Stop-ProcessTree $j.Proc
      Copy-StepOutput $j.Out
      $script:job = $null
      return @{ Ok = $false }
    }
    return $null
  }
  if ($j.Kind -eq "http") {
    if ($j.Ar.IsCompleted) {
      $ok = $false
      try {
        $resp = $j.Req.EndGetResponse($j.Ar)
        $ok = ([int]$resp.StatusCode -eq 200)
        $resp.Close()
      } catch { $ok = $false }
      $script:job = $null
      return @{ Ok = $ok }
    }
    if ((Get-Date) -gt $j.Deadline) {
      try { $j.Req.Abort() } catch {}
      $script:job = $null
      return @{ Ok = $false }
    }
    return $null
  }
  $script:job = $null
  return @{ Ok = $false }
}

function Stop-ProcessTree($proc) {
  try {
    if (-not $proc.HasExited) {
      & (Join-Path $env:SystemRoot "System32\taskkill.exe") /PID $proc.Id /T /F 2>&1 | Out-Null
    }
  } catch {}
}

function Stop-CurrentJob {
  $j = $script:job
  if ($null -eq $j) { return }
  if ($j.Kind -eq "proc") {
    Stop-ProcessTree $j.Proc
    Copy-StepOutput $j.Out
  }
  if ($j.Kind -eq "http") {
    try { $j.Req.Abort() } catch {}
  }
  $script:job = $null
}

# ---------------------------------------------------------------- UI helpers

function Update-Ui {
  if ($null -eq $script:notify) { return }
  $t = "Clip Factory "
  if ($script:version) { $t = $t + "v" + $script:version + " " }
  $t = $t + $script:dash + " "
  switch ($script:state) {
    "starting" { $t = $t + "starting" + $script:ell }
    "running"  { $t = $t + "running" }
    "stopping" { $t = $t + "stopping" + $script:ell }
    "updating" { $t = $t + "updating" + $script:ell }
    "stopped"  { $t = $t + "stopped" }
    "error"    { $t = $t + "error (right-click " + [char]0x2192 + " Show log)" }
    default    { $t = $t + $script:state }
  }
  if ($script:detail -and ($script:state -eq "starting" -or $script:state -eq "updating")) { $t = $t + " " + $script:detail }
  if ($t.Length -gt 63) { $t = $t.Substring(0, 63) }
  $script:notify.Text = $t
  $busy = ($script:state -eq "starting" -or $script:state -eq "stopping" -or $script:state -eq "updating")
  $script:miStart.Enabled = ($script:state -eq "stopped" -or $script:state -eq "error")
  $script:miStop.Enabled = ($script:state -eq "running" -or $script:state -eq "error")
  $script:miUpdate.Enabled = (-not $busy)
  $script:miAutostart.Checked = (Test-Path -LiteralPath (Get-StartupLnk))
  if ($script:version) { $script:miWhatsNew.Text = "What's new (v" + $script:version + ")" } else { $script:miWhatsNew.Text = "What's new" }
}

function Set-State([string]$state, [string]$detail) {
  if ($state -ne $script:state) { Write-Log ("State: " + $state) }
  $script:state = $state
  $script:detail = $detail
  Update-Ui
}

# action: "open" (open the app window), "whatsnew" (open the What's new page), "log" (open the log), "none"
function Show-Balloon([string]$text, [string]$kind, [string]$action) {
  if ($null -eq $script:notify) { return }
  $script:balloonAction = $action
  $icon = [System.Windows.Forms.ToolTipIcon]::Info
  if ($kind -eq "warning") { $icon = [System.Windows.Forms.ToolTipIcon]::Warning }
  if ($kind -eq "error") { $icon = [System.Windows.Forms.ToolTipIcon]::Error }
  try { $script:notify.ShowBalloonTip(5000, "Clip Factory", $text, $icon) } catch {}
}

function Open-Log {
  if (-not (Test-Path -LiteralPath $script:logPath)) { Write-Log "Log created." }
  Start-Process -FilePath "notepad.exe" -ArgumentList ("`"" + $script:logPath + "`"")
}

function Get-StartupLnk {
  return (Join-Path ([Environment]::GetFolderPath("Startup")) "Clip Factory.lnk")
}

# "Open Clip Factory": open the window now if running, else start (or keep starting) and open when ready.
# page: "" for the dashboard, or a path such as "/whats-new".
function Request-Open([bool]$fromClick, [string]$page) {
  if ($fromClick) {
    if (((Get-Date) - $script:lastOpen).TotalSeconds -lt 2) { return }
  }
  $script:lastOpen = Get-Date
  if (-not $page) { $page = "" }
  if ($script:state -eq "running" -or ($script:state -eq "error" -and $script:phase -eq "monitor")) {
    Open-ClipFactoryWindow ($script:url + $page)
    return
  }
  $script:openPage = $page
  if ($script:state -eq "stopped" -or $script:state -eq "error") {
    $script:openWhenReady = $true
    Show-Balloon "Starting Clip Factory. Its window opens by itself when it's ready." "info" "none"
    Start-ClipFactory $false "starting"
    return
  }
  if ($script:state -eq "stopping") {
    Show-Balloon "Clip Factory is stopping. Use Start when it has stopped." "info" "none"
    return
  }
  $script:openWhenReady = $true
  Show-Balloon "Clip Factory is still starting. Its window opens by itself when it's ready." "info" "none"
}

# ---------------------------------------------------------------- the steps

function Start-ClipFactory([bool]$doUpdate, [string]$state) {
  Stop-CurrentJob
  try { Remove-Item -LiteralPath $script:stopFlag -Force -ErrorAction SilentlyContinue } catch {}
  $script:failCount = 0
  Set-State $state ""
  if ($doUpdate) {
    if (-not $script:git) {
      Write-Log "Git isn't installed, so I can't check for updates. Starting the version you have."
    } elseif (-not (Test-Path -LiteralPath (Join-Path $script:repoRoot ".git"))) {
      Write-Log "This copy was downloaded as a ZIP, so it can't update itself. Starting the version you have."
    } else {
      $script:headBefore = Get-Head
      $script:phase = "git-pull"
      Set-State $state "(checking for updates)"
      Start-HiddenStep ("`"" + $script:git + "`" -C `"" + $script:repoRoot + "`" pull --ff-only") 180 "git pull --ff-only"
      return
    }
  }
  Start-DockerCheck
}

function Start-DockerCheck {
  if (-not (Test-Path -LiteralPath (Join-Path $script:root ".env"))) {
    try { Copy-Item -LiteralPath (Join-Path $script:root ".env.example") -Destination (Join-Path $script:root ".env") } catch {}
    Start-Process -FilePath "notepad.exe" -ArgumentList ("`"" + (Join-Path $script:root ".env") + "`"")
    $script:phase = ""
    Write-Log "Made your .env file. Paste your keys after the = signs, save, then right-click the tray icon and Start."
    Set-State "error" ""
    Show-Balloon "Paste your keys into the .env file that just opened, save it, then right-click this icon and Start." "warning" "none"
    return
  }
  if (-not $script:docker) {
    $script:docker = Find-Exe "docker" (Join-Path $env:ProgramFiles "Docker\Docker\resources\bin\docker.exe")
  }
  if (-not $script:docker) {
    Stop-WithError "Couldn't find Docker. Install Docker Desktop, then right-click this icon and Start."
    return
  }
  $script:phase = "docker-check"
  Set-State $script:state "(checking Docker)"
  Start-HiddenStep ("`"" + $script:docker + "`" info") 30 "docker info"
}

function Start-ComposeUp {
  $script:phase = "compose-up"
  Set-State $script:state "(building, can take minutes)"
  Start-HiddenStep ("`"" + $script:docker + "`" compose up -d --build") 1800 "docker compose up -d --build"
}

function Start-ComposeDown([string]$after) {
  Stop-CurrentJob
  $script:afterStop = $after
  if (-not $script:docker) {
    Write-Log "Docker isn't installed, nothing to stop."
    $script:job = @{ Kind = "done"; Ok = $true; Out = "" }
  } else {
    Start-HiddenStep ("`"" + $script:docker + "`" compose down") 300 "docker compose down"
  }
  $script:phase = "compose-down"
  if ($after -eq "update") { Set-State "updating" "" } else { Set-State "stopping" "" }
}

function Stop-WithError([string]$msg) {
  Write-Log ("ERROR: " + $msg)
  $script:phase = ""
  Set-State "error" ""
  Show-Balloon ($msg + " Right-click " + [char]0x2192 + " Show log for details.") "error" "log"
}

function Set-Running {
  $script:phase = "monitor"
  $script:failCount = 0
  $script:nextPollAt = (Get-Date).AddSeconds(30)
  Set-State "running" ""
  if ($script:openWhenReady) {
    $script:openWhenReady = $false
    Open-ClipFactoryWindow ($script:url + $script:openPage)
  }
  $script:openPage = ""
  if (-not (Show-UpdateNote)) { Show-Balloon "Clip Factory is running." "info" "open" }
}

# After an update changed the version: "Updated to Clip Factory v1.6.0 - click to see what's new".
# storage\launcher-version.txt holds the last version shown, so this also covers updates made by
# start.ps1, the setup file, or an older tray that restarted itself. Returns $true when it showed the note.
function Show-UpdateNote {
  $v = $script:version
  if (-not $v) { return $false }
  $seen = Get-SeenVersion $script:root
  if ($seen -eq $v) { return $false }
  Set-SeenVersion $script:root $v
  # No saved version on a fresh install: nothing was "updated".
  if ((-not $seen) -and (-not $script:previousInstall)) { return $false }
  Write-Log ("Updated to v" + $v + " (was " + $seen + "). Showing what's new.")
  Show-Balloon ("Updated to Clip Factory v" + $v + " " + $script:dash + " click to see what's new") "info" "whatsnew"
  return $true
}

# Restart this tray with the freshly pulled tray.ps1 (skips the pull, carries on starting).
function Restart-Tray {
  Write-Log "The launcher itself was updated; restarting it."
  $a = "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"" + $script:trayPath + "`" -SkipUpdate"
  if (-not $script:openWhenReady) { $a = $a + " -NoOpen" }
  $script:quitting = $true
  try { $script:timer.Stop() } catch {}
  try { $script:mutex.ReleaseMutex() } catch {}
  try { $script:mutex.Dispose() } catch {}
  $script:mutex = $null
  try { $script:notify.Visible = $false; $script:notify.Dispose() } catch {}
  $script:notify = $null
  try {
    Start-Process -FilePath $script:psExe -ArgumentList $a -WindowStyle Hidden
  } catch {
    Write-Log ("ERROR: couldn't restart the tray: " + $_.Exception.Message + " Open Clip Factory again.")
  }
  $script:ctx.ExitThread()
}

function Exit-Tray {
  Write-Log "Tray closed."
  $script:quitting = $true
  try { $script:timer.Stop() } catch {}
  try { $script:notify.Visible = $false; $script:notify.Dispose() } catch {}
  $script:notify = $null
  $script:ctx.ExitThread()
}

# Called when the running job finishes.
function Complete-Job($r) {
  $now = Get-Date
  switch ($script:phase) {
    "git-pull" {
      $script:version = Get-ClipFactoryVersion $script:root
      Update-Ui
      if ($r.Ok) {
        $after = Get-Head
        if ($after -and $script:headBefore -and ($after -ne $script:headBefore)) {
          Write-Log ("Updated " + $script:headBefore.Substring(0, 7) + " -> " + $after.Substring(0, 7) + ". Rebuilding (a few minutes).")
          $changed = @()
          try { $changed = @(& $script:git -C $script:repoRoot diff --name-only $script:headBefore $after 2>$null) } catch {}
          foreach ($f in $changed) {
            if (($f -like "*scripts/windows/tray.ps1") -or ($f -like "*scripts/windows/common.ps1")) {
              Restart-Tray
              return
            }
          }
        } else {
          Write-Log "Already up to date."
        }
      } else {
        Write-Log "Couldn't update (no internet, or files changed by hand). Starting the version you have."
      }
      Start-DockerCheck
      return
    }
    "docker-check" {
      if ($r.Ok) { Start-ComposeUp; return }
      $dd = Join-Path $env:ProgramFiles "Docker\Docker\Docker Desktop.exe"
      if (Test-Path -LiteralPath $dd) {
        Write-Log "Starting Docker Desktop..."
        Start-Process -FilePath $dd
      } else {
        Write-Log "Couldn't find Docker Desktop.exe; waiting in case it's starting anyway."
      }
      $script:phase = "docker-wait"
      Set-State $script:state "(starting Docker)"
      $script:deadline = $now.AddSeconds(240)
      $script:nextPollAt = $now.AddSeconds(5)
      return
    }
    "docker-wait" {
      if ($r.Ok) { Start-ComposeUp; return }
      if ($now -gt $script:deadline) {
        Stop-WithError "Docker didn't start. Open Docker Desktop, wait for 'Engine running', then right-click this icon and Start."
        return
      }
      $script:nextPollAt = $now.AddSeconds(3)
      return
    }
    "compose-up" {
      if (-not $r.Ok) {
        Stop-WithError "Something went wrong while starting."
        return
      }
      $script:phase = "health-wait"
      Set-State $script:state "(waiting for dashboard)"
      $script:deadline = $now.AddSeconds(240)
      $script:nextPollAt = $now
      return
    }
    "health-wait" {
      if ($r.Ok) { Set-Running; return }
      if ($now -gt $script:deadline) {
        Write-Log "ERROR: The dashboard didn't answer within 4 minutes. Still checking every 30s."
        $script:phase = "monitor"
        $script:failCount = 3
        $script:nextPollAt = $now.AddSeconds(30)
        Set-State "error" ""
        Show-Balloon ("The dashboard is slow to start. Right-click " + [char]0x2192 + " Show log.") "warning" "log"
        return
      }
      $script:nextPollAt = $now.AddSeconds(2)
      return
    }
    "monitor" {
      $script:nextPollAt = $now.AddSeconds(30)
      if ($r.Ok) {
        $script:failCount = 0
        if ($script:state -ne "running") { Set-Running }
        return
      }
      $script:failCount = $script:failCount + 1
      Write-Log ("Health check failed (" + $script:failCount + " in a row).")
      if ($script:failCount -ge 3 -and $script:state -eq "running") {
        Set-State "error" ""
        Show-Balloon ("Clip Factory stopped answering. Right-click " + [char]0x2192 + " Show log.") "error" "log"
      }
      return
    }
    "compose-down" {
      $script:phase = ""
      if (-not $r.Ok) { Write-Log "docker compose down reported a problem (see above)." }
      if ($script:afterStop -eq "quit") { Exit-Tray; return }
      if ($script:afterStop -eq "update") { Start-ClipFactory $true "updating"; return }
      Set-State "stopped" ""
      Show-Balloon "Clip Factory is stopped. Your clips and settings are kept." "info" "none"
      return
    }
  }
}

function Invoke-Tick {
  if ($script:ticking -or $script:quitting) { return }
  $script:ticking = $true
  try {
    # Another launch of "Clip Factory" asked us to open the window.
    if (Test-Path -LiteralPath $script:openFlag) {
      Remove-Item -LiteralPath $script:openFlag -Force -ErrorAction SilentlyContinue
      Request-Open $false
    }
    # "Stop Clip Factory" (stop.ps1) was used while we were watching it.
    if (Test-Path -LiteralPath $script:stopFlag) {
      Remove-Item -LiteralPath $script:stopFlag -Force -ErrorAction SilentlyContinue
      if ($script:phase -eq "monitor") {
        Stop-CurrentJob
        $script:phase = ""
        Set-State "stopped" ""
      }
    }
    if ($null -ne $script:job) {
      $r = Get-JobResult
      if ($null -ne $r) { Complete-Job $r }
      return
    }
    if ($script:phase -eq "docker-wait" -or $script:phase -eq "health-wait" -or $script:phase -eq "monitor") {
      if ((Get-Date) -ge $script:nextPollAt) {
        if ($script:phase -eq "docker-wait") {
          Start-HiddenStep ("`"" + $script:docker + "`" info") 30 "docker info"
        } else {
          Start-HealthCheck
        }
      }
    }
  } catch {
    Write-Log ("ERROR in timer: " + $_.Exception.Message + " (line " + $_.InvocationInfo.ScriptLineNumber + ")")
  } finally {
    $script:ticking = $false
  }
}

# ---------------------------------------------------------------- main

try {
  $script:previousInstall = ((Test-Path -LiteralPath $script:logPath) -or (Test-Path -LiteralPath $script:icoPath))
  if (-not (Test-Path -LiteralPath $script:storage)) { New-Item -ItemType Directory -Path $script:storage -Force | Out-Null }
  . (Join-Path $script:winDir "common.ps1")
  Add-Type -AssemblyName System.Windows.Forms
  Add-Type -AssemblyName System.Drawing
  [System.Windows.Forms.Application]::EnableVisualStyles()

  # Single instance: if the tray already runs, ask it to open the window and leave.
  $createdNew = $false
  $script:mutex = New-Object System.Threading.Mutex($true, "Local\ClipFactoryTray", [ref]$createdNew)
  if (-not $createdNew) {
    try { [System.IO.File]::WriteAllText($script:openFlag, "open") } catch {}
    # The running tray picks the flag up within a second. If nobody does, open the window ourselves.
    for ($i = 0; $i -lt 8; $i++) {
      Start-Sleep -Milliseconds 500
      if (-not (Test-Path -LiteralPath $script:openFlag)) { exit 0 }
    }
    Remove-Item -LiteralPath $script:openFlag -Force -ErrorAction SilentlyContinue
    Open-ClipFactoryWindow $script:url
    exit 0
  }

  Limit-Log
  Get-ChildItem -LiteralPath $script:storage -Filter "launcher-step-*.log" -ErrorAction SilentlyContinue | Remove-Item -Force -ErrorAction SilentlyContinue
  Remove-Item -LiteralPath $script:openFlag -Force -ErrorAction SilentlyContinue
  $script:version = Get-ClipFactoryVersion $script:root
  Write-Log ("---- Tray started (v" + $script:version + ", commit " + (Get-Head) + ")")

  # Icon (drawn in code) + a .ico copy for the shortcuts.
  $script:bmp = New-ClipFactoryBitmap 32
  $script:icon = [System.Drawing.Icon]::FromHandle($script:bmp.GetHicon())
  Invoke-Safe { if (-not (Test-Path -LiteralPath $script:icoPath)) { Save-ClipFactoryIcon $script:icoPath } }

  # Desktop shortcut -> this tray (also replaces the old shortcut to "Clip Factory.bat").
  Invoke-Safe {
    $lnk = Join-Path ([Environment]::GetFolderPath("Desktop")) "Clip Factory.lnk"
    if (Set-ClipFactoryShortcut $lnk $script:trayPath $script:root $script:icoPath "") { Write-Log "Desktop shortcut 'Clip Factory' now opens the tray app." }
  }
  # Start menu entry, so "Clip Factory" shows up in Windows search like any app.
  Invoke-Safe {
    $prog = Join-Path ([Environment]::GetFolderPath("Programs")) "Clip Factory.lnk"
    [void](Set-ClipFactoryShortcut $prog $script:trayPath $script:root $script:icoPath "")
  }
  # Keep the Startup shortcut pointing at this folder if it's turned on.
  Invoke-Safe {
    if (Test-Path -LiteralPath (Get-StartupLnk)) { [void](Set-ClipFactoryShortcut (Get-StartupLnk) $script:trayPath $script:root $script:icoPath "-NoOpen") }
  }

  # Menu
  $menu = New-Object System.Windows.Forms.ContextMenuStrip
  $script:miOpen = New-Object System.Windows.Forms.ToolStripMenuItem("Open Clip Factory")
  $script:miOpen.Font = New-Object System.Drawing.Font($script:miOpen.Font, [System.Drawing.FontStyle]::Bold)
  $script:miStart = New-Object System.Windows.Forms.ToolStripMenuItem("Start")
  $script:miStop = New-Object System.Windows.Forms.ToolStripMenuItem("Stop")
  $script:miUpdate = New-Object System.Windows.Forms.ToolStripMenuItem("Update now")
  $script:miAutostart = New-Object System.Windows.Forms.ToolStripMenuItem("Start when Windows starts")
  $script:miWhatsNew = New-Object System.Windows.Forms.ToolStripMenuItem("What's new")
  $script:miLog = New-Object System.Windows.Forms.ToolStripMenuItem("Show log")
  $script:miQuit = New-Object System.Windows.Forms.ToolStripMenuItem("Quit (keep running in background)")
  $script:miStopQuit = New-Object System.Windows.Forms.ToolStripMenuItem("Stop and quit")

  [void]$menu.Items.Add($script:miOpen)
  [void]$menu.Items.Add($script:miStart)
  [void]$menu.Items.Add($script:miStop)
  [void]$menu.Items.Add($script:miUpdate)
  [void]$menu.Items.Add((New-Object System.Windows.Forms.ToolStripSeparator))
  [void]$menu.Items.Add($script:miWhatsNew)
  [void]$menu.Items.Add($script:miAutostart)
  [void]$menu.Items.Add($script:miLog)
  [void]$menu.Items.Add((New-Object System.Windows.Forms.ToolStripSeparator))
  [void]$menu.Items.Add($script:miQuit)
  [void]$menu.Items.Add($script:miStopQuit)

  $script:miOpen.Add_Click({ Invoke-Safe { Request-Open $false } })
  $script:miStart.Add_Click({ Invoke-Safe { $script:openWhenReady = $true; $script:openPage = ""; Start-ClipFactory $false "starting" } })
  $script:miStop.Add_Click({ Invoke-Safe { Start-ComposeDown "none" } })
  $script:miUpdate.Add_Click({ Invoke-Safe {
    $script:openWhenReady = $true
    $script:openPage = ""
    if ($script:state -eq "stopped") { Start-ClipFactory $true "updating" } else { Start-ComposeDown "update" }
  } })
  $script:miAutostart.Add_Click({ Invoke-Safe {
    $lnk = Get-StartupLnk
    if (Test-Path -LiteralPath $lnk) {
      Remove-Item -LiteralPath $lnk -Force
      Write-Log "Start when Windows starts: off"
    } else {
      [void](Set-ClipFactoryShortcut $lnk $script:trayPath $script:root $script:icoPath "-NoOpen")
      Write-Log "Start when Windows starts: on"
    }
    Update-Ui
  } })
  $script:miWhatsNew.Add_Click({ Invoke-Safe { Request-Open $false "/whats-new" } })
  $script:miLog.Add_Click({ Invoke-Safe { Open-Log } })
  $script:miQuit.Add_Click({ Invoke-Safe { Exit-Tray } })
  $script:miStopQuit.Add_Click({ Invoke-Safe { Start-ComposeDown "quit" } })
  $menu.Add_Opening({ Invoke-Safe { Update-Ui } })

  # Tray icon
  $script:notify = New-Object System.Windows.Forms.NotifyIcon
  $script:notify.Icon = $script:icon
  $script:notify.ContextMenuStrip = $menu
  $script:notify.Text = "Clip Factory"
  $script:notify.Add_MouseClick({
    param($s, $e)
    if ($e.Button -eq [System.Windows.Forms.MouseButtons]::Left) { Invoke-Safe { Request-Open $true } }
  })
  $script:notify.Add_DoubleClick({ Invoke-Safe { Request-Open $true } })
  $script:notify.Add_BalloonTipClicked({ Invoke-Safe {
    if ($script:balloonAction -eq "log") { Open-Log }
    if ($script:balloonAction -eq "open") { Request-Open $false }
    if ($script:balloonAction -eq "whatsnew") { Request-Open $false "/whats-new" }
  } })
  $script:notify.Visible = $true

  $script:timer = New-Object System.Windows.Forms.Timer
  $script:timer.Interval = 1000
  $script:timer.Add_Tick({ Invoke-Tick })

  $script:openWhenReady = (-not $NoOpen)
  Start-ClipFactory (-not $SkipUpdate) "starting"
  $script:timer.Start()

  $script:ctx = New-Object System.Windows.Forms.ApplicationContext
  [System.Windows.Forms.Application]::Run($script:ctx)
} catch {
  Write-Log ("FATAL: " + $_.Exception.Message + " (line " + $_.InvocationInfo.ScriptLineNumber + ")")
} finally {
  try { if ($script:timer) { $script:timer.Stop() } } catch {}
  try { if ($script:notify) { $script:notify.Visible = $false; $script:notify.Dispose() } } catch {}
  try { if ($script:mutex) { $script:mutex.ReleaseMutex(); $script:mutex.Dispose() } } catch {}
}
