import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { realScheduler, TaskError, TaskStore, type StartArgs, type TaskStoreOptions } from "../../src/a2a/tasks.ts";
import { PushDispatcher, PushError, type PushTransport } from "../../src/a2a/push.ts";
import type { A2aTurnPort, A2aTurnRequest, TurnChunk } from "../../src/a2a/turn-port.ts";
import type { A2aStreamEvent, A2aTask, TaskState } from "../../src/a2a/types.ts";
import { ManualScheduler, TestClock } from "./helpers.ts";

type Script = (req: A2aTurnRequest) => AsyncIterable<TurnChunk>;
class FakePort implements A2aTurnPort {
  ok = true; script: Script; cancelled: string[] = []; sessions: { peerId: string; agentId: string; contextId: string }[] = []; runs: A2aTurnRequest[] = [];
  constructor(script: Script = chunks([{ type: "delta", text: "hi" }])) { this.script = script; }
  available(): boolean { return this.ok; }
  ensureSession(a: { peerId: string; agentId: string; contextId: string }): { sessionId: string } { this.sessions.push(a); return { sessionId: `s-${a.contextId}` }; }
  run(req: A2aTurnRequest): AsyncIterable<TurnChunk> { this.runs.push(req); return this.script(req); }
  cancel(sessionId: string): boolean { this.cancelled.push(sessionId); return true; }
}
const chunks = (cs: TurnChunk[]): Script => async function* () { for (const c of cs) yield c; };
/** Never finishes until the request is aborted. */
const hangUntilAbort: Script = (req) => ({
  [Symbol.asyncIterator]: () => ({
    next: () => new Promise((_, rej) => { req.signal.addEventListener("abort", () => rej(req.signal.reason), { once: true }); }),
  }),
});
const neverEnds: Script = () => ({ [Symbol.asyncIterator]: () => ({ next: () => new Promise(() => {}) }) });
const throwing = (e: unknown): Script => async function* () { throw e; };

const D = { peerId: "p1", agentId: "bernd" };
let n = 0;
const args = (o: Partial<StartArgs> = {}): StartArgs => ({
  ...D, text: "hello", parts: [{ kind: "text", text: "hello" }], messageId: `m-${++n}`, ...o,
});
function mk(o: { port?: FakePort; opts?: Partial<TaskStoreOptions>; push?: PushDispatcher } = {}) {
  const clock = new TestClock(); const sched = new ManualScheduler(); const port = o.port ?? new FakePort();
  const events: { type: string; state: TaskState; taskId: string }[] = [];
  const store = new TaskStore({
    turns: port, clock: () => clock.now(), scheduler: sched,
    maxLivePerPeer: 4, maxStored: 50, retentionMs: 10_000, replyTimeoutMs: 5_000, maxHistory: 10,
    onEvent: (e) => events.push({ type: e.type, state: e.state, taskId: e.taskId }),
    ...(o.push ? { push: o.push } : {}), ...o.opts,
  });
  return { store, clock, sched, port, events };
}
async function take(it: AsyncIterable<A2aStreamEvent>, max = 100): Promise<A2aStreamEvent[]> {
  const out: A2aStreamEvent[] = [];
  for await (const e of it) { out.push(e); if (out.length >= max) break; }
  return out;
}
const kinds = (es: A2aStreamEvent[]): string[] => es.map((e) => e.kind === "status-update" ? `status:${e.status.state}${e.final ? "!" : ""}` : e.kind);
const tick = (): Promise<void> => new Promise((r) => setImmediate(r));
function pushRig() {
  const posted: { url: string; body: string }[] = [];
  const transport: PushTransport = {
    async decide(url) { return { allowed: true, host: "h", port: 80, address: "127.0.0.1", family: 4 as const, ...(url ? {} : {}) }; },
    async post(a) { posted.push({ url: a.url, body: a.body }); return { status: 204 }; },
  };
  const sched = new ManualScheduler();
  const dispatcher = new PushDispatcher({ transport, scheduler: sched, clock: { now: () => 0 }, maxAttempts: 1, backoffMs: 1 });
  return { dispatcher, posted };
}

describe("TaskError / realScheduler", () => {
  for (const code of ["not-found", "not-cancelable", "too-many", "no-provider", "unsupported", "invalid"] as const) {
    it(`TaskError carries ${code}`, () => {
      const e = new TaskError(code, "msg");
      assert.equal(e.code, code); assert.equal(e.name, "TaskError"); assert.ok(e instanceof Error);
    });
  }
  it("realScheduler.set runs the callback after the delay and returns an unref'd timer", (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    let ran = 0;
    const h = realScheduler.set(() => { ran++; }, 1000);
    assert.equal(ran, 0);
    t.mock.timers.tick(1000);
    assert.equal(ran, 1);
    assert.ok(h);
  });
  it("realScheduler.clear cancels a pending callback", (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    let ran = 0;
    const h = realScheduler.set(() => { ran++; }, 1000);
    realScheduler.clear(h);
    t.mock.timers.tick(5000);
    assert.equal(ran, 0);
  });
});

describe("TaskStore.start", () => {
  it("returns a working task view immediately and completes with the reply artifact", async () => {
    const { store, events } = mk();
    const t = store.start(args());
    assert.equal(t.kind, "task"); assert.equal(t.status.state, "working");
    assert.equal(store.size, 1);
    await store.settled(t.id);
    const done = store.get(t.id, D.peerId, D.agentId);
    assert.equal(done.status.state, "completed");
    assert.equal(done.artifacts![0]!.parts[0]!.kind, "text");
    assert.deepEqual(done.history!.map((m) => m.role), ["user", "agent"]);
    assert.deepEqual(events.map((e) => e.type), ["created", "finished"]);
  });
  it("uses a given contextId and generates one otherwise; ensureSession gets the triple", () => {
    const { store, port } = mk({ port: new FakePort(neverEnds) });
    const a = store.start(args({ contextId: "ctx-given" }));
    const b = store.start(args());
    assert.equal(a.contextId, "ctx-given");
    assert.match(b.contextId, /^[0-9a-f-]{36}$/);
    assert.deepEqual(port.sessions[0], { ...D, contextId: "ctx-given" });
  });
  it("is idempotent per (peer, agent, messageId): the second start returns the same task", async () => {
    const { store, port } = mk();
    const a = args({ messageId: "same" });
    const t1 = store.start(a); const t2 = store.start(a);
    assert.equal(t1.id, t2.id);
    assert.equal(port.runs.length, 1);
    assert.equal(store.size, 1);
    await store.settled(t1.id);
  });
  it("the same messageId from another peer or agent is a different task", () => {
    const { store } = mk({ port: new FakePort(neverEnds) });
    const a = store.start(args({ messageId: "same" }));
    const b = store.start(args({ messageId: "same", peerId: "p2" }));
    const c = store.start(args({ messageId: "same", agentId: "anna" }));
    assert.equal(new Set([a.id, b.id, c.id]).size, 3);
  });
  it("no-provider when the port is unavailable, and nothing is stored", () => {
    const port = new FakePort(); port.ok = false;
    const { store } = mk({ port });
    assert.throws(() => store.start(args()), (e: unknown) => e instanceof TaskError && e.code === "no-provider");
    assert.equal(store.size, 0);
  });
  it("too-many running tasks per peer (other peers unaffected; finished tasks do not count)", async () => {
    const { store, port } = mk({ port: new FakePort(neverEnds), opts: { maxLivePerPeer: 2 } });
    store.start(args()); store.start(args());
    assert.throws(() => store.start(args()), (e: unknown) => e instanceof TaskError && e.code === "too-many" && /running tasks/.test(e.message));
    store.start(args({ peerId: "p2" }));
    port.script = chunks([{ type: "delta", text: "x" }]);
    const fin = mk({ opts: { maxLivePerPeer: 1 } });
    const t = fin.store.start(args());
    await fin.store.settled(t.id);
    fin.store.start(args());
  });
  it("too-many when the store is full", () => {
    const { store } = mk({ port: new FakePort(neverEnds), opts: { maxStored: 2, maxLivePerPeer: 10 } });
    store.start(args()); store.start(args({ peerId: "p2" }));
    assert.throws(() => store.start(args({ peerId: "p3" })), (e: unknown) => e instanceof TaskError && e.code === "too-many" && /store is full/.test(e.message));
  });
  it("registers an initial push config when given", async () => {
    const { dispatcher, posted } = pushRig();
    const { store } = mk({ push: dispatcher });
    const t = store.start(args({ push: { url: "http://hook.test/a" } }));
    await store.settled(t.id); await dispatcher.idle();
    const got = store.getPush(t.id, D.peerId, D.agentId);
    assert.equal(got.pushNotificationConfig.url, "http://hook.test/a");
    assert.ok(got.pushNotificationConfig.id);
    assert.equal(posted.length, 1);
    assert.equal((JSON.parse(posted[0]!.body) as A2aTask).status.state, "completed");
  });
  it("the history is bounded by maxHistory in the returned view", () => {
    const { store } = mk({ port: new FakePort(neverEnds), opts: { maxHistory: 0 } });
    assert.equal(store.start(args()).history, undefined);
  });
});

describe("TaskStore lifecycle outcomes", () => {
  it("streams artifact chunks (append after the first) and a final empty chunk, then completes", async () => {
    const { store } = mk({ port: new FakePort(chunks([{ type: "delta", text: "a" }, { type: "delta", text: "b" }])) });
    const t = store.start(args());
    const evs = await take(store.subscribe(t.id, D.peerId, D.agentId));
    assert.deepEqual(kinds(evs), ["task", "status:working", "artifact-update", "artifact-update", "artifact-update", "status:completed!"]);
    const arts = evs.filter((e) => e.kind === "artifact-update") as Extract<A2aStreamEvent, { kind: "artifact-update" }>[];
    assert.deepEqual(arts.map((a) => [a.append, a.lastChunk]), [[false, false], [true, false], [true, true]]);
    assert.equal(store.get(t.id, D.peerId, D.agentId).artifacts![0]!.parts[0]!.kind, "text");
  });
  it("an empty reply completes with an empty artifact text and no artifact events", async () => {
    const { store } = mk({ port: new FakePort(chunks([])) });
    const t = store.start(args());
    await store.settled(t.id);
    const view = store.get(t.id, D.peerId, D.agentId);
    assert.equal(view.status.state, "completed");
    assert.deepEqual(view.artifacts, [{ artifactId: `${t.id}-reply`, name: "reply", parts: [{ kind: "text", text: "" }] }]);
    const evs = await take(store.subscribe(t.id, D.peerId, D.agentId));
    assert.ok(!kinds(evs).includes("artifact-update"));
  });
  it("a working task with partial output exposes the partial artifact", async () => {
    let release!: () => void; const gate = new Promise<void>((r) => { release = r; });
    const { store } = mk({ port: new FakePort(async function* () { yield { type: "delta", text: "part" }; await gate; }) });
    const t = store.start(args());
    await tick();
    const mid = store.get(t.id, D.peerId, D.agentId);
    assert.equal(mid.status.state, "working");
    assert.equal((mid.artifacts![0]!.parts[0] as { text: string }).text, "part");
    release(); await store.settled(t.id);
  });
  for (const [state, text] of [["input-required", "More information is required."], ["auth-required", "Authentication is required."]] as const) {
    it(`a ${state} pause stores the agent message, stays resumable and notifies push`, async () => {
      const { dispatcher, posted } = pushRig();
      const { store } = mk({ port: new FakePort(chunks([{ type: "pause", state, message: text }])), push: dispatcher });
      const t = store.start(args({ push: { url: "http://hook.test/p" } }));
      await store.settled(t.id); await dispatcher.idle();
      const v = store.get(t.id, D.peerId, D.agentId);
      assert.equal(v.status.state, state);
      assert.equal((v.status.message!.parts[0] as { text: string }).text, text);
      assert.equal(posted.length, 1);
    });
  }
  it("reject ends rejected with the agent's message in the status", async () => {
    const { store, events } = mk({ port: new FakePort(chunks([{ type: "reject", message: "no thanks" }])) });
    const t = store.start(args());
    await store.settled(t.id);
    const v = store.get(t.id, D.peerId, D.agentId);
    assert.equal(v.status.state, "rejected");
    assert.equal((v.status.message!.parts[0] as { text: string }).text, "no thanks");
    assert.deepEqual(events.map((e) => e.state), ["submitted", "rejected"]);
  });
  it("a provider error ends failed with a generic status message", async () => {
    const { store } = mk({ port: new FakePort(throwing(new Error("secret internals"))) });
    const t = store.start(args());
    await store.settled(t.id);
    const v = store.get(t.id, D.peerId, D.agentId);
    assert.equal(v.status.state, "failed");
    assert.equal((v.status.message!.parts[0] as { text: string }).text, "The agent could not complete the task.");
    assert.ok(!JSON.stringify(v).includes("secret internals"));
  });
  it("a non-Error throw is also failed", async () => {
    const { store } = mk({ port: new FakePort(throwing("a string")) });
    const t = store.start(args());
    await store.settled(t.id);
    assert.equal(store.get(t.id, D.peerId, D.agentId).status.state, "failed");
  });
  it("a null/undefined throw is also failed", async () => {
    for (const v of [null, undefined]) {
      const { store } = mk({ port: new FakePort(throwing(v)) });
      const t = store.start(args());
      await store.settled(t.id);
      assert.equal(store.get(t.id, D.peerId, D.agentId).status.state, "failed");
    }
  });
  it("the reply timeout fires through the scheduler and fails with the timeout message", async () => {
    const { store, sched } = mk({ port: new FakePort(hangUntilAbort) });
    const t = store.start(args());
    await tick();
    assert.equal(sched.pending, 1);
    sched.fireAll();
    await store.settled(t.id);
    const v = store.get(t.id, D.peerId, D.agentId);
    assert.equal(v.status.state, "failed");
    assert.equal((v.status.message!.parts[0] as { text: string }).text, "The agent did not answer in time.");
    assert.equal(sched.pending, 0);
  });
  it("the timer is cleared on completion", async () => {
    const { store, sched } = mk();
    const t = store.start(args());
    await store.settled(t.id);
    assert.equal(sched.pending, 0);
  });
  it("the timeout is scheduled with replyTimeoutMs", async () => {
    const delays: number[] = [];
    const sched = { set(_fn: () => void, ms: number) { delays.push(ms); return 1; }, clear() {} };
    const { store } = mk({ opts: { scheduler: sched, replyTimeoutMs: 1234 } });
    await store.settled(store.start(args()).id);
    assert.deepEqual(delays, [1234]);
  });
  it("a no-provider error from the turn removes the task and rejects settled()", async () => {
    for (const thrown of [Object.assign(new Error("x"), { code: "no-provider" }), { reason: "no-provider" }]) {
      const { store } = mk({ port: new FakePort(throwing(thrown)) });
      const t = store.start(args({ messageId: "gone" }));
      const settled = store.settled(t.id);
      await assert.rejects(settled, (e: unknown) => e instanceof TaskError && e.code === "no-provider" && /not available/.test(e.message));
      assert.equal(store.size, 0);
      assert.throws(() => store.get(t.id, D.peerId, D.agentId), (e: unknown) => e instanceof TaskError && e.code === "not-found");
      // the message id is free again
      const again = store.start(args({ messageId: "gone" }));
      const againSettled = store.settled(again.id).catch(() => {});
      assert.notEqual(again.id, t.id);
      await againSettled;
    }
  });
  it("a TaskError no-provider from the turn is rethrown as is", async () => {
    const original = new TaskError("no-provider", "custom");
    const { store } = mk({ port: new FakePort(throwing(original)) });
    const t = store.start(args());
    await assert.rejects(store.settled(t.id), (e: unknown) => e === original);
  });
});

describe("TaskStore unobserved failures", () => {
  it("a non-blocking start whose turn throws no-provider must not leave an unhandled rejection", { skip: "BUG: rec.done wird bei no-provider rejected, ohne dass start() einen Handler anhaengt (unhandledRejection) - siehe docs/testing/coverage-2026-10.md#a2a-tasks-noprovider-unhandled-rejection" }, async () => {
    const seen: unknown[] = [];
    const onRejection = (r: unknown): void => { seen.push(r); };
    process.on("unhandledRejection", onRejection);
    try {
      const { store } = mk({ port: new FakePort(throwing(Object.assign(new Error("x"), { code: "no-provider" }))) });
      store.start(args());
      for (let i = 0; i < 5; i++) await tick();
    } finally { process.off("unhandledRejection", onRejection); }
    assert.deepEqual(seen, []);
  });
});

describe("TaskStore follow-ups (resume)", () => {
  const pausing = new FakePort(async function* (req) {
    if (/AGAIN/.test(req.text)) { yield { type: "pause", state: "auth-required", message: "again" }; return; }
    if (/PAUSE/.test(req.text)) { yield { type: "pause", state: "input-required", message: "need more" }; return; }
    yield { type: "delta", text: `got:${req.text}` };
  });
  it("an input-required task takes a follow-up, runs again and completes", async () => {
    const { store, port } = mk({ port: pausing });
    const t = store.start(args({ text: "PAUSE" }));
    await store.settled(t.id);
    assert.equal(store.get(t.id, D.peerId, D.agentId).status.state, "input-required");
    const r = store.start(args({ text: "more", taskId: t.id, messageId: "followup" }));
    assert.equal(r.id, t.id);
    await store.settled(t.id);
    const v = store.get(t.id, D.peerId, D.agentId);
    assert.equal(v.status.state, "completed");
    assert.deepEqual(v.history!.map((m) => m.role), ["user", "agent", "user", "agent"]);
    assert.equal(port.runs.at(-1)!.text, "more");
    // idempotent on the follow-up message id
    assert.equal(store.start(args({ text: "more", taskId: t.id, messageId: "followup" })).id, t.id);
    assert.equal(port.runs.length, 2);
  });
  it("an auth-required task can pause again on a follow-up", async () => {
    const { store } = mk({ port: pausing });
    const t = store.start(args({ text: "PAUSE" }));
    await store.settled(t.id);
    store.start(args({ text: "AGAIN", taskId: t.id }));
    await store.settled(t.id);
    assert.equal(store.get(t.id, D.peerId, D.agentId).status.state, "auth-required");
    store.start(args({ text: "done", taskId: t.id }));
    await store.settled(t.id);
    assert.equal(store.get(t.id, D.peerId, D.agentId).status.state, "completed");
  });
  it("unknown, foreign-peer and foreign-agent task ids are not-found", () => {
    const { store } = mk({ port: pausing });
    const t = store.start(args({ text: "PAUSE" }));
    for (const a of [args({ taskId: "nope" }), args({ taskId: t.id, peerId: "p2" }), args({ taskId: t.id, agentId: "anna" })]) {
      assert.throws(() => store.start(a), (e: unknown) => e instanceof TaskError && e.code === "not-found");
    }
  });
  it("a terminal task refuses follow-ups (unsupported: already <state>)", async () => {
    const { store } = mk();
    const t = store.start(args());
    await store.settled(t.id);
    assert.throws(() => store.start(args({ taskId: t.id })), (e: unknown) => e instanceof TaskError && e.code === "unsupported" && /already completed/.test(e.message));
  });
  it("a working task refuses follow-ups (only input/auth-required)", () => {
    const { store } = mk({ port: new FakePort(neverEnds) });
    const t = store.start(args());
    assert.throws(() => store.start(args({ taskId: t.id })), (e: unknown) => e instanceof TaskError && e.code === "unsupported" && /only accepted/.test(e.message));
  });
  it("a follow-up skips the no-provider and limit checks", async () => {
    const port = new FakePort(async function* () { yield { type: "pause", state: "input-required", message: "m" }; });
    const { store } = mk({ port, opts: { maxStored: 1, maxLivePerPeer: 1 } });
    const t = store.start(args());
    await store.settled(t.id);
    port.ok = false;
    port.script = chunks([{ type: "delta", text: "ok" }]);
    store.start(args({ taskId: t.id }));
    await store.settled(t.id);
    assert.equal(store.get(t.id, D.peerId, D.agentId).status.state, "completed");
  });
});

describe("TaskStore.get / prune", () => {
  it("historyLength is clamped to maxHistory; 0 and negative-free values", async () => {
    const { store } = mk({ opts: { maxHistory: 1 } });
    const t = store.start(args());
    await store.settled(t.id);
    assert.equal(store.get(t.id, D.peerId, D.agentId).history!.length, 1);
    assert.equal(store.get(t.id, D.peerId, D.agentId, 50).history!.length, 1);
    assert.equal(store.get(t.id, D.peerId, D.agentId, 0).history, undefined);
    assert.equal((store.get(t.id, D.peerId, D.agentId, 1).history![0]!).role, "agent");
  });
  it("history in a view is a copy", async () => {
    const { store } = mk();
    const t = store.start(args()); await store.settled(t.id);
    const v = store.get(t.id, D.peerId, D.agentId);
    v.history![0]!.parts = [];
    assert.equal(store.get(t.id, D.peerId, D.agentId).history![0]!.parts.length, 1);
  });
  it("another peer or agent cannot read a task", async () => {
    const { store } = mk();
    const t = store.start(args()); await store.settled(t.id);
    assert.throws(() => store.get(t.id, "p2", D.agentId), (e: unknown) => e instanceof TaskError && e.code === "not-found");
    assert.throws(() => store.get(t.id, D.peerId, "anna"), (e: unknown) => e instanceof TaskError && e.code === "not-found");
    assert.throws(() => store.get("x", D.peerId, D.agentId), (e: unknown) => e instanceof TaskError && e.code === "not-found");
  });
  it("terminal tasks are pruned after retentionMs (boundary inclusive); their message ids free up", async () => {
    const { store, clock } = mk({ opts: { retentionMs: 1000 } });
    const t = store.start(args({ messageId: "mm" }));
    await store.settled(t.id);
    clock.advance(999);
    assert.equal(store.get(t.id, D.peerId, D.agentId).id, t.id);
    clock.advance(1);
    assert.throws(() => store.get(t.id, D.peerId, D.agentId), (e: unknown) => e instanceof TaskError && e.code === "not-found");
    assert.equal(store.size, 0);
    assert.notEqual(store.start(args({ messageId: "mm" })).id, t.id);
  });
  it("running tasks are never pruned", () => {
    const { store, clock } = mk({ port: new FakePort(neverEnds), opts: { retentionMs: 10 } });
    const t = store.start(args());
    clock.advance(1_000_000);
    assert.equal(store.get(t.id, D.peerId, D.agentId).status.state, "working");
  });
  it("the status timestamp is an ISO string of the update time", async () => {
    const { store, clock } = mk();
    const t = store.start(args()); await store.settled(t.id);
    assert.equal(store.get(t.id, D.peerId, D.agentId).status.timestamp, new Date(clock.now()).toISOString());
  });
});

describe("TaskStore.cancel", () => {
  it("cancels a running task: aborts the turn, tells the port, ends canceled, emits events", async () => {
    const { store, port, events } = mk({ port: new FakePort(hangUntilAbort) });
    const t = store.start(args());
    await tick();
    const c = store.cancel(t.id, D.peerId, D.agentId);
    assert.equal(c.status.state, "canceled");
    assert.deepEqual(port.cancelled, [port.sessions[0] ? `s-${port.sessions[0].contextId}` : ""]);
    assert.equal(port.runs[0]!.signal.aborted, true);
    await store.settled(t.id);
    assert.equal(store.get(t.id, D.peerId, D.agentId).status.state, "canceled");
    assert.deepEqual(events.map((e) => e.type), ["created", "finished", "canceled"]);
  });
  it("cancels a paused task", async () => {
    const { store } = mk({ port: new FakePort(chunks([{ type: "pause", state: "input-required", message: "m" }])) });
    const t = store.start(args()); await store.settled(t.id);
    assert.equal(store.cancel(t.id, D.peerId, D.agentId).status.state, "canceled");
  });
  for (const outcome of ["completed", "failed", "rejected"] as const) {
    it(`a ${outcome} task is not cancelable`, async () => {
      const script = outcome === "completed" ? chunks([]) : outcome === "failed" ? throwing(new Error("x")) : chunks([{ type: "reject", message: "m" }]);
      const { store } = mk({ port: new FakePort(script) });
      const t = store.start(args()); await store.settled(t.id);
      assert.throws(() => store.cancel(t.id, D.peerId, D.agentId), (e: unknown) => e instanceof TaskError && e.code === "not-cancelable" && e.message.includes(outcome));
    });
  }
  it("a canceled task is not cancelable again", async () => {
    const { store } = mk({ port: new FakePort(hangUntilAbort) });
    const t = store.start(args()); await tick();
    store.cancel(t.id, D.peerId, D.agentId);
    assert.throws(() => store.cancel(t.id, D.peerId, D.agentId), (e: unknown) => e instanceof TaskError && e.code === "not-cancelable");
  });
  it("foreign peers get not-found", () => {
    const { store } = mk({ port: new FakePort(neverEnds) });
    const t = store.start(args());
    assert.throws(() => store.cancel(t.id, "p2", D.agentId), (e: unknown) => e instanceof TaskError && e.code === "not-found");
  });
  it("notifies push webhooks about the cancellation", async () => {
    const { dispatcher, posted } = pushRig();
    const { store } = mk({ port: new FakePort(hangUntilAbort), push: dispatcher });
    const t = store.start(args({ push: { url: "http://hook.test/c" } })); await tick();
    store.cancel(t.id, D.peerId, D.agentId);
    await store.settled(t.id); await dispatcher.idle();
    assert.equal(posted.length, 1);
    assert.equal((JSON.parse(posted[0]!.body) as A2aTask).status.state, "canceled");
  });
});

describe("TaskStore.settled", () => {
  it("resolves for unknown ids", async () => { await mk().store.settled("unknown"); });
});

describe("TaskStore.subscribe / resubscribe", () => {
  it("replays the full event log of a finished task and stops at the terminal event", async () => {
    const { store } = mk();
    const t = store.start(args()); await store.settled(t.id);
    const evs = await take(store.subscribe(t.id, D.peerId, D.agentId));
    assert.equal(kinds(evs)[0], "task"); assert.equal(kinds(evs).at(-1), "status:completed!");
  });
  it("fromSeq skips earlier events", async () => {
    const { store } = mk();
    const t = store.start(args()); await store.settled(t.id);
    const all = await take(store.subscribe(t.id, D.peerId, D.agentId));
    const tail = await take(store.subscribe(t.id, D.peerId, D.agentId, all.length - 1));
    assert.deepEqual(kinds(tail), ["status:completed!"]);
  });
  it("past the end of a finished task it yields one final status snapshot", async () => {
    const { store } = mk();
    const t = store.start(args()); await store.settled(t.id);
    const evs = await take(store.subscribe(t.id, D.peerId, D.agentId, 999));
    assert.deepEqual(kinds(evs), ["status:completed!"]);
  });
  it("a live subscriber waits for new events and ends on the terminal one", async () => {
    let release!: () => void; const gate = new Promise<void>((r) => { release = r; });
    const { store } = mk({ port: new FakePort(async function* () { await gate; yield { type: "delta", text: "late" }; }) });
    const t = store.start(args());
    const p = take(store.subscribe(t.id, D.peerId, D.agentId));
    await tick(); release();
    assert.equal(kinds(await p).at(-1), "status:completed!");
  });
  it("a subscriber blocked on a paused task is released by cancellation", async () => {
    const { store } = mk({ port: new FakePort(chunks([{ type: "pause", state: "input-required", message: "m" }])) });
    const t = store.start(args()); await store.settled(t.id);
    const p = take(store.subscribe(t.id, D.peerId, D.agentId));
    await tick();
    store.cancel(t.id, D.peerId, D.agentId);
    assert.equal(kinds(await p).at(-1), "status:canceled!");
  });
  it("enforces the per-peer stream cap (default 8, or configured) and frees slots", async () => {
    const { store } = mk({ port: new FakePort(chunks([{ type: "pause", state: "input-required", message: "m" }])), opts: { maxStreamConnectionsPerPeer: 2 } });
    const t = store.start(args()); await store.settled(t.id);
    const open: AsyncIterator<A2aStreamEvent>[] = [];
    for (let i = 0; i < 2; i++) {
      const it = store.subscribe(t.id, D.peerId, D.agentId)[Symbol.asyncIterator]();
      while (true) { const r = await it.next(); if (r.done || r.value.kind === "status-update" && r.value.status.state === "input-required") break; }
      open.push(it);
    }
    const third = store.subscribe(t.id, D.peerId, D.agentId)[Symbol.asyncIterator]();
    await assert.rejects(third.next(), (e: unknown) => e instanceof TaskError && e.code === "too-many" && /open streams/.test(e.message));
    await open[0]!.return!();
    const again = store.subscribe(t.id, D.peerId, D.agentId)[Symbol.asyncIterator]();
    assert.equal((await again.next()).done, false);
    await again.return!(); await open[1]!.return!();
  });
  it("the default cap is 8", async () => {
    const { store } = mk({ port: new FakePort(chunks([{ type: "pause", state: "input-required", message: "m" }])) });
    const t = store.start(args()); await store.settled(t.id);
    const its: AsyncIterator<A2aStreamEvent>[] = [];
    for (let i = 0; i < 8; i++) { const it = store.subscribe(t.id, D.peerId, D.agentId)[Symbol.asyncIterator](); await it.next(); its.push(it); }
    await assert.rejects(store.subscribe(t.id, D.peerId, D.agentId)[Symbol.asyncIterator]().next(), (e: unknown) => e instanceof TaskError && e.code === "too-many");
    for (const it of its) await it.return!();
  });
  it("another peer's cap is independent", async () => {
    const { store } = mk({ port: new FakePort(neverEnds), opts: { maxStreamConnectionsPerPeer: 1 } });
    const a = store.start(args()); const b = store.start(args({ peerId: "p2" }));
    const ia = store.subscribe(a.id, "p1", D.agentId)[Symbol.asyncIterator](); await ia.next();
    const ib = store.subscribe(b.id, "p2", D.agentId)[Symbol.asyncIterator](); await ib.next();
    await ia.return!(); await ib.return!();
  });
  it("subscribe on a foreign or unknown task is not-found", async () => {
    const { store } = mk();
    const t = store.start(args()); await store.settled(t.id);
    await assert.rejects(take(store.subscribe(t.id, "p2", D.agentId)), (e: unknown) => e instanceof TaskError && e.code === "not-found");
    await assert.rejects(take(store.resubscribe("nope", D.peerId, D.agentId)), (e: unknown) => e instanceof TaskError && e.code === "not-found");
  });
  it("resubscribe on a finished task yields exactly one final snapshot", async () => {
    const { store } = mk();
    const t = store.start(args()); await store.settled(t.id);
    assert.deepEqual(kinds(await take(store.resubscribe(t.id, D.peerId, D.agentId))), ["status:completed!"]);
  });
  it("resubscribe on a running task yields a snapshot, then only new events", async () => {
    let release!: () => void; const gate = new Promise<void>((r) => { release = r; });
    const { store } = mk({ port: new FakePort(async function* () { yield { type: "delta", text: "first" }; await gate; yield { type: "delta", text: "second" }; }) });
    const t = store.start(args()); await tick();
    const p = take(store.resubscribe(t.id, D.peerId, D.agentId));
    await tick(); release();
    const evs = await p;
    assert.equal(kinds(evs)[0], "status:working");
    const arts = evs.filter((e) => e.kind === "artifact-update") as Extract<A2aStreamEvent, { kind: "artifact-update" }>[];
    assert.deepEqual(arts.map((a) => a.artifact.parts[0] && (a.artifact.parts[0] as { text: string }).text), ["second", ""]);
    assert.equal(kinds(evs).at(-1), "status:completed!");
  });
});

describe("TaskStore push configuration", () => {
  const withPush = () => { const r = pushRig(); return { ...r, ...mk({ port: new FakePort(neverEnds), push: r.dispatcher }) }; };
  it("every push method fails with not-supported without a dispatcher", async () => {
    const { store } = mk();
    const t = store.start(args()); await store.settled(t.id);
    const notSupported = (e: unknown): boolean => e instanceof PushError && e.code === "not-supported";
    assert.equal(store.push, undefined);
    await assert.rejects(store.admitPush("http://x/"), notSupported);
    assert.throws(() => store.setPush(t.id, D.peerId, D.agentId, { url: "http://x/" }), notSupported);
    assert.throws(() => store.getPush(t.id, D.peerId, D.agentId), notSupported);
    assert.throws(() => store.listPush(t.id, D.peerId, D.agentId), notSupported);
    assert.throws(() => store.deletePush(t.id, D.peerId, D.agentId, "c"), notSupported);
  });
  it("exposes the dispatcher and delegates admission", async () => {
    const { store, dispatcher } = withPush();
    assert.equal(store.push, dispatcher);
    await store.admitPush("http://hook.test/");
  });
  it("admission denial is a PushError(denied)", async () => {
    const denyTransport: PushTransport = { decide: async () => ({ allowed: false, reason: "host-not-allowed", message: "no" }), post: async () => ({ status: 0 }) };
    const d = new PushDispatcher({ transport: denyTransport, scheduler: new ManualScheduler(), clock: { now: () => 0 }, maxAttempts: 1, backoffMs: 1 });
    await assert.rejects(mk({ push: d }).store.admitPush("http://x/"), (e: unknown) => e instanceof PushError && e.code === "denied");
  });
  it("set/get/list/delete round trip, ids assigned or kept", () => {
    const { store } = withPush();
    const t = store.start(args());
    const a = store.setPush(t.id, D.peerId, D.agentId, { url: "http://hook.test/1" });
    const b = store.setPush(t.id, D.peerId, D.agentId, { url: "http://hook.test/2", id: "mine" });
    assert.equal(a.taskId, t.id); assert.ok(a.pushNotificationConfig.id); assert.equal(b.pushNotificationConfig.id, "mine");
    assert.equal(store.getPush(t.id, D.peerId, D.agentId, "mine").pushNotificationConfig.url, "http://hook.test/2");
    assert.equal(store.getPush(t.id, D.peerId, D.agentId).pushNotificationConfig.id, a.pushNotificationConfig.id);
    assert.equal(store.listPush(t.id, D.peerId, D.agentId).length, 2);
    assert.equal(store.deletePush(t.id, D.peerId, D.agentId, "mine"), null);
    assert.equal(store.listPush(t.id, D.peerId, D.agentId).length, 1);
  });
  it("replacing a config with the same id keeps one entry", () => {
    const { store } = withPush();
    const t = store.start(args());
    store.setPush(t.id, D.peerId, D.agentId, { url: "http://hook.test/1", id: "k" });
    store.setPush(t.id, D.peerId, D.agentId, { url: "http://hook.test/2", id: "k" });
    const l = store.listPush(t.id, D.peerId, D.agentId);
    assert.equal(l.length, 1); assert.equal(l[0]!.pushNotificationConfig.url, "http://hook.test/2");
  });
  it("get without id on an empty set, get with unknown id and delete of unknown id are not-found", () => {
    const { store } = withPush();
    const t = store.start(args());
    const nf = (e: unknown): boolean => e instanceof TaskError && e.code === "not-found";
    assert.throws(() => store.getPush(t.id, D.peerId, D.agentId), nf);
    assert.throws(() => store.getPush(t.id, D.peerId, D.agentId, "ghost"), nf);
    assert.throws(() => store.deletePush(t.id, D.peerId, D.agentId, "ghost"), nf);
    assert.deepEqual(store.listPush(t.id, D.peerId, D.agentId), []);
  });
  it("foreign peers cannot touch another peer's push configs", () => {
    const { store } = withPush();
    const t = store.start(args());
    const nf = (e: unknown): boolean => e instanceof TaskError && e.code === "not-found";
    assert.throws(() => store.setPush(t.id, "p2", D.agentId, { url: "http://x/" }), nf);
    assert.throws(() => store.getPush(t.id, "p2", D.agentId), nf);
    assert.throws(() => store.listPush(t.id, "p2", D.agentId), nf);
    assert.throws(() => store.deletePush(t.id, "p2", D.agentId, "c"), nf);
  });
  it("a task without configs triggers no delivery on completion", async () => {
    const { dispatcher, posted } = pushRig();
    const { store } = mk({ push: dispatcher });
    const t = store.start(args()); await store.settled(t.id); await dispatcher.idle();
    assert.equal(posted.length, 0);
  });
});
