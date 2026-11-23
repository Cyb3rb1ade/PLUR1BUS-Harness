import { createPrivateKey, createPublicKey, sign } from "node:crypto";
import { fileURLToPath } from "node:url";
import { CatalogError } from "../../packages/core/src/catalog/types.ts";
import { parseRoot, verifyEnvelope } from "../../packages/core/src/catalog/verify.ts";
import { exporterMain } from "./lib.mjs";

export function testKey(byte: number) {
  // Standard PKCS#8 envelope around repeat-byte seeds used only by this fixture.
  const prefix = Buffer.from("302e020100300506032b657004220420", "hex");
  const key = createPrivateKey({ key: Buffer.concat([prefix, Buffer.alloc(32, byte)]), format: "der", type: "pkcs8" });
  const publicKey = createPublicKey(key).export({ format: "der", type: "spki" }).subarray(-32);
  return { key, publicKey: publicKey.toString("base64") };
}

export function recordCatalogTrust() {
  const now = Date.parse("2026-11-22T13:00:00Z");
  const keys = [testKey(1), testKey(2)];
  const ids = ["fixture-a", "fixture-b"];
  const expires = "2027-01-01T00:00:00Z";
  const payload = '{"serial":1,"label":"offline fixture"}';
  const vectors = [];
  for (const test of [
    { name: "ordinary threshold", signers: [0, 1] },
    { name: "duplicate signer counts once", signers: [0, 0] },
    { name: "key expired", signers: [0, 1], expired: true },
    { name: "revoked signatory", signers: [0, 1], revoked: ["fixture-b"] },
    { name: "unknown additional signer", signers: [0, 1, 2] },
    { name: "root expiration", signers: [0, 1], oldRoot: true },
  ]) {
    const root = parseRoot({
      type: "root", version: 1, threshold: 2,
      expires: test.oldRoot ? "2026-11-20T00:00:00Z" : expires,
      keys: keys.map(({ publicKey }, i) => ({
        id: ids[i], publicKey,
        expires: test.expired && i === 1 ? "2026-11-20T00:00:00Z" : expires,
      })),
    });
    const bytes = Buffer.from(payload);
    const signatures = test.signers.map(i => ({
      keyId: ids[i] ?? "unknown-fixture",
      signature: sign(null, bytes, keys[i % keys.length]!.key).toString("base64"),
    }));
    let expected;
    try {
      const checked = verifyEnvelope({ payload: bytes.toString("base64"), signatures }, root, now, new Set(test.revoked));
      expected = {
        signers: checked.signers, ignored: checked.ignored.map(({ keyId, code }) => ({ keyId, code })),
        bytes: checked.bytes.toString(),
      };
    } catch (error) {
      if (!(error instanceof CatalogError)) throw error;
      expected = { code: error.code };
    }
    vectors.push({ ...test, now, expires, payload, expected });
  }
  return { trust: { source: "packages/core/src/catalog/verify.ts", cases: vectors } };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  process.exitCode = await exporterMain({ area: "discovery", build: recordCatalogTrust });
}
