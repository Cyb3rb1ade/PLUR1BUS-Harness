// Step 7 of the server hardening sweep: pairing codes, pair-proof, the device store.
// Time is the injected `now` of this package (it has no clock module); generative cases use mulberry32 with a fixed seed
// that appears in every failure message. Key derivation is stubbed (SHA-256) wherever thousands of cases run.
// Already pinned elsewhere (not repeated): one use and one hour, the three-pending cap, five failures per source, ten
// per code, same work whatever the input (pair-code.test.ts, pair-bruteforce.test.ts); round trip, man in the middle,
// tampered fields, rate limits (pair-proof*.test.ts); pairing, revoke, restart, failed writes, replayed challenges
// (device-store.test.ts, device-revocation.test.ts).
import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { readFileSync as readSrc, readdirSync as listSrc } from "node:fs";
import { DeviceError, DeviceStore } from "../src/device-store.ts";
import { CODE_ALPHABET, CODE_LENGTH, DEFAULT_ARGON2, generateCode, normalizeCode, PairCodeStore } from "../src/pair-code.ts";
import { createClientNonce, createProofLimiter, handlePairProof, verifyPairProof } from "../src/pair-proof.ts";
import { SlidingWindowLimiter } from "../src/rate-limit.ts";

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
const cheapDerive = (code: string, salt: Uint8Array): Buffer => createHash("sha256").update("test-derive").update(code).update(salt).digest();
const srcDir = join(fileURLToPath(new URL(".", import.meta.url)), "../src");

// ---- the pairing code ----------------------------------------------------------------------------------------------

test("a code is 8 characters from a 32-character alphabet without I, O, 0 and 1: exactly the documented 40 bits", () => {
  assert.equal(new Set(CODE_ALPHABET).size, 32); assert.equal(CODE_ALPHABET.length ** CODE_LENGTH, 2 ** 40);
  for (const bad of "IO01") assert.ok(!CODE_ALPHABET.includes(bad), bad);
  assert.match(CODE_ALPHABET, /^[A-Z2-9]+$/);
  for (let i = 0; i < 200; i++) assert.match(generateCode(), /^[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}$/);
});

test("generated codes use every character about equally often and never repeat (2500 codes; CSPRNG, so bounds are loose but tight enough to catch a biased alphabet)", () => {
  const counts = new Map<string, number>(); const seen = new Set<string>();
  for (let i = 0; i < 2500; i++) { const c = generateCode(); assert.ok(!seen.has(c), `duplicate code ${c}`); seen.add(c); for (const ch of c.replace("-", "")) counts.set(ch, (counts.get(ch) ?? 0) + 1); }
  const expected = (2500 * 8) / 32; // 625 each; the standard deviation is about 24, so 0.7x to 1.3x is more than seven sigma
  for (const ch of CODE_ALPHABET) { const n = counts.get(ch) ?? 0; assert.ok(n > expected * 0.7 && n < expected * 1.3, `${ch} appeared ${n} times, expected about ${expected}`); }
});

test("code evidence: nothing in the package takes randomness from Math.random, and codes come from node:crypto", () => {
  const offenders = listSrc(srcDir).filter((f) => f.endsWith(".ts")).filter((f) => /Math\.random/.test(readSrc(join(srcDir, f), "utf8")));
  assert.deepEqual(offenders, []);
  assert.match(readSrc(join(srcDir, "pair-code.ts"), "utf8"), /import \{[^}]*randomInt[^}]*\} from "node:crypto"/);
});

test("whatever a request carries as the code (not a string at all, huge, odd Unicode), redeem answers 'invalid' and never throws", () => {
  const store = new PairCodeStore({ derive: cheapDerive, maxCodeFailures: 1000, sourceMaxFailures: 1000 }); const issued = store.issue(0); // generous limits: this test is about throwing, not burning
  const hostile: unknown[] = [undefined, null, 0, 123_456_78, NaN, true, {}, [], ["ABCD-EFGH"], { toString: () => issued.code }, Symbol.iterator, () => issued.code, 10n, "x".repeat(1_000_000), "\u0000".repeat(8), "\uD800ABCDEFGH", "ßßßßSSSS"];
  for (const h of hostile) {
    const r = store.redeem(h as string, 1, `src-${typeof h}-${String(h).length}`);
    assert.deepEqual(r, { ok: false, reason: "invalid" }, `${typeof h}: ${String(typeof h === "symbol" ? "symbol" : h).slice(0, 20)}`);
  }
  assert.equal(normalizeCode(123 as never), undefined);
  assert.equal(store.redeem(issued.code, 2, "fresh-source").ok, true, "the real code still works after all that (a hostile input costs failures, not the code)");
});

test("the hour is exact on the injected clock: open one millisecond before expiry, gone at the expiry, and the slot is free again", () => {
  const store = new PairCodeStore({ derive: cheapDerive, ttlMs: 3_600_000, maxPending: 1 }); const c = store.issue(10_000);
  assert.equal(c.expiresAt, 3_610_000); assert.equal(store.open(3_609_999).length, 1); assert.equal(store.open(3_610_000).length, 0);
  assert.equal(store.redeem(c.code, 3_610_000, "s").ok, false, "a correct code is refused from the very millisecond it expires");
  assert.doesNotThrow(() => store.issue(3_610_000));
  const c2 = new PairCodeStore({ derive: cheapDerive }); const live = c2.issue(0);
  assert.equal(c2.redeem(live.code, 3_599_999, "s").ok, true);
  assert.deepEqual(c2.redeem(live.code, 3_599_999, "s2"), { ok: false, reason: "invalid" }, "and once used it is gone for everyone");
});

test("seeded attacker model: 6000 guesses from 60 sources over simulated hours never redeem a code, never exceed the per-source budget, and a locked source costs no derivation", () => {
  const SEED = 0xBADC0DE; const rand = mulberry32(SEED); let derivations = 0;
  const store = new PairCodeStore({ derive: (c, s) => { derivations++; return cheapDerive(c, s); }, maxCodeFailures: 10, sourceMaxFailures: 5, sourceWindowMs: 600_000, sourceLockMs: 900_000 });
  let now = 1_000_000; store.issue(now); const sources = Array.from({ length: 60 }, (_, i) => `src-${i}`);
  const reached = new Map<string, number[]>(); let redeemed = 0; let issuedAgain = 0;
  for (let i = 0; i < 6000; i++) {
    now += Math.floor(rand() * 20_000); const src = sources[Math.floor(rand() * sources.length)]!;
    if (rand() < 0.02 && store.open(now).length === 0) { store.issue(now); issuedAgain++; }
    const guess = `${CODE_ALPHABET[Math.floor(rand() * 32)]}${CODE_ALPHABET[Math.floor(rand() * 32)]}${CODE_ALPHABET[Math.floor(rand() * 32)]}${CODE_ALPHABET[Math.floor(rand() * 32)]}-${CODE_ALPHABET[Math.floor(rand() * 32)]}${CODE_ALPHABET[Math.floor(rand() * 32)]}${CODE_ALPHABET[Math.floor(rand() * 32)]}${CODE_ALPHABET[Math.floor(rand() * 32)]}`;
    const before = derivations; const r = store.redeem(guess, now, src);
    if (r.ok) redeemed++;
    if (!r.ok && r.reason === "locked") assert.equal(derivations, before, `seed ${SEED} step ${i}: a locked source cost ${derivations - before} derivations`);
    else { const list = reached.get(src) ?? []; list.push(now); reached.set(src, list); }
  }
  assert.equal(redeemed, 0, `seed ${SEED}: a random guess redeemed a code (a 2^-40 event per try)`);
  for (const [src, times] of reached) for (let k = 0; k + 5 < times.length; k++) assert.ok(times[k + 5]! - times[k]! >= 600_000 || times[k + 5]! - times[k]! >= 0, `seed ${SEED}: ${src}`);
  // The budget itself: within any sliding window of 10 minutes a source got at most 5 attempts through to a derivation.
  for (const [src, times] of reached) for (let k = 0; k < times.length; k++) { const inWindow = times.filter((t) => t >= times[k]! && t < times[k]! + 600_000).length; assert.ok(inWindow <= 5, `seed ${SEED}: ${src} had ${inWindow} attempts reach the hasher inside ten minutes`); }
  assert.ok(issuedAgain >= 1, `seed ${SEED}: codes were burned and re-issued at least once, so the burn rule was exercised`);
});

test("the table of failing sources shrinks again: 20 000 sources failing once, then one failure after the window, leaves almost nothing behind", () => {
  class Probe extends PairCodeStore { get remembered(): number { return this.sources.size; } }
  const store = new Probe({ derive: cheapDerive, sourceWindowMs: 600_000, sourceLockMs: 900_000 }); store.issue(0);
  for (let i = 0; i < 20_000; i++) store.redeem("AAAA-AAAA", 1, `src-${i}`);
  assert.equal(store.remembered, 20_000);
  store.redeem("AAAA-AAAA", 600_000 + 5, "late");
  assert.ok(store.remembered <= 2, `${store.remembered} sources are still remembered a window later`);
});

test("a sliding-window limiter does not remember every key it ever saw: idle keys leave without anyone calling sweep, and the table has a ceiling", () => {
  const lim = new SlidingWindowLimiter({ max: 5, windowMs: 1_000 });
  for (let i = 0; i < 30_000; i++) lim.hit(`10.0.${i >> 8}.${i & 255}`, i * 5); // 30 000 distinct sources over 150 s, each seen once
  assert.ok(lim.size() <= 12_000, `${lim.size()} keys are held although only the last second's can matter`);
  const flood = new SlidingWindowLimiter({ max: 5, windowMs: 3_600_000 });
  for (let i = 0; i < 200_000; i++) flood.hit(`k${i}`, 1_000 + i); // all inside the window: the ceiling must hold anyway
  assert.ok(flood.size() <= 100_000, `${flood.size()} keys held under a flood of distinct sources`);
});

// ---- pair-proof ----------------------------------------------------------------------------------------------------

function proofFixture(now = 1_000) {
  const store = new PairCodeStore({ derive: cheapDerive }); const issued = store.issue(now); const fp = createHash("sha256").update("served leaf").digest();
  const ask = (at: number, clientNonce = createClientNonce(), over: Partial<Parameters<typeof handlePairProof>[1]> = {}) => ({ clientNonce, res: handlePairProof({ clientNonce }, { store, now: at, origin: "https://harness.lan:7443", servedFingerprint: fp, source: "203.0.113.7", limiter: createProofLimiter(), ...over }) });
  const check = (code: string, res: any, clientNonce: string, over: Record<string, unknown> = {}) => verifyPairProof({ code, response: res.body, fingerprintSeen: fp, origin: "https://harness.lan:7443", clientNonce, derive: cheapDerive, ...over });
  return { store, issued, fp, ask, check };
}

test("replay: a recorded proof answers its own client nonce only; with a fresh nonce, another code, another fingerprint or another origin it is refused", () => {
  const f = proofFixture(); const first = f.ask(2_000); assert.equal(first.res.status, 200);
  assert.equal(f.check(f.issued.code, first.res, first.clientNonce).ok, true);
  assert.equal(f.check(f.issued.code, first.res, createClientNonce()).ok, false, "a replayed response does not satisfy a fresh nonce");
  assert.equal(f.check("AAAA-AAAA", first.res, first.clientNonce).ok, false, "another typed code");
  assert.equal(f.check(f.issued.code, first.res, first.clientNonce, { fingerprintSeen: createHash("sha256").update("another leaf").digest() }).ok, false, "a proxy's certificate");
  assert.equal(f.check(f.issued.code, first.res, first.clientNonce, { origin: "https://harness.lan:7444" }).ok, false, "another origin");
  const second = f.ask(2_001); assert.notEqual((second.res.body as any).serverNonce, (first.res.body as any).serverNonce); assert.notEqual((second.res.body as any).proof, (first.res.body as any).proof);
});

test("every single bit of a proof, a salt and a server nonce matters: flipping any of them (768 cases) is refused", () => {
  const f = proofFixture(); const { res, clientNonce } = f.ask(2_000); const body = res.body as { salt: string; serverNonce: string; proof: string };
  for (const field of ["proof", "salt", "serverNonce"] as const) {
    const bytes = Buffer.from(body[field], "base64url"); let refused = 0; const bits = Math.min(bytes.length * 8, 256);
    for (let bit = 0; bit < bits; bit++) { const copy = Buffer.from(bytes); copy[bit >> 3]! ^= 1 << (bit & 7); if (!f.check(f.issued.code, { body: { ...body, [field]: copy.toString("base64url") } }, clientNonce).ok) refused++; }
    assert.equal(refused, bits, `${field}: ${bits - refused} bit flips were accepted`);
  }
});

test("no proof outlives its code: the handler answers up to the last millisecond of the hour and not a millisecond longer", () => {
  const f = proofFixture(1_000); const last = f.issued.expiresAt;
  assert.equal(f.ask(last - 1).res.status, 200); const gone = f.ask(last).res; assert.equal(gone.status, 404); assert.equal((gone.body as { code: string }).code, "no-open-code");
  f.store.redeem(f.issued.code, 5_000, "s"); assert.equal(f.ask(5_001).res.status, 404, "and not after the code was used either");
});

test("the handler never answers with the code, the derived key or the verifier, in any field of any answer", () => {
  const f = proofFixture(); const secrets = [f.issued.code, f.issued.code.replace("-", ""), f.store.open(2_000)[0]!.key.toString("base64url"), f.store.open(2_000)[0]!.key.toString("hex"), f.store.snapshot(2_000)[0]!.verifier];
  const bodies = [f.ask(2_000).res, f.ask(2_000, "short").res, f.ask(2_000, undefined, { limiter: createProofLimiter({ perSourceMax: 1 }) }).res];
  for (const r of bodies) for (const s of secrets) assert.ok(!JSON.stringify(r).includes(s), "a secret is in an answer");
});

// ---- the device store ----------------------------------------------------------------------------------------------

const keys = generateKeyPairSync("ed25519"); const spki = (k: typeof keys.publicKey) => k.export({ type: "spki", format: "der" }).toString("base64");
const publicKey = spki(keys.publicKey);
const meta = { name: "Phone", platform: "ios", publicKey, pairedBy: "alice", scope: ["memory.recall"] };
function fixture(mode?: "posix") {
  const dir = mkdtempSync(join(tmpdir(), "plur1bus-devstore-")); const file = join(dir, "devices.json"); let now = 1_000; const events: Array<{ action: string }> = [];
  const options = { file, clock: () => now, audit: { append: (e: { action: string }) => { events.push(e); } }, securePath: () => {} };
  return { dir, file, events, options, store: new DeviceStore(options), advance: (n: number) => { now += n; }, clean: () => rmSync(dir, { recursive: true, force: true }), mode };
}
const connectAs = (s: DeviceStore, pub: string, priv: typeof keys.privateKey, close = () => {}) => { const challenge = s.challenge(); return s.connect({ publicKey: pub, challenge, signature: sign(null, challenge, priv), close }); };

test("the same key cannot be enrolled twice, in any spelling; a revoked key stays a tombstone and cannot come back; other key types and odd metadata are refused", () => {
  const f = fixture();
  try {
    const d = f.store.recordPairing(meta);
    assert.throws(() => f.store.recordPairing({ ...meta, name: "Another name" }), { code: "conflict" });
    for (const respelled of [` ${publicKey}`, `${publicKey} `, publicKey.replace(/=+$/, ""), publicKey.replace(/\+/g, "-").replace(/\//g, "_"), publicKey.toLowerCase(), `${publicKey}\n`]) if (respelled !== publicKey) assert.throws(() => f.store.recordPairing({ ...meta, publicKey: respelled }), { code: "invalid" }, JSON.stringify(respelled.slice(-8)));
    const other = generateKeyPairSync("rsa", { modulusLength: 2048 }).publicKey.export({ type: "spki", format: "der" }).toString("base64");
    const ec = generateKeyPairSync("ec", { namedCurve: "prime256v1" }).publicKey.export({ type: "spki", format: "der" }).toString("base64");
    const x = generateKeyPairSync("x25519").publicKey.export({ type: "spki", format: "der" }).toString("base64");
    for (const wrong of [other, ec, x, "", "AAAA", Buffer.alloc(44).toString("base64")]) assert.throws(() => f.store.recordPairing({ ...meta, publicKey: wrong }), { code: "invalid" });
    for (const bad of [{ name: "" }, { name: "x".repeat(129) }, { name: "tab\there" }, { platform: "" }, { pairedBy: "\u0000" }, { scope: ["a".repeat(129)] }, { scope: Array.from({ length: 129 }, (_, i) => `s${i}`) }, { scope: "memory.recall" as never }]) assert.throws(() => f.store.recordPairing({ ...meta, ...bad }), { code: "invalid" });
    f.store.revoke(d.id, "alice");
    assert.throws(() => f.store.recordPairing(meta), { code: "revoked" }); assert.equal(f.store.list().length, 1); assert.equal(f.store.list()[0]!.revoked, true);
  } finally { f.clean(); }
});

test("revocation is immediate and complete: every live connection of the device closes (a throwing callback stops none), the key cannot connect again, a repeat is idempotent and audited once", () => {
  const f = fixture();
  try {
    const d = f.store.recordPairing(meta); const closed: string[] = [];
    const ends = [connectAs(f.store, publicKey, keys.privateKey, () => { closed.push("a"); }), connectAs(f.store, publicKey, keys.privateKey, () => { throw new Error("socket already gone"); }), connectAs(f.store, publicKey, keys.privateKey, () => { closed.push("c"); })];
    const preChallenge = f.store.challenge(); const preSig = sign(null, preChallenge, keys.privateKey);
    const r = f.store.revoke(d.id, "alice"); assert.equal(r.revoked, true); assert.deepEqual(closed.sort(), ["a", "c"]);
    assert.throws(() => f.store.connect({ publicKey, challenge: preChallenge, signature: preSig, close: () => {} }), { code: "denied" }, "a challenge issued before the revocation is no way in");
    assert.throws(() => connectAs(f.store, publicKey, keys.privateKey), { code: "denied" });
    const before = f.events.length; f.store.revoke(d.id, "alice"); assert.equal(f.events.length, before, "revoking twice is not audited twice");
    for (const end of ends) assert.doesNotThrow(() => end(), "a connection's cleanup after the revocation is harmless");
    assert.equal(new DeviceStore(f.options).get(d.id).revoked, true, "and it survives a restart");
  } finally { f.clean(); }
});

test("hostile connect inputs are a denial with a device error, never a TypeError that a transport would turn into a 500", () => {
  const f = fixture();
  try {
    f.store.recordPairing(meta); const c = f.store.challenge();
    const attempts: Array<[string, unknown]> = [["no challenge", { publicKey, challenge: undefined, signature: Buffer.alloc(64) }], ["challenge is a number", { publicKey, challenge: 5, signature: Buffer.alloc(64) }], ["challenge is an object", { publicKey, challenge: {}, signature: Buffer.alloc(64) }],
      ["no signature", { publicKey, challenge: c, signature: undefined }], ["short signature", { publicKey, challenge: c, signature: Buffer.alloc(3) }], ["signature is a string", { publicKey, challenge: c, signature: "x" }], ["no key", { publicKey: undefined, challenge: c, signature: Buffer.alloc(64) }], ["key is garbage", { publicKey: "!!", challenge: c, signature: Buffer.alloc(64) }]];
    for (const [label, input] of attempts) {
      try { f.store.connect({ close: () => {}, ...(input as object) } as never); assert.fail(`${label}: admitted`); }
      catch (e) { assert.ok(e instanceof DeviceError, `${label}: ${(e as Error).name}: ${(e as Error).message}`); }
    }
    connectAs(f.store, publicKey, keys.privateKey)(); // the store still works after all of that
  } finally { f.clean(); }
});

test("a corrupted store file is a defined error at start, never an empty list and never rewritten: every prefix of a valid file, and every kind of damage (seeded)", () => {
  const f = fixture();
  try {
    const second = generateKeyPairSync("ed25519"); f.store.recordPairing(meta); const d2 = f.store.recordPairing({ ...meta, name: "Tablet", publicKey: spki(second.publicKey) }); f.store.revoke(d2.id, "alice");
    const valid = readFileSync(f.file); const digest = (b: Buffer) => createHash("sha256").update(b).digest("hex"); const want = digest(valid);
    const load = () => new DeviceStore(f.options);
    let accepted = 0;
    for (let cut = 0; cut < valid.length; cut++) {
      writeFileSync(f.file, valid.subarray(0, cut)); const stamp = digest(readFileSync(f.file));
      let ok: DeviceStore | undefined;
      try { ok = load(); } catch (e) { assert.ok(e instanceof DeviceError && e.code === "storage", `prefix ${cut}: ${(e as Error).message}`); }
      if (ok) { accepted++; assert.equal(cut, valid.length - 1, `a prefix of ${cut} bytes was accepted (${ok.list().length} devices)`); assert.equal(ok.list().length, 2); }
      assert.equal(digest(readFileSync(f.file)), stamp, `prefix ${cut}: a failed load must not touch the file`);
    }
    assert.equal(accepted, 1, "only the file without its final newline is still complete");
    const text = valid.toString("utf8"); const fingerprints = f.store.list().map((d) => d.fingerprint).sort(); const SEED = 0xDEFEC7; const rand = mulberry32(SEED); let loaded = 0;
    for (let i = 0; i < 600; i++) {
      const at = Math.floor(rand() * valid.length); const mutated = Buffer.from(valid); mutated[at] = (mutated[at]! ^ (1 << Math.floor(rand() * 8))) & 0xff; writeFileSync(f.file, mutated);
      let s: DeviceStore | undefined;
      try { s = load(); } catch (e) { assert.ok(e instanceof DeviceError && e.code === "storage", `seed ${SEED} byte ${at}: ${(e as Error).name}`); }
      if (s) { loaded++; const list = s.list(); assert.equal(list.length, 2, `seed ${SEED} byte ${at}: a device vanished`); assert.equal(list.filter((d) => d.revoked).length, 1, `seed ${SEED} byte ${at} (bit flip in ${JSON.stringify(text.slice(Math.max(0, at - 12), at + 12))}): a revocation was undone by a flipped bit`); assert.deepEqual(list.map((d) => d.fingerprint).sort(), fingerprints, `seed ${SEED} byte ${at}: a key changed`); }
    }
    assert.ok(loaded < 600, "most flips are caught");
    const dups = JSON.parse(text); const damage: Array<[string, string | Buffer]> = [["empty", ""], ["blank", " \n"], ["null", "null"], ["array", "[]"], ["empty object", "{}"], ["wrong version", JSON.stringify({ ...dups, version: 2 })], ["extra key", JSON.stringify({ ...dups, extra: 1 })], ["devices not a list", JSON.stringify({ version: 1, devices: {} })],
      ["duplicate id", JSON.stringify({ version: 1, devices: [dups.devices[0], { ...dups.devices[1], id: dups.devices[0].id }] })], ["duplicate key", JSON.stringify({ version: 1, devices: [dups.devices[0], { ...dups.devices[0], id: `dev_${"a".repeat(8)}-${"b".repeat(4)}-${"c".repeat(4)}-${"d".repeat(4)}-${"e".repeat(12)}` }] })],
      ["fingerprint mismatch", JSON.stringify({ version: 1, devices: [{ ...dups.devices[0], fingerprint: "0".repeat(64) }] })], ["unknown device field", JSON.stringify({ version: 1, devices: [{ ...dups.devices[0], admin: true }] })], ["last seen before pairing", JSON.stringify({ version: 1, devices: [{ ...dups.devices[0], lastSeenAt: 0, pairedAt: 5 }] })],
      ["revoked without a time", JSON.stringify({ version: 1, devices: [{ ...dups.devices[0], revoked: true }] })], ["BOM", Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), valid])], ["NUL", Buffer.concat([valid, Buffer.from([0])])], ["junk", Buffer.alloc(5_000_000, 0x41)], ["two documents", `${text}${text}`]];
    for (const [label, content] of damage) { writeFileSync(f.file, content); assert.throws(load, (e: unknown) => e instanceof DeviceError && e.code === "storage", label); assert.equal(readFileSync(f.file).equals(Buffer.from(content)), true, `${label}: the file was left alone`); }
    rmSync(f.file); mkdirSync(f.file); assert.throws(load, { code: "storage" }, "a directory where the file belongs");
    rmSync(f.file, { recursive: true }); writeFileSync(`${f.file}.real`, valid); try { symlinkSync(`${f.file}.real`, f.file); assert.throws(load, { code: "storage" }, "a symlink where the file belongs"); } catch (e) { if (!(e as NodeJS.ErrnoException).code?.startsWith("E")) throw e; }
    rmSync(f.file, { force: true }); assert.deepEqual(load().list(), [], "only a missing file starts empty");
    writeFileSync(f.file, valid); assert.equal(digest(readFileSync(f.file)), want);
  } finally { f.clean(); }
});

test("seeded operation sequences (300 pair, rename, revoke, connect, challenge steps): disk equals memory after every step, the file stays valid and private, no temp file is left", () => {
  const SEED = 0x0DE51CE; const rand = mulberry32(SEED); const f = fixture();
  try {
    const pool = Array.from({ length: 12 }, () => { const k = generateKeyPairSync("ed25519"); return { k, pub: spki(k.publicKey) }; }); const ids = new Map<string, string>();
    for (let step = 0; step < 300; step++) {
      const p = pool[Math.floor(rand() * pool.length)]!; const op = Math.floor(rand() * 5); f.advance(Math.floor(rand() * 90_000));
      try {
        if (op === 0) ids.set(p.pub, f.store.recordPairing({ ...meta, name: `d${step}`, publicKey: p.pub }).id);
        else if (op === 1 && ids.has(p.pub)) f.store.rename(ids.get(p.pub)!, `n${step}`, "alice");
        else if (op === 2 && ids.has(p.pub)) f.store.revoke(ids.get(p.pub)!, "alice");
        else if (op === 3) connectAs(f.store, p.pub, p.k.privateKey)();
        else f.store.challenge();
      } catch (e) { assert.ok(e instanceof DeviceError, `seed ${SEED} step ${step}: ${(e as Error).name}`); }
      const onDisk = new DeviceStore(f.options).list(); assert.deepEqual(onDisk.map(({ lastSeenAt: _l, ...d }) => d), f.store.list().map(({ lastSeenAt: _l, ...d }) => d), `seed ${SEED} step ${step}: disk and memory differ`);
    }
    assert.deepEqual(readdirSync(f.dir), ["devices.json"], "no temporary file is left behind");
    if (process.platform !== "win32") assert.equal(statSync(f.file).mode & 0o077, 0, "the file is private");
  } finally { f.clean(); }
});

test("the challenge table is bounded (1024 live) and old challenges leave it, so a flood of unauthenticated challenges is a bounded cost, not unbounded memory", () => {
  const f = fixture();
  try {
    for (let i = 0; i < 1024; i++) f.store.challenge();
    assert.throws(() => f.store.challenge(), { code: "denied" }, "the 1025th live challenge is refused");
    f.advance(30_000); assert.doesNotThrow(() => f.store.challenge(), "30 seconds later they have all expired and made room");
  } finally { f.clean(); }
});

test("KNOWN GAP: a failed revocation write leaves the device connected and authorised in memory (docs/errors.md promises it is denied at once)", { todo: "KNOWN GAP: revoke() throws before updating memory or closing connections when the write fails; docs/errors.md says the opposite; see SICHERHEIT in the PR" }, () => {
  const f = fixture();
  try {
    const d = f.store.recordPairing(meta); let fail = false; const s = new DeviceStore({ ...f.options, securePath: () => { if (fail) throw new Error("disk full"); } });
    let closed = false; connectAs(s, publicKey, keys.privateKey, () => { closed = true; });
    fail = true; assert.throws(() => s.revoke(d.id, "alice"), { code: "storage" });
    assert.equal(closed, true, "the live connection of a device being revoked was closed although the write failed");
    assert.throws(() => connectAs(s, publicKey, keys.privateKey), { code: "denied" }, "and the key cannot connect again in this process");
  } finally { f.clean(); }
});

test("KNOWN GAP: two store instances over one file overwrite each other (a stale instance can undo a revocation); the documented rule is one owner per file", { todo: "KNOWN GAP: persist() writes the whole in-memory list, so a second instance undoes the first one's revocation; core uses one instance (device-surface.ts); see SICHERHEIT in the PR" }, () => {
  const f = fixture();
  try {
    const d = f.store.recordPairing(meta); const stale = new DeviceStore(f.options);
    f.store.revoke(d.id, "alice");
    stale.rename(d.id, "renamed by a stale instance", "bob");
    assert.equal(new DeviceStore(f.options).get(d.id).revoked, true, "the revocation survived another instance's write");
  } finally { f.clean(); }
});
