// ADR-007: exactly one Owner. user.role.set must not create another one; invitations already refuse it. There is no transfer operation yet.
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
const actor = { user: owner.userId, host: "offline", kind: "person", role: "owner" } as const;
const ctx = (): CallContext => ({ requestId: "test", connectionId: "offline", signal: new AbortController().signal });
const reject = (error: string, reason?: string) => (e: unknown) => e instanceof RpcError && e.error === error && (!reason || e.reason === reason);

function harness(t: { after(fn: () => void): void }) {
  const root = mkdtempSync(join(tmpdir(), "single-owner-"));
  const audit: { action: string; target: string }[] = [];
  const sink = { append: (v: { action: string; target: string }) => { audit.push(v); } };
  const identity = createIdentityService({ dbPath: join(root, "identity.sqlite"), clock: () => 1_000_000, audit: () => {} });
  const people = new AdminStore({ path: join(root, "admin.sqlite"), ownerId: owner.userId });
  const lifecycle = new AgentLifecycle({ path: join(root, "lifecycle.sqlite") });
  const sessions = new SessionStore({ path: ":memory:", clock: () => 1_000_000 });
  const breakglass = createBreakGlass({ audit: sink, notify: () => {}, clock: () => 1_000_000 });
  const raw = buildAdminSurface({ people, lifecycle, identity, sessions: () => sessions, breakglass, clock: () => 1_000_000, audit: sink,
    agents: () => ({ alpha: { displayName: "Alpha" } }), export: async (id) => ({ agentId: id }), ownership: (p) => [p.userId] });
  const as = (p: Principal) => guardMethods(raw, { resolve: () => people.resolve(p), audit: sink, now: () => 1_000_000 });
  t.after(() => { sessions.close(); identity.close(); people.close(); lifecycle.close(); rmSync(root, { recursive: true, force: true }); });
  return { as, people, identity, audit };
}

test("user.role.set refuses to create a second Owner, from every role the caller may hold, and changes nothing", async t => {
  const s = harness(t);
  const human = s.identity.createHuman({ displayName: "Alex" }, actor);
  const admin = s.identity.createHuman({ displayName: "Admin" }, actor);
  await s.as(owner)["user.role.set"]!({ userId: admin.id, role: "admin" }, ctx());
  for (const before of ["member", "viewer", "operator", "admin"] as const) {
    await s.as(owner)["user.role.set"]!({ userId: human.id, role: before }, ctx());
    const audited = s.audit.length;
    await assert.rejects(s.as(owner)["user.role.set"]!({ userId: human.id, role: "owner" }, ctx()), reject("E_DENIED", "single-owner"), before);
    assert.equal(s.people.role(human.id), before);
    assert.equal(s.audit.length, audited, "a refused change is not recorded as a role change");
  }
  // An Admin was already refused (only an Owner may change ownership); that answer does not change.
  await assert.rejects(s.as({ userId: admin.id, role: "admin", kind: "person" })["user.role.set"]!({ userId: human.id, role: "owner" }, ctx()), reject("E_DENIED", "owner-only"));
  assert.equal(s.people.users().filter(u => u.role === "owner").length, 1);
});

test("the sole Owner stays the sole Owner: no demotion of the last Owner, other role changes keep working", async t => {
  const s = harness(t);
  const human = s.identity.createHuman({ displayName: "Alex" }, actor);
  assert.deepEqual(await s.as(owner)["user.role.set"]!({ userId: human.id, role: "admin" }, ctx()), { userId: human.id, role: "admin" });
  await assert.rejects(s.as(owner)["user.role.set"]!({ userId: owner.userId, role: "admin" }, ctx()), reject("E_CONFLICT", "last-owner"));
  assert.equal(s.people.role(owner.userId), "owner");
});
