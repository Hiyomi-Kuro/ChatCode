import assert from "node:assert/strict"
import { access, mkdtemp, mkdir, rm, writeFile } from "node:fs/promises"
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

async function discoverRg() {
  for (const folder of String(process.env.PATH ?? "").split(path.delimiter)) {
    const candidate = path.join(folder, process.platform === "win32" ? "rg.exe" : "rg")
    try { await access(candidate); return candidate } catch { /* continue through current PATH */ }
  }
  throw new Error("The phase 9 test requires the already installed local ripgrep executable.")
}

test("ripgrep MCP integration searches a non-Git workspace with paging, ignore rules and large files", async (t) => {
  const testsRoot = path.join(projectRoot, ".tmp", "tests")
  await mkdir(testsRoot, { recursive: true })
  const sandbox = await mkdtemp(path.join(testsRoot, "rg-search-中文-"))
  const dataDir = path.join(sandbox, "data")
  const tempDir = path.join(sandbox, "tmp")
  const workspaceRoot = path.join(sandbox, "search workspace with spaces")
  const sourceDir = path.join(workspaceRoot, "src 中文")
  await Promise.all([mkdir(dataDir), mkdir(tempDir), mkdir(sourceDir, { recursive: true })])
  await writeFile(path.join(sourceDir, "sample file.ts"), "start\nneedle alpha\nmiddle\nneedle beta\nend\n")
  await writeFile(path.join(workspaceRoot, ".gitignore"), "ignored.ts\n")
  await writeFile(path.join(workspaceRoot, "ignored.ts"), "needle must-not-appear\n")
  await writeFile(path.join(workspaceRoot, "binary.bin"), Buffer.from([0, 1, 2, 110, 101, 101, 100, 108, 101, 0]))
  const large = Buffer.alloc(1_300_000, 120)
  const marker = Buffer.from("LATE_MAGIC\n")
  marker.copy(large, large.length - marker.length)
  await writeFile(path.join(workspaceRoot, "large source.txt"), large)

  const rgPath = await discoverRg()
  const port = await freePort()
  const origin = `http://127.0.0.1:${port}`
  const env = { ...process.env, CHATCODE_HOME: projectRoot, CHATCODE_DATA_DIR: dataDir, CHATCODE_TMP_DIR: tempDir, CHATCODE_PORT: String(port) }
  const admin = spawn(process.execPath, [path.join(projectRoot, "apps", "server", "admin.mjs")], { cwd: projectRoot, env, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] })
  let adminOutput = ""
  admin.stdout.on("data", (chunk) => { adminOutput = (adminOutput + chunk.toString("utf8")).slice(-3000) })
  admin.stderr.on("data", (chunk) => { adminOutput = (adminOutput + chunk.toString("utf8")).slice(-3000) })
  let client
  let transport
  t.after(async () => {
    if (client) await client.close().catch(() => transport?.close().catch(() => {}))
    else await transport?.close().catch(() => {})
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
  const added = await post("/api/workspaces", { name: "ripgrep fixture", path: workspaceRoot, mode: "readOnly" })
  if (added.status !== 201) throw new Error(`workspace setup returned ${added.status}: ${await added.text()}`)
  const workspace = (await added.json()).workspace
  const mcpEnv = {
    SystemRoot: process.env.SystemRoot ?? "C:\\Windows", SystemDrive: process.env.SystemDrive ?? "C:",
    PATH: [path.dirname(process.execPath), path.join(process.env.SystemRoot ?? "C:\\Windows", "System32")].join(path.delimiter),
    CHATCODE_HOME: projectRoot, CHATCODE_DATA_DIR: dataDir, CHATCODE_TMP_DIR: tempDir, CHATCODE_RG_PATH: rgPath,
  }
  transport = new StdioClientTransport({ command: process.execPath, args: [path.join(projectRoot, "apps", "server", "mcp.mjs")], cwd: projectRoot, env: mcpEnv, stderr: "pipe" })
  client = new Client({ name: "chatcode-ripgrep-integration", version: "1.0.0" })
  await client.connect(transport)
  const call = async (name, args) => {
    const result = await client.callTool({ name, arguments: args })
    if (result.isError) throw new Error(`${name}: ${result.structuredContent?.error ?? result.content?.[0]?.text ?? "MCP tool failed"}`)
    return result.structuredContent
  }

  const status = await call("get_code_search_status", {})
  assert.equal(status.available, true, JSON.stringify(status))
  assert.match(status.version, /^15\.2\.0$/)
  assert.match(status.sha256, /^[a-f0-9]{64}$/)
  const base = {
    workspace_id: workspace.id, query: "needle", engine: "fixed", path: "", include: [], exclude: [],
    case_sensitive: false, respect_ignore: true, context: 1, limit: 1,
  }
  const page1 = await call("search_code", { ...base, request_id: randomUUID() })
  assert.equal(page1.available, true)
  assert.equal(page1.total_matches, 2, JSON.stringify(page1.matches))
  assert.equal(page1.matches[0].path, "src 中文/sample file.ts")
  assert.deepEqual(page1.matches[0].context_before.map((item) => item.text), ["start"])
  assert.deepEqual(page1.matches[0].context_after.map((item) => item.text), ["middle"])
  assert.ok(page1.next_cursor)
  const page2 = await call("search_code", { ...base, cursor: page1.next_cursor, request_id: randomUUID() })
  assert.equal(page2.matches.length, 1)
  assert.deepEqual(page2.matches[0].context_before.map((item) => item.text), ["middle"])
  assert.deepEqual(page2.matches[0].context_after.map((item) => item.text), ["end"])
  assert.equal(page2.next_cursor, null)

  const largeResult = await call("search_code", {
    ...base, query: "LATE_MAGIC", include: ["*.txt"], context: 0, limit: 10, request_id: randomUUID(),
  })
  assert.equal(largeResult.total_matches, 1)
  assert.equal(largeResult.matches[0].path, "large source.txt")
  assert.equal(largeResult.matches[0].line, 1)
  const traversal = await client.callTool({ name: "search_code", arguments: { ...base, path: "../outside", request_id: randomUUID() } })
  assert.equal(traversal.isError, true)

  const evidenceDir = path.join(projectRoot, ".tmp", "phase9")
  await mkdir(evidenceDir, { recursive: true })
  await writeFile(path.join(evidenceDir, "a3-ripgrep-evidence.json"), JSON.stringify({
    result: "PASS", workspace_id: workspace.id, binary: { path: status.path, version: status.version, sha256: status.sha256 },
    source_files: page1.matches.concat(page2.matches), large_file: largeResult.matches[0], ignored_file_excluded: true,
    binary_file_filtered: true, non_git_workspace: true,
  }, null, 2) + "\n", "utf8")
})
