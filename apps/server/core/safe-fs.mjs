import { spawn } from "node:child_process"
import path from "node:path"
import { SAFE_FS_SCRIPT } from "./config.mjs"
import { normalizeRelative, rejectNetworkOrDeviceRoot } from "./paths.mjs"

const MAX_HELPER_OUTPUT = 5 * 1024 * 1024
const powershell = path.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe")
const helperMetrics = { calls: 0, failures: 0, totalMs: 0, maxMs: 0, lastMs: null }

export function getSafeFsMetrics() {
  return {
    calls: helperMetrics.calls, failures: helperMetrics.failures,
    total_ms: Math.round(helperMetrics.totalMs), max_ms: Math.round(helperMetrics.maxMs),
    average_ms: helperMetrics.calls ? Math.round(helperMetrics.totalMs / helperMetrics.calls) : 0,
    last_ms: helperMetrics.lastMs === null ? null : Math.round(helperMetrics.lastMs),
  }
}

function runHelper(operation, rootPath, relativePath = "", extra = {}) {
  if (process.platform !== "win32") return Promise.reject(new Error("Windows 文件安全辅助程序只支持 Windows"))
  const args = ["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", SAFE_FS_SCRIPT,
    "-Operation", operation, "-RootPath", rootPath, "-RelativePath", relativePath]
  if (extra.expectedHash) args.push("-ExpectedHash", extra.expectedHash)
  if (extra.expectedIdentity) args.push("-ExpectedIdentity", extra.expectedIdentity)
  if (extra.maxBytes !== undefined) args.push("-MaxBytes", String(extra.maxBytes))
  if (extra.offset !== undefined) args.push("-Offset", String(extra.offset))
  if (extra.limit !== undefined) args.push("-Limit", String(extra.limit))
  if (extra.chunkLength !== undefined) args.push("-ChunkLength", String(extra.chunkLength))
  if (extra.stagingRoot) args.push("-StagingRoot", extra.stagingRoot)
  if (extra.stagingPath) args.push("-StagingPath", extra.stagingPath)
  if (extra.cursor !== undefined) args.push("-Cursor", extra.cursor)
  const startedAt = performance.now()
  const operationPromise = new Promise((resolve, reject) => {
    const child = spawn(powershell, args, { windowsHide: true, stdio: ["pipe", "pipe", "pipe"] })
    const stdout = []
    const stderr = []
    let length = 0
    const timeoutMs = extra.timeoutMs ?? (["hash", "write", "write-staged", "copy-to-staging"].includes(operation) ? 30 * 60_000 : 30_000)
    const timer = setTimeout(() => {
      child.kill()
      reject(new Error("Windows 文件安全辅助程序调用超时；可安全重试当前分块"))
    }, timeoutMs)
    child.stdout.on("data", (chunk) => {
      length += chunk.length
      if (length > MAX_HELPER_OUTPUT) {
        child.kill()
        reject(new Error("Windows 文件辅助程序输出超过限制"))
      } else stdout.push(chunk)
    })
    child.stderr.on("data", (chunk) => { if (Buffer.concat(stderr).length < 4096) stderr.push(chunk) })
    child.once("error", () => { clearTimeout(timer); reject(new Error("无法启动 Windows 文件安全辅助程序")) })
    child.once("close", (code) => {
      clearTimeout(timer)
      const output = Buffer.concat(stdout).toString("utf8").trim()
      if (code !== 0) {
        const detail = Buffer.concat(stderr).toString("utf8").replace(/^CC:[a-z_]+:/, "").trim().slice(0, 300)
        reject(new Error(detail || "Windows 文件安全检查失败"))
      } else resolve(output)
    })
    child.stdin.end(extra.payload ? JSON.stringify(extra.payload) : "", "utf8")
  })
  return operationPromise.catch((error) => {
    helperMetrics.failures++
    throw error
  }).finally(() => {
    const elapsed = performance.now() - startedAt
    helperMetrics.calls++
    helperMetrics.totalMs += elapsed
    helperMetrics.maxMs = Math.max(helperMetrics.maxMs, elapsed)
    helperMetrics.lastMs = elapsed
  })
}

export async function canonicalRoot(candidate) {
  rejectNetworkOrDeviceRoot(candidate)
  const output = await runHelper("canonical-root", path.win32.resolve(candidate))
  if (!output) throw new Error("无法确认所选目录")
  return output
}

export async function fileInfo(root, relativePath = "") {
  const relative = normalizeRelative(relativePath, { allowRoot: true })
  return JSON.parse(await runHelper("info", root, relative))
}

export async function hashFile(root, relativePath) {
  const relative = normalizeRelative(relativePath)
  return JSON.parse(await runHelper("hash", root, relative))
}

export async function fileExists(root, relativePath) {
  const relative = normalizeRelative(relativePath)
  return JSON.parse(await runHelper("exists", root, relative))
}

export async function listDirectory(root, relativePath = "", { offset = 0, limit = 200, cursor } = {}) {
  const relative = normalizeRelative(relativePath, { allowRoot: true })
  const safeOffset = Math.max(0, Math.min(2_147_483_647, Math.trunc(offset)))
  const safeLimit = Math.max(1, Math.min(500, Math.trunc(limit)))
  if (cursor !== undefined) return JSON.parse(await runHelper("list-cursor", root, relative, { limit: safeLimit, cursor }))
  return JSON.parse(await runHelper("list", root, relative, { offset: safeOffset, limit: safeLimit }))
}

export async function readFileBytes(root, relativePath, maxBytes = 1_048_576) {
  const relative = normalizeRelative(relativePath)
  const output = await runHelper("read", root, relative, { maxBytes })
  return Buffer.from(output, "base64")
}

export async function readFileChunk(root, relativePath, offset, length) {
  const relative = normalizeRelative(relativePath)
  const exactOffset = BigInt(offset)
  if (exactOffset < 0n || exactOffset > 9_223_372_036_854_775_807n) throw new Error("字节 offset 超出 64 位范围")
  if (!Number.isInteger(length) || length < 1 || length > 262_144) throw new Error("单次读取长度必须为 1 到 262144 字节")
  return JSON.parse(await runHelper("read-chunk", root, relative, { offset: exactOffset.toString(), chunkLength: length }))
}

export async function writeExistingFile(root, relativePath, expectedHash, content) {
  const relative = normalizeRelative(relativePath)
  if (!/^[a-f0-9]{64}$/i.test(expectedHash ?? "")) throw new Error("缺少有效的文件版本哈希")
  const output = await runHelper("write", root, relative, { expectedHash, payload: { content: Buffer.from(content).toString("base64") } })
  return JSON.parse(output)
}

export async function createNewFile(root, relativePath, content) {
  const relative = normalizeRelative(relativePath)
  const output = await runHelper("create", root, relative, { payload: { content: Buffer.from(content).toString("base64") } })
  return JSON.parse(output)
}

export async function writeStagedFile(root, relativePath, expectedHash, stagingRoot, stagingPath) {
  const relative = normalizeRelative(relativePath)
  if (expectedHash !== null && !/^[a-f0-9]{64}$/i.test(expectedHash ?? "")) throw new Error("缺少有效的文件版本哈希")
  return JSON.parse(await runHelper("write-staged", root, relative, {
    expectedHash: expectedHash ?? "", stagingRoot, stagingPath,
  }))
}

export async function truncateStagingFile(stagingRoot, stagingPath, length) {
  const exactLength = BigInt(length)
  if (exactLength < 0n || exactLength > 9_223_372_036_854_775_807n) throw new Error("暂存文件长度超出 Int64 范围")
  return JSON.parse(await runHelper("truncate-staging", stagingRoot, "", {
    offset: exactLength.toString(), stagingRoot, stagingPath,
  }))
}

export async function copyFileToStaging(root, relativePath, expectedHash, stagingRoot, stagingPath) {
  const relative = normalizeRelative(relativePath)
  if (!/^[a-f0-9]{64}$/i.test(expectedHash ?? "")) throw new Error("缺少有效的文件版本哈希")
  return JSON.parse(await runHelper("copy-to-staging", root, relative, {
    expectedHash, stagingRoot, stagingPath,
  }))
}

export async function createDirectory(root, relativePath) {
  const relative = normalizeRelative(relativePath)
  return JSON.parse(await runHelper("mkdir", root, relative))
}

export async function deleteFileIfUnchanged(root, relativePath, expectedHash) {
  const relative = normalizeRelative(relativePath)
  if (!/^[a-f0-9]{64}$/i.test(expectedHash ?? "")) throw new Error("缺少有效的文件版本哈希")
  return JSON.parse(await runHelper("delete", root, relative, { expectedHash }))
}

export async function removeEmptyDirectory(root, relativePath, expectedIdentity) {
  const relative = normalizeRelative(relativePath)
  if (!/^[a-f0-9]{8}:[a-f0-9]{16}$/i.test(expectedIdentity ?? "")) throw new Error("缺少有效的目录身份校验值")
  return JSON.parse(await runHelper("rmdir", root, relative, { expectedIdentity }))
}
