import { runAndroidBuildWorker } from "./android.mjs"

const taskId = process.argv[2]
if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(taskId ?? "")) {
  process.stderr.write("Android worker requires a task ID.\n")
  process.exitCode = 2
} else {
  try {
    await runAndroidBuildWorker(taskId)
  } catch (error) {
    process.stderr.write(`${String(error?.message ?? "Android worker failed").replace(/[\r\n\0]+/g, " ").slice(0, 300)}\n`)
    process.exitCode = 1
  }
}
