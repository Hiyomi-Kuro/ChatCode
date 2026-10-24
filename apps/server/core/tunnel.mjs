import { spawn, execFile as execFileCallback } from "node:child_process"
import { lstat, mkdir, readFile, realpath, rename, rm, writeFile } from "node:fs/promises"
import path from "node:path"
import { createHash, randomUUID } from "node:crypto"
import { promisify } from "node:util"
import { setTimeout as delay } from "node:timers/promises"
import { DATA_DIR, DATA_FILES, CHATCODE_HOME, TMP_DIR } from "./config.mjs"
import { assertRegularFile } from "./state.mjs"
import {
  DEFAULT_TUNNEL_PROXY_URL, createTunnelClientEnvironment, parseProxyUrl,
  testOpenAIConnection, testProxyPort, tunnelProxySettings,
} from "./proxy.mjs"

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
const mcpCommand = `node ${CHATCODE_HOME.replaceAll("\\", "/")}/apps/server/mcp.mjs`
const profileNamePattern = /^[a-z0-9][a-z0-9_-]{0,63}$/

let tunnelOperationTail = Promise.resolve()
const activeTunnelOperations = new Map()
let tunnelSnapshot = { status: "not_configured", lastError: "", updatedAt: null, events: [] }
let proxyRuntimeSnapshot = {
  activeMode: "unknown", activeAddress: "未确认", activeSignature: "", activePid: null, activeSince: null,
  lastPortTest: null, lastOpenAiTest: null, lastSuccessfulPollAt: null, lastMetadataAt: null,
  lastMetadataAttemptAt: null, lastMetadataError: "",
}

export class TunnelError extends Error {
  constructor(message, status = 400, code = "tunnel_error") {
    super(message)
    this.name = "TunnelError"
    this.status = status
    this.code = code
  }
}

export function tunnelProfilePath(settings = {}) {
  return path.join(profileDir, `${settings.profile ?? "chatcode-local"}.yaml`)
}

function defaultSettings() {
  return {
    tunnelId: "", clientPath: "", profile: "chatcode-local", updatedAt: null,
    proxyMode: "direct", proxyUrl: DEFAULT_TUNNEL_PROXY_URL, proxyUpdatedAt: null, autoStart: false,
  }
}

function queueTunnelOperation(kind, run) {
  const active = activeTunnelOperations.get(kind)
  if (active) return active
  const operation = tunnelOperationTail.catch(() => {}).then(run)
  tunnelOperationTail = operation.catch(() => {})
  const tracked = operation.finally(() => {
    if (activeTunnelOperations.get(kind) === tracked) activeTunnelOperations.delete(kind)
  })
  activeTunnelOperations.set(kind, tracked)
  return tracked
}

export async function loadTunnelSettings() {
  try {
    await assertRegularFile(settingsFile)
    const settings = JSON.parse(await readFile(settingsFile, "utf8"))
    return validateSettings(settings)
  } catch (error) {
    if (error?.code === "ENOENT") return defaultSettings()
    if (error instanceof TunnelError) throw error
    throw new TunnelError(`无法读取连接设置：${error.message}`, 500)
  }
}

function validateSettings(value) {
  const settings = { ...defaultSettings(), ...(value && typeof value === "object" ? value : {}) }
  if (settings.tunnelId && !/^[A-Za-z0-9_-]{1,256}$/.test(settings.tunnelId)) throw new TunnelError("Tunnel ID 格式无效，只能包含英文字母、数字、下划线和短横线")
  if (typeof settings.clientPath !== "string" || settings.clientPath.length > 2048 || (settings.clientPath && !path.win32.isAbsolute(settings.clientPath))) throw new TunnelError("客户端位置必须是本机绝对路径")
  if (typeof settings.profile !== "string" || !profileNamePattern.test(settings.profile)) throw new TunnelError("Profile 标识只可使用小写字母、数字、下划线和短横线")
  const proxyMode = settings.proxyMode ?? "direct"
  if (!["direct", "system", "custom"].includes(proxyMode)) throw new TunnelError("代理模式无效")
  const proxyUrl = typeof settings.proxyUrl === "string" && settings.proxyUrl ? settings.proxyUrl : DEFAULT_TUNNEL_PROXY_URL
  if (proxyMode === "custom") {
    try { parseProxyUrl(proxyUrl) } catch (error) { throw new TunnelError(error.message, 400, error.code ?? "invalid_proxy_url") }
  }
  if (settings.autoStart !== undefined && typeof settings.autoStart !== "boolean") throw new TunnelError("自动连接设置必须是布尔值")
  return {
    tunnelId: settings.tunnelId, clientPath: settings.clientPath, profile: settings.profile, updatedAt: settings.updatedAt ?? null,
    proxyMode, proxyUrl, proxyUpdatedAt: settings.proxyUpdatedAt ?? null, autoStart: settings.autoStart === true,
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
  const previous = await loadTunnelSettings()
  const settings = validateSettings({ ...previous, ...(input && typeof input === "object" ? input : {}) })
  const connectionChanged = previous.tunnelId && previous.clientPath && (previous.tunnelId !== settings.tunnelId || previous.profile !== settings.profile)
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
  settings.updatedAt = new Date().toISOString()
  await persistTunnelSettings(settings)
  if (settings.tunnelId && settings.clientPath) {
    try {
      await initializeProfile(settings)
      recordTunnelEvent("profile_saved", `已生成独立 Profile：${tunnelProfilePath(settings)}`)
    } catch (error) {
      recordTunnelEvent("profile_error", safeMessage(error.message))
      return { settings, profilePath: tunnelProfilePath(settings), profileReady: false, warning: safeMessage(error.message) }
    }
    return { settings, profilePath: tunnelProfilePath(settings), profileReady: true, warning: "" }
  }
  return { settings, profilePath: tunnelProfilePath(settings), profileReady: false, warning: settings.clientPath ? "请先填写 Tunnel ID。" : "请先检测并填写官方 tunnel-client.exe 位置。" }
}

async function persistTunnelSettings(settings) {
  await ensurePlainDirectory(profileDir)
  await ensurePlainDirectory(runtimeHome)
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

export async function testTunnelProxyPort(input = {}) {
  const settings = await loadTunnelSettings()
  const mode = input.proxyMode ?? settings.proxyMode
  const proxyUrl = input.proxyUrl ?? settings.proxyUrl
  const selected = getProxyEndpoint({ ...settings, proxyMode: mode, proxyUrl })
  if (mode === "direct") return { status: "direct", address: "不使用代理", message: "当前选择直连，没有代理端口可测试。" }
  if (selected.configured && selected.valid === false) return { status: "proxy_unavailable", address: selected.address, message: selected.message }
  if (!selected.url) return { status: "proxy_not_configured", address: selected.address, message: selected.message }
  const result = await testProxyPort(selected.url)
  proxyRuntimeSnapshot.lastPortTest = { ...result, source: selected.source, testedAt: new Date().toISOString() }
  await persistTunnelStatus()
  recordTunnelEvent("proxy_port_test", `${result.status}: ${result.message}`)
  return { ...result, source: selected.source }
}

export async function testTunnelOpenAI(input = {}) {
  const settings = await loadTunnelSettings()
  const mode = input.proxyMode ?? settings.proxyMode
  const proxyUrl = input.proxyUrl ?? settings.proxyUrl
  const selected = getProxyEndpoint({ ...settings, proxyMode: mode, proxyUrl })
  if (mode === "system" && selected.configured && selected.valid === false) {
    const reported = { status: "proxy_unavailable", address: selected.address, mode, source: selected.source, testedAt: new Date().toISOString(), message: selected.message }
    proxyRuntimeSnapshot.lastOpenAiTest = reported
    await persistTunnelStatus()
    return reported
  }
  const result = await testOpenAIConnection({ proxyUrl: selected.url, timeoutMs: 15000 })
  const reported = { ...result, mode, source: selected.source, testedAt: new Date().toISOString(), message: mode === "system" && !selected.url ? `${selected.message} ${result.message}` : result.message }
  proxyRuntimeSnapshot.lastOpenAiTest = reported
  await persistTunnelStatus()
  recordTunnelEvent("openai_network_test", `${result.status}: ${result.message}`)
  return reported
}

export async function getTunnelProxyStatus(runtime = null) {
  const settings = await loadTunnelSettings()
  const status = runtime ?? await getTunnelRuntimeStatus()
  const selected = getProxyEndpoint(settings)
  const signature = getProxySignature(settings)
  const processMatches = status.running && status.processPid === proxyRuntimeSnapshot.activePid && signature === proxyRuntimeSnapshot.activeSignature
  let state = "disconnected"
  let message = "Tunnel 尚未连接。"
  if (status.status === "error") {
    state = "reconnecting"
    message = `Tunnel 状态检查失败：${status.message}`
  } else if (status.running && processMatches && status.ready) {
    state = selected.url ? "healthy" : "direct"
    message = selected.url ? "已由当前配置的代理建立并确认 Tunnel 控制平面连接。" : "Tunnel 已就绪，当前配置为直连。"
  } else if (status.running && proxyRuntimeSnapshot.activeMode === "direct" && selected.url) {
    state = "tunnel_still_direct"
    message = "Tunnel 仍由直连配置启动；点击“应用并安全重连”后才会使用已选代理。"
  } else if (status.running) {
    state = "connecting"
    message = "Tunnel 进程仍在运行，但其代理来源尚未由本管理器确认；请应用设置并安全重连。"
  } else if (settings.proxyMode === "system" && selected.configured && selected.valid === false) {
    state = "proxy_unavailable"
    message = selected.message
  } else if (proxyRuntimeSnapshot.lastOpenAiTest && !["api_reachable", "platform_rate_limited"].includes(proxyRuntimeSnapshot.lastOpenAiTest.status)) {
    state = proxyRuntimeSnapshot.lastOpenAiTest.status
    message = proxyRuntimeSnapshot.lastOpenAiTest.message
  }
  return {
    state, message, mode: settings.proxyMode, source: selected.source, address: selected.address,
    usingProxy: Boolean(selected.url), ready: status.ready, healthy: status.healthy, running: status.running,
    activeMode: proxyRuntimeSnapshot.activeMode, activeAddress: proxyRuntimeSnapshot.activeAddress,
    activeSince: proxyRuntimeSnapshot.activeSince, processPid: status.processPid,
    lastPortTest: proxyRuntimeSnapshot.lastPortTest, lastOpenAiTest: proxyRuntimeSnapshot.lastOpenAiTest,
    lastSuccessfulPollAt: status.lastSuccessfulPollAt ?? proxyRuntimeSnapshot.lastSuccessfulPollAt,
    pollHealthState: status.pollHealthState ?? "unknown", lastMetadataAt: proxyRuntimeSnapshot.lastMetadataAt,
    lastMetadataAttemptAt: proxyRuntimeSnapshot.lastMetadataAttemptAt, lastMetadataError: proxyRuntimeSnapshot.lastMetadataError,
    autoStart: settings.autoStart,
  }
}

function commandEnv(settings, secret = "") {
  const baseEnvironment = {
    ...process.env,
    CHATCODE_HOME,
    CHATCODE_DATA_DIR: DATA_DIR,
    CHATCODE_TMP_DIR: TMP_DIR,
    CODEX_HOME: runtimeHome,
    XDG_CONFIG_HOME: runtimeHome,
    TUNNEL_CLIENT_STATE_DIR: runtimeHome,
    TUNNEL_CLIENT_PROFILE_DIR: profileDir,
  }
  return createTunnelClientEnvironment(settings, { baseEnvironment, secret })
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
      env: commandEnv(settings, secret),
      windowsHide: true,
      timeout,
      maxBuffer,
      encoding: "utf8",
    })
    return { ...result, executable }
  } catch (error) {
    const commandOutput = [error.stderr, error.stdout].filter(Boolean).join("\n")
    const diagnostic = safeMessage(commandOutput, secret, settings.tunnelId)
    const combined = `${commandOutput}\n${error.message ?? ""}`
    const code = classifyTunnelClientFailure(combined, error)
    const exit = Number.isInteger(error.code) ? `退出码 ${error.code}` : typeof error.code === "string" ? error.code : error.killed ? "超时" : "未知状态"
    const message = diagnostic ? `tunnel-client 失败（${exit}）：${diagnostic}` : `tunnel-client 失败（${exit}，未返回诊断输出）。`
    throw new TunnelError(message, error.killed ? 504 : 502, code)
  }
}

function classifyTunnelClientFailure(value, error = {}) {
  const message = String(value ?? "")
  if (/\b407\b|proxy.{0,30}(auth|authentication)|proxy-authorization/i.test(message)) return "proxy_auth_failure"
  if (/\b429\b|rate.?limit|too many requests/i.test(message)) return "platform_rate_limited"
  if (/\b(?:401|403)\b|unauthorized|forbidden|authentication failed/i.test(message)) return "auth_failure"
  if (/x509|certificate|tls|ssl/i.test(message)) return "tls_error"
  if (/proxy.{0,40}(?:refused|unavailable|timeout|unreachable)|(?:ECONNREFUSED|EHOSTUNREACH|ENETUNREACH|ENOTFOUND|EAI_AGAIN)/i.test(message)) return "proxy_unavailable"
  if (error.killed || /ETIMEDOUT|ECONNRESET|network_error|network error|timeout/i.test(message)) return "api_unreachable"
  return "client_command_failed"
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

async function initializeProfile(settings) {
  await ensurePlainDirectory(profileDir)
  const profileFile = tunnelProfilePath(settings)
  await assertRegularFile(profileFile, { allowMissing: true })
  const args = [
    "init", "--sample", "sample_mcp_stdio_local", "--profile", settings.profile,
    "--profile-dir", profileDir, "--tunnel-id", settings.tunnelId,
    "--control-plane-api-key-ref", "env:CHATCODE_RUNTIME_API_KEY",
    "--mcp-command", mcpCommand, "--force",
  ]
  await runClient(settings, args, { timeout: 15000 })
  await assertRegularFile(profileFile)
  const profile = await readFile(profileFile, "utf8")
  if (!profile.includes("env:CHATCODE_RUNTIME_API_KEY") || profile.includes("api_key: \"sk-") || profile.includes("api_key: sk-")) throw new TunnelError("生成的 Profile 未通过密钥引用检查", 500)
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
  proxyRuntimeSnapshot.lastMetadataAttemptAt = new Date().toISOString()
  try {
    const secret = await readRuntimeCredential()
    const { stdout } = await runClient(settings, ["admin", "tunnels", "get", settings.tunnelId, "--json"], { secret, timeout: 20000 })
    let metadata
    try { metadata = JSON.parse(stdout) } catch { throw new TunnelError("Tunnel metadata 返回值不是有效 JSON", 502, "metadata_invalid_response") }
    proxyRuntimeSnapshot.lastMetadataAt = proxyRuntimeSnapshot.lastMetadataAttemptAt
    proxyRuntimeSnapshot.lastMetadataError = ""
    await persistTunnelStatus()
    recordTunnelEvent("metadata_ok", "已使用 Runtime API Key 成功读取 Tunnel metadata")
    const tunnel = metadata.tunnel ?? metadata
    return {
      status: "ok",
      id: safeMessage(tunnel.id ?? settings.tunnelId, secret, settings.tunnelId),
      name: safeMessage(tunnel.name ?? "", secret, settings.tunnelId),
      description: safeMessage(tunnel.description ?? "", secret, settings.tunnelId),
      organizationIds: sanitizeClientOutput(tunnel.organization_ids ?? tunnel.organizationIds ?? [], secret),
      workspaceIds: sanitizeClientOutput(tunnel.workspace_ids ?? tunnel.workspaceIds ?? [], secret),
    }
  } catch (error) {
    proxyRuntimeSnapshot.lastMetadataError = typeof error?.code === "string" ? error.code : "metadata_check_failed"
    await persistTunnelStatus().catch(() => {})
    recordTunnelEvent("metadata_failed", `metadata 检查失败（${proxyRuntimeSnapshot.lastMetadataError}）`)
    throw error
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
  if (!settings.tunnelId || !settings.clientPath) return { status: "not_configured", running: false, healthy: false, ready: false, processPid: null, processStartedAt: null, pollHealthState: "unknown", lastSuccessfulPollAt: null, message: "Tunnel ID 或官方客户端路径未配置" }
  let output
  try {
    const result = await runClient(settings, ["runtimes", "status", runtimeAlias(settings.profile), "--json"], { timeout: 8000, maxBuffer: 64 * 1024 })
    output = parseJsonOutput(result.stdout)
  } catch (error) {
    if (/not found|no local alias|alias.{0,40}(?:not known|unknown)|(?:not known|unknown).{0,40}alias|找不到|未找到/i.test(error.message)) return { status: "disconnected", running: false, healthy: false, ready: false, processPid: null, processStartedAt: null, message: "Tunnel 尚未启动" }
    return { status: "error", running: false, healthy: false, ready: false, processPid: null, processStartedAt: null, message: safeMessage(error.message) }
  }
  const local = output.local ?? {}
  const process = output.process ?? {}
  const health = local.health ?? output.health ?? {}
  const running = Boolean(output.process_running ?? output.running ?? local.process_running ?? process.running)
  const healthy = Boolean(output.healthy ?? health.healthy ?? local.healthy)
  const ready = Boolean(output.ready ?? health.ready ?? local.ready)
  const processPid = Number(process.pid ?? output.pid ?? 0) || null
  const processStartedAt = typeof process.started_at === "string" ? process.started_at : null
  const pollHealth = output.control_plane_poll_health ?? {}
  const pollHealthState = typeof pollHealth.state === "string" ? pollHealth.state : "unknown"
  const lastSuccessfulPollAt = typeof pollHealth.last_success_at === "string" ? pollHealth.last_success_at : null
  if (lastSuccessfulPollAt) proxyRuntimeSnapshot.lastSuccessfulPollAt = lastSuccessfulPollAt
  const state = running && healthy ? "connected" : running ? "starting" : output.error ? "error" : "disconnected"
  const message = safeMessage(output.error ?? output.remote_error ?? (ready ? "Tunnel 正在运行并报告就绪" : running ? "Tunnel 进程运行中，正在等待就绪" : "Tunnel 尚未启动"))
  return {
    status: state, running, healthy, ready, processPid, processStartedAt, pollHealthState, lastSuccessfulPollAt,
    message, healthUrl: safeMessage(output.health_url ?? local.health_url ?? health.url ?? ""), lastError: safeMessage(output.error ?? output.remote_error ?? ""),
  }
}

async function inspectLiveProcess(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return null
  if (process.platform === "win32") {
    const script = `$p=Get-CimInstance Win32_Process -Filter \"ProcessId=${pid}\" -ErrorAction SilentlyContinue; if($p){ [pscustomobject]@{pid=$p.ProcessId; executablePath=$p.ExecutablePath; startedAt=$p.CreationDate} | ConvertTo-Json -Compress }`
    try {
      const { stdout } = await execFile(powershell, ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script], { windowsHide: true, timeout: 5000, maxBuffer: 8192, encoding: "utf8" })
      const value = JSON.parse(stdout.trim())
      if (Number(value.pid) !== pid || typeof value.executablePath !== "string" || !value.startedAt) return null
      return { pid, executablePath: value.executablePath, startedAt: String(value.startedAt) }
    } catch { return null }
  }
  try {
    const executablePath = await realpath(`/proc/${pid}/exe`)
    const stat = await readFile(`/proc/${pid}/stat`, "utf8")
    return { pid, executablePath, startedAt: stat.slice(0, 256) }
  } catch { return null }
}

async function verifyManagedRuntime(settings, status) {
  if (!status.running || !Number.isSafeInteger(status.processPid)) throw new TunnelError("无法确认 ChatCode Tunnel 的实时 PID；为避免影响其他项目，未停止进程。", 409, "runtime_ownership_unknown")
  const live = await inspectLiveProcess(status.processPid)
  if (!live) throw new TunnelError("Tunnel 状态中的 PID 当前不可核验；为避免误停其他进程，未继续操作。", 409, "runtime_ownership_unknown")
  if (!samePath(live.executablePath, settings.clientPath)) throw new TunnelError("Tunnel PID 的可执行文件路径与 ChatCode 配置不一致；未停止任何进程。", 409, "runtime_ownership_mismatch")
  if (!live.startedAt) throw new TunnelError("无法核对 Tunnel 进程启动时间；未继续操作。", 409, "runtime_ownership_unknown")
  return live
}

async function assertNoLiveManagedRuntime(settings, status) {
  if (!Number.isSafeInteger(status.processPid)) return
  const live = await inspectLiveProcess(status.processPid)
  if (live && samePath(live.executablePath, settings.clientPath)) {
    throw new TunnelError("Tunnel status 报告未运行，但对应 PID 仍是活动的 tunnel-client；为避免重复 stdio 实例，已取消启动。", 409, "runtime_stop_unconfirmed")
  }
}

function getProxySignature(settings) {
  const selected = tunnelProxySettings(settings.proxyMode, settings.proxyUrl, process.env)
  return createHash("sha256").update(JSON.stringify({ mode: selected.mode, source: selected.source, address: selected.address, url: selected.url })).digest("hex")
}

function getProxyEndpoint(settings) {
  try { return tunnelProxySettings(settings.proxyMode, settings.proxyUrl, process.env) }
  catch (error) { throw new TunnelError(error.message, 400, error.code ?? "invalid_proxy_settings") }
}

async function checkProxyForStart(settings) {
  const selected = getProxyEndpoint(settings)
  if (settings.proxyMode === "custom" && !selected.url) throw new TunnelError("自定义代理地址无效。", 503, "proxy_unavailable")
  if (!selected.url) return { selected, result: null }
  const result = await testOpenAIConnection({ proxyUrl: selected.url, timeoutMs: 12000 })
  proxyRuntimeSnapshot.lastOpenAiTest = { ...result, testedAt: new Date().toISOString() }
  if (!new Set(["api_reachable", "platform_rate_limited"]).has(result.status)) {
    recordTunnelEvent("proxy_preflight_failed", `${result.status}: ${result.message}`)
    throw new TunnelError(`代理预检失败：${result.message}`, 503, result.status === "proxy_unavailable" ? "proxy_unavailable" : result.status)
  }
  return { selected, result }
}

async function startTunnelNow(settings = null, { preflight = null } = {}) {
  settings ??= await loadTunnelSettings()
  if (!settings.tunnelId) throw new TunnelError("请先填写并保存 Tunnel ID")
  if (!settings.clientPath) throw new TunnelError("请先填写并检测官方 tunnel-client.exe 的绝对路径")
  const { selected, result: proxyCheck } = preflight ?? await checkProxyForStart(settings)
  const secret = await readRuntimeCredential()
  const alias = runtimeAlias(settings.profile)
  const aliases = await listChatCodeRuntimes(settings)
  const conflict = aliases.find((item) => (item.alias === alias && item.tunnel_id !== settings.tunnelId) || (item.tunnel_id === settings.tunnelId && item.alias !== alias))
  if (conflict) throw new TunnelError("同一 Tunnel ID 只能由一个 ChatCode runtime alias 管理。请使用原 Profile，或先从该 Profile 断开。", 409, "runtime_alias_conflict")
  let existing = await getTunnelRuntimeStatus()
  const signature = getProxySignature(settings)
  if (existing.status === "error") throw new TunnelError(`无法确认现有 ChatCode Tunnel 状态：${existing.message}`, 409, "runtime_ownership_unknown")
  if (existing.running) {
    const identity = await verifyManagedRuntime(settings, existing)
    if (existing.status === "connected" && proxyRuntimeSnapshot.activePid === existing.processPid && proxyRuntimeSnapshot.activeSignature === signature && proxyRuntimeSnapshot.activeSince === identity.startedAt) return existing
    await stopTunnelNow(settings, existing, identity)
    existing = await getTunnelRuntimeStatus()
    if (existing.running || existing.status === "error") throw new TunnelError("旧 ChatCode Tunnel 未确认完全退出；已取消重连。", 409, "runtime_stop_unconfirmed")
  } else await assertNoLiveManagedRuntime(settings, existing)
  await initializeProfile(settings)
  const args = [
    "runtimes", "connect", "--json", "--alias", alias,
    "--profile", settings.profile, "--profile-dir", profileDir,
    "--tunnel-id", settings.tunnelId,
    "--runtime-api-key", "env:CHATCODE_RUNTIME_API_KEY",
    "--mcp-command", mcpCommand,
  ]
  const { stdout } = await runClient(settings, args, { secret, timeout: 60000, maxBuffer: 512 * 1024 })
  const result = parseJsonOutput(stdout)
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
    throw new TunnelError(`Tunnel 客户端未报告健康状态：${reason}`, 502, proxyCheck?.status === "platform_rate_limited" ? "platform_rate_limited" : "tunnel_unhealthy")
  }
  const identity = await verifyManagedRuntime(settings, status)
  proxyRuntimeSnapshot.activeMode = settings.proxyMode
  proxyRuntimeSnapshot.activeAddress = selected.address
  proxyRuntimeSnapshot.activeSignature = signature
  proxyRuntimeSnapshot.activePid = status.processPid
  proxyRuntimeSnapshot.activeSince = identity.startedAt
  proxyRuntimeSnapshot.lastSuccessfulPollAt = status.lastSuccessfulPollAt ?? proxyRuntimeSnapshot.lastSuccessfulPollAt
  tunnelSnapshot.status = status.ready ? "connected" : "starting"
  tunnelSnapshot.lastError = ""
  tunnelSnapshot.updatedAt = new Date().toISOString()
  await persistTunnelStatus()
  recordTunnelEvent("started", settings.proxyMode === "custom" ? "ChatCode Tunnel 已在自定义代理环境中报告健康" : settings.proxyMode === "system" && selected.url ? "ChatCode Tunnel 已在系统环境代理中报告健康" : status.message)
  return status
}

async function waitForRuntimeExit(settings, previousStatus, previousIdentity, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const current = await getTunnelRuntimeStatus()
    if (current.status === "error") throw new TunnelError("停止后无法核对 ChatCode Tunnel 状态；未启动新实例。", 502, "runtime_stop_unconfirmed")
    const currentIdentity = previousStatus.processPid ? await inspectLiveProcess(previousStatus.processPid) : null
    const sameProcess = currentIdentity && previousIdentity
      && samePath(currentIdentity.executablePath, previousIdentity.executablePath)
      && currentIdentity.startedAt === previousIdentity.startedAt
    if (!current.running && !sameProcess) return current
    await delay(250)
  }
  throw new TunnelError("旧 ChatCode Tunnel 进程未在 15 秒内完全退出；已取消新实例启动。", 504, "runtime_stop_unconfirmed")
}

async function stopTunnelNow(settings = null, knownStatus = null, knownIdentity = null) {
  settings ??= await loadTunnelSettings()
  if (!settings.tunnelId || !settings.clientPath) return { status: "disconnected", running: false, healthy: false, ready: false, message: "Tunnel 尚未配置" }
  const status = knownStatus ?? await getTunnelRuntimeStatus()
  if (status.status === "error") throw new TunnelError(`无法确认现有 ChatCode Tunnel 状态：${status.message}`, 409, "runtime_ownership_unknown")
  if (!status.running) {
    await assertNoLiveManagedRuntime(settings, status)
    return { status: "disconnected", running: false, healthy: false, ready: false, message: "Tunnel 已停止" }
  }
  const identity = knownIdentity ?? await verifyManagedRuntime(settings, status)
  let result
  try {
    const { stdout } = await runClient(settings, ["runtimes", "stop", runtimeAlias(settings.profile), "--json"], { timeout: 20000, maxBuffer: 128 * 1024 })
    result = parseJsonOutput(stdout)
  } catch (error) {
    if (/not found|no local alias|alias.{0,40}(?:not known|unknown)|(?:not known|unknown).{0,40}alias|找不到|未找到/i.test(error.message)) result = { message: "runtime alias 已停止" }
    else throw error
  }
  await waitForRuntimeExit(settings, status, identity)
  if (proxyRuntimeSnapshot.activePid === status.processPid) {
    proxyRuntimeSnapshot.activeMode = "unknown"
    proxyRuntimeSnapshot.activeAddress = "未连接"
    proxyRuntimeSnapshot.activeSignature = ""
    proxyRuntimeSnapshot.activePid = null
    proxyRuntimeSnapshot.activeSince = null
  }
  tunnelSnapshot.status = "disconnected"
  tunnelSnapshot.lastError = ""
  tunnelSnapshot.updatedAt = new Date().toISOString()
  await persistTunnelStatus()
  recordTunnelEvent("stopped", safeMessage(result.message ?? "Tunnel 已断开"))
  return { status: "disconnected", running: false, healthy: false, ready: false, message: "Tunnel 已断开", result: sanitizeClientOutput(result) }
}

export function startTunnel() {
  return queueTunnelOperation("start", () => startTunnelNow())
}

export function stopTunnel() {
  return queueTunnelOperation("stop", () => stopTunnelNow())
}

async function testProxySelection(settings, { requireProxy = false } = {}) {
  const selected = getProxyEndpoint(settings)
  if (settings.proxyMode === "custom" && !selected.url) throw new TunnelError("自定义代理地址无效。", 503, "proxy_unavailable")
  if (settings.proxyMode === "system" && selected.configured && selected.valid === false) throw new TunnelError(`系统代理无效：${selected.message}`, 503, "proxy_unavailable")
  if (!selected.url) {
    if (requireProxy) throw new TunnelError("系统环境没有可用于 api.openai.com 的代理；当前会直连。", 503, "proxy_unavailable")
    return { selected, port: null, openai: null }
  }
  const port = await testProxyPort(selected.url)
  proxyRuntimeSnapshot.lastPortTest = { ...port, source: selected.source, testedAt: new Date().toISOString() }
  if (port.status !== "reachable") throw new TunnelError(`代理端口不可用：${port.message}`, 503, "proxy_unavailable")
  const openai = await testOpenAIConnection({ proxyUrl: selected.url, timeoutMs: 15000 })
  proxyRuntimeSnapshot.lastOpenAiTest = { ...openai, mode: settings.proxyMode, source: selected.source, testedAt: new Date().toISOString() }
  if (!new Set(["api_reachable", "platform_rate_limited"]).has(openai.status)) {
    throw new TunnelError(`OpenAI API 代理检查失败：${openai.message}`, 503, openai.status === "proxy_unavailable" ? "proxy_unavailable" : openai.status)
  }
  return { selected, port, openai }
}

async function applyTunnelProxySettingsNow(input) {
  const previous = await loadTunnelSettings()
  const requested = input && typeof input === "object" ? input : {}
  const candidate = validateSettings({
    ...previous,
    proxyMode: requested.proxyMode ?? previous.proxyMode,
    proxyUrl: requested.proxyUrl ?? previous.proxyUrl,
    autoStart: requested.autoStart === true,
  })
  candidate.proxyUpdatedAt = new Date().toISOString()
  candidate.updatedAt = candidate.proxyUpdatedAt
  const preflight = candidate.proxyMode === "custom" || candidate.proxyMode === "system"
    ? await testProxySelection(candidate, { requireProxy: candidate.proxyMode === "custom" })
    : { selected: getProxyEndpoint(candidate), port: null, openai: null }

  const previousStatus = await getTunnelRuntimeStatus()
  if (previousStatus.status === "error") throw new TunnelError(`无法确认现有 ChatCode Tunnel 状态：${previousStatus.message}；代理设置未更改。`, 409, "runtime_ownership_unknown")
  const previousIdentity = previousStatus.running ? await verifyManagedRuntime(previous, previousStatus) : null
  if (!previousStatus.running) await assertNoLiveManagedRuntime(previous, previousStatus)
  const shouldReconnect = previousStatus.running || candidate.autoStart
  const previousSnapshot = { ...proxyRuntimeSnapshot }

  if (previousStatus.running) await stopTunnelNow(previous, previousStatus, previousIdentity)
  try {
    await persistTunnelSettings(candidate)
    const runtime = shouldReconnect
      ? await startTunnelNow(candidate, { preflight: { selected: preflight.selected, result: preflight.openai } })
      : await getTunnelRuntimeStatus()
    recordTunnelEvent("proxy_settings_applied", `代理模式已保存为 ${candidate.proxyMode}；自动连接 ${candidate.autoStart ? "已启用" : "已关闭"}`)
    return { settings: candidate, runtime, proxy: await getTunnelProxyStatus(runtime), reconnect: shouldReconnect ? "completed" : "not_started" }
  } catch (error) {
    let rollbackRuntime = null
    let rollbackStopError = null
    try {
      const failedRuntime = await getTunnelRuntimeStatus()
      if (failedRuntime.running) await stopTunnelNow(candidate, failedRuntime)
    } catch (stopError) { rollbackStopError = stopError }
    await persistTunnelSettings(previous)
    proxyRuntimeSnapshot = {
      ...previousSnapshot,
      activeMode: "unknown", activeAddress: "未确认", activeSignature: "", activePid: null, activeSince: null,
    }
    let rollbackError = null
    if (previousStatus.running && !rollbackStopError) {
      try { rollbackRuntime = await startTunnelNow(previous) }
      catch (restoreError) { rollbackError = restoreError }
    }
    const restored = !rollbackStopError && (!previousStatus.running || Boolean(rollbackRuntime?.healthy))
    const detail = rollbackStopError
      ? "旧 runtime 未能确认停止，已恢复原代理配置；请先检查本机 Tunnel 状态，未启动第二个实例。"
      : rollbackError
        ? "配置已恢复到先前值，但旧连接未能重新就绪；请在连接设置中重试。"
        : restored ? "配置已恢复到先前值，旧连接已恢复。" : "配置已恢复到先前值。"
    recordTunnelEvent("proxy_apply_rolled_back", safeMessage(`${error.message} ${detail}`))
    throw new TunnelError(`${error.message} ${detail}`, Number.isInteger(error.status) ? error.status : 502, error.code ?? "proxy_apply_failed")
  }
}

export function applyTunnelProxySettings(input) {
  return queueTunnelOperation("proxy-apply", () => applyTunnelProxySettingsNow(input))
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

function safeMessage(value, secret = "", tunnelId = "") {
  let message = String(value ?? "").replace(/[\r\n\0]+/g, " ").trim()
  if (secret) message = message.split(secret).join("[已脱敏]")
  if (tunnelId) message = message.split(tunnelId).join("[Tunnel ID 已脱敏]")
  message = message
    .replace(/Bearer\s+\S+/gi, "Bearer [已脱敏]")
    .replace(/\b(sk-[A-Za-z0-9_-]{12,})\b/g, "[已脱敏密钥]")
    .replace(/(https?:\/\/)[^/@\s]+:[^/@\s]+@/gi, "$1[代理凭据已脱敏]@")
    .replace(/((?:api.?key|access.?token|refresh.?token|authorization|password|secret)\s*[:=]\s*)[^,;\s]+/gi, "$1[已脱敏]")
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
  const safeTest = (value) => value ? {
    status: value.status, address: value.address, source: value.source, mode: value.mode,
    tcpMs: value.tcpMs ?? value.timings?.tcpMs ?? null, connectMs: value.connectMs ?? value.timings?.connectMs ?? null,
    tlsMs: value.tlsMs ?? value.timings?.tlsMs ?? null, httpMs: value.httpMs ?? value.timings?.httpMs ?? null,
    httpStatus: value.httpStatus ?? null, requestId: value.requestId ?? "", phase: value.phase ?? "",
    testedAt: value.testedAt ?? null, message: safeMessage(value.message),
  } : null
  const safe = {
    status: tunnelSnapshot.status, lastError: safeMessage(tunnelSnapshot.lastError), updatedAt: tunnelSnapshot.updatedAt,
    proxy: {
      activeMode: proxyRuntimeSnapshot.activeMode, activeAddress: proxyRuntimeSnapshot.activeAddress,
      activeSignature: proxyRuntimeSnapshot.activeSignature, activePid: proxyRuntimeSnapshot.activePid,
      activeSince: proxyRuntimeSnapshot.activeSince, lastPortTest: safeTest(proxyRuntimeSnapshot.lastPortTest),
      lastOpenAiTest: safeTest(proxyRuntimeSnapshot.lastOpenAiTest),
      lastSuccessfulPollAt: proxyRuntimeSnapshot.lastSuccessfulPollAt, lastMetadataAt: proxyRuntimeSnapshot.lastMetadataAt,
      lastMetadataAttemptAt: proxyRuntimeSnapshot.lastMetadataAttemptAt, lastMetadataError: proxyRuntimeSnapshot.lastMetadataError,
    },
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
    tunnelSnapshot = { ...tunnelSnapshot, status: saved.status ?? "unknown", lastError: safeMessage(saved.lastError), updatedAt: saved.updatedAt ?? null }
    if (saved.proxy && typeof saved.proxy === "object") {
      const proxy = saved.proxy
      proxyRuntimeSnapshot = {
        ...proxyRuntimeSnapshot,
        activeMode: ["direct", "system", "custom"].includes(proxy.activeMode) ? proxy.activeMode : "unknown",
        activeAddress: safeMessage(proxy.activeAddress || "未确认"), activeSignature: /^[a-f0-9]{64}$/.test(proxy.activeSignature ?? "") ? proxy.activeSignature : "",
        activePid: Number.isSafeInteger(proxy.activePid) && proxy.activePid > 0 ? proxy.activePid : null,
        activeSince: typeof proxy.activeSince === "string" ? proxy.activeSince : null,
        lastPortTest: proxy.lastPortTest && typeof proxy.lastPortTest === "object" ? proxy.lastPortTest : null,
        lastOpenAiTest: proxy.lastOpenAiTest && typeof proxy.lastOpenAiTest === "object" ? proxy.lastOpenAiTest : null,
        lastSuccessfulPollAt: typeof proxy.lastSuccessfulPollAt === "string" ? proxy.lastSuccessfulPollAt : null,
        lastMetadataAt: typeof proxy.lastMetadataAt === "string" ? proxy.lastMetadataAt : null,
        lastMetadataAttemptAt: typeof proxy.lastMetadataAttemptAt === "string" ? proxy.lastMetadataAttemptAt : null,
        lastMetadataError: /^[a-z0-9_-]{1,80}$/i.test(proxy.lastMetadataError ?? "") ? proxy.lastMetadataError : "",
      }
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
