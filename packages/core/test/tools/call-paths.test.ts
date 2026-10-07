// D109 §7: `policy.decide` in the dispatcher is the one path every tool call takes. This file guards that statically (no new
// place in src may execute a tool or call an MCP server on its own) and end to end (the turn loop, the MCP bridge).
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Compactor, defaultCompaction } from "../../src/session/compaction.ts";
import type { TurnMemory } from "../../src/session/memory-port.ts";
import type { ChatChunk, ChatProvider, ChatRequest } from "../../src/session/provider.ts";
import { SessionStore } from "../../src/session/store.ts";
import { TurnRunner } from "../../src/session/turn-loop.ts";
import { ToolDispatcher } from "../../src/tools/dispatcher.ts";
import { ToolRegistry } from "../../src/tools/registry.ts";
import { createPolicyAudit } from "../../src/policy/audit.ts";
import { lastNonce, rig, tick } from "../approvals/service-helpers.ts";

const T = { timeout: 30_000 };
const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../src");

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((n) => {
    const f = path.join(dir, n);
    return statSync(f).isDirectory() ? files(f) : f.endsWith(".ts") ? [f] : [];
  });
}
const rel = (f: string): string => path.relative(SRC, f).split(path.sep).join("/");
const all = files(SRC).map((f) => ({ file: rel(f), text: readFileSync(f, "utf8").split("\n").filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join("\n") }));
const sitesOf = (re: RegExp): string[] => all.filter((f) => re.test(f.text)).map((f) => f.file).sort();

describe("every way a tool can run goes through dispatcher.call (static guard)", () => {
  it("tool.execute( is called by the dispatcher only; callWithRepair (a test-only helper) is used by nothing in src", () => {
    // tools/repair.ts defines the helper that calls execute; it must not be imported from anywhere in src.
    assert.deepEqual(sitesOf(/\.execute\(/), ["tools/dispatcher.ts", "tools/repair.ts"]);
    assert.deepEqual(sitesOf(/\bcallWithRepair\b/), ["tools/repair.ts"], "callWithRepair would run a tool without the policy gate");
  });

  it("an MCP server is called through McpRegistry.callTool, and McpRegistry is reached only from src/mcp and the dispatcher's bridge", () => {
    assert.deepEqual(sitesOf(/\bcallTool\(/), ["mcp/connection.ts", "mcp/registry.ts", "tools/mcp-bridge.ts"]);
    const users = sitesOf(/\bMcpRegistry\b/).filter((f) => !f.startsWith("mcp/"));
    assert.deepEqual(users, [], "a new McpRegistry user must register its tools through tools/mcp-bridge.ts");
  });

  it("a ToolDispatcher is the only thing that takes a tool out of a ToolRegistry", () => {
    const getters = all.filter((f) => /\bregistry\.get\(|#tools\.get\(|\.registry\.get\(/.test(f.text)).map((f) => f.file).sort();
    assert.deepEqual(getters, ["tools/dispatcher.ts", "tools/registry.ts"]);
  });

  it("ACP, A2A and the host adapter never execute tools themselves", () => {
    for (const f of all.filter((x) => /^(acp|a2a)\//.test(x.file) || x.file === "host.ts")) {
      assert.ok(!/\.execute\(|callTool\(|ToolRegistry/.test(f.text), `${f.file} must reach tools through the turn loop and the dispatcher only`);
    }
  });
});

const CALLER = { channel: "cli" as const, accountId: "acc", userId: "u" };
const memory: TurnMemory = { async recall() { return { text: "", degraded: null }; }, async capture() {}, async checkpoint() {} };
class Scripted implements ChatProvider {
  readonly id = "scripted";
  readonly chunks: ChatChunk[];
  constructor(chunks: ChatChunk[]) { this.chunks = chunks; }
  async *stream(_req: ChatRequest): AsyncGenerator<ChatChunk> { for (const c of this.chunks) yield c; }
}

describe("the turn loop's tool call reaches the approval service through the dispatcher", () => {
  it("an external tool asked for by the model parks the turn until a person approves; approval runs it once", T, async () => {
    const r = await rig();
    const store = new SessionStore({ path: ":memory:" });
    const registry = new ToolRegistry();
    const ran: unknown[] = [];
    registry.register({ name: "demo.net", description: "net", capability: "net.submit", effect: "external", risk: "medium", inputSchema: { type: "object", properties: {} }, execute: async () => { ran.push("net"); return "sent"; } });
    const dispatcher = new ToolDispatcher({
      registry, approvals: r.service, grants: r.stores.grants, grantUse: r.stores.grants, clock: r.clock, timers: r.timers,
      audit: createPolicyAudit({ sink: r.audit, clock: r.clock, host: "h" }), policyContext: r.service.policyContext(),
    });
    const runner = new TurnRunner({
      store, compactor: new Compactor(store, defaultCompaction(8192), { beforeSwap: async () => {} }), memory,
      provider: () => new Scripted([{ type: "tool.call", id: "t1", name: "demo.net", args: {} }, { type: "delta", text: "done" }]),
      toolCalls: { dispatcher, context: ({ session }) => ({ agentId: session.agentId, principal: session.owner, sessionId: session.id, surface: 3 }) },
    });
    const session = store.createSession({ kind: "direct", agentId: "bernd", owner: "user:v1:o", memoryMode: "remember" });
    const handle = runner.submit({ session, caller: CALLER, text: "go" });
    for (let i = 0; i < 100 && !r.events.some((e) => e.name === "approval.requested"); i++) await tick();
    assert.equal(ran.length, 0, "the tool did not run before a person decided");
    const pending = r.stores.approvals.list({ status: "pending" });
    assert.equal(pending.length, 1);
    assert.equal(pending[0]!.bound.principal, "user:v1:o");
    const { id, nonce } = lastNonce(r);
    assert.ok(r.service.decide({ requestId: id, nonce, decision: "approve", person: "user:v1:o", surface: 3 }).ok);
    const out = await handle.done;
    assert.equal(out.state, "completed");
    assert.deepEqual(ran, ["net"]);
    assert.ok(r.audit.events.some((e) => e.action === "policy.decision" && e.detail.outcome === "approval"));
  });
});
