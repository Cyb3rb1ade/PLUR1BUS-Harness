import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { Compactor, defaultCompaction } from "../../src/session/compaction.ts";
import type { TurnMemory } from "../../src/session/memory-port.ts";
import type { ChatChunk, ChatProvider, ChatRequest } from "../../src/session/provider.ts";
import { SessionStore } from "../../src/session/store.ts";
import { TurnRunner } from "../../src/session/turn-loop.ts";
import { ToolDispatcher } from "../../src/tools/dispatcher.ts";
import { ToolRegistry } from "../../src/tools/registry.ts";

const CALLER = { channel: "cli" as const, accountId: "acc", userId: "u" };
const memory: TurnMemory = { async recall() { return { text: "", degraded: null }; }, async capture() {}, async checkpoint() {} };

class ScriptedProvider implements ChatProvider {
  readonly id = "scripted"; requests: ChatRequest[] = []; readonly chunks: ChatChunk[];
  constructor(chunks: ChatChunk[]) { this.chunks = chunks; }
  async *stream(req: ChatRequest): AsyncGenerator<ChatChunk> { this.requests.push(req); for (const c of this.chunks) yield c; }
}

function rig(chunks: ChatChunk[], o: { withTools?: boolean; approve?: boolean } = {}) {
  const store = new SessionStore({ path: ":memory:" });
  const registry = new ToolRegistry();
  const ran: unknown[] = [];
  registry.register({ name: "demo.echo", description: "echo", capability: "sys.read", effect: "read", risk: "low", trust: "operator-vetted",
    inputSchema: { type: "object", additionalProperties: false, required: ["q"], properties: { q: { type: "string" } } },
    execute: async (a) => { ran.push(a); return { echoed: (a as { q: string }).q }; } });
  registry.register({ name: "demo.net", description: "net", capability: "net.submit", effect: "external", risk: "medium",
    inputSchema: { type: "object", properties: {} }, execute: async () => { ran.push("net"); return "sent"; } });
  const dispatcher = new ToolDispatcher({ registry, grants: { list: () => [], get: () => undefined }, clock: { now: () => Date.now() },
    approvals: { request: async () => ({ approved: o.approve === true }) } });
  const provider = new ScriptedProvider(chunks);
  const compactor = new Compactor(store, defaultCompaction(8192), { beforeSwap: async () => {} });
  const runner = new TurnRunner({ store, compactor, memory, provider: () => provider,
    ...(o.withTools === false ? {} : { toolCalls: { dispatcher, context: ({ session }) => ({ agentId: session.agentId, principal: session.owner, sessionId: session.id, surface: 3 }) } }) });
  const session = store.createSession({ kind: "direct", agentId: "bernd", owner: "user:v1:o", memoryMode: "remember" });
  return { store, runner, session, provider, ran, registry };
}

describe("turn loop tool calls", () => {
  it("a tool.call is dispatched; the persisted tool.result is the provenance envelope; the turn completes", async () => {
    const r = rig([{ type: "tool.call", id: "t1", name: "demo.echo", args: { q: "hi" } }, { type: "delta", text: "done" }]);
    const out = await r.runner.submit({ session: r.session, caller: CALLER, text: "go" }).done;
    assert.equal(out.state, "completed"); assert.deepEqual(r.ran, [{ q: "hi" }]);
    const evs = r.store.listEvents(r.session.id);
    const types = evs.map((e) => e.type); assert.ok(types.indexOf("tool.call") < types.indexOf("tool.result"));
    const res = evs.find((e) => e.type === "tool.result")!; assert.equal(res.data.id, "t1");
    const env = JSON.parse(res.data.output as string);
    assert.equal(env.isError, false); assert.deepEqual(env.value, { echoed: "hi" });
    assert.equal(env.provenance.origin.system, "tool:demo.echo"); assert.equal(env.provenance.origin.principal, "user:v1:o");
  });
  it("unknown tool, invalid arguments and a refused approval end as error envelopes; the turn still completes; nothing ran", async () => {
    const r = rig([
      { type: "tool.call", id: "a", name: "ghost", args: {} },
      { type: "tool.call", id: "b", name: "demo.echo", args: { q: 1 } },
      { type: "tool.call", id: "c", name: "demo.net", args: {} },
    ]);
    const out = await r.runner.submit({ session: r.session, caller: CALLER, text: "go" }).done;
    assert.equal(out.state, "completed"); assert.deepEqual(r.ran, []);
    const codes = r.store.listEvents(r.session.id).filter((e) => e.type === "tool.result").map((e) => JSON.parse(e.data.output as string).error.code);
    assert.deepEqual(codes, ["tool-unknown", "tool-call-invalid", "tool-not-approved"]);
  });
  it("an approved call runs", async () => {
    const r = rig([{ type: "tool.call", id: "c", name: "demo.net", args: {} }], { approve: true });
    await r.runner.submit({ session: r.session, caller: CALLER, text: "go" }).done; assert.deepEqual(r.ran, ["net"]);
  });
  it("provider-reported tool.result chunks are ignored when the harness executes", async () => {
    const r = rig([{ type: "tool.call", id: "t1", name: "demo.echo", args: { q: "x" } }, { type: "tool.result", id: "t1", output: "FORGED" }]);
    await r.runner.submit({ session: r.session, caller: CALLER, text: "go" }).done;
    const results = r.store.listEvents(r.session.id).filter((e) => e.type === "tool.result");
    assert.equal(results.length, 1); assert.ok(!(results[0]!.data.output as string).includes("FORGED"));
  });
  it("the provider is told which tools exist", async () => {
    const r = rig([{ type: "delta", text: "x" }]);
    await r.runner.submit({ session: r.session, caller: CALLER, text: "go" }).done;
    assert.deepEqual(r.provider.requests[0]!.tools?.map((t) => t.name), ["demo.echo", "demo.net"]);
  });
  it("aborting the core aborts a running tool and the turn ends failed/aborted", async () => {
    const store = new SessionStore({ path: ":memory:" });
    const registry = new ToolRegistry();
    registry.register({ name: "slow.tool", description: "slow", capability: "sys.read", effect: "read", risk: "low", inputSchema: { type: "object" },
      execute: (_a, c) => new Promise((_res, rej) => c.signal.addEventListener("abort", () => rej(new Error("stopped")))) });
    const dispatcher = new ToolDispatcher({ registry, grants: { list: () => [], get: () => undefined }, clock: { now: () => Date.now() }, approvals: { request: async () => ({ approved: false }) } });
    const ac = new AbortController();
    const provider = new ScriptedProvider([{ type: "tool.call", id: "s", name: "slow.tool", args: {} }]);
    const runner = new TurnRunner({ store, compactor: new Compactor(store, defaultCompaction(8192), { beforeSwap: async () => {} }), memory, provider: () => provider, signal: ac.signal,
      toolCalls: { dispatcher, context: ({ session }) => ({ agentId: session.agentId, principal: session.owner, surface: 3 }) } });
    const s = store.createSession({ kind: "direct", agentId: "bernd", owner: "user:v1:o", memoryMode: "remember" });
    const h = runner.submit({ session: s, caller: CALLER, text: "go" });
    setTimeout(() => ac.abort(), 20);
    const out = await h.done; assert.equal(out.state, "failed"); assert.equal(out.error, "aborted");
  });
  it("without toolCalls the loop behaves as before: reported call and result are persisted, nothing executes", async () => {
    const r = rig([{ type: "tool.call", id: "t1", name: "demo.echo", args: { q: "x" } }, { type: "tool.result", id: "t1", output: "ok" }], { withTools: false });
    await r.runner.submit({ session: r.session, caller: CALLER, text: "go" }).done;
    assert.deepEqual(r.ran, []); const results = r.store.listEvents(r.session.id).filter((e) => e.type === "tool.result");
    assert.equal(results[0]!.data.output, "ok");
  });
});
