// Step 4 of the server hardening sweep: rate limits, the audit queue and emitter, and redaction.
// Generative cases use mulberry32 with a fixed seed; the seed is part of every failure message, so a failure replays.
// Already pinned elsewhere (not repeated): bucket arithmetic and eviction (rate-limit.test.ts), forwarding headers giving
// no fresh bucket (redteam.test.ts Q12-7), spraying from one address (Q12-4), queue retry, order and bound by example
// (audit-queue.test.ts), tokens and cookies absent from the log (log-marker.test.ts).
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createAuditEmitter } from "../src/audit.ts";
import { createBufferedSink } from "../src/audit-queue.ts";
import { FakeClock } from "../src/clock.ts";
import { hashPassword } from "../src/password.ts";
import { RateLimiter } from "../src/rate-limit.ts";
import type { AuditEvent, AuditSink } from "../src/rbac-bridge.ts";
import { redactFields, REDACTED } from "../src/redact.ts";
import { totpCodeAt } from "../src/totp.ts";
import { csrfToken, jsonHeaders, login, loginAs, raw, start, write } from "./helpers.ts";

const here = path.dirname(fileURLToPath(import.meta.url)); const srcDir = path.join(here, "../src");
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
const wide = { auth: { capacity: 100_000, refillPerSec: 10_000 }, read: { capacity: 100_000, refillPerSec: 10_000 }, write: { capacity: 100_000, refillPerSec: 10_000 }, totp: { capacity: 100_000, refillPerSec: 10_000 }, stream: { capacity: 100_000, refillPerSec: 10_000 } };
const nop = { error() {} };
const flushTicks = () => new Promise<void>((r) => setTimeout(r, 15));

// ---- rate limits ---------------------------------------------------------------------------------------------------

test("Retry-After never lies: after waiting exactly the advertised seconds the next request passes (500 seeded bucket shapes)", () => {
  const SEED = 0x5EED01; const rand = mulberry32(SEED);
  for (let i = 0; i < 500; i++) {
    const capacity = 1 + Math.floor(rand() * 20);
    const refill = rand() < 0.5 ? 1 / (1 + Math.floor(rand() * 120)) : Math.round((0.01 + rand() * 40) * 1000) / 1000;
    const clock = new FakeClock(); const lim = new RateLimiter(clock, { auth: { capacity, refillPerSec: refill }, read: { capacity: 1, refillPerSec: 1 }, write: { capacity: 1, refillPerSec: 1 } });
    const where = `seed ${SEED} case ${i}: capacity ${capacity}, refill ${refill}/s`;
    for (let k = 0; k < capacity; k++) assert.equal(lim.take("auth", "k").ok, true, `${where}: take ${k}`);
    for (let round = 0; round < 3; round++) {
      let guard = 0; while (lim.take("auth", "k").ok && guard++ < 10_000) { /* drain what the last wait refilled */ }
      const v = lim.take("auth", "k"); assert.equal(v.ok, false, `${where}: drained`);
      if (v.ok) return;
      assert.ok(Number.isInteger(v.retryAfterSec) && v.retryAfterSec >= 1, `${where}: Retry-After ${v.retryAfterSec}`);
      assert.ok(v.retryAfterSec <= Math.max(1, Math.ceil(1 / refill)), `${where}: Retry-After ${v.retryAfterSec} s is more than one refilled token needs`);
      clock.advance(v.retryAfterSec * 1000); assert.equal(lim.take("auth", "k").ok, true, `${where}: round ${round}: the advertised wait was not enough`);
    }
  }
});

test("a bucket never lets through more than capacity + refill × elapsed, whatever the request pattern (300 seeded timelines)", () => {
  const SEED = 0x5EED02; const rand = mulberry32(SEED);
  for (let i = 0; i < 300; i++) {
    const capacity = 1 + Math.floor(rand() * 30); const refill = 0.05 + rand() * 20;
    const clock = new FakeClock(); const t0 = clock.now(); const lim = new RateLimiter(clock, { auth: { capacity, refillPerSec: refill }, read: { capacity: 1, refillPerSec: 1 }, write: { capacity: 1, refillPerSec: 1 } });
    let allowed = 0;
    for (let n = 0; n < 400; n++) { if (rand() < 0.6) clock.advance(Math.floor(rand() * 400)); if (lim.take("auth", "k").ok) allowed++; }
    const elapsedSec = (clock.now() - t0) / 1000; const ceiling = capacity + refill * elapsedSec + 1e-6;
    assert.ok(allowed <= ceiling, `seed ${SEED} case ${i}: ${allowed} allowed, ceiling ${ceiling} (capacity ${capacity}, refill ${refill}, ${elapsedSec}s)`);
    assert.ok(allowed >= Math.min(capacity, 1), `seed ${SEED} case ${i}: a fresh bucket must allow at least one`);
  }
});

test("a bucket idle for a long time is full again but never overfull, and a clock that steps back does not mint tokens", () => {
  const clock = new FakeClock(); const lim = new RateLimiter(clock, { auth: { capacity: 3, refillPerSec: 1 }, read: { capacity: 1, refillPerSec: 1 }, write: { capacity: 1, refillPerSec: 1 } });
  for (let i = 0; i < 3; i++) lim.take("auth", "k");
  clock.advance(10 ** 9); let n = 0; while (lim.take("auth", "k").ok && n < 100) n++; assert.equal(n, 3);
  clock.advance(-60_000); // the clock stepped back (NTP): no negative elapsed time may refill anything
  assert.equal(lim.take("auth", "k").ok, false);
});

test("a rate class with a non-finite or non-positive number is refused at construction instead of poisoning the bucket", () => {
  const ok = { read: { capacity: 1, refillPerSec: 1 }, write: { capacity: 1, refillPerSec: 1 } };
  for (const bad of [{ capacity: 1, refillPerSec: Infinity }, { capacity: Infinity, refillPerSec: 1 }, { capacity: NaN, refillPerSec: 1 }, { capacity: 1, refillPerSec: NaN }, { capacity: 0, refillPerSec: 1 }, { capacity: 1, refillPerSec: 0 }, { capacity: 1, refillPerSec: -1 }]) {
    assert.throws(() => new RateLimiter(new FakeClock(), { auth: bad, ...ok }), /rate class auth/, JSON.stringify(bad));
  }
});

test("route classes have their own buckets over HTTP: an emptied login bucket leaves reads and writes of a live session alone, and the reverse", async () => {
  const h = await start({ rateClasses: { auth: { capacity: 2, refillPerSec: 0.0001 }, read: { capacity: 6, refillPerSec: 0.0001 }, write: { capacity: 3, refillPerSec: 0.0001 }, totp: { capacity: 5, refillPerSec: 0.0001 } } });
  try {
    const { cookie } = await login(h); // auth token 1
    const bad = (token: string) => raw(h, { method: "POST", path: "/api/v1/session", headers: jsonHeaders(), body: JSON.stringify({ token }) });
    assert.equal((await bad("f".repeat(64))).status, 401); // auth token 2
    assert.equal((await bad("f".repeat(64))).status, 429, "the login class is dry");
    assert.equal((await raw(h, { path: "/api/v1/whoami", headers: { cookie } })).status, 200, "reads still pass");
    const t = await csrfToken(h, cookie);
    assert.equal((await raw(h, { method: "DELETE", path: "/api/v1/sessions", headers: { cookie, "x-csrf-token": t } })).status, 200, "a write still passes");
    // Now the reverse: a fresh server, empty the read class, a login still works.
  } finally { await h.close(); }
  const h2 = await start({ rateClasses: { auth: { capacity: 3, refillPerSec: 0.0001 }, read: { capacity: 2, refillPerSec: 0.0001 }, write: { capacity: 3, refillPerSec: 0.0001 } } });
  try {
    assert.equal((await raw(h2, { path: "/api/v1/whoami" })).status, 401); assert.equal((await raw(h2, { path: "/api/v1/whoami" })).status, 401);
    assert.equal((await raw(h2, { path: "/api/v1/whoami" })).status, 429, "the read class is dry");
    assert.equal((await login(h2)).res.status, 200, "login draws on its own class");
  } finally { await h2.close(); }
});

test("code evidence: no source file of the API reads a forwarding header, so the address is the socket's and nothing can spoof it", () => {
  const offenders: string[] = [];
  for (const f of readdirSync(srcDir).filter((x) => x.endsWith(".ts"))) {
    const text = readFileSync(path.join(srcDir, f), "utf8").split("\n");
    text.forEach((line, i) => { if (/x-forwarded|x-real-ip|cf-connecting-ip|true-client-ip|headers\.(forwarded|via)\b|headers\[["'](forwarded|via)["']\]/i.test(line) && !/^\s*(\/\/|\*|\/\*)/.test(line)) offenders.push(`${f}:${i + 1}: ${line.trim().slice(0, 100)}`); });
  }
  assert.deepEqual(offenders, [], "a forwarding header is read; it must only be believed behind a configured proxy");
  assert.match(readFileSync(path.join(srcDir, "server.ts"), "utf8"), /req\.socket\.remoteAddress/);
});

// ---- audit queue ---------------------------------------------------------------------------------------------------

const evt = (n: number): AuditEvent => ({ at: n, actor: { user: "u", host: "api" }, action: "auth.login.success", target: `seq:${n}`, detail: {} }) as AuditEvent;
const seqOf = (e: AuditEvent) => Number((e.target as string).slice(4));

test("under random sink failures every event is written at most once, in order, and written + dropped accounts for all of them (seeded)", async () => {
  for (const SEED of [0xA0D1, 0xA0D2, 0xA0D3, 0xA0D4]) {
    const rand = mulberry32(SEED); const written: number[] = []; const failRate = 0.2 + rand() * 0.5;
    const inner: AuditSink = { append(e) { if (rand() < failRate) throw new Error("lock busy"); written.push(seqOf(e)); } };
    const q = createBufferedSink(inner, { log: nop, maxQueue: 100_000, maxAttempts: 4, retryMs: 1 });
    const N = 300;
    for (let i = 0; i < N; i++) { q.append(evt(i)); if (rand() < 0.1) await flushTicks(); }
    await q.flush();
    const where = `seed ${SEED}, failure rate ${failRate.toFixed(2)}`;
    assert.equal(new Set(written).size, written.length, `${where}: an event was written twice`);
    assert.deepEqual([...written].sort((a, b) => a - b), written, `${where}: order was not kept`);
    assert.equal(written.length + q.dropped, N, `${where}: ${written.length} written + ${q.dropped} dropped != ${N}`);
    assert.equal(q.pending, 0, where);
  }
});

test("backpressure: with the chain down for good the queue stays at its bound however many events arrive, keeps the oldest, and counts the rest", async () => {
  let down = true; const written: number[] = []; let errors = 0;
  const inner: AuditSink = { append(e) { if (down) throw new Error("locked"); written.push(seqOf(e)); } };
  const q = createBufferedSink(inner, { log: { error() { errors++; } }, maxQueue: 50, maxAttempts: 1_000_000, retryMs: 1 });
  for (let i = 0; i < 20_000; i++) { q.append(evt(i)); assert.ok(q.pending <= 50, `pending ${q.pending} at ${i}`); }
  assert.equal(q.dropped, 20_000 - 50); assert.ok(errors < 100, `the log was told ${errors} times; a flood must not become a log flood`);
  down = false; await q.flush();
  assert.deepEqual(written, Array.from({ length: 50 }, (_, i) => i), "the 50 oldest were kept (new events are the ones refused when full), in order");
  assert.equal(q.pending, 0);
});

test("a restart: what was written stays written exactly once, what was still queued is gone, and a new queue over the same chain re-sends nothing", async () => {
  const written: number[] = []; let down = false;
  const inner: AuditSink = { append(e) { if (down) throw new Error("locked"); written.push(seqOf(e)); } };
  const first = createBufferedSink(inner, { log: nop, maxAttempts: 1_000_000, retryMs: 1 });
  for (let i = 0; i < 10; i++) first.append(evt(i));
  await first.flush();
  down = true; for (let i = 10; i < 15; i++) first.append(evt(i)); // five events queued behind a locked chain …
  const lostWithTheProcess = first.pending; // … and the process dies here: nothing persists the queue
  down = false;
  const second = createBufferedSink(inner, { log: nop }); second.append(evt(100)); await second.flush();
  assert.equal(lostWithTheProcess, 5);
  assert.deepEqual(written, [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 100], "no duplicates from the old queue, no resurrection after restart");
  await first.flush(); // the old instance, if it were somehow still alive, would write its five once and only once
  assert.deepEqual(written.slice(11), [10, 11, 12, 13, 14]);
});

test("code evidence: shutdown stops accepting requests first and only then flushes the queue, so nothing accepted is left behind by a normal stop", () => {
  const bin = readFileSync(path.join(srcDir, "bin.ts"), "utf8");
  assert.match(bin, /await api\.close\(\);\s*await audit\.flush\(\);\s*await core\.close\(\)/);
  assert.match(bin, /process\.on\("SIGTERM"/); assert.match(bin, /process\.on\("SIGINT"/);
});

test("the emitter drops a repeated noisy event inside its window, lets it through again after, never throws, and keeps its memory bounded", () => {
  const clock = new FakeClock(); const out: AuditEvent[] = []; const sink: AuditSink = { append: (e) => { out.push(e); } };
  const em = createAuditEmitter({ sink, clock, log: nop });
  for (let i = 0; i < 10_000; i++) em.emit("auth.rate-limited", "anonymous", "ip:127.0.0.1", { n: i });
  assert.equal(out.length, 1, "10 000 identical throttle events in one window are one entry");
  clock.advance(59_999); em.emit("auth.rate-limited", "anonymous", "ip:127.0.0.1"); assert.equal(out.length, 1);
  clock.advance(1); em.emit("auth.rate-limited", "anonymous", "ip:127.0.0.1"); assert.equal(out.length, 2, "the next window starts exactly at 60 s");
  for (let i = 0; i < 5_000; i++) em.emit("auth.csrf-refused", `u${i}`, `user:u${i}`); // distinct keys: only the bookkeeping is bounded
  assert.equal(out.length, 2 + 5_000);
  for (let i = 0; i < 3; i++) em.emit("auth.login.failure", "anonymous", "name:x", { n: i }); assert.equal(out.length, 5_005, "quiet events are never merged");
  const failing = createAuditEmitter({ sink: { append() { throw new Error("chain tampered"); } }, clock, log: nop });
  assert.doesNotThrow(() => failing.emit("auth.login.success", "u", "user:u", {}));
});

// ---- redaction -----------------------------------------------------------------------------------------------------

test("redactFields covers the names a login, a second factor and a pairing carry, in any case and nesting; error identifiers named `code` survive", () => {
  const secret = "redact-probe-alpha";
  const input = {
    password: secret, Password: secret, newPassword: secret, passwd: secret, totp: secret, totpCode: secret, otp: secret, otpauthUri: `otpauth://totp/x?secret=${secret}`, backupCode: secret, backupCodes: [secret], challenge: secret,
    code: "123456", authCode: "123456", bearer: secret, passphrase: secret, "Set-Cookie": secret, cookie: secret, Authorization: secret, "x-api-key": secret, apiKey: secret, csrfToken: secret, sessionId: secret, credential: secret, secret,
    nested: { a: [{ deep: { token: secret, code: "654321" } }] },
    keep: { route: "tokens.create", status: 401, ip: "127.0.0.1", code: "HPE_HEADER_OVERFLOW", errorCode: "E_NOT_FOUND", reason: "invalid-code" },
  };
  const out = redactFields(input) as typeof input; const text = JSON.stringify(out);
  assert.ok(!text.includes(secret), `a marker survived: ${text}`); assert.ok(!text.includes("123456") && !text.includes("654321"), "a code survived");
  assert.deepEqual(out.keep, input.keep, "ordinary fields and error identifiers are untouched");
  assert.equal((out.nested as any).a[0].deep.token, REDACTED);
});

test("redactFields survives hostile shapes: cycles, very deep nesting, huge arrays, prototype keys, getters that throw are not the logger's problem but a cycle is", () => {
  const cyc: Record<string, unknown> = { a: 1 }; cyc.self = cyc;
  assert.doesNotThrow(() => redactFields(cyc)); assert.ok(JSON.stringify(redactFields(cyc)).includes(REDACTED));
  let deep: unknown = { token: "redact-probe-alpha" }; for (let i = 0; i < 1_000; i++) deep = { x: deep };
  assert.ok(!JSON.stringify(redactFields(deep)).includes("redact-probe-alpha"));
  const big = Array.from({ length: 100_000 }, (_, i) => ({ i, password: "redact-probe-alpha" }));
  assert.ok(!JSON.stringify(redactFields(big)).includes("redact-probe-alpha"));
  const polluted = JSON.parse('{"__proto__":{"polluted":true},"constructor":{"password":"redact-probe-alpha"}}');
  const r = redactFields(polluted) as Record<string, unknown>; assert.equal(({} as Record<string, unknown>).polluted, undefined);
  assert.ok(!JSON.stringify(r).includes("redact-probe-alpha"));
});

test("end to end: marker values sent as a password, a TOTP code, a challenge, a header, a cookie or a query string appear neither in the audit entries nor in the log", async () => {
  const PW = "redact-probe-alpha-password"; const WRONG = "redact-probe-alpha-wrong"; const NAME = "redact-probe-alpha-user";
  const h = await start({ rateClasses: wide });
  try {
    h.users.add({ id: "u-mia", username: "mia", role: "member", passwordHash: await hashPassword(PW) });
    const post = (body: unknown, extra: Record<string, string> = {}, p = "/api/v1/session") => raw(h, { method: "POST", path: p, headers: { ...jsonHeaders(), ...extra }, body: JSON.stringify(body) });
    const mine: string[] = [WRONG, NAME, "redact-probe-alpha-bearer", "redact-probe-alpha-cookie", "redact-probe-alpha-query", "redact-probe-alpha-challenge", "redact-probe-alpha-basic"];
    // Failed logins with markers in the body, plus markers in the headers and the query string of the same requests.
    await post({ username: NAME, password: WRONG }, { authorization: "Bearer redact-probe-alpha-bearer", cookie: "other=redact-probe-alpha-cookie; plur1bus_session=redact-probe-alpha-cookie" });
    await post({ username: "mia", password: WRONG }, { authorization: `Basic ${Buffer.from("redact-probe-alpha-basic").toString("base64")}` });
    await raw(h, { path: "/api/v1/whoami?token=redact-probe-alpha-query&access_token=redact-probe-alpha-query", headers: { authorization: "Bearer redact-probe-alpha-bearer" } });
    await post({ challenge: "redact-probe-alpha-challenge", code: "000000" }, {}, "/api/v1/session/totp");
    // A real login, enrolment, second step, token, logout: the values that are real secrets in this run.
    const { cookie } = await loginAs(h, "mia", PW); const sid = cookie.split("=")[1]!; mine.push(sid);
    const setup = await write(h, cookie, { path: "/api/v1/me/totp/setup" }); mine.push(setup.json.secret);
    const confirm = await write(h, cookie, { path: "/api/v1/me/totp/confirm", body: { code: totpCodeAt(setup.json.secret, h.clock.now()) } }); mine.push(...(confirm.json.backupCodes as string[]));
    const csrf = await csrfToken(h, cookie); mine.push(csrf);
    const made = await write(h, cookie, { path: "/api/v1/tokens", body: { name: "redact-probe-alpha-tokenname-not-secret", scopes: ["doctor.read"] } }); mine.push(made.json.token, (made.json.token as string).slice(17));
    await raw(h, { path: "/api/v1/health", headers: { authorization: `Bearer ${made.json.token}` } });
    await raw(h, { method: "DELETE", path: "/api/v1/session", headers: { cookie, "x-csrf-token": await csrfToken(h, cookie) } });
    h.clock.advance(30_000);
    const ch = await post({ username: "mia", password: PW }); mine.push(ch.json.challenge);
    await post({ challenge: ch.json.challenge, code: confirm.json.backupCodes[0] }, {}, "/api/v1/session/totp");
    const audit = JSON.stringify(h.audit.events); const logs = h.logs.join("\n");
    assert.ok(h.audit.events.length >= 8 && h.logs.length >= 8, "the flow produced audit entries and log lines to look through");
    const leaks = mine.filter((m) => audit.includes(m) || logs.includes(m));
    assert.deepEqual(leaks.map((l) => l.slice(0, 24)), [], "a secret value reached the audit or the log");
    assert.ok(!/"(password|code|token|secret|cookie|authorization)"\s*:\s*"[^\[]/i.test(audit), "no credential-named field holds a value in the audit");
  } finally { await h.close(); }
});
