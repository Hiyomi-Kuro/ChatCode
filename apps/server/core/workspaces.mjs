import { randomUUID } from "node:crypto"
import path from "node:path"
import { canonicalRoot } from "./safe-fs.mjs"
import { isPathWithin, isSensitivePath, normalizeRelative, pathsOverlap, rejectNetworkOrDeviceRoot } from "./paths.mjs"
import { mutateArray, readArray } from "./state.mjs"
import { DATA_DIR, TMP_DIR } from "./config.mjs"
import { audit } from "./audit.mjs"
import { fileInfo, readFileBytes } from "./safe-fs.mjs"
import { createHash } from "node:crypto"

const FIXED_COMMANDS = new Set(["node_test", "node_check", "python_test", "python_compile", "go_test", "rust_test", "dotnet_test"])
const ANDROID_TASKS = new Set(["assembleDebug", "testDebugUnitTest", "lintDebug"])

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex")
}

const REFERENCE_ROOTS = [
  "D:\\Download\\GitHub\\opencode",
  "D:\\Download\\GitHub\\codex-chatgpt-web",
  "D:\\Download\\GitHub\\WinCodex",
]

export function isManagedStatePath(workspace, relative) {
  const target = path.resolve(workspace.root, ...String(relative ?? "").split(/[\\/]/).filter(Boolean))
  return isPathWithin(DATA_DIR, target) || isPathWithin(TMP_DIR, target)
}

export function rejectManagedStatePath(workspace, relative) {
  if (isManagedStatePath(workspace, relative)) throw new Error("拒绝访问 ChatCode 自身的持久化状态或临时文件")
}

export function isSensitiveAllowed(workspace, relative) {
  return workspace.allowSensitive === true || !isSensitivePath(relative)
}

function displayWorkspace(item) {
  // Legacy writable records keep their approval-required semantics.
  const mode = item.mode === "autoWritable" ? "autoWritable" : item.mode === "writable" ? "writable" : "readOnly"
  return {
    id: item.id, name: item.name, path: item.root, mode, status: item.status,
    allowSensitive: item.allowSensitive === true,
    autoWriteGrantedAt: item.autoWriteGrantedAt ?? null,
    sensitiveGrantedAt: item.sensitiveGrantedAt ?? null,
    executionAuthorization: item.executionAuthorization ? {
      profile: item.executionAuthorization.profile,
      authorizationId: item.executionAuthorization.authorizationId,
      authorizedAt: item.executionAuthorization.authorizedAt,
      scope: {
        fixedCommands: [...(item.executionAuthorization.scope?.fixedCommands ?? [])],
        npmScripts: (item.executionAuthorization.scope?.npmScripts ?? []).map((entry) => entry.name),
        androidProjects: (item.executionAuthorization.scope?.android ?? []).map((entry) => ({
          projectPath: entry.projectPath, tasks: [...entry.tasks],
        })),
        gitReadOnly: item.executionAuthorization.scope?.gitReadOnly === true,
        gitWrite: item.executionAuthorization.scope?.gitWrite === true,
        fileLifecycle: item.executionAuthorization.scope?.fileLifecycle === true,
        mumuInstance: item.executionAuthorization.scope?.mumuInstance ?? null,
        mumuActions: item.executionAuthorization.scope?.mumuActions === true,
      },
      osIsolation: item.executionAuthorization.osIsolation ?? "none",
    } : null,
    updatedAt: item.updatedAt ?? item.createdAt,
  }
}

export async function listWorkspaces() {
  return (await readArray("workspaces")).map(displayWorkspace)
}

export async function getWorkspace(id) {
  if (typeof id !== "string" || !id) throw new Error("必须指定 workspace_id")
  const workspace = (await readArray("workspaces")).find((item) => item.id === id)
  if (!workspace) throw new Error("找不到已授权工作区")
  return workspace
}

export async function requireWorkspace(id, { writable = false } = {}) {
  const workspace = await getWorkspace(id)
  if (workspace.status !== "active") throw new Error("工作区已暂停")
  if (writable && !new Set(["writable", "autoWritable"]).has(workspace.mode)) throw new Error("此工作区当前为只读模式")
  return workspace
}

export async function addWorkspace({ name, root, mode = "readOnly", confirmAutoWrite = false, allowSensitive = false, confirmSensitive = false }) {
  rejectNetworkOrDeviceRoot(root)
  if (!new Set(["readOnly", "writable", "autoWritable"]).has(mode)) throw new Error("工作区权限无效")
  if (mode === "autoWritable" && confirmAutoWrite !== true) throw new Error("选择免逐项审批时，必须在本机页面单独明确确认")
  if (allowSensitive && confirmSensitive !== true) throw new Error("敏感文件访问需要单独明确确认")
  if (typeof root !== "string" || root.length > 2048 || !/^[A-Za-z]:[\\/]/.test(root)) throw new Error("请输入本机磁盘上的绝对路径（例如 D:\\Projects\\Demo）")
  if (typeof name === "string" && (name.length > 64 || /[\r\n\0]/.test(name))) throw new Error("显示名称最多 64 个字符，且不能包含换行")
  const canonical = await canonicalRoot(root)
  if (isPathWithin(DATA_DIR, canonical) || isPathWithin(TMP_DIR, canonical)) throw new Error("不能把 ChatCode 自身的数据或临时目录授权为工作区")
  for (const forbidden of REFERENCE_ROOTS) {
    let canonicalForbidden = forbidden
    try { canonicalForbidden = await canonicalRoot(forbidden) } catch { /* a missing reference checkout still remains reserved by its configured path */ }
    if (pathsOverlap(canonical, canonicalForbidden)) throw new Error("不能授权 OpenCode、codex-chatgpt-web、WinCodex 或覆盖这些仓库的目录")
  }
  const cleanName = String(name ?? "").trim() || canonical.split(/[\\/]/).filter(Boolean).at(-1) || "workspace"
  const now = new Date().toISOString()
  const workspace = {
    id: randomUUID(), name: cleanName, root: canonical, mode, status: "active",
    allowSensitive: allowSensitive === true,
    executionAuthorization: null,
    autoWriteGrantedAt: mode === "autoWritable" ? now : null,
    sensitiveGrantedAt: allowSensitive ? now : null,
    createdAt: now, updatedAt: now,
  }
  const saved = await mutateArray("workspaces", async (workspaces) => {
    if (workspaces.some((item) => pathsOverlap(item.root, canonical))) throw new Error("该目录与现有工作区重复或存在父子目录授权冲突")
    workspaces.push(workspace)
    return displayWorkspace(workspace)
  })
  await audit("workspace_added", { workspaceId: workspace.id, result: `${mode}${allowSensitive ? "_sensitive" : ""}` })
  return saved
}

export async function updateWorkspace(id, patch) {
  if (patch.mode === "autoWritable" && patch.confirmAutoWrite !== true) throw new Error("免逐项审批需要本机单独明确确认")
  if (patch.allowSensitive === true && patch.confirmSensitive !== true) throw new Error("敏感文件访问需要单独明确确认")
  const prior = await getWorkspace(id)
  const saved = await mutateArray("workspaces", async (workspaces) => {
    const index = workspaces.findIndex((item) => item.id === id)
    if (index < 0) throw new Error("找不到已授权工作区")
    const current = workspaces[index]
    if (patch.status !== undefined) {
      if (!new Set(["active", "paused"]).has(patch.status)) throw new Error("工作区状态无效")
      current.status = patch.status
    }
    if (patch.mode !== undefined) {
      if (!new Set(["readOnly", "writable", "autoWritable"]).has(patch.mode)) throw new Error("工作区权限无效")
      current.mode = patch.mode
      if (patch.mode === "autoWritable" && prior.mode !== "autoWritable") current.autoWriteGrantedAt = new Date().toISOString()
      if (patch.mode !== "autoWritable") current.autoWriteGrantedAt = null
      if (patch.mode !== "autoWritable") current.executionAuthorization = null
    }
    if (patch.allowSensitive !== undefined) {
      current.allowSensitive = patch.allowSensitive === true
      current.sensitiveGrantedAt = current.allowSensitive ? new Date().toISOString() : null
    }
    if (patch.name !== undefined) current.name = String(patch.name).trim().slice(0, 64) || current.name
    current.updatedAt = new Date().toISOString()
    workspaces[index] = current
    return displayWorkspace(current)
  })
  if (patch.mode !== undefined && patch.mode !== prior.mode) await audit("workspace_mode_changed", { workspaceId: id, result: `${prior.mode}_to_${patch.mode}` })
  if (patch.allowSensitive !== undefined && (prior.allowSensitive === true) !== (patch.allowSensitive === true)) {
    await audit("workspace_sensitive_access_changed", { workspaceId: id, result: patch.allowSensitive ? "granted" : "revoked" })
  }
  if (patch.status !== undefined && patch.status !== prior.status) await audit("workspace_status_changed", { workspaceId: id, result: patch.status })
  if (patch.mode !== undefined && patch.mode !== prior.mode && patch.mode !== "autoWritable" && prior.executionAuthorization) {
    await audit("workspace_execution_authorization_revoked", { workspaceId: id, result: "workspace_mode_changed" })
  }
  return saved
}

export async function setUnattendedDevAuthorization(id, {
  confirmUnattendedDev = false,
  npmScripts = [],
  fixedCommands = [],
  androidProjects = [],
  gitReadOnly = false,
  gitWrite = false,
  fileLifecycle = false,
  mumuInstance = null,
  mumuActions = false,
}) {
  const workspace = await requireWorkspace(id, { writable: true })
  if (workspace.mode !== "autoWritable") throw new Error("unattendedDev 仅适用于已在本机授予 autoWritable 的工作区")
  if (confirmUnattendedDev !== true) throw new Error("启用无人值守执行必须由本机管理页面明确确认")
  if (!Array.isArray(npmScripts) || npmScripts.length > 30) throw new Error("npm 脚本授权列表无效")
  if (!Array.isArray(fixedCommands) || fixedCommands.length > FIXED_COMMANDS.size || fixedCommands.some((item) => !FIXED_COMMANDS.has(item))) {
    throw new Error("固定命令授权列表无效")
  }
  if (!Array.isArray(androidProjects) || androidProjects.length > 10) throw new Error("Android 项目授权列表无效")
  if (typeof gitReadOnly !== "boolean") throw new Error("Git 只读授权选项无效")
  if (typeof gitWrite !== "boolean" || (gitWrite && !gitReadOnly)) throw new Error("Git commit/worktree 写入授权必须同时显式选择 Git 只读范围")
  if (typeof fileLifecycle !== "boolean") throw new Error("文件生命周期授权选项无效")
  if (typeof mumuActions !== "boolean" || (mumuActions && !mumuInstance)) throw new Error("MuMu 设备操作授权必须同时选定一个真实实例")

  const normalizedNames = [...new Set(npmScripts.map((name) => String(name).trim()))]
  if (normalizedNames.some((name) => !/^[A-Za-z0-9:_-]{1,64}$/.test(name))) throw new Error("npm 脚本名无效")
  const npmEntries = []
  if (normalizedNames.length) {
    const info = await fileInfo(workspace.root, "package.json")
    if (info.isDirectory || info.size > 256 * 1024) throw new Error("package.json 无效或超过 256 KiB")
    const bytes = await readFileBytes(workspace.root, "package.json", 256 * 1024)
    let manifest
    try { manifest = JSON.parse(bytes.toString("utf8")) } catch { throw new Error("package.json 格式无效") }
    for (const name of normalizedNames) {
      const script = manifest?.scripts?.[name]
      if (typeof script !== "string" || !script.trim() || script.length > 4_000) throw new Error(`package.json 中不存在可授权的 ${name} 脚本`)
      npmEntries.push({ name, packageJsonSha256: sha256(bytes), scriptSha256: sha256(Buffer.from(script, "utf8")) })
    }
  }

  const androidEntries = []
  for (const item of androidProjects) {
    if (!item || typeof item !== "object" || typeof item.projectPath !== "string" || !Array.isArray(item.tasks)) throw new Error("Android 项目授权项格式无效")
    const projectPath = normalizeRelative(item.projectPath)
    if (!projectPath) throw new Error("Android 项目必须指定工作区内的相对目录")
    const projectInfo = await fileInfo(workspace.root, projectPath)
    if (!projectInfo.isDirectory) throw new Error(`Android 授权路径不是目录：${projectPath}`)
    const tasks = [...new Set(item.tasks)]
    if (!tasks.length || tasks.some((task) => !ANDROID_TASKS.has(task))) throw new Error(`Android 任务列表无效：${projectPath}`)
    androidEntries.push({ projectPath, tasks })
  }

  let selectedMumu = null
  if (mumuInstance !== null) {
    if (!mumuInstance || typeof mumuInstance !== "object" || !/^\d{1,4}$/.test(String(mumuInstance.index)) ||
        typeof mumuInstance.name !== "string" || !mumuInstance.name.trim() ||
        !/^(?:\d{1,3}\.){3}\d{1,3}$/.test(String(mumuInstance.adb_host_ip)) ||
        !Number.isInteger(Number(mumuInstance.adb_port)) || Number(mumuInstance.adb_port) < 1 || Number(mumuInstance.adb_port) > 65535) {
      throw new Error("MuMu 实例必须通过本机 discovery 结果选定")
    }
    selectedMumu = {
      index: String(mumuInstance.index), name: mumuInstance.name.slice(0, 100),
      androidVersion: String(mumuInstance.android_version ?? "").slice(0, 32),
      adbHostIp: String(mumuInstance.adb_host_ip), adbPort: Number(mumuInstance.adb_port),
    }
  }
  if (!normalizedNames.length && !fixedCommands.length && !androidEntries.length && !gitReadOnly && !gitWrite && !selectedMumu && !fileLifecycle) {
    throw new Error("unattendedDev 至少需要一个固定命令、已存在 npm 脚本、Android 项目、Git 只读范围或 MuMu 实例")
  }

  const authorizedAt = new Date().toISOString()
  const executionAuthorization = {
    profile: "unattendedDev", version: 1, authorizationId: randomUUID(), authorizedAt,
    scope: {
      projectRoot: workspace.root,
      fixedCommands: [...new Set(fixedCommands)], npmScripts: npmEntries,
      android: androidEntries, gitReadOnly, gitWrite, fileLifecycle, mumuInstance: selectedMumu, mumuActions,
    },
    executor: { nodePath: process.execPath, nodeVersion: process.version },
    // This Windows process runs as the logged-in user; a project cwd is not OS isolation.
    osIsolation: "none",
  }
  const saved = await mutateArray("workspaces", async (workspaces) => {
    const current = workspaces.find((item) => item.id === id)
    if (!current || current.status !== "active" || current.mode !== "autoWritable") throw new Error("工作区状态在授权时发生变化")
    current.executionAuthorization = executionAuthorization
    current.updatedAt = authorizedAt
    return displayWorkspace(current)
  })
  await audit("workspace_execution_authorization_granted", { workspaceId: id, result: `unattendedDev:${executionAuthorization.authorizationId}` })
  return saved
}

export async function revokeUnattendedDevAuthorization(id) {
  const prior = await getWorkspace(id)
  const hadAuthorization = Boolean(prior.executionAuthorization)
  const saved = await mutateArray("workspaces", (workspaces) => {
    const current = workspaces.find((item) => item.id === id)
    if (!current) throw new Error("找不到已授权工作区")
    current.executionAuthorization = null
    current.updatedAt = new Date().toISOString()
    return displayWorkspace(current)
  })
  if (hadAuthorization) await audit("workspace_execution_authorization_revoked", { workspaceId: id, result: "revoked_locally" })
  return saved
}

export async function getUnattendedDevGrant(workspaceOrId, request) {
  const workspace = typeof workspaceOrId === "string" ? await getWorkspace(workspaceOrId) : workspaceOrId
  if (workspace.status !== "active") throw new Error("工作区已暂停")
  const authorization = workspace.executionAuthorization
  if (!authorization) return null
  if (workspace.mode !== "autoWritable") throw new Error("无人值守执行要求工作区保持 autoWritable")
  if (authorization.profile !== "unattendedDev" || authorization.version !== 1 || !authorization.authorizationId) {
    throw new Error("工作区执行授权记录无效；请在本机撤销并重新配置")
  }
  if (authorization.scope?.projectRoot?.toLowerCase() !== workspace.root.toLowerCase()) throw new Error("无人值守授权的项目根已变化；请重新在本机授权")

  if (request.kind === "fixed_command") {
    if (!authorization.scope.fixedCommands?.includes(request.commandType)) throw new Error(`unattendedDev 未授权固定命令 ${request.commandType}`)
  } else if (request.kind === "npm_script") {
    const grant = authorization.scope.npmScripts?.find((entry) => entry.name === request.script)
    if (!grant) throw new Error(`unattendedDev 未授权 npm 脚本 ${request.script}`)
    if (grant.packageJsonSha256 !== request.packageJsonSha256 || grant.scriptSha256 !== sha256(Buffer.from(request.scriptText, "utf8"))) {
      throw new Error(`npm 脚本 ${request.script} 或 package.json 已变化；请在本机重新授权`)
    }
  } else if (request.kind === "android_build") {
    const projectPath = normalizeRelative(request.projectPath)
    const grant = authorization.scope.android?.find((entry) => entry.projectPath.toLowerCase() === projectPath.toLowerCase())
    if (!grant || !grant.tasks.includes(request.task)) throw new Error(`unattendedDev 未授权 Android 项目/任务 ${projectPath}:${request.task}`)
  } else if (request.kind === "git_read") {
    if (request.operation !== "status" && request.operation !== "diff") throw new Error("unattendedDev 仅支持授权的 Git 只读操作")
    if (authorization.scope.gitReadOnly !== true) throw new Error("unattendedDev 未授权 Git 只读操作")
  } else if (request.kind === "git_write") {
    if (!new Set(["preview_commit", "commit", "create_worktree", "list_worktrees", "remove_worktree", "recover_commit"]).has(request.operation)) {
      throw new Error("unattendedDev Git 写入操作类型无效")
    }
    if (authorization.scope.gitReadOnly !== true || authorization.scope.gitWrite !== true) throw new Error("unattendedDev 未授权受控 Git commit/worktree 操作")
  } else if (request.kind === "mumu_action") {
    if (!authorization.scope.mumuInstance || authorization.scope.mumuActions !== true) throw new Error("unattendedDev 未授权 MuMu 设备操作或未选定实例")
    if (!new Set(["start", "install", "launch", "stop", "input", "screenshot", "ui_dump", "instrumentation"]).has(request.action)) {
      throw new Error("unattendedDev MuMu 操作类型无效")
    }
  } else {
    throw new Error("unattendedDev 操作类型无效")
  }
  return authorization
}

export async function removeWorkspace(id) {
  await getWorkspace(id)
  await mutateArray("workspaces", async (workspaces) => {
    const next = workspaces.filter((item) => item.id !== id)
    if (next.length === workspaces.length) throw new Error("找不到已授权工作区")
    workspaces.splice(0, workspaces.length, ...next)
  })
  await audit("workspace_removed", { workspaceId: id, result: "revoked" })
}
