// The tunnel client must keep its outbound proxy and runtime credential private
// to its own process. Its local stdio MCP child has neither use for those values
// nor any reason to inherit them.
for (const key of [
  "CHATCODE_RUNTIME_API_KEY", "CONTROL_PLANE_API_KEY", "OPENAI_API_KEY",
  "TUNNEL_CLIENT_HTTP_PROXY", "CONTROL_PLANE_HTTP_PROXY", "CHATCODE_TUNNEL_HTTP_PROXY",
  "MCP_HTTP_PROXY", "HARPOON_HTTP_PROXY",
  "HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "NO_PROXY",
  "http_proxy", "https_proxy", "all_proxy", "no_proxy",
  "tunnel_client_http_proxy", "control_plane_http_proxy", "chatcode_tunnel_http_proxy",
  "mcp_http_proxy", "harpoon_http_proxy",
]) delete process.env[key]

await import("../apps/server/mcp.mjs")
