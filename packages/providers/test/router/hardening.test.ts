// The router's fail-closed rules (C3/C4): fallback only on transient classes, breakers per provider+model, abort at every
// point ends as a `ProviderError` of kind `aborted`, foreign exceptions never leave unwrapped, profile defaults.
import assert from "node:assert/strict";
import { getEventListeners } from "node:events";
import { test } from "node:test";
import { ProviderError } from "../../src/errors.ts";
import { ProviderRouter, RouterError, systemClock } from "../../src/router/index.ts";
import type { BudgetGuard, RouterConfig, StreamingAdapter } from "../../src/router/index.ts";
import type { ChatRequest, ChatStreamEvent } from "../../src/types.ts";
import { FakeClock, REQ, auth, cand, down, drain, result, server } from "./helpers.ts";

const T = { timeout: 15_000 };

function setup(profiles: RouterConfig["profiles"], extra: Partial<RouterConfig> = {}) {
  const clock = new FakeClock();
  const router = new ProviderRouter({
    profiles, clock, random: () => 0.5,
    breaker: { failureThreshold: 2, openMs: 1000 }, retry: { maxRetries: 2, baseMs: 100, maxMs: 1000, maxRetryAfterMs: 5000 }, ...extra,
  });
  return { clock, router };
}

/** A clock whose sleep never ends on its own: only the caller's abort ends it (like a real long backoff). */
class HangingClock extends FakeClock {
  override sleep(_ms: number, signal?: AbortSignal): Promise<void> {
    return new Promise<void>((_ok, fail) => {
      if (signal?.aborted) { fail(signal.reason); return; }
      signal?.addEventListener("abort", () => fail(signal.reason), { once: true });
    });
  }
}

/** Pends until the signal aborts, then fails with its reason (what fetch does); an already aborted signal fails at once. */
const abortReason = (signal: AbortSignal | undefined): Promise<never> => new Promise<never>((_ok, fail) => {
  if (signal?.aborted) { fail(signal.reason); return; }
  signal?.addEventListener("abort", () => fail(signal.reason), { once: true });
});

const isAborted = (e: unknown): boolean => e instanceof ProviderError && e.kind === "aborted";

/** Yields one delta, then waits until the call's own signal aborts and fails like fetch does (a raw abort reason). */
const hangingAfterDelta: StreamingAdapter = {
  async *stream(_r, o): AsyncGenerator<ChatStreamEvent, void, void> {
    yield { type: "text_delta", text: "a" };
    await abortReason(o?.signal);
  },
};

const hangingBeforeDelta: StreamingAdapter = {
  // eslint-disable-next-line require-yield
  async *stream(_r, o): AsyncGenerator<ChatStreamEvent, void, void> {
    await abortReason(o?.signal);
  },
};

test("auth is never retried, never falls back and never trips the breaker: the credential problem stays visible", T, async () => {
  const a = cand("A", "m", [{ err: auth() }]);
  const b = cand("B", "m2", [{ text: "x" }]);
  const { router } = setup({ p: [a, b] });
  for (let i = 0; i < 4; i++) {
    await assert.rejects(router.complete("p", REQ), (e) => e instanceof ProviderError && e.kind === "auth", `call ${i}`);
  }
  assert.equal(a.adapter.calls, 4, "one attempt per call, no retry");
  assert.equal(b.adapter.calls, 0, "never answered from another vendor");
  assert.equal(router.breakerState("A", "m"), "closed", "an auth failure says nothing about the provider's health");
});

test("breakers are per provider+model, shared across profiles", T, async () => {
  const m1 = cand("A", "m1", [{ err: down() }]);
  const m2 = cand("A", "m2", [{ text: "ok" }]);
  const { router } = setup({ chat: [m1, m2], other: [m1] });
  await router.complete("chat", REQ);
  await router.complete("chat", REQ);
  assert.equal(router.breakerState("A", "m1"), "open");
  assert.equal(router.breakerState("A", "m2"), "closed", "the same provider's other model is unaffected");
  await assert.rejects(router.complete("other", REQ), (e) => e instanceof RouterError && e.code === "no_candidate_available", "another profile sees the open breaker of that provider+model");
});

test("a caller abort before the first attempt asks no adapter", T, async () => {
  const a = cand("A", "m", [{ text: "x" }]);
  const { router } = setup({ p: [a] });
  const ac = new AbortController();
  ac.abort(new Error("stop"));
  await assert.rejects(router.complete("p", REQ, { signal: ac.signal }), isAborted);
  assert.equal(a.adapter.calls, 0);
});

test("a caller abort while waiting to retry ends the wait at once as `aborted` and starts no further attempt", T, async () => {
  const a = cand("A", "m", [{ err: server() }]);
  const b = cand("B", "m2", [{ text: "x" }]);
  const { router } = setup({ p: [a, b] }, { clock: new HangingClock() });
  const ac = new AbortController();
  const done = router.complete("p", REQ, { signal: ac.signal });
  const settled = assert.rejects(done, isAborted);
  await new Promise((ok) => setImmediate(ok));
  assert.equal(a.adapter.calls, 1);
  ac.abort(new Error("stop"));
  await settled;
  assert.equal(a.adapter.calls, 1, "no retry after the abort");
  assert.equal(b.adapter.calls, 0, "no fallback after the abort");
});

test("a caller abort while a fallback candidate is answering ends the stream at once as `aborted`", T, async () => {
  const a = cand("A", "m", [{ err: down() }]);
  const { router } = setup({ p: [a, { provider: "B", model: "m2", adapter: hangingBeforeDelta }] });
  const ac = new AbortController();
  const settled = assert.rejects(drain(router.stream("p", REQ, { signal: ac.signal })), isAborted);
  await new Promise((ok) => setTimeout(ok, 10));
  ac.abort(new Error("stop"));
  await settled;
  assert.equal(a.adapter.calls, 1);
});

test("a caller abort mid-stream surfaces as `aborted` (not as the adapter's raw abort reason); no retry, no fallback", T, async () => {
  const b = cand("B", "m2", [{ text: "x" }]);
  const { router } = setup({ p: [{ provider: "A", model: "m", adapter: hangingAfterDelta }, b] });
  const ac = new AbortController();
  const seen: string[] = [];
  await assert.rejects(async () => {
    for await (const ev of router.stream("p", REQ, { signal: ac.signal })) {
      seen.push(ev.type);
      if (ev.type === "text_delta") ac.abort(new DOMException("stop", "AbortError"));
    }
  }, isAborted);
  assert.deepEqual(seen, ["served", "text_delta"]);
  assert.equal(b.adapter.calls, 0);
  assert.equal(router.breakerState("A", "m"), "closed", "an abort is not a health signal");
});

test("a foreign exception thrown after the first token is wrapped as well", T, async () => {
  const bug = new RangeError("bug");
  const broken: StreamingAdapter = { async *stream() { yield { type: "text_delta", text: "a" }; throw bug; } };
  const { router } = setup({ p: [{ provider: "A", model: "m", adapter: broken }] });
  await assert.rejects(drain(router.stream("p", REQ)), (e) => e instanceof ProviderError && e.kind === "unknown" && e.cause === bug);
});

test("a budget guard that throws denies the attempt and gives the half-open probe back", T, async () => {
  let broken = false;
  const guard: BudgetGuard = { authorize: () => { if (broken) throw new Error("guard down"); return { ok: true, ticket: { settle() {} } }; } };
  const a = cand("A", "m", [{ err: down() }, { text: "ok" }]);
  const { router, clock } = setup({ p: [a] }, { budget: guard, breaker: { failureThreshold: 1, openMs: 1000 }, retry: { maxRetries: 0 } });
  await assert.rejects(drain(router.stream("p", REQ)), (e) => e instanceof ProviderError && e.kind === "overloaded");
  assert.equal(router.breakerState("A", "m"), "open");
  clock.t += 1000; // half-open: the next admitted call is the one probe
  broken = true;
  await assert.rejects(router.complete("p", REQ), (e) => e instanceof RouterError && e.code === "budget_denied" && /guard failed/.test(e.message));
  broken = false;
  const out = await router.complete("p", REQ);
  assert.equal(out.result.text, "ok", "the probe was given back: the candidate is admitted again instead of staying half-open and busy");
  assert.equal(router.breakerState("A", "m"), "closed");
});

test("the budget guard is handed the caller's signal and the effective request", T, async () => {
  const seen: { signal: AbortSignal | undefined; temperature: number | undefined }[] = [];
  const guard: BudgetGuard = {
    authorize: (_info, request, ctx) => { seen.push({ signal: ctx?.signal, temperature: request.temperature }); return { ok: true, ticket: { settle() {} } }; },
  };
  const a = cand("A", "m", [{ text: "x" }]);
  const { router } = setup({ p: [a] }, { budget: guard, profileDefaults: { p: { temperature: 0.2 } } });
  const ac = new AbortController();
  await router.complete("p", REQ, { signal: ac.signal });
  assert.equal(seen[0]?.signal, ac.signal);
  assert.equal(seen[0]?.temperature, 0.2);
});

test("profile defaults fill only what the request leaves out; the request's own values win", T, async () => {
  const requests: ChatRequest[] = [];
  const spy: StreamingAdapter = { async *stream(r) { requests.push(r); yield { type: "done", result: result("x") }; } };
  const { router } = setup({ p: [{ provider: "A", model: "m", adapter: spy }], q: [{ provider: "A", model: "m", adapter: spy }] }, {
    profileDefaults: { p: { temperature: 0.3, topP: 0.9, maxTokens: 256 } },
  });
  await router.complete("p", REQ);
  await router.complete("p", { ...REQ, temperature: 1, maxTokens: 10 });
  await router.complete("q", REQ);
  assert.deepEqual([requests[0]?.temperature, requests[0]?.topP, requests[0]?.maxTokens], [0.3, 0.9, 256]);
  assert.deepEqual([requests[1]?.temperature, requests[1]?.topP, requests[1]?.maxTokens], [1, 0.9, 10]);
  assert.deepEqual([requests[2]?.temperature, requests[2]?.topP, requests[2]?.maxTokens], [undefined, undefined, undefined], "a profile without defaults leaves the request alone");
  assert.equal(REQ.temperature, undefined, "the caller's request object is never mutated");
});

test("a profile the router cannot execute fails with `unsupported_strategy` and asks no adapter", T, async () => {
  const a = cand("A", "m", [{ text: "x" }]);
  const { router } = setup({ panel: [a] }, { unsupportedProfiles: { panel: "strategy \"moa\" is not executable yet" } });
  await assert.rejects(router.complete("panel", REQ), (e) => e instanceof RouterError && e.code === "unsupported_strategy" && /moa/.test(e.message));
  assert.equal(a.adapter.calls, 0);
  assert.equal(router.hasProfile("panel"), true);
  assert.equal(router.hasProfile("nope"), false);
});

test("systemClock: sleeps for real, rejects with the abort reason, and leaves no listener behind", T, async () => {
  const ac = new AbortController();
  const t0 = systemClock.now();
  await systemClock.sleep(15, ac.signal);
  assert.ok(systemClock.now() - t0 >= 10);
  assert.equal(getEventListeners(ac.signal, "abort").length, 0, "a finished sleep removes its listener");
  const reason = new Error("stop");
  const pending = systemClock.sleep(60_000, ac.signal);
  assert.equal(getEventListeners(ac.signal, "abort").length, 1);
  ac.abort(reason);
  await assert.rejects(pending, (e) => e === reason);
  assert.equal(getEventListeners(ac.signal, "abort").length, 0);
  await assert.rejects(systemClock.sleep(10, ac.signal), (e) => e === reason, "an already aborted signal rejects at once");
});
