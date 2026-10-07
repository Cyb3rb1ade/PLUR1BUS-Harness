import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { Compactor, defaultCompaction } from "../../src/session/compaction.ts";
import type { TurnMemory } from "../../src/session/memory-port.ts";
import { FakeChatProvider, type ChatProvider } from "../../src/session/provider.ts";
import { SessionStore } from "../../src/session/store.ts";
import { NoProviderError, TurnRunner } from "../../src/session/turn-loop.ts";
import type { EventRecord } from "../../src/session/types.ts";

const CALLER = { channel: "cli" as const, accountId: "acc", userId: "u" };
const OWNER = "user:v1:o";

interface Spy extends TurnMemory { calls: { recall: unknown[]; capture: unknown[]; checkpoint: unknown[] } }
function spyMemory(o: { recallText?: string; recallThrows?: boolean; captureThrows?: boolean } = {}): Spy {
  const calls = { recall: [] as unknown[], capture: [] as unknown[], checkpoint: [] as unknown[] };
  return {
    calls,
    async recall(a) { calls.recall.push(a); if (o.recallThrows) throw new Error("engine down"); return { text: o.recallText ?? "", degraded: null }; },
    async capture(a) { calls.capture.push(a); if (o.captureThrows) throw new Error("capture down"); },
    async checkpoint(a) { calls.checkpoint.push(a); },
  };
}
function rig(o: { provider?: ChatProvider | null; memory?: Spy; window?: number } = {}) {
  const store = new SessionStore({ path: ":memory:" });
  const memory = o.memory ?? spyMemory();
  const events: EventRecord[] = [];
  const compactor = new Compactor(store, defaultCompaction(o.window ?? 8192), { beforeSwap: async (i) => { await memory.checkpoint({ agentId: "x", reason: "compaction" }); void i; } });
  const provider = o.provider === undefined ? new FakeChatProvider() : o.provider;
  const runner = new TurnRunner({ store, compactor, memory, provider: () => provider, notify: (e) => events.push(e) });
  const session = (agentId = "bernd", memoryMode: "remember" | "incognito" = "remember") => store.createSession({ kind: "direct", agentId, owner: OWNER, memoryMode });
  return { store, memory, events, runner, session };
}

describe("turn loop", () => {
  it("submit → ordered events → completed; the reply is stored; deltas add up", async () => {
    const r = rig(); const s = r.session();
    const h = r.runner.submit({ session: s, caller: CALLER, text: "hello world" });
    assert.equal(r.store.runningTurn(s.id)?.id, h.turnId); // submit returns while the turn is running
    const out = await h.done;
    assert.equal(out.state, "completed");
    const evs = r.store.listEvents(s.id);
    assert.deepEqual(evs.map((e) => e.seq), evs.map((_, i) => i + 1));
    assert.equal(evs[0]!.type, "turn.started"); assert.equal(evs.at(-1)!.type, "turn.completed");
    const text = evs.filter((e) => e.type === "delta").map((e) => e.data.text).join("");
    assert.equal(text, "echo[bernd]: hello world");
    assert.deepEqual(r.store.listMessages(s.id).map((m) => [m.role, m.text]), [["user", "hello world"], ["assistant", text]]);
    assert.deepEqual(r.events, evs, "everything persisted was relayed, in order");
  });

  it("two concurrent sessions: events never mix, each stream is gap-free and carries its own text", async () => {
    let release!: () => void; const gateOpen = new Promise<void>((res) => { release = res; });
    const provider = new FakeChatProvider({ chunkSize: 3, gate: async (_req, i) => { if (i === 1) await gateOpen; else await new Promise((res) => setImmediate(res)); } });
    const r = rig({ provider });
    const a = r.session("alpha"); const b = r.session("beta");
    const ha = r.runner.submit({ session: a, caller: CALLER, text: "AAAA AAAA AAAA" });
    const hb = r.runner.submit({ session: b, caller: CALLER, text: "BBBB BBBB BBBB" });
    await new Promise((res) => setTimeout(res, 20)); release();
    assert.deepEqual((await Promise.all([ha.done, hb.done])).map((o) => o.state), ["completed", "completed"]);
    for (const [s, ch] of [[a, "A"], [b, "B"]] as const) {
      const mine = r.events.filter((e) => e.sessionId === s.id);
      assert.deepEqual(mine.map((e) => e.seq), mine.map((_, i) => i + 1));
      const text = mine.filter((e) => e.type === "delta").map((e) => e.data.text).join("");
      assert.match(text, new RegExp(`^echo\\[${s.agentId}\\]: ${ch}{4} ${ch}{4} ${ch}{4}$`));
      assert.equal(new Set(mine.map((e) => e.turnId)).size, 1);
    }
    assert.ok(r.events.some((e, i) => i > 0 && e.sessionId !== r.events[i - 1]!.sessionId), "the two streams really interleaved");
    assert.equal(r.store.listMessages(a.id).find((m) => m.role === "assistant")!.text.includes("BBBB"), false);
  });

  it("recall once before and capture once after, with the right payload, in order", async () => {
    const order: string[] = []; const memory = spyMemory({ recallText: "MEM" });
    const rec = memory.recall; memory.recall = async (a) => { order.push("recall"); return rec(a); };
    const cap = memory.capture; memory.capture = async (a) => { order.push("capture"); return cap(a); };
    let seen: string[] = [];
    const r = rig({ memory, provider: new FakeChatProvider({ onRequest: (q) => { order.push("provider"); seen = [q.memory]; } }) });
    const s = r.session();
    for (let i = 0; i < 3; i++) await r.runner.submit({ session: s, caller: CALLER, text: `turn ${i}` }).done;
    assert.equal(memory.calls.recall.length, 3); assert.equal(memory.calls.capture.length, 3);
    assert.deepEqual(order.slice(0, 3), ["recall", "provider", "capture"]);
    assert.deepEqual(seen, ["MEM"]);
    const c = memory.calls.capture[0] as { incognito: boolean; messages: { role: string; content: string }[]; sessionId: string; agentId: string };
    assert.equal(c.incognito, false); assert.equal(c.sessionId, s.id); assert.equal(c.agentId, "bernd");
    assert.deepEqual(c.messages.map((m) => m.role), ["user", "assistant"]);
    assert.equal((memory.calls.recall[0] as { query: string }).query, "turn 0");
  });

  it("incognito: recall still happens, capture never does (core-derived, not a client flag)", async () => {
    const r = rig(); const s = r.session("bernd", "incognito");
    await r.runner.submit({ session: s, caller: CALLER, text: "private" }).done;
    assert.equal(r.memory.calls.recall.length, 1); assert.equal(r.memory.calls.capture.length, 0);
    assert.equal(r.store.listTurns(s.id)[0]!.incognito, true);
  });

  it("provider failure → turn.failed, no capture, no assistant message; the session stays usable", async () => {
    const r = rig(); const s = r.session();
    const out = await r.runner.submit({ session: s, caller: CALLER, text: "please FAIL" }).done;
    assert.equal(out.state, "failed"); assert.match(out.error!, /fake provider failure/);
    assert.equal(r.events.at(-1)!.type, "turn.failed");
    assert.equal(r.memory.calls.capture.length, 0);
    assert.deepEqual(r.store.listMessages(s.id).map((m) => m.role), ["user"]);
    assert.equal((await r.runner.submit({ session: s, caller: CALLER, text: "ok now" }).done).state, "completed");
  });

  it("a failing recall or capture never fails the turn", async () => {
    const r = rig({ memory: spyMemory({ recallThrows: true, captureThrows: true }) }); const s = r.session();
    const out = await r.runner.submit({ session: s, caller: CALLER, text: "x" }).done;
    assert.equal(out.state, "completed");
    const done = r.store.listEvents(s.id).at(-1)!;
    assert.deepEqual((done.data.recall as { degraded: { reason: string } }).degraded.reason, "recall-error");
  });

  it("tool placeholders are persisted and relayed, nothing is executed", async () => {
    const r = rig(); const s = r.session();
    await r.runner.submit({ session: s, caller: CALLER, text: "use TOOL" }).done;
    assert.deepEqual(r.store.listEvents(s.id).map((e) => e.type).filter((t) => t.startsWith("tool")), ["tool.call", "tool.result"]);
  });

  it("a second submit while a turn runs is refused; no provider is refused before anything is written", async () => {
    let release!: () => void; const gate = new Promise<void>((res) => { release = res; });
    const r = rig({ provider: new FakeChatProvider({ gate: () => gate }) }); const s = r.session();
    const h = r.runner.submit({ session: s, caller: CALLER, text: "one" });
    assert.throws(() => r.runner.submit({ session: s, caller: CALLER, text: "two" }), (e: unknown) => (e as { reason?: string }).reason === "turn-in-progress");
    release(); await h.done;
    const none = rig({ provider: null }); const s2 = none.session();
    assert.throws(() => none.runner.submit({ session: s2, caller: CALLER, text: "x" }), NoProviderError);
    assert.equal(none.store.listMessages(s2.id).length, 0); assert.equal(none.store.listEvents(s2.id).length, 0);
  });

  it("the core's shutdown signal aborts a running turn → failed(aborted)", async () => {
    const ac = new AbortController();
    const store = new SessionStore({ path: ":memory:" }); const memory = spyMemory();
    const runner = new TurnRunner({ store, compactor: new Compactor(store), memory, provider: () => new FakeChatProvider({ gate: async () => { ac.abort(); } }), signal: ac.signal });
    const s = store.createSession({ kind: "direct", agentId: "bernd", owner: OWNER });
    const out = await runner.submit({ session: s, caller: CALLER, text: "x" }).done;
    assert.deepEqual(out, { state: "failed", error: "aborted" });
    assert.equal(memory.calls.capture.length, 0);
  });

  it("a long session compacts: checkpoint before the swap, the provider never sees more than the hard limit", async () => {
    let maxSeen = 0;
    const provider = new FakeChatProvider({ onRequest: (q) => { maxSeen = Math.max(maxSeen, q.messages.reduce((n, m) => n + Math.ceil(m.text.length / 4), 0) + q.summaries.reduce((n, t) => n + Math.ceil(t.length / 4), 0)); } });
    const r = rig({ provider, window: 1000 }); const s = r.session();
    for (let i = 0; i < 25; i++) assert.equal((await r.runner.submit({ session: s, caller: CALLER, text: `message ${i} ${"w".repeat(300)}` }).done).state, "completed");
    assert.ok(maxSeen <= 880, `provider saw ${maxSeen}`);
    assert.ok(r.memory.calls.checkpoint.length > 0);
    assert.equal(r.memory.calls.capture.length, 25); assert.equal(r.memory.calls.recall.length, 25);
    assert.equal(r.store.listMessages(s.id).length, 50);
  });

  it("cancel aborts the running turn: failed(cancelled), the stored deltas stay, no capture; nothing running is a no-op", async () => {
    let release!: () => void; const gate = new Promise<void>((r) => { release = r; });
    const r = rig({ provider: new FakeChatProvider({ chunkSize: 2, gate: async (_q, i) => { if (i === 2) await gate; } }) }); const s = r.session();
    assert.equal(r.runner.cancel(s.id), null, "nothing running");
    const h = r.runner.submit({ session: s, caller: CALLER, text: "hello world" });
    while (r.events.filter((e) => e.type === "delta").length < 2) await new Promise((res) => setImmediate(res));
    assert.equal(r.runner.cancel(s.id), h.turnId);
    release();
    const out = await h.done;
    assert.deepEqual([out.state, out.error], ["failed", "cancelled"]);
    assert.equal(r.store.runningTurn(s.id), null);
    assert.equal(r.events.at(-1)!.type, "turn.failed");
    assert.equal(r.events.at(-1)!.data.error, "cancelled");
    assert.equal(r.memory.calls.capture.length, 0);
    assert.equal(r.runner.cancel(s.id), null, "already ended");
    // the session is usable again
    assert.equal((await r.runner.submit({ session: s, caller: CALLER, text: "again" }).done).state, "completed");
  });
});
