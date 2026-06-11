// Characterization (golden) test for the two MCP transport handlers.
// Imports the real Vercel handler and fires representative requests at both
// /mcp and /stream, capturing status + key headers + body so a refactor can
// be proven behavior-preserving. No network: only structural methods and the
// unknown-tool error path are exercised (never a real KuCoin call).
process.env.MCP_AUTH_KEY = "testkey";
process.env.MCP_DEBUG = "false";

const mod = await import("../api/mcp.ts");
const handler = mod.default;

const AUTH = { "Content-Type": "application/json", "X-MCP-Auth-Key": "testkey" };

function req(method, path, { body, headers } = {}) {
  return new Request(`https://example.test${path}`, {
    method,
    headers: { ...(headers || {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
}

const scenarios = [
  ["initialize /mcp",        req("POST", "/mcp",    { headers: AUTH, body: { jsonrpc:"2.0", id:1, method:"initialize", params:{ protocolVersion:"2024-11-05" } } })],
  ["initialize /stream",     req("POST", "/stream", { headers: AUTH, body: { jsonrpc:"2.0", id:1, method:"initialize", params:{ protocolVersion:"2024-11-05" } } })],
  ["tools/list /mcp",        req("POST", "/mcp",    { headers: AUTH, body: { jsonrpc:"2.0", id:2, method:"tools/list" } })],
  ["tools/list /stream",     req("POST", "/stream", { headers: AUTH, body: { jsonrpc:"2.0", id:2, method:"tools/list" } })],
  ["ping /mcp",              req("POST", "/mcp",    { headers: AUTH, body: { jsonrpc:"2.0", id:3, method:"ping" } })],
  ["ping /stream",           req("POST", "/stream", { headers: AUTH, body: { jsonrpc:"2.0", id:3, method:"ping" } })],
  ["notif/initialized /mcp", req("POST", "/mcp",    { headers: AUTH, body: { jsonrpc:"2.0", method:"notifications/initialized" } })],
  ["notif/initialized /str", req("POST", "/stream", { headers: AUTH, body: { jsonrpc:"2.0", method:"notifications/initialized" } })],
  ["notif/cancelled /str",   req("POST", "/stream", { headers: AUTH, body: { jsonrpc:"2.0", method:"notifications/cancelled" } })],
  ["unknown method /mcp",    req("POST", "/mcp",    { headers: AUTH, body: { jsonrpc:"2.0", id:4, method:"foo/bar" } })],
  ["unknown method /stream", req("POST", "/stream", { headers: AUTH, body: { jsonrpc:"2.0", id:4, method:"foo/bar" } })],
  ["tools/call err /mcp",    req("POST", "/mcp",    { headers: AUTH, body: { jsonrpc:"2.0", id:5, method:"tools/call", params:{ name:"nonexistentTool", arguments:{} } } })],
  ["tools/call err /stream", req("POST", "/stream", { headers: AUTH, body: { jsonrpc:"2.0", id:5, method:"tools/call", params:{ name:"nonexistentTool", arguments:{} } } })],
  ["GET /mcp",               req("GET",  "/mcp",    { headers: AUTH })],
  ["GET /stream",            req("GET",  "/stream", { headers: AUTH })],
  ["OPTIONS /mcp",           req("OPTIONS", "/mcp", { headers: AUTH })],
  ["no-auth /mcp",           req("POST", "/mcp",    { headers: { "Content-Type":"application/json" }, body: { jsonrpc:"2.0", id:6, method:"tools/list" } })],
];

const out = [];
for (const [label, request] of scenarios) {
  const res = await handler(request);
  const body = await res.text();
  out.push({
    label,
    status: res.status,
    contentType: res.headers.get("content-type"),
    acao: res.headers.get("access-control-allow-origin"),
    hasSessionId: res.headers.get("mcp-session-id") !== null,
    body,
  });
}
console.log(JSON.stringify(out, null, 2));
