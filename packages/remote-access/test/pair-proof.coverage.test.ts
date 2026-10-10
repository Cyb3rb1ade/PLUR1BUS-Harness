import { test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { DEFAULT_ARGON2, PairCodeStore, deriveKey } from "../src/pair-code.ts";
import type { Argon2Params } from "../src/pair-code.ts";
import { createClientNonce, createProofLimiter, handlePairProof, proofInput, verifyPairProof } from "../src/pair-proof.ts";
import type { PairProofContext, PairProofResponse } from "../src/pair-proof.ts";
import { pinOf } from "../src/fingerprint.ts";

// Coverage for the pair-proof edges the existing suite does not reach: nonce length boundaries and non-canonical
// base64url, fingerprint and CA-pin shape checks in the handler, the byte layout and guards of proofInput(), hostile
// input to verifyPairProof() (which must answer ok:false and never throw), the injected derive/params seams, the
// default rate-limit numbers, and the client nonce format.

const LIGHT: Argon2Params = { memoryKiB: 64, passes: 1, parallelism: 1 };
const T0 = 1_700_000_000_000;
const ORIGIN = "https://192.168.1.20:18701";
const REAL_FP = pinOf(Buffer.from("the harness leaf certificate"));
const REAL_FP_BYTES = Buffer.from(REAL_FP.slice("sha256:".length), "base64url");
const CA = pinOf(Buffer.from("company root"));
const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

function setup(over: Partial<PairProofContext> = {}) {
  const store = new PairCodeStore({ params: LIGHT });
  const issued = store.issue(T0);
  const ctx: PairProofContext = {
    store, now: T0 + 1000, origin: ORIGIN, servedFingerprint: REAL_FP, source: "192.168.1.77",
    limiter: createProofLimiter({ perSourceMax: 1000, perCodeMax: 1000 }), ...over,
  };
  return { store, issued, ctx };
}
const nonceOf = (n: number) => randomBytes(n).toString("base64url");
const statusOf = (r: ReturnType<typeof handlePairProof>) => r.status;
const codeOf = (r: ReturnType<typeof handlePairProof>) => (r.body as { code: string }).code;

// --- nonce shape at the handler ----------------------------------------------------------------------------------------

test("clientNonce length: 15 bytes is refused, 16 and 64 bytes are accepted, 65 is refused", () => {
  const { ctx } = setup();
  assert.equal(statusOf(handlePairProof({ clientNonce: nonceOf(15) }, ctx)), 400);
  assert.equal(statusOf(handlePairProof({ clientNonce: nonceOf(16) }, ctx)), 200);
  assert.equal(statusOf(handlePairProof({ clientNonce: nonceOf(64) }, ctx)), 200);
  assert.equal(statusOf(handlePairProof({ clientNonce: nonceOf(65) }, ctx)), 400);
  assert.equal(codeOf(handlePairProof({ clientNonce: nonceOf(15) }, ctx)), "bad-request");
});

test("clientNonce spelling: padding, the standard alphabet and non-string values are refused", () => {
  const { ctx } = setup();
  const padded = randomBytes(16).toString("base64url") + "==";
  for (const bad of [padded, "A".repeat(20) + " ", "a+b/" + "c".repeat(20), "", 16, null, ["x"]]) {
    assert.equal(statusOf(handlePairProof({ clientNonce: bad as never }, ctx)), 400, JSON.stringify(bad));
  }
});

test("clientNonce: a non-canonical spelling of the same bytes is refused (only the canonical form is accepted)", () => {
  const { ctx } = setup();
  const canonical = nonceOf(16); // 22 characters: the last one carries 2 data bits and 4 padding bits
  const idx = ALPHABET.indexOf(canonical.charAt(21));
  const alias = canonical.slice(0, 21) + ALPHABET.charAt(idx ^ 1);
  assert.deepEqual(Buffer.from(alias, "base64url"), Buffer.from(canonical, "base64url"), "same decoded bytes");
  assert.notEqual(alias, canonical);
  assert.equal(statusOf(handlePairProof({ clientNonce: alias }, ctx)), 400);
  assert.equal(statusOf(handlePairProof({ clientNonce: canonical }, ctx)), 200);
});

test("bodies that are arrays, or objects with the nonce under another key, are refused", () => {
  const { ctx } = setup();
  for (const body of [[], [{ clientNonce: createClientNonce() }], { nonce: createClientNonce() }]) {
    const r = handlePairProof(body, ctx);
    assert.equal(r.status, 400, JSON.stringify(body));
    assert.equal(codeOf(r), "bad-request");
  }
});

// --- the served fingerprint and the CA pin at the handler ----------------------------------------------------------------

test("servedFingerprint: a pin string, or the same 32 bytes, both work; anything else throws instead of answering", () => {
  const nonce = createClientNonce();
  const fromPin = handlePairProof({ clientNonce: nonce }, setup({ servedFingerprint: REAL_FP }).ctx);
  const fromBytes = handlePairProof({ clientNonce: nonce }, setup({ servedFingerprint: Uint8Array.from(REAL_FP_BYTES) }).ctx);
  assert.equal(statusOf(fromPin), 200);
  assert.equal(statusOf(fromBytes), 200);
  // the bytes answer is verifiable against the pin the client computes from what it saw
  const { issued, ctx } = setup({ servedFingerprint: Uint8Array.from(REAL_FP_BYTES) });
  const body = handlePairProof({ clientNonce: nonce }, ctx).body as PairProofResponse;
  assert.deepEqual(verifyPairProof({ code: issued.code, response: body, fingerprintSeen: REAL_FP, origin: ORIGIN, clientNonce: nonce, params: LIGHT }), { ok: true });

  for (const bad of ["sha256:tooShort", "md5:abc", Uint8Array.from(randomBytes(31)), Uint8Array.from(randomBytes(33))]) {
    assert.throws(() => handlePairProof({ clientNonce: nonce }, setup({ servedFingerprint: bad as never }).ctx), /servedFingerprint must be a sha256 pin or 32 bytes/, String(bad));
  }
});

test("caPin: a malformed pin throws; a well-formed one is echoed in the response", () => {
  const nonce = createClientNonce();
  assert.throws(() => handlePairProof({ clientNonce: nonce }, setup({ caPin: "sha256:nope" as never }).ctx), /caPin is not a sha256 pin/);
  const r = handlePairProof({ clientNonce: nonce }, setup({ caPin: CA }).ctx);
  assert.equal((r.body as PairProofResponse).caPin, CA);
});

test("the handler's answer is a fresh server nonce every time and never the code", () => {
  const { issued, ctx } = setup();
  const nonce = createClientNonce();
  const a = handlePairProof({ clientNonce: nonce }, ctx).body as PairProofResponse;
  const b = handlePairProof({ clientNonce: nonce }, ctx).body as PairProofResponse;
  assert.notEqual(a.serverNonce, b.serverNonce);
  assert.notEqual(a.proof, b.proof);
  assert.equal(a.salt, b.salt, "the salt is fixed for one code");
  assert.equal(JSON.stringify([a, b]).includes(issued.code.replace("-", "")), false);
});

// --- proofInput: layout and guards -------------------------------------------------------------------------------------

test("proofInput: fixed layout, length-prefixed origin (UTF-8 bytes) and nonces, optional CA pin with a presence byte", () => {
  const fp = Buffer.alloc(32, 1);
  const cn = Buffer.alloc(16, 2);
  const sn = Buffer.alloc(16, 3);
  const origin = "https://ü.example";
  const originBytes = Buffer.byteLength(origin, "utf8");
  const plain = proofInput({ fp, origin, clientNonce: cn, serverNonce: sn });
  assert.equal(plain.length, 16 + 32 + 1 + 2 + originBytes + 1 + 16 + 1 + 16);
  assert.equal(plain.subarray(0, 16).toString("ascii"), "plur1bus-pair-v1");
  assert.equal(plain.subarray(48, 49).readUInt8(0), 0, "no CA pin: presence byte 0");
  assert.equal(plain.readUInt16BE(49), originBytes, "origin length counts bytes, not characters");
  const withCa = proofInput({ fp, origin, clientNonce: cn, serverNonce: sn, caPin: Buffer.alloc(32, 9) });
  assert.equal(withCa.length, plain.length + 32);
  assert.equal(withCa.subarray(48, 49).readUInt8(0), 1);
  assert.notDeepEqual(withCa, plain);
});

test("proofInput: the longest origin and the longest nonces are accepted; one byte more is refused", () => {
  const fp = Buffer.alloc(32);
  const nonce = Buffer.alloc(255);
  assert.doesNotThrow(() => proofInput({ fp, origin: "a".repeat(0xffff), clientNonce: nonce, serverNonce: nonce }));
  assert.throws(() => proofInput({ fp, origin: "a".repeat(0x10000), clientNonce: nonce, serverNonce: nonce }), /field too long/);
  assert.throws(() => proofInput({ fp, origin: "x", clientNonce: Buffer.alloc(256), serverNonce: nonce }), /field too long/);
  assert.throws(() => proofInput({ fp, origin: "x", clientNonce: nonce, serverNonce: Buffer.alloc(256) }), /field too long/);
});

test("proofInput: a fingerprint or CA pin that is not 32 bytes is refused", () => {
  const n = Buffer.alloc(16);
  assert.throws(() => proofInput({ fp: Buffer.alloc(31), origin: "x", clientNonce: n, serverNonce: n }), /fingerprint must be 32 bytes/);
  assert.throws(() => proofInput({ fp: Buffer.alloc(32), origin: "x", clientNonce: n, serverNonce: n, caPin: Buffer.alloc(33) }), /caPin must be 32 bytes/);
});

// --- verifyPairProof: hostile input never throws -----------------------------------------------------------------------

test("verifyPairProof: every malformed input answers ok:false and does not throw", () => {
  const { issued, ctx } = setup();
  const clientNonce = createClientNonce();
  const body = handlePairProof({ clientNonce }, ctx).body as PairProofResponse;
  const base = { code: issued.code, response: body, fingerprintSeen: REAL_FP, origin: ORIGIN, clientNonce, params: LIGHT };
  const cases: Array<[string, unknown]> = [
    ["empty code", { ...base, code: "" }],
    ["short code", { ...base, code: "ABCD" }],
    ["fingerprint of 31 bytes", { ...base, fingerprintSeen: Uint8Array.from(randomBytes(31)) }],
    ["fingerprint that is not a pin", { ...base, fingerprintSeen: "sha256:nope" }],
    ["nonce too short", { ...base, clientNonce: nonceOf(15) }],
    ["nonce not base64url", { ...base, clientNonce: "not/base64" }],
    ["response undefined", { ...base, response: undefined }],
    ["response null", { ...base, response: null }],
    ["response a string", { ...base, response: "proof" }],
    ["salt is a number", { ...base, response: { ...body, salt: 5 } }],
    ["salt under 8 bytes", { ...base, response: { ...body, salt: nonceOf(7) } }],
    ["server nonce under 8 bytes", { ...base, response: { ...body, serverNonce: nonceOf(7) } }],
    ["server nonce over 64 bytes", { ...base, response: { ...body, serverNonce: nonceOf(65) } }],
    ["proof of 31 bytes", { ...base, response: { ...body, proof: nonceOf(31) } }],
    ["proof is a number", { ...base, response: { ...body, proof: 1 } }],
    ["CA pin that is not a pin", { ...base, response: { ...body, caPin: "sha256:nope" } }],
  ];
  for (const [label, input] of cases) {
    let result: unknown;
    assert.doesNotThrow(() => { result = verifyPairProof(input as never); }, label);
    assert.deepEqual(result, { ok: false }, label);
  }
});

test("verifyPairProof: the injected derive and params are used; the defaults are DEFAULT_ARGON2", () => {
  const { issued, ctx } = setup();
  const clientNonce = createClientNonce();
  const body = handlePairProof({ clientNonce }, ctx).body as PairProofResponse;
  const seen: Array<{ code: string; salt: Buffer; params: Argon2Params }> = [];
  const real = (code: string, salt: Uint8Array, params: Argon2Params) => {
    seen.push({ code, salt: Buffer.from(salt), params });
    return deriveKey(code, salt, params);
  };
  const r = verifyPairProof({ code: issued.code.toLowerCase(), response: body, fingerprintSeen: REAL_FP, origin: ORIGIN, clientNonce, params: LIGHT, derive: real });
  assert.deepEqual(r, { ok: true });
  assert.equal(seen.length, 1);
  assert.equal(seen[0]?.code, issued.code.replace("-", ""), "the code is normalised before derivation");
  assert.deepEqual(seen[0]?.params, LIGHT);
  assert.deepEqual(seen[0]?.salt, Buffer.from(body.salt, "base64url"));

  // no params given: the default cost is used. A stub key keeps the test cheap; the answer is then (correctly) a mismatch.
  const stub: Array<Argon2Params> = [];
  const r2 = verifyPairProof({ code: issued.code, response: body, fingerprintSeen: REAL_FP, origin: ORIGIN, clientNonce, derive: (_c, _s, p) => { stub.push(p); return Buffer.alloc(32); } });
  assert.deepEqual(r2, { ok: false });
  assert.deepEqual(stub, [DEFAULT_ARGON2]);
});

// --- rate limits and the client nonce ----------------------------------------------------------------------------------------

test("default rate limits: 10 proofs per source in a minute, 60 per open code in an hour", () => {
  const store = new PairCodeStore({ params: LIGHT });
  store.issue(T0);
  const base: PairProofContext = {
    store, now: T0 + 1000, origin: ORIGIN, servedFingerprint: REAL_FP, source: "one", limiter: createProofLimiter(),
  };
  for (let i = 0; i < 10; i++) assert.equal(statusOf(handlePairProof({ clientNonce: createClientNonce() }, base)), 200, `hit ${i + 1}`);
  const blockedSource = handlePairProof({ clientNonce: createClientNonce() }, base);
  assert.equal(statusOf(blockedSource), 429);
  assert.equal(codeOf(blockedSource), "rate-limited");
  assert.ok((blockedSource.body as { retryAfterMs?: number }).retryAfterMs! > 0);

  // 10 proofs were answered above; 50 more from other sources reach the per-code cap of 60, the next one is refused
  for (let i = 0; i < 50; i++) {
    assert.equal(statusOf(handlePairProof({ clientNonce: createClientNonce() }, { ...base, source: `s${i}` })), 200, `source ${i}`);
  }
  const blockedCode = handlePairProof({ clientNonce: createClientNonce() }, { ...base, source: "fresh" });
  assert.equal(statusOf(blockedCode), 429);
  assert.equal(codeOf(blockedCode), "rate-limited");
  assert.match((blockedCode.body as { message: string }).message, /open pairing code/);
});

test("createClientNonce: 16 random bytes in base64url (22 characters), different every time", () => {
  const seen = new Set<string>();
  for (let i = 0; i < 5; i++) {
    const n = createClientNonce();
    assert.match(n, /^[A-Za-z0-9_-]{22}$/);
    assert.equal(Buffer.from(n, "base64url").length, 16);
    seen.add(n);
  }
  assert.equal(seen.size, 5);
});
