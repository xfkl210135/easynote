$ErrorActionPreference = "Stop"
$Desktop = [Environment]::GetFolderPath("Desktop")
$Launcher = Join-Path $PSScriptRoot "serve-easynote.ps1"
$Target = "$env:SystemRoot\System32\WindowsPowerShell\v1.0\powershell.exe"
$ShortcutPath = Join-Path $Desktop "EasyNote.lnk"

if (-not (Test-Path -LiteralPath $Launcher)) {
  throw "EasyNote launcher was not found: $Launcher"
}

$Shell = New-Object -ComObject WScript.Shell
$Shortcut = $Shell.CreateShortcut($ShortcutPath)
$Shortcut.TargetPath = $Target
$Shortcut.Arguments = "-NoLogo -NoProfile -ExecutionPolicy Bypass -File `"$Launcher`""
$Shortcut.WorkingDirectory = $PSScriptRoot
$Shortcut.Description = "Open EasyNote on the fixed local safety origin"
$Shortcut.WindowStyle = 1

$Edge = "C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe"
if (Test-Path -LiteralPath $Edge) {
  $Shortcut.IconLocation = "$Edge,0"
} else {
  $Shortcut.IconLocation = "$env:SystemRoot\System32\shell32.dll,70"
}

$Shortcut.Save()
Write-Host "EasyNote desktop shortcut created: $ShortcutPath" -ForegroundColor Green
