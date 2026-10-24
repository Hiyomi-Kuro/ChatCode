import { spawn, spawnSync } from "node:child_process"
import { setTimeout as delay } from "node:timers/promises"
import { createHash, randomUUID } from "node:crypto"
import { mkdir, readFile, writeFile } from "node:fs/promises"
import path from "node:path"
import { audit } from "./audit.mjs"
import { TMP_DIR } from "./config.mjs"
import { assertRegularFile } from "./state.mjs"
import { fileInfo, readFileBytes } from "./safe-fs.mjs"
import { normalizeRelative } from "./paths.mjs"
import { requireWorkspace } from "./workspaces.mjs"
import { mutateArray, readArray } from "./state.mjs"

const ALLOWED_SCRIPTS = new Set(["test", "build", "lint", "typecheck", "check"])
const MAX_TASK_OUTPUT = 128 * 1024
const MAX_TASK_MS = 10 * 60 * 1000
const MAX_ACTIVE_TASKS = 2
const DEFAULT_OUTPUT_PAGE = 16 * 1024
const active = new Map()
const systemRoot = process.env.SystemRoot ?? "C:\\Windows"
const cmd = path.join(systemRoot, "System32", "cmd.exe")
const taskkill = path.join(systemRoot, "System32", "taskkill.exe")
const npmCli = path.join(path.dirname(process.execPath), "node_modules", "npm", "bin", "npm-cli.js")
const allowedCommandDefinitions = Object.freeze({
  node_test: { executable: "node", display: ["node", "--test"], args: ["--test"], requires: [] },
  node_check: { executable: "node", display: ["node", "--check", "<relative-file>"], args: ["--check"], requires: [], relativeFile: [".js", ".mjs", ".cjs"] },
  python_test: { executable: "python.exe", display: ["python", "-m", "unittest", "discover"], args: ["-m", "unittest", "discover"], requires: [] },
  python_compile: { executable: "python.exe", display: ["python", "-m", "py_compile", "<relative-file>"], args: ["-m", "py_compile"], requires: [], relativeFile: [".py"] },
  go_test: { executable: "go.exe", display: ["go", "test", "./..."], args: ["test", "./..."], requires: ["go.mod"] },
  rust_test: { executable: "cargo.exe", display: ["cargo", "test"], args: ["test"], requires: ["Cargo.toml"] },
  dotnet_test: { executable: "dotnet.exe", display: ["dotnet", "test", "--no-restore", "<relative-project>"], args: ["test", "--no-restore"], requires: [], relativeFile: [".sln", ".csproj"] },
})

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex")
}

function findAllowedExecutable(name) {
  if (process.platform !== "win32") throw new Error("受控项目命令当前仅支持 Windows")
  if (name === "node") return process.execPath
  const where = path.join(systemRoot, "System32", "where.exe")
  const found = spawnSync(where, [name], { encoding: "utf8", windowsHide: true, timeout: 1_500 })
  const executable = String(found.stdout ?? "").split(/\r?\n/).map((value) => value.trim()).find(Boolean)
  if (found.error || found.status !== 0 || !executable || !path.isAbsolute(executable) || path.extname(executable).toLowerCase() !== ".exe") {
    throw new Error(`当前环境未检测到可直接启动的 ${name} 可执行文件`)
  }
  return executable
}

async function resolveAllowedCommand(workspace, commandType, relativePath) {
  const definition = allowedCommandDefinitions[commandType]
  if (!definition) throw new Error("command_type 不是 ChatCode 提供的固定命令")
  for (const marker of definition.requires) {
    const markerInfo = await fileInfo(workspace.root, marker)
    if (markerInfo.isDirectory) throw new Error(`工作区缺少 ${marker}`)
  }
  let safeRelativePath = null
  let args = [...definition.args]
  let display = [...definition.display]
  if (definition.relativeFile) {
    if (typeof relativePath !== "string" || !relativePath) throw new Error("此命令需要指定根内相对源文件")
    safeRelativePath = normalizeRelative(relativePath)
    if (!definition.relativeFile.includes(path.extname(safeRelativePath).toLowerCase())) throw new Error("源文件扩展名与固定命令不匹配")
    const info = await fileInfo(workspace.root, safeRelativePath)
    if (info.isDirectory) throw new Error("命令目标必须是普通文件")
    args.push(safeRelativePath)
    display[display.length - 1] = safeRelativePath
  } else if (relativePath !== undefined) {
    throw new Error("此固定命令不接受文件路径参数")
  }
  const executable = findAllowedExecutable(definition.executable)
  return { executable, executableName: definition.executable, args, display, relativePath: safeRelativePath }
}

function displayCommand(parts) {
  return parts.map((value) => /^[a-zA-Z0-9_./\\<>-]+$/.test(value) ? value : JSON.stringify(value)).join(" ")
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

function isPidRunning(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try { process.kill(pid, 0); return true } catch (error) { return error?.code === "EPERM" }
}

function safeEnvironment(extraPath = [], commandType = "") {
  const system32 = path.join(systemRoot, "System32")
  const paths = [path.dirname(process.execPath), ...extraPath, system32]
  if (process.env.SystemDrive) paths.push(`${process.env.SystemDrive}\\Windows\\System32\\Wbem`)
  const emptyUserConfig = path.join(TMP_DIR, "cache", "empty-user.npmrc")
  const emptyGlobalConfig = path.join(TMP_DIR, "cache", "empty-global.npmrc")
  const environment = {
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
  if (commandType.startsWith("python_")) environment.PYTHONNOUSERSITE = "1"
  if (commandType === "go_test") {
    environment.CGO_ENABLED = "0"
    environment.GOPROXY = "off"
    environment.GOSUMDB = "off"
  }
  if (commandType === "rust_test") environment.CARGO_NET_OFFLINE = "true"
  if (commandType === "dotnet_test") {
    environment.DOTNET_CLI_TELEMETRY_OPTOUT = "1"
    environment.DOTNET_NOLOGO = "1"
  }
  return environment
}

async function appendTaskOutput(id, state, chunk) {
  const text = sanitize(chunk.toString("utf8"))
  state.totalChars = (state.totalChars ?? 0) + text.length
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

async function notifyLinkedAgentTask(task, stepStatus, taskStatus, summary) {
  if (!task?.agentTaskId || !Number.isInteger(task.agentStepIndex)) return
  try {
    const { updateAgentStep } = await import("./agent-tasks.mjs")
    await updateAgentStep({
      task_id: task.agentTaskId,
      step_index: task.agentStepIndex,
      step_status: stepStatus,
      task_status: taskStatus,
      summary,
    })
  } catch {
    try { await audit("agent_link_update_failed", { workspaceId: task.workspaceId, itemId: task.agentTaskId, result: `job_${task.id}` }) } catch { /* command status remains authoritative */ }
  }
}

export async function listTasks() {
  const tasks = (await readArray("tasks")).slice(-20).reverse()
  return Promise.all(tasks.map(async (task) => {
    let output = ""
    try { await assertRegularFile(logPath(task.id)); output = await readFile(logPath(task.id), "utf8") } catch (error) { if (error?.code !== "ENOENT") throw error }
    return { ...task, displayPreview: task.approvalPreview ?? task.scriptPreview, output }
  }))
}

export async function getTask(id) {
  const task = await taskRecord(id)
  if (!task) throw new Error("找不到任务")
  let output = ""
  try { await assertRegularFile(logPath(id)); output = await readFile(logPath(id), "utf8") } catch (error) { if (error?.code !== "ENOENT") throw error }
  const { executablePath: _executablePath, approvalPreview: _approvalPreview, ownerPid: _ownerPid, ...visibleTask } = task
  return { ...visibleTask, output }
}

export async function getTaskOutput({ task_id, offset = 0, limit = DEFAULT_OUTPUT_PAGE }) {
  if (!Number.isInteger(offset) || offset < 0 || offset > Number.MAX_SAFE_INTEGER) throw new Error("offset 必须是安全的非负整数")
  if (!Number.isInteger(limit) || limit < 1 || limit > 64 * 1024) throw new Error("limit 必须是 1 到 65536 个字符")
  const task = await taskRecord(task_id)
  if (!task) throw new Error("找不到任务")
  const activeState = active.get(task_id)
  let output = activeState?.output ?? ""
  if (!activeState) {
    try { await assertRegularFile(logPath(task_id)); output = await readFile(logPath(task_id), "utf8") } catch (error) { if (error?.code !== "ENOENT") throw error }
  }
  const totalChars = Number.isSafeInteger(activeState?.totalChars) ? activeState.totalChars
    : Number.isSafeInteger(task.outputLength) ? task.outputLength : output.length
  const baseOffset = Math.max(0, totalChars - output.length)
  const startOffset = Math.max(offset, baseOffset)
  const sliceStart = startOffset - baseOffset
  const text = output.slice(sliceStart, sliceStart + limit)
  const nextOffset = startOffset + text.length
  return {
    task_id,
    status: task.status,
    offset: startOffset,
    next_offset: nextOffset,
    total_chars: totalChars,
    truncated_before_offset: offset < baseOffset,
    output: text,
    has_more: nextOffset < totalChars,
  }
}

export async function requestCheck({ workspace_id, script, agent_task_id, agent_step_index }) {
  if (!ALLOWED_SCRIPTS.has(script)) throw new Error(`只允许请求以下固定脚本名：${[...ALLOWED_SCRIPTS].join(", ")}`)
  const workspace = await requireWorkspace(workspace_id, { writable: true })
  let linkedAgentTask = null
  if (agent_task_id !== undefined) {
    if (!Number.isInteger(agent_step_index) || agent_step_index < 0) throw new Error("关联 Agent task 时必须提供有效 agent_step_index")
    linkedAgentTask = (await readArray("agentTasks")).find((item) => item.id === agent_task_id)
    if (!linkedAgentTask || linkedAgentTask.workspaceId !== workspace.id) throw new Error("Agent task 不存在，或不属于同一工作区")
    if (!linkedAgentTask.plan[agent_step_index]) throw new Error("关联的 Agent task 步骤不存在")
  }
  const info = await fileInfo(workspace.root, "package.json")
  if (info.isDirectory || info.size > 256 * 1024) throw new Error("package.json 无效或超过 256 KiB")
  const raw = await readFileBytes(workspace.root, "package.json", 256 * 1024)
  let manifest
  try { manifest = JSON.parse(raw.toString("utf8")) } catch { throw new Error("package.json 格式无效") }
  const commandText = manifest?.scripts?.[script]
  if (typeof commandText !== "string" || !commandText.trim() || commandText.length > 4_000) throw new Error(`项目没有可运行的 ${script} 脚本`)
  const task = {
    id: randomUUID(),
    kind: "project_check",
    ownerPid: process.pid,
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
    agentTaskId: linkedAgentTask?.id ?? null,
    agentStepIndex: linkedAgentTask ? agent_step_index : null,
  }
  await mutateArray("tasks", (tasks) => { tasks.push(task) })
  await audit("check_requested", { workspaceId: workspace.id, itemId: task.id, result: "awaiting_approval" })
  await notifyLinkedAgentTask(task, "in_progress", "awaiting_user", `项目脚本 ${script} 等待本机管理页审批；job ${task.id}。`)
  return { task_id: task.id, status: task.status, command: task.command, script_preview: task.scriptPreview, requires_local_approval: true }
}

export async function requestAllowedCommand({ workspace_id, command_type, relative_path, agent_task_id, agent_step_index }) {
  const workspace = await requireWorkspace(workspace_id, { writable: true })
  let linkedAgentTask = null
  if (agent_task_id !== undefined) {
    if (!Number.isInteger(agent_step_index) || agent_step_index < 0) throw new Error("关联 Agent task 时必须提供有效 agent_step_index")
    linkedAgentTask = (await readArray("agentTasks")).find((item) => item.id === agent_task_id)
    if (!linkedAgentTask || linkedAgentTask.workspaceId !== workspace.id) throw new Error("Agent task 不存在，或不属于同一工作区")
    if (!linkedAgentTask.plan[agent_step_index]) throw new Error("关联的 Agent task 步骤不存在")
  }
  const resolved = await resolveAllowedCommand(workspace, command_type, relative_path)
  const command = displayCommand(resolved.display)
  const task = {
    id: randomUUID(),
    kind: "allowed_command",
    ownerPid: process.pid,
    workspaceId: workspace.id,
    commandType: command_type,
    relativePath: resolved.relativePath,
    command,
    executableName: resolved.executableName,
    executablePath: resolved.executable,
    args: resolved.args,
    scriptPreview: `ChatCode 固定命令参数：${command}`,
    approvalPreview: `可执行文件：${resolved.executable}\n固定参数：${command}\n工作目录：授权工作区根目录`,
    status: "awaiting_approval",
    requestedAt: new Date().toISOString(),
    startedAt: null,
    finishedAt: null,
    exitCode: null,
    signal: null,
    timeoutMs: MAX_TASK_MS,
    agentTaskId: linkedAgentTask?.id ?? null,
    agentStepIndex: linkedAgentTask ? agent_step_index : null,
  }
  await mutateArray("tasks", (tasks) => { tasks.push(task) })
  await audit("allowed_command_requested", { workspaceId: workspace.id, itemId: task.id, result: command_type })
  await notifyLinkedAgentTask(task, "in_progress", "awaiting_user", `固定命令 ${command} 等待本机管理页审批；job ${task.id}。`)
  return { task_id: task.id, status: task.status, command: task.command, command_type, args: task.args, cwd: ".", requires_local_approval: true }
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
  await notifyLinkedAgentTask(task, "in_progress", "awaiting_model", `本机已批准 ${task.command}；ChatGPT 可以决定是否启动 job ${task.id}。`)
  return task
}

async function runApprovedTaskOfKind(id, expectedKind) {
  if (active.size >= MAX_ACTIVE_TASKS) throw new Error(`最多同时运行 ${MAX_ACTIVE_TASKS} 个项目检查任务`)
  const existing = await taskRecord(id)
  if (!existing) throw new Error("找不到任务")
  const existingKind = existing.kind ?? "project_check"
  if (existingKind !== expectedKind) throw new Error(expectedKind === "allowed_command" ? "此 ID 不是待运行的固定命令任务" : "此 ID 不是待运行的项目脚本任务")
  await requireWorkspace(existing.workspaceId, { writable: true })
  const task = await mutateArray("tasks", (tasks) => {
    const item = tasks.find((entry) => entry.id === id)
    if (!item) throw new Error("找不到任务")
    if (item.status !== "approved") throw new Error("项目检查尚未由本机用户批准")
    item.status = "starting"
    item.startedAt = new Date().toISOString()
    item.cancelRequestedAt = null
    item.ownerPid = process.pid
    return { ...item }
  })
  const workspace = await requireWorkspace(task.workspaceId, { writable: true })
  let executable = process.execPath
  let executableArgs = []
  let extraPath = []
  if (existingKind === "project_check") {
  const currentManifest = await readFileBytes(workspace.root, "package.json", 256 * 1024)
  if (sha256(currentManifest) !== task.packageJsonHash) {
    await finishTask(id, { status: "failed", exitCode: null, signal: null, error: "package.json 在审批后发生变化" })
    throw new Error("package.json 在本机审批后发生变化，请重新请求并审批")
  }
  if (task.scriptPreview !== JSON.parse(currentManifest.toString("utf8")).scripts?.[task.script]) {
    await finishTask(id, { status: "failed", exitCode: null, signal: null, error: "项目脚本在审批后发生变化" })
    throw new Error("项目脚本在审批后发生变化，请重新请求并审批")
  }
  executableArgs = [npmCli, "run", task.script]
  } else {
    let resolved
    try { resolved = await resolveAllowedCommand(workspace, task.commandType, task.relativePath) }
    catch (error) {
      await finishTask(id, { status: "failed", exitCode: null, signal: null, error: String(error?.message ?? "固定命令不可用") })
      throw error
    }
    if (resolved.executableName !== task.executableName || resolved.executable !== task.executablePath
      || JSON.stringify(resolved.args) !== JSON.stringify(task.args)) {
      await finishTask(id, { status: "failed", exitCode: null, signal: null, error: "命令定义或可执行文件在审批后发生变化" })
      throw new Error("固定命令在审批后发生变化，请重新请求并审批")
    }
    executable = resolved.executable
    executableArgs = resolved.args
    extraPath = [path.dirname(resolved.executable)]
  }
  if (process.platform !== "win32") throw new Error("受控项目命令仅支持 Windows")
  await mkdir(path.join(TMP_DIR, "cache"), { recursive: true })
  await mkdir(path.join(TMP_DIR, "logs"), { recursive: true })
  await writeFile(path.join(TMP_DIR, "cache", "empty-user.npmrc"), "", "utf8")
  await writeFile(path.join(TMP_DIR, "cache", "empty-global.npmrc"), "", "utf8")
  let resolveClosed
  const state = { child: null, output: "", totalChars: 0, writeQueue: Promise.resolve(), timer: null, stopping: false, finalized: false, closed: new Promise((resolve) => { resolveClosed = resolve }) }
  const child = spawn(executable, executableArgs, {
    cwd: workspace.root,
    env: safeEnvironment(extraPath, task.commandType),
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
    if (state.cancelWatch) clearInterval(state.cancelWatch)
    await state.writeQueue
    await finishTask(id, { ...result, outputLength: state.totalChars })
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
  state.cancelWatch = setInterval(() => {
    if (state.stopping) return
    void taskRecord(id).then((item) => {
      if (item?.cancelRequestedAt) {
        state.stopReason = "cancelled"
        return cancelTask(id)
      }
    }).catch(() => {})
  }, 200)
  state.cancelWatch.unref?.()
  state.timer = setTimeout(() => { state.stopReason = "timeout"; void cancelTask(id).catch(() => {}) }, MAX_TASK_MS)
  await mutateArray("tasks", (tasks) => {
    const item = tasks.find((entry) => entry.id === id)
    if (item?.status === "starting") {
      item.status = "running"
      item.pid = child.pid ?? null
    }
  })
  try { await requireWorkspace(task.workspaceId, { writable: true }) }
  catch (error) {
    await cancelTask(id).catch(() => {})
    throw error
  }
  await audit("check_started", { workspaceId: workspace.id, itemId: id, result: "running" })
  await notifyLinkedAgentTask(task, "in_progress", "running", `${task.command} 正在本机执行；job ${id}。`)
  return { task_id: id, status: "running", command: task.command }
}

export async function runApprovedTask(id) { return runApprovedTaskOfKind(id, "project_check") }
export async function runApprovedCommand(id) { return runApprovedTaskOfKind(id, "allowed_command") }

async function finishTask(id, result) {
  await mutateArray("tasks", (tasks) => {
    const task = tasks.find((entry) => entry.id === id)
    if (!task) return
    task.status = result.status
    task.finishedAt = new Date().toISOString()
    task.exitCode = result.exitCode
    task.signal = result.signal
    if (Number.isSafeInteger(result.outputLength)) task.outputLength = result.outputLength
    if (result.error) task.error = sanitize(result.error).slice(0, 300)
  })
  const task = await taskRecord(id)
  await audit(`check_${result.status}`, { workspaceId: task?.workspaceId, itemId: id, result: result.status })
  await notifyLinkedAgentTask(task, result.status === "succeeded" ? "completed" : "failed", "awaiting_model",
    `${task?.command ?? "本地命令"} 完成：${result.status}，exit ${result.exitCode ?? "n/a"}；通过 get_task_output 读取实际 stdout/stderr。`)
}

export async function cancelTask(id) {
  const state = active.get(id)
  if (!state?.child?.pid) {
    const existing = await taskRecord(id)
    if (!existing || !["starting", "running"].includes(existing.status)) throw new Error("任务当前未运行")
    await mutateArray("tasks", (tasks) => {
      const task = tasks.find((entry) => entry.id === id)
      if (!task || !["starting", "running"].includes(task.status)) throw new Error("任务已结束，不能取消")
      task.cancelRequestedAt ??= new Date().toISOString()
    })
    for (let attempt = 0; attempt < 120; attempt++) {
      await delay(50)
      const task = await taskRecord(id)
      if (!task || !["starting", "running"].includes(task.status)) return { task_id: id, status: task?.status ?? "missing" }
    }
    throw new Error("已将取消请求写入持久化任务状态，但 MCP 执行进程尚未确认结束")
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

export async function cancelWorkspaceTasks(workspaceId) {
  const ids = (await readArray("tasks"))
    .filter((task) => task.workspaceId === workspaceId && ["starting", "running"].includes(task.status))
    .map((task) => task.id)
  const results = []
  for (const id of ids) {
    try { results.push(await cancelTask(id)) }
    catch (error) { results.push({ task_id: id, error: String(error?.message ?? "取消失败").slice(0, 300) }) }
  }
  return results
}

export async function markInterruptedTasks() {
  await mutateArray("tasks", (tasks) => {
    for (const task of tasks) {
      if ((task.status === "running" || task.status === "starting") && !isPidRunning(task.ownerPid)) {
        task.status = "interrupted"
        task.finishedAt = new Date().toISOString()
      }
    }
  })
}
