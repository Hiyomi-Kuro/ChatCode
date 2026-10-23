import { createHash } from "node:crypto"
import { hasBlockedExplicitDirectory, isSensitivePath, normalizeRelative, shouldSkipDirectory } from "./paths.mjs"
import { fileInfo, listDirectory, readFileBytes } from "./safe-fs.mjs"
import { isManagedStatePath, rejectManagedStatePath, requireWorkspace } from "./workspaces.mjs"
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

async function* walkFiles(workspace, startPath = "", maxDepth = 8) {
  const pending = [{ path: normalizeRelative(startPath, { allowRoot: true }), depth: 0 }]
  let visited = 0
  while (pending.length) {
    const current = pending.pop()
    let offset = 0
    do {
      const listing = await listDirectory(workspace.root, current.path, { limit: 500, offset })
      for (const entry of [...listing.entries].reverse()) {
        if (entry.blocked) continue
        const relative = asRelative(current.path, entry.name)
        if (isSensitivePath(relative) || hasBlockedExplicitDirectory(relative) || isManagedStatePath(workspace, relative)) continue
        if (entry.isDirectory) {
          if (current.depth < maxDepth && !shouldSkipDirectory(entry.name)) pending.push({ path: relative, depth: current.depth + 1 })
        } else {
          visited++
          if (visited > 2_000) throw new Error("递归搜索超过 2000 个文件的单次上限，请缩小目录范围")
          yield { path: relative, ...entry }
        }
      }
      offset = listing.nextOffset ?? -1
    } while (offset >= 0)
  }
}

export async function listFiles({ workspace_id, path = "", offset = 0, limit = 200 }) {
  const workspace = await requireWorkspace(workspace_id)
  const relative = normalizeRelative(path, { allowRoot: true })
  if (relative && isSensitivePath(relative)) throw new Error("该路径属于受保护的敏感目录")
  if (relative && hasBlockedExplicitDirectory(relative)) throw new Error("拒绝访问受保护的内部或生成目录")
  if (relative) rejectManagedStatePath(workspace, relative)
  const page = await listDirectory(workspace.root, relative, { offset, limit })
  const entries = page.entries.filter((entry) => {
    const child = asRelative(relative, entry.name)
    return !entry.blocked && !isSensitivePath(child) && !hasBlockedExplicitDirectory(child) && !isManagedStatePath(workspace, child) && !(entry.isDirectory && shouldSkipDirectory(entry.name))
  })
  return { workspace_id, path: relative, entries, offset: page.offset, total: page.total, next_offset: page.nextOffset }
}

export async function statFile({ workspace_id, path }) {
  const workspace = await requireWorkspace(workspace_id)
  const relative = normalizeRelative(path)
  if (isSensitivePath(relative)) throw new Error("拒绝读取受保护的敏感文件元数据")
  if (hasBlockedExplicitDirectory(relative)) throw new Error("拒绝访问受保护的内部或生成目录")
  rejectManagedStatePath(workspace, relative)
  const info = await fileInfo(workspace.root, relative)
  return { workspace_id, path: relative, type: info.isDirectory ? "directory" : "file", size: info.size, modified: info.modified }
}

export async function readFile({ workspace_id, path, start_line = 1, line_count = 250 }) {
  const workspace = await requireWorkspace(workspace_id)
  const relative = normalizeRelative(path)
  if (isSensitivePath(relative)) throw new Error("拒绝读取受保护的敏感文件")
  if (hasBlockedExplicitDirectory(relative)) throw new Error("拒绝访问受保护的内部或生成目录")
  rejectManagedStatePath(workspace, relative)
  const info = await fileInfo(workspace.root, relative)
  if (info.isDirectory) throw new Error("目标是目录，不是文本文件")
  if (info.size > MAX_TEXT_BYTES) throw new Error("单文件读取上限为 1 MiB")
  const bytes = await readFileBytes(workspace.root, relative, MAX_TEXT_BYTES)
  const text = textFrom(bytes)
  const lines = text.split(/\r\n|\n|\r/)
  const start = Math.max(1, Math.trunc(start_line))
  const count = Math.max(1, Math.min(1_000, Math.trunc(line_count)))
  const selected = lines.slice(start - 1, start - 1 + count).join("\n")
  const content = selected.slice(0, 32_000)
  return {
    workspace_id,
    path: relative,
    sha256: hash(bytes),
    size: bytes.length,
    total_lines: lines.length,
    start_line: start,
    content,
    truncated: selected.length > content.length || start - 1 + count < lines.length,
  }
}

export async function searchFiles({ workspace_id, query, path = "", max_results = 100 }) {
  if (typeof query !== "string" || !query.trim() || query.length > 200) throw new Error("文件名查询长度必须为 1 到 200 个字符")
  const workspace = await requireWorkspace(workspace_id)
  const startPath = normalizeRelative(path, { allowRoot: true })
  if (startPath && isSensitivePath(startPath)) throw new Error("不能在受保护的敏感目录内搜索")
  if (startPath && hasBlockedExplicitDirectory(startPath)) throw new Error("不能在受保护的内部或生成目录内搜索")
  if (startPath) rejectManagedStatePath(workspace, startPath)
  const cap = Math.max(1, Math.min(200, Math.trunc(max_results)))
  const needle = query.toLocaleLowerCase()
  const matches = []
  for await (const file of walkFiles(workspace, startPath)) {
    if (file.name.toLocaleLowerCase().includes(needle)) {
      matches.push({ path: file.path, size: file.size, modified: file.modified })
      if (matches.length >= cap) break
    }
  }
  return { workspace_id, query, matches, truncated: matches.length >= cap }
}

export async function searchText({ workspace_id, query, path = "", case_sensitive = false, max_results = 100, regex = false }) {
  if (typeof query !== "string" || !query || query.length > 160) throw new Error("搜索文字长度必须为 1 到 160 个字符")
  const workspace = await requireWorkspace(workspace_id)
  const startPath = normalizeRelative(path, { allowRoot: true })
  if (startPath && isSensitivePath(startPath)) throw new Error("不能在受保护的敏感目录内搜索")
  if (startPath && hasBlockedExplicitDirectory(startPath)) throw new Error("不能在受保护的内部或生成目录内搜索")
  if (startPath) rejectManagedStatePath(workspace, startPath)
  const cap = Math.max(1, Math.min(200, Math.trunc(max_results)))
  let scannedBytes = 0
  const matches = []
  for await (const file of walkFiles(workspace, startPath)) {
    if (file.size > MAX_TEXT_BYTES) continue
    if (scannedBytes + file.size > MAX_SEARCH_BYTES) break
    scannedBytes += file.size
    const bytes = await readFileBytes(workspace.root, file.path, MAX_TEXT_BYTES)
    if (bytes.includes(0)) continue
    const text = textFrom(bytes)
    let found
    if (regex) {
      found = await boundedRegexMatches(query, text, { caseSensitive: case_sensitive, maxMatches: Math.min(20, cap - matches.length) })
    } else {
      const lines = text.split(/\r\n|\n|\r/)
      const needle = case_sensitive ? query : query.toLocaleLowerCase()
      found = []
      for (let index = 0; index < lines.length && found.length < 20; index++) {
        const line = case_sensitive ? lines[index] : lines[index].toLocaleLowerCase()
        if (line.includes(needle)) found.push({ line: index + 1, text: lines[index].slice(0, 300) })
      }
    }
    for (const result of found) {
      matches.push({ path: file.path, line: result.line, text: result.text })
      if (matches.length >= cap) break
    }
    if (matches.length >= cap) break
  }
  return { workspace_id, query, regex, scanned_bytes: scannedBytes, matches, truncated: matches.length >= cap || scannedBytes >= MAX_SEARCH_BYTES }
}

export async function projectStructure({ workspace_id, max_depth = 4, max_files = 500 }) {
  const workspace = await requireWorkspace(workspace_id)
  const depth = Math.max(1, Math.min(8, Math.trunc(max_depth)))
  const cap = Math.max(1, Math.min(500, Math.trunc(max_files)))
  const entries = []
  for await (const file of walkFiles(workspace, "", depth)) {
    entries.push(file.path)
    if (entries.length >= cap) break
  }
  return { workspace_id, files: entries, count: entries.length, truncated: entries.length >= cap }
}
