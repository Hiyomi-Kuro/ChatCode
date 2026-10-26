import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { createServer } from "node:http"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import path from "node:path"
import { fileURLToPath } from "node:url"
import test from "node:test"

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
await mkdir(path.join(projectRoot, ".tmp", "tests"), { recursive: true })
const sandbox = await mkdtemp(path.join(projectRoot, ".tmp", "tests", "tunnel-proxy-"))
const dataDir = path.join(sandbox, "data")
const tmpDir = path.join(sandbox, ".tmp")
await mkdir(dataDir, { recursive: true })
await mkdir(tmpDir, { recursive: true })
process.env.CHATCODE_DATA_DIR = dataDir
process.env.CHATCODE_TMP_DIR = tmpDir

const {
  buildTunnelClientEnvironment,
  loadTunnelSettings,
  testProxyApi,
  testProxyTcp,
  updateProfileProxy,
} = await import("../apps/server/core/tunnel.mjs")

test.after(async () => rm(sandbox, { recursive: true, force: true }))

test("legacy settings migrate to persistent Geph HTTP proxy defaults", async () => {
  const file = path.join(dataDir, "tunnel-settings.json")
  await writeFile(file, JSON.stringify({ tunnelId: "tunnel_test", clientPath: "C:\\tools\\tunnel-client.exe", profile: "chatcode-local" }))

  const settings = await loadTunnelSettings()
  assert.equal(settings.proxyMode, "http")
  assert.equal(settings.proxyUrl, "http://127.0.0.1:9910")
  assert.ok(settings.proxyUpdatedAt)
  const saved = JSON.parse(await readFile(file, "utf8"))
  assert.equal(saved.proxyMode, "http")
  assert.equal(saved.proxyUrl, "http://127.0.0.1:9910")
  assert.equal(saved.proxyUpdatedAt, settings.proxyUpdatedAt)
})

test("an existing explicit proxy choice survives migration", async () => {
  const file = path.join(dataDir, "tunnel-settings.json")
  await writeFile(file, JSON.stringify({
    tunnelId: "tunnel_test", clientPath: "C:\\tools\\tunnel-client.exe", profile: "chatcode-local",
    proxyMode: "http", proxyUrl: "http://127.0.0.1:9080",
  }))
  const settings = await loadTunnelSettings()
  assert.equal(settings.proxyMode, "http")
  assert.equal(settings.proxyUrl, "http://127.0.0.1:9080")
  assert.ok(settings.proxyUpdatedAt)
})

test("tunnel-client JSON/YAML profiles receive and remove only the proxy reference", () => {
  const jsonProfile = JSON.stringify({ config_version: 1, mcp: { commands: [] } }, null, 2)
  const withProxy = JSON.parse(updateProfileProxy(jsonProfile, "http"))
  assert.equal(withProxy.http_proxy, "env:CHATCODE_TUNNEL_HTTP_PROXY")
  assert.deepEqual(withProxy.mcp, { commands: [] })
  const withoutProxy = JSON.parse(updateProfileProxy(JSON.stringify(withProxy), "system"))
  assert.equal(Object.hasOwn(withoutProxy, "http_proxy"), false)

  const yamlProfile = "config_version: 1\nmcp: {}\n"
  const yamlWithProxy = updateProfileProxy(yamlProfile, "http")
  assert.match(yamlWithProxy, /^http_proxy: "env:CHATCODE_TUNNEL_HTTP_PROXY"$/m)
  assert.equal(updateProfileProxy(yamlWithProxy, "direct").includes("http_proxy:"), false)
})

test("tunnel-only environment overrides conflicting proxy settings and a real child receives it", () => {
  const settings = { proxyMode: "http", proxyUrl: "http://127.0.0.1:9910" }
  const parentEnv = {
    PATH: process.env.PATH,
    HTTP_PROXY: "http://127.0.0.1:8080",
    HTTPS_PROXY: "http://127.0.0.1:8081",
    ALL_PROXY: "socks5://127.0.0.1:9909",
    NO_PROXY: "api.openai.com,localhost",
    CONTROL_PLANE_HTTP_PROXY: "http://127.0.0.1:7777",
  }
  const env = buildTunnelClientEnvironment(settings, "test-runtime-key", parentEnv)
  assert.equal(env.TUNNEL_CLIENT_HTTP_PROXY, "http://127.0.0.1:9910/")
  assert.equal(env.CONTROL_PLANE_HTTP_PROXY, "http://127.0.0.1:9910/")
  assert.equal(env.HTTP_PROXY, "http://127.0.0.1:9910/")
  assert.equal(env.HTTPS_PROXY, "http://127.0.0.1:9910/")
  assert.equal(env.NO_PROXY, "localhost,127.0.0.1,::1")
  assert.equal("ALL_PROXY" in env, false)
  assert.equal(env.CHATCODE_RUNTIME_API_KEY, "test-runtime-key")

  const child = spawnSync(process.execPath, ["-e", "process.stdout.write(JSON.stringify({http:process.env.HTTP_PROXY, tunnel:process.env.TUNNEL_CLIENT_HTTP_PROXY, noProxy:process.env.NO_PROXY}))"], { env, encoding: "utf8" })
  assert.equal(child.status, 0, child.stderr)
  assert.deepEqual(JSON.parse(child.stdout), {
    http: "http://127.0.0.1:9910/",
    tunnel: "http://127.0.0.1:9910/",
    noProxy: "localhost,127.0.0.1,::1",
  })
})

test("system and direct modes do not inherit a stale ChatCode forced proxy", () => {
  const parentEnv = {
    HTTP_PROXY: "http://127.0.0.1:9910",
    HTTPS_PROXY: "http://127.0.0.1:9910",
    ALL_PROXY: "socks5://127.0.0.1:9909",
    NO_PROXY: "localhost",
    TUNNEL_CLIENT_HTTP_PROXY: "http://127.0.0.1:8888",
    CONTROL_PLANE_HTTP_PROXY: "http://127.0.0.1:8888",
    CHATCODE_TUNNEL_HTTP_PROXY: "http://127.0.0.1:8888",
  }
  const system = buildTunnelClientEnvironment({ proxyMode: "system", proxyUrl: "" }, "", parentEnv)
  assert.equal(system.HTTPS_PROXY, "http://127.0.0.1:9910")
  assert.equal("TUNNEL_CLIENT_HTTP_PROXY" in system, false)
  assert.equal("CONTROL_PLANE_HTTP_PROXY" in system, false)

  const direct = buildTunnelClientEnvironment({ proxyMode: "direct", proxyUrl: "" }, "", parentEnv)
  for (const key of ["HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "TUNNEL_CLIENT_HTTP_PROXY", "CONTROL_PLANE_HTTP_PROXY", "CHATCODE_TUNNEL_HTTP_PROXY"]) {
    assert.equal(key in direct, false, `${key} must be removed in direct mode`)
  }
  assert.equal(direct.NO_PROXY, "*")
})

test("TCP and API probes use the selected HTTP CONNECT proxy and never fall back", async (t) => {
  const settingsFile = path.join(dataDir, "tunnel-settings.json")
  const proxy = createServer()
  let observedConnect = ""
  proxy.on("connect", (request, socket) => {
    observedConnect = request.url
    socket.end("HTTP/1.1 407 Proxy Authentication Required\r\nConnection: close\r\nContent-Length: 0\r\n\r\n")
  })
  await new Promise((resolve) => proxy.listen(0, "127.0.0.1", resolve))
  t.after(() => new Promise((resolve) => proxy.close(resolve)))
  const address = proxy.address()
  await writeFile(settingsFile, JSON.stringify({
    tunnelId: "tunnel_test", clientPath: "C:\\tools\\tunnel-client.exe", profile: "chatcode-local",
    proxyMode: "http", proxyUrl: `http://127.0.0.1:${address.port}`, proxyUpdatedAt: new Date().toISOString(),
  }))

  const tcp = await testProxyTcp()
  assert.equal(tcp.status, "available")
  const api = await testProxyApi()
  assert.equal(observedConnect, "api.openai.com:443")
  assert.equal(api.status, "unavailable")
  assert.match(api.message, /CONNECT 返回 HTTP 407/)
})

test("system NO_PROXY exclusions suppress API probing instead of falling through directly", async () => {
  const settingsFile = path.join(dataDir, "tunnel-settings.json")
  await writeFile(settingsFile, JSON.stringify({
    tunnelId: "tunnel_test", clientPath: "C:\\tools\\tunnel-client.exe", profile: "chatcode-local",
    proxyMode: "system", proxyUrl: "", proxyUpdatedAt: new Date().toISOString(),
  }))
  const previous = process.env.NO_PROXY
  process.env.NO_PROXY = "api.openai.com"
  try {
    const result = await testProxyApi()
    assert.equal(result.status, "unavailable")
    assert.match(result.message, /NO_PROXY.*排除/)
  } finally {
    if (previous === undefined) delete process.env.NO_PROXY
    else process.env.NO_PROXY = previous
  }
})
