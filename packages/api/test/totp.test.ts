import assert from "node:assert/strict";
import test from "node:test";
import { FakeClock } from "../src/clock.ts";
import { MemoryTotpStore } from "../src/memory-stores.ts";
import { base32Decode, base32Encode, generateSecret, hotp, otpauthUri, TotpService, totpCodeAt, verifyTotp } from "../src/totp.ts";

// RFC 4226 appendix D and RFC 6238 appendix B (SHA-1) vectors: public test data, not credentials.
const RFC_SECRET = Buffer.from("12345678901234567890", "ascii");

test("HOTP matches the RFC 4226 test vectors", () => {
  const want = ["755224", "287082", "359152", "969429", "338314", "254676", "287922", "162583", "399871", "520489"];
  want.forEach((code, counter) => assert.equal(hotp(RFC_SECRET, counter, 6), code, `counter ${counter}`));
});

test("TOTP matches the RFC 6238 SHA-1 vectors (6-digit tails of the 8-digit values)", () => {
  const cases: Array<[number, string]> = [[59, "287082"], [1111111109, "081804"], [1111111111, "050471"], [1234567890, "005924"], [2000000000, "279037"], [20000000000, "353130"]];
  const secret = base32Encode(RFC_SECRET);
  for (const [t, code] of cases) assert.equal(totpCodeAt(secret, t * 1000), code, `T=${t}`);
});

test("base32 round-trips and refuses characters outside the alphabet", () => {
  for (const n of [1, 5, 10, 20, 32]) { const b = Buffer.from(Array.from({ length: n }, (_, i) => (i * 37 + 11) % 256)); assert.deepEqual(base32Decode(base32Encode(b)), b); }
  assert.equal(base32Encode(Buffer.from("foobar")), "MZXW6YTBOI");
  assert.equal(base32Decode(""), undefined, "an empty secret is never valid");
  assert.deepEqual(base32Decode("mzxw 6ytb oi"), Buffer.from("foobar"), "case and spaces are forgiven");
  for (const bad of ["MZXW6YTB0I", "MZXW6YT!OI", "1"]) assert.equal(base32Decode(bad), undefined, bad);
});

test("a fresh secret is 160 bits, 32 base32 characters, never the same twice", () => {
  const a = generateSecret(); const b = generateSecret();
  assert.match(a, /^[A-Z2-7]{32}$/); assert.notEqual(a, b); assert.equal(base32Decode(a)!.length, 20);
});

test("otpauth URI carries issuer, account, secret and the parameters an authenticator app needs, URI-encoded", () => {
  const u = new URL(otpauthUri({ issuer: "PLUR1BUS Harness", account: "mia@example.org", secret: "JBSWY3DPEHPK3PXP" }));
  assert.equal(u.protocol, "otpauth:"); assert.equal(u.host, "totp");
  assert.equal(decodeURIComponent(u.pathname), "/PLUR1BUS Harness:mia@example.org");
  assert.deepEqual(Object.fromEntries(u.searchParams), { secret: "JBSWY3DPEHPK3PXP", issuer: "PLUR1BUS Harness", algorithm: "SHA1", digits: "6", period: "30" });
  assert.ok(!otpauthUri({ issuer: "a:b&c", account: "x y", secret: "AAAA" }).includes(" "));
});

test("verifyTotp accepts the current step and one either side, nothing further, and only exactly six digits", () => {
  const secret = base32Encode(RFC_SECRET); const now = 1_700_000_000_000;
  const at = (offsetSteps: number) => totpCodeAt(secret, now + offsetSteps * 30_000);
  for (const o of [-1, 0, 1]) assert.equal(verifyTotp(secret, at(o), now).ok, true, `offset ${o}`);
  for (const o of [-2, 2, 5]) assert.equal(verifyTotp(secret, at(o), now).ok, false, `offset ${o}`);
  for (const bad of ["", "12345", "1234567", "abcdef", undefined, 123456, null]) assert.equal(verifyTotp(secret, bad, now).ok, false, String(bad));
  assert.equal(verifyTotp(secret, ` ${at(0).slice(0, 3)} ${at(0).slice(3)} `, now).ok, true, "the space an app prints is forgiven");
  assert.equal(verifyTotp("not base32!", at(0), now).ok, false);
});

test("replay: a code from a step at or before the last accepted one is refused; a later step is fine", () => {
  const secret = base32Encode(RFC_SECRET); const now = 1_700_000_000_000;
  const first = verifyTotp(secret, totpCodeAt(secret, now), now); assert.equal(first.ok, true);
  const step = first.ok ? first.step : -1;
  assert.equal(verifyTotp(secret, totpCodeAt(secret, now), now, step).ok, false, "the same code twice");
  assert.equal(verifyTotp(secret, totpCodeAt(secret, now - 30_000), now, step).ok, false, "an older step after a newer one");
  assert.equal(verifyTotp(secret, totpCodeAt(secret, now + 30_000), now, step).ok, true);
});

const setup = () => { const clock = new FakeClock(1_700_000_000_000); const store = new MemoryTotpStore(); return { clock, store, svc: new TotpService({ store, clock, issuer: "PLUR1BUS Harness" }) }; };

test("enrolment: begin gives a secret and URI, nothing is on until a right code confirms; confirm hands out ten backup codes once", async () => {
  const { svc, clock, store } = setup();
  assert.equal(await svc.isEnabled("u1"), false);
  const b = await svc.begin("u1", "mia"); assert.match(b.secret, /^[A-Z2-7]{32}$/); assert.match(b.otpauthUri, /^otpauth:\/\/totp\//);
  assert.equal(await svc.isEnabled("u1"), false, "pending is not enabled");
  assert.equal((await svc.confirm("u1", "000000")).ok, false);
  assert.equal(await svc.isEnabled("u1"), false);
  const c = await svc.confirm("u1", totpCodeAt(b.secret, clock.now()));
  assert.equal(c.ok, true); if (!c.ok) return;
  assert.equal(c.backupCodes.length, 10); assert.equal(new Set(c.backupCodes).size, 10);
  for (const code of c.backupCodes) assert.match(code, /^[a-z2-9]{5}-[a-z2-9]{5}$/);
  assert.equal(await svc.isEnabled("u1"), true);
  assert.ok(!store.dump().includes(c.backupCodes[0]!.replace("-", "")), "backup codes are stored as hashes only");
  assert.equal((await svc.status("u1")).backupCodesRemaining, 10);
  await assert.rejects(svc.begin("u1", "mia"), (e: { reason?: string }) => e.reason === "totp-enabled", "no silent replacement of a live second factor");
});

test("the confirming code counts as used: it cannot be replayed to log in right after", async () => {
  const { svc, clock } = setup();
  const b = await svc.begin("u1", "mia"); const code = totpCodeAt(b.secret, clock.now());
  assert.equal((await svc.confirm("u1", code)).ok, true);
  assert.deepEqual(await svc.verify("u1", code), { ok: false });
  clock.advance(30_000);
  assert.deepEqual(await svc.verify("u1", totpCodeAt(b.secret, clock.now())), { ok: true, method: "totp" });
});

test("a backup code works once and is then gone; the remaining count falls; wrong codes change nothing", async () => {
  const { svc, clock } = setup();
  const b = await svc.begin("u1", "mia"); const c = await svc.confirm("u1", totpCodeAt(b.secret, clock.now()));
  const codes = c.ok ? c.backupCodes : [];
  assert.deepEqual(await svc.verify("u1", "aaaaa-aaaaa"), { ok: false });
  assert.deepEqual(await svc.verify("u1", codes[0]!.toUpperCase().replace("-", " ")), { ok: true, method: "backup" }, "case, space and hyphen are forgiven");
  assert.deepEqual(await svc.verify("u1", codes[0]!), { ok: false }, "once");
  assert.equal((await svc.status("u1")).backupCodesRemaining, 9);
  assert.deepEqual(await svc.verify("u2", codes[1]!), { ok: false }, "another user's code is nothing");
});

test("disable needs a valid code (TOTP or backup) and removes the factor entirely; verify then fails closed for that user", async () => {
  const { svc, clock } = setup();
  const b = await svc.begin("u1", "mia"); await svc.confirm("u1", totpCodeAt(b.secret, clock.now())); clock.advance(30_000);
  assert.equal(await svc.disable("u1", "000000"), false); assert.equal(await svc.isEnabled("u1"), true);
  assert.equal(await svc.disable("u1", totpCodeAt(b.secret, clock.now())), true);
  assert.equal(await svc.isEnabled("u1"), false);
  assert.deepEqual(await svc.verify("u1", totpCodeAt(b.secret, clock.now() + 30_000)), { ok: false });
  assert.equal(await svc.disable("u1", "000000"), false, "nothing to disable");
});
