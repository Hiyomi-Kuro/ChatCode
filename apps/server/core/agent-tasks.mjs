import { randomUUID } from "node:crypto"
import { audit } from "./audit.mjs"
import { collectGitContext } from "./git.mjs"
import { hashFile, listDirectory } from "./safe-fs.mjs"
import { mutateArray, readArray } from "./state.mjs"
import { hasBlockedExplicitDirectory, isSensitivePath, normalizeRelative, shouldSkipDirectory } from "./paths.mjs"
import { requireWorkspace } from "./workspaces.mjs"

const MAX_GOAL_CHARS = 12_000
const MAX_SUMMARY_CHARS = 2_000
const MAX_AGENT_STEP_CONCURRENCY = 3
const TERMINAL = new Set(["completed", "failed", "cancelled"])

function view(task) {
  const plan = (Array.isArray(task.plan) ? task.plan : []).map((step, index) => ({
    id: step.id ?? `step-${index + 1}`,
    index: Number.isInteger(step.index) ? step.index : index,
    title: step.title,
    dependencies: Array.isArray(step.dependencies) ? step.dependencies : [],
    status: step.status ?? "pending",
    attempts: Number.isInteger(step.attempts) ? step.attempts : 0,
    max_retries: Number.isInteger(step.max_retries) ? step.max_retries : 2,
    resource_locks: Array.isArray(step.resource_locks) ? step.resource_locks : [],
    failure_category: step.failure_category ?? null,
    input_versions: Array.isArray(step.input_versions) ? step.input_versions : [],
    artifacts: Array.isArray(step.artifacts) ? step.artifacts : [],
    outputs: Array.isArray(step.outputs) ? step.outputs : [],
    idempotency_key: step.idempotency_key ?? null,
    timeline: Array.isArray(step.timeline) ? step.timeline.slice(-30) : [],
    result_summary: step.result_summary ?? null,
    updated_at: step.updated_at ?? null,
  }))
  const done = new Set(plan.filter((step) => step.status === "completed").map((step) => step.id))
  const active = plan.filter((step) => step.status === "in_progress")
  const ready = topologicalStepOrder(plan).filter((step) => ["pending", "retryable"].includes(step.status) && step.dependencies.every((id) => done.has(id)) &&
    (step.status !== "retryable" || (step.failure_category === "transient" && step.attempts <= step.max_retries)) &&
    active.every((running) => !resourceConflict(step.resource_locks, running.resource_locks)))
    .slice(0, Math.max(0, MAX_AGENT_STEP_CONCURRENCY - active.length))
  const blocked = plan.filter((step) => step.dependencies.some((id) => plan.find((dependency) => dependency.id === id)?.status === "failed"))
  return {
    id: task.id,
    workspace_id: task.workspaceId ?? task.workspace_id,
    user_goal: task.userGoal ?? task.user_goal,
    status: task.status,
    phase: task.phase ?? "awaiting_model",
    plan,
    ready_steps: ready.map((step) => step.id),
    blocked_steps: blocked.map((step) => ({ id: step.id, failed_dependencies: step.dependencies.filter((id) => plan.find((dependency) => dependency.id === id)?.status === "failed") })),
    last_observation: task.lastObservation ?? task.last_observation ?? "",
    history: Array.isArray(task.history) ? task.history.slice(-50) : [],
    created_at: task.createdAt ?? task.created_at,
    updated_at: task.updatedAt ?? task.updated_at,
    resumed_at: task.resumedAt ?? task.resumed_at ?? null,
    finished_at: task.finishedAt ?? task.finished_at ?? null,
    revision: Number.isInteger(task.revision) ? task.revision : 1,
    local_jobs: Array.isArray(task.localJobs) ? task.localJobs : Array.isArray(task.local_jobs) ? task.local_jobs : [],
    timeline: Array.isArray(task.timeline) ? task.timeline.slice(-100) : [],
  }
}

function appendHistory(task, event, summary) {
  const history = Array.isArray(task.history) ? task.history : []
  history.push({ at: new Date().toISOString(), event, summary: cleanSummary(summary) })
  task.history = history.slice(-100)
  const timeline = Array.isArray(task.timeline) ? task.timeline : []
  timeline.push({ at: new Date().toISOString(), event, summary: cleanSummary(summary) })
  task.timeline = timeline.slice(-100)
}

function cleanSummary(value, max = MAX_SUMMARY_CHARS) {
  return String(value ?? "").replace(/[\r\n\0]+/g, " ").slice(0, max)
}

function validatePlanPath(input) {
  const relative = normalizeRelative(input)
  if (isSensitivePath(relative) || hasBlockedExplicitDirectory(relative) || relative.split("/").slice(0, -1).some(shouldSkipDirectory)) {
    throw new Error(`Agent DAG 输入版本禁止敏感、内部或生成路径：${relative}`)
  }
  return relative
}

function validateInputVersions(value) {
  if (!Array.isArray(value) || value.length > 100) throw new Error("input_versions 必须是最多 100 项的数组")
  const entries = value.map((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item) || typeof item.path !== "string" || !/^[a-f0-9]{64}$/i.test(item.sha256 ?? "")) {
      throw new Error("每个 input_version 都必须包含相对 path 和 SHA-256")
    }
    return { path: validatePlanPath(item.path), sha256: item.sha256.toLowerCase() }
  })
  if (new Set(entries.map((item) => item.path.toLowerCase())).size !== entries.length) throw new Error("input_versions 不能包含重复路径")
  return entries
}

async function verifyHashEntries(workspace, entries, label) {
  for (const entry of entries ?? []) {
    const actual = await hashFile(workspace.root, entry.path)
    if (actual.sha256.toLowerCase() !== entry.sha256.toLowerCase()) throw new Error(`${label} 文件版本冲突：${entry.path}`)
  }
}

function validateResourceLocks(value) {
  if (!Array.isArray(value) || value.length > 20) throw new Error("resource_locks 必须是最多 20 项的数组")
  const normalized = value.map((item) => {
    if (typeof item !== "string" || item.length > 512) throw new Error("Agent resource lock 格式无效")
    if (item.startsWith("file:")) return `file:${validatePlanPath(item.slice(5))}`
    if (item.startsWith("process:") && /^[A-Za-z0-9_.:-]{1,128}$/.test(item.slice(8))) return item.toLowerCase()
    throw new Error("resource lock 必须是 file:<workspace-relative-path> 或 process:<fixed-label>")
  })
  if (new Set(normalized.map((item) => item.toLowerCase())).size !== normalized.length) throw new Error("resource_locks 不能重复")
  return normalized
}

function resourceConflict(first = [], second = []) {
  for (const left of first) for (const right of second) {
    if (left.toLowerCase() === right.toLowerCase()) return true
    if (left.toLowerCase().startsWith("file:") && right.toLowerCase().startsWith("file:")) {
      const a = left.slice(5).replace(/\\/g, "/").toLowerCase()
      const b = right.slice(5).replace(/\\/g, "/").toLowerCase()
      if (a.startsWith(`${b}/`) || b.startsWith(`${a}/`)) return true
    }
  }
  return false
}

function topologicalStepOrder(plan) {
  const byId = new Map(plan.map((step) => [step.id, step]))
  const remaining = new Set(byId.keys())
  const completed = new Set()
  const order = []
  while (remaining.size) {
    const ready = [...remaining].map((id) => byId.get(id)).filter((step) => (step.dependencies ?? []).every((dependency) => completed.has(dependency)))
      .sort((first, second) => first.index - second.index)
    if (!ready.length) return plan
    const next = ready[0]
    remaining.delete(next.id)
    completed.add(next.id)
    order.push(next)
  }
  return order
}

function validateStepRecords(value, label) {
  if (!Array.isArray(value) || value.length > 50) throw new Error(`${label} 必须是最多 50 项的数组`)
  let total = 0
  return value.map((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) throw new Error(`${label} 记录格式无效`)
    const keys = Object.keys(item)
    if (typeof item.path === "string" && typeof item.sha256 === "string" && /^[a-f0-9]{64}$/i.test(item.sha256) && keys.every((key) => ["path", "sha256", "kind", "summary"].includes(key))) {
      return { path: validatePlanPath(item.path), sha256: item.sha256.toLowerCase(), kind: cleanSummary(item.kind, 80), summary: cleanSummary(item.summary, 500) }
    }
    if (typeof item.name === "string" && item.name.trim() && item.name.length <= 120 && typeof item.value === "string" && item.value.length <= 1000 && keys.every((key) => ["name", "value"].includes(key))) {
      total += item.name.length + item.value.length
      if (total > 20_000) throw new Error(`${label} 总长度超过 20000 个字符`)
      return { name: item.name.trim(), value: item.value }
    }
    throw new Error(`${label} 记录必须是 path/SHA-256 artifact 或 name/value output`)
  })
}

function normalizeAgentPlan(steps) {
  if (!Array.isArray(steps) || steps.length > 100) throw new Error("计划步骤必须是最多 100 项的数组")
  const ids = steps.map((raw, index) => {
    const legacyString = typeof raw === "string"
    const step = typeof raw === "string" ? { title: raw } : raw
    if (!step || typeof step !== "object" || Array.isArray(step) || !Object.keys(step).every((key) => ["id", "title", "dependencies", "max_retries", "input_versions", "resource_locks"].includes(key))) {
      throw new Error("结构化计划步骤字段无效")
    }
    if (typeof step.title !== "string" || !step.title.trim() || step.title.length > 240) throw new Error("每个计划步骤都必须有 1 到 240 个字符的标题")
    const id = step.id === undefined ? `step-${index + 1}` : step.id
    if (typeof id !== "string" || !/^[A-Za-z0-9_-]{1,64}$/.test(id)) throw new Error("DAG step id 格式无效")
    const dependencies = step.dependencies ?? (legacyString && index > 0 ? [`step-${index}`] : [])
    if (!Array.isArray(dependencies) || dependencies.length > 100 || dependencies.some((item) => typeof item !== "string" || !/^[A-Za-z0-9_-]{1,64}$/.test(item))) throw new Error("DAG dependencies 格式无效")
    const maxRetries = step.max_retries ?? 2
    if (!Number.isInteger(maxRetries) || maxRetries < 0 || maxRetries > 10) throw new Error("max_retries 必须是 0 到 10 的整数")
    return { id, title: step.title.trim(), dependencies: [...new Set(dependencies)], max_retries: maxRetries, input_versions: validateInputVersions(step.input_versions ?? []), resource_locks: validateResourceLocks(step.resource_locks ?? []) }
  })
  if (new Set(ids.map((step) => step.id)).size !== ids.length) throw new Error("DAG step id 不能重复")
  const byId = new Map(ids.map((step) => [step.id, step]))
  for (const step of ids) {
    if (step.dependencies.includes(step.id)) throw new Error(`DAG 步骤不能依赖自身：${step.id}`)
    for (const dependency of step.dependencies) if (!byId.has(dependency)) throw new Error(`DAG 依赖不存在：${step.id} -> ${dependency}`)
  }
  const visiting = new Set()
  const visited = new Set()
  function visit(id) {
    if (visiting.has(id)) throw new Error("Agent 计划包含依赖循环")
    if (visited.has(id)) return
    visiting.add(id)
    for (const dependency of byId.get(id).dependencies) visit(dependency)
    visiting.delete(id)
    visited.add(id)
  }
  for (const step of ids) visit(step.id)
  return ids
}

async function taskRecord(id) {
  return (await readArray("agentTasks")).find((task) => task.id === id)
}

async function contextFor(task) {
  const workspace = await requireWorkspace(task.workspaceId ?? task.workspace_id)
  const [git, listing] = await Promise.all([
    collectGitContext(workspace),
    listDirectory(workspace.root, "", { limit: 200 }),
  ])
  const rootEntries = listing.entries
    .filter((entry) => !entry.blocked && !hasBlockedExplicitDirectory(entry.name) && !isSensitivePath(entry.name) &&
      !(entry.isDirectory && shouldSkipDirectory(entry.name)))
    .map((entry) => ({ name: entry.name, type: entry.isDirectory ? "directory" : "file", size_bytes: entry.size ?? null }))
  return {
    task: view(task),
    workspace: { id: workspace.id, name: workspace.name },
    files: { root_entries: rootEntries, truncated: listing.nextOffset !== null, total_entries: listing.total ?? rootEntries.length },
    git,
  }
}

export async function beginAgentTask({ workspace_id, user_goal }) {
  if (typeof user_goal !== "string" || !user_goal.trim() || user_goal.length > MAX_GOAL_CHARS) {
    throw new Error(`user_goal 必须是 1 到 ${MAX_GOAL_CHARS} 个字符`)
  }
  const workspace = await requireWorkspace(workspace_id)
  const now = new Date().toISOString()
  const task = {
    id: randomUUID(), workspaceId: workspace.id, userGoal: user_goal.trim(),
    status: "planned", phase: "awaiting_model", plan: [],
    lastObservation: "等待 ChatGPT 规划和选择下一步工具调用。", history: [], timeline: [], localJobs: [],
    createdAt: now, updatedAt: now, resumedAt: null, finishedAt: null, revision: 1,
  }
  appendHistory(task, "task_started", task.lastObservation)
  await mutateArray("agentTasks", (tasks) => { tasks.push(task) })
  await audit("agent_task_started", { workspaceId: workspace.id, itemId: task.id, result: "planned" })
  return view(task)
}

export async function recordAgentPlan({ task_id, steps }) {
  const plan = normalizeAgentPlan(steps)
  const existing = await taskRecord(task_id)
  if (!existing) throw new Error("找不到 Agent 任务")
  const workspace = await requireWorkspace(existing.workspaceId ?? existing.workspace_id)
  for (const step of plan) await verifyHashEntries(workspace, step.input_versions, "input_version")
  const result = await mutateArray("agentTasks", async (tasks) => {
    const task = tasks.find((item) => item.id === task_id)
    if (!task) throw new Error("找不到 Agent 任务")
    if (TERMINAL.has(task.status)) throw new Error("已完成的 Agent 任务不能继续规划")
    await requireWorkspace(task.workspaceId ?? task.workspace_id)
    task.plan = plan.map((step, index) => ({
      id: step.id, index, title: step.title, dependencies: step.dependencies,
      status: "pending", attempts: 0, max_retries: step.max_retries,
      resource_locks: step.resource_locks,
      failure_category: null, input_versions: step.input_versions, artifacts: [], outputs: [],
      idempotency_key: randomUUID(), timeline: [{ at: new Date().toISOString(), event: "step_created", summary: "等待依赖完成" }],
      result_summary: null, updated_at: new Date().toISOString(),
    }))
    task.status = "awaiting_model"
    task.phase = "awaiting_model"
    task.updatedAt = new Date().toISOString()
    task.revision = (Number(task.revision) || 0) + 1
    task.lastObservation = `已记录 ${task.plan.length} 个步骤，等待 ChatGPT 选择下一项操作。`
    appendHistory(task, "plan_recorded", task.lastObservation)
    return view(task)
  })
  return result
}

export async function updateAgentStep({ task_id, step_index, step_id, step_status, summary, task_status, failure_category, input_versions, artifacts, outputs, expected_idempotency_key }) {
  const allowedStep = new Set(["pending", "in_progress", "completed", "failed", "retryable", "skipped"])
  const allowedTask = new Set(["planned", "running", "awaiting_user", "awaiting_model", "failed", "cancelled", "completed"])
  if ((!Number.isInteger(step_index) || step_index < 0) && (typeof step_id !== "string" || !step_id)) throw new Error("必须提供 step_index 或 step_id")
  if (!allowedStep.has(step_status)) throw new Error("step_status 无效")
  if (task_status !== undefined && !allowedTask.has(task_status)) throw new Error("task_status 无效")
  const allowedFailure = new Set(["transient", "auth", "path", "hash", "compiler", "permanent", "cancelled"])
  if (failure_category !== undefined && !allowedFailure.has(failure_category)) throw new Error("failure_category 无效")
  const normalizedInputs = input_versions === undefined ? undefined : validateInputVersions(input_versions)
  const normalizedArtifacts = artifacts === undefined ? undefined : validateStepRecords(artifacts, "artifact")
  const normalizedOutputs = outputs === undefined ? undefined : validateStepRecords(outputs, "output")
  const result = await mutateArray("agentTasks", async (tasks) => {
    const task = tasks.find((item) => item.id === task_id)
    if (!task) throw new Error("找不到 Agent 任务")
    if (TERMINAL.has(task.status)) throw new Error("已完成的 Agent 任务不能更新")
    const workspace = await requireWorkspace(task.workspaceId ?? task.workspace_id)
    const step = task.plan?.find((item, index) => step_id !== undefined ? (item.id ?? `step-${index + 1}`) === step_id : index === step_index)
    if (!step) throw new Error("找不到计划步骤")
    await verifyHashEntries(workspace, normalizedInputs ?? step.input_versions, "input_version")
    await verifyHashEntries(workspace, (normalizedArtifacts ?? step.artifacts ?? []).filter((item) => item.path), "artifact")
    if (expected_idempotency_key !== undefined && step.idempotency_key !== expected_idempotency_key) throw new Error("step idempotency_key 已变化；请重新读取任务步骤")
    const allSteps = task.plan.map((item, index) => ({ ...item, id: item.id ?? `step-${index + 1}` }))
    const byId = new Map(allSteps.map((item) => [item.id, item]))
    const priorStatus = step.status ?? "pending"
    if (["completed", "skipped", "failed"].includes(priorStatus) && step_status !== priorStatus) throw new Error(`不能从终态步骤 ${priorStatus} 转换到 ${step_status}`)
    if (step_status === "in_progress") {
      const unresolved = (step.dependencies ?? []).filter((id) => byId.get(id)?.status !== "completed")
      if (unresolved.length) throw new Error(`步骤依赖尚未完成：${unresolved.join(", ")}`)
      if (priorStatus === "completed" || priorStatus === "skipped" || priorStatus === "failed") throw new Error(`不能从 ${priorStatus} 转为 in_progress`)
      if (priorStatus === "retryable" && (step.failure_category !== "transient" || step.attempts > step.max_retries)) throw new Error("此步骤没有可用的 transient retry")
      const running = task.plan.filter((item) => item.id !== step.id && item.status === "in_progress")
      if (running.length >= MAX_AGENT_STEP_CONCURRENCY) throw new Error(`Agent DAG 并发上限为 ${MAX_AGENT_STEP_CONCURRENCY}`)
      if (running.some((item) => resourceConflict(step.resource_locks, item.resource_locks))) throw new Error("Agent DAG 步骤与正在运行的文件或进程资源冲突")
      if (priorStatus !== "in_progress") step.attempts = (Number(step.attempts) || 0) + 1
    }
    if (step_status === "completed") {
      const unresolved = (step.dependencies ?? []).filter((id) => byId.get(id)?.status !== "completed")
      if (unresolved.length) throw new Error(`步骤依赖尚未完成：${unresolved.join(", ")}`)
      if (priorStatus !== "in_progress" && priorStatus !== "completed") throw new Error("步骤必须先进入 in_progress 才能标记 completed")
    }
    if (step_status === "retryable" && (failure_category ?? step.failure_category) !== "transient") throw new Error("只有 transient 故障可以标记为 retryable")
    if (step_status === "failed" && failure_category === undefined && step.failure_category === null) step.failure_category = "permanent"
    if (failure_category !== undefined) step.failure_category = failure_category
    step.status = step_status
    if (step_status === "failed" && step.failure_category === "transient" && step.attempts <= step.max_retries) step.status = "retryable"
    if (step_status === "failed" && step.failure_category === "transient" && step.attempts > step.max_retries) step.status = "failed"
    if (normalizedInputs !== undefined) step.input_versions = normalizedInputs
    if (normalizedArtifacts !== undefined) step.artifacts = normalizedArtifacts
    if (normalizedOutputs !== undefined) step.outputs = normalizedOutputs
    step.result_summary = summary === undefined ? step.result_summary ?? null : cleanSummary(summary)
    step.updated_at = new Date().toISOString()
    if (task_status) task.status = task_status
    else if (step.status === "in_progress") task.status = "running"
    else if (["completed", "retryable", "failed", "skipped"].includes(step.status) && !TERMINAL.has(task.status)) task.status = "awaiting_model"
    if (task_status === "completed" && task.plan.some((item) => !["completed", "skipped"].includes(item.status))) throw new Error("Agent 任务仍有未完成的步骤")
    if (TERMINAL.has(task.status)) {
      task.phase = task.status
      task.finishedAt = task.finishedAt ?? new Date().toISOString()
    } else {
      task.phase = task.status === "awaiting_user" ? "awaiting_user" : task.status === "running" ? "running" : "awaiting_model"
    }
    task.lastObservation = summary === undefined ? task.lastObservation : cleanSummary(summary)
    task.updatedAt = new Date().toISOString()
    task.revision = (Number(task.revision) || 0) + 1
    const stepEvent = { at: step.updated_at, event: `step_${step.status}`, status: step.status, attempt: step.attempts, failure_category: step.failure_category, summary: cleanSummary(summary) }
    step.timeline = [...(Array.isArray(step.timeline) ? step.timeline : []), stepEvent].slice(-30)
    appendHistory(task, "step_updated", `步骤 ${step.id ?? step.index + 1}: ${step.status}${summary ? ` — ${summary}` : ""}`)
    return view(task)
  })
  return result
}

export async function getAgentTask({ task_id }) {
  const task = await taskRecord(task_id)
  if (!task) throw new Error("找不到 Agent 任务")
  return view(task)
}

export async function getTaskContext({ task_id }) {
  const task = await taskRecord(task_id)
  if (!task) throw new Error("找不到 Agent 任务")
  return contextFor(task)
}

export async function resumeAgentTask({ task_id }) {
  const task = await taskRecord(task_id)
  if (!task) throw new Error("找不到 Agent 任务")
  if (TERMINAL.has(task.status)) throw new Error("已完成的 Agent 任务不能恢复")

  // Gather all fallible workspace data before committing a resumed status.
  const context = await contextFor(task)
  const updated = await mutateArray("agentTasks", (tasks) => {
    const current = tasks.find((item) => item.id === task_id)
    if (!current) throw new Error("找不到 Agent 任务")
    if (TERMINAL.has(current.status)) throw new Error("已完成的 Agent 任务不能恢复")
    if ((Number(current.revision) || 1) !== (Number(task.revision) || 1)) throw new Error("Agent 任务在收集恢复上下文时已变化；请重新读取后再恢复")
    const now = new Date().toISOString()
    current.status = "awaiting_model"
    current.phase = "awaiting_model"
    current.resumedAt = now
    current.updatedAt = now
    current.revision = (Number(current.revision) || 0) + 1
    current.lastObservation = "已恢复持久化检查点；等待 ChatGPT 基于当前文件和 Git 状态继续。"
    appendHistory(current, "task_resumed", current.lastObservation)
    return view(current)
  })
  context.task = updated
  await audit("agent_task_resumed", { workspaceId: updated.workspace_id, itemId: task_id, result: "awaiting_model" })
  return context
}

export async function finishAgentTask({ task_id, status, summary = "" }) {
  if (!TERMINAL.has(status)) throw new Error("最终状态必须是 completed、failed 或 cancelled")
  const result = await mutateArray("agentTasks", (tasks) => {
    const task = tasks.find((item) => item.id === task_id)
    if (!task) throw new Error("找不到 Agent 任务")
    if (TERMINAL.has(task.status)) {
      if (task.status === status) return view(task)
      throw new Error("Agent 任务已经结束")
    }
    if (status === "completed" && task.plan.some((step) => !["completed", "skipped"].includes(step.status))) throw new Error("Agent 任务仍有未完成的步骤")
    const now = new Date().toISOString()
    task.status = status
    task.phase = status
    task.finishedAt = now
    task.updatedAt = now
    task.lastObservation = cleanSummary(summary)
    task.revision = (Number(task.revision) || 0) + 1
    appendHistory(task, `task_${status}`, task.lastObservation)
    return view(task)
  })
  await audit(`agent_task_${status}`, { workspaceId: result.workspace_id, itemId: task_id, result: status })
  return result
}
