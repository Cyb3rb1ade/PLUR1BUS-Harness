// The guard inside a real core: the RPC server, validators and handlers, with a resolver that is not the owner.
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import type { CoreClient } from "@plur1bus/module-api";
import { defaults } from "@plur1bus/config-schema";
import { createCore, type Core } from "../../src/core.ts";
import { layout } from "../../src/paths.ts";
import { memoryAuditSink } from "../../src/rbac/audit.ts";
import type { Principal } from "../../src/rbac/types.ts";
import { connect } from "../helpers/connect.ts";
import { flatTestInternals } from "../helpers/flat-embedder.ts";
import { tempDir } from "../helpers/temp-dir.ts";

const caller = { channel: "cli" as const, accountId: "macbooker", userId: "cyberblade" };

function newHome(): string {
  const home = tempDir("p1b-rbac-");
  const cfg = defaults(); cfg.agents.bernd = {};
  cfg.engine = { neo: { enabled: false }, gc: { enabled: false }, obsidianBridge: { enabled: false }, merging: { enabled: false }, dreaming: { enabled: false }, skillMiner: { enabled: false }, temporalContext: { enabled: false }, conversationReactivationRecall: { enabled: false }, reranker: { enabled: false } };
  writeFileSync(layout(home).configPath, JSON.stringify(cfg));
  return home;
}

describe("rbac in a running core", () => {
  const home = newHome();
  const audit = memoryAuditSink();
  let who: Principal | null = { userId: "u-viewer", role: "viewer" };
  let core: Core; let c: CoreClient;
  before(async () => {
    core = createCore({ home, testInternals: flatTestInternals(), rbac: { resolve: () => who, audit } });
    await core.start();
    c = await connect({ address: core.address, token: core.token });
  });
  after(async () => { await c?.close(); await core?.stop({ budgetMs: 5000 }); });

  const err = (e: any) => ({ error: e.error, reason: e.reason });
  const base = { caller, agentId: "bernd" };

  it("a Viewer is refused admin.*, memory.forget and jobs.run with E_DENIED, and the denial is audited", async () => {
    for (const [m, p] of [["admin.obsidian.detect", base], ["memory.forget", { ...base, id: "m1" }], ["jobs.run", { job: "light", agentId: "bernd" }]] as const) {
      await assert.rejects(c.call(m, p), (e: any) => { assert.deepEqual(err(e), { error: "E_DENIED", reason: "role-denied" }, m); return true; });
    }
    assert.deepEqual(audit.events.map((e) => [e.action, e.target]), [["rbac.denied", "admin.obsidian.detect"], ["rbac.denied", "memory.forget"], ["rbac.denied", "jobs.run"]]);
  });

  it("an unauthenticated resolver is E_UNAUTHORIZED; reads outside the rule table are unaffected", async () => {
    who = null;
    await assert.rejects(c.call("admin.obsidian.detect", base), (e: any) => { assert.deepEqual(err(e), { error: "E_UNAUTHORIZED", reason: "no-principal" }); return true; });
    assert.equal((await c.call<any>("core.status")).process.state, "ready");
  });

  it("an Admin reaches the handler (here: the engine's answer, not a refusal)", async () => {
    who = { userId: "u-admin", role: "admin" };
    const r = await c.call<any>("admin.obsidian.detect", base);
    assert.equal(typeof r, "object");
  });

  it("the default resolver is the local owner: nothing is refused and nothing is audited to a file", async () => {
    const dflt = newHome();
    const k = createCore({ home: dflt, testInternals: flatTestInternals() });
    await k.start();
    const cl = await connect({ address: k.address, token: k.token });
    try {
      assert.ok(await cl.call<any>("admin.obsidian.detect", base));
      assert.equal(existsSync(`${layout(dflt).logs}/audit.log`), false);
    } finally { await cl.close(); await k.stop({ budgetMs: 5000 }); }
  });

  it("the default audit sink writes a refusal to <home>/logs/audit.log", async () => {
    const h = newHome();
    const k = createCore({ home: h, testInternals: flatTestInternals(), rbac: { resolve: () => ({ userId: "u-op", role: "operator" }) } });
    await k.start();
    const cl = await connect({ address: k.address, token: k.token });
    try {
      await assert.rejects(cl.call("admin.migrate", { from: "0", to: "1" }), (e: any) => e.error === "E_DENIED");
      const line = JSON.parse(readFileSync(`${layout(h).logs}/audit.log`, "utf8").trim().split("\n")[0]!);
      assert.equal(line.action, "rbac.denied");
      assert.equal(line.actor.user, "u-op");
      assert.equal(line.target, "admin.migrate");
    } finally { await cl.close(); await k.stop({ budgetMs: 5000 }); }
  });
});
