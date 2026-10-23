param([switch]$NoBrowser)
$ErrorActionPreference = 'Stop'
$projectRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..')).Path
$node = (Get-Command node.exe -ErrorAction Stop).Source
$tmp = Join-Path $projectRoot '.tmp'
$runtimeFile = Join-Path $tmp 'admin-server.json'
$logs = Join-Path $tmp 'logs'
$stdout = Join-Path $logs 'admin.stdout.log'
$stderr = Join-Path $logs 'admin.stderr.log'
$entryScript = Join-Path $projectRoot 'apps\server\admin.mjs'
$expectedCommand = '"' + $entryScript + '"'
$port = 39721
$url = "http://127.0.0.1:$port"

if (Test-Path -LiteralPath $tmp) {
  $tmpItem = Get-Item -LiteralPath $tmp -Force
  if (-not $tmpItem.PSIsContainer -or ($tmpItem.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) { throw 'ChatCode .tmp must be a normal local directory.' }
} else { New-Item -ItemType Directory -Path $tmp | Out-Null }

if (-not (Test-Path -LiteralPath (Join-Path $projectRoot 'node_modules\@modelcontextprotocol\server\package.json'))) {
  throw 'ChatCode dependencies are not installed. Run npm install from the ChatCode directory first.'
}
if (Test-Path -LiteralPath $logs) {
  $logsItem = Get-Item -LiteralPath $logs -Force
  if (-not $logsItem.PSIsContainer -or ($logsItem.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) { throw 'ChatCode log directory must be a normal directory.' }
} else { New-Item -ItemType Directory -Path $logs | Out-Null }
foreach ($logFile in @($stdout, $stderr)) {
  if (Test-Path -LiteralPath $logFile) {
    $logItem = Get-Item -LiteralPath $logFile -Force
    if ($logItem.PSIsContainer -or ($logItem.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) { throw 'ChatCode log targets must be normal files.' }
  }
}
if (Test-Path -LiteralPath $runtimeFile) {
  $runtimeItem = Get-Item -LiteralPath $runtimeFile -Force
  if ($runtimeItem.PSIsContainer -or ($runtimeItem.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) { throw 'ChatCode runtime state is not a normal file.' }
  try { $runtime = Get-Content -LiteralPath $runtimeFile -Raw | ConvertFrom-Json }
  catch { throw 'ChatCode runtime state is invalid; inspect it before starting another service.' }
  $chatCodePid = [int]$runtime.pid
  $running = if ($chatCodePid -gt 0) { Get-CimInstance Win32_Process -Filter "ProcessId=$chatCodePid" -ErrorAction SilentlyContinue } else { $null }
  if ($running) {
    if ([string]$running.CommandLine.IndexOf($expectedCommand, [System.StringComparison]::OrdinalIgnoreCase) -lt 0) { throw 'Runtime PID belongs to another command; refusing to reuse or stop it.' }
    try {
      if ((Invoke-RestMethod -Uri "$url/healthz" -TimeoutSec 2).status -eq 'ok') {
        $session = Invoke-RestMethod -Uri "$url/api/session" -TimeoutSec 2
        if ([int]$session.apiVersion -ne 2 -or [string]$session.origin -ne $url) { throw 'An older ChatCode admin service is running. Stop it with scripts\Stop-ChatCode.ps1, then start ChatCode again.' }
        if (-not $NoBrowser) { Start-Process $url }
        exit 0
      }
    } catch {
      if ($_.Exception.Message -like 'An older ChatCode admin service is running.*') { throw }
      throw 'ChatCode process exists but its health or session endpoint is unavailable; inspect its logs before retrying.'
    }
    throw 'ChatCode process exists but did not report a healthy status.'
  }
  Remove-Item -LiteralPath $runtimeFile -Force
}

$process = Start-Process -FilePath $node -ArgumentList @($expectedCommand) -WorkingDirectory $projectRoot -WindowStyle Hidden -PassThru -RedirectStandardOutput $stdout -RedirectStandardError $stderr
$ready = $false
for ($attempt = 0; $attempt -lt 40; $attempt++) {
  Start-Sleep -Milliseconds 250
  try {
    $health = Invoke-RestMethod -Uri "$url/healthz" -TimeoutSec 2
    $session = Invoke-RestMethod -Uri "$url/api/session" -TimeoutSec 2
    if ($health.status -eq 'ok' -and [int]$session.apiVersion -eq 2 -and [string]$session.origin -eq $url) { $ready = $true; break }
  } catch { }
  if ($process.HasExited) { break }
}
if (-not $ready) {
  if (-not $process.HasExited) { Stop-Process -Id $process.Id -Force -ErrorAction SilentlyContinue }
  throw "ChatCode failed to start. Check $stderr and $stdout."
}
if (-not $NoBrowser) { Start-Process $url }
