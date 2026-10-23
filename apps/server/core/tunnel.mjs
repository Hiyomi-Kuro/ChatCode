import { spawn, execFile as execFileCallback } from "node:child_process"
import { lstat, mkdir, readFile, realpath, rename, rm, writeFile } from "node:fs/promises"
import path from "node:path"
import { randomUUID } from "node:crypto"
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
const mcpCommand = `node ${CHATCODE_HOME.replaceAll("\\", "/")}/apps/server/mcp.mjs`
const profileNamePattern = /^[a-z0-9][a-z0-9_-]{0,63}$/

let tunnelOperationTail = Promise.resolve()
let activeStartOperation = null
let activeStopOperation = null
let tunnelSnapshot = { status: "not_configured", lastError: "", updatedAt: null, events: [] }

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
  return { tunnelId: "", clientPath: "", profile: "chatcode-local", updatedAt: null }
}

function queueTunnelOperation(kind, run) {
  const active = kind === "start" ? activeStartOperation : activeStopOperation
  if (active) return active
  const operation = tunnelOperationTail.catch(() => {}).then(run)
  tunnelOperationTail = operation.catch(() => {})
  const tracked = operation.finally(() => {
    if (kind === "start" && activeStartOperation === tracked) activeStartOperation = null
    if (kind === "stop" && activeStopOperation === tracked) activeStopOperation = null
  })
  if (kind === "start") activeStartOperation = tracked
  else activeStopOperation = tracked
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
  return { tunnelId: settings.tunnelId, clientPath: settings.clientPath, profile: settings.profile, updatedAt: settings.updatedAt ?? null }
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

function commandEnv(secret = "") {
  return {
    ...process.env,
    CHATCODE_HOME,
    CHATCODE_DATA_DIR: DATA_DIR,
    CHATCODE_TMP_DIR: TMP_DIR,
    CODEX_HOME: runtimeHome,
    XDG_CONFIG_HOME: runtimeHome,
    TUNNEL_CLIENT_STATE_DIR: runtimeHome,
    TUNNEL_CLIENT_PROFILE_DIR: profileDir,
    ...(secret ? { CHATCODE_RUNTIME_API_KEY: secret, CONTROL_PLANE_API_KEY: secret } : {}),
  }
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
      env: commandEnv(secret),
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
  let output
  try {
    const result = await runClient(settings, ["runtimes", "status", runtimeAlias(settings.profile), "--json"], { timeout: 8000, maxBuffer: 64 * 1024 })
    output = parseJsonOutput(result.stdout)
  } catch (error) {
    if (/not found|no local alias|alias.{0,40}(?:not known|unknown)|(?:not known|unknown).{0,40}alias|找不到|未找到/i.test(error.message)) return { status: "disconnected", running: false, healthy: false, ready: false, message: "Tunnel 尚未启动" }
    return { status: "error", running: false, healthy: false, ready: false, message: safeMessage(error.message) }
  }
  const local = output.local ?? {}
  const process = output.process ?? {}
  const health = local.health ?? output.health ?? {}
  const running = Boolean(output.process_running ?? output.running ?? local.process_running ?? process.running)
  const healthy = Boolean(output.healthy ?? health.healthy ?? local.healthy)
  const ready = Boolean(output.ready ?? health.ready ?? local.ready)
  const state = running && healthy ? "connected" : running ? "starting" : output.error ? "error" : "disconnected"
  const message = safeMessage(output.error ?? output.remote_error ?? (ready ? "Tunnel 正在运行并报告就绪" : running ? "Tunnel 进程运行中，正在等待就绪" : "Tunnel 尚未启动"))
  return { status: state, running, healthy, ready, message, healthUrl: safeMessage(output.health_url ?? local.health_url ?? health.url ?? ""), lastError: safeMessage(output.error ?? output.remote_error ?? "") }
}

export function startTunnel() {
  return queueTunnelOperation("start", async () => {
    const settings = await loadTunnelSettings()
    if (!settings.tunnelId) throw new TunnelError("请先填写并保存 Tunnel ID")
    if (!settings.clientPath) throw new TunnelError("请先填写并检测官方 tunnel-client.exe 的绝对路径")
    const secret = await readRuntimeCredential()
    const alias = runtimeAlias(settings.profile)
    const aliases = await listChatCodeRuntimes(settings)
    const conflict = aliases.find((item) => (item.alias === alias && item.tunnel_id !== settings.tunnelId) || (item.tunnel_id === settings.tunnelId && item.alias !== alias))
    if (conflict) throw new TunnelError("同一 Tunnel ID 只能由一个 ChatCode runtime alias 管理。请使用原 Profile，或先从该 Profile 断开。")
    const existing = await getTunnelRuntimeStatus()
    if (existing.running && existing.status === "connected") return existing
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
      throw new TunnelError(`Tunnel 客户端未报告健康状态：${reason}`, 502)
    }
    tunnelSnapshot.status = status.ready ? "connected" : "starting"
    tunnelSnapshot.lastError = ""
    tunnelSnapshot.updatedAt = new Date().toISOString()
    await persistTunnelStatus()
    recordTunnelEvent("started", status.message)
    return status
  })
}

export function stopTunnel() {
  return queueTunnelOperation("stop", async () => {
    const settings = await loadTunnelSettings()
    if (!settings.tunnelId || !settings.clientPath) return { status: "disconnected", running: false, healthy: false, ready: false, message: "Tunnel 尚未配置" }
    let result
    try {
      const { stdout } = await runClient(settings, ["runtimes", "stop", runtimeAlias(settings.profile), "--json"], { timeout: 20000, maxBuffer: 128 * 1024 })
      result = parseJsonOutput(stdout)
    } catch (error) {
      if (/not found|no local alias|alias.{0,40}(?:not known|unknown)|(?:not known|unknown).{0,40}alias|找不到|未找到/i.test(error.message)) return { status: "disconnected", running: false, healthy: false, ready: false, message: "Tunnel 已停止" }
      throw error
    }
    tunnelSnapshot.status = "disconnected"
    tunnelSnapshot.lastError = ""
    tunnelSnapshot.updatedAt = new Date().toISOString()
    await persistTunnelStatus()
    recordTunnelEvent("stopped", safeMessage(result.message ?? "Tunnel 已断开"))
    return { status: "disconnected", running: false, healthy: false, ready: false, message: "Tunnel 已断开", result: sanitizeClientOutput(result) }
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
  const safe = { status: tunnelSnapshot.status, lastError: safeMessage(tunnelSnapshot.lastError), updatedAt: tunnelSnapshot.updatedAt }
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
  } catch { /* no saved diagnostics or unsafe file; status is rechecked with tunnel-client */ }
  try {
    await assertRegularFile(tunnelLogFile)
    const text = await readFile(tunnelLogFile, "utf8")
    tunnelSnapshot.events = text.split(/\r?\n/).filter(Boolean).slice(-100).flatMap((line) => {
      try { const event = JSON.parse(line); return [{ at: event.at, event: event.event, message: safeMessage(event.message) }] } catch { return [] }
    })
  } catch { /* logs are optional diagnostics */ }
}
