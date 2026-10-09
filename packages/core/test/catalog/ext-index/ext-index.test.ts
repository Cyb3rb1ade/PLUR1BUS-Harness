// #162's crypto/shape regressions; client attack scenarios now exercise the upgraded #162 entry point in ../trust.test.ts.
import { it } from "node:test";
import assert from "node:assert/strict";
import { sign } from "node:crypto";
import { importKeys, parseIndex, verifySignature, ExtIndexError } from "../../../src/catalog/ext-index/index.ts";
import { key, index } from "../signing.ts";

it("verifies the supplied bytes before parsing and reports the trusted signing key", () => {
  const a = key("one"), b = key("two");
  const bytes = Buffer.from(JSON.stringify(index(), null, 2) + "\n");
  const signature = sign(null, bytes, a.privateKey).toString("base64");
  assert.equal(verifySignature(bytes, signature, importKeys({ one: a.publicKey, two: b.publicKey })), "one");
  assert.throws(() => verifySignature(Buffer.from(JSON.stringify(index())), signature, importKeys({ one: a.publicKey })), { code: "signature-invalid" });
  assert.throws(() => verifySignature(bytes, signature, importKeys({ two: b.publicKey })), { code: "signature-invalid" });
});
it("rejects empty trust and invalid configured keys and signatures", () => {
  const a = key("one"); const keys = importKeys({ one: a.publicKey });
  assert.throws(() => importKeys({}), { code: "no-trusted-key" });
  assert.throws(() => importKeys({ one: "AAAA" }), { code: "invalid-config" });
  for (const sig of ["bad!!", Buffer.alloc(10).toString("base64")]) assert.throws(() => verifySignature(Buffer.from("x"), sig, keys), { code: "signature-invalid" });
});
it("retains #162's package schema validation for every security-relevant field", () => {
  const base = index(); const p = base.packages[0]!; const v = p.versions[0]!;
  const bad = [
    { ...base, serial: -1 }, { ...base, serial: 1.5 }, { ...base, expires: "soon" }, { ...base, packages: "x" },
    { ...base, packages: [p, p] },
    ...[{ url: "http://x/package" }, { sha256: "ABC" }, { size: 0 }, { size: 1.1 }, { version: "" }].map((change) => ({ ...base, packages: [{ ...p, versions: [{ ...v, ...change }] }] })),
  ];
  for (const doc of bad) assert.throws(() => parseIndex(Buffer.from(JSON.stringify(doc))), (e: unknown) => e instanceof ExtIndexError && e.code === "malformed");
  assert.throws(() => parseIndex(Buffer.from(JSON.stringify({ ...base, format: 2 }))), { code: "unsupported-format" });
  assert.throws(() => parseIndex(Buffer.from("not JSON")), { code: "malformed" });
  assert.equal(parseIndex(Buffer.from(JSON.stringify(base))).index.serial, 1);
});
