import { it } from "node:test";
import assert from "node:assert/strict";
import { McpConnection } from "../../src/mcp/connection.ts";
import { createRedactor } from "../../src/mcp/redact.ts";
import { systemClock } from "../../src/mcp/clock.ts";
import { pipedLegacy, pipedModern, httpModern, legacyServer } from "./helpers/dual-fixture.ts";
import { startFixtureHttp } from "./helpers/fixture-http.ts";
import { stdioDef, httpDef, capturingLogger } from "./helpers/util.ts";

for (const era of ["2026-07-28", "2025-11-25"] as const) for (const transport of ["stdio", "http"] as const) {
  it(`${era} ${transport}: common conformance tools/resources/prompts and stored capabilities`, async () => {
    const piped = transport === "stdio" ? era === "2026-07-28" ? await pipedModern() : await pipedLegacy() : undefined;
    const http = transport === "http" ? era === "2026-07-28" ? await httpModern() : await startFixtureHttp(() => ({ server: legacyServer(), state: { clientCapabilities: undefined, clientVersion: undefined, setLevelCalls: 0, calls: [] } })) : undefined;
    const def = http ? httpDef(http.url + (era === "2026-07-28" ? "/sse" : "")) : stdioDef();
    const conn = await McpConnection.open({ def, clock: systemClock, logger: capturingLogger(), redactor: createRedactor(), hostEnv: {},
      onToolsChanged: () => {}, onRemoteClose: () => {}, ...(piped ? { transportFactory: () => piped.client } : {}) });
    try {
      assert.equal(conn.protocolVersion, era);
      assert.ok(conn.serverCapabilities.tools);
      assert.equal(conn.clientCapabilities.sampling, undefined);
      const tools = await conn.listTools(); assert.ok(tools.some(t => t.name === "echo"));
      assert.equal((await conn.callTool("echo", { text: "ok" })).isError ?? false, false);
      assert.equal((await conn.listResources())[0]?.uri, "test://one");
      assert.equal((await conn.listResourceTemplates())[0]?.uriTemplate, "test://{id}");
      assert.equal((await conn.readResource("test://one")).contents[0]?.text, "resource");
      assert.equal((await conn.listPrompts())[0]?.name, "greet");
      assert.equal((await conn.getPrompt("greet")).messages[0]?.role, "user");
      await conn.subscribeResource("test://one"); await conn.unsubscribeResource("test://one");
      if (era === "2025-11-25") await conn.ping();
    } finally { await conn.close("graceful"); await piped?.close(); await http?.close(); }
  });
}
it("modern HTTP carries mandatory metadata headers and uses neither session nor GET", async () => {
  const http = await httpModern();
  const conn = await McpConnection.open({ def: httpDef(http.url + "/json"), clock: systemClock, logger: capturingLogger(), redactor: createRedactor(), hostEnv: {}, onToolsChanged: () => {}, onRemoteClose: () => {} });
  try {
    await conn.listTools(); await conn.callTool("echo", { text: " 世界 " });
    const call = http.requests.find(r => r.body.method === "tools/call")!;
    assert.equal(call.headers["mcp-method"], "tools/call");
    assert.equal(call.headers["mcp-name"], "echo");
    assert.match(String(call.headers["mcp-param-text"]), /^=\?base64\?/);
    assert.equal(call.headers["mcp-protocol-version"], "2026-07-28");
    assert.equal(call.headers["mcp-session-id"], undefined);
    assert.ok(http.requests.every(r => r.method === "POST"));
  } finally { await conn.close("graceful"); await http.close(); }
});
