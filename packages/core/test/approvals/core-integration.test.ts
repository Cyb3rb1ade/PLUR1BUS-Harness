// The eight grant.* / approval.* methods in a running core: the real RPC server, schema validators, RBAC guard, lazy stores and notifications.
import { fakeHelper } from "../attestation/fixtures/pinned-fake.ts";
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import type { CoreClient } from "@plur1bus/module-api";
import { defaults } from "@plur1bus/config-schema";
import { approvalsDbPath } from "../../src/approvals/db.ts";
import { createCore, type Core } from "../../src/core.ts";
import { layout } from "../../src/paths.ts";
import { memoryAuditSink } from "../../src/rbac/audit.ts";
import type { Principal } from "../../src/rbac/types.ts";
import { connect } from "../helpers/connect.ts";
import { flatTestInternals } from "../helpers/flat-embedder.ts";
import { tempDir } from "../helpers/temp-dir.ts";
import { askFor } from "./service-helpers.ts";

const T = { timeout: 60_000 };

function newHome(): string {
  const home = tempDir("p1b-appr-core-");
  const cfg = defaults(); cfg.agents.bernd = {};
  cfg.engine = { neo: { enabled: false }, gc: { enabled: false }, obsidianBridge: { enabled: false }, merging: { enabled: false }, dreaming: { enabled: false }, skillMiner: { enabled: false }, temporalContext: { enabled: false }, conversationReactivationRecall: { enabled: false }, reranker: { enabled: false } };
  writeFileSync(layout(home).configPath, JSON.stringify(cfg));
  return home;
}

/** The test keyring seam: an in-process keychain, so no run touches a real one. */
function withMemoryKeyring(): () => void {
  const saved = [process.env.PLUR1BUS_ALLOW_TEST_INTERNALS, process.env.PLUR1BUS_SECRETS_KEYRING];
  process.env.PLUR1BUS_ALLOW_TEST_INTERNALS = "1"; process.env.PLUR1BUS_SECRETS_KEYRING = "memory";
  return () => {
    if (saved[0] === undefined) delete process.env.PLUR1BUS_ALLOW_TEST_INTERNALS; else process.env.PLUR1BUS_ALLOW_TEST_INTERNALS = saved[0];
    if (saved[1] === undefined) delete process.env.PLUR1BUS_SECRETS_KEYRING; else process.env.PLUR1BUS_SECRETS_KEYRING = saved[1];
  };
}

const err = (e: any) => ({ error: e.error, reason: e.reason });
const AGENT: Principal = { userId: "local-owner", kind: "agent", role: "owner" };
const PARAMS: Record<string, object> = {
  "grant.list": {}, "grant.create": { capability: "fs.write", agent: "bernd", scope: "always" }, "grant.revoke": { id: "grt_x" },
  "approval.list": {}, "approval.get": { id: "apr_x" }, "approval.verify": {}, "approval.decide": { id: "apr_x", decision: "approve" }, "approval.cancel": { id: "apr_x" },
};

describe("grant.* and approval.* in a running core: who may call them", () => {
  const restore = withMemoryKeyring();
  const home = newHome();
  const audit = memoryAuditSink();
  let who: Principal | null = AGENT;
  let core: Core; let c: CoreClient;
  before(async () => {
    core = createCore({ home, testInternals: flatTestInternals(), rbac: { resolve: () => who, audit } });
    await core.start();
    c = await connect({ address: core.address, token: core.token });
  });
  after(async () => { await c?.close(); await core?.stop({ budgetMs: 5000 }); restore(); });

  it("an agent principal is refused every one of the eight methods, audited, and the stores are never opened", T, async () => {
    who = AGENT;
    for (const [m, p] of Object.entries(PARAMS)) {
      await assert.rejects(c.call(m, p), (e: any) => { assert.deepEqual(err(e), { error: "E_DENIED", reason: "agent-principal" }, m); return true; });
    }
    assert.deepEqual(audit.events.filter((e) => e.action === "rbac.denied").map((e) => e.target).sort(), Object.keys(PARAMS).sort());
    assert.equal(existsSync(approvalsDbPath(home)), false, "an agent never makes the core open the approval store");
  });

  it("a principal without a kind (fail closed) and a missing principal", T, async () => {
    who = { userId: "local-owner", role: "owner" };
    for (const [m, p] of Object.entries(PARAMS)) {
      await assert.rejects(c.call(m, p), (e: any) => { assert.deepEqual(err(e), { error: "E_DENIED", reason: "agent-principal" }, m); return true; });
    }
    who = null;
    for (const [m, p] of Object.entries(PARAMS)) {
      await assert.rejects(c.call(m, p), (e: any) => { assert.deepEqual(err(e), { error: "E_UNAUTHORIZED", reason: "no-principal" }, m); return true; });
    }
    assert.equal(existsSync(approvalsDbPath(home)), false);
  });

  it("roles: a viewer reads nothing, an operator reads approvals but neither grants nor decides", T, async () => {
    who = { userId: "u-v", kind: "person", role: "viewer" };
    for (const [m, p] of Object.entries(PARAMS)) {
      await assert.rejects(c.call(m, p), (e: any) => { assert.deepEqual(err(e), { error: "E_DENIED", reason: "role-denied" }, m); return true; });
    }
    who = { userId: "u-op", kind: "person", role: "operator" };
    assert.deepEqual((await c.call<any>("approval.list", {})).approvals, []);
    assert.equal((await c.call<any>("approval.verify", {})).ok, true);
    for (const m of ["grant.list", "grant.create", "grant.revoke", "approval.decide", "approval.cancel"]) {
      await assert.rejects(c.call(m, PARAMS[m]!), (e: any) => { assert.deepEqual(err(e), { error: "E_DENIED", reason: "role-denied" }, m); return true; });
    }
  });
});

describe("grant.* and approval.* in a running core: the owner's path", () => {
  const restore = withMemoryKeyring();
  const home = newHome();
  const principals = new Map<string, Principal>();
  let core: Core; let c: CoreClient;
  const PERSON: Principal = { userId: "christian", kind: "person", role: "owner" };
  // The server-side attestation seam (CoreOptions.rbac.attest); a request cannot reach it. Off = a plain token connection.
  let attested = false;
  before(async () => {
    core = createCore({
      home, testInternals: flatTestInternals(),
      // A connection announces itself with its first call; the resolver is the core's own, so this is just a way to give two connections two principals.
      rbac: { resolve: (ctx, _m, params: any) => { if (params?.agent === "as-agent") principals.set(ctx.connectionId, AGENT); else if (!principals.has(ctx.connectionId)) principals.set(ctx.connectionId, PERSON); return principals.get(ctx.connectionId) ?? null; }, audit: memoryAuditSink(), attest: () => (attested ? { kind: "desktop-app" } : undefined) },
    });
    await core.start();
    c = await connect({ address: core.address, token: core.token });
  });
  after(async () => { await c?.close(); await core?.stop({ budgetMs: 5000 }); restore(); });

  it("the approval store is opened by the first use, not by the start", T, async () => {
    assert.equal(existsSync(approvalsDbPath(home)), false);
    assert.equal((await c.call<any>("core.status")).process.state, "ready");
    assert.deepEqual(await c.call("approval.verify", {}), { ok: true, entries: 0, head: null });
    assert.equal(existsSync(approvalsDbPath(home)), true);
  });

  it("a grant is created, listed and revoked; the chain verifies", T, async () => {
    const g = await c.call<any>("grant.create", { capability: "fs.write", agent: "bernd", scope: "session", sessionId: "s1" });
    assert.equal(g.person, "christian");
    assert.equal(g.surface, 1, "a token connection without attestation is T1 (#192)");
    assert.deepEqual((await c.call<any>("grant.list", {})).grants.map((x: any) => x.id), [g.id]);
    assert.equal((await c.call<any>("grant.revoke", { id: g.id })).state, "revoked");
    assert.equal((await c.call<any>("approval.verify", {})).ok, true);
    await assert.rejects(c.call("grant.create", { capability: "harness.admin", agent: "bernd", scope: "always" }), (e: any) => { assert.deepEqual(err(e), { error: "E_DENIED", reason: "policy-never" }); return true; });
    await assert.rejects(c.call("grant.create", { capability: "fs.write", agent: "nobody", scope: "always" }), (e: any) => e.error === "E_AGENT_UNKNOWN");
  });

  it("an unattested token connection cannot create a T2 grant (#192); with an attestation the same request succeeds", T, async () => {
    const t2 = { capability: "shell.exec", agent: "bernd", scope: "always" };
    await assert.rejects(c.call("grant.create", t2), (e: any) => { assert.deepEqual(err(e), { error: "E_DENIED", reason: "surface-untrusted" }); return true; });
    attested = true;
    try {
      const g = await c.call<any>("grant.create", t2);
      assert.ok(g.surface >= 2);
      assert.equal((await c.call<any>("grant.revoke", { id: g.id })).state, "revoked");
    } finally { attested = false; }
  });

  it("a parked request reaches a person's opted-in connection, is decided over RPC, and the call is released", T, async () => {
    const service = await core.approvalService();
    const person = await connect({ address: core.address, token: core.token });
    const got: [string, any][] = []; person.onNotification((m, p) => got.push([m, p]));
    try {
      await person.call("events.subscribe", { names: ["approval.requested", "approval.resolved", "grant.changed"] });
      const answer = service.request(askFor({ actionHash: "ab".padEnd(64, "0"), taskId: "t1" }));
      await new Promise((r) => setTimeout(r, 150));
      const req = got.find(([m]) => m === "approval.requested");
      assert.ok(req, JSON.stringify(got));
      const id = req[1].approval.id as string;
      assert.ok(!JSON.stringify(got).match(/"nonce"/), "no nonce on the wire");
      const pending = await c.call<any>("approval.list", { status: "pending" });
      assert.deepEqual(pending.approvals.map((a: any) => a.id), [id]);
      const out = await c.call<any>("approval.decide", { id, decision: "approve", scope: "task" });
      assert.equal(out.approval.status, "approved");
      assert.equal(out.grant.scope, "task");
      assert.equal((await answer).approved, true);
      await new Promise((r) => setTimeout(r, 150));
      assert.deepEqual(got.map(([m]) => m), ["approval.requested", "approval.resolved", "grant.changed"]);
      await assert.rejects(c.call("approval.decide", { id, decision: "approve" }), (e: any) => { assert.deepEqual(err(e), { error: "E_DENIED", reason: "approval-used" }); return true; });
    } finally { await person.close(); }
  });

  it("an agent connection that opts in silences the notification for everyone and cannot decide", T, async () => {
    const service = await core.approvalService();
    const person = await connect({ address: core.address, token: core.token });
    const agent = await connect({ address: core.address, token: core.token });
    const got: [string, any][] = []; person.onNotification((m, p) => got.push([m, p]));
    const spied: [string, any][] = []; agent.onNotification((m, p) => spied.push([m, p]));
    try {
      await assert.rejects(agent.call("grant.list", { agent: "as-agent" }), (e: any) => e.reason === "agent-principal");
      await person.call("events.subscribe", { names: ["approval.requested"] });
      await agent.call("events.subscribe", { names: ["approval.requested"] });
      const answer = service.request(askFor({ actionHash: "cd".padEnd(64, "0"), taskId: "t2" }));
      await new Promise((r) => setTimeout(r, 150));
      assert.deepEqual(got, []);
      assert.deepEqual(spied, []);
      const pending = (await c.call<any>("approval.list", { status: "pending" })).approvals;
      await assert.rejects(agent.call("approval.decide", { id: pending[0].id, decision: "approve" }), (e: any) => e.reason === "agent-principal");
      assert.equal((await c.call<any>("approval.get", { id: pending[0].id })).status, "pending");
      await c.call("approval.cancel", { id: pending[0].id });
      assert.equal((await answer).approved, false);
    } finally { await person.close(); await agent.close(); }
  });

  it("stop() ends a call that is still waiting as not approved", T, async () => {
    const home2 = newHome();
    const k = createCore({ home: home2, testInternals: flatTestInternals() });
    await k.start();
    const service = await k.approvalService();
    const answer = service.request(askFor({ actionHash: "ef".padEnd(64, "0"), taskId: "t3" }));
    await new Promise((r) => setTimeout(r, 50));
    await k.stop({ budgetMs: 5000 });
    assert.equal((await answer).approved, false);
    assert.ok(readFileSync(approvalsDbPath(home2)).length > 0);
    await assert.rejects(k.approvalService(), (e: any) => e.error === "E_NOT_AVAILABLE");
  });
});

describe("OS attestation in a running core (#192 option C)", () => {
  const restore = withMemoryKeyring();
  const SHELL = { capability: "shell.exec", tool: "shell.run", effect: "local-destructive" as const, targets: [], args: { cmd: "ls" } };
  const PERSON: Principal = { userId: "christian", kind: "person", role: "owner" };
  after(() => restore());

  async function run<T>(attestation: { helper: { path: string; args?: string[] } | null }, body: (c: CoreClient, core: Core) => Promise<T>): Promise<T> {
    const core = createCore({ home: newHome(), testInternals: flatTestInternals(), attestation, rbac: { resolve: () => PERSON, audit: memoryAuditSink() } });
    await core.start();
    const c = await connect({ address: core.address, token: core.token });
    try { return await body(c, core); } finally { await c.close(); await core.stop({ budgetMs: 5000 }); }
  }
  const park = async (core: Core) => {
    const service = await core.approvalService();
    const answer = service.request(askFor({ ...SHELL, actionHash: "ab".padEnd(64, "0"), taskId: "t1" }));
    await new Promise((r) => setTimeout(r, 100));
    const id = (await service.list({ status: "pending" }))[0]!.id;
    return { id, answer };
  };

  it("a token connection lifts one T2 approval with one confirmation; the grant says where it came from", T, async () => {
    await run({ helper: fakeHelper("ok") }, async (c, core) => {
      const { id, answer } = await park(core);
      await assert.rejects(c.call("approval.decide", { id, decision: "approve", scope: "session" }), (e: any) => { assert.deepEqual(err(e), { error: "E_APPROVAL_REQUIRED", reason: "attestation-required" }); return true; });
      const out = await c.call<any>("approval.decide", { id, decision: "approve", scope: "task", attest: true });
      assert.equal(out.approval.decisionSurface, 2);
      assert.equal(out.grant.attestedVia, "attested:fake-biometric");
      assert.equal((await answer).approved, true);
    });
  });

  it("a cancelled confirmation, and a core without a helper, leave the request pending at T1", T, async () => {
    await run({ helper: fakeHelper("cancel") }, async (c, core) => {
      const { id } = await park(core);
      await assert.rejects(c.call("approval.decide", { id, decision: "approve", attest: true }), (e: any) => { assert.deepEqual(err(e), { error: "E_DENIED", reason: "attestation-failed" }); return true; });
      assert.equal((await c.call<any>("approval.get", { id })).status, "pending");
    });
    await run({ helper: null }, async (c, core) => {
      const { id } = await park(core);
      for (const attest of [false, true]) await assert.rejects(c.call("approval.decide", { id, decision: "approve", attest }), (e: any) => { assert.deepEqual(err(e), { error: "E_NOT_AVAILABLE", reason: "attestation-unavailable" }); return true; });
    });
  });
});
