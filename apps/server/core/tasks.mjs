import { spawn } from "node:child_process"
import { setTimeout as delay } from "node:timers/promises"
import { createHash, randomUUID } from "node:crypto"
import { mkdir, readFile, writeFile } from "node:fs/promises"
import path from "node:path"
import { audit } from "./audit.mjs"
import { TMP_DIR } from "./config.mjs"
import { assertRegularFile } from "./state.mjs"
import { fileInfo, readFileBytes } from "./safe-fs.mjs"
import { requireWorkspace } from "./workspaces.mjs"
import { mutateArray, readArray } from "./state.mjs"

const ALLOWED_SCRIPTS = new Set(["test", "build", "lint", "typecheck", "check"])
const MAX_TASK_OUTPUT = 128 * 1024
const MAX_TASK_MS = 10 * 60 * 1000
const active = new Map()
const systemRoot = process.env.SystemRoot ?? "C:\\Windows"
const cmd = path.join(systemRoot, "System32", "cmd.exe")
const taskkill = path.join(systemRoot, "System32", "taskkill.exe")
const npmCli = path.join(path.dirname(process.execPath), "node_modules", "npm", "bin", "npm-cli.js")

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex")
}

function sanitize(text) {
  return String(text)
    .replace(/(authorization\s*[:=]\s*bearer\s+)[^\s"']+/gi, "$1[REDACTED]")
    .replace(/\b(?:sk-[A-Za-z0-9_-]{12,}|gh[pousr]_[A-Za-z0-9_]{12,})\b/g, "[REDACTED]")
    .replace(/((?:api[_-]?key|token|password|secret)\s*[=:]\s*)[^\s,;"']+/gi, "$1[REDACTED]")
}

function logPath(id) {
  return path.join(TMP_DIR, "logs", `task-${id}.log`)
}

function safeEnvironment() {
  const system32 = path.join(systemRoot, "System32")
  const paths = [path.dirname(process.execPath), system32]
  if (process.env.SystemDrive) paths.push(`${process.env.SystemDrive}\\Windows\\System32\\Wbem`)
  const emptyUserConfig = path.join(TMP_DIR, "cache", "empty-user.npmrc")
  const emptyGlobalConfig = path.join(TMP_DIR, "cache", "empty-global.npmrc")
  return {
    PATH: [...new Set(paths)].join(path.delimiter),
    PATHEXT: ".COM;.EXE;.BAT;.CMD",
    SystemRoot: systemRoot,
    WINDIR: systemRoot,
    SystemDrive: process.env.SystemDrive ?? "C:",
    ComSpec: cmd,
    TEMP: path.join(TMP_DIR, "cache"),
    TMP: path.join(TMP_DIR, "cache"),
    USERPROFILE: path.join(TMP_DIR, "cache", "user-profile"),
    APPDATA: path.join(TMP_DIR, "cache", "appdata"),
    LOCALAPPDATA: path.join(TMP_DIR, "cache", "localappdata"),
    npm_config_cache: path.join(TMP_DIR, "cache", "npm"),
    NPM_CONFIG_USERCONFIG: emptyUserConfig,
    NPM_CONFIG_GLOBALCONFIG: emptyGlobalConfig,
    NPM_CONFIG_UPDATE_NOTIFIER: "false",
    NPM_CONFIG_FUND: "false",
    NPM_CONFIG_AUDIT: "false",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "NUL",
    GIT_TERMINAL_PROMPT: "0",
    CI: "true",
  }
}

async function appendTaskOutput(id, state, chunk) {
  const text = sanitize(chunk.toString("utf8"))
  state.output = (state.output + text).slice(-MAX_TASK_OUTPUT)
  state.writeQueue = state.writeQueue.then(async () => {
    await mkdir(path.dirname(logPath(id)), { recursive: true })
    await assertRegularFile(logPath(id), { allowMissing: true })
    await writeFile(logPath(id), state.output, "utf8")
  }).catch(() => {})
}

async function taskRecord(id) {
  return (await readArray("tasks")).find((task) => task.id === id)
}

export async function listTasks() {
  const tasks = (await readArray("tasks")).slice(-20).reverse()
  return Promise.all(tasks.map(async (task) => {
    let output = ""
    try { await assertRegularFile(logPath(task.id)); output = await readFile(logPath(task.id), "utf8") } catch (error) { if (error?.code !== "ENOENT") throw error }
    return { ...task, output }
  }))
}

export async function getTask(id) {
  const task = await taskRecord(id)
  if (!task) throw new Error("找不到任务")
  let output = ""
  try { await assertRegularFile(logPath(id)); output = await readFile(logPath(id), "utf8") } catch (error) { if (error?.code !== "ENOENT") throw error }
  return { ...task, output }
}

export async function requestCheck({ workspace_id, script }) {
  if (!ALLOWED_SCRIPTS.has(script)) throw new Error(`只允许请求以下固定脚本名：${[...ALLOWED_SCRIPTS].join(", ")}`)
  const workspace = await requireWorkspace(workspace_id, { writable: true })
  const info = await fileInfo(workspace.root, "package.json")
  if (info.isDirectory || info.size > 256 * 1024) throw new Error("package.json 无效或超过 256 KiB")
  const raw = await readFileBytes(workspace.root, "package.json", 256 * 1024)
  let manifest
  try { manifest = JSON.parse(raw.toString("utf8")) } catch { throw new Error("package.json 格式无效") }
  const commandText = manifest?.scripts?.[script]
  if (typeof commandText !== "string" || !commandText.trim() || commandText.length > 4_000) throw new Error(`项目没有可运行的 ${script} 脚本`)
  const task = {
    id: randomUUID(),
    workspaceId: workspace.id,
    script,
    command: `npm run ${script}`,
    scriptPreview: commandText.slice(0, 4_000),
    packageJsonHash: sha256(raw),
    status: "awaiting_approval",
    requestedAt: new Date().toISOString(),
    startedAt: null,
    finishedAt: null,
    exitCode: null,
    signal: null,
    timeoutMs: MAX_TASK_MS,
  }
  await mutateArray("tasks", (tasks) => { tasks.push(task) })
  await audit("check_requested", { workspaceId: workspace.id, itemId: task.id, result: "awaiting_approval" })
  return { task_id: task.id, status: task.status, command: task.command, script_preview: task.scriptPreview, requires_local_approval: true }
}

export async function approveTask(id) {
  const existing = await taskRecord(id)
  if (!existing) throw new Error("找不到任务")
  await requireWorkspace(existing.workspaceId, { writable: true })
  const task = await mutateArray("tasks", (tasks) => {
    const item = tasks.find((entry) => entry.id === id)
    if (!item) throw new Error("找不到任务")
    if (item.status !== "awaiting_approval") throw new Error("此任务当前不能审批")
    item.status = "approved"
    item.approvedAt = new Date().toISOString()
    return { ...item }
  })
  await audit("check_approved", { workspaceId: task.workspaceId, itemId: id, result: "approved" })
  return task
}

export async function runApprovedTask(id) {
  const existing = await taskRecord(id)
  if (!existing) throw new Error("找不到任务")
  await requireWorkspace(existing.workspaceId, { writable: true })
  const task = await mutateArray("tasks", (tasks) => {
    const item = tasks.find((entry) => entry.id === id)
    if (!item) throw new Error("找不到任务")
    if (item.status !== "approved") throw new Error("项目检查尚未由本机用户批准")
    item.status = "starting"
    item.startedAt = new Date().toISOString()
    return { ...item }
  })
  const workspace = await requireWorkspace(task.workspaceId, { writable: true })
  const currentManifest = await readFileBytes(workspace.root, "package.json", 256 * 1024)
  if (sha256(currentManifest) !== task.packageJsonHash) {
    await finishTask(id, { status: "failed", exitCode: null, signal: null, error: "package.json 在审批后发生变化" })
    throw new Error("package.json 在本机审批后发生变化，请重新请求并审批")
  }
  if (task.scriptPreview !== JSON.parse(currentManifest.toString("utf8")).scripts?.[task.script]) {
    await finishTask(id, { status: "failed", exitCode: null, signal: null, error: "项目脚本在审批后发生变化" })
    throw new Error("项目脚本在审批后发生变化，请重新请求并审批")
  }
  if (process.platform !== "win32") throw new Error("受控项目脚本仅支持 Windows")
  await mkdir(path.join(TMP_DIR, "cache"), { recursive: true })
  await mkdir(path.join(TMP_DIR, "logs"), { recursive: true })
  await writeFile(path.join(TMP_DIR, "cache", "empty-user.npmrc"), "", "utf8")
  await writeFile(path.join(TMP_DIR, "cache", "empty-global.npmrc"), "", "utf8")
  let resolveClosed
  const state = { child: null, output: "", writeQueue: Promise.resolve(), timer: null, stopping: false, finalized: false, closed: new Promise((resolve) => { resolveClosed = resolve }) }
  const child = spawn(process.execPath, [npmCli, "run", task.script], {
    cwd: workspace.root,
    env: safeEnvironment(),
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
  })
  state.child = child
  active.set(id, state)
  child.stdout.on("data", (chunk) => { void appendTaskOutput(id, state, chunk) })
  child.stderr.on("data", (chunk) => { void appendTaskOutput(id, state, chunk) })
  const finalize = async (result) => {
    if (state.finalized) return
    state.finalized = true
    state.stopping = true
    if (state.timer) clearTimeout(state.timer)
    await state.writeQueue
    await finishTask(id, result)
    active.delete(id)
    resolveClosed()
  }
  child.once("error", (error) => {
    void finalize({ status: "failed", exitCode: null, signal: null, error: String(error.message).slice(0, 300) })
  })
  child.once("close", (code, signal) => {
    const status = state.stopping && state.stopReason === "timeout" ? "timed_out"
      : state.stopping ? "cancelled" : code === 0 ? "succeeded" : "failed"
    void finalize({ status, exitCode: code, signal, error: null })
  })
  state.timer = setTimeout(() => { state.stopReason = "timeout"; void cancelTask(id).catch(() => {}) }, MAX_TASK_MS)
  await mutateArray("tasks", (tasks) => {
    const item = tasks.find((entry) => entry.id === id)
    if (item?.status === "starting") { item.status = "running"; item.pid = child.pid ?? null }
  })
  await audit("check_started", { workspaceId: workspace.id, itemId: id, result: "running" })
  return { task_id: id, status: "running", command: task.command }
}

async function finishTask(id, result) {
  await mutateArray("tasks", (tasks) => {
    const task = tasks.find((entry) => entry.id === id)
    if (!task) return
    task.status = result.status
    task.finishedAt = new Date().toISOString()
    task.exitCode = result.exitCode
    task.signal = result.signal
    if (result.error) task.error = sanitize(result.error).slice(0, 300)
  })
  const task = await taskRecord(id)
  await audit(`check_${result.status}`, { workspaceId: task?.workspaceId, itemId: id, result: result.status })
}

export async function cancelTask(id) {
  const state = active.get(id)
  if (!state?.child?.pid) throw new Error("任务当前未运行")
  state.stopping = true
  if (state.stopReason !== "timeout") state.stopReason = "cancelled"
  const killer = spawn(taskkill, ["/PID", String(state.child.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" })
  const killerCode = await new Promise((resolve) => {
    killer.once("error", () => resolve(-1))
    killer.once("close", (code) => resolve(code ?? -1))
  })
  if (killerCode !== 0) {
    try { state.child.kill() } catch { /* the process may already have exited */ }
  }
  const closed = await Promise.race([state.closed.then(() => true), delay(5_000).then(() => false)])
  if (!closed) throw new Error(`取消请求已发送，但任务进程仍未退出（taskkill exit ${killerCode}）`)
  const task = await taskRecord(id)
  return { task_id: id, status: task?.status ?? "cancelled" }
}

export async function markInterruptedTasks() {
  await mutateArray("tasks", (tasks) => {
    for (const task of tasks) {
      if (task.status === "running" || task.status === "starting") {
        task.status = "interrupted"
        task.finishedAt = new Date().toISOString()
      }
    }
  })
}
