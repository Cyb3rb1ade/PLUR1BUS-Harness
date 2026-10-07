import assert from "node:assert/strict";
import { test } from "node:test";
import { usable } from "../src/local/discover.ts";
import type { DiscoveredEndpoint } from "../src/local/discover.ts";
import { LocalEndpointMonitor } from "../src/local/monitor.ts";
import { probeEndpoint } from "../src/local/probe.ts";
import { CircuitBreaker } from "../src/router/breaker.ts";
import { ProviderError } from "../src/index.ts";
import { FakeClock } from "./router/helpers.ts";
import { startStub } from "./helpers/stub.ts";
import { T, adapterFor, basic, candidate, collect, sse } from "./gemini/helpers.ts";

const T15 = { timeout: 15_000 };
const ep = (state: DiscoveredEndpoint["state"], label: string): DiscoveredEndpoint =>
  ({ state, baseUrl: "http://127.0.0.1:1/v1", models: state === "ok" ? [{ id: "m" }] : [], label, origin: "http://127.0.0.1:1" });

test("usable keeps only endpoints in state ok", T15, () => {
  const found = [ep("ok", "a"), ep("empty", "b"), ep("unreachable", "c"), ep("timeout", "d"), ep("protocol", "e"), ep("ok", "f")];
  assert.deepEqual(usable(found).map((f) => f.label), ["a", "f"]);
  assert.deepEqual(usable([]), []);
});

test("refreshInBackground swallows a failing endpoint: status becomes unavailable, nothing is thrown", T15, async () => {
  const monitor = new LocalEndpointMonitor({
    candidates: [{ origin: "http://127.0.0.1:9", dialects: ["openai"], label: "x" }],
    fetch: async () => { throw new TypeError("fetch failed"); },
  });
  assert.equal(monitor.status("x")?.status, "unknown");
  assert.equal(monitor.refreshInBackground(), undefined);
  await monitor.refresh();
  assert.equal(monitor.status("x")?.status, "unavailable");
});

const cand = { origin: "http://127.0.0.1:9", dialects: ["openai" as const], label: "x" };
const rejectingCancel = () => Promise.reject(new Error("cancel failed"));

test("probe: redirect with a body whose cancel rejects is a protocol result", T15, async () => {
  let cancelled = 0;
  const fetch = (async () => ({
    status: 302, ok: false,
    body: { cancel: () => { cancelled++; return rejectingCancel(); } },
  })) as unknown as typeof globalThis.fetch;
  const r = await probeEndpoint(cand, { fetch });
  assert.equal(r.state, "protocol");
  assert.equal(r.httpStatus, 302);
  assert.match(r.detail ?? "", /redirect/);
  assert.equal(cancelled, 1);
});

test("probe: HTTP 500 with a body whose cancel rejects is a protocol result", T15, async () => {
  let cancelled = 0;
  const fetch = (async () => ({
    status: 500, ok: false,
    body: { cancel: () => { cancelled++; return rejectingCancel(); } },
  })) as unknown as typeof globalThis.fetch;
  const r = await probeEndpoint(cand, { fetch });
  assert.equal(r.state, "protocol");
  assert.equal(r.httpStatus, 500);
  assert.match(r.detail ?? "", /HTTP 500/);
  assert.equal(cancelled, 1);
});

test("probe: an oversized body whose reader cancel rejects is a protocol result 'too large'", T15, async () => {
  let cancelled = 0;
  const big = new Uint8Array(1024 * 1024 + 1);
  const fetch = (async () => ({
    status: 200, ok: true,
    body: { getReader: () => ({
      read: async () => ({ done: false, value: big }),
      cancel: () => { cancelled++; return rejectingCancel(); },
    }) },
  })) as unknown as typeof globalThis.fetch;
  const r = await probeEndpoint(cand, { fetch });
  assert.equal(r.state, "protocol");
  assert.match(r.detail ?? "", /too large/);
  assert.equal(cancelled, 1);
});

test("CircuitBreaker without onChange: closed -> open -> half_open -> closed, and half_open failure reopens", T15, () => {
  const clock = new FakeClock();
  const b = new CircuitBreaker({ failureThreshold: 2, openMs: 1000 }, clock);
  assert.equal(b.state, "closed");
  b.failure();
  assert.equal(b.state, "closed");
  b.failure();
  assert.equal(b.state, "open");
  assert.deepEqual(b.admit(), { allowed: false, reason: "breaker_open" });
  clock.t += 1000;
  assert.equal(b.state, "half_open");
  assert.deepEqual(b.admit(), { allowed: true });
  assert.deepEqual(b.admit(), { allowed: false, reason: "half_open_busy" });
  b.failure();
  assert.equal(b.state, "open");
  clock.t += 1000;
  assert.deepEqual(b.admit(), { allowed: true });
  b.release();
  assert.deepEqual(b.admit(), { allowed: true });
  b.success();
  assert.equal(b.state, "closed");
  assert.deepEqual(b.admit(), { allowed: true });
});

test("gemini stream: functionCall then a candidate safety block keeps the tool call in partial.toolCalls", T, async () => {
  const stub = await startStub((_q, res) => sse(res, [
    candidate([{ functionCall: { name: "lookup", args: { q: "x" } } }]),
    candidate([], "SAFETY", { safetyRatings: [{ category: "HARM_CATEGORY_HARASSMENT", probability: "HIGH", blocked: true }] }),
  ]));
  try {
    await assert.rejects(collect(adapterFor(stub).adapter.stream(basic)), (e: unknown) => {
      assert.ok(e instanceof ProviderError);
      const calls = e.partial?.toolCalls ?? [];
      assert.equal(calls.length, 1);
      assert.equal(calls[0]?.index, 0);
      assert.equal(calls[0]?.name, "lookup");
      assert.equal(calls[0]?.argumentsRaw, JSON.stringify({ q: "x" }));
      assert.ok(calls[0]?.id);
      return true;
    });
  } finally { await stub.close(); }
});
