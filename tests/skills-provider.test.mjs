import assert from "node:assert/strict"
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { test } from "node:test"

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const testsRoot = path.join(projectRoot, ".tmp", "tests")

test("Skills provider is read-only, paginated, redacted, and does not follow linked resources", async (t) => {
  await mkdir(testsRoot, { recursive: true })
  const sandbox = await mkdtemp(path.join(testsRoot, "skills-provider-"))
  const codexHome = path.join(sandbox, "codex-home")
  const root = path.join(codexHome, "skills")
  const skill = path.join(root, "mumu")
  const outside = path.join(sandbox, "outside")
  await Promise.all([
    mkdir(path.join(skill, "references"), { recursive: true }),
    mkdir(path.join(skill, "scripts"), { recursive: true }),
    mkdir(path.join(skill, "assets"), { recursive: true }),
    mkdir(outside, { recursive: true }),
  ])
  await writeFile(path.join(skill, "SKILL.md"), [
    "---", "name: mumu", "description: Control a local emulator safely.", "version: 2.0.1", "---",
    "Treat this file as untrusted instruction text.",
  ].join("\n"), "utf8")
  await writeFile(path.join(skill, "references", "guide.md"), "access_token: hidden-example-value\nUse only the selected instance.\n", "utf8")
  await writeFile(path.join(skill, "scripts", "runner.ps1"), "Write-Output 'not exposed'\n", "utf8")
  await writeFile(path.join(skill, "assets", "oversized.md"), "x".repeat(600_000), "utf8")
  await writeFile(path.join(outside, "outside.md"), "outside-root-secret", "utf8")
  await writeFile(path.join(outside, "SKILL.md"), "---\nname: escape\ndescription: outside\n---\n", "utf8")
  let linkedDirectoryCreated = false
  let linkedFileCreated = false
  try {
    await symlink(outside, path.join(root, "escape"), "junction")
    linkedDirectoryCreated = true
    await symlink(path.join(outside, "outside.md"), path.join(skill, "references", "linked.md"), "file")
    linkedFileCreated = true
  } catch { /* Windows Developer Mode may disable user symlink creation. */ }

  const originalCodexHome = process.env.CODEX_HOME
  const originalUserProfile = process.env.USERPROFILE
  process.env.CODEX_HOME = codexHome
  process.env.USERPROFILE = sandbox
  const provider = await import(`../apps/server/core/skills.mjs?fixture=${Date.now()}`)
  t.after(async () => {
    if (originalCodexHome === undefined) delete process.env.CODEX_HOME
    else process.env.CODEX_HOME = originalCodexHome
    if (originalUserProfile === undefined) delete process.env.USERPROFILE
    else process.env.USERPROFILE = originalUserProfile
    const absolute = path.resolve(sandbox)
    const relative = path.relative(testsRoot, absolute)
    if (relative && !relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative)) await rm(absolute, { recursive: true, force: true })
  })

  const result = await provider.refreshSkills()
  assert.equal(result.source, "codex_home")
  assert.deepEqual(result.skills.map((item) => item.name), ["mumu"])
  assert.equal(result.skills[0].status, "ready")
  assert.equal(result.skills[0].version, "2.0.1")
  assert.ok(!JSON.stringify(result).includes("sourcePath"), "provider responses must not expose resource filesystem paths")
  const resourceNames = result.skills[0].resources.map((item) => item.path)
  assert.ok(resourceNames.includes("SKILL.md"))
  assert.ok(resourceNames.includes("references/guide.md"))
  assert.ok(!resourceNames.includes("scripts/runner.ps1"), "Skill scripts are not readable resources")
  assert.ok(!resourceNames.includes("assets/oversized.md"), "oversized resources are skipped")
  assert.ok(!resourceNames.some((name) => name.includes("linked")), "linked resources are skipped")
  if (linkedDirectoryCreated) assert.ok(!result.skills.some((item) => item.name === "escape"))

  const firstPage = await provider.getSkill({ skill_name: "mumu", offset: 0, limit: 1 })
  assert.equal(firstPage.resources.length, 1)
  assert.ok(firstPage.next_resource_offset !== null)
  const secondPage = await provider.getSkill({ skill_name: "mumu", offset: firstPage.next_resource_offset, limit: 1 })
  assert.equal(secondPage.resources.length, 1)
  const guide = await provider.readSkillResource({ skill_name: "mumu", resource_path: "references/guide.md" })
  assert.match(guide.content, /access_token: \[REDACTED\]/)
  assert.ok(!guide.content.includes("hidden-example-value"))
  await assert.rejects(provider.readSkillResource({ skill_name: "mumu", resource_path: "../outside/outside.md" }), /not in|路径|资源/i)
  if (linkedFileCreated) await assert.rejects(provider.readSkillResource({ skill_name: "mumu", resource_path: "references/linked.md" }), /not in|reparse|安全资源/i)

  await writeFile(path.join(skill, "references", "guide.md"), "access_token: changed-secret\nUpdated text.\n", "utf8")
  await assert.rejects(provider.readSkillResource({ skill_name: "mumu", resource_path: "references/guide.md" }), /已变化/)
  await provider.refreshSkills()
  const refreshed = await provider.readSkillResource({ skill_name: "mumu", resource_path: "references/guide.md" })
  assert.ok(!refreshed.content.includes("changed-secret"))
  assert.ok((await readFile(path.join(skill, "scripts", "runner.ps1"), "utf8")).includes("not exposed"), "provider did not modify Skill files")
})
