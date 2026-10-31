import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, statSync, writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomBytes } from "node:crypto";
import { AccountStore, type CorePerson } from "../src/account-store.ts";
import { hashPassword } from "../src/password.ts";
import { PasswordLogin } from "../src/login.ts";
import { systemClock } from "../src/clock.ts";
import { TokenService } from "../src/tokens.ts";

test("durable credentials normalize names, enforce both unique keys, secure files and exclude authority", async t => {
  const dir = mkdtempSync(join(tmpdir(), "accounts-")), path = join(dir, "private", "accounts.db"); t.after(() => rmSync(dir, { recursive: true, force: true }));
  const p: CorePerson = { userId: "person-a", kind: "person", role: "member", disabled: false, version: 1 };
  let store = new AccountStore({ path, resolve: async () => p });
  const hash = await hashPassword(randomBytes(16).toString("hex"));
  await store.createPending(p.userId, "  Alice  ", hash); assert.equal(await store.findById(p.userId), undefined);
  await assert.rejects(store.createPending("person-b", "ALICE", hash), { error: "E_CONFLICT" });
  await assert.rejects(store.createPending(p.userId, "different", hash), { error: "E_CONFLICT" });
  await store.activate(p.userId); assert.equal((await store.findByUsername("aLiCe"))?.role, "member");
  if (process.platform !== "win32") { assert.equal(statSync(path).mode & 0o777, 0o600); assert.equal(statSync(join(dir, "private")).mode & 0o777, 0o700); } // Windows has no POSIX mode bits (its files read 0o666)
  store.close(); store = new AccountStore({ path, resolve: async () => ({ ...p, role: "viewer" }) });
  assert.equal((await store.findByUsername("alice"))?.role, "viewer");
  await store.createPending("pending", "pending", hash); await store.removePending("pending"); await store.createPending("pending", "pending", hash);
  store.close(); assert.equal(readFileSync(path).includes(Buffer.from('"role"')), false);
});
test("disable then enable while API was offline revokes old tokens permanently and invalidates versions", async t => {
  const dir = mkdtempSync(join(tmpdir(), "accounts-status-")), path = join(dir, "accounts.db");
  let p: CorePerson | null = { userId: "person-a", kind: "person", role: "member", disabled: false, version: 1 };
  // after-hooks run in registration order: the open SQLite file must be closed before its directory is removed (Windows refuses otherwise)
  const store = new AccountStore({ path, resolve: async () => p }); t.after(() => store.close()); t.after(() => rmSync(dir, { recursive: true, force: true }));
  const password = randomBytes(16).toString("hex"); await store.createPending("person-a", "alice", await hashPassword(password)); await store.activate("person-a");
  const login = new PasswordLogin({ users: store, clock: systemClock }); assert.equal((await login.check("alice", password)).ok, true);
  const old = (await store.findById("person-a"))!.version;
  const tokens = new TokenService({ store: store.tokens, clock: systemClock }); const minted = await tokens.create("person-a", { name: "test", scopes: ["agent.read"] });
  p = { ...p!, version: 3 }; assert.equal((await tokens.authenticate(minted.token)).ok, false); assert.ok((await store.tokens.get(minted.record.id))?.revokedAt);
  assert.ok((await store.findById("person-a"))!.version > old);
  p = { ...p, disabled: true, version: 4 }; assert.equal((await login.check("alice", password)).ok, false);
  p = { ...p, disabled: false, version: 5 }; assert.equal((await login.check("alice", password)).ok, true); assert.equal((await tokens.authenticate(minted.token)).ok, false);
  p = null; assert.equal((await login.check("alice", password)).ok, false);
});
test("corrupt database storage errors do not disclose paths or SQLite messages", () => {
  const dir = mkdtempSync(join(tmpdir(), "accounts-corrupt-")), path = join(dir, "marker-private.db"); writeFileSync(path, randomBytes(32));
  try { assert.throws(() => new AccountStore({ path, resolve: async () => null }), e => { assert.equal((e as { error: string }).error, "E_STORAGE"); assert.equal(String(e).includes(path), false); assert.equal(String(e).includes("SQLite"), false); return true; }); }
  finally { rmSync(dir, { recursive: true, force: true }); }
});

test("durable login compares the real password before reading Core status", async t => {
  let comparisons = 0, resolutions = 0;
  const store = new AccountStore({ path: ":memory:", resolve: async userId => { resolutions++; assert.equal(comparisons, 1); return { userId, kind: "person", role: "member", disabled: true, version: 1 }; } }); t.after(() => store.close());
  const password = randomBytes(16).toString("hex"); await store.createPending("person", "alice", await hashPassword(password)); await store.activate("person");
  const { verifyPassword } = await import("../src/password.ts"); const login = new PasswordLogin({ users: store, clock: systemClock, verify: async (hash, input) => { comparisons++; return verifyPassword(hash, input); } });
  assert.equal((await login.check("alice", password)).ok, false); assert.equal(resolutions, 1);
});

test("TOTP enrollment, backup hashes and replay counter persist; only enabled credential changes end sessions", async t => {
  const dir = mkdtempSync(join(tmpdir(), "accounts-totp-")), path = join(dir, "accounts.db");
  const resolve = async (userId: string): Promise<CorePerson> => ({ userId, kind: "person", role: "member", disabled: false, version: 1 }); let store = new AccountStore({ path, resolve });
  // one hook, store first: it closes whichever store is current (the test reopens), then removes the directory (Windows refuses while the file is open)
  t.after(() => { try { store.close(); } catch { /* already closed */ } rmSync(dir, { recursive: true, force: true }); });
  const password = randomBytes(16).toString("hex"); await store.createPending("person", "alice", await hashPassword(password)); await store.activate("person");
  const { TotpService, totpCodeAt } = await import("../src/totp.ts"); const { FakeClock } = await import("../src/clock.ts"); const clock = new FakeClock(); const service = new TotpService({ store: store.totp, clock, issuer: "Test" });
  const before = (await store.findById("person"))!.version; const setup = await service.begin("person", "alice"); assert.equal((await store.findById("person"))!.version, before);
  const enabled = await service.confirm("person", totpCodeAt(setup.secret, clock.now())); assert.equal(enabled.ok, true); const version = (await store.findById("person"))!.version; assert.ok(version > before);
  store.close(); store = new AccountStore({ path, resolve }); const reopened = new TotpService({ store: store.totp, clock, issuer: "Test" });
  assert.equal(await reopened.isEnabled("person"), true); assert.equal((await reopened.verify("person", totpCodeAt(setup.secret, clock.now()))).ok, false);
  clock.advance(30_000); assert.equal((await reopened.verify("person", totpCodeAt(setup.secret, clock.now()))).ok, true); assert.equal((await store.findById("person"))!.version, version);
  assert.equal((await reopened.status("person")).backupCodesRemaining, 10);
});

test("passkeys persist across reopen and changes bump the account version; consumed bootstrap never reinitializes", async t => {
  const dir = mkdtempSync(join(tmpdir(), "passkeys-durable-")), path = join(dir, "accounts.db");
  const resolve = async (userId: string): Promise<CorePerson> => ({ userId, kind: "person", role: "owner", disabled: false, version: 1 }); let store = new AccountStore({ path, resolve });
  t.after(() => { try { store.close(); } catch { /* already closed */ } rmSync(dir, { recursive: true, force: true }); });
  const { bootstrapHash } = await import("../src/bootstrap.ts"); const proof = randomBytes(32).toString("base64url"); store.initializeBootstrap(bootstrapHash(proof)); await store.bootstrapOwner("christian", "unused");
  const v = (await store.findById("local-owner"))!.version, id = randomBytes(32).toString("base64url"); store.putPasskey("local-owner", { id, name: "Laptop", publicKey: "public-test-key", signCount: 1 }); assert.equal((await store.findById("local-owner"))!.version, v + 1);
  store.close(); store = new AccountStore({ path, resolve }); assert.deepEqual(store.passkeysFor("local-owner").map(k => k.name), ["Laptop"]);
  assert.equal(store.advancePasskey("local-owner", id, 1, 2), true); assert.equal(store.advancePasskey("local-owner", id, 1, 3), false);
  store.changePasskey("local-owner", id, "Desktop"); assert.equal((await store.findById("local-owner"))!.version, v + 2);
  store.changePasskey("local-owner", id); assert.equal(store.passkeysFor("local-owner").length, 0); assert.equal((await store.findById("local-owner"))!.version, v + 3);
  store.initializeBootstrap(bootstrapHash(randomBytes(32).toString("base64url"))); assert.equal(store.bootstrapState()?.consumed, true); assert.equal(store.bootstrapState()?.hash, null);
  await assert.rejects(store.bootstrapOwner("someone", "unused"), { status: 404 });
});

test("M6A-B3: OAuth state persists in AccountStore SQLite and survives restart", async t => {
  const dir = mkdtempSync(join(tmpdir(), "accounts-oauth-")), path = join(dir, "accounts.db");
  const resolve = async (userId: string): Promise<CorePerson> => ({ userId, kind: "person", role: "member", disabled: false, version: 1 });
  let store = new AccountStore({ path, resolve });
  t.after(() => { try { store.close(); } catch { /* already closed */ } rmSync(dir, { recursive: true, force: true }); });

  const grant = {
    id: "g-1",
    familyId: "fam-1",
    userId: "u-1",
    clientId: "client-a",
    agentId: "main",
    audience: "mcp" as const,
    scopes: ["mcp.read"],
    createdAt: 1000,
    lastUsedAt: 1000,
  };
  const token = {
    tokenHash: "hash-1",
    grantId: "g-1",
    familyId: "fam-1",
    userId: "u-1",
    clientId: "client-a",
    agentId: "main",
    audience: "mcp" as const,
    scopes: ["mcp.read"],
    createdAt: 1000,
    expiresAt: 5000,
    used: false,
  };

  await store.oauth.saveGrant(grant);
  await store.oauth.saveRefreshToken(token);

  assert.deepEqual(await store.oauth.getGrant("g-1"), grant);
  assert.deepEqual(await store.oauth.getRefreshToken("hash-1"), token);

  // Close and reopen
  store.close();
  store = new AccountStore({ path, resolve });

  assert.deepEqual(await store.oauth.getGrant("g-1"), grant);
  assert.deepEqual(await store.oauth.getRefreshToken("hash-1"), token);
  assert.deepEqual(await store.oauth.getGrantByFamily("fam-1"), grant);
  assert.equal((await store.oauth.listGrantsByUser("u-1")).length, 1);

  // markRefreshTokenUsed
  await store.oauth.markRefreshTokenUsed("hash-1");
  const usedToken = await store.oauth.getRefreshToken("hash-1");
  assert.equal(usedToken?.used, true);

  // revokeFamily
  await store.oauth.revokeFamily("fam-1");
  assert.equal(await store.oauth.getRefreshToken("hash-1"), undefined);
  const revokedGrant = await store.oauth.getGrant("g-1");
  assert.ok(revokedGrant?.revokedAt);
});
