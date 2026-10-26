import assert from "node:assert/strict"
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises"
import path from "node:path"
import { createHash, randomUUID } from "node:crypto"
import { test } from "node:test"
import { fileURLToPath } from "node:url"

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const testsRoot = path.join(projectRoot, ".tmp", "tests")
await mkdir(testsRoot, { recursive: true })
const sandbox = await mkdtemp(path.join(testsRoot, "agent-dag-"))
const dataDir = path.join(sandbox, "data")
const tempDir = path.join(sandbox, "tmp")
const workspaceRoot = path.join(sandbox, "workspace")
await Promise.all([mkdir(dataDir, { recursive: true }), mkdir(tempDir, { recursive: true }), mkdir(workspaceRoot, { recursive: true })])
await mkdir(path.join(workspaceRoot, "src"), { recursive: true })
const inputBytes = Buffer.from("agent dag input\n", "utf8")
await writeFile(path.join(workspaceRoot, "src", "input.txt"), inputBytes)
const inputSha256 = createHash("sha256").update(inputBytes).digest("hex")
process.env.CHATCODE_HOME = projectRoot
process.env.CHATCODE_DATA_DIR = dataDir
process.env.CHATCODE_TMP_DIR = tempDir

const { ensureLayout, writeArray } = await import("../apps/server/core/state.mjs")
const tasks = await import("../apps/server/core/agent-tasks.mjs")
const workspaceId = randomUUID()
const workspace = { id: workspaceId, name: "Agent DAG fixture", root: workspaceRoot, mode: "readOnly", status: "active" }
await ensureLayout()
await writeArray("workspaces", [workspace])

test("Agent DAG validates cycles, gates dependencies, classifies retries, and persists artifacts and timeline", async (t) => {
  t.after(async () => { await rm(sandbox, { recursive: true, force: true }) })
  const task = await tasks.beginAgentTask({ workspace_id: workspaceId, user_goal: "Validate a host-driven dependency graph." })
  await assert.rejects(tasks.recordAgentPlan({ task_id: task.id, steps: [
    { id: "a", title: "A", dependencies: ["b"] }, { id: "b", title: "B", dependencies: ["a"] },
  ] }), /循环/)
  await assert.rejects(tasks.recordAgentPlan({ task_id: task.id, steps: [
    { id: "a", title: "A", dependencies: ["missing"] },
  ] }), /依赖不存在/)
  await assert.rejects(tasks.recordAgentPlan({ task_id: task.id, steps: [
    { id: "hash", title: "Hash mismatch", input_versions: [{ path: "src/input.txt", sha256: "a".repeat(64) }] },
  ] }), /input_version 文件版本冲突/)
  const planned = await tasks.recordAgentPlan({ task_id: task.id, steps: [
    { id: "inspect", title: "Inspect input", max_retries: 1, input_versions: [{ path: "src/input.txt", sha256: inputSha256 }], resource_locks: ["file:src/output"] },
    { id: "build", title: "Build result", dependencies: ["inspect"], max_retries: 0 },
    { id: "parallel", title: "Parallel output", resource_locks: ["file:src/output/child.txt"] },
  ] })
  assert.deepEqual(planned.ready_steps, ["inspect", "parallel"])
  const inspect = planned.plan.find((step) => step.id === "inspect")
  const build = planned.plan.find((step) => step.id === "build")
  const parallel = planned.plan.find((step) => step.id === "parallel")
  await assert.rejects(tasks.updateAgentStep({ task_id: task.id, step_id: "build", step_status: "in_progress" }), /依赖尚未完成/)
  await assert.rejects(tasks.updateAgentStep({ task_id: task.id, step_id: "inspect", step_status: "in_progress", input_versions: [{ path: ".env", sha256: "b".repeat(64) }] }), /禁止敏感/)

  let updated = await tasks.updateAgentStep({ task_id: task.id, step_id: "inspect", step_status: "in_progress", expected_idempotency_key: inspect.idempotency_key })
  assert.equal(updated.plan[0].attempts, 1)
  assert.deepEqual(updated.ready_steps, [], "conflicting resources stay out of the ready queue")
  await assert.rejects(tasks.updateAgentStep({ task_id: task.id, step_id: "parallel", step_status: "in_progress" }), /资源冲突/)
  updated = await tasks.updateAgentStep({ task_id: task.id, step_id: "inspect", step_status: "failed", failure_category: "transient", summary: "Temporary local service timeout." })
  assert.equal(updated.plan[0].status, "retryable")
  assert.deepEqual(updated.ready_steps, ["inspect", "parallel"])
  updated = await tasks.updateAgentStep({ task_id: task.id, step_id: "inspect", step_status: "in_progress", expected_idempotency_key: inspect.idempotency_key })
  assert.equal(updated.plan[0].attempts, 2)
  const artifactBytes = Buffer.from("verified output\n", "utf8")
  await writeFile(path.join(workspaceRoot, "src", "result.txt"), artifactBytes)
  const artifactSha256 = createHash("sha256").update(artifactBytes).digest("hex")
  await assert.rejects(tasks.updateAgentStep({ task_id: task.id, step_id: "inspect", step_status: "completed", artifacts: [{ path: "src/result.txt", sha256: "c".repeat(64) }] }), /artifact 文件版本冲突/)
  updated = await tasks.updateAgentStep({ task_id: task.id, step_id: "inspect", step_status: "completed", summary: "Input was checked.", artifacts: [{ path: "src/result.txt", sha256: artifactSha256, kind: "report" }], outputs: [{ name: "checked", value: "true" }] })
  assert.deepEqual(updated.ready_steps, ["build", "parallel"])
  assert.equal(updated.plan[0].artifacts[0].path, "src/result.txt")
  assert.equal(updated.plan[0].outputs[0].value, "true")
  assert.equal(updated.plan[0].failure_category, "transient", "the classification remains part of the attempt history")

  updated = await tasks.updateAgentStep({ task_id: task.id, step_id: "build", step_status: "in_progress", expected_idempotency_key: build.idempotency_key })
  assert.deepEqual(updated.ready_steps, ["parallel"])
  updated = await tasks.updateAgentStep({ task_id: task.id, step_id: "parallel", step_status: "in_progress", expected_idempotency_key: parallel.idempotency_key })
  updated = await tasks.updateAgentStep({ task_id: task.id, step_id: "parallel", step_status: "completed", summary: "Parallel output verified." })
  await assert.rejects(tasks.finishAgentTask({ task_id: task.id, status: "completed", summary: "premature" }), /未完成的步骤/)
  updated = await tasks.updateAgentStep({ task_id: task.id, step_id: "build", step_status: "completed", summary: "Build succeeded.", task_status: "completed" })
  assert.equal(updated.status, "completed")
  assert.deepEqual(updated.ready_steps, [])
  assert.ok(updated.timeline.some((item) => item.event === "step_updated"))
  assert.ok(updated.plan[0].timeline.some((item) => item.event === "step_retryable"))
  const persisted = await tasks.getAgentTask({ task_id: task.id })
  assert.equal(persisted.plan[0].attempts, 2)
  assert.equal(persisted.plan[0].input_versions[0].sha256, inputSha256)
  assert.equal(persisted.plan[0].idempotency_key, inspect.idempotency_key)
  const capacityTask = await tasks.beginAgentTask({ workspace_id: workspaceId, user_goal: "Verify DAG concurrency limit." })
  const capacityPlan = await tasks.recordAgentPlan({ task_id: capacityTask.id, steps: [
    { id: "one", title: "one" }, { id: "two", title: "two" }, { id: "three", title: "three" }, { id: "four", title: "four" },
  ] })
  for (const step of capacityPlan.plan.slice(0, 3)) await tasks.updateAgentStep({ task_id: capacityTask.id, step_id: step.id, step_status: "in_progress" })
  const fullCapacity = await tasks.getAgentTask({ task_id: capacityTask.id })
  assert.deepEqual(fullCapacity.ready_steps, [])
  await assert.rejects(tasks.updateAgentStep({ task_id: capacityTask.id, step_id: "four", step_status: "in_progress" }), /并发上限/)
  await tasks.finishAgentTask({ task_id: capacityTask.id, status: "cancelled", summary: "Concurrency cap fixture complete." })
  const evidenceDir = path.join(projectRoot, ".tmp", "phase9")
  await mkdir(evidenceDir, { recursive: true })
  await writeFile(path.join(evidenceDir, "a5-agent-dag-evidence.json"), `${JSON.stringify({
    at: new Date().toISOString(), test: "agent-dag.integration.test.mjs", result: "PASS",
    cycle_rejected: true, dangling_dependency_rejected: true, dependency_gating: true,
    conflict_lock_enforced: true, bounded_concurrency: 3, transient_retry_attempts: persisted.plan[0].attempts,
    concurrency_cap_tested: true,
    artifact_count: persisted.plan[0].artifacts.length, output_count: persisted.plan[0].outputs.length,
    idempotency_key: persisted.plan[0].idempotency_key, finished_status: persisted.status,
  }, null, 2)}\n`, "utf8")
})

