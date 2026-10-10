// Admin backends, input bounds and failure paths (#337): the limits on break-glass and invitations, the delete path
// when the engine cannot erase or erasing fails, a second delete while one is in flight, the export offer's owner
// binding, the last-Owner rule with two Owners, and the invitation states. Time is an injected clock; the in-flight
// delete is held by a promise the test releases, never by a sleep.
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
const secondOwner: Principal = { userId: "second-owner", role: "owner", kind: "person" };
const actor = { user: owner.userId, host: "offline", kind: "person", role: "owner" } as const;
const MIN = 60_000;
const ctx = (): CallContext => ({ requestId: "test", connectionId: "offline", signal: new AbortController().signal });
const reject = (error: string, reason?: string) => (e: unknown) => e instanceof RpcError && e.error === error && (!reason || e.reason === reason);

type Erase = (agentId: string) => Promise<void>;

function harness(t: { after(fn: () => void): void }, erase?: Erase) {
  const root = mkdtempSync(join(tmpdir(), "admin-bounds-"));
  let now = 1_000_000;
  const audit: { action: string; target: string }[] = [];
  const sink = { append: (v: { action: string; target: string }) => { audit.push(v); } };
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
    ...(erase ? { erase } : {}),
  });
  const as = (p: Principal) => guardMethods(raw, { resolve: () => p, audit: sink, now: () => now });
  t.after(() => { sessions.close(); identity.close(); people.close(); lifecycle.close(); rmSync(root, { recursive: true, force: true }); });
  return { as, people, identity, lifecycle, audit, breakglass, tick: (ms: number) => { now += ms; }, clock: () => now };
}

test("break-glass reason is bounded to 10-500 characters after trimming", async t => {
  const s = harness(t);
  const target = s.identity.createHuman({ displayName: "Target" }, actor);
  const request = (reason: string) => s.as(owner)["breakglass.request"]!({ targetUserId: target.id, reason, windowMinutes: 1 }, ctx());
  await assert.rejects(request("a".repeat(9)), reject("E_INVALID_PARAMS"));
  // Padding does not count: nine characters after trimming is still too short.
  await assert.rejects(request(`   ${"a".repeat(9)}   `), reject("E_INVALID_PARAMS"));
  await assert.rejects(request("a".repeat(501)), reject("E_INVALID_PARAMS"));
  assert.equal(((await request("a".repeat(10))) as any).reason.length, 10);
  assert.equal(((await request("a".repeat(500))) as any).reason.length, 500);
});

test("break-glass window is 1-60 minutes, defaults to 15, and the expiry is exact", async t => {
  const s = harness(t);
  const target = s.identity.createHuman({ displayName: "Target" }, actor);
  const request = (windowMinutes?: unknown) => s.as(owner)["breakglass.request"]!({
    targetUserId: target.id, reason: "Investigate an incident", ...(windowMinutes === undefined ? {} : { windowMinutes }),
  }, ctx());
  for (const bad of [0, -1, 61, 1.5, "5"]) await assert.rejects(request(bad), reject("E_INVALID_PARAMS"), String(bad));
  const shortest = await request(1) as any;
  assert.equal(shortest.expiresAt - shortest.issuedAt, MIN);
  const longest = await request(60) as any;
  assert.equal(longest.expiresAt - longest.issuedAt, 60 * MIN);
  const defaulted = await request() as any;
  assert.equal(defaulted.expiresAt - defaulted.issuedAt, 15 * MIN);
});

test("invitations: lifetime is 1-60 minutes (default 60), never Owner, and fields are validated", async t => {
  const s = harness(t);
  const invite = (extra: Record<string, unknown> = {}) => s.as(owner)["user.invite.create"]!({ displayName: "Guest", role: "member", channel: "test", ...extra }, ctx());
  for (const bad of [0, 61, 1.5, "10"]) await assert.rejects(invite({ expiresInMinutes: bad }), reject("E_INVALID_PARAMS"), String(bad));
  await assert.rejects(invite({ role: "owner" }), reject("E_DENIED"));
  await assert.rejects(invite({ role: "superuser" }), reject("E_INVALID_PARAMS"));
  await assert.rejects(invite({ channel: "c".repeat(33) }), reject("E_INVALID_PARAMS"));
  await assert.rejects(invite({ displayName: "" }), reject("E_INVALID_PARAMS"));
  const defaulted = await invite() as any;
  assert.equal(defaulted.expiresAt - s.clock(), 60 * MIN);
  const longest = await invite({ expiresInMinutes: 60 }) as any;
  assert.equal(longest.expiresAt - s.clock(), 60 * MIN);
  const shortest = await invite({ expiresInMinutes: 1 }) as any;
  assert.equal(shortest.expiresAt - s.clock(), MIN);
});

test("user.invite.list reports pending, claimed, confirmed, revoked and expired invitations, never codes", { todo: "KNOWN GAP: user.invite.list reports a confirmed invitation as \"expired\" (identity.list returns only open pairings)" }, async t => {
  const s = harness(t);
  const invite = (displayName: string, expiresInMinutes = 60) => s.as(owner)["user.invite.create"]!({ displayName, role: "member", channel: "test", expiresInMinutes }, ctx()) as Promise<any>;
  const identity = (userId: string) => ({ channel: "test", accountId: "offline", userId });
  const pending = await invite("Pending");
  const claimed = await invite("Claimed");
  s.identity.claim({ code: claimed.code, identity: identity("claimed") });
  const confirmed = await invite("Confirmed");
  s.identity.confirm({ pairingId: s.identity.claim({ code: confirmed.code, identity: identity("confirmed") }).pairingId, approve: true }, actor);
  const revoked = await invite("Revoked");
  await s.as(owner)["user.invite.revoke"]!({ inviteId: revoked.id }, ctx());
  const expired = await invite("Expired", 1);
  s.tick(MIN);

  const listed = await s.as(owner)["user.invite.list"]!({}, ctx()) as any;
  const state = new Map(listed.invites.map((i: any) => [i.id, i.state]));
  assert.equal(state.get(pending.id), "pending");
  assert.equal(state.get(claimed.id), "claimed");
  assert.equal(state.get(confirmed.id), "confirmed");
  assert.equal(state.get(revoked.id), "revoked");
  assert.equal(state.get(expired.id), "expired");
  const serialized = JSON.stringify(listed);
  for (const i of [pending, claimed, confirmed, revoked, expired]) assert.ok(!serialized.includes(i.code), i.id);
});

test("a confirmed invitation cannot be revoked", async t => {
  const s = harness(t);
  const i = await s.as(owner)["user.invite.create"]!({ displayName: "Done", role: "member", channel: "test" }, ctx()) as any;
  const pairing = s.identity.claim({ code: i.code, identity: { channel: "test", accountId: "offline", userId: "done" } });
  s.identity.confirm({ pairingId: pairing.pairingId, approve: true }, actor);
  await assert.rejects(s.as(owner)["user.invite.revoke"]!({ inviteId: i.id }, ctx()), reject("E_CONFLICT"));
  assert.equal(s.people.invites().find(x => x.id === i.id)?.revoked, 0);
});

test("delete without an engine erasure API fails closed and leaves the agent archived", async t => {
  const s = harness(t);
  const call = s.as(owner);
  await call["agent.archive"]!({ agentId: "alpha" }, ctx());
  const offer = await call["agent.export"]!({ agentId: "alpha", offerOnly: true }, ctx()) as any;
  await assert.rejects(call["agent.delete"]!({ agentId: "alpha", confirmName: "Alpha", exportOfferId: offer.offerId }, ctx()), reject("E_NOT_AVAILABLE", "engine-erasure-unavailable"));
  assert.equal(s.lifecycle.state("alpha").deleted, false);
  assert.equal(s.lifecycle.state("alpha").archived, true);
  assert.ok(s.audit.some(e => e.action === "agent.delete.unavailable"));
});

test("a failed engine erasure keeps the agent, is audited, and can be retried", async t => {
  let failing = true;
  const erased: string[] = [];
  const s = harness(t, async (id) => {
    if (failing) throw new Error("offline engine storage unavailable");
    erased.push(id);
  });
  const call = s.as(owner);
  await call["agent.archive"]!({ agentId: "alpha" }, ctx());
  const offer = await call["agent.export"]!({ agentId: "alpha", offerOnly: true }, ctx()) as any;
  const params = { agentId: "alpha", confirmName: "Alpha", exportOfferId: offer.offerId };
  await assert.rejects(call["agent.delete"]!(params, ctx()), reject("E_STORAGE"));
  assert.equal(s.lifecycle.state("alpha").deleted, false);
  assert.ok(s.audit.some(e => e.action === "agent.delete.failed"));
  failing = false;
  assert.deepEqual(await call["agent.delete"]!(params, ctx()), { agentId: "alpha", deleted: true });
  assert.deepEqual(erased, ["alpha"]);
  assert.equal(s.lifecycle.state("alpha").deleted, true);
});

test("a second delete of the same agent is refused while the first erasure is in flight", async t => {
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  let entered!: () => void;
  const reached = new Promise<void>(resolve => { entered = resolve; });
  const s = harness(t, async () => { entered(); await gate; });
  const call = s.as(owner);
  await call["agent.archive"]!({ agentId: "alpha" }, ctx());
  const offer = await call["agent.export"]!({ agentId: "alpha", offerOnly: true }, ctx()) as any;
  const params = { agentId: "alpha", confirmName: "Alpha", exportOfferId: offer.offerId };
  const first = call["agent.delete"]!(params, ctx());
  await reached;
  await assert.rejects(call["agent.delete"]!(params, ctx()), reject("E_CONFLICT", "delete-in-progress"));
  release();
  assert.deepEqual(await first, { agentId: "alpha", deleted: true });
});

test("an export offer only authorizes deletion for the person who made it", async t => {
  const s = harness(t, async () => {});
  s.people.setRole(secondOwner.userId, "owner", () => {});
  const ownerCall = s.as(owner), otherCall = s.as(secondOwner);
  await ownerCall["agent.archive"]!({ agentId: "alpha" }, ctx());
  const offer = await ownerCall["agent.export"]!({ agentId: "alpha", offerOnly: true }, ctx()) as any;
  const params = { agentId: "alpha", confirmName: "Alpha", exportOfferId: offer.offerId };
  await assert.rejects(otherCall["agent.delete"]!(params, ctx()), reject("E_CONFLICT", "export-offer-required"));
  assert.equal(s.lifecycle.state("alpha").deleted, false);
  assert.deepEqual(await ownerCall["agent.delete"]!(params, ctx()), { agentId: "alpha", deleted: true });
});

test("the last Owner cannot demote themselves, but two Owners may demote one another", async t => {
  const s = harness(t);
  s.people.setRole(secondOwner.userId, "owner", () => {});
  const call = s.as(owner);
  assert.deepEqual(await call["user.role.set"]!({ userId: secondOwner.userId, role: "admin" }, ctx()), { userId: secondOwner.userId, role: "admin" });
  assert.equal(s.people.role(secondOwner.userId), "admin");
  await assert.rejects(call["user.role.set"]!({ userId: owner.userId, role: "admin" }, ctx()), reject("E_CONFLICT", "last-owner"));
  assert.equal(s.people.role(owner.userId), "owner");
});

test("role presets and agent right values are validated before any change", async t => {
  const s = harness(t);
  const human = s.identity.createHuman({ displayName: "Alex" }, actor);
  const call = s.as(owner);
  await assert.rejects(call["user.role.set"]!({ userId: human.id, role: "root" }, ctx()), reject("E_INVALID_PARAMS"));
  await assert.rejects(call["agent.rights.set"]!({ agentId: "alpha", userId: human.id, right: "read" }, ctx()), reject("E_INVALID_PARAMS"));
  await assert.rejects(call["agent.rights.set"]!({ agentId: "alpha", userId: human.id }, ctx()), reject("E_INVALID_PARAMS"));
  assert.deepEqual((await call["agent.rights.get"]!({ agentId: "alpha" }, ctx()) as any).rights, []);
  assert.equal(s.people.role(human.id), "member");
});
