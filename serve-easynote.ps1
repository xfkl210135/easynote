param(
  [int]$Port = 4173,
  [switch]$NoBrowser
)

$ErrorActionPreference = "Stop"
$SourceRoot = [IO.Path]::GetFullPath($PSScriptRoot)
$AppRoot = Join-Path $SourceRoot "dist"
$BuiltIndex = Join-Path $AppRoot "index.html"

if (-not (Test-Path -LiteralPath $BuiltIndex)) {
  $Npm = Get-Command npm.cmd -ErrorAction SilentlyContinue
  if (-not $Npm) {
    Write-Host "EasyNote production files are missing and npm is not installed." -ForegroundColor Red
    Write-Host "Install Node.js, then run: npm install && npm run build"
    exit 1
  }
  Write-Host "Preparing the EasyNote production build..." -ForegroundColor Cyan
  Push-Location $SourceRoot
  try {
    & $Npm.Source run build
    if ($LASTEXITCODE -ne 0) { throw "EasyNote build failed with exit code $LASTEXITCODE" }
  } finally {
    Pop-Location
  }
}

$AppRoot = [IO.Path]::GetFullPath($AppRoot)
$RootPrefix = $AppRoot.TrimEnd([IO.Path]::DirectorySeparatorChar) + [IO.Path]::DirectorySeparatorChar
$Url = "http://localhost:$Port/"

function Test-EasyNoteServer {
  param([int]$Attempts = 1)
  for ($Attempt = 0; $Attempt -lt $Attempts; $Attempt++) {
    try {
      $Existing = Invoke-WebRequest -Uri $Url -UseBasicParsing -TimeoutSec 3
      if ($Existing.StatusCode -eq 200 -and $Existing.Content -match "EasyNote" -and $Existing.Content -match "assets/index-") {
        return $true
      }
    } catch {
      # A second launcher may be starting the listener. Retry below when requested.
    }
    if ($Attempt -lt ($Attempts - 1)) { Start-Sleep -Milliseconds 300 }
  }
  return $false
}

if (Test-EasyNoteServer) {
  if (-not $NoBrowser) { Start-Process $Url }
  Write-Host "EasyNote is already running. The browser has been opened." -ForegroundColor Green
  exit 0
}

$CreatedNew = $false
$ServerMutex = [Threading.Mutex]::new($true, "Local\EasyNoteServer-$Port", [ref]$CreatedNew)
if (-not $CreatedNew) {
  if (Test-EasyNoteServer -Attempts 12) {
    if (-not $NoBrowser) { Start-Process $Url }
    Write-Host "EasyNote startup was already in progress. The browser has been opened." -ForegroundColor Green
    $ServerMutex.Dispose()
    exit 0
  }
  Write-Host "Another EasyNote launcher owns the startup lock, but the server did not become ready." -ForegroundColor Red
  $ServerMutex.Dispose()
  exit 1
}

$ServerSource = Join-Path $SourceRoot "EasyNoteStaticServer.cs"
Add-Type -Path $ServerSource
$Server = New-Object EasyNoteStaticServer($AppRoot, $Port)
try {
  $Server.Start()
} catch {
  if (Test-EasyNoteServer -Attempts 12) {
    if (-not $NoBrowser) { Start-Process $Url }
    Write-Host "EasyNote was started by another launcher. The browser has been opened." -ForegroundColor Green
    $ServerMutex.ReleaseMutex(); $ServerMutex.Dispose()
    exit 0
  }
  Write-Host "Port $Port is occupied by another program. EasyNote keeps this fixed port to protect your browser database." -ForegroundColor Red
  $ServerMutex.ReleaseMutex(); $ServerMutex.Dispose()
  exit 1
}

Write-Host ""
Write-Host "EasyNote local safety server is running" -ForegroundColor Green
Write-Host "Address: $Url"
Write-Host "Close this window to stop the server. Verified notes remain in browser storage and your backup directory."
Write-Host ""
if (-not $NoBrowser) { Start-Process $Url }

try {
  $Server.Run()
} finally {
  $Server.Stop()
  $ServerMutex.ReleaseMutex()
  $ServerMutex.Dispose()
}
