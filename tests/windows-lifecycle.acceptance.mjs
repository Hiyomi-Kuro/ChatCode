import assert from "node:assert/strict"
import { execFileSync, spawnSync } from "node:child_process"
import { appendFileSync } from "node:fs"
import { mkdir, writeFile } from "node:fs/promises"
import { createServer } from "node:net"
import http from "node:http"
import path from "node:path"
import { fileURLToPath } from "node:url"

if (process.platform !== "win32") throw new Error("Windows lifecycle acceptance must run on Windows.")

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const startCmd = path.join(projectRoot, "scripts", "Start-ChatCode.cmd")
const stopCmd = path.join(projectRoot, "scripts", "Stop-ChatCode.cmd")
const evidenceDir = path.join(projectRoot, ".tmp", "tests", "windows-lifecycle")
const origin = "http://127.0.0.1:39721"
const stamp = new Date().toISOString().replaceAll(":", "-")
const evidencePath = path.join(evidenceDir, `acceptance-${stamp}.json`)
const progressPath = path.join(evidenceDir, `progress-${stamp}.ndjson`)
const evidence = {
  startedAt: new Date().toISOString(),
  mode: "cmd-line simulation of Explorer double-click; Explorer UI was not automated",
  commands: [], checks: {},
}
await mkdir(evidenceDir, { recursive: true })

function mark(event, details = {}) {
  appendFileSync(progressPath, `${JSON.stringify({ at: new Date().toISOString(), event, ...details })}\n`, "utf8")
}

function runCmd(label, commandPath, args = [], timeout = 150000) {
  mark("command_begin", { label })
  const command = `"${commandPath}"${args.length ? ` ${args.join(" ")}` : ""}`
  const result = spawnSync(process.env.ComSpec || "cmd.exe", ["/d", "/s", "/c", `"${command}"`], {
    windowsVerbatimArguments: true, stdio: "ignore",
    cwd: projectRoot, timeout, windowsHide: true,
    env: { ...process.env, CHATCODE_ACCEPTANCE_ROOT: projectRoot },
  })
  const record = {
    label, exitCode: result.status, signal: result.signal ?? null,
    stdout: "see project-local start/stop logs",
    stderr: "see project-local start/stop logs",
    error: result.error?.message ?? null,
  }
  evidence.commands.push(record)
  mark("command_end", { label, exitCode: record.exitCode, signal: record.signal })
  if (result.error) throw result.error
  if (result.status !== 0) throw new Error(`${label} failed with exit code ${result.status}; inspect the matching .tmp/logs record.`)
  return record
}

function requestJson(method, route, body, csrf) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? null : Buffer.from(JSON.stringify(body))
    const request = http.request(`${origin}${route}`, {
      method, timeout: 20000, agent: false,
      headers: {
        ...(payload ? { "content-type": "application/json", "content-length": payload.length } : {}),
        ...(csrf ? { Origin: origin, "X-ChatCode-CSRF": csrf } : {}),
      },
    }, (response) => {
      const chunks = []
      response.on("data", (chunk) => chunks.push(chunk))
      response.on("end", () => {
        const text = Buffer.concat(chunks).toString("utf8")
        let parsed
        try { parsed = JSON.parse(text) } catch { return reject(new Error(`${method} ${route} returned invalid JSON (${response.statusCode})`)) }
        if (response.statusCode < 200 || response.statusCode >= 300) return reject(new Error(`${method} ${route} failed (${response.statusCode}): ${parsed.error ?? text}`))
        resolve(parsed)
      })
    })
    request.on("timeout", () => request.destroy(new Error(`${method} ${route} timed out`)))
    request.on("error", reject)
    if (payload) request.write(payload)
    request.end()
  })
}

async function getJson(route) {
  mark("http_get_begin", { route })
  const result = await requestJson("GET", route)
  mark("http_get_end", { route })
  return result
}

async function getProcessSnapshot() {
  const script = String.raw`
$root = $env:CHATCODE_ACCEPTANCE_ROOT.TrimEnd('\').ToLowerInvariant() + '\'
$items = @(Get-CimInstance Win32_Process | Where-Object { $_.Name -eq 'tunnel-client.exe' })
$owned = @($items | Where-Object { ([string]$_.CommandLine).Replace('/', '\').ToLowerInvariant().Contains($root) } | ForEach-Object { [int]$_.ProcessId })
$all = @($items | ForEach-Object { [int]$_.ProcessId })
$adminRoot = $root + 'apps\server\admin.mjs'
$admins = @(Get-CimInstance Win32_Process | Where-Object { $_.Name -eq 'node.exe' -and ([string]$_.CommandLine).Replace('/', '\').ToLowerInvariant().Contains($adminRoot) } | ForEach-Object { [int]$_.ProcessId })
[pscustomobject]@{ ownedTunnelPids = $owned; allTunnelPids = $all; adminPids = $admins } | ConvertTo-Json -Compress
`
  const output = execFileSync("powershell.exe", ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script], {
    encoding: "utf8", windowsHide: true, timeout: 15000, maxBuffer: 128 * 1024,
    env: { ...process.env, CHATCODE_ACCEPTANCE_ROOT: projectRoot },
  }).replace(/^\uFEFF/, "").trim()
  return JSON.parse(output)
}

function delay(ms) { return new Promise((resolve) => setTimeout(resolve, ms)) }

async function allocateClosedLoopbackPort() {
  const server = createServer()
  await new Promise((resolve, reject) => {
    server.once("error", reject)
    server.listen(0, "127.0.0.1", resolve)
  })
  const port = server.address().port
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
  return port
}

async function saveSettings(session, settings) {
  mark("settings_save_begin", { proxyMode: settings.proxyMode, proxyUrl: settings.proxyUrl })
  const result = await requestJson("POST", "/api/tunnel/settings", settings, session.csrf)
  mark("settings_save_end", { proxyMode: result.settings?.proxyMode, proxyUrl: result.settings?.proxyUrl })
  return result
}

async function waitForCondition(label, predicate, timeoutMs = 100000) {
  mark("wait_begin", { label, timeoutMs })
  const started = Date.now()
  let latest
  while (Date.now() - started < timeoutMs) {
    try { latest = await predicate() } catch { /* service may be restarting */ }
    if (latest?.ok) { mark("wait_complete", { label, elapsedMs: Date.now() - started }); return latest.value }
    await delay(1000)
  }
  mark("wait_timeout", { label, elapsedMs: Date.now() - started })
  throw new Error(`${label} was not observed within ${timeoutMs} ms`)
}

let originalSettings
let settingsSession
let temporaryProxyApplied = false
try {
  mark("acceptance_begin")
  const initialProcesses = await getProcessSnapshot()
  evidence.checks.externalTunnelPidsBefore = initialProcesses.allTunnelPids.filter((pid) => !initialProcesses.ownedTunnelPids.includes(pid))

  runCmd("first Start-ChatCode.cmd invocation", startCmd, ["-NoBrowser"])
  const session1 = await getJson("/api/session")
  const diagnostics1 = await getJson("/api/diagnostics")
  const tunnel1 = await getJson("/api/tunnel/status")
  const processes1 = await getProcessSnapshot()
  evidence.checks.firstStart = {
    adminPid: session1.pid, adminProcessPids: processes1.adminPids,
    mcp: diagnostics1.mcp, proxy: diagnostics1.proxy, tunnel: tunnel1,
    ownedTunnelPids: processes1.ownedTunnelPids,
  }
  assert.equal(diagnostics1.mcp?.status, "ok", "fresh local MCP initialize/tools/list/list_workspaces diagnostic must pass")
  assert.equal(diagnostics1.mcp?.toolCount, 92, "local MCP tools/list must retain the 92-tool catalog")
  assert.ok(processes1.adminPids.includes(session1.pid), "the session PID must match a ChatCode admin process")
  if (tunnel1.running) assert.equal(processes1.ownedTunnelPids.length, 1, "exactly one project-owned tunnel-client process may run")

  runCmd("repeated Start-ChatCode.cmd invocation", startCmd, ["-NoBrowser"])
  const session2 = await getJson("/api/session")
  const tunnel2 = await getJson("/api/tunnel/status")
  const processes2 = await getProcessSnapshot()
  evidence.checks.repeatedStart = {
    adminPid: session2.pid, adminProcessPids: processes2.adminPids,
    tunnel: tunnel2, ownedTunnelPids: processes2.ownedTunnelPids,
    adminPidReused: session2.pid === session1.pid,
  }
  assert.equal(session2.pid, session1.pid, "repeated Start must reuse the same admin PID")
  assert.equal(processes2.adminPids.filter((pid) => pid === session1.pid).length, 1)
  if (tunnel2.running) assert.equal(processes2.ownedTunnelPids.length, 1, "repeated Start must not duplicate the Tunnel process")

  settingsSession = session2
  const settingsResponse = await getJson("/api/tunnel/settings")
  originalSettings = settingsResponse.settings
  if (originalSettings.tunnelId && originalSettings.clientPath && settingsResponse.credentialConfigured && originalSettings.proxyMode === "http") {
    const closedPort = await allocateClosedLoopbackPort()
    const offlineSettings = { ...originalSettings, proxyMode: "http", proxyUrl: `http://127.0.0.1:${closedPort}` }
    await saveSettings(settingsSession, offlineSettings)
    temporaryProxyApplied = true
    runCmd("Start with an intentionally unavailable local proxy", startCmd, ["-NoBrowser"])
    const waiting = await getJson("/api/tunnel/status")
    const offlineProcesses = await getProcessSnapshot()
    evidence.checks.proxyUnavailable = {
      mode: "temporary closed loopback port used for controlled failure injection",
      tcp: (await getJson("/api/diagnostics")).proxy?.tcp,
      tunnel: waiting, ownedTunnelPids: offlineProcesses.ownedTunnelPids,
    }
    assert.equal(waiting.status, "waiting_proxy", "a failed forced proxy must remain visible as waiting_proxy")
    assert.equal(waiting.running, false, "the client must not silently start with direct networking")
    assert.equal(offlineProcesses.ownedTunnelPids.length, 0, "no direct-fallback tunnel process may start during proxy failure")

    const restoreAt = new Date().toISOString()
    await saveSettings(settingsSession, originalSettings)
    temporaryProxyApplied = false
    let lastDiagnostics
    let lastDiagnosticsAt = 0
    const recovered = await waitForCondition("automatic proxy and Tunnel recovery", async () => {
      const tunnel = await getJson("/api/tunnel/status")
      const processes = await getProcessSnapshot()
      if (tunnel.running && processes.ownedTunnelPids.length === 1) {
        return { ok: true, value: { tunnel, ownedTunnelPids: processes.ownedTunnelPids, recovery: "tunnel_process_restored" } }
      }
      if (Date.now() - lastDiagnosticsAt > 5000) {
        lastDiagnostics = await getJson("/api/diagnostics")
        lastDiagnosticsAt = Date.now()
      }
      const retry = (lastDiagnostics?.tunnelEvents ?? []).find((event) => event.event === "runtime_list_failed" && event.at >= restoreAt)
      const proxyReady = lastDiagnostics?.proxy?.tcp?.status === "available" && lastDiagnostics?.proxy?.api?.status === "reachable"
      if (retry && proxyReady) {
        return { ok: true, value: {
          tunnel, ownedTunnelPids: processes.ownedTunnelPids,
          recovery: "proxy_retested_and_retry_observed; tunnel-client runtime list remained externally unavailable",
          retryEvent: retry, proxy: lastDiagnostics.proxy,
        } }
      }
      return { ok: false, value: { tunnel, ownedTunnelPids: processes.ownedTunnelPids, lastDiagnostics } }
    })
    evidence.checks.automaticRecovery = recovered
    if (recovered.tunnel?.running) {
      const pollStartedAt = Date.now()
      let latestTunnel = recovered.tunnel
      while (Date.now() - pollStartedAt < 45000 && !latestTunnel.controlPlane?.pollSucceeded) {
        await delay(1000)
        latestTunnel = await getJson("/api/tunnel/status")
      }
      evidence.checks.controlPlaneAfterRecovery = {
        status: latestTunnel.status,
        pollSucceeded: Boolean(latestTunnel.controlPlane?.pollSucceeded),
        controlPlane: latestTunnel.controlPlane,
      }
    } else {
      evidence.checks.controlPlaneAfterRecovery = {
        status: recovered.tunnel?.status ?? "unknown",
        pollSucceeded: false,
        note: "No Tunnel process was available for a control-plane poll; inspect the recorded runtime-list error.",
      }
    }
  } else {
    evidence.checks.proxyUnavailable = { skipped: "Tunnel ID, client, Runtime API Key, or saved HTTP proxy configuration was unavailable." }
    evidence.checks.automaticRecovery = { skipped: evidence.checks.proxyUnavailable.skipped }
  }

  runCmd("post-recovery Start-ChatCode.cmd invocation", startCmd, ["-NoBrowser"])
  const session3 = await getJson("/api/session")
  const postRecoveryTunnel = await getJson("/api/tunnel/status")
  const postRecoveryProcesses = await getProcessSnapshot()
  assert.equal(session3.pid, session1.pid, "post-recovery Start must keep the same admin process")
  if (postRecoveryTunnel.running) assert.equal(postRecoveryProcesses.ownedTunnelPids.length, 1)
  evidence.checks.postRecoveryStart = {
    adminPid: session3.pid, tunnel: postRecoveryTunnel,
    ownedTunnelPids: postRecoveryProcesses.ownedTunnelPids,
  }

  const beforeStopPids = await getProcessSnapshot()
  runCmd("first Stop-ChatCode.cmd invocation", stopCmd)
  await waitForCondition("admin and project Tunnel process exit", async () => {
    const processes = await getProcessSnapshot()
    const adminGone = !processes.adminPids.includes(session1.pid)
    const tunnelGone = beforeStopPids.ownedTunnelPids.every((pid) => !processes.ownedTunnelPids.includes(pid))
    return adminGone && tunnelGone ? { ok: true, value: processes } : { ok: false, value: processes }
  }, 90000).then((processes) => { evidence.checks.afterFirstStop = processes })

  runCmd("repeated Stop-ChatCode.cmd invocation", stopCmd)
  const afterRepeatedStop = await getProcessSnapshot()
  evidence.checks.repeatedStop = afterRepeatedStop
  assert.equal(afterRepeatedStop.adminPids.includes(session1.pid), false)
  assert.equal(afterRepeatedStop.ownedTunnelPids.some((pid) => beforeStopPids.ownedTunnelPids.includes(pid)), false)

  const externalTunnelPidsAfter = afterRepeatedStop.allTunnelPids.filter((pid) => !afterRepeatedStop.ownedTunnelPids.includes(pid))
  evidence.checks.externalTunnelPidsAfter = externalTunnelPidsAfter
  evidence.checks.externalTunnelPidsUnaffected = evidence.checks.externalTunnelPidsBefore.every((pid) => externalTunnelPidsAfter.includes(pid))
  assert.equal(evidence.checks.externalTunnelPidsUnaffected, true, "Stop must preserve every pre-existing non-project tunnel-client PID")
} catch (error) {
  mark("acceptance_failure", { message: String(error?.message ?? error).slice(0, 1000) })
  evidence.failure = String(error?.stack ?? error).slice(0, 5000)
  throw error
} finally {
  if (temporaryProxyApplied && originalSettings && settingsSession) {
    try { await saveSettings(settingsSession, originalSettings) }
    catch (error) { evidence.restoreError = String(error?.message ?? error).slice(0, 1000) }
  }
  evidence.completedAt = new Date().toISOString()
  mark("acceptance_finally", { temporaryProxyRestored: !temporaryProxyApplied })
  await writeFile(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`, "utf8")
}

mark("acceptance_passed", { evidencePath })
process.stdout.write(`${JSON.stringify({ status: "passed", evidencePath, checks: evidence.checks }, null, 2)}\n`)
