import { createHash, randomUUID } from "node:crypto"
import { execFile as execFileCallback } from "node:child_process"
import { lstat, realpath } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { promisify } from "node:util"
import { setTimeout as delay } from "node:timers/promises"
import { createDirectory, createNewFile, fileExists, fileInfo, hashFile } from "./safe-fs.mjs"
import { getWorkspace, getUnattendedDevGrant, requireWorkspace } from "./workspaces.mjs"
import { mutateArray, readArray } from "./state.mjs"
import { normalizeRelative } from "./paths.mjs"

const execFileAsync = promisify(execFileCallback)
const MAX_CLI_OUTPUT = 2 * 1024 * 1024
const PACKAGE_PATTERN = /^[a-z][a-z0-9_]*(?:\.[A-Za-z0-9_]+)+$/
const SYSTEM_ROOT = process.env.SystemRoot ?? "C:\\Windows"
let cliCache

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex")
}

function sanitize(text) {
  return String(text ?? "")
    .replace(/(authorization\s*[:=]\s*bearer\s+)[^\s"']+/gi, "$1[REDACTED]")
    .replace(/\b(?:sk-[A-Za-z0-9_-]{12,}|gh[pousr]_[A-Za-z0-9_]{12,})\b/g, "[REDACTED]")
    .replace(/((?:api[_-]?key|token|password|secret)\s*[=:]\s*)[^\s,;"']+/gi, "$1[REDACTED]")
    .replace(/[\r\n\0]+/g, " ")
}

function isReparse(info) {
  return info.isSymbolicLink() || (process.platform === "win32" && (Number(info.attributes ?? 0) & 0x400) !== 0)
}

async function safeExecutable(candidate) {
  const absolute = path.win32.resolve(candidate)
  const driveRoot = path.win32.parse(absolute).root
  let current = driveRoot
  for (const component of absolute.slice(driveRoot.length).split(/[\\/]+/).filter(Boolean)) {
    current = path.win32.join(current, component)
    const info = await lstat(current).catch(() => null)
    if (!info || isReparse(info)) return false
  }
  const info = await lstat(absolute)
  if (!info.isFile()) return false
  return path.win32.resolve(await realpath(absolute)).toLowerCase() === absolute.toLowerCase()
}

async function findMumuCli() {
  if (cliCache && await safeExecutable(cliCache.path).catch(() => false)) {
    const currentHash = sha256(await (await import("node:fs/promises")).readFile(cliCache.path))
    if (currentHash === cliCache.sha256) return cliCache
    cliCache = null
  }
  const roots = [
    process.env.ProgramFiles,
    process.env["ProgramFiles(x86)"],
    "D:\\Program Files",
    "C:\\Program Files",
    "C:\\Program Files (x86)",
  ].filter(Boolean)
  const candidates = [...new Set(roots.map((root) => path.win32.join(root, "MuMuPlayer", "nx_main", "mumu-cli.exe")))]
  for (const candidate of candidates) {
    if (!await safeExecutable(candidate).catch(() => false)) continue
    const bytesHash = sha256(await (await import("node:fs/promises")).readFile(candidate))
    cliCache = { path: candidate, sha256: bytesHash }
    return cliCache
  }
  throw new Error("未找到经过路径和文件属性验证的 MuMu mumu-cli.exe")
}

async function invoke(args, { timeout = 20_000, encoding = "utf8", maxBuffer = MAX_CLI_OUTPUT } = {}) {
  const cli = await findMumuCli()
  try {
    const result = await execFileAsync(cli.path, args, { windowsHide: true, timeout, maxBuffer, encoding })
    return { ...result, cli }
  } catch (error) {
    const message = sanitize(error?.stderr || error?.stdout || error?.message || "MuMu CLI 调用失败").slice(0, 500)
    throw new Error(`MuMu CLI ${args[0] ?? "command"} 失败：${message}`)
  }
}

function parseInstances(text) {
  let parsed
  try { parsed = JSON.parse(String(text).trim()) } catch { throw new Error("MuMu info -v all 未返回有效 JSON") }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("MuMu 实例列表格式无效")
  const instances = []
  for (const [key, item] of Object.entries(parsed)) {
    if (!item || typeof item !== "object") continue
    const index = String(item.index ?? key)
    if (!/^\d{1,4}$/.test(index)) continue
    instances.push({
      index,
      name: String(item.name ?? "").slice(0, 100),
      android_version: String(item.android_version ?? "").slice(0, 32),
      player_state: String(item.player_state ?? "unknown"),
      adb_host_ip: String(item.adb_host_ip ?? ""),
      adb_port: Number(item.adb_port),
      is_android_started: item.is_android_started === true,
      is_process_started: item.is_process_started === true,
      is_main: item.is_main === true,
      error_code: Number(item.error_code ?? 0),
    })
  }
  return instances.sort((a, b) => Number(a.index) - Number(b.index))
}

export async function listMumuInstances() {
  const cli = await findMumuCli()
  const [versionResult, infoResult] = await Promise.all([
    invoke(["version"], { timeout: 10_000, maxBuffer: 32_000 }),
    invoke(["info", "-v", "all"], { timeout: 20_000 }),
  ])
  let version = "unknown"
  try { version = JSON.parse(versionResult.stdout).version ?? version } catch { /* version string stays bounded */ }
  return {
    cli_version: String(version).slice(0, 80), cli_sha256: cli.sha256,
    instances: parseInstances(infoResult.stdout),
  }
}

async function selectedInstance(workspaceId) {
  const workspace = await requireWorkspace(workspaceId)
  const authorization = workspace.executionAuthorization
  const selected = authorization?.profile === "unattendedDev" ? authorization.scope?.mumuInstance : null
  if (!selected) throw new Error("请先在本机管理页的 unattendedDev 设置中选定 MuMu 实例")
  const discovery = await listMumuInstances()
  const current = discovery.instances.find((item) => item.index === String(selected.index))
  if (!current) throw new Error(`已选定的 MuMu 实例 index ${selected.index} 当前不存在；请在本机重新选择实例`)
  if (current.name !== selected.name || current.android_version !== selected.androidVersion ||
      current.adb_host_ip !== selected.adbHostIp || current.adb_port !== selected.adbPort) {
    throw new Error("已选定 MuMu 实例指纹已变化；请在本机重新授权，ChatCode 不会改用其他实例")
  }
  return { workspace, authorization, current, discovery }
}

async function requireDeviceAction(selection, action) {
  const grant = await getUnattendedDevGrant(selection.workspace, { kind: "mumu_action", action })
  if (!grant || grant.authorizationId !== selection.authorization.authorizationId) throw new Error("MuMu 操作缺少有效的本机 unattendedDev 授权")
}

export async function getMumuStatus({ workspace_id }) {
  const { current, discovery } = await selectedInstance(workspace_id)
  return {
    selected_instance: current,
    cli_version: discovery.cli_version,
    connected: current.player_state === "start_finished" && current.is_process_started && current.is_android_started &&
      Number.isInteger(current.adb_port) && current.adb_port > 0,
    adb_endpoint: `${current.adb_host_ip}:${current.adb_port}`,
  }
}

export async function startMumuIfNeeded({ workspace_id }) {
  let selection = await selectedInstance(workspace_id)
  if (selection.current.player_state === "start_finished" && selection.current.is_process_started && selection.current.is_android_started) {
    return { started: false, status: "ready", instance: selection.current }
  }
  await requireDeviceAction(selection, "start")
  await invoke(["control", "-v", selection.current.index, "launch"], { timeout: 30_000 })
  const deadline = Date.now() + 120_000
  while (Date.now() < deadline) {
    await delay(1_000)
    selection = await selectedInstance(workspace_id)
    if (selection.current.player_state === "start_finished" && selection.current.is_process_started && selection.current.is_android_started) {
      return { started: true, status: "ready", instance: selection.current }
    }
  }
  throw new Error(`MuMu index ${selection.current.index} 已请求启动，但 Android 在 120 秒内未就绪`)
}

export async function getAndroidDevices({ workspace_id }) {
  const { current } = await selectedInstance(workspace_id)
  const endpoint = `${current.adb_host_ip}:${current.adb_port}`
  const result = await invoke(["adb", "-v", current.index, "-c", "get-state"], { timeout: 15_000, maxBuffer: 64_000 })
  return {
    selected_instance: current.index, endpoint,
    state: String(result.stdout).trim().slice(0, 200),
    connected: String(result.stdout).trim().toLowerCase() === "device",
  }
}

async function requireBuildArtifact(workspaceId, taskId) {
  const task = (await readArray("tasks")).find((item) => item.id === taskId && item.kind === "android_build")
  if (!task || task.workspaceId !== workspaceId || task.status !== "succeeded" || task.exitCode !== 0 || task.buildTask !== "assembleDebug" || !task.artifact?.published) {
    throw new Error("必须指定此工作区本次成功构建并已校验发布的 assembleDebug task_id")
  }
  const workspace = await requireWorkspace(workspaceId)
  const projectPath = normalizeRelative(task.projectPath)
  const projectGrant = workspace.executionAuthorization?.scope?.android?.find((item) => item.projectPath.toLowerCase() === projectPath.toLowerCase())
  if (workspace.executionAuthorization?.profile !== "unattendedDev" || !projectGrant?.tasks?.includes("assembleDebug")) {
    throw new Error("此 Android 项目未在本机 unattendedDev scope 中授权")
  }
  const relativeApk = `${projectPath}/app-debug.apk`
  const actualHash = (await hashFile(workspace.root, relativeApk)).sha256
  if (actualHash !== task.artifact.sha256) throw new Error("APK 哈希与本次任务的已校验工件记录不一致")
  const artifact = task.artifact
  const packageName = artifact.manifest?.package_name
  if (typeof packageName !== "string" || !PACKAGE_PATTERN.test(packageName) || typeof artifact.manifest?.launchable_activity !== "string") {
    throw new Error("已发布 APK 缺少有效 package 或 launcher 元信息")
  }
  return { task, workspace, relativeApk, packageName, activity: artifact.manifest.launchable_activity, artifact }
}

export async function installDebugApk({ workspace_id, task_id }) {
  const selection = await selectedInstance(workspace_id)
  await requireDeviceAction(selection, "install")
  await requireBuildArtifact(workspace_id, task_id)
  await startMumuIfNeeded({ workspace_id })
  const built = await requireBuildArtifact(workspace_id, task_id)
  const apkPath = path.win32.resolve(built.workspace.root, ...built.relativeApk.split("/"))
  const output = await invoke(["control", "-v", selection.current.index, "app", "install", "-apk", apkPath], { timeout: 240_000, maxBuffer: 256_000 })
  return {
    task_id, instance_index: selection.current.index, package_name: built.packageName,
    apk_sha256: built.artifact.sha256, installed: true, output: sanitize(output.stdout).slice(0, 2_000),
  }
}

export async function launchAndroidApp({ workspace_id, task_id }) {
  const selection = await selectedInstance(workspace_id)
  await requireDeviceAction(selection, "launch")
  const built = await requireBuildArtifact(workspace_id, task_id)
  await startMumuIfNeeded({ workspace_id })
  const output = await invoke(["control", "-v", selection.current.index, "app", "launch", "-pkg", built.packageName], { timeout: 60_000, maxBuffer: 128_000 })
  let state = null
  for (let attempt = 0; attempt < 5; attempt++) {
    await delay(500)
    state = await foregroundState(workspace_id, built.packageName)
    if (state.visible) return {
      task_id, instance_index: selection.current.index, package_name: built.packageName, launched: true,
      launcher: "mumu-cli", visible_state: state, output: sanitize(output.stdout).slice(0, 1_000),
    }
  }

  // Some MuMu versions can return errcode=0 without starting a package installed via ADB.
  // Fall back to Android's package-resolved launch command through the same selected MuMu CLI.
  if (!/^[A-Za-z0-9_$.]+$/.test(built.activity)) throw new Error("APK launcher activity contains unsupported characters; refusing ADB fallback")
  const fallback = await runShellFor(selection.current, `am start -W -n ${built.packageName}/${built.activity}`, { timeout: 30_000, maxBuffer: 64_000 })
  for (let attempt = 0; attempt < 10; attempt++) {
    await delay(500)
    state = await foregroundState(workspace_id, built.packageName)
    if (state.visible) return {
      task_id, instance_index: selection.current.index, package_name: built.packageName, launched: true,
      launcher: "mumu-cli-am-start-fallback", visible_state: state,
      output: sanitize(output.stdout).slice(0, 1_000), fallback_output: sanitize(fallback.output).slice(0, 1_000),
    }
  }
  throw new Error(`MuMu CLI 与 am start 均未使目标应用可见；state=${JSON.stringify(state)}; CLI=${sanitize(output.stdout).slice(0, 500)}; am=${sanitize(fallback.output).slice(0, 500)}`)
}

export async function stopTestApp({ workspace_id, task_id }) {
  const selection = await selectedInstance(workspace_id)
  await requireDeviceAction(selection, "stop")
  const built = await requireBuildArtifact(workspace_id, task_id)
  const output = await invoke(["control", "-v", selection.current.index, "app", "close", "-pkg", built.packageName], { timeout: 30_000, maxBuffer: 64_000 })
  return { task_id, instance_index: selection.current.index, package_name: built.packageName, stopped: true, output: sanitize(output.stdout).slice(0, 1_000) }
}

async function runShellFor(current, command, { timeout = 20_000, maxBuffer = MAX_CLI_OUTPUT } = {}) {
  if (!/^[A-Za-z0-9_./ :={}<>\-]+$/.test(command)) throw new Error("MuMu shell command contains unsupported characters")
  const result = await invoke(["sh", "-v", current.index, "-c", command], { timeout, maxBuffer })
  return { selection: current, output: String(result.stdout ?? "").slice(0, maxBuffer) }
}

async function runShell(workspaceId, command, options) {
  const { current } = await selectedInstance(workspaceId)
  return runShellFor(current, command, options)
}

async function foregroundState(workspaceId, packageName) {
  if (!PACKAGE_PATTERN.test(packageName)) throw new Error("Android 包名格式无效")
  const { current } = await selectedInstance(workspaceId)
  const [activity, windows, pid, layers] = await Promise.all([
    runShellFor(current, "dumpsys activity activities"),
    runShellFor(current, "dumpsys window windows"),
    runShellFor(current, `pidof ${packageName}`),
    runShellFor(current, "dumpsys SurfaceFlinger --list"),
  ])
  const activityText = activity.output
  const displayHeaders = [...activityText.matchAll(/^Display #(\d+)[^\r\n]*$/gm)]
  const activityDisplays = displayHeaders.map((header, index) => {
    const end = displayHeaders[index + 1]?.index ?? activityText.length
    const block = activityText.slice(header.index, end)
    const resumedPackages = [...block.matchAll(/(?:mResumedActivity|topResumedActivity|ResumedActivity)=ActivityRecord\{[^}]*?\bu\d+\s+([A-Za-z0-9_.]+)\//gs)]
      .map((match) => match[1])
    const escapedPackageName = packageName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
    const taskMatch = new RegExp(`Task\\{[^}]*#(\\d+)[^}]*${escapedPackageName}`).exec(block)
    return { display_id: Number(header[1]), block, resumed_packages: resumedPackages, task_id: taskMatch ? Number(taskMatch[1]) : null }
  })
  const targetActivityDisplay = activityDisplays.find((display) => display.resumed_packages.includes(packageName)) ?? null
  const focusedWindowPackage = /mCurrentFocus=Window\{[^\r\n]*?\s([A-Za-z0-9_.]+)\//.exec(windows.output)?.[1]
  const focusedAppPackage = /mFocusedApp=ActivityRecord\{[^\r\n]*?\s([A-Za-z0-9_.]+)\//.exec(windows.output)?.[1]
  const foregroundPackage = focusedWindowPackage ?? focusedAppPackage ?? targetActivityDisplay?.resumed_packages.at(-1) ?? null
  const pidValue = pid.output.trim().split(/\s+/)[0] ?? ""
  const surfaceCount = layers.output.split(/\r?\n/).filter((line) => line.includes(packageName)).length
  const targetWindows = windows.output
    .split(/(?=^\s*Window #\d+\s+Window\{)/m)
    .filter((block) => block.includes(packageName))
  const visibleWindow = targetWindows.find((block) =>
    /mViewVisibility=0x0\b/.test(block) && /mHasSurface=true/.test(block) && /(?:isOnScreen=true|isVisible=true)/.test(block)) ?? null
  const windowVisible = Boolean(visibleWindow)
  const displayMatch = visibleWindow && /\bmDisplayId=(\d+)\b/.exec(visibleWindow)
  const taskMatch = visibleWindow && /\brootTaskId=(\d+)\b/.exec(visibleWindow)
  const displayId = displayMatch ? Number(displayMatch[1]) : targetActivityDisplay?.display_id ?? null
  const activityVisible = Boolean(targetActivityDisplay)
  return {
    package_name: packageName, foreground_package: foregroundPackage, pid: /^\d+$/.test(pidValue) ? Number(pidValue) : null,
    display_id: Number.isInteger(displayId) ? displayId : null,
    task_id: taskMatch ? Number(taskMatch[1]) : targetActivityDisplay?.task_id ?? null,
    activity_visible: activityVisible, window_visible: windowVisible,
    surface_layer_count: surfaceCount, surface_visible: surfaceCount > 0,
    visible: activityVisible && /^\d+$/.test(pidValue) && (windowVisible || surfaceCount > 0),
  }
}

async function physicalDisplayIdFor(current, displayId) {
  if (!Number.isInteger(displayId) || displayId < 0 || displayId > 10_000) throw new Error("目标应用没有有效的 Android display id")
  const display = await runShellFor(current, "dumpsys display", { timeout: 20_000, maxBuffer: 1_000_000 })
  const escapedDisplayId = String(displayId).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
  const match = new RegExp(`displayId=${escapedDisplayId},\\s*uniqueId='local:(\\d+)'`).exec(display.output)
  if (!match) throw new Error(`MuMu 未报告目标 display ${displayId} 对应的本地物理显示器`)
  return match[1]
}

async function targetTask(workspaceId, taskId) {
  const built = await requireBuildArtifact(workspaceId, taskId)
  const selection = await selectedInstance(workspaceId)
  return { ...built, selection }
}

export async function getLogcat({ workspace_id, task_id, offset = 0, limit = 16_000 }) {
  const { packageName } = await targetTask(workspace_id, task_id)
  const pidResult = await runShell(workspace_id, `pidof ${packageName}`, { maxBuffer: 64_000 })
  const pids = pidResult.output.trim().split(/\s+/).filter((item) => /^\d+$/.test(item))
  const logcat = await runShell(workspace_id, "logcat -d -t 1500", { timeout: 30_000, maxBuffer: MAX_CLI_OUTPUT })
  const lines = logcat.output.split(/\r?\n/).filter((line) =>
    pids.some((pid) => line.includes(pid)) ||
    (line.toLowerCase().includes(packageName.toLowerCase()) && /ActivityTaskManager|ActivityManager|crash|fatal/i.test(line)))
  const redacted = lines.map(sanitize)
  const start = Math.max(0, Math.min(redacted.length, Math.trunc(offset)))
  const page = redacted.slice(start, start + Math.max(1, Math.min(200, Math.trunc(limit / 100) || 100)))
  return {
    task_id, package_name: packageName, selected_instance: logcat.selection.index,
    total_filtered_lines: redacted.length, offset: start, lines: page,
    next_offset: start + page.length < redacted.length ? start + page.length : null,
  }
}

export async function captureScreenshot({ workspace_id, task_id }) {
  const { packageName, workspace, task, selection } = await targetTask(workspace_id, task_id)
  await requireDeviceAction(selection, "screenshot")
  const state = await foregroundState(workspace_id, packageName)
  if (!state.visible) throw new Error(`拒绝截图：目标应用不在可见前台；foreground=${state.foreground_package ?? "unknown"}`)
  const physicalDisplayId = await physicalDisplayIdFor(selection.current, state.display_id)
  const result = await invoke(["adb", "-v", selection.current.index, "-c", `exec-out screencap -d ${physicalDisplayId} -p`], {
    timeout: 30_000, encoding: "buffer", maxBuffer: 32 * 1024 * 1024,
  })
  const bytes = Buffer.isBuffer(result.stdout) ? result.stdout : Buffer.from(result.stdout)
  if (bytes.length < 32 || bytes.length > 24 * 1024 * 1024 || bytes.subarray(0, 8).toString("hex") !== "89504e470d0a1a0a") {
    throw new Error("MuMu ADB 未返回有效 PNG 截图")
  }
  const project = normalizeRelative(task.projectPath)
  const directory = `${project}/.tmp/mumu`
  await ensureMumuDirectory(workspace.root, directory)
  const name = `screen-${new Date().toISOString().replace(/[:.]/g, "-")}-${randomUUID()}.png`
  const relative = `${directory}/${name}`
  await createNewFile(workspace.root, relative, bytes)
  const info = await fileInfo(workspace.root, relative)
  const digest = (await hashFile(workspace.root, relative)).sha256
  return { task_id, package_name: packageName, instance_index: selection.current.index, display_id: state.display_id,
    physical_display_id: physicalDisplayId, path: relative, size_bytes: info.sizeBytes, sha256: digest, visible_state: state }
}

export async function dumpUiHierarchy({ workspace_id, task_id }) {
  const built = await targetTask(workspace_id, task_id)
  await requireDeviceAction(built.selection, "ui_dump")
  const state = await foregroundState(workspace_id, built.packageName)
  if (!state.visible) throw new Error(`拒绝读取 UI hierarchy：目标应用不在可见前台；foreground=${state.foreground_package ?? "unknown"}`)
  const remote = `/sdcard/chatcode-window-${randomUUID()}.xml`
  const dump = await runShell(workspace_id, `uiautomator dump ${remote}`, { timeout: 45_000, maxBuffer: 128_000 })
  if (/null root node returned|ERROR:/i.test(dump.output)) {
    throw new Error(`MuMu UIAutomator 无法读取当前显示器的 UI hierarchy：${sanitize(dump.output).slice(0, 500)}`)
  }
  const dumped = await runShell(workspace_id, `cat ${remote}`, { timeout: 20_000, maxBuffer: 2 * 1024 * 1024 })
  const xml = dumped.output.trim()
  if (!xml.startsWith("<?xml") || !xml.includes("hierarchy")) throw new Error("MuMu 没有返回有效的 UI hierarchy")
  if (!xml.includes(built.packageName)) throw new Error("MuMu UIAutomator 返回的 hierarchy 不属于本次构建的目标应用")
  const directory = `${normalizeRelative(built.task.projectPath)}/.tmp/mumu`
  await ensureMumuDirectory(built.workspace.root, directory)
  const relative = `${directory}/ui-${new Date().toISOString().replace(/[:.]/g, "-")}-${randomUUID()}.xml`
  await createNewFile(built.workspace.root, relative, Buffer.from(xml, "utf8"))
  await runShell(workspace_id, `rm ${remote}`).catch(() => {})
  return { task_id, package_name: built.packageName, path: relative, sha256: sha256(Buffer.from(xml, "utf8")), xml_preview: xml.slice(0, 16_000), truncated: xml.length > 16_000 }
}

export async function runAndroidInstrumentationOrUiAutomator({ workspace_id, task_id, actions = [] }) {
  const built = await targetTask(workspace_id, task_id)
  await requireDeviceAction(built.selection, "input")
  if (!Array.isArray(actions) || actions.length < 1 || actions.length > 100) throw new Error("UI automation actions 必须有 1 至 100 项")
  const before = await foregroundState(workspace_id, built.packageName)
  if (!before.visible) throw new Error(`拒绝操作：目标应用不在可见前台；foreground=${before.foreground_package ?? "unknown"}`)
  const completed = []
  for (const action of actions) {
    if (!action || typeof action !== "object") throw new Error("UI automation action 格式无效")
    if (action.type === "tap" && Number.isInteger(action.x) && Number.isInteger(action.y) && action.x >= 0 && action.x <= 10_000 && action.y >= 0 && action.y <= 10_000) {
      await runShell(workspace_id, `input -d ${before.display_id} tap ${action.x} ${action.y}`)
      completed.push({ type: "tap", x: action.x, y: action.y })
    } else if (action.type === "text" && typeof action.text === "string" && action.text.length <= 64 && /^[0-9A-Za-z_+*/().%-]+$/.test(action.text)) {
      await runShell(workspace_id, `input -d ${before.display_id} text ${action.text}`)
      completed.push({ type: "text", length: action.text.length })
    } else if (action.type === "key" && ["ENTER", "BACK", "DEL", "HOME"].includes(action.key)) {
      const code = { ENTER: 66, BACK: 4, DEL: 67, HOME: 3 }[action.key]
      await runShell(workspace_id, `input -d ${before.display_id} keyevent ${code}`)
      completed.push({ type: "key", key: action.key })
    } else {
      throw new Error("只支持边界内 tap/text/ENTER/BACK/DEL/HOME actions")
    }
    await delay(120)
  }
  const after = await foregroundState(workspace_id, built.packageName)
  if (!after.visible) throw new Error("UI automation 后目标应用不再可见；请获取 crash diagnostics")
  return { task_id, package_name: built.packageName, instance_index: built.selection.current.index, actions: completed, visible_after: after }
}

export async function validateAndroidUi({ workspace_id, task_id, rounds = 3 }) {
  const { packageName, selection } = await targetTask(workspace_id, task_id)
  const boundedRounds = Math.max(1, Math.min(5, Math.trunc(rounds)))
  const results = []
  for (let index = 0; index < boundedRounds; index++) {
    results.push({ round: index + 1, ...(await foregroundState(workspace_id, packageName)) })
    if (index + 1 < boundedRounds) await delay(1_000)
  }
  return {
    task_id, package_name: packageName, instance_index: selection.current.index,
    passed: results.length >= 3 && results.every((item) => item.visible), rounds: results,
    failure_reason: results.every((item) => item.visible) ? null : "一轮或多轮未同时观察到目标 Activity、进程和可见窗口/Surface",
  }
}

export async function collectCrashDiagnostics({ workspace_id, task_id }) {
  const { packageName } = await targetTask(workspace_id, task_id)
  const [logs, state] = await Promise.all([
    getLogcat({ workspace_id, task_id, offset: 0, limit: 20_000 }),
    foregroundState(workspace_id, packageName),
  ])
  const suspicious = logs.lines.filter((line) => /FATAL EXCEPTION|AndroidRuntime|Fatal signal|ANR in|am_crash|am_anr/i.test(line)).slice(-50)
  return {
    task_id, package_name: packageName, app_state: state,
    crash_lines: suspicious,
    crash_detected: suspicious.length > 0,
    diagnostics: !state.pid ? ["目标应用进程未运行"] : !state.visible ? ["目标应用未在其所属显示器呈现为可见 Activity 和窗口/Surface"] : [],
    logcat_offset: logs.offset, logcat_next_offset: logs.next_offset,
  }
}

export async function listMumuDevicesForAdmin() {
  return listMumuInstances()
}

async function ensureMumuDirectory(root, relative) {
  if (await fileExists(root, relative)) {
    const info = await fileInfo(root, relative)
    if (!info.isDirectory) throw new Error(`MuMu 临时输出路径不是目录：${relative}`)
    return
  }
  await createDirectory(root, relative)
  const created = await fileInfo(root, relative)
  if (!created.isDirectory) throw new Error(`无法建立 MuMu 临时输出目录：${relative}`)
}
