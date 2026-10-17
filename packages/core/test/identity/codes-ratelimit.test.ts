// identity codes.ts and ratelimit.ts: the code alphabet and hashing, UUIDv7, and the brute-force limiter that
// ratelimit.ts documents (5 failures per handle and 20 overall per 15 minutes, lock 15 minutes; durable across restarts).
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { CODE_ALPHABET, CODE_LENGTH, generateCode, hashCode, hashesEqual, newSalt, normalizeCode, uuidv7 } from "../../src/identity/codes.ts";
import { createLimiter, GLOBAL_KEY, GLOBAL_LIMIT, SOURCE_LIMIT, type LimitSpec } from "../../src/identity/ratelimit.ts";
import { IdentityError, type ChannelIdentity } from "../../src/identity/service.ts";
import { MIN, OWNER, mulberry32, refuses, useIdentity } from "./helpers.ts";

describe("identity codes: alphabet and generation", () => {
  it("the alphabet is 32 distinct upper-case symbols without 0, O, 1 and I; codes are 8 symbols long", () => {
    assert.equal(CODE_ALPHABET.length, 32); assert.equal(new Set(CODE_ALPHABET).size, 32); assert.equal(CODE_LENGTH, 8);
    for (const c of "01OI") assert.equal(CODE_ALPHABET.includes(c), false, c);
    assert.match(CODE_ALPHABET, /^[A-Z2-9]+$/);
  });

  it("generated codes use only the alphabet, are 8 long, and across 2000 codes every symbol shows up and no code repeats", () => {
    const seen = new Set<string>(); const symbols = new Set<string>();
    for (let i = 0; i < 2000; i++) {
      const c = generateCode();
      assert.match(c, /^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{8}$/); seen.add(c); for (const ch of c) symbols.add(ch);
    }
    assert.equal(seen.size, 2000); assert.equal(symbols.size, 32);
  });

  it("every generated code survives normalization unchanged (what is displayed is what is matched)", () => {
    for (let i = 0; i < 200; i++) { const c = generateCode(); assert.equal(normalizeCode(c), c); }
  });
});

describe("identity codes: normalization", () => {
  const table: Array<[string, string]> = [
    ["abcd2345", "ABCD2345"], ["ABCD-2345", "ABCD2345"], [" ab cd - 23 45 ", "ABCD2345"], ["ab\tcd\n2345", "ABCD2345"], ["", ""], ["---", ""],
    ["ABCD_2345", "ABCD_2345"], ["ABCD.2345", "ABCD.2345"], ["abcd 2345", "ABCD2345"],
  ];
  for (const [raw, want] of table) it(`${JSON.stringify(raw)} becomes ${JSON.stringify(want)}`, () => assert.equal(normalizeCode(raw), want));

  it("other dashes and zero-width characters are not forgiven: they stay and fail to match", () => {
    for (const raw of ["ABCD–2345", "ABCD−2345", "ABCD​2345", "ABCD­2345"]) assert.notEqual(normalizeCode(raw), "ABCD2345", JSON.stringify(raw));
  });

  it("normalization is idempotent", () => {
    const rnd = mulberry32(0x1d_c0de); const pool = "abcXYZ 0189-_\t\n.";
    for (let i = 0; i < 300; i++) {
      let s = ""; const n = Math.floor(rnd() * 14); for (let k = 0; k < n; k++) s += pool[Math.floor(rnd() * pool.length)];
      assert.equal(normalizeCode(normalizeCode(s)), normalizeCode(s), `seed 0x1dc0de case ${i}: ${JSON.stringify(s)}`);
    }
  });
});

describe("identity codes: salt, hash, comparison", () => {
  it("a salt is 32 hex characters and fresh each time", () => {
    const a = newSalt(); const b = newSalt();
    assert.match(a, /^[0-9a-f]{32}$/); assert.notEqual(a, b);
  });

  it("the hash is SHA-256 over salt, a NUL separator and the code (derived independently)", () => {
    const want = createHash("sha256").update("salt-1").update(Buffer.from([0])).update("ABCD2345").digest("hex");
    assert.equal(hashCode("salt-1", "ABCD2345"), want);
    assert.match(hashCode("s", "c"), /^[0-9a-f]{64}$/);
  });

  it("another salt or another code gives another hash; the separator keeps salt and code from sliding into each other", () => {
    assert.notEqual(hashCode("s1", "ABCD2345"), hashCode("s2", "ABCD2345"));
    assert.notEqual(hashCode("s1", "ABCD2345"), hashCode("s1", "ABCD2346"));
    assert.notEqual(hashCode("ab", "cd"), hashCode("a", "bcd"));
    assert.notEqual(hashCode("abc", "d"), hashCode("ab", "cd"));
  });

  it("the hash never contains the code", () => assert.equal(hashCode(newSalt(), "ABCD2345").includes("ABCD2345"), false));

  it("equal hashes compare equal, different ones and different lengths do not", () => {
    const h = hashCode("s", "c"); const other = hashCode("s", "d");
    assert.equal(hashesEqual(h, h), true); assert.equal(hashesEqual(h, other), false); assert.equal(hashesEqual(h, h.slice(0, 62)), false); assert.equal(hashesEqual(h, ""), false);
  });

  it("characterization: Ist-Verhalten, nicht spezifiziert: hashesEqual decodes hex leniently, so non-hex input of equal decoded length compares equal (callers only pass SHA-256 hex)", () => {
    assert.equal(hashesEqual("zz", "yy"), true, "both decode to zero bytes");
    assert.equal(hashesEqual("abc", "abd"), true, "an odd trailing nibble is dropped");
  });
});

describe("identity codes: uuidv7", () => {
  it("has the 8-4-4-4-12 shape, version 7, variant 10xx and the millisecond timestamp in the first 48 bits", () => {
    const t = 1_800_000_123_456;
    const id = uuidv7(t);
    assert.match(id, /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    assert.equal(parseInt(id.replace(/-/g, "").slice(0, 12), 16), t);
  });

  it("ids sort by creation time as strings, and ids of the same millisecond still differ", () => {
    const ids = [1_000, 2_000, 3_000, 70_000_000_000].map((t) => uuidv7(t));
    assert.deepEqual([...ids].sort(), ids);
    const same = new Set(Array.from({ length: 500 }, () => uuidv7(5_000)));
    assert.equal(same.size, 500);
  });
});

describe("identity ratelimit: the limiter alone", () => {
  function setup(start = 1_000_000) {
    const db = new DatabaseSync(":memory:");
    db.exec("CREATE TABLE attempts (key TEXT PRIMARY KEY, failures INTEGER NOT NULL, window_start INTEGER NOT NULL, locked_until INTEGER NOT NULL) STRICT");
    let now = start;
    const lim = createLimiter(db, () => now);
    return { db, lim, now: () => now, set: (t: number) => { now = t; }, advance: (ms: number) => { now += ms; }, rows: () => (db.prepare("SELECT * FROM attempts ORDER BY key").all() as Array<{ key: string; failures: number; window_start: number; locked_until: number }>).map((r) => ({ ...r })) };
  }
  const spec: LimitSpec = { limit: 3, windowMs: 1000, lockMs: 5000 };

  it("the documented numbers: 5 per handle, 20 overall, 15 minutes window, 15 minutes lock", () => {
    assert.deepEqual(SOURCE_LIMIT, { limit: 5, windowMs: 15 * MIN, lockMs: 15 * MIN });
    assert.deepEqual(GLOBAL_LIMIT, { limit: 20, windowMs: 15 * MIN, lockMs: 15 * MIN });
    assert.equal(GLOBAL_KEY, "global");
  });

  it("nothing is locked before the limit; the failure that reaches the limit locks for lockMs and restarts the count", () => {
    const s = setup();
    s.lim.failure("k", spec); s.lim.failure("k", spec);
    assert.equal(s.lim.lockedFor(["k"]), 0);
    s.lim.failure("k", spec);
    assert.equal(s.lim.lockedFor(["k"]), 5000);
    assert.deepEqual(s.rows(), [{ key: "k", failures: 0, window_start: s.now(), locked_until: s.now() + 5000 }]);
  });

  it("lockedFor reports the remaining time and is zero exactly when the lock ends", () => {
    const s = setup();
    for (let i = 0; i < 3; i++) s.lim.failure("k", spec);
    s.advance(4999); assert.equal(s.lim.lockedFor(["k"]), 1);
    s.advance(1); assert.equal(s.lim.lockedFor(["k"]), 0);
  });

  it("with several keys, the longest remaining lock wins; unknown keys are free", () => {
    const s = setup();
    for (let i = 0; i < 3; i++) s.lim.failure("a", spec);
    s.advance(1000);
    for (let i = 0; i < 3; i++) s.lim.failure("b", spec);
    assert.equal(s.lim.lockedFor(["a", "b", "never-seen"]), 5000);
    assert.equal(s.lim.lockedFor(["a", "never-seen"]), 4000);
    assert.equal(s.lim.lockedFor(["never-seen"]), 0); assert.equal(s.lim.lockedFor([]), 0);
  });

  it("failures are counted per key", () => {
    const s = setup();
    s.lim.failure("a", spec); s.lim.failure("a", spec); s.lim.failure("b", spec); s.lim.failure("b", spec);
    assert.equal(s.lim.lockedFor(["a", "b"]), 0);
  });

  it("failures older than the window no longer count; one exactly windowMs old still does", () => {
    const s = setup();
    s.lim.failure("k", spec); s.lim.failure("k", spec);
    s.advance(1000); s.lim.failure("k", spec);
    assert.equal(s.lim.lockedFor(["k"]), 5000, "the window is inclusive of its last millisecond");
    const t = setup();
    t.lim.failure("k", spec); t.lim.failure("k", spec);
    t.advance(1001); t.lim.failure("k", spec);
    assert.equal(t.lim.lockedFor(["k"]), 0, "the first two fell out of the window");
    assert.equal(t.rows()[0]!.failures, 1);
  });

  it("success forgets the key's failures, and only that key's", () => {
    const s = setup();
    s.lim.failure("a", spec); s.lim.failure("a", spec); s.lim.failure("b", spec);
    s.lim.success("a");
    assert.deepEqual(s.rows().map((r) => r.key), ["b"]);
    s.lim.failure("a", spec); s.lim.failure("a", spec);
    assert.equal(s.lim.lockedFor(["a"]), 0);
    s.lim.success("never-seen");
  });

  it("success lifts a lock too (the row is deleted)", () => {
    const s = setup();
    for (let i = 0; i < 3; i++) s.lim.failure("k", spec);
    s.lim.success("k");
    assert.equal(s.lim.lockedFor(["k"]), 0);
  });

  it("a failure during a lock never shortens it", () => {
    const s = setup();
    for (let i = 0; i < 3; i++) s.lim.failure("k", spec);
    const until = s.now() + 5000;
    s.advance(100); s.lim.failure("k", spec);
    assert.equal(s.rows()[0]!.locked_until, until);
    assert.equal(s.lim.lockedFor(["k"]), until - s.now());
  });

  it("a new lock after the old one ended starts from the new moment", () => {
    const s = setup();
    for (let i = 0; i < 3; i++) s.lim.failure("k", spec);
    s.advance(6000);
    for (let i = 0; i < 3; i++) s.lim.failure("k", spec);
    assert.equal(s.lim.lockedFor(["k"]), 5000);
  });

  it("a limit of one locks on the first failure", () => {
    const s = setup(); s.lim.failure("k", { limit: 1, windowMs: 10, lockMs: 77 });
    assert.equal(s.lim.lockedFor(["k"]), 77);
  });

  it("prune removes only keys whose lock has ended and whose window began over a day ago", () => {
    const s = setup(10 * 24 * 3_600_000);
    s.lim.failure("old-free", spec);                       // window_start = T, never locked
    for (let i = 0; i < 3; i++) s.lim.failure("old-locked", spec);
    s.advance(25 * 3_600_000);
    s.lim.failure("fresh", spec);                          // window starts now
    s.lim.prune();
    assert.deepEqual(s.rows().map((r) => r.key), ["fresh"], "the old rows are gone");
    const t = setup(10 * 24 * 3_600_000);
    for (let i = 0; i < 3; i++) t.lim.failure("lock-held", { limit: 3, windowMs: 1000, lockMs: 30 * 3_600_000 });
    t.advance(25 * 3_600_000); t.lim.prune();
    assert.deepEqual(t.rows().map((r) => r.key), ["lock-held"], "a lock still in force is kept");
  });

  it("randomised model check: the limiter matches an independent model (seeded)", () => {
    const seed = 0xfeed01; const rnd = mulberry32(seed);
    const s = setup(0);
    const sp: LimitSpec = { limit: 4, windowMs: 700, lockMs: 1500 };
    const model = new Map<string, { n: number; start: number; until: number }>();
    for (let step = 0; step < 600; step++) {
      s.advance(Math.floor(rnd() * 400));
      const key = `k${Math.floor(rnd() * 3)}`; const op = rnd();
      const m = model.get(key);
      if (op < 0.7) {
        s.lim.failure(key, sp);
        const inWin = m !== undefined && s.now() - m.start <= sp.windowMs;
        let n = inWin ? m!.n : 0; let start = inWin ? m!.start : s.now(); let until = m?.until ?? 0;
        n += 1; if (n >= sp.limit) { until = s.now() + sp.lockMs; n = 0; start = s.now(); }
        model.set(key, { n, start, until });
      } else if (op < 0.8) { s.lim.success(key); model.delete(key); }
      const want = Math.max(0, ...[...model.entries()].filter(([k]) => k === key).map(([, v]) => v.until - s.now()));
      assert.equal(s.lim.lockedFor([key]), want, `seed ${seed.toString(16)} step ${step} key ${key}`);
    }
  });
});

describe("identity ratelimit: as the service applies it", () => {
  const fixture = useIdentity();
  const at = (n: number | string): ChannelIdentity => ({ channel: "telegram", accountId: "bot-a", userId: String(n) });
  const wrong = (f: ReturnType<typeof fixture>, who: ChannelIdentity) => { try { f.svc.claim({ code: "AAAAAAAA", identity: who }); } catch (e) { return e as IdentityError; } throw new Error("claim with a wrong code did not throw"); };

  it("four wrong guesses stay invalid-code; the fifth locks the handle and every later answer is rate-limited with the remaining time", () => {
    const f = fixture(); const who = at(1);
    for (let i = 0; i < 4; i++) assert.equal(wrong(f, who).code, "invalid-code", `guess ${i + 1}`);
    assert.equal(wrong(f, who).code, "invalid-code", "the guess that trips the lock is still answered as a wrong code");
    const locked = wrong(f, who);
    assert.equal(locked.code, "rate-limited"); assert.equal(locked.retryAfterMs, 15 * MIN);
    f.advance(MIN); assert.equal(wrong(f, who).retryAfterMs, 14 * MIN);
  });

  it("a locked handle is refused even with the right code, and the code stays pending for later", () => {
    const f = fixture(); const h = f.human(); const who = at(2);
    const p = f.svc.startPairing({ humanId: h.id, channel: "telegram", ttlMs: 60 * MIN }, OWNER); // lives past the 15-minute lock
    for (let i = 0; i < 5; i++) wrong(f, who);
    refuses(() => f.svc.claim({ code: p.code, identity: who }), "rate-limited");
    f.advance(15 * MIN);
    assert.equal(f.svc.claim({ code: p.code, identity: who }).state, "awaiting-confirmation");
  });

  it("the lock is per handle: another handle is not affected, and the lock ends exactly after 15 minutes", () => {
    const f = fixture(); const h = f.human();
    for (let i = 0; i < 5; i++) wrong(f, at(3));
    const p = f.svc.startPairing({ humanId: h.id, channel: "telegram" }, OWNER);
    assert.equal(f.svc.claim({ code: p.code, identity: at(4) }).state, "awaiting-confirmation");
    f.advance(15 * MIN - 1); assert.equal(wrong(f, at(3)).code, "rate-limited");
    f.advance(1); assert.equal(wrong(f, at(3)).code, "invalid-code");
  });

  it("a different account or channel with the same user id is a different handle with its own count", () => {
    const f = fixture();
    for (let i = 0; i < 5; i++) wrong(f, at(5));
    assert.equal(wrong(f, { ...at(5), accountId: "bot-b" }).code, "invalid-code");
    assert.equal(wrong(f, { ...at(5), channel: "discord" }).code, "invalid-code");
    assert.equal(wrong(f, at(5)).code, "rate-limited");
  });

  it("a differently cased spelling of the handle is a different handle and does not inherit the lock", () => {
    const f = fixture();
    for (let i = 0; i < 5; i++) wrong(f, at("Abc"));
    assert.equal(wrong(f, at("abc")).code, "invalid-code");
    assert.equal(wrong(f, at("Abc")).code, "rate-limited");
  });

  it("rotating through many handles does not reset the overall counter: the 20th failure anywhere locks everybody", () => {
    const f = fixture(); const h = f.human();
    const p = f.svc.startPairing({ humanId: h.id, channel: "telegram", ttlMs: 60 * MIN }, OWNER); // lives past the 15-minute lock
    for (let i = 0; i < 20; i++) assert.equal(wrong(f, at(`rot-${i}`)).code, "invalid-code", `failure ${i + 1}`);
    refuses(() => f.svc.claim({ code: p.code, identity: at("fresh") }), "rate-limited", undefined, "valid code from a never-seen handle");
    f.advance(15 * MIN);
    assert.equal(f.svc.claim({ code: p.code, identity: at("fresh") }).state, "awaiting-confirmation");
  });

  it("19 failures overall do not lock anyone", () => {
    const f = fixture(); const h = f.human();
    const p = f.svc.startPairing({ humanId: h.id, channel: "telegram" }, OWNER);
    for (let i = 0; i < 19; i++) wrong(f, at(`n-${i}`));
    assert.equal(f.svc.claim({ code: p.code, identity: at("fresh") }).state, "awaiting-confirmation");
  });

  it("failures older than the window are forgotten: 4 now, 4 after the window, no lock", () => {
    const f = fixture(); const who = at(6);
    for (let i = 0; i < 4; i++) wrong(f, who);
    f.advance(15 * MIN + 1);
    for (let i = 0; i < 4; i++) assert.equal(wrong(f, who).code, "invalid-code");
  });

  it("a successful claim clears that handle's failures", () => {
    const f = fixture(); const h = f.human(); const who = at(7);
    for (let i = 0; i < 4; i++) wrong(f, who);
    const p = f.svc.startPairing({ humanId: h.id, channel: "telegram" }, OWNER);
    f.svc.claim({ code: p.code, identity: who });
    for (let i = 0; i < 4; i++) assert.equal(wrong(f, who).code, "invalid-code", `after success, guess ${i + 1}`);
  });

  it("the counters survive a restart: 4 failures, restart, the next one still locks", () => {
    const f = fixture(); const who = at(8);
    for (let i = 0; i < 4; i++) wrong(f, who);
    const again = f.reopen();
    try { again.claim({ code: "AAAAAAAA", identity: who }); } catch (e) { assert.equal((e as IdentityError).code, "invalid-code"); }
    try { again.claim({ code: "AAAAAAAA", identity: who }); assert.fail("must throw"); } catch (e) { assert.equal((e as IdentityError).code, "rate-limited"); }
  });

  it("an existing lock survives a restart", () => {
    const f = fixture(); const who = at(9);
    for (let i = 0; i < 5; i++) wrong(f, who);
    const again = f.reopen();
    refuses(() => again.claim({ code: "AAAAAAAA", identity: who }), "rate-limited");
  });

  it("malformed codes (not a string, over 128 characters) count as failures like any other wrong guess", () => {
    const f = fixture(); const who = at(10);
    for (const bad of [123, null, undefined, "x".repeat(129), {}]) refuses(() => f.svc.claim({ code: bad as never, identity: who }), "invalid-code");
    refuses(() => f.svc.claim({ code: "AAAAAAAA", identity: who }), "rate-limited");
  });

  it("a code of the wrong length can never match, and still counts", () => {
    const f = fixture(); const who = at(11);
    for (const bad of ["", "A", "AAAAAAA", "AAAAAAAAA"]) refuses(() => f.svc.claim({ code: bad, identity: who }), "invalid-code", undefined, bad);
    refuses(() => f.svc.claim({ code: "AAAAAAAA", identity: who }), "invalid-code");
    refuses(() => f.svc.claim({ code: "AAAAAAAA", identity: who }), "rate-limited");
  });

  it("claiming a handle that already belongs to someone is a conflict, not a failed guess: it never feeds the lock", () => {
    const f = fixture(); const a = f.human("A"); const b = f.human("B"); const taken = at(12);
    f.pairAndLink(a.id, taken);
    const p = f.svc.startPairing({ humanId: b.id, channel: "telegram" }, OWNER);
    for (let i = 0; i < 8; i++) refuses(() => f.svc.claim({ code: p.code, identity: taken }), "conflict");
    assert.equal(wrong(f, taken).code, "invalid-code");
    assert.equal(f.svc.claim({ code: p.code, identity: at(13) }).state, "awaiting-confirmation");
  });

  it("an invalid identity is refused before anything is counted", () => {
    const f = fixture();
    for (let i = 0; i < 30; i++) refuses(() => f.svc.claim({ code: "AAAAAAAA", identity: { channel: "telegram", accountId: "", userId: "x" } }), "invalid-params");
    assert.equal(wrong(f, at(14)).code, "invalid-code");
  });

  it("one person's invitations are claimable only 5 times per 15 minutes, however many handles claim; the refused code stays usable", () => {
    const f = fixture(); const h = f.human();
    for (let i = 1; i <= 5; i++) {
      const p = f.svc.startPairing({ humanId: h.id, channel: "telegram" }, OWNER);
      const c = f.svc.claim({ code: p.code, identity: at(`u${i}`) });
      f.svc.confirm({ pairingId: c.pairingId, approve: false }, OWNER);
    }
    const p6 = f.svc.startPairing({ humanId: h.id, channel: "telegram", ttlMs: 60 * MIN }, OWNER); // lives past the 15-minute window
    refuses(() => f.svc.claim({ code: p6.code, identity: at("u6") }), "rate-limited");
    const other = f.human("Other"); const po = f.svc.startPairing({ humanId: other.id, channel: "telegram" }, OWNER);
    assert.equal(f.svc.claim({ code: po.code, identity: at("u7") }).state, "awaiting-confirmation", "another person's invitations are unaffected");
    f.advance(15 * MIN);
    assert.equal(f.svc.claim({ code: p6.code, identity: at("u6") }).state, "awaiting-confirmation");
  });

  it("issuing: 10 invitations per person per 15 minutes; the 11th is rate-limited, other people and later times are fine", () => {
    const f = fixture(); const h = f.human(); const other = f.human("Other");
    for (let i = 0; i < 10; i++) f.svc.startPairing({ humanId: h.id, channel: `chan${i}` }, OWNER);
    const e = (() => { try { f.svc.startPairing({ humanId: h.id, channel: "chan0" }, OWNER); } catch (x) { return x as IdentityError; } throw new Error("no throw"); })();
    assert.equal(e.code, "rate-limited"); assert.equal(e.retryAfterMs, 15 * MIN);
    assert.ok(f.svc.startPairing({ humanId: other.id, channel: "chan0" }, OWNER));
    f.advance(15 * MIN);
    assert.ok(f.svc.startPairing({ humanId: h.id, channel: "chan0" }, OWNER));
  });

  it("issuing: a refusal by the per-channel cap is not counted as an issuance", () => {
    const f = fixture(); const h = f.human();
    const ps = [1, 2, 3].map(() => f.svc.startPairing({ humanId: h.id, channel: "telegram" }, OWNER));
    for (let i = 0; i < 30; i++) refuses(() => f.svc.startPairing({ humanId: h.id, channel: "telegram" }, OWNER), "limit");
    f.svc.revokePairing(ps[0]!.pairingId, OWNER);
    assert.ok(f.svc.startPairing({ humanId: h.id, channel: "telegram" }, OWNER), "still below the issuance limit (4 issued)");
  });

  it("issuing: 100 invitations overall per 15 minutes, then everybody is rate-limited", () => {
    const f = fixture(); const humans = Array.from({ length: 11 }, (_, i) => f.human(`H${i}`));
    for (let hi = 0; hi < 10; hi++) for (let c = 0; c < 10; c++) f.svc.startPairing({ humanId: humans[hi]!.id, channel: `chan${c}` }, OWNER);
    refuses(() => f.svc.startPairing({ humanId: humans[10]!.id, channel: "chan0" }, OWNER), "rate-limited", undefined, "101st issuance");
    f.advance(15 * MIN);
    assert.ok(f.svc.startPairing({ humanId: humans[10]!.id, channel: "chan0" }, OWNER));
  });

  it("limiter keys are stored hashed: the attempts table holds no handle, id or code", async () => {
    const f = fixture(); const h = f.human(); const who: ChannelIdentity = { channel: "telegram", accountId: "acct-marker-keys", userId: "user-marker-keys" };
    wrong(f, who); f.svc.startPairing({ humanId: h.id, channel: "telegram" }, OWNER);
    const db = new DatabaseSync(f.file, { readOnly: true });
    try {
      const rows = db.prepare("SELECT key FROM attempts").all() as Array<{ key: string }>;
      assert.ok(rows.length >= 3);
      for (const r of rows) {
        assert.match(r.key, /^(src|issue|claim):([0-9a-f]{64}|global)$|^global$/, r.key);
        for (const secret of ["acct-marker-keys", "user-marker-keys", h.id]) assert.equal(r.key.includes(secret), false);
      }
    } finally { db.close(); }
  });
});
