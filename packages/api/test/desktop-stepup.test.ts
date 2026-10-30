/** Native operation proofs reuse factor-stamped ordinary sessions and never confer missing grants. */
import test from "node:test";
import assert from "node:assert/strict";
import { FakeClock } from "../src/clock.ts";
import { SessionStore } from "../src/session.ts";
import { MemoryUserDirectory } from "../src/memory-stores.ts";
import type { CoreRpc } from "../src/core-rpc.ts";
import type { CorePerson } from "../src/account-store.ts";
import type { DesktopIdentity } from "../src/desktop-attach-routes.ts";

const TOKEN = "a".repeat(43), OTHER = "b".repeat(43);
async function rig() {
  const module = await import("../src/desktop-stepup.ts").catch(() => undefined);
  assert.equal(typeof module?.DesktopStepUp, "function", "native MFA needs a real bounded proof authority");
  const clock = new FakeClock(), sessions = new SessionStore(clock), users = new MemoryUserDirectory();
  users.add({ id: "alice", username: "alice", role: "owner" });
  users.add({ id: "bob", username: "bob", role: "owner" });
  let localVersion = 1, revoked = false;
  const person: CorePerson = { userId: "alice", kind: "person", role: "owner", disabled: false, version: 3 };
  const identity: DesktopIdentity = { deviceId: "desktop-fixture", userId: "alice", expiresAt: clock.now() + 86400_000,
    scopes: ["chat:read", "extensions.read", "extensions.manage", "imports.read", "imports.manage"] };
  const core = { serviceCall: async (method: string, body: Record<string, unknown>) => {
    if (revoked) throw { error: "E_DENIED", reason: "device-revoked" };
    if (method === "admin.api.person.resolve") return { person: structuredClone(person) };
    if (method === "admin.api.desktop.token" && body.token === TOKEN) return structuredClone(identity);
    if (method === "admin.api.desktop.resolve" && body.deviceId === identity.deviceId) return structuredClone(identity);
    throw { error: "E_DENIED", reason: "device-token" };
  } } as unknown as CoreRpc;
  const authority = new module!.DesktopStepUp({ core, clock, sessions, users, credentialVersion: () => localVersion });
  const login = (id = "alice", factor = true) => sessions.create({ kind: "user", id, role: "owner" },
    { authVersion: 1, ...(factor ? { stepUpAt: clock.now() } : {}) });
  const approved = async (purpose: "session" | "extensions" | "imports" = "extensions") => {
    const challenge = await authority.start(TOKEN, purpose), browser = login();
    await authority.decision(browser.session, challenge.userCode, "approve");
    const poll = await authority.poll(TOKEN, challenge.challengeId);
    assert.equal(poll.state, "approved");
    assert.ok("proofToken" in poll);
    return { challenge, browser, poll };
  };
  return { authority, clock, sessions, users, person, identity, login, approved,
    revoke: () => { revoked = true; }, changePassword: () => { localVersion++; users.change("alice", {}); } };
}
const refused = (reason?: string) => (error: unknown) => {
  const value = error as { status?: number; reason?: string };
  return [401, 403, 429].includes(value.status ?? 0) && (!reason || value.reason === reason);
};

test("only a same-person ordinary MFA session can approve an enrolled purpose", async () => {
  const r = await rig(), c = await r.authority.start(TOKEN, "extensions");
  assert.match(c.challengeId, /^[A-Za-z0-9_-]{43}$/); assert.match(c.userCode, /^[A-Z2-9]{4}-[A-Z2-9]{4}$/);
  assert.equal(c.expiresAt, r.clock.now() + 300_000);
  await assert.rejects(r.authority.decision(r.login("bob").session, c.userCode, "approve"), refused());
  await assert.rejects(r.authority.decision(r.login("alice", false).session, c.userCode, "approve"), refused("second-factor-required"));
  const native = r.sessions.create({ kind: "user", id: "alice", role: "owner" }, { device: r.identity, authVersion: 1, stepUpAt: r.clock.now() });
  await assert.rejects(r.authority.decision(native.session, c.userCode, "approve"), refused());
  const owner = r.sessions.create({ kind: "owner", id: "alice", role: "owner" }, { stepUpAt: r.clock.now() });
  await assert.rejects(r.authority.decision(owner.session, c.userCode, "approve"), refused());
  const browser = r.login();
  await assert.rejects(r.authority.decision({ ...browser.session }, c.userCode, "approve"), refused());
  const publicInfo = await r.authority.lookup(browser.session, c.userCode);
  assert.equal(publicInfo.deviceId, r.identity.deviceId);
  assert.equal(JSON.stringify(publicInfo).includes(c.challengeId), false);
  assert.equal(JSON.stringify(await r.authority.decision(browser.session, c.userCode, "approve")).includes("proofToken"), false);
  const result = await r.authority.poll(TOKEN, c.challengeId);
  assert.equal(result.state, "approved"); assert.ok("proofToken" in result);
  await assert.rejects(r.authority.poll(OTHER, c.challengeId), refused());
});

test("operation proofs are consumed once even when verification races", async () => {
  const r = await rig(), { poll } = await r.approved();
  if (!("proofToken" in poll)) throw new Error("missing native proof");
  const results = await Promise.allSettled([
    r.authority.verify(TOKEN, poll.proofToken, "extensions.manage"),
    r.authority.verify(TOKEN, poll.proofToken, "extensions.manage"),
  ]);
  assert.equal(results.filter(result => result.status === "fulfilled").length, 1);
  await assert.rejects(r.authority.verify(TOKEN, poll.proofToken, "extensions.manage"), refused());
});

test("a session purpose cannot inherit management scopes and purpose proofs cannot cross operations", async () => {
  const r = await rig(), { challenge, poll } = await r.approved("session");
  if (!("proofToken" in poll)) throw new Error("missing native proof");
  await assert.rejects(r.authority.verify(TOKEN, poll.proofToken, "extensions.manage"), refused());
  const fresh = await r.authority.poll(TOKEN, challenge.challengeId);
  if (!("proofToken" in fresh)) throw new Error("missing native proof");
  const proof = await r.authority.verify(TOKEN, fresh.proofToken, "session");
  assert.deepEqual(proof.grantedScopes, ["chat:read"]);
  r.identity.scopes = ["chat:read"];
  await assert.rejects(r.authority.start(TOKEN, "imports"), refused());
});

test("proof grants expire at the original factor deadline and replayed approval cannot extend them", async () => {
  const r = await rig(), browser = r.login();
  r.clock.advance(240_000);
  const c = await r.authority.start(TOKEN, "imports");
  const approved = await r.authority.decision(browser.session, c.userCode, "approve");
  assert.equal(approved.expiresAt, browser.session.stepUpAt! + 300_000);
  r.clock.advance(1000);
  assert.equal((await r.authority.decision(r.login().session, c.userCode, "approve")).expiresAt, approved.expiresAt);
  const proof = await r.authority.poll(TOKEN, c.challengeId);
  r.clock.advance(59_000);
  assert.equal((await r.authority.poll(TOKEN, c.challengeId)).state, "expired");
  if (!("proofToken" in proof)) throw new Error("missing native proof");
  await assert.rejects(r.authority.verify(TOKEN, proof.proofToken, "imports.manage"), refused());
});

test("decline and approving-browser logout revoke outstanding grants and tickets", async () => {
  const r = await rig(), c = await r.authority.start(TOKEN, "extensions"), browser = r.login();
  await r.authority.decision(browser.session, c.userCode, "decline");
  assert.equal((await r.authority.poll(TOKEN, c.challengeId)).state, "declined");
  await assert.rejects(r.authority.decision(browser.session, c.userCode, "approve"), refused());
  const second = await r.approved();
  if (!("proofToken" in second.poll)) throw new Error("missing native proof");
  const verified = await r.authority.verify(TOKEN, second.poll.proofToken, "session");
  r.sessions.destroy(second.browser.id);
  await assert.rejects(r.authority.revalidateTicket(verified, r.identity), refused());
});

test("device revocation, scope changes, Core role/version changes and local credential changes refuse proofs", async () => {
  for (const mutate of [
    (r: Awaited<ReturnType<typeof rig>>) => r.revoke(),
    (r: Awaited<ReturnType<typeof rig>>) => { r.identity.scopes = ["chat:read"]; },
    (r: Awaited<ReturnType<typeof rig>>) => { Object.assign(r.person, { role: "member" }); },
    (r: Awaited<ReturnType<typeof rig>>) => { r.person.version++; },
    (r: Awaited<ReturnType<typeof rig>>) => r.changePassword(),
  ]) {
    const r = await rig(), { poll } = await r.approved();
    if (!("proofToken" in poll)) throw new Error("missing native proof");
    mutate(r);
    await assert.rejects(r.authority.verify(TOKEN, poll.proofToken, "extensions.manage"), refused());
  }
});

test("only privately bound imports-purpose cookies expose stable run provenance for their normal session lifetime", async () => {
  const r = await rig(), { poll, browser } = await r.approved("imports");
  if (!("proofToken" in poll)) throw new Error("missing native proof");
  const verified = await r.authority.verify(TOKEN, poll.proofToken, "session");
  await r.authority.revalidateTicket(verified, r.identity);
  const native = r.sessions.create({ kind: "user", id: "alice", role: "owner" },
    { authVersion: r.person.version, device: { ...r.identity, scopes: verified.grantedScopes }, stepUpAt: verified.stepUpAt });
  r.authority.bindSession(native.session, verified);
  const principal = { ...r.person, kind: "person" as const, tokenScopes: verified.grantedScopes };
  const first = r.authority.importSessionProof(native.session, principal);
  assert.ok(first); assert.equal(Object.isFrozen(first), true);
  assert.equal(r.authority.importSessionProof(native.session, principal), first);
  const fake = r.sessions.create(native.session.principal, { device: native.session.device!, stepUpAt: verified.stepUpAt });
  assert.equal(r.authority.importSessionProof(fake.session, principal), undefined);
  r.sessions.destroy(browser.id); r.clock.advance(300_001);
  assert.equal(r.authority.importSessionProof(native.session, principal), first, "redeemed device cookie is independent of approving browser");
  r.changePassword();
  assert.equal(r.authority.importSessionProof(native.session, principal), undefined);
});

test("private session provenance refuses changed user, role, scope, device lifetime and copied cookie fields", async () => {
  for (const alter of [
    (s: import("../src/session.ts").Session) => { s.device!.scopes.push("extensions.manage"); },
    (s: import("../src/session.ts").Session) => { s.device!.expiresAt++; },
    (s: import("../src/session.ts").Session) => { s.device!.userId = "bob"; },
    (s: import("../src/session.ts").Session) => { s.authVersion++; },
  ]) {
    const r = await rig(), { poll } = await r.approved("imports");
    if (!("proofToken" in poll)) throw new Error("missing native proof");
    const verified = await r.authority.verify(TOKEN, poll.proofToken, "session");
    const session = r.sessions.create({ kind: "user", id: "alice", role: "owner" },
      { authVersion: r.person.version, device: { ...r.identity, scopes: [...verified.grantedScopes] }, stepUpAt: verified.stepUpAt });
    r.authority.bindSession(session.session, verified);
    const principal = { ...r.person, kind: "person" as const, tokenScopes: [...verified.grantedScopes] };
    assert.equal(r.authority.importSessionProof(session.session, { ...principal, role: "member" }), undefined);
    assert.equal(r.authority.importSessionProof(session.session, { ...principal, tokenScopes: ["imports.manage"] }), undefined);
    alter(session.session);
    assert.equal(r.authority.importSessionProof(session.session, principal), undefined);
  }
});

test("proof authority results cannot be mutated to widen a redeemed session", async () => {
  const r = await rig(), { poll } = await r.approved("session");
  if (!("proofToken" in poll)) throw new Error("missing native proof");
  const verified = await r.authority.verify(TOKEN, poll.proofToken, "session");
  assert.equal(Object.isFrozen(verified), true);
  assert.equal(Object.isFrozen(verified.identity), true);
  assert.equal(Object.isFrozen(verified.identity.scopes), true);
  assert.equal(Object.isFrozen(verified.grantedScopes), true);
  assert.throws(() => verified.grantedScopes.push("imports.manage"));
});

test("challenge and proof maps are bounded and expiration permits a fresh approval", async () => {
  const r = await rig();
  for (let index = 0; index < 4; index++) await r.authority.start(TOKEN, "session");
  await assert.rejects(r.authority.start(TOKEN, "session"), refused());
  r.clock.advance(300_001);
  const { challenge } = await r.approved("session");
  for (let index = 0; index < 7; index++) await r.authority.poll(TOKEN, challenge.challengeId);
  await assert.rejects(r.authority.poll(TOKEN, challenge.challengeId), refused());
});
