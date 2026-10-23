$ErrorActionPreference = 'Stop'
$projectRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..')).Path
$runtimeFile = Join-Path $projectRoot '.tmp\admin-server.json'
if (-not (Test-Path -LiteralPath $runtimeFile)) { Write-Output 'ChatCode management service is not running.'; exit 0 }

$runtimeItem = Get-Item -LiteralPath $runtimeFile -Force
if ($runtimeItem.PSIsContainer -or ($runtimeItem.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) { throw 'ChatCode runtime state is not a normal file; refusing to read or stop a PID.' }
$runtime = Get-Content -LiteralPath $runtimeFile -Raw | ConvertFrom-Json
$pidToStop = [int]$runtime.pid
$process = if ($pidToStop -gt 0) { Get-CimInstance Win32_Process -Filter "ProcessId=$pidToStop" -ErrorAction SilentlyContinue } else { $null }
if (-not $process) {
  $latest = Get-Content -LiteralPath $runtimeFile -Raw | ConvertFrom-Json
  if ([int]$latest.pid -eq $pidToStop) { Remove-Item -LiteralPath $runtimeFile -Force }
  Write-Output 'Removed stale ChatCode runtime state.'
  exit 0
}

$expectedScript = Join-Path $projectRoot 'apps\server\admin.mjs'
$commandLine = [string]$process.CommandLine
if ($process.Name -ne 'node.exe' -or $commandLine.IndexOf($expectedScript, [System.StringComparison]::OrdinalIgnoreCase) -lt 0) { throw 'PID does not belong to the ChatCode admin service; refusing to stop it.' }

$port = [int]$runtime.port
$expectedOrigin = "http://127.0.0.1:$port"
$token = [string]$runtime.controlToken
$shutdownRequested = $false
if ($port -ge 1024 -and $port -le 65535 -and [string]$runtime.origin -eq $expectedOrigin -and $token -match '^[a-f0-9]{64}$') {
  try {
    $reply = Invoke-RestMethod -Uri "$expectedOrigin/api/shutdown" -Method Post -Headers @{ Origin = $expectedOrigin; 'X-ChatCode-CSRF' = $token } -Body '{}' -ContentType 'application/json' -TimeoutSec 3
    $shutdownRequested = [string]$reply.status -eq 'shutting_down'
  } catch { }
}

$stopped = $false
for ($attempt = 0; $shutdownRequested -and $attempt -lt 240; $attempt++) {
  Start-Sleep -Milliseconds 250
  $current = Get-CimInstance Win32_Process -Filter "ProcessId=$pidToStop" -ErrorAction SilentlyContinue
  if (-not $current) { $stopped = $true; break }
  if ($current.Name -ne 'node.exe' -or ([string]$current.CommandLine).IndexOf($expectedScript, [System.StringComparison]::OrdinalIgnoreCase) -lt 0) { throw 'The recorded PID changed ownership while stopping; refusing to terminate it.' }
}

if (-not $stopped) {
  $current = Get-CimInstance Win32_Process -Filter "ProcessId=$pidToStop" -ErrorAction SilentlyContinue
  if ($current) {
    if ($current.Name -ne 'node.exe' -or ([string]$current.CommandLine).IndexOf($expectedScript, [System.StringComparison]::OrdinalIgnoreCase) -lt 0) { throw 'The recorded PID changed ownership while stopping; refusing to terminate it.' }
    Stop-Process -Id $pidToStop -Force
    for ($attempt = 0; $attempt -lt 20; $attempt++) {
      Start-Sleep -Milliseconds 100
      if (-not (Get-Process -Id $pidToStop -ErrorAction SilentlyContinue)) { $stopped = $true; break }
    }
  } else { $stopped = $true }
}

if (-not $stopped) { throw 'ChatCode admin process did not stop after the safe fallback.' }
if (Test-Path -LiteralPath $runtimeFile) {
  $latest = Get-Content -LiteralPath $runtimeFile -Raw | ConvertFrom-Json
  if ([int]$latest.pid -eq $pidToStop) { Remove-Item -LiteralPath $runtimeFile -Force }
}
Write-Output 'ChatCode management service stopped.'
