import { createHash, randomUUID } from "node:crypto"
import { applyPatch, createTwoFilesPatch, parsePatch } from "diff"
import { audit } from "./audit.mjs"
import { mutateArray, readArray } from "./state.mjs"
import { fileInfo, fileExists, readFileBytes, writeExistingFile, createNewFile, createDirectory } from "./safe-fs.mjs"
import { hasBlockedExplicitDirectory, isSensitivePath, normalizeRelative } from "./paths.mjs"
import { rejectManagedStatePath, requireWorkspace, getWorkspace } from "./workspaces.mjs"

const MAX_CHANGE_BYTES = 1_048_576
const MAX_BATCH_BYTES = 4 * MAX_CHANGE_BYTES

function sha256(buffer) {
  return createHash("sha256").update(buffer).digest("hex")
}

function safeView(change) {
  const { originalBase64, proposedBase64, ...view } = change
  return view
}

async function getText(workspace, relative) {
  if (hasBlockedExplicitDirectory(relative)) throw new Error("拒绝访问受保护的内部或生成目录")
  rejectManagedStatePath(workspace, relative)
  const info = await fileInfo(workspace.root, relative)
  if (info.isDirectory) throw new Error("目标路径是目录")
  if (info.size > MAX_CHANGE_BYTES) throw new Error("修改工具只接受不超过 1 MiB 的文本文件")
  const bytes = await readFileBytes(workspace.root, relative, MAX_CHANGE_BYTES)
  if (bytes.includes(0)) throw new Error("不支持修改二进制文件")
  return { bytes, text: bytes.toString("utf8"), hash: sha256(bytes) }
}

export async function stageFileWrite({ workspace_id, path, content, expected_sha256, create = false }) {
  const workspace = await requireWorkspace(workspace_id, { writable: true })
  const relative = normalizeRelative(path)
  if (isSensitivePath(relative)) throw new Error("拒绝修改受保护的敏感文件")
  if (hasBlockedExplicitDirectory(relative)) throw new Error("拒绝修改受保护的内部或生成目录")
  rejectManagedStatePath(workspace, relative)
  if (typeof content !== "string" || Buffer.byteLength(content, "utf8") > MAX_CHANGE_BYTES) throw new Error("新文件内容上限为 1 MiB")
  let original = Buffer.alloc(0)
  let oldText = ""
  let oldHash = null

  if (create) {
    if (expected_sha256) throw new Error("新建文件不接受旧版本哈希")
    if (await fileExists(workspace.root, relative)) throw new Error("目标文件已经存在；不能通过新建操作覆盖它")
    const parentPath = relative.includes("/") ? relative.slice(0, relative.lastIndexOf("/")) : ""
    const parent = await fileInfo(workspace.root, parentPath)
    if (!parent.isDirectory) throw new Error("新文件的父目录不存在或不是目录")
  } else {
    if (!/^[a-f0-9]{64}$/i.test(expected_sha256 ?? "")) throw new Error("修改已存在文件时必须提供 read_file 返回的 sha256")
    const current = await getText(workspace, relative)
    if (current.hash.toLowerCase() !== expected_sha256.toLowerCase()) throw new Error("文件版本已变化，请重新读取后再生成修改")
    original = current.bytes
    oldText = current.text
    oldHash = current.hash
  }

  const proposed = Buffer.from(content, "utf8")
  const id = randomUUID()
  const diff = createTwoFilesPatch(relative, relative, oldText, content, "current", "proposed", { context: 3 })
  const change = {
    id,
    workspaceId: workspace.id,
    path: relative,
    create,
    expectedHash: oldHash,
    proposedHash: sha256(proposed),
    originalBase64: original.toString("base64"),
    proposedBase64: proposed.toString("base64"),
    diff: diff.slice(0, 120_000),
    status: "pending_approval",
    createdAt: new Date().toISOString(),
    approvedAt: null,
    appliedAt: null,
  }
  await mutateArray("changes", (changes) => { changes.push(change) })
  await audit("change_staged", { workspaceId: workspace.id, path: relative, itemId: id, result: "pending_approval" })
  return { change_id: id, path: relative, sha256_before: oldHash, sha256_after: change.proposedHash, diff: change.diff, status: change.status, requires_local_approval: true }
}

export async function stageReplace({ workspace_id, path, find, replace, expected_sha256 }) {
  if (typeof find !== "string" || !find || find.length > 100_000) throw new Error("find 参数不能为空且不能超过 100000 个字符")
  const workspace = await requireWorkspace(workspace_id, { writable: true })
  const relative = normalizeRelative(path)
  if (isSensitivePath(relative)) throw new Error("拒绝修改受保护的敏感文件")
  const current = await getText(workspace, relative)
  if (current.hash.toLowerCase() !== String(expected_sha256 ?? "").toLowerCase()) throw new Error("文件版本已变化，请重新读取后再生成修改")
  const first = current.text.indexOf(find)
  if (first < 0) throw new Error("没有找到要替换的原文，文件未改变")
  if (current.text.indexOf(find, first + find.length) >= 0) throw new Error("原文出现多次，请提供更精确的替换片段")
  const content = current.text.slice(0, first) + String(replace ?? "") + current.text.slice(first + find.length)
  return stageFileWrite({ workspace_id, path: relative, content, expected_sha256: current.hash })
}

export async function stageUnifiedPatch({ workspace_id, unified_patch, expected_hashes }) {
  if (typeof unified_patch !== "string" || !unified_patch.trim() || Buffer.byteLength(unified_patch, "utf8") > MAX_CHANGE_BYTES) {
    throw new Error("Unified Diff 必须为 1 字节到 1 MiB")
  }
  if (!Array.isArray(expected_hashes) || expected_hashes.length < 1 || expected_hashes.length > 20) throw new Error("批量补丁需要 1 到 20 个文件版本哈希")
  const workspace = await requireWorkspace(workspace_id, { writable: true })
  let patches
  try { patches = parsePatch(unified_patch) } catch { throw new Error("Unified Diff 格式无效") }
  if (patches.length < 1 || patches.length > 20) throw new Error("单次补丁最多处理 20 个文件")

  const expected = new Map()
  for (const item of expected_hashes) {
    const relative = normalizeRelative(item?.path)
    if (!/^[a-f0-9]{64}$/i.test(item?.sha256 ?? "") || expected.has(relative)) throw new Error("文件版本哈希无效或路径重复")
    expected.set(relative, item.sha256.toLowerCase())
  }

  const plans = []
  const seen = new Set()
  let proposedBytes = 0
  for (const patch of patches) {
    const oldPath = patchPath(patch.oldFileName, "a")
    const newPath = patchPath(patch.newFileName, "b")
    if (oldPath !== newPath) throw new Error("批量补丁不能创建、删除或重命名文件；请使用单独的文件工具")
    if (seen.has(oldPath)) throw new Error(`补丁重复修改同一路径：${oldPath}`)
    seen.add(oldPath)
    if (isSensitivePath(oldPath)) throw new Error(`拒绝修改受保护的敏感文件：${oldPath}`)
    if (hasBlockedExplicitDirectory(oldPath)) throw new Error("拒绝修改受保护的内部或生成目录")
    rejectManagedStatePath(workspace, oldPath)
    const expectedHash = expected.get(oldPath)
    if (!expectedHash) throw new Error(`缺少 ${oldPath} 的 read_file SHA-256`)
    const current = await getText(workspace, oldPath)
    if (current.hash.toLowerCase() !== expectedHash) throw new Error(`${oldPath} 已变化，请重新读取后生成补丁`)
    const proposedText = applyPatch(current.text, patch)
    if (proposedText === false) throw new Error(`补丁无法精确应用到 ${oldPath}`)
    if (proposedText === current.text) throw new Error(`补丁没有修改 ${oldPath}`)
    proposedBytes += Buffer.byteLength(proposedText, "utf8")
    if (proposedBytes > MAX_BATCH_BYTES) throw new Error("批量补丁的总新内容超过 4 MiB 上限")
    plans.push({ path: oldPath, current, proposedText })
  }
  if (seen.size !== expected.size || [...expected.keys()].some((relative) => !seen.has(relative))) throw new Error("版本哈希列表必须与补丁中的文件路径完全一致")

  const batchId = randomUUID()
  const timestamp = new Date().toISOString()
  const staged = plans.map(({ path: relative, current, proposedText }) => {
    const proposed = Buffer.from(proposedText, "utf8")
    const id = randomUUID()
    return {
      id,
      workspaceId: workspace.id,
      batchId,
      path: relative,
      create: false,
      expectedHash: current.hash,
      proposedHash: sha256(proposed),
      originalBase64: current.bytes.toString("base64"),
      proposedBase64: proposed.toString("base64"),
      diff: createTwoFilesPatch(relative, relative, current.text, proposedText, "current", "proposed", { context: 3 }).slice(0, 120_000),
      status: "pending_approval",
      createdAt: timestamp,
      approvedAt: null,
      appliedAt: null,
    }
  })
  await mutateArray("changes", (changes) => { changes.push(...staged) })
  for (const item of staged) await audit("change_staged", { workspaceId: workspace.id, path: item.path, itemId: item.id, result: "pending_approval" })
  return {
    batch_id: batchId,
    status: "pending_approval",
    per_file_approval: true,
    changes: staged.map(({ id, path: relative, expectedHash, proposedHash, diff }) => ({ change_id: id, path: relative, sha256_before: expectedHash, sha256_after: proposedHash, diff, status: "pending_approval" })),
  }
}

function patchPath(input, expectedPrefix) {
  if (typeof input !== "string" || input === "/dev/null") throw new Error("补丁不支持文件创建或删除")
  const candidate = input.replace(/\\/g, "/")
  const relative = candidate.startsWith(`${expectedPrefix}/`) ? candidate.slice(expectedPrefix.length + 1) : candidate
  return normalizeRelative(relative)
}

export async function stageDirectoryCreate({ workspace_id, path }) {
  const workspace = await requireWorkspace(workspace_id, { writable: true })
  const relative = normalizeRelative(path)
  if (isSensitivePath(relative)) throw new Error("拒绝在受保护的敏感路径创建目录")
  if (hasBlockedExplicitDirectory(relative)) throw new Error("拒绝在受保护的内部或生成目录创建新目录")
  rejectManagedStatePath(workspace, relative)
  if (await fileExists(workspace.root, relative)) throw new Error("目标路径已经存在")
  const parentPath = relative.includes("/") ? relative.slice(0, relative.lastIndexOf("/")) : ""
  const parent = await fileInfo(workspace.root, parentPath)
  if (!parent.isDirectory) throw new Error("新目录的父目录不存在或不是目录")
  const id = randomUUID()
  const change = {
    id, workspaceId: workspace.id, path: relative, create: false, createDirectory: true,
    expectedHash: null, proposedHash: null, originalBase64: "", proposedBase64: "",
    diff: `*** New directory: ${relative}\n`, status: "pending_approval",
    createdAt: new Date().toISOString(), approvedAt: null, appliedAt: null,
  }
  await mutateArray("changes", (changes) => { changes.push(change) })
  await audit("directory_create_staged", { workspaceId: workspace.id, path: relative, itemId: id, result: "pending_approval" })
  return { change_id: id, path: relative, status: change.status, diff: change.diff, requires_local_approval: true }
}

export async function listChanges() {
  return (await readArray("changes")).map(safeView)
}

export async function getChange(id) {
  const change = (await readArray("changes")).find((item) => item.id === id)
  if (!change) throw new Error("找不到待处理的变更")
  return change
}

export async function approveChange(id) {
  const change = await mutateArray("changes", async (changes) => {
    const item = changes.find((entry) => entry.id === id)
    if (!item) throw new Error("找不到待处理的变更")
    if (item.status !== "pending_approval") throw new Error("此变更当前不能审批")
    await requireWorkspace(item.workspaceId, { writable: true })
    item.status = "approved"
    item.approvedAt = new Date().toISOString()
    return { ...item }
  })
  await audit("change_approved", { workspaceId: change.workspaceId, path: change.path, itemId: id, result: "approved" })
  return safeView(change)
}

export async function applyChange(id) {
  const change = await mutateArray("changes", async (changes) => {
    const item = changes.find((entry) => entry.id === id)
    if (!item) throw new Error("找不到待处理的变更")
    if (item.status !== "approved") throw new Error("变更尚未由本机用户批准")
    await requireWorkspace(item.workspaceId, { writable: true })
    item.status = "applying"
    return { ...item }
  })
  const workspace = await requireWorkspace(change.workspaceId, { writable: true })

  try {
    const proposed = Buffer.from(change.proposedBase64, "base64")
    const result = change.createDirectory
      ? await createDirectory(workspace.root, change.path)
      : change.create
        ? await createNewFile(workspace.root, change.path, proposed)
        : await writeExistingFile(workspace.root, change.path, change.expectedHash, proposed)
    if (!change.createDirectory && result.sha256.toLowerCase() !== change.proposedHash.toLowerCase()) throw new Error("写入后校验哈希不匹配")
    await mutateArray("changes", (changes) => {
      const item = changes.find((entry) => entry.id === id)
      if (!item || item.status !== "applying") throw new Error("变更状态在应用期间发生变化")
      item.status = "applied"
      item.appliedAt = new Date().toISOString()
      item.appliedHash = result.sha256 ?? null
    })
    await audit("change_applied", { workspaceId: workspace.id, path: change.path, itemId: id, result: "applied" })
    return { change_id: id, path: change.path, sha256: result.sha256 ?? null, status: "applied" }
  } catch (error) {
    await mutateArray("changes", (changes) => {
      const item = changes.find((entry) => entry.id === id)
      if (item) {
        item.status = "failed"
        item.failure = String(error instanceof Error ? error.message : "写入失败").slice(0, 300)
      }
    })
    await audit("change_failed", { workspaceId: workspace.id, path: change.path, itemId: id, result: "failed" })
    throw error
  }
}

export async function recoverChange(id) {
  const change = await mutateArray("changes", (changes) => {
    const item = changes.find((entry) => entry.id === id)
    if (!item) throw new Error("找不到要恢复的变更")
    if (!new Set(["applied", "failed", "recovery_required"]).has(item.status)) throw new Error("此变更当前不能恢复")
    if (item.create || item.createDirectory) throw new Error("新建文件或目录不能自动恢复；请在项目中手动检查")
    item.status = "recovering"
    return { ...item }
  })
  try {
    const workspace = await requireWorkspace(change.workspaceId, { writable: true })
    const current = await getText(workspace, change.path)
    if (current.hash === change.expectedHash) {
      // The original contents are already present, so no filesystem write is needed.
    } else if (current.hash === change.proposedHash) {
      await writeExistingFile(workspace.root, change.path, current.hash, Buffer.from(change.originalBase64, "base64"))
    } else {
      throw new Error("文件已同时偏离原始版本和 ChatCode 变更版本；为保留用户改动，未覆盖文件")
    }
    await mutateArray("changes", (changes) => {
      const item = changes.find((entry) => entry.id === id)
      if (!item || item.status !== "recovering") throw new Error("恢复期间变更状态发生变化")
      item.status = "reverted"
      item.recoveredAt = new Date().toISOString()
      item.failure = null
    })
    await audit("change_recovered", { workspaceId: change.workspaceId, path: change.path, itemId: id, result: "reverted" })
    return { change_id: id, path: change.path, status: "reverted" }
  } catch (error) {
    await mutateArray("changes", (changes) => {
      const item = changes.find((entry) => entry.id === id)
      if (item?.status === "recovering") {
        item.status = "recovery_required"
        item.failure = String(error instanceof Error ? error.message : "恢复失败").slice(0, 300)
      }
    })
    await audit("change_recovery_failed", { workspaceId: change.workspaceId, path: change.path, itemId: id, result: "recovery_required" })
    throw error
  }
}

export async function recoverInterruptedChanges() {
  const current = await readArray("changes")
  for (const change of current.filter((item) => ["applying", "recovering"].includes(item.status))) {
    let status = "recovery_required"
    try {
      const workspace = await getWorkspace(change.workspaceId)
      if (change.status === "recovering") {
        const file = await getText(workspace, change.path)
        if (file.hash === change.expectedHash) status = "reverted"
      } else if (change.createDirectory) {
        const present = await fileExists(workspace.root, change.path)
        if (present && (await fileInfo(workspace.root, change.path)).isDirectory) status = "applied"
        else if (!present) status = "approved"
      } else if (change.create) {
        const present = await fileExists(workspace.root, change.path)
        if (!present) status = "approved"
        else if ((await getText(workspace, change.path)).hash === change.proposedHash) status = "applied"
      } else {
        const file = await getText(workspace, change.path)
        if (file.hash === change.proposedHash) status = "applied"
        else if (file.hash === change.expectedHash) status = "approved"
      }
    } catch { /* missing or blocked file requires local recovery */ }
    await mutateArray("changes", (changes) => {
      const item = changes.find((entry) => entry.id === change.id)
      if (item?.status === "applying") {
        item.status = status
        item.recoveredAt = new Date().toISOString()
      }
    })
  }
}
