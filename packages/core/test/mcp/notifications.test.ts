import { it } from "node:test";
import assert from "node:assert/strict";
import { McpConnection } from "../../src/mcp/connection.ts";
import { systemClock } from "../../src/mcp/clock.ts";
import { createRedactor } from "../../src/mcp/redact.ts";
import { pipedModern, modernHandler, pipedLegacy } from "./helpers/dual-fixture.ts";
import { stdioDef, capturingLogger } from "./helpers/util.ts";

const tick = () => new Promise<void>(r => setImmediate(r));
it("modern subscriptions require acknowledgement and correlated, opted-in notifications", async () => {
  const f = await pipedModern(); const notices: string[] = [];
  const c = await McpConnection.open({ def: stdioDef(), clock: systemClock, logger: capturingLogger(), redactor: createRedactor(), hostEnv: {}, onToolsChanged: () => notices.push("tools"), onRemoteClose: () => {}, onNotification: method => notices.push(method), transportFactory: () => f.client });
  try {
    await c.listen(); await tick();
    const listen = f.requests.findLast(m => m.method === "subscriptions/listen")!;
    assert.ok(listen);
    await f.transport.send({ jsonrpc: "2.0", method: "notifications/tools/list_changed", params: {} });
    await tick(); assert.ok(!notices.includes("tools"), "unsolicited modern list-change was accepted");
    await f.transport.send({ jsonrpc: "2.0", method: "notifications/tools/list_changed", params: { _meta: { "io.modelcontextprotocol/subscriptionId": listen.id } } });
    await tick(); assert.ok(notices.includes("tools"));
  } finally { await c.close("graceful"); await f.close(); }
});
it("legacy resources subscriptions deliver updates through the notification port", async () => {
  const f = await pipedLegacy(); let updated = "";
  const c = await McpConnection.open({ def: stdioDef(), clock: systemClock, logger: capturingLogger(), redactor: createRedactor(), hostEnv: {}, onToolsChanged: () => {}, onRemoteClose: () => {}, onNotification: (method, p) => { if (method === "notifications/resources/updated") updated = String(p.uri); }, transportFactory: () => f.client });
  try { await c.subscribeResource("test://one"); await f.server.sendResourceUpdated({ uri: "test://one" }); await tick(); assert.equal(updated, "test://one"); }
  finally { await c.close("graceful"); await f.close(); }
});
it("modern progress correlates to progressToken and cancellation is sent on stdio", async () => {
  let f: Awaited<ReturnType<typeof pipedModern>>;
  f = await pipedModern(m => {
    if (m.method !== "tools/call") return modernHandler(m);
    const token = ((m.params as Record<string, unknown>)._meta as Record<string, unknown>).progressToken;
    void f.transport.send({ jsonrpc: "2.0", method: "notifications/progress", params: { progressToken: token, progress: 1, total: 2 } });
    return undefined;
  });
  const c = await McpConnection.open({ def: stdioDef(), clock: systemClock, logger: capturingLogger(), redactor: createRedactor(), hostEnv: {}, onToolsChanged: () => {}, onRemoteClose: () => {}, transportFactory: () => f.client });
  try {
    const ac = new AbortController(); const progress: number[] = [];
    const call = c.callTool("echo", {}, ac.signal, { onProgress: p => { progress.push(p.progress); ac.abort(); } });
    await assert.rejects(call, (e: { code?: string }) => e.code === "aborted");
    assert.deepEqual(progress, [1]); assert.ok(f.requests.some(m => m.method === "notifications/cancelled"));
  } finally { await c.close("graceful"); await f.close(); }
});
