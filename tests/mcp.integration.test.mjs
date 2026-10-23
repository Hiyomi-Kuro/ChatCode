import assert from "node:assert/strict"
import { link, mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises"
import { spawn } from "node:child_process"
import { execFileSync } from "node:child_process"
import { createServer } from "node:net"
import path from "node:path"
import { randomUUID } from "node:crypto"
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
    for (const name of ["list_workspaces", "read_file", "git_status", "git_diff", "stage_file_write", "stage_unified_patch", "apply_change", "request_project_check", "run_approved_check"]) assert.ok(names.has(name), `missing MCP tool: ${name}`)
    assert.equal(toolMap.get("read_file").annotations.readOnlyHint, true)
    assert.equal(toolMap.get("stage_file_write").annotations.readOnlyHint, false)
    assert.equal(toolMap.get("apply_change").annotations.destructiveHint, true)

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
    assert.notEqual(regex.isError, true)
    assert.equal(regex.structuredContent.matches[0].path, "src/app.ts")

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

    await assert.rejects(() => workspaces.addWorkspace({ name: "forbidden parent", root: "D:\\Download\\GitHub", mode: "readOnly" }), /不能授权/)
  } catch (error) {
    if (startupStderr) error.message += `\nMCP stderr:\n${startupStderr}`
    throw error
  }
})
