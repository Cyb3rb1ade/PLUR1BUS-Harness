import { it } from "node:test";
import assert from "node:assert/strict";
import { createServer, type IncomingHttpHeaders } from "node:http";
import type { AddressInfo } from "node:net";
import { McpConnection } from "../../src/mcp/connection.ts";
import { McpRegistry } from "../../src/mcp/registry.ts";
import { systemClock } from "../../src/mcp/clock.ts";
import { createRedactor } from "../../src/mcp/redact.ts";
import { capturingLogger, httpDef, caller } from "./helpers/util.ts";

async function legacyHttp() {
  const seen: Array<{ method: string; headers: IncomingHttpHeaders; body?: Record<string, unknown> }> = [];
  let listId: unknown; let deleted = false; let expired = false; let initialized = 0;
  const server = createServer(async (req, res) => {
    let body = ""; for await (const chunk of req) body += String(chunk);
    const m = body ? JSON.parse(body) as Record<string, unknown> : undefined;
    seen.push({ method: req.method!, headers: req.headers, ...(m ? { body: m } : {}) });
    if (m?.method === "server/discover") { res.writeHead(400).end(); return; }
    if (m?.method === "initialize") {
      initialized++; expired = false;
      res.writeHead(200, { "content-type": "application/json", "mcp-session-id": `session-${initialized}` }).end(JSON.stringify({ jsonrpc: "2.0", id: m.id, result: { protocolVersion: "2025-11-25", capabilities: { tools: {} }, serverInfo: { name: "legacy-http", version: "1" } } })); return;
    }
    if (req.method === "DELETE") { deleted = true; res.writeHead(200).end(); return; }
    if (expired) { res.writeHead(404).end(); return; }
    if (req.method === "GET") {
      if (!req.headers["last-event-id"]) { res.writeHead(405).end(); return; }
      res.writeHead(200, { "content-type": "text/event-stream" }).end(`id: result\ndata: ${JSON.stringify({ jsonrpc: "2.0", id: listId, result: { tools: [{ name: "echo", inputSchema: { type: "object" } }] } })}\n\n`); return;
    }
    if (m?.method === "notifications/initialized" || m?.method === "notifications/cancelled") { res.writeHead(202).end(); return; }
    if (m?.method === "tools/list") {
      listId = m.id; res.writeHead(200, { "content-type": "text/event-stream" }).end("id: primed\nretry: 1\ndata:\n\n"); return;
    }
    res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ jsonrpc: "2.0", id: m?.id, result: { content: [{ type: "text", text: "ok" }] } }));
  });
  await new Promise<void>(r => server.listen(0, "127.0.0.1", r));
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/mcp`, seen, deleted: () => deleted, expire: () => { expired = true; },
    initialized: () => initialized, close: async () => { server.closeAllConnections(); await new Promise<void>(r => server.close(() => r())); } };
}
it("legacy HTTP handles JSON/SSE, session headers, GET resumption and DELETE", async () => {
  const f = await legacyHttp();
  const c = await McpConnection.open({ def: httpDef(f.url), clock: systemClock, logger: capturingLogger(), redactor: createRedactor(), hostEnv: {}, onToolsChanged: () => {}, onRemoteClose: () => {} });
  try {
    assert.equal((await c.listTools())[0]?.name, "echo");
    assert.ok(f.seen.some(r => r.method === "GET" && r.headers["last-event-id"] === "primed"));
    assert.ok(f.seen.filter(r => r.body?.method === "tools/list").every(r => String(r.headers.accept).includes("text/event-stream") && String(r.headers.accept).includes("application/json")));
    assert.ok(f.seen.filter(r => r.body?.method === "tools/list").every(r => r.headers["mcp-session-id"] === "session-1" && r.headers["mcp-protocol-version"] === "2025-11-25"));
  } finally { await c.close("graceful"); assert.ok(f.deleted()); await f.close(); }
});
it("legacy HTTP session expiration abandons the failed call and initializes a fresh session on next use", async () => {
  const f = await legacyHttp(); const reg = new McpRegistry({ logger: capturingLogger() });
  reg.register({ name: "one", transport: { type: "http", url: f.url } });
  try {
    await reg.listTools("one", caller); f.expire();
    await assert.rejects(reg.callTool("one", "echo", {}, caller));
    await reg.callTool("one", "echo", {}, caller);
    assert.equal(f.initialized(), 2);
  } finally { await reg.shutdown(); await f.close(); }
});
