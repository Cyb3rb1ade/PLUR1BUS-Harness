import { generateKeyPairSync, randomBytes, createHash, sign } from "node:crypto";
export function cbor(v: unknown): Buffer {
  const head = (type: number, n: number) => n < 24 ? Buffer.from([type * 32 + n]) : n < 256 ? Buffer.from([type * 32 + 24, n]) : Buffer.from([type * 32 + 25, n >> 8, n & 255]);
  if (typeof v === "number") return head(v < 0 ? 1 : 0, v < 0 ? -1 - v : v);
  if (typeof v === "string") { const b = Buffer.from(v); return Buffer.concat([head(3, b.length), b]); }
  if (Buffer.isBuffer(v)) return Buffer.concat([head(2, v.length), v]);
  if (v instanceof Map) return Buffer.concat([head(5, v.size), ...[...v].flatMap(([k, x]) => [cbor(k), cbor(x)])]);
  throw new Error("fixture type");
}
export function vector(algorithm: -7 | -8 = -7, origin = "https://harness.example") {
  const pair = algorithm === -7 ? generateKeyPairSync("ec", { namedCurve: "prime256v1" }) : generateKeyPairSync("ed25519");
  const jwk = pair.publicKey.export({ format: "jwk" }), credentialId = randomBytes(32), challenge = randomBytes(32).toString("base64url");
  const map = new Map<number, unknown>([[1, algorithm === -7 ? 2 : 1], [3, algorithm], [-1, algorithm === -7 ? 1 : 6], [-2, Buffer.from(jwk.x!, "base64url")]]); if (jwk.y) map.set(-3, Buffer.from(jwk.y, "base64url"));
  const key = cbor(map), context = { challenge, origin, rpId: new URL(origin).hostname };
  const hash = (s: string | Buffer) => createHash("sha256").update(s).digest();
  const client = (type: string) => Buffer.from(JSON.stringify({ type, challenge: context.challenge, origin: context.origin, crossOrigin: false }));
  const auth = (registration: boolean, count: number) => { const b = Buffer.alloc(37); hash(context.rpId).copy(b); b[32] = registration ? 0x45 : 5; b.writeUInt32BE(count, 33); if (!registration) return b; const length = Buffer.alloc(2); length.writeUInt16BE(credentialId.length); return Buffer.concat([b, Buffer.alloc(16), length, credentialId, key]); };
  const data = auth(true, 1), cd = client("webauthn.create");
  const att = cbor(new Map<string, unknown>([["fmt", "packed"], ["authData", data], ["attStmt", new Map<string, unknown>([["alg", algorithm], ["sig", sign(algorithm === -7 ? "sha256" : null, Buffer.concat([data, hash(cd)]), pair.privateKey)]])]]));
  const registration = { id: credentialId.toString("base64url"), clientDataJSON: cd.toString("base64url"), attestationObject: att.toString("base64url") };
  const assertion = (count = 2) => { const raw = auth(false, count), c = client("webauthn.get"); return { id: registration.id, clientDataJSON: c.toString("base64url"), authenticatorData: raw.toString("base64url"), signature: sign(algorithm === -7 ? "sha256" : null, Buffer.concat([raw, hash(c)]), pair.privateKey).toString("base64url") }; };
  return { context, get registration() {
    const cd = client("webauthn.create"), data = auth(true, 1);
    const att = cbor(new Map<string, unknown>([["fmt", "packed"], ["authData", data], ["attStmt", new Map<string, unknown>([["alg", algorithm], ["sig", sign(algorithm === -7 ? "sha256" : null, Buffer.concat([data, hash(cd)]), pair.privateKey)]])]]));
    return { ...registration, clientDataJSON: cd.toString("base64url"), attestationObject: att.toString("base64url") };
  }, assertion, key };
}
