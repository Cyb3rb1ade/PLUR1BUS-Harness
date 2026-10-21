import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { McpConnection } from "../../src/mcp/connection.ts";
import { systemClock } from "../../src/mcp/clock.ts";
import { createRedactor } from "../../src/mcp/redact.ts";
import { sanitizeOutputSchema } from "../../src/mcp/output-schema.ts";
import { pipedModern, modernHandler, tool } from "./helpers/dual-fixture.ts";
import { stdioDef, capturingLogger } from "./helpers/util.ts";

type Handler = Parameters<typeof pipedModern>[0];
async function withServer(outputSchema: Record<string, unknown>, structuredContent: unknown, run: (c: McpConnection) => Promise<void>) {
  const handler: Handler = m => {
    if (m.method === "tools/list") return { jsonrpc: "2.0", id: m.id, result: { resultType: "complete", ttlMs: 0, cacheScope: "private", tools: [{ ...tool, outputSchema }] } };
    if (m.method === "tools/call") return { jsonrpc: "2.0", id: m.id, result: { resultType: "complete", content: [{ type: "text", text: "ok" }], structuredContent } };
    return modernHandler(m);
  };
  const fixture = await pipedModern(handler);
  const conn = await McpConnection.open({ def: stdioDef(), clock: systemClock, logger: capturingLogger(), redactor: createRedactor(), hostEnv: {}, onToolsChanged: () => {}, onRemoteClose: () => {}, transportFactory: () => fixture.client });
  try { await run(conn); } finally { await conn.close("graceful"); await fixture.close(); }
}

// 30 characters block the event loop for ~15 s with an unguarded `^(a+)+$` (audit mcp #1).
const EVIL = "a".repeat(30) + "!";

describe("mcp outputSchema from a server is not allowed to run its own regular expressions", () => {
  it("a catastrophic `pattern` does not stall validation", async () => {
    await withServer({ type: "object", properties: { v: { type: "string", pattern: "^(a+)+$" } } }, { v: EVIL }, async c => {
      const t0 = performance.now();
      const result = await c.callTool("echo", {});
      assert.ok(performance.now() - t0 < 1000, "validation must finish in under a second");
      assert.deepEqual(result.structuredContent, { v: EVIL });
    });
  });
  it("a catastrophic `patternProperties` and `propertyNames.pattern` do not stall validation", async () => {
    await withServer({ type: "object", patternProperties: { "^(a+)+$": { type: "string" } }, propertyNames: { pattern: "^(a+)+$" } }, { [EVIL]: "x" }, async c => {
      const t0 = performance.now();
      await c.callTool("echo", {});
      assert.ok(performance.now() - t0 < 1000);
    });
  });
  it("the rest of the schema is still enforced", async () => {
    const schema = { type: "object", required: ["v"], properties: { v: { type: "string", pattern: "^(a+)+$", maxLength: 40 } } };
    await withServer(schema, { v: 123 }, async c => { await assert.rejects(c.callTool("echo", {}), /outputSchema/); });
    await withServer(schema, {}, async c => { await assert.rejects(c.callTool("echo", {}), /outputSchema/); });
    await withServer(schema, { v: "a".repeat(41) }, async c => { await assert.rejects(c.callTool("echo", {}), /outputSchema/); });
    await withServer(schema, { v: "aaa" }, async c => { assert.deepEqual((await c.callTool("echo", {})).structuredContent, { v: "aaa" }); });
  });
  it("the descriptor handed to callers keeps the server's own schema", async () => {
    const schema = { type: "object", properties: { v: { type: "string", pattern: "^a$" } } };
    await withServer(schema, { v: "a" }, async c => { assert.deepEqual((await c.listTools())[0]?.outputSchema, schema); });
  });
});

describe("sanitizeOutputSchema", () => {
  it("removes pattern and patternProperties in every subschema position", () => {
    const out = sanitizeOutputSchema({
      type: "object", pattern: "^(a+)+$", patternProperties: { "^x": { type: "string" } },
      properties: { a: { type: "array", items: { type: "string", pattern: "x" } }, b: { anyOf: [{ pattern: "y" }, { type: "null" }] } },
      $defs: { d: { type: "string", pattern: "z" } }, propertyNames: { pattern: "w" },
    });
    assert.ok(!JSON.stringify(out).includes("pattern\""), JSON.stringify(out));
    assert.ok(!JSON.stringify(out).includes("patternProperties"));
    assert.deepEqual((out as { properties: unknown }).properties, { a: { type: "array", items: { type: "string" } }, b: { anyOf: [{}, { type: "null" }] } });
  });
  it("keeps a property that is merely called `pattern`, and data in enum/const/default", () => {
    const schema = { type: "object", required: ["pattern"], properties: { pattern: { type: "string", enum: ["^a$"] }, k: { const: { pattern: "keep" } }, d: { default: { patternProperties: 1 } } } };
    assert.deepEqual(sanitizeOutputSchema(schema), schema);
  });
  it("does not let additionalProperties:false reject the properties a removed patternProperties allowed", () => {
    const out = sanitizeOutputSchema({ type: "object", patternProperties: { "^x_": { type: "string" } }, additionalProperties: false }) as Record<string, unknown>;
    assert.equal("additionalProperties" in out, false);
    const keep = sanitizeOutputSchema({ type: "object", properties: { a: { type: "string" } }, additionalProperties: false });
    assert.deepEqual(keep, { type: "object", properties: { a: { type: "string" } }, additionalProperties: false });
  });
  it("does not mutate its input and survives a __proto__ key", () => {
    const schema = JSON.parse('{"type":"object","properties":{"__proto__":{"type":"string","pattern":"x"}}}') as Record<string, unknown>;
    const before = JSON.stringify(schema);
    const out = sanitizeOutputSchema(schema) as { properties: Record<string, unknown> };
    assert.equal(JSON.stringify(schema), before);
    assert.deepEqual(Object.keys(out.properties), ["__proto__"]);
    assert.equal(Object.getPrototypeOf(out.properties), Object.prototype);
  });
});
