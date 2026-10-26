import { createHash, randomUUID } from "node:crypto"
import { createReadStream } from "node:fs"
import { copyFile, lstat, readFile, readdir, realpath, rm, stat } from "node:fs/promises"
import { constants as fsConstants } from "node:fs"
import { execFile as execFileCallback, spawn } from "node:child_process"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { promisify } from "node:util"
import { setTimeout as delay } from "node:timers/promises"
import { audit } from "./audit.mjs"
import { CHATCODE_HOME, DATA_DIR, TMP_DIR } from "./config.mjs"
import { createDirectory, fileExists, fileInfo, hashFile, listDirectory, readFileBytes, writeStagedFile } from "./safe-fs.mjs"
import { hasBlockedExplicitDirectory, isPathWithin, normalizeRelative } from "./paths.mjs"
import { assertRegularFile, mutateArray, readArray } from "./state.mjs"
import { getUnattendedDevGrant, requireWorkspace } from "./workspaces.mjs"
import { finishTask, getTask, launchApprovedProcess, linkAgentJob } from "./tasks.mjs"

const execFileAsync = promisify(execFileCallback)
const APPROVED_BUILD_TASKS = new Set(["assembleDebug", "testDebugUnitTest", "lintDebug"])
const PREFERRED_AGP = "8.13.2"
const PREFERRED_GRADLE = "8.13"
const PREFERRED_COMPILE_SDK = "36"
const MAX_FINGERPRINT_FILES = 5_000
const MAX_FINGERPRINT_BYTES = 250 * 1024 * 1024
const systemRoot = process.env.SystemRoot ?? "C:\\Windows"
const ANDROID_WORKER = fileURLToPath(new URL("./android-worker.mjs", import.meta.url))

function isReparse(info) {
  return info.isSymbolicLink() || (process.platform === "win32" && (Number(info.attributes ?? 0) & 0x400) !== 0)
}

async function plainPath(candidate, wantDirectory = null) {
  const absolute = path.win32.resolve(candidate)
  const root = path.win32.parse(absolute).root
  const components = absolute.slice(root.length).split(/[\\/]+/).filter(Boolean)
  let current = root
  for (const component of components) {
    current = path.win32.join(current, component)
    const info = await lstat(current)
    if (isReparse(info)) throw new Error("Android 工具链路径包含符号链接或 reparse point")
    if (info.isFile() && Number(info.nlink ?? 1) > 1) throw new Error("Android 工具链文件包含硬链接")
  }
  const finalPath = await realpath(absolute)
  if (path.win32.resolve(finalPath).toLowerCase() !== absolute.toLowerCase()) throw new Error("Android 工具链路径的最终位置发生变化")
  const finalInfo = await stat(absolute)
  if (wantDirectory === true && !finalInfo.isDirectory()) throw new Error("Android 工具链目录无效")
  if (wantDirectory === false && !finalInfo.isFile()) throw new Error("Android 工具文件无效")
  return absolute
}

async function exists(candidate, wantDirectory = null) {
  try { await plainPath(candidate, wantDirectory); return true } catch { return false }
}

async function runVersion(executable, args) {
  try {
    const result = await execFileAsync(executable, args, { windowsHide: true, timeout: 8_000, maxBuffer: 16_384 })
    return `${result.stdout ?? ""}\n${result.stderr ?? ""}`.trim()
  } catch (error) {
    return `${error.stdout ?? ""}\n${error.stderr ?? ""}`.trim()
  }
}

function javaMajor(versionText) {
  const match = /version\s+["']?(?:1\.)?(\d+)/i.exec(versionText)
  return match ? Number(match[1]) : null
}

async function findJavaHomes() {
  const candidates = new Set()
  for (const candidate of [process.env.JAVA_HOME, process.env.JDK_HOME,
    "D:\\Program Files\\Android\\Android Studio\\jbr"]) {
    if (candidate) candidates.add(path.win32.resolve(candidate))
  }
  for (const base of ["C:\\Program Files\\Eclipse Adoptium", "C:\\Program Files\\Java", "D:\\Program Files\\Java"]) {
    try {
      for (const name of await readdir(base)) {
        if (/^(?:jdk|jre)-?\d|^jdk/i.test(name)) candidates.add(path.win32.join(base, name))
      }
    } catch { /* optional JDK vendor directory */ }
  }
  const found = []
  for (const home of candidates) {
    const java = path.win32.join(home, "bin", "java.exe")
    const javac = path.win32.join(home, "bin", "javac.exe")
    if (!(await exists(java, false)) || !(await exists(javac, false))) continue
    const versionText = await runVersion(java, ["-version"])
    found.push({ home, java, javac, version: versionText.match(/version\s+["']([^"']+)/i)?.[1] ?? "unknown", major: javaMajor(versionText) })
  }
  found.sort((a, b) => {
    const rank = (value) => value === 17 ? 0 : (value ?? 0) >= 17 ? 1 : 2
    return rank(a.major) - rank(b.major) || (b.major ?? 0) - (a.major ?? 0)
  })
  return found
}

function semverSort(values) {
  return [...values].sort((a, b) => b.localeCompare(a, undefined, { numeric: true, sensitivity: "base" }))
}

function versionAtLeast(actual, minimum) {
  const left = String(actual).split(".").map((part) => Number.parseInt(part, 10) || 0)
  const right = String(minimum).split(".").map((part) => Number.parseInt(part, 10) || 0)
  for (let index = 0; index < Math.max(left.length, right.length); index++) {
    if ((left[index] ?? 0) !== (right[index] ?? 0)) return (left[index] ?? 0) > (right[index] ?? 0)
  }
  return true
}

function minimumGradleForAgp(version) {
  const match = /^(\d+)\.(\d+)/.exec(String(version ?? ""))
  if (!match) return null
  const major = Number(match[1])
  const minor = Number(match[2])
  if (major === 8) {
    if (minor >= 11) return "8.13"
    if (minor >= 9) return "8.11.1"
    if (minor === 8) return "8.10.2"
    if ([6, 7].includes(minor)) return "8.9"
    if ([4, 5].includes(minor)) return "8.7"
    if (minor === 3) return "8.4"
    if (minor === 2) return "8.2"
    if (minor === 1) return "8.0"
    if (minor === 0) return "8.0"
  }
  return null
}

async function findAndroidSdk() {
  const candidates = [...new Set([process.env.ANDROID_HOME, process.env.ANDROID_SDK_ROOT,
    process.env.LOCALAPPDATA ? path.win32.join(process.env.LOCALAPPDATA, "Android", "Sdk") : null].filter(Boolean))]
  for (const candidate of candidates) {
    if (!(await exists(candidate, true))) continue
    const root = path.win32.resolve(candidate)
    let platforms = []
    let buildTools = []
    try { platforms = semverSort((await readdir(path.win32.join(root, "platforms"))).filter((name) => /^android-\d+(?:\.\d+)?$/.test(name))) } catch { /* unavailable */ }
    try { buildTools = semverSort((await readdir(path.win32.join(root, "build-tools"))).filter((name) => /^\d+\.\d+\.\d+$/.test(name))) } catch { /* unavailable */ }
    const licensePath = path.win32.join(root, "licenses", "android-sdk-license")
    let licenseAccepted = false
    try { licenseAccepted = (await readFile(licensePath, "utf8")).trim().length > 0 } catch { /* license not present */ }
    let buildToolsVersion = buildTools[0] ?? null
    let selectedTools = null
    for (const candidate of buildTools) {
      const candidateRoot = path.win32.join(root, "build-tools", candidate)
      const tool = async (name) => exists(path.win32.join(candidateRoot, name), false)
      const candidateTools = {
        aapt: await tool("aapt.exe"), aapt2: await tool("aapt2.exe"),
        apksigner: await tool("lib\\apksigner.jar"), apkanalyzer: await tool("apkanalyzer.bat"),
      }
      if (!selectedTools) selectedTools = candidateTools
      if (candidateTools.aapt && candidateTools.apksigner) {
        buildToolsVersion = candidate
        selectedTools = candidateTools
        break
      }
    }
    return {
      root, source: candidate === process.env.ANDROID_HOME ? "ANDROID_HOME" : candidate === process.env.ANDROID_SDK_ROOT ? "ANDROID_SDK_ROOT" : "LOCALAPPDATA",
      platforms, hasCompileSdk36: platforms.includes("android-36"), build_tools: buildTools,
      selected_build_tools: buildToolsVersion,
      license_accepted: licenseAccepted,
      tools: selectedTools ?? { aapt: false, aapt2: false, apksigner: false, apkanalyzer: false },
    }
  }
  return null
}

async function projectLocation(workspace, rawPath) {
  const projectPath = normalizeRelative(rawPath)
  if (hasBlockedExplicitDirectory(projectPath)) throw new Error("Android project_path 不能进入内部或生成目录")
  const root = path.win32.resolve(workspace.root)
  const absolute = path.win32.resolve(root, ...projectPath.split("/"))
  if (!isPathWithin(root, absolute)) throw new Error("Android project_path 超出授权工作区")
  const info = await fileInfo(workspace.root, projectPath)
  if (!info.isDirectory) throw new Error("Android project_path 必须指向工作区内的目录")
  return { projectPath, absolute }
}

async function wrapperMetadata(workspace, projectPath) {
  const propertiesPath = `${projectPath}/gradle/wrapper/gradle-wrapper.properties`
  let propertiesText = ""
  let wrapperJar = null
  let wrapperBatch = null
  try { propertiesText = (await readFileBytes(workspace.root, propertiesPath, 32_768)).toString("utf8") } catch { /* wrapper absent */ }
  if (propertiesText) {
    const unescaped = propertiesText.replace(/\\([:=#!])/g, "$1")
    const distributionUrl = /^\s*distributionUrl\s*=\s*(\S+)\s*$/m.exec(unescaped)?.[1] ?? null
    const match = /^https:\/\/services\.gradle\.org\/distributions\/gradle-(\d+(?:\.\d+){1,2}(?:-[A-Za-z0-9.]+)?)-(?:bin|all)\.zip$/i.exec(distributionUrl ?? "")
    if (distributionUrl && !match) throw new Error("Gradle Wrapper 只允许 services.gradle.org 的固定 distribution zip")
    if (match) {
      const jarPath = `${projectPath}/gradle/wrapper/gradle-wrapper.jar`
      const batchPath = `${projectPath}/gradlew.bat`
      try { wrapperJar = { path: jarPath, ...await hashFile(workspace.root, jarPath) } } catch { /* wrapper jar absent */ }
      try { wrapperBatch = { path: batchPath, ...await hashFile(workspace.root, batchPath) } } catch { /* wrapper batch absent */ }
      return { distributionUrl, version: match[1], jar: wrapperJar, batch: wrapperBatch }
    }
  }
  return { distributionUrl: null, version: null, jar: wrapperJar, batch: wrapperBatch }
}

async function cachedGradleDistribution(version) {
  const userProfile = process.env.USERPROFILE
  if (!userProfile || !version) return null
  const wrapperRoot = path.win32.join(userProfile, ".gradle", "wrapper", "dists")
  let distFolders
  try { distFolders = await readdir(wrapperRoot) } catch { return null }
  for (const distribution of distFolders) {
    if (distribution.toLowerCase() !== `gradle-${version}-bin`.toLowerCase() && distribution.toLowerCase() !== `gradle-${version}-all`.toLowerCase()) continue
    const hashes = path.win32.join(wrapperRoot, distribution)
    for (const hashDir of await readdir(hashes).catch(() => [])) {
      const base = path.win32.join(hashes, hashDir)
      const expectedZip = path.win32.join(base, `${distribution}.zip`)
      const okFile = `${expectedZip}.ok`
      const gradleHome = path.win32.join(base, `gradle-${version}`)
      const launcherJar = path.win32.join(gradleHome, "lib", `gradle-launcher-${version}.jar`)
      if (await exists(okFile, false) && await exists(launcherJar, false)) {
        const binary = path.win32.join(gradleHome, "bin", "gradle.bat")
        if (await exists(binary, false)) return { version, distribution, hash_dir: hashDir, gradle_home: gradleHome, launcher_jar: launcherJar, binary }
      }
    }
  }
  return null
}

async function cachedPlugin(home, group, artifact, version, { profileRoot = true } = {}) {
  if (!home) return false
  const gradleHome = profileRoot ? path.win32.join(home, ".gradle") : home
  const directory = path.win32.join(gradleHome, "caches", "modules-2", "files-2.1", group, artifact, version)
  return exists(directory, true)
}

async function scanGradleProject(workspace, projectPath) {
  const stack = [projectPath]
  const files = []
  let bytes = 0
  const skipped = new Set([".tmp", ".git", "node_modules", "build", ".gradle", ".kotlin"])
  while (stack.length) {
    const directory = stack.pop()
    let cursor = ""
    do {
      const listing = await listDirectory(workspace.root, directory, { limit: 500, cursor })
      for (const entry of listing.entries) {
        const relative = `${directory}/${entry.name}`
        if (entry.blocked) throw new Error(`Gradle 项目包含不可安全访问的链接路径：${relative}`)
        if (entry.isDirectory) {
          if (!skipped.has(entry.name.toLowerCase())) stack.push(relative)
        } else if (/\.gradle(?:\.kts)?$/i.test(entry.name) || entry.name.toLowerCase() === "libs.versions.toml") {
          if (files.length >= 200) throw new Error("Gradle 配置文件数量超过安全扫描上限")
          const body = await readFileBytes(workspace.root, relative, 256 * 1024)
          bytes += body.length
          if (bytes > 2 * 1024 * 1024) throw new Error("Gradle 配置文本超过安全扫描上限")
          files.push({ path: relative, text: body.toString("utf8") })
        }
      }
      cursor = listing.nextCursor ?? ""
    } while (cursor)
  }

  const allText = files.map((file) => file.text).join("\n")
  const agpVersion = /(?:com\.android\.tools\.build:gradle:|id\s*\(?\s*["']com\.android\.(?:application|library|test|dynamic-feature)["']\s*\)?\s+version\s+["'])([0-9][A-Za-z0-9.+_-]*)/i.exec(allText)?.[1] ?? null
  const kotlinVersion = /(?:org\.jetbrains\.kotlin\.(?:android|jvm|multiplatform)["']\s*\)?\s+version\s+["']|kotlin\s*\(\s*["'](?:android|jvm)["']\s*\)\s+version\s+["'])([0-9][A-Za-z0-9.+_-]*)/i.exec(allText)?.[1] ?? null
  const repositories = new Set()
  if (/\bgoogle\s*\(\s*\)/i.test(allText)) repositories.add("google()")
  if (/\bmavenCentral\s*\(\s*\)/i.test(allText)) repositories.add("mavenCentral()")
  if (/\bgradlePluginPortal\s*\(\s*\)/i.test(allText)) repositories.add("gradlePluginPortal()")
  const allowedHosts = new Set(["dl.google.com", "maven.google.com", "repo.maven.apache.org", "repo1.maven.org", "plugins.gradle.org"])
  const unknownRepositories = new Set()
  for (const match of allText.matchAll(/https?:\/\/[^\s"'<>)}]+/gi)) {
    try {
      const url = new URL(match[0].replace(/[),;]+$/, ""))
      repositories.add(url.origin)
      if (!allowedHosts.has(url.hostname.toLowerCase())) unknownRepositories.add(url.hostname.toLowerCase())
    } catch { /* invalid URL text is diagnosed by Gradle itself */ }
  }
  return {
    agp_version: agpVersion, kotlin_version: kotlinVersion,
    configured_repositories: [...repositories].sort(),
    unapproved_repository_hosts: [...unknownRepositories].sort(),
    scanned_files: files.map((file) => file.path).sort(),
  }
}

async function androidEnvironment(workspace, projectPath) {
  const sdk = await findAndroidSdk()
  const java = await findJavaHomes()
  const selectedJava = java.find((candidate) => candidate.major === 17) ?? java.find((candidate) => (candidate.major ?? 0) >= 17) ?? null
  const wrapper = await wrapperMetadata(workspace, projectPath)
  const gradleVersion = wrapper.version ?? PREFERRED_GRADLE
  const buildConfig = await scanGradleProject(workspace, projectPath)
  const agpVersion = buildConfig.agp_version ?? PREFERRED_AGP
  const kotlinVersion = buildConfig.kotlin_version ?? "2.2.10"
  const cached = await cachedGradleDistribution(gradleVersion)
  const profile = process.env.USERPROFILE
  const projectRoot = path.win32.resolve(workspace.root, ...projectPath.split("/"))
  const isolatedGradleHome = path.win32.join(projectRoot, ".tmp", "gradle-user-home")
  const sharedPlugins = {
    agp: await cachedPlugin(profile, "com.android.tools.build", "gradle", agpVersion),
    kotlin_android_marker: await cachedPlugin(profile, "org.jetbrains.kotlin.android", "org.jetbrains.kotlin.android.gradle.plugin", kotlinVersion),
    kotlin_android_implementation: await cachedPlugin(profile, "org.jetbrains.kotlin", "kotlin-gradle-plugin", kotlinVersion),
    compose_material3: await cachedPlugin(profile, "androidx.compose.material3", "material3", "1.4.0"),
  }
  const isolatedPlugins = {
    agp: await cachedPlugin(isolatedGradleHome, "com.android.tools.build", "gradle", agpVersion, { profileRoot: false }),
    kotlin_android_marker: await cachedPlugin(isolatedGradleHome, "org.jetbrains.kotlin.android", "org.jetbrains.kotlin.android.gradle.plugin", kotlinVersion, { profileRoot: false }),
    kotlin_android_implementation: await cachedPlugin(isolatedGradleHome, "org.jetbrains.kotlin", "kotlin-gradle-plugin", kotlinVersion, { profileRoot: false }),
    compose_material3: await cachedPlugin(isolatedGradleHome, "androidx.compose.material3", "material3", "1.4.0", { profileRoot: false }),
  }
  const diagnostics = []
  if (!sdk) diagnostics.push({ code: "android_sdk_missing", severity: "error", message: "未找到 Android SDK" })
  else {
    if (!sdk.hasCompileSdk36) diagnostics.push({ code: "compile_sdk_missing", severity: "error", message: "缺少 Android SDK Platform 36" })
    if (!sdk.license_accepted) diagnostics.push({ code: "android_license_missing", severity: "error", message: "Android SDK license 未接受或 license 文件为空" })
    if (!sdk.selected_build_tools) diagnostics.push({ code: "build_tools_missing", severity: "error", message: "未找到 Android SDK Build Tools" })
    else if (!sdk.tools.aapt || !sdk.tools.apksigner) diagnostics.push({ code: "build_tools_incomplete", severity: "error", message: "所选 Build Tools 缺少 aapt 或 apksigner" })
  }
  if (!selectedJava) diagnostics.push({ code: "jdk_17_missing", severity: "error", message: "AGP 8.x 需要 JDK 17 或更高版本；当前未找到兼容 JDK" })
  else if (java.some((candidate) => candidate.major < 17)) diagnostics.push({ code: "path_java_conflict", severity: "info", message: "PATH 上可能有旧版 Java；Android runner 会显式使用兼容的 JDK_HOME" })
  if (!cached && !wrapper.jar) diagnostics.push({ code: "gradle_runner_missing", severity: "error", message: "没有可复用的 Gradle distribution，也没有完整 Gradle Wrapper" })
  if (!isolatedPlugins.agp) diagnostics.push({ code: "agp_not_cached_in_isolated_home", severity: "info", message: `AGP ${agpVersion} 不在项目隔离缓存中；即使共享用户缓存有副本，本次构建也可能需要从批准仓库下载` })
  if (sharedPlugins.agp && !isolatedPlugins.agp) diagnostics.push({ code: "shared_agp_cache_not_seeded", severity: "info", message: "共享 Gradle 缓存包含 AGP，但为避免修改或迁移用户缓存，本次不会把它连接到项目构建；隔离缓存需要下载依赖" })
  const minimumGradle = minimumGradleForAgp(agpVersion)
  if (minimumGradle && !versionAtLeast(gradleVersion, minimumGradle)) {
    diagnostics.push({ code: "gradle_agp_incompatible", severity: "error", message: `检测到 AGP ${agpVersion}，至少需要 Gradle ${minimumGradle}；当前 Wrapper 版本为 ${gradleVersion}` })
  }
  if (buildConfig.unapproved_repository_hosts.length) diagnostics.push({
    code: "unapproved_repository", severity: "error",
    message: `Gradle 配置静态声明了未列入批准预览的仓库主机：${buildConfig.unapproved_repository_hosts.join(", ")}`,
  })
  if (!isolatedPlugins.compose_material3) diagnostics.push({ code: "compose_not_cached", severity: "info", message: "Compose Material3 不在项目隔离缓存中；可用 Android SDK 原生 Views 避免 Compose 依赖下载" })

  const runner = cached
    ? { mode: "cached_distribution", version: cached.version, gradle_home: cached.gradle_home, launcher_jar: cached.launcher_jar }
    : wrapper.jar ? { mode: "gradle_wrapper", version: wrapper.version, wrapper_jar: wrapper.jar.path } : null
  return {
    workspace_id: workspace.id,
    project_path: projectPath,
    android_sdk: sdk,
    java: { selected: selectedJava, candidates: java.map(({ home, version, major }) => ({ home, version, major })) },
    gradle: { wrapper, cached_distribution: cached, selected_runner: runner },
    project_plugins: { agp: buildConfig.agp_version, kotlin: buildConfig.kotlin_version },
    configured_repositories: buildConfig.configured_repositories,
    repository_scan: { files: buildConfig.scanned_files, unapproved_hosts: buildConfig.unapproved_repository_hosts },
    cached_plugins: { shared_user_home: sharedPlugins, isolated_project_home: isolatedPlugins },
    compatibility: { agp: agpVersion, minimum_gradle: minimumGradle, selected_compile_sdk: PREFERRED_COMPILE_SDK, minimum_jdk: 17 },
    diagnostics,
    build_scripts_run_as_current_user: true,
    local_approval_required: true,
  }
}

export async function getAndroidEnvironment({ workspace_id, project_path }) {
  const workspace = await requireWorkspace(workspace_id)
  const project = await projectLocation(workspace, project_path)
  return androidEnvironment(workspace, project.projectPath)
}

async function buildFingerprint(root, projectPath) {
  const pending = [projectPath]
  const rows = []
  let totalBytes = 0
  while (pending.length) {
    const directory = pending.pop()
    let cursor = ""
    do {
      const listing = await listDirectory(root, directory, { limit: 500, cursor })
      for (const entry of listing.entries) {
        if (entry.blocked) throw new Error(`Gradle project 包含不可安全访问的链接路径：${directory}/${entry.name}`)
        const relative = `${directory}/${entry.name}`
        if (entry.isDirectory) {
          if ([".tmp", ".git", "node_modules", "build", ".gradle", ".kotlin"].includes(entry.name.toLowerCase())) continue
          pending.push(relative)
          continue
        }
        totalBytes += Number(entry.size ?? 0)
        if (rows.length >= MAX_FINGERPRINT_FILES || totalBytes > MAX_FINGERPRINT_BYTES) throw new Error("Gradle project 的输入清单超过安全扫描上限")
        const digest = await hashFile(root, relative)
        rows.push([relative, digest.sha256, digest.sizeBytes])
      }
      cursor = listing.nextCursor ?? ""
    } while (cursor)
  }
  rows.sort((a, b) => a[0].localeCompare(b[0]))
  return { sha256: createHash("sha256").update(JSON.stringify(rows)).digest("hex"), files: rows.length, bytes: totalBytes }
}

async function executionPlan(workspace, projectPath, buildTask) {
  const environment = await androidEnvironment(workspace, projectPath)
  const errors = environment.diagnostics.filter((item) => item.severity === "error")
  if (errors.length) throw Object.assign(new Error(errors.map((item) => item.message).join("；")), { diagnostics: errors })
  const projectRoot = path.win32.resolve(workspace.root, ...projectPath.split("/"))
  const sdk = environment.android_sdk
  const java = environment.java.selected
  const gradle = environment.gradle.selected_runner
  if (!gradle) throw new Error("没有可用的 Gradle runner")
  const tempRoot = path.win32.join(projectRoot, ".tmp")
  const gradleUserHome = path.win32.join(tempRoot, "gradle-user-home")
  const projectCache = path.win32.join(tempRoot, "gradle-project-cache")
  let executable = java.java
  let args
  let gradleDistributionUrl = environment.gradle.wrapper.distributionUrl
  let javaHash
  let runnerHash
  if (gradle.mode === "cached_distribution") {
    javaHash = await sha256File(executable)
    runnerHash = await sha256File(gradle.launcher_jar)
    args = ["-Xmx256m", "-classpath", gradle.launcher_jar, "org.gradle.launcher.GradleMain",
      "--no-daemon", "--console=plain", "--project-cache-dir", projectCache,
      "--gradle-user-home", gradleUserHome, `:app:${buildTask}`]
    gradleDistributionUrl ??= `https://services.gradle.org/distributions/gradle-${gradle.version}-bin.zip`
  } else {
    const jar = gradle.wrapper_jar
    if (!jar) throw new Error("Gradle Wrapper 缺少 gradle-wrapper.jar")
    const wrapperInfo = await fileInfo(workspace.root, jar)
    if (wrapperInfo.isDirectory) throw new Error("Gradle Wrapper jar 路径不是文件")
    javaHash = await sha256File(executable)
    runnerHash = (await hashFile(workspace.root, jar)).sha256
    args = ["-Xmx256m", "-classpath", path.win32.resolve(workspace.root, ...jar.split("/")), "org.gradle.wrapper.GradleWrapperMain",
      "--no-daemon", "--console=plain", "--project-cache-dir", projectCache,
      "--gradle-user-home", gradleUserHome, `:app:${buildTask}`]
  }
  const environmentVars = {
    PATH: [path.win32.join(java.home, "bin"), path.win32.join(sdk.root, "platform-tools"), path.win32.join(systemRoot, "System32")].join(path.delimiter),
    PATHEXT: ".COM;.EXE;.BAT;.CMD",
    SystemRoot: systemRoot,
    WINDIR: systemRoot,
    SystemDrive: process.env.SystemDrive ?? "C:",
    JAVA_HOME: java.home,
    ANDROID_HOME: sdk.root,
    ANDROID_SDK_ROOT: sdk.root,
    ANDROID_USER_HOME: path.win32.join(tempRoot, "android-user-home"),
    GRADLE_USER_HOME: gradleUserHome,
    TEMP: path.win32.join(tempRoot, "temp"),
    TMP: path.win32.join(tempRoot, "temp"),
    USERPROFILE: path.win32.join(tempRoot, "user-profile"),
    APPDATA: path.win32.join(tempRoot, "appdata"),
    LOCALAPPDATA: path.win32.join(tempRoot, "localappdata"),
    CI: "true",
    NO_COLOR: "1",
  }
  const command = [path.basename(executable), ...args].map(quote).join(" ")
  return {
    executable,
    args,
    environment: environmentVars,
    cwd: projectRoot,
    timeoutMs: 30 * 60 * 1000,
    command,
    preview: {
      runner: gradle.mode,
      executable,
      java_sha256: javaHash,
      gradle_runner_sha256: runnerHash,
      arguments: args,
      wrapper_distribution_url: gradleDistributionUrl,
      android_sdk: sdk.root,
      java_home: java.home,
      project_cwd: projectRoot,
      target: `:app:${buildTask}`,
      isolated_gradle_user_home: gradleUserHome,
      project_cache_dir: projectCache,
      expected_apk: path.win32.join(projectRoot, ".tmp", "build", "app", "outputs", "apk", "debug", "app-debug.apk"),
      agp_version: environment.project_plugins.agp ?? PREFERRED_AGP,
      kotlin_version: environment.project_plugins.kotlin,
      configured_dependency_repositories: environment.configured_repositories,
      approved_repository_hosts: ["dl.google.com", "maven.google.com", "repo.maven.apache.org", "repo1.maven.org", "plugins.gradle.org"],
      risk: "Gradle build scripts, wrapper JAR, plugins, and dependencies execute with the Windows ChatCode user's permissions; workspace cwd is not an OS sandbox. Local approval is required.",
    },
    logRelativePath: `${projectPath}/.tmp/logs/android-${buildTask}.log`,
    projectRoot,
    projectPath,
    buildTask,
  }
}

function quote(value) {
  const text = String(value)
  return /[\s"]/.test(text) ? `"${text.replace(/"/g, '\\"')}"` : text
}

async function sha256File(file) {
  await plainPath(file, false)
  return new Promise((resolve, reject) => {
    const hash = createHash("sha256")
    const stream = createReadStream(file)
    stream.on("data", (chunk) => hash.update(chunk))
    stream.once("error", reject)
    stream.once("end", () => resolve(hash.digest("hex")))
  })
}

async function ensureProjectDirectory(root, relative) {
  if (await fileExists(root, relative)) {
    const info = await fileInfo(root, relative)
    if (!info.isDirectory) throw new Error(`Gradle 临时目录路径被非目录占用：${relative}`)
    return
  }
  await createDirectory(root, relative)
  const created = await fileInfo(root, relative)
  if (!created.isDirectory) throw new Error(`无法建立安全目录：${relative}`)
}

async function ensureCleanGradleUserHome(root, relativeHome) {
  const configFiles = ["init.gradle", "init.gradle.kts", "gradle.properties"]
  for (const name of configFiles) {
    if (await fileExists(root, `${relativeHome}/${name}`)) throw new Error(`隔离 Gradle User Home 已包含用户配置 ${name}；拒绝在未审核配置下构建`)
  }
  const initDirectory = `${relativeHome}/init.d`
  if (await fileExists(root, initDirectory)) {
    const info = await fileInfo(root, initDirectory)
    if (!info.isDirectory) throw new Error("隔离 Gradle User Home 的 init.d 路径不是目录")
    const contents = await listDirectory(root, initDirectory, { limit: 500 })
    if (contents.entries.length || contents.nextCursor) throw new Error("隔离 Gradle User Home 的 init.d 非空；拒绝加载未审核初始化脚本")
  }
}

export async function requestAndroidBuild({ workspace_id, project_path, task = "assembleDebug", agent_task_id, agent_step_index }) {
  if (!APPROVED_BUILD_TASKS.has(task)) throw new Error("Android 构建任务仅允许 assembleDebug、testDebugUnitTest 或 lintDebug")
  const workspace = await requireWorkspace(workspace_id, { writable: true })
  const project = await projectLocation(workspace, project_path)
  const execution = await executionPlan(workspace, project.projectPath, task)
  const fingerprint = await buildFingerprint(workspace.root, project.projectPath)
  const authorization = await getUnattendedDevGrant(workspace, {
    kind: "android_build", projectPath: project.projectPath, task,
  })
  if (agent_task_id !== undefined || agent_step_index !== undefined) {
    if (typeof agent_task_id !== "string" || !Number.isInteger(agent_step_index) || agent_step_index < 0) throw new Error("agent_task_id 和 agent_step_index 必须一起提供")
    const agents = await readArray("agentTasks")
    const agent = agents.find((item) => item.id === agent_task_id)
    if (!agent || (agent.workspaceId ?? agent.workspace_id) !== workspace.id || !agent.plan?.[agent_step_index]) throw new Error("Agent 任务/步骤关联无效")
  }
  const taskId = randomUUID()
  execution.logRelativePath = `${project.projectPath}/.tmp/logs/android-${task}-${taskId}.log`
  const taskRecord = {
    id: taskId, kind: "android_build", workspaceId: workspace.id,
    projectPath: project.projectPath, buildTask: task,
    buildInputSha256: fingerprint.sha256, buildInputFiles: fingerprint.files, buildInputBytes: fingerprint.bytes,
    command: execution.command, commandPreview: execution.preview,
    executablePath: execution.executable, arguments: execution.args,
    environment: execution.environment, timeoutMs: execution.timeoutMs,
    logRelativePath: execution.logRelativePath,
    status: authorization ? "queued" : "awaiting_approval", requestedAt: new Date().toISOString(),
    authorizedBy: authorization ? "unattendedDev" : "localApproval",
    authorizationId: authorization?.authorizationId ?? null,
    executorFingerprint: authorization ? {
      processPath: process.execPath,
      processSha256: createHash("sha256").update(await readFile(process.execPath)).digest("hex"),
      executablePath: execution.executable,
      executableSha256: createHash("sha256").update(await readFile(execution.executable)).digest("hex"),
      argumentsSha256: createHash("sha256").update(JSON.stringify(execution.args)).digest("hex"),
    } : null,
    startedAt: null, finishedAt: null, exitCode: null, signal: null,
    agentTaskId: agent_task_id ?? null, agentStepIndex: agent_step_index ?? null,
  }
  await mutateArray("tasks", (tasks) => {
    const active = tasks.find((item) => item.kind === "android_build" && item.workspaceId === workspace.id &&
      String(item.projectPath).toLowerCase() === project.projectPath.toLowerCase() && ["starting", "running"].includes(item.status))
    if (active) throw new Error(`Calculator 已有 Android 构建运行中（${active.id}）；同一项目不能并发写入 build 输出`)
    tasks.push(taskRecord)
  })
  if (agent_task_id !== undefined && !authorization) await linkAgentJob(agent_task_id, agent_step_index, taskRecord, "awaiting_user", "等待本机批准 Android Gradle 构建。")
  await audit(authorization ? "android_build_authorized_queued" : "android_build_requested", { workspaceId: workspace.id, itemId: taskRecord.id, result: taskRecord.status })
  if (authorization) {
    setImmediate(() => {
      void runApprovedAndroidBuild({ task_id: taskRecord.id }).catch(async (error) => {
        const current = (await readArray("tasks").catch(() => [])).find((item) => item.id === taskRecord.id)
        if (current && ["queued", "starting", "running"].includes(current.status)) {
          await finishTask(taskRecord.id, { status: "failed", exitCode: null, signal: null,
            error: String(error?.message ?? "无人值守 Android runner 启动失败") }).catch(() => {})
        }
        await audit("android_build_unattended_start_failed", {
          workspaceId: workspace.id, itemId: taskRecord.id,
          result: String(error?.message ?? "worker start failed").replace(/[\r\n\0]+/g, " ").slice(0, 300),
        }).catch(() => {})
      })
    })
  }
  return {
    task_id: taskRecord.id, status: taskRecord.status, project_path: project.projectPath,
    task, command: execution.command, preview: execution.preview,
    build_input_sha256: fingerprint.sha256, build_input_files: fingerprint.files,
    requires_local_approval: !authorization,
    authorization_id: authorization?.authorizationId ?? null,
  }
}

export async function runApprovedAndroidBuild({ task_id }) {
  const task = (await readArray("tasks")).find((item) => item.id === task_id)
  if (!task || task.kind !== "android_build") throw new Error("找不到 Android build task")
  const isAuthorizedQueue = task.status === "queued" && task.authorizedBy === "unattendedDev"
  if (task.status !== "approved" && !isAuthorizedQueue) throw new Error("Android build task 尚未由本机用户批准或无人值守授权")
  const workspace = await requireWorkspace(task.workspaceId, { writable: true })
  if (task.authorizedBy === "unattendedDev") {
    const authorization = await getUnattendedDevGrant(workspace, { kind: "android_build", projectPath: task.projectPath, task: task.buildTask })
    if (authorization?.authorizationId !== task.authorizationId) throw new Error("Android build 的无人值守授权已撤销或变化")
  }
  const project = await projectLocation(workspace, task.projectPath)
  const fingerprint = await buildFingerprint(workspace.root, project.projectPath)
  if (fingerprint.sha256 !== task.buildInputSha256) throw new Error("Gradle project 在本机审批后发生变化；请重新请求并审批")
  const execution = await executionPlan(workspace, project.projectPath, task.buildTask)
  if (execution.executable !== task.executablePath || JSON.stringify(execution.args) !== JSON.stringify(task.arguments) ||
      execution.command !== task.command || JSON.stringify(execution.environment) !== JSON.stringify(task.environment)) {
    throw new Error("Android build 命令或环境在审批后发生变化；请重新请求并审批")
  }
  if (task.authorizedBy === "unattendedDev") {
    const currentFingerprint = {
      processPath: process.execPath,
      processSha256: createHash("sha256").update(await readFile(process.execPath)).digest("hex"),
      executablePath: execution.executable,
      executableSha256: createHash("sha256").update(await readFile(execution.executable)).digest("hex"),
      argumentsSha256: createHash("sha256").update(JSON.stringify(execution.args)).digest("hex"),
    }
    if (JSON.stringify(currentFingerprint) !== JSON.stringify(task.executorFingerprint)) throw new Error("Android 执行器指纹与排队时不一致；拒绝无人值守构建")
  }
  const temporary = `${project.projectPath}/.tmp`
  const gradleUserHome = `${temporary}/gradle-user-home`
  for (const directory of [temporary, `${temporary}/logs`, `${temporary}/temp`, `${temporary}/user-profile`, `${temporary}/appdata`, `${temporary}/localappdata`, `${temporary}/android-user-home`, gradleUserHome, `${temporary}/gradle-project-cache`, `${temporary}/build`]) {
    await ensureProjectDirectory(workspace.root, directory)
  }
  await ensureCleanGradleUserHome(workspace.root, gradleUserHome)
  await mutateArray("tasks", (tasks) => {
    const item = tasks.find((entry) => entry.id === task_id)
    if (!item || (item.status !== "approved" && !(item.status === "queued" && item.authorizedBy === "unattendedDev"))) throw new Error("Android build task 尚未由本机用户批准或无人值守授权")
    const blocker = tasks.find((entry) => entry.id !== task_id && entry.kind === "android_build" && entry.workspaceId === item.workspaceId &&
      String(entry.projectPath).toLowerCase() === String(item.projectPath).toLowerCase() && (
        ["starting", "running"].includes(entry.status) ||
        (entry.status === "succeeded" && entry.buildTask === "assembleDebug" && !entry.artifact?.published)
      ))
    if (blocker) throw new Error(`Android 构建任务 ${blocker.id} 尚未结束或发布 APK；同一项目不能并发写入 build 输出`)
    item.status = "starting"
    item.startedAt = new Date().toISOString()
    return { ...item }
  })
  const environment = {
    PATH: [path.dirname(process.execPath), path.join(systemRoot, "System32")].join(path.delimiter),
    SystemRoot: systemRoot,
    SystemDrive: process.env.SystemDrive ?? "C:",
    USERPROFILE: process.env.USERPROFILE ?? "",
    LOCALAPPDATA: process.env.LOCALAPPDATA ?? "",
    JAVA_HOME: process.env.JAVA_HOME ?? "",
    ANDROID_HOME: process.env.ANDROID_HOME ?? "",
    ANDROID_SDK_ROOT: process.env.ANDROID_SDK_ROOT ?? "",
    CHATCODE_HOME,
    CHATCODE_DATA_DIR: DATA_DIR,
    CHATCODE_TMP_DIR: TMP_DIR,
  }
  const worker = spawn(process.execPath, [ANDROID_WORKER, task_id], {
    cwd: CHATCODE_HOME, env: environment, windowsHide: true,
    detached: true, stdio: "ignore",
  })
  if (Number.isInteger(worker.pid)) {
    await mutateArray("tasks", (tasks) => {
      const item = tasks.find((entry) => entry.id === task_id)
      if (item && ["starting", "running"].includes(item.status)) item.runnerPid = worker.pid
    })
  }
  const spawnResult = new Promise((resolve, reject) => {
    worker.once("spawn", resolve)
    worker.once("error", reject)
  })
  try {
    await spawnResult
  } catch (error) {
    const detail = `无法启动已批准的 Android runner：${String(error?.message ?? "spawn failed").slice(0, 240)}`
    await finishTask(task_id, { status: "failed", exitCode: null, signal: null, error: detail })
    throw new Error(detail)
  }
  for (let attempt = 0; attempt < 300; attempt++) {
    const current = await getTask(task_id)
    if (current.status === "running") return { task_id, status: current.status, command: execution.command, preview: execution.preview }
    if (["succeeded", "failed", "timed_out", "cancelled", "interrupted"].includes(current.status)) {
      if (current.status === "failed") throw new Error(current.error ?? "Android runner 在启动 Gradle 前失败")
      return { task_id, status: current.status, command: execution.command, preview: execution.preview }
    }
    await delay(100)
  }
  const detail = "Android runner 未能在 30 秒内确认 Gradle 子进程已启动"
  try { spawn(path.join(systemRoot, "System32", "taskkill.exe"), ["/PID", String(worker.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" }) } catch { /* task status records the startup timeout */ }
  await finishTask(task_id, { status: "failed", exitCode: null, signal: null, error: detail })
  throw new Error(detail)
}

export async function runAndroidBuildWorker(taskId) {
  try {
    const task = (await readArray("tasks")).find((item) => item.id === taskId)
    if (!task || task.kind !== "android_build" || task.status !== "starting") throw new Error("Android runner 找不到已批准的 starting 任务")
    const workspace = await requireWorkspace(task.workspaceId, { writable: true })
    if (task.authorizedBy === "unattendedDev") {
      const authorization = await getUnattendedDevGrant(workspace, { kind: "android_build", projectPath: task.projectPath, task: task.buildTask })
      if (authorization?.authorizationId !== task.authorizationId) throw new Error("Android runner 的无人值守授权已撤销或变化")
    }
    const project = await projectLocation(workspace, task.projectPath)
    const fingerprint = await buildFingerprint(workspace.root, project.projectPath)
    if (fingerprint.sha256 !== task.buildInputSha256) throw new Error("Gradle project 在 runner 启动前发生变化；请重新申请并审批")
    const execution = await executionPlan(workspace, project.projectPath, task.buildTask)
    if (execution.executable !== task.executablePath || JSON.stringify(execution.args) !== JSON.stringify(task.arguments) ||
        execution.command !== task.command || JSON.stringify(execution.environment) !== JSON.stringify(task.environment)) {
      throw new Error("Android runner 的固定命令或环境与已批准预览不一致")
    }
    await ensureCleanGradleUserHome(workspace.root, `${project.projectPath}/.tmp/gradle-user-home`)
    await launchApprovedProcess(taskId, "android_build", execution)
    while (true) {
      const current = await getTask(taskId)
      if (["succeeded", "failed", "timed_out", "cancelled", "interrupted"].includes(current.status)) return current
      await delay(250)
    }
  } catch (error) {
    const detail = String(error?.message ?? "Android runner failed").replace(/[\r\n\0]+/g, " ").slice(0, 300)
    const current = (await readArray("tasks").catch(() => [])).find((item) => item.id === taskId)
    if (current && ["starting", "running"].includes(current.status)) {
      await finishTask(taskId, { status: "failed", exitCode: null, signal: null, error: detail }).catch(() => {})
    }
    throw error
  }
}

async function parseApkMetadata(sdk, java, apkPath) {
  const aaptPath = path.win32.join(sdk.root, "build-tools", sdk.selected_build_tools, "aapt.exe")
  const apksignerJar = path.win32.join(sdk.root, "build-tools", sdk.selected_build_tools, "lib", "apksigner.jar")
  const [aapt, signature] = await Promise.all([
    execFileAsync(aaptPath, ["dump", "badging", apkPath], { windowsHide: true, timeout: 60_000, maxBuffer: 1_000_000 }),
    execFileAsync(java.java, ["-jar", apksignerJar, "verify", "--verbose", apkPath], { windowsHide: true, timeout: 60_000, maxBuffer: 64_000, env: { SystemRoot: systemRoot, JAVA_HOME: java.home, PATH: path.win32.join(java.home, "bin") } }),
  ])
  const text = aapt.stdout
  const packageLine = /^package:\s+name='([^']+)'\s+versionCode='([^']*)'\s+versionName='([^']*)'/m.exec(text)
  const minSdk = /^sdkVersion:'([^']+)'/m.exec(text)?.[1] ?? null
  const targetSdk = /^targetSdkVersion:'([^']+)'/m.exec(text)?.[1] ?? null
  const activity = /^launchable-activity:\s+name='([^']+)'/m.exec(text)?.[1] ?? null
  if (!packageLine || !activity || !minSdk || !targetSdk) throw new Error("aapt 未能确认 APK package、launchable activity、minSdk 或 targetSdk")
  return {
    package_name: packageLine[1], version_code: packageLine[2], version_name: packageLine[3],
    min_sdk: Number(minSdk), target_sdk: Number(targetSdk), launchable_activity: activity,
    signature_verified: true, signature_output: (signature.stdout + signature.stderr).trim().slice(0, 4_000),
  }
}

export async function getAndroidBuildArtifacts({ task_id }) {
  const task = (await readArray("tasks")).find((item) => item.id === task_id)
  if (!task || task.kind !== "android_build") throw new Error("找不到 Android build task")
  const workspace = await requireWorkspace(task.workspaceId)
  const project = await projectLocation(workspace, task.projectPath)
  const finalRelative = `${project.projectPath}/app-debug.apk`
  if (task.status !== "succeeded" || task.exitCode !== 0 || task.buildTask !== "assembleDebug") {
    const staleExists = await fileExists(workspace.root, finalRelative)
    return { task_id, status: task.status, published: false, stale_apk_exists: staleExists, diagnostic: "APK 只会从 exitCode=0 的 assembleDebug 任务发布。" }
  }
  await requireWorkspace(task.workspaceId, { writable: true })
  if (task.artifact?.published) {
    const finalStat = await fileInfo(workspace.root, finalRelative)
    const finalHash = (await hashFile(workspace.root, finalRelative)).sha256
    if (finalHash !== task.artifact.sha256 || Number(finalStat.sizeBytes) !== Number(task.artifact.size_bytes)) {
      throw new Error("已发布 APK 在记录后发生变化；拒绝把修改后的文件当作此构建产物")
    }
    return task.artifact
  }
  const environment = await androidEnvironment(workspace, project.projectPath)
  const sdk = environment.android_sdk
  const java = environment.java.selected
  if (!sdk || !java || !sdk.tools.aapt || !sdk.tools.apksigner) throw new Error("APK 校验所需 aapt、apksigner 或 JDK 不可用")
  const sourceRelative = `${project.projectPath}/.tmp/build/app/outputs/apk/debug/app-debug.apk`
  const sourceInfo = await fileInfo(workspace.root, sourceRelative)
  if (sourceInfo.isDirectory || Number(sourceInfo.size) <= 0) throw new Error("Gradle 没有生成非零大小的 app-debug.apk")
  const sourceAbsolute = path.win32.resolve(workspace.root, ...sourceRelative.split("/"))
  const beforeHash = (await hashFile(workspace.root, sourceRelative)).sha256
  const metadata = await parseApkMetadata(sdk, java, sourceAbsolute)
  const sourceAfter = await hashFile(workspace.root, sourceRelative)
  if (sourceAfter.sha256 !== beforeHash || Number(sourceAfter.sizeBytes) !== Number(sourceInfo.size)) throw new Error("APK 在签名或 Manifest 校验期间发生变化")

  const tmpBase = `${project.projectPath}/.tmp`
  const publishDirectory = `${tmpBase}/publish`
  await ensureProjectDirectory(workspace.root, publishDirectory)
  const stageRelative = `${publishDirectory}/app-debug-${task_id}.apk`
  const stageAbsolute = path.win32.resolve(workspace.root, ...stageRelative.split("/"))
  await assertRegularFile(stageAbsolute, { allowMissing: true })
  await copyFile(sourceAbsolute, stageAbsolute, fsConstants.COPYFILE_EXCL)
  try {
    const stagedHash = (await hashFile(workspace.root, stageRelative)).sha256
    if (stagedHash !== beforeHash) throw new Error("待发布 APK 的 SHA-256 与 Gradle 输出不一致")
    const existing = await fileExists(workspace.root, finalRelative)
    const expectedHash = existing ? (await hashFile(workspace.root, finalRelative)).sha256 : null
    const published = await writeStagedFile(workspace.root, finalRelative, expectedHash, path.win32.resolve(workspace.root, ...publishDirectory.split("/").filter(Boolean)), stageAbsolute)
    if (published.sha256 !== beforeHash || Number(published.bytes) !== Number(sourceInfo.size)) throw new Error("发布后 APK 的大小或 SHA-256 不一致")
  } finally {
    await rm(stageAbsolute, { force: true }).catch(() => {})
  }
  const finalStat = await fileInfo(workspace.root, finalRelative)
  const finalHash = (await hashFile(workspace.root, finalRelative)).sha256
  if (finalHash !== beforeHash || Number(finalStat.size) !== Number(sourceInfo.size)) throw new Error("最终 app-debug.apk 回读校验失败")
  const result = {
    task_id, status: task.status, published: true,
    path: finalRelative, size_bytes: finalStat.sizeBytes, sha256: finalHash,
    build_task: task.buildTask, build_finished_at: task.finishedAt,
    gradle_version: environment.gradle.selected_runner?.version ?? null,
    agp_version: PREFERRED_AGP, java_version: java.version, android_sdk: sdk.root,
    manifest: metadata,
  }
  await mutateArray("tasks", (tasks) => {
    const current = tasks.find((item) => item.id === task_id)
    if (current) current.artifact = result
  })
  await audit("android_apk_published", { workspaceId: workspace.id, itemId: task_id, path: finalRelative, result: finalHash })
  return result
}

export function classifyGradleDiagnostics(text) {
  const lines = String(text ?? "").split(/\r?\n/)
  const diagnostics = []
  const patterns = [
    { type: "groovy_kotlin_dsl", re: /(?:build\.gradle(?:\.kts)?|settings\.gradle(?:\.kts)?):\s*(?:line\s+)?\d+|(?:Build file\s+)?['"]?[^'"\r\n]*?(?:build|settings)\.gradle(?:\.kts)?['"]?\s+line:\s*\d+/i },
    { type: "kotlin_compile", re: /^(?:e:\s*)?(?:file:\/\/)?(.+\.kt):(?:\s*\()?\s*(\d+)[,:]\s*(\d+)\)?\s*:?\s*(?:error:\s*)?(.+)$/i },
    { type: "java_compile", re: /^(.+\.java):(\d+):\s*error:\s*(.+)$/i },
    { type: "resource_linking", re: /(?:Android resource linking failed|AAPT2?\s+error|resource .* not found)/i },
    { type: "dependency_resolution", re: /(?:Could not resolve|Could not find|Failed to resolve|No cached version of .* available for offline mode)/i },
    { type: "sdk_configuration", re: /(?:SDK location not found|failed to find target|licenses? for Android SDK|compileSdkVersion .* is not installed)/i },
    { type: "java_home", re: /(?:requires Java 17|invalid source release|Unsupported class file major version|JAVA_HOME)/i },
    { type: "gradle_plugin", re: /(?:Plugin .* was not found|Failed to apply plugin|Minimum supported Gradle version)/i },
    { type: "dex", re: /(?:D8:|DexArchiveMergerException|Cannot fit requested classes in a single dex file)/i },
  ]
  for (const line of lines) {
    const value = line.trim()
    if (!value) continue
    const kotlin = patterns[1].re.exec(value)
    const java = patterns[2].re.exec(value)
    const gradlePath = /(?:Build file\s+)?['"]?(.+?(?:build|settings)\.gradle(?:\.kts)?)["']?\s+line:\s*(\d+)(?:\s*,\s*column:\s*(\d+))?/i.exec(value)
    const gradleColon = /^(.+?(?:build|settings)\.gradle(?:\.kts)?):(\d+)(?::(\d+))?/i.exec(value)
    const type = gradlePath || gradleColon ? "groovy_kotlin_dsl" : patterns.find((pattern) => pattern.re.test(value))?.type ?? null
    if (!type) continue
    diagnostics.push({
      type,
      file: gradlePath?.[1] ?? gradleColon?.[1] ?? kotlin?.[1] ?? java?.[1] ?? null,
      line: Number(gradlePath?.[2] ?? gradleColon?.[2] ?? kotlin?.[2] ?? java?.[2]) || null,
      column: Number(gradlePath?.[3] ?? gradleColon?.[3] ?? kotlin?.[3] ?? java?.[3]) || null,
      severity: /warning/i.test(value) ? "warning" : "error",
      message: value.slice(0, 600),
    })
    if (diagnostics.length >= 100) break
  }
  const categories = [...new Set(diagnostics.map((item) => item.type))]
  return { categories, diagnostics, truncated: diagnostics.length >= 100 }
}
