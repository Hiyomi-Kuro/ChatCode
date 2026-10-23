import path from "node:path"

const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i
const SENSITIVE_NAMES = new Set([
  ".npmrc", ".netrc", "credentials", "credentials.json", "cookies", "cookies.json",
  "id_rsa", "id_ed25519", "known_hosts", "secrets.json", "token.json",
])
const SKIP_DIRECTORY_NAMES = new Set([
  ".git", ".hg", ".svn", ".tmp", "node_modules", "vendor", "dist", "build",
  "coverage", ".next", ".nuxt", ".turbo", ".cache", "out", "target",
])
const BLOCKED_EXPLICIT_DIRECTORY_NAMES = new Set([".git", ".hg", ".svn", ".tmp", "node_modules"])

export function normalizeRelative(input, { allowRoot = false } = {}) {
  if (typeof input !== "string" || input.length > 2048 || input.includes("\0")) throw new Error("路径参数无效")
  if (input === "" || input === ".") {
    if (allowRoot) return ""
    throw new Error("必须提供工作区内的相对路径")
  }
  if (/^(?:[a-z]:|[\\/]{2}|\\\\\?\\|\\\\\.\\)/i.test(input) || path.isAbsolute(input) || path.win32.isAbsolute(input)) {
    throw new Error("只允许工作区内的相对路径")
  }
  if (input.includes(":") || input.includes("%00")) throw new Error("路径包含不允许的冒号或备用数据流")
  const parts = input.replace(/\\/g, "/").split("/")
  if (parts.some((part) => !part || part === "." || part === ".." || part.endsWith(".") || part.endsWith(" ") || WINDOWS_RESERVED.test(part))) {
    throw new Error("路径包含穿越、空段或 Windows 保留名称")
  }
  return parts.join("/")
}

export function isSensitivePath(relative) {
  const parts = relative.split("/")
  return parts.some((part) => {
    const lower = part.toLowerCase()
    return lower === ".env" || lower.startsWith(".env.") || SENSITIVE_NAMES.has(lower) ||
      /(?:^|[._-])(secret|token|credential|cookie|private[-_]?key)(?:[._-]|$)/i.test(lower) ||
      /\.(?:pem|p12|pfx|key|keystore)$/i.test(lower)
  })
}

export function shouldSkipDirectory(name) {
  return SKIP_DIRECTORY_NAMES.has(name.toLowerCase())
}

export function hasBlockedExplicitDirectory(relative) {
  return relative.split("/").some((part) => BLOCKED_EXPLICIT_DIRECTORY_NAMES.has(part.toLowerCase()))
}

export function isPathWithin(root, target) {
  const flavor = process.platform === "win32" ? path.win32 : path
  const relative = flavor.relative(root, target)
  return relative === "" || (!relative.startsWith(`..${flavor.sep}`) && relative !== ".." && !flavor.isAbsolute(relative))
}

export function pathsOverlap(first, second) {
  return isPathWithin(first, second) || isPathWithin(second, first)
}

export function rejectNetworkOrDeviceRoot(candidate) {
  if (typeof candidate !== "string" || candidate.length > 2048 || candidate.includes("\0")) throw new Error("目录路径无效")
  if (/^(?:\\\\|\/\/|\\\\\?\\|\\\\\.\\)/.test(candidate)) throw new Error("不支持 UNC、设备或扩展路径")
  if (process.platform === "win32" && !/^[a-z]:[\\/]/i.test(candidate)) throw new Error("请选择本地驱动器上的完整目录")
}
