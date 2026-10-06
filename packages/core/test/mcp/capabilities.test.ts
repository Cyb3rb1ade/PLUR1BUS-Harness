// ADR-014 §5 / ADR-008 conformance row: the client negotiates no Sampling, Roots or Logging, and still works
// against a server that offers (and then demands) all three.
import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import { McpConnection } from "../../src/mcp/connection.ts";
import { createRedactor } from "../../src/mcp/redact.ts";
import { systemClock } from "../../src/mcp/clock.ts";
import type { McpServerDefinition } from "../../src/mcp/types.ts";
import { startFixtureHttp, type FixtureHttp } from "./helpers/fixture-http.ts";
import { capturingLogger, httpDef, stdioDef } from "./helpers/util.ts";

let http: FixtureHttp;

async function probe(def: McpServerDefinition) {
  const conn = await McpConnection.open({ def, clock: systemClock, logger: capturingLogger(), redactor: createRedactor(), hostEnv: {}, onToolsChanged: () => {}, onRemoteClose: () => {} });
  try {
    const first = await conn.callTool("probe_client", {});
    // The server pushes a logging notification: the client must ignore it and keep serving.
    await conn.callTool("log_now", {});
    const echo = await conn.callTool("echo", { text: "still works" });
    const second = await conn.callTool("probe_client", {});
    const text = (r: { content?: unknown }) => (r.content as Array<{ text: string }>)[0]!.text;
    return { first: JSON.parse(text(first)), second: JSON.parse(text(second)), echo: text(echo), serverCaps: conn.serverInfo };
  } finally { await conn.close("graceful"); }
}

describe("mcp negative capabilities: Sampling, Roots and Logging are not negotiated", { timeout: 60_000 }, async () => {
  http = await startFixtureHttp();
  after(async () => { await http.close(); });

  for (const [label, mk] of [["stdio", () => stdioDef()], ["streamable http", () => httpDef(http.url)]] as Array<[string, () => McpServerDefinition]>) {
    it(`${label}: the handshake declares no client capability`, async () => {
      const r = await probe(mk());
      assert.deepEqual(r.first.clientCapabilities, {}, "client capabilities in initialize must be empty");
      for (const cap of ["sampling", "roots", "logging", "elicitation"]) assert.ok(!(cap in r.first.clientCapabilities), cap);
    });
    it(`${label}: sampling/createMessage and roots/list from the server are refused (method not found)`, async () => {
      const r = await probe(mk());
      for (const k of ["sampling", "roots"] as const) {
        assert.equal(r.first[k].ok, false, k);
        assert.equal(r.first[k].code, -32601, k);
      }
    });
    it(`${label}: logging is never used and the client keeps working`, async () => {
      const r = await probe(mk());
      assert.equal(r.echo, "echo:still works");
      assert.equal(r.second.setLevelCalls, 0, "logging/setLevel must never be sent");
    });
  }
});
