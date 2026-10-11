// #386: shareable invitation links. TTL on a fake clock, single use, revocation, one uniform failure, no token in any sink.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AdminStore } from "../../src/identity/admin-store.ts";
import { AgentLifecycle } from "../../src/agents/lifecycle.ts";
import { buildAdminSurface } from "../../src/rpc/admin-surface.ts";
import { guardMethods, RPC_RULES } from "../../src/rbac/guard.ts";
import { RpcError } from "../../src/rpc/errors.ts";
import { createIdentityService } from "../../src/identity/service.ts";
import { createBreakGlass } from "../../src/rbac/break-glass.ts";
import { createLogger } from "../../src/logger.ts";
import { createRpcServer } from "../../src/rpc/server.ts";
import { hashInviteToken, isInviteTokenShape, parseOrigin } from "../../src/identity/invite-token.ts";
import { connect } from "../helpers/connect.ts";
import type { Principal } from "../../src/rbac/types.ts";
import type { CallContext } from "../../src/rpc/server.ts";

const owner: Principal = { userId: "local-owner", role: "owner", kind: "person" };
const ORIGIN = "https://harness.example";
const MINUTE = 60_000;
const ctx = (connectionId = "conn-a"): CallContext => ({ requestId: "test", connectionId, signal: new AbortController().signal });
const refused = (error: string, reason?: string) => (e: unknown) => e instanceof RpcError && e.error === error && e.reason === reason;
const invalid = refused("E_INVITE_INVALID");
/** The token is the last path segment of the link's fragment. */
const tokenOf = (link: string): string => link.slice(link.lastIndexOf("/") + 1);

function setup(t: { after(fn: () => void): void }) {
  const root = mkdtempSync(join(tmpdir(), "invites-"));
  let now = 1_000_000;
  const audit: any[] = [];
  let auditDown = false;
  const sink = { append: (v: unknown) => { if (auditDown) throw new Error("audit down"); audit.push(v); } };
  const identity = createIdentityService({ dbPath: join(root, "identity.sqlite"), clock: () => now, audit: () => {} });
  const people = new AdminStore({ path: join(root, "admin.sqlite"), ownerId: owner.userId });
  const lifecycle = new AgentLifecycle({ path: join(root, "lifecycle.sqlite") });
  const raw = buildAdminSurface({ people, lifecycle, identity, sessions: () => null, breakglass: createBreakGlass({ audit: sink, notify: () => {}, clock: () => now }),
    agents: () => ({}), export: async () => ({}), ownership: p => [p.userId], clock: () => now, audit: sink });
  const guarded = guardMethods(raw, { resolve: () => people.resolve(owner), audit: sink, now: () => now });
  const call = (m: string, p: any = {}, c = ctx()) => guarded[m]!(p, c);
  const create = (extra: Record<string, unknown> = {}) => call("user.invite.create", { displayName: "Alex", role: "member", channel: "web", origin: ORIGIN, ...extra });
  t.after(() => { identity.close(); people.close(); lifecycle.close(); rmSync(root, { recursive: true, force: true }); });
  return { root, people, identity, call, create, raw, audit, sink, tick: (ms: number) => { now += ms; }, setAuditDown: (v: boolean) => { auditDown = v; }, now: () => now };
}

test("a link carries 256 bits of randomness, is built on the origin's fragment and is returned once", async t => {
  const s = setup(t);
  const a = await s.create() as any, b = await s.create() as any;
  assert.ok(a.link.startsWith(`${ORIGIN}/#/invite/`));
  assert.ok(isInviteTokenShape(tokenOf(a.link)));
  assert.equal(Buffer.from(tokenOf(a.link), "base64url").length, 32);
  assert.notEqual(tokenOf(a.link), tokenOf(b.link));
  const listed = JSON.stringify(await s.call("user.invite.list"));
  assert.ok(!listed.includes(tokenOf(a.link)), "list never repeats the token");
  assert.ok(!listed.includes(hashInviteToken(tokenOf(a.link))), "list never repeats the hash");
});

test("only the hash is stored", async t => {
  const s = setup(t);
  const { link } = await s.create() as any, token = tokenOf(link);
  const rows = s.people.db.prepare("SELECT * FROM admin_invites").all();
  assert.ok(!JSON.stringify(rows).includes(token));
  assert.equal((rows[0] as any).token_hash, hashInviteToken(token));
});

test("without an origin no link is made (CLI shape: pairing code only)", async t => {
  const s = setup(t);
  const r = await s.call("user.invite.create", { displayName: "Alex", role: "member", channel: "cli" }) as any;
  assert.equal(r.link, undefined); assert.ok(r.code);
  assert.equal(((await s.call("user.invite.list")) as any).invites[0].shareable, false);
});

test("validity: presets and a custom value up to 30 days, nothing beyond", async t => {
  const s = setup(t);
  for (const [minutes, label] of [[60, "1h"], [24 * 60, "24h"], [7 * 24 * 60, "7d"], [30 * 24 * 60, "30d"], [90, "custom"]] as const) {
    const r = await s.create({ ttlMinutes: minutes }) as any;
    assert.equal(r.expiresAt, s.now() + minutes * MINUTE, label);
  }
  for (const bad of [0, -5, 30 * 24 * 60 + 1, 1.5, "60"]) await assert.rejects(s.create({ ttlMinutes: bad }), refused("E_INVALID_PARAMS"), String(bad));
  await assert.rejects(s.create({ ttlMinutes: 60, expiresInMinutes: 60 }), refused("E_INVALID_PARAMS"));
  assert.equal(((await s.create()) as any).expiresAt, s.now() + 60 * MINUTE, "default stays one hour");
});

test("the origin must be a bare web origin", async t => {
  const s = setup(t);
  for (const bad of ["harness.example", "ftp://harness.example", "https://u:p@harness.example", "https://harness.example/path", "https://harness.example/?a=1", "https://harness.example/#x", "javascript:alert(1)", ""])
    await assert.rejects(s.create({ origin: bad }), refused("E_INVALID_PARAMS"), bad);
  assert.equal(parseOrigin("http://127.0.0.1:8080"), "http://127.0.0.1:8080");
  assert.equal(parseOrigin("https://harness.example/"), "https://harness.example");
});

test("redeem works once, returns the invited person and never shows the token again", async t => {
  const s = setup(t);
  const made = await s.create({ displayName: "Kim", role: "operator" }) as any, token = tokenOf(made.link);
  const out = await s.raw["user.invite.redeem"]!({ token }, ctx()) as any;
  assert.deepEqual(out, { userId: made.userId, displayName: "Kim", role: "operator" });
  await assert.rejects(s.raw["user.invite.redeem"]!({ token }, ctx()), invalid, "second use");
  assert.equal(((await s.call("user.invite.list")) as any).invites[0].state, "redeemed");
});

test("expiry on a fake clock: valid just before, invalid at the instant and after", async t => {
  const s = setup(t);
  const early = tokenOf(((await s.create({ ttlMinutes: 24 * 60 })) as any).link);
  const late = tokenOf(((await s.create({ ttlMinutes: 24 * 60 })) as any).link);
  s.tick(24 * 60 * MINUTE - 1);
  assert.ok(await s.raw["user.invite.redeem"]!({ token: early }, ctx()), "one millisecond before expiry");
  s.tick(1);
  await assert.rejects(s.raw["user.invite.redeem"]!({ token: late }, ctx()), invalid, "at expiry");
  s.tick(10 * 24 * 60 * MINUTE);
  await assert.rejects(s.raw["user.invite.redeem"]!({ token: late }, ctx()), invalid, "long after");
});

test("a 30-day link outlives the one-hour pairing code and survives a restart of the store", async t => {
  const s = setup(t);
  const made = await s.create({ ttlMinutes: 30 * 24 * 60 }) as any;
  s.tick(2 * 60 * MINUTE);
  const listed = (await s.call("user.invite.list") as any).invites[0];
  assert.equal(listed.state, "pending", "pairing code is long expired, the link is not");
  const reopened = new AdminStore({ path: join(s.root, "admin.sqlite"), ownerId: owner.userId });
  t.after(() => reopened.close());
  assert.equal(reopened.invites()[0]!.id, made.id, "durable across reopen");
});

test("revoked links fail, and the pairing code dies with them", async t => {
  const s = setup(t);
  const made = await s.create() as any, token = tokenOf(made.link);
  assert.deepEqual(await s.call("user.invite.revoke", { inviteId: made.id }), { id: made.id, revoked: true });
  await assert.rejects(s.raw["user.invite.redeem"]!({ token }, ctx()), invalid);
  assert.equal(((await s.call("user.invite.list")) as any).invites[0].state, "revoked");
});

test("a link can still be revoked after its pairing code was claimed and confirmed", async t => {
  const s = setup(t);
  const made = await s.create() as any, token = tokenOf(made.link);
  const handle = { channel: "web", accountId: "acct", userId: "u-1" };
  s.identity.claim({ code: made.code, identity: handle });
  s.identity.confirm({ pairingId: made.id, approve: true }, { user: owner.userId, host: "rpc", role: "owner", kind: "person" });
  assert.deepEqual(await s.call("user.invite.revoke", { inviteId: made.id }), { id: made.id, revoked: true });
  await assert.rejects(s.raw["user.invite.redeem"]!({ token }, ctx()), invalid, "the link is dead");
  assert.equal(((await s.call("user.invite.list")) as any).invites[0].state, "revoked");
});

test("a code-only invitation still refuses revoke once its pairing is confirmed", async t => {
  const s = setup(t);
  const made = await s.call("user.invite.create", { displayName: "Alex", role: "member", channel: "web" }) as any;
  s.identity.claim({ code: made.code, identity: { channel: "web", accountId: "acct", userId: "u-2" } });
  s.identity.confirm({ pairingId: made.id, approve: true }, { user: owner.userId, host: "rpc", role: "owner", kind: "person" });
  await assert.rejects(s.call("user.invite.revoke", { inviteId: made.id }), refused("E_CONFLICT"));
});

test("a redeemed invitation cannot be revoked afterwards", async t => {
  const s = setup(t);
  const made = await s.create() as any;
  await s.raw["user.invite.redeem"]!({ token: tokenOf(made.link) }, ctx());
  await assert.rejects(s.call("user.invite.revoke", { inviteId: made.id }), refused("E_CONFLICT", "redeemed"));
});

test("unknown, expired, revoked, used and malformed tokens are indistinguishable to the caller", async t => {
  const s = setup(t);
  const expired = tokenOf(((await s.create({ ttlMinutes: 1 })) as any).link);
  const revoked = (await s.create()) as any, used = tokenOf(((await s.create()) as any).link);
  await s.call("user.invite.revoke", { inviteId: revoked.id });
  await s.raw["user.invite.redeem"]!({ token: used }, ctx());
  s.tick(2 * MINUTE);
  const answers: string[] = [];
  // Distinct connections, so the per-connection lock does not turn the later answers into a different error.
  const cases: [string, unknown][] = [["expired", expired], ["revoked", tokenOf(revoked.link)], ["used", used], ["unknown", "A".repeat(43)], ["malformed", "short"], ["not a string", 42], ["missing", undefined]];
  for (const [i, [, token]] of cases.entries()) {
    try { await s.raw["user.invite.redeem"]!({ token }, ctx(`c${i}`)); answers.push("accepted"); }
    catch (e) { answers.push(JSON.stringify(e instanceof RpcError ? { error: e.error, message: e.message, reason: e.reason, detail: e.detail } : String(e))); }
  }
  assert.equal(new Set(answers).size, 1, answers.join("\n"));
  assert.match(answers[0]!, /E_INVITE_INVALID/);
  assert.ok(!/expired|revoked|used|unknown|redeemed/i.test(answers[0]!.replace("E_INVITE_INVALID", "")), "no hint in the error");
});

test("failed redeems are rate-limited per connection, and a lock also refuses a valid token", async t => {
  const s = setup(t);
  const good = tokenOf(((await s.create()) as any).link);
  for (let i = 0; i < 5; i++) await assert.rejects(s.raw["user.invite.redeem"]!({ token: "A".repeat(43) }, ctx("attacker")), invalid);
  await assert.rejects(s.raw["user.invite.redeem"]!({ token: good }, ctx("attacker")), refused("E_DENIED", "rate-limited"));
  // Another connection is not locked by it.
  assert.ok(await s.raw["user.invite.redeem"]!({ token: good }, ctx("someone-else")));
  s.tick(15 * MINUTE + 1);
  await assert.rejects(s.raw["user.invite.redeem"]!({ token: "A".repeat(43) }, ctx("attacker")), invalid, "the lock expires");
});

test("the global limit holds when the attacker rotates connections", async t => {
  const s = setup(t);
  const good = tokenOf(((await s.create()) as any).link);
  for (let i = 0; i < 99; i++) await assert.rejects(s.raw["user.invite.redeem"]!({ token: "A".repeat(43) }, ctx(`rot-${i}`)), invalid);
  assert.ok(await s.raw["user.invite.redeem"]!({ token: tokenOf(((await s.create()) as any).link) }, ctx("still-fine")), "below the limit nobody is locked out");
  await assert.rejects(s.raw["user.invite.redeem"]!({ token: "A".repeat(43) }, ctx("rot-last")), invalid);
  await assert.rejects(s.raw["user.invite.redeem"]!({ token: good }, ctx("fresh")), refused("E_DENIED", "rate-limited"));
  s.tick(5 * MINUTE + 1);
  assert.ok(await s.raw["user.invite.redeem"]!({ token: good }, ctx("after-the-short-lock")), "the overall lock is short");
});

test("the limit survives a restart of the store", async t => {
  const s = setup(t);
  for (let i = 0; i < 5; i++) await assert.rejects(s.raw["user.invite.redeem"]!({ token: "A".repeat(43) }, ctx("attacker")), invalid);
  const reopened = new AdminStore({ path: join(s.root, "admin.sqlite"), ownerId: owner.userId });
  t.after(() => reopened.close());
  const left = reopened.db.prepare("SELECT locked_until FROM attempts WHERE key = ?").get("invite-redeem:src:attacker") as any;
  assert.ok(left.locked_until > s.now());
});

test("create, redeem, refusal and revoke are audited, without any token", async t => {
  const s = setup(t);
  const made = await s.create() as any, token = tokenOf(made.link);
  await assert.rejects(s.raw["user.invite.redeem"]!({ token: "B".repeat(43) }, ctx()), invalid);
  await s.raw["user.invite.redeem"]!({ token }, ctx());
  const second = await s.create() as any;
  await s.call("user.invite.revoke", { inviteId: second.id });
  const actions = s.audit.map(e => e.action);
  for (const a of ["user.invite.create", "user.invite.redeem", "user.invite.revoke", "user.invite.redeem.refused"]) assert.ok(actions.includes(a), a);
  const trail = JSON.stringify(s.audit);
  for (const secret of [token, hashInviteToken(token), tokenOf(second.link), made.code]) assert.ok(!trail.includes(secret));
  const create = s.audit.find(e => e.action === "user.invite.create");
  assert.deepEqual(create.detail, { role: "member", channel: "web", ttlMinutes: 60, shareable: true });
});

test("if the audit write fails the token is not consumed, and the caller sees the same uniform failure", async t => {
  const s = setup(t);
  const token = tokenOf(((await s.create()) as any).link);
  s.setAuditDown(true);
  await assert.rejects(s.raw["user.invite.redeem"]!({ token }, ctx()), invalid);
  s.setAuditDown(false);
  assert.ok(await s.raw["user.invite.redeem"]!({ token }, ctx("retry")), "still redeemable");
});

test("concurrent redeems of one token: exactly one wins", async t => {
  const s = setup(t);
  const token = tokenOf(((await s.create()) as any).link);
  const results = await Promise.allSettled(Array.from({ length: 8 }, (_, i) => s.raw["user.invite.redeem"]!({ token }, ctx(`p${i}`))));
  assert.equal(results.filter(r => r.status === "fulfilled").length, 1);
});

test("redeem needs no principal; every other invite method is still guarded", async t => {
  const s = setup(t);
  assert.equal(RPC_RULES["user.invite.redeem"], undefined);
  for (const m of ["user.invite.create", "user.invite.list", "user.invite.revoke"]) assert.ok(RPC_RULES[m], m);
  const anonymous = guardMethods(s.raw, { resolve: () => null, now: () => 1 });
  for (const m of ["user.invite.create", "user.invite.list", "user.invite.revoke"]) await assert.rejects(anonymous[m]!({}, ctx()), refused("E_UNAUTHORIZED", "no-principal"), m);
});

test("over a real RPC server: the token appears in no log line, no error and no reply but the one issuing it", async t => {
  const s = setup(t);
  const dir = mkdtempSync(join(tmpdir(), "invites-rpc-"));
  const logFile = join(dir, "core.log");
  const log = createLogger({ file: logFile, level: "debug", role: "core" });
  const address = process.platform === "win32" ? `\\\\.\\pipe\\plur1bus-invites-${process.pid}` : join(dir, "core.sock");
  const TOKEN = "c".repeat(64);
  const server = createRpcServer({ address, token: TOKEN, hello: () => ({ contract: "1.4.1", rpc: "1.0.0", instanceId: "inst", pid: process.pid }), logger: log, methods: { "user.invite.redeem": s.raw["user.invite.redeem"]! } });
  await server.listen();
  t.after(async () => { await server.close(); await log.close(); rmSync(dir, { recursive: true, force: true }); });
  const made = await s.create() as any, token = tokenOf(made.link), wrong = "W".repeat(43);
  const c = await connect({ address, token: TOKEN });
  const replies: string[] = [];
  const oversize = "O".repeat(300); // refused by the schema layer: its error text must not echo the value either
  for (const tk of [oversize, wrong, wrong, token, token]) {
    try { replies.push(JSON.stringify(await c.call("user.invite.redeem", { token: tk }))); } catch (e: any) { replies.push(JSON.stringify({ error: e.error, message: e.message, reason: e.reason, detail: e.detail })); }
  }
  await c.close();
  await server.close(); await log.close();
  const logs = readdirSync(dir).filter(f => f.startsWith("core.log")).map(f => readFileSync(join(dir, f), "utf8")).join("\n");
  assert.ok(logs.length > 0, "the server did log the calls");
  for (const secret of [token, wrong, oversize, hashInviteToken(token)]) { assert.ok(!logs.includes(secret), "log"); assert.ok(!replies.join("\n").includes(secret), "replies"); }
  assert.equal(replies.filter(r => r.includes("E_INVITE_INVALID")).length, 3);
});
