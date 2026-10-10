import { test, mock } from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_FEATURE_BUDGET_MS, FEATURE_NAMES, LOCAL_REALTIME_DEFAULTS, createFeatureRunner, resolveProfile, type FeatureEvent, type LocalRealtimeProfile } from "../src/realtime/profile.ts";
import { FeatureLatencyRecorder } from "../src/realtime/latency.ts";

test("defaults match the brief", () => {
  const p = resolveProfile(undefined);
  assert.equal(p.enabled, false);
  assert.equal(p.endpointingMs, 400);
  assert.equal(p.speculativeTurnStart, false);
  assert.equal(p.ackSound, false);
  assert.equal(p.toolSchemas, "reduced");
  assert.equal(p.auditDetail, "minimal");
  assert.deepEqual(p.features, {
    autoRecall: { mode: "on", maxMs: 30 },
    reranker: { mode: "off" },
    recallMultiIdentity: { mode: "off" },
    promptEnrichment: { mode: "on", maxMs: 10 },
    decisionService: { mode: "off" },
    postTurnRefine: { mode: "deferred" },
    memoryWrite: { mode: "deferred" },
    compaction: { mode: "deferred" },
  });
  assert.deepEqual(Object.keys(p.features).sort(), [...FEATURE_NAMES].sort());
  assert.ok(p.sentenceChunking.maxWords > 0);
});

test("resolving never mutates the shared defaults", () => {
  const p = resolveProfile({ features: { reranker: "on" } });
  p.features.autoRecall.maxMs = 999;
  assert.equal(LOCAL_REALTIME_DEFAULTS.features.autoRecall.maxMs, 30);
  assert.equal(resolveProfile(undefined).features.autoRecall.maxMs, 30);
});

test("global config overrides defaults: string and object feature forms, maxMs kept unless replaced", () => {
  const p = resolveProfile({ enabled: true, endpointingMs: 250, speculativeTurnStart: true, ackSound: true, sentenceChunking: { maxWords: 12 }, toolSchemas: "full", auditDetail: "full", features: { reranker: "on", autoRecall: { maxMs: 50 }, promptEnrichment: "off", memoryWrite: { mode: "on", maxMs: 80 } } });
  assert.equal(p.enabled, true);
  assert.equal(p.endpointingMs, 250);
  assert.equal(p.speculativeTurnStart, true);
  assert.equal(p.ackSound, true);
  assert.equal(p.sentenceChunking.maxWords, 12);
  assert.equal(p.toolSchemas, "full");
  assert.equal(p.auditDetail, "full");
  assert.deepEqual(p.features.reranker, { mode: "on", maxMs: DEFAULT_FEATURE_BUDGET_MS }, "an on feature without maxMs gets the default budget");
  assert.deepEqual(p.features.autoRecall, { mode: "on", maxMs: 50 });
  assert.deepEqual(p.features.promptEnrichment, { mode: "off", maxMs: 10 });
  assert.deepEqual(p.features.memoryWrite, { mode: "on", maxMs: 80 });
});

test("per-agent override beats global, only for the agent named; other agents see the global values", () => {
  const cfg = { enabled: true, endpointingMs: 300, features: { autoRecall: { mode: "on" as const, maxMs: 40 } }, perAgent: { bernd: { endpointingMs: 700, speculativeTurnStart: true, features: { autoRecall: "off" as const, reranker: { mode: "on" as const, maxMs: 20 } } } } };
  const bernd = resolveProfile(cfg, "bernd");
  const anna = resolveProfile(cfg, "anna");
  const none = resolveProfile(cfg);
  assert.equal(bernd.endpointingMs, 700);
  assert.equal(bernd.speculativeTurnStart, true);
  assert.deepEqual(bernd.features.autoRecall, { mode: "off", maxMs: 40 });
  assert.deepEqual(bernd.features.reranker, { mode: "on", maxMs: 20 });
  assert.equal(bernd.enabled, true, "unset keys fall through to the global layer");
  assert.equal(anna.endpointingMs, 300);
  assert.deepEqual(anna.features.autoRecall, { mode: "on", maxMs: 40 });
  assert.deepEqual(none, anna);
});

function runner(profile: LocalRealtimeProfile, extra: { recorder?: FeatureLatencyRecorder; now?: () => number } = {}) {
  const events: FeatureEvent[] = [];
  let t = 0;
  const r = createFeatureRunner({ profile, emit: (e) => events.push(e), now: extra.now ?? (() => t), ...(extra.recorder ? { recorder: extra.recorder, turnId: "t1" } : {}) });
  return { r, events, advance: (ms: number) => { t += ms; } };
}
const on = (cfg: Parameters<typeof resolveProfile>[0] = {}) => resolveProfile({ enabled: true, ...cfg });

test("runWithBudget: a feature that finishes inside the budget returns its value", async () => {
  const { r, events } = runner(on());
  const res = await r.runWithBudget("autoRecall", async () => 42);
  assert.deepEqual(res, { ok: true, value: 42 });
  assert.deepEqual(events.map((e) => e.type), ["feature.completed"]);
});

test("runWithBudget: exceeding maxMs returns budget_exceeded, aborts the work and emits one event (fake timers)", async () => {
  mock.timers.enable({ apis: ["setTimeout"] });
  try {
    const rec = new FeatureLatencyRecorder({ now: () => 0 });
    const { r, events, advance } = runner(on(), { recorder: rec });
    let sawAbort = false;
    const p = r.runWithBudget("autoRecall", (signal) => new Promise<string>((resolve) => { signal.addEventListener("abort", () => { sawAbort = true; }); setTimeout(() => resolve("late"), 1000); }));
    advance(31);
    mock.timers.tick(30);
    assert.deepEqual(await p, { ok: false, reason: "budget_exceeded", maxMs: 30 });
    assert.equal(sawAbort, true);
    assert.deepEqual(events, [{ type: "feature.budget_exceeded", feature: "autoRecall", maxMs: 30, elapsedMs: 31 }]);
    assert.equal(rec.report().features["autoRecall"]!.budgetExceeded, 1);
    mock.timers.tick(5000); // the late result is ignored, no second event
    assert.equal(events.length, 1);
  } finally { mock.timers.reset(); }
});

test("runWithBudget: the exact budget boundary is still within budget; one tick over is not", async () => {
  mock.timers.enable({ apis: ["setTimeout"] });
  try {
    const { r } = runner(on({ features: { promptEnrichment: { mode: "on", maxMs: 10 } } }));
    let resolveWork!: (v: number) => void;
    const p = r.runWithBudget("promptEnrichment", () => new Promise<number>((res) => { resolveWork = res; }));
    mock.timers.tick(9);
    resolveWork(1);
    assert.deepEqual(await p, { ok: true, value: 1 });
    const p2 = r.runWithBudget("promptEnrichment", () => new Promise<number>(() => {}));
    mock.timers.tick(10);
    assert.equal((await p2).ok, false);
  } finally { mock.timers.reset(); }
});

test("off and deferred features do not run inline; deferred work is queued and drained after the turn", async () => {
  const { r, events } = runner(on());
  let ran = 0;
  assert.deepEqual(await r.runWithBudget("reranker", async () => { ran++; }), { ok: false, reason: "off" });
  assert.deepEqual(await r.runWithBudget("memoryWrite", async () => { ran++; }), { ok: false, reason: "deferred" });
  assert.equal(ran, 0);
  assert.deepEqual(events.map((e) => e.type === "feature.skipped" && `${e.feature}:${e.reason}`), ["reranker:off", "memoryWrite:deferred"]);
  const order: string[] = [];
  r.defer("memoryWrite", async () => { order.push("write"); });
  r.defer("compaction", async () => { throw new Error("fails"); });
  r.defer("postTurnRefine", async () => { order.push("refine"); });
  assert.equal(r.pendingDeferred, 3);
  assert.equal(await r.drainDeferred(), 3);
  assert.deepEqual(order, ["write", "refine"]);
  assert.equal(r.pendingDeferred, 0);
  assert.deepEqual(events.slice(2).map((e) => e.type), ["feature.completed", "feature.failed", "feature.completed"]);
});

test("a throwing feature does not break the turn: error result and a failed event", async () => {
  const { r, events } = runner(on());
  const res = await r.runWithBudget("autoRecall", async () => { throw new Error("db down"); });
  assert.equal(res.ok, false);
  assert.equal((res as { reason: string }).reason, "error");
  assert.deepEqual(events.map((e) => e.type), ["feature.failed"]);
});

test("a caller abort wins: aborted result, work signalled, no budget event", async () => {
  const { r, events } = runner(on());
  const ctl = new AbortController();
  ctl.abort();
  assert.deepEqual(await r.runWithBudget("autoRecall", async () => 1, ctl.signal), { ok: false, reason: "aborted" });
  assert.equal(events.length, 0);
  const ctl2 = new AbortController();
  let inner: AbortSignal | undefined;
  const p = r.runWithBudget("autoRecall", (s) => { inner = s; return new Promise<number>((res) => s.addEventListener("abort", () => res(0))); }, ctl2.signal);
  ctl2.abort();
  assert.deepEqual(await p, { ok: false, reason: "aborted" });
  assert.equal(inner?.aborted, true);
});

test("when the local-realtime profile is not enabled every feature runs normally, with no budget", async () => {
  mock.timers.enable({ apis: ["setTimeout"] });
  try {
    const { r, events } = runner(resolveProfile({}));
    assert.deepEqual(await r.runWithBudget("reranker", async () => "ran"), { ok: true, value: "ran" });
    let done = false;
    const p = r.runWithBudget("autoRecall", () => new Promise<string>((res) => setTimeout(() => { done = true; res("slow"); }, 500)));
    mock.timers.tick(500);
    assert.deepEqual(await p, { ok: true, value: "slow" });
    assert.equal(done, true);
    assert.ok(events.every((e) => e.type === "feature.completed"));
  } finally { mock.timers.reset(); }
});

// ---- F4 / F5 / F6 ----

const enabledProfile = (): LocalRealtimeProfile => resolveProfile({ enabled: true });

test("F4: an aborted drain loses no job: the jobs not run stay queued and a later drain runs them", async () => {
  const runner = createFeatureRunner({ profile: enabledProfile(), emit: () => {} });
  const ran: string[] = [];
  runner.defer("memoryWrite", async () => { ran.push("a"); });
  runner.defer("memoryWrite", async () => { ran.push("b"); });
  const ctl = new AbortController();
  ctl.abort();
  assert.equal(await runner.drainDeferred(ctl.signal), 0);
  assert.equal(runner.pendingDeferred, 2);
  assert.deepEqual(ran, []);
  assert.equal(await runner.drainDeferred(), 2);
  assert.deepEqual(ran, ["a", "b"]);
});

test("F4: an abort between jobs stops the drain with the rest still queued; the running job sees the abort", async () => {
  const runner = createFeatureRunner({ profile: enabledProfile(), emit: () => {} });
  const ctl = new AbortController();
  let seen = false;
  runner.defer("memoryWrite", async (s) => { ctl.abort(); seen = s.aborted; });
  runner.defer("compaction", async () => { throw new Error("must not run"); });
  assert.equal(await runner.drainDeferred(ctl.signal), 1);
  assert.equal(seen, true);
  assert.equal(runner.pendingDeferred, 1);
});

test("F5: a caller abort returns promptly even without maxMs and with an fn that ignores the signal", async () => {
  const events: FeatureEvent[] = [];
  const runner = createFeatureRunner({ profile: resolveProfile({ enabled: false }), emit: (e) => events.push(e) });
  const ctl = new AbortController();
  const p = runner.runWithBudget("autoRecall", () => new Promise<never>(() => {}), ctl.signal);
  ctl.abort();
  assert.deepEqual(await p, { ok: false, reason: "aborted" });
});

test("F5: a feature switched on without maxMs in an enabled profile still returns on abort", async () => {
  const profile = enabledProfile();
  delete profile.features.reranker.maxMs;
  profile.features.reranker.mode = "on";
  const runner = createFeatureRunner({ profile, emit: () => {} });
  const ctl = new AbortController();
  const p = runner.runWithBudget("reranker", () => new Promise<never>(() => {}), ctl.signal);
  ctl.abort();
  assert.deepEqual(await p, { ok: false, reason: "aborted" });
});

test("F5: a synchronously throwing fn is an error result with a feature.failed event, not a rejection", async () => {
  const events: FeatureEvent[] = [];
  const runner = createFeatureRunner({ profile: enabledProfile(), emit: (e) => events.push(e) });
  const boom = new Error("sync");
  const r = await runner.runWithBudget("autoRecall", (() => { throw boom; }) as never);
  assert.deepEqual(r, { ok: false, reason: "error", error: boom });
  assert.equal(events.at(-1)?.type, "feature.failed");
});

test("F6: invalid layer values are ignored and fall back to the lower layer", () => {
  const bad = { endpointingMs: Number.NaN, sentenceChunking: { maxWords: 0 }, features: { autoRecall: { mode: "bogus", maxMs: -4 }, reranker: { mode: "on", maxMs: "abc" } } };
  const p = resolveProfile({ enabled: true, ...bad, perAgent: { a: { endpointingMs: -5, ackSound: "yes" as never } } } as never, "a");
  assert.equal(p.endpointingMs, 400, "NaN global falls back to the default");
  assert.equal(p.ackSound, false);
  assert.equal(p.sentenceChunking.maxWords, 24);
  assert.deepEqual(p.features.autoRecall, { mode: "on", maxMs: 30 });
  assert.equal(p.features.reranker.mode, "on");
  const q = resolveProfile({ endpointingMs: 250, perAgent: { a: { endpointingMs: "abc" as never }, b: { endpointingMs: 1.5 }, c: { endpointingMs: 0 } } }, "a");
  assert.equal(q.endpointingMs, 250, "invalid per-agent value falls back to the global one");
  assert.equal(resolveProfile({ endpointingMs: 250, perAgent: { b: { endpointingMs: 1.5 } } }, "b").endpointingMs, 250);
  assert.equal(resolveProfile({ perAgent: { c: { endpointingMs: 0 } } }, "c").endpointingMs, 0);
});

test("F6: an enabled profile gives an on feature without maxMs the default budget; a disabled one is left alone", () => {
  const p = resolveProfile({ enabled: true, features: { reranker: { mode: "on" } } });
  assert.equal(DEFAULT_FEATURE_BUDGET_MS, 50);
  assert.equal(p.features.reranker.maxMs, DEFAULT_FEATURE_BUDGET_MS);
  assert.equal(p.features.decisionService.maxMs, undefined, "off features get no budget");
  assert.equal(resolveProfile({ features: { reranker: { mode: "on" } } }).features.reranker.maxMs, undefined);
});
