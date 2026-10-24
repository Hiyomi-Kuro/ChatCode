import assert from "node:assert/strict"
import net from "node:net"
import test from "node:test"
import {
  createTunnelClientEnvironment, parseProxyUrl, resolveSystemProxy, testOpenAIConnection, testProxyPort,
} from "../apps/server/core/proxy.mjs"

async function listen(server) {
  await new Promise((resolve, reject) => {
    server.once("error", reject)
    server.listen(0, "127.0.0.1", resolve)
  })
  return server.address().port
}

async function close(server) {
  if (server.listening) await new Promise((resolve) => server.close(resolve))
}

test("custom, system, and direct modes build isolated child environments", () => {
  const base = {
    PATH: "safe-path", TUNNEL_CLIENT_HTTP_PROXY: "http://inherited.example:8000",
    CONTROL_PLANE_HTTP_PROXY: "http://control.example:8001", HTTP_PROXY: "http://system.example:8002",
    HTTPS_PROXY: "http://secure.example:8003", NO_PROXY: "localhost,127.0.0.1",
  }
  const original = { ...base }
  const custom = createTunnelClientEnvironment({ proxyMode: "custom", proxyUrl: "http://127.0.0.1:9910" }, { baseEnvironment: base })
  assert.equal(custom.TUNNEL_CLIENT_HTTP_PROXY, "http://127.0.0.1:9910/")
  for (const name of ["CONTROL_PLANE_HTTP_PROXY", "HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY"]) assert.equal(custom[name], undefined)
  assert.equal(custom.PATH, "safe-path")

  const system = createTunnelClientEnvironment({ proxyMode: "system" }, { baseEnvironment: base })
  assert.equal(system.TUNNEL_CLIENT_HTTP_PROXY, base.TUNNEL_CLIENT_HTTP_PROXY)
  assert.equal(system.HTTPS_PROXY, base.HTTPS_PROXY)
  assert.equal(system.NO_PROXY, base.NO_PROXY)

  const direct = createTunnelClientEnvironment({ proxyMode: "direct" }, { baseEnvironment: base })
  for (const name of ["TUNNEL_CLIENT_HTTP_PROXY", "CONTROL_PLANE_HTTP_PROXY", "HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY"]) assert.equal(direct[name], undefined)
  assert.deepEqual(base, original, "building a child environment must not mutate the manager environment")
})

test("custom proxy validation rejects embedded credentials and non-HTTP proxies", () => {
  assert.equal(parseProxyUrl("http://127.0.0.1:9910").port, 9910)
  assert.throws(() => parseProxyUrl("http://user:password@127.0.0.1:9910"), { code: "invalid_proxy_url" })
  assert.throws(() => parseProxyUrl("https://127.0.0.1:9910"), { code: "invalid_proxy_url" })
  assert.throws(() => parseProxyUrl("http://127.0.0.1:9910/path"), { code: "invalid_proxy_url" })
})

test("system proxy resolution respects NO_PROXY and explicit tunnel proxy precedence", () => {
  const bypassed = resolveSystemProxy({ HTTPS_PROXY: "http://proxy.example:8080", NO_PROXY: "api.openai.com" })
  assert.equal(bypassed.bypassed, true)
  assert.equal(bypassed.url, "")
  const explicit = resolveSystemProxy({ TUNNEL_CLIENT_HTTP_PROXY: "http://forced.example:9000", NO_PROXY: "api.openai.com" })
  assert.equal(explicit.address, "forced.example:9000")
  assert.equal(explicit.url, "http://forced.example:9000")
})

test("proxy port probe performs a real TCP connection and reports a closed port", async () => {
  const server = net.createServer((socket) => socket.end())
  const port = await listen(server)
  try {
    const reachable = await testProxyPort(`http://127.0.0.1:${port}`)
    assert.equal(reachable.status, "reachable")
    assert.ok(reachable.tcpMs >= 0)
  } finally { await close(server) }

  const closed = await testProxyPort(`http://127.0.0.1:${port}`, { timeoutMs: 500 })
  assert.equal(closed.status, "proxy_unavailable")
})

test("OpenAI probe sends an actual api.openai.com CONNECT request and classifies proxy auth failure", async () => {
  let connectRequest = ""
  const server = net.createServer((socket) => {
    let request = ""
    socket.on("data", (chunk) => {
      request += chunk.toString("latin1")
      if (!request.includes("\r\n\r\n")) return
      connectRequest = request
      socket.end("HTTP/1.1 407 Proxy Authentication Required\r\nContent-Length: 0\r\n\r\n")
    })
  })
  const port = await listen(server)
  try {
    const result = await testOpenAIConnection({ proxyUrl: `http://127.0.0.1:${port}`, timeoutMs: 1000 })
    assert.match(connectRequest, /^CONNECT api\.openai\.com:443 HTTP\/1\.1\r\n/)
    assert.equal(result.status, "proxy_auth_failure")
    assert.equal(result.httpStatus, 407)
  } finally { await close(server) }
})
