import { readFile } from "node:fs/promises"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { z } from "zod"
import { projectStructure } from "./files.mjs"
import { getAndroidBuildArtifacts, getAndroidEnvironment, requestAndroidBuild, runApprovedAndroidBuild } from "./android.mjs"
import {
  captureScreenshot, collectCrashDiagnostics, dumpUiHierarchy, getAndroidDevices, getLogcat,
  getMumuStatus, installDebugApk, launchAndroidApp, listMumuInstances, runAndroidInstrumentationOrUiAutomator,
  startMumuIfNeeded, stopTestApp, validateAndroidUi,
} from "./mumu.mjs"

const here = path.dirname(fileURLToPath(import.meta.url))
const repositoryRoot = path.resolve(here, "../../..")
const manifestFiles = new Map([
  ["android", path.join(repositoryRoot, "tools", "android", "manifest.json")],
  ["mumu", path.join(repositoryRoot, "tools", "mumu", "manifest.json")],
  ["project-summary", path.join(repositoryRoot, "tools", "project-summary", "manifest.json")],
])
const schemas = {
  "android.environment": z.object({ workspace_id: z.string().uuid(), project_path: z.string().max(2048) }).strict(),
  "android.request_build": z.object({
    workspace_id: z.string().uuid(), project_path: z.string().max(2048),
    task: z.enum(["assembleDebug", "testDebugUnitTest", "lintDebug"]).optional().default("assembleDebug"),
    agent_task_id: z.string().uuid().optional(), agent_step_index: z.number().int().min(0).optional(),
  }).strict(),
  "android.run_build": z.object({ task_id: z.string().uuid() }).strict(),
  "android.build_artifacts": z.object({ task_id: z.string().uuid() }).strict(),
  "mumu.list_mumu_instances": z.object({}).strict(),
  "mumu.get_mumu_status": z.object({ workspace_id: z.string().uuid() }).strict(),
  "mumu.start_mumu_if_needed": z.object({ workspace_id: z.string().uuid() }).strict(),
  "mumu.get_android_devices": z.object({ workspace_id: z.string().uuid() }).strict(),
  "mumu.install_debug_apk": z.object({ workspace_id: z.string().uuid(), task_id: z.string().uuid() }).strict(),
  "mumu.launch_android_app": z.object({ workspace_id: z.string().uuid(), task_id: z.string().uuid() }).strict(),
  "mumu.stop_test_app": z.object({ workspace_id: z.string().uuid(), task_id: z.string().uuid() }).strict(),
  "mumu.get_logcat": z.object({ workspace_id: z.string().uuid(), task_id: z.string().uuid(), offset: z.number().int().min(0).max(50_000).optional().default(0), limit: z.number().int().min(1).max(20_000).optional().default(16_000) }).strict(),
  "mumu.capture_screenshot": z.object({ workspace_id: z.string().uuid(), task_id: z.string().uuid() }).strict(),
  "mumu.dump_ui_hierarchy": z.object({ workspace_id: z.string().uuid(), task_id: z.string().uuid() }).strict(),
  "mumu.run_android_instrumentation_or_uiautomator": z.object({
    workspace_id: z.string().uuid(), task_id: z.string().uuid(),
    actions: z.array(z.discriminatedUnion("type", [
      z.object({ type: z.literal("tap"), x: z.number().int().min(0).max(10_000), y: z.number().int().min(0).max(10_000) }).strict(),
      z.object({ type: z.literal("text"), text: z.string().max(64) }).strict(),
      z.object({ type: z.literal("key"), key: z.enum(["ENTER", "BACK", "DEL", "HOME"]) }).strict(),
    ])).min(1).max(100),
  }).strict(),
  "mumu.collect_crash_diagnostics": z.object({ workspace_id: z.string().uuid(), task_id: z.string().uuid() }).strict(),
  "mumu.validate_android_ui": z.object({ workspace_id: z.string().uuid(), task_id: z.string().uuid(), rounds: z.number().int().min(3).max(5).optional().default(3) }).strict(),
  "project.summary": z.object({
    workspace_id: z.string().uuid(), max_depth: z.number().int().min(1).max(8).optional().default(4),
    max_files: z.number().int().min(1).max(500).optional().default(300),
  }).strict(),
}
const actions = {
  "android.environment": getAndroidEnvironment,
  "android.request_build": requestAndroidBuild,
  "android.run_build": runApprovedAndroidBuild,
  "android.build_artifacts": getAndroidBuildArtifacts,
  "mumu.list_mumu_instances": listMumuInstances,
  "mumu.get_mumu_status": getMumuStatus,
  "mumu.start_mumu_if_needed": startMumuIfNeeded,
  "mumu.get_android_devices": getAndroidDevices,
  "mumu.install_debug_apk": installDebugApk,
  "mumu.launch_android_app": launchAndroidApp,
  "mumu.stop_test_app": stopTestApp,
  "mumu.get_logcat": getLogcat,
  "mumu.capture_screenshot": captureScreenshot,
  "mumu.dump_ui_hierarchy": dumpUiHierarchy,
  "mumu.run_android_instrumentation_or_uiautomator": runAndroidInstrumentationOrUiAutomator,
  "mumu.collect_crash_diagnostics": collectCrashDiagnostics,
  "mumu.validate_android_ui": validateAndroidUi,
  "project.summary": projectStructure,
}

const ANNOTATIONS = Object.freeze({
  read: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  device_read: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  execution: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  device_action: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
  workspace_write: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
})
let snapshot = null

function validateManifest(raw, expectedId) {
  if (!raw || raw.id !== expectedId || typeof raw.namespace !== "string" || typeof raw.version !== "string" || !Array.isArray(raw.tools)) {
    throw new Error(`自定义工具 manifest ${expectedId} 必需字段无效`)
  }
  if (!/^[a-z][a-z0-9-]{0,63}$/.test(raw.id) || !/^[a-z][a-z0-9_]{0,31}$/.test(raw.namespace) || !/^\d+\.\d+\.\d+$/.test(raw.version)) {
    throw new Error(`自定义工具 manifest ${expectedId} 标识或版本无效`)
  }
  const toolNames = new Set()
  for (const tool of raw.tools) {
    if (!/^[a-z][a-z0-9_]{0,63}$/.test(tool.name) || typeof tool.mcpName !== "string" || toolNames.has(tool.name) ||
        !tool.inputSchema || tool.inputSchema.type !== "object" || typeof tool.permission !== "string" || !tool.hints) {
      throw new Error(`自定义工具 manifest ${expectedId} 的工具定义无效`)
    }
    toolNames.add(tool.name)
  }
  return raw
}

export async function reloadCustomToolManifests() {
  const packages = []
  const errors = []
  for (const [id, manifestPath] of manifestFiles) {
    try {
      const raw = JSON.parse(await readFile(manifestPath, "utf8"))
      const manifest = validateManifest(raw, id)
      const namespaceOwner = packages.find((item) => item.manifest.namespace === manifest.namespace)
      if (namespaceOwner) throw new Error(`namespace ${manifest.namespace} 已由工具包 ${namespaceOwner.id} 使用`)
      packages.push({ id, manifest, manifestPath })
    } catch (error) {
      errors.push({ id, error: String(error?.message ?? "manifest 读取失败").slice(0, 300) })
    }
  }
  snapshot = { packages, errors, loadedAt: new Date().toISOString() }
  return snapshot
}

async function currentSnapshot() {
  if (!snapshot) await reloadCustomToolManifests()
  return snapshot
}

export async function listCustomTools() {
  const current = await currentSnapshot()
  return {
    packages: current.packages.map(({ manifest }) => ({
      id: manifest.id, namespace: manifest.namespace, version: manifest.version,
      title: manifest.title, description: manifest.description,
      enabled: manifest.enabledByDefault === true, permission_level: manifest.permissionLevel,
      path_scope: manifest.pathScope, device_scope: manifest.deviceScope,
      tools: manifest.tools.map((tool) => ({
        name: tool.name, mcp_name: tool.mcpName, permission: tool.permission,
        input_schema: tool.inputSchema, hints: tool.hints,
      })),
    })),
    errors: current.errors,
    loaded_at: current.loadedAt,
    reload_policy: "source-controlled static handler allowlist; manifest refresh requires MCP reconnect for schema changes",
  }
}

export async function getCustomToolManifest({ package_id }) {
  const current = await currentSnapshot()
  const item = current.packages.find(({ id }) => id === package_id)
  if (!item) throw new Error("找不到已注册的自定义工具包")
  return { manifest: item.manifest, manifest_path: path.relative(repositoryRoot, item.manifestPath).replace(/\\/g, "/"), loaded_at: current.loadedAt }
}

export async function getCustomToolStatus() {
  const current = await currentSnapshot()
  return {
    packages: current.packages.map(({ manifest }) => ({
      id: manifest.id, version: manifest.version, enabled: manifest.enabledByDefault === true,
      action_count: manifest.tools.length, status: "ready",
      handler_count: manifest.tools.filter((tool) => actions[`${manifest.namespace}.${tool.name}`]).length,
    })),
    errors: current.errors,
    loaded_at: current.loadedAt,
  }
}

export async function reloadCustomTools() {
  const result = await reloadCustomToolManifests()
  return {
    packages: result.packages.map(({ id, manifest }) => ({ id, version: manifest.version, action_count: manifest.tools.length })),
    errors: result.errors,
    loaded_at: result.loadedAt,
    restart_required: true,
    message: "Manifest 已重新读取；tools/list 与 JSON schema 变化需要重启或重连 MCP。代码动作不会从动态目录加载。",
  }
}

export async function customToolDefinition(packageId, toolName) {
  const current = await currentSnapshot()
  const item = current.packages.find(({ id }) => id === packageId)
  const tool = item?.manifest.tools.find((entry) => entry.name === toolName)
  if (!item || !tool) throw new Error("工具包动作未注册")
  const handlerKey = `${item.manifest.namespace}.${tool.name}`
  const handler = actions[handlerKey]
  const schema = schemas[handlerKey]
  if (!handler || !schema) throw new Error(`工具动作 ${handlerKey} 缺少源码白名单实现或 Zod schema`)
  return { manifest: item.manifest, tool, handler, schema, annotations: ANNOTATIONS[tool.permission] ?? ANNOTATIONS.execution }
}

export async function dispatchCustomTool(packageId, toolName, args, context = {}) {
  const definition = await customToolDefinition(packageId, toolName)
  const parsed = definition.schema.parse(args)
  return definition.handler(parsed, context)
}

export function toolContext({ requireWorkspace, audit, cancelTask, tmpDirectory }) {
  return Object.freeze({
    requireWorkspace, audit, cancelTask, tmpDirectory,
    host: "ChatCode",
    capabilities: Object.freeze(["workspace_validation", "task_cancellation", "audit", "secret_redaction"]),
  })
}
