import { spawn, execFile as execFileCallback } from "node:child_process"
import { request as httpRequest } from "node:http"
import { lstat, mkdir, readFile, realpath, rename, rm, writeFile } from "node:fs/promises"
import { connect as netConnect } from "node:net"
import path from "node:path"
import { randomUUID } from "node:crypto"
import { connect as tlsConnect } from "node:tls"
import { promisify } from "node:util"
import { DATA_DIR, DATA_FILES, CHATCODE_HOME, TMP_DIR } from "./config.mjs"
import { assertRegularFile } from "./state.mjs"

const execFile = promisify(execFileCallback)
const credentialScript = path.join(CHATCODE_HOME, "scripts", "credential-store.ps1")
const settingsFile = DATA_FILES.tunnelSettings
const profileDir = path.join(DATA_DIR, "tunnel-client", "profiles")
const runtimeHome = path.join(DATA_DIR, "tunnel-client", "runtime-home")
const tunnelLogFile = path.join(TMP_DIR, "logs", "tunnel-client.ndjson")
const tunnelStatusFile = path.join(TMP_DIR, "tunnel-client-status.json")
const credentialTarget = process.env.CHATCODE_CREDENTIAL_TARGET ?? "ChatCode/SecureMcpTunnel/RuntimeApiKey"
const powershell = path.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe")
const runtimeAlias = (profile) => `chatcode-${profile}`
const mcpWrapperPath = `${CHATCODE_HOME.replaceAll("\\", "/")}/scripts/tunnel-mcp.mjs`
const mcpCommand = `node "${mcpWrapperPath}"`
const profileNamePattern = /^[a-z0-9][a-z0-9_-]{0,63}$/
const DEFAULT_PROXY_URL = "http://127.0.0.1:9910"
const API_PROBE_URL = "https://api.openai.com/v1/models"
const proxyEnvironmentKeys = [
  "HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "NO_PROXY",
  "http_proxy", "https_proxy", "all_proxy", "no_proxy",
  "TUNNEL_CLIENT_HTTP_PROXY", "CONTROL_PLANE_HTTP_PROXY", "MCP_HTTP_PROXY", "HARPOON_HTTP_PROXY",
  "CHATCODE_TUNNEL_HTTP_PROXY", "tunnel_client_http_proxy", "control_plane_http_proxy",
  "mcp_http_proxy", "harpoon_http_proxy", "chatcode_tunnel_http_proxy",
]

let tunnelOperationTail = Promise.resolve()
let activeStartOperation = null
let activeStopOperation = null
let activeReconnectOperation = null
let tunnelSnapshot = { status: "not_configured", lastError: "", updatedAt: null, appliedProxyMode: null, appliedProxyUrl: "", events: [] }
let proxyProbeSnapshot = { tcp: null, api: null }
let recoveryTimer = null
let recoveryAttempt = 0
let recoveryWanted = false
let recoveryProbeRequired = false

export class TunnelError extends Error {
  constructor(message, status = 400) {
    super(message)
    this.name = "TunnelError"
    this.status = status
  }
}

export function tunnelProfilePath(settings = {}) {
  return path.join(profileDir, `${settings.profile ?? "chatcode-local"}.yaml`)
}

function defaultSettings() {
  return {
    tunnelId: "", clientPath: "", profile: "chatcode-local",
    proxyMode: "http", proxyUrl: DEFAULT_PROXY_URL, proxyUpdatedAt: null, updatedAt: null,
  }
}

function queueTunnelOperation(kind, run) {
  const active = kind === "start" ? activeStartOperation : kind === "stop" ? activeStopOperation : activeReconnectOperation
  if (active) return active
  const operation = tunnelOperationTail.catch(() => {}).then(run)
  tunnelOperationTail = operation.catch(() => {})
  const tracked = operation.finally(() => {
    if (kind === "start" && activeStartOperation === tracked) activeStartOperation = null
    if (kind === "stop" && activeStopOperation === tracked) activeStopOperation = null
    if (kind === "reconnect" && activeReconnectOperation === tracked) activeReconnectOperation = null
  })
  if (kind === "start") activeStartOperation = tracked
  else if (kind === "stop") activeStopOperation = tracked
  else activeReconnectOperation = tracked
  return tracked
}

export async function loadTunnelSettings() {
  try {
    await assertRegularFile(settingsFile)
    const settings = JSON.parse(await readFile(settingsFile, "utf8"))
    const validated = validateSettings(settings)
    const migrationNeeded = !settings.proxyMode || !settings.proxyUpdatedAt || (!settings.proxyUrl && validated.proxyMode === "http")
    if (migrationNeeded) {
      const now = new Date().toISOString()
      validated.proxyUpdatedAt = now
      validated.updatedAt = now
      await writeSettingsFile(validated)
    }
    return validated
  } catch (error) {
    if (error?.code === "ENOENT") {
      const settings = defaultSettings()
      const now = new Date().toISOString()
      settings.proxyUpdatedAt = now
      settings.updatedAt = now
      await writeSettingsFile(settings)
      return settings
    }
    if (error instanceof TunnelError) throw error
    throw new TunnelError(`无法读取连接设置：${error.message}`, 500)
  }
}

function validateSettings(value) {
  const settings = { ...defaultSettings(), ...(value && typeof value === "object" ? value : {}) }
  if (settings.tunnelId && !/^[A-Za-z0-9_-]{1,256}$/.test(settings.tunnelId)) throw new TunnelError("Tunnel ID 格式无效，只能包含英文字母、数字、下划线和短横线")
  if (typeof settings.clientPath !== "string" || settings.clientPath.length > 2048 || (settings.clientPath && !path.win32.isAbsolute(settings.clientPath))) throw new TunnelError("客户端位置必须是本机绝对路径")
  if (typeof settings.profile !== "string" || !profileNamePattern.test(settings.profile)) throw new TunnelError("Profile 标识只可使用小写字母、数字、下划线和短横线")
  const proxyMode = settings.proxyMode ?? (typeof settings.httpProxy === "string" && settings.httpProxy ? "http" : "http")
  if (!["http", "system", "direct"].includes(proxyMode)) throw new TunnelError("代理模式必须是 http、system 或 direct")
  const proxyUrl = typeof settings.proxyUrl === "string" && settings.proxyUrl.trim() ? settings.proxyUrl.trim() : typeof settings.httpProxy === "string" && settings.httpProxy.trim() ? settings.httpProxy.trim() : DEFAULT_PROXY_URL
  if (proxyMode === "http") validateProxyUrl(proxyUrl)
  return {
    tunnelId: settings.tunnelId, clientPath: settings.clientPath, profile: settings.profile,
    proxyMode, proxyUrl, proxyUpdatedAt: settings.proxyUpdatedAt ?? null, updatedAt: settings.updatedAt ?? null,
  }
}

function validateProxyUrl(value) {
  let url
  try { url = new URL(value) } catch { throw new TunnelError("HTTP 代理地址格式无效，例如 http://127.0.0.1:9910") }
  if (url.protocol !== "http:" || !url.hostname || !url.port || url.username || url.password || url.pathname !== "/" || url.search || url.hash) {
    throw new TunnelError("代理地址必须是无凭据的 HTTP 代理 URL，例如 http://127.0.0.1:9910")
  }
  return url
}

async function writeSettingsFile(settings) {
  await assertRegularFile(settingsFile, { allowMissing: true })
  const temporary = path.join(TMP_DIR, `tunnel-settings-${process.pid}-${randomUUID()}.tmp`)
  try {
    await writeFile(temporary, `${JSON.stringify(settings, null, 2)}\n`, { encoding: "utf8", flag: "wx" })
    await assertRegularFile(settingsFile, { allowMissing: true })
    await rename(temporary, settingsFile)
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => {})
    throw error
  }
}

async function ensurePlainDirectory(directory) {
  await mkdir(directory, { recursive: true })
  const stat = await lstat(directory)
  if (!stat.isDirectory() || stat.isSymbolicLink() || (process.platform === "win32" && (Number(stat.attributes ?? 0) & 0x400) !== 0)) throw new TunnelError(`拒绝使用 reparse point 或非普通目录：${path.basename(directory)}`, 500)
  if (!samePath(await realpath(directory), directory)) throw new TunnelError("连接配置目录最终路径不一致", 500)
}

function samePath(a, b) {
  return process.platform === "win32" ? path.win32.resolve(a).toLowerCase() === path.win32.resolve(b).toLowerCase() : path.resolve(a) === path.resolve(b)
}

export async function saveTunnelSettings(input) {
  const settings = validateSettings(input)
  const previous = await loadTunnelSettings()
  const connectionChanged = previous.tunnelId && previous.clientPath && (previous.tunnelId !== settings.tunnelId || previous.profile !== settings.profile || previous.clientPath !== settings.clientPath)
  if (connectionChanged) {
    const currentRuntime = await getTunnelRuntimeStatus()
    if (currentRuntime.running) throw new TunnelError("Tunnel 正在运行，请先断开连接后再更改 Tunnel ID、客户端或 Profile。", 409)
    if (currentRuntime.status === "error") throw new TunnelError("无法确认现有 Tunnel 是否已停止，连接设置未更改。请先检查客户端状态。", 409)
    try {
      await runClient(previous, ["runtimes", "rm", runtimeAlias(previous.profile), "--json"], { timeout: 10000, maxBuffer: 64 * 1024 })
    } catch (error) {
      if (!/not found|no local alias|alias.{0,40}(?:not known|unknown)|(?:not known|unknown).{0,40}alias|找不到|未找到/i.test(error.message)) throw new TunnelError("无法清理已停止的 ChatCode runtime alias；连接设置未更改。", 502)
    }
  }
  const now = new Date().toISOString()
  settings.proxyUpdatedAt = previous.proxyMode !== settings.proxyMode || previous.proxyUrl !== settings.proxyUrl ? now : previous.proxyUpdatedAt
  settings.updatedAt = now
  await ensurePlainDirectory(profileDir)
  await ensurePlainDirectory(runtimeHome)
  await assertRegularFile(settingsFile, { allowMissing: true })
  const profileFile = tunnelProfilePath(settings)
  await assertRegularFile(profileFile, { allowMissing: true })
  const previousProfile = await readFile(profileFile, "utf8").catch((error) => error?.code === "ENOENT" ? null : Promise.reject(error))
  const profileProxyMismatch = previousProfile !== null && (settings.proxyMode === "http" ? !profileUsesTunnelProxy(previousProfile) : profileHasHttpProxy(previousProfile))
  await writeSettingsFile(settings)
  try {
    const proxyModeChanged = previous.proxyMode !== settings.proxyMode
    if (settings.tunnelId && settings.clientPath && (connectionChanged || !previousProfile || proxyModeChanged || profileProxyMismatch)) {
      await initializeProfile(settings, { force: Boolean(connectionChanged && previousProfile) })
    }
  } catch (error) {
    await writeSettingsFile(previous).catch(() => {})
    if (previousProfile !== null) {
      const restore = path.join(TMP_DIR, `tunnel-profile-restore-${process.pid}-${randomUUID()}.tmp`)
      await writeFile(restore, previousProfile, { encoding: "utf8", flag: "wx" })
      await rename(restore, profileFile)
    } else await rm(profileFile, { force: true }).catch(() => {})
    throw error
  }
  if (settings.tunnelId && settings.clientPath) {
    recordTunnelEvent("settings_saved", `连接和代理设置已保存；代理模式：${settings.proxyMode}`)
    return { settings, profilePath: tunnelProfilePath(settings), profileReady: Boolean(await fileExists(profileFile)), warning: "" }
  }
  return { settings, profilePath: tunnelProfilePath(settings), profileReady: false, warning: settings.clientPath ? "请先填写 Tunnel ID。" : "请先检测并填写官方 tunnel-client.exe 位置。" }
}

async function fileExists(file) {
  try { await assertRegularFile(file); return true } catch { return false }
}

export function buildTunnelClientEnvironment(settings, secret = "", parentEnv = process.env) {
  const env = {
    ...parentEnv,
    CHATCODE_HOME,
    CHATCODE_DATA_DIR: DATA_DIR,
    CHATCODE_TMP_DIR: TMP_DIR,
    CODEX_HOME: runtimeHome,
    XDG_CONFIG_HOME: runtimeHome,
    TUNNEL_CLIENT_STATE_DIR: runtimeHome,
    TUNNEL_CLIENT_PROFILE_DIR: profileDir,
    ...(secret ? { CHATCODE_RUNTIME_API_KEY: secret, CONTROL_PLANE_API_KEY: secret } : {}),
  }
  for (const key of ["TUNNEL_CLIENT_HTTP_PROXY", "CONTROL_PLANE_HTTP_PROXY", "MCP_HTTP_PROXY", "HARPOON_HTTP_PROXY", "CHATCODE_TUNNEL_HTTP_PROXY", "tunnel_client_http_proxy", "control_plane_http_proxy", "mcp_http_proxy", "harpoon_http_proxy", "chatcode_tunnel_http_proxy"]) delete env[key]
  if (settings.proxyMode === "http") {
    const proxyUrl = validateProxyUrl(settings.proxyUrl).href
    env.CHATCODE_TUNNEL_HTTP_PROXY = proxyUrl
    env.TUNNEL_CLIENT_HTTP_PROXY = proxyUrl
    env.CONTROL_PLANE_HTTP_PROXY = proxyUrl
    env.HTTP_PROXY = proxyUrl
    env.HTTPS_PROXY = proxyUrl
    env.NO_PROXY = "localhost,127.0.0.1,::1"
    delete env.ALL_PROXY
    delete env.http_proxy
    delete env.https_proxy
    delete env.all_proxy
    delete env.no_proxy
  } else if (settings.proxyMode === "direct") {
    for (const key of proxyEnvironmentKeys) delete env[key]
    env.NO_PROXY = "*"
    env.no_proxy = "*"
  }
  return env
}

async function resolveClientPath(settings) {
  const candidate = settings.clientPath.trim()
  if (candidate) {
    try {
      await assertRegularFile(candidate)
      return candidate
    } catch (error) {
      throw new TunnelError(`找不到 tunnel-client 可执行文件：${error.message}`)
    }
  }
  if (process.platform !== "win32") throw new TunnelError("未填写 tunnel-client.exe 位置；请从 OpenAI Platform 的 Tunnels 页面下载官方客户端")
  try {
    const { stdout } = await execFile("where.exe", ["tunnel-client.exe"], { windowsHide: true, timeout: 3000, maxBuffer: 8192 })
    const candidateOnPath = stdout.split(/\r?\n/).map((line) => line.trim()).find(Boolean)
    if (candidateOnPath) return candidateOnPath
  } catch { /* offer the manual official download path below */ }
  throw new TunnelError("未检测到官方 tunnel-client.exe；可从 OpenAI Platform 的 Tunnels 页面下载，或填写已安装的绝对路径")
}

async function runClient(settings, args, { secret = "", timeout = 15000, maxBuffer = 1024 * 1024 } = {}) {
  const executable = await resolveClientPath(settings)
  try {
    const result = await execFile(executable, args, {
      cwd: CHATCODE_HOME,
      env: buildTunnelClientEnvironment(settings, secret),
      windowsHide: true,
      timeout,
      maxBuffer,
      encoding: "utf8",
    })
    return { ...result, executable }
  } catch (error) {
    const output = safeMessage([error.stderr, error.stdout, error.message].filter(Boolean).join("\n"), secret)
    throw new TunnelError(output || "tunnel-client 执行失败，请查看最近诊断", error.killed ? 504 : 502)
  }
}

function selectedProxyUrl(settings, env = process.env) {
  if (settings.proxyMode === "direct") return null
  if (settings.proxyMode === "http") return validateProxyUrl(settings.proxyUrl).href
  const value = env.HTTPS_PROXY ?? env.https_proxy ?? env.HTTP_PROXY ?? env.http_proxy ?? ""
  if (!value) return null
  let url
  try { url = new URL(value) } catch { return null }
  return url.protocol === "http:" ? url.href : null
}

function noProxyMatches(host, value = "") {
  const normalizedHost = host.toLowerCase()
  return String(value).split(/[\s,]+/).filter(Boolean).some((entryValue) => {
    const entry = entryValue.toLowerCase().replace(/^\./, "")
    if (entry === "*") return true
    const hostOnly = entry.startsWith("[") ? entry.slice(1, entry.indexOf("]")) : entry.replace(/:\d+$/, "")
    return normalizedHost === hostOnly || normalizedHost.endsWith(`.${hostOnly}`)
  })
}

function safeProxyAddress(value) {
  if (!value) return ""
  try {
    const url = new URL(value)
    if (url.username || url.password) { url.username = "[redacted]"; url.password = "[redacted]" }
    return `${url.protocol}//${url.host}`
  } catch { return "<invalid>" }
}

function connectTcp(host, port, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    const socket = netConnect({ host, port: Number(port) })
    const timer = setTimeout(() => socket.destroy(new Error("TCP 连接超时")), timeoutMs)
    socket.once("connect", () => { clearTimeout(timer); socket.destroy(); resolve() })
    socket.once("error", (error) => { clearTimeout(timer); reject(error) })
  })
}

function readApiHead(proxyUrl, timeoutMs = 10000) {
  return new Promise((resolve, reject) => {
    const target = new URL(API_PROBE_URL)
    let socket
    let settled = false
    let responseText = ""
    const timer = setTimeout(() => finish(new Error("API 探测超过 10 秒")), timeoutMs)
    const finish = (error, result) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      socket?.destroy()
      if (error) reject(error)
      else resolve(result)
    }
    const sendHead = (secureSocket) => {
      socket = secureSocket
      secureSocket.once("error", (error) => finish(error))
      secureSocket.once("secureConnect", () => {
        secureSocket.write(`HEAD ${target.pathname} HTTP/1.1\r\nHost: ${target.host}\r\nConnection: close\r\n\r\n`)
      })
      secureSocket.on("data", (chunk) => {
        responseText += chunk.toString("latin1")
        if (responseText.length > 32768) return finish(new Error("API 探测响应头过大"))
        const end = responseText.indexOf("\r\n\r\n")
        if (end < 0) return
        const header = responseText.slice(0, end)
        const status = /^HTTP\/\d(?:\.\d)?\s+(\d{3})/i.exec(header)
        if (!status) return finish(new Error("API 探测没有返回有效 HTTP 状态"))
        const requestId = /^x-request-id:\s*([^\r\n]+)/im.exec(header)?.[1]?.trim() ?? ""
        const server = /^server:\s*([^\r\n]+)/im.exec(header)?.[1]?.trim() ?? ""
        finish(null, { statusCode: Number(status[1]), requestId: requestId.slice(0, 120), server: server.slice(0, 80) })
      })
    }

    if (!proxyUrl) {
      socket = tlsConnect({ host: target.hostname, port: 443, servername: target.hostname, ALPNProtocols: ["http/1.1"] })
      sendHead(socket)
      return
    }

    const proxy = new URL(proxyUrl)
    if (proxy.protocol !== "http:") return finish(new Error("当前版本只支持 HTTP CONNECT 代理探测"))
    const headers = { Host: `${target.hostname}:443` }
    if (proxy.username || proxy.password) {
      const user = decodeURIComponent(proxy.username)
      const pass = decodeURIComponent(proxy.password)
      headers["Proxy-Authorization"] = `Basic ${Buffer.from(`${user}:${pass}`).toString("base64")}`
    }
    const req = httpRequest({ hostname: proxy.hostname, port: Number(proxy.port || 80), method: "CONNECT", path: `${target.hostname}:443`, headers })
    req.setTimeout(timeoutMs, () => req.destroy(new Error("代理 CONNECT 超时")))
    req.once("connect", (res, proxySocket, head) => {
      socket = proxySocket
      if (res.statusCode !== 200) return finish(new Error(`代理 CONNECT 返回 HTTP ${res.statusCode}`))
      if (head?.length) proxySocket.unshift(head)
      sendHead(tlsConnect({ socket: proxySocket, servername: target.hostname, ALPNProtocols: ["http/1.1"] }))
    })
    req.once("error", (error) => finish(error))
    req.end()
  })
}

export async function testProxyTcp() {
  const settings = await loadTunnelSettings()
  const proxyUrl = selectedProxyUrl(settings)
  const direct = settings.proxyMode === "direct"
  if (!direct && !proxyUrl) {
    const result = { status: "unavailable", checkedAt: new Date().toISOString(), mode: settings.proxyMode, address: "", message: "系统 HTTP(S)_PROXY 未配置，未尝试直连回退。" }
    proxyProbeSnapshot.tcp = result
    return result
  }
  const target = direct ? new URL(API_PROBE_URL) : new URL(proxyUrl)
  try {
    await connectTcp(target.hostname, Number(target.port || (target.protocol === "https:" ? 443 : 80)))
    const result = {
      status: "available", checkedAt: new Date().toISOString(), mode: settings.proxyMode,
      address: direct ? `${target.hostname}:443` : safeProxyAddress(proxyUrl),
      message: direct ? "直连 TCP 可达；当前模式不使用代理。" : "代理 TCP 端口可达。",
    }
    proxyProbeSnapshot.tcp = result
    recordTunnelEvent("proxy_tcp_ok", result.message)
    return result
  } catch (error) {
    const result = {
      status: "unavailable", checkedAt: new Date().toISOString(), mode: settings.proxyMode,
      address: direct ? `${target.hostname}:443` : safeProxyAddress(proxyUrl),
      message: safeMessage(`TCP 连接失败：${error.code ?? error.message}`),
    }
    proxyProbeSnapshot.tcp = result
    recordTunnelEvent("proxy_tcp_failed", result.message)
    return result
  }
}

export async function testProxyApi() {
  const settings = await loadTunnelSettings()
  const proxyUrl = selectedProxyUrl(settings)
  if (settings.proxyMode === "system" && !proxyUrl) {
    const result = { status: "unavailable", checkedAt: new Date().toISOString(), mode: settings.proxyMode, address: "", message: "系统 HTTP(S)_PROXY 未配置；为避免隐式直连，本次未发送 API 探测。" }
    proxyProbeSnapshot.api = result
    return result
  }
  const noProxyValue = process.env.NO_PROXY ?? process.env.no_proxy ?? ""
  if (settings.proxyMode === "system" && noProxyMatches("api.openai.com", noProxyValue)) {
    const result = { status: "unavailable", checkedAt: new Date().toISOString(), mode: settings.proxyMode, address: safeProxyAddress(proxyUrl), message: "NO_PROXY 将 api.openai.com 排除在系统代理之外；为避免误报，本次未探测 API。" }
    proxyProbeSnapshot.api = result
    return result
  }
  try {
    const reply = await readApiHead(proxyUrl)
    const status = reply.statusCode === 429 ? "rate_limited" : reply.statusCode === 401 || reply.statusCode === 403 || (reply.statusCode >= 200 && reply.statusCode < 300) ? "reachable" : "api_error"
    const result = {
      status, checkedAt: new Date().toISOString(), mode: settings.proxyMode,
      address: proxyUrl ? safeProxyAddress(proxyUrl) : "direct",
      httpStatus: reply.statusCode, requestId: reply.requestId, server: reply.server,
      message: status === "reachable" ? `已通过所选路径到达 OpenAI API（HTTP ${reply.statusCode}；无 Key 测试不代表鉴权成功）。`
        : status === "rate_limited" ? "已到达 OpenAI API，但本次探测收到 HTTP 429。"
          : `已收到 HTTP ${reply.statusCode}，但不是预期的 API 探测响应。`,
    }
    proxyProbeSnapshot.api = result
    recordTunnelEvent(status === "reachable" ? "proxy_api_ok" : "proxy_api_response", result.message)
    return result
  } catch (error) {
    const result = {
      status: "unavailable", checkedAt: new Date().toISOString(), mode: settings.proxyMode,
      address: proxyUrl ? safeProxyAddress(proxyUrl) : "direct", message: safeMessage(`API 探测失败：${error.code ?? error.message}`),
    }
    proxyProbeSnapshot.api = result
    recordTunnelEvent("proxy_api_failed", result.message)
    return result
  }
}

export function getProxyProbeStatus() {
  return { tcp: proxyProbeSnapshot.tcp, api: proxyProbeSnapshot.api }
}

function proxyProbeIsFresh(result, settings) {
  if (!result?.checkedAt || result.mode !== settings.proxyMode || Date.now() - Date.parse(result.checkedAt) > 30000) return false
  const selected = selectedProxyUrl(settings)
  const address = settings.proxyMode === "direct" ? "api.openai.com:443" : safeProxyAddress(selected)
  return result.address === address
}

export async function detectTunnelClient(clientPath = "") {
  const settings = await loadTunnelSettings()
  const candidate = typeof clientPath === "string" && clientPath.trim() ? clientPath.trim() : settings.clientPath
  const { stdout, executable } = await runClient({ ...settings, clientPath: candidate }, ["--version"], { timeout: 8000, maxBuffer: 8192 })
  const version = safeMessage(stdout.trim(), "").slice(0, 240)
  return { installed: true, executable, version }
}

async function credentialOperation(operation, payload = "") {
  if (process.platform !== "win32") throw new TunnelError("安全凭据存储仅支持 Windows Credential Manager", 501)
  const child = spawn(powershell, ["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", credentialScript, "-Operation", operation], {
    env: { ...process.env, CHATCODE_CREDENTIAL_TARGET: credentialTarget },
    windowsHide: true,
    stdio: ["pipe", "pipe", "pipe"],
  })
  const stdout = []
  let stdoutLength = 0
  child.stdout.on("data", (chunk) => {
    stdoutLength += chunk.length
    if (stdoutLength > 64 * 1024) child.kill()
    else stdout.push(chunk)
  })
  child.stderr.resume()
  const timer = setTimeout(() => child.kill(), 10000)
  const closed = new Promise((resolve, reject) => {
    child.once("error", () => reject(new TunnelError("无法启动 Windows Credential Manager 助手", 500)))
    child.once("close", (code) => code === 0 ? resolve() : reject(new TunnelError(`Windows Credential Manager 操作失败（退出码 ${code ?? "unknown"}）`, 500)))
  })
  child.stdin.end(payload, "utf8")
  try { await closed } finally { clearTimeout(timer) }
  try { return JSON.parse(Buffer.concat(stdout).toString("utf8").trim()) } catch { throw new TunnelError("Windows Credential Manager 返回了无效结果", 500) }
}

export async function runtimeCredentialStatus() {
  try { return Boolean((await credentialOperation("status")).configured) } catch { return false }
}

export async function saveRuntimeCredential(secret) {
  if (typeof secret !== "string" || !secret.trim() || secret !== secret.trim() || secret.length > 4096 || /[\r\n\0]/.test(secret)) throw new TunnelError("Runtime API Key 不能为空，且不能包含空白字符或换行")
  await credentialOperation("set", JSON.stringify({ secret }))
  recordTunnelEvent("credential_saved", "Runtime API Key 已保存到 Windows Credential Manager；ChatCode 不会读取或回显已保存密钥")
  return { configured: true }
}

export async function deleteRuntimeCredential() {
  await credentialOperation("delete")
  recordTunnelEvent("credential_deleted", "Runtime API Key 已从 Windows Credential Manager 删除")
  return { configured: false }
}

async function readRuntimeCredential() {
  const value = await credentialOperation("get")
  if (typeof value.secret !== "string" || !value.secret) throw new TunnelError("请先在连接设置中录入 Runtime API Key")
  return value.secret
}

function profileArgs(settings) {
  return ["--profile", settings.profile, "--profile-dir", profileDir]
}

async function initializeProfile(settings, { force = false } = {}) {
  await ensurePlainDirectory(profileDir)
  const profileFile = tunnelProfilePath(settings)
  await assertRegularFile(profileFile, { allowMissing: true })
  let profile = await readFile(profileFile, "utf8").catch((error) => error?.code === "ENOENT" ? "" : Promise.reject(error))
  const matchesCurrentConnection = profile.includes(settings.tunnelId)
    && profile.includes("env:CHATCODE_RUNTIME_API_KEY")
    && profile.includes(mcpWrapperPath)
  if (force || !matchesCurrentConnection) {
    const args = [
      "init", "--sample", "sample_mcp_stdio_local", "--profile", settings.profile,
      "--profile-dir", profileDir, "--tunnel-id", settings.tunnelId,
      "--control-plane-api-key-ref", "env:CHATCODE_RUNTIME_API_KEY",
      "--mcp-command", mcpCommand,
      ...(profile ? ["--force"] : []),
    ]
    await runClient(settings, args, { timeout: 15000 })
    profile = await readFile(profileFile, "utf8")
  }
  const withProxy = updateProfileProxy(profile, settings.proxyMode)
  if (withProxy !== profile) {
    const temporary = path.join(profileDir, `.chatcode-profile-${process.pid}-${randomUUID()}.tmp`)
    try {
      await writeFile(temporary, withProxy, { encoding: "utf8", flag: "wx" })
      await assertRegularFile(profileFile)
      await rename(temporary, profileFile)
    } catch (error) {
      await rm(temporary, { force: true }).catch(() => {})
      throw error
    }
  }
  await assertRegularFile(profileFile)
  const verified = await readFile(profileFile, "utf8")
  if (!verified.includes("env:CHATCODE_RUNTIME_API_KEY") || (settings.proxyMode === "http" && !profileUsesTunnelProxy(verified)) || (settings.proxyMode !== "http" && profileHasHttpProxy(verified)) || verified.includes("api_key: \"sk-") || verified.includes("api_key: sk-")) throw new TunnelError("生成的 Profile 未通过代理或密钥引用检查", 500)
}

export function updateProfileProxy(profile, proxyMode) {
  if (typeof profile !== "string" || !["http", "system", "direct"].includes(proxyMode)) throw new TunnelError("Profile 代理更新参数无效", 400)
  try {
    const config = JSON.parse(profile)
    if (config && typeof config === "object" && !Array.isArray(config)) {
      if (proxyMode === "http") config.http_proxy = "env:CHATCODE_TUNNEL_HTTP_PROXY"
      else delete config.http_proxy
      return `${JSON.stringify(config, null, 2)}\n`
    }
  } catch { /* Profiles may use block-style YAML rather than JSON-compatible YAML. */ }
  const hasGlobalProxy = /^http_proxy\s*:.+$/m.test(profile)
  const proxyLine = 'http_proxy: "env:CHATCODE_TUNNEL_HTTP_PROXY"'
  if (proxyMode === "http") {
    const updated = hasGlobalProxy
      ? profile.replace(/^http_proxy\s*:.+$/m, proxyLine)
      : profile.replace(/^(config_version\s*:\s*\d+\s*)$/m, `$1\n${proxyLine}`)
    if (updated === profile && !hasGlobalProxy) throw new TunnelError("无法在生成的 Profile 中安全写入 tunnel-client 代理引用", 500)
    return updated
  }
  return profile.replace(/^http_proxy\s*:.+\r?\n?/m, "")
}

function profileUsesTunnelProxy(profile) {
  try {
    const config = JSON.parse(profile)
    if (config && typeof config === "object" && !Array.isArray(config)) return config.http_proxy === "env:CHATCODE_TUNNEL_HTTP_PROXY"
  } catch { /* Read block-style YAML below. */ }
  return /^http_proxy\s*:\s*["']?env:CHATCODE_TUNNEL_HTTP_PROXY["']?\s*$/m.test(profile)
}

function profileHasHttpProxy(profile) {
  try {
    const config = JSON.parse(profile)
    if (config && typeof config === "object" && !Array.isArray(config)) return Object.hasOwn(config, "http_proxy")
  } catch { /* Read block-style YAML below. */ }
  return /^http_proxy\s*:/m.test(profile)
}

async function profileProxyNeedsUpdate(settings) {
  const profileFile = tunnelProfilePath(settings)
  await assertRegularFile(profileFile, { allowMissing: true })
  const profile = await readFile(profileFile, "utf8").catch((error) => error?.code === "ENOENT" ? null : Promise.reject(error))
  if (profile === null) return true
  return settings.proxyMode === "http" ? !profileUsesTunnelProxy(profile) : profileHasHttpProxy(profile)
}

async function listChatCodeRuntimes(settings) {
  await ensurePlainDirectory(runtimeHome)
  try {
    const { stdout } = await runClient(settings, ["runtimes", "list", "--json"], { timeout: 8000, maxBuffer: 256 * 1024 })
    const listed = parseJsonOutput(stdout)
    if (!Array.isArray(listed.aliases)) throw new Error("invalid aliases list")
    return listed.aliases
  } catch {
    throw new TunnelError("无法检查 ChatCode 隔离的 Tunnel runtime 状态，已取消启动；其他本机 Tunnel 状态未触碰。", 502)
  }
}

export async function checkTunnelMetadata() {
  const settings = await loadTunnelSettings()
  if (!settings.tunnelId) throw new TunnelError("请先保存 Tunnel ID")
  const secret = await readRuntimeCredential()
  const { stdout } = await runClient(settings, ["admin", "tunnels", "get", settings.tunnelId, "--json"], { secret, timeout: 20000 })
  let metadata
  try { metadata = JSON.parse(stdout) } catch { throw new TunnelError("Tunnel metadata 返回值不是有效 JSON", 502) }
  recordTunnelEvent("metadata_ok", "已使用 Runtime API Key 成功读取 Tunnel metadata")
  const tunnel = metadata.tunnel ?? metadata
  return {
    status: "ok",
    id: safeMessage(tunnel.id ?? settings.tunnelId, secret),
    name: safeMessage(tunnel.name ?? "", secret),
    description: safeMessage(tunnel.description ?? "", secret),
    organizationIds: sanitizeClientOutput(tunnel.organization_ids ?? tunnel.organizationIds ?? [], secret),
    workspaceIds: sanitizeClientOutput(tunnel.workspace_ids ?? tunnel.workspaceIds ?? [], secret),
  }
}

export async function diagnoseTunnel() {
  const settings = await loadTunnelSettings()
  const client = await detectTunnelClient(settings.clientPath)
  if (!settings.tunnelId) return { status: "incomplete", client, profilePath: tunnelProfilePath(settings), message: "尚未配置 Tunnel ID" }
  if (!await runtimeCredentialStatus()) return { status: "credential_missing", client, profilePath: tunnelProfilePath(settings), message: "尚未在 Windows Credential Manager 中录入 Runtime API Key" }
  await initializeProfile(settings)
  const secret = await readRuntimeCredential()
  const { stdout } = await runClient(settings, ["doctor", ...profileArgs(settings), "--explain", "--json"], { secret, timeout: 30000 })
  recordTunnelEvent("doctor_ok", "tunnel-client doctor 已完成")
  return { status: "ok", client, profilePath: tunnelProfilePath(settings), result: sanitizeClientOutput(parseJsonOutput(stdout), secret) }
}

function sanitizeClientOutput(value, secret = "", depth = 0) {
  if (depth > 5) return "[nested output omitted]"
  if (typeof value === "string") return safeMessage(value, secret)
  if (Array.isArray(value)) return value.slice(0, 100).map((entry) => sanitizeClientOutput(entry, secret, depth + 1))
  if (!value || typeof value !== "object") return value
  const safe = {}
  for (const [key, entry] of Object.entries(value).slice(0, 100)) {
    if (/(?:api.?key|token|secret|credential|authorization|password)/i.test(key)) continue
    safe[safeMessage(key, secret)] = sanitizeClientOutput(entry, secret, depth + 1)
  }
  return safe
}

function parseJsonOutput(output) {
  const text = output.trim()
  try { return JSON.parse(text) } catch {
    const first = text.indexOf("{")
    const last = text.lastIndexOf("}")
    if (first >= 0 && last > first) {
      try { return JSON.parse(text.slice(first, last + 1)) } catch { /* report a safe summary below */ }
    }
    return { summary: text.slice(0, 2000) }
  }
}

export async function getTunnelRuntimeStatus() {
  const settings = await loadTunnelSettings()
  if (!settings.tunnelId || !settings.clientPath) return { status: "not_configured", running: false, healthy: false, ready: false, message: "Tunnel ID 或官方客户端路径未配置" }
  const missingRuntimeStatus = () => {
    if (recoveryWanted && tunnelSnapshot.appliedProxyMode && tunnelSnapshot.status === "connected") {
      tunnelSnapshot.status = "starting"
      tunnelSnapshot.lastError = "Tunnel runtime exited; automatic reconnect is scheduled."
      tunnelSnapshot.updatedAt = new Date().toISOString()
      scheduleTunnelRecovery()
    }
    if (recoveryWanted && ["waiting_proxy", "error", "starting", "control_plane_degraded"].includes(tunnelSnapshot.status)) {
      if (tunnelSnapshot.status !== "waiting_proxy" && tunnelSnapshot.status !== "error") scheduleTunnelRecovery()
      return {
        status: tunnelSnapshot.status, running: false, healthy: false, ready: false,
        message: tunnelSnapshot.lastError || "Tunnel 尚未启动",
        controlPlane: { status: "not_started", pollSucceeded: false },
      }
    }
    return { status: "disconnected", running: false, healthy: false, ready: false, message: "Tunnel 尚未启动" }
  }
  let output
  try {
    const result = await runClient(settings, ["runtimes", "status", runtimeAlias(settings.profile), "--json"], { timeout: 8000, maxBuffer: 64 * 1024 })
    output = parseJsonOutput(result.stdout)
  } catch (error) {
    if (/not found|no local alias|alias.{0,40}(?:not known|unknown)|(?:not known|unknown).{0,40}alias|找不到|未找到/i.test(error.message)) return missingRuntimeStatus()
    return { status: "error", running: false, healthy: false, ready: false, message: safeMessage(error.message) }
  }
  const local = output.local ?? {}
  const process = output.process ?? {}
  const health = local.health ?? output.health ?? {}
  const running = Boolean(output.process_running ?? output.running ?? local.process_running ?? process.running)
  const healthy = Boolean(output.healthy ?? health.healthy ?? local.healthy)
  const ready = Boolean(output.ready ?? health.ready ?? local.ready)
  const healthUrl = safeMessage(output.health_url ?? local.health_url ?? health.url ?? "")
  const detailed = running && healthUrl ? await readTunnelHealth(healthUrl) : null
  const controlPlaneComponent = detailed?.components?.["control-plane"] ?? null
  const controlPlaneDetails = controlPlaneComponent?.details ?? {}
  const mcpDetails = detailed?.components?.mcp?.details ?? {}
  const proxyDetails = detailed?.components?.proxy ?? null
  const pollSucceeded = controlPlaneComponent?.status === "ok" && controlPlaneComponent?.state !== "backoff" && !controlPlaneComponent?.reason_code
  const state = !running ? (output.error ? "error" : recoveryWanted && ["waiting_proxy", "error", "starting", "control_plane_degraded"].includes(tunnelSnapshot.status) ? tunnelSnapshot.status : "disconnected")
    : !healthy ? "starting"
      : pollSucceeded ? "connected"
        : controlPlaneComponent?.status === "degraded" || controlPlaneComponent?.state === "backoff" ? "control_plane_degraded" : "starting"
  const remoteError = controlPlaneComponent?.details?.last_error ?? controlPlaneComponent?.reason_code ?? ""
  const message = safeMessage(output.error ?? output.remote_error ?? (state === "waiting_proxy" || state === "error" ? tunnelSnapshot.lastError
    : pollSucceeded
    ? "Tunnel 控制平面轮询已成功；MCP 工具发现状态单独报告。"
    : state === "control_plane_degraded"
      ? `Tunnel 本地进程正常，但控制平面轮询失败：${remoteError || "网络错误"}`
      : ready ? "Tunnel 本地健康检查就绪，尚未观察到控制平面轮询成功。" : running ? "Tunnel 进程运行中，正在等待本地健康检查。" : "Tunnel 尚未启动"))
  return {
    status: state, running, healthy, ready, message, healthUrl,
    controlPlane: {
      status: controlPlaneComponent?.status ?? "unknown",
      state: controlPlaneComponent?.state ?? "not_observed",
      pollSucceeded,
      reasonCode: safeMessage(controlPlaneComponent?.reason_code ?? ""),
      lastAttempt: controlPlaneDetails.last_attempt ?? null,
      lastErrorAt: controlPlaneComponent?.observed_at ?? null,
      lastError: safeMessage(remoteError),
      nextRetry: controlPlaneDetails.next_retry ?? null,
      consecutiveFailures: Number(controlPlaneDetails.consecutive_failures ?? 0),
    },
    mcp: {
      status: detailed?.components?.mcp?.status ?? "unknown",
      initialized: Boolean(mcpDetails.initialize?.ok),
      toolsDiscovered: Boolean(mcpDetails.tools_list?.ok),
      toolsComplete: Boolean(mcpDetails.tools_list?.complete),
      toolCount: Number(mcpDetails.tools_list?.retained_count ?? 0),
    },
    clientProxy: proxyDetails ? { status: proxyDetails.status, state: proxyDetails.state } : { status: "unknown", state: "not_observed" },
    lastError: safeMessage(remoteError || output.error || output.remote_error || ""),
  }
}

async function readTunnelHealth(healthUrl) {
  let base
  try {
    base = new URL(healthUrl)
    if (base.protocol !== "http:" || !["127.0.0.1", "localhost", "[::1]", "::1"].includes(base.hostname)) return null
  } catch { return null }
  base.pathname = "/health"
  base.search = "?details=true"
  base.hash = ""
  return new Promise((resolve) => {
    const request = httpRequest({ hostname: base.hostname.replace(/^\[|\]$/g, ""), port: Number(base.port || 80), path: `${base.pathname}${base.search}`, method: "GET", agent: false }, (response) => {
      const chunks = []
      let length = 0
      response.on("data", (chunk) => {
        length += chunk.length
        if (length > 256 * 1024) { request.destroy(); resolve(null); return }
        chunks.push(chunk)
      })
      response.on("end", () => {
        if (response.statusCode !== 200) return resolve(null)
        try { resolve(JSON.parse(Buffer.concat(chunks).toString("utf8"))) } catch { resolve(null) }
      })
    })
    request.setTimeout(2000, () => request.destroy())
    request.once("error", () => resolve(null))
    request.end()
  })
}

export function startTunnel() {
  return queueTunnelOperation("start", startTunnelInternal)
}

async function startTunnelInternal() {
  const settings = await loadTunnelSettings()
  if (!settings.tunnelId) throw new TunnelError("请先填写并保存 Tunnel ID")
  if (!settings.clientPath) throw new TunnelError("请先填写并检测官方 tunnel-client.exe 的绝对路径")
  recoveryWanted = true
  const secret = await readRuntimeCredential()
  const alias = runtimeAlias(settings.profile)
  const existing = await getTunnelRuntimeStatus()
  if (existing.running) {
    const explicitAppliedConfig = Boolean(tunnelSnapshot.appliedProxyMode)
    const appliedConfigChanged = explicitAppliedConfig && (tunnelSnapshot.appliedProxyMode !== settings.proxyMode || tunnelSnapshot.appliedProxyUrl !== (settings.proxyMode === "http" ? settings.proxyUrl : ""))
    const outdatedDirectRuntime = settings.proxyMode === "http" && existing.clientProxy?.state === "direct"
    const needsProfileProxyUpdate = await profileProxyNeedsUpdate(settings)
    if (!outdatedDirectRuntime && !appliedConfigChanged && !needsProfileProxyUpdate) {
      tunnelSnapshot.status = existing.status
      tunnelSnapshot.lastError = existing.lastError ?? ""
      tunnelSnapshot.updatedAt = new Date().toISOString()
      await persistTunnelStatus()
      if (existing.status === "connected") cancelTunnelRecovery()
      else if (canRetryTunnelRecovery(settings)) scheduleTunnelRecovery()
      return existing
    }
    recordTunnelEvent("restarting_for_saved_proxy", outdatedDirectRuntime
      ? "检测到现有 Tunnel 使用直连；先停止该专属实例，再应用已保存的代理设置。"
      : "检测到现有 Tunnel 的 Profile 或代理设置与持久配置不同；正在安全重启以应用设置。")
    await stopTunnelInternal()
  }
  recoveryWanted = true
  tunnelSnapshot.appliedProxyMode = null
  tunnelSnapshot.appliedProxyUrl = ""

  const requireFreshProbe = recoveryProbeRequired
  recoveryProbeRequired = false
  const tcp = !requireFreshProbe && proxyProbeIsFresh(proxyProbeSnapshot.tcp, settings) ? proxyProbeSnapshot.tcp : await testProxyTcp()
  if (settings.proxyMode === "http" && tcp.status !== "available") {
    return waitingForProxy(settings, tcp.message)
  }
  const api = !requireFreshProbe && proxyProbeIsFresh(proxyProbeSnapshot.api, settings) ? proxyProbeSnapshot.api : await testProxyApi()
  if (api.status !== "reachable") {
    const message = api.status === "rate_limited" ? api.message : api.message || "API 探测没有成功。"
    tunnelSnapshot.status = api.status === "unavailable" ? "waiting_proxy" : "error"
    tunnelSnapshot.lastError = message
    tunnelSnapshot.appliedProxyMode = null
    tunnelSnapshot.appliedProxyUrl = ""
    tunnelSnapshot.updatedAt = new Date().toISOString()
    await persistTunnelStatus()
    recordTunnelEvent(api.status === "unavailable" ? "waiting_proxy" : "proxy_api_rejected", message)
    if (api.status === "unavailable" && canRetryTunnelRecovery(settings)) scheduleTunnelRecovery()
    return { status: tunnelSnapshot.status, running: false, healthy: false, ready: false, message, proxy: api, controlPlane: { pollSucceeded: false, status: "not_started" } }
  }

  await initializeProfile(settings)
  let aliases
  try {
    aliases = await listChatCodeRuntimes(settings)
  } catch (error) {
    const message = safeMessage(error.message, secret)
    tunnelSnapshot.status = "error"
    tunnelSnapshot.lastError = message
    tunnelSnapshot.updatedAt = new Date().toISOString()
    await persistTunnelStatus()
    recordTunnelEvent("runtime_list_failed", message)
    if (canRetryTunnelRecovery(settings)) scheduleTunnelRecovery()
    throw error
  }
  const conflict = aliases.find((item) => (item.alias === alias && item.tunnel_id !== settings.tunnelId) || (item.tunnel_id === settings.tunnelId && item.alias !== alias))
  if (conflict) throw new TunnelError("同一 Tunnel ID 只能由一个 ChatCode runtime alias 管理。请使用原 Profile，或先从该 Profile 断开。")

  const args = [
    "runtimes", "connect", "--json", "--alias", alias,
    "--profile", settings.profile, "--profile-dir", profileDir,
    "--tunnel-id", settings.tunnelId,
    "--runtime-api-key", "env:CHATCODE_RUNTIME_API_KEY",
    "--mcp-command", mcpCommand,
  ]
  let result
  try {
    const { stdout } = await runClient(settings, args, { secret, timeout: 60000, maxBuffer: 512 * 1024 })
    result = parseJsonOutput(stdout)
    await initializeProfile(settings)
  } catch (error) {
    const reason = safeMessage(error.message, secret)
    if (/Profile|配置/i.test(reason)) {
      try { await stopTunnelInternal(); recoveryWanted = true }
      catch (stopError) { recordTunnelEvent("profile_failure_stop_failed", safeMessage(stopError.message, secret)) }
    }
    tunnelSnapshot.status = "error"
    tunnelSnapshot.lastError = reason
    tunnelSnapshot.updatedAt = new Date().toISOString()
    await persistTunnelStatus()
    recordTunnelEvent("start_failed", reason)
    if (canRetryTunnelRecovery(settings) && /network|timeout|timed out|connect|proxy|tls|dns|refused|unreachable/i.test(reason)) scheduleTunnelRecovery()
    throw error
  }

  const status = await getTunnelRuntimeStatus()
  status.message = safeMessage(status.message, secret)
  status.healthUrl = safeMessage(status.healthUrl, secret)
  status.lastError = safeMessage(status.lastError, secret)
  if (!status.running || !status.healthy) {
    const reason = safeMessage(result.error ?? result.remote_error ?? status.message, secret)
    tunnelSnapshot.status = "error"
    tunnelSnapshot.lastError = reason
    await persistTunnelStatus()
    recordTunnelEvent("start_failed", reason)
    throw new TunnelError(`Tunnel 客户端未报告本地健康状态：${reason}`, 502)
  }
  tunnelSnapshot.status = status.status
  tunnelSnapshot.lastError = status.lastError
  tunnelSnapshot.appliedProxyMode = settings.proxyMode
  tunnelSnapshot.appliedProxyUrl = settings.proxyMode === "http" ? settings.proxyUrl : ""
  tunnelSnapshot.updatedAt = new Date().toISOString()
  recoveryAttempt = 0
  await persistTunnelStatus()
  recordTunnelEvent("started", status.message)
  if (status.status === "connected") cancelTunnelRecovery()
  else if (canRetryTunnelRecovery(settings)) scheduleTunnelRecovery()
  return status
}

function waitingForProxy(settings, message) {
  tunnelSnapshot.status = "waiting_proxy"
  tunnelSnapshot.lastError = safeMessage(message)
  tunnelSnapshot.appliedProxyMode = null
  tunnelSnapshot.appliedProxyUrl = ""
  tunnelSnapshot.updatedAt = new Date().toISOString()
  void persistTunnelStatus()
  recordTunnelEvent("waiting_proxy", message)
  if (canRetryTunnelRecovery(settings)) scheduleTunnelRecovery()
  return { status: "waiting_proxy", running: false, healthy: false, ready: false, message: safeMessage(message), proxy: proxyProbeSnapshot.tcp, controlPlane: { pollSucceeded: false, status: "not_started" } }
}

function scheduleTunnelRecovery() {
  if (!recoveryWanted || recoveryTimer) return
  const delayMs = Math.min(5000 * 2 ** Math.min(recoveryAttempt, 5), 120000)
  recoveryAttempt += 1
  recordTunnelEvent("reconnect_scheduled", `代理或控制平面恢复检查将在 ${Math.ceil(delayMs / 1000)} 秒后重试。`)
  recoveryTimer = setTimeout(() => {
    recoveryTimer = null
    recoveryProbeRequired = true
    void startTunnel().catch((error) => {
      recordTunnelEvent("reconnect_attempt_failed", safeMessage(error.message))
      scheduleTunnelRecovery()
    })
  }, delayMs)
  recoveryTimer.unref?.()
}

function cancelTunnelRecovery() {
  if (recoveryTimer) clearTimeout(recoveryTimer)
  recoveryTimer = null
  recoveryAttempt = 0
  recoveryProbeRequired = false
}

function canRetryTunnelRecovery(settings) {
  return settings.proxyMode !== "system" || Boolean(selectedProxyUrl(settings))
}

export function stopTunnel() {
  return queueTunnelOperation("stop", stopTunnelInternal)
}

async function stopTunnelInternal() {
  recoveryWanted = false
  cancelTunnelRecovery()
  const settings = await loadTunnelSettings()
  if (!settings.tunnelId || !settings.clientPath) return { status: "disconnected", running: false, healthy: false, ready: false, message: "Tunnel 尚未配置" }
  let result = {}
  try {
    const { stdout } = await runClient(settings, ["runtimes", "stop", runtimeAlias(settings.profile), "--json"], { timeout: 20000, maxBuffer: 128 * 1024 })
    result = parseJsonOutput(stdout)
  } catch (error) {
    if (!/not found|no local alias|alias.{0,40}(?:not known|unknown)|(?:not known|unknown).{0,40}alias|找不到|未找到/i.test(error.message)) throw error
  }
  let status = await getTunnelRuntimeStatus()
  for (let attempt = 0; attempt < 40 && status.running; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 250))
    status = await getTunnelRuntimeStatus()
  }
  if (status.running) throw new TunnelError("tunnel-client runtimes stop 后进程仍在运行；请检查本机日志，未清理任何其他 Tunnel。", 502)
  tunnelSnapshot.status = "disconnected"
  tunnelSnapshot.lastError = ""
  tunnelSnapshot.appliedProxyMode = null
  tunnelSnapshot.appliedProxyUrl = ""
  tunnelSnapshot.updatedAt = new Date().toISOString()
  await persistTunnelStatus()
  recordTunnelEvent("stopped", safeMessage(result.message ?? "Tunnel 已断开；本地进程已退出。"))
  return { status: "disconnected", running: false, healthy: false, ready: false, message: "Tunnel 已断开；本地进程已退出。", result: sanitizeClientOutput(result) }
}

export function reconnectTunnel() {
  return queueTunnelOperation("reconnect", async () => {
    await stopTunnelInternal()
    return startTunnelInternal()
  })
}

export function loadTunnelSnapshot() {
  return { ...tunnelSnapshot, events: tunnelSnapshot.events.slice(-100) }
}

export function recordTunnelEvent(event, message) {
  const entry = { at: new Date().toISOString(), event, message: safeMessage(message) }
  tunnelSnapshot.events.push(entry)
  tunnelSnapshot.events = tunnelSnapshot.events.slice(-100)
  tunnelSnapshot.updatedAt = entry.at
  appendTunnelLog(entry)
}

function safeMessage(value, secret = "") {
  let message = String(value ?? "").replace(/[\r\n\0]+/g, " ").trim()
  if (secret) message = message.split(secret).join("[已脱敏]")
  message = message.replace(/Bearer\s+\S+/gi, "Bearer [已脱敏]").replace(/\b(sk-[A-Za-z0-9_-]{12,})\b/g, "[已脱敏密钥]")
  return message.slice(0, 1000)
}

async function appendTunnelLog(entry) {
  try {
    await assertRegularFile(tunnelLogFile, { allowMissing: true })
    const existing = await readFile(tunnelLogFile, "utf8").catch((error) => error?.code === "ENOENT" ? "" : Promise.reject(error))
    const lines = `${existing}${JSON.stringify(entry)}\n`.split(/\r?\n/).filter(Boolean).slice(-200)
    await writeFile(tunnelLogFile, `${lines.join("\n")}\n`, { encoding: "utf8" })
  } catch { /* diagnostics must never affect normal UI operation */ }
}

async function persistTunnelStatus() {
  const safe = {
    status: tunnelSnapshot.status, lastError: safeMessage(tunnelSnapshot.lastError), updatedAt: tunnelSnapshot.updatedAt,
    appliedProxyMode: tunnelSnapshot.appliedProxyMode, appliedProxyUrl: tunnelSnapshot.appliedProxyUrl,
  }
  const temporary = path.join(TMP_DIR, `tunnel-status-${process.pid}-${randomUUID()}.tmp`)
  try {
    await assertRegularFile(tunnelStatusFile, { allowMissing: true })
    await writeFile(temporary, `${JSON.stringify(safe)}\n`, { encoding: "utf8", flag: "wx" })
    await assertRegularFile(tunnelStatusFile, { allowMissing: true })
    await rename(temporary, tunnelStatusFile)
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => {})
    throw error
  }
}

export async function restoreTunnelSnapshot() {
  try {
    await assertRegularFile(tunnelStatusFile)
    const saved = JSON.parse(await readFile(tunnelStatusFile, "utf8"))
    tunnelSnapshot = {
      ...tunnelSnapshot, status: saved.status ?? "unknown", lastError: safeMessage(saved.lastError), updatedAt: saved.updatedAt ?? null,
      appliedProxyMode: saved.appliedProxyMode ?? null, appliedProxyUrl: safeMessage(saved.appliedProxyUrl ?? ""),
    }
  } catch { /* no saved diagnostics or unsafe file; status is rechecked with tunnel-client */ }
  try {
    await assertRegularFile(tunnelLogFile)
    const text = await readFile(tunnelLogFile, "utf8")
    tunnelSnapshot.events = text.split(/\r?\n/).filter(Boolean).slice(-100).flatMap((line) => {
      try { const event = JSON.parse(line); return [{ at: event.at, event: event.event, message: safeMessage(event.message) }] } catch { return [] }
    })
  } catch { /* logs are optional diagnostics */ }
}
