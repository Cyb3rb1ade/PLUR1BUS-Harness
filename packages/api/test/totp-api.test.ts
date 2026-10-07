import assert from "node:assert/strict";
import test from "node:test";
import { LoginChallenges } from "../src/challenge.ts";
import { FakeClock } from "../src/clock.ts";
import { totpCodeAt } from "../src/totp.ts";
import { addUser, csrfToken, FIXTURE_PASSWORD, jsonHeaders, login, loginAs, raw, start, write, type Harness } from "./helpers.ts";

const wide = { auth: { capacity: 1000, refillPerSec: 100 }, read: { capacity: 1000, refillPerSec: 100 }, write: { capacity: 1000, refillPerSec: 100 }, totp: { capacity: 1000, refillPerSec: 100 } };
const setup = async (o: Parameters<typeof start>[0] = {}) => {
  const h = await start({ rateClasses: wide, ...o });
  await addUser(h, { id: "u-mia", username: "mia", role: "member" });
  await addUser(h, { id: "u-vera", username: "vera", role: "viewer" });
  return h;
};
/** Enrols mia and returns what an authenticator app would hold. The confirming code's step is spent, so time moves on one step. */
async function enrol(h: Harness, username = "mia") {
  const { cookie } = await loginAs(h, username);
  const s = await write(h, cookie, { path: "/api/v1/me/totp/setup" });
  assert.equal(s.status, 200, s.text);
  const c = await write(h, cookie, { path: "/api/v1/me/totp/confirm", body: { code: totpCodeAt(s.json.secret, h.clock.now()) } });
  assert.equal(c.status, 200, c.text);
  h.clock.advance(30_000);
  return { cookie, secret: s.json.secret as string, backup: c.json.backupCodes as string[] };
}
const pwLogin = (h: Harness, username = "mia", cookie?: string) => raw(h, { method: "POST", path: "/api/v1/session", headers: { ...jsonHeaders(), ...(cookie ? { cookie } : {}) }, body: JSON.stringify({ username, password: FIXTURE_PASSWORD }) });
const second = (h: Harness, challenge: string, code: string, cookie?: string) => raw(h, { method: "POST", path: "/api/v1/session/totp", headers: { ...jsonHeaders(), ...(cookie ? { cookie } : {}) }, body: JSON.stringify({ challenge, code }) });

test("setup gives a secret and an otpauth URI; confirm with a wrong code changes nothing; a right one turns it on and hands out ten backup codes once", async () => {
  const h = await setup();
  try {
    const { cookie } = await loginAs(h, "mia");
    assert.deepEqual((await raw(h, { path: "/api/v1/me/totp", headers: { cookie } })).json, { schema: "totp.status/1", enabled: false, backupCodesRemaining: 0 });
    const s = await write(h, cookie, { path: "/api/v1/me/totp/setup" });
    assert.match(s.json.secret, /^[A-Z2-7]{32}$/); assert.match(s.json.otpauthUri, /^otpauth:\/\/totp\/PLUR1BUS%20Harness:mia\?/);
    const wrong = await write(h, cookie, { path: "/api/v1/me/totp/confirm", body: { code: "000000" } });
    assert.deepEqual([wrong.status, wrong.json.reason], [403, "invalid-code"]);
    assert.equal((await raw(h, { path: "/api/v1/me/totp", headers: { cookie } })).json.enabled, false);
    const ok = await write(h, cookie, { path: "/api/v1/me/totp/confirm", body: { code: totpCodeAt(s.json.secret, h.clock.now()) } });
    assert.equal(ok.status, 200); assert.equal(ok.json.backupCodes.length, 10); assert.equal(ok.json.enabled, true);
    const st = await raw(h, { path: "/api/v1/me/totp", headers: { cookie } });
    assert.deepEqual(st.json, { schema: "totp.status/1", enabled: true, backupCodesRemaining: 10 });
    assert.ok(!st.text.includes(s.json.secret) && !st.text.includes(ok.json.backupCodes[0]), "status shows neither secret nor codes");
    assert.equal((await write(h, cookie, { path: "/api/v1/me/totp/setup" })).json.reason, "totp-enabled");
  } finally { await h.close(); }
});

test("with a second factor on, a right password gives a challenge and no cookie; a right code then gives the session", async () => {
  const h = await setup();
  try {
    const { secret } = await enrol(h);
    const p = await pwLogin(h);
    assert.equal(p.status, 200); assert.equal(p.json.schema, "session.challenge/1"); assert.equal(p.json.mfa, "totp");
    assert.equal(p.headers["set-cookie"], undefined); assert.equal(p.json.principal, undefined);
    assert.ok(Date.parse(p.json.expiresAt) > h.clock.now());
    const s = await second(h, p.json.challenge, totpCodeAt(secret, h.clock.now()));
    assert.equal(s.status, 200); assert.equal(s.json.schema, "session.create/1"); assert.deepEqual(s.json.principal, { kind: "user", id: "u-mia", role: "member" });
    const cookie = s.headers["set-cookie"]![0]!.split(";", 1)[0]!;
    assert.match(s.headers["set-cookie"]![0]!, /HttpOnly; SameSite=Strict/);
    assert.equal((await raw(h, { path: "/api/v1/whoami", headers: { cookie } })).json.principal.id, "u-mia");
    assert.equal((await second(h, p.json.challenge, totpCodeAt(secret, h.clock.now() + 30_000))).status, 401, "the challenge is single-use");
  } finally { await h.close(); }
});

test("a wrong password never reaches the second step, and looks exactly like it did without a second factor", async () => {
  const h = await setup();
  try {
    await enrol(h);
    const r = await raw(h, { method: "POST", path: "/api/v1/session", headers: jsonHeaders(), body: JSON.stringify({ username: "mia", password: "wrong" }) });
    assert.deepEqual([r.status, r.json.reason, r.json.schema], [401, "invalid-credentials", "error/1"]);
  } finally { await h.close(); }
});

test("a wrong code is 401 invalid-code and leaves no session; the code that confirmed enrolment cannot be replayed", async () => {
  const h = await setup();
  try {
    const { cookie } = await loginAs(h, "mia");
    const s = await write(h, cookie, { path: "/api/v1/me/totp/setup" });
    const used = totpCodeAt(s.json.secret, h.clock.now());
    await write(h, cookie, { path: "/api/v1/me/totp/confirm", body: { code: used } });
    const p = await pwLogin(h);
    const replay = await second(h, p.json.challenge, used);
    assert.deepEqual([replay.status, replay.json.reason], [401, "invalid-code"]); assert.equal(replay.headers["set-cookie"], undefined);
    h.clock.advance(30_000);
    assert.equal((await second(h, p.json.challenge, totpCodeAt(s.json.secret, h.clock.now()))).status, 200, "a fresh step works, the challenge is still alive");
  } finally { await h.close(); }
});

test("a challenge dies after five wrong codes (even for the right one) and after five minutes", async () => {
  const h = await setup();
  try {
    const { secret } = await enrol(h);
    const a = await pwLogin(h);
    for (let i = 0; i < 5; i++) assert.equal((await second(h, a.json.challenge, "000000")).status, 401);
    assert.equal((await second(h, a.json.challenge, totpCodeAt(secret, h.clock.now()))).status, 401, "five wrong codes ended it");
    const b = await pwLogin(h); h.clock.advance(5 * 60_000 + 1);
    assert.equal((await second(h, b.json.challenge, totpCodeAt(secret, h.clock.now()))).status, 401, "expired");
    for (const challenge of ["", "nope", "x".repeat(500)]) assert.equal((await second(h, challenge, "123456")).status, 401, challenge.slice(0, 5));
  } finally { await h.close(); }
});

test("a challenge ends when the user's record changes (password or role) before the code arrives", async () => {
  const h = await setup();
  try {
    const { secret } = await enrol(h);
    const p = await pwLogin(h);
    h.users.change("u-mia", { role: "viewer" });
    assert.equal((await second(h, p.json.challenge, totpCodeAt(secret, h.clock.now()))).status, 401);
  } finally { await h.close(); }
});

test("brute force is bounded per user, not per challenge: new challenges do not reset the totp bucket", async () => {
  const h = await setup({ rateClasses: { ...wide, totp: { capacity: 5, refillPerSec: 0.001 } } });
  try {
    await enrol(h);
    h.clock.advance(10_000_000); // enrolment spent some of the bucket; start full
    const seen: number[] = []; let last;
    for (let i = 0; i < 8; i++) { const p = await pwLogin(h); last = await second(h, p.json.challenge, "000000"); seen.push(last.status); }
    assert.deepEqual(seen.slice(0, 5), [401, 401, 401, 401, 401]); assert.ok(seen.slice(5).every((x) => x === 429), JSON.stringify(seen));
    assert.match(last!.headers["retry-after"] as string, /^\d+$/);
    assert.ok(h.audit.events.some((e) => e.action === "auth.rate-limited"));
  } finally { await h.close(); }
});

test("a backup code logs in once, then is gone; using it is audited with the count left", async () => {
  const h = await setup();
  try {
    const { backup } = await enrol(h);
    const p = await pwLogin(h);
    assert.equal((await second(h, p.json.challenge, backup[0]!)).status, 200);
    const p2 = await pwLogin(h);
    assert.equal((await second(h, p2.json.challenge, backup[0]!)).status, 401, "once");
    const ev = h.audit.events.find((e) => e.action === "auth.totp.backup-used")!;
    assert.deepEqual([ev.actor.user, ev.detail.remaining], ["u-mia", 9]);
    assert.ok(!JSON.stringify(h.audit.events).includes(backup[0]!.replace("-", "")));
  } finally { await h.close(); }
});

test("session fixation holds on the second step too: a cookie presented with the code is ended, not adopted", async () => {
  const h = await setup();
  try {
    const { secret } = await enrol(h);
    const other = await loginAs(h, "vera");
    const p = await pwLogin(h);
    const s = await second(h, p.json.challenge, totpCodeAt(secret, h.clock.now()), other.cookie);
    assert.equal(s.status, 200); assert.notEqual(s.headers["set-cookie"]![0]!.split(";", 1)[0], other.cookie);
    assert.equal((await raw(h, { path: "/api/v1/whoami", headers: { cookie: other.cookie } })).status, 401);
  } finally { await h.close(); }
});

test("disable needs a valid code; afterwards a password login is a plain session again", async () => {
  const h = await setup();
  try {
    const { cookie, backup } = await enrol(h);
    const bad = await write(h, cookie, { path: "/api/v1/me/totp/disable", body: { code: "000000" } });
    assert.deepEqual([bad.status, bad.json.reason], [403, "invalid-code"]);
    assert.equal((await raw(h, { path: "/api/v1/me/totp", headers: { cookie } })).json.enabled, true);
    const ok = await write(h, cookie, { path: "/api/v1/me/totp/disable", body: { code: backup[3]! } });
    assert.equal(ok.status, 200); assert.equal(ok.json.enabled, false);
    const p = await pwLogin(h); assert.equal(p.json.schema, "session.create/1"); assert.ok(p.headers["set-cookie"]);
    assert.deepEqual(h.audit.events.map((e) => e.action).filter((a) => a.startsWith("auth.totp")), ["auth.totp.enabled", "auth.totp.failure", "auth.totp.disabled"]);
  } finally { await h.close(); }
});

test("the TOTP routes need the CSRF token, a session (not a token), a user account (not the owner token) and a role that may write", async () => {
  const h = await setup();
  try {
    const { cookie } = await loginAs(h, "mia");
    assert.equal((await raw(h, { method: "POST", path: "/api/v1/me/totp/setup", headers: { cookie } })).status, 403, "no CSRF token");
    assert.equal((await raw(h, { method: "POST", path: "/api/v1/me/totp/setup", headers: { authorization: "Bearer plb_000000000000_" + "A".repeat(43) } })).status, 401);
    const v = await loginAs(h, "vera");
    assert.equal((await write(h, v.cookie, { path: "/api/v1/me/totp/setup" })).status, 403, "a viewer has no writes, not even on their own account");
    const o = await login(h);
    const r = await write(h, o.cookie, { path: "/api/v1/me/totp/setup" });
    assert.deepEqual([r.status, r.json.reason], [409, "no-account"]);
    assert.equal((await write(h, cookie, { path: "/api/v1/me/totp/confirm", body: { code: 123456 } })).json.reason, "body");
    assert.equal((await write(h, cookie, { path: "/api/v1/me/totp/confirm", body: { code: "123456", x: 1 } })).json.reason, "body");
    assert.equal((await write(h, cookie, { path: "/api/v1/me/totp/confirm", body: { code: "123456" } })).json.reason, "invalid-code", "no setup pending: the same answer as a wrong code");
  } finally { await h.close(); }
});

test("neither the secret, a code nor a backup code ever reaches the audit or the log", async () => {
  const h = await setup();
  try {
    const { cookie } = await loginAs(h, "mia");
    const s = await write(h, cookie, { path: "/api/v1/me/totp/setup" });
    const code = totpCodeAt(s.json.secret, h.clock.now());
    const c = await write(h, cookie, { path: "/api/v1/me/totp/confirm", body: { code } });
    h.clock.advance(30_000);
    const p = await pwLogin(h); await second(h, p.json.challenge, "000000");
    await second(h, p.json.challenge, totpCodeAt(s.json.secret, h.clock.now()));
    const text = JSON.stringify(h.audit.events) + h.logs.join("\n");
    for (const secret of [s.json.secret, code, p.json.challenge, ...c.json.backupCodes.map((b: string) => b.replace("-", ""))]) assert.ok(!text.includes(secret), `no ${String(secret).slice(0, 6)}… in audit or log`);
    const acts = h.audit.events.map((e) => e.action);
    for (const a of ["auth.totp.enabled", "auth.totp.failure", "auth.login.success"]) assert.ok(acts.includes(a), a);
  } finally { await h.close(); }
});

test("LoginChallenges: single use, bounded count, wrong codes end it, expiry on the injected clock", () => {
  const clock = new FakeClock(); const ch = new LoginChallenges(clock, { ttlMs: 1000, maxAttempts: 2, maxChallenges: 2 });
  const a = ch.create("u1", 1); assert.deepEqual(ch.get(a.id), { userId: "u1", version: 1 });
  assert.equal(ch.consume(a.id), true); assert.equal(ch.consume(a.id), false); assert.equal(ch.get(a.id), undefined);
  const b = ch.create("u1", 1); ch.fail(b.id); assert.ok(ch.get(b.id)); ch.fail(b.id); assert.equal(ch.get(b.id), undefined);
  const c = ch.create("u1", 1); ch.create("u2", 1); const d = ch.create("u3", 1);
  assert.equal(ch.get(c.id), undefined, "the oldest goes at the cap"); assert.ok(ch.get(d.id));
  clock.advance(1001); assert.equal(ch.get(d.id), undefined);
  for (const bad of [undefined, 5, "", "x".repeat(101)]) assert.equal(ch.get(bad), undefined);
});
