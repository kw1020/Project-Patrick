# Shared helpers for the Clip Factory Windows launchers (tray.ps1 and start.ps1).
# Dot-sourced: . (Join-Path $PSScriptRoot "common.ps1")
# Keep this file plain ASCII: Windows PowerShell 5.1 reads BOM-less files as ANSI.

# Finds Chrome, then Edge. Returns the full path, or $null when neither is installed.
function Find-AppBrowser {
  $candidates = @()
  if ($env:ProgramFiles) { $candidates += (Join-Path $env:ProgramFiles "Google\Chrome\Application\chrome.exe") }
  if (${env:ProgramFiles(x86)}) { $candidates += (Join-Path ${env:ProgramFiles(x86)} "Google\Chrome\Application\chrome.exe") }
  if ($env:LOCALAPPDATA) { $candidates += (Join-Path $env:LOCALAPPDATA "Google\Chrome\Application\chrome.exe") }
  if (${env:ProgramFiles(x86)}) { $candidates += (Join-Path ${env:ProgramFiles(x86)} "Microsoft\Edge\Application\msedge.exe") }
  if ($env:ProgramFiles) { $candidates += (Join-Path $env:ProgramFiles "Microsoft\Edge\Application\msedge.exe") }
  foreach ($c in $candidates) {
    if (Test-Path -LiteralPath $c) { return $c }
  }
  return $null
}

# Opens the dashboard in its own app window (no tabs, no address bar).
# Falls back to the default browser when Chrome and Edge are both missing.
function Open-ClipFactoryWindow([string]$url) {
  $browser = Find-AppBrowser
  if ($browser) {
    $appArgs = "--app=" + $url + " --window-size=1400,900"
    Start-Process -FilePath $browser -ArgumentList $appArgs
  } else {
    Start-Process $url
  }
}

# Draws the Clip Factory logo (pink to amber rounded square with "CF") at any size.
function New-ClipFactoryBitmap([int]$size) {
  Add-Type -AssemblyName System.Drawing
  $bmp = New-Object System.Drawing.Bitmap($size, $size)
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
  $g.TextRenderingHint = [System.Drawing.Text.TextRenderingHint]::AntiAlias
  $g.Clear([System.Drawing.Color]::Transparent)
  $scale = [single]($size / 32.0)
  $g.ScaleTransform($scale, $scale)
  $rect = New-Object System.Drawing.Rectangle(0, 0, 32, 32)
  $c1 = [System.Drawing.ColorTranslator]::FromHtml("#ff3d81")
  $c2 = [System.Drawing.ColorTranslator]::FromHtml("#ffb547")
  $brush = New-Object System.Drawing.Drawing2D.LinearGradientBrush($rect, $c1, $c2, [single]45)
  $path = New-Object System.Drawing.Drawing2D.GraphicsPath
  $path.AddArc([single]0, [single]0, [single]14, [single]14, [single]180, [single]90)
  $path.AddArc([single]17, [single]0, [single]14, [single]14, [single]270, [single]90)
  $path.AddArc([single]17, [single]17, [single]14, [single]14, [single]0, [single]90)
  $path.AddArc([single]0, [single]17, [single]14, [single]14, [single]90, [single]90)
  $path.CloseFigure()
  $g.FillPath($brush, $path)
  $font = New-Object System.Drawing.Font("Segoe UI", [single]14, [System.Drawing.FontStyle]::Bold, [System.Drawing.GraphicsUnit]::Pixel)
  $fmt = New-Object System.Drawing.StringFormat
  $fmt.Alignment = [System.Drawing.StringAlignment]::Center
  $fmt.LineAlignment = [System.Drawing.StringAlignment]::Center
  $box = New-Object System.Drawing.RectangleF([single]0, [single]0, [single]32, [single]32)
  $g.DrawString("CF", $font, [System.Drawing.Brushes]::White, $box, $fmt)
  $font.Dispose()
  $fmt.Dispose()
  $brush.Dispose()
  $path.Dispose()
  $g.Dispose()
  return $bmp
}

# Writes a .ico file (one 256x256 PNG image inside, supported since Windows Vista) for shortcuts.
function Save-ClipFactoryIcon([string]$icoPath) {
  $bmp = New-ClipFactoryBitmap 256
  $ms = New-Object System.IO.MemoryStream
  $bmp.Save($ms, [System.Drawing.Imaging.ImageFormat]::Png)
  $png = $ms.ToArray()
  $ms.Dispose()
  $bmp.Dispose()
  $fs = [System.IO.File]::Create($icoPath)
  $bw = New-Object System.IO.BinaryWriter($fs)
  $bw.Write([UInt16]0)              # reserved
  $bw.Write([UInt16]1)              # type: icon
  $bw.Write([UInt16]1)              # one image
  $bw.Write([byte]0)                # width 256 (0 means 256)
  $bw.Write([byte]0)                # height 256
  $bw.Write([byte]0)                # no palette
  $bw.Write([byte]0)                # reserved
  $bw.Write([UInt16]1)              # colour planes
  $bw.Write([UInt16]32)             # bits per pixel
  $bw.Write([UInt32]$png.Length)    # image size in bytes
  $bw.Write([UInt32]22)             # image offset (6 + 16)
  $bw.Write($png)
  $bw.Close()
  $fs.Close()
}

# Creates or updates a shortcut that starts the tray app hidden.
# Returns $true when the shortcut was written, $false when it was already right.
function Set-ClipFactoryShortcut([string]$lnkPath, [string]$trayPath, [string]$workDir, [string]$iconPath, [string]$extraArgs) {
  $psExe = Join-Path $env:SystemRoot "System32\WindowsPowerShell\v1.0\powershell.exe"
  $arguments = "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"" + $trayPath + "`""
  if ($extraArgs) { $arguments = $arguments + " " + $extraArgs }
  if ($iconPath -and (Test-Path -LiteralPath $iconPath)) { $iconLoc = $iconPath + ",0" } else { $iconLoc = $psExe + ",0" }
  $ws = New-Object -ComObject WScript.Shell
  $s = $ws.CreateShortcut($lnkPath)
  if ((Test-Path -LiteralPath $lnkPath) -and ($s.TargetPath -eq $psExe) -and ($s.Arguments -eq $arguments) -and ($s.WorkingDirectory -eq $workDir) -and ($s.IconLocation -eq $iconLoc)) {
    return $false
  }
  $s.TargetPath = $psExe
  $s.Arguments = $arguments
  $s.WorkingDirectory = $workDir
  $s.IconLocation = $iconLoc
  $s.WindowStyle = 7
  $s.Description = "Clip Factory"
  $s.Save()
  return $true
}
