import { mkdir } from "node:fs/promises"
import path from "node:path"
import { randomUUID } from "node:crypto"
import { CHATCODE_HOME, TMP_DIR } from "../../apps/server/core/config.mjs"
import { verifyOpenCodeSession } from "./adapter.mjs"

const sandbox = path.join(TMP_DIR, "tests", `opencode-sdk-${randomUUID()}`)
const isolatedHome = path.join(sandbox, "home")
const workspace = path.join(sandbox, "workspace")
for (const folder of [isolatedHome, workspace, path.join(sandbox, "xdg-config"), path.join(sandbox, "xdg-data"), path.join(sandbox, "xdg-cache"), path.join(sandbox, "xdg-state")]) {
  await mkdir(folder, { recursive: true })
}
process.env.OPENCODE_CONFIG_DIR = path.join(sandbox, "config")
process.env.XDG_CONFIG_HOME = path.join(sandbox, "xdg-config")
process.env.XDG_DATA_HOME = path.join(sandbox, "xdg-data")
process.env.XDG_CACHE_HOME = path.join(sandbox, "xdg-cache")
process.env.XDG_STATE_HOME = path.join(sandbox, "xdg-state")
process.env.HOME = isolatedHome
process.env.USERPROFILE = isolatedHome

const result = await verifyOpenCodeSession({ directory: workspace, databasePath: path.join(sandbox, "sessions.sqlite") })
if (!result.created || !result.readBack) throw new Error("OpenCode SDK 会话生命周期验证失败")
process.stdout.write(`${JSON.stringify({ ...result, workspace, database: path.join(sandbox, "sessions.sqlite"), chatcodeHome: CHATCODE_HOME }, null, 2)}\n`)
