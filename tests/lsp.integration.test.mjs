import assert from "node:assert/strict"
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises"
import { spawn } from "node:child_process"
import path from "node:path"
import { randomUUID } from "node:crypto"
import { fileURLToPath } from "node:url"
import { setTimeout as delay } from "node:timers/promises"
import { test } from "node:test"
import { Client } from "@modelcontextprotocol/client"
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio"

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")

async function freePort() {
  const server = await import("node:net").then(({ createServer }) => createServer())
  await new Promise((resolve, reject) => server.once("error", reject).listen(0, "127.0.0.1", resolve))
  const port = server.address().port
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
  return port
}

test("LSP MCP integration uses the pinned real TypeScript language server", async (t) => {
  const testsRoot = path.join(projectRoot, ".tmp", "tests")
  await mkdir(testsRoot, { recursive: true })
  const sandbox = await mkdtemp(path.join(testsRoot, "lsp-验收-"))
  const dataDir = path.join(sandbox, "data")
  const tempDir = path.join(sandbox, "tmp")
  const workspaceRoot = path.join(sandbox, "隔离 TypeScript 工程")
  await Promise.all([mkdir(dataDir), mkdir(tempDir), mkdir(path.join(workspaceRoot, "src"), { recursive: true })])
  await writeFile(path.join(workspaceRoot, "src", "target.ts"), [
    "export interface Example { title: string }",
    "export function answer(value: Example): number { return 42 }",
    "",
  ].join("\n"))
  await writeFile(path.join(workspaceRoot, "src", "main.ts"), [
    'import { answer, Example } from "./target"',
    'const item: Example = { title: "hello" }',
    "answer(item)",
    "const invalid: string = 5",
    "",
  ].join("\n"))

  const port = await freePort()
  const origin = `http://127.0.0.1:${port}`
  const env = { ...process.env, CHATCODE_HOME: projectRoot, CHATCODE_DATA_DIR: dataDir, CHATCODE_TMP_DIR: tempDir, CHATCODE_PORT: String(port) }
  const admin = spawn(process.execPath, [path.join(projectRoot, "apps", "server", "admin.mjs")], { cwd: projectRoot, env, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] })
  let adminOutput = ""
  admin.stdout.on("data", (chunk) => { adminOutput = (adminOutput + chunk.toString("utf8")).slice(-3000) })
  admin.stderr.on("data", (chunk) => { adminOutput = (adminOutput + chunk.toString("utf8")).slice(-3000) })
  let client
  let transport
  let mcp
  t.after(async () => {
    if (client) await client.close().catch(() => transport?.close().catch(() => {}))
    else await transport?.close().catch(() => {})
    if (mcp?.exitCode === null) {
      mcp.kill()
      await Promise.race([new Promise((resolve) => mcp.once("close", resolve)), delay(2000)])
    }
    if (admin.exitCode === null) {
      admin.kill()
      await Promise.race([new Promise((resolve) => admin.once("close", resolve)), delay(2000)])
    }
    const relative = path.relative(path.resolve(testsRoot), path.resolve(sandbox))
    if (relative && relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)) await rm(sandbox, { recursive: true, force: true })
  })

  let session
  for (let attempt = 0; attempt < 80; attempt++) {
    if (admin.exitCode !== null) throw new Error(`isolated admin exited.\n${adminOutput}`)
    try {
      const response = await fetch(`${origin}/api/session`)
      if (response.ok) { session = await response.json(); break }
    } catch { /* wait for local setup */ }
    await delay(100)
  }
  assert.ok(session?.csrf, `isolated admin did not start.\n${adminOutput}`)
  const post = (route, body = {}) => fetch(`${origin}${route}`, {
    method: "POST", headers: { Origin: origin, "X-ChatCode-CSRF": session.csrf, "Content-Type": "application/json" }, body: JSON.stringify(body),
  })
  const added = await post("/api/workspaces", { name: "LSP fixture", path: workspaceRoot, mode: "readOnly" })
  if (added.status !== 201) throw new Error(`workspace setup returned ${added.status}: ${await added.text()}`)
  const workspace = (await added.json()).workspace
  const mcpEnv = {
    SystemRoot: process.env.SystemRoot ?? "C:\\Windows", SystemDrive: process.env.SystemDrive ?? "C:",
    PATH: [path.dirname(process.execPath), path.join(process.env.SystemRoot ?? "C:\\Windows", "System32")].join(path.delimiter),
    CHATCODE_HOME: projectRoot, CHATCODE_DATA_DIR: dataDir, CHATCODE_TMP_DIR: tempDir,
  }
  transport = new StdioClientTransport({ command: process.execPath, args: [path.join(projectRoot, "apps", "server", "mcp.mjs")], cwd: projectRoot, env: mcpEnv, stderr: "pipe" })
  client = new Client({ name: "chatcode-lsp-integration", version: "1.0.0" })
  await client.connect(transport)
  mcp = transport.process
  const call = async (name, args) => {
    const result = await client.callTool({ name, arguments: args })
    if (result.isError) throw new Error(`${name}: ${result.structuredContent?.error ?? result.content?.[0]?.text ?? "MCP tool failed"}`)
    return result.structuredContent
  }

  const status = await call("get_lsp_status", {})
  const typescript = status.servers.find((item) => item.name === "typescript-language-server")
  assert.ok(typescript, JSON.stringify(status))
  assert.equal(typescript.version, "6.0.2")
  assert.equal(typescript.typescript_version, "6.0.3")

  const definitions = await call("go_to_definition", { workspace_id: workspace.id, file: "src/main.ts", line: 3, character: 1 })
  assert.ok(definitions.result.some((item) => item.file === "src/target.ts" && item.line === 2), JSON.stringify(definitions.result))
  const references = await call("find_references", { workspace_id: workspace.id, file: "src/main.ts", line: 1, character: 10 })
  assert.ok(references.result.length >= 2, JSON.stringify(references.result))
  const hover = await call("get_hover", { workspace_id: workspace.id, file: "src/main.ts", line: 2, character: 13 })
  assert.ok(hover.result, "expected a real TypeScript hover response")
  const symbols = await call("get_document_symbols", { workspace_id: workspace.id, file: "src/target.ts" })
  assert.ok(symbols.result.some((item) => item.name === "answer"), JSON.stringify(symbols.result))
  const workspaceSymbols = await call("search_workspace_symbols", { workspace_id: workspace.id, query: "answer" })
  assert.ok(workspaceSymbols.symbols.some((item) => item.name === "answer"), JSON.stringify(workspaceSymbols.symbols))
  const diagnostics = await call("get_file_diagnostics", { workspace_id: workspace.id, file: "src/main.ts" })
  assert.ok(diagnostics.diagnostics.some((item) => item.provenance === "lsp" && item.line === 4 && item.severity === "error"), JSON.stringify(diagnostics))
  assert.equal((await call("get_workspace_diagnostics", { workspace_id: workspace.id, max_files: 10 })).available, true)

  const evidenceDir = path.join(projectRoot, ".tmp", "phase9")
  await mkdir(evidenceDir, { recursive: true })
  await writeFile(path.join(evidenceDir, "a2-lsp-evidence.json"), JSON.stringify({
    result: "PASS", workspace_id: workspace.id, server: { version: typescript.version, typescript_version: typescript.typescript_version, executable_sha256: typescript.executable_sha256 },
    methods: { definition: definitions.result, references: references.result, hover: hover.result, symbols: symbols.result, workspace_symbols: workspaceSymbols.symbols, diagnostics: diagnostics.diagnostics },
    unsupported_languages: status.unavailable,
  }, null, 2) + "\n", "utf8")
})
