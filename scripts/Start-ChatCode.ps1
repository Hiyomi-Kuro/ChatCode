param([switch]$NoBrowser)
$ErrorActionPreference = 'Stop'
$projectRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..')).Path
$nodeCommand = Get-Command node.exe -ErrorAction SilentlyContinue
$nodePath = if ($nodeCommand) { $nodeCommand.Source } else { '' }
$tmp = Join-Path $projectRoot '.tmp'
$runtimeFile = Join-Path $tmp 'admin-server.json'
$stateFile = Join-Path $tmp 'chatcode-runtime-state.json'
$logs = Join-Path $tmp 'logs'
$entryScript = Join-Path $projectRoot 'apps\server\admin.mjs'
$port = 39721
$url = "http://127.0.0.1:$port"
$stamp = Get-Date -Format 'yyyyMMdd-HHmmss-fff'

if (-not (Test-Path -LiteralPath $tmp)) { New-Item -ItemType Directory -Path $tmp | Out-Null }
if (-not (Test-Path -LiteralPath $logs)) { New-Item -ItemType Directory -Path $logs | Out-Null }
foreach ($directory in @($tmp, $logs)) {
  $item = Get-Item -LiteralPath $directory -Force
  if (-not $item.PSIsContainer -or ($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) { throw 'ChatCode runtime and log directories must be ordinary local directories.' }
}
$logFile = Join-Path $logs "start-$stamp-$PID.ndjson"
$stdin = Join-Path $logs "admin-$stamp-$PID.stdin.log"
$stdout = Join-Path $logs "admin-$stamp-$PID.stdout.log"
$stderr = Join-Path $logs "admin-$stamp-$PID.stderr.log"
$sha256 = [Security.Cryptography.SHA256]::Create()
$mutexSuffix = [BitConverter]::ToString($sha256.ComputeHash([Text.Encoding]::UTF8.GetBytes($projectRoot.ToLowerInvariant()))).Replace('-', '').Substring(0, 20)
$sha256.Dispose()
$lifecycleMutex = [System.Threading.Mutex]::new($false, "Local\ChatCodeLifecycle-$mutexSuffix")
$lifecycleMutexOwned = $false

function Write-Event([string]$Event, [string]$Level, [string]$Message, $Data = $null) {
  $record = [ordered]@{ at = [DateTime]::UtcNow.ToString('o'); event = $Event; level = $Level; message = $Message }
  if ($null -ne $Data) { $record.data = $Data }
  $record | ConvertTo-Json -Compress -Depth 7 | Add-Content -LiteralPath $logFile -Encoding utf8
}

function Write-State($Service, $Mcp, $Proxy, $Tunnel, [string]$ErrorMessage = '') {
  $state = [ordered]@{
    updatedAt = [DateTime]::UtcNow.ToString('o')
    service = $Service
    mcp = $Mcp
    proxy = $Proxy
    tunnel = $Tunnel
    lastError = $ErrorMessage
  }
  $temporary = "$stateFile.$PID.tmp"
  $state | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $temporary -Encoding utf8
  Move-Item -LiteralPath $temporary -Destination $stateFile -Force
}

function Get-ProcessById([int]$ProcessId) {
  if ($ProcessId -le 0) { return $null }
  return Get-CimInstance Win32_Process -Filter "ProcessId=$ProcessId" -ErrorAction SilentlyContinue
}

function Test-AdminIdentity($Process, $Runtime) {
  if (-not $Process -or $Process.Name -ne 'node.exe') { return $false }
  $expectedScript = Join-Path $projectRoot 'apps\server\admin.mjs'
  $expectedNode = if ($Runtime.processPath) { [string]$Runtime.processPath } else { [string]$nodePath }
  if (-not $expectedNode -or -not [string]::Equals([string]$Process.ExecutablePath, $expectedNode, [System.StringComparison]::OrdinalIgnoreCase)) { return $false }
  if ([string]$Process.CommandLine -notlike "*$expectedScript*") { return $false }
  if ($Runtime.processPath -and -not [string]::Equals([string]$Runtime.processPath, [string]$Process.ExecutablePath, [System.StringComparison]::OrdinalIgnoreCase)) { return $false }
  if ($Runtime.projectRoot -and -not [string]::Equals([string]$Runtime.projectRoot, [string]$projectRoot, [System.StringComparison]::OrdinalIgnoreCase)) { return $false }
  if ($Runtime.startedAt) {
    try {
      $expectedStart = [DateTimeOffset]::Parse([string]$Runtime.startedAt).UtcDateTime
      $actualStart = if ($Process.CreationDate -is [datetime]) { $Process.CreationDate.ToUniversalTime() } else { [Management.ManagementDateTimeConverter]::ToDateTime([string]$Process.CreationDate).ToUniversalTime() }
      if ([Math]::Abs(($actualStart - $expectedStart).TotalSeconds) -gt 45) { return $false }
    } catch { return $false }
  }
  return $true
}

function Invoke-LocalPost([string]$Path, $Session, [int]$TimeoutSec = 90) {
  return Invoke-RestMethod -Uri "$url$Path" -Method Post -Headers @{ Origin = $url; 'X-ChatCode-CSRF' = [string]$Session.csrf } -Body '{}' -ContentType 'application/json' -TimeoutSec $TimeoutSec
}

function Stop-ExistingAdmin($Process, $Runtime) {
  if (-not (Test-AdminIdentity $Process $Runtime)) { throw 'The recorded PID does not match this ChatCode admin process; refusing to stop it.' }
  try {
    $session = Invoke-RestMethod -Uri "$url/api/session" -TimeoutSec 2
    Invoke-LocalPost '/api/shutdown' $session 5 | Out-Null
  } catch { Write-Event 'graceful_shutdown_unavailable' 'warn' 'Local shutdown endpoint was unavailable; waiting before the verified-process fallback.' @{ pid = $Process.ProcessId } }
  for ($attempt = 0; $attempt -lt 240; $attempt++) {
    Start-Sleep -Milliseconds 250
    $current = Get-ProcessById ([int]$Runtime.pid)
    if (-not $current) { return }
    if (-not (Test-AdminIdentity $current $Runtime)) { throw 'The admin PID changed ownership during shutdown; refusing to terminate it.' }
  }
  $current = Get-ProcessById ([int]$Runtime.pid)
  if ($current -and (Test-AdminIdentity $current $Runtime)) {
    Stop-Process -Id ([int]$Runtime.pid) -Force
    for ($attempt = 0; $attempt -lt 40; $attempt++) {
      Start-Sleep -Milliseconds 250
      if (-not (Get-ProcessById ([int]$Runtime.pid))) { return }
    }
    throw 'The verified ChatCode admin process did not exit after the targeted fallback.'
  }
}

function Start-LocalChecks($Session) {
  $mcp = $null
  $proxyTcp = $null
  $proxyApi = $null
  $tunnel = $null
  try {
    $mcp = Invoke-LocalPost '/api/mcp/diagnostic' $Session 45
    Write-Event 'mcp_diagnostic' 'info' ([string]$mcp.message) @{ status = $mcp.status; toolCount = $mcp.toolCount; checkedAt = $mcp.checkedAt }
  } catch { Write-Event 'mcp_diagnostic' 'warn' $_.Exception.Message }
  try {
    $proxyTcp = Invoke-LocalPost '/api/tunnel/proxy/tcp' $Session 10
    Write-Event 'proxy_tcp' $(if ($proxyTcp.status -eq 'available') { 'info' } else { 'warn' }) ([string]$proxyTcp.message) @{ status = $proxyTcp.status; address = $proxyTcp.address; checkedAt = $proxyTcp.checkedAt }
    $proxyApi = Invoke-LocalPost '/api/tunnel/proxy/api' $Session 15
    Write-Event 'proxy_api' $(if ($proxyApi.status -eq 'reachable') { 'info' } elseif ($proxyApi.status -eq 'rate_limited') { 'warn' } else { 'error' }) ([string]$proxyApi.message) @{ status = $proxyApi.status; httpStatus = $proxyApi.httpStatus; requestId = $proxyApi.requestId; checkedAt = $proxyApi.checkedAt }
  } catch { Write-Event 'proxy_probe' 'warn' $_.Exception.Message }
  try {
    $tunnel = Invoke-LocalPost '/api/tunnel/start' $Session 90
    Write-Event 'tunnel_start' $(if ($tunnel.status -eq 'connected') { 'info' } elseif ($tunnel.status -in @('waiting_proxy','control_plane_degraded','starting')) { 'warn' } else { 'error' }) ([string]$tunnel.message) @{ status = $tunnel.status; running = $tunnel.running; pollSucceeded = $tunnel.controlPlane.pollSucceeded; controlPlane = $tunnel.controlPlane }
  } catch {
    Write-Event 'tunnel_start' 'warn' $_.Exception.Message
    try { $tunnel = Invoke-RestMethod -Uri "$url/api/tunnel/status" -TimeoutSec 8 }
    catch { Write-Event 'tunnel_status_fallback' 'warn' $_.Exception.Message }
  }

  $latest = $tunnel
  if ($null -ne $tunnel -and $tunnel.running -and $tunnel.status -in @('starting','control_plane_degraded')) {
    for ($attempt = 0; $attempt -lt 15; $attempt++) {
      Start-Sleep -Seconds 2
      try {
        $latest = Invoke-RestMethod -Uri "$url/api/tunnel/status" -TimeoutSec 5
        if ($latest.status -eq 'connected') { break }
      } catch { break }
    }
    Write-Event 'tunnel_poll_observation' $(if ($latest.status -eq 'connected') { 'info' } else { 'warn' }) ([string]$latest.message) @{ status = $latest.status; running = $latest.running; pollSucceeded = $latest.controlPlane.pollSucceeded; controlPlane = $latest.controlPlane }
  }

  $service = @{ status = 'ready'; pid = (Get-ProcessById ([int]$Session.pid)).ProcessId; port = $port; origin = $url }
  $proxy = @{ tcp = $proxyTcp; api = $proxyApi }
  Write-State $service $mcp $proxy $latest
  return @{ mcp = $mcp; proxyTcp = $proxyTcp; proxyApi = $proxyApi; tunnel = $latest }
}

try {
  try { $lifecycleMutexOwned = $lifecycleMutex.WaitOne(60000) }
  catch [System.Threading.AbandonedMutexException] { $lifecycleMutexOwned = $true; Write-Event 'lifecycle_lock_recovered' 'warn' 'Recovered the abandoned per-project lifecycle lock.' }
  if (-not $lifecycleMutexOwned) { throw 'Another ChatCode Start/Stop operation still holds the lifecycle lock; retry after it finishes.' }
  Write-Event 'start_begin' 'info' 'Starting or reusing the ChatCode management service.' @{ projectRoot = $projectRoot; nodePath = $nodePath; port = $port }
  if (-not (Test-Path -LiteralPath (Join-Path $projectRoot 'node_modules\@modelcontextprotocol\server\package.json'))) {
    throw 'ChatCode dependencies are missing. Run npm install in the ChatCode project directory.'
  }

  $session = $null
  $runtime = $null
  if (Test-Path -LiteralPath $runtimeFile) {
    $runtimeItem = Get-Item -LiteralPath $runtimeFile -Force
    if ($runtimeItem.PSIsContainer -or ($runtimeItem.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) { throw 'ChatCode runtime state is not an ordinary file.' }
    try { $runtime = Get-Content -LiteralPath $runtimeFile -Raw | ConvertFrom-Json }
    catch { throw 'ChatCode runtime state is invalid; inspect the startup logs before retrying.' }
    $running = Get-ProcessById ([int]$runtime.pid)
    if ($running -and (Test-AdminIdentity $running $runtime)) {
      $upgradeRequired = $false
      try {
        $health = Invoke-RestMethod -Uri "$url/healthz" -TimeoutSec 2
        $session = Invoke-RestMethod -Uri "$url/api/session" -TimeoutSec 2
        if ($health.status -ne 'ok' -or $session.origin -ne $url) { throw 'The recorded ChatCode service returned an unexpected identity.' }
        $upgradeRequired = [int]$session.runtimeVersion -lt 7
      } catch {
        if ($_.Exception.Message -like 'The recorded ChatCode service returned an unexpected identity.*') { throw }
        Write-Event 'unhealthy_existing_service' 'warn' 'The verified ChatCode process did not answer health checks; restarting only that process.' @{ pid = $running.ProcessId }
        Stop-ExistingAdmin $running $runtime
        $session = $null
      }
      if ($session -and $upgradeRequired) {
        Write-Event 'upgrade_restart' 'info' 'Stopping the verified older ChatCode service before starting this version.' @{ pid = $running.ProcessId }
        Stop-ExistingAdmin $running $runtime
        $session = $null
      }
    } elseif ($running) {
      Write-Event 'stale_runtime_state' 'warn' 'The recorded PID belongs to a different process; removing only the stale ChatCode state file.' @{ pid = $runtime.pid }
      Remove-Item -LiteralPath $runtimeFile -Force
      $runtime = $null
    } else {
      Remove-Item -LiteralPath $runtimeFile -Force
      $runtime = $null
    }
  }

  if (-not $session) {
    if (-not $nodePath) { throw 'node.exe was not found on PATH; ChatCode could not start. Install Node.js and retry.' }
    $listeners = @(Get-NetTCPConnection -State Listen -LocalPort $port -ErrorAction SilentlyContinue)
    if ($listeners.Count -gt 0) { throw "Port $port is occupied by another process; ChatCode did not stop it." }
    $adminArgs = '"' + $entryScript + '"'
    $stdinStream = [System.IO.File]::Open($stdin, [System.IO.FileMode]::CreateNew, [System.IO.FileAccess]::Write, [System.IO.FileShare]::None)
    $stdinStream.Dispose()
    $process = Start-Process -FilePath $nodePath -ArgumentList $adminArgs -WorkingDirectory $projectRoot -WindowStyle Hidden -PassThru -RedirectStandardInput $stdin -RedirectStandardOutput $stdout -RedirectStandardError $stderr
    Write-Event 'admin_spawned' 'info' 'Started the verified ChatCode admin entry point.' @{ pid = $process.Id; image = $nodePath; script = $entryScript }
    for ($attempt = 0; $attempt -lt 60; $attempt++) {
      Start-Sleep -Milliseconds 250
      if ($process.HasExited) { break }
      try {
        $health = Invoke-RestMethod -Uri "$url/healthz" -TimeoutSec 2
        $candidate = Invoke-RestMethod -Uri "$url/api/session" -TimeoutSec 2
        if ($health.status -eq 'ok' -and $candidate.origin -eq $url -and [int]$candidate.runtimeVersion -ge 7) { $session = $candidate; break }
      } catch { }
    }
    if (-not $session) {
      $current = Get-ProcessById $process.Id
      if ($current -and [string]::Equals([string]$current.ExecutablePath, $nodePath, [System.StringComparison]::OrdinalIgnoreCase) -and [string]$current.CommandLine -like "*$entryScript*") { Stop-Process -Id $process.Id -Force -ErrorAction SilentlyContinue }
      throw "ChatCode failed to become HTTP-ready. Inspect $stderr and $stdout."
    }
    Write-Event 'admin_ready' 'info' 'The local management API is healthy and its version identity matched.' @{ pid = $session.pid; port = $session.port; runtimeVersion = $session.runtimeVersion }
  } else {
    Write-Event 'admin_reused' 'info' 'Reused the healthy ChatCode management service.' @{ pid = $session.pid; port = $session.port; runtimeVersion = $session.runtimeVersion }
  }

  $checks = Start-LocalChecks $session
  if (-not $NoBrowser) { Start-Process $url }
  if ($checks.tunnel.status -eq 'waiting_proxy') {
    Write-Output "ChatCode is ready at $url. The saved proxy is unavailable; automatic retries are scheduled."
  } elseif ($checks.tunnel.status -eq 'control_plane_degraded') {
    Write-Output "ChatCode is ready at $url. The Tunnel process is running, but control-plane polling is degraded."
  } elseif ($checks.tunnel.status -eq 'starting') {
    Write-Output "ChatCode is ready at $url. Tunnel is running; control-plane polling has not succeeded yet."
  } elseif ($checks.tunnel.status -eq 'error') {
    Write-Output "ChatCode is ready at $url, but Tunnel startup reported an error. See the newest start log."
  } else {
    Write-Output "ChatCode is ready at $url."
  }
  Write-Event 'start_complete' 'info' 'ChatCode local startup flow completed.' @{ pid = $session.pid; tunnelStatus = $checks.tunnel.status; pollSucceeded = $checks.tunnel.controlPlane.pollSucceeded; toolCount = $checks.mcp.toolCount }
  exit 0
} catch {
  $message = $_.Exception.Message
  try { Write-Event 'start_failed' 'error' $message } catch { }
  try { Write-State @{ status = 'failed'; port = $port } $null $null $null $message } catch { }
  Write-Error $message
  exit 1
} finally {
  if ($lifecycleMutexOwned) { $lifecycleMutex.ReleaseMutex() }
  $lifecycleMutex.Dispose()
}
