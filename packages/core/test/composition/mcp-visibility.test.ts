/** M-A5: turn descriptor snapshots and live execution authority are separate boundaries. */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { composeTools, type ToolCompositionOptions } from "../../src/composition/tools.ts";
import type { McpToolPort } from "../../src/tools/mcp-bridge.ts";
import type { ChatRequest } from "../../src/session/provider.ts";
import type { ToolRunContext } from "../../src/tools/registry.ts";
import { useTempDirs } from "./helpers.ts";

const tmp = useTempDirs("p1b-mcp-visibility-");
const signal = new AbortController().signal;
const turn = (agentId: string): ChatRequest => ({ agentId, principal: "canonical-person", sessionId: "s1",
  messages: [], summaries: [], memory: "", signal });
const run = (agentId: string): ToolRunContext => ({ agentId, principal: "approver-person", sessionId: "s1",
  signal, surface: 0 });

function fixture() {
  let enabled = true;
  let agents = ["A"];
  let serverNames = ["reports"];
  let title = "first descriptor";
  const listed: string[] = [];
  const invoked: unknown[] = [];
  let refreshes = 0;
  let generation = 1;
  const port: McpToolPort = {
    async listTools(_server, caller) {
      listed.push(caller.agentId);
      return [{ name: "query", description: title, inputSchema: { type: "object", properties: {} } }];
    },
    async callTool(server, tool, args, caller) {
      invoked.push({ server, tool, args, caller });
      return { server, tool, isError: false, content: [], provenance: {
        origin: { system: server, agent: caller.agentId, principal: caller.principal, trust: "untrusted" },
        hops: 0, transformedBy: [],
      } };
    },
  };
  const options: ToolCompositionOptions = { home: tmp.make(), roots: [], audit: { append() {} } as never,
    grants: { get: () => undefined, list: () => [] }, mcp: {
      port, servers: () => serverNames, refresh: async () => { refreshes++; },
      visible: (server, agent) => server === "reports" && enabled && agents.includes(agent),
      declaration: () => ({ network: "none", tools: [{ name: "query", effect: "read" }] }),
      revision: () => generation,
    } };
  return { options, listed, invoked, refreshes: () => refreshes,
    disable: () => { enabled = false; }, enable: () => { enabled = true; },
    agents: (next: string[]) => { agents = next; },
    descriptor: (next: string) => { title = next; }, servers: (next: string[]) => { serverNames = next; },
    replace: () => { generation++; } };
}

describe("M-A5 MCP agent visibility", () => {
  it("only discovers the server for enabled agents and carries the manifest declaration into policy", async () => {
    const f = fixture();
    const a = await composeTools(f.options, turn("A"));
    const b = await composeTools(f.options, turn("B"));
    const tool = a.entries().find(tool => tool.name === "mcp.reports.query")!;
    assert.ok(tool);
    assert.equal(tool.effect, "read");
    assert.equal(b.entries().some(tool => tool.name.startsWith("mcp.")), false);
    assert.deepEqual(f.listed, ["A"], "invisible servers must not even be contacted");
    assert.equal(f.refreshes(), 2);
  });

  it("updates tool visibility and descriptors at the next turn while retaining the current turn snapshot", async () => {
    const f = fixture();
    const first = await composeTools(f.options, turn("A"));
    const original = first.entries().find(tool => tool.name === "mcp.reports.query")!;
    f.descriptor("second descriptor");
    f.agents(["B"]);
    const nextA = await composeTools(f.options, turn("A"));
    const nextB = await composeTools(f.options, turn("B"));
    assert.equal(original.description, "first descriptor");
    assert.equal(first.entries().some(tool => tool.name === original.name), true);
    assert.equal(nextA.entries().some(tool => tool.name === original.name), false);
    assert.equal(nextB.entries().find(tool => tool.name === original.name)?.description, "second descriptor");
    f.servers([]);
    assert.equal(nextB.entries().some(tool => tool.name === original.name), true);
    assert.equal((await composeTools(f.options, turn("B"))).entries().some(tool => tool.name === original.name), false);
  });

  it("rechecks live authority immediately before invoking a tool from an already admitted turn", async () => {
    const f = fixture();
    const registry = await composeTools(f.options, turn("A"));
    const tool = registry.entries().find(tool => tool.name === "mcp.reports.query")!;
    await tool.execute({}, run("A"));
    assert.equal(f.invoked.length, 1);
    assert.deepEqual((f.invoked[0] as { caller: unknown }).caller,
      { agentId: "A", principal: "canonical-person" });
    f.disable();
    await assert.rejects(() => tool.execute({}, run("A")), error =>
      error instanceof Error && "code" in error && error.code === "not-allowed");
    f.enable();
    f.agents(["B"]);
    await assert.rejects(() => tool.execute({}, run("A")), /MCP server is no longer enabled for this agent/);
    assert.equal(f.invoked.length, 1, "a stale turn must not dispatch after disable or agent revocation");
  });

  it("refuses an old descriptor snapshot after replacement changes the server registration", async () => {
    const f = fixture();
    const old = (await composeTools(f.options, turn("A"))).entries().find(tool => tool.name === "mcp.reports.query")!;
    f.replace();
    await assert.rejects(() => old.execute({}, run("A")), /MCP server is no longer enabled for this agent/);
    assert.equal(f.invoked.length, 0);
    const next = (await composeTools(f.options, turn("A"))).entries().find(tool => tool.name === old.name)!;
    await next.execute({}, run("A"));
    assert.equal(f.invoked.length, 1);
  });
});
