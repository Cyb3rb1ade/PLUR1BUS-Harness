import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { fileURLToPath } from "node:url";
import { McpServerCore } from "../../packages/api/src/mcp/server.ts";
import type { McpToolDef } from "../../packages/api/src/mcp/types.ts";
import { createMcpFetch } from "../../packages/core/src/mcp/http.ts";
import { exporterMain } from "./lib.mjs";

const tool: McpToolDef = {
  name: "alpha.echo",
  description: "Echoes a fixture message",
  inputSchema: { type: "object", properties: { msg: { type: "string", "x-mcp-header": "Text" } } },
  handler: async args => ({ echoed: args.msg }),
};
const version = "2026-07-28";

export async function recordMcpServer() {
  const core = new McpServerCore({ tools: [tool], ttlMs: 30_000, agentId: "fixture-agent" });
  const listener = createServer((req, res) => { void core.handleRequest({ req, res }); });
  try {
    await new Promise<void>((resolve, reject) => {
      listener.once("error", reject);
      listener.listen(0, "127.0.0.1", resolve);
    });
    const endpoint = new URL(`http://127.0.0.1:${(listener.address() as AddressInfo).port}/mcp`);
    const fetch = createMcpFetch();
    const meta = { "io.modelcontextprotocol/protocolVersion": version };
    const selected = [
      { name: "discover", method: "server/discover", headers: {}, params: { _meta: meta } },
      { name: "list", method: "tools/list", headers: {}, params: { _meta: meta } },
      { name: "call", method: "tools/call", headers: { "mcp-name": "alpha.echo", "mcp-param-text": "=?base64?Y2Fmw6k=?=" },
        params: { name: "alpha.echo", arguments: { msg: "café" }, _meta: meta } },
      { name: "method-header", method: "tools/list", headers: { "mcp-method": "ping" }, params: { _meta: meta } },
      { name: "param-header", method: "tools/call", headers: { "mcp-name": "alpha.echo" },
        params: { name: "alpha.echo", arguments: { msg: "café" }, _meta: meta } },
      { name: "version", method: "tools/list", headers: { "mcp-protocol-version": "2001-01-01" }, params: { _meta: meta } },
    ];
    const cases = [];
    for (const [offset, test] of selected.entries()) {
      const headers = {
        "content-type": "application/json", "mcp-protocol-version": version, "mcp-method": test.method, ...test.headers,
      };
      const message = { jsonrpc: "2.0", id: offset + 1, method: test.method, params: test.params };
      const response = await fetch(endpoint, { method: "POST", headers, body: JSON.stringify(message) });
      cases.push({ name: test.name,
        ...(test.name === "param-header" ? { "expected-divergence": "P4D-233" } : {}),
        request: { headers, message }, response: { status: response.status, message: await response.json() } });
    }
    const legacy = [
      { name: "legacy-initialize", headers: {}, message: { jsonrpc: "2.0", id: 20, method: "initialize",
        params: { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "fixture", version: "1" } } } },
      { name: "legacy-initialized", headers: { "mcp-protocol-version": "2025-11-25" }, message: { jsonrpc: "2.0", method: "notifications/initialized" } },
      { name: "legacy-list", headers: { "mcp-protocol-version": "2025-11-25" }, message: { jsonrpc: "2.0", id: 21, method: "tools/list", params: {} } },
      { name: "legacy-call", headers: { "mcp-protocol-version": "2025-11-25" }, message: { jsonrpc: "2.0", id: 22, method: "tools/call", params: { name: "alpha.echo", arguments: { msg: "café" } } } },
    ];
    for (const test of legacy) {
      const headers = { "accept": "application/json, text/event-stream", "content-type": "application/json", ...test.headers };
      const response = await fetch(endpoint, { method: "POST", headers, body: JSON.stringify(test.message) });
      const raw = await response.text();
      cases.push({ name: test.name, request: { headers, message: test.message }, response: { status: response.status, message: raw ? JSON.parse(raw) : null } });
    }
    return { server: { source: "packages/api/src/mcp/server.ts", cases } };
  } finally {
    listener.closeAllConnections();
    await new Promise<void>(resolve => listener.close(() => resolve()));
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  process.exitCode = await exporterMain({ area: "mcp", build: recordMcpServer });
}
