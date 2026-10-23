import { randomUUID } from "node:crypto"
import path from "node:path"
import { canonicalRoot } from "./safe-fs.mjs"
import { isPathWithin, isSensitivePath, pathsOverlap, rejectNetworkOrDeviceRoot } from "./paths.mjs"
import { mutateArray, readArray } from "./state.mjs"
import { DATA_DIR, TMP_DIR } from "./config.mjs"
import { audit } from "./audit.mjs"

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
  return saved
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
