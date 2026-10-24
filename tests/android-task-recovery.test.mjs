import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { setTimeout as delay } from "node:timers/promises"
import { test } from "node:test"

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")

test("Android task recovery preserves a live detached worker and marks a dead worker interrupted", async (t) => {
  const testsRoot = path.join(projectRoot, ".tmp", "tests")
  const sandbox = await mkdtemp(path.join(testsRoot, "android-recovery-"))
  const dataDir = path.join(sandbox, "data")
  const tempDir = path.join(sandbox, "tmp")
  await Promise.all([mkdir(dataDir, { recursive: true }), mkdir(tempDir, { recursive: true })])
  const worker = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
    cwd: sandbox, windowsHide: true, stdio: "ignore", detached: true,
  })
  await new Promise((resolve, reject) => {
    worker.once("spawn", resolve)
    worker.once("error", reject)
  })
  t.after(async () => {
    try { worker.kill() } catch { /* it may already have exited */ }
    const absolute = path.resolve(sandbox)
    const relative = path.relative(testsRoot, absolute)
    if (relative && !relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative)) await rm(absolute, { recursive: true, force: true })
  })

  const taskId = "7b0ae012-f264-42f1-91ac-8215643a5a1b"
  const taskFile = path.join(dataDir, "tasks.json")
  await writeFile(taskFile, `${JSON.stringify([{
    id: taskId, kind: "android_build", workspaceId: "4401d067-6bbf-4f15-b7e0-1edeffa9d6ba",
    status: "running", runnerPid: worker.pid, requestedAt: new Date().toISOString(),
  }], null, 2)}\n`, "utf8")
  const env = {
    ...process.env, CHATCODE_HOME: projectRoot, CHATCODE_DATA_DIR: dataDir, CHATCODE_TMP_DIR: tempDir,
  }
  const recover = () => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--input-type=module", "-e", `import { markInterruptedTasks } from ${JSON.stringify(new URL("../apps/server/core/tasks.mjs", import.meta.url).href)}; await markInterruptedTasks()`], {
      cwd: projectRoot, env, windowsHide: true, stdio: "ignore",
    })
    child.once("error", reject)
    child.once("close", (code) => code === 0 ? resolve() : reject(new Error(`task recovery process exited ${code}`)))
  })

  await recover()
  let tasks = JSON.parse(await readFile(taskFile, "utf8"))
  assert.equal(tasks[0].status, "running", "a worker owned by a disconnected MCP process can continue")
  worker.kill()
  await new Promise((resolve) => worker.once("close", resolve))
  await delay(50)
  await recover()
  tasks = JSON.parse(await readFile(taskFile, "utf8"))
  assert.equal(tasks[0].status, "interrupted", "a task with a dead worker is recoverable as interrupted")
})
