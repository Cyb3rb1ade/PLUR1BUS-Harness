import { it } from "node:test";
import assert from "node:assert/strict";
import { McpRegistry } from "../../src/mcp/registry.ts";
import { FakeClock } from "./helpers/fake-clock.ts";
import { caller, capturingLogger, stdioDef, NODE } from "./helpers/util.ts";
import { httpModern } from "./helpers/dual-fixture.ts";

it("configured stdio restart uses backoff; a crashed tool call is never replayed", { timeout: 30000 }, async () => {
  const clock = new FakeClock(); const logger = capturingLogger();
  const events: string[] = [];
  const reg = new McpRegistry({ logger, clock, hostEnv: process.env, policy: { allowedCommands: [NODE] }, onEvent: event => { if (event.state) events.push(event.state); } });
  reg.register(stdioDef({ reconnect: { maxAttempts: 2, initialDelayMs: 50, maxDelayMs: 100 } }));
  try {
    await reg.listTools("fixture", caller);
    await assert.rejects(reg.callTool("fixture", "crash", {}, caller));
    assert.equal(reg.status("fixture", caller.agentId).connectionState, "degraded");
    await clock.advance(49); assert.equal(reg.status("fixture", caller.agentId).starts, 1);
    await clock.advance(1);
    const until = Date.now() + 10000;
    while (reg.status("fixture", caller.agentId).starts < 2 && Date.now() < until) await new Promise(r => setTimeout(r, 20));
    assert.equal(reg.status("fixture", caller.agentId).starts, 2);
    assert.ok(events.includes("degraded")); assert.equal(events.at(-1), "ready");
  } finally { await reg.shutdown(); }
});
it("modern cache TTL expires even without list_changed, and server era is remembered after idle stop", async () => {
  const f = await httpModern(); const clock = new FakeClock();
  const reg = new McpRegistry({ logger: capturingLogger(), clock, policy: { idleTimeoutMs: 100 } });
  reg.register({ name: "one", transport: { type: "http", url: f.url + "/json" } });
  try {
    await reg.listTools("one", caller); await reg.listTools("one", caller);
    assert.equal(f.requests.filter(m => m.body.method === "tools/list").length, 2);
    await clock.advance(100); assert.equal(reg.status("one", caller.agentId).state, "stopped");
    assert.equal(reg.status("one", caller.agentId).protocolVersion, "2026-07-28");
    await reg.callTool("one", "echo", { text: "ok" }, caller);
    assert.ok(f.requests.every(m => m.body.method !== "initialize"));
  } finally { await reg.shutdown(); await f.close(); }
});

it("registry re-probes a cached legacy era after the server upgrades to modern", async () => {
  const { createServer } = await import("node:http");
  const { modernHandler } = await import("./helpers/dual-fixture.ts");
  let upgraded = false;
  const http = createServer(async (req, res) => {
    if (req.method !== "POST") { res.writeHead(405).end(); return; }
    let raw = ""; for await (const b of req) raw += String(b);
    const m = JSON.parse(raw) as Record<string, unknown>;
    if (!Object.hasOwn(m, "id")) { res.writeHead(202).end(); return; }
    if (upgraded && m.method === "subscriptions/listen") {
      res.writeHead(200, { "content-type": "text/event-stream" }); res.write(`data: ${JSON.stringify({ jsonrpc: "2.0", method: "notifications/subscriptions/acknowledged", params: { notifications: (m.params as Record<string, unknown>).notifications, _meta: { "io.modelcontextprotocol/subscriptionId": m.id } } })}\n\n`); return;
    }
    let response: Record<string, unknown>;
    if (upgraded) response = modernHandler(m);
    else if (m.method === "server/discover") response = { jsonrpc: "2.0", id: m.id, error: { code: -32601, message: "legacy" } };
    else if (m.method === "initialize") response = { jsonrpc: "2.0", id: m.id, result: { protocolVersion: "2025-11-25", capabilities: { tools: {} }, serverInfo: { name: "upgrading", version: "1" } } };
    else response = modernHandler({ ...m, params: { ...((m.params ?? {}) as object), _meta: { "io.modelcontextprotocol/protocolVersion": "2026-07-28" } } });
    res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(response));
  });
  await new Promise<void>(r => http.listen(0, "127.0.0.1", r));
  const port = (http.address() as { port: number }).port; const clock = new FakeClock();
  const reg = new McpRegistry({ logger: capturingLogger(), clock, policy: { idleTimeoutMs: 100 } });
  reg.register({ name: "one", transport: { type: "http", url: `http://127.0.0.1:${port}/mcp` } });
  try {
    await reg.listTools("one", caller); assert.equal(reg.status("one", caller.agentId).protocolVersion, "2025-11-25");
    await clock.advance(100); upgraded = true;
    await reg.listTools("one", caller, { refresh: true });
    assert.equal(reg.status("one", caller.agentId).protocolVersion, "2026-07-28");
  } finally { await reg.shutdown(); http.closeAllConnections(); await new Promise<void>(r => http.close(() => r())); }
});
