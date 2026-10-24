import { execFile } from "node:child_process"
import path from "node:path"
import { mkdir } from "node:fs/promises"
import { promisify } from "node:util"
import { hasBlockedExplicitDirectory, normalizeRelative, shouldSkipDirectory } from "./paths.mjs"
import { isManagedStatePath, isSensitiveAllowed, rejectManagedStatePath, requireWorkspace } from "./workspaces.mjs"
import { canonicalRoot } from "./safe-fs.mjs"
import { TMP_DIR } from "./config.mjs"

const execFileAsync = promisify(execFile)

async function runGit(workspace, args, maxBuffer = 512 * 1024) {
  const root = await canonicalRoot(workspace.root)
  if (path.win32.resolve(root).toLowerCase() !== path.win32.resolve(workspace.root).toLowerCase()) throw new Error("Git 工作区的最终路径已变化，拒绝访问")
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

export async function gitLog({ workspace_id }) {
  const workspace = await requireWorkspace(workspace_id)
  const output = await runGit(workspace, ["log", "-8", "--date=iso-strict", "--format=%h%x09%ad%x09%s"], 128 * 1024)
  const commits = output.split(/\r?\n/).filter(Boolean).slice(0, 8).map((line) => {
    const [hash, date, ...subject] = line.split("\t")
    return {
      hash: String(hash ?? "").slice(0, 16),
      date: String(date ?? "").slice(0, 40),
      subject: String(subject.join(" ") ?? "").replace(/[\0\x1b\x7f]/g, "").slice(0, 240),
    }
  })
  return { workspace_id, commits }
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
