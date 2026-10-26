import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { existsSync } from "node:fs"
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile, copyFile } from "node:fs/promises"
import { spawn } from "node:child_process"
import net from "node:net"
import path from "node:path"
import { randomUUID } from "node:crypto"
import { fileURLToPath } from "node:url"
import { setTimeout as delay } from "node:timers/promises"

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const testsRoot = path.join(projectRoot, ".tmp", "tests")
const evidenceDir = path.join(testsRoot, "admin-browser-evidence")
const powerShell = path.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe")

async function freePort() {
  const server = net.createServer()
  await new Promise((resolve, reject) => server.once("error", reject).listen(0, "127.0.0.1", resolve))
  const port = server.address().port
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
  return port
}

async function waitFor(predicate, label, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs
  let lastError
  while (Date.now() < deadline) {
    try { if (await predicate()) return } catch (error) { lastError = error }
    await delay(100)
  }
  throw new Error(`${label}未在 ${timeoutMs} ms 内完成${lastError ? `：${lastError.message}` : ""}`)
}

class DevTools {
  constructor(url) {
    this.url = url
    this.socket = null
    this.sequence = 0
    this.pending = new Map()
    this.events = []
    this.waiters = new Set()
  }

  async connect() {
    this.socket = new WebSocket(this.url)
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("Edge DevTools WebSocket 连接超时")), 10000)
      this.socket.addEventListener("open", () => { clearTimeout(timer); resolve() }, { once: true })
      this.socket.addEventListener("error", () => { clearTimeout(timer); reject(new Error("Edge DevTools WebSocket 连接失败")) }, { once: true })
    })
    this.socket.addEventListener("message", (event) => this.receive(JSON.parse(event.data)))
    this.socket.addEventListener("close", () => {
      for (const pending of this.pending.values()) pending.reject(new Error("Edge DevTools WebSocket 已关闭"))
      this.pending.clear()
    })
    return this
  }

  receive(message) {
    if (message.id) {
      const pending = this.pending.get(message.id)
      if (!pending) return
      this.pending.delete(message.id)
      if (message.error) pending.reject(new Error(message.error.message ?? "DevTools 命令失败"))
      else pending.resolve(message.result ?? {})
      return
    }
    if (message.method) {
      const event = { method: message.method, params: message.params ?? {} }
      this.events.push(event)
      for (const waiter of [...this.waiters]) {
        if (waiter.method !== event.method) continue
        this.waiters.delete(waiter)
        clearTimeout(waiter.timer)
        waiter.resolve(event)
      }
    }
  }

  send(method, params = {}, timeoutMs = 15000) {
    const id = ++this.sequence
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`DevTools 命令 ${method} 超时`))
      }, timeoutMs)
      this.pending.set(id, {
        resolve: (result) => { clearTimeout(timer); resolve(result) },
        reject: (error) => { clearTimeout(timer); reject(error) },
      })
      this.socket.send(JSON.stringify({ id, method, params }))
    })
  }

  evaluate(expression) {
    return this.send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true, userGesture: true }).then((result) => {
      if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text)
      return result.result?.value
    })
  }

  waitForEvent(method, timeoutMs = 10000) {
    return new Promise((resolve, reject) => {
      const waiter = { method, resolve, reject, timer: null }
      waiter.timer = setTimeout(() => {
        this.waiters.delete(waiter)
        reject(new Error(`等待 DevTools 事件 ${method} 超时`))
      }, timeoutMs)
      this.waiters.add(waiter)
    })
  }

  async navigate(url) {
    const loaded = this.waitForEvent("Page.loadEventFired", 15000)
    await this.send("Page.navigate", { url })
    await loaded
  }

  async close() {
    if (this.socket?.readyState === WebSocket.OPEN) this.socket.close()
  }
}

function edgeExecutable() {
  const candidates = [
    process.env.CHATCODE_EDGE_PATH,
    "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
    "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
  ].filter(Boolean)
  const found = candidates.find((candidate) => existsSync(candidate))
  if (!found) throw new Error("未找到 Microsoft Edge；设置 CHATCODE_EDGE_PATH 可指定 msedge.exe")
  return found
}

async function readJson(url) {
  const response = await fetch(url, { cache: "no-store" })
  if (!response.ok) throw new Error(`HTTP ${response.status} 读取 ${url} 失败`)
  return response.json()
}

async function ensureWithinTestsRoot(target) {
  const root = path.resolve(testsRoot)
  const absolute = path.resolve(target)
  const relative = path.relative(root, absolute)
  if (!relative || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw new Error("拒绝清理位于 .tmp/tests 之外的目录")
  return absolute
}

async function collectTextFiles(root, out = []) {
  let entries
  try { entries = await readdir(root, { withFileTypes: true }) } catch { return out }
  for (const entry of entries) {
    const target = path.join(root, entry.name)
    if (entry.isDirectory()) await collectTextFiles(target, out)
    else if (entry.isFile() && !entry.name.endsWith(".exe") && !entry.name.endsWith(".zip")) out.push(target)
  }
  return out
}

const runId = randomUUID()
const sandbox = await mkdtemp(path.join(testsRoot, "admin-browser-"))
const dataDir = path.join(sandbox, "data")
const serviceTmp = path.join(sandbox, "service-tmp")
const workspaceRoot = path.join(sandbox, "workspace")
const browserProfile = path.join(sandbox, "edge-profile")
const credentialTarget = `ChatCode/Validation/admin-browser-${runId}`
const testKey = `chatcode-validation-placeholder-${runId}`
const port = await freePort()
const origin = `http://127.0.0.1:${port}`
const adminEntry = path.join(projectRoot, "apps", "server", "admin.mjs")
const credentialScript = path.join(projectRoot, "scripts", "credential-store.ps1")
const candidateClient = process.env.CHATCODE_TEST_TUNNEL_CLIENT ?? path.join(projectRoot, ".tmp", "tunnel-client-validation", "tunnel-client.exe")
const clientAvailable = existsSync(candidateClient)
let admin
let edge
let page
let browser
let adminOutput = ""
let edgeOutput = ""
let sessionToken = ""
let report = { runId, browser: "Microsoft Edge headless with DevTools protocol", origin, assertions: [] }
let screenshotSaved = false

function record(assertion, evidence) {
  report.assertions.push({ assertion, evidence })
}

async function pageValue(expression) { return page.evaluate(expression) }
async function waitPage(expression, label, timeoutMs = 15000) { await waitFor(async () => Boolean(await pageValue(expression)), label, timeoutMs) }
async function click(selector) { return page.evaluate(`document.querySelector(${JSON.stringify(selector)}).click()`) }
async function fill(selector, value, event = "input") {
  return page.evaluate(`(() => { const e=document.querySelector(${JSON.stringify(selector)}); e.value=${JSON.stringify(value)}; e.dispatchEvent(new Event(${JSON.stringify(event)},{bubbles:true})); })()`)
}

async function shutdownAdmin() {
  if (!admin) return
  if (admin.exitCode !== null) return
  try {
    await fetch(`${origin}/api/shutdown`, {
      method: "POST",
      headers: { Origin: origin, "X-ChatCode-CSRF": sessionToken, "Content-Type": "application/json" },
      body: "{}",
    })
  } catch { /* service may already have exited */ }
  await Promise.race([new Promise((resolve) => admin.once("close", resolve)), delay(5000)])
  if (admin.exitCode === null) admin.kill()
}

async function cleanupCredential() {
  try {
    execFileSync(powerShell, ["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", credentialScript, "-Operation", "delete"], {
      encoding: "utf8", windowsHide: true, env: { ...process.env, CHATCODE_CREDENTIAL_TARGET: credentialTarget }, stdio: ["ignore", "ignore", "ignore"],
    })
  } catch { /* target is absent or Windows Credential Manager is unavailable */ }
}

try {
  await mkdir(testsRoot, { recursive: true })
  await Promise.all([mkdir(dataDir, { recursive: true }), mkdir(serviceTmp, { recursive: true }), mkdir(workspaceRoot, { recursive: true })])
  await writeFile(path.join(workspaceRoot, "README.md"), "isolated browser workspace\n", "utf8")
  admin = spawn(process.execPath, [adminEntry], {
    cwd: projectRoot,
    env: {
      ...process.env,
      CHATCODE_HOME: projectRoot,
      CHATCODE_DATA_DIR: dataDir,
      CHATCODE_TMP_DIR: serviceTmp,
      CHATCODE_PORT: String(port),
      CHATCODE_CREDENTIAL_TARGET: credentialTarget,
    },
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
  })
  admin.stdout.on("data", (chunk) => { adminOutput = (adminOutput + chunk.toString("utf8")).slice(-3000) })
  admin.stderr.on("data", (chunk) => { adminOutput = (adminOutput + chunk.toString("utf8")).slice(-3000) })
  await waitFor(async () => {
    if (admin.exitCode !== null) throw new Error(`ChatCode admin 退出：${adminOutput}`)
    try { return (await readJson(`${origin}/healthz`)).status === "ok" } catch { return false }
  }, "隔离 ChatCode 管理服务启动", 12000)
  const session = await readJson(`${origin}/api/session`)
  sessionToken = session.csrf
  assert.equal(session.apiVersion, 2)
  assert.equal(session.port, port)
  record("管理服务 healthz 与 CSRF session 已实际完成", { port: session.port, origin: session.origin })

  const edgePath = edgeExecutable()
  edge = spawn(edgePath, [
    "--headless=new", "--disable-gpu", "--disable-background-networking", "--no-first-run", "--no-default-browser-check",
    `--user-data-dir=${browserProfile}`, "--remote-debugging-port=0", "--remote-allow-origins=*", origin,
  ], { windowsHide: true, stdio: ["ignore", "ignore", "pipe"] })
  edge.stderr.on("data", (chunk) => { edgeOutput = (edgeOutput + chunk.toString("utf8")).slice(-4000) })
  const activePortFile = path.join(browserProfile, "DevToolsActivePort")
  let debugPort
  await waitFor(async () => {
    if (edge.exitCode !== null) throw new Error(`Edge 退出：${edgeOutput}`)
    try {
      const lines = (await readFile(activePortFile, "utf8")).split(/\r?\n/)
      debugPort = Number(lines[0])
      return debugPort > 0
    } catch { return false }
  }, "Edge DevTools 端口启动", 15000)
  const versionInfo = await readJson(`http://127.0.0.1:${debugPort}/json/version`)
  browser = await new DevTools(versionInfo.webSocketDebuggerUrl).connect()
  const pages = await readJson(`http://127.0.0.1:${debugPort}/json/list`)
  const target = pages.find((item) => item.type === "page" && item.url.startsWith(origin))
  assert.ok(target?.webSocketDebuggerUrl, "Edge 已打开本机管理页")
  page = await new DevTools(target.webSocketDebuggerUrl).connect()
  await page.send("Page.enable")
  await page.send("Runtime.enable")
  await page.send("Network.enable", { maxTotalBufferSize: 4_000_000, maxResourceBufferSize: 1_000_000 })

  const legacyUrl = `data:text/html;charset=utf-8,${encodeURIComponent('<!doctype html><script>try { await Promise.resolve(); } catch (error) {}</script>')}`
  await page.navigate(legacyUrl)
  await waitFor(() => page.events.some((event) => event.method === "Runtime.exceptionThrown" && /SyntaxError/.test(JSON.stringify(event.params))), "经典脚本顶层 await 的浏览器 SyntaxError")
  record("浏览器确认经典脚本顶层 await 会在解析阶段产生 SyntaxError", "isolated Edge classic-script probe")

  page.events.length = 0
  await page.navigate(origin)
  await waitPage("document.querySelector('#service')?.dataset.state === 'connected'", "前端服务状态变为已连接")
  await waitPage("document.querySelector('#workspaces')?.children.length > 0", "工作区查询完成")
  const jsResponse = page.events.find((event) => event.method === "Network.responseReceived" && event.params.response.url === `${origin}/admin.js`)
  const cssResponse = page.events.find((event) => event.method === "Network.responseReceived" && event.params.response.url === `${origin}/admin.css`)
  const sessionResponse = page.events.find((event) => event.method === "Network.responseReceived" && event.params.response.url === `${origin}/api/session`)
  assert.equal(jsResponse?.params.response.status, 200)
  assert.equal(jsResponse?.params.response.mimeType, "text/javascript")
  assert.equal(cssResponse?.params.response.status, 200)
  assert.equal(sessionResponse?.params.response.status, 200)
  const failedPageResources = page.events.filter((event) => event.method === "Network.loadingFailed" && /127\.0\.0\.1/.test(event.params.requestId ?? ""))
  assert.equal(failedPageResources.length, 0)
  assert.equal(page.events.filter((event) => event.method === "Runtime.exceptionThrown").length, 0, "修复页没有未处理的浏览器异常")
  record("管理页模块脚本、CSS、session 和基础列表在真实浏览器中成功加载", { jsStatus: 200, jsMime: jsResponse.params.response.mimeType, sessionStatus: 200, failedResources: failedPageResources.length })

  await page.send("Fetch.enable", { patterns: [{ urlPattern: `${origin}/api/workspaces`, requestStage: "Request" }] })
  const workspaceRequestPaused = page.waitForEvent("Fetch.requestPaused")
  await page.evaluate(`(() => {
    const pathInput=document.querySelector('#workspace-form [name=path]');
    pathInput.value=${JSON.stringify(workspaceRoot)};
    pathInput.dispatchEvent(new Event('input',{bubbles:true}));
    const nameInput=document.querySelector('#workspace-form [name=name]');
    nameInput.value='Browser Fixture';
    nameInput.dispatchEvent(new Event('input',{bubbles:true}));
    document.querySelector('#workspace-form [name=mode]').value='autoWritable';
    document.querySelector('#workspace-form [name=confirmAutoWrite]').checked=true;
    document.querySelector('#workspace-form').requestSubmit();
  })()`)
  const pausedWorkspaceRequest = await workspaceRequestPaused
  assert.equal(await pageValue("document.querySelector('#add-workspace').disabled"), true, "工作区 POST 等待期间提交按钮必须禁用")
  await page.send("Fetch.continueRequest", { requestId: pausedWorkspaceRequest.params.requestId })
  await page.send("Fetch.disable")
  await waitPage("document.querySelector('#workspace-message')?.textContent.includes('已保存')", "工作区表单提交成功提示")
  assert.equal(await pageValue("location.search"), "", "工作区提交不得修改地址栏查询参数")
  const workspacePost = page.events.find((event) => event.method === "Network.requestWillBeSent" && event.params.request.url === `${origin}/api/workspaces` && event.params.request.method === "POST")
  assert.ok(workspacePost, "浏览器实际发出 POST /api/workspaces")
  record("工作区通过浏览器表单真实 POST 添加，地址栏未附加字段且等待期间禁止重复提交", { method: workspacePost.params.request.method, url: workspacePost.params.request.url, locationSearch: "", submitDisabledWhilePending: true })

  const workspaceData = JSON.parse(await readFile(path.join(dataDir, "workspaces.json"), "utf8"))
  assert.equal(workspaceData.length, 1)
  assert.equal(workspaceData[0].name, "Browser Fixture")
  assert.equal(path.resolve(workspaceData[0].root).toLowerCase(), path.resolve(workspaceRoot).toLowerCase())
  assert.equal(workspaceData[0].mode, "autoWritable")
  assert.ok(workspaceData[0].autoWriteGrantedAt)

  await page.send("Page.reload", { ignoreCache: true })
  await waitPage("document.querySelector('#service')?.dataset.state === 'connected'", "刷新后连接状态恢复")
  await waitPage("document.querySelector('#workspaces')?.textContent.includes('Browser Fixture')", "刷新后工作区从持久状态恢复")
  record("刷新页面后已授权工作区和免逐项审批授予时间从 data/workspaces.json 恢复", { count: workspaceData.length, mode: workspaceData[0].mode, autoWriteGrantedAt: workspaceData[0].autoWriteGrantedAt })

  const committingUploadId = randomUUID()
  const uploadDirectory = path.join(serviceTmp, "uploads")
  await mkdir(uploadDirectory, { recursive: true })
  const uploadCreated = new Date(Date.now() - 5_000).toISOString()
  const commitStarted = new Date(Date.now() - 2_000).toISOString()
  await writeFile(path.join(uploadDirectory, `${committingUploadId}.part`), Buffer.from([0x42]))
  await writeFile(path.join(uploadDirectory, `${committingUploadId}.json`), `${JSON.stringify({
    id: committingUploadId, workspaceId: workspaceData[0].id, path: "commit-phase.bin", sizeBytes: "1",
    expectedHash: null, idempotencyKey: randomUUID(), receivedBytes: "1", lastChunk: null,
    status: "uploading", phase: "committing", transferCompletedAt: uploadCreated,
    createdAt: uploadCreated, commitStartedAt: commitStarted, updatedAt: commitStarted,
  })}\n`, "utf8")
  await waitPage("document.querySelector('#uploads')?.textContent.includes('提交校验中')", "浏览器显示上传完成后的 SHA-256/原子发布阶段", 20000)
  assert.match(await pageValue("document.querySelector('#uploads').textContent"), /数据已收完，正在复核 SHA-256 并原子发布/)
  assert.equal(await pageValue("[...document.querySelectorAll('#uploads button')].some(button=>button.textContent.includes('取消上传'))"), false, "提交校验期间不得显示无法执行的取消按钮")
  record("上传面板展示提交校验阶段、总耗时与已收字节，且不显示误导性的取消操作", { phase: "committing", cancelVisible: false })

  await click("#workspaces .card button")
  await waitPage("document.querySelector('#global-message')?.textContent.includes('目录可访问')", "工作区测试访问反馈")
  await page.evaluate(`(() => { const card=[...document.querySelectorAll('#workspaces .card')].find(item=>item.textContent.includes('Browser Fixture')); [...card.querySelectorAll('button')].find(item=>item.textContent.includes('暂停授权')).click(); })()`)
  await waitPage("document.querySelector('#workspaces')?.textContent.includes('已暂停')", "暂停工作区授权")
  await page.evaluate(`(() => { const card=[...document.querySelectorAll('#workspaces .card')].find(item=>item.textContent.includes('Browser Fixture')); [...card.querySelectorAll('button')].find(item=>item.textContent.includes('恢复授权')).click(); })()`)
  await waitPage("document.querySelector('#workspaces')?.textContent.includes('已启用')", "恢复工作区授权")
  await page.evaluate(`(() => { const card=[...document.querySelectorAll('#workspaces .card')].find(item=>item.textContent.includes('Browser Fixture')); [...card.querySelectorAll('button')].find(item=>item.textContent.includes('设为逐项审批')).click(); })()`)
  await waitPage("document.querySelector('#workspaces')?.textContent.includes('可写（逐项审批）')", "工作区权限切换为可写")
  const autoWriteDialog = page.waitForEvent("Page.javascriptDialogOpening")
  const autoWriteClick = page.evaluate(`(() => { const card=[...document.querySelectorAll('#workspaces .card')].find(item=>item.textContent.includes('Browser Fixture')); [...card.querySelectorAll('button')].find(item=>item.textContent.includes('启用免逐项审批写入')).click(); })()`)
  await autoWriteDialog
  await page.send("Page.handleJavaScriptDialog", { accept: true })
  await autoWriteClick
  await waitPage("document.querySelector('#workspaces')?.textContent.includes('可写（无需逐项审批）')", "工作区权限切换为免逐项审批写入")
  const grantedWorkspace = JSON.parse(await readFile(path.join(dataDir, "workspaces.json"), "utf8"))[0]
  assert.ok(grantedWorkspace.autoWriteGrantedAt)
  await page.evaluate(`(() => { const card=[...document.querySelectorAll('#workspaces .card')].find(item=>item.textContent.includes('Browser Fixture')); [...card.querySelectorAll('button')].find(item=>item.textContent.includes('设为只读')).click(); })()`)
  await waitPage("document.querySelector('#workspaces')?.textContent.includes('只读')", "工作区权限切回只读")
  record("工作区暂停、恢复、逐项审批/免审批/只读切换和访问测试均由浏览器控件触发", { operations: ["test_access", "pause", "resume", "writable", "autoWritable", "readOnly"] })

  await page.evaluate(`(() => { const form=document.querySelector('#workspace-form'); form.elements.name.value='Duplicate Fixture'; form.elements.name.dispatchEvent(new Event('input',{bubbles:true})); form.elements.path.value=${JSON.stringify(workspaceRoot)}; form.elements.path.dispatchEvent(new Event('input',{bubbles:true})); form.requestSubmit(); })()`)
  await waitPage("document.querySelector('#workspace-message')?.classList.contains('bad') && document.querySelector('#workspace-message').textContent.includes('授权冲突')", "重复工作区路径显示可读冲突")
  assert.equal(JSON.parse(await readFile(path.join(dataDir, "workspaces.json"), "utf8")).length, 1)
  await mkdir(path.join(workspaceRoot, "nested"), { recursive: true })
  await page.evaluate(`(() => { const form=document.querySelector('#workspace-form'); form.elements.name.value='Nested Fixture'; form.elements.name.dispatchEvent(new Event('input',{bubbles:true})); form.elements.path.value=${JSON.stringify(path.join(workspaceRoot, "nested"))}; form.elements.path.dispatchEvent(new Event('input',{bubbles:true})); form.requestSubmit(); })()`)
  await waitPage("document.querySelector('#workspace-message')?.classList.contains('bad') && document.querySelector('#workspace-message').textContent.includes('授权冲突')", "父子工作区路径显示可读冲突")
  assert.equal(JSON.parse(await readFile(path.join(dataDir, "workspaces.json"), "utf8")).length, 1)
  record("重复目录和父子目录冲突通过真实浏览器表单拒绝，持久授权记录不变", { workspaceCount: 1, nestedDirectoryExists: true })

  const missingPath = `${workspaceRoot}-missing-${runId}`
  await page.evaluate(`(() => {
    const form=document.querySelector('#workspace-form');
    form.elements.name.value='Invalid Fixture';
    form.elements.name.dispatchEvent(new Event('input',{bubbles:true}));
    form.elements.path.value=${JSON.stringify(missingPath)};
    form.elements.path.dispatchEvent(new Event('input',{bubbles:true}));
    form.requestSubmit();
  })()`)
  await waitPage("document.querySelector('#workspace-message')?.classList.contains('bad') && document.querySelector('#workspace-message').textContent.includes('失败')", "非法/不存在的路径显示前端可读错误")
  assert.equal(JSON.parse(await readFile(path.join(dataDir, "workspaces.json"), "utf8")).length, 1, "非法路径不得写入授权状态")
  record("不存在的绝对路径在页面中显示失败，且未写入持久授权记录", await pageValue("document.querySelector('#workspace-message').textContent"))

  const dialogOpened = page.waitForEvent("Page.javascriptDialogOpening")
  const removeClick = page.evaluate(`(() => { const card=[...document.querySelectorAll('#workspaces .card')].find(item=>item.textContent.includes('Browser Fixture')); [...card.querySelectorAll('button')].find(item=>item.textContent.trim()==='移除').click(); })()`)
  await dialogOpened
  await page.send("Page.handleJavaScriptDialog", { accept: true })
  await removeClick
  await waitPage("document.querySelector('#workspaces')?.textContent.includes('尚未授权目录')", "移除工作区")
  assert.equal(JSON.parse(await readFile(path.join(dataDir, "workspaces.json"), "utf8")).length, 0)
  record("移除按钮在确认后删除授权记录，不删除工作区目录", { workspaceDirectoryStillExists: Boolean(await stat(workspaceRoot)) })

  await click(".nav-button[data-page='settings']")
  await waitPage("document.querySelector('#http-badge')?.textContent === '已连接'", "连接设置显示真实管理服务状态")
  const localHttp = await pageValue("document.querySelector('#http-detail').textContent")
  assert.ok(localHttp.includes(String(port)))
  await click("#test-mcp")
  await waitPage("document.querySelector('#mcp-badge')?.textContent.startsWith('已验证')", "本机 MCP stdio 真实工具调用完成", 20000)
  record("设置页通过 StdioClientTransport 发现工具并实际调用 list_workspaces", { detail: await pageValue("document.querySelector('#mcp-detail').textContent") })

  if (clientAvailable) {
    await fill("#tunnel-settings-form [name=tunnelId]", "tunnel_0123456789abcdef0123456789abcdef")
    await fill("#tunnel-settings-form [name=clientPath]", candidateClient)
    await fill("#tunnel-settings-form [name=profile]", "browser-test")
    await click("#detect-client")
    await waitPage("document.querySelector('#client-message')?.textContent.includes('0.0.17')", "官方客户端版本检测")
    record("已用通过 SHA-256 校验的 OpenAI 官方客户端执行版本检测", await pageValue("document.querySelector('#client-message').textContent"))
    await click("#save-settings")
    await waitPage("document.querySelector('#client-message')?.textContent.includes('生成独立 Profile')", "官方客户端保存 Profile")
    const savedProfile = path.join(dataDir, "tunnel-client", "profiles", "browser-test.yaml")
    const profileText = await readFile(savedProfile, "utf8")
    assert.match(profileText, /env:CHATCODE_RUNTIME_API_KEY/)
    assert.doesNotMatch(profileText, /chatcode-validation-placeholder/)
    record("官方 tunnel-client init 生成独立 stdio Profile，密钥仅为 env 引用", { profilePath: savedProfile, containsRuntimeKeyReference: true })

    await fill("#credential-form [name=key]", testKey)
    await page.evaluate("document.querySelector('#credential-form').requestSubmit()")
    await waitPage("document.querySelector('#credential-badge')?.textContent === '已安全保存'", "Runtime API Key 写入 Windows Credential Manager")
    assert.equal(await pageValue("document.querySelector('#credential-form [name=key]').value"), "", "保存后密码框必须清空")
    const persistentFiles = await collectTextFiles(dataDir)
    const tempFiles = await collectTextFiles(serviceTmp)
    for (const file of [...persistentFiles, ...tempFiles]) assert.ok(!(await readFile(file, "utf8").catch(() => "")).includes(testKey), `明文测试密钥不得写入 ${file}`)
    record("测试密钥通过真实密码表单写入 Credential Manager，UI 清空且 data/.tmp 文本文件无明文", { credentialStatus: await pageValue("document.querySelector('#credential-badge').textContent"), persistedPlaintextFound: false })

    const deleteDialog = page.waitForEvent("Page.javascriptDialogOpening")
    const deleteClick = click("#delete-key")
    await deleteDialog
    await page.send("Page.handleJavaScriptDialog", { accept: true })
    await deleteClick
    await waitPage("document.querySelector('#credential-badge')?.textContent === '未配置'", "删除 Credential Manager 测试密钥")
    await click("#check-metadata")
    await waitPage("document.querySelector('#tunnel-operation-message')?.textContent.includes('请先在连接设置中录入 Runtime API Key')", "缺少凭据时 metadata 检查给出下一步提示")
    await click("#run-doctor")
    await waitPage("document.querySelector('#tunnel-operation-message')?.textContent.includes('尚未在 Windows Credential Manager 中录入')", "缺少凭据时 doctor 明确报告未配置")
    await fill("#tunnel-settings-form [name=profile]", "browser-test-renamed")
    await click("#save-settings")
    await waitPage("document.querySelector('#client-message')?.textContent.includes('生成独立 Profile')", "停止态修改 Profile 后重新生成配置")
    const updatedTunnelSettings = JSON.parse(await readFile(path.join(dataDir, "tunnel-settings.json"), "utf8"))
    assert.equal(updatedTunnelSettings.profile, "browser-test-renamed")
    record("未运行时更改 Profile 会重新生成配置并持久化新标识", { profile: updatedTunnelSettings.profile })
    await click("#start-tunnel")
    await waitPage("document.querySelector('#tunnel-operation-message')?.textContent.includes('请先在连接设置中录入 Runtime API Key')", "缺少凭据时阻止 Tunnel 启动")
    await click("#stop-tunnel")
    await waitPage("document.querySelector('#tunnel-operation-message')?.textContent.includes('Tunnel 已断开')", "未创建的本机 Tunnel alias 可安全报告为已断开")
    record("Tunnel 无凭据时 metadata/doctor/启动明确提示；停止未创建 alias 只影响 ChatCode 隔离状态", { metadataMessage: "需要 Runtime API Key", startBlocked: true, isolatedAliasStatus: "disconnected" })
  } else {
    record("Tunnel 客户端缺失态可继续使用本机管理页", "本机没有配置官方客户端绝对路径；没有安装或启动外部连接")
  }

  await click("#refresh-diagnostics")
  await waitPage("document.querySelector('#chatgpt-badge')?.textContent === '需网页确认'", "ChatGPT 状态诚实显示需要网页确认")
  assert.match(await pageValue("document.querySelector('#diagnostics-output').textContent"), /needs_web_confirmation|需在 ChatGPT 网页确认/)
  assert.equal(await pageValue("document.querySelector('#tunnel-badge').textContent"), "未连接", "未创建的本机 runtime 应显示未连接，不应误报连接错误")
  record("四层诊断分别显示 HTTP、MCP、未连接 Tunnel 与需在 ChatGPT 网页确认", { http: await pageValue("document.querySelector('#http-badge').textContent"), mcp: await pageValue("document.querySelector('#mcp-badge').textContent"), tunnel: await pageValue("document.querySelector('#tunnel-badge').textContent"), chatgpt: await pageValue("document.querySelector('#chatgpt-badge').textContent") })
  await page.send("Page.bringToFront")
  const settingsScreenshot = await page.send("Page.captureScreenshot", { format: "png", captureBeyondViewport: true })
  await mkdir(evidenceDir, { recursive: true })
  await writeFile(path.join(evidenceDir, "admin-settings.png"), Buffer.from(settingsScreenshot.data, "base64"))

  await page.send("Network.setBlockedURLs", { urls: [`${origin}/api/changes`] })
  await click("#retry-connection")
  await waitPage("document.querySelector('#service')?.dataset.state === 'failed'", "管理 API 断网时页面进入明确失败状态")
  assert.equal(await pageValue("document.querySelector('#add-workspace').disabled"), true, "连接失败后写操作必须禁用")
  await page.send("Network.setBlockedURLs", { urls: [] })
  await click("#retry-connection")
  await waitPage("document.querySelector('#service')?.dataset.state === 'connected'", "网络恢复后页面可重试恢复")
  record("真实浏览器断网/接口失败后显示错误并禁用写操作，解除故障后可重试恢复", { failureState: "failed", recoveryState: "connected" })

  await click(".nav-button[data-page='logs']")
  await waitPage("document.querySelector('#tunnel-logs')?.children.length > 0", "Tunnel 运行日志加载")
  await page.send("Page.bringToFront")
  const screenshot = await page.send("Page.captureScreenshot", { format: "png", captureBeyondViewport: true })
  await mkdir(evidenceDir, { recursive: true })
  await writeFile(path.join(evidenceDir, "admin-page.png"), Buffer.from(screenshot.data, "base64"))
  screenshotSaved = true

  const storedWorkspaces = JSON.parse(await readFile(path.join(dataDir, "workspaces.json"), "utf8"))
  assert.equal(storedWorkspaces.length, 0)
  report.result = "passed"
  report.testWorkspace = "temporary workspace under .tmp/tests; removed from authorization after UI test"
  report.credentials = "temporary validation credential deleted; no plaintext persisted"
  report.externalTunnel = "not verified; no user Tunnel ID or real Runtime API Key used"
  report.screenshot = path.join(evidenceDir, "admin-page.png")
  report.settingsScreenshot = path.join(evidenceDir, "admin-settings.png")
  report.finishedAt = new Date().toISOString()
} catch (error) {
  report.result = "failed"
  report.error = String(error?.message ?? error).slice(0, 2000)
  report.adminOutput = adminOutput
  report.edgeOutput = edgeOutput
  if (page && !screenshotSaved) {
    try {
      const screenshot = await page.send("Page.captureScreenshot", { format: "png", captureBeyondViewport: true })
      await mkdir(evidenceDir, { recursive: true })
      await writeFile(path.join(evidenceDir, "admin-page-failure.png"), Buffer.from(screenshot.data, "base64"))
      report.failureScreenshot = path.join(evidenceDir, "admin-page-failure.png")
    } catch { /* browser may have closed */ }
  }
} finally {
  try { await shutdownAdmin() } catch { /* the service may have crashed */ }
  try { await page?.close() } catch { /* isolated browser cleanup continues */ }
  try {
    if (browser?.socket?.readyState === WebSocket.OPEN) await browser.send("Browser.close")
  } catch { /* browser may have already exited */ }
  await Promise.race([new Promise((resolve) => edge?.once("close", resolve)), delay(4000)])
  if (edge && edge.exitCode === null) {
    try { execFileSync("taskkill.exe", ["/PID", String(edge.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" }) } catch { edge.kill() }
  }
  await cleanupCredential()
  const evidenceTarget = ensureWithinTestsRoot(evidenceDir)
  const reportPath = path.join(await evidenceTarget, "result.json")
  await mkdir(evidenceDir, { recursive: true })
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8")
  const safeSandbox = await ensureWithinTestsRoot(sandbox)
  await rm(safeSandbox, { recursive: true, force: true })
}

if (report.result !== "passed") {
  process.stderr.write(`${JSON.stringify(report, null, 2)}\n`)
  process.exitCode = 1
} else {
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`)
}
