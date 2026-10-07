// logs.query / logs.tail inside a real core: schema validation, RBAC (Owner/Admin only), the audited refusal, redaction.
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import path from "node:path";
import type { CoreClient } from "@plur1bus/module-api";
import { defaults } from "@plur1bus/config-schema";
import { buildCapabilities } from "@plur1bus/rpc-schema";
import { createCore, type Core } from "../../src/core.ts";
import { layout } from "../../src/paths.ts";
import { memoryAuditSink } from "../../src/rbac/audit.ts";
import type { Principal } from "../../src/rbac/types.ts";
import { connect } from "../helpers/connect.ts";
import { flatTestInternals } from "../helpers/flat-embedder.ts";
import { tempDir } from "../helpers/temp-dir.ts";
import { rec } from "./helpers.ts";

function newHome(): string {
  const home = tempDir("p1b-logsrpc-");
  const cfg = defaults();
  cfg.engine = { neo: { enabled: false }, gc: { enabled: false }, obsidianBridge: { enabled: false }, merging: { enabled: false }, dreaming: { enabled: false }, skillMiner: { enabled: false }, temporalContext: { enabled: false }, conversationReactivationRecall: { enabled: false }, reranker: { enabled: false } };
  writeFileSync(layout(home).configPath, JSON.stringify(cfg));
  return home;
}

describe("logs.* over RPC", () => {
  const home = newHome();
  const audit = memoryAuditSink();
  let who: Principal | null = { userId: "u1", role: "owner" };
  let core: Core; let c: CoreClient;
  const SECRET = "sk-" + "Q1w2E3r4T5y6U7i8O9p0A1s2";
  before(async () => {
    core = createCore({ home, testInternals: flatTestInternals(), rbac: { resolve: () => who, audit } });
    await core.start();
    c = await connect({ address: core.address, token: core.token });
    writeFileSync(path.join(layout(home).logs, "planted.log"), rec(0, "error", `failed with ${SECRET}`, { source: { kind: "harness", id: "planted", version: null }, attrs: { password: "hunter2" } }));
  });
  after(async () => { await c?.close(); await core?.stop({ budgetMs: 5000 }); });
  const err = (e: any) => ({ error: e.error, reason: e.reason });

  it("Owner and Admin read the core's own log; the record is the written line", async () => {
    for (const role of ["owner", "admin"] as const) {
      who = { userId: "u1", role };
      const r = await c.call<any>("logs.query", { component: "core", limit: 5 });
      assert.ok(r.records.length > 0, role);
      assert.equal(r.records[0].component, "core");
      assert.equal(r.corrupt, 0);
    }
  });
  it("Operator, Member and Viewer are refused logs.query and logs.tail with E_DENIED, and the refusal is audited", async () => {
    const before = audit.events.length;
    for (const role of ["operator", "member", "viewer"] as const) {
      who = { userId: "u2", role };
      for (const m of ["logs.query", "logs.tail"]) await assert.rejects(c.call(m, {}), (e: any) => { assert.deepEqual(err(e), { error: "E_DENIED", reason: "role-denied" }, `${role} ${m}`); return true; });
    }
    assert.equal(audit.events.length - before, 6);
    assert.ok(audit.events.slice(before).every((e) => e.action === "rbac.denied" && (e.target === "logs.query" || e.target === "logs.tail")));
  });
  it("no principal is E_UNAUTHORIZED", async () => {
    who = null;
    await assert.rejects(c.call("logs.query", {}), (e: any) => { assert.deepEqual(err(e), { error: "E_UNAUTHORIZED", reason: "no-principal" }); return true; });
    who = { userId: "u1", role: "owner" };
  });
  it("params are validated by the schema before the handler (closed object, bounds)", async () => {
    for (const p of [{ limit: 0 }, { limit: 1001 }, { stream: "payload" }, { minLevel: "loud" }, { nope: 1 }, { waitMs: 31_000 }]) {
      await assert.rejects(c.call("logs.query", p), (e: any) => e.error === "E_INVALID_PARAMS", JSON.stringify(p));
    }
    await assert.rejects(c.call("logs.tail", { order: "asc" }), (e: any) => e.error === "E_INVALID_PARAMS");
  });
  it("a planted secret never leaves the core, even for the Owner", async () => {
    const q = await c.call<any>("logs.query", { component: "planted" });
    assert.equal(q.records.length, 1);
    const text = JSON.stringify(q);
    assert.ok(!text.includes(SECRET) && !text.includes("hunter2"), text);
    assert.equal(q.records[0].record.attrs.password, "[REDACTED:key]");
    const t = await c.call<any>("logs.tail", { component: "planted" });
    assert.ok(!JSON.stringify(t).includes(SECRET));
    assert.deepEqual((await c.call<any>("logs.query", { text: SECRET })).records, []);
  });
  it("logs.tail follows the core's own log across calls", async () => {
    const first = await c.call<any>("logs.tail", { component: "core", limit: 1 });
    assert.equal(typeof first.nextCursor, "string");
    // an RPC call makes the core write (per-request debug/info lines); a plain cursor call must not error either way
    const next = await c.call<any>("logs.tail", { component: "core", cursor: first.nextCursor });
    assert.equal(typeof next.nextCursor, "string");
  });
  it("both methods are core methods in the schema, experimental", () => {
    const caps = buildCapabilities([], "core");
    for (const m of ["logs.query", "logs.tail"]) assert.equal((caps.methods as any)[m]?.stability, "experimental", m);
  });
});
