import { Worker } from "node:worker_threads"
import { fileURLToPath } from "node:url"

const workerUrl = new URL("./regex-worker.mjs", import.meta.url)

export function boundedRegexMatches(pattern, text, { caseSensitive = false, maxMatches = 10, timeoutMs = 2_000 } = {}) {
  if (typeof pattern !== "string" || !pattern || pattern.length > 160) throw new Error("正则表达式长度必须为 1 到 160 个字符")
  if (text.length > 1_048_576) throw new Error("正则搜索单文件超过 1 MiB 上限")
  try { new RegExp(pattern, caseSensitive ? "u" : "iu") } catch (error) { throw new Error(`正则表达式无效：${error.message}`) }
  const worker = new Worker(fileURLToPath(workerUrl), { workerData: { pattern, text, caseSensitive, maxMatches } })
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      void worker.terminate()
      reject(new Error("正则表达式运行超时，已终止本次搜索"))
    }, timeoutMs)
    worker.once("message", (matches) => { clearTimeout(timer); void worker.terminate(); resolve(matches) })
    worker.once("error", (error) => { clearTimeout(timer); void worker.terminate(); reject(error) })
    worker.once("exit", (code) => {
      if (code !== 0) { clearTimeout(timer); reject(new Error("正则搜索工作线程已终止")) }
    })
  })
}
