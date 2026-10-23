import path from "node:path"
import { lstat, readdir, readFile, realpath, rm, rmdir, unlink } from "node:fs/promises"
import { CHATCODE_HOME, TMP_DIR } from "../apps/server/core/config.mjs"

const allowed = ["build", "cache", "sessions", "tests", "downloads", "diagnostics", "logs"]
const expectedRoot = path.resolve(CHATCODE_HOME, ".tmp")
if (process.platform === "win32" ? path.win32.resolve(TMP_DIR).toLowerCase() !== path.win32.resolve(expectedRoot).toLowerCase() : path.resolve(TMP_DIR) !== expectedRoot) {
  throw new Error("clean:tmp 只允许清理 ChatCode 项目根目录下的 .tmp")
}

let rootStat
try { rootStat = await lstat(TMP_DIR) } catch (error) { if (error?.code === "ENOENT") process.exit(0); throw error }
if (!rootStat.isDirectory() || isReparse(rootStat)) throw new Error(".tmp 不是普通目录或本身是 reparse point；拒绝清理")
const resolvedRoot = await realpath(TMP_DIR)
if (!samePath(resolvedRoot, expectedRoot)) throw new Error(".tmp 实际路径不在 ChatCode 项目目录；拒绝清理")

const liveProcesses = await readRuntimeLocks()
if (liveProcesses.length) throw new Error(`ChatCode 仍在运行（PID ${liveProcesses.join(", ")}）；停止服务和 Tunnel MCP 子进程后再清理`)

for (const name of allowed) {
  const target = path.join(TMP_DIR, name)
  if (!inside(resolvedRoot, path.resolve(target))) throw new Error(`临时清理目标越界：${name}`)
  try {
    const stat = await lstat(target)
    if (!stat.isDirectory() || isReparse(stat)) continue
    await clearDirectory(target)
  } catch (error) {
    if (error?.code !== "ENOENT") throw error
  }
}
process.stdout.write(`已清理 .tmp 下的 ${allowed.join(", " )} 临时目录。\n`)

async function readRuntimeLocks() {
  const names = await readdir(TMP_DIR)
  const files = names.filter((name) => name === "admin-server.json" || /^mcp-\d+\.json$/.test(name))
  const live = []
  for (const name of files) {
    const file = path.join(TMP_DIR, name)
    const stat = await lstat(file)
    if (!stat.isFile() || isReparse(stat)) continue
    try {
      const record = JSON.parse(await readFile(file, "utf8"))
      const pid = Number(record.pid)
      if (Number.isInteger(pid) && pid > 0 && isRunning(pid)) live.push(pid)
      else if (Number.isInteger(pid) && pid > 0) await unlink(file)
    } catch (error) {
      if (error?.code === "ENOENT") continue
      throw new Error(`运行状态 ${name} 无法安全检查，拒绝清理`)
    }
  }
  return [...new Set(live)]
}

function isRunning(pid) {
  try { process.kill(pid, 0); return true } catch (error) { return error?.code === "EPERM" }
}

async function clearDirectory(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const child = path.join(directory, entry.name)
    if (!inside(resolvedRoot, path.resolve(child))) throw new Error("发现越界临时路径，停止清理")
    const stat = await lstat(child)
    if (isReparse(stat)) {
      try { await rm(child, { recursive: false, force: true }) }
      catch (error) {
        if (process.platform === "win32" && stat.isDirectory() && ["EISDIR", "EPERM"].includes(error?.code)) await rmdir(child)
        else throw error
      }
      continue
    }
    if (stat.isDirectory()) {
      await clearDirectory(child)
      await rmdir(child)
    } else if (stat.isFile()) {
      await unlink(child)
    }
  }
}

function isReparse(stat) {
  return stat.isSymbolicLink() || (process.platform === "win32" && (Number(stat.attributes ?? 0) & 0x400) !== 0)
}

function samePath(first, second) {
  return process.platform === "win32" ? path.win32.resolve(first).toLowerCase() === path.win32.resolve(second).toLowerCase() : path.resolve(first) === path.resolve(second)
}

function inside(root, target) {
  const flavor = process.platform === "win32" ? path.win32 : path
  const relative = flavor.relative(root, target)
  return relative === "" || (!relative.startsWith(`..${flavor.sep}`) && relative !== ".." && !flavor.isAbsolute(relative))
}
