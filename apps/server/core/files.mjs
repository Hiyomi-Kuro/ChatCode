import { createHash } from "node:crypto"
import { hasBlockedExplicitDirectory, normalizeRelative, shouldSkipDirectory } from "./paths.mjs"
import { fileInfo, hashFile, listDirectory, readFileBytes, readFileChunk } from "./safe-fs.mjs"
import { isManagedStatePath, isSensitiveAllowed, rejectManagedStatePath, requireWorkspace } from "./workspaces.mjs"
import { boundedRegexMatches } from "./regex.mjs"

const MAX_TEXT_BYTES = 1_048_576
const MAX_SEARCH_BYTES = 16 * 1024 * 1024

function asRelative(parent, name) {
  return parent ? `${parent}/${name}` : name
}

function hash(buffer) {
  return createHash("sha256").update(buffer).digest("hex")
}

function textFrom(buffer) {
  if (buffer.includes(0)) throw new Error("拒绝读取包含 NUL 字节的二进制文件")
  return buffer.toString("utf8")
}

async function* walkFiles(workspace, startPath = "", maxDepth = Number.POSITIVE_INFINITY) {
  const pending = [{ path: normalizeRelative(startPath, { allowRoot: true }), depth: 0 }]
  while (pending.length) {
    const current = pending.pop()
    let cursor = ""
    do {
      const listing = await listDirectory(workspace.root, current.path, { limit: 500, cursor })
      for (const entry of [...listing.entries].reverse()) {
        if (entry.blocked) continue
        const relative = asRelative(current.path, entry.name)
        if ((!isSensitiveAllowed(workspace, relative)) || hasBlockedExplicitDirectory(relative) || isManagedStatePath(workspace, relative)) continue
        if (entry.isDirectory) {
          if (current.depth < maxDepth && !shouldSkipDirectory(entry.name)) pending.push({ path: relative, depth: current.depth + 1 })
        } else {
          yield { path: relative, ...entry }
        }
      }
      cursor = listing.nextCursor ?? ""
    } while (cursor)
  }
}

export async function listFiles({ workspace_id, path = "", offset = 0, limit = 200, cursor }) {
  const workspace = await requireWorkspace(workspace_id)
  const relative = normalizeRelative(path, { allowRoot: true })
  if (relative && !isSensitiveAllowed(workspace, relative)) throw new Error("该路径属于受保护的敏感目录；请在本机管理页单独授权")
  if (relative && hasBlockedExplicitDirectory(relative)) throw new Error("拒绝访问受保护的内部或生成目录")
  if (relative) rejectManagedStatePath(workspace, relative)
  const page = await listDirectory(workspace.root, relative, { offset, limit, ...(cursor !== undefined ? { cursor } : {}) })
  const entries = page.entries.filter((entry) => {
    const child = asRelative(relative, entry.name)
    return !entry.blocked && isSensitiveAllowed(workspace, child) && !hasBlockedExplicitDirectory(child) && !isManagedStatePath(workspace, child) && !(entry.isDirectory && shouldSkipDirectory(entry.name))
  })
  return {
    workspace_id, path: relative, entries, offset: page.offset ?? null, total: page.total,
    next_offset: page.nextOffset ?? null, next_cursor: page.nextCursor ?? null,
    has_more: page.hasMore ?? page.nextOffset !== null,
  }
}

export async function statFile({ workspace_id, path, include_sha256 = false }) {
  const workspace = await requireWorkspace(workspace_id)
  const relative = normalizeRelative(path)
  if (!isSensitiveAllowed(workspace, relative)) throw new Error("拒绝读取受保护的敏感文件元数据；请在本机管理页单独授权")
  if (hasBlockedExplicitDirectory(relative)) throw new Error("拒绝访问受保护的内部或生成目录")
  rejectManagedStatePath(workspace, relative)
  const info = await fileInfo(workspace.root, relative)
  const digest = include_sha256 && !info.isDirectory ? await hashFile(workspace.root, relative) : null
  if (digest && digest.version !== info.version) throw new Error("读取文件哈希期间文件已变化；请重试")
  return {
    workspace_id, path: relative, type: info.isDirectory ? "directory" : "file",
    size: info.size, size_bytes: info.sizeBytes ?? String(info.size), modified: info.modified,
    version: info.version, sha256: digest?.sha256 ?? null,
  }
}

export async function readFileChunkRange({ workspace_id, path, offset_bytes, length_bytes = 262_144, expected_version }) {
  const workspace = await requireWorkspace(workspace_id)
  const relative = normalizeRelative(path)
  if (!isSensitiveAllowed(workspace, relative)) throw new Error("拒绝读取受保护的敏感文件；请在本机管理页单独授权")
  if (hasBlockedExplicitDirectory(relative)) throw new Error("拒绝访问受保护的内部或生成目录")
  rejectManagedStatePath(workspace, relative)
  const offset = BigInt(offset_bytes)
  if (offset < 0n || offset > 9_223_372_036_854_775_807n) throw new Error("字节 offset 超出 64 位范围")
  if (!Number.isInteger(length_bytes) || length_bytes < 1 || length_bytes > 262_144) throw new Error("单次读取长度必须为 1 到 262144 字节")
  const chunk = await readFileChunk(workspace.root, relative, offset, length_bytes)
  if (expected_version && expected_version !== chunk.version) throw new Error("文件版本已变化；请从 offset 0 重新读取")
  return {
    workspace_id, path: relative, offset_bytes: offset.toString(),
    data_base64: chunk.data, bytes_read: chunk.bytesRead,
    size_bytes: chunk.sizeBytes, next_offset: chunk.nextOffset,
    eof: chunk.eof, version: chunk.version, modified: chunk.modified,
  }
}

export async function readFile({ workspace_id, path, start_line = 1, line_count = 250 }) {
  const workspace = await requireWorkspace(workspace_id)
  const relative = normalizeRelative(path)
  if (!isSensitiveAllowed(workspace, relative)) throw new Error("拒绝读取受保护的敏感文件；请在本机管理页单独授权")
  if (hasBlockedExplicitDirectory(relative)) throw new Error("拒绝访问受保护的内部或生成目录")
  rejectManagedStatePath(workspace, relative)
  const info = await fileInfo(workspace.root, relative)
  if (info.isDirectory) throw new Error("目标是目录，不是文本文件")
  const previewBytes = []
  let offset = 0n
  while (offset < BigInt(info.sizeBytes ?? info.size) && offset < BigInt(MAX_TEXT_BYTES)) {
    const count = Number(BigInt(MAX_TEXT_BYTES) - offset > 262_144n ? 262_144n : BigInt(MAX_TEXT_BYTES) - offset)
    const chunk = await readFileChunk(workspace.root, relative, offset, count)
    if (chunk.version !== info.version) throw new Error("文件版本在读取预览期间发生变化；请重试")
    previewBytes.push(Buffer.from(chunk.data, "base64"))
    offset = BigInt(chunk.nextOffset)
    if (!chunk.bytesRead) break
  }
  const bytes = Buffer.concat(previewBytes)
  const truncatedFile = BigInt(info.sizeBytes ?? info.size) > BigInt(bytes.length)
  const text = textFrom(bytes)
  const lines = text.split(/\r\n|\n|\r/)
  const start = Math.max(1, Math.trunc(start_line))
  const count = Math.max(1, Math.min(1_000, Math.trunc(line_count)))
  const selected = lines.slice(start - 1, start - 1 + count).join("\n")
  const content = selected.slice(0, 32_000)
  const digest = await hashFile(workspace.root, relative)
  if (digest.version !== info.version) throw new Error("文件版本在读取期间发生变化；请重试")
  return {
    workspace_id,
    path: relative,
    sha256: digest.sha256,
    size: Number(info.sizeBytes ?? info.size),
    total_lines: truncatedFile ? null : lines.length,
    lines_scanned: lines.length,
    start_line: start,
    content,
    truncated: truncatedFile || selected.length > content.length || start - 1 + count < lines.length,
  }
}

export async function searchFiles({ workspace_id, query, path = "", max_results = 100, cursor = "" }) {
  if (typeof query !== "string" || !query.trim() || query.length > 200) throw new Error("文件名查询长度必须为 1 到 200 个字符")
  const workspace = await requireWorkspace(workspace_id)
  const startPath = normalizeRelative(path, { allowRoot: true })
  if (startPath && !isSensitiveAllowed(workspace, startPath)) throw new Error("不能在受保护的敏感目录内搜索")
  if (startPath && hasBlockedExplicitDirectory(startPath)) throw new Error("不能在受保护的内部或生成目录内搜索")
  if (startPath) rejectManagedStatePath(workspace, startPath)
  const cap = Math.max(1, Math.min(200, Math.trunc(max_results)))
  const needle = query.toLocaleLowerCase()
  const matches = []
  let cursorFound = !cursor
  let lastScannedPath = null
  let stoppedAtResultLimit = false
  for await (const file of walkFiles(workspace, startPath)) {
    if (!cursorFound) {
      if (file.path === cursor) cursorFound = true
      continue
    }
    lastScannedPath = file.path
    if (file.name.toLocaleLowerCase().includes(needle)) {
      matches.push({ path: file.path, size: file.size, modified: file.modified })
      if (matches.length >= cap) { stoppedAtResultLimit = true; break }
    }
  }
  if (!cursorFound) throw new Error("文件搜索游标已失效；请从头开始搜索")
  return { workspace_id, query, matches, truncated: stoppedAtResultLimit, next_cursor: stoppedAtResultLimit ? lastScannedPath : null }
}

export async function searchText({ workspace_id, query, path = "", case_sensitive = false, max_results = 100, regex = false, cursor = "" }) {
  if (typeof query !== "string" || !query || query.length > 160) throw new Error("搜索文字长度必须为 1 到 160 个字符")
  const workspace = await requireWorkspace(workspace_id)
  const startPath = normalizeRelative(path, { allowRoot: true })
  if (startPath && !isSensitiveAllowed(workspace, startPath)) throw new Error("不能在受保护的敏感目录内搜索")
  if (startPath && hasBlockedExplicitDirectory(startPath)) throw new Error("不能在受保护的内部或生成目录内搜索")
  if (startPath) rejectManagedStatePath(workspace, startPath)
  const cap = Math.max(1, Math.min(200, Math.trunc(max_results)))
  let scannedBytes = 0
  const matches = []
  const cursorState = cursor ? decodeTextCursor(cursor) : null
  let cursorFound = !cursorState
  let lastScannedPath = null
  let stoppedAtLimit = false
  let budgetHit = false
  let nextCursor = null
  for await (const file of walkFiles(workspace, startPath)) {
    if (!cursorFound) {
      if (file.path !== cursorState.path) continue
      cursorFound = true
      // A line 0 cursor means the file could not be scanned within this call's
      // byte budget; skip it on resume so later paths remain reachable. A
      // positive line cursor resumes inside the same file.
      if (cursorState.line === 0) continue
    }
    if (scannedBytes + file.size > MAX_SEARCH_BYTES) {
      budgetHit = true
      nextCursor = encodeTextCursor({ path: file.path, line: 0 })
      break
    }
    lastScannedPath = file.path
    if (file.size > MAX_TEXT_BYTES) continue
    scannedBytes += file.size
    const bytes = await readFileBytes(workspace.root, file.path, MAX_TEXT_BYTES)
    if (bytes.includes(0)) continue
    const text = textFrom(bytes)
    const lines = text.split(/\r\n|\n|\r/)
    const firstLine = cursorState?.path === file.path ? cursorState.line + 1 : 1
    if (firstLine > lines.length) continue
    const searchableText = lines.slice(firstLine - 1).join("\n")
    let found
    if (regex) {
      found = (await boundedRegexMatches(query, searchableText, { caseSensitive: case_sensitive, maxMatches: cap - matches.length }))
        .map((result) => ({ ...result, line: result.line + firstLine - 1 }))
    } else {
      const needle = case_sensitive ? query : query.toLocaleLowerCase()
      found = []
      for (let index = firstLine - 1; index < lines.length && found.length < cap - matches.length; index++) {
        const line = case_sensitive ? lines[index] : lines[index].toLocaleLowerCase()
        if (line.includes(needle)) found.push({ line: index + 1, text: lines[index].slice(0, 300) })
      }
    }
    for (const result of found) {
      matches.push({ path: file.path, line: result.line, text: result.text })
      if (matches.length >= cap) {
        stoppedAtLimit = true
        nextCursor = encodeTextCursor({ path: file.path, line: result.line })
        break
      }
    }
    if (stoppedAtLimit) break
  }
  if (!cursorFound) throw new Error("文本搜索游标已失效；请从头开始搜索")
  const truncated = stoppedAtLimit || budgetHit
  if (budgetHit && lastScannedPath) nextCursor = encodeTextCursor({ path: lastScannedPath, line: 0 })
  return { workspace_id, query, regex, scanned_bytes: scannedBytes, matches, truncated, next_cursor: truncated ? nextCursor : null }
}

function encodeTextCursor(value) {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64url")
}

function decodeTextCursor(value) {
  try {
    const decoded = JSON.parse(Buffer.from(value, "base64url").toString("utf8"))
    if (typeof decoded.path === "string" && Number.isSafeInteger(decoded.line) && decoded.line >= 0) return decoded
  } catch { /* invalid cursor */ }
  throw new Error("文本搜索游标无效；请从头开始搜索")
}

export async function projectStructure({ workspace_id, max_depth = 4, max_files = 500 }) {
  const workspace = await requireWorkspace(workspace_id)
  const depth = Math.max(1, Math.trunc(max_depth))
  const cap = Math.max(1, Math.min(500, Math.trunc(max_files)))
  const entries = []
  for await (const file of walkFiles(workspace, "", depth)) {
    entries.push(file.path)
    if (entries.length >= cap) break
  }
  return { workspace_id, files: entries, count: entries.length, truncated: entries.length >= cap }
}
