// Admin backends, who may do what (#337): break-glass grants are visible and revocable only to their holder and an
// Owner, the agent operate/manage split between Operator, Admin and Member, session.list's owner scoping and filters,
// and the audit lines an export or a role change leaves. Time is an injected clock; nothing sleeps.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AdminStore } from "../../src/identity/admin-store.ts";
import { AgentLifecycle } from "../../src/agents/lifecycle.ts";
import { buildAdminSurface } from "../../src/rpc/admin-surface.ts";
import { guardMethods } from "../../src/rbac/guard.ts";
import { RpcError } from "../../src/rpc/errors.ts";
import { createIdentityService } from "../../src/identity/service.ts";
import { createBreakGlass } from "../../src/rbac/break-glass.ts";
import { SessionStore } from "../../src/session/store.ts";
import type { Principal } from "../../src/rbac/types.ts";
import type { CallContext } from "../../src/rpc/server.ts";

const owner: Principal = { userId: "local-owner", role: "owner", kind: "person" };
const admin1: Principal = { userId: "admin-1", role: "admin", kind: "person" };
const admin2: Principal = { userId: "admin-2", role: "admin", kind: "person" };
const operator: Principal = { userId: "ops", role: "operator", kind: "person" };
const member: Principal = { userId: "member-1", role: "member", kind: "person" };
const agentPrincipal: Principal = { userId: "local-owner", role: "owner", kind: "agent" };
const actor = { user: owner.userId, host: "offline", kind: "person", role: "owner" } as const;
const ctx = (): CallContext => ({ requestId: "test", connectionId: "offline", signal: new AbortController().signal });
const reject = (error: string, reason?: string) => (e: unknown) => e instanceof RpcError && e.error === error && (!reason || e.reason === reason);

function harness(t: { after(fn: () => void): void }) {
  const root = mkdtempSync(join(tmpdir(), "admin-scope-"));
  let now = 1_000_000;
  const audit: { action: string; target: string; actor: { user: string } }[] = [];
  const sink = { append: (v: { action: string; target: string; actor: { user: string } }) => { audit.push(v); } };
  const identity = createIdentityService({ dbPath: join(root, "identity.sqlite"), clock: () => now, audit: () => {} });
  const people = new AdminStore({ path: join(root, "admin.sqlite"), ownerId: owner.userId });
  const lifecycle = new AgentLifecycle({ path: join(root, "lifecycle.sqlite") });
  const sessions = new SessionStore({ path: ":memory:", clock: () => now });
  const breakglass = createBreakGlass({ audit: sink, notify: () => {}, clock: () => now });
  const raw = buildAdminSurface({
    people, lifecycle, identity, sessions: () => sessions, breakglass, clock: () => now, audit: sink,
    agents: () => ({ alpha: { displayName: "Alpha" }, beta: { displayName: "Beta" } }),
    export: async (id) => ({ agentId: id, format: "offline-fixture" }),
    erase: async () => {},
    ownership: (p) => [p.userId],
  });
  const as = (p: Principal) => guardMethods(raw, { resolve: () => p, audit: sink, now: () => now });
  t.after(() => { sessions.close(); identity.close(); people.close(); lifecycle.close(); rmSync(root, { recursive: true, force: true }); });
  return { as, people, identity, lifecycle, sessions, audit, clock: () => now };
}

test("a break-glass grant is listed only to its holder and revocable only by its holder or an Owner", async t => {
  const s = harness(t);
  const target = s.identity.createHuman({ displayName: "Target" }, actor);
  const grant = await s.as(admin1)["breakglass.request"]!({ targetUserId: target.id, reason: "Investigate an incident", windowMinutes: 5 }, ctx()) as any;

  assert.deepEqual(((await s.as(admin1)["breakglass.list"]!({}, ctx())) as any).grants.map((g: any) => g.id), [grant.id]);
  assert.deepEqual((await s.as(admin2)["breakglass.list"]!({}, ctx()) as any).grants, []);
  assert.deepEqual((await s.as(owner)["breakglass.list"]!({}, ctx()) as any).grants, []);

  await assert.rejects(s.as(admin2)["breakglass.revoke"]!({ grantId: grant.id }, ctx()), reject("E_DENIED"));
  assert.equal((await s.as(admin1)["breakglass.list"]!({}, ctx()) as any).grants.length, 1);

  assert.deepEqual(await s.as(owner)["breakglass.revoke"]!({ grantId: grant.id }, ctx()), { id: grant.id, revoked: true });
  await assert.rejects(s.as(owner)["breakglass.revoke"]!({ grantId: grant.id }, ctx()), reject("E_NOT_FOUND"));
});

test("break-glass refuses a request on one's own cards", async t => {
  const s = harness(t);
  await assert.rejects(s.as(owner)["breakglass.request"]!({ targetUserId: owner.userId, reason: "Investigate an incident" }, ctx()), reject("E_INVALID_PARAMS"));
});

test("Operator may pause and resume any agent; Admin and Owner may also archive, and Member may do neither", async t => {
  const s = harness(t);
  await assert.rejects(s.as(member)["agent.pause"]!({ agentId: "alpha" }, ctx()), reject("E_DENIED"));
  assert.equal((await s.as(operator)["agent.pause"]!({ agentId: "alpha" }, ctx()) as any).paused, true);
  assert.equal((await s.as(operator)["agent.resume"]!({ agentId: "alpha" }, ctx()) as any).paused, false);
  await assert.rejects(s.as(operator)["agent.archive"]!({ agentId: "alpha" }, ctx()), reject("E_DENIED"));
  assert.equal(s.lifecycle.state("alpha").archived, false);
  assert.equal((await s.as(admin1)["agent.archive"]!({ agentId: "alpha" }, ctx()) as any).archived, true);
  await assert.rejects(s.as(member)["agent.unarchive"]!({ agentId: "alpha" }, ctx()), reject("E_DENIED"));
});

test("an agent principal is refused every admin method, even as an Owner", async t => {
  const s = harness(t);
  const call = s.as(agentPrincipal);
  for (const m of ["agent.pause", "agent.archive", "agent.export", "user.role.set", "user.invite.create", "agent.rights.set", "breakglass.request", "session.list"]) {
    await assert.rejects(call[m]!({ agentId: "alpha", userId: "x", targetUserId: "x", reason: "Investigate an incident" }, ctx()), reject("E_DENIED"), m);
  }
  assert.equal(s.lifecycle.state("alpha").paused, false);
});

test("session.list: Members see only their own sessions, and all-owner listing is refused to them", async t => {
  const s = harness(t);
  s.sessions.createSession({ kind: "direct", agentId: "alpha", owner: member.userId });
  s.sessions.createSession({ kind: "direct", agentId: "alpha", owner: "someone-else" });
  const own = await s.as(member)["session.list"]!({}, ctx()) as any;
  assert.deepEqual(own.sessions.map((x: any) => x.owner), [member.userId]);
  assert.equal(((await s.as(member)["session.list"]!({ owner: member.userId }, ctx())) as any).sessions.length, 1);
  await assert.rejects(s.as(member)["session.list"]!({ allOwners: true }, ctx()), reject("E_DENIED"));
  await assert.rejects(s.as(member)["session.list"]!({ owner: "someone-else" }, ctx()), reject("E_DENIED"));
});

test("session.list filters by owner, agent, kind, archive state and limit", async t => {
  const s = harness(t);
  const a = s.sessions.createSession({ kind: "direct", agentId: "alpha", owner: "one" });
  const betaOne = s.sessions.createSession({ kind: "direct", agentId: "beta", owner: "one" });
  const twoAlpha = s.sessions.createSession({ kind: "direct", agentId: "alpha", owner: "two" });
  const channel = s.sessions.createSession({ kind: "channel", agentId: "alpha", owner: "one", chatKey: "chat-filter" });
  const archived = s.sessions.createSession({ kind: "direct", agentId: "beta", owner: "two" });
  s.sessions.archiveSession(archived.id);
  const ids = async (p: Record<string, unknown>) => ((await s.as(operator)["session.list"]!(p, ctx())) as any).sessions.map((x: any) => x.id);

  assert.equal((await ids({ allOwners: true })).length, 4);
  assert.deepEqual(await ids({ allOwners: true, owner: "one", agentId: "beta" }), [betaOne.id]);
  assert.deepEqual(await ids({ allOwners: true, kind: "channel" }), [channel.id]);
  assert.deepEqual(await ids({ allOwners: true, archived: "only" }), [archived.id]);
  assert.equal((await ids({ allOwners: true, archived: "any" })).length, 5);
  assert.deepEqual(await ids({ owner: "two" }), [twoAlpha.id]);
  assert.deepEqual(await ids({ owner: "one", agentId: "alpha", kind: "direct" }), [a.id]);
  const limited = await s.as(operator)["session.list"]!({ allOwners: true, limit: 2 }, ctx()) as any;
  assert.equal(limited.sessions.length, 2);
  assert.equal(limited.truncated, true);
});

test("an export is audited when offered and again when the bundle is produced; an offer-only call is audited once", async t => {
  const s = harness(t);
  await s.as(owner)["agent.archive"]!({ agentId: "alpha" }, ctx());
  const before = s.audit.length;
  await s.as(owner)["agent.export"]!({ agentId: "alpha", offerOnly: true }, ctx());
  assert.deepEqual(s.audit.slice(before).map(e => e.action), ["agent.export.offered"]);
  const mid = s.audit.length;
  await s.as(owner)["agent.export"]!({ agentId: "alpha" }, ctx());
  assert.deepEqual(s.audit.slice(mid).map(e => e.action), ["agent.export.offered", "agent.export"]);
  assert.ok(s.audit.slice(mid).every(e => e.actor.user === owner.userId && e.target === "alpha"));
});

test("role changes and rights changes are audited with the acting person", async t => {
  const s = harness(t);
  const human = s.identity.createHuman({ displayName: "Alex" }, actor);
  await s.as(admin1)["user.role.set"]!({ userId: human.id, role: "operator" }, ctx());
  await s.as(admin1)["agent.rights.set"]!({ agentId: "alpha", userId: human.id, right: "use" }, ctx());
  const roleEvent = s.audit.find(e => e.action === "user.role.set");
  assert.ok(roleEvent);
  assert.equal(roleEvent.actor.user, admin1.userId);
  assert.ok(s.audit.some(e => e.action === "agent.rights.set" && e.actor.user === admin1.userId));
});

test("a denied role change leaves the role and the audit trail untouched", async t => {
  const s = harness(t);
  const human = s.identity.createHuman({ displayName: "Alex" }, actor);
  const before = s.audit.length;
  await assert.rejects(s.as(member)["user.role.set"]!({ userId: human.id, role: "admin" }, ctx()), reject("E_DENIED"));
  assert.equal(s.people.role(human.id), "member");
  assert.ok(!s.audit.slice(before).some(e => e.action === "user.role.set"));
});
