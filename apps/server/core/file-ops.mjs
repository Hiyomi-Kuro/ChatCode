import { createHash, randomUUID } from "node:crypto"
import { lstat, mkdir, realpath, rm } from "node:fs/promises"
import path from "node:path"
import { DATA_DIR } from "./config.mjs"
import { audit } from "./audit.mjs"
import { hasBlockedExplicitDirectory, normalizeRelative, pathsOverlap, shouldSkipDirectory } from "./paths.mjs"
import {
  copyFileToStaging, createDirectory, deleteFileIfUnchanged, fileExists, fileInfo,
  hashFile, listDirectory, removeEmptyDirectory, writeStagedFile,
} from "./safe-fs.mjs"
import { isManagedStatePath, isSensitiveAllowed, requireWorkspace } from "./workspaces.mjs"
import { mutateArray, readArray, withNamedStateLock } from "./state.mjs"
import { invalidateWorkspaceLsp } from "./lsp.mjs"

const MAX_TREE_ENTRIES = 50_000
const MAX_TREE_BYTES = 200 * 1024 * 1024 * 1024
const TRANSIENT_STATES = new Set(["preparing", "committing"])
const ACTIVE_RECOVERY_STATES = new Set(["active", "restoring", "partial_commit", "recovery_required"])

function sha256(value) {
  return createHash("sha256").update(value).digest("hex")
}

function cleanFileError(error) {
  return String(error?.message ?? "文件恢复失败").replace(/[\r\n\0]+/g, " ").slice(0, 240)
}

function identityFromVersion(version) {
  const match = /^([a-f0-9]{8}:[a-f0-9]{16}):/i.exec(version ?? "")
  if (!match) throw new Error("无法确认 Windows 文件身份")
  return match[1]
}

function isReparse(stat) {
  return stat.isSymbolicLink() || (process.platform === "win32" && (Number(stat.attributes ?? 0) & 0x400) !== 0)
}

function samePath(first, second) {
  return process.platform === "win32"
    ? path.win32.resolve(first).toLocaleLowerCase("en-US") === path.win32.resolve(second).toLocaleLowerCase("en-US")
    : path.resolve(first) === path.resolve(second)
}

async function ensurePlainDirectory(target, { create = false } = {}) {
  if (create) await mkdir(target, { recursive: true })
  const stat = await lstat(target)
  if (!stat.isDirectory() || isReparse(stat)) throw new Error("恢复区包含非普通目录；保留现状并拒绝继续")
  const actual = await realpath(target)
  if (!samePath(actual, target)) throw new Error("恢复区路径解析到配置目录之外")
}

async function createOperationStorage(workspaceId, operationId) {
  await ensurePlainDirectory(DATA_DIR)
  const recoveryRoot = path.join(DATA_DIR, "file-recovery")
  const workspaceRoot = path.join(recoveryRoot, workspaceId)
  await ensurePlainDirectory(recoveryRoot, { create: true })
  await ensurePlainDirectory(workspaceRoot, { create: true })
  const operationRoot = path.join(workspaceRoot, operationId)
  await mkdir(operationRoot)
  await ensurePlainDirectory(operationRoot)
  const payloadRoot = path.join(operationRoot, "payload")
  await mkdir(payloadRoot)
  await ensurePlainDirectory(payloadRoot)
  return { recoveryRoot, workspaceRoot, operationRoot, payloadRoot }
}

function payloadRelative(payloadRoot, relative) {
  const value = relative || "__root__"
  const target = path.resolve(payloadRoot, ...value.split("/").filter(Boolean))
  const rel = path.relative(payloadRoot, target)
  if (!rel || rel === ".." || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) throw new Error("恢复区内部路径越界")
  return target
}

async function assertPayloadRoot(payloadRoot) {
  const base = path.join(DATA_DIR, "file-recovery")
  const resolvedBase = path.resolve(base)
  const resolvedPayload = path.resolve(payloadRoot)
  const rel = path.relative(resolvedBase, resolvedPayload)
  if (!rel || rel === ".." || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) throw new Error("恢复内容路径不在受控恢复区内")
  const parts = resolvedPayload.slice(resolvedBase.length).split(path.sep).filter(Boolean)
  let current = resolvedBase
  await ensurePlainDirectory(current)
  for (const part of parts) {
    current = path.join(current, part)
    await ensurePlainDirectory(current)
  }
}

async function pathInfo(root, relative) {
  if (!await fileExists(root, relative)) return null
  return fileInfo(root, relative)
}

function assertWorkspacePath(workspace, value) {
  const relative = normalizeRelative(value)
  if (!isSensitiveAllowed(workspace, relative)) throw new Error("文件生命周期操作拒绝访问受保护的敏感路径")
  if (hasBlockedExplicitDirectory(relative) || isManagedStatePath(workspace, relative)) throw new Error("文件生命周期操作拒绝访问 ChatCode 内部或生成目录")
  if (relative.split("/").some((part) => shouldSkipDirectory(part))) throw new Error("目录树包含受保护的生成或依赖目录")
  return relative
}

async function operationWorkspace(workspaceId, destructive = false) {
  const workspace = await requireWorkspace(workspaceId, { writable: true })
  if (workspace.mode !== "autoWritable") throw new Error("文件生命周期工具要求本机已授权 autoWritable 工作区")
  if (destructive && workspace.executionAuthorization?.scope?.fileLifecycle !== true) {
    throw new Error("移动、重命名和软删除需要在本机管理页明确启用 fileLifecycle 文件生命周期授权")
  }
  return workspace
}

async function assertCurrentGrant(workspaceId, destructive) {
  return operationWorkspace(workspaceId, destructive)
}

function sortEntries(entries) {
  return [...entries].sort((a, b) => a.relative.localeCompare(b.relative, "en", { sensitivity: "base" }))
}

function manifestDigest(entries) {
  const stable = sortEntries(entries).map(({ relative, type, size_bytes, sha256: digest }) => ({
    relative, type, size_bytes: String(size_bytes ?? "0"), sha256: digest ?? null,
  }))
  return sha256(JSON.stringify(stable))
}

async function collectTree(workspace, inputPath) {
  const rootPath = assertWorkspacePath(workspace, inputPath)
  const entries = []
  let totalBytes = 0n
  async function visit(relative, manifestRelative) {
    const info = await fileInfo(workspace.root, relative)
    if (info.isDirectory) {
      entries.push({ relative: manifestRelative, path: relative, type: "directory", size_bytes: "0", identity: identityFromVersion(info.version) })
      let cursor = ""
      let observed = 0
      let expectedTotal = null
      do {
        const page = await listDirectory(workspace.root, relative, { limit: 500, cursor })
        expectedTotal ??= page.total
        for (const child of page.entries) {
          observed++
          if (child.blocked) throw new Error(`目录树包含符号链接、junction、硬链接或不可读路径：${relative}/${child.name}`)
          const childPath = `${relative}/${child.name}`
          const childManifestPath = manifestRelative ? `${manifestRelative}/${child.name}` : child.name
          assertWorkspacePath(workspace, childPath)
          await visit(childPath, childManifestPath)
          if (entries.length > MAX_TREE_ENTRIES) throw new Error(`目录树超过 ${MAX_TREE_ENTRIES} 项上限`)
        }
        cursor = page.nextCursor ?? ""
      } while (cursor)
      if (expectedTotal !== null && observed !== expectedTotal) throw new Error("目录在清点期间发生变化或含有无法访问的项目")
      return
    }
    const digest = await hashFile(workspace.root, relative)
    totalBytes += BigInt(digest.sizeBytes)
    if (totalBytes > BigInt(MAX_TREE_BYTES)) throw new Error("目录树超过 200 GiB 的单次事务预算")
    entries.push({ relative: manifestRelative, path: relative, type: "file", size_bytes: digest.sizeBytes, sha256: digest.sha256, version: digest.version })
    if (entries.length > MAX_TREE_ENTRIES) throw new Error(`目录树超过 ${MAX_TREE_ENTRIES} 项上限`)
  }
  await visit(rootPath, "")
  const sorted = sortEntries(entries)
  return {
    rootPath, rootType: entries[0].type, rootIdentity: entries[0].identity ?? null,
    entries: sorted, manifest_sha256: manifestDigest(sorted), total_bytes: totalBytes.toString(),
  }
}

async function validateExpected(snapshot, expected) {
  if (!/^[a-f0-9]{64}$/i.test(expected ?? "")) throw new Error("必须提供 get_path_manifest 返回的 SHA-256")
  if (snapshot.manifest_sha256.toLowerCase() !== expected.toLowerCase()) throw new Error("源路径内容版本已变化；请重新获取 manifest")
}

async function validateDestination(workspace, destinationPath, sourcePath, sourceIsDirectory, { allowCaseOnly = false } = {}) {
  const destination = assertWorkspacePath(workspace, destinationPath)
  const sameFolded = destination.toLocaleLowerCase("en-US") === sourcePath.toLocaleLowerCase("en-US")
  const caseOnly = sameFolded && destination !== sourcePath
  if (sameFolded && !caseOnly) throw new Error("源路径和目标路径相同")
  if (caseOnly && !allowCaseOnly) throw new Error("复制操作不能把目标路径改为源路径的大小写变体")
  if (!caseOnly && sourceIsDirectory && pathsOverlap(path.win32.resolve(workspace.root, sourcePath), path.win32.resolve(workspace.root, destination))) {
    throw new Error("源目录与目标目录不能重叠")
  }
  if (!caseOnly && await fileExists(workspace.root, destination)) throw new Error("目标路径已存在；保留现有目标并拒绝覆盖")
  const parent = destination.includes("/") ? destination.slice(0, destination.lastIndexOf("/")) : ""
  const parentInfo = parent ? await fileInfo(workspace.root, parent) : await fileInfo(workspace.root, "")
  if (!parentInfo.isDirectory) throw new Error("目標路径的父项不是目录")
  return { destination, caseOnly }
}

async function storeOperation(record) {
  await mutateArray("fileOperations", async (items) => { items.push(record) })
}

async function updateOperation(operationId, patch) {
  return mutateArray("fileOperations", async (items) => {
    const record = items.find((item) => item.operation_id === operationId)
    if (!record) throw new Error("文件操作日志丢失；保留恢复区并人工检查")
    Object.assign(record, patch, { updated_at: new Date().toISOString() })
    return record
  })
}

async function storeRecovery(record) {
  await mutateArray("fileRecovery", async (items) => { items.push(record) })
}

async function updateRecovery(recoveryId, patch) {
  return mutateArray("fileRecovery", async (items) => {
    const record = items.find((item) => item.recovery_id === recoveryId)
    if (!record) throw new Error("恢复墓碑丢失；保留恢复区并人工检查")
    Object.assign(record, patch, { updated_at: new Date().toISOString() })
    return record
  })
}

async function saveProgress(operationId, changes) {
  const record = await readArray("fileOperations")
  const current = record.find((item) => item.operation_id === operationId)
  if (!current) throw new Error("文件操作日志丢失；停止后续提交")
  await updateOperation(operationId, changes)
}

async function stageSnapshot(workspace, snapshot, payloadRoot, workspaceId, destructive) {
  await assertPayloadRoot(payloadRoot)
  for (const entry of snapshot.entries) {
    await assertCurrentGrant(workspaceId, destructive)
    if (entry.type !== "file") continue
    const sourceDigest = await hashFile(workspace.root, entry.path)
    if (sourceDigest.sha256 !== entry.sha256 || sourceDigest.version !== entry.version) throw new Error(`源文件版本已变化：${entry.path}`)
    const target = payloadRelative(payloadRoot, entry.relative)
    await mkdir(path.dirname(target), { recursive: true })
    const copied = await copyFileToStaging(workspace.root, entry.path, entry.sha256, payloadRoot, target)
    if (copied.sha256 !== entry.sha256 || String(copied.sizeBytes) !== String(entry.size_bytes)) throw new Error(`恢复副本校验失败：${entry.path}`)
  }
  const current = await collectTree(workspace, snapshot.rootPath)
  await validateExpected(current, snapshot.manifest_sha256)
  return current
}

function fullRelative(rootPath, childRelative) {
  return childRelative ? `${rootPath}/${childRelative}` : rootPath
}

function depthOf(relative) {
  return relative ? relative.split("/").length : 0
}

async function createTargetDirectory(workspace, relative) {
  if (await fileExists(workspace.root, relative)) {
    const info = await fileInfo(workspace.root, relative)
    if (!info.isDirectory) throw new Error(`目标文件冲突：${relative}`)
    return { created: false, identity: identityFromVersion(info.version) }
  }
  await createDirectory(workspace.root, relative)
  const info = await fileInfo(workspace.root, relative)
  return { created: true, identity: identityFromVersion(info.version) }
}

async function publishSnapshot(workspace, snapshot, targetPath, payloadRoot, operationId, destructive) {
  const createdFiles = []
  const createdDirectories = []
  await assertPayloadRoot(payloadRoot)
  try {
    if (snapshot.rootType === "directory") {
      await assertCurrentGrant(workspace.id, destructive)
      const rootResult = await createTargetDirectory(workspace, targetPath)
      if (!rootResult.created) throw new Error(`目标目录刚刚创建：${targetPath}`)
      createdDirectories.push({ path: targetPath, identity: rootResult.identity })
      await saveProgress(operationId, { created_directories: [...createdDirectories] })
      const directories = snapshot.entries.filter((entry) => entry.type === "directory" && entry.relative)
        .sort((a, b) => depthOf(a.relative) - depthOf(b.relative) || a.relative.localeCompare(b.relative, "en", { sensitivity: "base" }))
      for (const entry of directories) {
        await assertCurrentGrant(workspace.id, destructive)
        const result = await createTargetDirectory(workspace, fullRelative(targetPath, entry.relative))
        if (!result.created) throw new Error(`目标目录刚刚创建：${fullRelative(targetPath, entry.relative)}`)
        createdDirectories.push({ path: fullRelative(targetPath, entry.relative), identity: result.identity })
        await saveProgress(operationId, { created_directories: [...createdDirectories] })
      }
    }
    const files = snapshot.entries.filter((entry) => entry.type === "file")
    for (const entry of files) {
      await assertCurrentGrant(workspace.id, destructive)
      const target = snapshot.rootType === "directory" ? fullRelative(targetPath, entry.relative) : targetPath
      const stageFile = payloadRelative(payloadRoot, entry.relative)
      const published = await writeStagedFile(workspace.root, target, null, payloadRoot, stageFile)
      if (published.sha256 !== entry.sha256 || String(published.sizeBytes ?? published.bytes) !== String(entry.size_bytes)) {
        try { await deleteFileIfUnchanged(workspace.root, target, published.sha256) } catch { /* journal retains the partial output */ }
        throw new Error(`发布文件内容校验失败：${target}`)
      }
      createdFiles.push({ path: target, sha256: entry.sha256, size_bytes: entry.size_bytes })
      await saveProgress(operationId, { created_files: [...createdFiles] })
    }
    const publishedTree = await collectTree(workspace, targetPath)
    if (publishedTree.manifest_sha256 !== snapshot.manifest_sha256) throw new Error("目标树的最终 manifest 与源树不一致")
    return { createdFiles, createdDirectories, manifest_sha256: publishedTree.manifest_sha256 }
  } catch (error) {
    error.fileOpsCreatedFiles = createdFiles
    error.fileOpsCreatedDirectories = createdDirectories
    throw error
  }
}

async function deleteSnapshot(workspace, snapshot, operationId, workspaceId, destructive) {
  const deletedFiles = []
  const deletedDirectories = []
  const files = snapshot.entries.filter((entry) => entry.type === "file").sort((a, b) => depthOf(b.path) - depthOf(a.path))
  for (const entry of files) {
    await assertCurrentGrant(workspaceId, destructive)
    await deleteFileIfUnchanged(workspace.root, entry.path, entry.sha256)
    deletedFiles.push(entry.path)
    await saveProgress(operationId, { deleted_files: [...deletedFiles] })
  }
  const directories = snapshot.entries.filter((entry) => entry.type === "directory")
    .sort((a, b) => depthOf(b.path) - depthOf(a.path))
  for (const entry of directories) {
    await assertCurrentGrant(workspaceId, destructive)
    await removeEmptyDirectory(workspace.root, entry.path, entry.identity)
    deletedDirectories.push(entry.path)
    await saveProgress(operationId, { deleted_directories: [...deletedDirectories] })
  }
  return { deletedFiles, deletedDirectories }
}

async function removeCreated(workspace, createdFiles, createdDirectories) {
  const failures = []
  for (const entry of [...createdFiles].reverse()) {
    try { await deleteFileIfUnchanged(workspace.root, entry.path, entry.sha256) }
    catch (error) { failures.push({ path: entry.path, error: String(error?.message ?? "删除新文件失败").slice(0, 240) }) }
  }
  for (const entry of [...createdDirectories].reverse()) {
    try {
      const info = await pathInfo(workspace.root, entry.path)
      if (info) await removeEmptyDirectory(workspace.root, entry.path, entry.identity ?? identityFromVersion(info.version))
    } catch (error) { failures.push({ path: entry.path, error: String(error?.message ?? "移除新目录失败").slice(0, 240) }) }
  }
  return failures
}

async function removeBatchDestination(workspace, result, failures) {
  const snapshot = await collectTree(workspace, result.destination_path)
  if (snapshot.manifest_sha256 !== result.manifest_sha256) throw new Error("批量回滚目标已被并发修改")
  failures.push(...await removeCreated(workspace,
    snapshot.entries.filter((entry) => entry.type === "file").map((entry) => ({ path: entry.path, sha256: entry.sha256 })),
    snapshot.entries.filter((entry) => entry.type === "directory")
      .sort((a, b) => depthOf(a.path) - depthOf(b.path))
      .map((entry) => ({ path: entry.path, identity: entry.identity }))))
}

async function assertSourceStillMatches(workspace, snapshot) {
  const current = await collectTree(workspace, snapshot.rootPath)
  if (current.manifest_sha256 !== snapshot.manifest_sha256) throw new Error("源目录在事务准备期间发生变化；未提交后续操作")
  return current
}

function recoveryProjection(snapshot) {
  return snapshot.entries.map(({ relative, type, size_bytes, sha256: digest, identity }) => ({
    relative, type, size_bytes: String(size_bytes ?? "0"), sha256: digest ?? null, identity: identity ?? null,
  }))
}

function payloadRootFromRecord(record) {
  const value = path.resolve(DATA_DIR, ...String(record.payload_relative ?? "").split(/[\\/]/).filter(Boolean))
  const base = path.resolve(DATA_DIR, "file-recovery")
  const rel = path.relative(base, value)
  if (!rel || rel === ".." || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) throw new Error("恢复墓碑中的 payload 路径无效")
  return value
}

function makeRecoveryRecord({ recoveryId, operationId, workspaceId, path: originalPath, snapshot, payloadRoot, reason }) {
  return {
    recovery_id: recoveryId, operation_id: operationId, workspace_id: workspaceId,
    original_path: originalPath, object_type: snapshot.rootType,
    manifest_sha256: snapshot.manifest_sha256, total_bytes: snapshot.total_bytes,
    entries: recoveryProjection(snapshot), root_identity: snapshot.rootIdentity,
    payload_relative: path.relative(DATA_DIR, payloadRoot).split(path.sep).join("/"),
    reason, status: "preparing", created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
  }
}

async function createRecoveryRecord(record) {
  await storeRecovery(record)
  return record
}

async function restoreRecoveryRecord(workspace, record, workspaceId, operationId = null) {
  await assertCurrentGrant(workspaceId, true)
  if (!ACTIVE_RECOVERY_STATES.has(record.status) && record.status !== "preparing") throw new Error(`恢复项状态为 ${record.status}，不能重复恢复`)
  const payloadRoot = payloadRootFromRecord(record)
  await assertPayloadRoot(payloadRoot)
  const originalPath = assertWorkspacePath(workspace, record.original_path)
  const entries = record.entries
  const directories = entries.filter((entry) => entry.type === "directory")
    .sort((a, b) => depthOf(a.relative) - depthOf(b.relative))
  const createdDirectories = []
  const createdFiles = []
  await updateRecovery(record.recovery_id, { status: "restoring", restore_created_directories: [], restore_created_files: [] })
  for (const entry of directories) {
    await assertCurrentGrant(workspaceId, true)
    const relative = fullRelative(originalPath, entry.relative)
    const current = await pathInfo(workspace.root, relative)
    if (current) {
      if (!current.isDirectory) throw new Error(`恢复目标被文件占用：${relative}`)
      const actualIdentity = identityFromVersion(current.version)
      const previouslyCreated = record.restore_created_directories?.find((item) => item.path.toLocaleLowerCase("en-US") === relative.toLocaleLowerCase("en-US"))
      if (entry.identity && actualIdentity !== entry.identity && previouslyCreated?.identity !== actualIdentity) {
        throw new Error(`恢复目标目录已被替换：${relative}`)
      }
      continue
    }
    const result = await createTargetDirectory(workspace, relative)
    createdDirectories.push({ path: relative, identity: result.identity })
    record.restore_created_directories = [...(record.restore_created_directories ?? []), ...createdDirectories.slice(-1)]
    await updateRecovery(record.recovery_id, { status: "restoring", restore_created_directories: [...record.restore_created_directories] })
  }
  const files = entries.filter((entry) => entry.type === "file")
  for (const entry of files) {
    await assertCurrentGrant(workspaceId, true)
    const relative = fullRelative(originalPath, entry.relative)
    const current = await pathInfo(workspace.root, relative)
    if (current) {
      if (current.isDirectory) throw new Error(`恢复目标被目录占用：${relative}`)
      const digest = await hashFile(workspace.root, relative)
      if (digest.sha256 !== entry.sha256) throw new Error(`恢复目标已发生修改，拒绝覆盖：${relative}`)
      continue
    }
    const stageFile = payloadRelative(payloadRoot, entry.relative)
    const result = await writeStagedFile(workspace.root, relative, null, payloadRoot, stageFile)
    if (result.sha256 !== entry.sha256 || String(result.sizeBytes ?? result.bytes) !== String(entry.size_bytes)) {
      try { await deleteFileIfUnchanged(workspace.root, relative, result.sha256) } catch { /* recovery remains required */ }
      throw new Error(`恢复内容校验失败：${relative}`)
    }
    createdFiles.push({ path: relative, sha256: entry.sha256, size_bytes: entry.size_bytes })
    record.restore_created_files = [...(record.restore_created_files ?? []), ...createdFiles.slice(-1)]
    await updateRecovery(record.recovery_id, { status: "restoring", restore_created_files: [...record.restore_created_files] })
    if (operationId) await saveProgress(operationId, { restored_files: [...createdFiles] })
  }
  const restored = await collectTree(workspace, originalPath)
  if (restored.manifest_sha256 !== record.manifest_sha256) throw new Error("恢复后 manifest 不一致；保留恢复区供检查")
  await updateRecovery(record.recovery_id, { status: "restored", restored_at: new Date().toISOString() })
  return { recovery_id: record.recovery_id, original_path: originalPath, status: "restored", manifest_sha256: restored.manifest_sha256 }
}

async function cleanupPayload(operationRoot) {
  const base = path.resolve(DATA_DIR, "file-recovery")
  const target = path.resolve(operationRoot)
  const rel = path.relative(base, target)
  if (!rel || rel === ".." || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) throw new Error("拒绝清理恢复区以外的路径")
  await ensurePlainDirectory(base)
  const parts = rel.split(path.sep).filter(Boolean)
  let current = base
  for (const part of parts) {
    current = path.join(current, part)
    await ensurePlainDirectory(current)
  }
  const stat = await lstat(target)
  if (!stat.isDirectory() || isReparse(stat)) throw new Error("事务临时恢复目录已变化；保留现状")
  await rm(target, { recursive: true, force: false })
}

async function replayExisting(workspaceId, requestId, fingerprint) {
  const entries = await readArray("fileOperations")
  const existing = entries.find((item) => item.workspace_id === workspaceId && item.request_id === requestId)
  if (!existing) return null
  if (existing.request_fingerprint !== fingerprint) throw new Error("幂等键已用于不同的文件操作参数")
  return existing.result ?? {
    operation_id: existing.operation_id, status: existing.status,
    recovery_id: existing.recovery_id ?? null, error: existing.error ?? null,
    message: "已存在同一幂等键的文件事务；没有重复提交。",
  }
}

function requestFingerprint(action, input) {
  return sha256(JSON.stringify({ action, ...input }))
}

async function performOperation(action, input, { workspaceId, parentOperationId = null } = {}) {
  const destructive = action !== "copy"
  const workspace = await operationWorkspace(workspaceId, destructive)
  const requestId = input.request_id
  if (!/^[0-9a-f-]{36}$/i.test(requestId ?? "")) throw new Error("每个文件操作都必须带 UUID 幂等键")
  const fingerprint = requestFingerprint(action, input)
  const prior = await replayExisting(workspaceId, requestId, fingerprint)
  if (prior) return prior
  const sourcePath = assertWorkspacePath(workspace, input.source_path ?? input.path)
  const snapshot = await collectTree(workspace, sourcePath)
  await validateExpected(snapshot, input.expected_manifest_sha256)
  let destinationPath = null
  let caseOnly = false
  if (action === "copy" || action === "move") {
    const destination = await validateDestination(workspace, input.destination_path, sourcePath, snapshot.rootType === "directory", { allowCaseOnly: action === "move" })
    destinationPath = destination.destination
    caseOnly = destination.caseOnly
  }
  if (action === "rename") {
    const name = normalizeRelative(input.new_name)
    if (name.includes("/")) throw new Error("new_name 必须只是一个文件或目录名")
    const parent = sourcePath.includes("/") ? sourcePath.slice(0, sourcePath.lastIndexOf("/")) : ""
    destinationPath = parent ? `${parent}/${name}` : name
    const destination = await validateDestination(workspace, destinationPath, sourcePath, snapshot.rootType === "directory", { allowCaseOnly: true })
    destinationPath = destination.destination
    caseOnly = destination.caseOnly
  }
  if (action === "delete" && sourcePath === "") throw new Error("不允許刪除工作区根目录")
  const operationId = randomUUID()
  const recoveryId = action === "delete" || action === "move" || action === "rename" ? randomUUID() : null
  const storage = await createOperationStorage(workspaceId, operationId)
  const now = new Date().toISOString()
  const record = {
    operation_id: operationId, request_id: requestId, request_fingerprint: fingerprint,
    parent_operation_id: parentOperationId, workspace_id: workspaceId, action,
    source_path: sourcePath, destination_path: destinationPath, recovery_id: recoveryId,
    status: "preparing", owner_pid: process.pid, created_at: now, updated_at: now,
    manifest_sha256: snapshot.manifest_sha256, entries: snapshot.entries.length, total_bytes: snapshot.total_bytes,
    created_files: [], created_directories: [], deleted_files: [], deleted_directories: [],
    payload_relative: path.relative(DATA_DIR, storage.payloadRoot).split(path.sep).join("/"),
  }
  await storeOperation(record)
  let recoveryRecord = null
  let published = null
  try {
    await stageSnapshot(workspace, snapshot, storage.payloadRoot, workspaceId, destructive)
    await updateOperation(operationId, { status: "committing" })
    if (recoveryId) {
      recoveryRecord = makeRecoveryRecord({ recoveryId, operationId, workspaceId, path: sourcePath, snapshot, payloadRoot: storage.payloadRoot, reason: action })
      await createRecoveryRecord(recoveryRecord)
    }
    if (action === "delete") {
      await deleteSnapshot(workspace, snapshot, operationId, workspaceId, true)
      await updateRecovery(recoveryId, { status: "active" })
    } else if (action === "copy") {
      published = await publishSnapshot(workspace, snapshot, destinationPath, storage.payloadRoot, operationId, false)
    } else {
      if (caseOnly) await deleteSnapshot(workspace, snapshot, operationId, workspaceId, true)
      published = await publishSnapshot(workspace, snapshot, destinationPath, storage.payloadRoot, operationId, true)
      if (!caseOnly) await deleteSnapshot(workspace, snapshot, operationId, workspaceId, true)
      await updateRecovery(recoveryId, { status: "active" })
    }
    const result = {
      operation_id: operationId, action, status: "committed", source_path: sourcePath,
      destination_path: destinationPath, recovery_id: recoveryId,
      case_only: caseOnly,
      manifest_sha256: snapshot.manifest_sha256, total_bytes: snapshot.total_bytes,
      atomic: false, created_files: published?.createdFiles ?? [], created_directories: published?.createdDirectories ?? [],
      message: action === "copy" ? "复制完成；源内容和目标 manifest 已校验。" : "操作完成；源文件先校验保存到可恢复区，再逐项提交，因此不承诺多文件物理原子性。",
    }
    // Move and soft-delete tombstones share this payload. Keep it until the
    // user restores the recovery item; only copy's scratch payload is disposable.
    if (!recoveryId) await cleanupPayload(storage.operationRoot)
    await updateOperation(operationId, { status: "committed", result, payload_relative: recoveryId ? record.payload_relative : null })
    await audit(`file_${action}`, { workspaceId, operationId, recoveryId, sourcePath, destinationPath, status: "committed", manifestSha256: snapshot.manifest_sha256 })
    await invalidateWorkspaceLsp(workspaceId).catch(() => {})
    return result
  } catch (error) {
    const message = String(error?.message ?? "文件事务失败").replace(/[\r\n\0]+/g, " ").slice(0, 400)
    const createdFiles = error.fileOpsCreatedFiles ?? published?.createdFiles ?? []
    const createdDirectories = error.fileOpsCreatedDirectories ?? published?.createdDirectories ?? []
    const compensations = []
    let sourceRecoveryFailed = false
    if (action === "copy" || action === "move" || action === "rename") {
      compensations.push(...await removeCreated(workspace, createdFiles, createdDirectories))
    }
    if (recoveryRecord && (action === "delete" || action === "move" || action === "rename")) {
      try { await restoreRecoveryRecord(workspace, recoveryRecord, workspaceId, operationId) }
      catch (restoreError) {
        sourceRecoveryFailed = true
        compensations.push({ path: sourcePath, error: String(restoreError?.message ?? "恢复源失败").slice(0, 240) })
      }
    }
    const status = sourceRecoveryFailed ? "recovery_required" : compensations.length ? "partial_commit" : "rolled_back"
    if (status === "rolled_back") {
      try { await cleanupPayload(storage.operationRoot) }
      catch (cleanupError) {
        compensations.push({ path: storage.operationRoot, error: String(cleanupError?.message ?? "事务暂存清理失败").slice(0, 240) })
      }
    }
    const finalStatus = sourceRecoveryFailed ? "recovery_required" : compensations.length ? "partial_commit" : status
    const result = {
      operation_id: operationId, action, status: finalStatus, source_path: sourcePath, destination_path: destinationPath,
      recovery_id: recoveryId, manifest_sha256: snapshot.manifest_sha256,
      error: message, compensation_errors: compensations,
      message: compensations.length ? "事务部分提交；自动补偿未完成，恢复项和日志已保留。" : "事务失败；已恢复或移除本次创建的内容。",
    }
    if (recoveryId && recoveryRecord) await updateRecovery(recoveryId, { status: sourceRecoveryFailed ? "recovery_required" : compensations.length ? "partial_commit" : "rolled_back" })
    try { await updateOperation(operationId, { status: finalStatus, error: message, compensation_errors: compensations, result, payload_relative: compensations.length ? record.payload_relative : null }) } catch { /* the durable record is retained if its write failed */ }
    await audit(`file_${action}`, { workspaceId, operationId, recoveryId, sourcePath, destinationPath, status: finalStatus, error: message })
    await invalidateWorkspaceLsp(workspaceId).catch(() => {})
    return result
  }
}

export async function getPathManifest({ workspace_id, path: inputPath }) {
  const workspace = await requireWorkspace(workspace_id)
  const snapshot = await collectTree(workspace, inputPath)
  return {
    workspace_id, path: snapshot.rootPath, object_type: snapshot.rootType,
    manifest_sha256: snapshot.manifest_sha256, entry_count: snapshot.entries.length,
    total_bytes: snapshot.total_bytes,
    entries: snapshot.entries.map(({ relative, type, size_bytes, sha256: digest, version }) => ({ relative, type, size_bytes, sha256: digest ?? null, version: version ?? null })),
    complete: true,
  }
}

export async function copyPath(input) {
  return withNamedStateLock(`file-ops-${input.workspace_id}`, () => performOperation("copy", input, { workspaceId: input.workspace_id }))
}

export async function movePath(input) {
  return withNamedStateLock(`file-ops-${input.workspace_id}`, () => performOperation("move", input, { workspaceId: input.workspace_id }))
}

export async function renamePath(input) {
  return withNamedStateLock(`file-ops-${input.workspace_id}`, () => performOperation("rename", input, { workspaceId: input.workspace_id }))
}

export async function deletePath(input) {
  return withNamedStateLock(`file-ops-${input.workspace_id}`, () => performOperation("delete", input, { workspaceId: input.workspace_id }))
}

export async function listRecoveryItems({ workspace_id, limit = 100 }) {
  await requireWorkspace(workspace_id)
  const cap = Math.max(1, Math.min(250, Math.trunc(limit)))
  const recoveries = (await readArray("fileRecovery"))
    .filter((item) => item.workspace_id === workspace_id && ACTIVE_RECOVERY_STATES.has(item.status))
    .sort((a, b) => b.created_at.localeCompare(a.created_at))
    .slice(0, cap)
    .map(({ recovery_id, operation_id, original_path, object_type, manifest_sha256, total_bytes, reason, status, created_at, updated_at, entries }) => ({
      recovery_id, operation_id, original_path, object_type, manifest_sha256, total_bytes,
      entry_count: entries.length, reason, status, created_at, updated_at,
    }))
  const interrupted = (await readArray("fileOperations"))
    .filter((item) => item.workspace_id === workspace_id && ["partial_commit", "recovery_required"].includes(item.status))
    .slice(0, cap)
    .map(({ operation_id, action, source_path, destination_path, recovery_id, status, error, updated_at }) => ({
      operation_id, action, source_path, destination_path, recovery_id, status, error, updated_at,
    }))
  return { workspace_id, recoveries, interrupted_operations: interrupted, limit: cap }
}

export async function recoverFileOperation({ workspace_id, operation_id, request_id }) {
  return withNamedStateLock(`file-ops-${workspace_id}`, async () => {
    if (!/^[0-9a-f-]{36}$/i.test(request_id ?? "")) throw new Error("恢复事务必须带 UUID 幂等键")
    const operations = await readArray("fileOperations")
    const record = operations.find((item) => item.operation_id === operation_id && item.workspace_id === workspace_id)
    if (!record) throw new Error("文件事务不属于该工作区或已不存在")
    if (!["partial_commit", "recovery_required"].includes(record.status)) throw new Error("只有 partial_commit 或 recovery_required 事务可以重试补偿")
    const destructive = record.action !== "copy"
    const workspace = await operationWorkspace(workspace_id, destructive)
    const fingerprint = requestFingerprint("recover_operation", { operation_id })
    const prior = await replayExisting(workspace_id, request_id, fingerprint)
    if (prior) return prior
    const recoveryId = record.recovery_id ?? null
    const recovery = recoveryId ? (await readArray("fileRecovery")).find((item) => item.recovery_id === recoveryId && item.workspace_id === workspace_id) : null
    const journalId = randomUUID()
    const journal = {
      operation_id: journalId, request_id, request_fingerprint: fingerprint, parent_operation_id: operation_id,
      workspace_id, action: "recover_operation", recovery_id: recoveryId, status: "committing", owner_pid: process.pid,
      created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
    }
    await storeOperation(journal)
    const errors = []
    let sourceRestored = !recoveryId
    try {
      if (record.action === "batch") {
        let sourceRestoreFailed = false
        for (const result of [...(record.completed_steps ?? [])].reverse()) {
          try {
            if (["move", "rename", "delete"].includes(result.action) && result.recovery_id) {
              const item = (await readArray("fileRecovery")).find((entry) => entry.recovery_id === result.recovery_id && entry.workspace_id === workspace_id)
              if (!item) throw new Error("批量步骤缺少持久恢复墓碑")
              if (!["restored", "rolled_back"].includes(item.status)) await restoreRecoveryRecord(workspace, item, workspace_id, journalId)
            }
            if (["copy", "move", "rename"].includes(result.action)) await removeBatchDestination(workspace, result, errors)
          } catch (error) {
            if (["move", "rename", "delete"].includes(result.action)) sourceRestoreFailed = true
            errors.push({ path: result.source_path ?? result.destination_path ?? "", error: cleanFileError(error) })
          }
        }
        sourceRestored = !sourceRestoreFailed
      } else {
        if (recovery && !["restored", "rolled_back"].includes(recovery.status)) {
          await restoreRecoveryRecord(workspace, recovery, workspace_id, journalId)
          sourceRestored = true
        } else sourceRestored = true
        if (["copy", "move", "rename"].includes(record.action)) {
          errors.push(...await removeCreated(workspace, record.created_files ?? [], record.created_directories ?? []))
        }
      }
    } catch (error) { errors.push({ path: record.source_path ?? "", error: cleanFileError(error) }); sourceRestored = false }
    const status = !sourceRestored ? "recovery_required" : errors.length ? "partial_commit" : "rolled_back"
    const result = {
      operation_id: journalId, original_operation_id: operation_id, recovery_id: recoveryId,
      status, source_restored: sourceRestored, compensation_errors: errors,
      message: status === "rolled_back" ? "事务补偿完成；已核对版本后恢复源内容并清理本次创建的目标。" : status === "partial_commit" ? "源内容已恢复，但有目标或目录无法安全清理；保留事务记录供检查。" : "仍有源内容无法安全恢复；保留恢复区和事务记录。",
    }
    await updateOperation(journalId, { status: status === "rolled_back" ? "committed" : status, result, compensation_errors: errors })
    await updateOperation(operation_id, { status, recovery_result: result, updated_at: new Date().toISOString() })
    if (recoveryId && recovery && !sourceRestored) await updateRecovery(recoveryId, { status: "recovery_required" })
    await audit("file_operation_recovered", { workspaceId: workspace_id, operationId: operation_id, recoveryId, status })
    await invalidateWorkspaceLsp(workspace_id).catch(() => {})
    return result
  })
}

export async function restoreDeletedPath({ workspace_id, recovery_id, request_id }) {
  return withNamedStateLock(`file-ops-${workspace_id}`, async () => {
    const workspace = await operationWorkspace(workspace_id, true)
    if (!/^[0-9a-f-]{36}$/i.test(request_id ?? "")) throw new Error("恢复操作必须带 UUID 幂等键")
    const fingerprint = requestFingerprint("restore", { recovery_id })
    const prior = await replayExisting(workspace_id, request_id, fingerprint)
    if (prior) return prior
    const record = (await readArray("fileRecovery")).find((item) => item.recovery_id === recovery_id && item.workspace_id === workspace_id)
    if (!record) throw new Error("恢复 ID 不属于该工作区或已不存在")
    if (record.status === "restored") return { recovery_id, status: "restored", message: "此恢复项已恢复；没有重复写入。" }
    const operationId = randomUUID()
    const journal = {
      operation_id: operationId, request_id, request_fingerprint: fingerprint,
      workspace_id, action: "restore", recovery_id, source_path: record.original_path,
      status: "committing", owner_pid: process.pid, created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
    }
    await storeOperation(journal)
    try {
      const result = await restoreRecoveryRecord(workspace, record, workspace_id, operationId)
      await updateOperation(operationId, { status: "committed", result })
      await audit("file_restore", { workspaceId: workspace_id, operationId, recoveryId: recovery_id, sourcePath: record.original_path, status: "committed" })
      await invalidateWorkspaceLsp(workspace_id).catch(() => {})
      return { operation_id: operationId, ...result, atomic: false }
    } catch (error) {
      const message = String(error?.message ?? "恢复失败").replace(/[\r\n\0]+/g, " ").slice(0, 400)
      await updateRecovery(recovery_id, { status: "recovery_required", last_error: message })
      const result = { operation_id: operationId, recovery_id, status: "recovery_required", original_path: record.original_path, error: message }
      await updateOperation(operationId, { status: "recovery_required", error: message, result })
      await invalidateWorkspaceLsp(workspace_id).catch(() => {})
      return result
    }
  })
}

export async function applyFileOperations({ workspace_id, request_id, operations }) {
  return withNamedStateLock(`file-ops-${workspace_id}`, async () => {
    const workspace = await operationWorkspace(workspace_id, operations.some((item) => item.action !== "copy"))
    if (!/^[0-9a-f-]{36}$/i.test(request_id ?? "")) throw new Error("批量事务必须带 UUID 幂等键")
    if (!Array.isArray(operations) || operations.length < 1 || operations.length > 20) throw new Error("批量事务必须含 1 到 20 个文件操作")
    const fingerprint = requestFingerprint("batch", { operations })
    const prior = await replayExisting(workspace_id, request_id, fingerprint)
    if (prior) return prior
    const operationId = randomUUID()
    const journal = {
      operation_id: operationId, request_id, request_fingerprint: fingerprint,
      workspace_id, action: "batch", status: "preparing", owner_pid: process.pid,
      created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
      step_count: operations.length, completed_steps: [], rollback_errors: [],
    }
    await storeOperation(journal)
    const completed = []
    try {
      const results = []
      for (let index = 0; index < operations.length; index++) {
        const step = operations[index]
        const action = step.action === "copy" ? "copy" : step.action === "move" ? "move" : step.action === "rename" ? "rename" : step.action === "delete" ? "delete" : null
        if (!action) throw new Error(`第 ${index + 1} 项操作类型无效`)
        const input = { ...step, request_id: randomUUID() }
        const result = await performOperation(action, input, { workspaceId: workspace_id, parentOperationId: operationId })
        results.push(result)
        await updateOperation(operationId, { status: "committing", completed_steps: [...results] })
        if (result.status !== "committed") throw Object.assign(new Error(result.error ?? `第 ${index + 1} 项操作未提交`), { fileOpsStepResults: results })
        completed.push({ action, step, result })
      }
      const result = { operation_id: operationId, status: "committed", atomic: false, step_count: results.length, results, message: "批量文件事务已按序提交；每项均有独立 durable journal，不承诺多文件物理原子性。" }
      await updateOperation(operationId, { status: "committed", result })
      await audit("file_batch", { workspaceId: workspace_id, operationId, status: "committed", stepCount: results.length })
      await invalidateWorkspaceLsp(workspace_id).catch(() => {})
      return result
    } catch (error) {
      const rollbackErrors = []
      const steps = error.fileOpsStepResults ?? completed
      for (const item of [...steps].reverse()) {
        if (item.status && item.status !== "committed") continue
        const operation = item.step ? item : completed.find((entry) => entry.result === item)
        if (!operation) continue
        try {
          await assertCurrentGrant(workspace_id, true)
          if (operation.action === "delete") {
            await restoreRecoveryRecord(workspace, (await readArray("fileRecovery")).find((entry) => entry.recovery_id === operation.result.recovery_id), workspace_id, operationId)
          } else if (operation.action === "move" || operation.action === "rename") {
            const recovery = (await readArray("fileRecovery")).find((entry) => entry.recovery_id === operation.result.recovery_id)
            if (operation.result.case_only) await removeBatchDestination(workspace, operation.result, rollbackErrors)
            await restoreRecoveryRecord(workspace, recovery, workspace_id, operationId)
            if (!operation.result.case_only) await removeBatchDestination(workspace, operation.result, rollbackErrors)
          } else if (operation.action === "copy") {
            await removeBatchDestination(workspace, operation.result, rollbackErrors)
          }
        } catch (rollbackError) { rollbackErrors.push({ path: item.result?.source_path ?? "", error: String(rollbackError?.message ?? "批量补偿失败").slice(0, 240) }) }
      }
      const message = String(error?.message ?? "批量文件事务失败").replace(/[\r\n\0]+/g, " ").slice(0, 400)
      const status = rollbackErrors.length ? "recovery_required" : "rolled_back"
      const result = { operation_id: operationId, status, atomic: false, completed_steps: completed.map((item) => item.result), rollback_errors: rollbackErrors, error: message }
      await updateOperation(operationId, { status, error: message, rollback_errors: rollbackErrors, result })
      await audit("file_batch", { workspaceId: workspace_id, operationId, status, error: message })
      await invalidateWorkspaceLsp(workspace_id).catch(() => {})
      return result
    }
  })
}

function isProcessRunning(pid) {
  if (!Number.isInteger(pid) || pid < 1) return false
  try { process.kill(pid, 0); return true } catch (error) { return error?.code === "EPERM" }
}

export async function recoverInterruptedFileOperations() {
  const records = await readArray("fileOperations")
  const interrupted = records.filter((item) => TRANSIENT_STATES.has(item.status) && item.owner_pid !== process.pid && !isProcessRunning(item.owner_pid))
  if (!interrupted.length) return { marked: 0 }
  await mutateArray("fileOperations", async (items) => {
    for (const item of items) {
      if (interrupted.some((entry) => entry.operation_id === item.operation_id)) {
        item.status = "recovery_required"
        item.error = "服务在事务提交期间退出；请通过 list_recovery_items 检查并恢复。"
        item.updated_at = new Date().toISOString()
      }
    }
  })
  return { marked: interrupted.length }
}
