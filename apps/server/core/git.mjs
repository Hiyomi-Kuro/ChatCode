import { execFile } from "node:child_process"
import path from "node:path"
import { mkdir } from "node:fs/promises"
import { promisify } from "node:util"
import { hasBlockedExplicitDirectory, normalizeRelative, shouldSkipDirectory } from "./paths.mjs"
import { isManagedStatePath, isSensitiveAllowed, rejectManagedStatePath, requireWorkspace } from "./workspaces.mjs"
import { canonicalRoot, fileExists } from "./safe-fs.mjs"
import { TMP_DIR } from "./config.mjs"

const execFileAsync = promisify(execFile)

async function runGit(workspace, args, maxBuffer = 512 * 1024) {
  const root = await canonicalRoot(workspace.root)
  if (path.win32.resolve(root).toLowerCase() !== path.win32.resolve(workspace.root).toLowerCase()) throw new Error("Git 工作区的最终路径已变化，拒绝访问")
  // A child directory can otherwise inherit Git metadata from an enclosing checkout.
  // Keep all Git context and direct Git tools scoped to the selected workspace root.
  if (!(await fileExists(root, ".git"))) throw new Error("not a git repository (workspace root has no .git metadata)")
  const gitHome = path.join(TMP_DIR, "cache", "git-home")
  await mkdir(gitHome, { recursive: true })
  const env = {
    SystemRoot: process.env.SystemRoot ?? "C:\\Windows",
    SystemDrive: process.env.SystemDrive ?? "C:",
    PATH: process.env.PATH ?? "",
    HOME: gitHome,
    USERPROFILE: gitHome,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "NUL",
    GIT_CONFIG_COUNT: "0",
    GIT_OPTIONAL_LOCKS: "0",
    GIT_TERMINAL_PROMPT: "0",
    GIT_CEILING_DIRECTORIES: root,
    GIT_PAGER: "cat",
    PAGER: "cat",
    GIT_EXTERNAL_DIFF: "",
  }
  try {
    const result = await execFileAsync("git", ["--no-pager", "-c", "core.pager=cat", "-c", "core.fsmonitor=false", "-c", "diff.external=", ...args], {
      cwd: root,
      env,
      windowsHide: true,
      maxBuffer,
      timeout: 10_000,
      encoding: "utf8",
    })
    return result.stdout
  } catch (error) {
    const stderr = String(error?.stderr ?? "").slice(0, 300)
    if (error?.code === "ENOENT") throw new Error("未找到 Git。请安装 Git for Windows 并重启 ChatCode")
    if (error?.code === 1 && !stderr) return String(error?.stdout ?? "")
    throw new Error(stderr || String(error?.message ?? "Git 命令失败").slice(0, 300))
  }
}

export async function gitStatus({ workspace_id }) {
  const workspace = await requireWorkspace(workspace_id)
  const output = await runGit(workspace, ["status", "--short", "--branch", "--untracked-files=normal"])
  return { workspace_id, status: output.slice(0, 32_000), truncated: output.length > 32_000 }
}

export async function gitDiff({ workspace_id, path }) {
  const workspace = await requireWorkspace(workspace_id)
  const baseArgs = ["diff", "--no-ext-diff", "--no-color", "--no-textconv"]
  let relative = null
  if (path) {
    relative = normalizeRelative(path)
    if (!isSensitiveAllowed(workspace, relative)) throw new Error("拒绝返回受保护的敏感文件 Git Diff；请在本机管理页单独授权")
    if (hasBlockedExplicitDirectory(relative)) throw new Error("拒绝读取受保护的内部或生成目录 Git Diff")
    rejectManagedStatePath(workspace, relative)
    const output = await runGit(workspace, [...baseArgs, "--", relative], 2 * 1024 * 1024)
    return { workspace_id, path: relative, diff: output.slice(0, 120_000), truncated: output.length > 120_000 }
  }

  const changed = (await runGit(workspace, [...baseArgs, "--name-only", "-z", "--"])).split("\0").filter(Boolean)
  const visible = []
  let pathBytes = 0
  let omitted = false
  for (const candidate of changed) {
    let normalized
    try { normalized = normalizeRelative(candidate) } catch { omitted = true; continue }
    const parts = normalized.split("/")
    if (!isSensitiveAllowed(workspace, normalized) || hasBlockedExplicitDirectory(normalized) || parts.slice(0, -1).some(shouldSkipDirectory) || isManagedStatePath(workspace, normalized)) continue
    if (visible.length >= 50 || pathBytes + normalized.length > 12_000) { omitted = true; continue }
    visible.push(normalized)
    pathBytes += normalized.length
  }
  const output = visible.length ? await runGit(workspace, [...baseArgs, "--", ...visible], 2 * 1024 * 1024) : ""
  return { workspace_id, path: null, diff: output.slice(0, 120_000), truncated: omitted || output.length > 120_000 }
}

export async function collectGitContext(workspace) {
  const root = await canonicalRoot(workspace.root)
  if (path.win32.resolve(root).toLowerCase() !== path.win32.resolve(workspace.root).toLowerCase()) {
    throw new Error("Git 工作区的最终路径已变化，拒绝访问")
  }

  let hasMetadata
  try { hasMetadata = await fileExists(root, ".git") }
  catch (error) { return unavailableGitContext(error) }
  if (!hasMetadata) return unavailableGitContext(new Error("not a git repository (workspace root has no .git metadata)"))

  try {
    const topLevel = (await runGit(workspace, ["rev-parse", "--show-toplevel"])).trim()
    if (path.win32.resolve(topLevel).toLowerCase() !== path.win32.resolve(root).toLowerCase()) {
      return unavailableGitContext(new Error("corrupt Git metadata resolves outside the selected workspace root"), { hasMetadata })
    }
  } catch (error) {
    return unavailableGitContext(error, { hasMetadata })
  }

  try {
    const [status, names, recentCommits] = await Promise.all([
      runGit(workspace, ["status", "--short", "--branch", "--untracked-files=normal"]),
      runGit(workspace, ["diff", "--no-ext-diff", "--no-color", "--no-textconv", "--name-only", "-z", "--"]),
      runGit(workspace, ["log", "-8", "--format=%H%x09%cs%x09%s"]).catch((error) => {
        if (/does not have any commits yet|your current branch .* does not have any commits|unknown revision or path not in the working tree/i.test(String(error?.message ?? ""))) return ""
        throw error
      }),
    ])
    const visible = []
    let omitted = false
    for (const candidate of names.split("\0").filter(Boolean)) {
      let relative
      try { relative = normalizeRelative(candidate) } catch { omitted = true; continue }
      const parts = relative.split("/")
      if (!isSensitiveAllowed(workspace, relative) || hasBlockedExplicitDirectory(relative) ||
          parts.slice(0, -1).some(shouldSkipDirectory) || isManagedStatePath(workspace, relative)) continue
      if (visible.length >= 50) { omitted = true; continue }
      visible.push(relative)
    }
    const diff = visible.length
      ? await runGit(workspace, ["diff", "--no-ext-diff", "--no-color", "--no-textconv", "--", ...visible], 2 * 1024 * 1024)
      : ""
    return {
      available: true,
      status: status.slice(0, 32_000),
      status_truncated: status.length > 32_000,
      diff: diff.slice(0, 120_000),
      diff_truncated: omitted || diff.length > 120_000,
      recent_commits: recentCommits.split(/\r?\n/).filter(Boolean).slice(0, 8),
    }
  } catch (error) {
    return unavailableGitContext(error, { hasMetadata })
  }
}

function unavailableGitContext(error, { hasMetadata = false } = {}) {
  const detail = String(error?.message ?? "Git 元信息不可用").replace(/[\r\n\0]+/g, " ").slice(0, 300)
  const lower = detail.toLowerCase()
  let reason = "execution_failed"
  if (error?.code === "ENOENT" || /未找到 git|not found|cannot find/i.test(detail)) reason = "git_not_installed"
  else if (/permission denied|access is denied|拒绝访问|permission|权限不足/i.test(detail)) reason = "permission_denied"
  else if (/not a git repository|不是 git 仓库|不是 git 工作区/i.test(detail)) reason = hasMetadata ? "repository_corrupt" : "not_a_repository"
  else if (/corrupt|bad object|bad tree|bad revision.*head|index file.*corrupt|invalid object|index.*invalid|object file .* is empty/i.test(lower)) reason = "repository_corrupt"
  return { available: false, reason, diagnostic: detail, status: null, diff: null, recent_commits: [] }
}
