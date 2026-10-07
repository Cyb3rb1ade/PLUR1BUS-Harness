import { it } from "node:test";
import assert from "node:assert/strict";
import { McpConnection } from "../../src/mcp/connection.ts";
import { systemClock } from "../../src/mcp/clock.ts";
import { createRedactor } from "../../src/mcp/redact.ts";
import { pipedLegacy, pipedModern, modernHandler } from "./helpers/dual-fixture.ts";
import { capturingLogger, stdioDef } from "./helpers/util.ts";
import type { McpClientPorts } from "../../src/mcp/ports.ts";

const ports: McpClientPorts = {
  roots: { list: async () => ({ roots: [{ uri: "file:///fixture", name: "fixture" }] }) },
  sampling: { createMessage: async () => ({ role: "assistant", model: "fake", content: { type: "text", text: "sampled" } }) },
  elicitation: { create: async () => ({ action: "accept", content: { answer: "yes" } }) },
};
for (const era of ["2026-07-28", "2025-11-25"] as const) {
  it(`${era}: roots/sampling/elicitation reach explicit ports and defaults deny`, async () => {
    for (const enabled of [true, false]) {
      const requests = { roots: { method: "roots/list" }, sampling: { method: "sampling/createMessage", params: { messages: [{ role: "user" as const, content: { type: "text" as const, text: "sample" } }], maxTokens: 10 } },
        elicitation: { method: "elicitation/create", params: { message: "Confirm", requestedSchema: { type: "object", properties: { answer: { type: "string" } } } } } };
      const piped = era === "2026-07-28" ? await pipedModern(message => {
        if (message.method !== "tools/call") return modernHandler(message);
        const params = message.params as Record<string, unknown>;
        if (!params.inputResponses) return { jsonrpc: "2.0", id: message.id, result: { resultType: "input_required", requestState: "opaque-state", inputRequests: requests } };
        assert.equal(params.requestState, "opaque-state");
        assert.equal(((params.inputResponses as Record<string, unknown>).sampling as { model: string }).model, "fake");
        return modernHandler(message);
      }) : await pipedLegacy();
      const conn = await McpConnection.open({ def: stdioDef(), clock: systemClock, logger: capturingLogger(), redactor: createRedactor(), hostEnv: {}, onToolsChanged: () => {}, onRemoteClose: () => {}, ports: enabled ? ports : {}, transportFactory: () => piped.client });
      try {
        assert.equal(!!conn.clientCapabilities.roots, enabled);
        if (era === "2026-07-28") {
          if (enabled) await conn.callTool("echo", { text: "ok" });
          else await assert.rejects(conn.callTool("echo", { text: "ok" }), /disabled/);
        } else {
          const server = (piped as Awaited<ReturnType<typeof pipedLegacy>>).server;
          if (enabled) {
            assert.equal((await server.listRoots()).roots[0]?.uri, "file:///fixture");
            assert.equal((await server.createMessage(requests.sampling.params)).model, "fake");
            assert.equal((await server.elicitInput(requests.elicitation.params as never)).action, "accept");
            await conn.rootsChanged();
          } else await assert.rejects(server.listRoots(), /capability|not support|Method not found/i);
        }
      } finally { await conn.close("graceful"); await piped.close(); }
    }
  });
}
it("modern MRTR is bounded even when a client port ignores cancellation", async () => {
  const piped = await pipedModern(m => m.method !== "tools/call" ? modernHandler(m) : { jsonrpc: "2.0", id: m.id, result: { resultType: "input_required", inputRequests: { roots: { method: "roots/list" } } } });
  const conn = await McpConnection.open({ def: stdioDef({ timeouts: { callMs: 50 } }), clock: systemClock, logger: capturingLogger(), redactor: createRedactor(), hostEnv: {}, onToolsChanged: () => {}, onRemoteClose: () => {},
    ports: { roots: { list: async () => await new Promise<never>(() => {}) } }, transportFactory: () => piped.client });
  try { await assert.rejects(conn.callTool("echo", { text: "ok" }), (e: { code?: string }) => e.code === "call-timeout"); }
  finally { await conn.close("graceful"); await piped.close(); }
});

it("client ports bound inbound requests and discard even MCP-shaped secret exceptions", async () => {
  const { dispatchPort } = await import("../../src/mcp/ports.ts");
  const { McpError } = await import("@modelcontextprotocol/sdk/types.js");
  const context = { server: "test", signal: new AbortController().signal, timeoutMs: 50 };
  await assert.rejects(dispatchPort("roots/list", {}, { roots: { list: async () => await new Promise<never>(() => {}) } }, context), /timed out/);
  await assert.rejects(dispatchPort("roots/list", {}, { roots: { list: async () => { throw new McpError(-32603, "fake-secret-value"); } } }, context), e => !String(e).includes("fake-secret-value"));
});

for (const era of ["2026-07-28", "2025-11-25"] as const) it(`${era}: all client ports work on HTTP response streams`, async () => {
  const { httpModern, legacyServer } = await import("./helpers/dual-fixture.ts");
  const { startFixtureHttp } = await import("./helpers/fixture-http.ts");
  const { httpDef } = await import("./helpers/util.ts");
  const { CallToolRequestSchema } = await import("@modelcontextprotocol/sdk/types.js");
  const inputRequests = { roots: { method: "roots/list" }, sampling: { method: "sampling/createMessage", params: { messages: [{ role: "user" as const, content: { type: "text" as const, text: "hello" } }], maxTokens: 10 } }, elicitation: { method: "elicitation/create", params: { message: "Question", requestedSchema: { type: "object", properties: { answer: { type: "string" } } } } } };
  const f = era === "2026-07-28" ? await httpModern(m => {
    if (m.method !== "tools/call") return modernHandler(m);
    if (!(m.params as Record<string, unknown>).inputResponses) return { jsonrpc: "2.0", id: m.id, result: { resultType: "input_required", inputRequests } };
    assert.deepEqual(Object.keys((m.params as Record<string, unknown>).inputResponses as object).sort(), ["elicitation", "roots", "sampling"]);
    return modernHandler(m);
  }) : await startFixtureHttp(() => {
    const server = legacyServer();
    server.setRequestHandler(CallToolRequestSchema, async () => {
      assert.equal((await server.listRoots()).roots[0]?.uri, "file:///fixture");
      assert.equal((await server.createMessage(inputRequests.sampling.params)).model, "fake");
      assert.equal((await server.elicitInput(inputRequests.elicitation.params as never)).action, "accept");
      return { content: [{ type: "text", text: "ok" }], structuredContent: { answer: "ok" } };
    });
    return { server, state: { clientCapabilities: undefined, clientVersion: undefined, setLevelCalls: 0, calls: [] } };
  });
  const c = await McpConnection.open({ def: httpDef(f.url + (era === "2026-07-28" ? "/sse" : "")), clock: systemClock, logger: capturingLogger(), redactor: createRedactor(), hostEnv: {}, onToolsChanged: () => {}, onRemoteClose: () => {}, ports });
  try { assert.deepEqual((await c.callTool("echo", { text: "ok" })).structuredContent, { answer: "ok" }); }
  finally { await c.close("graceful"); await f.close(); }
});
