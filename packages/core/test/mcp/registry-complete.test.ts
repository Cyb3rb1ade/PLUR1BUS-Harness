import { it } from "node:test";
import assert from "node:assert/strict";
import { McpRegistry } from "../../src/mcp/registry.ts";
import { httpModern } from "./helpers/dual-fixture.ts";
import { caller, capturingLogger } from "./helpers/util.ts";

it("registry aggregates parallel servers with collision-free names and remembers the negotiated era", async () => {
  const a = await httpModern(); const b = await httpModern();
  const reg = new McpRegistry({ logger: capturingLogger() });
  try {
    reg.register({ name: "a", transport: { type: "http", url: a.url + "/json" } });
    reg.register({ name: "b", transport: { type: "http", url: b.url + "/json" } });
    const snapshot = await reg.aggregate(caller);
    assert.deepEqual(snapshot.tools.map(t => t.name).sort(), ["a::echo", "b::echo"]);
    assert.equal(snapshot.resources.length, 2); assert.equal(snapshot.prompts.length, 2);
    assert.equal(reg.status("a", caller.agentId).protocolVersion, "2026-07-28");
    assert.equal(reg.status("a", caller.agentId).connectionState, "ready");
    assert.deepEqual(snapshot.errors, []);
  } finally { await reg.shutdown(); await a.close(); await b.close(); }
});
