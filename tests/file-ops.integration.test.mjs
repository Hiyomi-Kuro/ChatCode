import assert from "node:assert/strict"
import { lstat, mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises"
import { spawn } from "node:child_process"
import path from "node:path"
import { createHash, randomUUID } from "node:crypto"
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

function hash(bytes) {
  return createHash("sha256").update(bytes).digest("hex")
}

test("file lifecycle MCP: Win32 copy/move/case-rename/soft-delete/restore and rollback", async (t) => {
  const testsRoot = path.join(projectRoot, ".tmp", "tests")
  await mkdir(testsRoot, { recursive: true })
  const sandbox = await mkdtemp(path.join(testsRoot, "file-ops-"))
  const dataDir = path.join(sandbox, "data")
  const tempDir = path.join(sandbox, "tmp")
  const workspaceRoot = path.join(sandbox, "authorized workspace 中文")
  const deniedWorkspaceRoot = path.join(sandbox, "no destructive scope")
  await Promise.all([mkdir(dataDir), mkdir(tempDir), mkdir(workspaceRoot), mkdir(deniedWorkspaceRoot)])

  const sourceRoot = path.join(workspaceRoot, "source pack 中文")
  const nestedRoot = path.join(sourceRoot, "子目录 with spaces")
  await mkdir(nestedRoot, { recursive: true })
  const binary = Buffer.from([0, 1, 2, 13, 10, 0, 255, 128, 42, 0, 99])
  await writeFile(path.join(sourceRoot, "Name.txt"), "case-sensitive path on a case-insensitive volume\r\n", "utf8")
  await writeFile(path.join(nestedRoot, "内容.bin"), binary)
  await writeFile(path.join(nestedRoot, "readme 中文.md"), "copy/move/restore fixture\n", "utf8")
  await writeFile(path.join(deniedWorkspaceRoot, "keep.bin"), binary)

  const previousHome = process.env.CHATCODE_HOME
  const previousDataDir = process.env.CHATCODE_DATA_DIR
  const previousTmpDir = process.env.CHATCODE_TMP_DIR
  const port = await freePort()
  const origin = `http://127.0.0.1:${port}`
  const env = {
    ...process.env,
    CHATCODE_HOME: projectRoot,
    CHATCODE_DATA_DIR: dataDir,
    CHATCODE_TMP_DIR: tempDir,
    CHATCODE_PORT: String(port),
  }
  const admin = spawn(process.execPath, [path.join(projectRoot, "apps", "server", "admin.mjs")], {
    cwd: projectRoot, env, windowsHide: true, stdio: ["ignore", "pipe", "pipe"],
  })
  let adminOutput = ""
  admin.stdout.on("data", (chunk) => { adminOutput = (adminOutput + chunk.toString("utf8")).slice(-4000) })
  admin.stderr.on("data", (chunk) => { adminOutput = (adminOutput + chunk.toString("utf8")).slice(-4000) })
  let transport
  let client
  t.after(async () => {
    if (client) await client.close().catch(() => transport?.close().catch(() => {}))
    else await transport?.close().catch(() => {})
    if (admin.exitCode === null) {
      admin.kill()
      await Promise.race([new Promise((resolve) => admin.once("close", resolve)), delay(2_000)])
    }
    try {
      const root = path.resolve(testsRoot)
      const target = path.resolve(sandbox)
      const relative = path.relative(root, target)
      if (relative && !relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative)) await rm(target, { recursive: true, force: true })
    } finally {
      if (previousHome === undefined) delete process.env.CHATCODE_HOME
      else process.env.CHATCODE_HOME = previousHome
      if (previousDataDir === undefined) delete process.env.CHATCODE_DATA_DIR
      else process.env.CHATCODE_DATA_DIR = previousDataDir
      if (previousTmpDir === undefined) delete process.env.CHATCODE_TMP_DIR
      else process.env.CHATCODE_TMP_DIR = previousTmpDir
    }
  })

  let session
  for (let attempt = 0; attempt < 80; attempt++) {
    if (admin.exitCode !== null) throw new Error(`ChatCode admin exited during file-ops setup.\n${adminOutput}`)
    try {
      const response = await fetch(`${origin}/api/session`)
      if (response.ok) { session = await response.json(); break }
    } catch { /* wait for the isolated test admin */ }
    await delay(100)
  }
  assert.ok(session?.csrf, `isolated admin did not start.\n${adminOutput}`)
  const post = (route, body = {}) => fetch(`${origin}${route}`, {
    method: "POST",
    headers: { Origin: origin, "X-ChatCode-CSRF": session.csrf, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  })
  const addWorkspace = async (name, root) => {
    const response = await post("/api/workspaces", { name, path: root, mode: "autoWritable", confirmAutoWrite: true })
    if (response.status !== 201) throw new Error(`workspace setup returned ${response.status}: ${await response.text()}`)
    return (await response.json()).workspace
  }
  const workspace = await addWorkspace("File operations fixture", workspaceRoot)
  const deniedWorkspace = await addWorkspace("No file lifecycle grant", deniedWorkspaceRoot)
  const grant = await post(`/api/workspaces/${workspace.id}/execution-profile/enable`, { confirmUnattendedDev: true, fileLifecycle: true })
  assert.equal(grant.status, 200, await grant.text())
  const deniedGrant = await post(`/api/workspaces/${deniedWorkspace.id}/execution-profile/enable`, { confirmUnattendedDev: true, gitReadOnly: true, fileLifecycle: false })
  assert.equal(deniedGrant.status, 200, await deniedGrant.text())

  const mcpEnv = {
    SystemRoot: process.env.SystemRoot ?? "C:\\Windows",
    SystemDrive: process.env.SystemDrive ?? "C:",
    PATH: [path.dirname(process.execPath), path.join(process.env.SystemRoot ?? "C:\\Windows", "System32")].join(path.delimiter),
    CHATCODE_HOME: projectRoot,
    CHATCODE_DATA_DIR: dataDir,
    CHATCODE_TMP_DIR: tempDir,
  }
  transport = new StdioClientTransport({
    command: process.execPath, args: [path.join(projectRoot, "apps", "server", "mcp.mjs")],
    cwd: projectRoot, env: mcpEnv, stderr: "pipe",
  })
  client = new Client({ name: "chatcode-file-ops-integration", version: "1.0.0" })
  await client.connect(transport)
  const listing = await client.listTools()
  const names = new Set(listing.tools.map((tool) => tool.name))
  for (const name of ["get_path_manifest", "copy_path", "move_path", "rename_path", "delete_path", "restore_deleted_path", "list_recovery_items", "apply_file_operations"]) {
    assert.ok(names.has(name), `missing file lifecycle MCP tool: ${name}`)
  }
  const legacy = JSON.parse(await readFile(path.join(projectRoot, "tests", "legacy-mcp-tools.json"), "utf8"))
  for (const name of legacy) assert.ok(names.has(name), `legacy tool disappeared: ${name}`)

  const call = async (name, args) => {
    const result = await client.callTool({ name, arguments: args }, { timeout: 300_000 })
    if (result.isError) throw new Error(`${name}: ${result.structuredContent?.error ?? result.content?.[0]?.text ?? "MCP tool failed"}`)
    return result.structuredContent
  }
  const expectError = async (name, args, pattern) => {
    const result = await client.callTool({ name, arguments: args })
    assert.equal(result.isError, true, `${name} should reject this input`)
    assert.match(result.structuredContent?.error ?? result.content?.[0]?.text ?? "", pattern)
  }
  const manifest = await call("get_path_manifest", { workspace_id: workspace.id, path: "source pack 中文" })
  assert.equal(manifest.object_type, "directory")
  assert.equal(manifest.entry_count, 5)
  assert.equal(manifest.complete, true)
  assert.equal(manifest.entries.find((item) => item.relative.endsWith("内容.bin")).sha256, hash(binary))
  const copyArgs = {
    workspace_id: workspace.id, source_path: "source pack 中文", destination_path: "copy output",
    expected_manifest_sha256: manifest.manifest_sha256, request_id: randomUUID(),
  }
  const copied = await call("copy_path", copyArgs)
  assert.equal(copied.status, "committed")
  assert.equal(copied.manifest_sha256, manifest.manifest_sha256)
  assert.deepEqual(await readFile(path.join(workspaceRoot, "copy output", "子目录 with spaces", "内容.bin")), binary)
  assert.equal(hash(await readFile(path.join(workspaceRoot, "copy output", "Name.txt"))), hash(await readFile(path.join(sourceRoot, "Name.txt"))))
  const retriedCopy = await call("copy_path", copyArgs)
  assert.equal(retriedCopy.operation_id, copied.operation_id)
  await expectError("copy_path", { ...copyArgs, destination_path: "different output" }, /幂等键/)
  await expectError("copy_path", { ...copyArgs, destination_path: "copy output" , request_id: randomUUID() }, /目标路径已存在/)
  await expectError("copy_path", { ...copyArgs, destination_path: "source pack 中文/nested" , request_id: randomUUID() }, /重叠/)

  const batch = await call("apply_file_operations", {
    workspace_id: workspace.id, request_id: randomUUID(), operations: [
      { action: "copy", source_path: "source pack 中文", destination_path: "batch candidate", expected_manifest_sha256: manifest.manifest_sha256 },
      { action: "copy", source_path: "source pack 中文", destination_path: "copy output", expected_manifest_sha256: manifest.manifest_sha256 },
    ],
  })
  assert.equal(batch.status, "rolled_back", JSON.stringify(batch))
  await assert.rejects(lstat(path.join(workspaceRoot, "batch candidate")), { code: "ENOENT" })

  const copyManifest = await call("get_path_manifest", { workspace_id: workspace.id, path: "copy output" })
  const move = await call("move_path", {
    workspace_id: workspace.id, source_path: "copy output", destination_path: "moved output",
    expected_manifest_sha256: copyManifest.manifest_sha256, request_id: randomUUID(),
  })
  assert.equal(move.status, "committed")
  assert.equal(move.atomic, false)
  await assert.rejects(lstat(path.join(workspaceRoot, "copy output")), { code: "ENOENT" })
  assert.deepEqual(await readFile(path.join(workspaceRoot, "moved output", "子目录 with spaces", "内容.bin")), binary)

  const nameManifest = await call("get_path_manifest", { workspace_id: workspace.id, path: "moved output/Name.txt" })
  const renamed = await call("rename_path", {
    workspace_id: workspace.id, source_path: "moved output/Name.txt", new_name: "name.txt",
    expected_manifest_sha256: nameManifest.manifest_sha256, request_id: randomUUID(),
  })
  assert.equal(renamed.status, "committed")
  assert.equal(renamed.case_only, true)
  assert.deepEqual(await readFile(path.join(workspaceRoot, "moved output", "name.txt")), Buffer.from("case-sensitive path on a case-insensitive volume\r\n"))
  const renamedNames = await readdir(path.join(workspaceRoot, "moved output"))
  assert.ok(renamedNames.includes("name.txt"))
  assert.ok(!renamedNames.includes("Name.txt"))

  const movedManifest = await call("get_path_manifest", { workspace_id: workspace.id, path: "moved output" })
  const deleted = await call("delete_path", {
    workspace_id: workspace.id, path: "moved output", expected_manifest_sha256: movedManifest.manifest_sha256, request_id: randomUUID(),
  })
  assert.equal(deleted.status, "committed")
  assert.ok(deleted.recovery_id)
  await assert.rejects(lstat(path.join(workspaceRoot, "moved output")), { code: "ENOENT" })
  const recoveryItems = await call("list_recovery_items", { workspace_id: workspace.id })
  assert.ok(recoveryItems.recoveries.some((item) => item.recovery_id === deleted.recovery_id))
  assert.ok(await readdir(path.join(dataDir, "file-recovery", workspace.id)).then((items) => items.length > 0))
  const restored = await call("restore_deleted_path", { workspace_id: workspace.id, recovery_id: deleted.recovery_id, request_id: randomUUID() })
  assert.equal(restored.status, "restored")
  assert.deepEqual(await readFile(path.join(workspaceRoot, "moved output", "子目录 with spaces", "内容.bin")), binary)
  assert.deepEqual(await readFile(path.join(workspaceRoot, "moved output", "name.txt")), Buffer.from("case-sensitive path on a case-insensitive volume\r\n"))
  const restoredAgain = await call("restore_deleted_path", { workspace_id: workspace.id, recovery_id: deleted.recovery_id, request_id: randomUUID() })
  assert.equal(restoredAgain.status, "restored")

  const moveRecovery = await call("restore_deleted_path", { workspace_id: workspace.id, recovery_id: move.recovery_id, request_id: randomUUID() })
  assert.equal(moveRecovery.status, "restored")
  assert.deepEqual(await readFile(path.join(workspaceRoot, "copy output", "子目录 with spaces", "内容.bin")), binary)

  await expectError("delete_path", {
    workspace_id: deniedWorkspace.id, path: "keep.bin", expected_manifest_sha256: (await call("get_path_manifest", { workspace_id: deniedWorkspace.id, path: "keep.bin" })).manifest_sha256, request_id: randomUUID(),
  }, /fileLifecycle/)
  assert.deepEqual(await readFile(path.join(deniedWorkspaceRoot, "keep.bin")), binary)
  await expectError("get_path_manifest", { workspace_id: workspace.id, path: "../outside" }, /路径/)

  let junctionAvailable = true
  try { await symlink(deniedWorkspaceRoot, path.join(workspaceRoot, "junction"), "junction") }
  catch { junctionAvailable = false }
  if (junctionAvailable) await expectError("get_path_manifest", { workspace_id: workspace.id, path: "junction" }, /链接|reparse|path/i)

  const evidenceDir = path.join(projectRoot, ".tmp", "phase9")
  await mkdir(evidenceDir, { recursive: true })
  await writeFile(path.join(evidenceDir, "a1-file-ops-evidence.json"), JSON.stringify({
    result: "PASS", platform: process.platform, workspace_id: workspace.id, binary_sha256: hash(binary),
    initial_manifest_sha256: manifest.manifest_sha256, copied_manifest_sha256: copied.manifest_sha256,
    operation_ids: { copy: copied.operation_id, batch: batch.operation_id, move: move.operation_id, rename: renamed.operation_id, delete: deleted.operation_id },
    recovery_ids: { move: move.recovery_id, delete: deleted.recovery_id },
    verified: ["real Win32 directory copy", "binary bytes and SHA-256", "request id idempotency", "destination conflict", "source-target overlap", "batch rollback", "move", "case-only rename", "soft delete to durable recovery", "restore", "fileLifecycle denial", "path traversal denial", junctionAvailable ? "junction denial" : "junction creation unavailable"],
  }, null, 2) + "\n", "utf8")
})
