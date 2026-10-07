import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type CoreClient } from "@plur1bus/module-api";
import { validateParams, validateResult } from "@plur1bus/rpc-schema";
import { connect } from "../helpers/connect.ts";
import { buildMethods } from "../../src/rpc/methods.ts";
import { createRpcServer, type RpcServer } from "../../src/rpc/server.ts";
import { createLogger } from "../../src/logger.ts";
import { ActivityTracker } from "../../src/activity.ts";
import { createEgress } from "../../src/egress/index.ts";
import { stubResolver } from "../tools/web/helpers.ts";

describe("egress.status RPC", () => {
  const TOKEN = "e".repeat(64);
  let dir: string; let server: RpcServer; let client: CoreClient;
  const cfg = { allowHosts: ["Api.Example.com"], allowPorts: [443], allowLoopback: false };

  before(async () => {
    dir = mkdtempSync(join(tmpdir(), "plur1bus-egress-rpc-"));
    const egress = createEgress({ config: () => cfg, resolver: stubResolver({ "api.example.com": ["93.184.216.34"] }), now: () => 0 });
    await egress.decide("https://api.example.com/");
    await egress.decide("https://evil.example/secret-path?token=abc");
    const address = process.platform === "win32" ? `\\\\.\\pipe\\plur1bus-egress-rpc-${process.pid}` : join(dir, "core.sock");
    const log = createLogger({ file: join(dir, "core.log"), level: "error", role: "core" });
    const methods = buildMethods({
      engine: {} as never, config: () => ({}) as never, agents: {} as never, activity: new ActivityTracker(() => 0), logger: log,
      status: () => ({}) as never, shutdown: () => {}, journalBacklog: () => 0, clock: () => 0, captureSignal: new AbortController().signal,
      isStopping: () => false, adopt: () => ({}) as never, onMigrated: () => {}, egress,
    });
    server = createRpcServer({ address, token: TOKEN, hello: () => ({ contract: "1.0.0", rpc: "1.5.0", instanceId: "i", pid: process.pid }), methods, logger: log });
    await server.listen();
    client = await connect({ address, token: TOKEN });
  });
  after(async () => { await client?.close(); await server?.close(); rmSync(dir, { recursive: true, force: true }); });

  it("answers the policy and counters, matching the schema, without any URL", async () => {
    const st = await client.call<any>("egress.status", {});
    assert.deepEqual(validateResult("egress.status", st), { ok: true });
    assert.deepEqual(st.policy, { allowHosts: ["api.example.com"], allowPorts: [443], allowLoopback: false, valid: true, errors: [] });
    assert.deepEqual(st.decisions, { allowed: 1, denied: 1, byReason: { "host-not-allowed": 1 } });
    assert.equal(st.since, "1970-01-01T00:00:00.000Z");
    assert.ok(!JSON.stringify(st).includes("secret-path"));
  });
  it("takes no parameters", async () => {
    assert.equal(validateParams("egress.status", {}).ok, true);
    assert.equal(validateParams("egress.status", { x: 1 }).ok, false);
    await assert.rejects(client.call("egress.status", { x: 1 }), (e: any) => e.error === "E_INVALID_PARAMS");
  });
});
