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
      ["budget.set", { limit: { scope: "agent", period: "day", metric: "cost", hard: 1 } }],
      ["budget.set", { limit: { scope: "global", period: "day", metric: "cost", soft: 9, hard: 1 } }],
      ["budget.set", { limit: { scope: "global", period: "week", metric: "cost", hard: 1 } }],
      ["budget.set", { limit: { scope: "global", period: "day", metric: "cost", hard: 1 }, extra: 1 }],
      ["budget.status", { agentId: "has space" }],
      ["budget.status", { period: "day" }],
    ];
    for (const [m, p] of bad) {
      await assert.rejects(client.call(m, p as never), (e: unknown) => e instanceof RpcCallError && e.error === "E_INVALID_PARAMS", `${m} ${JSON.stringify(p)}`);
    }
    assert.equal(validateParams("budget.set", { limit: { scope: "global", period: "day", metric: "cost", hard: 1 } }).ok, true);
  });
});
