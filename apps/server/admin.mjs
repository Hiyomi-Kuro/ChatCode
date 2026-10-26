import { createServer } from "node:http"
import { execFile as execFileCallback } from "node:child_process"
import { lstat, readFile, writeFile, rm } from "node:fs/promises"
import path from "node:path"
import { randomBytes } from "node:crypto"
import { fileURLToPath } from "node:url"
import { promisify } from "node:util"
import { Client } from "@modelcontextprotocol/client"
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio"
import { CHATCODE_HOME, DATA_DIR, DATA_FILES, TMP_DIR } from "./core/config.mjs"
import { assertRegularFile, ensureLayout } from "./core/state.mjs"
import {
  addWorkspace, getWorkspace, listWorkspaces, removeWorkspace, revokeUnattendedDevAuthorization,
  setUnattendedDevAuthorization, updateWorkspace,
} from "./core/workspaces.mjs"
import { listMumuDevicesForAdmin } from "./core/mumu.mjs"
import { getCustomToolStatus, listCustomTools, reloadCustomTools } from "./core/custom-tools.mjs"
import { listSkills, refreshSkills } from "./core/skills.mjs"
import { approveChange, listChanges, recoverChange, recoverInterruptedChanges } from "./core/changes.mjs"
import { approveTask, cancelTask, listTasks, markInterruptedTasks } from "./core/tasks.mjs"
import { fileInfo, getSafeFsMetrics } from "./core/safe-fs.mjs"
import { recoverInterruptedFileOperations } from "./core/file-ops.mjs"
import { abortWrite, listUploads } from "./core/uploads.mjs"
import {
  checkTunnelMetadata, deleteRuntimeCredential, detectTunnelClient, diagnoseTunnel, getTunnelRuntimeStatus,
  getProxyProbeStatus, loadTunnelSettings, loadTunnelSnapshot, recordTunnelEvent, restoreTunnelSnapshot, runtimeCredentialStatus,
  saveRuntimeCredential, saveTunnelSettings, startTunnel, stopTunnel, testProxyApi, testProxyTcp, reconnectTunnel, tunnelProfilePath,
} from "./core/tunnel.mjs"

const execFile = promisify(execFileCallback)
const PORT = Number(process.env.CHATCODE_PORT ?? 39721)
if (!Number.isInteger(PORT) || PORT < 1024 || PORT > 65535) throw new Error("CHATCODE_PORT 必须是 1024 到 65535 之间的端口")
const ORIGIN = `http://127.0.0.1:${PORT}`
const csrfToken = randomBytes(32).toString("hex")
const here = path.dirname(fileURLToPath(import.meta.url))
const ui = path.join(here, "ui")
const runtimeFile = path.join(TMP_DIR, "admin-server.json")
const mcpEntry = path.join(here, "mcp.mjs")
const folderPicker = path.join(CHATCODE_HOME, "scripts", "select-folder.ps1")
const runtimeVersion = 7
const powershellPath = path.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe")
let mcpLastCheck = { status: "not_tested", message: "尚未测试本机 stdio MCP。", checkedAt: null, toolCount: null }
let mcpCheckOperation = null
let shutdownOperation = null
let shuttingDown = false

await ensureLayout()
await recoverInterruptedFileOperations()
await restoreTunnelSnapshot()
await recoverInterruptedChanges()
await markInterruptedTasks()
await assertRegularFile(runtimeFile, { allowMissing: true })
try {
  const previous = JSON.parse(await readFile(runtimeFile, "utf8"))
  if (isPidRunning(Number(previous.pid))) {
    const identity = await getPidIdentity(Number(previous.pid))
    if (matchesAdminIdentity(identity, previous)) throw new Error("ChatCode 管理服务已经运行")
  }
  await rm(runtimeFile, { force: true })
} catch (error) {
  if (error?.code !== "ENOENT") throw error
}

function sendJson(response, status, value) {
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    "Content-Security-Policy": "default-src 'none'; frame-ancestors 'none'",
  })
  response.end(JSON.stringify(value))
}

async function getPidIdentity(pid) {
  if (process.platform !== "win32" || !Number.isInteger(pid) || pid <= 0) return null
  const script = "$p=Get-CimInstance Win32_Process -Filter \"ProcessId=$env:CHATCODE_PID\" -ErrorAction SilentlyContinue; if($p){$created=[Management.ManagementDateTimeConverter]::ToDateTime($p.CreationDate).ToUniversalTime().ToString('o');[pscustomobject]@{name=$p.Name;image=$p.ExecutablePath;command=$p.CommandLine;createdAt=$created}|ConvertTo-Json -Compress}"
  try {
    const { stdout } = await execFile(powershellPath, ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script], {
      env: { ...process.env, CHATCODE_PID: String(pid) }, windowsHide: true, timeout: 5000, maxBuffer: 16 * 1024, encoding: "utf8",
    })
    return stdout.trim() ? JSON.parse(stdout.trim()) : null
  } catch { return null }
}

function samePath(a, b) {
  return process.platform === "win32" ? path.win32.resolve(a).toLowerCase() === path.win32.resolve(b).toLowerCase() : path.resolve(a) === path.resolve(b)
}

function matchesAdminIdentity(identity, runtime) {
  if (!identity || identity.name !== "node.exe") return false
  const script = path.join(CHATCODE_HOME, "apps", "server", "admin.mjs")
  if (!samePath(identity.image ?? "", process.execPath) || !String(identity.command ?? "").toLowerCase().includes(script.toLowerCase())) return false
  if (runtime.processPath && !samePath(runtime.processPath, process.execPath)) return false
  if (runtime.projectRoot && !samePath(runtime.projectRoot, CHATCODE_HOME)) return false
  if (runtime.startedAt) {
    const startedAt = Date.parse(runtime.startedAt)
    const createdAt = Date.parse(identity.createdAt)
    if (!Number.isFinite(startedAt) || !Number.isFinite(createdAt) || Math.abs(createdAt - startedAt) > 60000) return false
  }
  return true
}

function withTimeout(promise, ms, label) {
  let timer
  return Promise.race([
    promise,
    new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`${label}超时`)), ms) }),
  ]).finally(() => clearTimeout(timer))
}

async function checkLocalMcp() {
  if (mcpCheckOperation) return mcpCheckOperation
  mcpCheckOperation = (async () => {
    const env = { ...process.env, CHATCODE_HOME, CHATCODE_DATA_DIR: DATA_DIR, CHATCODE_TMP_DIR: TMP_DIR }
    for (const key of [
      "CHATCODE_RUNTIME_API_KEY", "CONTROL_PLANE_API_KEY", "OPENAI_API_KEY",
      "TUNNEL_CLIENT_HTTP_PROXY", "CONTROL_PLANE_HTTP_PROXY", "CHATCODE_TUNNEL_HTTP_PROXY",
      "MCP_HTTP_PROXY", "HARPOON_HTTP_PROXY",
      "HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "NO_PROXY",
      "http_proxy", "https_proxy", "all_proxy", "no_proxy",
      "tunnel_client_http_proxy", "control_plane_http_proxy", "chatcode_tunnel_http_proxy",
      "mcp_http_proxy", "harpoon_http_proxy",
    ]) delete env[key]
    const transport = new StdioClientTransport({ command: process.execPath, args: [mcpEntry], cwd: CHATCODE_HOME, env, stderr: "pipe" })
    const client = new Client({ name: "chatcode-admin-diagnostic", version: "1.0.0" })
    try {
      await withTimeout((async () => {
        await client.connect(transport)
        const catalog = await client.listTools()
        const names = new Set(catalog.tools.map((tool) => tool.name))
        if (!names.has("list_workspaces")) throw new Error("MCP 已启动，但缺少 list_workspaces 工具")
        const result = await client.callTool({ name: "list_workspaces", arguments: {} })
        if (result.isError) throw new Error(result.structuredContent?.error ?? "list_workspaces 调用失败")
        mcpLastCheck = { status: "ok", message: "本机 stdio MCP 已发现并调用 list_workspaces。", checkedAt: new Date().toISOString(), toolCount: catalog.tools.length }
      })(), 15000, "本机 MCP 测试")
      return mcpLastCheck
    } catch (error) {
      mcpLastCheck = { status: "failed", message: String(error?.message ?? "本机 MCP 测试失败").replace(/[\r\n\0]+/g, " ").slice(0, 400), checkedAt: new Date().toISOString(), toolCount: null }
      throw error
    } finally {
      await client.close().catch(() => {})
      await transport.close().catch(() => {})
    }
  })().finally(() => { mcpCheckOperation = null })
  return mcpCheckOperation
}

async function pickFolder() {
  if (process.platform !== "win32") throw new Error("Windows 文件夹选择器只支持 Windows")
  const { stdout } = await execFile(path.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe"), [
    "-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", folderPicker,
  ], { cwd: CHATCODE_HOME, windowsHide: true, timeout: 120000, maxBuffer: 16384 })
  return JSON.parse(stdout.trim())
}

async function bodyJson(request) {
  const buffers = []
  let size = 0
  for await (const chunk of request) {
    size += chunk.length
    if (size > 256_000) throw new Error("请求正文超过 256 KiB")
    buffers.push(chunk)
  }
  try { return JSON.parse(Buffer.concat(buffers).toString("utf8")) } catch { throw new Error("请求正文必须是有效 JSON") }
}

function sameHost(request) {
  return request.headers.host === `127.0.0.1:${PORT}`
}

function sameOrigin(request) {
  return request.headers.origin === ORIGIN && (!request.headers["sec-fetch-site"] || request.headers["sec-fetch-site"] === "same-origin")
}

async function route(request, response) {
  if (!sameHost(request)) return sendJson(response, 421, { error: "只接受本机管理界面主机名" })
  const url = new URL(request.url ?? "/", ORIGIN)
  if (request.method === "GET" && url.pathname === "/healthz") return sendJson(response, 200, { status: "ok", bind: "127.0.0.1", port: PORT, mcpTransport: "stdio" })
  if (request.method === "GET" && url.pathname === "/") {
    const content = await readFile(path.join(ui, "index.html"))
    response.writeHead(200, {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "no-referrer",
      "Content-Security-Policy": "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
    })
    return response.end(content)
  }
  if (request.method === "GET" && ["/admin.js", "/admin.css"].includes(url.pathname)) {
    const file = path.join(ui, url.pathname.slice(1))
    const content = await readFile(file)
    response.writeHead(200, { "Content-Type": url.pathname.endsWith(".js") ? "text/javascript; charset=utf-8" : "text/css; charset=utf-8", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" })
    return response.end(content)
  }
  if (request.method === "GET" && url.pathname === "/api/session") return sendJson(response, 200, { apiVersion: 2, runtimeVersion, csrf: csrfToken, origin: ORIGIN, port: PORT, pid: process.pid })
  if (request.method === "GET" && url.pathname === "/api/mumu/instances") return sendJson(response, 200, await listMumuDevicesForAdmin())
  if (request.method === "GET" && url.pathname === "/api/workspaces") return sendJson(response, 200, { workspaces: await listWorkspaces() })
  if (request.method === "GET" && url.pathname === "/api/skills") return sendJson(response, 200, await listSkills())
  if (request.method === "GET" && url.pathname === "/api/custom-tools") return sendJson(response, 200, { catalog: await listCustomTools(), status: await getCustomToolStatus() })
  if (request.method === "GET" && url.pathname === "/api/uploads") return sendJson(response, 200, await listUploads())
  if (request.method === "GET" && url.pathname === "/api/changes") return sendJson(response, 200, { changes: await listChanges() })
  if (request.method === "GET" && url.pathname === "/api/tasks") return sendJson(response, 200, { tasks: await listTasks() })
  if (request.method === "GET" && url.pathname === "/api/audit") {
    let lines = []
    try { lines = (await readFile(DATA_FILES.audit, "utf8")).split(/\r?\n/).filter(Boolean).slice(-150) } catch { /* no audit events yet */ }
    return sendJson(response, 200, { events: lines.flatMap((line) => { try { return [JSON.parse(line)] } catch { return [] } }) })
  }
  if (request.method === "GET" && url.pathname === "/api/diagnostics") {
    const settings = await loadTunnelSettings()
    const tunnel = await getTunnelRuntimeStatus()
    return sendJson(response, 200, {
      management: { status: "connected", bind: "127.0.0.1", port: PORT, healthUrl: `${ORIGIN}/healthz`, pid: process.pid },
      mcp: mcpLastCheck,
      safeFs: getSafeFsMetrics(),
      tunnel: { ...tunnel, credentialConfigured: await runtimeCredentialStatus(), clientConfigured: Boolean(settings.clientPath), tunnelIdConfigured: Boolean(settings.tunnelId), profile: settings.profile, profilePath: tunnelProfilePath(settings), proxyMode: settings.proxyMode, proxyUrl: settings.proxyMode === "http" ? settings.proxyUrl : "" },
      chatgpt: { status: "needs_web_confirmation", message: "需在 ChatGPT 网页确认应用注册、工具发现和真实工具调用。" },
      proxy: getProxyProbeStatus(),
      tunnelEvents: loadTunnelSnapshot().events,
    })
  }
  if (request.method === "GET" && url.pathname === "/api/tunnel/settings") {
    const settings = await loadTunnelSettings()
    return sendJson(response, 200, { settings, profilePath: tunnelProfilePath(settings), credentialConfigured: await runtimeCredentialStatus(), proxy: getProxyProbeStatus() })
  }
  if (request.method === "GET" && url.pathname === "/api/tunnel/status") return sendJson(response, 200, await getTunnelRuntimeStatus())
  if (request.method === "GET" && url.pathname === "/api/logs") {
    let tunnelLogs = loadTunnelSnapshot().events
    try { tunnelLogs = (await readFile(path.join(TMP_DIR, "logs", "tunnel-client.ndjson"), "utf8")).split(/\r?\n/).filter(Boolean).slice(-100).flatMap((line) => { try { return [JSON.parse(line)] } catch { return [] } }) } catch { /* no tunnel events yet */ }
    return sendJson(response, 200, { tunnel: tunnelLogs })
  }
  const workspaceProbe = /^\/api\/workspaces\/([a-f0-9-]+)\/test$/.exec(url.pathname)
  if (request.method === "GET" && workspaceProbe) {
    const workspace = await getWorkspace(workspaceProbe[1])
    const info = await fileInfo(workspace.root)
    return sendJson(response, 200, { status: "ok", path: workspace.root, mode: workspace.mode, workspaceStatus: workspace.status, type: info.type })
  }
  if (!request.method || request.method !== "POST") return sendJson(response, 404, { error: "路由不存在" })
  if (!sameOrigin(request) || request.headers["x-chatcode-csrf"] !== csrfToken) return sendJson(response, 403, { error: "管理请求缺少有效的本机 Origin/CSRF 校验" })

  const body = await bodyJson(request)
  if (url.pathname === "/api/workspaces/picker") return sendJson(response, 200, await pickFolder())
  if (url.pathname === "/api/skills/refresh") return sendJson(response, 200, await refreshSkills())
  if (url.pathname === "/api/custom-tools/reload") return sendJson(response, 200, await reloadCustomTools())
  if (url.pathname === "/api/mcp/diagnostic") {
    try { return sendJson(response, 200, await checkLocalMcp()) }
    catch { return sendJson(response, 503, { status: "failed", message: mcpLastCheck.message }) }
  }
  if (url.pathname === "/api/tunnel/client-check") {
    const settings = await loadTunnelSettings()
    return sendJson(response, 200, await detectTunnelClient(body.clientPath ?? settings.clientPath))
  }
  if (url.pathname === "/api/tunnel/settings") return sendJson(response, 200, await saveTunnelSettings(body))
  if (url.pathname === "/api/tunnel/credential") return sendJson(response, 200, await saveRuntimeCredential(body.key))
  if (url.pathname === "/api/tunnel/credential/delete") return sendJson(response, 200, await deleteRuntimeCredential())
  if (url.pathname === "/api/tunnel/proxy/tcp") return sendJson(response, 200, await testProxyTcp())
  if (url.pathname === "/api/tunnel/proxy/api") return sendJson(response, 200, await testProxyApi())
  if (url.pathname === "/api/tunnel/metadata") return sendJson(response, 200, await checkTunnelMetadata())
  if (url.pathname === "/api/tunnel/doctor") return sendJson(response, 200, await diagnoseTunnel())
  if (url.pathname === "/api/tunnel/start") return sendJson(response, 200, await startTunnel())
  if (url.pathname === "/api/tunnel/stop") return sendJson(response, 200, await stopTunnel())
  if (url.pathname === "/api/tunnel/reconnect") return sendJson(response, 200, await reconnectTunnel())
  if (url.pathname === "/api/shutdown") {
    sendJson(response, 202, { status: "shutting_down" })
    setTimeout(() => { void shutdown() }, 0)
    return
  }
  if (url.pathname === "/api/workspaces") {
    const workspace = await addWorkspace({
      name: body.name, root: body.path, mode: body.mode,
      confirmAutoWrite: body.confirmAutoWrite, allowSensitive: body.allowSensitive,
      confirmSensitive: body.confirmSensitive,
    })
    return sendJson(response, 201, { workspace })
  }
  const unattendedProfile = /^\/api\/workspaces\/([a-f0-9-]+)\/execution-profile\/(enable|revoke)$/.exec(url.pathname)
  if (unattendedProfile) {
    const [, id, action] = unattendedProfile
    if (action === "revoke") return sendJson(response, 200, { workspace: await revokeUnattendedDevAuthorization(id) })
    let mumuInstance = null
    if (body.mumuInstance?.index !== undefined && body.mumuInstance?.index !== "") {
      const discovered = await listMumuDevicesForAdmin()
      const selected = discovered.instances.find((item) => item.index === String(body.mumuInstance.index))
      if (!selected) throw new Error("所选 MuMu index 不在当前 mumu-cli info -v all 返回的实例中")
      mumuInstance = selected
    }
    const workspace = await setUnattendedDevAuthorization(id, {
      confirmUnattendedDev: body.confirmUnattendedDev,
      npmScripts: body.npmScripts,
      fixedCommands: body.fixedCommands,
      androidProjects: body.androidProjects,
      gitReadOnly: body.gitReadOnly,
      gitWrite: body.gitWrite,
      fileLifecycle: body.fileLifecycle,
      mumuInstance,
      mumuActions: body.mumuActions,
    })
    return sendJson(response, 200, { workspace })
  }
  const uploadAbort = /^\/api\/uploads\/([a-f0-9-]{36})\/abort$/i.exec(url.pathname)
  if (uploadAbort) return sendJson(response, 200, await abortWrite({ upload_id: uploadAbort[1] }))
  const workspaceAction = /^\/api\/workspaces\/([a-f0-9-]+)\/(pause|resume|readonly|writable|auto-write|sensitive-on|sensitive-off|remove)$/.exec(url.pathname)
  if (workspaceAction) {
    const [, id, action] = workspaceAction
    if (action === "remove") {
      await removeWorkspace(id)
      return sendJson(response, 200, { removed: true })
    }
    const patch = action === "pause" ? { status: "paused" } : action === "resume" ? { status: "active" }
      : action === "readonly" ? { mode: "readOnly" } : action === "writable" ? { mode: "writable" }
        : action === "auto-write" ? { mode: "autoWritable", confirmAutoWrite: body.confirmAutoWrite }
          : action === "sensitive-on" ? { allowSensitive: true, confirmSensitive: body.confirmSensitive }
            : action === "sensitive-off" ? { allowSensitive: false } : null
    if (!patch) throw new Error("工作区操作无效")
    return sendJson(response, 200, { workspace: await updateWorkspace(id, patch) })
  }
  const changeAction = /^\/api\/changes\/([a-f0-9-]+)\/(approve|recover)$/.exec(url.pathname)
  if (changeAction) {
    const [, id, action] = changeAction
    if (action === "approve") return sendJson(response, 200, { change: await approveChange(id) })
    return sendJson(response, 200, { change: await recoverChange(id) })
  }
  const taskAction = /^\/api\/tasks\/([a-f0-9-]+)\/approve$/.exec(url.pathname)
  if (taskAction) return sendJson(response, 200, { task: await approveTask(taskAction[1]) })
  const getTaskMatch = /^\/api\/tasks\/([a-f0-9-]+)$/.exec(url.pathname)
  if (getTaskMatch && body.action === "cancel") return sendJson(response, 200, await cancelTask(getTaskMatch[1]))
  return sendJson(response, 404, { error: "路由不存在" })
}

const server = createServer((request, response) => {
  void route(request, response).catch((error) => {
    const message = String(error instanceof Error ? error.message : "请求失败").replace(/[\r\n\0]/g, " ").slice(0, 400)
    if (response.headersSent) { response.destroy(); return }
    sendJson(response, Number.isInteger(error?.status) ? error.status : 400, { error: message })
  })
})

server.listen(PORT, "127.0.0.1", async () => {
  const startedAt = new Date().toISOString()
  const scriptPath = path.join(here, "admin.mjs")
  const runtime = {
    pid: process.pid, port: PORT, origin: ORIGIN, controlToken: csrfToken, apiVersion: 2, runtimeVersion,
    processPath: process.execPath, projectRoot: CHATCODE_HOME, scriptPath, startedAt,
  }
  await writeFile(runtimeFile, `${JSON.stringify(runtime)}\n`, { encoding: "utf8", flag: "wx" })
  process.stdout.write(`ChatCode 管理界面：${ORIGIN}\n`)
})

async function shutdown() {
  if (shutdownOperation) return shutdownOperation
  shutdownOperation = (async () => {
    if (shuttingDown) return
    shuttingDown = true
    try {
      await stopTunnel()
    } catch (error) {
      recordTunnelEvent("shutdown_error", String(error?.message ?? "Tunnel 停止失败").replace(/[\r\n]/g, " ").slice(0, 500))
    }
    const closed = new Promise((resolve) => server.close(() => resolve()))
    server.closeAllConnections?.()
    await closed
    try {
      const runtime = JSON.parse(await readFile(runtimeFile, "utf8"))
      const stat = await lstat(runtimeFile)
      if (runtime.pid === process.pid && stat.isFile() && !stat.isSymbolicLink()) await rm(runtimeFile, { force: true })
    } catch { /* service state may already be removed */ }
    process.exit(0)
  })()
  return shutdownOperation
}

function isPidRunning(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try { process.kill(pid, 0); return true } catch (error) { return error?.code === "EPERM" }
}

process.once("SIGINT", () => { void shutdown() })
process.once("SIGTERM", () => { void shutdown() })
