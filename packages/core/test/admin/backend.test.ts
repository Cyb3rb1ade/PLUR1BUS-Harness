import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash, createPublicKey, generateKeyPairSync, verify } from "node:crypto";
import { AdminStore } from "../../src/identity/admin-store.ts";
import { AgentLifecycle } from "../../src/agents/lifecycle.ts";
import { exportAgent } from "../../src/agents/export.ts";
import { buildAdminSurface } from "../../src/rpc/admin-surface.ts";
import { guardMethods, RPC_RULES } from "../../src/rbac/guard.ts";
import { RpcError } from "../../src/rpc/errors.ts";
import { createIdentityService } from "../../src/identity/service.ts";
import { createBreakGlass } from "../../src/rbac/break-glass.ts";
import { SessionStore } from "../../src/session/store.ts";
import type { Principal } from "../../src/rbac/types.ts";
import type { CallContext } from "../../src/rpc/server.ts";

const owner: Principal = { userId: "local-owner", role: "owner", kind: "person" };
const ctx = (): CallContext => ({ requestId: "test", connectionId: "offline", signal: new AbortController().signal });
const methods = ["agent.pause", "agent.resume", "agent.archive", "agent.unarchive", "agent.export", "agent.delete", "user.list", "user.role.set", "user.invite.create", "user.invite.list", "user.invite.revoke", "agent.rights.get", "agent.rights.set", "breakglass.request", "breakglass.list", "breakglass.revoke", "session.list", "pairing.qr"];
const schema = JSON.parse(readFileSync(new URL("../../../rpc-schema/schema/rpc.schema.json", import.meta.url), "utf8"));
const reject = (error: string, reason?: string) => (e: unknown) => e instanceof RpcError && e.error === error && (!reason || e.reason === reason);

function setup(t: { after(fn: () => void): void }, principal = owner) {
  const root = mkdtempSync(join(tmpdir(), "admin-offline-"));
  let now = 1_000_000;
  const audit: any[] = [], notices: any[] = [];
  const sink = { append: (v: unknown) => { audit.push(v); } };
  const identities = createIdentityService({ dbPath: join(root, "identity.sqlite"), clock: () => now, audit: () => {} });
  const people = new AdminStore({ path: join(root, "admin.sqlite"), ownerId: owner.userId });
  const lifecycle = new AgentLifecycle({ path: join(root, "lifecycle.sqlite") });
  const sessions = new SessionStore({ path: ":memory:", clock: () => now });
  const bg = createBreakGlass({ audit: sink, notify: n => { notices.push(n); }, clock: () => now });
  const keys = generateKeyPairSync("ed25519");
  mkdirSync(join(root, "agents", "alpha", "workspace"), { recursive: true });
  writeFileSync(join(root, "agents", "alpha", "SOUL.md"), "A helpful persona");
  const exported: string[] = [], erased: string[] = [];
  const raw = buildAdminSurface({ people, lifecycle, identity: identities, sessions: () => sessions, breakglass: bg, clock: () => now, audit: sink,
    agents: () => ({ alpha: { displayName: "Alpha", skills: ["summary"] } }),
    export: async (id, who) => { exported.push(id); return exportAgent({ root: join(root, "agents", id), agentId: id, config: { skills: ["summary"], password: "synthetic-sensitive-value" }, memories: [], signer: async hash => ({ publicKey: keys.publicKey.export({ type: "spki", format: "der" }).toString("base64"), signature: (await import("node:crypto")).sign(null, Buffer.from(hash, "hex"), keys.privateKey).toString("base64") }) }); },
    erase: async id => { erased.push(id); },
    ownership: p => [p.userId],
  });
  const guarded = guardMethods(raw, { resolve: () => people.resolve(principal), audit: sink, now: () => now });
  const call = (m: string, p: any = {}) => guarded[m]!(p, ctx());
  t.after(() => { sessions.close(); identities.close(); people.close(); lifecycle.close(); rmSync(root, { recursive: true, force: true }); });
  return { root, people, identities, lifecycle, sessions, raw, call, bg, notices, audit, exported, erased, tick: (ms: number) => { now += ms; } };
}

test("every admin method is schema-declared, closed, core-served and guarded", t => {
  const s = setup(t);
  for (const m of methods) { assert.ok(s.raw[m], m); assert.ok(RPC_RULES[m], m); assert.equal(schema.$defs.methods[m]?.["x-server"], "core", m); assert.equal(schema.$defs.methods[m]?.params.additionalProperties, false, m); }
});
for (const principal of [null, { ...owner, role: "viewer" }, { ...owner, kind: "agent" }] as (Principal | null)[]) {
  test(`admin deny by default (${principal?.kind ?? "anonymous"}/${principal?.role ?? "none"}) before side effects`, async t => {
    const s = setup(t);
    const guarded = guardMethods(s.raw, { resolve: () => principal, now: () => 1 });
    for (const m of methods.filter(m => !(principal?.role === "viewer" && m === "session.list"))) {
      await assert.rejects(guarded[m]!({ agentId: "alpha", targetUserId: "other" }, ctx()), reject(principal ? "E_DENIED" : "E_UNAUTHORIZED"), m);
    }
    assert.deepEqual(s.erased, []); assert.deepEqual(s.exported, []);
  });
}
test("pause/resume and archive/unarchive persist independently and retain data", async t => {
  const s = setup(t);
  assert.equal((await s.call("agent.pause", { agentId: "alpha" }) as any).paused, true);
  assert.equal(s.lifecycle.usable("alpha"), false);
  await s.call("agent.archive", { agentId: "alpha" });
  await assert.rejects(s.call("agent.resume", { agentId: "alpha" }), reject("E_CONFLICT", "archived"));
  await s.call("agent.unarchive", { agentId: "alpha" });
  assert.equal(s.lifecycle.usable("alpha"), false);
  await s.call("agent.resume", { agentId: "alpha" });
  assert.equal(s.lifecycle.usable("alpha"), true);
  assert.equal(readFileSync(join(s.root, "agents", "alpha", "SOUL.md"), "utf8"), "A helpful persona");
  const another = new AgentLifecycle({ path: join(s.root, "lifecycle.sqlite") });
  assert.equal(another.usable("alpha"), true); another.close();
});
test("delete requires archive, typed display name and an actor-bound export offer", async t => {
  const s = setup(t), params = { agentId: "alpha", confirmName: "Alpha", exportOfferId: "missing" };
  await assert.rejects(s.call("agent.delete", params), reject("E_CONFLICT", "not-archived"));
  await s.call("agent.archive", { agentId: "alpha" });
  await assert.rejects(s.call("agent.delete", { ...params, confirmName: "alpha" }), reject("E_INVALID_PARAMS", "name-mismatch"));
  await assert.rejects(s.call("agent.delete", params), reject("E_CONFLICT", "export-offer-required"));
  const offer = await s.call("agent.export", { agentId: "alpha", offerOnly: true }) as any;
  assert.deepEqual(s.exported, []);
  await s.call("agent.delete", { ...params, exportOfferId: offer.offerId });
  assert.deepEqual(s.erased, ["alpha"]); assert.equal(s.lifecycle.state("alpha").deleted, true);
  assert.ok(s.audit.some(e => e.action === "agent.delete"));
  await assert.rejects(s.call("agent.unarchive", { agentId: "alpha" }), reject("E_NOT_FOUND"));
});
test("expired export offers cannot authorize deletion; absent engine erasure fails closed", async t => {
  const s = setup(t);
  await s.call("agent.archive", { agentId: "alpha" });
  const offer = await s.call("agent.export", { agentId: "alpha", offerOnly: true }) as any;
  s.tick(600_000);
  await assert.rejects(s.call("agent.delete", { agentId: "alpha", confirmName: "Alpha", exportOfferId: offer.offerId }), reject("E_CONFLICT"));
  const raw = buildAdminSurface({} as any); // denied before dependencies even when a surface is misregistered
  await assert.rejects(raw["agent.delete"]!({}, ctx()), reject("E_UNAUTHORIZED"));
});
test("role presets, rights and last-owner protection affect resolved principals immediately", async t => {
  const s = setup(t), human = s.identities.createHuman({ displayName: "Alex" }, { user: "local-owner", host: "offline", role: "owner", kind: "person" });
  const users = await s.call("user.list") as any;
  assert.equal(users.users.find((u: any) => u.id === human.id).role, "member");
  await assert.rejects(s.call("user.role.set", { userId: owner.userId, role: "member" }), reject("E_CONFLICT", "last-owner"));
  await s.call("user.role.set", { userId: human.id, role: "operator" });
  await s.call("agent.rights.set", { agentId: "alpha", userId: human.id, right: "manage" });
  assert.equal(s.people.resolve({ userId: human.id, role: "member", kind: "person" }).role, "operator");
  assert.equal(s.people.resolve({ userId: human.id, role: "member", kind: "person" }).agentRights?.alpha, "manage");
  const rights = await s.call("agent.rights.get", { agentId: "alpha" }) as any;
  assert.equal(rights.rights[0].right, "manage");
  await s.call("agent.rights.set", { agentId: "alpha", userId: human.id, right: null });
  assert.deepEqual((await s.call("agent.rights.get", { agentId: "alpha" }) as any).rights, []);
});
test("invites show code only once, redeem through identity pairing, expire and revoke", async t => {
  const s = setup(t);
  const invite = await s.call("user.invite.create", { displayName: "Guest", role: "viewer", channel: "test", expiresInMinutes: 1 }) as any;
  const list = await s.call("user.invite.list") as any;
  assert.ok(!JSON.stringify(list).includes(invite.code));
  const claim = s.identities.claim({ code: invite.code, identity: { channel: "test", accountId: "offline", userId: "guest" } });
  await assert.rejects(Promise.resolve().then(() => s.identities.claim({ code: invite.code, identity: { channel: "test", accountId: "offline", userId: "second" } })), /code/);
  s.identities.confirm({ pairingId: claim.pairingId, approve: true }, { user: owner.userId, host: "offline", role: "owner", kind: "person" });
  assert.equal(s.people.resolve({ userId: invite.userId, role: "member", kind: "person" }).role, "viewer");
  const expired = await s.call("user.invite.create", { displayName: "Late", role: "member", channel: "test", expiresInMinutes: 1 }) as any;
  s.tick(60_000);
  assert.throws(() => s.identities.claim({ code: expired.code, identity: { channel: "test", accountId: "offline", userId: "late" } }));
  const revoked = await s.call("user.invite.create", { displayName: "Revoked", role: "member", channel: "test" }) as any;
  await s.call("user.invite.revoke", { inviteId: revoked.id });
  assert.throws(() => s.identities.claim({ code: revoked.code, identity: { channel: "test", accountId: "offline", userId: "revoked" } }));
});
test("break-glass notifies, audits every use, expires and revokes", async t => {
  const s = setup(t), human = s.identities.createHuman({ displayName: "Other" }, { user: owner.userId, host: "offline", kind: "person", role: "owner" });
  const grant = await s.call("breakglass.request", { targetUserId: human.id, reason: "Investigate an incident", windowMinutes: 1 }) as any;
  assert.equal(s.notices[0].userId, human.id);
  assert.equal((await s.call("breakglass.list") as any).grants.length, 1);
  assert.equal(s.bg.authorize(owner, "memory.user.read", { kind: "memory", scope: "user", ownerUserId: human.id }).effect, "allow");
  s.tick(60_000);
  assert.equal((await s.call("breakglass.list") as any).grants.length, 0);
  assert.equal(s.bg.authorize(owner, "memory.user.read", { kind: "memory", scope: "user", ownerUserId: human.id }).effect, "deny");
  assert.ok(s.audit.some(e => e.action === "break-glass.expired"));
  const next = await s.call("breakglass.request", { targetUserId: human.id, reason: "Investigate an incident", windowMinutes: 2 }) as any;
  await s.call("breakglass.revoke", { grantId: next.id });
  assert.equal((await s.call("breakglass.list") as any).grants.length, 0);
  await assert.rejects(s.call("breakglass.request", { targetUserId: human.id, reason: "short", windowMinutes: 1 }), reject("E_INVALID_PARAMS"));
});
test("operator session listing filters owner/agent and contains metadata only", async t => {
  const s = setup(t, { userId: "ops", role: "operator", kind: "person" });
  const one = s.sessions.createSession({ agentId: "alpha", kind: "direct", owner: "one" });
  s.sessions.createSession({ agentId: "beta", kind: "direct", owner: "two" });
  const turn = s.sessions.beginTurn(one.id, "PRIVATE TRANSCRIPT", 5);
  s.sessions.completeTurn(turn.turn.id, { text: "PRIVATE ANSWER", tokens: 8, data: { provider: "offline-model", usage: { inputTokens: 12, outputTokens: 8 } } });
  const r = await s.call("session.list", { owner: "one", agentId: "alpha" }) as any;
  assert.equal(r.sessions.length, 1); assert.equal(r.sessions[0].owner, "one");
  assert.equal(r.sessions[0].model, "offline-model"); assert.equal(r.sessions[0].usage.inputTokens, 12); assert.equal(r.sessions[0].usage.costMicros, null);
  assert.ok(!JSON.stringify(r).includes("PRIVATE"));
  await assert.rejects(s.call("session.list", { owner: "one", search: "PRIVATE" }), reject("E_DENIED", "transcript-search"));
});
test("member cannot request another owner's sessions", async t => {
  const s = setup(t, { userId: "self", role: "member", kind: "person" });
  await assert.rejects(s.call("session.list", { owner: "other" }), reject("E_DENIED"));
});
test("pairing.qr formats an existing validated offer and never issues a code", async t => {
  const s = setup(t), link = "plur1bus://pair?origin=https%3A%2F%2Foffline.invalid&code=ABCD-EFGH&exp=2000&tag=offline-fixture";
  const r = await s.call("pairing.qr", { link }) as any;
  assert.equal(r.qr.text, link); assert.equal(r.qr.errorCorrection, "M");
  await assert.rejects(s.call("pairing.qr", { link: "https://invalid.example" }), reject("E_INVALID_PARAMS"));
  s.tick(2_000_000);
  await assert.rejects(s.call("pairing.qr", { link }), reject("E_CONFLICT", "offer-expired"));
});
test("export has an Ed25519 signature over manifest hash, redacted config and bounded allowlisted files", async t => {
  const s = setup(t);
  writeFileSync(join(s.root, "agents", "alpha", "USER.md"), "password=synthetic-sensitive-value");
  writeFileSync(join(s.root, "agents", "alpha", ".env"), "sensitive ignored");
  symlinkSync(join(s.root, "identity.sqlite"), join(s.root, "agents", "alpha", "IDENTITY.md"));
  const result = await s.call("agent.export", { agentId: "alpha" }) as any;
  const bundle = result.bundle;
  assert.equal(bundle.format, "plur1bus.agent-export/1");
  assert.ok(!JSON.stringify(bundle).includes("synthetic-sensitive-value"));
  assert.ok(!bundle.files.some((f: any) => f.path === ".env" || f.path === "IDENTITY.md"));
  assert.equal(createHash("sha256").update(JSON.stringify(bundle.manifest)).digest("hex"), bundle.manifestHash);
  assert.equal(verify(null, Buffer.from(bundle.manifestHash, "hex"), createPublicKey({ key: Buffer.from(bundle.publicKey, "base64"), type: "spki", format: "der" }), Buffer.from(bundle.signature, "base64")), true);
  for (const f of bundle.files) assert.equal(createHash("sha256").update(f.text).digest("hex"), bundle.manifest.files.find((m: any) => m.path === f.path).sha256);
});

test("metadata defaults to own sessions; privileged allOwners is explicit", async t => {
  const s = setup(t);
  s.sessions.createSession({ kind: "direct", agentId: "alpha", owner: owner.userId });
  s.sessions.createSession({ kind: "direct", agentId: "alpha", owner: "other" });
  assert.equal((await s.call("session.list") as any).sessions.length, 1);
  assert.equal((await s.call("session.list", { allOwners: true }) as any).sessions.length, 2);
  assert.equal((await s.call("session.list", { search: "title" }) as any).sessions.length, 0);
});
test("durable notices are self-scoped and an agent cannot read them", async t => {
  const s = setup(t);
  s.people.notice({ kind: "granted", userId: "self", grantId: "notice-self", holderUserId: "holder", reason: "Investigate incident", expiresAt: 2_000_000 });
  s.people.notice({ kind: "granted", userId: "other", grantId: "notice-other", holderUserId: "holder", reason: "Investigate incident", expiresAt: 2_000_000 });
  const person = guardMethods(s.raw, { resolve: () => ({ userId: "self", role: "member", kind: "person" }), now: () => 1 });
  const result = await person["breakglass.notices"]!({}, ctx()) as any;
  assert.equal(result.notices.length, 1); assert.equal(result.notices[0].userId, "self");
  const agent = guardMethods(s.raw, { resolve: () => ({ ...owner, kind: "agent" }), now: () => 1 });
  await assert.rejects(agent["breakglass.notices"]!({}, ctx()), reject("E_DENIED"));
});
test("a failed mandatory notice never leaves a usable break-glass grant", () => {
  const events: any[] = [];
  const bg = createBreakGlass({ audit: { append: e => { events.push(e); } }, clock: () => 1_000_000, requireNotification: true, notify: () => { throw new Error("offline notice store unavailable"); } });
  assert.throws(() => bg.request(owner, { targetUserId: "other", reason: "Investigate incident" }), /durable notice/);
  assert.deepEqual(bg.active(owner.userId), []);
  assert.ok(events.some(e => e.action === "break-glass.notify-failed"));
});
test("all invalid targets fail without performing administrative effects", async t => {
  const s = setup(t);
  for (const method of ["agent.pause", "agent.resume", "agent.archive", "agent.unarchive", "agent.export", "agent.delete", "agent.rights.get", "agent.rights.set"])
    await assert.rejects(s.call(method, { agentId: "unknown", userId: "unknown", right: "use", confirmName: "Unknown", exportOfferId: "unknown" }), reject("E_NOT_FOUND"), method);
  for (const [m,p] of [["user.role.set", { userId: "unknown", role: "member" }], ["user.invite.revoke", { inviteId: "unknown" }], ["breakglass.request", { targetUserId: "unknown", reason: "Investigate incident" }], ["breakglass.revoke", { grantId: "unknown" }]] as const)
    await assert.rejects(s.call(m,p), reject("E_NOT_FOUND"), m);
  await assert.rejects(s.call("agent.archive", { agentId: "constructor" }), reject("E_NOT_FOUND"));
  assert.deepEqual(s.exported, []); assert.deepEqual(s.erased, []);
});
test("admin cannot promote an Owner, or demote an existing Owner", async t => {
  const s = setup(t, { userId: "admin", role: "admin", kind: "person" });
  const h = s.identities.createHuman({ displayName: "Alex" }, { user: owner.userId, host: "offline", kind: "person", role: "owner" });
  await assert.rejects(s.call("user.role.set", { userId: h.id, role: "owner" }), reject("E_DENIED", "owner-only"));
  await assert.rejects(s.call("user.role.set", { userId: owner.userId, role: "member" }), reject("E_DENIED", "owner-only"));
});

test("export scans recognizable patterns and exact secret canaries without committed token-like fixtures", async t => {
  const s = setup(t), keys = generateKeyPairSync("ed25519");
  const token = ["s", "k", "-"].join("") + "synthetic".repeat(8);
  const canary = "offline phrase with arbitrary sensitive contents";
  writeFileSync(join(s.root,"agents","alpha","SOUL.md"), `Persona includes ${token} and ${canary}`);
  const bundle = await exportAgent({ root:join(s.root,"agents","alpha"),agentId:"alpha",config:{ skills:["summary"],apiKey:canary },memories:[{ text:token,summary:canary }],secrets:[canary],signer:async hash=>({ publicKey: keys.publicKey.export({format:"der",type:"spki"}).toString("base64"),signature:(await import("node:crypto")).sign(null,Buffer.from(hash,"hex"),keys.privateKey).toString("base64") }) });
  const serialized=JSON.stringify(bundle); assert.equal(serialized.includes(token),false); assert.equal(serialized.includes(canary),false);
  assert.equal(bundle.files.some(f=>f.path.endsWith(".sqlite") || f.path===".env"),false);
});
test("audit failure blocks role, rights and lifecycle mutations", async t => {
  const s=setup(t);
  const raw=buildAdminSurface({ people:s.people,lifecycle:s.lifecycle,identity:s.identities,sessions:()=>s.sessions,breakglass:s.bg,agents:()=>({alpha:{displayName:"Alpha"}}),export:async()=>({}),clock:()=>1_000_000,ownership:p=>[p.userId],audit:{append:()=>{throw new Error("offline failure");}} });
  const methods=guardMethods(raw,{ resolve:()=>owner,now:()=>1 });
  await assert.rejects(methods["agent.pause"]!({agentId:"alpha"},ctx()),reject("E_STORAGE","audit-failed"));
  assert.equal(s.lifecycle.usable("alpha"),true);
  await assert.rejects(methods["user.role.set"]!({userId:owner.userId,role:"owner"},ctx()),reject("E_STORAGE","audit-failed"));
  assert.equal(s.people.role(owner.userId),"owner");
});
test("claimed invitations expire at their original deadline and can be revoked before confirmation", async t => {
  const s=setup(t),a={user:owner.userId,host:"offline",role:"owner",kind:"person"} as const;
  const i=await s.call("user.invite.create",{ displayName:"Expiring",role:"member",channel:"test",expiresInMinutes:1 }) as any;
  const claimed=s.identities.claim({code:i.code,identity:{channel:"test",accountId:"offline",userId:"expiring"}});
  s.tick(60_000); assert.throws(()=>s.identities.confirm({pairingId:claimed.pairingId,approve:true},a),/confirmed in time/);
  const next=await s.call("user.invite.create",{displayName:"Revocable",role:"member",channel:"test"}) as any;
  const proof=s.identities.claim({code:next.code,identity:{channel:"test",accountId:"offline",userId:"revocable"}});
  await s.call("user.invite.revoke",{inviteId:next.id});
  assert.throws(()=>s.identities.confirm({pairingId:proof.pairingId,approve:true},a),/not waiting/);
});
