import { randomUUID } from "node:crypto"
import { lstat, mkdir, open, readFile, realpath, rename, writeFile } from "node:fs/promises"
import path from "node:path"
import { rm } from "node:fs/promises"
import { setTimeout as delay } from "node:timers/promises"
import { DATA_DIR, DATA_FILES, TMP_DIR } from "./config.mjs"

const queues = new Map()

async function removeStaleLock(lockPath) {
  try {
    const stat = await lstat(lockPath)
    if (!stat.isFile() || isReparse(stat)) throw new Error(`拒绝使用非普通状态锁：${path.basename(lockPath)}`)
    if (Date.now() - stat.mtimeMs < 60_000) return
    let lock
    try { lock = JSON.parse(await readFile(lockPath, "utf8")) } catch { lock = null }
    let running = false
    if (Number.isInteger(lock?.pid) && lock.pid > 0) {
      try { process.kill(lock.pid, 0); running = true } catch (error) { running = error?.code === "EPERM" }
    }
    if (!running) {
      const confirmed = await lstat(lockPath)
      if (confirmed.isFile() && !isReparse(confirmed) && confirmed.dev === stat.dev && confirmed.ino === stat.ino) {
        const current = JSON.parse(await readFile(lockPath, "utf8"))
        if (current.token === lock?.token) await rm(lockPath, { force: true })
      }
    }
  } catch (error) {
    if (error?.code !== "ENOENT") throw error
  }
}

async function acquireArrayLock(key, file) {
  const lockPath = `${file}.lock`
  const token = randomUUID()
  const deadline = Date.now() + 30_000
  while (Date.now() < deadline) {
    try {
      await assertRegularFile(lockPath, { allowMissing: true })
      const handle = await open(lockPath, "wx")
      await handle.writeFile(`${JSON.stringify({ pid: process.pid, token, createdAt: Date.now() })}\n`, "utf8")
      await handle.close()
      return async () => {
        try {
          const current = JSON.parse(await readFile(lockPath, "utf8"))
          if (current.token === token && current.pid === process.pid) await rm(lockPath, { force: true })
        } catch (error) { if (error?.code !== "ENOENT") throw error }
      }
    } catch (error) {
      if (error?.code !== "EEXIST") throw error
      await removeStaleLock(lockPath)
      await delay(25)
    }
  }
  throw new Error(`等待 ${key} 状态文件锁超时`)
}

export async function ensureLayout() {
  await ensurePlainDirectory(DATA_DIR)
  await ensurePlainDirectory(TMP_DIR)
  for (const child of ["build", "cache", "sessions", "tests", "downloads", "diagnostics", "logs", "uploads"]) {
    await ensurePlainDirectory(path.join(TMP_DIR, child))
  }
}

export async function assertRegularFile(target, { allowMissing = false } = {}) {
  try {
    const stat = await lstat(target)
    if (!stat.isFile() || isReparse(stat)) throw new Error(`拒绝使用非普通文件或 reparse point：${path.basename(target)}`)
  } catch (error) {
    if (allowMissing && error?.code === "ENOENT") return false
    throw error
  }
  return true
}

async function ensurePlainDirectory(target) {
  await mkdir(target, { recursive: true })
  const stat = await lstat(target)
  if (!stat.isDirectory() || isReparse(stat)) throw new Error(`拒绝使用非普通目录或 reparse point：${target}`)
  const actual = await realpath(target)
  if (!samePath(actual, target)) throw new Error(`目录最终路径超出配置位置：${target}`)
}

function isReparse(stat) {
  return stat.isSymbolicLink() || (process.platform === "win32" && (Number(stat.attributes ?? 0) & 0x400) !== 0)
}

function samePath(first, second) {
  return process.platform === "win32" ? path.win32.resolve(first).toLowerCase() === path.win32.resolve(second).toLowerCase() : path.resolve(first) === path.resolve(second)
}

export async function readArray(key) {
  await ensureLayout()
  const file = DATA_FILES[key]
  if (!file) throw new Error("未知的持久化状态名称")
  try {
    await assertRegularFile(file)
    const value = JSON.parse(await readFile(file, "utf8"))
    if (!Array.isArray(value)) throw new Error("状态文件格式无效")
    return value
  } catch (error) {
    if (error?.code === "ENOENT") return []
    throw new Error(`无法读取 ${key} 状态：${error instanceof Error ? error.message : "未知错误"}`)
  }
}

export async function writeArray(key, value) {
  await ensureLayout()
  const file = DATA_FILES[key]
  if (!file) throw new Error("未知的持久化状态名称")
  await assertRegularFile(file, { allowMissing: true })
  if (!Array.isArray(value)) throw new TypeError("持久化状态必须是数组")
  const temporary = path.join(TMP_DIR, `state-${key}-${randomUUID()}.tmp`)
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", flag: "wx" })
  try {
    await assertRegularFile(file, { allowMissing: true })
    await rename(temporary, file)
  } catch (error) {
    try { await rm(temporary, { force: true }) } catch { /* keep the original state error */ }
    throw error
  }
}

export function mutateArray(key, mutate) {
  const previous = queues.get(key) ?? Promise.resolve()
  const operation = previous.catch(() => {}).then(async () => {
    await ensureLayout()
    const file = DATA_FILES[key]
    const release = await acquireArrayLock(key, file)
    try {
      const latest = await readArray(key)
      const result = await mutate(latest)
      await writeArray(key, latest)
      return result
    } finally {
      await release()
    }
  })
  queues.set(key, operation)
  return operation
}
