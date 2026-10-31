import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { validateResult } from "@plur1bus/rpc-schema";
import { RpcError } from "../../src/rpc/errors.ts";
import type { CallContext } from "../../src/rpc/server.ts";
import { buildTelemetryMethods } from "../../src/rpc/telemetry-surface.ts";
import type { CacheUsageRow } from "../../src/budget/cache-report.ts";
import type { CacheUsageSummary } from "../../src/prompt/index.ts";

const NOW = Date.UTC(2026, 9, 31, 12);
const ctx: CallContext = { requestId: "r1", connectionId: "c1", signal: new AbortController().signal };
const row: CacheUsageRow = { provider: "anthropic", agentId: "bernd", model: "m-1", calls: 2, uncachedCalls: 1, inputTokens: 100, outputTokens: 10,
  cacheReadTokens: 60, cacheWriteTokens: 10, cachingInputTokens: 80, hitRatio: 0.6, hitRatioCaching: 0.75 };
const summary: CacheUsageSummary = { cacheReadTokens: 60, cacheCreationTokens: 10, inputTokens: 30, totalInputTokens: 100, hitRatio: 0.6, turns: 2, hits: 1, misses: 1, notCacheable: 0,
  missCauses: { "first-request": 1, "model-changed": 0, "tools-changed": 0, "system-changed": 0, "snapshot-changed": 0, "ttl-expired": 0, provider: 0 } };

function setup(o: { budget?: boolean; telemetry?: boolean } = {}) {
  const calls: unknown[] = [];
  const methods = buildTelemetryMethods({
    clock: () => NOW,
    budget: () => (o.budget === false ? null : { cacheUsage: (q) => { calls.push(q); return [row]; } }),
    cacheTelemetry: () => (o.telemetry === false ? null : { sessionModels: () => [{ model: "m-1", summary }] }),
    sessionAgent: (id) => (id === "s-1" ? "bernd" : null),
  });
  return { call: (p: object) => methods["telemetry.cache.summary"]!(p, ctx) as Promise<any>, calls };
}
const reject = async (p: Promise<unknown>) => { try { await p; } catch (e) { return e as RpcError; } throw new Error("expected rejection"); };

describe("telemetry.cache.summary", () => {
  it("defaults to the 24h window and no session", async () => {
    const { call, calls } = setup();
    const r = await call({});
    assert.equal(r.window, "24h");
    assert.equal(r.until, new Date(NOW).toISOString());
    assert.equal(r.since, new Date(NOW - 86_400_000).toISOString());
    assert.deepEqual(r.providers, [row]); assert.equal(r.session, null);
    assert.deepEqual(calls, [{ since: NOW - 86_400_000, until: NOW }]);
    assert.ok(validateResult("telemetry.cache.summary", r).ok);
  });
  it("supports 7d and forwards agentId", async () => {
    const { call, calls } = setup();
    const r = await call({ window: "7d", agentId: "bernd" });
    assert.equal(r.since, new Date(NOW - 604_800_000).toISOString());
    assert.deepEqual(calls, [{ since: NOW - 604_800_000, until: NOW, agentId: "bernd" }]);
  });
  it("maps the session's per-model counters, or [] without telemetry", async () => {
    const r = await setup().call({ sessionId: "s-1" });
    assert.equal(r.session.agentId, "bernd");
    assert.equal(r.session.models[0].model, "m-1"); assert.equal(r.session.models[0].misses, 1);
    assert.ok(validateResult("telemetry.cache.summary", r).ok, JSON.stringify(validateResult("telemetry.cache.summary", r)));
    const none = await setup({ telemetry: false }).call({ sessionId: "s-1" });
    assert.deepEqual(none.session.models, []);
    assert.ok(validateResult("telemetry.cache.summary", none).ok);
  });
  it("refuses unknown sessions, agent mismatches and a missing ledger", async () => {
    const a = await reject(setup().call({ sessionId: "nope" }));
    assert.equal(a.error, "E_NOT_FOUND"); assert.equal(a.reason, "session-not-found");
    const b = await reject(setup().call({ sessionId: "s-1", agentId: "other" }));
    assert.equal(b.error, "E_INVALID_PARAMS"); assert.equal(b.reason, "agent-session-mismatch");
    const c = await reject(setup({ budget: false }).call({}));
    assert.equal(c.error, "E_NOT_AVAILABLE"); assert.equal(c.reason, "budget-unavailable");
  });
});
