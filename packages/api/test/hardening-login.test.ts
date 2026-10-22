// Step 2 of the server hardening sweep: password login, lockout, Argon2id parameters, TOTP edge cases, the login challenge.
// Already pinned elsewhere (not repeated): identical failure shape and one verification for unknown names (login.test.ts),
// exponential lock and reset after success (login.test.ts), rehash after a good login (login.test.ts), the ±1 window and
// replay at the function level (totp.test.ts), the per-user totp bucket and five-code challenge (totp-api.test.ts).
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { LoginChallenges } from "../src/challenge.ts";
import { FakeClock } from "../src/clock.ts";
import { PasswordLogin } from "../src/login.ts";
import { MemoryUserDirectory } from "../src/memory-stores.ts";
import { ARGON2_PARAMS, hashPassword, MAX_PASSWORD_BYTES, parsePhc, verifyPassword } from "../src/password.ts";
import { base32Encode, totpCodeAt, verifyTotp } from "../src/totp.ts";
import { addUser, csrfToken, FIXTURE_PASSWORD, jsonHeaders, loginAs, raw, start, write, type Harness } from "./helpers.ts";

const docs = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../docs");
const wide = { auth: { capacity: 100_000, refillPerSec: 10_000 }, read: { capacity: 100_000, refillPerSec: 10_000 }, write: { capacity: 100_000, refillPerSec: 10_000 }, totp: { capacity: 100_000, refillPerSec: 10_000 }, stream: { capacity: 100_000, refillPerSec: 10_000 } };

/** mulberry32, the generator the kill-soak system test uses: a fixed seed makes every failure replayable. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
const secretFrom = (rand: () => number): string => base32Encode(Buffer.from(Array.from({ length: 20 }, () => Math.floor(rand() * 256))));

// ---- passwords -----------------------------------------------------------------------------------------------------

test("the Argon2id parameters are at least the documented ones, and docs/api.md states the same numbers", async () => {
  assert.ok(ARGON2_PARAMS.memoryKiB >= 19_456 && ARGON2_PARAMS.passes >= 2 && ARGON2_PARAMS.parallelism >= 1, JSON.stringify(ARGON2_PARAMS));
  const stored = parsePhc(await hashPassword("redact-probe-alpha"))!;
  assert.equal(stored.salt.length, 16); assert.equal(stored.tag.length, 32);
  assert.deepEqual([stored.memoryKiB, stored.passes, stored.parallelism], [ARGON2_PARAMS.memoryKiB, ARGON2_PARAMS.passes, ARGON2_PARAMS.parallelism]);
  const md = readFileSync(path.join(docs, "api.md"), "utf8");
  assert.ok(md.includes(`m=${ARGON2_PARAMS.memoryKiB},t=${ARGON2_PARAMS.passes},p=${ARGON2_PARAMS.parallelism}`), "docs/api.md names the live PHC parameters");
});

test("a 1 MB password is refused at hashing and at verification, and costs no Argon2id work", async () => {
  const stored = await hashPassword("redact-probe-alpha"); const huge = "x".repeat(1_048_576);
  await assert.rejects(hashPassword(huge), /too long/);
  await assert.rejects(hashPassword("y".repeat(MAX_PASSWORD_BYTES + 1)), /too long/);
  assert.equal(await verifyPassword(stored, "y".repeat(MAX_PASSWORD_BYTES + 1)), false);
  const before = process.cpuUsage();
  for (let i = 0; i < 10; i++) assert.equal(await verifyPassword(stored, huge), false);
  const used = process.cpuUsage(before); const ms = (used.user + used.system) / 1000;
  // One verification at 19 MiB and 2 passes costs tens of milliseconds of CPU; ten refused ones must cost a small fraction of one.
  assert.ok(ms < 150, `10 refused 1 MB verifications used ${ms} ms of CPU`);
});

test("over HTTP: a 1 MB password never reaches the hasher (413 or a cut connection), and a 60 KB one is the plain invalid-credentials answer at no Argon2id cost", async () => {
  const h = await start({ rateClasses: wide, lockout: { maxFailures: 100 } }); await addUser(h, { id: "u-alice", username: "alice", role: "member" });
  try {
    const post = (password: string) => raw(h, { method: "POST", path: "/api/v1/session", headers: jsonHeaders(), body: JSON.stringify({ username: "alice", password }) });
    const wrong = await post("not-the-password");
    let status = 0; try { status = (await post("x".repeat(1_048_576))).status; } catch { status = 413; /* the server cut the upload off: also no hashing */ }
    assert.equal(status, 413);
    assert.equal(h.audit.events.filter((e) => e.action === "auth.login.failure").length, 1, "only the first, small attempt reached the login check");
    const before = process.cpuUsage();
    const big = []; for (let i = 0; i < 5; i++) big.push(await post("z".repeat(60_000)));
    const used = process.cpuUsage(before); const ms = (used.user + used.system) / 1000;
    for (const r of big) { assert.equal(r.status, 401); assert.equal(r.text, wrong.text, "the same body as an ordinary wrong password"); }
    assert.ok(ms < 400, `five 60 KB attempts used ${ms} ms of CPU (an Argon2id each would be several times that)`);
  } finally { await h.close(); }
});

test("a hash made with stronger parameters than the current ones is kept at the next login, not replaced by the weaker current ones", async () => {
  const users = new MemoryUserDirectory(); const clock = new FakeClock();
  const strong = { memoryKiB: 65_536, passes: 3, parallelism: 1 };
  users.add({ id: "u-s", username: "strong", role: "member", passwordHash: await hashPassword(FIXTURE_PASSWORD, strong) });
  const r = await new PasswordLogin({ users, clock }).check("strong", FIXTURE_PASSWORD); assert.equal(r.ok, true);
  const after = parsePhc((await users.findByUsername("strong"))!.passwordHash)!;
  assert.deepEqual([after.memoryKiB, after.passes], [strong.memoryKiB, strong.passes], "the stronger cost was kept");
});

test("a hash that is stronger in one parameter and weaker in another is rehashed to the per-parameter maximum: nothing is lowered, the weak one is raised", async () => {
  const users = new MemoryUserDirectory(); const clock = new FakeClock();
  const mixed = { memoryKiB: 65_536, passes: 1, parallelism: 1 };
  users.add({ id: "u-m", username: "mixed", role: "member", passwordHash: await hashPassword(FIXTURE_PASSWORD, mixed) });
  const r = await new PasswordLogin({ users, clock }).check("mixed", FIXTURE_PASSWORD); assert.equal(r.ok && r.rehashed, true);
  const after = parsePhc((await users.findByUsername("mixed"))!.passwordHash)!;
  assert.deepEqual([after.memoryKiB, after.passes, after.parallelism], [65_536, ARGON2_PARAMS.passes, 1]);
  assert.equal(await verifyPassword((await users.findByUsername("mixed"))!.passwordHash!, FIXTURE_PASSWORD), true);
});

test("a stronger hash is not rewritten at all: the stored record and its version stay as they were", async () => {
  const users = new MemoryUserDirectory(); const clock = new FakeClock();
  const hash = await hashPassword(FIXTURE_PASSWORD, { memoryKiB: 65_536, passes: 3, parallelism: 1 });
  users.add({ id: "u-s2", username: "strong2", role: "member", passwordHash: hash });
  const before = (await users.findById("u-s2"))!;
  const r = await new PasswordLogin({ users, clock }).check("strong2", FIXTURE_PASSWORD); assert.equal(r.ok && r.rehashed, false);
  const after = (await users.findById("u-s2"))!; assert.equal(after.passwordHash, hash); assert.equal(after.version, before.version);
});

// ---- lockout -------------------------------------------------------------------------------------------------------

async function directory(): Promise<{ users: MemoryUserDirectory; clock: FakeClock; hash: string }> {
  const users = new MemoryUserDirectory(); const clock = new FakeClock(); const hash = await hashPassword(FIXTURE_PASSWORD);
  users.add({ id: "u-jose", username: "José", role: "member", passwordHash: hash });
  return { users, clock, hash };
}

test("the lock follows the normalised name: case, whitespace and Unicode composition variants share one counter", async () => {
  const { users, clock } = await directory(); const login = new PasswordLogin({ users, clock });
  const variants = ["josé", "JOSÉ", "  José ", "josé", "JOSÉ", "\tjosé\n"];
  for (const v of variants.slice(0, 5)) assert.deepEqual(await login.check(v, "wrong-1"), { ok: false, locked: false });
  for (const v of variants) { const r = await login.check(v, FIXTURE_PASSWORD); assert.equal(r.ok, false, JSON.stringify(v)); assert.equal(r.ok === false && r.locked, true, JSON.stringify(v)); }
  assert.equal(login.trackedNames, 1, "one remembered name, not six");
  assert.deepEqual(await login.check("jose", "wrong-1"), { ok: false, locked: false }, "a different name is a different counter");
});

test("a burst of parallel wrong guesses on one name reaches the hasher at most maxFailures times (the lock cannot be outrun by concurrency)", async () => {
  const { users, clock, hash } = await directory(); let reached = 0;
  const verify: typeof verifyPassword = async (h, p) => { reached += 1; await new Promise((r) => setTimeout(r, 5)); return verifyPassword(h, p); };
  const login = new PasswordLogin({ users, clock, verify, policy: { maxFailures: 3 } });
  const results = await Promise.all(Array.from({ length: 12 }, (_, i) => login.check("josé", `wrong-${i}`)));
  assert.ok(reached <= 3, `${reached} guesses were checked although the lock is after 3 (hash ${hash.slice(0, 12)}…)`);
  assert.equal(results.filter((r) => !r.ok && r.locked).length, 12 - reached, "the rest were refused as locked");
  assert.equal(results.some((r) => r.ok), false);
});

test("parallel attempts with the right password on one name all stay correct (serialising per name must not lose a success)", async () => {
  const { users, clock } = await directory(); const login = new PasswordLogin({ users, clock });
  const results = await Promise.all([login.check("josé", FIXTURE_PASSWORD), login.check("josé", FIXTURE_PASSWORD), login.check("josé", "wrong")]);
  assert.deepEqual(results.map((r) => r.ok), [true, true, false]);
  assert.equal(login.lockedFor("josé"), 0);
  // Hold all verifications until every distinct name reaches the verifier. A global queue would deadlock here.
  let entered = 0, allEntered!: () => void, release!: () => void;
  const started = new Promise<void>(resolve => { allEntered = resolve; });
  const gate = new Promise<void>(resolve => { release = resolve; });
  const slow = new PasswordLogin({ users, clock, verify: async () => {
    if (++entered === 3) allEntered();
    await gate;
    return false;
  } });
  const checks = [slow.check("josé", "wrong"), slow.check("nobody", "wrong"), slow.check("other", "wrong")];
  try { await started; assert.equal(entered, 3); }
  finally { release(); }
  assert.deepEqual((await Promise.all(checks)).map(result => result.ok), [false, false, false]);
});

// ---- TOTP ----------------------------------------------------------------------------------------------------------

test("TOTP codes keep their leading zeros: generated over many seeded secrets and steps, a code is accepted as text and never as a stripped number", () => {
  const SEED = 0x70D0; const rand = mulberry32(SEED); let zeros = 0;
  for (let i = 0; i < 400; i++) {
    const secret = secretFrom(rand); const now = 1_700_000_000_000 + Math.floor(rand() * 1e9) * 1000;
    const code = totpCodeAt(secret, now); assert.match(code, /^\d{6}$/, `seed ${SEED} case ${i}`);
    assert.equal(verifyTotp(secret, code, now).ok, true, `seed ${SEED} case ${i}: ${code}`);
    if (code.startsWith("0")) {
      zeros++; const stripped = String(Number(code));
      assert.equal(verifyTotp(secret, stripped, now).ok, false, `seed ${SEED} case ${i}: ${stripped} is ${code} without its zero`);
      assert.equal(verifyTotp(secret, Number(code), now).ok, false, `seed ${SEED} case ${i}: a number is not a code`);
    }
  }
  assert.ok(zeros >= 10, `seed ${SEED} produced only ${zeros} codes with a leading zero; the property was not exercised`);
});

test("wrong length, non-digits and look-alike digits are refused, never coerced", () => {
  const secret = secretFrom(mulberry32(7)); const now = 1_700_000_000_000; const good = totpCodeAt(secret, now);
  const bad = [
    good.slice(0, 5), `${good}0`, `${good}${good}`, "", " ", "000000".slice(1), `${good.slice(0, 5)}a`, `a${good.slice(1)}`, `+${good.slice(1)}`, `-${good.slice(1)}`, `0x${good.slice(2)}`, `${good}e0`,
    good.replace(/\d/g, (d) => String.fromCharCode(0xFF10 + Number(d))), // full-width digits
    good.replace(/\d/g, (d) => String.fromCharCode(0x0660 + Number(d))), // Arabic-Indic digits
    `${good}\u0000`, `${good}​`, `​${good}`, `${good.slice(0, 3)}​${good.slice(3)}`, "9".repeat(1_000_000),
  ];
  for (const b of bad) assert.equal(verifyTotp(secret, b, now).ok, false, JSON.stringify(b.slice(0, 20)));
  for (const b of [null, undefined, 123456, 123456n, {}, [good], [], true, Symbol.iterator]) assert.equal(verifyTotp(secret, b, now).ok, false, String(typeof b));
  // The space an authenticator app prints between the halves is forgiven, as documented; a tab or newline around it too.
  assert.equal(verifyTotp(secret, `${good.slice(0, 3)} ${good.slice(3)}`, now).ok, true); assert.equal(verifyTotp(secret, `\t${good}\n`, now).ok, true);
});

test("the ±1 step window is exact at the edges of a step, on the injected clock", () => {
  const secret = secretFrom(mulberry32(11)); const step = 30_000; const t0 = Math.floor(1_700_000_000_000 / step) * step; // a step boundary
  const codeOfStep = (n: number) => totpCodeAt(secret, t0 + n * step);
  for (const [nowOffset, accepts] of [[0, [-1, 0, 1]], [step - 1, [-1, 0, 1]], [step, [0, 1, 2]], [-1, [-2, -1, 0]]] as const) {
    for (let n = -3; n <= 3; n++) {
      const want = (accepts as readonly number[]).includes(n);
      assert.equal(verifyTotp(secret, codeOfStep(n), t0 + nowOffset).ok, want, `now = step 0 ${nowOffset >= 0 ? "+" : ""}${nowOffset} ms, code of step ${n}`);
    }
  }
});

test("over HTTP: a code one step ahead is accepted (clock skew), two steps ahead and the enrolment step are not", async () => {
  const h = await start({ rateClasses: wide }); await addUser(h, { id: "u-mia", username: "mia", role: "member" });
  try {
    const { cookie } = await loginAs(h, "mia");
    const s = await write(h, cookie, { path: "/api/v1/me/totp/setup" });
    const enrolStep = h.clock.now(); await write(h, cookie, { path: "/api/v1/me/totp/confirm", body: { code: totpCodeAt(s.json.secret, enrolStep) } });
    h.clock.advance(30_000);
    const attempt = async (ms: number) => { const p = await raw(h, { method: "POST", path: "/api/v1/session", headers: jsonHeaders(), body: JSON.stringify({ username: "mia", password: FIXTURE_PASSWORD }) }); return raw(h, { method: "POST", path: "/api/v1/session/totp", headers: jsonHeaders(), body: JSON.stringify({ challenge: p.json.challenge, code: totpCodeAt(s.json.secret, ms) }) }); };
    assert.equal((await attempt(enrolStep)).status, 401, "the step that confirmed enrolment is spent");
    assert.equal((await attempt(h.clock.now() + 60_000)).status, 401, "two steps ahead is outside the window");
    assert.equal((await attempt(h.clock.now() + 30_000)).status, 200, "one step ahead is inside it");
    for (const code of ["12345", "1234567", "abcdef", "１２３４５６", "x".repeat(33)]) {
      const p = await raw(h, { method: "POST", path: "/api/v1/session", headers: jsonHeaders(), body: JSON.stringify({ username: "mia", password: FIXTURE_PASSWORD }) });
      const r = await raw(h, { method: "POST", path: "/api/v1/session/totp", headers: jsonHeaders(), body: JSON.stringify({ challenge: p.json.challenge, code }) });
      assert.ok(r.status === 401 || r.status === 400, `${code.slice(0, 8)}: ${r.status}`);
    }
  } finally { await h.close(); }
});

// ---- challenge -----------------------------------------------------------------------------------------------------

async function enrolled(h: Harness, username: string, id: string) {
  await addUser(h, { id, username, role: "member" });
  const { cookie } = await loginAs(h, username);
  const s = await write(h, cookie, { path: "/api/v1/me/totp/setup" });
  const c = await write(h, cookie, { path: "/api/v1/me/totp/confirm", body: { code: totpCodeAt(s.json.secret, h.clock.now()) } });
  assert.equal(c.status, 200, c.text);
  await raw(h, { method: "DELETE", path: "/api/v1/session", headers: { cookie, "x-csrf-token": await csrfToken(h, cookie) } });
  return s.json.secret as string;
}
const challengeFor = async (h: Harness, username: string) => (await raw(h, { method: "POST", path: "/api/v1/session", headers: jsonHeaders(), body: JSON.stringify({ username, password: FIXTURE_PASSWORD }) })).json.challenge as string;
const submit = (h: Harness, challenge: string, code: string) => raw(h, { method: "POST", path: "/api/v1/session/totp", headers: jsonHeaders(), body: JSON.stringify({ challenge, code }) });

test("a challenge belongs to the user who passed the password: another person's valid code does not complete it", async () => {
  const h = await start({ rateClasses: wide });
  try {
    const mia = await enrolled(h, "mia", "u-mia"); const vera = await enrolled(h, "vera", "u-vera"); h.clock.advance(30_000);
    const c = await challengeFor(h, "mia");
    const r = await submit(h, c, totpCodeAt(vera, h.clock.now()));
    assert.equal(r.status, 401); assert.equal(r.headers["set-cookie"], undefined);
    assert.equal((await submit(h, c, totpCodeAt(mia, h.clock.now()))).status, 200, "the owner of the challenge can still finish it (a wrong code costs one of five tries)");
  } finally { await h.close(); }
});

test("every way a second step can fail answers with the same bytes: unknown, expired, spent, wrong code, someone else's challenge", async () => {
  const h = await start({ rateClasses: wide });
  try {
    const mia = await enrolled(h, "mia", "u-mia"); h.clock.advance(30_000);
    const unknown = await submit(h, "nope", "000000");
    const wrong = await submit(h, await challengeFor(h, "mia"), "000000");
    const expiredId = await challengeFor(h, "mia"); h.clock.advance(5 * 60_000 + 1);
    const expired = await submit(h, expiredId, totpCodeAt(mia, h.clock.now()));
    const spentId = await challengeFor(h, "mia"); const ok = await submit(h, spentId, totpCodeAt(mia, h.clock.now())); assert.equal(ok.status, 200);
    const spent = await submit(h, spentId, totpCodeAt(mia, h.clock.now() + 30_000));
    for (const [label, r] of [["unknown", unknown], ["wrong", wrong], ["expired", expired], ["spent", spent]] as const) { assert.equal(r.status, 401, label); assert.equal(r.text, unknown.text, label); assert.equal(r.headers["set-cookie"], undefined, label); }
  } finally { await h.close(); }
});

/** A directory whose lookups take a moment, so two requests are both past the challenge check before either has finished. */
class SlowUsers extends MemoryUserDirectory {
  override async findById(id: string) { await new Promise((r) => setTimeout(r, 25)); return super.findById(id); }
}

test("a challenge is single use even when two different valid codes arrive at once (one session, not two)", async () => {
  const h = await start({ rateClasses: wide, users: new SlowUsers() });
  try {
    const mia = await enrolled(h, "mia", "u-mia"); h.clock.advance(30_000);
    const c = await challengeFor(h, "mia"); const now = h.clock.now();
    // Two distinct codes inside the ±1 window (steps 0 and +1 relative to now), the older one first: the replay guard alone lets both through.
    const both = await Promise.all([submit(h, c, totpCodeAt(mia, now)), submit(h, c, totpCodeAt(mia, now + 30_000))]);
    const sessions = both.filter((r) => r.status === 200).length;
    assert.equal(sessions, 1, `${sessions} sessions were issued from one challenge: ${both.map((r) => r.status).join(",")}`);
  } finally { await h.close(); }
});

test("LoginChallenges: ids are 256-bit, distinct, never stored in the clear, and an oversized or non-string id is simply unknown", () => {
  const clock = new FakeClock(); const c = new LoginChallenges(clock);
  const ids = new Set(Array.from({ length: 50 }, () => c.create("u", 1).id));
  assert.equal(ids.size, 50);
  for (const id of ids) assert.match(id, /^[A-Za-z0-9_-]{43}$/);
  for (const bad of [undefined, null, 5, {}, [], "", "x".repeat(101), "x".repeat(100_000)]) assert.equal(c.get(bad), undefined);
});
