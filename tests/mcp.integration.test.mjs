import assert from "node:assert/strict"
import { appendFile, link, mkdtemp, mkdir, readFile, rm, stat, symlink, truncate, writeFile } from "node:fs/promises"
import { spawn } from "node:child_process"
import { execFileSync } from "node:child_process"
import { createServer } from "node:net"
import path from "node:path"
import { createHash, randomUUID } from "node:crypto"
import { fileURLToPath } from "node:url"
import { setTimeout as delay } from "node:timers/promises"
import { test } from "node:test"
import { Client } from "@modelcontextprotocol/client"
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio"
import { createTwoFilesPatch } from "diff"

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")

async function freePort() {
  const server = createServer()
  await new Promise((resolve, reject) => server.once("error", reject).listen(0, "127.0.0.1", resolve))
  const port = server.address().port
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
  return port
}

test("MCP stdio: discovery, bounded reads, approvals, file writes, directory creation, and a controlled check", async (t) => {
  await mkdir(path.join(projectRoot, ".tmp", "tests"), { recursive: true })
  const sandbox = await mkdtemp(path.join(projectRoot, ".tmp", "tests", "mcp-"))
  const adminFixtureRoot = path.join(projectRoot, ".tmp", "tests", `admin-fixture-${randomUUID()}`)
  const dataDir = path.join(sandbox, "data")
  const tempDir = path.join(sandbox, "tmp")
  const workspaceRoot = path.join(sandbox, "workspace")
  const outsideRoot = path.join(sandbox, "outside")
  await Promise.all([mkdir(dataDir, { recursive: true }), mkdir(tempDir, { recursive: true }), mkdir(workspaceRoot, { recursive: true }), mkdir(outsideRoot, { recursive: true }), mkdir(adminFixtureRoot, { recursive: true })])

  const workspaceId = randomUUID()
  const parentWorkspaceId = randomUUID()
  await writeFile(path.join(workspaceRoot, "README.md"), "first line\nsecond line\n", "utf8")
  await writeFile(path.join(workspaceRoot, "race.md"), "version one\n", "utf8")
  await writeFile(path.join(workspaceRoot, ".env"), "CHATCODE_TEST_SECRET=blocked\n", "utf8")
  await Promise.all([mkdir(path.join(workspaceRoot, ".git"), { recursive: true }), mkdir(path.join(workspaceRoot, ".tmp"), { recursive: true }), mkdir(path.join(workspaceRoot, "node_modules", "pkg"), { recursive: true })])
  await writeFile(path.join(workspaceRoot, ".tmp", "private.txt"), "private temp\n", "utf8")
  await writeFile(path.join(workspaceRoot, "node_modules", "pkg", "index.js"), "export default 1\n", "utf8")
  await mkdir(path.join(workspaceRoot, "src"), { recursive: true })
  const appSource = "import value from 'pkg'\nexport const ready = true\n"
  await writeFile(path.join(workspaceRoot, "src", "app.ts"), appSource, "utf8")
  const manifest = { name: "chatcode-fixture", scripts: {
    test: "node -e \"process.stdout.write('chatcode controlled test passed')\"",
    build: "node -e \"setTimeout(() => process.exit(0), 8000)\"",
  } }
  await writeFile(path.join(workspaceRoot, "package.json"), `${JSON.stringify(manifest, null, 2)}\n`, "utf8")
  await writeFile(path.join(outsideRoot, "secret.txt"), "outside data must not be readable\n", "utf8")
  await writeFile(path.join(workspaceRoot, "hardlink-source.txt"), "hard link content\n", "utf8")
  const gitEnv = {
    SystemRoot: process.env.SystemRoot ?? "C:\\Windows",
    SystemDrive: process.env.SystemDrive ?? "C:",
    PATH: process.env.PATH ?? "",
    HOME: tempDir,
    USERPROFILE: tempDir,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "NUL",
    GIT_TERMINAL_PROMPT: "0",
  }
  execFileSync("git", ["init", "--quiet"], { cwd: workspaceRoot, env: gitEnv, windowsHide: true })
  execFileSync("git", ["-c", "user.name=ChatCode Test", "-c", "user.email=chatcode-test@example.invalid", "add", "--", "README.md", ".env"], { cwd: workspaceRoot, env: gitEnv, windowsHide: true })
  execFileSync("git", ["-c", "user.name=ChatCode Test", "-c", "user.email=chatcode-test@example.invalid", "commit", "--quiet", "-m", "fixture", "--", "README.md", ".env"], { cwd: workspaceRoot, env: gitEnv, windowsHide: true })
  await writeFile(path.join(dataDir, "workspaces.json"), `${JSON.stringify([
    { id: workspaceId, name: "MCP fixture", root: workspaceRoot, mode: "writable", status: "active", createdAt: new Date().toISOString() },
    { id: parentWorkspaceId, name: "Containing test sandbox", root: sandbox, mode: "writable", status: "active", createdAt: new Date().toISOString() },
  ])}\n`, "utf8")

  let junctionAvailable = true
  try { await symlink(outsideRoot, path.join(workspaceRoot, "junction"), "junction") } catch { junctionAvailable = false }
  let hardlinkAvailable = true
  try { await link(path.join(workspaceRoot, "hardlink-source.txt"), path.join(workspaceRoot, "hardlink-leak.txt")) } catch { hardlinkAvailable = false }

  const previousDataDir = process.env.CHATCODE_DATA_DIR
  const previousTmpDir = process.env.CHATCODE_TMP_DIR
  process.env.CHATCODE_DATA_DIR = dataDir
  process.env.CHATCODE_TMP_DIR = tempDir
  const workspaces = await import("../apps/server/core/workspaces.mjs")

  const adminPort = await freePort()
  const adminOrigin = `http://127.0.0.1:${adminPort}`
  const admin = spawn(process.execPath, [path.join(projectRoot, "apps", "server", "admin.mjs")], {
    cwd: projectRoot,
    env: { ...process.env, CHATCODE_HOME: projectRoot, CHATCODE_DATA_DIR: dataDir, CHATCODE_TMP_DIR: tempDir, CHATCODE_PORT: String(adminPort) },
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
  })
  let transport
  let client
  t.after(async () => {
    if (client) {
      try { await client.close() } catch { try { await transport?.close() } catch { /* already closed */ } }
    } else {
      try { await transport?.close() } catch { /* not connected */ }
    }
    if (admin.exitCode === null) {
      admin.kill()
      await Promise.race([new Promise((resolve) => admin.once("close", resolve)), delay(2_000)])
    }
    try {
      const testsRoot = path.resolve(projectRoot, ".tmp", "tests")
      for (const target of [sandbox, adminFixtureRoot]) {
        const absolute = path.resolve(target)
        const relative = path.relative(testsRoot, absolute)
        if (relative && !relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative)) await rm(absolute, { recursive: true, force: true })
      }
    } finally {
      if (previousDataDir === undefined) delete process.env.CHATCODE_DATA_DIR
      else process.env.CHATCODE_DATA_DIR = previousDataDir
      if (previousTmpDir === undefined) delete process.env.CHATCODE_TMP_DIR
      else process.env.CHATCODE_TMP_DIR = previousTmpDir
    }
  })
  let adminOutput = ""
  admin.stdout.on("data", (chunk) => { adminOutput = (adminOutput + chunk.toString("utf8")).slice(-4000) })
  admin.stderr.on("data", (chunk) => { adminOutput = (adminOutput + chunk.toString("utf8")).slice(-4000) })
  let session
  for (let attempt = 0; attempt < 60; attempt++) {
    if (admin.exitCode !== null) throw new Error(`ChatCode admin exited during startup.\n${adminOutput}`)
    try {
      const response = await fetch(`${adminOrigin}/api/session`)
      if (response.ok) { session = await response.json(); break }
    } catch { /* server is still starting */ }
    await delay(100)
  }
  if (!session?.csrf) throw new Error(`ChatCode admin did not become ready.\n${adminOutput}`)
  const adminPost = async (route, body = {}) => fetch(`${adminOrigin}${route}`, {
    method: "POST",
    headers: { Origin: adminOrigin, "X-ChatCode-CSRF": session.csrf, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  })

  const systemRoot = process.env.SystemRoot ?? "C:\\Windows"
  const gitExecutable = execFileSync(path.join(systemRoot, "System32", "where.exe"), ["git.exe"], { encoding: "utf8", env: gitEnv }).trim().split(/\r?\n/)[0]
  const env = {
    CHATCODE_HOME: projectRoot,
    CHATCODE_DATA_DIR: dataDir,
    CHATCODE_TMP_DIR: tempDir,
    SystemRoot: systemRoot,
    SystemDrive: process.env.SystemDrive ?? "C:",
    PATH: [path.dirname(process.execPath), path.dirname(gitExecutable), path.join(systemRoot, "System32")].join(path.delimiter),
  }
  transport = new StdioClientTransport({
    command: process.execPath,
    args: [path.join(projectRoot, "apps", "server", "mcp.mjs")],
    cwd: projectRoot,
    env,
    stderr: "pipe",
  })
  const stderr = transport.stderr
  let startupStderr = ""
  stderr?.on("data", (chunk) => { startupStderr = (startupStderr + chunk.toString("utf8")).slice(-6000) })
  client = new Client({ name: "chatcode-integration-test", version: "1.0.0" })

  try {
    const noOrigin = await fetch(`${adminOrigin}/api/workspaces`, { method: "POST", body: JSON.stringify({ name: "blocked" }) })
    assert.equal(noOrigin.status, 403)
    const badCsrf = await fetch(`${adminOrigin}/api/workspaces`, { method: "POST", headers: { Origin: adminOrigin, "X-ChatCode-CSRF": "wrong", "Content-Type": "application/json" }, body: JSON.stringify({ name: "blocked" }) })
    assert.equal(badCsrf.status, 403)
    const extraWorkspaceResponse = await adminPost("/api/workspaces", { name: "Admin fixture", path: adminFixtureRoot, mode: "readOnly" })
    assert.equal(extraWorkspaceResponse.status, 201)
    const extraWorkspace = (await extraWorkspaceResponse.json()).workspace
    assert.ok((await (await fetch(`${adminOrigin}/api/workspaces`)).json()).workspaces.some((item) => item.id === extraWorkspace.id))
    assert.equal((await adminPost(`/api/workspaces/${extraWorkspace.id}/remove`)).status, 200)
    assert.equal((await adminPost("/api/workspaces", { name: "Nested fixture", path: path.join(workspaceRoot, "src"), mode: "readOnly" })).status, 400)
    assert.equal((await adminPost("/api/workspaces", { name: "Managed data", path: dataDir, mode: "writable" })).status, 400)

    await client.connect(transport)
    const catalog = await client.listTools()
    const names = new Set(catalog.tools.map((tool) => tool.name))
    const toolMap = new Map(catalog.tools.map((tool) => [tool.name, tool]))
    const legacyNames = JSON.parse(await readFile(path.join(projectRoot, "tests", "legacy-mcp-tools.json"), "utf8"))
    assert.equal(legacyNames.length, 42, "the original ChatCode MCP baseline has 42 tool names")
    for (const name of legacyNames) assert.ok(names.has(name), `legacy MCP tool disappeared: ${name}`)
    const phase9Names = [
      "get_path_manifest", "copy_path", "move_path", "rename_path", "delete_path", "restore_deleted_path", "list_recovery_items", "recover_file_operation", "apply_file_operations",
      "get_lsp_status", "get_file_diagnostics", "get_workspace_diagnostics", "go_to_definition", "find_references", "get_document_symbols", "search_workspace_symbols", "get_hover",
      "get_code_search_status", "search_code", "cancel_code_search",
      "get_git_runtime_status", "git_log", "git_branch", "git_preview_commit", "git_commit", "recover_git_commit", "git_create_worktree", "git_list_worktrees", "git_remove_worktree",
    ]
    for (const name of phase9Names) assert.ok(names.has(name), `missing Phase 9 MCP tool: ${name}`)
    for (const name of ["list_workspaces", "read_file", "read_file_chunk", "begin_write", "write_chunk", "commit_write", "abort_write", "write_file", "git_status", "git_diff", "stage_file_write", "stage_unified_patch", "apply_change", "request_project_check", "run_approved_check"]) assert.ok(names.has(name), `missing MCP tool: ${name}`)
    assert.equal(names.has("update_workspace"), false, "MCP must not expose workspace permission changes")
    assert.equal(toolMap.get("read_file").annotations.readOnlyHint, true)
    assert.equal(toolMap.get("stage_file_write").annotations.readOnlyHint, false)
    assert.equal(toolMap.get("apply_change").annotations.destructiveHint, true)
    assert.equal(toolMap.get("abort_write").annotations.destructiveHint, false)
    assert.equal(toolMap.get("abort_write").annotations.idempotentHint, true)

    const currentCatalog = await client.callTool({ name: "get_tool_catalog", arguments: {} })
    assert.notEqual(currentCatalog.isError, true, JSON.stringify(currentCatalog))
    const catalogNames = Object.values(currentCatalog.structuredContent.groups).flat().map((item) => item.name).sort()
    assert.deepEqual(catalogNames, [...names].sort(), "get_tool_catalog and tools/list must report the same names")
    for (const capabilityTool of ["get_lsp_status", "get_code_search_status", "get_git_runtime_status"]) {
      const capability = await client.callTool({ name: capabilityTool, arguments: {} })
      assert.notEqual(capability.isError, true, JSON.stringify(capability))
    }

    const listed = await client.callTool({ name: "list_workspaces", arguments: {} })
    assert.notEqual(listed.isError, true)
    assert.equal(listed.structuredContent.workspaces[0].id, workspaceId)
    assert.equal("path" in listed.structuredContent.workspaces[0], false)

    const page = await client.callTool({ name: "list_files", arguments: { workspace_id: workspaceId, path: "", offset: 2, limit: 1 } })
    assert.ok(page.structuredContent.entries.length <= 1)
    assert.ok(page.structuredContent.next_offset !== null)
    const visible = await client.callTool({ name: "list_files", arguments: { workspace_id: workspaceId, path: "", limit: 20 } })
    assert.ok(visible.structuredContent.entries.some((entry) => entry.name === "README.md"))
    assert.ok(!visible.structuredContent.entries.some((entry) => [".env", ".git", ".tmp", "junction", "node_modules"].includes(entry.name)))
    await mkdir(path.join(workspaceRoot, "cursor-list"), { recursive: true })
    for (const name of ["a.txt", "b.txt", "c.txt"]) await writeFile(path.join(workspaceRoot, "cursor-list", name), name, "utf8")
    const cursorListOne = await client.callTool({ name: "list_files", arguments: { workspace_id: workspaceId, path: "cursor-list", cursor: "", limit: 1 } })
    assert.equal(cursorListOne.structuredContent.entries.length, 1)
    assert.ok(cursorListOne.structuredContent.next_cursor)
    const cursorListTwo = await client.callTool({ name: "list_files", arguments: {
      workspace_id: workspaceId, path: "cursor-list", cursor: cursorListOne.structuredContent.next_cursor, limit: 1,
    } })
    assert.equal(cursorListTwo.structuredContent.entries.length, 1)
    assert.notEqual(cursorListTwo.structuredContent.entries[0].name, cursorListOne.structuredContent.entries[0].name)
    const read = await client.callTool({ name: "read_file", arguments: { workspace_id: workspaceId, path: "README.md", start_line: 1, line_count: 2 } })
    assert.equal(read.structuredContent.content, "first line\nsecond line")
    assert.match(read.structuredContent.sha256, /^[a-f0-9]{64}$/)

    const traversal = await client.callTool({ name: "read_file", arguments: { workspace_id: workspaceId, path: "../outside/secret.txt" } })
    assert.equal(traversal.isError, true)
    const sensitive = await client.callTool({ name: "read_file", arguments: { workspace_id: workspaceId, path: ".env" } })
    assert.equal(sensitive.isError, true)
    const gitStatus = await client.callTool({ name: "git_status", arguments: { workspace_id: workspaceId } })
    assert.notEqual(gitStatus.isError, true, JSON.stringify(gitStatus))
    await writeFile(path.join(workspaceRoot, ".env"), "CHATCODE_TEST_SECRET=changed\n", "utf8")
    const allDiff = await client.callTool({ name: "git_diff", arguments: { workspace_id: workspaceId } })
    assert.notEqual(allDiff.isError, true, JSON.stringify(allDiff))
    assert.equal(allDiff.structuredContent.diff, "")
    const sensitiveGitDiff = await client.callTool({ name: "git_diff", arguments: { workspace_id: workspaceId, path: ".env" } })
    assert.equal(sensitiveGitDiff.isError, true)
    for (const protectedPath of [".git/config", ".tmp/private.txt", "node_modules/pkg/index.js"]) {
      const hiddenRead = await client.callTool({ name: "read_file", arguments: { workspace_id: workspaceId, path: protectedPath } })
      assert.equal(hiddenRead.isError, true, `protected path was readable: ${protectedPath}`)
    }
    const managedStateRead = await client.callTool({ name: "read_file", arguments: { workspace_id: parentWorkspaceId, path: "data/workspaces.json" } })
    assert.equal(managedStateRead.isError, true)
    const managedStateWrite = await client.callTool({ name: "stage_file_write", arguments: {
      workspace_id: parentWorkspaceId,
      path: "data/workspaces.json",
      content: "[]\n",
      expected_sha256: "0".repeat(64),
    } })
    assert.equal(managedStateWrite.isError, true)
    if (hardlinkAvailable) {
      const hardlinkRead = await client.callTool({ name: "read_file", arguments: { workspace_id: workspaceId, path: "hardlink-leak.txt" } })
      assert.equal(hardlinkRead.isError, true)
    } else {
      t.diagnostic("Windows did not allow the test process to create a hard link; hard-link check was not exercised by this run")
    }

    const regex = await client.callTool({ name: "search_text", arguments: { workspace_id: workspaceId, query: "import.+from", regex: true } })
    assert.notEqual(regex.isError, true, JSON.stringify(regex))
    assert.equal(regex.structuredContent.matches[0].path, "src/app.ts")

    await writeFile(path.join(workspaceRoot, "search-cursor.txt"), "CURSOR_MATCH one\nCURSOR_MATCH two\nCURSOR_MATCH three\n", "utf8")
    const searchPageOne = await client.callTool({ name: "search_text", arguments: { workspace_id: workspaceId, query: "CURSOR_MATCH", max_results: 1 } })
    assert.notEqual(searchPageOne.isError, true, JSON.stringify(searchPageOne))
    assert.equal(searchPageOne.structuredContent.matches[0].line, 1)
    assert.ok(searchPageOne.structuredContent.next_cursor)
    const searchPageTwo = await client.callTool({ name: "search_text", arguments: {
      workspace_id: workspaceId, query: "CURSOR_MATCH", max_results: 1, cursor: searchPageOne.structuredContent.next_cursor,
    } })
    assert.notEqual(searchPageTwo.isError, true, JSON.stringify(searchPageTwo))
    assert.equal(searchPageTwo.structuredContent.matches[0].line, 2, "text search cursor must resume inside the same file")
    const searchPageThree = await client.callTool({ name: "search_text", arguments: {
      workspace_id: workspaceId, query: "CURSOR_MATCH", max_results: 1, cursor: searchPageTwo.structuredContent.next_cursor,
    } })
    assert.notEqual(searchPageThree.isError, true, JSON.stringify(searchPageThree))
    assert.equal(searchPageThree.structuredContent.matches[0].line, 3)
    const searchPageFour = await client.callTool({ name: "search_text", arguments: {
      workspace_id: workspaceId, query: "CURSOR_MATCH", max_results: 1, cursor: searchPageThree.structuredContent.next_cursor,
    } })
    assert.notEqual(searchPageFour.isError, true, JSON.stringify(searchPageFour))
    assert.equal(searchPageFour.structuredContent.matches.length, 0)
    assert.equal(searchPageFour.structuredContent.next_cursor, null)

    for (const name of ["cursor-search-a.txt", "cursor-search-b.txt", "cursor-search-c.txt"]) await writeFile(path.join(workspaceRoot, name), "", "utf8")
    const filePageOne = await client.callTool({ name: "search_files", arguments: { workspace_id: workspaceId, query: "cursor-search-", max_results: 1 } })
    assert.notEqual(filePageOne.isError, true, JSON.stringify(filePageOne))
    assert.equal(filePageOne.structuredContent.matches.length, 1)
    assert.ok(filePageOne.structuredContent.next_cursor)
    const filePageTwo = await client.callTool({ name: "search_files", arguments: {
      workspace_id: workspaceId, query: "cursor-search-", max_results: 1, cursor: filePageOne.structuredContent.next_cursor,
    } })
    assert.notEqual(filePageTwo.isError, true, JSON.stringify(filePageTwo))
    assert.equal(filePageTwo.structuredContent.matches.length, 1)
    assert.notEqual(filePageTwo.structuredContent.matches[0].path, filePageOne.structuredContent.matches[0].path)

    if (junctionAvailable) {
      const junctionRead = await client.callTool({ name: "read_file", arguments: { workspace_id: workspaceId, path: "junction/secret.txt" } })
      assert.equal(junctionRead.isError, true)
    } else {
      t.diagnostic("Windows did not allow the test process to create a junction; reparse-point check was not exercised by this run")
    }

    const before = await readFile(path.join(workspaceRoot, "README.md"), "utf8")
    const staged = await client.callTool({ name: "stage_file_write", arguments: {
      workspace_id: workspaceId,
      path: "README.md",
      content: "changed by approved MCP operation\n",
      expected_sha256: read.structuredContent.sha256,
    } })
    assert.notEqual(staged.isError, true, JSON.stringify(staged))
    assert.equal(staged.structuredContent.status, "pending_approval")
    assert.equal(await readFile(path.join(workspaceRoot, "README.md"), "utf8"), before, "staging must not write the project file")
    assert.equal((await adminPost(`/api/changes/${staged.structuredContent.change_id}/approve`)).status, 200)
    const applied = await client.callTool({ name: "apply_change", arguments: { change_id: staged.structuredContent.change_id } })
    assert.notEqual(applied.isError, true, JSON.stringify(applied))
    assert.equal(await readFile(path.join(workspaceRoot, "README.md"), "utf8"), "changed by approved MCP operation\n")
    const gitDiff = await client.callTool({ name: "git_diff", arguments: { workspace_id: workspaceId, path: "README.md" } })
    assert.notEqual(gitDiff.isError, true, JSON.stringify(gitDiff))
    assert.match(gitDiff.structuredContent.diff, /changed by approved MCP operation/)
    const allVisibleDiff = await client.callTool({ name: "git_diff", arguments: { workspace_id: workspaceId } })
    assert.notEqual(allVisibleDiff.isError, true, JSON.stringify(allVisibleDiff))
    assert.match(allVisibleDiff.structuredContent.diff, /changed by approved MCP operation/)
    const restoredResponse = await adminPost(`/api/changes/${staged.structuredContent.change_id}/recover`)
    assert.equal(restoredResponse.status, 200)
    assert.equal((await restoredResponse.json()).change.status, "reverted")
    assert.equal(await readFile(path.join(workspaceRoot, "README.md"), "utf8"), before)

    const appRead = await client.callTool({ name: "read_file", arguments: { workspace_id: workspaceId, path: "src/app.ts" } })
    const updatedReadme = "batch changed README\n"
    const updatedApp = "export const ready = false\n"
    const unifiedPatch = createTwoFilesPatch("a/README.md", "b/README.md", before, updatedReadme) + createTwoFilesPatch("a/src/app.ts", "b/src/app.ts", appSource, updatedApp)
    const batch = await client.callTool({ name: "stage_unified_patch", arguments: {
      workspace_id: workspaceId,
      unified_patch: unifiedPatch,
      expected_hashes: [
        { path: "README.md", sha256: read.structuredContent.sha256 },
        { path: "src/app.ts", sha256: appRead.structuredContent.sha256 },
      ],
    } })
    assert.notEqual(batch.isError, true, JSON.stringify(batch))
    assert.equal(batch.structuredContent.changes.length, 2)
    assert.equal(batch.structuredContent.per_file_approval, true)
    assert.equal(await readFile(path.join(workspaceRoot, "README.md"), "utf8"), before, "batch staging must not write files")
    for (const change of batch.structuredContent.changes) {
      assert.equal((await adminPost(`/api/changes/${change.change_id}/approve`)).status, 200)
      const appliedChange = await client.callTool({ name: "apply_change", arguments: { change_id: change.change_id } })
      assert.notEqual(appliedChange.isError, true, JSON.stringify(appliedChange))
    }
    assert.equal(await readFile(path.join(workspaceRoot, "README.md"), "utf8"), updatedReadme)
    assert.equal(await readFile(path.join(workspaceRoot, "src", "app.ts"), "utf8"), updatedApp)
    for (const change of batch.structuredContent.changes) assert.equal((await adminPost(`/api/changes/${change.change_id}/recover`)).status, 200)
    assert.equal(await readFile(path.join(workspaceRoot, "src", "app.ts"), "utf8"), appSource)

    const raceRead = await client.callTool({ name: "read_file", arguments: { workspace_id: workspaceId, path: "race.md" } })
    const raceStage = await client.callTool({ name: "stage_file_write", arguments: {
      workspace_id: workspaceId,
      path: "race.md",
      content: "ChatCode candidate\n",
      expected_sha256: raceRead.structuredContent.sha256,
    } })
    assert.notEqual(raceStage.isError, true)
    assert.equal((await adminPost(`/api/changes/${raceStage.structuredContent.change_id}/approve`)).status, 200)
    await writeFile(path.join(workspaceRoot, "race.md"), "user changed this after review\n", "utf8")
    const raceApply = await client.callTool({ name: "apply_change", arguments: { change_id: raceStage.structuredContent.change_id } })
    assert.equal(raceApply.isError, true)
    const raceRecovery = await adminPost(`/api/changes/${raceStage.structuredContent.change_id}/recover`)
    assert.equal(raceRecovery.status, 400)
    assert.equal(await readFile(path.join(workspaceRoot, "race.md"), "utf8"), "user changed this after review\n")

    const newFile = await client.callTool({ name: "stage_file_write", arguments: {
      workspace_id: workspaceId,
      path: "src/generated.ts",
      content: "export const generated = true\n",
      create: true,
    } })
    assert.equal(newFile.structuredContent.status, "pending_approval")
    assert.equal((await adminPost(`/api/changes/${newFile.structuredContent.change_id}/approve`)).status, 200)
    const newFileApplied = await client.callTool({ name: "apply_change", arguments: { change_id: newFile.structuredContent.change_id } })
    assert.notEqual(newFileApplied.isError, true)
    assert.equal(await readFile(path.join(workspaceRoot, "src", "generated.ts"), "utf8"), "export const generated = true\n")

    const directoryStage = await client.callTool({ name: "stage_directory_create", arguments: { workspace_id: workspaceId, path: "src/generated" } })
    assert.equal(directoryStage.structuredContent.status, "pending_approval")
    assert.equal((await adminPost(`/api/changes/${directoryStage.structuredContent.change_id}/approve`)).status, 200)
    const directoryApply = await client.callTool({ name: "apply_change", arguments: { change_id: directoryStage.structuredContent.change_id } })
    assert.notEqual(directoryApply.isError, true)
    assert.equal(directoryApply.structuredContent.status, "applied")

    const requested = await client.callTool({ name: "request_project_check", arguments: { workspace_id: workspaceId, script: "test" } })
    assert.equal(requested.structuredContent.status, "awaiting_approval")
    const unapprovedRun = await client.callTool({ name: "run_approved_check", arguments: { task_id: requested.structuredContent.task_id } })
    assert.equal(unapprovedRun.isError, true)
    assert.equal((await adminPost(`/api/tasks/${requested.structuredContent.task_id}/approve`)).status, 200)
    const started = await client.callTool({ name: "run_approved_check", arguments: { task_id: requested.structuredContent.task_id } })
    assert.notEqual(started.isError, true)
    let task
    for (let attempt = 0; attempt < 100; attempt++) {
      await delay(200)
      task = await client.callTool({ name: "get_task", arguments: { task_id: requested.structuredContent.task_id } })
      if (["succeeded", "failed", "timed_out", "cancelled"].includes(task.structuredContent.status)) break
    }
    assert.equal(task.structuredContent.status, "succeeded", `${task.structuredContent.error ?? "task failed"}\n${task.structuredContent.output}\n${startupStderr}`)
    assert.match(task.structuredContent.output, /chatcode controlled test passed/)

    const cancellationRequest = await client.callTool({ name: "request_project_check", arguments: { workspace_id: workspaceId, script: "build" } })
    assert.equal((await adminPost(`/api/tasks/${cancellationRequest.structuredContent.task_id}/approve`)).status, 200)
    const cancellationStart = await client.callTool({ name: "run_approved_check", arguments: { task_id: cancellationRequest.structuredContent.task_id } })
    assert.notEqual(cancellationStart.isError, true)
    await delay(300)
    const cancellation = await client.callTool({ name: "cancel_task", arguments: { task_id: cancellationRequest.structuredContent.task_id } })
    assert.notEqual(cancellation.isError, true, JSON.stringify(cancellation))
    assert.equal(cancellation.structuredContent.status, "cancelled")
    let cancelledTask
    for (let attempt = 0; attempt < 100; attempt++) {
      await delay(100)
      cancelledTask = await client.callTool({ name: "get_task", arguments: { task_id: cancellationRequest.structuredContent.task_id } })
      if (["cancelled", "timed_out", "failed", "succeeded"].includes(cancelledTask.structuredContent.status)) break
    }
    assert.equal(cancelledTask.structuredContent.status, "cancelled", `${cancelledTask.structuredContent.error ?? "cancellation failed"}\n${cancelledTask.structuredContent.output}`)

    const legacyWorkspace = (await (await fetch(`${adminOrigin}/api/workspaces`)).json()).workspaces.find((item) => item.id === workspaceId)
    assert.equal(legacyWorkspace.mode, "writable", "legacy writable mode must retain per-item approval")
    assert.equal((await adminPost(`/api/workspaces/${workspaceId}/auto-write`)).status, 400, "auto-write permission must require explicit local confirmation")

    const originalBinary = Buffer.from([0, 255, 128, 13, 10, 0, 65])
    const proposedBinary = Buffer.from([255, 0, 1, 2, 128, 0, 66, 10])
    const approvalBinaryPath = path.join(workspaceRoot, "binary-approval.dat")
    await writeFile(approvalBinaryPath, originalBinary)
    const binaryStat = await client.callTool({ name: "stat_file", arguments: { workspace_id: workspaceId, path: "binary-approval.dat", include_sha256: true } })
    assert.notEqual(binaryStat.isError, true, JSON.stringify(binaryStat))
    const binaryUpload = await client.callTool({ name: "begin_write", arguments: {
      workspace_id: workspaceId, path: "binary-approval.dat", size_bytes: String(proposedBinary.length),
      expected_sha256: binaryStat.structuredContent.sha256, idempotency_key: randomUUID(),
    } })
    assert.notEqual(binaryUpload.isError, true, JSON.stringify(binaryUpload))
    const binaryChunk = await client.callTool({ name: "write_chunk", arguments: {
      upload_id: binaryUpload.structuredContent.upload_id, offset_bytes: "0", data_base64: proposedBinary.toString("base64"),
    } })
    assert.notEqual(binaryChunk.isError, true, JSON.stringify(binaryChunk))
    const binaryCommit = await client.callTool({ name: "commit_write", arguments: { upload_id: binaryUpload.structuredContent.upload_id } })
    assert.notEqual(binaryCommit.isError, true, JSON.stringify(binaryCommit))
    assert.equal(binaryCommit.structuredContent.status, "pending_approval")
    assert.deepEqual(await readFile(approvalBinaryPath), originalBinary, "approval mode must leave raw target bytes unchanged before approval")
    assert.equal((await adminPost(`/api/changes/${binaryCommit.structuredContent.change_id}/approve`)).status, 200)
    const binaryApply = await client.callTool({ name: "apply_change", arguments: { change_id: binaryCommit.structuredContent.change_id } })
    assert.notEqual(binaryApply.isError, true, JSON.stringify(binaryApply))
    assert.deepEqual(await readFile(approvalBinaryPath), proposedBinary)
    assert.equal((await adminPost(`/api/changes/${binaryCommit.structuredContent.change_id}/recover`)).status, 200)
    assert.deepEqual(await readFile(approvalBinaryPath), originalBinary, "raw upload recovery must restore the exact original bytes")

    const sensitiveDenied = await client.callTool({ name: "read_file", arguments: { workspace_id: workspaceId, path: ".env" } })
    assert.equal(sensitiveDenied.isError, true)
    assert.equal((await adminPost(`/api/workspaces/${workspaceId}/sensitive-on`, { confirmSensitive: true })).status, 200)
    const sensitiveAllowed = await client.callTool({ name: "read_file", arguments: { workspace_id: workspaceId, path: ".env" } })
    assert.notEqual(sensitiveAllowed.isError, true, JSON.stringify(sensitiveAllowed))
    assert.match(sensitiveAllowed.structuredContent.content, /CHATCODE_TEST_SECRET/)
    assert.equal((await adminPost(`/api/workspaces/${workspaceId}/sensitive-off`)).status, 200)
    assert.equal((await client.callTool({ name: "read_file", arguments: { workspace_id: workspaceId, path: ".env" } })).isError, true)

    const autoResponse = await adminPost(`/api/workspaces/${workspaceId}/auto-write`, { confirmAutoWrite: true })
    assert.equal(autoResponse.status, 200)
    const autoWorkspace = (await (await fetch(`${adminOrigin}/api/workspaces`)).json()).workspaces.find((item) => item.id === workspaceId)
    assert.equal(autoWorkspace.mode, "autoWritable")
    assert.ok(autoWorkspace.autoWriteGrantedAt)

    const rawBytes = Buffer.from([0, 255, 128, 1, 0, 13, 10, 65, 66])
    const utf16BomBytes = Buffer.from([0xff, 0xfe, 0x60, 0x4f, 0x7d, 0x59, 0x0d, 0x00, 0x0a, 0x00])
    const multilingualBytes = Buffer.from("你好，世界 🌏\r\nمرحبا\n", "utf8")
    for (const name of ["opaque.exe", "opaque.dll", "opaque.apk", "opaque.zip", "opaque.rar", "opaque.7z", "opaque.pdf", "opaque.png", "opaque.jpg", "opaque.docx", "opaque.xlsx", "opaque.pptx", "opaque.mp3", "opaque.mp4", "opaque.db", "opaque.sqlite", "extensionless"]) {
      const rawWrite = await client.callTool({ name: "write_file", arguments: { workspace_id: workspaceId, path: name, data_base64: rawBytes.toString("base64") } })
      assert.notEqual(rawWrite.isError, true, `${name}: ${JSON.stringify(rawWrite)}`)
      assert.equal(rawWrite.structuredContent.status, "applied")
      assert.deepEqual(await readFile(path.join(workspaceRoot, name)), rawBytes, `${name} must round-trip without decoding`)
    }
    const auditLog = await (await fetch(`${adminOrigin}/api/audit`)).json()
    assert.ok(auditLog.events.some((event) => event.event === "file_written_direct" && event.workspaceId === workspaceId && event.path === "opaque.exe" && event.result === "uploaded"), "direct raw writes must emit an auditable path and result")
    for (const [name, bytes] of [["one-byte.bin", Buffer.from([0x42])], ["utf16-bom.txt", utf16BomBytes], ["multilingual.txt", multilingualBytes]]) {
      const result = await client.callTool({ name: "write_file", arguments: { workspace_id: workspaceId, path: name, data_base64: bytes.toString("base64") } })
      assert.notEqual(result.isError, true, `${name}: ${JSON.stringify(result)}`)
      assert.deepEqual(await readFile(path.join(workspaceRoot, name)), bytes, `${name} must retain its exact encoding bytes`)
    }

    const emptyWrite = await client.callTool({ name: "write_file", arguments: { workspace_id: workspaceId, path: "empty.bin", data_base64: "" } })
    assert.notEqual(emptyWrite.isError, true, JSON.stringify(emptyWrite))
    assert.equal((await stat(path.join(workspaceRoot, "empty.bin"))).size, 0)
    const emptyRead = await client.callTool({ name: "read_file_chunk", arguments: { workspace_id: workspaceId, path: "empty.bin", offset_bytes: "0", length_bytes: 1 } })
    assert.notEqual(emptyRead.isError, true, JSON.stringify(emptyRead))
    assert.equal(emptyRead.structuredContent.eof, true)
    assert.equal(emptyRead.structuredContent.bytes_read, 0)
    for (const offset of ["-1", "9223372036854775808"]) {
      const invalidRange = await client.callTool({ name: "read_file_chunk", arguments: { workspace_id: workspaceId, path: "empty.bin", offset_bytes: offset, length_bytes: 1 } })
      assert.equal(invalidRange.isError, true, `invalid 64-bit offset must be rejected: ${offset}`)
    }
    const invalidLength = await client.callTool({ name: "read_file_chunk", arguments: { workspace_id: workspaceId, path: "empty.bin", offset_bytes: "0", length_bytes: 0 } })
    assert.equal(invalidLength.isError, true)

    const interruptedKey = randomUUID()
    const interruptedStart = await client.callTool({ name: "begin_write", arguments: {
      workspace_id: workspaceId, path: "interrupted-upload.bin", size_bytes: "2", idempotency_key: interruptedKey,
    } })
    assert.notEqual(interruptedStart.isError, true, JSON.stringify(interruptedStart))
    const resumedStart = await client.callTool({ name: "begin_write", arguments: {
      workspace_id: workspaceId, path: "interrupted-upload.bin", size_bytes: "2", idempotency_key: interruptedKey,
    } })
    assert.notEqual(resumedStart.isError, true, JSON.stringify(resumedStart))
    assert.equal(resumedStart.structuredContent.upload_id, interruptedStart.structuredContent.upload_id)
    assert.equal(resumedStart.structuredContent.resumed, true)
    const interruptedId = interruptedStart.structuredContent.upload_id
    const { uploadFilePath } = await import("../apps/server/core/uploads.mjs")
    const invalidBase64 = await client.callTool({ name: "write_chunk", arguments: { upload_id: interruptedId, offset_bytes: "0", data_base64: "AA=Z" } })
    assert.equal(invalidBase64.isError, true, "malformed Base64 must be rejected")
    const outOfOrder = await client.callTool({ name: "write_chunk", arguments: { upload_id: interruptedId, offset_bytes: "1", data_base64: "AQ==" } })
    assert.equal(outOfOrder.isError, true, "out-of-order chunks must be rejected")
    const firstInterruptedChunk = await client.callTool({ name: "write_chunk", arguments: { upload_id: interruptedId, offset_bytes: "0", data_base64: "AQ==" } })
    assert.notEqual(firstInterruptedChunk.isError, true, JSON.stringify(firstInterruptedChunk))
    assert.equal(firstInterruptedChunk.structuredContent.progress_percent, 50)
    const conflictingRetry = await client.callTool({ name: "write_chunk", arguments: { upload_id: interruptedId, offset_bytes: "0", data_base64: "Ag==" } })
    assert.equal(conflictingRetry.isError, true, "a retry at the same offset with different bytes must be rejected")
    await appendFile(uploadFilePath(interruptedId), Buffer.from([0xff]))
    const recoveredChunk = await client.callTool({ name: "write_chunk", arguments: { upload_id: interruptedId, offset_bytes: "1", data_base64: "Ag==" } })
    assert.notEqual(recoveredChunk.isError, true, `an uncommitted tail must be truncated to the last confirmed 64-bit offset: ${JSON.stringify(recoveredChunk)}`)
    const recoveredCommit = await client.callTool({ name: "commit_write", arguments: { upload_id: interruptedId } })
    assert.notEqual(recoveredCommit.isError, true, JSON.stringify(recoveredCommit))
    assert.deepEqual(await readFile(path.join(workspaceRoot, "interrupted-upload.bin")), Buffer.from([1, 2]))

    const commitPhaseUpload = await client.callTool({ name: "begin_write", arguments: {
      workspace_id: workspaceId, path: "commit-phase.bin", size_bytes: "1", idempotency_key: randomUUID(),
    } })
    const commitPhaseId = commitPhaseUpload.structuredContent.upload_id
    const commitPhaseChunk = await client.callTool({ name: "write_chunk", arguments: { upload_id: commitPhaseId, offset_bytes: "0", data_base64: "AQ==" } })
    assert.notEqual(commitPhaseChunk.isError, true, JSON.stringify(commitPhaseChunk))
    const commitPhaseMetaPath = path.join(tempDir, "uploads", `${commitPhaseId}.json`)
    const commitPhaseMeta = JSON.parse(await readFile(commitPhaseMetaPath, "utf8"))
    commitPhaseMeta.phase = "committing"
    commitPhaseMeta.commitStartedAt = new Date(Date.now() - 2_000).toISOString()
    await writeFile(commitPhaseMetaPath, `${JSON.stringify(commitPhaseMeta)}\n`, "utf8")
    const commitProgress = await (await fetch(`${adminOrigin}/api/uploads`)).json()
    const committingItem = commitProgress.uploads.find((item) => item.upload_id === commitPhaseId)
    assert.equal(committingItem.phase, "committing")
    assert.equal(committingItem.progress_percent, 100)
    assert.ok(committingItem.phase_elapsed_ms >= 1_000)
    const commitPhaseAbort = await client.callTool({ name: "abort_write", arguments: { upload_id: commitPhaseId } })
    assert.notEqual(commitPhaseAbort.isError, true, JSON.stringify(commitPhaseAbort))

    const pausedUpload = await client.callTool({ name: "begin_write", arguments: {
      workspace_id: workspaceId, path: "paused-upload.bin", size_bytes: "2", idempotency_key: randomUUID(),
    } })
    assert.notEqual(pausedUpload.isError, true, JSON.stringify(pausedUpload))
    const pausedUploadId = pausedUpload.structuredContent.upload_id
    const pausedFirstChunk = await client.callTool({ name: "write_chunk", arguments: { upload_id: pausedUploadId, offset_bytes: "0", data_base64: "AQ==" } })
    assert.notEqual(pausedFirstChunk.isError, true, JSON.stringify(pausedFirstChunk))
    const uploadDashboard = await (await fetch(`${adminOrigin}/api/uploads`)).json()
    assert.equal(uploadDashboard.uploads.find((item) => item.upload_id === pausedUploadId).received_bytes, "1")
    assert.equal((await adminPost(`/api/workspaces/${workspaceId}/pause`)).status, 200)
    const pausedChunk = await client.callTool({ name: "write_chunk", arguments: { upload_id: pausedUploadId, offset_bytes: "1", data_base64: "Ag==" } })
    assert.equal(pausedChunk.isError, true, "workspace pause must block an in-flight upload")
    const abortedUpload = await adminPost(`/api/uploads/${pausedUploadId}/abort`)
    assert.equal(abortedUpload.status, 200)
    assert.equal((await abortedUpload.json()).status, "aborted")
    assert.equal((await adminPost(`/api/workspaces/${workspaceId}/resume`)).status, 200)

    const largeBytes = Buffer.alloc(1_048_613)
    for (let index = 0; index < largeBytes.length; index++) largeBytes[index] = (index * 31 + 7) & 0xff
    const largeStart = await client.callTool({ name: "begin_write", arguments: {
      workspace_id: workspaceId, path: "large-roundtrip.bin", size_bytes: String(largeBytes.length), idempotency_key: randomUUID(),
    } })
    assert.notEqual(largeStart.isError, true, JSON.stringify(largeStart))
    const uploadId = largeStart.structuredContent.upload_id
    for (let offset = 0; offset < largeBytes.length; offset += 262_144) {
      const part = largeBytes.subarray(offset, Math.min(largeBytes.length, offset + 262_144))
      const partResult = await client.callTool({ name: "write_chunk", arguments: { upload_id: uploadId, offset_bytes: String(offset), data_base64: part.toString("base64") } })
      assert.notEqual(partResult.isError, true, JSON.stringify(partResult))
      if (offset === 0) {
        const retry = await client.callTool({ name: "write_chunk", arguments: { upload_id: uploadId, offset_bytes: "0", data_base64: part.toString("base64") } })
        assert.equal(retry.structuredContent.duplicate, true)
      }
    }
    const largeCommit = await client.callTool({ name: "commit_write", arguments: { upload_id: uploadId } })
    assert.notEqual(largeCommit.isError, true, JSON.stringify(largeCommit))
    assert.equal(largeCommit.structuredContent.status, "applied")
    assert.equal(largeCommit.structuredContent.sha256_after, createHash("sha256").update(largeBytes).digest("hex"))
    assert.deepEqual(await readFile(path.join(workspaceRoot, "large-roundtrip.bin")), largeBytes)
    const largeStat = await client.callTool({ name: "stat_file", arguments: { workspace_id: workspaceId, path: "large-roundtrip.bin", include_sha256: true } })
    assert.notEqual(largeStat.isError, true, JSON.stringify(largeStat))
    assert.equal(largeStat.structuredContent.size_bytes, String(largeBytes.length))
    const readParts = []
    let readOffset = 0
    while (true) {
      const partResult = await client.callTool({ name: "read_file_chunk", arguments: {
        workspace_id: workspaceId, path: "large-roundtrip.bin", offset_bytes: String(readOffset),
        length_bytes: 262_144, expected_version: largeStat.structuredContent.version,
      } })
      assert.notEqual(partResult.isError, true, JSON.stringify(partResult))
      readParts.push(Buffer.from(partResult.structuredContent.data_base64, "base64"))
      readOffset = Number(partResult.structuredContent.next_offset)
      if (partResult.structuredContent.eof) break
    }
    assert.deepEqual(Buffer.concat(readParts), largeBytes, "chunked raw read must reproduce every byte")

    const textOne = "before one\n"
    const textTwo = "before two\n"
    for (const [name, text] of [["patch-one.txt", textOne], ["patch-two.txt", textTwo]]) {
      const create = await client.callTool({ name: "write_file", arguments: { workspace_id: workspaceId, path: name, data_base64: Buffer.from(text).toString("base64") } })
      assert.notEqual(create.isError, true, JSON.stringify(create))
    }
    const oneStat = await client.callTool({ name: "stat_file", arguments: { workspace_id: workspaceId, path: "patch-one.txt", include_sha256: true } })
    const twoStat = await client.callTool({ name: "stat_file", arguments: { workspace_id: workspaceId, path: "patch-two.txt", include_sha256: true } })
    const autoPatch = await client.callTool({ name: "stage_unified_patch", arguments: {
      workspace_id: workspaceId,
      unified_patch: createTwoFilesPatch("a/patch-one.txt", "b/patch-one.txt", textOne, "after one\n") + createTwoFilesPatch("a/patch-two.txt", "b/patch-two.txt", textTwo, "after two\n"),
      expected_hashes: [{ path: "patch-one.txt", sha256: oneStat.structuredContent.sha256 }, { path: "patch-two.txt", sha256: twoStat.structuredContent.sha256 }],
    } })
    assert.notEqual(autoPatch.isError, true, JSON.stringify(autoPatch))
    assert.equal(autoPatch.structuredContent.per_file_approval, false)
    assert.equal(autoPatch.structuredContent.applied_count, 2)
    assert.equal(autoPatch.structuredContent.failed_count, 0)
    assert.equal(await readFile(path.join(workspaceRoot, "patch-one.txt"), "utf8"), "after one\n")
    for (const item of autoPatch.structuredContent.recovery_paths) {
      const response = await adminPost(`/api/changes/${item.change_id}/recover`)
      assert.equal(response.status, 200, `${item.path}: ${await response.text()}`)
    }
    assert.equal(await readFile(path.join(workspaceRoot, "patch-one.txt"), "utf8"), textOne)

    const directCreate = await client.callTool({ name: "stage_file_write", arguments: { workspace_id: workspaceId, path: "direct-edit.txt", content: "direct version\n", create: true } })
    assert.notEqual(directCreate.isError, true, JSON.stringify(directCreate))
    assert.equal(directCreate.structuredContent.requires_local_approval, false)
    const directRead = await client.callTool({ name: "read_file", arguments: { workspace_id: workspaceId, path: "direct-edit.txt" } })
    const directUpdate = await client.callTool({ name: "stage_replace", arguments: {
      workspace_id: workspaceId, path: "direct-edit.txt", find: "direct", replace: "automatic", expected_sha256: directRead.structuredContent.sha256,
    } })
    assert.notEqual(directUpdate.isError, true, JSON.stringify(directUpdate))
    assert.equal(directUpdate.structuredContent.requires_local_approval, false)
    assert.equal(await readFile(path.join(workspaceRoot, "direct-edit.txt"), "utf8"), "automatic version\n")
    const directDirectory = await client.callTool({ name: "stage_directory_create", arguments: { workspace_id: workspaceId, path: "no-approval-directory" } })
    assert.notEqual(directDirectory.isError, true, JSON.stringify(directDirectory))
    assert.equal(directDirectory.structuredContent.requires_local_approval, false)
    assert.equal((await adminPost(`/api/workspaces/${workspaceId}/pause`)).status, 200)
    const pausedWrite = await client.callTool({ name: "write_file", arguments: { workspace_id: workspaceId, path: "paused-denied.bin", data_base64: "AA==" } })
    assert.equal(pausedWrite.isError, true)
    assert.equal((await adminPost(`/api/workspaces/${workspaceId}/resume`)).status, 200)
    assert.equal((await adminPost(`/api/workspaces/${workspaceId}/readonly`)).status, 200)
    const readOnlyWrite = await client.callTool({ name: "write_file", arguments: { workspace_id: workspaceId, path: "readonly-denied.bin", data_base64: "AA==" } })
    assert.equal(readOnlyWrite.isError, true)

    const sparsePath = path.join(workspaceRoot, "sparse-over-1g.bin")
    try {
      const fsutil = path.join(systemRoot, "System32", "fsutil.exe")
      await writeFile(sparsePath, Buffer.alloc(0))
      execFileSync(fsutil, ["sparse", "setflag", sparsePath], { windowsHide: true })
      await truncate(sparsePath, 1_073_741_837)
      const sparseStat = await client.callTool({ name: "stat_file", arguments: { workspace_id: workspaceId, path: "sparse-over-1g.bin" } })
      assert.notEqual(sparseStat.isError, true, JSON.stringify(sparseStat))
      assert.equal(sparseStat.structuredContent.size_bytes, "1073741837")
      const sparseTail = await client.callTool({ name: "read_file_chunk", arguments: { workspace_id: workspaceId, path: "sparse-over-1g.bin", offset_bytes: "1073741824", length_bytes: 13 } })
      assert.notEqual(sparseTail.isError, true, JSON.stringify(sparseTail))
      assert.deepEqual(Buffer.from(sparseTail.structuredContent.data_base64, "base64"), Buffer.alloc(13))
    } catch (error) {
      t.diagnostic(`Sparse >1 GiB fixture was not available: ${error.message}`)
    }

    await assert.rejects(() => workspaces.addWorkspace({ name: "forbidden parent", root: "D:\\Download\\GitHub", mode: "readOnly" }), /不能授权/)
  } catch (error) {
    if (startupStderr) error.message += `\nMCP stderr:\n${startupStderr}`
    throw error
  }
})
