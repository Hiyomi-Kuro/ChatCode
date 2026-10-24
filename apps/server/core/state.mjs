import { randomUUID } from "node:crypto"
import { lstat, mkdir, readFile, realpath, rename, rm, writeFile } from "node:fs/promises"
import path from "node:path"
import { setTimeout as delay } from "node:timers/promises"
import { DATA_DIR, DATA_FILES, TMP_DIR } from "./config.mjs"

const queues = new Map()
const STATE_LOCK_TIMEOUT_MS = 30_000
const STATE_LOCK_STALE_MS = 60_000

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
  const operation = previous.catch(() => {}).then(async () => withStateLock(key, async () => {
    const value = await readArray(key)
    const result = await mutate(value)
    await writeArray(key, value)
    return result
  }))
  queues.set(key, operation)
  return operation
}

async function withStateLock(key, action) {
  const lockPath = path.join(TMP_DIR, `state-lock-${key}`)
  const ownerPath = path.join(lockPath, "owner.json")
  const token = randomUUID()
  const deadline = Date.now() + STATE_LOCK_TIMEOUT_MS

  while (true) {
    let created = false
    try {
      await mkdir(lockPath)
      created = true
      await writeFile(ownerPath, JSON.stringify({ token, pid: process.pid, createdAt: Date.now() }), { encoding: "utf8", flag: "wx" })
      break
    } catch (error) {
      if (created) {
        try { await rm(lockPath, { recursive: true, force: true }) } catch { /* preserve the original lock error */ }
      }
      if (error?.code !== "EEXIST") {
        throw error
      }
      await removeStaleStateLock(lockPath, ownerPath)
      if (Date.now() >= deadline) throw new Error(`等待 ${key} 持久化锁超时`)
      await delay(35 + Math.floor(Math.random() * 35))
    }
  }

  try {
    return await action()
  } finally {
    try {
      const stat = await lstat(lockPath)
      if (stat.isDirectory() && !isReparse(stat)) {
        const owner = JSON.parse(await readFile(ownerPath, "utf8"))
        if (owner.token === token && owner.pid === process.pid) await rm(lockPath, { recursive: true, force: true })
      }
    } catch { /* an interrupted or replaced lock is left for stale-lock recovery */ }
  }
}

async function removeStaleStateLock(lockPath, ownerPath) {
  try {
    const directory = await lstat(lockPath)
    if (!directory.isDirectory() || isReparse(directory)) throw new Error("拒绝使用非普通状态锁目录")
    let owner
    try {
      const ownerStat = await lstat(ownerPath)
      if (!ownerStat.isFile() || isReparse(ownerStat)) throw new Error("拒绝使用非普通状态锁文件")
      owner = JSON.parse(await readFile(ownerPath, "utf8"))
    } catch (error) {
      if (error?.code !== "ENOENT") throw error
    }
    const ageMs = Date.now() - (Number(owner?.createdAt) || directory.mtimeMs)
    if (ageMs < STATE_LOCK_STALE_MS) return
    if (Number.isInteger(owner?.pid) && isPidRunning(owner.pid)) return
    await rm(lockPath, { recursive: true, force: true })
  } catch (error) {
    if (error?.code !== "ENOENT") throw error
  }
}

function isPidRunning(pid) {
  try { process.kill(pid, 0); return true } catch (error) { return error?.code === "EPERM" }
}
