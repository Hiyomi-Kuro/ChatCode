import { spawn } from "node:child_process"
import { createHmac, createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto"
import { execFile } from "node:child_process"
import { createReadStream } from "node:fs"
import { lstat, mkdir, open, realpath, rm, stat } from "node:fs/promises"
import path from "node:path"
import { promisify } from "node:util"
import { hasBlockedExplicitDirectory, normalizeRelative, shouldSkipDirectory } from "./paths.mjs"
import { fileInfo, listDirectory } from "./safe-fs.mjs"
import { TMP_DIR } from "./config.mjs"
import { isSensitivePath } from "./paths.mjs"
import { requireWorkspace } from "./workspaces.mjs"

const execFileAsync = promisify(execFile)
const MAX_LISTED_FILES = 50_000
const MAX_MATCHES = 20_000
const MAX_RESULT_BYTES = 64 * 1024 * 1024
const MAX_OUTPUT_BYTES = 128 * 1024 * 1024
const MAX_QUERY_MS = 60_000
const CACHE_TTL_MS = 15 * 60_000
const cursorKey = randomBytes(32)
const searches = new Map()
const active = new Map()
let binaryPromise

function sha256(value) { return createHash("sha256").update(value).digest("hex") }
function clean(value, max = 1200) { return String(value ?? "").replace(/[\r\n\0]+/g, " ").slice(0, max) }
function bytesValue(value) {
  if (typeof value?.text === "string") return value.text
  if (typeof value?.bytes === "string") return Buffer.from(value.bytes, "base64").toString("utf8")
  return ""
}

async function findBinary() {
  if (binaryPromise) return binaryPromise
  binaryPromise = (async () => {
    const candidates = []
    if (process.env.CHATCODE_RG_PATH) candidates.push(path.resolve(process.env.CHATCODE_RG_PATH))
    for (const item of String(process.env.PATH ?? "").split(path.delimiter)) {
      if (item) candidates.push(path.join(item, process.platform === "win32" ? "rg.exe" : "rg"))
    }
    const seen = new Set()
    for (const candidate of candidates) {
      const key = path.resolve(candidate).toLocaleLowerCase("en-US")
      if (seen.has(key)) continue
      seen.add(key)
      try {
        const link = await lstat(candidate)
        if (!link.isFile() || link.isSymbolicLink() || (Number(link.attributes ?? 0) & 0x400) !== 0 || link.size < 500_000 || link.size > 40_000_000) continue
        const real = await realpath(candidate)
        const info = await stat(real)
        if (!info.isFile()) continue
        const result = await execFileAsync(real, ["--version"], { windowsHide: true, timeout: 5000, maxBuffer: 4096, encoding: "utf8" })
        const version = /^ripgrep\s+(\d+\.\d+\.\d+)/i.exec(result.stdout.trim())?.[1]
        if (!version) continue
        const digest = createHash("sha256")
        for await (const chunk of createReadStream(real)) digest.update(chunk)
        return { available: true, path: real, version, sha256: digest.digest("hex") }
      } catch { /* continue only through locally configured/PATH candidates */ }
    }
    return { available: false, reason: "ripgrep_not_installed", diagnostic: "未找到有效的本机 rg 可执行文件；没有下载或替换二进制。" }
  })()
  return binaryPromise
}

function validGlob(value) {
  if (typeof value !== "string" || !value.length || value.length > 256 || value.startsWith("!") || value.startsWith("-") || /[\0\r\n:]/.test(value) || path.win32.isAbsolute(value) || path.posix.isAbsolute(value)) return false
  return value.split(/[\\/]/).every((part) => part !== "..")
}

function requestFingerprint(args) {
  const { cursor, request_id, limit, ...stable } = args
  return sha256(JSON.stringify(stable))
}

function makeCursor(searchId, workspaceId, fingerprint, offset) {
  const payload = Buffer.from(JSON.stringify({ searchId, workspaceId, fingerprint, offset })).toString("base64url")
  return `${payload}.${createHmac("sha256", cursorKey).update(payload).digest("base64url")}`
}

function readCursor(cursor) {
  const [payload, signature, extra] = String(cursor ?? "").split(".")
  if (!payload || !signature || extra) throw new Error("搜索 cursor 无效或已过期")
  const expected = createHmac("sha256", cursorKey).update(payload).digest()
  let actual
  try { actual = Buffer.from(signature, "base64url") } catch { throw new Error("搜索 cursor 无效或已过期") }
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) throw new Error("搜索 cursor 无效或已过期")
  let data
  try { data = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) } catch { throw new Error("搜索 cursor 无效或已过期") }
  if (!Number.isSafeInteger(data.offset) || data.offset < 0) throw new Error("搜索 cursor 无效或已过期")
  return data
}

async function collectFiles(workspace, scope) {
  let start = scope
  if (start) {
    start = normalizeRelative(start)
    if (isSensitivePath(start) || start.split("/").some((part) => hasBlockedExplicitDirectory(part) || shouldSkipDirectory(part))) throw new Error("代码搜索拒绝访问敏感、内部或生成目录")
    const info = await fileInfo(workspace.root, start)
    if (!info.isDirectory) return { files: info.blocked ? [] : [start], truncated: false }
  }
  const files = []
  const stack = [start]
  let truncated = false
  while (stack.length) {
    const relativeDirectory = stack.pop()
    let cursor = ""
    do {
      const listing = await listDirectory(workspace.root, relativeDirectory, { limit: 500, cursor })
      for (const entry of listing.entries) {
        if (entry.blocked) continue
        const relative = relativeDirectory ? `${relativeDirectory}/${entry.name}` : entry.name
        if (isSensitivePath(relative) || hasBlockedExplicitDirectory(entry.name)) continue
        if (entry.isDirectory) {
          if (!shouldSkipDirectory(entry.name)) stack.push(relative)
        } else {
          files.push(relative)
          if (files.length >= MAX_LISTED_FILES) { truncated = true; break }
        }
      }
      if (truncated) break
      cursor = listing.nextCursor ?? ""
    } while (cursor)
    if (truncated) break
  }
  return { files: files.sort((a, b) => a.localeCompare(b, "en")), truncated }
}

async function collectSearchableFiles(binary, workspace, args, allowedFiles) {
  const listArgs = ["--files", "--hidden", "--color", "never", "--no-ignore-parent"]
  if (args.respect_ignore === false) listArgs.push("--no-ignore")
  for (const glob of args.include ?? []) listArgs.push("--glob", glob)
  for (const glob of args.exclude ?? []) listArgs.push("--glob", `!${glob}`)
  listArgs.push("--", args.path || ".")
  const root = await ensureSpoolRoot()
  const env = {
    SystemRoot: process.env.SystemRoot ?? "C:\\Windows", SystemDrive: process.env.SystemDrive ?? "C:",
    PATH: [path.dirname(binary.path), path.join(process.env.SystemRoot ?? "C:\\Windows", "System32")].join(path.delimiter),
    HOME: path.join(root, "home"), USERPROFILE: path.join(root, "home"),
  }
  await mkdir(env.HOME, { recursive: true })
  let result
  try {
    result = await execFileAsync(binary.path, listArgs, { cwd: workspace.root, env, windowsHide: true, timeout: 20_000, maxBuffer: MAX_OUTPUT_BYTES, encoding: "utf8" })
  } catch (error) {
    if (error?.code === 1) result = { stdout: "" }
    else if (error?.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER") throw new Error("ripgrep 文件清单超过 128 MiB 预算")
    else throw new Error(clean(error?.stderr ?? error?.message ?? "ripgrep 枚举安全文件失败"))
  }
  const available = new Map(allowedFiles.map((file) => [process.platform === "win32" ? file.toLocaleLowerCase("en-US") : file, file]))
  const resultFiles = []
  const seen = new Set()
  for (let item of String(result.stdout ?? "").split(/\r?\n/)) {
    if (!item) continue
    item = item.replace(/\\/g, "/").replace(/^\.\//, "")
    const key = process.platform === "win32" ? item.toLocaleLowerCase("en-US") : item
    const matched = available.get(key)
    if (!matched || seen.has(key)) continue
    seen.add(key)
    resultFiles.push(matched)
  }
  return resultFiles.sort((a, b) => a.localeCompare(b, "en"))
}

function normalizeOutputPath(value, workspaceRoot) {
  let normalized = String(value ?? "").replace(/\\/g, "/")
  if (path.win32.isAbsolute(normalized) || path.isAbsolute(normalized)) {
    const relative = path.relative(workspaceRoot, normalized).replace(/\\/g, "/")
    if (relative === ".." || relative.startsWith("../") || path.isAbsolute(relative)) return ""
    normalized = relative
  }
  return normalized.replace(/^\.\//, "")
}

function normalizeLine(event, workspaceRoot) {
  const line = event.data?.lines
  return {
    path: normalizeOutputPath(bytesValue(event.data?.path), workspaceRoot),
    line: event.data?.line_number,
    text: bytesValue(line).replace(/\r?\n$/, ""),
    absolute_offset: String(event.data?.absolute_offset ?? "0"),
  }
}

function makeMatch(event, before, workspaceRoot) {
  const item = normalizeLine(event, workspaceRoot)
  return {
    path: item.path, line: item.line, absolute_offset: item.absolute_offset, text: item.text,
    matches: (event.data?.submatches ?? []).slice(0, 100).map((part) => ({
      start: part.start, end: part.end, text: bytesValue(part.match),
    })),
    context_before: before,
    context_after: [],
  }
}

async function ensureSpoolRoot() {
  const root = path.join(TMP_DIR, "code-search")
  await mkdir(root, { recursive: true })
  const meta = await lstat(root)
  const resolved = path.resolve(await realpath(root))
  if (!meta.isDirectory() || meta.isSymbolicLink() || (Number(meta.attributes ?? 0) & 0x400) !== 0 || resolved.toLocaleLowerCase("en-US") !== path.resolve(root).toLocaleLowerCase("en-US")) {
    throw new Error("ripgrep 结果缓存不是受控临时目录")
  }
  return root
}

async function spoolSearch(args, workspace, binary, fingerprint) {
  if (active.size >= 4) throw new Error("当前最多并发运行 4 个 ripgrep 搜索")
  const { files: allowedFiles, truncated: fileListTruncated } = await collectFiles(workspace, args.path ?? "")
  const files = await collectSearchableFiles(binary, workspace, args, allowedFiles)
  if (!files.length) return { searchId: randomUUID(), fingerprint, spoolPath: null, offsets: [], totalMatches: 0, truncated: fileListTruncated, timedOut: false, cancelled: false, fileListTruncated, exactTotal: !fileListTruncated, expires: Date.now() + CACHE_TTL_MS }
  const root = await ensureSpoolRoot()
  const searchId = randomUUID()
  const spoolPath = path.join(root, `${searchId}.ndjson`)
  const handle = await open(spoolPath, "wx")
  const options = ["--json", "--line-number", "--column", "--no-messages", "--color", "never", "--hidden", "--no-ignore-parent", "--max-columns", "2000", "--max-columns-preview"]
  if (args.context) options.push("--context", String(args.context))
  if (args.case_sensitive) options.push("--case-sensitive")
  else options.push("--smart-case")
  if (args.engine === "fixed") options.push("--fixed-strings")
  if (args.respect_ignore === false) options.push("--no-ignore")
  for (const glob of args.include ?? []) options.push("--glob", glob)
  for (const glob of args.exclude ?? []) options.push("--glob", `!${glob}`)
  const env = {
    SystemRoot: process.env.SystemRoot ?? "C:\\Windows",
    SystemDrive: process.env.SystemDrive ?? "C:",
    PATH: [path.dirname(binary.path), path.join(process.env.SystemRoot ?? "C:\\Windows", "System32")].join(path.delimiter),
    HOME: path.join(root, "home"), USERPROFILE: path.join(root, "home"),
    RUST_BACKTRACE: "0",
  }
  await mkdir(env.HOME, { recursive: true })
  const requestId = args.request_id || randomUUID()
  const activeKey = `${workspace.id}:${requestId}`
  const activeEntry = { children: new Set(), workspaceId: workspace.id, searchId, cancelled: false }
  active.set(activeKey, activeEntry)
  const offsets = []
  let spoolOffset = 0
  let spoolBytes = 0
  let outputBytes = 0
  let totalMatches = 0
  let stderr = ""
  let pendingWrites = Promise.resolve()
  let processingError = null
  let truncated = fileListTruncated
  let timedOut = false
  let contextBuffer = new Map()
  let pendingContext = new Map()
  let fileMatches = new Map()
  const contextLimit = args.context ?? 0
  const groups = []
  let group = []
  let groupChars = 0
  for (const relative of files) {
    if (group.length && groupChars + relative.length + 1 > 20_000) { groups.push(group); group = []; groupChars = 0 }
    group.push(relative)
    groupChars += relative.length + 1
  }
  if (group.length) groups.push(group)
  const stopRunning = () => { for (const child of activeEntry.children) child.kill() }

  const persist = (item) => {
    const values = fileMatches.get(item.path) ?? []
    values.push(item)
    fileMatches.set(item.path, values)
  }

  const writeMatchToSpool = (item) => {
    if (offsets.length >= MAX_MATCHES || spoolBytes >= MAX_RESULT_BYTES) { truncated = true; stopRunning(); return }
    const bytes = Buffer.from(`${JSON.stringify(item)}\n`, "utf8")
    if (spoolBytes + bytes.length > MAX_RESULT_BYTES) { truncated = true; stopRunning(); return }
    const offset = spoolOffset
    offsets.push({ offset, length: bytes.length })
    spoolOffset += bytes.length
    spoolBytes += bytes.length
    pendingWrites = pendingWrites.then(async () => { await handle.write(bytes, 0, bytes.length, offset) }).catch((error) => { processingError = error; stopRunning() })
  }

  const finalizePending = (relative, throughLine = Number.MAX_SAFE_INTEGER) => {
    const pending = pendingContext.get(relative) ?? []
    const stillPending = []
    for (const item of pending) {
      if (throughLine >= item.line + contextLimit) persist(item)
      else stillPending.push(item)
    }
    if (stillPending.length) pendingContext.set(relative, stillPending)
    else pendingContext.delete(relative)
  }

  const processEvent = (event) => {
    if (event.type === "begin") {
      const relative = normalizeOutputPath(bytesValue(event.data?.path), workspace.root)
      if (relative) fileMatches.set(relative, [])
      return
    }
    if (event.type === "end") {
      const relative = normalizeOutputPath(bytesValue(event.data?.path), workspace.root)
      if (!relative) return
      finalizePending(relative)
      const matches = fileMatches.get(relative) ?? []
      if (event.data?.binary_offset != null) totalMatches = Math.max(0, totalMatches - matches.length)
      else for (const item of matches) writeMatchToSpool(item)
      fileMatches.delete(relative)
      return
    }
    if (event.type !== "match" && event.type !== "context") return
    const line = normalizeLine(event, workspace.root)
    if (!line.path) return
    const recent = contextBuffer.get(line.path) ?? []
    for (const item of pendingContext.get(line.path) ?? []) {
      if (line.line > item.line && line.line <= item.line + contextLimit) item.context_after.push({ line: line.line, text: line.text })
    }
    if (event.type === "match") {
      totalMatches++
      if (totalMatches > MAX_MATCHES) { totalMatches = MAX_MATCHES; truncated = true; stopRunning(); return }
      const before = contextLimit ? recent.slice(-contextLimit).map((value) => ({ line: value.line, text: value.text })) : []
      const match = makeMatch(event, before, workspace.root)
      if (contextLimit) {
        const values = pendingContext.get(line.path) ?? []
        values.push(match)
        pendingContext.set(line.path, values)
      } else persist(match)
    }
    recent.push(line)
    if (recent.length > Math.max(contextLimit, 1)) recent.splice(0, recent.length - Math.max(contextLimit, 1))
    contextBuffer.set(line.path, recent)
    finalizePending(line.path, line.line)
  }

  const parseLine = (line) => {
    if (!line.length) return
    let event
    try { event = JSON.parse(line.toString("utf8")) } catch { throw new Error("ripgrep 返回了无效 JSON 行") }
    processEvent(event)
  }

  const timeout = setTimeout(() => { timedOut = true; truncated = true; stopRunning() }, MAX_QUERY_MS)
  try {
    for (const paths of groups) {
      if (timedOut || truncated && offsets.length >= MAX_MATCHES || activeEntry.cancelled) break
      const child = spawn(binary.path, [...options, "--regexp", args.query, "--", ...paths], { cwd: workspace.root, env, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] })
      activeEntry.children.add(child)
      let rawBuffer = Buffer.alloc(0)
      child.stdout.on("data", (chunk) => {
        outputBytes += chunk.length
        if (outputBytes > MAX_OUTPUT_BYTES) { truncated = true; stopRunning(); return }
        rawBuffer = Buffer.concat([rawBuffer, chunk])
        let newline
        while ((newline = rawBuffer.indexOf(10)) >= 0) {
          const line = rawBuffer.subarray(0, newline)
          rawBuffer = rawBuffer.subarray(newline + 1)
          try { parseLine(line) } catch (error) { processingError = error; stopRunning(); return }
        }
        if (rawBuffer.length > 4 * 1024 * 1024) { processingError = new Error("ripgrep 单个输出事件超过限制"); stopRunning() }
      })
      child.stderr.on("data", (chunk) => { if (stderr.length < 8000) stderr += chunk.toString("utf8").slice(0, 8000 - stderr.length) })
      const exit = await new Promise((resolve, reject) => {
        child.once("error", reject)
        child.once("close", (code, signal) => resolve({ code, signal }))
      })
      activeEntry.children.delete(child)
      if (rawBuffer.length) parseLine(rawBuffer)
      for (const relative of pendingContext.keys()) finalizePending(relative)
      await pendingWrites
      if (processingError) throw processingError
      if (![0, 1, null].includes(exit.code) && !truncated && !activeEntry.cancelled) throw new Error(clean(stderr) || `ripgrep exited ${exit.code}`)
      if (activeEntry.cancelled) { truncated = true; break }
    }
    if (processingError) throw processingError
  } catch (error) {
    await handle.close().catch(() => {})
    await rm(spoolPath, { force: true }).catch(() => {})
    throw error
  } finally {
    clearTimeout(timeout)
    active.delete(activeKey)
    stopRunning()
    await handle.close().catch(() => {})
  }
  return {
    searchId, fingerprint, spoolPath, offsets, totalMatches: Math.min(totalMatches, MAX_MATCHES),
    truncated: truncated || timedOut || activeEntry.cancelled, timedOut, cancelled: activeEntry.cancelled, fileListTruncated, exactTotal: !truncated && !timedOut && !activeEntry.cancelled,
    expires: Date.now() + CACHE_TTL_MS,
  }
}

async function readPage(search, start, limit) {
  const rows = []
  if (!search.spoolPath) return rows
  const file = await open(search.spoolPath, "r")
  try {
    for (const item of search.offsets.slice(start, start + limit)) {
      const buffer = Buffer.alloc(item.length)
      const { bytesRead } = await file.read(buffer, 0, item.length, item.offset)
      if (bytesRead !== item.length) throw new Error("搜索结果缓存被截断；请重新搜索")
      rows.push(JSON.parse(buffer.toString("utf8").trimEnd()))
    }
  } finally { await file.close() }
  return rows
}

async function expireCaches() {
  const now = Date.now()
  for (const [id, search] of searches) {
    if (search.expires > now) continue
    searches.delete(id)
    if (search.spoolPath) {
      try {
        const root = path.resolve(TMP_DIR, "code-search")
        const target = path.resolve(search.spoolPath)
        const relative = path.relative(root, target)
        if (relative && relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)) await rm(target, { force: true })
      } catch { /* a disposable expired cursor must not affect the workspace */ }
    }
  }
}

export async function getCodeSearchStatus() {
  const binary = await findBinary()
  return { ...binary, active_searches: active.size, cached_searches: searches.size, cache_ttl_seconds: CACHE_TTL_MS / 1000 }
}

export async function searchCode(args) {
  const workspace = await requireWorkspace(args.workspace_id)
  await expireCaches()
  const stableArgs = { ...args }
  for (const glob of [...(stableArgs.include ?? []), ...(stableArgs.exclude ?? [])]) if (!validGlob(glob)) throw new Error("glob 必须是工作区相对模式，且不能含路径穿越")
  const fingerprint = requestFingerprint(stableArgs)
  let search
  let offset = 0
  if (args.cursor) {
    const cursor = readCursor(args.cursor)
    if (cursor.workspaceId !== workspace.id || cursor.fingerprint !== fingerprint) throw new Error("搜索 cursor 不属于当前 workspace 或搜索参数已变化")
    search = searches.get(cursor.searchId)
    if (!search || search.expires <= Date.now()) throw new Error("搜索结果已过期；请重新搜索")
    offset = cursor.offset
  } else {
    const binary = await findBinary()
    if (!binary.available) return { available: false, workspace_id: workspace.id, reason: binary.reason, diagnostic: binary.diagnostic }
    search = await spoolSearch(stableArgs, workspace, binary, fingerprint)
    searches.set(search.searchId, search)
  }
  const limit = Math.min(200, Math.max(1, Math.trunc(args.limit ?? 100)))
  const matches = await readPage(search, offset, limit)
  const nextOffset = offset + matches.length
  const more = nextOffset < search.offsets.length
  const nextCursor = more ? makeCursor(search.searchId, workspace.id, fingerprint, nextOffset) : null
  return {
    available: true, workspace_id: workspace.id, search_id: search.searchId, request_id: args.request_id ?? null,
    engine: "ripgrep", version: (await findBinary()).version, matches, total_matches: search.totalMatches,
    exact_total: search.exactTotal, truncated: search.truncated, timed_out: search.timedOut,
    file_list_truncated: search.fileListTruncated, next_cursor: nextCursor, limit,
    message: search.timedOut ? "搜索达到 60 秒预算；返回已收集结果并标记 truncated。" : search.truncated ? "搜索达到输出或结果预算；返回已收集结果并标记 truncated。" : "搜索完成。",
  }
}

export async function cancelCodeSearch({ workspace_id, request_id }) {
  await requireWorkspace(workspace_id)
  const current = active.get(`${workspace_id}:${request_id}`)
  if (!current) return { workspace_id, request_id, cancelled: false, reason: "not_running" }
  current.cancelled = true
  current.child.kill()
  return { workspace_id, request_id, cancelled: true, search_id: current.searchId }
}
