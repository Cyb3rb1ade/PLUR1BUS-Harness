import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AdminStore } from "../../src/identity/admin-store.ts";
import { AgentLifecycle } from "../../src/agents/lifecycle.ts";
import { buildAdminSurface } from "../../src/rpc/admin-surface.ts";
import { guardMethods } from "../../src/rbac/guard.ts";
import { createIdentityService } from "../../src/identity/service.ts";
import { createBreakGlass } from "../../src/rbac/break-glass.ts";
import { SessionStore } from "../../src/session/store.ts";
import type { Principal } from "../../src/rbac/types.ts";
import type { CallContext } from "../../src/rpc/server.ts";

const owner: Principal = { userId: "local-owner", role: "owner", kind: "person" };
const actor = { user: owner.userId, host: "offline", kind: "person", role: "owner" } as const;
const MIN = 60_000;
const ctx = (): CallContext => ({ requestId: "test", connectionId: "offline", signal: new AbortController().signal });

function harness(t: { after(fn: () => void): void }) {
  const root = mkdtempSync(join(tmpdir(), "admin-bounds-"));
  let now = 1_000_000;
  const sink = { append: () => {} };
  const identity = createIdentityService({ dbPath: join(root, "identity.sqlite"), clock: () => now, audit: () => {} });
  const people = new AdminStore({ path: join(root, "admin.sqlite"), ownerId: owner.userId });
  const lifecycle = new AgentLifecycle({ path: join(root, "lifecycle.sqlite") });
  const sessions = new SessionStore({ path: ":memory:", clock: () => now });
  const breakglass = createBreakGlass({ audit: sink, notify: () => {}, clock: () => now });
  const raw = buildAdminSurface({
    people, lifecycle, identity, sessions: () => sessions, breakglass, clock: () => now, audit: sink,
    agents: () => ({ alpha: { displayName: "Alpha" } }),
    export: async (id) => ({ agentId: id, format: "offline-fixture" }),
    ownership: (p) => [p.userId],
  });
  const as = (p: Principal) => guardMethods(raw, { resolve: () => p, audit: sink, now: () => now });
  t.after(() => { sessions.close(); identity.close(); people.close(); lifecycle.close(); rmSync(root, { recursive: true, force: true }); });
  return { as, identity, tick: (ms: number) => { now += ms; } };
}

test("user.invite.list reports pending, claimed, confirmed, revoked and expired invitations, never codes", async t => {
  const s = harness(t);
  const invite = (displayName: string, expiresInMinutes = 60) => s.as(owner)["user.invite.create"]!({ displayName, role: "member", channel: "test", expiresInMinutes }, ctx()) as Promise<any>;
  const identity = (userId: string) => ({ channel: "test", accountId: "offline", userId });
  const pending = await invite("Pending");
  const claimed = await invite("Claimed");
  s.identity.claim({ code: claimed.code, identity: identity("claimed") });
  const confirmed = await invite("Confirmed");
  s.identity.confirm({ pairingId: s.identity.claim({ code: confirmed.code, identity: identity("confirmed") }).pairingId, approve: true }, actor);
  const declined = await invite("Declined");
  s.identity.confirm({ pairingId: s.identity.claim({ code: declined.code, identity: identity("declined") }).pairingId, approve: false }, actor);
  const revoked = await invite("Revoked");
  await s.as(owner)["user.invite.revoke"]!({ inviteId: revoked.id }, ctx());
  const expired = await invite("Expired", 1);
  s.tick(MIN);

  const listed = await s.as(owner)["user.invite.list"]!({}, ctx()) as any;
  const state = new Map(listed.invites.map((i: any) => [i.id, i.state]));
  assert.equal(state.get(pending.id), "pending");
  assert.equal(state.get(claimed.id), "claimed");
  assert.equal(state.get(confirmed.id), "confirmed");
  assert.equal(state.get(declined.id), "declined");
  assert.equal(state.get(revoked.id), "revoked");
  assert.equal(state.get(expired.id), "expired");
  const serialized = JSON.stringify(listed);
  for (const i of [pending, claimed, confirmed, declined, revoked, expired]) assert.ok(!serialized.includes(i.code), i.id);
  assert.deepEqual(s.identity.list({}).pairings.map(p => p.id).sort(), [pending.id, claimed.id].sort());

  s.tick(59 * MIN);
  const afterExpiry = await s.as(owner)["user.invite.list"]!({}, ctx()) as any;
  const finalState = new Map(afterExpiry.invites.map((i: any) => [i.id, i.state]));
  assert.equal(finalState.get(confirmed.id), "confirmed");
  assert.equal(finalState.get(declined.id), "declined");
  assert.equal(finalState.get(pending.id), "expired");
  assert.equal(finalState.get(claimed.id), "expired");
  assert.equal(finalState.get(revoked.id), "revoked");
  assert.equal(finalState.get(expired.id), "expired");
  assert.deepEqual(s.identity.list({}).pairings, []);
});
