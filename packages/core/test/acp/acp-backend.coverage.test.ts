import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { CoreSessionBackend, type AcpTurnUpdate, type RpcCaller } from "../../src/acp/backend.ts";

const CALLER = { channel: "cli" as const, accountId: "acc", userId: "u" };
type Ev = { seq: number; turnId: string | null; type: string; data: Record<string, unknown> };
interface Call { m: string; p: any }

function rig(o: { pages?: { events: Ev[]; running: boolean }[]; turnId?: string; submit?: () => Promise<unknown>; onCall?: (m: string, p: any) => void; pollMs?: number; noSleep?: boolean } = {}) {
  const calls: Call[] = [];
  const sleeps: number[] = [];
  const pages = [...(o.pages ?? [])];
  const client: RpcCaller = {
    call: (async (m: string, p: any) => {
      calls.push({ m, p });
      o.onCall?.(m, p);
      if (m === "session.create") return { session: { id: "ses_1" } };
      if (m === "session.submit") return o.submit ? o.submit() : { turnId: o.turnId ?? "t1" };
      if (m === "session.events") return pages.shift() ?? { events: [], running: false };
      return {};
    }) as never,
  };
  const backend = new CoreSessionBackend({ client, caller: CALLER, agentId: "bernd", ...(o.noSleep ? {} : { sleep: async (ms: number) => { sleeps.push(ms); } }), ...(o.pollMs !== undefined ? { pollMs: o.pollMs } : {}) });
  return { backend, calls, sleeps };
}
const ev = (seq: number, type: string, data: Record<string, unknown> = {}, turnId: string | null = "t1"): Ev => ({ seq, turnId, type, data });
const run = async (r: ReturnType<typeof rig>, sessionId = "ses_1") => {
  const updates: AcpTurnUpdate[] = [];
  const outcome = await r.backend.prompt({ sessionId, text: "hello" }, (u) => updates.push(u));
  return { updates, outcome };
};

describe("core session backend coverage: createSession", () => {
  it("creates a session of kind acp for the caller and agent and returns its id", async () => {
    const r = rig();
    assert.deepEqual(await r.backend.createSession(), { sessionId: "ses_1" });
    assert.deepEqual(r.calls, [{ m: "session.create", p: { caller: CALLER, agentId: "bernd", kind: "acp", title: "ACP" } }]);
  });
  it("propagates a create failure", async () => {
    const client: RpcCaller = { call: async () => { throw new Error("down"); } };
    const b = new CoreSessionBackend({ client, caller: CALLER, agentId: "a" });
    await assert.rejects(() => b.createSession(), /down/);
  });
});

describe("core session backend coverage: prompt events", () => {
  it("maps delta, tool.call (with/without args), tool.result and ends on turn.completed", async () => {
    const r = rig({ pages: [{ events: [
      ev(1, "delta", { text: "he" }), ev(2, "delta", { text: "llo" }),
      ev(3, "tool.call", { id: "c1", name: "search", args: { q: 1 } }),
      ev(4, "tool.call", { id: 2, name: "noargs" }),
      ev(5, "tool.result", { id: "c1", output: "ok" }),
      ev(6, "tool.result", { id: "c2" }),
      ev(7, "turn.completed"),
    ], running: false }] });
    const { updates, outcome } = await run(r);
    assert.deepEqual(outcome, { state: "completed" });
    assert.deepEqual(updates, [
      { type: "text", text: "he" }, { type: "text", text: "llo" },
      { type: "tool.call", id: "c1", name: "search", args: { q: 1 } },
      { type: "tool.call", id: "2", name: "noargs" },
      { type: "tool.result", id: "c1", output: "ok" },
      { type: "tool.result", id: "c2", output: "" },
    ]);
    assert.deepEqual(r.calls.find((c) => c.m === "session.submit")?.p, { caller: CALLER, sessionId: "ses_1", text: "hello" });
  });
  it("ignores events of other turns, deltas without text, and unknown types, but advances the cursor past them", async () => {
    const r = rig({ pages: [
      { events: [ev(1, "delta", { text: "old" }, "t0"), ev(2, "delta", { text: 5 }), ev(3, "mystery"), ev(4, "delta", { text: "x" }, null)], running: true },
      { events: [ev(5, "turn.completed")], running: false },
    ] });
    const { updates, outcome } = await run(r);
    assert.deepEqual(updates, []);
    assert.equal(outcome.state, "completed");
    const afters = r.calls.filter((c) => c.m === "session.events").map((c) => c.p.afterSeq);
    assert.deepEqual(afters, [0, 4]);
  });
  it("a turn.completed for another turn does not end this one", async () => {
    const r = rig({ pages: [
      { events: [ev(1, "turn.completed", {}, "other")], running: true },
      { events: [ev(2, "turn.completed")], running: false },
    ] });
    assert.equal((await run(r)).outcome.state, "completed");
  });
  const failed: { name: string; data: Record<string, unknown>; expect: unknown }[] = [
    { name: "cancelled error", data: { error: "cancelled" }, expect: { state: "cancelled" } },
    { name: "provider error text", data: { error: "boom" }, expect: { state: "failed", error: "boom" } },
    { name: "missing error", data: {}, expect: { state: "failed", error: "unknown" } },
    { name: "non-string error", data: { error: 5 }, expect: { state: "failed", error: "unknown" } },
  ];
  for (const c of failed) {
    it(`turn.failed with ${c.name}`, async () => {
      const r = rig({ pages: [{ events: [ev(1, "turn.failed", c.data)], running: false }] });
      assert.deepEqual((await run(r)).outcome, c.expect);
    });
  }
  it("events after the terminal event of a page are not delivered", async () => {
    const r = rig({ pages: [{ events: [ev(1, "turn.completed"), ev(2, "delta", { text: "late" })], running: false }] });
    const { updates } = await run(r);
    assert.deepEqual(updates, []);
  });
});

describe("core session backend coverage: polling", () => {
  it("an empty page while the turn is not running fails with turn-ended-without-event", async () => {
    const r = rig({ pages: [{ events: [], running: false }] });
    assert.deepEqual((await run(r)).outcome, { state: "failed", error: "turn-ended-without-event" });
    assert.deepEqual(r.sleeps, []);
  });
  it("an empty page while running sleeps the default 40 ms and polls again", async () => {
    const r = rig({ pages: [{ events: [], running: true }, { events: [ev(1, "turn.completed")], running: false }] });
    assert.equal((await run(r)).outcome.state, "completed");
    assert.deepEqual(r.sleeps, [40]);
  });
  it("pollMs overrides the wait", async () => {
    const r = rig({ pollMs: 7, pages: [{ events: [], running: true }, { events: [ev(1, "turn.completed")], running: false }] });
    await run(r);
    assert.deepEqual(r.sleeps, [7]);
  });
  it("a partial page sleeps, a full page of 500 does not", async () => {
    const full = Array.from({ length: 500 }, (_, i) => ev(i + 1, "delta", { text: "." }));
    const r = rig({ pages: [{ events: full, running: true }, { events: [ev(501, "delta", { text: "!" })], running: true }, { events: [ev(502, "turn.completed")], running: false }] });
    const { updates } = await run(r);
    assert.equal(updates.length, 501);
    assert.deepEqual(r.sleeps, [40], "only the second (partial) page sleeps");
    assert.deepEqual(r.calls.filter((c) => c.m === "session.events").map((c) => [c.p.afterSeq, c.p.limit]), [[0, 500], [500, 500], [501, 500]]);
  });
  it("the cursor persists across prompts of the same session", async () => {
    const r = rig({ pages: [{ events: [ev(1, "turn.completed")], running: false }, { events: [ev(2, "turn.completed")], running: false }] });
    await run(r); await run(r);
    assert.deepEqual(r.calls.filter((c) => c.m === "session.events").map((c) => c.p.afterSeq), [0, 1]);
  });
  it("the cursor is per session", async () => {
    const r = rig({ pages: [{ events: [ev(9, "turn.completed")], running: false }, { events: [ev(1, "turn.completed")], running: false }] });
    await run(r, "a"); await run(r, "b");
    assert.deepEqual(r.calls.filter((c) => c.m === "session.events").map((c) => [c.p.sessionId, c.p.afterSeq]), [["a", 0], ["b", 0]]);
  });
  it("uses a real timer by default (fake timers)", async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const r = rig({ noSleep: true, pages: [{ events: [], running: true }, { events: [ev(1, "turn.completed")], running: false }] });
    let done = false;
    const p = run(r).then((x) => { done = true; return x; });
    for (let i = 0; i < 20; i++) await new Promise<void>((res) => setImmediate(res));
    assert.equal(done, false, "waiting on the poll timer");
    t.mock.timers.tick(40);
    assert.equal((await p).outcome.state, "completed");
  });
  it("submit and events failures propagate and clear the in-flight marker", async () => {
    const r = rig({ submit: async () => { throw new Error("busy"); } });
    await assert.rejects(() => run(r), /busy/);
    await r.backend.cancel("ses_1");
    assert.equal(r.calls.filter((c) => c.m === "session.cancel").length, 0, "nothing in flight after the failure");
  });
});

describe("core session backend coverage: cancel", () => {
  it("cancel without a running prompt is a no-op", async () => {
    const r = rig();
    await r.backend.cancel("ses_1");
    assert.deepEqual(r.calls, []);
  });
  it("cancel during a running turn calls session.cancel once with the caller", async () => {
    const calls: Call[] = [];
    const queue: { events: Ev[]; running: boolean }[] = [{ events: [], running: true }, { events: [ev(1, "turn.failed", { error: "cancelled" })], running: false }];
    const b = new CoreSessionBackend({
      client: { call: (async (m: string, p: any) => { calls.push({ m, p }); if (m === "session.submit") return { turnId: "t1" }; if (m === "session.events") return queue.shift(); return {}; }) as never },
      caller: CALLER, agentId: "a", sleep: async () => { await b.cancel("ses_1"); },
    });
    const outcome = await b.prompt({ sessionId: "ses_1", text: "x" }, () => {});
    assert.deepEqual(outcome, { state: "cancelled" });
    assert.deepEqual(calls.filter((c) => c.m === "session.cancel"), [{ m: "session.cancel", p: { caller: CALLER, sessionId: "ses_1" } }]);
  });
  it("a cancel that arrives before the turn id is known is applied right after submit", async () => {
    let release!: (v: { turnId: string }) => void;
    const submitted = new Promise<{ turnId: string }>((res) => { release = res; });
    const r = rig({ submit: () => submitted, pages: [{ events: [ev(1, "turn.failed", { error: "cancelled" })], running: false }] });
    const p = run(r);
    await new Promise<void>((res) => setImmediate(res));
    await r.backend.cancel("ses_1");
    assert.equal(r.calls.filter((c) => c.m === "session.cancel").length, 0, "not yet: no turn");
    release({ turnId: "t1" });
    const { outcome } = await p;
    assert.equal(outcome.state, "cancelled");
    const order = r.calls.map((c) => c.m);
    assert.ok(order.indexOf("session.cancel") > order.indexOf("session.submit"));
    assert.ok(order.indexOf("session.cancel") < order.indexOf("session.events"));
  });
  it("a failing session.cancel rejects cancel()", async () => {
    let backend!: CoreSessionBackend;
    const queue = [{ events: [], running: true }];
    backend = new CoreSessionBackend({
      client: { call: (async (m: string) => { if (m === "session.submit") return { turnId: "t1" }; if (m === "session.cancel") throw new Error("cancel refused"); return queue.shift() ?? { events: [ev(1, "turn.completed")], running: false }; }) as never },
      caller: CALLER, agentId: "a",
      sleep: async () => { await assert.rejects(() => backend.cancel("s"), /cancel refused/); },
    });
    assert.equal((await backend.prompt({ sessionId: "s", text: "x" }, () => {})).state, "completed");
  });
});
