import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { type CoreClient, RpcCallError } from "@plur1bus/module-api";
import { connect } from "./helpers/connect.ts";
import { validateParams, validateResult } from "@plur1bus/rpc-schema";
import { buildMethods } from "../src/rpc/methods.ts";
import { createRpcServer, type RpcServer } from "../src/rpc/server.ts";
import { createLogger } from "../src/logger.ts";
import { ActivityTracker } from "../src/activity.ts";
import { open, Clock } from "./budget/helpers.ts";

describe("budget RPC", () => {
  const TOKEN = "b".repeat(64);
  let server: RpcServer; let client: CoreClient; let svc: ReturnType<typeof open>["svc"]; let clock: Clock;

  before(async () => {
    const o = open({ tz: "Europe/Berlin" });
    svc = o.svc; clock = o.clock;
    const address = process.platform === "win32" ? `\\\\.\\pipe\\plur1bus-budget-rpc-${process.pid}` : join(o.dir, "core.sock");
    const log = createLogger({ file: join(o.dir, "core.log"), level: "error", role: "core" });
    const methods = buildMethods({
      engine: {} as never, config: () => ({}) as never, agents: {} as never, activity: new ActivityTracker(() => clock.now()), logger: log,
      status: () => ({}) as never, shutdown: () => {}, journalBacklog: () => 0, clock: () => clock.now(), captureSignal: new AbortController().signal,
      isStopping: () => false, adopt: () => ({}) as never, onMigrated: () => {}, budget: svc,
    });
    server = createRpcServer({ address, token: TOKEN, hello: () => ({ contract: "1.0.0", rpc: "1.5.0", instanceId: "i", pid: process.pid }), methods, logger: log });
    await server.listen();
    client = await connect({ address, token: TOKEN });
  });
  after(async () => { await client?.close(); await server?.close(); svc.close(); });

  it("budget.set stores a limit and the zone; budget.status shows usage, limits and states, matching the schema", async () => {
    const set = await client.call<any>("budget.set", { timeZone: "Europe/Berlin", limit: { scope: "agent", agentId: "a1", period: "day", metric: "tokens", soft: 100, hard: 200 } });
    assert.deepEqual(set.limit, { scope: "agent", agentId: "a1", period: "day", metric: "tokens", soft: 100, hard: 200 });
    assert.equal(set.timeZone, "Europe/Berlin");
    assert.equal(validateResult("budget.set", set).ok, true);

    svc.recordUsage({ agent: "a1", model: "m-small", inputTokens: 150, outputTokens: 0 });
    const st = await client.call<any>("budget.status", {});
    assert.equal(validateResult("budget.status", st).ok, true, JSON.stringify(validateResult("budget.status", st)));
    assert.equal(st.periods[0].key, "2026-10-06");
    assert.equal(st.periods[0].start, "2026-10-05T22:00:00.000Z");
    assert.equal(st.periods[0].agents[0].models[0].model, "m-small");
    assert.deepEqual([st.limits[0].used, st.limits[0].state], [150, "soft"]);

    const only = await client.call<any>("budget.status", { agentId: "nobody" });
    assert.equal(only.periods[0].total.events, 0);
    assert.deepEqual(only.limits, []);
  });

  it("budget.set clears with null and zone-only changes carry no limit", async () => {
    const cleared = await client.call<any>("budget.set", { limit: { scope: "agent", agentId: "a1", period: "day", metric: "tokens", soft: null, hard: null } });
    assert.equal(cleared.limit, null);
    assert.deepEqual(cleared.limits, []);
    const zone = await client.call<any>("budget.set", { timeZone: "UTC" });
    assert.equal("limit" in zone, false);
    assert.equal(zone.timeZone, "UTC");
  });

  it("refuses bad input as E_INVALID_PARAMS", async () => {
    const bad: [string, unknown][] = [
      ["budget.set", {}],
      ["budget.set", { timeZone: "Mars/Base" }],
      ["budget.set", { limit: { scope: "agent", period: "day", metric: "tokens", hard: 1 } }],
      ["budget.set", { limit: { scope: "global", period: "day", metric: "tokens", soft: 9, hard: 1 } }],
      ["budget.set", { limit: { scope: "global", period: "week", metric: "tokens", hard: 1 } }],
      ["budget.set", { limit: { scope: "global", period: "day", metric: "tokens", hard: 1 }, extra: 1 }],
      // No money dimension since 2026-10-19: the cost metric is not part of the wire format any more.
      ["budget.set", { limit: { scope: "global", period: "day", metric: "cost", hard: 1 } }],
      ["budget.status", { agentId: "has space" }],
      ["budget.status", { period: "day" }],
    ];
    for (const [m, p] of bad) {
      await assert.rejects(client.call(m, p as never), (e: unknown) => e instanceof RpcCallError && e.error === "E_INVALID_PARAMS", `${m} ${JSON.stringify(p)}`);
    }
    assert.equal(validateParams("budget.set", { limit: { scope: "global", period: "day", metric: "tokens", hard: 1 } }).ok, true);
    assert.equal(validateParams("budget.set", { limit: { scope: "global", period: "day", metric: "cost", hard: 1 } }).ok, false);
  });

  it("sets and returns cache-read weights, preserving existing limits when weight is omitted", async () => {
    const limit = { scope: "agent", agentId: "weighted", period: "day", metric: "tokens", hard: 1200 };
    const set = await client.call<any>("budget.set", { limit, cacheReadWeight: 0.1 });
    assert.equal(set.cacheReadWeight, 0.1);
    assert.equal(set.limit.hard, 1200);
    assert.equal(validateResult("budget.set", set).ok, true);
    svc.recordUsage({ agent: "weighted", model: "m-small", inputTokens: 1000, outputTokens: 100, cacheReadTokens: 900, cacheWriteTokens: 50 });
    const status = await client.call<any>("budget.status", { agentId: "weighted" });
    assert.equal(status.cacheReadWeight, 0.1);
    assert.equal(status.periods[0].total.freshInputTokens, 50);
    assert.equal(status.periods[0].total.countedTokens, 290);
    assert.equal(status.limits[0].used, 290);
    assert.equal(validateResult("budget.status", status).ok, true);
    const zone = await client.call<any>("budget.set", { timeZone: "UTC" });
    assert.equal(zone.cacheReadWeight, 0.1);
    assert.equal(zone.limits.find((l: { agentId: string }) => l.agentId === "weighted").hard, 1200);
    assert.equal((await client.call<any>("budget.set", { cacheReadWeight: 0 })).cacheReadWeight, 0);
    assert.equal((await client.call<any>("budget.set", { cacheReadWeight: 1 })).cacheReadWeight, 1);
    assert.equal((await client.call<any>("budget.set", { cacheReadWeight: 0.1234567 })).cacheReadWeight, 0.123457);
  });

  it("rejects bad combined settings without persisting a partial change", async () => {
    await client.call("budget.set", { timeZone: "UTC" });
    svc.setCacheReadWeight(0.25);
    const before = svc.status();
    const bad = [
      { timeZone: "Europe/Berlin", cacheReadWeight: -0.1 },
      { timeZone: "Europe/Berlin", cacheReadWeight: 1.1 },
      { timeZone: "Europe/Berlin", cacheReadWeight: "0.1" },
      { timeZone: "Europe/Berlin", cacheReadWeight: null },
      { timeZone: "Europe/Berlin", cacheReadWeight: 0, limit: { scope: "global", period: "day", metric: "tokens", soft: 10, hard: 1 } },
      { timeZone: "Mars/Base", cacheReadWeight: 0 },
      { timeZone: "Mars/Base", cacheReadWeight: 0, limit: { scope: "global", period: "day", metric: "tokens", hard: 444 } },
    ];
    for (const params of bad) {
      await assert.rejects(client.call("budget.set", params as never), (e: unknown) => e instanceof RpcCallError && e.error === "E_INVALID_PARAMS");
      assert.equal(svc.timeZone(), "UTC");
      assert.equal(svc.cacheReadWeight(), 0.25);
      assert.deepEqual(svc.limits(), before.limits.map(({ used: _used, state: _state, ...limit }) => limit));
    }
  });
});
