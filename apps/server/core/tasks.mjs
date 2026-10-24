import { spawn, execFile as execFileCallback } from "node:child_process"
import { setTimeout as delay } from "node:timers/promises"
import { createHash, randomUUID } from "node:crypto"
import { lstat, mkdir, readFile, realpath, writeFile } from "node:fs/promises"
import path from "node:path"
import { promisify } from "node:util"
import { audit } from "./audit.mjs"
import { TMP_DIR } from "./config.mjs"
import { assertRegularFile } from "./state.mjs"
import { fileInfo, readFileBytes } from "./safe-fs.mjs"
import { isPathWithin, normalizeRelative } from "./paths.mjs"
import { getWorkspace, requireWorkspace } from "./workspaces.mjs"
import { mutateArray, readArray } from "./state.mjs"

const ALLOWED_SCRIPTS = new Set(["test", "build", "lint", "typecheck", "check"])
const MAX_TASK_OUTPUT = 128 * 1024
const MAX_TASK_MS = 10 * 60 * 1000
const TERMINAL_TASK_STATUSES = new Set(["succeeded", "failed", "timed_out", "cancelled", "interrupted"])
const active = new Map()
const systemRoot = process.env.SystemRoot ?? "C:\\Windows"
const cmd = path.join(systemRoot, "System32", "cmd.exe")
const taskkill = path.join(systemRoot, "System32", "taskkill.exe")
const npmCli = path.join(path.dirname(process.execPath), "node_modules", "npm", "bin", "npm-cli.js")
const execFileAsync = promisify(execFileCallback)
const FIXED_COMMAND_TYPES = new Set(["node_test", "node_check", "python_test", "python_compile", "go_test", "rust_test", "dotnet_test"])

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

async function taskLogPath(task) {
  if (!task.logRelativePath) return logPath(task.id)
  if (task.kind !== "android_build" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(task.id ?? "") ||
      !["assembleDebug", "testDebugUnitTest", "lintDebug"].includes(task.buildTask)) {
    throw new Error("任务日志路径类型无效")
  }
  const workspace = await getWorkspace(task.workspaceId)
  if (!workspace) throw new Error("任务工作区不存在")
  const projectPath = normalizeRelative(task.projectPath)
  const relative = normalizeRelative(task.logRelativePath)
  const expected = `${projectPath}/.tmp/logs/android-${task.buildTask}-${task.id}.log`
  if (relative.toLowerCase() !== expected.toLowerCase()) throw new Error("Android 任务日志路径与任务不匹配")
  const root = path.win32.resolve(workspace.root)
  const target = path.win32.resolve(root, ...relative.split("/"))
  if (!isPathWithin(root, target)) throw new Error("任务日志路径超出授权工作区")

  const checkComponent = async (candidate, directory) => {
    let info
    try { info = await lstat(candidate) } catch (error) {
      if (error?.code === "ENOENT") return false
      throw error
    }
    if (info.isSymbolicLink() || (process.platform === "win32" && (Number(info.attributes ?? 0) & 0x400) !== 0)) {
      throw new Error("任务日志路径包含符号链接或 reparse point")
    }
    if (directory ? !info.isDirectory() : (!info.isFile() || Number(info.nlink ?? 1) > 1)) {
      throw new Error("任务日志路径包含非普通文件或目录")
    }
    const actual = await realpath(candidate)
    if (path.win32.resolve(actual).toLowerCase() !== path.win32.resolve(candidate).toLowerCase()) {
      throw new Error("任务日志路径最终位置发生变化")
    }
    return true
  }

  if (!(await checkComponent(root, true))) throw new Error("任务工作区目录不存在")
  let current = root
  const components = relative.split("/")
  for (let index = 0; index < components.length; index++) {
    current = path.win32.join(current, components[index])
    const exists = await checkComponent(current, index < components.length - 1)
    if (!exists) return target
  }
  return target
}

function safeEnvironment(extraPath = []) {
  const system32 = path.join(systemRoot, "System32")
  const paths = [path.dirname(process.execPath), ...extraPath, system32]
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

function normalizeCommandPath(value) {
  if (value === undefined || value === null || value === "") return null
  return normalizeRelative(value)
}

async function findRuntimeExecutable(name) {
  const where = path.join(systemRoot, "System32", "where.exe")
  try {
    const { stdout } = await execFileAsync(where, [`${name}.exe`], { windowsHide: true, timeout: 5_000, maxBuffer: 8_192 })
    const candidate = stdout.split(/\r?\n/).map((line) => line.trim()).find((line) => /^[A-Za-z]:\\/.test(line))
    if (!candidate) throw new Error(`未找到 ${name}.exe`)
    return path.win32.resolve(candidate)
  } catch {
    throw new Error(`当前环境未找到已支持的 ${name}.exe`)
  }
}

async function fixedCommand(workspace, commandType, rawRelativePath) {
  if (!FIXED_COMMAND_TYPES.has(commandType)) throw new Error("固定命令类型无效")
  const relativePath = normalizeCommandPath(rawRelativePath)
  const root = path.win32.resolve(workspace.root)
  const target = relativePath === null ? null : path.win32.resolve(root, ...relativePath.split("/"))
  if (target && !(target.toLowerCase() === root.toLowerCase() || target.toLowerCase().startsWith(`${root.toLowerCase()}\\`))) {
    throw new Error("命令路径超出授权工作区")
  }

  const requireFile = async (extension, label) => {
    if (relativePath === null) throw new Error(`${label} 必须提供 relative_path`)
    const info = await fileInfo(workspace.root, relativePath)
    if (info.isDirectory) throw new Error(`${label} 必须指向文件`)
    if (extension && path.posix.extname(relativePath).toLowerCase() !== extension) throw new Error(`${label} 只接受 ${extension} 文件`)
  }
  const allowPath = new Set(["node_test", "python_test", "go_test", "rust_test", "dotnet_test"])
  if (relativePath !== null && !allowPath.has(commandType) && !["node_check", "python_compile"].includes(commandType)) {
    throw new Error("此固定命令不接受文件路径参数")
  }

  let executable = process.execPath
  let args = []
  let cwd = workspace.root
  let pathAddition = []
  if (commandType === "node_test") {
    if (relativePath !== null) {
      const info = await fileInfo(workspace.root, relativePath)
      if (!info.isDirectory && ![".js", ".cjs", ".mjs"].includes(path.posix.extname(relativePath).toLowerCase())) throw new Error("node_test 路径必须是目录或 .js/.cjs/.mjs 文件")
    }
    args = ["--test", "--test-reporter=tap", ...(relativePath === null ? [] : [relativePath])]
  } else if (commandType === "node_check") {
    await requireFile(null, "node_check")
    if (![".js", ".cjs", ".mjs"].includes(path.posix.extname(relativePath).toLowerCase())) throw new Error("node_check 只接受 .js/.cjs/.mjs 文件")
    args = ["--check", relativePath]
  } else if (commandType === "python_test") {
    executable = await findRuntimeExecutable("python")
    pathAddition = [path.dirname(executable)]
    if (relativePath === null) args = ["-B", "-m", "unittest"]
    else {
      await requireFile(".py", "python_test")
      const module = relativePath.replace(/\.py$/i, "").replace(/[\\/]/g, ".")
      if (module.split(".").some((part) => !/^[A-Za-z_]\w*$/.test(part))) throw new Error("python_test 路径必须由有效的 Python 模块名组成")
      args = ["-B", "-m", "unittest", module]
    }
  } else if (commandType === "python_compile") {
    executable = await findRuntimeExecutable("python")
    pathAddition = [path.dirname(executable)]
    await requireFile(".py", "python_compile")
    // The standard ast module parses a source file without writing __pycache__.
    args = ["-B", "-m", "ast", relativePath]
  } else if (commandType === "go_test") {
    executable = await findRuntimeExecutable("go")
    pathAddition = [path.dirname(executable)]
    if (relativePath !== null) {
      const info = await fileInfo(workspace.root, relativePath)
      if (!info.isDirectory) throw new Error("go_test relative_path 必须指向包目录")
      args = ["test", `./${relativePath}`]
    } else args = ["test", "./..."]
  } else if (commandType === "rust_test") {
    executable = await findRuntimeExecutable("cargo")
    pathAddition = [path.dirname(executable)]
    args = ["test"]
    if (relativePath !== null) {
      await requireFile(".toml", "rust_test")
      if (path.posix.basename(relativePath).toLowerCase() !== "cargo.toml") throw new Error("rust_test 只接受 Cargo.toml")
      args.push("--manifest-path", relativePath)
    }
  } else if (commandType === "dotnet_test") {
    executable = await findRuntimeExecutable("dotnet")
    pathAddition = [path.dirname(executable)]
    args = ["test", "--nologo", "--no-restore"]
    if (relativePath !== null) {
      await requireFile(null, "dotnet_test")
      if (![".sln", ".csproj"].includes(path.posix.extname(relativePath).toLowerCase())) throw new Error("dotnet_test 只接受 .sln 或 .csproj 文件")
      args.splice(1, 0, relativePath)
    }
  }

  const command = [path.basename(executable), ...args].map(quoteCommandPart).join(" ")
  return {
    commandType,
    relativePath,
    executable,
    args,
    cwd,
    environment: safeEnvironment(pathAddition),
    command,
    preview: { executable, arguments: args, cwd, project_relative_path: relativePath },
  }
}

function quoteCommandPart(value) {
  const text = String(value)
  return /[\s"]/.test(text) ? `"${text.replace(/"/g, '\\"')}"` : text
}

async function appendTaskOutput(id, state, chunk) {
  const text = sanitize(chunk.toString("utf8"))
  state.output = (state.output + text).slice(-MAX_TASK_OUTPUT)
  state.writeQueue = state.writeQueue.then(async () => {
    const target = state.logFile ?? logPath(id)
    await mkdir(path.dirname(target), { recursive: true })
    if (state.logTask) await taskLogPath(state.logTask)
    await assertRegularFile(target, { allowMissing: true })
    await writeFile(target, state.output, "utf8")
  }).catch(() => {})
}

async function taskRecord(id) {
  return (await readArray("tasks")).find((task) => task.id === id)
}

export async function listTasks() {
  const tasks = (await readArray("tasks")).slice(-20).reverse()
  return Promise.all(tasks.map(async (task) => {
    let output = ""
    try { const target = await taskLogPath(task); await assertRegularFile(target); output = await readFile(target, "utf8") } catch (error) { if (error?.code !== "ENOENT") throw error }
    return { ...task, output }
  }))
}

export async function getTask(id) {
  const task = await taskRecord(id)
  if (!task) throw new Error("找不到任务")
  let output = ""
  try { const target = await taskLogPath(task); await assertRegularFile(target); output = await readFile(target, "utf8") } catch (error) { if (error?.code !== "ENOENT") throw error }
  return { ...task, output }
}

export async function getTaskOutput({ task_id, offset = 0, limit = 16_000 }) {
  const task = await taskRecord(task_id)
  if (!task) throw new Error("找不到任务")
  const safeOffset = Math.max(0, Math.min(MAX_TASK_OUTPUT, Math.trunc(offset)))
  const safeLimit = Math.max(1, Math.min(32_000, Math.trunc(limit)))
  let output = ""
  try { const target = await taskLogPath(task); await assertRegularFile(target); output = await readFile(target, "utf8") }
  catch (error) { if (error?.code !== "ENOENT") throw error }
  const page = output.slice(safeOffset, safeOffset + safeLimit)
  const next = safeOffset + page.length
  return { task_id, status: task.status, offset: safeOffset, output: page, next_offset: next < output.length ? next : null, eof: next >= output.length }
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

export async function requestAllowedCommand({ workspace_id, command_type, relative_path, agent_task_id, agent_step_index }) {
  const workspace = await requireWorkspace(workspace_id, { writable: true })
  const command = await fixedCommand(workspace, command_type, relative_path)
  if (agent_task_id !== undefined || agent_step_index !== undefined) {
    if (typeof agent_task_id !== "string" || !Number.isInteger(agent_step_index) || agent_step_index < 0) throw new Error("agent_task_id 和 agent_step_index 必须一起提供")
    const linked = await readArray("agentTasks")
    const agent = linked.find((item) => item.id === agent_task_id)
    if (!agent || (agent.workspaceId ?? agent.workspace_id) !== workspace.id) throw new Error("找不到同一工作区中的 Agent 任务")
    if (!agent.plan?.[agent_step_index]) throw new Error("找不到要关联的 Agent 计划步骤")
  }
  const task = {
    id: randomUUID(), kind: "fixed_command", workspaceId: workspace.id,
    commandType: command.commandType, relativePath: command.relativePath,
    command: command.command, commandPreview: command.preview,
    executablePath: command.executable, arguments: command.args,
    status: "awaiting_approval", requestedAt: new Date().toISOString(),
    startedAt: null, finishedAt: null, exitCode: null, signal: null,
    timeoutMs: MAX_TASK_MS, agentTaskId: agent_task_id ?? null,
    agentStepIndex: agent_step_index ?? null,
  }
  await mutateArray("tasks", (tasks) => { tasks.push(task) })
  if (agent_task_id !== undefined) await linkAgentJob(agent_task_id, agent_step_index, task, "awaiting_user", "等待本机批准固定命令。")
  await audit("command_requested", { workspaceId: workspace.id, itemId: task.id, result: "awaiting_approval" })
  return {
    task_id: task.id, status: task.status, command_type: command.commandType,
    relative_path: command.relativePath, command: command.command,
    preview: command.preview, requires_local_approval: true,
  }
}

export async function linkAgentJob(agentTaskId, stepIndex, job, taskStatus, summary) {
  await mutateArray("agentTasks", (tasks) => {
    const task = tasks.find((item) => item.id === agentTaskId)
    if (!task || !task.plan?.[stepIndex]) return
    task.localJobs ??= []
    task.localJobs.push({ task_id: job.id, type: job.kind, status: job.status, created_at: job.requestedAt })
    task.localJobs = task.localJobs.slice(-50)
    task.status = taskStatus
    task.phase = taskStatus
    task.lastObservation = summary
    task.updatedAt = new Date().toISOString()
    task.revision = (Number(task.revision) || 0) + 1
    const step = task.plan[stepIndex]
    if (taskStatus === "running") step.status = "in_progress"
    else if (job.status === "succeeded") step.status = "completed"
    else if (["failed", "timed_out", "cancelled"].includes(job.status)) step.status = "failed"
    step.result_summary = summary
    step.updated_at = task.updatedAt
    const history = Array.isArray(task.history) ? task.history : []
    history.push({ at: task.updatedAt, event: "local_job", summary: `步骤 ${stepIndex + 1}: ${summary}`.slice(0, 2_000) })
    task.history = history.slice(-100)
  })
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

export async function runApprovedCommand(id) {
  const existing = await taskRecord(id)
  if (!existing) throw new Error("找不到任务")
  if (existing.kind !== "fixed_command") throw new Error("此任务不是固定命令任务")
  if (process.platform !== "win32") throw new Error("固定命令仅支持 Windows")
  const workspace = await requireWorkspace(existing.workspaceId, { writable: true })
  const relativePath = normalizeCommandPath(existing.relativePath)
  const execution = await fixedCommand(workspace, existing.commandType, relativePath)
  if (execution.relativePath !== relativePath || execution.executable !== existing.executablePath ||
      JSON.stringify(execution.args) !== JSON.stringify(existing.arguments) || execution.command !== existing.command) {
    throw new Error("固定命令参数在审批后发生变化；请重新请求并审批")
  }
  return launchApprovedProcess(id, "fixed_command", execution)
}

export async function launchApprovedProcess(id, expectedKind, execution) {
  if (process.platform !== "win32") throw new Error("受控 Windows 任务执行器仅支持 Windows")
  const existing = await taskRecord(id)
  if (!existing) throw new Error("找不到任务")
  if (existing.kind !== expectedKind) throw new Error("任务类型与批准的执行器不匹配")
  const workspace = await requireWorkspace(existing.workspaceId, { writable: true })
  const task = await mutateArray("tasks", (tasks) => {
    const item = tasks.find((entry) => entry.id === id)
    if (!item) throw new Error("找不到任务")
    const workerStarting = expectedKind === "android_build" && item.status === "starting"
    if (item.status !== "approved" && !workerStarting) throw new Error("任务尚未由本机用户批准")
    if (!workerStarting) {
      item.status = "starting"
      item.startedAt = new Date().toISOString()
    }
    return { ...item }
  })

  await mkdir(path.join(TMP_DIR, "cache"), { recursive: true })
  await mkdir(path.join(TMP_DIR, "logs"), { recursive: true })
  let resolveClosed
  const state = {
    child: null, output: "", writeQueue: Promise.resolve(), timer: null,
    stopping: false, finalized: false,
    closed: new Promise((resolve) => { resolveClosed = resolve }),
  }
  state.logFile = await taskLogPath(task)
  if (task.logRelativePath) state.logTask = task
  await assertRegularFile(state.logFile, { allowMissing: true })
  const child = spawn(execution.executable, execution.args, {
    cwd: execution.cwd, env: execution.environment, windowsHide: true,
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
    if (task.agentTaskId) await linkAgentJob(task.agentTaskId, task.agentStepIndex, { ...task, status: result.status }, "awaiting_model",
      `任务 ${expectedKind} ${result.status}，exitCode=${result.exitCode ?? "null"}。`)
  }
  const spawnResult = new Promise((resolve, reject) => {
    child.once("spawn", resolve)
    child.once("error", reject)
  })
  child.once("error", (error) => {
    void finalize({ status: "failed", exitCode: null, signal: null, error: String(error.message).slice(0, 300) })
  })
  child.once("close", (code, signal) => {
    const status = state.stopping && state.stopReason === "timeout" ? "timed_out"
      : state.stopping ? "cancelled" : code === 0 ? "succeeded" : "failed"
    void finalize({ status, exitCode: code, signal, error: null })
  })
  try {
    await spawnResult
  } catch (error) {
    await state.closed
    throw new Error(`无法启动已批准的任务：${String(error?.message ?? "spawn failed").slice(0, 300)}`)
  }
  state.timer = setTimeout(() => { state.stopReason = "timeout"; void cancelTask(id).catch(() => {}) }, task.timeoutMs ?? MAX_TASK_MS)
  await mutateArray("tasks", (tasks) => {
    const item = tasks.find((entry) => entry.id === id)
    if (item?.status === "starting") { item.status = "running"; item.pid = child.pid ?? null }
  })
  if (task.agentTaskId) await linkAgentJob(task.agentTaskId, task.agentStepIndex, { ...task, status: "running" }, "running", `任务 ${expectedKind} 已启动。`)
  const eventPrefix = expectedKind === "fixed_command" ? "command" : expectedKind === "android_build" ? "android_build" : "check"
  await audit(`${eventPrefix}_started`, { workspaceId: workspace.id, itemId: id, result: "running" })
  return { task_id: id, status: "running", command: execution.command, preview: execution.preview ?? null }
}

export async function finishTask(id, result) {
  await mutateArray("tasks", (tasks) => {
    const task = tasks.find((entry) => entry.id === id)
    if (!task) return
    if (TERMINAL_TASK_STATUSES.has(task.status)) return
    task.status = result.status
    task.finishedAt = new Date().toISOString()
    task.exitCode = result.exitCode
    task.signal = result.signal
    if (result.error) task.error = sanitize(result.error).slice(0, 300)
  })
  const task = await taskRecord(id)
  if (!task || task.status !== result.status) return
  const event = task?.kind === "fixed_command" ? `command_${result.status}`
    : task?.kind === "android_build" ? `android_build_${result.status}` : `check_${result.status}`
  await audit(event, { workspaceId: task?.workspaceId, itemId: id, result: result.status })
}

export async function cancelTask(id) {
  const state = active.get(id)
  if (!state?.child?.pid) {
    const task = await taskRecord(id)
    if (!task || !["starting", "running"].includes(task.status)) throw new Error("任务当前未运行")
    const processId = task.kind === "android_build" ? task.runnerPid ?? task.pid : task.pid
    if (!Number.isInteger(processId) || processId <= 0) throw new Error("任务进程 ID 不可恢复；请检查本机进程后重试")
    const killed = spawn(taskkill, ["/PID", String(processId), "/T", "/F"], { windowsHide: true, stdio: "ignore" })
    const code = await new Promise((resolve) => {
      killed.once("error", () => resolve(-1))
      killed.once("close", (value) => resolve(value ?? -1))
    })
    if (code !== 0) throw new Error(`无法终止恢复的任务进程（taskkill exit ${code}）`)
    const afterKill = await taskRecord(id)
    if (["starting", "running"].includes(afterKill?.status)) await finishTask(id, { status: "cancelled", exitCode: null, signal: null, error: null })
    const finished = await taskRecord(id)
    return { task_id: id, status: finished?.status ?? "cancelled" }
  }
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
        if (task.kind === "android_build" && Number.isInteger(task.runnerPid) && isPidRunning(task.runnerPid)) continue
        task.status = "interrupted"
        task.finishedAt = new Date().toISOString()
      }
    }
  })
}

function isPidRunning(pid) {
  try { process.kill(pid, 0); return true } catch (error) { return error?.code === "EPERM" }
}
