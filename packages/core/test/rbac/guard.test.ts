import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { RpcError } from "../../src/rpc/errors.ts";
import type { CallContext, Handler } from "../../src/rpc/server.ts";
import { LOCAL_OWNER, RPC_RULES, guardMethods, type PrincipalResolver } from "../../src/rbac/guard.ts";
import { memoryAuditSink } from "../../src/rbac/audit.ts";
import { POLICY } from "../../src/rbac/policy.ts";
import type { Principal, Role } from "../../src/rbac/types.ts";

const ctx: CallContext = { requestId: "r1", connectionId: "c1", signal: new AbortController().signal };
const caller = { channel: "cli", accountId: "a", userId: "u" };
const SCHEMA = JSON.parse(readFileSync(fileURLToPath(new URL("../../../rpc-schema/schema/rpc.schema.json", import.meta.url)), "utf8"));

const params: Record<string, unknown> = {
  "media.preferences.get": {}, "media.preferences.set": {},
  "media.generate": {},
  "media.edit": {},
  "media.job.get": {},
  "media.job.cancel": {},
  "media.job.list": {},
  "media.output.get": {},
  "media.output.list": {},
  "media.output.delete": {},
  "media.adapters.list": {},
  "project.create": {},
  "project.get": {},
  "project.list": {},
  "project.update": {},
  "project.archive": {},
  "project.member.add": {},
  "project.member.remove": {},
  "project.member.role": {},
  "project.agent.add": {},
  "project.agent.remove": {},
  "collab.trace.get": {},
  "collab.trace.list": {},
  "collab.chain.cancel": {},
  "identity.link.request": {},
  "identity.link.list": {},
  "identity.link.approve": {},
  "identity.link.decline": {},
  "identity.link.remove": {},
  "identity.principals": {},
  "memory.forget": { caller, agentId: "bernd", id: "m1" },
  "agent.status": { agentId: "bernd" },
  "jobs.run": { job: "light", agentId: "bernd" },
  "egress.status": {},
  "models.setOverride": { provider: "p", model: "m" },
  "models.removeManual": { provider: "p", model: "m" },
  "admin.migrate": {}, "admin.obsidian.detect": {}, "admin.obsidian.prepare": {}, "admin.obsidian.confirm": {},
  "admin.embedding.probe": {}, "admin.embedding.serve": {},
  "admin.reembed.plan": {}, "admin.reembed.run": {}, "admin.reembed.status": {}, "admin.reembed.abort": {}, "admin.backup.snapshot": {}, "audit.verify": {}, "logs.query": {}, "logs.tail": {}, "identity.list": {}, "identity.human.create": {}, "identity.link": {}, "identity.unlink": {}, "identity.pair.start": {}, "identity.pair.claim": {}, "identity.pair.confirm": {}, "dreams.run": {}, "dreams.schedule.set": {}, "dreams.enable": {}, "dreams.disable": {},
  "grant.list": {}, "grant.create": { capability: "fs.write", agent: "bernd", scope: "always" }, "grant.revoke": { id: "grt_1" },
  "approval.list": {}, "approval.get": { id: "apr_1" }, "approval.decide": { id: "apr_1", decision: "approve" }, "approval.cancel": { id: "apr_1" }, "approval.verify": {},
};

/** Stub handlers for every guarded method; they record that they ran. */
function stubs(): { handlers: Record<string, Handler>; ran: string[] } {
  const ran: string[] = [];
  const handlers: Record<string, Handler> = {};
  for (const m of [...Object.keys(RPC_RULES), "memory.recall", "core.status"]) handlers[m] = async () => { ran.push(m); return { ok: m }; };
  return { handlers, ran };
}

const asRole = (role: Role, extra: Partial<Principal> = {}): PrincipalResolver => () => ({ userId: "u-1", role, kind: "person", ...extra });
// `...p`: an explicit `undefined` argument must reach the handler as undefined, not become the default params.
async function call(h: Record<string, Handler>, m: string, ...p: unknown[]): Promise<unknown> { return await h[m]!(p.length ? p[0] : params[m], ctx); }
async function code(h: Record<string, Handler>, m: string, ...p: unknown[]): Promise<{ error?: string; reason?: string }> {
  try { await call(h, m, ...p); return {}; } catch (e) { return e instanceof RpcError ? { error: e.error, ...(e.reason ? { reason: e.reason } : {}) } : { error: `other:${String(e)}` }; }
}
const wrap = (resolve: PrincipalResolver, audit = memoryAuditSink()) => {
  const s = stubs();
  return { ...s, audit, guarded: guardMethods(s.handlers, { resolve, audit, now: () => 1234 }) };
};

describe("rpc guard: rules", () => {
  it("every rule names a real core method and a real policy action", () => {
    const coreMethods = new Set(Object.entries<any>(findMethods(SCHEMA)).filter(([, v]) => v["x-server"] === "core").map(([k]) => k));
    const actions = new Set(POLICY.map((p) => p.action));
    for (const [method, rule] of Object.entries(RPC_RULES)) {
      assert.ok(coreMethods.has(method), `${method} is not a core RPC method`);
      assert.ok(actions.has(rule.action), `${method} -> unknown action ${rule.action}`);
    }
  });
  it("every surface method is secured", () => {
    for (const name of Object.keys(findMethods(SCHEMA)).filter(n => /^(media|project|collab|identity)\./.test(n))) assert.ok(RPC_RULES[name], name);
  });
  it("every admin.* method in the schema is guarded (an `admin.*` is never left open)", () => {
    const admin = Object.keys(findMethods(SCHEMA)).filter((m) => m.startsWith("admin."));
    assert.ok(admin.length >= 6);
    for (const m of admin) assert.ok(RPC_RULES[m], `${m} has no RBAC rule`);
  });
});

describe("rpc guard: decisions", () => {
  it("passes a Owner/Admin through to the handler and returns its result untouched", async () => {
    for (const role of ["owner", "admin"] as const) {
      const { guarded, ran } = wrap(asRole(role));
      for (const m of ["jobs.run", "models.setOverride", "admin.migrate", "memory.forget", "agent.status"]) assert.deepEqual(await call(guarded, m), { ok: m }, `${role} ${m}`);
      assert.equal(ran.length, 5);
    }
  });

  it("admin.* is refused to Operator, Member and Viewer, and the handler never runs", async () => {
    for (const role of ["operator", "member", "viewer"] as const) {
      const { guarded, ran } = wrap(asRole(role));
      for (const m of Object.keys(RPC_RULES).filter((x) => x.startsWith("admin."))) {
        assert.deepEqual(await code(guarded, m), { error: "E_DENIED", reason: "role-denied" }, `${role} ${m}`);
      }
      assert.deepEqual(ran, []);
    }
  });

  it("memory.forget: Viewer denied; Member needs `use` on that agent; Operator likewise", async () => {
    assert.deepEqual(await code(wrap(asRole("viewer")).guarded, "memory.forget"), { error: "E_DENIED", reason: "role-denied" });
    assert.deepEqual(await code(wrap(asRole("member")).guarded, "memory.forget"), { error: "E_DENIED", reason: "object-right-required" });
    assert.deepEqual(await code(wrap(asRole("member", { agentRights: { other: "use" } })).guarded, "memory.forget"), { error: "E_DENIED", reason: "object-right-required" });
    assert.deepEqual(await code(wrap(asRole("member", { agentRights: { bernd: "use" } })).guarded, "memory.forget"), {});
    assert.deepEqual(await code(wrap(asRole("operator", { agentRights: { bernd: "use" } })).guarded, "memory.forget"), {});
  });

  it("agent.status: Viewer and Member see only agents shared with them; Operator and Admin see all", async () => {
    for (const role of ["viewer", "member"] as const) {
      assert.deepEqual(await code(wrap(asRole(role)).guarded, "agent.status"), { error: "E_DENIED", reason: "object-right-required" }, role);
      assert.deepEqual(await code(wrap(asRole(role, { agentRights: { bernd: "use" } })).guarded, "agent.status"), {}, role);
    }
    for (const role of ["operator", "admin"] as const) assert.deepEqual(await code(wrap(asRole(role)).guarded, "agent.status"), {}, role);
  });

  it("egress.status: Owner and Admin may read, Operator, Member and Viewer may not", async () => {
    for (const role of ["owner", "admin"] as const) assert.deepEqual(await code(wrap(asRole(role)).guarded, "egress.status"), {}, role);
    for (const role of ["operator", "member", "viewer"] as const) assert.equal((await code(wrap(asRole(role)).guarded, "egress.status")).error, "E_DENIED", role);
  });
  it("jobs.run: Operator may, Member and Viewer may not; models writes: Operator may not", async () => {
    assert.deepEqual(await code(wrap(asRole("operator")).guarded, "jobs.run"), {});
    for (const role of ["member", "viewer"] as const) assert.equal((await code(wrap(asRole(role)).guarded, "jobs.run")).error, "E_DENIED", role);
    assert.equal((await code(wrap(asRole("operator")).guarded, "models.setOverride")).error, "E_DENIED");
    assert.equal((await code(wrap(asRole("operator")).guarded, "models.removeManual")).error, "E_DENIED");
  });

  it("an API token's scopes narrow the role", async () => {
    const { guarded } = wrap(asRole("admin", { tokenScopes: ["jobs.run"] }));
    assert.deepEqual(await code(guarded, "jobs.run"), {});
    assert.deepEqual(await code(guarded, "admin.migrate"), { error: "E_DENIED", reason: "token-scope" });
  });

  it("no principal, a throwing resolver and a malformed principal all fail closed", async () => {
    assert.deepEqual(await code(wrap(() => null).guarded, "admin.migrate"), { error: "E_UNAUTHORIZED", reason: "no-principal" });
    assert.deepEqual(await code(wrap(() => undefined).guarded, "jobs.run"), { error: "E_UNAUTHORIZED", reason: "no-principal" });
    assert.deepEqual(await code(wrap(() => { throw new Error("boom"); }).guarded, "jobs.run"), { error: "E_UNAUTHORIZED", reason: "resolver-failed" });
    assert.deepEqual(await code(wrap(async () => { throw new Error("boom"); }).guarded, "jobs.run"), { error: "E_UNAUTHORIZED", reason: "resolver-failed" });
    assert.deepEqual(await code(wrap(() => ({ userId: "u", role: "root" }) as never).guarded, "jobs.run"), { error: "E_DENIED", reason: "invalid-principal" });
  });

  it("garbage params never reach the handler as a permitted resource", async () => {
    const { guarded, ran } = wrap(asRole("member", { agentRights: { bernd: "use" } }));
    for (const p of [undefined, null, 5, "bernd", {}, { agentId: 5 }, { agentId: "" }, { agentId: "__proto__" }]) {
      assert.equal((await code(guarded, "memory.forget", p)).error, "E_DENIED", JSON.stringify(p));
    }
    assert.deepEqual(ran, []);
  });

  it("methods without a rule are passed through untouched", async () => {
    const { guarded, handlers } = wrap(() => null);
    assert.equal(guarded["memory.recall"], handlers["memory.recall"]);
    assert.equal(guarded["core.status"], handlers["core.status"]);
  });

  it("a rule whose handler is absent adds nothing", () => {
    const g = guardMethods({ "core.status": async () => ({}) }, { resolve: () => LOCAL_OWNER, now: () => 0 });
    assert.deepEqual(Object.keys(g), ["core.status"]);
  });
});

describe("rpc guard: audit and default resolver", () => {
  it("audits a denial with who, what and why (no params, no secrets)", async () => {
    const { guarded, audit } = wrap(asRole("viewer"));
    await code(guarded, "memory.forget");
    assert.deepEqual(audit.events, [{
      at: 1234, actor: { user: "u-1", host: "local" }, action: "rbac.denied", target: "memory.forget", detail: { action: "memory.forget", reason: "role-denied", role: "viewer" },
    }]);
  });
  it("audits an unauthenticated call, and an audit failure does not turn a denial into an allow", async () => {
    const { guarded, audit } = wrap(() => null);
    await code(guarded, "admin.migrate");
    assert.equal(audit.events[0]?.action, "rbac.unauthenticated");
    const s = stubs();
    const g = guardMethods(s.handlers, { resolve: asRole("viewer"), audit: { append() { throw new Error("disk full"); } }, now: () => 0 });
    assert.equal((await code(g, "admin.migrate")).error, "E_DENIED");
    assert.deepEqual(s.ran, []);
  });
  it("does not audit allowed calls (the log would drown)", async () => {
    const { guarded, audit } = wrap(asRole("owner"));
    await call(guarded, "jobs.run");
    assert.equal(audit.events.length, 0);
  });
  it("the local-owner default lets every guarded method through, as before RBAC", async () => {
    const { guarded, ran } = wrap(() => LOCAL_OWNER);
    for (const m of Object.keys(RPC_RULES)) await call(guarded, m);
    assert.equal(ran.length, Object.keys(RPC_RULES).length);
  });
});

function findMethods(schema: any): Record<string, any> {
  // rpc.schema.json keeps methods under a $defs entry whose keys are method names; locate it by a known one.
  for (const v of Object.values<any>(schema.$defs)) if (v && typeof v === "object" && v["core.status"]) return v;
  throw new Error("methods table not found");
}
