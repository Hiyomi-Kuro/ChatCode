import { createHash, randomUUID } from "node:crypto"
import { lstat, open, readdir, readFile, rename, rm, writeFile } from "node:fs/promises"
import path from "node:path"
import { createReadStream } from "node:fs"
import { audit } from "./audit.mjs"
import { fileExists, fileInfo, hashFile, writeStagedFile, copyFileToStaging, truncateStagingFile } from "./safe-fs.mjs"
import { hasBlockedExplicitDirectory, normalizeRelative } from "./paths.mjs"
import { getWorkspace, isSensitiveAllowed, rejectManagedStatePath, requireWorkspace } from "./workspaces.mjs"
import { ensureLayout, assertRegularFile, mutateArray } from "./state.mjs"
import { TMP_DIR } from "./config.mjs"

const UPLOAD_DIR = path.join(TMP_DIR, "uploads")
const CHUNK_BYTES = 262_144
const SESSION_TTL_MS = 24 * 60 * 60 * 1000
const MAX_INT64 = 9_223_372_036_854_775_807n
const locks = new Map()

function uploadPaths(id) {
  if (typeof id !== "string" || !/^[a-f0-9-]{36}$/i.test(id)) throw new Error("上传 ID 无效")
  return { data: path.join(UPLOAD_DIR, `${id}.part`), meta: path.join(UPLOAD_DIR, `${id}.json`) }
}

async function ensureUploadArea() {
  await ensureLayout()
  const info = await lstat(UPLOAD_DIR)
  if (!info.isDirectory() || info.isSymbolicLink() || (process.platform === "win32" && (Number(info.attributes ?? 0) & 0x400) !== 0)) {
    throw new Error("上传暂存目录不是普通目录")
  }
}

function serializeSize(value) {
  const result = BigInt(value)
  if (result < 0n || result > MAX_INT64) throw new Error("size_bytes 必须在 0 到 Int64 最大值之间")
  return result.toString()
}

function throughput(bytes, elapsedMs) {
  const rate = BigInt(bytes) * 1000n / BigInt(Math.max(1, Math.trunc(elapsedMs)))
  const maximum = BigInt(Number.MAX_SAFE_INTEGER)
  return Number(rate > maximum ? maximum : rate)
}

async function readMetadata(id) {
  await ensureUploadArea()
  const locations = uploadPaths(id)
  await assertRegularFile(locations.meta)
  const meta = JSON.parse(await readFile(locations.meta, "utf8"))
  if (meta.id !== id) throw new Error("上传元数据 ID 不匹配")
  return meta
}

async function writeMetadata(meta) {
  const locations = uploadPaths(meta.id)
  await assertRegularFile(locations.meta, { allowMissing: true })
  const temporary = `${locations.meta}.${randomUUID()}.tmp`
  await writeFile(temporary, `${JSON.stringify(meta)}\n`, { encoding: "utf8", flag: "wx" })
  try {
    await assertRegularFile(locations.meta, { allowMissing: true })
    await rename(temporary, locations.meta)
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => {})
    throw error
  }
}

function withLock(id, action) {
  const previous = locks.get(id) ?? Promise.resolve()
  const operation = previous.catch(() => {}).then(action)
  locks.set(id, operation)
  return operation.finally(() => { if (locks.get(id) === operation) locks.delete(id) })
}

async function checkUploadWorkspace(meta) {
  const workspace = await requireWorkspace(meta.workspaceId, { writable: true })
  if (!isSensitiveAllowed(workspace, meta.path)) throw new Error("该文件属于受保护的敏感路径；请在本机管理页单独授权")
  if (hasBlockedExplicitDirectory(meta.path)) throw new Error("拒绝访问受保护的内部或生成目录")
  rejectManagedStatePath(workspace, meta.path)
  return workspace
}

async function validateSession(id, { allowCommitted = false } = {}) {
  const meta = await readMetadata(id)
  if (meta.status === "uploading" && Date.now() - Date.parse(meta.updatedAt) > SESSION_TTL_MS) {
    await rm(uploadPaths(id).data, { force: true }).catch(() => {})
    await rm(uploadPaths(id).meta, { force: true }).catch(() => {})
    throw new Error("上传会话已过期；请重新开始")
  }
  if (allowCommitted && meta.status === "committed") return meta
  if (meta.status !== "uploading") throw new Error(`上传当前状态为 ${meta.status}，不能继续写入`)
  await checkUploadWorkspace(meta)
  return meta
}

async function cleanExpiredUploads() {
  await ensureUploadArea()
  for (const name of await readdir(UPLOAD_DIR)) {
    const match = /^([a-f0-9-]{36})\.json$/i.exec(name)
    if (!match) continue
    try {
      const meta = await readMetadata(match[1])
      if (meta.status === "uploading" && Date.now() - Date.parse(meta.updatedAt) > SESSION_TTL_MS) {
        const locations = uploadPaths(meta.id)
        await rm(locations.data, { force: true })
        await rm(locations.meta, { force: true })
      }
    } catch { /* malformed entries are left for local inspection; never follow them */ }
  }
}

export function uploadFilePath(id) {
  return uploadPaths(id).data
}

export async function createStagedBlob(bytes) {
  await ensureUploadArea()
  const id = randomUUID()
  const file = await open(uploadPaths(id).data, "wx")
  try { await file.writeFile(bytes); await file.sync() } finally { await file.close() }
  return id
}

export async function discardUploadFiles(id) {
  const locations = uploadPaths(id)
  await rm(locations.data, { force: true })
  await rm(locations.meta, { force: true })
}

export async function markUploadApplied(id) {
  const meta = await readMetadata(id)
  meta.status = "applied"
  meta.updatedAt = new Date().toISOString()
  await writeMetadata(meta)
  await rm(uploadPaths(id).data, { force: true })
}

export async function beginWrite({ workspace_id, path: inputPath, size_bytes, expected_sha256, idempotency_key }) {
  await cleanExpiredUploads()
  const workspace = await requireWorkspace(workspace_id, { writable: true })
  const relative = normalizeRelative(inputPath)
  if (!isSensitiveAllowed(workspace, relative)) throw new Error("该文件属于受保护的敏感路径；请在本机管理页单独授权")
  if (hasBlockedExplicitDirectory(relative)) throw new Error("拒绝访问受保护的内部或生成目录")
  rejectManagedStatePath(workspace, relative)
  const sizeBytes = serializeSize(size_bytes)
  const key = String(idempotency_key ?? "")
  if (!/^[a-f0-9-]{36}$/i.test(key)) throw new Error("idempotency_key 必须是 UUID")
  const expectedHash = expected_sha256 ? String(expected_sha256).toLowerCase() : null
  if (expectedHash && !/^[a-f0-9]{64}$/.test(expectedHash)) throw new Error("expected_sha256 无效")
  const exists = await fileExists(workspace.root, relative)
  if (exists !== Boolean(expectedHash)) throw new Error(exists ? "覆盖文件必须提供当前 SHA-256" : "目标不存在，不能提供覆盖用 SHA-256")
  if (exists) {
    const info = await fileInfo(workspace.root, relative)
    if (info.isDirectory) throw new Error("目标是目录，不是文件")
    const current = await hashFile(workspace.root, relative)
    if (current.sha256.toLowerCase() !== expectedHash) throw new Error("文件版本已变化，请重新 stat_file 后开始上传")
  }

  for (const name of await readdir(UPLOAD_DIR)) {
    const match = /^([a-f0-9-]{36})\.json$/i.exec(name)
    if (!match) continue
    try {
      const prior = await readMetadata(match[1])
      if (prior.workspaceId === workspace.id && prior.idempotencyKey === key) {
        if (prior.path !== relative || prior.sizeBytes !== sizeBytes || prior.expectedHash !== expectedHash) throw new Error("idempotency_key 已用于不同的上传参数")
        if (prior.status === "uploading") return sessionView(prior, true)
        throw new Error(`该 idempotency_key 已处于 ${prior.status} 状态`)
      }
    } catch (error) {
      if (String(error?.message).includes("idempotency_key")) throw error
    }
  }

  const id = randomUUID()
  const locations = uploadPaths(id)
  const file = await open(locations.data, "wx")
  await file.sync()
  await file.close()
  const now = new Date().toISOString()
  const meta = {
    id, workspaceId: workspace.id, path: relative, sizeBytes,
    expectedHash, idempotencyKey: key, receivedBytes: "0", lastChunk: null,
    status: "uploading", phase: "uploading", transferCompletedAt: sizeBytes === "0" ? now : null,
    createdAt: now, updatedAt: now,
  }
  await writeMetadata(meta)
  await audit("file_upload_started", { workspaceId: workspace.id, path: relative, itemId: id, result: "started" })
  return sessionView(meta, false)
}

function sessionView(meta, resumed) {
  const received = BigInt(meta.receivedBytes)
  const total = BigInt(meta.sizeBytes)
  const now = Date.now()
  const elapsedMs = Math.max(1, now - Date.parse(meta.createdAt))
  const transferEnd = meta.transferCompletedAt ? Date.parse(meta.transferCompletedAt) : now
  const transferElapsedMs = Math.max(1, transferEnd - Date.parse(meta.createdAt))
  return {
    upload_id: meta.id, path: meta.path, status: meta.status, phase: meta.phase ?? "uploading",
    size_bytes: meta.sizeBytes, received_bytes: meta.receivedBytes,
    next_offset: meta.receivedBytes, chunk_bytes: CHUNK_BYTES,
    progress_percent: total === 0n ? 100 : Number((received * 10_000n) / total) / 100,
    elapsed_ms: elapsedMs,
    phase_elapsed_ms: meta.phase === "committing" && meta.commitStartedAt ? Math.max(0, now - Date.parse(meta.commitStartedAt)) : 0,
    bytes_per_second: throughput(received, transferElapsedMs),
    expires_at: new Date(Date.parse(meta.updatedAt) + SESSION_TTL_MS).toISOString(), resumed,
  }
}

export async function writeChunk({ upload_id, offset_bytes, data_base64 }) {
  const id = upload_id
  return withLock(id, async () => {
    const meta = await validateSession(id)
    const offset = BigInt(offset_bytes)
    const data = Buffer.from(data_base64, "base64")
    if (!data.length || data.length > CHUNK_BYTES || data.toString("base64") !== data_base64) throw new Error("每块必须是有效的 Base64，解码后长度为 1 到 262144 字节")
    const digest = createHash("sha256").update(data).digest("hex")
    const received = BigInt(meta.receivedBytes)
    if (meta.lastChunk && offset === BigInt(meta.lastChunk.offsetBytes) && data.length === meta.lastChunk.length && digest === meta.lastChunk.sha256) {
    return { ...sessionView(meta, false), bytes_written: data.length, duplicate: true }
    }
    if (offset !== received) throw new Error(`分块 offset 必须等于当前 next_offset ${meta.receivedBytes}；只接受顺序分块和最近一块的幂等重试`)
    if (received + BigInt(data.length) > BigInt(meta.sizeBytes)) throw new Error("分块超出 begin_write 声明的总字节数")
    const locations = uploadPaths(id)
    await assertRegularFile(locations.data)
    const file = await open(locations.data, "r+")
    let stagedSize
    try {
      stagedSize = (await file.stat({ bigint: true })).size
    } finally { await file.close() }
    if (stagedSize < received) throw new Error("上传暂存文件短于已确认偏移；请 abort 后重试")
    if (stagedSize > received) {
      const truncated = await truncateStagingFile(UPLOAD_DIR, locations.data, received)
      if (truncated.sizeBytes !== received.toString()) throw new Error("上传暂存文件未能精确恢复到已确认的 64 位偏移")
    }
    const append = await open(locations.data, "a")
    try { await append.writeFile(data); await append.sync() } finally { await append.close() }
    meta.receivedBytes = (received + BigInt(data.length)).toString()
    meta.lastChunk = { offsetBytes: offset.toString(), length: data.length, sha256: digest }
    meta.updatedAt = new Date().toISOString()
    meta.phase = "uploading"
    if (meta.receivedBytes === meta.sizeBytes) meta.transferCompletedAt = meta.updatedAt
    await writeMetadata(meta)
    return { ...sessionView(meta, false), bytes_written: data.length, duplicate: false }
  })
}

async function hashUpload(filePath) {
  const hash = createHash("sha256")
  let bytes = 0n
  for await (const chunk of createReadStream(filePath, { highWaterMark: 65_536 })) {
    hash.update(chunk)
    bytes += BigInt(chunk.length)
  }
  return { sha256: hash.digest("hex"), sizeBytes: bytes.toString() }
}

export async function commitWrite({ upload_id }) {
  const id = upload_id
  return withLock(id, async () => {
    let meta = await readMetadata(id)
    if (meta.status === "committed") return meta.result
    meta = await validateSession(id)
    if (BigInt(meta.receivedBytes) !== BigInt(meta.sizeBytes)) throw new Error(`上传尚未完整：收到 ${meta.receivedBytes} / ${meta.sizeBytes} bytes`)
    let workspace = await checkUploadWorkspace(meta)
    meta.phase = "committing"
    meta.commitStartedAt = new Date().toISOString()
    meta.updatedAt = meta.commitStartedAt
    await writeMetadata(meta)
    try {
      const locations = uploadPaths(id)
      await assertRegularFile(locations.data)
      const proposed = await hashUpload(locations.data)
      if (proposed.sizeBytes !== meta.sizeBytes) throw new Error("上传暂存长度与声明不一致")
      if (meta.proposedSha256 && meta.proposedSha256 !== proposed.sha256) throw new Error("上传内容哈希冲突")
      meta.proposedSha256 = proposed.sha256
      workspace = await checkUploadWorkspace(meta)

      let result
      if (workspace.mode === "autoWritable") {
        result = await writeStagedFile(workspace.root, meta.path, meta.expectedHash, UPLOAD_DIR, locations.data)
        meta.status = "committed"
        meta.result = {
          upload_id: id, path: meta.path, status: "applied", requires_local_approval: false,
          sha256_before: meta.expectedHash, sha256_after: result.sha256,
          bytes: result.sizeBytes ?? proposed.sizeBytes, recovery_path: null,
        }
        await audit("file_written_direct", { workspaceId: workspace.id, path: meta.path, itemId: id, result: "uploaded" })
        await rm(locations.data, { force: true })
      } else {
        let backupId = null
        if (meta.expectedHash) {
          backupId = randomUUID()
          await copyFileToStaging(workspace.root, meta.path, meta.expectedHash, UPLOAD_DIR, uploadPaths(backupId).data)
        }
        const changeId = randomUUID()
        const now = new Date().toISOString()
        const change = {
          id: changeId, workspaceId: workspace.id, path: meta.path, create: !meta.expectedHash,
          createDirectory: false, expectedHash: meta.expectedHash, proposedHash: proposed.sha256,
          originalBase64: "", proposedBase64: "", uploadedFileId: id, backupFileId: backupId,
          diff: `*** Raw byte upload\nPath: ${meta.path}\nBefore SHA-256: ${meta.expectedHash ?? "(new file)"}\nAfter SHA-256: ${proposed.sha256}\nBytes: ${proposed.sizeBytes}\n`,
          status: "pending_approval", createdAt: now, approvedAt: null, appliedAt: null,
        }
        await mutateArray("changes", (changes) => { changes.push(change) })
        meta.status = "committed"
        meta.result = {
          upload_id: id, change_id: changeId, path: meta.path, status: "pending_approval",
          requires_local_approval: true, sha256_before: meta.expectedHash, sha256_after: proposed.sha256,
          bytes: proposed.sizeBytes, recovery_path: backupId ? `restore_upload:${backupId}` : "manual_review_if_new_file",
        }
        await audit("file_upload_staged", { workspaceId: workspace.id, path: meta.path, itemId: changeId, result: "pending_approval" })
      }
      const elapsedMs = Math.max(1, Date.now() - Date.parse(meta.createdAt))
      meta.result.elapsed_ms = elapsedMs
      const transferElapsedMs = Math.max(1, Date.parse(meta.transferCompletedAt ?? meta.updatedAt) - Date.parse(meta.createdAt))
      meta.result.bytes_per_second = throughput(meta.sizeBytes, transferElapsedMs)
      meta.phase = "completed"
      meta.updatedAt = new Date().toISOString()
      await writeMetadata(meta)
      return meta.result
    } catch (error) {
      if (meta.status === "uploading") {
        meta.phase = "uploading"
        meta.commitStartedAt = null
        meta.updatedAt = new Date().toISOString()
        await writeMetadata(meta).catch(() => {})
      }
      throw error
    }
  })
}

export async function abortWrite({ upload_id }) {
  const id = upload_id
  return withLock(id, async () => {
    const meta = await readMetadata(id)
    if (meta.status === "aborted") return { upload_id: id, status: "aborted", already_aborted: true }
    if (meta.status === "committed") throw new Error("已提交的上传不能中止；检查对应变更或恢复记录")
    if (meta.status !== "uploading") throw new Error(`上传当前状态为 ${meta.status}，不能中止`)
    const workspace = await getWorkspace(meta.workspaceId).catch(() => null)
    await rm(uploadPaths(id).data, { force: true })
    meta.status = "aborted"
    meta.updatedAt = new Date().toISOString()
    await writeMetadata(meta)
    await audit("file_upload_aborted", { workspaceId: meta.workspaceId, path: meta.path, itemId: id, result: workspace?.status === "active" ? "aborted" : "aborted_after_pause_or_revocation" })
    return { upload_id: id, status: "aborted", already_aborted: false }
  })
}

export async function listUploads() {
  await cleanExpiredUploads()
  const results = []
  for (const name of await readdir(UPLOAD_DIR)) {
    const match = /^([a-f0-9-]{36})\.json$/i.exec(name)
    if (!match) continue
    try {
      const meta = await readMetadata(match[1])
      if (meta.status !== "uploading") continue
      const view = sessionView(meta, false)
      results.push({
        ...view, workspace_id: meta.workspaceId, updated_at: meta.updatedAt,
      })
    } catch { /* malformed upload metadata is omitted from the dashboard */ }
  }
  return { uploads: results.sort((first, second) => first.updated_at.localeCompare(second.updated_at)) }
}

export async function writeFileRaw({ workspace_id, path, data_base64, expected_sha256 }) {
  const bytes = Buffer.from(data_base64, "base64")
  if (bytes.length > CHUNK_BYTES || bytes.toString("base64") !== data_base64) throw new Error("write_file 单次最多传 262144 字节；更大的文件请使用 begin_write/write_chunk/commit_write")
  const session = await beginWrite({
    workspace_id, path, size_bytes: String(bytes.length), expected_sha256,
    idempotency_key: randomUUID(),
  })
  if (bytes.length) await writeChunk({ upload_id: session.upload_id, offset_bytes: "0", data_base64 })
  return commitWrite({ upload_id: session.upload_id })
}
