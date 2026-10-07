import assert from "node:assert/strict";
import { test } from "node:test";
import { ProviderError } from "../../src/errors.ts";
import { ProviderRouter, RouterError } from "../../src/router/router.ts";
import type { BudgetGuard, RouterConfig } from "../../src/router/types.ts";
import { FakeClock, REQ, auth, badRequest, cand, collector, down, drain, filter, rateLimit, server } from "./helpers.ts";

function setup(profile: ReturnType<typeof cand>[], extra: Partial<RouterConfig> = {}) {
  const clock = new FakeClock();
  const { events, sink } = collector();
  const router = new ProviderRouter({
    profiles: { p: profile }, clock, random: () => 0.5, onEvent: sink,
    breaker: { failureThreshold: 3, openMs: 1000 }, retry: { maxRetries: 2, baseMs: 100, maxMs: 1000, maxRetryAfterMs: 5000 }, ...extra,
  });
  return { clock, events, router };
}
const types = (e: { type: string }[]) => e.map((x) => x.type);

test("success on the first candidate: served event, no fallback, model replaced per candidate", async () => {
  const a = cand("A", "model-a", [{ text: "ok" }]);
  const { router, events } = setup([a]);
  const out = await drain(router.stream("p", REQ));
  assert.deepEqual(out[0], { type: "served", provider: "A", model: "model-a" });
  assert.equal(out.at(-1)?.type, "done");
  assert.deepEqual(a.adapter.models, ["model-a"]);
  assert.deepEqual(events, []);
});

test("retryable failure is retried on the same candidate with jittered backoff", async () => {
  const a = cand("A", "m", [{ err: server() }, { err: server() }, { text: "ok" }]);
  const { router, clock, events } = setup([a]);
  const { result } = await router.complete("p", REQ);
  assert.equal(result.text, "ok");
  assert.equal(a.adapter.calls, 3);
  // random 0.5: floor(0.5 * min(1000, 100*2^n))
  assert.deepEqual(clock.sleeps, [50, 100]);
  assert.deepEqual(types(events), ["provider.retry", "provider.retry"]);
});

test("Retry-After is a floor for the delay; an over-long one skips to fallback", async () => {
  const a = cand("A", "m", [{ err: rateLimit(3000) }, { text: "ok" }]);
  const { router, clock } = setup([a]);
  await router.complete("p", REQ);
  assert.deepEqual(clock.sleeps, [3000]);

  const a2 = cand("A", "m", [{ err: rateLimit(60_000) }]);
  const b2 = cand("B", "m2", [{ text: "from-b" }]);
  const s = setup([a2, b2]);
  const r = await s.router.complete("p", REQ);
  assert.equal(r.served.provider, "B");
  assert.deepEqual(s.clock.sleeps, []);
  assert.equal(a2.adapter.calls, 1);
});

test("retries exhausted -> fallback to the next candidate, with a provider.fallback event before it answers", async () => {
  const a = cand("A", "m", [{ err: server() }]);
  const b = cand("B", "m2", [{ text: "from-b" }]);
  const { router, events } = setup([a, b]);
  const out = await drain(router.stream("p", REQ));
  assert.equal(a.adapter.calls, 3);
  const fb = events.find((e) => e.type === "provider.fallback");
  assert.deepEqual(fb, { type: "provider.fallback", profile: "p", from: { provider: "A", model: "m" }, to: { provider: "B", model: "m2" }, reason: "overloaded" });
  assert.deepEqual(out[0], { type: "served", provider: "B", model: "m2" });
});

test("no silent switch: every answer from a non-first candidate is preceded by provider.fallback", async () => {
  const a = cand("A", "m", [{ err: down() }]);
  const b = cand("B", "m2", [{ text: "x" }]);
  const { router, events } = setup([a, b]);
  const r = await router.complete("p", REQ);
  assert.equal(r.served.provider, "B");
  assert.equal(events.filter((e) => e.type === "provider.fallback").length, 1);
  assert.equal(a.adapter.calls, 1); // a non-retryable answer is not retried
});

test("non-fallbackable errors go to the caller and the next candidate is never asked", async () => {
  for (const err of [badRequest(), filter(), auth(), new ProviderError("context_length", "x"), new ProviderError("unknown", "x")]) {
    const a = cand("A", "m", [{ err }]);
    const b = cand("B", "m2", [{ text: "x" }]);
    const { router, events } = setup([a, b]);
    await assert.rejects(router.complete("p", REQ), (e) => e === err);
    assert.equal(b.adapter.calls, 0);
    assert.equal(a.adapter.calls, 1);
    assert.deepEqual(events, []);
  }
});

test("a foreign (non-ProviderError) exception fails closed and leaves as an `unknown` ProviderError with its cause", async () => {
  const bug = new TypeError("bug");
  const a = cand("A", "m", [{ throwRaw: bug }]);
  const b = cand("B", "m2", [{ text: "x" }]);
  const { router } = setup([a, b]);
  await assert.rejects(router.complete("p", REQ), (e) => e instanceof ProviderError && e.kind === "unknown" && e.cause === bug);
  assert.equal(b.adapter.calls, 0);
});

test("failure AFTER the first streamed token: error to the caller, no retry, no fallback", async () => {
  const a = cand("A", "m", [{ text: "par", textThenErr: server() }]);
  const b = cand("B", "m2", [{ text: "x" }]);
  const { router, events } = setup([a, b]);
  const seen: string[] = [];
  await assert.rejects(async () => { for await (const ev of router.stream("p", REQ)) seen.push(ev.type); }, (e) => e instanceof ProviderError && e.kind === "overloaded");
  assert.deepEqual(seen, ["served", "text_delta"]);
  assert.equal(a.adapter.calls, 1);
  assert.equal(b.adapter.calls, 0);
  assert.deepEqual(events, []);
});

test("failure after the first token still counts against that candidate's breaker", async () => {
  const a = cand("A", "m", [{ text: "par", textThenErr: server() }]);
  const { router } = setup([a], { breaker: { failureThreshold: 2, openMs: 1000 }, retry: { maxRetries: 0 } });
  for (let i = 0; i < 2; i++) await assert.rejects(drain(router.stream("p", REQ)));
  assert.equal(router.breakerState("A", "m"), "open");
});

test("breaker opens after repeated failures; open candidate is skipped (with events) and fallback is reported", async () => {
  const a = cand("A", "m", [{ err: server() }]);
  const b = cand("B", "m2", [{ text: "x" }]);
  const { router, events } = setup([a, b]);
  await router.complete("p", REQ); // A fails 2x -> open (threshold 2), B answers
  assert.equal(router.breakerState("A", "m"), "open");
  const before = a.adapter.calls;
  events.length = 0;
  await router.complete("p", REQ);
  assert.equal(a.adapter.calls, before); // not even tried
  assert.deepEqual(types(events), ["provider.skipped", "provider.fallback"]);
  assert.equal((events[1] as { reason: string }).reason, "breaker_open");
});

test("half-open probe: success closes, failure re-opens; time via fake clock only", async () => {
  const a = cand("A", "m", [{ err: server() }, { err: server() }, { err: server() }, { text: "back" }]);
  const b = cand("B", "m2", [{ text: "x" }]);
  const { router, clock } = setup([a, b], { breaker: { failureThreshold: 2, openMs: 1000 }, retry: { maxRetries: 0 } });
  await router.complete("p", REQ);
  await router.complete("p", REQ); // A: 2 failures -> open
  assert.equal(router.breakerState("A", "m"), "open");
  clock.t += 1000;
  assert.equal(router.breakerState("A", "m"), "half_open");
  await router.complete("p", REQ); // probe fails (3rd scripted err) -> open again, B answers
  assert.equal(router.breakerState("A", "m"), "open");
  clock.t += 1000;
  const r = await router.complete("p", REQ); // probe succeeds
  assert.equal(r.served.provider, "A");
  assert.equal(router.breakerState("A", "m"), "closed");
});

test("all candidates unavailable -> RouterError", async () => {
  const a = cand("A", "m", [{ err: server() }]);
  const { router } = setup([a], { breaker: { failureThreshold: 2, openMs: 1000 }, retry: { maxRetries: 0 } });
  await assert.rejects(router.complete("p", REQ));
  await assert.rejects(router.complete("p", REQ));
  await assert.rejects(router.complete("p", REQ), (e) => e instanceof RouterError && e.code === "no_candidate_available");
});

test("unknown profile", async () => {
  const { router } = setup([cand("A", "m", [{ text: "x" }])]);
  await assert.rejects(router.complete("nope", REQ), (e) => e instanceof RouterError && e.code === "unknown_profile");
});

test("caller abort is rethrown, never retried and not a breaker failure", async () => {
  const ac = new AbortController();
  const aborted = new ProviderError("aborted", "aborted");
  const a = cand("A", "m", [{ err: aborted }]);
  const b = cand("B", "m2", [{ text: "x" }]);
  const { router } = setup([a, b]);
  ac.abort();
  await assert.rejects(router.complete("p", REQ, { signal: ac.signal }));
  assert.equal(a.adapter.calls, 0);
  assert.equal(b.adapter.calls, 0);
  // an aborted ProviderError without the signal set is still not retried/fallen back
  await assert.rejects(router.complete("p", REQ), (e) => e === aborted);
  assert.equal(b.adapter.calls, 0);
  assert.equal(router.breakerState("A", "m"), "closed");
});

test("a throwing event sink never changes routing", async () => {
  const a = cand("A", "m", [{ err: down() }]);
  const b = cand("B", "m2", [{ text: "x" }]);
  const { router } = setup([a, b], { onEvent: () => { throw new Error("sink"); } });
  assert.equal((await router.complete("p", REQ)).served.provider, "B");
});

// --- budget protection -------------------------------------------------------------------------------------

function guard(deny: (provider: string, attempt: number) => string | undefined) {
  const settled: { provider: string; tokens: number | undefined }[] = [];
  const asked: string[] = [];
  const g: BudgetGuard = {
    authorize(info) {
      asked.push(`${info.provider}#${info.attempt}`);
      const why = deny(info.provider, info.attempt);
      if (why !== undefined) return { ok: false, reason: why };
      return { ok: true, ticket: { settle: (u) => { settled.push({ provider: info.provider, tokens: u?.totalTokens }); } } };
    },
  };
  return { g, settled, asked };
}

test("budget: guard is asked before every attempt (retries and fallbacks) and settled with usage", async () => {
  const a = cand("A", "m", [{ err: server() }, { err: server() }, { err: server() }]);
  const b = cand("B", "m2", [{ text: "x" }]);
  const { g, settled, asked } = guard(() => undefined);
  const { router } = setup([a, b], { budget: g });
  await router.complete("p", REQ);
  assert.deepEqual(asked, ["A#1", "A#2", "A#3", "B#4"]);
  assert.equal(settled.length, 4);
  assert.equal(settled.at(-1)?.tokens, 20);
});

test("budget: a denied fallback is never called and the denial is surfaced (cannot bypass the limit)", async () => {
  const a = cand("A", "m", [{ err: server() }]);
  const b = cand("B", "m2", [{ text: "x" }]);
  const { g } = guard((p) => (p === "B" ? "hard limit reached" : undefined));
  const { router, events } = setup([a, b], { budget: g, retry: { maxRetries: 0 } });
  await assert.rejects(router.complete("p", REQ), (e) => e instanceof RouterError && e.code === "budget_denied" && /hard limit/.test(e.message));
  assert.equal(b.adapter.calls, 0);
  assert.ok(events.some((e) => e.type === "provider.skipped" && e.reason === "budget_denied"));
  assert.ok(!events.some((e) => e.type === "provider.fallback"));
});

test("budget: denied first candidate is skipped and a cheaper allowed one answers, with a fallback event", async () => {
  const a = cand("A", "pricey", [{ text: "x" }]);
  const b = cand("B", "cheap", [{ text: "y" }]);
  const { g } = guard((p) => (p === "A" ? "soft limit" : undefined));
  const { router, events } = setup([a, b], { budget: g });
  const r = await router.complete("p", REQ);
  assert.equal(r.served.provider, "B");
  assert.equal(a.adapter.calls, 0);
  assert.equal((events.find((e) => e.type === "provider.fallback") as { reason: string }).reason, "budget_denied");
});

test("budget: maxAttempts caps total spend across retries and fallbacks", async () => {
  const a = cand("A", "m", [{ err: server() }]);
  const b = cand("B", "m2", [{ err: server() }]);
  const { g, asked } = guard(() => undefined);
  const { router } = setup([a, b], { budget: g, maxAttempts: 3 });
  await assert.rejects(router.complete("p", REQ), (e) => e instanceof RouterError && e.code === "attempts_exhausted");
  assert.equal(asked.length, 3);
  assert.equal(a.adapter.calls + b.adapter.calls, 3);
});

test("budget: a retry is re-authorized and can be denied mid-way", async () => {
  const a = cand("A", "m", [{ err: server() }]);
  const { g } = guard((_p, attempt) => (attempt >= 2 ? "limit hit" : undefined));
  const { router } = setup([a], { budget: g });
  await assert.rejects(router.complete("p", REQ), (e) => e instanceof RouterError && e.code === "budget_denied");
  assert.equal(a.adapter.calls, 1);
});

test("early stop by the consumer releases the half-open probe and settles the ticket", async () => {
  const a = cand("A", "m", [{ text: "x" }]);
  const { g, settled } = guard(() => undefined);
  const { router } = setup([a], { budget: g });
  const it = router.stream("p", REQ);
  await it.next(); // served
  await it.return();
  assert.equal(settled.length, 1);
  assert.equal(router.breakerState("A", "m"), "closed");
});
