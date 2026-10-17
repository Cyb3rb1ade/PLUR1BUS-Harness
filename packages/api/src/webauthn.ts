/** A deliberately small WebAuthn verifier: definite-length CBOR, ES256/Ed25519, none or packed self attestation. */
import { createHash, createPublicKey, timingSafeEqual, verify, type KeyObject } from "node:crypto";
export class WebAuthnError extends Error { readonly reason: string; constructor(reason: string) { super(reason); this.reason = reason; } }
const reject = (reason = "invalid-webauthn"): never => { throw new WebAuthnError(reason); };
export type Cbor = number | string | Buffer | boolean | null | Cbor[] | Map<Cbor, Cbor>;
export function decodeCbor(data: Buffer, start = 0): { value: Cbor; end: number } {
  if (!Number.isSafeInteger(start) || start < 0 || start >= data.length || data.length > 16384) reject("cbor-size");
  let at = start, items = 0;
  function read(depth: number): Cbor {
    if (depth > 8 || ++items > 256 || at >= data.length) reject("cbor-bounds");
    const tag = data[at++]!, major = tag >> 5, extra = tag & 31;
    let n = extra;
    if (extra >= 24) {
      const bytes = extra === 24 ? 1 : extra === 25 ? 2 : extra === 26 ? 4 : 0;
      if (!bytes || at + bytes > data.length) reject("cbor-length");
      n = data.readUIntBE(at, bytes); at += bytes;
      if (n < (bytes === 1 ? 24 : bytes === 2 ? 256 : 65536)) reject("cbor-noncanonical");
    }
    if (major === 0) return n;
    if (major === 1) return -1 - n;
    if (major === 2 || major === 3) {
      if (n > 8192 || at + n > data.length) reject("cbor-length");
      const b = data.subarray(at, at += n);
      return major === 2 ? b : new TextDecoder("utf-8", { fatal: true }).decode(b);
    }
    if (major === 4) { if (n > 64) reject("cbor-items"); return Array.from({ length: n }, () => read(depth + 1)); }
    if (major === 5) {
      if (n > 32) reject("cbor-items"); const map = new Map<Cbor, Cbor>();
      for (let j = 0; j < n; j++) { const key = read(depth + 1); if (typeof key !== "number" && typeof key !== "string" || map.has(key)) reject("cbor-key"); map.set(key, read(depth + 1)); } return map;
    }
    if (major === 7 && extra === 20) return false;
    if (major === 7 && extra === 21) return true;
    if (major === 7 && extra === 22) return null;
    return reject("cbor-type");
  }
  try { const value = read(0); return { value, end: at }; } catch (e) { if (e instanceof WebAuthnError) throw e; return reject("cbor-invalid"); }
}
export function base64url(value: unknown, max = 16384): Buffer {
  if (typeof value !== "string" || !value.length || value.length > max * 2 || !/^[A-Za-z0-9_-]+$/.test(value)) reject();
  const result = Buffer.from(value as string, "base64url"); if (result.length > max || result.toString("base64url") !== value) reject(); return result;
}
const hash = (b: Buffer | string) => createHash("sha256").update(b).digest();
function equal(a: Buffer, b: Buffer): boolean { return a.length === b.length && timingSafeEqual(a, b); }
export function coseKey(bytes: Buffer): { key: KeyObject; algorithm: -7 | -8 } {
  const parsed = decodeCbor(bytes); if (parsed.end !== bytes.length || !(parsed.value instanceof Map)) reject("cose-key");
  const m = parsed.value as Map<Cbor, Cbor>; const alg = m.get(3);
  let jwk: { kty: string; crv: string; x: string; y?: string };
  const x = m.get(-2); if (!Buffer.isBuffer(x) || x.length !== 32) reject("cose-coordinate");
  if (alg === -7 && m.get(1) === 2 && m.get(-1) === 1) {
    const y = m.get(-3); if (!Buffer.isBuffer(y) || y.length !== 32) reject("cose-coordinate"); jwk = { kty: "EC", crv: "P-256", x: (x as Buffer).toString("base64url"), y: (y as Buffer).toString("base64url") };
  } else if (alg === -8 && m.get(1) === 1 && m.get(-1) === 6) jwk = { kty: "OKP", crv: "Ed25519", x: (x as Buffer).toString("base64url") };
  else return reject("cose-algorithm");
  try { return { key: createPublicKey({ key: jwk, format: "jwk" }), algorithm: alg as -7 | -8 }; } catch { return reject("cose-key"); }
}
export interface WebAuthnContext { challenge: string; origin: string; rpId: string }
export interface CredentialResponse { id: string; clientDataJSON: string; authenticatorData?: string; signature?: string; attestationObject?: string }
function client(value: string, type: string, c: WebAuthnContext): Buffer {
  const raw = base64url(value, 4096); let p: Record<string, unknown>;
  try { p = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(raw)) as Record<string, unknown>; } catch { return reject("client-data"); }
  if (!p || typeof p !== "object" || Array.isArray(p)) reject("client-data");
  if (p.type !== type || p.origin !== c.origin || p.challenge !== c.challenge || (p.crossOrigin !== undefined && p.crossOrigin !== false) || p.topOrigin !== undefined) reject("client-binding"); return hash(raw);
}
function authenticator(raw: Buffer, c: WebAuthnContext, registration: boolean): number {
  if (raw.length < 37 || !equal(raw.subarray(0, 32), hash(c.rpId))) reject("rp-id");
  const flags = raw[32]!;
  // User verification is mandatory; reject reserved bits and unsupported extension data.
  if (!(flags & 1) || !(flags & 4) || flags & 0xa2 || !!(flags & 0x40) !== registration || flags & 0x10 && !(flags & 8)) reject("authenticator-flags");
  if (!registration && raw.length !== 37) reject("authenticator-length"); return raw.readUInt32BE(33);
}
export function registerCredential(r: CredentialResponse, c: WebAuthnContext): { id: string; publicKey: string; signCount: number } {
  const clientHash = client(r.clientDataJSON, "webauthn.create", c), decoded = decodeCbor(base64url(r.attestationObject));
  const m = decoded.value; if (!(m instanceof Map) || decoded.end !== base64url(r.attestationObject).length) reject("attestation");
  const raw = (m as Map<Cbor, Cbor>).get("authData"); if (!Buffer.isBuffer(raw)) reject("attestation");
  const auth = raw as Buffer, signCount = authenticator(auth, c, true);
  if (auth.length < 55) reject("attested-data"); const size = auth.readUInt16BE(53); if (!size || size > 1024 || 55 + size >= auth.length) reject("credential-id");
  const id = auth.subarray(55, 55 + size).toString("base64url"); if (id !== r.id) reject("credential-id");
  const publicKey = auth.subarray(55 + size); const key = coseKey(publicKey);
  const fmt = (m as Map<Cbor, Cbor>).get("fmt"), statement = (m as Map<Cbor, Cbor>).get("attStmt"); if (!(statement instanceof Map)) reject("attestation");
  if (fmt === "none") { if ((statement as Map<Cbor, Cbor>).size !== 0) reject("attestation"); }
  else if (fmt === "packed") { const s = statement as Map<Cbor, Cbor>, signature = s.get("sig"); if (s.size !== 2 || s.get("alg") !== key.algorithm || !Buffer.isBuffer(signature) || !verify(key.algorithm === -7 ? "sha256" : null, Buffer.concat([auth, clientHash]), key.key, signature as Buffer)) reject("attestation-signature"); }
  else reject("attestation-format");
  return { id, publicKey: publicKey.toString("base64url"), signCount };
}
export function assertCredential(r: CredentialResponse, c: WebAuthnContext, stored: { id: string; publicKey: string; signCount: number }): number {
  if (r.id !== stored.id) reject("credential-id"); const clientHash = client(r.clientDataJSON, "webauthn.get", c), auth = base64url(r.authenticatorData), signCount = authenticator(auth, c, false), key = coseKey(base64url(stored.publicKey));
  if (!verify(key.algorithm === -7 ? "sha256" : null, Buffer.concat([auth, clientHash]), key.key, base64url(r.signature, 128))) reject("assertion-signature");
  if ((stored.signCount !== 0 || signCount !== 0) && signCount <= stored.signCount) reject("credential-clone");
  return signCount;
}
