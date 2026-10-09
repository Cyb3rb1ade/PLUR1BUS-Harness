import { test } from "node:test";
import assert from "node:assert/strict";
import { createHmac, randomBytes } from "node:crypto";
import { PairCodeStore, deriveKey, normalizeCode } from "../src/pair-code.ts";
import type { Argon2Params } from "../src/pair-code.ts";
import { createClientNonce, createProofLimiter, handlePairProof, proofInput, verifyPairProof } from "../src/pair-proof.ts";
import type { PairProofContext, PairProofResponse } from "../src/pair-proof.ts";
import { SlidingWindowLimiter } from "../src/rate-limit.ts";
import { pinOf } from "../src/fingerprint.ts";

const LIGHT: Argon2Params = { memoryKiB: 64, passes: 1, parallelism: 1 };
const T0 = 1_700_000_000_000;
const ORIGIN = "https://192.168.1.20:18701";
const REAL_FP = pinOf(Buffer.from("the harness leaf certificate"));
const MITM_FP = pinOf(Buffer.from("a proxy's re-signed certificate"));
const CA = pinOf(Buffer.from("company root"));

function setup(over: Partial<PairProofContext> = {}) {
  const store = new PairCodeStore({ params: LIGHT });
  const issued = store.issue(T0);
  const ctx: PairProofContext = {
    store, now: T0 + 1000, origin: ORIGIN, servedFingerprint: REAL_FP, source: "192.168.1.77",
    limiter: createProofLimiter(), ...over,
  };
  return { store, issued, ctx };
}
function ok(res: ReturnType<typeof handlePairProof>): PairProofResponse {
  assert.equal(res.status, 200, JSON.stringify(res));
  return res.body as PairProofResponse;
}

test("round trip: the client that sees the real certificate accepts the proof for the typed code", () => {
  const { issued, ctx } = setup();
  const clientNonce = createClientNonce();
  const body = ok(handlePairProof({ clientNonce }, ctx));
  assert.deepEqual(Object.keys(body).sort(), ["proof", "salt", "serverNonce"]);
  const r = verifyPairProof({ code: issued.code, response: body, fingerprintSeen: REAL_FP, origin: ORIGIN, clientNonce, params: LIGHT });
  assert.deepEqual(r, { ok: true });
  assert.ok(!JSON.stringify(body).includes(issued.code.replace("-", "")), "the response never carries the code");
});

test("man in the middle: a client behind a re-signing proxy sees another fingerprint and refuses", () => {
  const { issued, ctx } = setup();
  const clientNonce = createClientNonce();
  const body = ok(handlePairProof({ clientNonce }, ctx));
  // the proxy relays the real harness's answer unchanged; the client computes against what it was shown
  assert.deepEqual(verifyPairProof({ code: issued.code, response: body, fingerprintSeen: MITM_FP, origin: ORIGIN, clientNonce, params: LIGHT }), { ok: false });
});

test("a wrong code, another origin, another client nonce or a tampered field fail", () => {
  const { issued, ctx } = setup();
  const clientNonce = createClientNonce();
  const body = ok(handlePairProof({ clientNonce }, ctx));
  const base = { code: issued.code, response: body, fingerprintSeen: REAL_FP, origin: ORIGIN, clientNonce, params: LIGHT };
  assert.equal(verifyPairProof(base).ok, true);
  assert.equal(verifyPairProof({ ...base, code: "ABCD-EFGH" }).ok, false);
  assert.equal(verifyPairProof({ ...base, origin: "https://192.168.1.21:18701" }).ok, false);
  assert.equal(verifyPairProof({ ...base, clientNonce: createClientNonce() }).ok, false);
  assert.equal(verifyPairProof({ ...base, response: { ...body, serverNonce: randomBytes(16).toString("base64url") } }).ok, false);
  assert.equal(verifyPairProof({ ...base, response: { ...body, proof: randomBytes(32).toString("base64url") } }).ok, false);
  assert.equal(verifyPairProof({ ...base, response: { ...body, salt: randomBytes(16).toString("base64url") } }).ok, false);
  assert.equal(verifyPairProof({ ...base, code: "garbage" }).ok, false);
  assert.equal(verifyPairProof({ ...base, response: { ...body, proof: "!!" } }).ok, false);
  assert.equal(verifyPairProof({ ...base, response: {} as never }).ok, false);
});

test("company CA: the proof also binds the CA pin, and a client only learns a pin that was proven", () => {
  const { issued, ctx } = setup({ caPin: CA });
  const clientNonce = createClientNonce();
  const body = ok(handlePairProof({ clientNonce }, ctx));
  assert.equal(body.caPin, CA);
  const base = { code: issued.code, response: body, fingerprintSeen: REAL_FP, origin: ORIGIN, clientNonce, params: LIGHT };
  assert.deepEqual(verifyPairProof(base), { ok: true, caPin: CA });
  const swapped = pinOf(Buffer.from("attacker root"));
  assert.deepEqual(verifyPairProof({ ...base, response: { ...body, caPin: swapped } }), { ok: false });
  const dropped: PairProofResponse = { salt: body.salt, serverNonce: body.serverNonce, proof: body.proof };
  assert.deepEqual(verifyPairProof({ ...base, response: dropped }), { ok: false }, "stripping caPin changes the HMAC input");
});

test("the proof is exactly HMAC-SHA256(K, label | fp | ca | origin | nonces) with K = Argon2id(code, salt)", () => {
  const { issued, ctx } = setup();
  const clientNonce = createClientNonce();
  const body = ok(handlePairProof({ clientNonce }, ctx));
  const k = deriveKey(normalizeCode(issued.code)!, Buffer.from(body.salt, "base64url"), LIGHT);
  const expected = createHmac("sha256", k).update(proofInput({
    fp: Buffer.from(REAL_FP.slice(7), "base64url"), origin: ORIGIN,
    clientNonce: Buffer.from(clientNonce, "base64url"), serverNonce: Buffer.from(body.serverNonce, "base64url"),
  })).digest("base64url");
  assert.equal(body.proof, expected);
  // field boundaries cannot be shifted: length-prefixed origin and nonces, fixed-size fingerprint
  const fp = Buffer.alloc(32, 1);
  const a = proofInput({ fp, origin: "https://a.example", clientNonce: Buffer.from("bbbbbbbbbbbbbbbb"), serverNonce: Buffer.from("cccccccccccccccc") });
  const b = proofInput({ fp, origin: "https://a.exampleb", clientNonce: Buffer.from("bbbbbbbbbbbbbbb"), serverNonce: Buffer.from("cccccccccccccccc") });
  assert.notDeepEqual(a, b);
});

test("handler: bad requests, no open code, expired code", () => {
  const { store, ctx } = setup();
  for (const body of [undefined, null, "x", {}, { clientNonce: 5 }, { clientNonce: "short" }, { clientNonce: "!!!!!!!!!!!!!!!!!!!!!!" }, { clientNonce: randomBytes(65).toString("base64url") }, { clientNonce: createClientNonce(), code: "ABCD-EFGH" }]) {
    const r = handlePairProof(body, { ...ctx, limiter: createProofLimiter() });
    assert.equal(r.status, 400, JSON.stringify(body));
    assert.equal((r.body as { code: string }).code, "bad-request");
  }
  const late = handlePairProof({ clientNonce: createClientNonce() }, { ...ctx, now: T0 + 3_600_000, limiter: createProofLimiter() });
  assert.equal(late.status, 404);
  assert.equal((late.body as { code: string }).code, "no-open-code");
  const empty = handlePairProof({ clientNonce: createClientNonce() }, { ...ctx, store: new PairCodeStore({ params: LIGHT }), limiter: createProofLimiter() });
  assert.equal(empty.status, 404);
  assert.equal(store.open(T0).length, 1, "answering never consumes a code");
});

test("with several open codes the newest one answers", () => {
  const store = new PairCodeStore({ params: LIGHT });
  store.issue(T0);
  const newest = store.issue(T0 + 10);
  const clientNonce = createClientNonce();
  const body = ok(handlePairProof({ clientNonce }, { store, now: T0 + 20, origin: ORIGIN, servedFingerprint: REAL_FP, source: "s", limiter: createProofLimiter() }));
  assert.equal(verifyPairProof({ code: newest.code, response: body, fingerprintSeen: REAL_FP, origin: ORIGIN, clientNonce, params: LIGHT }).ok, true);
});

test("rate limits: per source, and per open code across sources", () => {
  const { ctx } = setup({ limiter: createProofLimiter({ perSourceMax: 3, perSourceWindowMs: 60_000, perCodeMax: 5, perCodeWindowMs: 3_600_000 }) });
  const go = (source: string, now = ctx.now) => handlePairProof({ clientNonce: createClientNonce() }, { ...ctx, source, now });
  assert.equal(go("a").status, 200);
  assert.equal(go("a").status, 200);
  assert.equal(go("a").status, 200);
  const blocked = go("a");
  assert.equal(blocked.status, 429);
  assert.ok(((blocked.body as { retryAfterMs: number }).retryAfterMs) > 0);
  assert.equal(go("b").status, 200, "another source is unaffected");
  assert.equal(go("a", ctx.now + 61_000).status, 200, "the window slides");
  // 3 + 1 + 1 = 5 answered for this code so far; the sixth, from a fresh source, hits the per-code cap
  assert.equal(go("c", ctx.now + 61_000).status, 429);
});

test("SlidingWindowLimiter: counts inside the window only and forgets idle keys", () => {
  const l = new SlidingWindowLimiter({ max: 2, windowMs: 1000 });
  assert.equal(l.hit("k", 0).allowed, true);
  assert.equal(l.hit("k", 100).allowed, true);
  const d = l.hit("k", 200);
  assert.deepEqual(d, { allowed: false, retryAfterMs: 800 });
  assert.equal(l.hit("k", 1001).allowed, true, "first hit left the window");
  assert.equal(l.hit("other", 200).allowed, true);
  l.sweep(10_000);
  assert.equal(l.size(), 0);
  assert.throws(() => new SlidingWindowLimiter({ max: 0, windowMs: 1000 }), /max/);
});
