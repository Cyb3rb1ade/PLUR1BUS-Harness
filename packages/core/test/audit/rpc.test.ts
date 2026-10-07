// audit.verify inside a real core: RBAC (Owner/Admin only), the default sink teeing into the chain, tamper findings.
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { CoreClient } from "@plur1bus/module-api";
import { defaults } from "@plur1bus/config-schema";
import { validateResult } from "@plur1bus/rpc-schema";
import { createCore, type Core } from "../../src/core.ts";
import { layout } from "../../src/paths.ts";
import { ACTIVE_NAME } from "../../src/audit/chain.ts";
import type { Principal } from "../../src/rbac/types.ts";
import { connect } from "../helpers/connect.ts";
import { flatTestInternals } from "../helpers/flat-embedder.ts";
import { tempDir } from "../helpers/temp-dir.ts";

describe("audit.verify in a running core", () => {
  const home = tempDir("p1b-audit-");
  const cfg = defaults(); cfg.agents.bernd = {};
  cfg.engine = { neo: { enabled: false }, gc: { enabled: false }, obsidianBridge: { enabled: false }, merging: { enabled: false }, dreaming: { enabled: false }, skillMiner: { enabled: false }, temporalContext: { enabled: false }, conversationReactivationRecall: { enabled: false }, reranker: { enabled: false } };
  writeFileSync(layout(home).configPath, JSON.stringify(cfg));
  const logs = layout(home).logs;
  let who: Principal = { userId: "u-viewer", role: "viewer" };
  let core: Core; let c: CoreClient;
  before(async () => {
    core = createCore({ home, testInternals: flatTestInternals(), rbac: { resolve: () => who } }); // default audit sink: audit.log + the chain
    await core.start();
    c = await connect({ address: core.address, token: core.token });
  });
  after(async () => { await c?.close(); await core?.stop({ budgetMs: 5000 }); });

  it("Viewer and Operator are refused (E_DENIED), Owner and Admin reach the verifier", async () => {
    for (const role of ["viewer", "operator", "member"] as const) {
      who = { userId: `u-${role}`, role };
      await assert.rejects(c.call("audit.verify", {}), (e: any) => { assert.deepEqual([e.error, e.reason], ["E_DENIED", "role-denied"], role); return true; });
    }
    for (const role of ["owner", "admin"] as const) {
      who = { userId: `u-${role}`, role };
      const r = await c.call<any>("audit.verify", {});
      assert.equal(validateResult("audit.verify", r).ok, true, JSON.stringify(validateResult("audit.verify", r)));
    }
  });

  it("the three refusals above are in the chain; verify is ok; tampering shows as findings without record content", async () => {
    who = { userId: "u-admin", role: "admin" };
    const ok = await c.call<any>("audit.verify", {});
    assert.deepEqual([ok.ok, ok.records, ok.anchor.status], [true, 3, "match"]);

    const file = path.join(logs, ACTIVE_NAME);
    const lines = readFileSync(file, "utf8").split("\n").filter(Boolean);
    assert.equal(JSON.parse(lines[0] as string).rec.action, "rbac.denied");
    writeFileSync(file, [lines[0], (lines[1] as string).replace("u-operator", "u-nobody"), lines[2]].join("\n") + "\n");
    const bad = await c.call<any>("audit.verify", {});
    assert.equal(bad.ok, false);
    assert.deepEqual(bad.findings.map((f: any) => [f.code, f.line]), [["hash-mismatch", 3]]);
    assert.ok(!JSON.stringify(bad).includes("u-nobody"));

    writeFileSync(file, lines.slice(0, 2).join("\n") + "\n");
    assert.deepEqual((await c.call<any>("audit.verify", {})).findings.map((f: any) => f.code), ["truncated"]);
    rmSync(file);
    assert.deepEqual((await c.call<any>("audit.verify", {})).findings.map((f: any) => f.code), ["truncated"]);
  });

  it("audit.verify rejects params (closed schema)", async () => {
    who = { userId: "u-owner", role: "owner" };
    await assert.rejects(c.call("audit.verify", { full: true }), (e: any) => e.error === "E_INVALID_PARAMS");
  });
});
