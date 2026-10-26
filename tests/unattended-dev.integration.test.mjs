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

async function waitTask(client, id, expected) {
  const deadline = Date.now() + 30_000
  let last
  while (Date.now() < deadline) {
    const result = await client.callTool({ name: "get_task", arguments: { task_id: id } })
    assert.notEqual(result.isError, true, JSON.stringify(result))
    last = result.structuredContent
    if (["succeeded", "failed", "timed_out", "cancelled", "interrupted"].includes(last.status)) break
    await delay(100)
  }
  assert.ok(last, "task record should be readable")
  if (expected) assert.equal(last.status, expected, JSON.stringify(last))
  return last
}

test("unattendedDev is a local, scoped authorization that starts real async jobs and preserves legacy approval", async (t) => {
  const testsRoot = path.join(projectRoot, ".tmp", "tests")
  await mkdir(testsRoot, { recursive: true })
  const sandbox = await mkdtemp(path.join(testsRoot, "unattended-dev-"))
  const dataDir = path.join(sandbox, "data")
  const tempDir = path.join(sandbox, "tmp")
  const workspaceRoot = path.join(sandbox, "workspace with spaces")
  const sourceRoot = path.join(workspaceRoot, "src")
  await Promise.all([mkdir(dataDir, { recursive: true }), mkdir(tempDir, { recursive: true }), mkdir(sourceRoot, { recursive: true })])
  const workspaceId = randomUUID()
  const packageJson = {
    name: "unattended-dev-fixture", version: "1.0.0",
    scripts: { test: "node --test src/pass.test.mjs src/engine.test.mjs" },
  }
  await writeFile(path.join(workspaceRoot, "package.json"), `${JSON.stringify(packageJson, null, 2)}\n`, "utf8")
  await writeFile(path.join(sourceRoot, "pass.test.mjs"), "import test from 'node:test'\nimport assert from 'node:assert/strict'\ntest('fixture passes', () => assert.equal(2 + 2, 4))\n", "utf8")
  await writeFile(path.join(sourceRoot, "slow.test.mjs"), "import test from 'node:test'\ntest('slow fixture', async () => await new Promise(resolve => setTimeout(resolve, 10000)))\n", "utf8")
  await writeFile(path.join(sourceRoot, "syntax.mjs"), "export const value = 42\n", "utf8")
  await writeFile(path.join(dataDir, "workspaces.json"), `${JSON.stringify([{
    id: workspaceId, name: "unattended fixture", root: workspaceRoot, mode: "autoWritable", status: "active",
    createdAt: new Date().toISOString(), executionAuthorization: null,
  }], null, 2)}\n`, "utf8")

  const port = await freePort()
  const origin = `http://127.0.0.1:${port}`
  const baseEnv = { ...process.env, CHATCODE_HOME: projectRoot, CHATCODE_DATA_DIR: dataDir, CHATCODE_TMP_DIR: tempDir, CHATCODE_PORT: String(port) }
  const admin = spawn(process.execPath, [path.join(projectRoot, "apps/server/admin.mjs")], { cwd: projectRoot, env: baseEnv, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] })
  let transport
  let client
  let adminOutput = ""
  admin.stdout.on("data", (chunk) => { adminOutput = (adminOutput + chunk.toString("utf8")).slice(-3000) })
  admin.stderr.on("data", (chunk) => { adminOutput = (adminOutput + chunk.toString("utf8")).slice(-3000) })
  t.after(async () => {
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
  for (let attempt = 0; attempt < 100; attempt++) {
    if (admin.exitCode !== null) throw new Error(`Admin startup failed.\n${adminOutput}`)
    try {
      const response = await fetch(`${origin}/api/session`)
      if (response.ok) { session = await response.json(); break }
    } catch { /* admin is still starting */ }
    await delay(100)
  }
  assert.ok(session?.csrf, `Admin did not become ready.\n${adminOutput}`)
  const adminPost = async (route, body = {}) => fetch(`${origin}${route}`, {
    method: "POST", headers: { Origin: origin, "X-ChatCode-CSRF": session.csrf, "Content-Type": "application/json" }, body: JSON.stringify(body),
  })
  const deniedRemoteEnable = await fetch(`${origin}/api/workspaces/${workspaceId}/execution-profile/enable`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ confirmUnattendedDev: true, fixedCommands: ["node_test"] }),
  })
  assert.equal(deniedRemoteEnable.status, 403, "execution authorization requires the local same-origin CSRF session")

  const mcpEnv = {
    CHATCODE_HOME: projectRoot, CHATCODE_DATA_DIR: dataDir, CHATCODE_TMP_DIR: tempDir,
    SystemRoot: process.env.SystemRoot ?? "C:\\Windows", SystemDrive: process.env.SystemDrive ?? "C:", PATH: process.env.PATH ?? "",
  }
  transport = new StdioClientTransport({ command: process.execPath, args: [path.join(projectRoot, "apps/server/mcp.mjs")], cwd: projectRoot, env: mcpEnv, stderr: "pipe" })
  client = new Client({ name: "chatcode-unattended-dev-e2e", version: "1.0.0" })
  await client.connect(transport)
  const toolList = await client.listTools()
  const toolNames = toolList.tools.map((item) => item.name)
  assert.ok(toolNames.length > 50)
  assert.ok(!toolNames.some((name) => /enable.*execution|set.*profile|run_shell|arbitrary_shell/i.test(name)), "remote MCP cannot set trust or invoke arbitrary shell")

  const toolsCatalog = (await client.callTool({ name: "get_tool_catalog", arguments: {} })).structuredContent
  const catalogCount = Object.values(toolsCatalog.groups).reduce((count, group) => count + group.length, 0)
  assert.equal(catalogCount, toolNames.length, "tools/list and get_tool_catalog must describe the same registrations")
  assert.equal(toolsCatalog.tool_schema_version, "2026-10-25.phase9.4")

  const manualRequest = await client.callTool({ name: "request_project_check", arguments: { workspace_id: workspaceId, script: "test" } })
  assert.notEqual(manualRequest.isError, true, JSON.stringify(manualRequest))
  assert.equal(manualRequest.structuredContent.status, "awaiting_approval", "autoWritable alone does not authorize commands")
  assert.equal(manualRequest.structuredContent.requires_local_approval, true)

  const configured = await adminPost(`/api/workspaces/${workspaceId}/execution-profile/enable`, {
    confirmUnattendedDev: true, npmScripts: ["test"], fixedCommands: ["node_test"],
    androidProjects: [], gitReadOnly: false, mumuInstance: null, mumuActions: false,
  })
  assert.equal(configured.status, 200, await configured.text())
  const workspaceResponse = await fetch(`${origin}/api/workspaces`)
  const workspaceData = await workspaceResponse.json()
  const profile = workspaceData.workspaces.find((item) => item.id === workspaceId).executionAuthorization
  assert.equal(profile.profile, "unattendedDev")
  assert.equal(profile.osIsolation, "none")
  assert.deepEqual(profile.scope.npmScripts, ["test"])
  assert.deepEqual(profile.scope.fixedCommands, ["node_test"])

  const createdModule = await client.callTool({ name: "stage_file_write", arguments: {
    workspace_id: workspaceId, path: "src/engine.mjs", content: "export const add = (a, b) => a - b\n", create: true,
  } })
  assert.notEqual(createdModule.isError, true, JSON.stringify(createdModule))
  const createdTest = await client.callTool({ name: "stage_file_write", arguments: {
    workspace_id: workspaceId, path: "src/engine.test.mjs",
    content: "import test from 'node:test'\nimport assert from 'node:assert/strict'\nimport { add } from './engine.mjs'\ntest('addition', () => assert.equal(add(2, 3), 5))\n", create: true,
  } })
  assert.notEqual(createdTest.isError, true, JSON.stringify(createdTest))
  const failingRun = await client.callTool({ name: "request_project_check", arguments: { workspace_id: workspaceId, script: "test" } })
  assert.notEqual(failingRun.isError, true, JSON.stringify(failingRun))
  assert.equal((await waitTask(client, failingRun.structuredContent.task_id, "failed")).exitCode, 1)
  const moduleBeforeFix = await client.callTool({ name: "read_file", arguments: { workspace_id: workspaceId, path: "src/engine.mjs" } })
  assert.notEqual(moduleBeforeFix.isError, true, JSON.stringify(moduleBeforeFix))
  const fixedModule = await client.callTool({ name: "stage_file_write", arguments: {
    workspace_id: workspaceId, path: "src/engine.mjs", content: "export const add = (a, b) => a + b\n",
    expected_sha256: moduleBeforeFix.structuredContent.sha256,
  } })
  assert.notEqual(fixedModule.isError, true, JSON.stringify(fixedModule))
  const passingRun = await client.callTool({ name: "request_project_check", arguments: { workspace_id: workspaceId, script: "test" } })
  assert.notEqual(passingRun.isError, true, JSON.stringify(passingRun))
  assert.equal((await waitTask(client, passingRun.structuredContent.task_id, "succeeded")).exitCode, 0)

  const fixed = await client.callTool({ name: "request_allowed_command", arguments: {
    workspace_id: workspaceId, command_type: "node_test", relative_path: "src/pass.test.mjs",
  } })
  assert.notEqual(fixed.isError, true, JSON.stringify(fixed))
  assert.equal(fixed.structuredContent.requires_local_approval, false)
  assert.equal((await waitTask(client, fixed.structuredContent.task_id, "succeeded")).exitCode, 0)

  const beforeUnauthorized = JSON.parse(await readFile(path.join(dataDir, "tasks.json"), "utf8")).length
  const excluded = await client.callTool({ name: "request_allowed_command", arguments: { workspace_id: workspaceId, command_type: "node_check", relative_path: "src/syntax.mjs" } })
  assert.equal(excluded.isError, true, "an operation outside the saved scope fails directly instead of entering approval")
  const escaped = await client.callTool({ name: "request_allowed_command", arguments: { workspace_id: workspaceId, command_type: "node_test", relative_path: "../outside" } })
  assert.equal(escaped.isError, true)
  assert.equal(JSON.parse(await readFile(path.join(dataDir, "tasks.json"), "utf8")).length, beforeUnauthorized)

  const slow = await client.callTool({ name: "request_allowed_command", arguments: { workspace_id: workspaceId, command_type: "node_test", relative_path: "src/slow.test.mjs" } })
  assert.notEqual(slow.isError, true, JSON.stringify(slow))
  assert.equal(slow.structuredContent.requires_local_approval, false)
  const cancellation = await client.callTool({ name: "cancel_task", arguments: { task_id: slow.structuredContent.task_id } })
  assert.notEqual(cancellation.isError, true, JSON.stringify(cancellation))
  assert.equal((await waitTask(client, slow.structuredContent.task_id, "cancelled")).status, "cancelled")

  assert.equal((await adminPost(`/api/workspaces/${workspaceId}/pause`)).status, 200)
  const paused = await client.callTool({ name: "request_project_check", arguments: { workspace_id: workspaceId, script: "test" } })
  assert.equal(paused.isError, true, "paused workspaces cannot execute under an existing profile")
  assert.equal((await adminPost(`/api/workspaces/${workspaceId}/resume`)).status, 200)

  const packageChanged = { ...packageJson, scripts: { ...packageJson.scripts, test: "node --test src/syntax.mjs" } }
  await writeFile(path.join(workspaceRoot, "package.json"), `${JSON.stringify(packageChanged, null, 2)}\n`, "utf8")
  const changed = await client.callTool({ name: "request_project_check", arguments: { workspace_id: workspaceId, script: "test" } })
  assert.equal(changed.isError, true, "a changed package.json cannot reuse the old authorization fingerprint")

  assert.equal((await adminPost(`/api/workspaces/${workspaceId}/execution-profile/revoke`)).status, 200)
  const revoked = await client.callTool({ name: "request_project_check", arguments: { workspace_id: workspaceId, script: "test" } })
  assert.notEqual(revoked.isError, true, JSON.stringify(revoked))
  assert.equal(revoked.structuredContent.status, "awaiting_approval", "revocation falls back to the legacy manual flow")

  const tasks = JSON.parse(await readFile(path.join(dataDir, "tasks.json"), "utf8"))
  const createdDuringProfile = tasks.filter((item) => item.authorizationId === profile.authorizationId)
  assert.ok(createdDuringProfile.length >= 4)
  assert.ok(createdDuringProfile.every((item) => item.status !== "awaiting_approval"), "authorized work created no pending approval entry")
  const audit = (await readFile(path.join(dataDir, "audit.jsonl"), "utf8")).split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line))
  assert.ok(audit.some((item) => item.event === "workspace_execution_authorization_granted"))
  assert.ok(audit.some((item) => item.event === "command_authorized_queued"))
  assert.ok(audit.some((item) => item.event === "check_authorized_queued"))
  assert.ok(audit.some((item) => item.event === "workspace_execution_authorization_revoked"))
})
