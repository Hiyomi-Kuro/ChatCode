import assert from "node:assert/strict"
import { execFile } from "node:child_process"
import { mkdtemp, mkdir, readFile, rm, unlink, writeFile } from "node:fs/promises"
import path from "node:path"
import { promisify } from "node:util"
import { randomUUID } from "node:crypto"
import { test } from "node:test"
import { fileURLToPath } from "node:url"
import { Client } from "@modelcontextprotocol/client"
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio"

const execFileAsync = promisify(execFile)
const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const testsRoot = path.join(projectRoot, ".tmp", "tests")
await mkdir(testsRoot, { recursive: true })
const sandbox = await mkdtemp(path.join(testsRoot, "git-write-"))
const dataDir = path.join(sandbox, "data")
const tempDir = path.join(sandbox, "tmp")
const workspaceRoot = path.join(sandbox, "workspace")
await Promise.all([mkdir(dataDir, { recursive: true }), mkdir(tempDir, { recursive: true }), mkdir(workspaceRoot, { recursive: true })])
process.env.CHATCODE_HOME = projectRoot
process.env.CHATCODE_DATA_DIR = dataDir
process.env.CHATCODE_TMP_DIR = tempDir

const { ensureLayout, writeArray } = await import("../apps/server/core/state.mjs")
const workspaceId = randomUUID()
const repositoryGit = await execFileAsync(path.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "where.exe"), ["git.exe"], { encoding: "utf8" })
const gitExecutable = repositoryGit.stdout.split(/\r?\n/).map((line) => line.trim()).find(Boolean)
assert.ok(gitExecutable, "Git for Windows must be discoverable on PATH")

async function run(...args) {
  return execFileAsync(gitExecutable, args, { cwd: workspaceRoot, windowsHide: true, encoding: "utf8", maxBuffer: 2 * 1024 * 1024 })
}

await ensureLayout()
await mkdir(path.join(workspaceRoot, "src"), { recursive: true })
await writeFile(path.join(workspaceRoot, "src", "selected.txt"), "before selected\n", "utf8")
await writeFile(path.join(workspaceRoot, "src", "unselected.txt"), "before unselected\n", "utf8")
await run("init", "--quiet")
await run("config", "user.name", "ChatCode integration fixture")
await run("config", "user.email", "chatcode-test@localhost")
await run("add", "--", "src/selected.txt", "src/unselected.txt")
await run("commit", "--quiet", "-m", "baseline")
const workspace = {
  id: workspaceId, name: "Git write fixture", root: workspaceRoot, mode: "autoWritable", status: "active",
  executionAuthorization: {
    profile: "unattendedDev", version: 1, authorizationId: randomUUID(), authorizedAt: new Date().toISOString(),
    scope: { projectRoot: workspaceRoot, fixedCommands: [], npmScripts: [], android: [], gitReadOnly: true, gitWrite: true },
    osIsolation: "none",
  },
}
await writeArray("workspaces", [workspace])

test("preview-first commit is scoped, CAS published, idempotent, and worktrees are hooks-disabled and clean-only", async (t) => {
  let client
  let transport
  t.after(async () => {
    if (client) await client.close().catch(() => {})
    else await transport?.close().catch(() => {})
    await rm(sandbox, { recursive: true, force: true })
  })
  const mcpEnv = {
    CHATCODE_HOME: projectRoot, CHATCODE_DATA_DIR: dataDir, CHATCODE_TMP_DIR: tempDir,
    SystemRoot: process.env.SystemRoot ?? "C:\\Windows", SystemDrive: process.env.SystemDrive ?? "C:", PATH: process.env.PATH ?? "",
  }
  transport = new StdioClientTransport({ command: process.execPath, args: [path.join(projectRoot, "apps", "server", "mcp.mjs")], cwd: projectRoot, env: mcpEnv, stderr: "pipe" })
  client = new Client({ name: "chatcode-git-write-e2e", version: "1.0.0" })
  await client.connect(transport)
  const call = async (name, args = {}) => {
    const result = await client.callTool({ name, arguments: args }, { timeout: 300_000 })
    if (result.isError) throw new Error(`${name}: ${result.structuredContent?.error ?? result.content?.[0]?.text ?? "MCP tool failed"}`)
    return result.structuredContent
  }
  const expectError = async (name, args, pattern) => {
    const result = await client.callTool({ name, arguments: args }, { timeout: 300_000 })
    assert.equal(result.isError, true, `${name} should reject this input`)
    assert.match(result.structuredContent?.error ?? result.content?.[0]?.text ?? "", pattern)
  }
  const listedTools = await client.listTools()
  for (const name of ["git_preview_commit", "git_commit", "recover_git_commit", "git_create_worktree", "git_list_worktrees", "git_remove_worktree"]) {
    assert.ok(listedTools.tools.some((tool) => tool.name === name), `missing MCP Git tool ${name}`)
  }
  const initialHead = (await run("rev-parse", "HEAD")).stdout.trim()
  await writeFile(path.join(workspaceRoot, "src", "selected.txt"), "after selected\n", "utf8")
  const movedHeadPreview = await call("git_preview_commit", { workspace_id: workspaceId, paths: ["src/selected.txt"], message: "head race" })
  await run("commit", "--allow-empty", "--quiet", "-m", "advance head outside ChatCode")
  await expectError("git_commit", { workspace_id: workspaceId, preview_id: movedHeadPreview.preview_id, preview_sha256: movedHeadPreview.preview_sha256, request_id: randomUUID() }, /HEAD 已变化/)
  const headAfterExternalAdvance = (await run("rev-parse", "HEAD")).stdout.trim()
  assert.notEqual(headAfterExternalAdvance, initialHead)
  let preview = await call("git_preview_commit", { workspace_id: workspaceId, paths: ["src/selected.txt"], message: "selected file only" })
  assert.match(preview.patches[0].diff, /-before selected[\r\n]+\+after selected/)
  assert.deepEqual(preview.author, { name: "ChatCode integration fixture", email: "chatcode-test@localhost" })
  const previewRequest = { workspace_id: workspaceId, preview_id: preview.preview_id, preview_sha256: preview.preview_sha256, request_id: randomUUID() }
  await writeFile(path.join(workspaceRoot, "src", "selected.txt"), "changed after preview\n", "utf8")
  await expectError("git_commit", previewRequest, /版本已变化/)
  assert.equal((await run("rev-parse", "HEAD")).stdout.trim(), headAfterExternalAdvance, "a stale preview must not move the branch")

  await writeFile(path.join(workspaceRoot, "src", "selected.txt"), "after selected\n", "utf8")
  await writeFile(path.join(workspaceRoot, "src", "unselected.txt"), "staged and unselected\n", "utf8")
  await run("add", "--", "src/unselected.txt")
  preview = await call("git_preview_commit", { workspace_id: workspaceId, paths: ["src/selected.txt"], message: "selected file only" })
  const requestId = randomUUID()
  const committed = await call("git_commit", { workspace_id: workspaceId, preview_id: preview.preview_id, preview_sha256: preview.preview_sha256, request_id: requestId })
  assert.equal(committed.status, "committed")
  assert.notEqual(committed.commit, headAfterExternalAdvance)
  const duplicate = await call("git_commit", { workspace_id: workspaceId, preview_id: preview.preview_id, preview_sha256: preview.preview_sha256, request_id: requestId })
  assert.equal(duplicate.commit, committed.commit)
  assert.equal(duplicate.idempotent, true)
  assert.equal((await run("show", "HEAD:src/selected.txt")).stdout, "after selected\n")
  assert.equal((await run("show", "HEAD:src/unselected.txt")).stdout, "before unselected\n", "unselected changes must not enter the commit")
  assert.match((await run("status", "--porcelain")).stdout, /src\/unselected\.txt/, "the user staged index entry must remain outside the commit")

  await expectError("git_preview_commit", { workspace_id: workspaceId, paths: [".env"], message: "blocked" }, /敏感路径/)
  const hooksDir = path.join(workspaceRoot, ".git", "hooks")
  const hookMarker = path.join(sandbox, "post-checkout-hook-ran.txt")
  await writeFile(path.join(hooksDir, "post-checkout"), `#!/bin/sh\nprintf ran > '${hookMarker.replaceAll("\\", "/")}'\n`, "utf8")
  const worktree = await call("git_create_worktree", { workspace_id: workspaceId, request_id: randomUUID() })
  assert.equal(worktree.status, "ready")
  assert.equal(worktree.head, committed.commit)
  assert.equal(worktree.chatcode_managed, true)
  await assert.rejects(readFile(hookMarker, "utf8"), { code: "ENOENT" })
  const listed = await call("git_list_worktrees", { workspace_id: workspaceId })
  assert.ok(listed.worktrees.some((item) => item.worktree_id === worktree.worktree_id))
  const worktreePath = path.join(tempDir, "worktrees", workspaceId, worktree.worktree_id)
  const dirtyPath = path.join(worktreePath, "user-change.txt")
  await writeFile(dirtyPath, "keep me\n", "utf8")
  await expectError("git_remove_worktree", { workspace_id: workspaceId, worktree_id: worktree.worktree_id }, /不会强制移除/)
  await unlink(dirtyPath)
  const removed = await call("git_remove_worktree", { workspace_id: workspaceId, worktree_id: worktree.worktree_id })
  assert.equal(removed.status, "removed")
  assert.equal((await call("git_remove_worktree", { workspace_id: workspaceId, worktree_id: worktree.worktree_id })).idempotent, true)
  const evidenceDir = path.join(projectRoot, ".tmp", "phase9")
  await mkdir(evidenceDir, { recursive: true })
  await writeFile(path.join(evidenceDir, "a4-git-evidence.json"), `${JSON.stringify({
    at: new Date().toISOString(), test: "git-write.integration.test.mjs", result: "PASS",
    git_runtime: await call("get_git_runtime_status"), stale_file_preview_rejected: true,
    moved_head_preview_rejected: true, preview_sha256: preview.preview_sha256,
    commit: committed.commit, commit_retry_idempotent: duplicate.idempotent === true,
    unselected_staged_change_preserved: true, sensitive_path_rejected: true,
    worktree_hooks_disabled: true, dirty_worktree_removal_rejected: true, clean_worktree_removed: true,
  }, null, 2)}\n`, "utf8")
})

