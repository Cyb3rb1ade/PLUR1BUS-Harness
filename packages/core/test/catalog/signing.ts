import { generateKeyPairSync, sign, createHash } from "node:crypto";

export const NOW = Date.parse("2026-10-07T12:00:00Z");
export const EXPIRES = "2026-11-01T00:00:00Z";
export function key(id: string) {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const x = (publicKey.export({ format: "jwk" }) as { x: string }).x;
  return { id, privateKey, publicKey: Buffer.from(x, "base64url").toString("base64"), expires: "2027-01-01T00:00:00Z" };
}
export type TestKey = ReturnType<typeof key>;
export const hash = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
export function signed(value: unknown, keys: TestKey[]) {
  const bytes = typeof value === "string" ? Buffer.from(value) : Buffer.from(JSON.stringify(value));
  return { payload: bytes.toString("base64"), signatures: keys.map((k) => ({ keyId: k.id, signature: sign(null, bytes, k.privateKey).toString("base64") })) };
}
export function root(keys: TestKey[], version = 1, threshold = 1) {
  return { type: "root" as const, version, threshold, expires: "2027-01-01T00:00:00Z", keys: keys.map(({ id, publicKey, expires }) => ({ id, publicKey, expires })) };
}
export function index(serial = 1, artifact: Uint8Array = Buffer.from("package"), overrides: Record<string, unknown> = {}) {
  return { format: 1, serial, rootVersion: 1, generatedAt: "2026-10-07T00:00:00Z", expires: EXPIRES,
    revocation: { version: 1, sha256: "" },
    packages: [{ id: "owner/skill", kind: "skill", name: "skill", versions: [{ version: "1.0.0", url: "https://assets.test/skill.p1x", size: artifact.length, sha256: hash(artifact) }] }], ...overrides };
}
export function revocations(overrides: Record<string, unknown> = {}) {
  return { type: "revocations", version: 1, rootVersion: 1, expires: EXPIRES, keys: [], packages: [], ...overrides };
}
