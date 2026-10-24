import net from "node:net"
import tls from "node:tls"

export const DEFAULT_TUNNEL_PROXY_URL = "http://127.0.0.1:9910"
export const OPENAI_CONTROL_PLANE_HOST = "api.openai.com"
const proxyEnvironmentNames = [
  "TUNNEL_CLIENT_HTTP_PROXY", "CONTROL_PLANE_HTTP_PROXY", "MCP_HTTP_PROXY", "HARPOON_HTTP_PROXY",
  "HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "NO_PROXY",
  "http_proxy", "https_proxy", "all_proxy", "no_proxy",
]

export class ProxyProbeError extends Error {
  constructor(code, message, details = {}) {
    super(message)
    this.name = "ProxyProbeError"
    this.code = code
    this.details = details
  }
}

export function parseProxyUrl(value, { allowHttps = false, allowCredentials = false } = {}) {
  if (typeof value !== "string" || !value.trim() || value.length > 2048 || /[\r\n\0]/.test(value)) {
    throw new ProxyProbeError("invalid_proxy_url", "请填写有效的 HTTP 代理地址。")
  }
  let parsed
  try { parsed = new URL(value.trim()) } catch {
    throw new ProxyProbeError("invalid_proxy_url", "代理地址格式无效，请使用 http://主机:端口。")
  }
  const allowedProtocol = parsed.protocol === "http:" || (allowHttps && parsed.protocol === "https:")
  if (!allowedProtocol || !parsed.hostname || (!allowCredentials && (parsed.username || parsed.password)) || parsed.pathname !== "/" || parsed.search || parsed.hash) {
    throw new ProxyProbeError("invalid_proxy_url", "代理地址必须是无路径的 HTTP(S) 代理；ChatCode 自定义地址不能内嵌账号密码。")
  }
  const port = parsed.port ? Number(parsed.port) : parsed.protocol === "https:" ? 443 : 80
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new ProxyProbeError("invalid_proxy_url", "代理端口必须是 1 到 65535 之间的整数。")
  return { url: parsed.toString(), protocol: parsed.protocol, host: parsed.hostname, port, username: parsed.username, password: parsed.password }
}

export function sanitizeProxyAddress(value) {
  try {
    const parsed = parseProxyUrl(value, { allowHttps: true, allowCredentials: true })
    const host = parsed.host.includes(":") && !parsed.host.startsWith("[") ? `[${parsed.host}]` : parsed.host
    return `${host}:${parsed.port}`
  } catch { return "未配置" }
}

function firstEnvironmentValue(environment, names) {
  for (const name of names) {
    const value = environment?.[name]
    if (typeof value === "string" && value.trim()) return { name, value: value.trim() }
  }
  return null
}

function noProxyMatches(hostname, value) {
  if (!value) return false
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, "")
  return value.split(/[;,]/).some((entry) => {
    let suffix = entry.trim().toLowerCase()
    if (!suffix) return false
    if (suffix === "*") return true
    if (suffix.includes(":")) suffix = suffix.slice(0, suffix.lastIndexOf(":"))
    suffix = suffix.replace(/^\[|\]$/g, "").replace(/^\./, "")
    return host === suffix || host.endsWith(`.${suffix}`)
  })
}

export function resolveSystemProxy(environment = process.env) {
  const explicit = firstEnvironmentValue(environment, ["TUNNEL_CLIENT_HTTP_PROXY", "CONTROL_PLANE_HTTP_PROXY"])
  const https = firstEnvironmentValue(environment, ["HTTPS_PROXY", "https_proxy"])
  const http = firstEnvironmentValue(environment, ["HTTP_PROXY", "http_proxy"])
  const all = firstEnvironmentValue(environment, ["ALL_PROXY", "all_proxy"])
  const selected = explicit ?? https ?? http ?? all
  if (!selected) return { configured: false, source: "system", address: "未设置", url: "", message: "系统环境中没有可用于控制平面的 HTTP(S) 代理。" }
  let parsed
  try { parsed = new URL(selected.value) } catch {
    return { configured: true, valid: false, source: selected.name, address: "地址无效", url: "", message: "系统环境代理地址格式无效。" }
  }
  if (!new Set(["http:", "https:"]).has(parsed.protocol) || !parsed.hostname || parsed.pathname !== "/" || parsed.search || parsed.hash) {
    return { configured: true, valid: false, source: selected.name, address: "地址无效", url: "", message: "系统环境代理必须是无路径的 HTTP(S) 代理地址。" }
  }
  const address = `${parsed.hostname.includes(":") ? `[${parsed.hostname.replace(/^\[|\]$/g, "")}]` : parsed.hostname}:${parsed.port || (parsed.protocol === "https:" ? "443" : "80")}`
  const noProxy = firstEnvironmentValue(environment, ["NO_PROXY", "no_proxy"])?.value ?? ""
  if (!explicit && noProxyMatches(OPENAI_CONTROL_PLANE_HOST, noProxy)) {
    return { configured: true, valid: true, bypassed: true, source: selected.name, address, url: "", message: "NO_PROXY 包含 api.openai.com；系统设置会让控制平面直连。" }
  }
  return { configured: true, valid: true, source: selected.name, address, url: selected.value, message: "将使用当前进程环境中的代理。" }
}

export function tunnelProxySettings(mode = "direct", proxyUrl = DEFAULT_TUNNEL_PROXY_URL, environment = process.env) {
  if (mode === "custom") {
    const proxy = parseProxyUrl(proxyUrl)
    return { mode, source: "ChatCode 设置", url: proxy.url, address: sanitizeProxyAddress(proxy.url), configured: true, valid: true }
  }
  if (mode === "system") return { mode, ...resolveSystemProxy(environment) }
  if (mode === "direct") return { mode, source: "直连", url: "", address: "不使用代理", configured: false, valid: true }
  throw new ProxyProbeError("invalid_proxy_mode", "代理模式无效。")
}

export function createTunnelClientEnvironment(settings, { baseEnvironment = process.env, secret = "" } = {}) {
  const environment = { ...baseEnvironment }
  if (secret) {
    environment.CHATCODE_RUNTIME_API_KEY = secret
    environment.CONTROL_PLANE_API_KEY = secret
  }
  if (settings.proxyMode === "custom") {
    const proxy = parseProxyUrl(settings.proxyUrl)
    for (const name of proxyEnvironmentNames) delete environment[name]
    environment.TUNNEL_CLIENT_HTTP_PROXY = proxy.url
    return environment
  }
  if (settings.proxyMode === "direct") {
    for (const name of proxyEnvironmentNames) delete environment[name]
    return environment
  }
  if (settings.proxyMode === "system") return environment
  throw new ProxyProbeError("invalid_proxy_mode", "代理模式无效。")
}

function onceEvent(target, event, errorEvent, timeoutMs, timeoutCode, timeoutMessage) {
  return new Promise((resolve, reject) => {
    let settled = false
    const finish = (error, value) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      target.removeListener(event, onEvent)
      target.removeListener(errorEvent, onError)
      if (error) reject(error)
      else resolve(value)
    }
    const onEvent = (value) => finish(null, value)
    const onError = (error) => finish(error)
    const timer = setTimeout(() => finish(new ProxyProbeError(timeoutCode, timeoutMessage)), timeoutMs)
    target.once(event, onEvent)
    target.once(errorEvent, onError)
  })
}

function classifyNetworkFailure(error, phase) {
  if (error instanceof ProxyProbeError) return error
  const code = String(error?.code ?? "")
  if (code === "ECONNREFUSED" || code === "EHOSTUNREACH" || code === "ENETUNREACH" || code === "ENOTFOUND" || code === "EAI_AGAIN") {
    return new ProxyProbeError("proxy_unavailable", "无法连接配置的代理；请启动代理或检查地址与端口。", { phase, systemCode: code })
  }
  if (code === "ETIMEDOUT" || code === "ECONNRESET" || code === "EPIPE") {
    return new ProxyProbeError(phase === "proxy" ? "proxy_unavailable" : "api_unreachable", phase === "proxy" ? "代理连接超时或被重置。" : "代理已接收请求，但 OpenAI API 连接超时或被重置。", { phase, systemCode: code })
  }
  if (/CERT|TLS|SSL|VERIFY|SELF_SIGNED/i.test(code)) return new ProxyProbeError("tls_error", "TLS 证书验证失败；未关闭证书校验。", { phase, systemCode: code })
  return new ProxyProbeError("api_unreachable", phase === "proxy" ? "无法建立到代理的 TCP 连接。" : "无法完成 OpenAI API 网络检查。", { phase, systemCode: code || "unknown" })
}

export async function testProxyPort(value, { timeoutMs = 3000 } = {}) {
  let proxy
  try { proxy = parseProxyUrl(value, { allowHttps: true, allowCredentials: true }) } catch (error) {
    return { status: error.code ?? "invalid_proxy_url", address: "未配置", tcpMs: null, message: error.message }
  }
  const started = Date.now()
  const socket = net.connect({ host: proxy.host, port: proxy.port })
  try {
    await onceEvent(socket, "connect", "error", timeoutMs, "proxy_unavailable", "代理 TCP 连接超时。")
    return { status: "reachable", address: sanitizeProxyAddress(proxy.url), tcpMs: Date.now() - started, message: "代理端口可连接。" }
  } catch (error) {
    const safe = classifyNetworkFailure(error, "proxy")
    return { status: safe.code, address: sanitizeProxyAddress(proxy.url), tcpMs: Date.now() - started, message: safe.message }
  } finally { socket.destroy() }
}

async function connectToTargetThroughProxy(proxy, target, timeoutMs, timings) {
  const tcpStarted = Date.now()
  let socket = net.connect({ host: proxy.host, port: proxy.port })
  try {
    await onceEvent(socket, "connect", "error", timeoutMs, "proxy_unavailable", "代理 TCP 连接超时。")
    timings.tcpMs = Date.now() - tcpStarted
    if (proxy.protocol === "https:") {
      const proxyTlsStarted = Date.now()
      const secureProxy = tls.connect({ socket, host: proxy.host, servername: proxy.host, rejectUnauthorized: true })
      await onceEvent(secureProxy, "secureConnect", "error", timeoutMs, "tls_error", "HTTPS 代理 TLS 握手超时。")
      timings.proxyTlsMs = Date.now() - proxyTlsStarted
      socket = secureProxy
    }
    const connectStarted = Date.now()
    const response = await new Promise((resolve, reject) => {
      let buffer = Buffer.alloc(0)
      const onData = (chunk) => {
        buffer = Buffer.concat([buffer, chunk])
        if (buffer.length > 16 * 1024) {
          socket.removeListener("data", onData)
          reject(new ProxyProbeError("proxy_connect_failed", "代理返回了过大的 CONNECT 响应头。", { phase: "proxy" }))
          return
        }
        const end = buffer.indexOf("\r\n\r\n")
        if (end < 0) return
        socket.removeListener("data", onData)
        socket.removeListener("error", onError)
        clearTimeout(timer)
        const header = buffer.subarray(0, end).toString("latin1")
        const status = /^HTTP\/\d(?:\.\d)?\s+(\d{3})/i.exec(header)?.[1]
        if (!status) return reject(new ProxyProbeError("proxy_connect_failed", "代理返回了无法识别的 CONNECT 响应。", { phase: "proxy" }))
        if (buffer.length > end + 4) return reject(new ProxyProbeError("proxy_connect_failed", "代理在 CONNECT 建立前返回了非预期数据。", { phase: "proxy" }))
        resolve(Number(status))
      }
      const onError = (error) => { clearTimeout(timer); socket.removeListener("data", onData); reject(classifyNetworkFailure(error, "proxy")) }
      const timer = setTimeout(() => {
        socket.removeListener("data", onData)
        socket.removeListener("error", onError)
        reject(new ProxyProbeError("proxy_unavailable", "代理 CONNECT 请求超时。", { phase: "proxy" }))
      }, timeoutMs)
      socket.on("data", onData)
      socket.once("error", onError)
      const authorization = proxy.username || proxy.password
        ? `Proxy-Authorization: Basic ${Buffer.from(`${decodeURIComponent(proxy.username)}:${decodeURIComponent(proxy.password)}`).toString("base64")}\r\n`
        : ""
      socket.write(`CONNECT ${target.host}:${target.port} HTTP/1.1\r\nHost: ${target.host}:${target.port}\r\nProxy-Connection: Keep-Alive\r\n${authorization}\r\n`)
    })
    timings.connectMs = Date.now() - connectStarted
    if (response === 407) throw new ProxyProbeError("proxy_auth_failure", "代理要求认证；请使用无凭据代理地址，或由管理员配置进程环境代理。", { phase: "proxy", httpStatus: response })
    if (response !== 200) throw new ProxyProbeError("proxy_connect_failed", `代理 CONNECT 返回 HTTP ${response}。`, { phase: "proxy", httpStatus: response })
    return socket
  } catch (error) {
    socket.destroy()
    throw error
  }
}

async function connectToTargetDirect(target, timeoutMs, timings) {
  const tcpStarted = Date.now()
  const socket = net.connect({ host: target.host, port: target.port })
  try {
    await onceEvent(socket, "connect", "error", timeoutMs, "api_unreachable", "OpenAI API TCP 连接超时。")
    timings.tcpMs = Date.now() - tcpStarted
    return socket
  } catch (error) {
    socket.destroy()
    throw classifyNetworkFailure(error, "api")
  }
}

async function secureTargetSocket(socket, target, timeoutMs, timings) {
  const started = Date.now()
  const secure = tls.connect({ socket, host: target.host, servername: target.host, rejectUnauthorized: true })
  try {
    await onceEvent(secure, "secureConnect", "error", timeoutMs, "tls_error", "OpenAI API TLS 握手超时。")
    timings.tlsMs = Date.now() - started
    return secure
  } catch (error) {
    secure.destroy()
    throw classifyNetworkFailure(error, "tls")
  }
}

async function requestOpenAIHead(socket, target, timeoutMs, timings) {
  const started = Date.now()
  return await new Promise((resolve, reject) => {
    let buffer = Buffer.alloc(0)
    const onData = (chunk) => {
      buffer = Buffer.concat([buffer, chunk])
      if (buffer.length > 32 * 1024) {
        cleanup()
        reject(new ProxyProbeError("api_unreachable", "OpenAI API 返回了过大的响应头。", { phase: "http" }))
        return
      }
      const end = buffer.indexOf("\r\n\r\n")
      if (end < 0) return
      cleanup()
      const header = buffer.subarray(0, end).toString("latin1")
      const status = Number(/^HTTP\/\d(?:\.\d)?\s+(\d{3})/i.exec(header)?.[1] ?? 0)
      const requestId = /^(?:x-request-id|cf-ray):\s*([A-Za-z0-9._-]{1,100})\s*$/im.exec(header)?.[1] ?? ""
      timings.httpMs = Date.now() - started
      resolve({ status, requestId })
    }
    const onError = (error) => { cleanup(); reject(classifyNetworkFailure(error, "http")) }
    const timer = setTimeout(() => { cleanup(); reject(new ProxyProbeError("api_unreachable", "等待 OpenAI API HTTP 响应超时。", { phase: "http" })) }, timeoutMs)
    const cleanup = () => {
      clearTimeout(timer)
      socket.removeListener("data", onData)
      socket.removeListener("error", onError)
    }
    socket.once("error", onError)
    socket.on("data", onData)
    socket.write(`HEAD /v1/models HTTP/1.1\r\nHost: ${target.host}\r\nUser-Agent: ChatCode-Proxy-Diagnostic/1.0\r\nConnection: close\r\n\r\n`)
  })
}

export async function testOpenAIConnection({ proxyUrl = "", timeoutMs = 12000 } = {}) {
  const timings = { tcpMs: null, connectMs: null, tlsMs: null, httpMs: null }
  const target = { host: OPENAI_CONTROL_PLANE_HOST, port: 443 }
  let socket
  let secure
  let address = "直连"
  try {
    if (proxyUrl) {
      const proxy = parseProxyUrl(proxyUrl, { allowHttps: true, allowCredentials: true })
      address = sanitizeProxyAddress(proxy.url)
      socket = await connectToTargetThroughProxy(proxy, target, timeoutMs, timings)
    } else {
      socket = await connectToTargetDirect(target, timeoutMs, timings)
    }
    secure = await secureTargetSocket(socket, target, timeoutMs, timings)
    const reply = await requestOpenAIHead(secure, target, timeoutMs, timings)
    if (!reply.status) throw new ProxyProbeError("api_unreachable", "OpenAI API 未返回有效 HTTP 状态。", { phase: "http" })
    if (reply.status === 407) throw new ProxyProbeError("proxy_auth_failure", "代理要求认证。", { phase: "http", httpStatus: reply.status })
    if (reply.status === 429) {
      return { status: "platform_rate_limited", address, timings, httpStatus: reply.status, requestId: reply.requestId, message: "网络已到达 OpenAI API，但 API 返回 HTTP 429；这不代表 ChatGPT 插件创建成功。" }
    }
    if ([401, 403].includes(reply.status) || (reply.status >= 200 && reply.status < 300)) {
      return { status: "api_reachable", address, timings, httpStatus: reply.status, requestId: reply.requestId, message: `已完成 TCP、TLS 和 HTTP 检查（HTTP ${reply.status}）；无密钥检查不代表认证成功。` }
    }
    return { status: "api_unreachable", address, timings, httpStatus: reply.status, requestId: reply.requestId, message: `OpenAI API 返回 HTTP ${reply.status}。` }
  } catch (error) {
    const safe = classifyNetworkFailure(error, error?.details?.phase ?? (proxyUrl ? "proxy" : "api"))
    return { status: safe.code, address, timings, httpStatus: safe.details.httpStatus ?? null, requestId: "", phase: safe.details.phase ?? "unknown", systemCode: safe.details.systemCode ?? "", message: safe.message }
  } finally {
    secure?.destroy()
    if (!secure) socket?.destroy()
  }
}
