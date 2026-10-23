import { OpenCode } from "@opencode/sdk"

export async function verifyOpenCodeSession({ directory, databasePath }) {
  if (!directory || !databasePath) throw new Error("需要提供 ChatCode 临时目录和隔离的会话数据库路径")
  const host = await OpenCode.create({ database: { path: databasePath } })
  try {
    const session = await host.sessions.create({ location: { directory }, title: "ChatCode SDK 生命周期验证" })
    const loaded = await host.sessions.get({ sessionID: session.id })
    return {
      sdk: "@opencode/sdk",
      version: "2.1.4",
      sessionId: session.id,
      created: Boolean(session.id),
      readBack: loaded.id === session.id,
      promptExecuted: false,
    }
  } finally {
    await host.close()
  }
}
