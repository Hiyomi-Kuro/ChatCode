import { spawn } from "node:child_process"
import path from "node:path"
import { SAFE_FS_SCRIPT } from "./config.mjs"
import { normalizeRelative, rejectNetworkOrDeviceRoot } from "./paths.mjs"

const MAX_HELPER_OUTPUT = 5 * 1024 * 1024
const powershell = path.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe")

function runHelper(operation, rootPath, relativePath = "", extra = {}) {
  if (process.platform !== "win32") return Promise.reject(new Error("Windows 文件安全辅助程序只支持 Windows"))
  const args = ["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", SAFE_FS_SCRIPT,
    "-Operation", operation, "-RootPath", rootPath, "-RelativePath", relativePath]
  if (extra.expectedHash) args.push("-ExpectedHash", extra.expectedHash)
  if (extra.maxBytes !== undefined) args.push("-MaxBytes", String(extra.maxBytes))
  if (extra.offset !== undefined) args.push("-Offset", String(extra.offset))
  if (extra.limit !== undefined) args.push("-Limit", String(extra.limit))
  return new Promise((resolve, reject) => {
    const child = spawn(powershell, args, { windowsHide: true, stdio: ["pipe", "pipe", "pipe"] })
    const stdout = []
    const stderr = []
    let length = 0
    child.stdout.on("data", (chunk) => {
      length += chunk.length
      if (length > MAX_HELPER_OUTPUT) {
        child.kill()
        reject(new Error("Windows 文件辅助程序输出超过限制"))
      } else stdout.push(chunk)
    })
    child.stderr.on("data", (chunk) => { if (Buffer.concat(stderr).length < 4096) stderr.push(chunk) })
    child.once("error", () => reject(new Error("无法启动 Windows 文件安全辅助程序")))
    child.once("close", (code) => {
      const output = Buffer.concat(stdout).toString("utf8").trim()
      if (code !== 0) {
        const detail = Buffer.concat(stderr).toString("utf8").replace(/^CC:[a-z_]+:/, "").trim().slice(0, 300)
        reject(new Error(detail || "Windows 文件安全检查失败"))
      } else resolve(output)
    })
    child.stdin.end(extra.payload ? JSON.stringify(extra.payload) : "", "utf8")
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

export async function fileExists(root, relativePath) {
  const relative = normalizeRelative(relativePath)
  return JSON.parse(await runHelper("exists", root, relative))
}

export async function listDirectory(root, relativePath = "", { offset = 0, limit = 200 } = {}) {
  const relative = normalizeRelative(relativePath, { allowRoot: true })
  const safeOffset = Math.max(0, Math.min(100_000, Math.trunc(offset)))
  const safeLimit = Math.max(1, Math.min(500, Math.trunc(limit)))
  return JSON.parse(await runHelper("list", root, relative, { offset: safeOffset, limit: safeLimit }))
}

export async function readFileBytes(root, relativePath, maxBytes = 1_048_576) {
  const relative = normalizeRelative(relativePath)
  const output = await runHelper("read", root, relative, { maxBytes })
  return Buffer.from(output, "base64")
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

export async function createDirectory(root, relativePath) {
  const relative = normalizeRelative(relativePath)
  return JSON.parse(await runHelper("mkdir", root, relative))
}
