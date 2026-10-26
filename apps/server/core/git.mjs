import { execFile, spawn } from "node:child_process"
import { createHash, randomUUID } from "node:crypto"
import path from "node:path"
import { lstat, mkdir, readdir, realpath, rm } from "node:fs/promises"
import { promisify } from "node:util"
import { createTwoFilesPatch } from "diff"
import { TMP_DIR } from "./config.mjs"
import { audit } from "./audit.mjs"
import { hasBlockedExplicitDirectory, isSensitivePath, normalizeRelative, shouldSkipDirectory } from "./paths.mjs"
import { getUnattendedDevGrant, isManagedStatePath, isSensitiveAllowed, rejectManagedStatePath, requireWorkspace } from "./workspaces.mjs"
import { canonicalRoot, fileExists, fileInfo, hashFile, readFileBytes } from "./safe-fs.mjs"
import { mutateArray, readArray, withNamedStateLock } from "./state.mjs"
import { invalidateWorkspaceLsp } from "./lsp.mjs"

const execFileAsync = promisify(execFile)
let gitRuntimePromise

function sha256(value) { return createHash("sha256").update(value).digest("hex") }

async function gitRuntime() {
  if (gitRuntimePromise) return gitRuntimePromise
  gitRuntimePromise = (async () => {
    try {
      const where = path.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "where.exe")
      const result = await execFileAsync(where, ["git.exe"], { env: { SystemRoot: process.env.SystemRoot ?? "C:\\Windows", PATH: process.env.PATH ?? "" }, windowsHide: true, timeout: 5000, maxBuffer: 16_384, encoding: "utf8" })
      for (const candidate of result.stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean)) {
        try {
          if (!/(?:^|[\\/])Git[\\/](?:cmd|bin)[\\/]git\.exe$/i.test(candidate)) continue
          const item = await lstat(candidate)
          if (!item.isFile() || item.isSymbolicLink() || (Number(item.attributes ?? 0) & 0x400) !== 0 || item.size > 100_000_000) continue
          const executable = await realpath(candidate)
          const version = (await execFileAsync(executable, ["--version"], { windowsHide: true, timeout: 5000, maxBuffer: 4096, encoding: "utf8" })).stdout.trim()
          if (!/^git version \d+\.\d+/.test(version)) continue
          const hash = createHash("sha256")
          const stream = (await import("node:fs")).createReadStream(executable)
          for await (const chunk of stream) hash.update(chunk)
          return { available: true, executable, version, sha256: hash.digest("hex") }
        } catch { /* try the next locally installed Git binary */ }
      }
    } catch { /* report unavailable rather than running a shell fallback */ }
    return { available: false, reason: "git_not_installed" }
  })()
  return gitRuntimePromise
}

async function runGit(workspace, args, maxBuffer = 512 * 1024, extraEnv = {}) {
  const root = await canonicalRoot(workspace.root)
  if (path.win32.resolve(root).toLowerCase() !== path.win32.resolve(workspace.root).toLowerCase()) throw new Error("Git 工作区的最终路径已变化，拒绝访问")
  // A child directory can otherwise inherit Git metadata from an enclosing checkout.
  // Keep all Git context and direct Git tools scoped to the selected workspace root.
  if (!(await fileExists(root, ".git"))) throw new Error("not a git repository (workspace root has no .git metadata)")
  const gitHome = path.join(TMP_DIR, "cache", "git-home")
  await mkdir(gitHome, { recursive: true })
  const runtime = await gitRuntime()
  if (!runtime.available) throw new Error("未找到受信任的 Git for Windows 安装")
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
    ...extraEnv,
  }
  try {
    const result = await execFileAsync(runtime.executable, ["--literal-pathspecs", "--no-pager", "-c", "core.pager=cat", "-c", "core.fsmonitor=false", "-c", "diff.external=", ...args], {
      cwd: root,
      env,
      windowsHide: true,
      maxBuffer,
      timeout: 60_000,
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

const GIT_COMMIT_MAX_FILES = 100
const GIT_COMMIT_MAX_FILE_BYTES = 4 * 1024 * 1024
const GIT_COMMIT_MAX_TOTAL_BYTES = 32 * 1024 * 1024
const GIT_PREVIEW_TTL_MS = 60 * 60 * 1000
const GIT_WORKTREE_ROOT = path.join(TMP_DIR, "worktrees")

function canonicalJson(value) { return JSON.stringify(value) }

async function requireGitWriteWorkspace(workspaceId, operation) {
  const workspace = await requireWorkspace(workspaceId, { writable: true })
  if (workspace.mode !== "autoWritable") throw new Error("受控 Git commit/worktree 仅适用于本机明确授予 autoWritable 的工作区")
  await getUnattendedDevGrant(workspace, { kind: "git_write", operation })
  const runtime = await gitRuntime()
  if (!runtime.available) throw new Error("未找到受信任的 Git for Windows 安装")
  const root = await canonicalRoot(workspace.root)
  if (path.win32.resolve(root).toLowerCase() !== path.win32.resolve(workspace.root).toLowerCase()) throw new Error("Git 工作区的最终路径已变化，拒绝访问")
  if (!(await fileExists(root, ".git"))) throw new Error("工作区根目录没有 .git 元信息")
  const top = (await runGit(workspace, ["rev-parse", "--show-toplevel"])).trim()
  if (path.win32.resolve(top).toLowerCase() !== path.win32.resolve(root).toLowerCase()) throw new Error("Git 仓库根目录与已授权工作区不一致")
  return workspace
}

async function runGitInput(workspace, args, input, { maxOutput = 64 * 1024, timeoutMs = 30_000, extraEnv = {} } = {}) {
  const root = await canonicalRoot(workspace.root)
  const runtime = await gitRuntime()
  if (!runtime.available) throw new Error("未找到受信任的 Git for Windows 安装")
  const gitHome = path.join(TMP_DIR, "cache", "git-home")
  await mkdir(gitHome, { recursive: true })
  const env = {
    SystemRoot: process.env.SystemRoot ?? "C:\\Windows", SystemDrive: process.env.SystemDrive ?? "C:",
    PATH: process.env.PATH ?? "", HOME: gitHome, USERPROFILE: gitHome,
    GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "NUL", GIT_CONFIG_COUNT: "0",
    GIT_OPTIONAL_LOCKS: "0", GIT_TERMINAL_PROMPT: "0", GIT_CEILING_DIRECTORIES: root,
    GIT_PAGER: "cat", PAGER: "cat", GIT_EXTERNAL_DIFF: "", ...extraEnv,
  }
  return new Promise((resolve, reject) => {
    const child = spawn(runtime.executable, ["--literal-pathspecs", "--no-pager", "-c", "core.pager=cat", "-c", "core.fsmonitor=false", "-c", "diff.external=", ...args], {
      cwd: root, env, windowsHide: true, stdio: ["pipe", "pipe", "pipe"],
    })
    const stdout = []
    const stderr = []
    let outputLength = 0
    let settled = false
    const finish = (error, value) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (error) reject(error)
      else resolve(value)
    }
    const timer = setTimeout(() => { child.kill(); finish(new Error("Git 输入操作超时")) }, timeoutMs)
    child.stdout.on("data", (chunk) => {
      outputLength += chunk.length
      if (outputLength > maxOutput) { child.kill(); finish(new Error("Git 命令输出超过限制")); return }
      stdout.push(chunk)
    })
    child.stderr.on("data", (chunk) => { if (Buffer.concat(stderr).length < 4096) stderr.push(chunk) })
    child.once("error", () => finish(new Error("无法启动已验证的 Git 可执行文件")))
    child.once("close", (code) => {
      if (code === 0) return finish(null, Buffer.concat(stdout).toString("utf8").trim())
      finish(new Error(Buffer.concat(stderr).toString("utf8").replace(/[\r\n\0]+/g, " ").trim().slice(0, 300) || `Git 命令退出 ${code}`))
    })
    child.stdin.end(input)
  })
}

async function runGitBytes(workspace, args, maxOutput = GIT_COMMIT_MAX_FILE_BYTES) {
  const root = await canonicalRoot(workspace.root)
  const runtime = await gitRuntime()
  if (!runtime.available) throw new Error("未找到受信任的 Git for Windows 安装")
  const gitHome = path.join(TMP_DIR, "cache", "git-home")
  await mkdir(gitHome, { recursive: true })
  const env = {
    SystemRoot: process.env.SystemRoot ?? "C:\\Windows", SystemDrive: process.env.SystemDrive ?? "C:",
    PATH: process.env.PATH ?? "", HOME: gitHome, USERPROFILE: gitHome,
    GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "NUL", GIT_CONFIG_COUNT: "0",
    GIT_OPTIONAL_LOCKS: "0", GIT_TERMINAL_PROMPT: "0", GIT_CEILING_DIRECTORIES: root,
    GIT_PAGER: "cat", PAGER: "cat", GIT_EXTERNAL_DIFF: "",
  }
  const result = await execFileAsync(runtime.executable, ["--literal-pathspecs", "--no-pager", "-c", "core.pager=cat", "-c", "core.fsmonitor=false", ...args], {
    cwd: root, env, windowsHide: true, maxBuffer: maxOutput, timeout: 30_000, encoding: "buffer",
  })
  if (result.stdout.length > maxOutput) throw new Error("Git blob 超过读取限制")
  return result.stdout
}

async function gitHeadAndRef(workspace) {
  let head
  try { head = (await runGit(workspace, ["rev-parse", "--verify", "HEAD"])).trim() }
  catch { throw new Error("受控 commit/worktree 需要至少一个现有本地提交") }
  if (!/^[a-f0-9]{40,64}$/i.test(head)) throw new Error("Git HEAD 格式无效")
  let ref
  try { ref = (await runGit(workspace, ["symbolic-ref", "--quiet", "HEAD"])).trim() }
  catch { throw new Error("受控 commit/worktree 不支持 detached HEAD；请先切换到本地分支") }
  if (!/^refs\/heads\/[A-Za-z0-9._/-]+$/.test(ref) || ref.includes("..") || ref.endsWith("/")) throw new Error("当前分支引用格式不安全")
  return { head, ref }
}

function validateGitCommitPath(workspace, input) {
  const relative = normalizeRelative(input)
  if (/[\u0001-\u001f\u007f]/.test(relative)) throw new Error("Git commit 路径不能包含控制字符")
  const parents = relative.split("/").slice(0, -1)
  if (isSensitivePath(relative)) throw new Error(`受控 Git commit 禁止敏感路径：${relative}`)
  if (hasBlockedExplicitDirectory(relative) || parents.some(shouldSkipDirectory)) throw new Error(`受控 Git commit 禁止内部、依赖或生成路径：${relative}`)
  if (isManagedStatePath(workspace, relative)) throw new Error("受控 Git commit 禁止 ChatCode 管理状态路径")
  rejectManagedStatePath(workspace, relative)
  if (!isSensitiveAllowed(workspace, relative)) throw new Error(`拒绝受保护的敏感路径：${relative}`)
  return relative
}

async function currentFileForPreview(workspace, relative) {
  if (!(await fileExists(workspace.root, relative))) return { path: relative, exists: false, sha256: null, version: "missing", size_bytes: 0 }
  const info = await fileInfo(workspace.root, relative)
  if (info.isDirectory) throw new Error(`commit 只接受普通文件：${relative}`)
  const size = Number(info.sizeBytes ?? info.size)
  if (!Number.isSafeInteger(size) || size < 0 || size > GIT_COMMIT_MAX_FILE_BYTES) throw new Error(`commit 文件超过 ${GIT_COMMIT_MAX_FILE_BYTES} bytes 或大小无效：${relative}`)
  const hash = await hashFile(workspace.root, relative)
  if (info.version !== hash.version || String(size) !== String(hash.sizeBytes)) throw new Error(`预览期间文件发生变化：${relative}`)
  return { path: relative, exists: true, sha256: hash.sha256, version: hash.version, size_bytes: size }
}

async function resolveCommitAuthor(workspace, authorName, authorEmail) {
  if ((authorName === undefined) !== (authorEmail === undefined)) throw new Error("author_name 和 author_email 必须同时提供")
  if (authorName === undefined) {
    try {
      const identity = (await runGit(workspace, ["var", "GIT_AUTHOR_IDENT"])).trim()
      const parsed = identity.match(/^(.+) <([^<>\r\n]+)> \d+ [+-]\d{4}$/)
      if (parsed) return { name: parsed[1], email: parsed[2] }
    } catch { /* use the explicit ChatCode identity when the repository has no valid local author config */ }
    return { name: "ChatCode Local", email: "chatcode@localhost" }
  }
  if (typeof authorName !== "string" || authorName.trim().length < 1 || authorName.trim().length > 100 || /[\u0000-\u001f\u007f<>]/.test(authorName)) throw new Error("author_name 格式无效")
  if (typeof authorEmail !== "string" || authorEmail.trim().length < 3 || authorEmail.trim().length > 254 || /[\r\n\0<>\s]/.test(authorEmail) || !authorEmail.includes("@")) throw new Error("author_email 格式无效")
  return { name: authorName.trim(), email: authorEmail.trim() }
}

export async function gitPreviewCommit({ workspace_id, paths, message, author_name, author_email }) {
  const workspace = await requireGitWriteWorkspace(workspace_id, "preview_commit")
  if (!Array.isArray(paths) || paths.length < 1 || paths.length > GIT_COMMIT_MAX_FILES) throw new Error(`paths 必须是 1 到 ${GIT_COMMIT_MAX_FILES} 个明确文件路径`)
  if (typeof message !== "string" || !message.trim() || message.trim().length > 240 || /[\u0000-\u001f\u007f]/.test(message)) throw new Error("commit message 必须是单行的 1 到 240 个可打印字符")
  const selected = [...new Set(paths.map((value) => validateGitCommitPath(workspace, value)))].sort((a, b) => a.localeCompare(b, "en"))
  if (selected.length !== paths.length) throw new Error("paths 不能包含重复路径")
  const author = await resolveCommitAuthor(workspace, author_name, author_email)
  const { head, ref } = await gitHeadAndRef(workspace)
  const files = []
  let totalBytes = 0
  for (const relative of selected) {
    const file = await currentFileForPreview(workspace, relative)
    totalBytes += file.size_bytes
    if (totalBytes > GIT_COMMIT_MAX_TOTAL_BYTES) throw new Error(`commit 选中文件总量不能超过 ${GIT_COMMIT_MAX_TOTAL_BYTES} bytes`)
    files.push(file)
  }
  const patches = []
  let patchBytes = 0
  let patchTruncated = false
  for (const file of files) {
    const treeEntry = (await runGit(workspace, ["ls-tree", "-z", head, "--", file.path], 64 * 1024)).split("\0").filter(Boolean)[0]
    const objectEntry = treeEntry?.match(/^(100644|100755|120000) blob ([a-f0-9]{40,64})\t/)
    const before = objectEntry ? await runGitBytes(workspace, ["cat-file", "blob", objectEntry[2]], GIT_COMMIT_MAX_FILE_BYTES) : Buffer.alloc(0)
    const after = file.exists ? await readFileBytes(workspace.root, file.path, GIT_COMMIT_MAX_FILE_BYTES) : Buffer.alloc(0)
    if (file.exists && sha256(after) !== file.sha256) throw new Error(`生成预览 Diff 时文件发生变化：${file.path}`)
    const beforeText = before.toString("utf8")
    const afterText = after.toString("utf8")
    const validUtf8 = Buffer.from(beforeText, "utf8").equals(before) && Buffer.from(afterText, "utf8").equals(after) && !before.includes(0) && !after.includes(0)
    if (!validUtf8) {
      patches.push({ path: file.path, kind: "binary", before_sha256: objectEntry ? sha256(before) : null, after_sha256: file.sha256, before_bytes: before.length, after_bytes: after.length, diff: null })
      continue
    }
    const diff = createTwoFilesPatch(`${file.path} (HEAD)`, file.path, beforeText, afterText, "", "", { context: 3 })
    const byteLength = Buffer.byteLength(diff, "utf8")
    if (patchBytes + byteLength <= 512 * 1024) {
      patches.push({ path: file.path, kind: "text", before_sha256: objectEntry ? sha256(before) : null, after_sha256: file.sha256, before_bytes: before.length, after_bytes: after.length, diff })
      patchBytes += byteLength
    } else {
      patchTruncated = true
      patches.push({ path: file.path, kind: "text", before_sha256: objectEntry ? sha256(before) : null, after_sha256: file.sha256, before_bytes: before.length, after_bytes: after.length, diff: null, diff_omitted: "preview_diff_limit" })
    }
  }
  const previewId = randomUUID()
  const previewCore = { workspace_id, preview_id: previewId, branch_ref: ref, base_head: head, author, message: message.trim(), files, patches, patch_truncated: patchTruncated }
  const previewSha256 = sha256(canonicalJson(previewCore))
  const now = new Date().toISOString()
  await mutateArray("gitPreviews", (items) => {
    const cutoff = Date.now() - GIT_PREVIEW_TTL_MS
    const retained = items.filter((item) => Date.parse(item.createdAt) >= cutoff).slice(-99)
    items.splice(0, items.length, ...retained)
    items.push({ ...previewCore, preview_sha256: previewSha256, status: "previewed", createdAt: now })
  })
  await audit("git_commit_preview_created", { workspaceId: workspace_id, itemId: previewId, result: `${files.length}_files` })
  return { ...previewCore, preview_sha256: previewSha256, expires_at: new Date(Date.now() + GIT_PREVIEW_TTL_MS).toISOString(), hooks: "disabled", push: false }
}

function safeIndexPath(previewId) {
  if (!/^[0-9a-f-]{36}$/i.test(previewId)) throw new Error("Git 预览 ID 无效")
  return path.join(TMP_DIR, "git-indexes", `${previewId}.index`)
}

async function removeSafeIndex(indexPath) {
  try {
    const stat = await lstat(indexPath)
    if (!stat.isFile() || stat.isSymbolicLink() || (process.platform === "win32" && (Number(stat.attributes ?? 0) & 0x400) !== 0)) return
    await rm(indexPath, { force: true })
  } catch (error) { if (error?.code !== "ENOENT") throw error }
}

async function persistCommitState(record) {
  await mutateArray("gitCommits", (items) => {
    const index = items.findIndex((item) => item.id === record.id)
    if (index < 0) items.push(record)
    else items[index] = { ...items[index], ...record, updatedAt: new Date().toISOString() }
  })
}

async function publishRecordedCommit(workspace, record) {
  if (!record.commitOid || !record.baseHead || !record.ref) throw new Error("Git commit journal 缺少可恢复的信息")
  const current = (await runGit(workspace, ["rev-parse", "--verify", record.ref])).trim()
  if (current === record.commitOid) {
    record.status = "committed"
    record.recovered = true
    record.updatedAt = new Date().toISOString()
    await persistCommitState(record)
    await invalidateWorkspaceLsp(workspace.id)
    return { commit_id: record.id, status: "committed", commit: record.commitOid, recovered: true, idempotent: true }
  }
  if (current !== record.baseHead) {
    record.status = "conflict"
    record.updatedAt = new Date().toISOString()
    await persistCommitState(record)
    return { commit_id: record.id, status: "conflict", commit: record.commitOid, expected_head: record.baseHead, current_head: current }
  }
  try {
    await runGit(workspace, ["update-ref", record.ref, record.commitOid, record.baseHead])
  } catch {
    const latest = (await runGit(workspace, ["rev-parse", "--verify", record.ref])).trim()
    if (latest !== record.commitOid) throw new Error("Git ref CAS 未成功；当前分支未被覆盖，可重新恢复或重新预览")
  }
  record.status = "committed"
  record.updatedAt = new Date().toISOString()
  await persistCommitState(record)
  await invalidateWorkspaceLsp(workspace.id)
  await audit("git_commit_published", { workspaceId: workspace.id, itemId: record.id, result: record.commitOid })
  return { commit_id: record.id, status: "committed", commit: record.commitOid, branch_ref: record.ref, recovered: false, idempotent: false }
}

export async function gitCommit({ workspace_id, preview_id, preview_sha256, request_id }) {
  const workspace = await requireGitWriteWorkspace(workspace_id, "commit")
  if (!/^[a-f0-9]{64}$/i.test(preview_sha256 ?? "")) throw new Error("必须提供预览 SHA-256")
  return withNamedStateLock("git-write", async () => {
    const preview = (await readArray("gitPreviews")).find((item) => item.preview_id === preview_id && item.workspace_id === workspace_id)
    if (!preview) throw new Error("找不到可用的 Git commit 预览")
    if (preview.preview_sha256.toLowerCase() !== preview_sha256.toLowerCase()) throw new Error("Git commit 预览 SHA-256 不匹配")
    const existing = (await readArray("gitCommits")).find((item) => item.previewId === preview_id)
    if (existing) {
      if (existing.requestId !== request_id) throw new Error("此预览已经绑定另一个 idempotency request_id")
      if (existing.status === "committed") return { commit_id: existing.id, status: "committed", commit: existing.commitOid, branch_ref: existing.ref, idempotent: true }
      if (existing.status === "conflict") return { commit_id: existing.id, status: "conflict", commit: existing.commitOid }
      return publishRecordedCommit(workspace, existing)
    }
    if (preview.status !== "previewed") throw new Error("此 Git commit 预览已被使用或正在恢复")
    if (Date.now() - Date.parse(preview.createdAt) > GIT_PREVIEW_TTL_MS) throw new Error("Git commit 预览已过期；请重新预览")
    const { head, ref } = await gitHeadAndRef(workspace)
    if (head !== preview.base_head || ref !== preview.branch_ref) throw new Error("预览后分支或 HEAD 已变化；请重新生成预览")
    const indexPath = safeIndexPath(preview_id)
    await mkdir(path.dirname(indexPath), { recursive: true })
    await removeSafeIndex(indexPath)
    const extraEnv = { GIT_INDEX_FILE: indexPath }
    let record
    try {
      await runGit(workspace, ["read-tree", head], 64 * 1024, extraEnv)
      for (const file of preview.files) {
        const current = await currentFileForPreview(workspace, file.path)
        if (current.sha256 !== file.sha256 || current.version !== file.version || current.exists !== file.exists) throw new Error(`预览后文件版本已变化：${file.path}`)
        if (!file.exists) {
          await runGit(workspace, ["update-index", "--force-remove", "--", file.path], 64 * 1024, extraEnv)
          continue
        }
        const bytes = await readFileBytes(workspace.root, file.path, GIT_COMMIT_MAX_FILE_BYTES)
        if (sha256(bytes) !== file.sha256 || bytes.length !== file.size_bytes) throw new Error(`读取期间文件内容已变化：${file.path}`)
        const afterRead = await currentFileForPreview(workspace, file.path)
        if (afterRead.version !== file.version || afterRead.sha256 !== file.sha256) throw new Error(`读取期间文件版本已变化：${file.path}`)
        const blob = await runGitInput(workspace, ["hash-object", "-w", "--stdin"], bytes)
        if (!/^[a-f0-9]{40,64}$/i.test(blob)) throw new Error("Git blob SHA-1/SHA-256 格式无效")
        const cached = (await runGit(workspace, ["ls-files", "--stage", "-z", "--", file.path], 64 * 1024, extraEnv)).split("\0").filter(Boolean)[0]
        const mode = cached?.match(/^(100644|100755) [a-f0-9]{40,64} 0\t/)?.[1] ?? "100644"
        await runGit(workspace, ["update-index", "--add", "--cacheinfo", `${mode},${blob},${file.path}`], 64 * 1024, extraEnv)
      }
      const tree = (await runGit(workspace, ["write-tree"], 64 * 1024, extraEnv)).trim()
      if (!/^[a-f0-9]{40,64}$/i.test(tree) || tree === (await runGit(workspace, ["rev-parse", `${head}^{tree}`])).trim()) throw new Error("所选文件没有产生相对 HEAD 的 Git tree 变化")
      const commitOid = (await runGit(workspace, ["commit-tree", tree, "-p", head, "-m", preview.message], 64 * 1024, {
        GIT_AUTHOR_NAME: preview.author.name, GIT_AUTHOR_EMAIL: preview.author.email,
        GIT_COMMITTER_NAME: preview.author.name, GIT_COMMITTER_EMAIL: preview.author.email,
      })).trim()
      if (!/^[a-f0-9]{40,64}$/i.test(commitOid)) throw new Error("Git commit 对象格式无效")
      record = {
        id: randomUUID(), workspaceId: workspace_id, previewId: preview_id, requestId: request_id,
        status: "ready_to_publish", ref, baseHead: head, tree, commitOid,
        paths: preview.files.map((file) => file.path), createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
      }
      await persistCommitState(record)
    } finally {
      await removeSafeIndex(indexPath)
    }
    await mutateArray("gitPreviews", (items) => {
      const item = items.find((entry) => entry.preview_id === preview_id)
      if (item) item.status = "committing"
    })
    return publishRecordedCommit(workspace, record)
  })
}

export async function gitRecoverCommit({ workspace_id, commit_id }) {
  const workspace = await requireGitWriteWorkspace(workspace_id, "recover_commit")
  return withNamedStateLock("git-write", async () => {
    const record = (await readArray("gitCommits")).find((item) => item.id === commit_id && item.workspaceId === workspace_id)
    if (!record) throw new Error("找不到此工作区的 Git commit recovery journal")
    if (record.status === "committed") return { commit_id, status: "committed", commit: record.commitOid, idempotent: true }
    if (record.status === "conflict") return { commit_id, status: "conflict", commit: record.commitOid }
    return publishRecordedCommit(workspace, record)
  })
}

async function verifyNoConfiguredGitFilters(workspace) {
  const output = await runGit(workspace, ["config", "--local", "--get-regexp", "^filter\\..*\\.(clean|smudge|process)$"], 64 * 1024).catch((error) => {
    if (/exit 1|返回代码 1|exited with code 1/i.test(String(error?.message ?? ""))) return ""
    throw error
  })
  if (output.trim()) throw new Error("拒绝创建 worktree：仓库配置了外部 Git filter；请先在本机审查并移除该配置")
}

async function managedWorktreePath(workspaceId, worktreeId) {
  if (!/^[0-9a-f-]{36}$/i.test(workspaceId) || !/^[0-9a-f-]{36}$/i.test(worktreeId)) throw new Error("ChatCode worktree ID 无效")
  await mkdir(GIT_WORKTREE_ROOT, { recursive: true })
  const managedRoot = await lstat(GIT_WORKTREE_ROOT)
  if (!managedRoot.isDirectory() || managedRoot.isSymbolicLink() || (process.platform === "win32" && (Number(managedRoot.attributes ?? 0) & 0x400) !== 0)) throw new Error("ChatCode worktree 根目录不是普通目录")
  if (path.win32.resolve(await realpath(GIT_WORKTREE_ROOT)).toLowerCase() !== path.win32.resolve(GIT_WORKTREE_ROOT).toLowerCase()) throw new Error("ChatCode worktree 根目录最终路径发生变化")
  const parent = path.join(GIT_WORKTREE_ROOT, workspaceId)
  await mkdir(parent, { recursive: true })
  const parentInfo = await lstat(parent)
  if (!parentInfo.isDirectory() || parentInfo.isSymbolicLink() || (process.platform === "win32" && (Number(parentInfo.attributes ?? 0) & 0x400) !== 0)) throw new Error("ChatCode worktree 父目录不是普通目录")
  if (path.win32.resolve(await realpath(parent)).toLowerCase() !== path.win32.resolve(parent).toLowerCase()) throw new Error("ChatCode worktree 父目录最终路径发生变化")
  return path.join(parent, worktreeId)
}

async function verifyManagedWorktree(workspace, record) {
  const expectedPath = await managedWorktreePath(workspace.id, record.id)
  if (path.win32.resolve(record.path).toLowerCase() !== path.win32.resolve(expectedPath).toLowerCase()) throw new Error("Git worktree journal 路径校验失败")
  const info = await lstat(expectedPath)
  if (!info.isDirectory() || info.isSymbolicLink() || (process.platform === "win32" && (Number(info.attributes ?? 0) & 0x400) !== 0)) throw new Error("ChatCode worktree 不是普通目录")
  const resolved = await realpath(expectedPath)
  if (path.win32.resolve(resolved).toLowerCase() !== path.win32.resolve(expectedPath).toLowerCase()) throw new Error("ChatCode worktree 最终路径发生变化")
  const top = (await runGit(workspace, ["-C", expectedPath, "rev-parse", "--show-toplevel"])).trim()
  if (path.win32.resolve(top).toLowerCase() !== path.win32.resolve(expectedPath).toLowerCase()) throw new Error("登记路径不再是对应 Git worktree 根目录")
  const expectedBranch = `refs/heads/${record.branch}`
  const branch = (await runGit(workspace, ["-C", expectedPath, "symbolic-ref", "--quiet", "HEAD"])).trim()
  if (branch !== expectedBranch) throw new Error("ChatCode worktree 的分支引用已变化")
  const [mainCommon, worktreeCommon] = await Promise.all([
    runGit(workspace, ["rev-parse", "--path-format=absolute", "--git-common-dir"]),
    runGit(workspace, ["-C", expectedPath, "rev-parse", "--path-format=absolute", "--git-common-dir"]),
  ])
  if (path.win32.resolve(mainCommon.trim()).toLowerCase() !== path.win32.resolve(worktreeCommon.trim()).toLowerCase()) throw new Error("登记路径不属于已授权仓库的 Git common directory")
  return expectedPath
}

export async function gitCreateWorktree({ workspace_id, request_id }) {
  const workspace = await requireGitWriteWorkspace(workspace_id, "create_worktree")
  return withNamedStateLock("git-worktree", async () => {
    let record = (await readArray("gitWorktrees")).find((item) => item.workspaceId === workspace_id && item.requestId === request_id)
    if (record?.status === "ready") {
      await verifyManagedWorktree(workspace, record)
      return publicWorktree(record, workspace)
    }
    if (!record) {
      const { head } = await gitHeadAndRef(workspace)
      record = { id: randomUUID(), workspaceId: workspace_id, requestId: request_id, branch: `chatcode/wt-${randomUUID().replaceAll("-", "")}`, head, status: "creating", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() }
      record.path = await managedWorktreePath(workspace_id, record.id)
      await mutateArray("gitWorktrees", (items) => { items.push(record) })
    }
    const expectedPath = await managedWorktreePath(workspace_id, record.id)
    if (path.win32.resolve(record.path).toLowerCase() !== path.win32.resolve(expectedPath).toLowerCase()) throw new Error("Git worktree journal 路径校验失败")
    const exists = await lstat(record.path).then((stat) => stat.isDirectory() && !stat.isSymbolicLink()).catch((error) => error?.code === "ENOENT" ? false : Promise.reject(error))
    if (!exists) {
      await verifyNoConfiguredGitFilters(workspace)
      const hooksDir = path.join(TMP_DIR, `git-hooks-disabled-${randomUUID()}`)
      await mkdir(hooksDir)
      const hookInfo = await lstat(hooksDir)
      if (!hookInfo.isDirectory() || hookInfo.isSymbolicLink() || (process.platform === "win32" && (Number(hookInfo.attributes ?? 0) & 0x400) !== 0)) throw new Error("受控 hooks-disabled 目录无效")
      if ((await readdir(hooksDir)).length !== 0) throw new Error("受控 hooks-disabled 目录必须为空")
      await runGit(workspace, ["-c", `core.hooksPath=${hooksDir}`, "worktree", "add", "-b", record.branch, record.path, record.head], 256 * 1024)
    }
    await verifyManagedWorktree(workspace, record)
    record.status = "ready"
    record.updatedAt = new Date().toISOString()
    await mutateArray("gitWorktrees", (items) => {
      const index = items.findIndex((item) => item.id === record.id)
      if (index >= 0) items[index] = record
      else items.push(record)
    })
    await invalidateWorkspaceLsp(workspace_id)
    await audit("git_worktree_created", { workspaceId: workspace_id, itemId: record.id, result: record.branch })
    return publicWorktree(record, workspace)
  })
}

function publicWorktree(record, workspace) {
  let relative = null
  const candidate = path.relative(workspace.root, record.path)
  if (candidate && !candidate.startsWith(`..${path.sep}`) && candidate !== ".." && !path.isAbsolute(candidate)) relative = candidate.split(path.sep).join("/")
  return { worktree_id: record.id, branch: record.branch, head: record.head, status: record.status, workspace_relative_path: relative, chatcode_managed: true }
}

export async function gitListWorktrees({ workspace_id }) {
  const workspace = await requireGitWriteWorkspace(workspace_id, "list_worktrees")
  const items = (await readArray("gitWorktrees")).filter((item) => item.workspaceId === workspace_id)
  return { worktrees: items.map((item) => publicWorktree(item, workspace)), count: items.length }
}

export async function gitRemoveWorktree({ workspace_id, worktree_id }) {
  const workspace = await requireGitWriteWorkspace(workspace_id, "remove_worktree")
  return withNamedStateLock("git-worktree", async () => {
    const record = (await readArray("gitWorktrees")).find((item) => item.id === worktree_id && item.workspaceId === workspace_id)
    if (!record) throw new Error("只能移除本工作区由 ChatCode 创建并登记的 worktree")
    if (record.status === "removed") return { worktree_id, status: "removed", idempotent: true }
    const expectedPath = await verifyManagedWorktree(workspace, record)
    const status = await runGit(workspace, ["-C", expectedPath, "status", "--porcelain=v1", "--untracked-files=all", "--ignored"])
    if (status.trim()) throw new Error("worktree 含有修改、未跟踪或忽略文件；ChatCode 不会强制移除")
    await runGit(workspace, ["worktree", "remove", "--", expectedPath], 64 * 1024)
    record.status = "removed"
    record.updatedAt = new Date().toISOString()
    await mutateArray("gitWorktrees", (items) => {
      const index = items.findIndex((item) => item.id === worktree_id)
      if (index >= 0) items[index] = record
    })
    await invalidateWorkspaceLsp(workspace_id)
    await audit("git_worktree_removed", { workspaceId: workspace_id, itemId: worktree_id, result: "clean_removed" })
    return { worktree_id, status: "removed", idempotent: false }
  })
}

export async function getGitRuntimeStatus() {
  const runtime = await gitRuntime()
  return runtime.available
    ? { available: true, version: runtime.version, sha256: runtime.sha256 }
    : { available: false, reason: runtime.reason }
}

export async function gitLog({ workspace_id, limit = 20 }) {
  const workspace = await requireWorkspace(workspace_id)
  const count = Math.max(1, Math.min(100, Number(limit) || 20))
  const output = await runGit(workspace, ["log", `-${count}`, "--format=%H%x09%cs%x09%s"])
  return { workspace_id, commits: output.split(/\r?\n/).filter(Boolean).map((line) => {
    const [commit, date, ...subject] = line.split("\t")
    return { commit, date, subject: subject.join("\t").slice(0, 500) }
  }), count }
}

export async function gitBranch({ workspace_id }) {
  const workspace = await requireWorkspace(workspace_id)
  const current = await runGit(workspace, ["branch", "--show-current"]).catch(() => "")
  const output = await runGit(workspace, ["for-each-ref", "--format=%(refname:short)%09%(objectname)", "refs/heads"], 64 * 1024)
  const branches = output.split(/\r?\n/).filter(Boolean).map((line) => {
    const [name, head] = line.split("\t")
    return { name: name.slice(0, 240), head }
  })
  return { workspace_id, current: current.trim() || null, branches: branches.slice(0, 200), truncated: branches.length > 200 }
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
