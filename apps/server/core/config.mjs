import path from "node:path"
import { fileURLToPath } from "node:url"

const here = path.dirname(fileURLToPath(import.meta.url))
export const CHATCODE_HOME = path.resolve(process.env.CHATCODE_HOME ?? path.resolve(here, "../../.."))
export const DATA_DIR = path.resolve(process.env.CHATCODE_DATA_DIR ?? path.join(CHATCODE_HOME, "data"))
export const TMP_DIR = path.resolve(process.env.CHATCODE_TMP_DIR ?? path.join(CHATCODE_HOME, ".tmp"))
export const SAFE_FS_SCRIPT = path.join(CHATCODE_HOME, "scripts", "safe-fs.ps1")

export const DATA_FILES = Object.freeze({
  workspaces: path.join(DATA_DIR, "workspaces.json"),
  changes: path.join(DATA_DIR, "changes.json"),
  tasks: path.join(DATA_DIR, "tasks.json"),
  agentTasks: path.join(DATA_DIR, "agent-tasks.json"),
  fileOperations: path.join(DATA_DIR, "file-operations.json"),
  fileRecovery: path.join(DATA_DIR, "file-recovery.json"),
  gitCommits: path.join(DATA_DIR, "git-commits.json"),
  gitPreviews: path.join(DATA_DIR, "git-previews.json"),
  gitWorktrees: path.join(DATA_DIR, "git-worktrees.json"),
  audit: path.join(DATA_DIR, "audit.jsonl"),
  tunnelSettings: path.join(DATA_DIR, "tunnel-settings.json"),
})

export function tempPath(...parts) {
  return path.join(TMP_DIR, ...parts)
}
