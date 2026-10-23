import { appendFile } from "node:fs/promises"
import { assertRegularFile, ensureLayout } from "./state.mjs"
import { DATA_FILES } from "./config.mjs"
import { isSensitivePath } from "./paths.mjs"

function clean(value) {
  return String(value ?? "")
    .replace(/(?:bearer\s+)[A-Za-z0-9._~+/-]+/gi, "Bearer [REDACTED]")
    .replace(/(?:sk-[A-Za-z0-9_-]{12,}|gh[pousr]_[A-Za-z0-9_]{12,})/g, "[REDACTED]")
    .replace(/[\r\n\t]/g, " ")
    .slice(0, 500)
}

export async function audit(event, details = {}) {
  await ensureLayout()
  await assertRegularFile(DATA_FILES.audit, { allowMissing: true })
  const record = {
    at: new Date().toISOString(),
    event: clean(event),
    workspaceId: clean(details.workspaceId),
    path: isSensitivePath(String(details.path ?? "")) ? "[sensitive path]" : clean(details.path),
    itemId: clean(details.itemId),
    result: clean(details.result),
  }
  await appendFile(DATA_FILES.audit, `${JSON.stringify(record)}\n`, { encoding: "utf8" })
}
