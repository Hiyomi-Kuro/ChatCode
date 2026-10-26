import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { createHash, randomUUID } from "node:crypto"
import { cp, lstat, mkdir, readFile, readdir, writeFile } from "node:fs/promises"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { setTimeout as delay } from "node:timers/promises"
import { Client } from "@modelcontextprotocol/client"
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio"

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const sourceCalculator = "D:\\Download\\ChatCode\\Calculator"
const testsRoot = path.join(repositoryRoot, ".tmp", "tests")
const runId = `mumu-calculator-${new Date().toISOString().replace(/[:.]/g, "-")}-${randomUUID()}`
const evidenceRoot = path.join(testsRoot, runId)
const dataDir = path.join(evidenceRoot, "data")
const tempDir = path.join(evidenceRoot, "server-tmp")
const workspaceRoot = path.join(repositoryRoot, ".tmp", "tests", `ws-${randomUUID().slice(0, 8)}`, "workspace with spaces")
const calculatorRoot = path.join(workspaceRoot, "Calculator")
const evidencePath = path.join(evidenceRoot, "acceptance-evidence.json")
const isolatedApplicationId = `com.example.chatcode.calculator.acceptance.r${randomUUID().replace(/-/g, "").slice(0, 12)}`

async function sha256File(filePath) {
  return createHash("sha256").update(await readFile(filePath)).digest("hex")
}

async function sourceFingerprint(root) {
  const files = []
  const excludedDirectories = new Set([".git", ".tmp", "artifacts", "build", ".gradle"])
  async function walk(directory, relative = "") {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (entry.isSymbolicLink()) throw new Error(`Calculator 源项目包含符号链接，拒绝复制：${path.join(directory, entry.name)}`)
      if (entry.isDirectory()) {
        if (!excludedDirectories.has(entry.name)) await walk(path.join(directory, entry.name), path.join(relative, entry.name))
        continue
      }
      if (!entry.isFile() || entry.name.toLowerCase().endsWith(".apk")) continue
      const file = path.join(directory, entry.name)
      files.push({ path: path.join(relative, entry.name).replace(/\\/g, "/"), sha256: await sha256File(file) })
    }
  }
  await walk(root)
  files.sort((a, b) => a.path.localeCompare(b.path))
  const apkFiles = [path.join(root, "app-debug.apk"), path.join(root, "artifacts", "app-debug.apk")]
  const apks = []
  for (const file of apkFiles) {
    try { apks.push({ path: file, sha256: await sha256File(file) }) }
    catch (error) { if (error?.code !== "ENOENT") throw error }
  }
  return { files, apks, tree_sha256: createHash("sha256").update(JSON.stringify(files)).digest("hex") }
}

async function copyCalculatorSources(source, destination) {
  const excludedDirectories = new Set([".git", ".tmp", "artifacts", "build", ".gradle"])
  async function copyDirectory(from, to) {
    await mkdir(to, { recursive: true })
    for (const entry of await readdir(from, { withFileTypes: true })) {
      const sourcePath = path.join(from, entry.name)
      const targetPath = path.join(to, entry.name)
      const info = await lstat(sourcePath)
      if (info.isSymbolicLink() || (process.platform === "win32" && (Number(info.attributes ?? 0) & 0x400) !== 0)) {
        throw new Error(`Calculator 源项目包含 reparse point，拒绝复制：${sourcePath}`)
      }
      if (info.isDirectory()) {
        if (!excludedDirectories.has(entry.name)) await copyDirectory(sourcePath, targetPath)
        continue
      }
      if (!info.isFile() || entry.name.toLowerCase().endsWith(".apk")) continue
      await cp(sourcePath, targetPath, { errorOnExist: true, force: false })
    }
  }
  await copyDirectory(source, destination)
}

async function seedIsolatedGradleCache(source, destination) {
  const rootInfo = await lstat(source).catch((error) => error?.code === "ENOENT" ? null : Promise.reject(error))
  if (!rootInfo) return { seeded: false, reason: "source cache is absent", files: 0, bytes: 0 }
  if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink() || (process.platform === "win32" && (Number(rootInfo.attributes ?? 0) & 0x400) !== 0)) {
    throw new Error("Calculator Gradle cache is not a plain directory; refusing to copy it")
  }
  let files = 0
  let bytes = 0
  async function walk(from, to) {
    await mkdir(to, { recursive: true })
    for (const entry of await readdir(from, { withFileTypes: true })) {
      const fromPath = path.join(from, entry.name)
      const toPath = path.join(to, entry.name)
      const info = await lstat(fromPath)
      if (info.isSymbolicLink() || (process.platform === "win32" && (Number(info.attributes ?? 0) & 0x400) !== 0) || Number(info.nlink ?? 1) > 1) {
        throw new Error(`Calculator Gradle cache contains a link; refusing to copy ${fromPath}`)
      }
      if (info.isDirectory()) await walk(fromPath, toPath)
      else if (info.isFile() && !entry.name.toLowerCase().endsWith(".lock")) {
        files++
        bytes += info.size
        if (files > 30_000 || bytes > 2 * 1024 * 1024 * 1024) throw new Error("Calculator Gradle cache exceeds the bounded seed-copy limit")
        await cp(fromPath, toPath, { errorOnExist: true, force: false })
      }
    }
  }
  await walk(source, destination)
  return { seeded: true, files, bytes }
}

async function freePort() {
  const { createServer } = await import("node:net")
  const server = createServer()
  await new Promise((resolve, reject) => server.once("error", reject).listen(0, "127.0.0.1", resolve))
  const port = server.address().port
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
  return port
}

function toolPayload(result, name) {
  if (result?.isError) throw new Error(`${name} failed: ${JSON.stringify(result.structuredContent ?? result.content).slice(0, 3_000)}`)
  if (result?.structuredContent === undefined) throw new Error(`${name} returned no structured content: ${JSON.stringify(result).slice(0, 2_000)}`)
  return result.structuredContent
}

async function waitForTask(client, taskId, timeoutMs = 20 * 60 * 1000) {
  const deadline = Date.now() + timeoutMs
  let last
  while (Date.now() < deadline) {
    last = toolPayload(await client.callTool({ name: "get_task", arguments: { task_id: taskId } }), "get_task")
    if (["succeeded", "failed", "timed_out", "cancelled", "interrupted"].includes(last.status)) return last
    await delay(1_000)
  }
  throw new Error(`任务 ${taskId} 在 ${timeoutMs}ms 内未结束；最后状态=${last?.status ?? "unknown"}`)
}

async function collectTaskOutput(client, taskId) {
  const pages = []
  let offset = 0
  while (offset <= 131_072) {
    const page = toolPayload(await client.callTool({ name: "get_task_output", arguments: { task_id: taskId, offset, limit: 32_000 } }), "get_task_output")
    pages.push(page.output ?? "")
    if (page.eof || page.next_offset === null || page.next_offset === undefined || page.next_offset <= offset) break
    offset = page.next_offset
  }
  return pages.join("")
}

function parseNodeAttributes(tag) {
  const attributes = {}
  for (const match of tag.matchAll(/([\w:-]+)="((?:\\.|[^"])*)"/g)) {
    attributes[match[1]] = match[2].replaceAll("&amp;", "&").replaceAll("&quot;", '"').replaceAll("&lt;", "<").replaceAll("&gt;", ">").replaceAll("&#39;", "'")
  }
  return attributes
}

function readNodes(xml) {
  const nodes = []
  for (const match of xml.matchAll(/<node\b[^>]*>/g)) {
    const attributes = parseNodeAttributes(match[0])
    const bounds = /^\[(\d+),(\d+)\]\[(\d+),(\d+)\]$/.exec(attributes.bounds ?? "")
    if (bounds) nodes.push({ ...attributes, center_x: Math.round((Number(bounds[1]) + Number(bounds[3])) / 2), center_y: Math.round((Number(bounds[2]) + Number(bounds[4])) / 2) })
  }
  return nodes
}

function buttonMap(width, height) {
  const rows = [
    ["AC", "C", "⌫", "÷"], ["7", "8", "9", "×"], ["4", "5", "6", "−"],
    ["1", "2", "3", "+"], ["±", "0", ".", "="],
  ]
  const columnFractions = [0.15, 0.3833, 0.6167, 0.85]
  const rowFractions = [0.6063, 0.6896, 0.7729, 0.8563, 0.9396]
  const result = new Map()
  rows.forEach((row, rowIndex) => row.forEach((key, columnIndex) => {
    result.set(key, { type: "tap", x: Math.round(width * columnFractions[columnIndex]), y: Math.round(height * rowFractions[rowIndex]) })
  }))
  return result
}

function normalizedOcrText(text) {
  return String(text ?? "")
    .replace(/[．。·]/g, ".")
    .replace(/[−–—]/g, "-")
    .replace(/[：]/g, ":")
    .replace(/\s+/g, "")
    .toLowerCase()
}

async function readCalculatorDisplayWithOcr(imagePath) {
  const powershell = path.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe")
  const script = path.join(repositoryRoot, "tests", "windows-ocr.ps1")
  const child = spawn(powershell, ["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", script, "-Path", imagePath], {
    cwd: repositoryRoot, windowsHide: true, stdio: ["ignore", "pipe", "pipe"],
  })
  let stdout = ""
  let stderr = ""
  child.stdout.setEncoding("utf8").on("data", (chunk) => { stdout += chunk })
  child.stderr.setEncoding("utf8").on("data", (chunk) => { stderr += chunk })
  const timeout = setTimeout(() => child.kill(), 30_000)
  const exitCode = await new Promise((resolve, reject) => {
    child.once("error", reject)
    child.once("close", resolve)
  }).finally(() => clearTimeout(timeout))
  assert.equal(exitCode, 0, `Windows OCR failed (${exitCode}): ${stderr.slice(-2_000)}`)
  const parsed = JSON.parse(stdout.trim())
  const text = Buffer.from(String(parsed.text_base64 ?? ""), "base64").toString("utf8")
  return { text, normalized: normalizedOcrText(text), regionSha256: String(parsed.region_sha256 ?? "") }
}

async function captureScreenshot(client, workspaceId, taskId) {
  return toolPayload(await client.callTool({ name: "capture_screenshot", arguments: { workspace_id: workspaceId, task_id: taskId } }), "capture_screenshot")
}

async function captureHierarchy(client, workspaceId, taskId) {
  return toolPayload(await client.callTool({ name: "dump_ui_hierarchy", arguments: { workspace_id: workspaceId, task_id: taskId } }), "dump_ui_hierarchy")
}

async function runCalculation(client, workspaceId, taskId, workspaceRoot, buttons, zeroBaseline, sequence, expected, label) {
  const actions = sequence.map((key) => {
    const action = buttons.get(key)
    assert.ok(action, `Calculator key ${key} was not mapped for the screenshot dimensions`)
    return action
  })
  toolPayload(await client.callTool({ name: "run_android_instrumentation_or_uiautomator", arguments: {
    workspace_id: workspaceId, task_id: taskId, actions,
  } }), "run_android_instrumentation_or_uiautomator")
  await delay(300)
  const screenshot = await captureScreenshot(client, workspaceId, taskId)
  const imagePath = path.join(workspaceRoot, ...screenshot.path.split("/"))
  const bytes = await readFile(imagePath)
  assert.equal(bytes.subarray(0, 8).toString("hex"), "89504e470d0a1a0a", `${label}: screenshot was not PNG`)
  const width = bytes.readUInt32BE(16)
  const height = bytes.readUInt32BE(20)
  assert.ok(width >= 400 && height >= 700, `${label}: unexpected screenshot dimensions ${width}x${height}`)
  const ocr = await readCalculatorDisplayWithOcr(imagePath)
  const normalizedExpected = normalizedOcrText(expected)
  const zeroPixelMatch = expected === "0" && !ocr.normalized && ocr.regionSha256 === zeroBaseline
  assert.ok(ocr.normalized === normalizedExpected || zeroPixelMatch,
    `${label}: expected screenshot display ${expected}, OCR read ${JSON.stringify(ocr.text)} (display region SHA-256 ${ocr.regionSha256})`)
  return { label, key_sequence: sequence, expected, actual: ocr.text, normalized_actual: ocr.normalized,
    screenshot_path: screenshot.path, screenshot_sha256: screenshot.sha256, screenshot_display_id: screenshot.display_id,
    screenshot_dimensions: { width, height }, display_region_sha256: ocr.regionSha256, zero_pixel_match_to_reset: zeroPixelMatch,
    ocr_region: "cropped calculator display, excluding Android status bar and keypad" }
}

async function adminPost(origin, csrf, route, body) {
  return fetch(`${origin}${route}`, {
    method: "POST", headers: { Origin: origin, "X-ChatCode-CSRF": csrf, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  })
}

const evidence = {
  run_id: runId,
  started_at: new Date().toISOString(),
  status: "running",
  repository_root: repositoryRoot,
  source_calculator: sourceCalculator,
  evidence_root: evidenceRoot,
  workspace_root: workspaceRoot,
  tasks: [],
  calculator_checks: [],
  errors: [],
}
const runtime = { admin: null, client: null, transport: null, workspaceId: null, assembleTaskId: null, launched: false, adminOutput: "" }

async function runTask(client, workspaceId, task, scriptName = null, { allowFailure = false } = {}) {
  const result = scriptName
    ? toolPayload(await client.callTool({ name: "request_project_check", arguments: { workspace_id: workspaceId, script: scriptName } }), "request_project_check")
    : toolPayload(await client.callTool({ name: "request_android_build", arguments: { workspace_id: workspaceId, project_path: "Calculator", task } }), "request_android_build")
  assert.equal(result.requires_local_approval, false, `${task ?? scriptName} unexpectedly requires local approval: ${JSON.stringify(result)}`)
  const completed = await waitForTask(client, result.task_id)
  const output = await collectTaskOutput(client, result.task_id)
  const record = { task_id: result.task_id, kind: scriptName ? "npm_script" : "android_build", task: task ?? scriptName,
    requested_status: result.status, status: completed.status, exit_code: completed.exitCode,
    command: completed.command ?? result.command, output_excerpt: output.slice(-12_000) }
  evidence.tasks.push(record)
  if (!allowFailure) {
    assert.equal(completed.status, "succeeded", `${task ?? scriptName} task failed: ${JSON.stringify(record)}`)
    assert.equal(completed.exitCode, 0)
  }
  return { request: result, task: completed, output }
}

async function publishApk(client, taskId, workspaceRoot) {
  const artifact = toolPayload(await client.callTool({ name: "get_android_build_artifacts", arguments: { task_id: taskId } }), "get_android_build_artifacts")
  assert.equal(artifact.published, true, JSON.stringify(artifact))
  assert.match(artifact.sha256, /^[0-9a-f]{64}$/)
  assert.ok(Number(artifact.size_bytes) > 0)
  const currentHash = await sha256File(path.join(workspaceRoot, ...artifact.path.split("/")))
  assert.equal(currentHash, artifact.sha256, "published debug APK SHA-256 did not match the file")
  evidence.apk_artifact = artifact
  return artifact
}

async function fixCalculatorNavigationBarLint(client, workspaceId) {
  const stylePaths = [
    "Calculator/app/src/main/res/values/styles.xml",
    "Calculator/app/src/main/res/values-night/styles.xml",
  ]
  const resources = []
  for (const resourcePath of stylePaths) {
    const current = toolPayload(await client.callTool({ name: "read_file", arguments: { workspace_id: workspaceId, path: resourcePath } }), "read_file")
    const occurrences = current.content.match(/<item\s+name="android:windowLightNavigationBar">[^<]*<\/item>/g) ?? []
    assert.equal(occurrences.length, 1, `${resourcePath} no longer has exactly one linted API 27 style item`)
    const [item] = occurrences
    const patched = current.content.replace(/^[\t ]*<item\s+name="android:windowLightNavigationBar">[^<]*<\/item>[\t ]*\r?$/m, "")
    assert.notEqual(patched, current.content)
    resources.push({ resourcePath, source: current.content, patched, sha256: current.sha256, item })
  }
  const directories = [
    "Calculator/app/src/main/res/values-v27",
    "Calculator/app/src/main/res/values-night-v27",
  ]
  for (const directory of directories) toolPayload(await client.callTool({ name: "stage_directory_create", arguments: {
    workspace_id: workspaceId, path: directory,
  } }), "stage_directory_create for API 27 resources")
  for (let index = 0; index < resources.length; index++) {
    const resource = resources[index]
    const target = index === 0
      ? "Calculator/app/src/main/res/values-v27/styles.xml"
      : "Calculator/app/src/main/res/values-night-v27/styles.xml"
    toolPayload(await client.callTool({ name: "stage_file_write", arguments: {
      workspace_id: workspaceId, path: target, content: resource.source, create: true,
    } }), "stage_file_write API 27 resource")
    toolPayload(await client.callTool({ name: "stage_file_write", arguments: {
      workspace_id: workspaceId, path: resource.resourcePath, content: resource.patched,
      expected_sha256: resource.sha256,
    } }), "stage_file_write API 23-compatible resource")
  }
  evidence.lint_fix = {
    issue: "android:windowLightNavigationBar requires API level 27; original styles.xml used it with minSdk 23",
    method: "Moved each exact item into matching values-v27 / values-night-v27 resources through hash-guarded MCP writes in the isolated copy.",
    original_calculator_modified: false,
    files: [...stylePaths, ...directories.map((directory) => `${directory}/styles.xml`)],
  }
}

async function isolateCalculatorApplicationId(client, workspaceId) {
  const resourcePath = "Calculator/app/build.gradle.kts"
  const current = toolPayload(await client.callTool({ name: "read_file", arguments: {
    workspace_id: workspaceId, path: resourcePath,
  } }), "read_file isolated Calculator applicationId")
  const applicationId = /^([\t ]*applicationId\s*=\s*)"([^"]+)"/m.exec(current.content)
  assert.ok(applicationId, `${resourcePath} does not declare an applicationId`)
  assert.equal(applicationId[2], "com.example.calculator", "the isolated source's baseline package changed unexpectedly")
  const updated = current.content.replace(applicationId[0], `${applicationId[1]}"${isolatedApplicationId}"`)
  assert.notEqual(updated, current.content)
  toolPayload(await client.callTool({ name: "stage_file_write", arguments: {
    workspace_id: workspaceId, path: resourcePath, content: updated, expected_sha256: current.sha256,
  } }), "stage_file_write isolated Calculator applicationId")
  evidence.install_isolation = {
    application_id: isolatedApplicationId,
    reason: "A different-signed com.example.calculator is already installed on the selected VM, and each isolated Gradle workspace has its own debug signing key; this per-run package allows side-by-side installation without uninstalling or replacing any app.",
    original_calculator_modified: false,
  }
}

async function main() {
  await mkdir(evidenceRoot, { recursive: true })
  await mkdir(dataDir, { recursive: true })
  await mkdir(tempDir, { recursive: true })
  evidence.calculator_original_before = await sourceFingerprint(sourceCalculator)
  await copyCalculatorSources(sourceCalculator, calculatorRoot)
  evidence.gradle_cache_seed = await seedIsolatedGradleCache(
    path.join(sourceCalculator, ".tmp", "gradle-user-home", "caches"),
    path.join(calculatorRoot, ".tmp", "gradle-user-home", "caches"),
  )

  const port = await freePort()
  const origin = `http://127.0.0.1:${port}`
  const baseEnv = {
    ...process.env,
    CHATCODE_HOME: repositoryRoot,
    CHATCODE_DATA_DIR: dataDir,
    CHATCODE_TMP_DIR: tempDir,
    CHATCODE_PORT: String(port),
  }
  runtime.admin = spawn(process.execPath, [path.join(repositoryRoot, "apps/server/admin.mjs")], {
    cwd: repositoryRoot, env: baseEnv, windowsHide: true, stdio: ["ignore", "pipe", "pipe"],
  })
  const captureAdmin = (chunk) => { runtime.adminOutput = (runtime.adminOutput + chunk.toString("utf8")).slice(-8_000) }
  runtime.admin.stdout.on("data", captureAdmin)
  runtime.admin.stderr.on("data", captureAdmin)
  let session
  for (let attempt = 0; attempt < 150; attempt++) {
    if (runtime.admin.exitCode !== null) throw new Error(`ChatCode admin exited before becoming ready.\n${runtime.adminOutput}`)
    try {
      const response = await fetch(`${origin}/api/session`)
      if (response.ok) { session = await response.json(); break }
    } catch { /* the local admin server is starting */ }
    await delay(100)
  }
  assert.ok(session?.csrf, `ChatCode admin did not become ready.\n${runtime.adminOutput}`)

  const workspaceResponse = await adminPost(origin, session.csrf, "/api/workspaces", {
    name: "MuMu Calculator isolated acceptance",
    path: workspaceRoot,
    mode: "autoWritable",
    confirmAutoWrite: true,
  })
  if (workspaceResponse.status !== 201) throw new Error(`Workspace setup failed (${workspaceResponse.status}): ${await workspaceResponse.text()}`)
  const added = await workspaceResponse.json()
  runtime.workspaceId = added.workspace.id
  evidence.workspace_id = runtime.workspaceId

  const mcpEnv = { ...baseEnv, PATH: process.env.PATH ?? "", SystemRoot: process.env.SystemRoot ?? "C:\\Windows" }
  runtime.transport = new StdioClientTransport({
    command: process.execPath, args: [path.join(repositoryRoot, "apps/server/mcp.mjs")],
    cwd: repositoryRoot, env: mcpEnv, stderr: "pipe",
  })
  runtime.client = new Client({ name: "chatcode-mumu-calculator-acceptance", version: "1.0.0" })
  await runtime.client.connect(runtime.transport)

  const discovered = toolPayload(await runtime.client.callTool({ name: "list_mumu_instances", arguments: {} }), "list_mumu_instances")
  evidence.mumu_discovery = discovered
  const running = discovered.instances.filter((item) => item.player_state === "start_finished" && item.is_process_started)
  if (running.length > 1) throw new Error(`发现 ${running.length} 个正在运行 MuMu 实例；为避免影响其他 VM，本次停止所有设备操作。`)
  if (running.length === 0 && discovered.instances.length !== 1) {
    throw new Error(`没有唯一可选的 MuMu 实例（运行中 ${running.length}，总数 ${discovered.instances.length}）；本次停止所有设备操作。`)
  }
  const selected = running[0] ?? discovered.instances[0]
  if (!selected) throw new Error("MuMu CLI 没有发现现有实例；不会创建新 VM。")
  evidence.selected_mumu_instance = selected

  const packageJson = {
    name: "chatcode-mumu-acceptance",
    version: "1.0.0",
    private: true,
    scripts: { test: "node --test e2e.test.mjs" },
  }
  toolPayload(await runtime.client.callTool({ name: "stage_file_write", arguments: {
    workspace_id: runtime.workspaceId, path: "package.json", content: `${JSON.stringify(packageJson, null, 2)}\n`, create: true,
  } }), "stage_file_write package.json")
  toolPayload(await runtime.client.callTool({ name: "stage_file_write", arguments: {
    workspace_id: runtime.workspaceId, path: "sample-engine.mjs", content: "export const add = (a, b) => a - b\n", create: true,
  } }), "stage_file_write sample-engine.mjs")
  toolPayload(await runtime.client.callTool({ name: "stage_file_write", arguments: {
    workspace_id: runtime.workspaceId, path: "e2e.test.mjs",
    content: "import test from 'node:test'\nimport assert from 'node:assert/strict'\nimport { add } from './sample-engine.mjs'\ntest('Calculator fixture addition', () => assert.equal(add(12, 5), 17))\n",
    create: true,
  } }), "stage_file_write e2e.test.mjs")

  const grantResponse = await adminPost(origin, session.csrf, `/api/workspaces/${runtime.workspaceId}/execution-profile/enable`, {
    confirmUnattendedDev: true,
    npmScripts: ["test"],
    fixedCommands: [],
    androidProjects: [{ projectPath: "Calculator", tasks: ["assembleDebug", "testDebugUnitTest", "lintDebug"] }],
    gitReadOnly: false,
    mumuInstance: { index: selected.index },
    mumuActions: true,
  })
  if (grantResponse.status !== 200) throw new Error(`Execution authorization setup failed (${grantResponse.status}): ${await grantResponse.text()}`)
  const granted = await grantResponse.json()
  evidence.execution_authorization = granted.workspace.executionAuthorization
  assert.equal(evidence.execution_authorization.profile, "unattendedDev")
  assert.equal(evidence.execution_authorization.osIsolation, "none")
  await isolateCalculatorApplicationId(runtime.client, runtime.workspaceId)

  const failing = await runTask(runtime.client, runtime.workspaceId, null, "test").catch(async (error) => {
    const tasks = JSON.parse(await readFile(path.join(dataDir, "tasks.json"), "utf8"))
    const task = tasks.filter((item) => item.workspaceId === runtime.workspaceId && item.script === "test").at(-1)
    if (!task) throw error
    const record = await waitForTask(runtime.client, task.id)
    evidence.tasks.push({ task_id: task.id, kind: "npm_script", task: "test (expected failure)", status: record.status, exit_code: record.exitCode,
      output_excerpt: (await collectTaskOutput(runtime.client, task.id)).slice(-12_000) })
    assert.equal(record.status, "failed")
    assert.notEqual(record.exitCode, 0)
    return { expectedFailure: true, task: record }
  })
  if (!failing.expectedFailure) throw new Error("Intentionally broken npm test unexpectedly succeeded; failure-and-fix proof was not exercised.")
  const beforeFix = toolPayload(await runtime.client.callTool({ name: "read_file", arguments: { workspace_id: runtime.workspaceId, path: "sample-engine.mjs" } }), "read_file")
  toolPayload(await runtime.client.callTool({ name: "stage_file_write", arguments: {
    workspace_id: runtime.workspaceId, path: "sample-engine.mjs", content: "export const add = (a, b) => a + b\n",
    expected_sha256: beforeFix.sha256,
  } }), "stage_file_write fixed sample-engine.mjs")
  await runTask(runtime.client, runtime.workspaceId, null, "test")

  let built = await runTask(runtime.client, runtime.workspaceId, "assembleDebug")
  runtime.assembleTaskId = built.request.task_id
  let artifact = await publishApk(runtime.client, runtime.assembleTaskId, workspaceRoot)
  await runTask(runtime.client, runtime.workspaceId, "testDebugUnitTest")
  const initialLint = await runTask(runtime.client, runtime.workspaceId, "lintDebug", null, { allowFailure: true })
  if (initialLint.task.status !== "succeeded") {
    assert.match(initialLint.output, /android:windowLightNavigationBar.*API level 27/s,
      "lint failed for a reason other than the known minSdk 23 navigation-bar attribute")
    await fixCalculatorNavigationBarLint(runtime.client, runtime.workspaceId)
    built = await runTask(runtime.client, runtime.workspaceId, "assembleDebug")
    runtime.assembleTaskId = built.request.task_id
    artifact = await publishApk(runtime.client, runtime.assembleTaskId, workspaceRoot)
    await runTask(runtime.client, runtime.workspaceId, "testDebugUnitTest")
    await runTask(runtime.client, runtime.workspaceId, "lintDebug")
  }
  evidence.apk_artifact = artifact

  const status = toolPayload(await runtime.client.callTool({ name: "get_mumu_status", arguments: { workspace_id: runtime.workspaceId } }), "get_mumu_status")
  evidence.mumu_status = status
  assert.equal(status.selected_instance.index, selected.index)
  if (!status.connected) {
    const started = toolPayload(await runtime.client.callTool({ name: "start_mumu_if_needed", arguments: { workspace_id: runtime.workspaceId } }), "start_mumu_if_needed")
    evidence.mumu_start = started
    assert.equal(started.status, "ready")
  }
  const devices = toolPayload(await runtime.client.callTool({ name: "get_android_devices", arguments: { workspace_id: runtime.workspaceId } }), "get_android_devices")
  evidence.android_device = devices
  assert.equal(devices.connected, true, JSON.stringify(devices))
  assert.equal(devices.selected_instance, selected.index)

  const install = toolPayload(await runtime.client.callTool({ name: "install_debug_apk", arguments: {
    workspace_id: runtime.workspaceId, task_id: runtime.assembleTaskId,
  } }), "install_debug_apk")
  assert.equal(install.installed, true)
  assert.equal(install.apk_sha256, artifact.sha256)
  assert.equal(install.instance_index, selected.index)
  evidence.install = install

  const firstLaunch = toolPayload(await runtime.client.callTool({ name: "launch_android_app", arguments: {
    workspace_id: runtime.workspaceId, task_id: runtime.assembleTaskId,
  } }), "launch_android_app")
  runtime.launched = true
  evidence.first_launch = firstLaunch
  assert.equal(firstLaunch.launched, true)
  await delay(1_000)
  evidence.cold_stop = toolPayload(await runtime.client.callTool({ name: "stop_test_app", arguments: {
    workspace_id: runtime.workspaceId, task_id: runtime.assembleTaskId,
  } }), "stop_test_app")
  await delay(500)
  evidence.cold_launch = toolPayload(await runtime.client.callTool({ name: "launch_android_app", arguments: {
    workspace_id: runtime.workspaceId, task_id: runtime.assembleTaskId,
  } }), "launch_android_app")
  await delay(1_500)

  const visibility = toolPayload(await runtime.client.callTool({ name: "validate_android_ui", arguments: {
    workspace_id: runtime.workspaceId, task_id: runtime.assembleTaskId, rounds: 3,
  } }), "validate_android_ui")
  evidence.cold_launch_visibility = visibility
  assert.equal(visibility.passed, true, JSON.stringify(visibility))
  assert.equal(visibility.rounds.length, 3)
  assert.ok(visibility.rounds.every((round) => round.pid && round.activity_visible && (round.window_visible || round.surface_visible)),
    "each visibility round must have a process, target activity and visible window or surface")

  const firstScreenshot = toolPayload(await runtime.client.callTool({ name: "capture_screenshot", arguments: {
    workspace_id: runtime.workspaceId, task_id: runtime.assembleTaskId,
  } }), "capture_screenshot")
  evidence.first_screenshot = firstScreenshot
  const firstImagePath = path.join(workspaceRoot, ...firstScreenshot.path.split("/"))
  const firstImage = await readFile(firstImagePath)
  const imageWidth = firstImage.readUInt32BE(16)
  const imageHeight = firstImage.readUInt32BE(20)
  const initialOcr = await readCalculatorDisplayWithOcr(firstImagePath)
  evidence.initial_display_ocr = { text: initialOcr.text, normalized: initialOcr.normalized,
    display_region_sha256: initialOcr.regionSha256, screenshot_dimensions: { width: imageWidth, height: imageHeight }, screenshot_path: firstScreenshot.path }
  const buttons = buttonMap(imageWidth, imageHeight)
  for (const key of ["AC", "C", "⌫", "0", "1", "2", "3", "4", "5", "6", "7", "8", "9", ".", "+", "−", "×", "÷", "="]) {
    assert.ok(buttons.has(key), `calculator key ${key} is missing from the screenshot grid map`)
  }
  try {
    const hierarchy = await captureHierarchy(runtime.client, runtime.workspaceId, runtime.assembleTaskId)
    evidence.initial_ui_hierarchy = { available: true, path: hierarchy.path, sha256: hierarchy.sha256, truncated: hierarchy.truncated }
  } catch (error) {
    evidence.initial_ui_hierarchy = { available: false, error: String(error?.message ?? error).slice(0, 1_000) }
  }
  toolPayload(await runtime.client.callTool({ name: "run_android_instrumentation_or_uiautomator", arguments: {
    workspace_id: runtime.workspaceId, task_id: runtime.assembleTaskId, actions: [buttons.get("AC")],
  } }), "reset Calculator before UI checks")
  await delay(300)
  const resetScreenshot = await captureScreenshot(runtime.client, runtime.workspaceId, runtime.assembleTaskId)
  const resetOcr = await readCalculatorDisplayWithOcr(path.join(workspaceRoot, ...resetScreenshot.path.split("/")))
  evidence.calculator_reset = { screenshot_path: resetScreenshot.path, screenshot_sha256: resetScreenshot.sha256,
    display_region_sha256: resetOcr.regionSha256, ocr_text: resetOcr.text, normalized_ocr: resetOcr.normalized }
  assert.ok(resetOcr.normalized === "0" || resetOcr.normalized === "" || resetOcr.normalized === "o",
    `AC reset did not show zero: OCR read ${JSON.stringify(resetOcr.text)}`)
  assert.equal(initialOcr.regionSha256, resetOcr.regionSha256, "cold-launch display differs from the same app after AC reset")
  const zeroBaseline = resetOcr.regionSha256

  evidence.calculator_checks.push(await runCalculation(runtime.client, runtime.workspaceId, runtime.assembleTaskId,
    workspaceRoot, buttons, zeroBaseline, ["AC", "1", "2", ".", "5", "+", "2", "="], "14.5", "decimal addition 12.5 + 2"))
  evidence.calculator_checks.push(await runCalculation(runtime.client, runtime.workspaceId, runtime.assembleTaskId,
    workspaceRoot, buttons, zeroBaseline, ["AC", "1", "9", ".", "5", "−", "4", "="], "15.5", "decimal subtraction 19.5 - 4"))
  evidence.calculator_checks.push(await runCalculation(runtime.client, runtime.workspaceId, runtime.assembleTaskId,
    workspaceRoot, buttons, zeroBaseline, ["AC", "7", "×", "8", ".", "5", "="], "59.5", "decimal multiplication 7 * 8.5"))
  evidence.calculator_checks.push(await runCalculation(runtime.client, runtime.workspaceId, runtime.assembleTaskId,
    workspaceRoot, buttons, zeroBaseline, ["AC", "8", "4", "÷", "2", ".", "5", "="], "33.6", "decimal division 84 / 2.5"))
  evidence.calculator_checks.push(await runCalculation(runtime.client, runtime.workspaceId, runtime.assembleTaskId,
    workspaceRoot, buttons, zeroBaseline, ["AC", "1", "2", "+", "3", "C"], "0", "clear entry C"))
  evidence.calculator_checks.push(await runCalculation(runtime.client, runtime.workspaceId, runtime.assembleTaskId,
    workspaceRoot, buttons, zeroBaseline, ["AC", "8", "÷", "0", "="], "Error", "division by zero"))
  evidence.calculator_checks.push(await runCalculation(runtime.client, runtime.workspaceId, runtime.assembleTaskId,
    workspaceRoot, buttons, zeroBaseline, ["2", "2", ".", "5", "+", "2", "0", "="], "42.5", "recover after division by zero"))
  evidence.calculator_checks.push(await runCalculation(runtime.client, runtime.workspaceId, runtime.assembleTaskId,
    workspaceRoot, buttons, zeroBaseline, ["AC", "1", "2", ".", "5", "⌫", "+", "4", ".", "5", "="], "16.5", "delete last digit before decimal addition"))
  evidence.calculator_checks.push(await runCalculation(runtime.client, runtime.workspaceId, runtime.assembleTaskId,
    workspaceRoot, buttons, zeroBaseline, ["AC"], "0", "clear all AC"))

  const finalValidation = toolPayload(await runtime.client.callTool({ name: "validate_android_ui", arguments: {
    workspace_id: runtime.workspaceId, task_id: runtime.assembleTaskId, rounds: 3,
  } }), "validate_android_ui")
  evidence.final_visibility = finalValidation
  assert.equal(finalValidation.passed, true, JSON.stringify(finalValidation))
  evidence.final_screenshot = toolPayload(await runtime.client.callTool({ name: "capture_screenshot", arguments: {
    workspace_id: runtime.workspaceId, task_id: runtime.assembleTaskId,
  } }), "capture_screenshot")
  const finalImagePath = path.join(workspaceRoot, ...evidence.final_screenshot.path.split("/"))
  const finalOcr = await readCalculatorDisplayWithOcr(finalImagePath)
  evidence.final_display_ocr = { text: finalOcr.text, normalized: finalOcr.normalized, display_region_sha256: finalOcr.regionSha256,
    screenshot_path: evidence.final_screenshot.path }
  assert.ok(finalOcr.normalized === "0" || (!finalOcr.normalized && finalOcr.regionSha256 === zeroBaseline),
    `final AC should leave display zero; OCR read ${JSON.stringify(finalOcr.text)} and display SHA-256 ${finalOcr.regionSha256}`)
  try {
    const hierarchy = await captureHierarchy(runtime.client, runtime.workspaceId, runtime.assembleTaskId)
    evidence.final_ui_hierarchy = { available: true, path: hierarchy.path, sha256: hierarchy.sha256, truncated: hierarchy.truncated }
  } catch (error) {
    evidence.final_ui_hierarchy = { available: false, error: String(error?.message ?? error).slice(0, 1_000) }
  }
  evidence.logcat = toolPayload(await runtime.client.callTool({ name: "get_logcat", arguments: {
    workspace_id: runtime.workspaceId, task_id: runtime.assembleTaskId, offset: 0, limit: 20_000,
  } }), "get_logcat")
  evidence.crash_diagnostics = toolPayload(await runtime.client.callTool({ name: "collect_crash_diagnostics", arguments: {
    workspace_id: runtime.workspaceId, task_id: runtime.assembleTaskId,
  } }), "collect_crash_diagnostics")
  assert.equal(evidence.crash_diagnostics.crash_detected, false, JSON.stringify(evidence.crash_diagnostics))

  const auditLines = (await readFile(path.join(dataDir, "audit.jsonl"), "utf8")).split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line))
  const auditEvents = auditLines.map((entry) => entry.event)
  for (const required of ["workspace_execution_authorization_granted", "check_authorized_queued", "android_build_authorized_queued", "android_apk_published"]) {
    assert.ok(auditEvents.includes(required), `missing audit event ${required}`)
  }
  const tasks = JSON.parse(await readFile(path.join(dataDir, "tasks.json"), "utf8"))
  const workspaceTasks = tasks.filter((item) => item.workspaceId === runtime.workspaceId)
  assert.ok(workspaceTasks.length >= 5)
  assert.ok(workspaceTasks.every((item) => item.status !== "awaiting_approval"), "the authorized workflow created no per-task approval entries")
  evidence.audit = { total_events: auditLines.length, required_events: ["workspace_execution_authorization_granted", "check_authorized_queued", "android_build_authorized_queued", "android_apk_published"],
    events_for_workspace: auditLines.filter((item) => item.workspaceId === runtime.workspaceId).map((item) => item.event) }

  evidence.calculator_original_after = await sourceFingerprint(sourceCalculator)
  assert.deepEqual(evidence.calculator_original_after, evidence.calculator_original_before, "original Calculator sources or APKs changed during acceptance")
  evidence.status = "passed"
}

try {
  await main()
} catch (error) {
  evidence.status = "failed"
  evidence.errors.push({ message: String(error?.message ?? error).slice(0, 6_000), stack: String(error?.stack ?? "").slice(0, 8_000) })
  evidence.admin_output_tail = runtime.adminOutput
  process.exitCode = 1
} finally {
  if (runtime.launched && runtime.client && runtime.workspaceId && runtime.assembleTaskId) {
    await runtime.client.callTool({ name: "stop_test_app", arguments: { workspace_id: runtime.workspaceId, task_id: runtime.assembleTaskId } }).catch(() => {})
  }
  if (runtime.client) await runtime.client.close().catch(() => {})
  else await runtime.transport?.close().catch(() => {})
  if (runtime.admin?.exitCode === null) {
    runtime.admin.kill()
    await Promise.race([new Promise((resolve) => runtime.admin.once("close", resolve)), delay(4_000)])
  }
  try {
    if (!evidence.calculator_original_after) evidence.calculator_original_after = await sourceFingerprint(sourceCalculator)
    evidence.ended_at = new Date().toISOString()
    await mkdir(evidenceRoot, { recursive: true })
    await writeFile(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`, "utf8")
    process.stdout.write(`MuMu Calculator acceptance ${evidence.status}. Evidence: ${evidencePath}\n`)
  } catch (error) {
    process.stderr.write(`Could not persist acceptance evidence: ${String(error?.message ?? error)}\n`)
    process.exitCode = 1
  }
}

