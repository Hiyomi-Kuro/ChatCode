import assert from "node:assert/strict"
import { test } from "node:test"
import { customToolDefinition, getCustomToolStatus, listCustomTools, reloadCustomTools } from "../apps/server/core/custom-tools.mjs"

test("custom tool manifests match the static action and Zod registry", async () => {
  const catalog = await listCustomTools()
  const status = await getCustomToolStatus()
  assert.deepEqual(catalog.errors, [])
  assert.deepEqual(status.errors, [])
  assert.deepEqual(catalog.packages.map((item) => item.id).sort(), ["android", "mumu", "project-summary"])
  assert.equal(new Set(catalog.packages.map((item) => item.namespace)).size, catalog.packages.length)
  assert.ok(status.packages.every((item) => item.status === "ready" && item.action_count === item.handler_count))
  const mumu = catalog.packages.find((item) => item.id === "mumu")
  assert.equal(mumu.tools.length, 13)
  assert.ok(mumu.tools.some((item) => item.mcp_name === "install_debug_apk" && item.permission === "device_action"))

  const automation = await customToolDefinition("mumu", "run_android_instrumentation_or_uiautomator")
  assert.equal(automation.schema.safeParse({ workspace_id: "00000000-0000-4000-8000-000000000000", task_id: "00000000-0000-4000-8000-000000000001", actions: [{ type: "tap", x: 10, y: 20 }] }).success, true)
  assert.equal(automation.schema.safeParse({ workspace_id: "00000000-0000-4000-8000-000000000000", task_id: "00000000-0000-4000-8000-000000000001", actions: [{ type: "shell", command: "format c:" }] }).success, false)
  await assert.rejects(customToolDefinition("workspace", "load_javascript"), /not found|未注册/i)

  const refreshed = await reloadCustomTools()
  assert.equal(refreshed.restart_required, true)
  assert.equal(refreshed.errors.length, 0)
})
