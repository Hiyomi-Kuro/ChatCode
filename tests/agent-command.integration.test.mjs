import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { createServer } from "node:net"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import path from "node:path"
import { randomUUID } from "node:crypto"
import { fileURLToPath } from "node:url"
import { setTimeout as delay } from "node:timers/promises"
import { test } from "node:test"
import { Client } from "@modelcontextprotocol/client"
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio"

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")

async function freePort() {
  const server = createServer()
  await new Promise((resolve, reject) => server.once("error", reject).listen(0, "127.0.0.1", resolve))
  const port = server.address().port
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
  return port
}

test("isolated MCP E2E: no-Git resume is atomic and optional command paths survive admin/MCP process boundaries", async (t) => {
  const testsRoot = path.resolve(projectRoot, ".tmp", "tests")
  await mkdir(testsRoot, { recursive: true })
  const sandbox = await mkdtemp(path.join(testsRoot, "agent-command-"))
  const dataDir = path.join(sandbox, "data")
  const tempDir = path.join(sandbox, "tmp")
  const workspaceRoot = path.join(sandbox, "workspace no-git")
  const gitRoot = path.join(sandbox, "workspace-git")
  const corruptGitRoot = path.join(sandbox, "workspace-corrupt-git")
  await Promise.all([
    mkdir(dataDir, { recursive: true }), mkdir(tempDir, { recursive: true }), mkdir(workspaceRoot, { recursive: true }),
    mkdir(gitRoot, { recursive: true }), mkdir(corruptGitRoot, { recursive: true }),
    mkdir(path.join(workspaceRoot, "src"), { recursive: true }),
  ])
  const workspaceId = randomUUID()
  const gitWorkspaceId = randomUUID()
  const corruptGitWorkspaceId = randomUUID()
  const gitInit = spawn("git", ["init", "--quiet"], { cwd: gitRoot, windowsHide: true, stdio: "ignore" })
  await new Promise((resolve, reject) => {
    gitInit.once("error", reject)
    gitInit.once("close", (code) => code === 0 ? resolve() : reject(new Error(`git init exited ${code}`)))
  })
  await mkdir(path.join(corruptGitRoot, ".git"), { recursive: true })
  await writeFile(path.join(workspaceRoot, "package.json"), JSON.stringify({ name: "agent-command-fixture", version: "1.0.0" }, null, 2), "utf8")
  await writeFile(path.join(workspaceRoot, "src", "sample.test.mjs"), "import test from 'node:test'\nimport assert from 'node:assert/strict'\ntest('fixture passes', () => assert.equal(2 + 2, 4))\n", "utf8")
  await writeFile(path.join(workspaceRoot, "src", "syntax.mjs"), "export const value = 42\n", "utf8")
  const workspaceRecord = (id, name, root) => ({ id, name, root, mode: "autoWritable", status: "active", createdAt: new Date().toISOString() })
  await writeFile(path.join(dataDir, "workspaces.json"), `${JSON.stringify([
    workspaceRecord(workspaceId, "No Git task fixture", workspaceRoot),
    workspaceRecord(gitWorkspaceId, "Git task fixture", gitRoot),
    workspaceRecord(corruptGitWorkspaceId, "Corrupt Git task fixture", corruptGitRoot),
  ], null, 2)}\n`, "utf8")

  const port = await freePort()
  const origin = `http://127.0.0.1:${port}`
  const baseEnv = {
    ...process.env,
    CHATCODE_HOME: projectRoot,
    CHATCODE_DATA_DIR: dataDir,
    CHATCODE_TMP_DIR: tempDir,
    CHATCODE_PORT: String(port),
  }
  const admin = spawn(process.execPath, [path.join(projectRoot, "apps", "server", "admin.mjs")], {
    cwd: projectRoot, env: baseEnv, windowsHide: true, stdio: ["ignore", "pipe", "pipe"],
  })
  let transport
  let client
  let secondTransport
  let secondClient
  let adminOutput = ""
  admin.stdout.on("data", (chunk) => { adminOutput = (adminOutput + chunk.toString("utf8")).slice(-4000) })
  admin.stderr.on("data", (chunk) => { adminOutput = (adminOutput + chunk.toString("utf8")).slice(-4000) })
  t.after(async () => {
    if (secondClient) await secondClient.close().catch(() => {})
    else await secondTransport?.close().catch(() => {})
    if (client) await client.close().catch(() => {})
    else await transport?.close().catch(() => {})
    if (admin.exitCode === null) {
      admin.kill()
      await Promise.race([new Promise((resolve) => admin.once("close", resolve)), delay(2_000)])
    }
    const absolute = path.resolve(sandbox)
    const relative = path.relative(testsRoot, absolute)
    if (relative && !relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative)) await rm(absolute, { recursive: true, force: true })
  })

  let session
  for (let attempt = 0; attempt < 80; attempt++) {
    if (admin.exitCode !== null) throw new Error(`ChatCode admin exited during startup.\n${adminOutput}`)
    try {
      const response = await fetch(`${origin}/api/session`)
      if (response.ok) { session = await response.json(); break }
    } catch { /* server is still starting */ }
    await delay(100)
  }
  assert.ok(session?.csrf, `ChatCode admin did not become ready.\n${adminOutput}`)
  const adminPost = async (route, body = {}) => fetch(`${origin}${route}`, {
    method: "POST",
    headers: { Origin: origin, "X-ChatCode-CSRF": session.csrf, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  })
  const env = {
    CHATCODE_HOME: projectRoot,
    CHATCODE_DATA_DIR: dataDir,
    CHATCODE_TMP_DIR: tempDir,
    SystemRoot: process.env.SystemRoot ?? "C:\\Windows",
    SystemDrive: process.env.SystemDrive ?? "C:",
    PATH: process.env.PATH ?? "",
  }
  transport = new StdioClientTransport({ command: process.execPath, args: [path.join(projectRoot, "apps", "server", "mcp.mjs")], cwd: projectRoot, env, stderr: "pipe" })
  client = new Client({ name: "chatcode-agent-command-e2e", version: "1.0.0" })
  await client.connect(transport)

  const begin = await client.callTool({ name: "begin_agent_task", arguments: { workspace_id: workspaceId, user_goal: "Reproduce non-Git resume and command approval behavior." } })
  assert.notEqual(begin.isError, true, JSON.stringify(begin))
  const agentId = begin.structuredContent.id
  await client.callTool({ name: "record_agent_plan", arguments: { task_id: agentId, steps: ["Check task context", "Run fixed command"] } })
  const checkpointBefore = (await client.callTool({ name: "get_agent_task", arguments: { task_id: agentId } })).structuredContent

  assert.equal((await adminPost(`/api/workspaces/${workspaceId}/pause`)).status, 200)
  const failedResume = await client.callTool({ name: "resume_agent_task", arguments: { task_id: agentId } })
  assert.equal(failedResume.isError, true)
  const checkpointAfterFailure = (await client.callTool({ name: "get_agent_task", arguments: { task_id: agentId } })).structuredContent
  assert.equal(checkpointAfterFailure.status, checkpointBefore.status, "a failed resume must not commit a new task status")
  assert.equal(checkpointAfterFailure.revision, checkpointBefore.revision, "a failed resume must not advance the revision")
  assert.equal((await adminPost(`/api/workspaces/${workspaceId}/resume`)).status, 200)

  const context = await client.callTool({ name: "get_task_context", arguments: { task_id: agentId } })
  assert.notEqual(context.isError, true, JSON.stringify(context))
  assert.equal(context.structuredContent.git.available, false, JSON.stringify(context.structuredContent.git))
  assert.equal(context.structuredContent.git.reason, "not_a_repository", JSON.stringify(context.structuredContent.git))
  assert.ok(context.structuredContent.files.root_entries.some((entry) => entry.name === "package.json"))
  const resumed = await client.callTool({ name: "resume_agent_task", arguments: { task_id: agentId } })
  assert.notEqual(resumed.isError, true, JSON.stringify(resumed))
  assert.equal(resumed.structuredContent.task.status, "awaiting_model")
  assert.equal(resumed.structuredContent.git.reason, "not_a_repository")

  const gitAgent = (await client.callTool({ name: "begin_agent_task", arguments: { workspace_id: gitWorkspaceId, user_goal: "Verify valid Git context remains available." } })).structuredContent
  const validGit = await client.callTool({ name: "get_task_context", arguments: { task_id: gitAgent.id } })
  assert.notEqual(validGit.isError, true, JSON.stringify(validGit))
  assert.equal(validGit.structuredContent.git.available, true)
  assert.equal(validGit.structuredContent.git.recent_commits.length, 0, "an initialized repository with no commits still has usable Git context")

  const corruptAgent = (await client.callTool({ name: "begin_agent_task", arguments: { workspace_id: corruptGitWorkspaceId, user_goal: "Verify corrupt Git metadata is optional." } })).structuredContent
  const corruptGit = await client.callTool({ name: "get_task_context", arguments: { task_id: corruptAgent.id } })
  assert.notEqual(corruptGit.isError, true, JSON.stringify(corruptGit))
  assert.equal(corruptGit.structuredContent.git.available, false)
  assert.equal(corruptGit.structuredContent.git.reason, "repository_corrupt", JSON.stringify(corruptGit.structuredContent.git))

  const androidEnvironment = await client.callTool({ name: "get_android_environment", arguments: { workspace_id: workspaceId, project_path: "src" } })
  assert.notEqual(androidEnvironment.isError, true, JSON.stringify(androidEnvironment))
  assert.equal(androidEnvironment.structuredContent.workspace_id, workspaceId)
  assert.ok(Array.isArray(androidEnvironment.structuredContent.diagnostics))
  assert.ok("selected_runner" in androidEnvironment.structuredContent.gradle)
  const invalidAndroidPath = await client.callTool({ name: "get_android_environment", arguments: { workspace_id: workspaceId, project_path: "../outside" } })
  assert.equal(invalidAndroidPath.isError, true, "Android project paths stay within the authorized workspace")
  const invalidAndroidTask = await client.callTool({ name: "request_android_build", arguments: { workspace_id: workspaceId, project_path: "src", task: "help" } })
  assert.equal(invalidAndroidTask.isError, true, "Android task names are a fixed allowlist")
  await writeFile(path.join(workspaceRoot, "src", "settings.gradle.kts"), "pluginManagement { repositories { maven(url = \"https://untrusted.example/maven\") } }\n", "utf8")
  const repositoryEnvironment = await client.callTool({ name: "get_android_environment", arguments: { workspace_id: workspaceId, project_path: "src" } })
  assert.notEqual(repositoryEnvironment.isError, true, JSON.stringify(repositoryEnvironment))
  assert.ok(repositoryEnvironment.structuredContent.diagnostics.some((item) => item.code === "unapproved_repository"))
  await rm(path.join(workspaceRoot, "src", "settings.gradle.kts"), { force: true })
  const wrapperDirectory = path.join(workspaceRoot, "src", "gradle", "wrapper")
  await mkdir(wrapperDirectory, { recursive: true })
  await writeFile(path.join(wrapperDirectory, "gradle-wrapper.properties"), "distributionUrl=https\\://untrusted.example/gradle-8.13-bin.zip\n", "utf8")
  const invalidWrapper = await client.callTool({ name: "get_android_environment", arguments: { workspace_id: workspaceId, project_path: "src" } })
  assert.equal(invalidWrapper.isError, true, "the Android scanner rejects non-official Gradle Wrapper URLs")
  await rm(path.join(workspaceRoot, "src", "gradle"), { recursive: true, force: true })

  const commandRequestId = randomUUID()
  const omitted = await client.callTool({ name: "request_allowed_command", arguments: { workspace_id: workspaceId, command_type: "node_test", request_id: commandRequestId } })
  assert.notEqual(omitted.isError, true, JSON.stringify(omitted))
  const omittedId = omitted.structuredContent.task_id
  const duplicateOmitted = await client.callTool({ name: "request_allowed_command", arguments: { workspace_id: workspaceId, command_type: "node_test", request_id: commandRequestId } })
  assert.equal(duplicateOmitted.structuredContent.task_id, omittedId, "retrying an acknowledged request_id returns the original task")
  assert.equal(duplicateOmitted.structuredContent.idempotent, true)
  let storedTasks = JSON.parse(await readFile(path.join(dataDir, "tasks.json"), "utf8"))
  let persisted = storedTasks.find((task) => task.id === omittedId)
  assert.equal(persisted.relativePath, null, "omitted optional path must be canonicalized before persistence")
  assert.deepEqual(persisted.arguments, ["--test", "--test-reporter=tap"])
  assert.equal((await client.callTool({ name: "run_approved_command", arguments: { task_id: omittedId } })).isError, true)
  assert.equal((await adminPost(`/api/tasks/${omittedId}/approve`)).status, 200)
  const started = await client.callTool({ name: "run_approved_command", arguments: { task_id: omittedId } })
  assert.notEqual(started.isError, true, JSON.stringify(started))
  const nodeTest = await waitForTask(client, omittedId)
  assert.equal(nodeTest.status, "succeeded", JSON.stringify(nodeTest))
  assert.equal(nodeTest.exitCode, 0)
  const output = await readAllOutput(client, omittedId)
  assert.match(output, /TAP version/)
  assert.match(output, /# tests 1/)
  assert.match(output, /# pass 1/)
  assert.equal((await client.callTool({ name: "run_approved_command", arguments: { task_id: omittedId } })).isError, true, "a fixed command cannot be run twice")

  const empty = await client.callTool({ name: "request_allowed_command", arguments: { workspace_id: workspaceId, command_type: "node_test", relative_path: "" } })
  assert.notEqual(empty.isError, true, JSON.stringify(empty))
  storedTasks = JSON.parse(await readFile(path.join(dataDir, "tasks.json"), "utf8"))
  persisted = storedTasks.find((task) => task.id === empty.structuredContent.task_id)
  assert.equal(persisted.relativePath, null, "empty optional path must canonicalize to null")

  const nullPath = await client.callTool({ name: "request_allowed_command", arguments: { workspace_id: workspaceId, command_type: "node_test", relative_path: null } })
  assert.notEqual(nullPath.isError, true, JSON.stringify(nullPath))
  storedTasks = JSON.parse(await readFile(path.join(dataDir, "tasks.json"), "utf8"))
  persisted = storedTasks.find((task) => task.id === nullPath.structuredContent.task_id)
  assert.equal(persisted.relativePath, null)

  const checkMissing = await client.callTool({ name: "request_allowed_command", arguments: { workspace_id: workspaceId, command_type: "node_check" } })
  assert.equal(checkMissing.isError, true, "node_check requires a source file")
  const check = await client.callTool({ name: "request_allowed_command", arguments: { workspace_id: workspaceId, command_type: "node_check", relative_path: "src/syntax.mjs" } })
  assert.notEqual(check.isError, true, JSON.stringify(check))
  assert.deepEqual(check.structuredContent.preview.arguments, ["--check", "src/syntax.mjs"])
  assert.equal((await adminPost(`/api/tasks/${check.structuredContent.task_id}/approve`)).status, 200)
  assert.notEqual((await client.callTool({ name: "run_approved_command", arguments: { task_id: check.structuredContent.task_id } })).isError, true)
  const checked = await waitForTask(client, check.structuredContent.task_id)
  assert.equal(checked.status, "succeeded", JSON.stringify(checked))
  assert.equal(checked.exitCode, 0)

  await writeFile(path.join(workspaceRoot, "src", "output.test.mjs"), "import test from 'node:test'\nimport assert from 'node:assert/strict'\ntest('paged output', () => { process.stdout.write('x'.repeat(150000)); assert.ok(true) })\n", "utf8")
  const outputRequest = await client.callTool({ name: "request_allowed_command", arguments: { workspace_id: workspaceId, command_type: "node_test", relative_path: "src/output.test.mjs" } })
  assert.notEqual(outputRequest.isError, true, JSON.stringify(outputRequest))
  assert.equal((await adminPost(`/api/tasks/${outputRequest.structuredContent.task_id}/approve`)).status, 200)
  assert.notEqual((await client.callTool({ name: "run_approved_command", arguments: { task_id: outputRequest.structuredContent.task_id } })).isError, true)
  const outputTask = await waitForTask(client, outputRequest.structuredContent.task_id)
  assert.equal(outputTask.status, "succeeded", JSON.stringify(outputTask))
  assert.equal(outputTask.output.length, 128 * 1024, "task output is bounded to the documented history cap")
  const firstPage = await client.callTool({ name: "get_task_output", arguments: { task_id: outputRequest.structuredContent.task_id, offset: 0, limit: 512 } })
  assert.equal(firstPage.structuredContent.output.length, 512)
  assert.equal(firstPage.structuredContent.next_offset, 512)
  const secondPage = await client.callTool({ name: "get_task_output", arguments: { task_id: outputRequest.structuredContent.task_id, offset: 512, limit: 512 } })
  assert.equal(secondPage.structuredContent.offset, 512)
  assert.equal(secondPage.structuredContent.output.length, 512)
  assert.equal(secondPage.structuredContent.next_offset, 1024)
  assert.equal(firstPage.structuredContent.eof, false)

  await writeFile(path.join(workspaceRoot, "src", "slow.test.mjs"), "import test from 'node:test'\ntest('long-running task', async () => await new Promise(resolve => setTimeout(resolve, 10000)))\n", "utf8")
  const slowRequest = await client.callTool({ name: "request_allowed_command", arguments: { workspace_id: workspaceId, command_type: "node_test", relative_path: "src/slow.test.mjs" } })
  assert.notEqual(slowRequest.isError, true, JSON.stringify(slowRequest))
  assert.equal((await adminPost(`/api/tasks/${slowRequest.structuredContent.task_id}/approve`)).status, 200)
  assert.notEqual((await client.callTool({ name: "run_approved_command", arguments: { task_id: slowRequest.structuredContent.task_id } })).isError, true)
  const cancelled = await client.callTool({ name: "cancel_task", arguments: { task_id: slowRequest.structuredContent.task_id } })
  assert.notEqual(cancelled.isError, true, JSON.stringify(cancelled))
  assert.equal(cancelled.structuredContent.status, "cancelled")
  const cancelledTask = await client.callTool({ name: "get_task", arguments: { task_id: slowRequest.structuredContent.task_id } })
  assert.equal(cancelledTask.structuredContent.status, "cancelled")

  for (const invalid of ["../outside.mjs", "C:\\Windows\\win.ini", "src/../syntax.mjs"]) {
    const rejected = await client.callTool({ name: "request_allowed_command", arguments: { workspace_id: workspaceId, command_type: "node_check", relative_path: invalid } })
    assert.equal(rejected.isError, true, `unsafe command path should reject: ${invalid}`)
  }
  let dagStep = await client.callTool({ name: "update_agent_step", arguments: { task_id: agentId, step_index: 0, step_status: "in_progress", summary: "Resumed step one." } })
  assert.notEqual(dagStep.isError, true, JSON.stringify(dagStep))
  dagStep = await client.callTool({ name: "update_agent_step", arguments: { task_id: agentId, step_index: 0, step_status: "completed", summary: "Step one complete." } })
  assert.deepEqual(dagStep.structuredContent.ready_steps, ["step-2"])
  dagStep = await client.callTool({ name: "update_agent_step", arguments: { task_id: agentId, step_index: 1, step_status: "in_progress", summary: "Resumed step two." } })
  assert.notEqual(dagStep.isError, true, JSON.stringify(dagStep))
  dagStep = await client.callTool({ name: "update_agent_step", arguments: { task_id: agentId, step_index: 1, step_status: "completed", task_status: "completed", summary: "Step two complete." } })
  assert.equal(dagStep.structuredContent.status, "completed")
  await client.callTool({ name: "finish_agent_task", arguments: { task_id: agentId, status: "completed", summary: "E2E finished." } })
  const terminalResume = await client.callTool({ name: "resume_agent_task", arguments: { task_id: agentId } })
  assert.equal(terminalResume.isError, true, "completed tasks cannot resume")
  const terminal = (await client.callTool({ name: "get_agent_task", arguments: { task_id: agentId } })).structuredContent
  assert.equal(terminal.status, "completed")

  secondTransport = new StdioClientTransport({ command: process.execPath, args: [path.join(projectRoot, "apps", "server", "mcp.mjs")], cwd: projectRoot, env, stderr: "pipe" })
  secondClient = new Client({ name: "chatcode-agent-command-e2e-peer", version: "1.0.0" })
  await secondClient.connect(secondTransport)
  const [parallelA, parallelB] = await Promise.all([
    client.callTool({ name: "begin_agent_task", arguments: { workspace_id: workspaceId, user_goal: "Cross-process state-lock writer A." } }),
    secondClient.callTool({ name: "begin_agent_task", arguments: { workspace_id: workspaceId, user_goal: "Cross-process state-lock writer B." } }),
  ])
  assert.notEqual(parallelA.isError, true, JSON.stringify(parallelA))
  assert.notEqual(parallelB.isError, true, JSON.stringify(parallelB))
  const parallelIds = [parallelA.structuredContent.id, parallelB.structuredContent.id]
  const persistedAgents = JSON.parse(await readFile(path.join(dataDir, "agent-tasks.json"), "utf8"))
  for (const id of parallelIds) assert.ok(persistedAgents.some((task) => task.id === id), `parallel Agent task ${id} must survive cross-process writes`)
  await client.close()
  client = null
  transport = null
  const persistedCheckpoint = await secondClient.callTool({ name: "get_agent_task", arguments: { task_id: parallelIds[0] } })
  assert.notEqual(persistedCheckpoint.isError, true, JSON.stringify(persistedCheckpoint))
  const recoveredCheckpoint = await secondClient.callTool({ name: "resume_agent_task", arguments: { task_id: parallelIds[0] } })
  assert.notEqual(recoveredCheckpoint.isError, true, JSON.stringify(recoveredCheckpoint))
  assert.equal(recoveredCheckpoint.structuredContent.task.status, "awaiting_model")
  assert.equal(recoveredCheckpoint.structuredContent.git.reason, "not_a_repository")
})

async function waitForTask(client, taskId) {
  for (let attempt = 0; attempt < 100; attempt++) {
    const result = await client.callTool({ name: "get_task", arguments: { task_id: taskId } })
    assert.notEqual(result.isError, true, JSON.stringify(result))
    if (["succeeded", "failed", "timed_out", "cancelled", "interrupted"].includes(result.structuredContent.status)) return result.structuredContent
    await delay(100)
  }
  throw new Error(`Task ${taskId} did not finish before the test timeout`)
}

async function readAllOutput(client, taskId) {
  let offset = 0
  let output = ""
  for (let page = 0; page < 100; page++) {
    const result = await client.callTool({ name: "get_task_output", arguments: { task_id: taskId, offset, limit: 512 } })
    assert.notEqual(result.isError, true, JSON.stringify(result))
    output += result.structuredContent.output
    if (result.structuredContent.eof) return output
    offset = result.structuredContent.next_offset
  }
  throw new Error(`Task ${taskId} produced too much output for the test`)
}
