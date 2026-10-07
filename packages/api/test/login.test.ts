import assert from "node:assert/strict";
import test from "node:test";
import { FakeClock } from "../src/clock.ts";
import { PasswordLogin } from "../src/login.ts";
import { MemoryUserDirectory } from "../src/memory-stores.ts";
import { ARGON2_PARAMS, hashPassword, needsRehash, verifyPassword } from "../src/password.ts";

const PW = "fixture-password-not-real-1";

async function setup(policy = {}) {
  const users = new MemoryUserDirectory(); const clock = new FakeClock();
  users.add({ id: "u1", username: "Alice", role: "member", passwordHash: await hashPassword(PW) });
  users.add({ id: "u2", username: "off", role: "member", passwordHash: await hashPassword(PW), disabled: true });
  users.add({ id: "u3", username: "tokenonly", role: "member" });
  const verifyCalls: string[] = [];
  const verify: typeof verifyPassword = (h, p) => { verifyCalls.push(h); return verifyPassword(h, p); };
  return { users, clock, verifyCalls, login: new PasswordLogin({ users, clock, verify, policy }) };
}

test("the right password logs in; the name is case- and whitespace-insensitive", async () => {
  const { login } = await setup();
  const r = await login.check("  ALICE ", PW);
  assert.equal(r.ok, true); if (r.ok) assert.equal(r.user.id, "u1");
});

test("unknown name, wrong password, disabled and password-less accounts fail with the identical result (no enumeration)", async () => {
  const { login } = await setup({ maxFailures: 100 });
  const results = [await login.check("nobody", PW), await login.check("alice", "wrong"), await login.check("off", PW), await login.check("tokenonly", PW)];
  for (const r of results) assert.deepEqual(r, { ok: false, locked: false });
  for (const bad of [undefined, 5, null, "", "x".repeat(129)]) assert.deepEqual(await login.check(bad, PW), { ok: false, locked: false });
  assert.deepEqual(await login.check("alice", undefined), { ok: false, locked: false });
});

test("unknown names cost one Argon2id verification, like known ones (constant work), against a dummy hash that is not any user's", async () => {
  const { login, verifyCalls, users } = await setup({ maxFailures: 100 });
  await login.check("nobody", PW); await login.check("tokenonly", PW); await login.check("alice", "wrong");
  assert.equal(verifyCalls.length, 3);
  const alice = (await users.findByUsername("alice"))!.passwordHash;
  assert.equal(verifyCalls[0], verifyCalls[1], "one shared dummy");
  assert.notEqual(verifyCalls[0], alice); assert.equal(verifyCalls[2], alice);
});

test("failures lock the name with exponential backoff, even for the right password; a lock applies to unknown names alike", async () => {
  const { login, clock } = await setup({ maxFailures: 3, baseDelayMs: 10_000, maxDelayMs: 60_000 });
  for (let i = 0; i < 3; i++) await login.check("alice", "wrong");
  let r = await login.check("alice", PW);
  assert.deepEqual(r, { ok: false, locked: true, retryAfterSec: 10 });
  clock.advance(10_001);
  assert.equal((await login.check("alice", "wrong")).ok, false);
  r = await login.check("alice", PW);
  assert.equal(r.ok === false && r.locked, true); assert.equal(r.ok === false ? r.retryAfterSec : 0, 20, "the second lock doubles");
  clock.advance(20_001);
  for (let i = 0; i < 6; i++) { await login.check("alice", "wrong"); clock.advance(70_000); }
  assert.ok(login.lockedFor("alice") === 0);
  for (let i = 0; i < 3; i++) await login.check("ghost", "x");
  assert.equal(login.lockedFor("ghost"), 10, "an unknown name locks exactly like a real one");
});

test("a success clears the counter", async () => {
  const { login } = await setup({ maxFailures: 3 });
  await login.check("alice", "wrong"); await login.check("alice", "wrong");
  assert.equal((await login.check("alice", PW)).ok, true);
  await login.check("alice", "wrong"); await login.check("alice", "wrong");
  assert.equal((await login.check("alice", PW)).ok, true, "two fresh failures do not lock");
});

test("a hash made with older parameters is replaced by one with the current parameters after a good login", async () => {
  const users = new MemoryUserDirectory();
  users.add({ id: "u1", username: "old", role: "member", passwordHash: await hashPassword(PW, { ...ARGON2_PARAMS, memoryKiB: 8192 }) });
  const login = new PasswordLogin({ users, clock: new FakeClock() });
  const r = await login.check("old", PW);
  assert.equal(r.ok && r.rehashed, true);
  const now = (await users.findById("u1"))!;
  assert.equal(needsRehash(now.passwordHash!), false);
  assert.equal(await verifyPassword(now.passwordHash!, PW), true);
  assert.equal(now.version, 2);
});

test("remembered names are bounded", async () => {
  const { users, clock } = await setup();
  const login = new PasswordLogin({ users, clock, policy: { maxKeys: 5, maxFailures: 100 } });
  for (let i = 0; i < 40; i++) await login.check(`n${i}`, "x");
  assert.equal(login.trackedNames, 5);
});
