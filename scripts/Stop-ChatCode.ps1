$ErrorActionPreference = 'Stop'
$projectRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..')).Path
$tmp = Join-Path $projectRoot '.tmp'
$runtimeFile = Join-Path $tmp 'admin-server.json'
$stateFile = Join-Path $tmp 'chatcode-runtime-state.json'
$settingsFile = Join-Path $projectRoot 'data\tunnel-settings.json'
$runtimeHome = Join-Path $projectRoot 'data\tunnel-client\runtime-home'
$processesFile = Join-Path $runtimeHome 'processes.yaml'
$profileDir = Join-Path $projectRoot 'data\tunnel-client\profiles'
$adminEntry = Join-Path $projectRoot 'apps\server\admin.mjs'
$nodePath = (Get-Command node.exe -ErrorAction SilentlyContinue).Source
$stamp = Get-Date -Format 'yyyyMMdd-HHmmss-fff'
$logs = Join-Path $tmp 'logs'
if (-not (Test-Path -LiteralPath $tmp)) { New-Item -ItemType Directory -Path $tmp | Out-Null }
if (-not (Test-Path -LiteralPath $logs)) { New-Item -ItemType Directory -Path $logs | Out-Null }
$logFile = Join-Path $logs "stop-$stamp-$PID.ndjson"
$adminPid = 0
$tunnelRecord = $null
$tunnelProcess = $null
$stoppedChildPids = @()
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

function Write-State([string]$Status, $Admin, $Tunnel, $Children, [string]$ErrorMessage = '') {
  $state = [ordered]@{
    updatedAt = [DateTime]::UtcNow.ToString('o')
    service = @{ status = $Status; pid = $Admin }
    tunnel = $Tunnel
    stoppedMcpChildren = $Children
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

function ProcessStartedNear($Process, [string]$StartedAt, [int]$ToleranceSeconds = 45) {
  if (-not $StartedAt) { return $false }
  try {
    $expected = [DateTimeOffset]::Parse($StartedAt).UtcDateTime
    $actual = if ($Process.CreationDate -is [datetime]) { $Process.CreationDate.ToUniversalTime() } else { [Management.ManagementDateTimeConverter]::ToDateTime([string]$Process.CreationDate).ToUniversalTime() }
    return [Math]::Abs(($actual - $expected).TotalSeconds) -le $ToleranceSeconds
  } catch { return $false }
}

function ProcessStartedAfter($Process, [string]$StartedAt) {
  if (-not $StartedAt) { return $false }
  try {
    $expected = [DateTimeOffset]::Parse($StartedAt).UtcDateTime.AddSeconds(-5)
    $actual = if ($Process.CreationDate -is [datetime]) { $Process.CreationDate.ToUniversalTime() } else { [Management.ManagementDateTimeConverter]::ToDateTime([string]$Process.CreationDate).ToUniversalTime() }
    return $actual -ge $expected
  } catch { return $false }
}

function Test-AdminIdentity($Process, $Runtime) {
  if (-not $Process -or $Process.Name -ne 'node.exe') { return $false }
  $expectedNode = if ($Runtime.processPath) { [string]$Runtime.processPath } else { [string]$nodePath }
  if ($expectedNode -and -not [string]::Equals([string]$Process.ExecutablePath, $expectedNode, [System.StringComparison]::OrdinalIgnoreCase)) { return $false }
  if ([string]$Process.CommandLine -notlike "*$adminEntry*") { return $false }
  if ($Runtime.projectRoot -and -not [string]::Equals([string]$Runtime.projectRoot, [string]$projectRoot, [System.StringComparison]::OrdinalIgnoreCase)) { return $false }
  if ($Runtime.startedAt -and -not (ProcessStartedNear $Process ([string]$Runtime.startedAt) 45)) { return $false }
  return $true
}

function Test-TunnelIdentity($Process, $Record, $Settings, $ProfilePath, $ProfileName) {
  if (-not $Process -or -not $Record -or $Process.Name -ne 'tunnel-client.exe') { return $false }
  if (-not [string]::Equals([string]$Process.ExecutablePath, [string]$Settings.clientPath, [System.StringComparison]::OrdinalIgnoreCase)) { return $false }
  if (-not [string]::Equals([string]$Record.tunnel_id, [string]$Settings.tunnelId, [System.StringComparison]::Ordinal)) { return $false }
  if (-not [string]::Equals([string]$Record.profile_path, [string]$ProfilePath, [System.StringComparison]::OrdinalIgnoreCase)) { return $false }
  if (-not [string]::Equals([string]$Record.pid_executable, [string]$Settings.clientPath, [System.StringComparison]::OrdinalIgnoreCase)) { return $false }
  $command = [string]$Process.CommandLine
  if ($command -notlike '* run *' -or $command -notlike '*--profile*' -or $command -notlike "*--profile $ProfileName*") { return $false }
  if (-not (ProcessStartedNear $Process ([string]$Record.started_at) 90)) { return $false }
  return $true
}

function Invoke-ManagedTunnelStop([string]$ClientPath, [string]$Alias) {
  $info = New-Object System.Diagnostics.ProcessStartInfo
  $info.FileName = $ClientPath
  $info.Arguments = "runtimes stop $Alias --json"
  $info.WorkingDirectory = $projectRoot
  $info.UseShellExecute = $false
  $info.CreateNoWindow = $true
  $info.RedirectStandardOutput = $true
  $info.RedirectStandardError = $true
  $info.EnvironmentVariables['CHATCODE_HOME'] = $projectRoot
  $info.EnvironmentVariables['CHATCODE_DATA_DIR'] = (Join-Path $projectRoot 'data')
  $info.EnvironmentVariables['CHATCODE_TMP_DIR'] = $tmp
  $info.EnvironmentVariables['CODEX_HOME'] = $runtimeHome
  $info.EnvironmentVariables['XDG_CONFIG_HOME'] = $runtimeHome
  $info.EnvironmentVariables['TUNNEL_CLIENT_STATE_DIR'] = $runtimeHome
  $info.EnvironmentVariables['TUNNEL_CLIENT_PROFILE_DIR'] = $profileDir
  foreach ($key in @('HTTP_PROXY','HTTPS_PROXY','ALL_PROXY','NO_PROXY','http_proxy','https_proxy','all_proxy','no_proxy','TUNNEL_CLIENT_HTTP_PROXY','CONTROL_PLANE_HTTP_PROXY')) { $info.EnvironmentVariables.Remove($key) }
  $process = [System.Diagnostics.Process]::Start($info)
  if (-not $process.WaitForExit(25000)) {
    $processId = $process.Id
    $process.Kill()
    throw "The local tunnel-client stop command timed out (PID $processId)."
  }
  $stdout = $process.StandardOutput.ReadToEnd()
  $stderr = $process.StandardError.ReadToEnd()
  Write-Event 'tunnel_runtime_stop_command' $(if ($process.ExitCode -eq 0) { 'info' } else { 'warn' }) 'Ran the local tunnel-client runtime stop command.' @{ exitCode = $process.ExitCode; output = (($stdout + ' ' + $stderr).Trim() -replace '(?i)(Bearer\s+)\S+','$1[redacted]' -replace '\bsk-[A-Za-z0-9_-]{12,}\b','[redacted]') }
}

function Stop-VerifiedProcess($Process, [string]$Reason) {
  if (-not $Process) { return $false }
  $current = Get-ProcessById ([int]$Process.ProcessId)
  if (-not $current -or $current.CreationDate -ne $Process.CreationDate -or $current.ExecutablePath -ne $Process.ExecutablePath -or $current.CommandLine -ne $Process.CommandLine) { return $false }
  Write-Event 'targeted_process_stop' 'warn' $Reason @{ pid = $current.ProcessId; image = $current.ExecutablePath }
  Stop-Process -Id ([int]$current.ProcessId) -Force
  for ($attempt = 0; $attempt -lt 40; $attempt++) {
    Start-Sleep -Milliseconds 250
    if (-not (Get-ProcessById ([int]$current.ProcessId))) { return $true }
  }
  return $false
}

try {
  try { $lifecycleMutexOwned = $lifecycleMutex.WaitOne(60000) }
  catch [System.Threading.AbandonedMutexException] { $lifecycleMutexOwned = $true; Write-Event 'lifecycle_lock_recovered' 'warn' 'Recovered the abandoned per-project lifecycle lock.' }
  if (-not $lifecycleMutexOwned) { throw 'Another ChatCode Start/Stop operation still holds the lifecycle lock; retry after it finishes.' }
  Write-Event 'stop_begin' 'info' 'Starting a verified, project-scoped ChatCode shutdown.' @{ projectRoot = $projectRoot }
  if (Test-Path -LiteralPath $settingsFile) {
    $settingsItem = Get-Item -LiteralPath $settingsFile -Force
    if ($settingsItem.PSIsContainer -or ($settingsItem.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) { throw 'Tunnel settings is not an ordinary file; no process was stopped.' }
    $settings = Get-Content -Raw -LiteralPath $settingsFile | ConvertFrom-Json
    if ([string]$settings.profile -notmatch '^[a-z0-9][a-z0-9_-]{0,63}$' -or [string]$settings.tunnelId -notmatch '^[A-Za-z0-9_-]{1,256}$') { throw 'Tunnel settings contain invalid profile or tunnel identifiers; no process was stopped.' }
    $tunnelAlias = "chatcode-$([string]$settings.profile)"
    $profilePath = Join-Path $profileDir "$($settings.profile).yaml"
    if (Test-Path -LiteralPath $processesFile) {
      try {
        $registry = Get-Content -Raw -LiteralPath $processesFile | ConvertFrom-Json
        $candidate = $registry.PSObject.Properties[$tunnelAlias].Value
        if ($candidate -and [string]::Equals([string]$candidate.tunnel_id, [string]$settings.tunnelId, [System.StringComparison]::Ordinal) -and [string]::Equals([string]$candidate.profile_path, $profilePath, [System.StringComparison]::OrdinalIgnoreCase)) {
          $candidateProcess = Get-ProcessById ([int]$candidate.pid)
          if (-not $candidateProcess) { $tunnelRecord = $candidate }
          elseif (Test-TunnelIdentity $candidateProcess $candidate $settings $profilePath ([string]$settings.profile)) { $tunnelRecord = $candidate; $tunnelProcess = $candidateProcess }
        }
      } catch { Write-Event 'runtime_registry_read' 'warn' 'Could not verify the ChatCode tunnel runtime registry.' }
    }
  }

  $runtime = $null
  if (Test-Path -LiteralPath $runtimeFile) {
    $runtimeItem = Get-Item -LiteralPath $runtimeFile -Force
    if ($runtimeItem.PSIsContainer -or ($runtimeItem.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) { throw 'ChatCode runtime state is not an ordinary file; no PID was used.' }
    $runtime = Get-Content -LiteralPath $runtimeFile -Raw | ConvertFrom-Json
    $adminPid = [int]$runtime.pid
    $adminProcess = Get-ProcessById $adminPid
    if ($adminProcess -and (Test-AdminIdentity $adminProcess $runtime)) {
      $origin = [string]$runtime.origin
      $session = $null
      try {
        $session = Invoke-RestMethod -Uri "$origin/api/session" -TimeoutSec 3
        if ($session.origin -ne $origin) { throw 'The running service origin did not match its runtime record.' }
        Invoke-RestMethod -Uri "$origin/api/shutdown" -Method Post -Headers @{ Origin = $origin; 'X-ChatCode-CSRF' = [string]$session.csrf } -Body '{}' -ContentType 'application/json' -TimeoutSec 5 | Out-Null
        Write-Event 'admin_shutdown_requested' 'info' 'Requested graceful ChatCode shutdown through the local authenticated endpoint.' @{ pid = $adminPid }
      } catch { Write-Event 'admin_shutdown_request_failed' 'warn' $_.Exception.Message @{ pid = $adminPid } }
      $stopped = $false
      for ($attempt = 0; $attempt -lt 240; $attempt++) {
        Start-Sleep -Milliseconds 250
        $current = Get-ProcessById $adminPid
        if (-not $current) { $stopped = $true; break }
        if (-not (Test-AdminIdentity $current $runtime)) { throw 'The admin PID changed ownership during shutdown; refusing to terminate it.' }
      }
      if (-not $stopped) {
        $current = Get-ProcessById $adminPid
        if ($current -and (Test-AdminIdentity $current $runtime)) { $stopped = Stop-VerifiedProcess $current 'Graceful shutdown timed out; terminated only the verified ChatCode admin process.' }
      }
      if (-not $stopped) { throw 'The verified ChatCode admin process did not stop.' }
      if (Test-Path -LiteralPath $runtimeFile) {
        $latest = Get-Content -LiteralPath $runtimeFile -Raw | ConvertFrom-Json
        if ([int]$latest.pid -eq $adminPid) { Remove-Item -LiteralPath $runtimeFile -Force }
      }
    } elseif (-not $adminProcess) {
      Remove-Item -LiteralPath $runtimeFile -Force
      Write-Event 'stale_admin_state_removed' 'info' 'Removed stale ChatCode admin state after confirming the PID no longer exists.' @{ pid = $adminPid }
    } else {
      Remove-Item -LiteralPath $runtimeFile -Force
      Write-Event 'reused_admin_pid' 'warn' 'The recorded PID belongs to another process; removed only ChatCode stale state.' @{ pid = $adminPid; image = $adminProcess.ExecutablePath }
    }
  }

  if ($settings -and $tunnelRecord) {
    $stillRunning = if ($tunnelProcess) { Get-ProcessById ([int]$tunnelRecord.pid) } else { $null }
    if ($stillRunning -and (Test-TunnelIdentity $stillRunning $tunnelRecord $settings $profilePath ([string]$settings.profile))) {
      Invoke-ManagedTunnelStop ([string]$settings.clientPath) $tunnelAlias
      for ($attempt = 0; $attempt -lt 120; $attempt++) {
        Start-Sleep -Milliseconds 250
        $stillRunning = Get-ProcessById ([int]$tunnelRecord.pid)
        if (-not $stillRunning) { break }
        if (-not (Test-TunnelIdentity $stillRunning $tunnelRecord $settings $profilePath ([string]$settings.profile))) { throw 'The tunnel PID changed ownership during shutdown; refusing to terminate it.' }
      }
      if ($stillRunning) {
        if (-not (Stop-VerifiedProcess $stillRunning 'Managed runtime stop timed out; terminated only the verified ChatCode tunnel process.')) { throw 'The verified ChatCode tunnel process did not stop.' }
      }
      Write-Event 'tunnel_stopped' 'info' 'The verified ChatCode tunnel process exited.' @{ pid = $tunnelRecord.pid; tunnelIdConfigured = [bool]$settings.tunnelId }
    } elseif ($stillRunning) { throw 'The tunnel PID changed ownership during shutdown; refusing to terminate it.' }
    else { Write-Event 'tunnel_parent_absent' 'info' 'The recorded ChatCode tunnel process had already exited; checking only its recorded MCP child identity.' @{ pid = $tunnelRecord.pid } }
    $normalizedRoot = $projectRoot.TrimEnd('\').ToLowerInvariant() + '\'
    $children = @(Get-CimInstance Win32_Process | Where-Object {
      $command = ([string]$_.CommandLine).Replace('/', '\').ToLowerInvariant()
      $_.ParentProcessId -eq [int]$tunnelRecord.pid -and $_.Name -eq 'node.exe' -and
      $_.ExecutablePath -and $nodePath -and [string]::Equals([string]$_.ExecutablePath, [string]$nodePath, [System.StringComparison]::OrdinalIgnoreCase) -and
      $command.Contains($normalizedRoot) -and ($command.Contains('\apps\server\mcp.mjs') -or $command.Contains('\scripts\tunnel-mcp.mjs')) -and
      (ProcessStartedAfter $_ ([string]$tunnelRecord.started_at))
    })
    foreach ($child in $children) {
      if (-not (Stop-VerifiedProcess $child 'The verified ChatCode Tunnel MCP stdio child remained after its parent exited; stopped only that child.')) { throw "ChatCode MCP child PID $($child.ProcessId) did not stop." }
      $stoppedChildPids += [int]$child.ProcessId
    }
  }

  if ($runtime -and $adminPid -gt 0) {
    $normalizedRoot = $projectRoot.TrimEnd('\').ToLowerInvariant() + '\'
    $adminChildren = @(Get-CimInstance Win32_Process | Where-Object {
      $command = ([string]$_.CommandLine).Replace('/', '\').ToLowerInvariant()
      $_.ParentProcessId -eq $adminPid -and $_.Name -eq 'node.exe' -and $_.ExecutablePath -and
      [string]::Equals([string]$_.ExecutablePath, [string]$nodePath, [System.StringComparison]::OrdinalIgnoreCase) -and
      $command.Contains($normalizedRoot) -and ($command.Contains('\apps\server\mcp.mjs') -or $command.Contains('\scripts\tunnel-mcp.mjs')) -and
      (ProcessStartedAfter $_ ([string]$runtime.startedAt))
    })
    foreach ($child in $adminChildren) {
      if (-not (Stop-VerifiedProcess $child 'Stopped only a ChatCode admin-owned MCP diagnostic child that remained after service shutdown.')) { throw "ChatCode admin MCP child PID $($child.ProcessId) did not stop." }
      $stoppedChildPids += [int]$child.ProcessId
    }
  }

  $tunnelPid = $null
  if ($tunnelRecord) { $tunnelPid = $tunnelRecord.pid }
  $stopMessage = if ($adminPid -gt 0 -or $tunnelRecord) { 'ChatCode service and verified child processes stopped.' } else { 'ChatCode was already stopped.' }
  Write-State 'stopped' $adminPid @{ status = 'disconnected'; pid = $tunnelPid } $stoppedChildPids ''
  Write-Event 'stop_complete' 'info' $stopMessage @{ adminPid = $adminPid; tunnelPid = $tunnelPid; stoppedMcpChildPids = $stoppedChildPids }
  if ($adminPid -gt 0 -or $tunnelRecord) { Write-Output 'ChatCode service stopped.' } else { Write-Output 'ChatCode is already stopped.' }
  exit 0
} catch {
  $message = $_.Exception.Message
  try { Write-Event 'stop_failed' 'error' $message } catch { }
  try { Write-State 'failed' $adminPid @{ status = 'unknown'; pid = if ($tunnelRecord) { $tunnelRecord.pid } else { $null } } @() $message } catch { }
  Write-Error $message
  exit 1
} finally {
  if ($lifecycleMutexOwned) { $lifecycleMutex.ReleaseMutex() }
  $lifecycleMutex.Dispose()
}
