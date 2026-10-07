import { it } from "node:test";
import assert from "node:assert/strict";
import { McpConnection } from "../../src/mcp/connection.ts";
import { systemClock } from "../../src/mcp/clock.ts";
import { createRedactor } from "../../src/mcp/redact.ts";
import { pipedModern, modernHandler, tool, pipedLegacy } from "./helpers/dual-fixture.ts";
import { stdioDef, capturingLogger } from "./helpers/util.ts";
import { toolHeaderExtractor } from "../../src/mcp/tool-headers.ts";

async function withModern(handler: typeof modernHandler, run: (c: McpConnection, f: Awaited<ReturnType<typeof pipedModern>>) => Promise<void>) {
  const fixture = await pipedModern(handler);
  const conn = await McpConnection.open({ def: stdioDef(), clock: systemClock, logger: capturingLogger(), redactor: createRedactor(), hostEnv: {}, onToolsChanged: () => {}, onRemoteClose: () => {}, transportFactory: () => fixture.client });
  try { await run(conn, fixture); } finally { await conn.close("graceful"); await fixture.close(); }
}
it("modern pagination covers all pages and rejects repeated cursors", async () => {
  await withModern(m => m.method === "tools/list" ? { jsonrpc: "2.0", id: m.id, result: { resultType: "complete", ttlMs: 100, cacheScope: "private", tools: [{ ...tool, name: (m.params as { cursor?: string }).cursor ? "second" : "first" }], ...((m.params as { cursor?: string }).cursor ? {} : { nextCursor: "page2" }) } } : modernHandler(m), async c => {
    assert.deepEqual((await c.listTools()).map(t => t.name), ["first", "second"]);
  });
  await withModern(m => m.method === "resources/list" ? { jsonrpc: "2.0", id: m.id, result: { resultType: "complete", ttlMs: 0, cacheScope: "private", resources: [], nextCursor: "repeat" } } : modernHandler(m), async c => {
    await assert.rejects(c.listResources(), /repeated/);
  });
});
it("both generations reject outputSchema violations but preserve isError", async () => {
  await withModern(m => m.method === "tools/call" ? { jsonrpc: "2.0", id: m.id, result: { resultType: "complete", content: [{ type: "text", text: "bad" }], structuredContent: { answer: 123 } } } : modernHandler(m), async c => {
    await assert.rejects(c.callTool("echo", {}), /outputSchema/);
  });
  const f = await pipedLegacy();
  const { CallToolRequestSchema } = await import("@modelcontextprotocol/sdk/types.js");
  f.server.setRequestHandler(CallToolRequestSchema, async req => ({ content: [{ type: "text", text: "bad" }], structuredContent: { answer: 123 }, isError: req.params.arguments?.error === true }));
  const c = await McpConnection.open({ def: stdioDef(), clock: systemClock, logger: capturingLogger(), redactor: createRedactor(), hostEnv: {}, onToolsChanged: () => {}, onRemoteClose: () => {}, transportFactory: () => f.client });
  try { await assert.rejects(c.callTool("echo", {}), /outputSchema/); assert.equal((await c.callTool("echo", { error: true })).isError, true); }
  finally { await c.close("graceful"); await f.close(); }
});
it("unknown modern versions and recognized modern errors never silently downgrade", async () => {
  const f = await pipedModern(m => ({ jsonrpc: "2.0", id: m.id, error: { code: -32022, message: "unsupported", data: { supported: ["2099-01-01"] } } }));
  try {
    await assert.rejects(McpConnection.open({ def: stdioDef(), clock: systemClock, logger: capturingLogger(), redactor: createRedactor(), hostEnv: {}, onToolsChanged: () => {}, onRemoteClose: () => {}, transportFactory: () => f.client }), /unsupported|rejected/);
    assert.ok(f.requests.every(m => m.method !== "initialize"));
  } finally { await f.close(); }
});
it("modern tool headers encode nested primitive values and refuse unreachable or duplicate annotations", () => {
  const extract = toolHeaderExtractor({ properties: { nested: { type: "object", properties: { x: { type: "integer", "x-mcp-header": "X" } } }, y: { type: "string", "x-mcp-header": "Y" } } });
  assert.deepEqual(extract({ nested: { x: 42 }, y: "line\nbreak" }), { "Mcp-Param-X": "42", "Mcp-Param-Y": "=?base64?bGluZQpicmVhaw==?=" });
  assert.throws(() => extract({ nested: { x: 1.5 } }), /type/);
  for (const schema of [
    { properties: { x: { type: "string", "x-mcp-header": "Bad\r\n" } } },
    { properties: { x: { type: "number", "x-mcp-header": "X" } } },
    { anyOf: [{ properties: { x: { type: "string", "x-mcp-header": "X" } } }] },
    { properties: { x: { type: "string", "x-mcp-header": "X" }, y: { type: "string", "x-mcp-header": "x" } } },
  ]) assert.throws(() => toolHeaderExtractor(schema), /invalid/);
});

it("modern resource/prompt listings reject malformed entries before aggregate consumers see them", async () => {
  for (const feature of ["resources", "prompts"] as const) {
    await withModern(m => m.method === `${feature}/list` ? { jsonrpc: "2.0", id: m.id, result: { resultType: "complete", ttlMs: 0, cacheScope: "private", [feature]: [{}] } } : modernHandler(m), async c => {
      await assert.rejects(feature === "resources" ? c.listResources() : c.listPrompts());
    });
  }
});

it("output schemas are isolated per tool even when a server reuses the same $id", async () => {
  await withModern(m => {
    if (m.method === "tools/list") return { jsonrpc: "2.0", id: m.id, result: { resultType: "complete", ttlMs: 0, cacheScope: "private", tools: [
      { ...tool, outputSchema: { $id: "test://same", type: "object", required: ["answer"], properties: { answer: { type: "string" } } } },
      { ...tool, name: "number", outputSchema: { $id: "test://same", type: "object", required: ["answer"], properties: { answer: { type: "number" } } } },
    ] } };
    return modernHandler(m);
  }, async c => { await assert.rejects(c.callTool("number", { text: "a string" }), /outputSchema/); });
});
