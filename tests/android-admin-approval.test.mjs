import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import { mkdir, rm, writeFile } from "node:fs/promises"
import path from "node:path"
import test from "node:test"

test("pending Android approval remains visible when its Calculator .tmp log does not exist yet", { skip: process.platform !== "win32" }, async () => {
  const repo = path.resolve()
  const tempRoot = path.resolve(repo, ".tmp")
  const fixture = path.join(tempRoot, `android-admin-approval-${randomUUID()}`)
  const fixtureRelative = path.relative(tempRoot, fixture)
  const previousEnvironment = Object.fromEntries(["CHATCODE_HOME", "CHATCODE_DATA_DIR", "CHATCODE_TMP_DIR"].map((key) => [key, process.env[key]]))
  assert.ok(fixtureRelative && !fixtureRelative.startsWith(`..${path.sep}`) && !path.isAbsolute(fixtureRelative))

  try {
    const dataDir = path.join(fixture, "data")
    const serverTmp = path.join(fixture, "server-tmp")
    const workspaceRoot = path.join(fixture, "workspace")
    const projectRoot = path.join(workspaceRoot, "Calculator")
    await mkdir(projectRoot, { recursive: true })

    process.env.CHATCODE_HOME = fixture
    process.env.CHATCODE_DATA_DIR = dataDir
    process.env.CHATCODE_TMP_DIR = serverTmp
    const [{ writeArray }, { listTasks }] = await Promise.all([
      import("../apps/server/core/state.mjs"),
      import("../apps/server/core/tasks.mjs"),
    ])

    const workspaceId = randomUUID()
    const taskId = randomUUID()
    const task = {
      id: taskId,
      kind: "android_build",
      workspaceId,
      projectPath: "Calculator",
      buildTask: "assembleDebug",
      logRelativePath: `Calculator/.tmp/logs/android-assembleDebug-${taskId}.log`,
      command: ":app:assembleDebug",
      status: "awaiting_approval",
      requestedAt: new Date().toISOString(),
    }
    await writeArray("workspaces", [{ id: workspaceId, name: "fixture", root: workspaceRoot, mode: "autoWritable", status: "active" }])
    await writeArray("tasks", [task])

    let listed = await listTasks()
    assert.equal(listed.length, 1)
    assert.equal(listed[0].id, taskId)
    assert.equal(listed[0].status, "awaiting_approval")
    assert.equal(listed[0].output, "")

    const logPath = path.join(projectRoot, ".tmp", "logs", `android-assembleDebug-${taskId}.log`)
    await mkdir(path.dirname(logPath), { recursive: true })
    await writeFile(logPath, "Gradle output\n", "utf8")
    listed = await listTasks()
    assert.equal(listed[0].output, "Gradle output\n")

    await writeArray("tasks", [{ ...task, logRelativePath: `Calculator/.tmp/logs/android-assembleDebug-${taskId}.other` }])
    await assert.rejects(listTasks(), /日志路径与任务不匹配/)
  } finally {
    const resolved = path.resolve(fixture)
    assert.ok(resolved.toLowerCase().startsWith(`${tempRoot}${path.sep}`.toLowerCase()))
    await rm(resolved, { recursive: true, force: true })
    for (const [key, value] of Object.entries(previousEnvironment ?? {})) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  }
})
