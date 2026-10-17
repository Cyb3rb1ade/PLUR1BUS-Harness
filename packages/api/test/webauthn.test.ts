import { cbor, vector } from "./webauthn-vectors.ts";
import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { decodeCbor, coseKey, registerCredential, assertCredential, WebAuthnError } from "../src/webauthn.ts";
for (const algorithm of [-7, -8] as const) test(`cryptographic packed self attestation and assertion algorithm ${algorithm}`, () => {
  const v = vector(algorithm), stored = registerCredential(v.registration, v.context); assert.equal(assertCredential(v.assertion(), v.context, stored), 2);
  assert.throws(() => assertCredential(v.assertion(1), v.context, stored), { reason: "credential-clone" });
  assert.throws(() => registerCredential(v.registration, { ...v.context, origin: "https://wrong.example" }), { reason: "client-binding" });
  assert.throws(() => registerCredential(v.registration, { ...v.context, rpId: "wrong.example" }), { reason: "rp-id" });
  assert.throws(() => assertCredential({ ...v.assertion(), signature: randomBytes(64).toString("base64url") }, v.context, stored));
});
test("CBOR parser bounds and deterministic fuzz corpus never crash or hang", () => {
  for (const b of [Buffer.from([0x9f]), Buffer.from([0x5b]), Buffer.alloc(16385), Buffer.from([0xa2, 1, 1, 1, 2]), Buffer.from([0x5a, 0xff, 0xff, 0xff, 0xff]), Buffer.from([0x18, 0])]) assert.throws(() => decodeCbor(b), WebAuthnError);
  let seed = 0x1729; for (let n = 0; n < 5000; n++) { const b = Buffer.alloc(n % 130); for (let j = 0; j < b.length; j++) { seed = (seed * 1664525 + 1013904223) >>> 0; b[j] = seed & 255; } try { const parsed = decodeCbor(b); assert.ok(parsed.end <= b.length); } catch (e) { assert.ok(e instanceof WebAuthnError); } }
  assert.throws(() => decodeCbor(Buffer.from([...Array(9).fill(0x81), 0])), WebAuthnError);
  assert.throws(() => coseKey(cbor(new Map([[3, -257]]))), WebAuthnError);
});

test("RFC 8032 section 7.1 Ed25519 known public key decodes through COSE", () => {
  // Published public key, not an authentication credential: https://www.rfc-editor.org/rfc/rfc8032#section-7.1
  const publicKey = Buffer.from("d75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a", "hex");
  const key = coseKey(cbor(new Map<number, unknown>([[1, 1], [3, -8], [-1, 6], [-2, publicKey]])));
  assert.equal(key.algorithm, -8); assert.equal(key.key.export({ format: "jwk" }).x, publicKey.toString("base64url"));
});

test("clientData null, invalid UTF-8 and cross-origin values fail closed with controlled errors", () => {
  const v = vector();
  for (const raw of [Buffer.from("null"), Buffer.from([0xff]), Buffer.from(JSON.stringify({ type: "webauthn.get", origin: v.context.origin, challenge: v.context.challenge, crossOrigin: "false" }))]) {
    const stored = registerCredential(v.registration, v.context);
    assert.throws(() => assertCredential({ ...v.assertion(), clientDataJSON: raw.toString("base64url") }, v.context, stored), WebAuthnError);
  }
});
