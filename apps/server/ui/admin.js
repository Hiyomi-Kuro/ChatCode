let csrf = ""
let sessionReady = false
let diagnosticsData = null

const byId = (id) => document.getElementById(id)
const api = async (url, options = {}) => {
  const { timeoutMs = 12000, ...requestOptions } = options
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  const method = requestOptions.method ?? "GET"
  if (method === "POST" && !csrf) { clearTimeout(timer); throw new Error("安全会话尚未建立，写请求已阻止。") }
  const headers = {
    ...(requestOptions.body ? { "Content-Type": "application/json" } : {}),
    ...(method === "POST" && csrf ? { "X-ChatCode-CSRF": csrf } : {}),
    ...(requestOptions.headers ?? {}),
  }
  try {
    const response = await fetch(url, { ...requestOptions, method, headers, cache: "no-store", redirect: "error", signal: controller.signal })
    const contentType = response.headers.get("content-type") ?? ""
    if (!contentType.toLowerCase().includes("application/json")) throw new Error(`本机服务返回了非 JSON 响应（HTTP ${response.status}）。请检查服务版本并重试。`)
    let data
    try { data = await response.json() } catch { throw new Error(`本机服务的 JSON 响应无效（HTTP ${response.status}）。`) }
    if (!response.ok) throw new Error(data?.error ?? `本机请求失败（HTTP ${response.status}）。`)
    return data
  } catch (error) {
    if (error?.name === "AbortError") throw new Error(`本机请求超过 ${Math.round(timeoutMs / 1000)} 秒，请重试。`)
    if (error instanceof TypeError) throw new Error("无法连接本机服务。请确认 ChatCode 正在运行，然后重试。")
    throw error
  } finally {
    clearTimeout(timer)
  }
}

const post = (url, body = {}, timeoutMs = 12000) => api(url, { method: "POST", body: JSON.stringify(body), timeoutMs })
const sessionControlIds = [
  "browse-folder", "add-workspace", "test-mcp", "detect-client", "save-settings", "save-key", "delete-key",
  "save-settings-shortcut", "check-metadata", "run-doctor", "start-tunnel", "stop-tunnel", "refresh-diagnostics", "copy-diagnostics",
]
function enableSessionControls(enabled) {
  for (const id of sessionControlIds) if (byId(id)) byId(id).disabled = !enabled
}
enableSessionControls(false)
const el = (tag, className, text) => {
  const node = document.createElement(tag)
  if (className) node.className = className
  if (text !== undefined) node.textContent = String(text)
  return node
}
const empty = (message) => el("div", "empty", message)
const globalMessage = el("div", "notice global-notice")
globalMessage.id = "global-message"
globalMessage.setAttribute("role", "status")
globalMessage.setAttribute("aria-live", "polite")
globalMessage.hidden = true
document.querySelector("main").prepend(globalMessage)

function showNotice(node, message, kind = "ok") {
  node.textContent = message
  node.className = `notice ${kind}`
  node.hidden = false
}

function clearNotice(node) {
  node.textContent = ""
  node.hidden = true
}

function setServiceState(state, message) {
  const service = byId("service")
  service.className = `pill ${state}`
  service.textContent = message
  service.dataset.state = state
}

function setBadge(node, state, text) {
  node.className = `badge ${state}`.trim()
  node.textContent = text
}

function button(label, action, style = "secondary") {
  const node = el("button", style, label)
  node.type = "button"
  node.addEventListener("click", async () => {
    if (!sessionReady) return showNotice(globalMessage, "安全会话尚未连接，暂时不能执行写操作。请重试连接。", "bad")
    node.disabled = true
    clearNotice(globalMessage)
    try {
      await action()
    } catch (error) {
      showNotice(globalMessage, error.message, "bad")
    } finally {
      node.disabled = false
    }
  })
  return node
}

function renderWorkspaces(items) {
  const root = byId("workspaces")
  root.replaceChildren()
  if (!items.length) return root.append(empty("尚未授权目录。可以先添加 .tmp/tests 中的隔离测试项目。"))
  for (const item of items) {
    const card = el("article", "card")
    const head = el("div", "card-head")
    const modeLabel = item.mode === "autoWritable" ? "可写（无需逐项审批）" : item.mode === "writable" ? "可写（逐项审批）" : "只读"
    head.append(
      el("div", "card-title", item.name),
      el("span", `badge ${item.status === "active" ? "ok" : ""}`, `${item.status === "active" ? "已启用" : "已暂停"} · ${modeLabel}`),
    )
    card.append(head, el("div", "meta", `绝对路径：${item.path}`), el("div", "meta", `更新时间：${item.updatedAt ?? "未知"}`))
    if (item.mode === "autoWritable") card.append(el("div", "meta", `免逐项审批授予时间：${item.autoWriteGrantedAt ?? "旧数据无记录"}`))
    if (item.allowSensitive) card.append(el("div", "meta", `敏感文件访问已单独授权：${item.sensitiveGrantedAt ?? "旧数据无记录"}`))
    const actions = el("div", "actions")
    actions.append(button("测试访问", async () => {
      const result = await api(`/api/workspaces/${item.id}/test`)
      const testedMode = result.mode === "autoWritable" ? "可写（无需逐项审批）" : result.mode === "writable" ? "可写（仍需审批）" : "只读"
      showNotice(globalMessage, `目录可访问：${result.path} · ${testedMode}`, "ok")
    }))
    actions.append(button(item.status === "active" ? "暂停授权" : "恢复授权", async () => {
      await post(`/api/workspaces/${item.id}/${item.status === "active" ? "pause" : "resume"}`)
      await refreshCore()
    }))
    if (item.mode !== "readOnly") actions.append(button("设为只读", async () => {
      await post(`/api/workspaces/${item.id}/readonly`)
      await refreshCore()
    }))
    if (item.mode !== "writable") actions.append(button("设为逐项审批", async () => {
      await post(`/api/workspaces/${item.id}/writable`)
      await refreshCore()
    }, "secondary"))
    if (item.mode !== "autoWritable") actions.append(button("启用免逐项审批写入", async () => {
      if (!confirm(`确认对工作区“${item.name}”授予免逐项审批写入？普通文件创建、覆盖、编辑和目录创建不会再经过 ChatCode 本机逐文件审批。ChatGPT 平台确认、授权路径与版本冲突检查仍然生效。`)) return
      await post(`/api/workspaces/${item.id}/auto-write`, { confirmAutoWrite: true })
      await refreshCore()
    }))
    actions.append(button(item.allowSensitive ? "撤销敏感文件访问" : "单独授权敏感文件访问", async () => {
      if (!item.allowSensitive && !confirm(`确认允许“${item.name}”工作区访问 .env、密钥、凭据等敏感文件？这些内容不会写入审计日志。`)) return
      await post(`/api/workspaces/${item.id}/${item.allowSensitive ? "sensitive-off" : "sensitive-on"}`, item.allowSensitive ? {} : { confirmSensitive: true })
      await refreshCore()
    }, item.allowSensitive ? "danger" : "secondary"))
    actions.append(button("移除", async () => {
      if (!confirm(`移除工作区“${item.name}”？这只会移除 ChatCode 授权，不会删除目录。`)) return
      await post(`/api/workspaces/${item.id}/remove`)
      await refreshCore()
    }, "danger"))
    card.append(actions)
    root.append(card)
  }
}

function renderChanges(items) {
  const root = byId("changes")
  root.replaceChildren()
  const visible = items.filter((item) => ["pending_approval", "approved", "applied", "failed", "recovery_required"].includes(item.status)).reverse()
  if (!visible.length) return root.append(empty("当前没有待审批的文件变更。"))
  for (const item of visible.slice(0, 30)) {
    const card = el("article", "card")
    const head = el("div", "card-head")
    head.append(el("div", "card-title", item.path), el("span", `badge ${item.status === "applied" ? "ok" : item.status.includes("failed") || item.status === "recovery_required" ? "bad" : ""}`, item.status))
    card.append(head, el("div", "meta", `变更 ID：${item.id}${item.batchId ? ` · 批次：${item.batchId}` : ""} · 目标 SHA-256：${item.proposedHash}`))
    card.append(el("pre", "diff", item.diff ?? "Diff 不可用"))
    if (item.failure) card.append(el("div", "meta", `失败原因：${item.failure}`))
    if (item.status === "pending_approval") card.append(button("我已检查 Diff，批准此修改", async () => { await post(`/api/changes/${item.id}/approve`); await refreshCore() }, ""))
    if (item.status === "approved") card.append(el("div", "meta", "已由本机批准。ChatGPT 现在可以调用 apply_change 写入文件。"))
    if (item.status === "recovery_required") card.append(el("div", "meta", "检测到操作中断。只有文件仍匹配 ChatCode 记录的版本时，恢复操作才会还原原始内容；其他改动会被保留。"))
    if (["applied", "failed", "recovery_required"].includes(item.status) && !item.create && !item.createDirectory) {
      card.append(button("恢复原文件", async () => {
        if (!confirm(`将“${item.path}”恢复为这次修改前的内容？如果文件已有其他改动，ChatCode 会拒绝覆盖。`)) return
        await post(`/api/changes/${item.id}/recover`)
        await refreshCore()
      }, "danger"))
    }
    root.append(card)
  }
}

function renderTasks(items) {
  const root = byId("tasks")
  root.replaceChildren()
  if (!items.length) return root.append(empty("没有项目脚本任务。"))
  for (const item of items.slice(0, 30)) {
    const card = el("article", "card")
    const head = el("div", "card-head")
    head.append(el("div", "card-title", `${item.command} · ${item.id}`), el("span", `badge ${item.status === "succeeded" ? "ok" : ["failed", "timed_out", "cancelled", "interrupted"].includes(item.status) ? "bad" : ""}`, item.status))
    card.append(head, el("div", "meta", `工作区：${item.workspaceDisplay ?? item.workspaceId} · 请求时间：${item.requestedAt}`))
    card.append(el("pre", "script", item.scriptPreview ?? ""))
    if (item.status === "awaiting_approval") card.append(button("批准运行此项目脚本", async () => { await post(`/api/tasks/${item.id}/approve`); await refreshCore() }, ""))
    if (item.status === "approved") card.append(el("div", "meta", "本机已批准。ChatGPT 可以调用 run_approved_check 启动。"))
    if (["running", "starting"].includes(item.status)) card.append(button("取消任务", async () => { await post(`/api/tasks/${item.id}`, { action: "cancel" }); await refreshCore() }, "danger"))
    if (item.error) card.append(el("div", "meta", `错误：${item.error}`))
    if (item.output) card.append(el("pre", "output", item.output))
    root.append(card)
  }
}

function renderAudit(items) {
  const root = byId("audit")
  root.replaceChildren()
  if (!items.length) return root.append(empty("尚无操作记录。"))
  for (const item of items.slice().reverse().slice(0, 80)) {
    const row = el("div", "audit-row")
    row.append(el("span", "", item.at), el("strong", "", item.event), el("span", "", [item.path, item.result].filter(Boolean).join(" · ")))
    root.append(row)
  }
}

function renderTunnelLogs(items) {
  const root = byId("tunnel-logs")
  root.replaceChildren()
  if (!items.length) return root.append(empty("尚无 Tunnel 诊断记录。"))
  for (const item of items.slice().reverse().slice(0, 100)) {
    const row = el("div", "audit-row")
    row.append(el("span", "", item.at), el("strong", "", item.event), el("span", "", item.message))
    root.append(row)
  }
}

function formatBytes(value) {
  try { return `${BigInt(value).toLocaleString()} bytes` } catch { return `${value} bytes` }
}

function renderUploads(items, workspaces) {
  const root = byId("uploads")
  root.replaceChildren()
  if (!items.length) return root.append(empty("当前没有进行中的上传。"))
  const names = new Map(workspaces.map((workspace) => [workspace.id, workspace.name]))
  for (const item of items) {
    const card = el("article", "card")
    const head = el("div", "card-head")
    const committing = item.phase === "committing"
    head.append(el("div", "card-title", `${item.path} · ${item.progress_percent}%`), el("span", "badge", committing ? "提交校验中" : "上传中"))
    const bar = document.createElement("progress")
    bar.max = 100
    bar.value = item.progress_percent
    bar.setAttribute("aria-label", `${committing ? "文件提交校验" : "上传进度"} ${item.progress_percent}%`)
    card.append(
      head,
      el("div", "meta", `工作区：${names.get(item.workspace_id) ?? item.workspace_id}`),
      el("div", "meta", `已收 ${formatBytes(item.received_bytes)} / ${formatBytes(item.size_bytes)} · ${formatBytes(item.bytes_per_second)}/秒 · ${(item.elapsed_ms / 1000).toFixed(1)} 秒`),
      el("div", "meta", `最近活动：${item.updated_at} · 空闲过期：${item.expires_at}`),
      ...(committing ? [el("div", "meta", `数据已收完，正在复核 SHA-256 并原子发布；提交阶段 ${(item.phase_elapsed_ms / 1000).toFixed(1)} 秒。`)] : []),
      bar,
    )
    if (!committing) card.append(button("取消上传", async () => {
        await post(`/api/uploads/${item.upload_id}/abort`)
        await refreshCore()
      }, "danger"))
    root.append(card)
  }
}

async function refreshCore() {
  try {
    const [workspaces, changes, tasks, audit, uploads] = await Promise.all([
      api("/api/workspaces"), api("/api/changes"), api("/api/tasks"), api("/api/audit"), api("/api/uploads"),
    ])
    renderWorkspaces(workspaces.workspaces)
    renderChanges(changes.changes)
    const workspaceNames = new Map(workspaces.workspaces.map((workspace) => [workspace.id, `${workspace.name} · ${workspace.path}`]))
    renderTasks(tasks.tasks.map((task) => ({ ...task, workspaceDisplay: workspaceNames.get(task.workspaceId) ?? task.workspaceId })))
    renderAudit(audit.events)
    renderUploads(uploads.uploads, workspaces.workspaces)
    setServiceState("connected", `本机服务已连接 · 127.0.0.1:${window.location.port || "80"}`)
    return true
  } catch (error) {
    sessionReady = false
    enableSessionControls(false)
    setServiceState("failed", `连接失败：${error.message}`)
    showNotice(globalMessage, `本机状态读取失败：${error.message}`, "bad")
    return false
  }
}

async function initialize() {
  setServiceState("connecting", "正在验证本机服务与安全会话…")
  byId("retry-connection").disabled = true
  try {
    const session = await api("/api/session")
    if (session.apiVersion !== 2 || typeof session.csrf !== "string" || session.csrf.length < 32 || session.origin !== window.location.origin) throw new Error("管理服务版本或安全会话来源不匹配。请重启 ChatCode 管理服务后重试。")
    csrf = session.csrf
    sessionReady = true
    enableSessionControls(true)
    const connected = await refreshCore()
    if (connected) clearNotice(globalMessage)
    if (byId("page-settings").hidden === false) await refreshSettings()
  } catch (error) {
    csrf = ""
    sessionReady = false
    enableSessionControls(false)
    setServiceState("failed", `本机服务连接失败：${error.message}`)
    showNotice(globalMessage, `${error.message} 点击“重试连接”可再次诊断。`, "bad")
  } finally {
    byId("retry-connection").disabled = false
  }
}

function showPage(name) {
  for (const page of document.querySelectorAll(".page")) page.hidden = page.id !== `page-${name}`
  for (const button of document.querySelectorAll(".nav-button")) {
    const active = button.dataset.page === name
    button.classList.toggle("active", active)
    if (active) button.setAttribute("aria-current", "page")
    else button.removeAttribute("aria-current")
  }
  if (name === "settings" && sessionReady) void refreshSettings()
  if (name === "logs" && sessionReady) void refreshLogs()
}

function statusFromMcp(value) {
  const badge = byId("mcp-badge")
  if (value.status === "ok") setBadge(badge, "ok", `已验证 · ${value.toolCount} 个工具`)
  else if (value.status === "failed") setBadge(badge, "bad", "测试失败")
  else setBadge(badge, "", "尚未测试")
  byId("mcp-detail").textContent = value.message ?? "本地 stdio MCP 尚未测试。"
}

function statusFromTunnel(value) {
  const badge = byId("tunnel-badge")
  const states = {
    connected: ["ok", value.ready ? "已连接且就绪" : "已连接"],
    starting: ["", "正在连接"],
    error: ["bad", "连接出错"],
    disconnected: ["", "未连接"],
    not_configured: ["", "未配置"],
  }
  const [tone, label] = states[value.status] ?? ["", value.status ?? "未知"]
  setBadge(badge, tone, label)
  const lines = [value.message]
  if (value.healthUrl) lines.push(`本机 Tunnel health：${value.healthUrl}`)
  if (value.credentialConfigured === false) lines.push("Runtime API Key 尚未录入。")
  if (value.clientConfigured === false) lines.push("尚未填写 tunnel-client.exe 路径。")
  byId("tunnel-detail").textContent = lines.filter(Boolean).join(" ") || "尚未获取 Tunnel 状态。"
  const configured = value.credentialConfigured
  setBadge(byId("credential-badge"), configured ? "ok" : "", configured ? "已安全保存" : "未配置")
}

function renderDiagnostics(data) {
  diagnosticsData = data
  setBadge(byId("http-badge"), "ok", "已连接")
  byId("http-detail").textContent = `监听地址：${data.management.bind}:${data.management.port} · 健康检查：${data.management.healthUrl} · PID ${data.management.pid}`
  statusFromMcp(data.mcp)
  statusFromTunnel(data.tunnel)
  setBadge(byId("chatgpt-badge"), "", "需网页确认")
  byId("chatgpt-detail").textContent = data.chatgpt.message
  byId("diagnostics-output").textContent = JSON.stringify({
    management: data.management,
    mcp: data.mcp,
    safeFs: data.safeFs,
    tunnel: {
      status: data.tunnel.status,
      running: data.tunnel.running,
      healthy: data.tunnel.healthy,
      ready: data.tunnel.ready,
      credentialConfigured: data.tunnel.credentialConfigured,
      clientConfigured: data.tunnel.clientConfigured,
      tunnelIdConfigured: data.tunnel.tunnelIdConfigured,
      profile: data.tunnel.profile,
      message: data.tunnel.message,
      lastError: data.tunnel.lastError,
    },
    chatgpt: data.chatgpt,
    tunnelEvents: data.tunnelEvents,
  }, null, 2)
}

async function refreshSettings() {
  if (!sessionReady) return
  try {
    const [saved, diagnostics] = await Promise.all([api("/api/tunnel/settings"), api("/api/diagnostics")])
    const form = byId("tunnel-settings-form")
    form.elements.tunnelId.value = saved.settings.tunnelId
    form.elements.clientPath.value = saved.settings.clientPath
    form.elements.profile.value = saved.settings.profile
    byId("profile-path").textContent = saved.profilePath
    setBadge(byId("credential-badge"), saved.credentialConfigured ? "ok" : "", saved.credentialConfigured ? "已安全保存" : "未配置")
    renderDiagnostics(diagnostics)
  } catch (error) {
    setBadge(byId("http-badge"), "bad", "诊断失败")
    byId("http-detail").textContent = error.message
    showNotice(byId("settings-message"), `连接诊断失败：${error.message}`, "bad")
  }
}

async function refreshLogs() {
  try {
    const [audit, logs] = await Promise.all([api("/api/audit"), api("/api/logs")])
    renderAudit(audit.events)
    renderTunnelLogs(logs.tunnel)
  } catch (error) {
    showNotice(globalMessage, `读取运行日志失败：${error.message}`, "bad")
  }
}

function localWindowsPath(value) {
  return /^[a-zA-Z]:[\\/](?:[^<>:"|?*\r\n\0]+)?$/.test(value) && !/^[a-zA-Z]:[\\/]{2}/.test(value)
}

function folderName(value) {
  return value.trim().replace(/[\\/]+$/, "").split(/[\\/]/).filter(Boolean).at(-1) ?? ""
}

const workspaceForm = byId("workspace-form")
const workspaceName = workspaceForm.elements.name
const workspacePath = workspaceForm.elements.path
workspaceName.dataset.edited = "false"
workspaceName.addEventListener("input", () => { workspaceName.dataset.edited = workspaceName.value.trim() ? "true" : "false" })
workspacePath.addEventListener("input", () => {
  if (workspaceName.dataset.edited !== "true" || !workspaceName.value.trim()) workspaceName.value = folderName(workspacePath.value)
})

workspaceForm.addEventListener("submit", async (event) => {
  event.preventDefault()
  if (!sessionReady) return showNotice(byId("workspace-message"), "安全会话未连接，工作区尚未提交。请先重试连接。", "bad")
  clearNotice(byId("workspace-message"))
  const name = workspaceName.value.trim()
  const pathValue = workspacePath.value.trim()
  const mode = workspaceForm.elements.mode.value
  const confirmAutoWrite = workspaceForm.elements.confirmAutoWrite.checked
  const allowSensitive = workspaceForm.elements.allowSensitive.checked
  if (!localWindowsPath(pathValue)) return showNotice(byId("workspace-message"), "请输入本机磁盘绝对路径，例如 D:\Projects\Demo；UNC、设备路径和相对路径不受支持。", "bad")
  if (name.length > 64 || /[\r\n\0]/.test(name)) return showNotice(byId("workspace-message"), "显示名称最多 64 个字符，且不能包含换行。", "bad")
  if (!new Set(["readOnly", "writable", "autoWritable"]).has(mode)) return showNotice(byId("workspace-message"), "请选择有效工作区权限。", "bad")
  if (mode === "autoWritable" && !confirmAutoWrite) return showNotice(byId("workspace-message"), "请选择独立确认框，才能授予免逐项审批写入。", "bad")
  const submit = byId("add-workspace")
  submit.disabled = true
  submit.textContent = "正在验证并保存…"
  showNotice(byId("workspace-message"), "正在验证本机路径并保存工作区授权…", "working")
  try {
    const result = await post("/api/workspaces", { name, path: pathValue, mode, confirmAutoWrite, allowSensitive, confirmSensitive: allowSensitive })
    workspaceForm.reset()
    workspaceName.dataset.edited = "false"
    const savedMode = mode === "autoWritable" ? "可写，普通文件不需本机逐项审批" : mode === "writable" ? "可写，文件仍需逐项审批" : "只读"
    showNotice(byId("workspace-message"), `工作区“${result.workspace.name}”已保存（${savedMode}${allowSensitive ? "；已单独授权敏感文件" : ""}）。`, "ok")
    await refreshCore()
  } catch (error) {
    showNotice(byId("workspace-message"), `添加失败：${error.message}`, "bad")
  } finally {
    submit.disabled = false
    submit.textContent = "添加工作区"
  }
})

byId("browse-folder").addEventListener("click", async () => {
  if (!sessionReady) return showNotice(byId("workspace-message"), "请先连接本机服务。", "bad")
  const buttonNode = byId("browse-folder")
  buttonNode.disabled = true
  try {
    const selection = await post("/api/workspaces/picker", {}, 125000)
    if (selection.cancelled) return showNotice(byId("workspace-message"), "已取消文件夹选择，未添加授权。", "")
    workspacePath.value = selection.path
    workspacePath.dispatchEvent(new Event("input", { bubbles: true }))
    showNotice(byId("workspace-message"), "已选择目录；点击“添加工作区”后才会进行授权。", "working")
  } catch (error) {
    showNotice(byId("workspace-message"), `无法打开系统文件夹选择器：${error.message}`, "bad")
  } finally { buttonNode.disabled = false }
})

byId("retry-connection").addEventListener("click", () => { void initialize() })
for (const tab of document.querySelectorAll(".nav-button")) tab.addEventListener("click", () => showPage(tab.dataset.page))

byId("test-mcp").addEventListener("click", async () => {
  if (!sessionReady) return showNotice(byId("settings-message"), "请先连接本机服务。", "bad")
  const buttonNode = byId("test-mcp")
  buttonNode.disabled = true
  buttonNode.textContent = "正在调用本机 MCP…"
  byId("mcp-detail").textContent = "正在启动 stdio MCP 子进程、读取工具清单并调用 list_workspaces…"
  try {
    const result = await post("/api/mcp/diagnostic", {}, 20000)
    statusFromMcp(result)
    showNotice(byId("settings-message"), result.message, "ok")
  } catch (error) {
    statusFromMcp({ status: "failed", message: error.message })
    showNotice(byId("settings-message"), `本机 MCP 测试失败：${error.message}`, "bad")
  } finally {
    buttonNode.disabled = false
    buttonNode.textContent = "测试本机 MCP"
  }
})

const settingsForm = byId("tunnel-settings-form")
async function saveSettings() {
  if (!sessionReady) throw new Error("安全会话尚未连接")
  const buttonNode = byId("save-settings")
  buttonNode.disabled = true
  try {
    const result = await post("/api/tunnel/settings", {
      tunnelId: settingsForm.elements.tunnelId.value.trim(),
      clientPath: settingsForm.elements.clientPath.value.trim(),
      profile: settingsForm.elements.profile.value.trim(),
    }, 30000)
    byId("profile-path").textContent = result.profilePath
    const message = result.profileReady ? "配置已保存，官方客户端已生成独立 Profile。" : `配置已保存。${result.warning}`
    showNotice(byId("client-message"), message, result.warning ? "working" : "ok")
    await refreshSettings()
    return result
  } finally { buttonNode.disabled = false }
}

settingsForm.addEventListener("submit", async (event) => {
  event.preventDefault()
  clearNotice(byId("client-message"))
  try { await saveSettings() } catch (error) { showNotice(byId("client-message"), `保存配置失败：${error.message}`, "bad") }
})

byId("detect-client").addEventListener("click", async () => {
  const buttonNode = byId("detect-client")
  buttonNode.disabled = true
  try {
    const result = await post("/api/tunnel/client-check", { clientPath: settingsForm.elements.clientPath.value.trim() })
    settingsForm.elements.clientPath.value = result.executable
    showNotice(byId("client-message"), `客户端可用：${result.version}`, "ok")
  } catch (error) { showNotice(byId("client-message"), `客户端检测失败：${error.message}`, "bad") }
  finally { buttonNode.disabled = false }
})

byId("save-settings-shortcut").addEventListener("click", async () => {
  try { await saveSettings(); showNotice(byId("tunnel-operation-message"), "连接配置已保存。", "ok") }
  catch (error) { showNotice(byId("tunnel-operation-message"), `保存配置失败：${error.message}`, "bad") }
})

byId("credential-form").addEventListener("submit", async (event) => {
  event.preventDefault()
  const field = event.currentTarget.elements.key
  const key = field.value
  if (!key) return showNotice(byId("settings-message"), "请先粘贴 Runtime API Key。", "bad")
  const buttonNode = byId("save-key")
  buttonNode.disabled = true
  try {
    await post("/api/tunnel/credential", { key })
    field.value = ""
    showNotice(byId("settings-message"), "Runtime API Key 已保存到 Windows Credential Manager，页面未保留密钥。", "ok")
    await refreshSettings()
  } catch (error) { showNotice(byId("settings-message"), `密钥保存失败：${error.message}`, "bad") }
  finally { buttonNode.disabled = false }
})

byId("delete-key").addEventListener("click", async () => {
  if (!confirm("从 Windows Credential Manager 删除 ChatCode 的 Runtime API Key？")) return
  const buttonNode = byId("delete-key")
  buttonNode.disabled = true
  try {
    await post("/api/tunnel/credential/delete")
    showNotice(byId("settings-message"), "Runtime API Key 已删除。", "ok")
    await refreshSettings()
  } catch (error) { showNotice(byId("settings-message"), `删除密钥失败：${error.message}`, "bad") }
  finally { buttonNode.disabled = false }
})

async function runTunnelOperation(buttonId, endpoint, pending, success) {
  const buttonNode = byId(buttonId)
  buttonNode.disabled = true
  showNotice(byId("tunnel-operation-message"), pending, "working")
  try {
    const result = await post(endpoint, {}, endpoint === "/api/tunnel/start" ? 70000 : 35000)
    showNotice(byId("tunnel-operation-message"), result.message ?? success, result.status === "error" ? "bad" : "ok")
    await refreshSettings()
  } catch (error) {
    showNotice(byId("tunnel-operation-message"), `${error.message}`, "bad")
    await refreshSettings()
  } finally { buttonNode.disabled = false }
}

byId("check-metadata").addEventListener("click", () => { void runTunnelOperation("check-metadata", "/api/tunnel/metadata", "正在使用 Runtime API Key 检查 Tunnel metadata…", "Tunnel metadata 检查成功。") })
byId("run-doctor").addEventListener("click", () => { void runTunnelOperation("run-doctor", "/api/tunnel/doctor", "正在运行 tunnel-client doctor…", "Tunnel doctor 检查完成。") })
byId("start-tunnel").addEventListener("click", () => { void runTunnelOperation("start-tunnel", "/api/tunnel/start", "正在启动受控的 tunnel-client 连接…", "Tunnel 已启动。") })
byId("stop-tunnel").addEventListener("click", () => { void runTunnelOperation("stop-tunnel", "/api/tunnel/stop", "正在停止 ChatCode 管理的 Tunnel…", "Tunnel 已断开。") })
byId("refresh-diagnostics").addEventListener("click", () => { void refreshSettings() })

byId("copy-diagnostics").addEventListener("click", async () => {
  if (!diagnosticsData) return showNotice(byId("settings-message"), "请先刷新连接诊断。", "bad")
  const data = diagnosticsData
  const safeCopy = {
    management: { status: data.management.status, bind: data.management.bind, port: data.management.port },
    mcp: data.mcp,
    safeFs: data.safeFs,
    tunnel: {
      status: data.tunnel.status,
      running: data.tunnel.running,
      healthy: data.tunnel.healthy,
      ready: data.tunnel.ready,
      credentialConfigured: data.tunnel.credentialConfigured,
      clientConfigured: data.tunnel.clientConfigured,
      tunnelIdConfigured: data.tunnel.tunnelIdConfigured,
      message: data.tunnel.message,
      lastError: data.tunnel.lastError,
    },
    chatgpt: data.chatgpt,
  }
  try {
    await navigator.clipboard.writeText(JSON.stringify(safeCopy, null, 2))
    showNotice(byId("settings-message"), "脱敏诊断已复制；未包含 Runtime API Key、Tunnel ID、工作区路径或文件内容。", "ok")
  } catch { showNotice(byId("settings-message"), "剪贴板不可用，请从本机诊断详情手动复制。", "bad") }
})

void initialize()
setInterval(() => { if (sessionReady) void refreshCore() }, 15000)
