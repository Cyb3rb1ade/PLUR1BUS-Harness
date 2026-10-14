// Audit c16: the local probe is documented to turn every service problem into a state and to reject only on a caller abort.
// A bound that is Infinity ("wait as long as it takes"), NaN or negative must not break that.
import assert from "node:assert/strict";
import { test } from "node:test";
import { discoverLocalEndpoints, probeEndpoint } from "../../src/local/index.ts";

const T = { timeout: 15_000 };
const ORIGIN = "http://127.0.0.1:1";
const list = () => new Response(JSON.stringify({ data: [{ id: "m1" }] }), { status: 200, headers: { "content-type": "application/json" } });
const slowList = (async (_u: unknown, init?: RequestInit) => {
  await new Promise((r) => setTimeout(r, 40));
  if (init?.signal?.aborted) throw init.signal.reason;
  return list();
}) as typeof globalThis.fetch;

test("probeEndpoint: timeoutMs Infinity or beyond the timer range is 'no practical bound', NaN/zero/negative use the default; none throws", T, async () => {
  for (const timeoutMs of [Infinity, 3_000_000_000, Number.NaN, 0, -5]) {
    const r = await probeEndpoint({ origin: ORIGIN, dialects: ["openai"] }, { timeoutMs, fetch: slowList });
    assert.equal(r.state, "ok", `timeoutMs=${timeoutMs}`);
  }
});

test("discoverLocalEndpoints: deadlineMs Infinity, beyond the timer range, NaN or negative does not expire every candidate at once", T, async () => {
  for (const deadlineMs of [Infinity, 3_000_000_000, Number.NaN, -1]) {
    const [r] = await discoverLocalEndpoints({ candidates: [{ origin: ORIGIN, dialects: ["openai"], label: "x" }], deadlineMs, fetch: slowList });
    assert.equal(r?.state, "ok", `deadlineMs=${deadlineMs}`);
  }
});
