import { spawn } from "node:child_process"
import { createHash, randomUUID } from "node:crypto"
import { lstat, mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises"
import path from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import { CHATCODE_HOME, TMP_DIR } from "./config.mjs"
import { hasBlockedExplicitDirectory, normalizeRelative, shouldSkipDirectory } from "./paths.mjs"
import { fileInfo, listDirectory, readFileBytes } from "./safe-fs.mjs"
import { withNamedStateLock } from "./state.mjs"
import { isSensitivePath } from "./paths.mjs"
import { requireWorkspace } from "./workspaces.mjs"

const MAX_SNAPSHOT_FILES = 5000
const MAX_SNAPSHOT_BYTES = 128 * 1024 * 1024
const MAX_DOCUMENT_BYTES = 2 * 1024 * 1024
const MAX_SERVER_PROCESSES = 3
const SUPPORTED = new Set([".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".mts", ".cts"])
const serverStates = new Map()
const sourceRoot = CHATCODE_HOME
const cliPath = path.join(sourceRoot, "node_modules", "typescript-language-server", "lib", "cli.mjs")
const runtimePackagePath = path.join(sourceRoot, "node_modules", "typescript-language-server", "package.json")

function sha256(value) { return createHash("sha256").update(value).digest("hex") }
function clean(value, max = 300) { return String(value ?? "").replace(/[\r\n\0]+/g, " ").slice(0, max) }
function isSupported(relative) { return SUPPORTED.has(path.posix.extname(relative).toLowerCase()) }
function encodeUri(root, relative) { return pathToFileURL(path.join(root, ...relative.split("/"))).href }
function uriKey(uri) {
  const absolute = path.resolve(fileURLToPath(uri))
  return process.platform === "win32" ? absolute.toLocaleLowerCase("en-US") : absolute
}
function idForUri(root, uri) {
  const actual = path.resolve(fileURLToPath(uri))
  const relative = path.relative(root, actual)
  if (!relative || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw new Error("语言服务器返回了工作区快照之外的路径")
  return relative.split(path.sep).join("/")
}

async function runtimeInfo() {
  try {
    const typescriptPackagePath = path.join(sourceRoot, "node_modules", "typescript", "package.json")
    const [packageBytes, cliBytes, typescriptPackageBytes] = await Promise.all([readFile(runtimePackagePath), readFile(cliPath), readFile(typescriptPackagePath)])
    const pkg = JSON.parse(packageBytes.toString("utf8"))
    const typescript = JSON.parse(typescriptPackageBytes.toString("utf8"))
    if (pkg.name !== "typescript-language-server" || pkg.version !== "6.0.2") return { available: false, reason: "version_not_trusted", diagnostic: "受信任的 TypeScript LSP 版本未匹配。" }
    if (typescript.name !== "typescript" || typescript.version !== "6.0.3") return { available: false, reason: "typescript_version_not_trusted", diagnostic: "受信任的 TypeScript runtime 版本未匹配。" }
    return { available: true, language: "typescript/javascript", name: pkg.name, version: pkg.version, typescript_version: typescript.version, source: pkg.repository?.url ?? null, executable_sha256: sha256(cliBytes), executable: cliPath }
  } catch {
    return { available: false, reason: "server_not_installed", diagnostic: "ChatCode 固定的 TypeScript Language Server 6.0.2 未安装。" }
  }
}

function send(state, message) {
  if (!state.child || state.child.exitCode !== null || !state.child.stdin.writable) throw new Error("LSP 进程已退出")
  const body = Buffer.from(JSON.stringify(message), "utf8")
  state.child.stdin.write(Buffer.from(`Content-Length: ${body.length}\r\n\r\n`, "ascii"))
  state.child.stdin.write(body)
}

function respondToServerRequest(state, message) {
  const method = message.method
  let result = null
  if (method === "workspace/configuration") result = Array.isArray(message.params?.items) ? message.params.items.map(() => null) : []
  else if (method === "workspace/workspaceFolders") result = [{ uri: pathToFileURL(state.snapshotRoot).href, name: "ChatCode isolated snapshot" }]
  else if (method === "workspace/applyEdit") result = { applied: false, failureReason: "ChatCode LSP is read-only." }
  else if (method === "window/workDoneProgress/create") result = null
  else if (method === "client/registerCapability" || method === "client/unregisterCapability") result = null
  else if (method === "workspace/semanticTokens/refresh" || method === "workspace/diagnostic/refresh") result = null
  else if (method === "window/showMessageRequest") result = null
  else if (method === "workspace/executeClientCommand") result = null
  send(state, { jsonrpc: "2.0", id: message.id, result })
}

function handleMessage(state, message) {
  if (message.id !== undefined && message.method) {
    try { respondToServerRequest(state, message) } catch { /* process exit will reject pending calls */ }
    return
  }
  if (message.id !== undefined) {
    const pending = state.pending.get(message.id)
    if (!pending) return
    state.pending.delete(message.id)
    clearTimeout(pending.timer)
    if (message.error) pending.reject(new Error(clean(message.error.message ?? "LSP request failed")))
    else pending.resolve(message.result)
    return
  }
  if (message.method === "textDocument/publishDiagnostics") {
    const uri = message.params?.uri
    if (typeof uri === "string") state.diagnostics.set(uriKey(uri), Array.isArray(message.params.diagnostics) ? message.params.diagnostics : [])
  }
}

function receive(state, chunk) {
  state.buffer = Buffer.concat([state.buffer, chunk])
  while (true) {
    const headerEnd = state.buffer.indexOf("\r\n\r\n")
    if (headerEnd < 0) return
    const header = state.buffer.subarray(0, headerEnd).toString("ascii")
    const match = /(?:^|\r\n)Content-Length:\s*(\d+)/i.exec(header)
    if (!match) { state.child.kill(); return }
    const length = Number(match[1])
    if (!Number.isSafeInteger(length) || length < 0 || length > 8 * 1024 * 1024) { state.child.kill(); return }
    const messageEnd = headerEnd + 4 + length
    if (state.buffer.length < messageEnd) return
    const body = state.buffer.subarray(headerEnd + 4, messageEnd)
    state.buffer = state.buffer.subarray(messageEnd)
    try { handleMessage(state, JSON.parse(body.toString("utf8"))) } catch { state.child.kill(); return }
  }
}

function request(state, method, params, timeoutMs = 10_000) {
  const id = ++state.nextId
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      state.pending.delete(id)
      try { send(state, { jsonrpc: "2.0", method: "$/cancelRequest", params: { id } }) } catch { /* process exited */ }
      reject(new Error(`LSP 请求超时：${method}`))
    }, timeoutMs)
    state.pending.set(id, { resolve, reject, timer })
    try { send(state, { jsonrpc: "2.0", id, method, params }) }
    catch (error) { clearTimeout(timer); state.pending.delete(id); reject(error) }
  })
}

function notify(state, method, params) { send(state, { jsonrpc: "2.0", method, params }) }

async function collectSourceFiles(workspace) {
  const found = []
  let totalBytes = 0
  const stack = [""]
  while (stack.length && found.length < MAX_SNAPSHOT_FILES) {
    const directory = stack.pop()
    let cursor = ""
    do {
      const page = await listDirectory(workspace.root, directory, { limit: 500, cursor })
      for (const item of page.entries) {
        if (item.blocked) continue
        const relative = directory ? `${directory}/${item.name}` : item.name
        if (isSensitivePath(relative) || hasBlockedExplicitDirectory(relative)) continue
        if (item.isDirectory) {
          if (!shouldSkipDirectory(item.name)) stack.push(relative)
          continue
        }
        if (!isSupported(relative)) continue
        const size = Number(item.size ?? item.size_bytes ?? 0)
        if (!Number.isFinite(size) || size < 0 || size > MAX_DOCUMENT_BYTES) continue
        if (totalBytes + size > MAX_SNAPSHOT_BYTES) continue
        found.push(relative)
        totalBytes += size
      }
      cursor = page.nextCursor ?? ""
    } while (cursor && found.length < MAX_SNAPSHOT_FILES)
  }
  return { files: found.sort((a, b) => a.localeCompare(b, "en")), bytes: totalBytes, truncated: stack.length > 0 }
}

async function buildSnapshot(workspace, snapshotRoot) {
  await mkdir(snapshotRoot, { recursive: true })
  const listing = await collectSourceFiles(workspace)
  const versions = new Map()
  for (const relative of listing.files) {
    let metadata
    let bytes
    try {
      metadata = await fileInfo(workspace.root, relative)
      if (metadata.isDirectory || metadata.blocked) continue
      bytes = await readFileBytes(workspace.root, relative, MAX_DOCUMENT_BYTES)
    } catch { continue }
    if (bytes.includes(0)) continue
    const target = path.join(snapshotRoot, ...relative.split("/"))
    await mkdir(path.dirname(target), { recursive: true })
    await writeFile(target, bytes, { flag: "wx" })
    versions.set(relative, { version: metadata.version, sha256: sha256(bytes), bytes: bytes.length, lspVersion: 1 })
  }
  return { ...listing, versions }
}

async function startServer(workspace) {
  if (serverStates.size >= MAX_SERVER_PROCESSES) throw new Error(`最多同时运行 ${MAX_SERVER_PROCESSES} 个 workspace LSP`)
  const runtime = await runtimeInfo()
  if (!runtime.available) throw Object.assign(new Error(runtime.diagnostic), { code: runtime.reason })
  const root = path.join(TMP_DIR, "lsp")
  await mkdir(root, { recursive: true })
  const rootStat = await lstat(root)
  const resolvedRoot = path.resolve(await realpath(root))
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink() || (Number(rootStat.attributes ?? 0) & 0x400) !== 0 || resolvedRoot.toLocaleLowerCase("en-US") !== path.resolve(root).toLocaleLowerCase("en-US")) {
    throw new Error("LSP 快照目录不是受控的普通目录")
  }
  const snapshotRoot = path.join(root, `${workspace.id}-${randomUUID()}`)
  const snapshot = await buildSnapshot(workspace, snapshotRoot)
  const env = {
    SystemRoot: process.env.SystemRoot ?? "C:\\Windows",
    SystemDrive: process.env.SystemDrive ?? "C:",
    PATH: [path.dirname(process.execPath), path.join(process.env.SystemRoot ?? "C:\\Windows", "System32")].join(path.delimiter),
    TEMP: path.join(TMP_DIR, "lsp"), TMP: path.join(TMP_DIR, "lsp"),
    HOME: snapshotRoot, USERPROFILE: snapshotRoot,
  }
  const child = spawn(process.execPath, [cliPath, "--stdio"], { cwd: sourceRoot, env, windowsHide: true, stdio: ["pipe", "pipe", "pipe"] })
  const state = {
    workspaceId: workspace.id, snapshotRoot, child, buffer: Buffer.alloc(0), pending: new Map(), nextId: 0,
    diagnostics: new Map(), documents: new Map(), versions: snapshot.versions, sourceFiles: snapshot.files,
    snapshotTruncated: snapshot.truncated, runtime, closed: false,
  }
  serverStates.set(workspace.id, state)
  child.stdout.on("data", (chunk) => receive(state, chunk))
  state.stderrTail = ""
  child.stderr.on("data", (chunk) => { state.stderrTail = (state.stderrTail + chunk.toString("utf8")).slice(-3000) })
  child.once("error", (error) => failState(state, error))
  child.once("exit", (code, signal) => failState(state, new Error(`LSP exit ${code ?? signal ?? "unknown"}`)))
  const rootUri = pathToFileURL(snapshotRoot).href
  try {
    await request(state, "initialize", {
      processId: process.pid, clientInfo: { name: "ChatCode", version: "0.1.0" }, rootUri,
      workspaceFolders: [{ uri: rootUri, name: "ChatCode isolated snapshot" }],
      capabilities: {
        workspace: { workspaceFolders: true, configuration: true, applyEdit: false, symbol: { dynamicRegistration: false } },
        textDocument: {
          synchronization: { dynamicRegistration: false, didSave: false, willSave: false },
          definition: { dynamicRegistration: false, linkSupport: true },
          references: { dynamicRegistration: false }, hover: { dynamicRegistration: false, contentFormat: ["markdown", "plaintext"] },
          documentSymbol: { dynamicRegistration: false, hierarchicalDocumentSymbolSupport: true },
          publishDiagnostics: { relatedInformation: true },
        },
      },
      initializationOptions: { hostInfo: "ChatCode", maxTsServerMemory: 256, disableAutomaticTypingAcquisition: true },
      trace: "off", workDoneToken: "chatcode-initialize",
    }, 20_000)
    notify(state, "initialized", {})
    return state
  } catch (error) {
    await stopState(state)
    throw error
  }
}

function failState(state, error) {
  if (state.closed) return
  state.closed = true
  state.failure = clean(error?.message ?? "LSP stopped")
  for (const pending of state.pending.values()) { clearTimeout(pending.timer); pending.reject(new Error(state.failure)) }
  state.pending.clear()
  if (serverStates.get(state.workspaceId) === state) serverStates.delete(state.workspaceId)
}

async function stopState(state) {
  if (!state || state.closed) return
  try { await request(state, "shutdown", null, 1500) } catch { /* process may be unhealthy */ }
  try { notify(state, "exit", {}) } catch { /* process may have exited */ }
  state.closed = true
  if (state.child.exitCode === null) state.child.kill()
  for (const pending of state.pending.values()) { clearTimeout(pending.timer); pending.reject(new Error("LSP 已关闭")) }
  state.pending.clear()
  if (serverStates.get(state.workspaceId) === state) serverStates.delete(state.workspaceId)
  try {
    const realRoot = path.resolve(TMP_DIR, "lsp")
    const target = path.resolve(state.snapshotRoot)
    const relative = path.relative(realRoot, target)
    if (relative && relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)) await rm(target, { recursive: true, force: true })
  } catch { /* snapshot is disposable and remains under .tmp */ }
}

async function getServer(workspace) {
  const current = serverStates.get(workspace.id)
  if (current && !current.closed && current.child.exitCode === null) return current
  return startServer(workspace)
}

function languageId(relative) {
  const ext = path.posix.extname(relative).toLowerCase()
  if ([".tsx", ".jsx"].includes(ext)) return ext === ".tsx" ? "typescriptreact" : "javascriptreact"
  if ([".js", ".mjs", ".cjs"].includes(ext)) return "javascript"
  return "typescript"
}

async function openDocument(state, workspace, inputPath, expectedVersion) {
  const relative = normalizeRelative(inputPath)
  if (!isSupported(relative)) throw new Error("当前真实安装的 LSP 仅支持 TypeScript/JavaScript 源文件")
  if (isSensitivePath(relative) || relative.split("/").some((part) => hasBlockedExplicitDirectory(part) || shouldSkipDirectory(part))) throw new Error("LSP 拒绝访问敏感、生成或内部路径")
  const metadata = await fileInfo(workspace.root, relative)
  if (metadata.isDirectory || metadata.blocked) throw new Error("LSP 文档不是普通授权文件")
  if (expectedVersion && metadata.version !== expectedVersion) throw new Error("文档版本已变化；请重新读取文件后再查询 LSP")
  const bytes = await readFileBytes(workspace.root, relative, MAX_DOCUMENT_BYTES)
  if (bytes.includes(0)) throw new Error("LSP 不接受二进制文件")
  const text = bytes.toString("utf8")
  const digest = sha256(bytes)
  let version = state.versions.get(relative)
  const target = path.join(state.snapshotRoot, ...relative.split("/"))
  await mkdir(path.dirname(target), { recursive: true })
  if (!version) {
    await writeFile(target, bytes)
    version = { version: metadata.version, sha256: digest, bytes: bytes.length, lspVersion: 1 }
    state.versions.set(relative, version)
    if (!state.sourceFiles.includes(relative)) state.sourceFiles.push(relative)
  } else if (version.sha256 !== digest || version.version !== metadata.version) {
    version.version = metadata.version
    version.sha256 = digest
    version.bytes = bytes.length
    version.lspVersion++
    await writeFile(target, bytes)
    notify(state, "workspace/didChangeWatchedFiles", { changes: [{ uri: encodeUri(state.snapshotRoot, relative), type: 2 }] })
  }
  const uri = encodeUri(state.snapshotRoot, relative)
  const previous = state.documents.get(relative)
  if (!previous) {
    notify(state, "textDocument/didOpen", { textDocument: { uri, languageId: languageId(relative), version: version.lspVersion, text } })
    state.documents.set(relative, { uri, version: version.lspVersion })
  } else if (previous.version !== version.lspVersion) {
    notify(state, "textDocument/didChange", { textDocument: { uri, version: version.lspVersion }, contentChanges: [{ text }] })
    state.documents.set(relative, { uri, version: version.lspVersion })
  }
  return { relative, uri, version: metadata.version, lspVersion: version.lspVersion, text }
}

function position(line, character) {
  if (!Number.isInteger(line) || line < 1 || line > 1_000_000 || !Number.isInteger(character) || character < 1 || character > 100_000) throw new Error("LSP line/character 必须是 1 起始的 UTF-16 位置")
  return { line: line - 1, character: character - 1 }
}

function mapLocation(state, value) {
  const items = Array.isArray(value) ? value : value ? [value] : []
  return items.slice(0, 100).flatMap((item) => {
    try {
      const uri = item.uri ?? item.targetUri
      const range = item.range ?? item.targetSelectionRange ?? item.targetRange
      const file = idForUri(state.snapshotRoot, uri)
      return [{ file, line: range.start.line + 1, column: range.start.character + 1, end_line: range.end.line + 1, end_column: range.end.character + 1 }]
    } catch { return [] }
  })
}

function mapDiagnostics(state, uri) {
  const diagnostics = state.diagnostics.get(uriKey(uri)) ?? []
  return diagnostics.slice(0, 300).flatMap((item) => {
    try {
      return [{
        file: idForUri(state.snapshotRoot, uri), line: item.range.start.line + 1, column: item.range.start.character + 1,
        end_line: item.range.end.line + 1, end_column: item.range.end.character + 1,
        severity: ({ 1: "error", 2: "warning", 3: "information", 4: "hint" })[item.severity] ?? "information",
        source: item.source ?? "typescript-language-server", provenance: "lsp", code: item.code ?? null,
        message: clean(item.message, 1200), related_information: (item.relatedInformation ?? []).slice(0, 20).flatMap((related) => {
          try { return [{ ...mapLocation(state, related.location)[0], message: clean(related.message, 500) }] } catch { return [] }
        }),
      }]
    } catch { return [] }
  })
}

export async function getLspStatus() {
  const runtime = await runtimeInfo()
  return {
    servers: runtime.available ? [runtime] : [],
    unavailable: ["java", "kotlin", "python"].map((language) => ({ language, reason: "language_server_not_installed" })),
    active_workspaces: serverStates.size,
  }
}

export async function getFileDiagnostics({ workspace_id, file, document_version }) {
  const workspace = await requireWorkspace(workspace_id)
  return withNamedStateLock(`lsp-${workspace_id}`, async () => {
    const state = await getServer(workspace)
    const document = await openDocument(state, workspace, file, document_version)
    let diagnosticRequestError = null
    try {
      await request(state, "workspace/executeCommand", {
        command: "typescript.tsserverRequest",
        arguments: ["geterr", { files: [path.join(state.snapshotRoot, ...document.relative.split("/"))], delay: 0 }, { expectsResult: false, isAsync: true, lowPriority: false }],
      }, 5000)
    } catch (error) { diagnosticRequestError = clean(error?.message); /* diagnostics can also arrive from the server's normal didOpen flow */ }
    await new Promise((resolve) => setTimeout(resolve, 1200))
    return { available: true, workspace_id, file: document.relative, document_version: document.version, diagnostics: mapDiagnostics(state, document.uri), published_diagnostic_documents: [...state.diagnostics].map(([absolute, values]) => ({ file: path.relative(state.snapshotRoot, absolute).split(path.sep).join("/"), count: values.length })), diagnostic_request_error: diagnosticRequestError, server: state.runtime, snapshot: { files: state.versions.size, truncated: state.snapshotTruncated } }
  })
}

export async function getWorkspaceDiagnostics({ workspace_id, max_files = 50 }) {
  const workspace = await requireWorkspace(workspace_id)
  return withNamedStateLock(`lsp-${workspace_id}`, async () => {
    const state = await getServer(workspace)
    const files = state.sourceFiles.slice(0, Math.max(1, Math.min(200, max_files)))
    for (const file of files) {
      try { await openDocument(state, workspace, file) } catch { /* one changed/unreadable file does not hide other diagnostics */ }
    }
    try {
      const localFiles = files.map((relative) => path.join(state.snapshotRoot, ...relative.split("/")))
      await request(state, "workspace/executeCommand", {
        command: "typescript.tsserverRequest",
        arguments: ["geterr", { files: localFiles, delay: 0 }, { expectsResult: false, isAsync: true, lowPriority: false }],
      }, 5000)
    } catch { /* rely on the normal open diagnostics if this extension request is unavailable */ }
    await new Promise((resolve) => setTimeout(resolve, 1200))
    const diagnostics = []
    for (const [key, values] of state.diagnostics) {
      if (values.length) diagnostics.push(...mapDiagnostics(state, pathToFileURL(key).href))
    }
    return { available: true, workspace_id, scanned_files: files.length, truncated: state.snapshotTruncated || files.length < state.sourceFiles.length, diagnostics: diagnostics.slice(0, 1000), server: state.runtime }
  })
}

async function withDocument(args, method, params, transform) {
  const workspace = await requireWorkspace(args.workspace_id)
  return withNamedStateLock(`lsp-${args.workspace_id}`, async () => {
    const state = await getServer(workspace)
    const document = await openDocument(state, workspace, args.file, args.document_version)
    const result = await request(state, method, { textDocument: { uri: document.uri }, ...params(document) })
    return { available: true, workspace_id: args.workspace_id, file: document.relative, document_version: document.version, result: await transform(state, result, document), server: state.runtime }
  })
}

export async function goToDefinition(args) {
  return withDocument(args, "textDocument/definition", () => ({ position: position(args.line, args.character) }), async (state, value, document) => {
    const locations = mapLocation(state, value)
    if (!locations.some((item) => item.file === document.relative)) return locations
    try {
      const sourceDefinitions = await request(state, "workspace/executeCommand", {
        command: "_typescript.goToSourceDefinition",
        arguments: [document.uri, position(args.line, args.character)],
      })
      const mapped = mapLocation(state, sourceDefinitions)
      if (mapped.length) return mapped
    } catch { /* retain the standard LSP definition result when source definitions are unsupported */ }
    return locations
  })
}

export async function findReferences(args) {
  return withDocument(args, "textDocument/references", (doc) => ({ position: position(args.line, args.character), context: { includeDeclaration: args.include_declaration } }), mapLocation)
}

export async function getHover(args) {
  return withDocument(args, "textDocument/hover", (doc) => ({ position: position(args.line, args.character) }), (_state, value) => value?.contents ?? null)
}

export async function getDocumentSymbols(args) {
  return withDocument(args, "textDocument/documentSymbol", () => ({}), (_state, value) => (Array.isArray(value) ? value : []).slice(0, 500))
}

export async function searchWorkspaceSymbols({ workspace_id, query, limit = 100 }) {
  const workspace = await requireWorkspace(workspace_id)
  return withNamedStateLock(`lsp-${workspace_id}`, async () => {
    const state = await getServer(workspace)
    const result = await request(state, "workspace/symbol", { query: query.slice(0, 300) })
    const symbols = (Array.isArray(result) ? result : []).slice(0, Math.min(200, limit)).flatMap((item) => {
      try {
        const location = mapLocation(state, item.location)[0]
        return location ? [{ name: clean(item.name, 300), kind: item.kind, container_name: item.containerName ?? null, ...location }] : []
      } catch { return [] }
    })
    return { available: true, workspace_id, query, symbols, truncated: Array.isArray(result) && result.length > symbols.length, server: state.runtime }
  })
}

export async function closeLspServers() {
  await Promise.all([...serverStates.values()].map((state) => stopState(state)))
}

export async function invalidateWorkspaceLsp(workspaceId) {
  const state = serverStates.get(workspaceId)
  if (state) await stopState(state)
}
