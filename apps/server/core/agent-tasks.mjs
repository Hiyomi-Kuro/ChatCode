import { randomUUID } from "node:crypto"
import { audit } from "./audit.mjs"
import { collectGitContext } from "./git.mjs"
import { listDirectory } from "./safe-fs.mjs"
import { mutateArray, readArray } from "./state.mjs"
import { hasBlockedExplicitDirectory, isSensitivePath, shouldSkipDirectory } from "./paths.mjs"
import { requireWorkspace } from "./workspaces.mjs"

const MAX_GOAL_CHARS = 12_000
const MAX_SUMMARY_CHARS = 2_000
const TERMINAL = new Set(["completed", "failed", "cancelled"])

function view(task) {
  return {
    id: task.id,
    workspace_id: task.workspaceId ?? task.workspace_id,
    user_goal: task.userGoal ?? task.user_goal,
    status: task.status,
    phase: task.phase ?? "awaiting_model",
    plan: Array.isArray(task.plan) ? task.plan : [],
    last_observation: task.lastObservation ?? task.last_observation ?? "",
    history: Array.isArray(task.history) ? task.history.slice(-50) : [],
    created_at: task.createdAt ?? task.created_at,
    updated_at: task.updatedAt ?? task.updated_at,
    resumed_at: task.resumedAt ?? task.resumed_at ?? null,
    finished_at: task.finishedAt ?? task.finished_at ?? null,
    revision: Number.isInteger(task.revision) ? task.revision : 1,
    local_jobs: Array.isArray(task.localJobs) ? task.localJobs : Array.isArray(task.local_jobs) ? task.local_jobs : [],
  }
}

function appendHistory(task, event, summary) {
  const history = Array.isArray(task.history) ? task.history : []
  history.push({ at: new Date().toISOString(), event, summary: cleanSummary(summary) })
  task.history = history.slice(-100)
}

function cleanSummary(value, max = MAX_SUMMARY_CHARS) {
  return String(value ?? "").replace(/[\r\n\0]+/g, " ").slice(0, max)
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
    lastObservation: "等待 ChatGPT 规划和选择下一步工具调用。", history: [], localJobs: [],
    createdAt: now, updatedAt: now, resumedAt: null, finishedAt: null, revision: 1,
  }
  appendHistory(task, "task_started", task.lastObservation)
  await mutateArray("agentTasks", (tasks) => { tasks.push(task) })
  await audit("agent_task_started", { workspaceId: workspace.id, itemId: task.id, result: "planned" })
  return view(task)
}

export async function recordAgentPlan({ task_id, steps }) {
  if (!Array.isArray(steps) || steps.length > 100) throw new Error("计划步骤必须是最多 100 项的数组")
  const titles = steps.map((step) => typeof step === "string" ? step : step?.title)
  if (titles.some((title) => typeof title !== "string" || !title.trim() || title.length > 240)) {
    throw new Error("每个计划步骤都必须有 1 到 240 个字符的标题")
  }
  const result = await mutateArray("agentTasks", (tasks) => {
    const task = tasks.find((item) => item.id === task_id)
    if (!task) throw new Error("找不到 Agent 任务")
    if (TERMINAL.has(task.status)) throw new Error("已完成的 Agent 任务不能继续规划")
    task.plan = titles.map((title, index) => ({ index, title: title.trim(), status: "pending", result_summary: null, updated_at: new Date().toISOString() }))
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

export async function updateAgentStep({ task_id, step_index, step_status, summary, task_status }) {
  const allowedStep = new Set(["pending", "in_progress", "completed", "failed", "skipped"])
  const allowedTask = new Set(["planned", "running", "awaiting_user", "awaiting_model", "failed", "cancelled", "completed"])
  if (!Number.isInteger(step_index) || step_index < 0) throw new Error("step_index 无效")
  if (!allowedStep.has(step_status)) throw new Error("step_status 无效")
  if (task_status !== undefined && !allowedTask.has(task_status)) throw new Error("task_status 无效")
  const result = await mutateArray("agentTasks", (tasks) => {
    const task = tasks.find((item) => item.id === task_id)
    if (!task) throw new Error("找不到 Agent 任务")
    if (TERMINAL.has(task.status)) throw new Error("已完成的 Agent 任务不能更新")
    const step = task.plan?.[step_index]
    if (!step) throw new Error("找不到计划步骤")
    step.status = step_status
    step.result_summary = summary === undefined ? step.result_summary ?? null : cleanSummary(summary)
    step.updated_at = new Date().toISOString()
    if (task_status) task.status = task_status
    task.phase = task.status === "awaiting_user" ? "awaiting_user" : task.status === "running" ? "running" : "awaiting_model"
    task.lastObservation = summary === undefined ? task.lastObservation : cleanSummary(summary)
    task.updatedAt = new Date().toISOString()
    task.revision = (Number(task.revision) || 0) + 1
    appendHistory(task, "step_updated", `步骤 ${step_index + 1}: ${step_status}${summary ? ` — ${summary}` : ""}`)
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
