import { createHash } from "node:crypto"
import { lstat, readFile, readdir, realpath } from "node:fs/promises"
import os from "node:os"
import path from "node:path"

const MAX_SKILLS = 500
const MAX_DEPTH = 10
const MAX_RESOURCES_PER_SKILL = 2_000
const RESOURCE_PAGE_SIZE = 100
const MAX_RESOURCE_BYTES = 512 * 1024
const MAX_INDEX_BYTES = 32 * 1024 * 1024
const SYSTEM_SKILLS_ENABLED = process.env.CHATCODE_ENABLE_CODEX_SYSTEM_SKILLS === "1"
const TEXT_EXTENSIONS = new Set([".md", ".txt", ".yml", ".yaml", ".json", ".toml", ".xml", ".svg", ".css"])
const OMIT_NAME = /(?:^|[._-])(?:env|secret|token|credential|password|cookie|auth|private[-_]?key)(?:$|[._-])/i
const OMIT_FILES = new Set([".codex", ".git", "node_modules", "__pycache__", ".cache", "secrets", "credentials"])
let indexPromise

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex")
}

function isReparse(info) {
  return info.isSymbolicLink() || (process.platform === "win32" && (Number(info.attributes ?? 0) & 0x400) !== 0)
}

function safeResourceName(name) {
  const extension = path.extname(name).toLowerCase()
  return TEXT_EXTENSIONS.has(extension) && !OMIT_NAME.test(name) && !name.startsWith(".")
}

function scalar(value) {
  const trimmed = String(value ?? "").trim()
  if (!trimmed) return ""
  if ((trimmed.startsWith("\"") && trimmed.endsWith("\"")) || (trimmed.startsWith("'") && trimmed.endsWith("'"))) return trimmed.slice(1, -1)
  return trimmed.replace(/\s+#.*$/, "").trim()
}

function frontmatter(markdown) {
  if (!markdown.startsWith("---\n") && !markdown.startsWith("---\r\n")) return { error: "SKILL.md 缺少 YAML frontmatter" }
  const end = markdown.search(/\r?\n---(?:\r?\n|$)/)
  if (end < 0) return { error: "SKILL.md 的 YAML frontmatter 未闭合" }
  const header = markdown.slice(4, end)
  const name = scalar(/^name\s*:\s*(.*?)\s*$/im.exec(header)?.[1])
  const description = scalar(/^description\s*:\s*(.*?)\s*$/im.exec(header)?.[1])
  if (!name || !description) return { error: "SKILL.md 必须包含非空 name 和 description" }
  return { name: name.slice(0, 120), description: description.slice(0, 1_000), bodyOffset: end + (/^\r\n/.test(markdown.slice(end)) ? 3 : 2) }
}

function skillsRootCandidates() {
  const profile = process.env.USERPROFILE || os.homedir()
  const candidates = []
  if (process.env.CODEX_HOME?.trim()) candidates.push({ path: path.join(process.env.CODEX_HOME, "skills"), source: "codex_home" })
  candidates.push({ path: path.join(profile, ".codex", "skills"), source: "user_profile" })
  const seen = new Set()
  return candidates.filter((item) => {
    const key = path.resolve(item.path).toLowerCase()
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

async function plainDirectory(target, rootReal) {
  let info
  try { info = await lstat(target) } catch { return false }
  if (!info.isDirectory() || isReparse(info)) return false
  const actual = await realpath(target)
  const root = path.resolve(rootReal).toLowerCase()
  const resolved = path.resolve(actual).toLowerCase()
  return resolved === root || resolved.startsWith(`${root}${path.sep.toLowerCase()}`)
}

async function inspectSkill(root, skillDirectory, source) {
  const skillRoot = path.join(root.real, skillDirectory.name)
  const result = {
    name: skillDirectory.name.slice(0, 120), description: "", source, sourcePath: skillRoot,
    version: null, sha256: null, status: "invalid", error: null, resources: [],
    resourcesTruncated: false,
  }
  try {
    if (!(await plainDirectory(skillRoot, root.real))) throw new Error("技能目录包含 reparse point 或路径越界")
    const skillFile = path.join(skillRoot, "SKILL.md")
    const skillStat = await lstat(skillFile)
    if (!skillStat.isFile() || isReparse(skillStat) || skillStat.size > MAX_RESOURCE_BYTES) throw new Error("SKILL.md 不是安全的普通文件或超过 512 KiB")
    const skillBytes = await readFile(skillFile)
    const markdown = skillBytes.toString("utf8")
    const meta = frontmatter(markdown)
    if (meta.error) throw new Error(meta.error)
    result.name = meta.name
    result.description = meta.description
    result.sha256 = sha256(skillBytes)
    result.version = /^[0-9]+(?:\.[0-9]+){0,3}(?:[-+][A-Za-z0-9.-]+)?$/.test(scalar(/^version\s*:\s*(.*?)\s*$/im.exec(markdown.slice(0, meta.bodyOffset))?.[1]))
      ? scalar(/^version\s*:\s*(.*?)\s*$/im.exec(markdown.slice(0, meta.bodyOffset))?.[1]) : result.sha256.slice(0, 12)
    result.resources.push({ path: "SKILL.md", sizeBytes: skillBytes.length, sha256: result.sha256 })
    let totalBytes = skillBytes.length
    const stack = [{ directory: skillRoot, relative: "", depth: 0 }]
    while (stack.length && !result.resourcesTruncated) {
      const current = stack.pop()
      if (current.depth >= MAX_DEPTH) continue
      const entries = await readdir(current.directory, { withFileTypes: true })
      for (const entry of entries) {
        if (entry.name === "SKILL.md" || OMIT_FILES.has(entry.name.toLowerCase()) || OMIT_NAME.test(entry.name)) continue
        const absolute = path.join(current.directory, entry.name)
        const relative = current.relative ? `${current.relative}/${entry.name}` : entry.name
        const info = await lstat(absolute).catch(() => null)
        if (!info || isReparse(info)) continue
        if (info.isDirectory()) {
          if (entry.name.startsWith(".")) continue
          stack.push({ directory: absolute, relative, depth: current.depth + 1 })
        } else if (info.isFile() && safeResourceName(entry.name)) {
          if (result.resources.length >= MAX_RESOURCES_PER_SKILL) { result.resourcesTruncated = true; break }
          if (info.size > MAX_RESOURCE_BYTES) continue
          totalBytes += info.size
          if (totalBytes > MAX_INDEX_BYTES) { totalBytes -= info.size; result.resourcesTruncated = true; break }
          const bytes = await readFile(absolute)
          result.resources.push({ path: relative, sizeBytes: bytes.length, sha256: sha256(bytes) })
        }
      }
    }
    result.resources.sort((a, b) => a.path.localeCompare(b.path))
    result.status = "ready"
  } catch (error) {
    result.error = String(error?.message ?? "技能扫描失败").replace(/[\r\n\0]/g, " ").slice(0, 300)
  }
  return result
}

async function buildIndex() {
  let lastError = null
  for (const candidate of skillsRootCandidates()) {
    const absolute = path.resolve(candidate.path)
    let info
    try { info = await lstat(absolute) } catch (error) { lastError = error; continue }
    if (!info.isDirectory() || isReparse(info)) {
      lastError = new Error("Codex Skills 根目录不是普通目录或包含 reparse point")
      continue
    }
    const actual = await realpath(absolute)
    if (path.resolve(actual).toLowerCase() !== absolute.toLowerCase()) {
      lastError = new Error("Codex Skills 根目录最终路径与配置路径不一致")
      continue
    }
    const root = { path: absolute, real: actual }
    const skills = []
    for (const entry of await readdir(root.real, { withFileTypes: true })) {
      if (entry.name === ".system" && !SYSTEM_SKILLS_ENABLED) continue
      if (entry.name.startsWith(".") || !entry.isDirectory()) continue
      if (skills.length >= MAX_SKILLS) break
      const absoluteSkill = path.join(root.real, entry.name)
      const infoSkill = await lstat(absoluteSkill).catch(() => null)
      if (!infoSkill || !infoSkill.isDirectory() || isReparse(infoSkill)) continue
      if (!await plainDirectory(absoluteSkill, root.real)) continue
      const hasSkillFile = await lstat(path.join(absoluteSkill, "SKILL.md")).then((item) => item.isFile()).catch(() => false)
      if (!hasSkillFile) continue
      skills.push(await inspectSkill(root, entry, candidate.source))
    }
    return { root: root.path, source: candidate.source, systemSkillsEnabled: SYSTEM_SKILLS_ENABLED, refreshedAt: new Date().toISOString(), skills }
  }
  return {
    root: null, source: null, systemSkillsEnabled: SYSTEM_SKILLS_ENABLED,
    refreshedAt: new Date().toISOString(), skills: [],
    error: lastError?.code === "ENOENT" ? "未找到 Codex Skills 目录" : String(lastError?.message ?? "无法安全访问 Codex Skills 目录").slice(0, 300),
  }
}

export async function refreshSkills() {
  indexPromise = buildIndex()
  await indexPromise
  return listSkills()
}

async function currentIndex() {
  if (!indexPromise) indexPromise = buildIndex()
  return indexPromise
}

export async function listSkills() {
  const index = await currentIndex()
  return {
    source: index.source, system_skills_enabled: index.systemSkillsEnabled,
    refreshed_at: index.refreshedAt, error: index.error ?? null,
    skills: index.skills.map(({ name, description, source, version, sha256: digest, status, error, resources }) => ({
      name, description, source, version, sha256: digest, status, error,
      resource_count: resources.length, resources_truncated: index.skills.find((item) => item.name === name)?.resourcesTruncated === true,
      resources: resources.slice(0, RESOURCE_PAGE_SIZE).map(({ path: resourcePath, sizeBytes, sha256: resourceHash }) => ({ path: resourcePath, size_bytes: sizeBytes, sha256: resourceHash })),
    })),
  }
}

export async function getSkill({ skill_name, offset = 0, limit = RESOURCE_PAGE_SIZE }) {
  const index = await currentIndex()
  const skill = index.skills.find((item) => item.name.toLowerCase() === String(skill_name).toLowerCase())
  if (!skill) throw new Error("找不到此 Codex Skill")
  return {
    name: skill.name, description: skill.description, source: skill.source, version: skill.version,
    sha256: skill.sha256, status: skill.status, error: skill.error,
    resource_count: skill.resources.length, resources_truncated: skill.resourcesTruncated,
    resource_offset: Math.max(0, Math.min(skill.resources.length, Math.trunc(offset))),
    resources: skill.resources.slice(Math.max(0, Math.min(skill.resources.length, Math.trunc(offset))), Math.max(0, Math.min(skill.resources.length, Math.trunc(offset))) + Math.max(1, Math.min(RESOURCE_PAGE_SIZE, Math.trunc(limit)))).map(({ path: resourcePath, sizeBytes, sha256: digest }) => ({ path: resourcePath, size_bytes: sizeBytes, sha256: digest })),
    next_resource_offset: Math.max(0, Math.min(skill.resources.length, Math.trunc(offset))) + Math.max(1, Math.min(RESOURCE_PAGE_SIZE, Math.trunc(limit))) < skill.resources.length
      ? Math.max(0, Math.min(skill.resources.length, Math.trunc(offset))) + Math.max(1, Math.min(RESOURCE_PAGE_SIZE, Math.trunc(limit))) : null,
  }
}

export async function readSkillResource({ skill_name, resource_path, offset = 0, limit = 32_000 }) {
  const index = await currentIndex()
  const skill = index.skills.find((item) => item.name.toLowerCase() === String(skill_name).toLowerCase())
  if (!skill || skill.status !== "ready") throw new Error("Skill 不存在或当前状态不可读取")
  const requested = String(resource_path ?? "").replace(/\\/g, "/")
  const entry = skill.resources.find((item) => item.path === requested)
  if (!entry) throw new Error("资源不在该 Skill 的安全资源清单中")
  const target = path.resolve(skill.sourcePath, ...requested.split("/"))
  const relative = path.relative(skill.sourcePath, target)
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) throw new Error("Skill 资源路径越界")
  const rootInfo = await lstat(skill.sourcePath)
  if (!rootInfo.isDirectory() || isReparse(rootInfo) || path.resolve(await realpath(skill.sourcePath)).toLowerCase() !== path.resolve(skill.sourcePath).toLowerCase()) {
    throw new Error("Skill 根目录已变为 reparse point 或路径越界")
  }
  let cursor = skill.sourcePath
  for (const component of relative.split(path.sep)) {
    cursor = path.join(cursor, component)
    const componentInfo = await lstat(cursor)
    if (isReparse(componentInfo)) throw new Error("Skill 资源路径包含 reparse point")
  }
  const info = await lstat(target)
  if (!info.isFile() || info.size > MAX_RESOURCE_BYTES || path.resolve(await realpath(target)).toLowerCase() !== path.resolve(target).toLowerCase()) throw new Error("Skill 资源已失效或不再是安全的普通文件")
  const bytes = await readFile(target)
  const digest = sha256(bytes)
  if (digest !== entry.sha256) throw new Error("Skill 资源在扫描后已变化；请先调用 refresh_skills")
  const text = bytes.toString("utf8")
  const start = Math.max(0, Math.min(text.length, Math.trunc(Number(offset) || 0)))
  const size = Math.max(1, Math.min(64_000, Math.trunc(Number(limit) || 32_000)))
  const content = text.slice(start, start + size)
  const next = start + content.length
  const redacted = content
    .replace(/(authorization\s*[:=]\s*bearer\s+)[^\s"']+/gi, "$1[REDACTED]")
    .replace(/\b(?:sk-[A-Za-z0-9_-]{12,}|gh[pousr]_[A-Za-z0-9_]{12,})\b/g, "[REDACTED]")
    .replace(/(["']?(?:api[_-]?key|access[_-]?token|token|password|secret|credential|client_secret)["']?\s*[:=]\s*["']?)[^\s,;"'}]+/gi, "$1[REDACTED]")
  return { skill_name: skill.name, resource_path: requested, sha256: digest, offset: start, next_offset: next < text.length ? next : null, eof: next >= text.length, content: redacted }
}
