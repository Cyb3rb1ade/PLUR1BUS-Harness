// B5: audit.verify in a running core, the RBAC refusal that feeds the chain, and the tee.
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import type { CoreClient } from "@plur1bus/module-api";
import { defaults } from "@plur1bus/config-schema";
import { validateResult } from "@plur1bus/rpc-schema";
import { createCore, type Core } from "../../src/core.ts";
import { layout } from "../../src/paths.ts";
import { teeAudit } from "../../src/audit/index.ts";
import { memoryAuditSink, type AuditEvent } from "../../src/rbac/audit.ts";
import type { Principal } from "../../src/rbac/types.ts";
import { connect } from "../helpers/connect.ts";
import { flatTestInternals } from "../helpers/flat-embedder.ts";
import { tempDir } from "../helpers/temp-dir.ts";

function newHome(): string {
  const home = tempDir("p1b-auditrpc-");
  const cfg = defaults(); cfg.agents.bernd = {};
  cfg.engine = { neo: { enabled: false }, gc: { enabled: false }, obsidianBridge: { enabled: false }, merging: { enabled: false }, dreaming: { enabled: false }, skillMiner: { enabled: false }, temporalContext: { enabled: false }, conversationReactivationRecall: { enabled: false } } as typeof cfg.engine;
  writeFileSync(layout(home).configPath, JSON.stringify(cfg));
  return home;
}

describe("audit.verify in a running core", () => {
  const home = newHome();
  let who: Principal = { userId: "u-op", role: "operator" };
  let core: Core; let c: CoreClient;
  before(async () => {
    core = createCore({ home, testInternals: flatTestInternals(), rbac: { resolve: () => who } });
    await core.start();
    c = await connect({ address: core.address, token: core.token });
  });
  after(async () => { await c?.close(); await core?.stop({ budgetMs: 5000 }); });

  it("is denied to an Operator, and that denial is the first line of the chain (and of the legacy audit.log)", async () => {
    await assert.rejects(c.call("audit.verify", {}), (e: any) => e.error === "E_DENIED" && e.reason === "role-denied");
    const chain = readFileSync(`${layout(home).logs}/audit.chain.jsonl`, "utf8").trim().split("\n").map((l) => JSON.parse(l));
    assert.equal(chain.length, 1);
    assert.equal(chain[0].action, "rbac.denied"); assert.equal(chain[0].target, "audit.verify"); assert.equal(chain[0].seq, 1);
    assert.equal(JSON.parse(readFileSync(`${layout(home).logs}/audit.log`, "utf8").trim().split("\n")[0]!).action, "rbac.denied");
  });

  it("an Admin gets a schema-valid, ok result; a tampered chain turns it red", async () => {
    who = { userId: "u-admin", role: "admin" };
    const r = await c.call<any>("audit.verify", {});
    assert.equal(validateResult("audit.verify", r).ok, true, JSON.stringify(validateResult("audit.verify", r)));
    assert.equal(r.ok, true); assert.equal(r.lines, 1); assert.equal(r.anchor, "match");
    const file = `${layout(home).logs}/audit.chain.jsonl`;
    writeFileSync(file, readFileSync(file, "utf8").replace("rbac.denied", "rbac.allowed"));
    const bad = await c.call<any>("audit.verify", {});
    assert.equal(validateResult("audit.verify", bad).ok, true);
    assert.equal(bad.ok, false); assert.equal(bad.anchor, "mismatch");
    assert.ok(!JSON.stringify(bad).includes(home), "no path leaves the core");
  });

  it("params must be empty", async () => {
    await assert.rejects(c.call("audit.verify", { deep: true }), (e: any) => e.error === "E_INVALID_PARAMS");
  });
});

describe("audit.verify on a fresh core", () => {
  it("is ok with an empty chain and creates no chain file by itself", async () => {
    const home = newHome();
    const k = createCore({ home, testInternals: flatTestInternals() });
    await k.start();
    const cl = await connect({ address: k.address, token: k.token });
    try {
      const r = await cl.call<any>("audit.verify", {});
      assert.equal(r.ok, true); assert.equal(r.lines, 0); assert.equal(r.lastHash, null);
      assert.equal(existsSync(`${layout(home).logs}/audit.chain.jsonl`), false);
    } finally { await cl.close(); await k.stop({ budgetMs: 5000 }); }
  });
});

describe("teeAudit", () => {
  const ev: AuditEvent = { at: 1, actor: { user: "u", host: "h" }, action: "a", target: "t", detail: {} };
  const boom = { append() { throw new Error("disk"); } };

  it("writes to both, primary first", () => {
    const a = memoryAuditSink(), b = memoryAuditSink();
    teeAudit(a, b).append(ev);
    assert.equal(a.events.length, 1); assert.equal(b.events.length, 1);
  });
  it("a failing copy still leaves the primary line, and the failure is thrown", () => {
    const a = memoryAuditSink();
    assert.throws(() => teeAudit(a, boom).append(ev), /disk/);
    assert.equal(a.events.length, 1);
  });
  it("a failing primary still writes the copy, and the failure is thrown", () => {
    const b = memoryAuditSink();
    assert.throws(() => teeAudit(boom, b).append(ev), /disk/);
    assert.equal(b.events.length, 1);
  });
});
