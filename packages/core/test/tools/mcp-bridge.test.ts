import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mcpToolDefs, type McpToolPort } from "../../src/tools/mcp-bridge.ts";
import { ToolDispatcher, type DispatchContext } from "../../src/tools/dispatcher.ts";
import { ToolRegistry } from "../../src/tools/registry.ts";
import type { McpCaller, McpToolDescriptor, McpToolResult } from "../../src/mcp/types.ts";
import { lastNonce, rig, tick } from "../approvals/service-helpers.ts";

const T = { timeout: 20_000 };
const schema = { type: "object", additionalProperties: false, properties: { q: { type: "string" } } };
const result = (tool: string): McpToolResult => ({
  provenance: { origin: { system: "mcp:srv", agent: "bernd", principal: "christian", trust: "untrusted" }, hops: 1, transformedBy: [] },
  server: "srv", tool, isError: false, content: [{ type: "text", text: "ok" }],
});

function port(tools: McpToolDescriptor[]) {
  const calls: { server: string; tool: string; args: unknown; caller: McpCaller }[] = [];
  const p: McpToolPort = {
    async listTools() { return tools; },
    async callTool(server, tool, args, caller) { calls.push({ server, tool, args, caller }); return result(tool); },
  };
  return { p, calls };
}
const ctx = (o: Partial<DispatchContext> = {}): DispatchContext => ({ agentId: "bernd", principal: "christian", sessionId: "s1", taskId: "t1", surface: 3, signal: new AbortController().signal, ...o });

async function setup(tools: McpToolDescriptor[], policy: Record<string, unknown> = {}) {
  const r = await rig();
  const { p, calls } = port(tools);
  const built = await mcpToolDefs(p, "srv", { agentId: "bernd", principal: "christian" });
  const registry = new ToolRegistry();
  for (const t of built.tools) registry.register(t);
  const d = new ToolDispatcher({ registry, approvals: r.service, grants: r.stores.grants, grantUse: r.stores.grants, clock: r.clock, timers: r.timers, policyContext: r.service.policyContext(() => policy) });
  return { r, d, calls, built, registry };
}

describe("MCP tools go through the dispatcher (D109 §7)", () => {
  it("maps each server tool to a registered tool of capability net.submit; an undeclared effect is external", T, async () => {
    const { built } = await setup([{ name: "Search-Docs", inputSchema: schema, description: "d" }, { name: "write", inputSchema: schema, annotations: { destructiveHint: true } }]);
    assert.deepEqual(built.tools.map((t) => t.name), ["mcp.srv.search-docs", "mcp.srv.write"]);
    for (const t of built.tools) { assert.equal(t.capability, "net.submit"); assert.equal(t.trust, "untrusted"); }
    assert.equal(built.tools[0]!.effect, "external");
    assert.equal(built.tools[1]!.risk, "high", "a destructive hint raises the risk");
  });

  it("a readOnlyHint cannot lower a tool's class: the call still asks", T, async () => {
    const { r, d, calls } = await setup([{ name: "peek", inputSchema: schema, annotations: { readOnlyHint: true } }]);
    const p = d.call({ id: "c1", name: "mcp.srv.peek", args: { q: "x" } }, ctx());
    await tick();
    assert.equal(r.stores.approvals.list({ status: "pending" }).length, 1);
    assert.equal(calls.length, 0, "the server is not called before the person decides");
    r.service.dispose();
    await p;
  });

  it("denied: the MCP server is never called. approved: it is called once, as the dispatching agent and principal", T, async () => {
    const { r, d, calls } = await setup([{ name: "send", inputSchema: schema }]);
    const denied = d.call({ id: "c1", name: "mcp.srv.send", args: { q: "a" } }, ctx());
    await tick();
    const first = lastNonce(r);
    r.service.decide({ requestId: first.id, nonce: first.nonce, decision: "deny", person: "christian", surface: 3 });
    assert.equal((await denied).isError, true);
    assert.equal(calls.length, 0);

    const ok = d.call({ id: "c2", name: "mcp.srv.send", args: { q: "b" } }, ctx({ agentId: "bernd" }));
    await tick();
    const second = lastNonce(r);
    assert.ok(r.service.decide({ requestId: second.id, nonce: second.nonce, decision: "approve", person: "christian", surface: 3 }).ok);
    const res = await ok;
    assert.equal(res.isError, false);
    assert.equal(res.meta.decision, "approved");
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0], { server: "srv", tool: "send", args: { q: "b" }, caller: { agentId: "bernd", principal: "christian" } });
  });

  it("tools.deny on the capability refuses it before anything is asked or called", T, async () => {
    const { r, d, calls } = await setup([{ name: "send", inputSchema: schema }], { toolsDeny: ["net.submit"] });
    const res = await d.call({ id: "c1", name: "mcp.srv.send", args: {} }, ctx());
    assert.equal(res.isError && res.error.code, "tool-denied");
    assert.equal(calls.length, 0);
    assert.equal(r.stores.approvals.list().length, 0);
  });

  it("invalid schemas, unmappable names and collisions are skipped and reported, never registered", T, async () => {
    const { built } = await setup([
      { name: "ok", inputSchema: schema },
      { name: "bad-schema", inputSchema: { type: "string" } as never },
      { name: "x".repeat(80), inputSchema: schema },
      { name: "Ok", inputSchema: schema },
      { name: "!!!", inputSchema: schema },
    ]);
    assert.deepEqual(built.tools.map((t) => t.name), ["mcp.srv.ok"]);
    assert.deepEqual(built.skipped.map((s) => s.tool).sort(), ["!!!", "Ok", "bad-schema", "x".repeat(80)].sort());
  });

  it("the arguments cannot pick another agent or principal: the caller comes from the dispatch context", T, async () => {
    const { r, d, calls } = await setup([{ name: "send", inputSchema: { type: "object", properties: { agentId: { type: "string" } } } }]);
    const p = d.call({ id: "c1", name: "mcp.srv.send", args: { agentId: "mallory" } }, ctx({ agentId: "bernd" }));
    await tick();
    const n = lastNonce(r);
    r.service.decide({ requestId: n.id, nonce: n.nonce, decision: "approve", person: "christian", surface: 3 });
    await p;
    assert.equal(calls[0]!.caller.agentId, "bernd");
  });
});
