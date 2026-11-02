import { canonicalizeAgentCard, type AgentCard } from "@a2a-js/sdk";
import { createHash, createPublicKey, verify, type KeyObject } from "node:crypto";
import { A2aPeerError } from "./peer-error.ts";

export interface PeerPublicKey { kty: "OKP"; crv: "Ed25519"; x: string }
export interface VerifiedPeerCard { endpoint: string; fingerprint: string; kid: string }

const object = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);
const INVALID_KEYS = new Set(["__proto__", "prototype", "constructor"]);
const signatureFailure = (): never => { throw new A2aPeerError("card-signature"); };

function decode(raw: unknown, maxBytes: number, exactBytes?: number): Buffer {
  if (typeof raw !== "string" || !/^[A-Za-z0-9_-]+$/.test(raw) || raw.length > Math.ceil(maxBytes * 4 / 3)) throw new Error("invalid encoding");
  const bytes = Buffer.from(raw, "base64url");
  if (bytes.toString("base64url") !== raw || bytes.length > maxBytes || (exactBytes !== undefined && bytes.length !== exactBytes)) throw new Error("invalid encoding");
  return bytes;
}

function publicKey(value: unknown): { jwk: PeerPublicKey; key: KeyObject } {
  try {
    if (!object(value) || Object.keys(value).some(k => !["kty", "crv", "x"].includes(k)) || value.kty !== "OKP" || value.crv !== "Ed25519") throw new Error("invalid key");
    decode(value.x, 32, 32);
    const jwk: PeerPublicKey = { kty: "OKP", crv: "Ed25519", x: value.x as string };
    const key = createPublicKey({ key: { ...jwk }, format: "jwk" });
    if (key.asymmetricKeyType !== "ed25519") throw new Error("invalid key");
    return { jwk, key };
  } catch { throw new A2aPeerError("invalid-key"); }
}

/** RFC 7638 thumbprint: no display text, key id or representation-dependent PEM bytes. */
export function peerKeyFingerprint(value: unknown): string {
  const { jwk } = publicKey(value);
  return `sha256:${createHash("sha256").update(JSON.stringify({ crv: jwk.crv, kty: jwk.kty, x: jwk.x })).digest("base64url")}`;
}

function checkTree(value: unknown, state: { nodes: number }, depth = 0): void {
  if (++state.nodes > 8192 || depth > 16) signatureFailure();
  if (Array.isArray(value)) {
    if (value.length > 256) signatureFailure();
    for (const child of value) checkTree(child, state, depth + 1);
  } else if (object(value)) {
    const keys = Object.keys(value);
    if (keys.length > 128 || keys.some(k => INVALID_KEYS.has(k))) signatureFailure();
    for (const key of keys) checkTree(value[key], state, depth + 1);
  }
}

function endpointOf(card: Record<string, unknown>, cardUrl: string): string {
  const source = new URL(cardUrl);
  if (!["https:", "http:"].includes(source.protocol) || source.username || source.password || source.hash || source.search) signatureFailure();
  if (!Array.isArray(card.supportedInterfaces)) return signatureFailure();
  const endpoints = new Set<string>();
  for (const item of card.supportedInterfaces) {
    if (!object(item) || item.protocolBinding !== "JSONRPC" || item.protocolVersion !== "1.0" || typeof item.url !== "string") continue;
    const url = new URL(item.url);
    if (url.origin !== source.origin || url.username || url.password || url.hash || url.search) signatureFailure();
    endpoints.add(url.toString());
  }
  if (endpoints.size !== 1) signatureFailure();
  return [...endpoints][0]!;
}

/** Verify raw card data before parsing/using it; the SDK verifier logs failed signatures and is intentionally avoided. */
export function verifyPeerCard(raw: unknown, options: { key: unknown; kid: string; cardUrl: string }): VerifiedPeerCard {
  try {
    if (!object(raw) || typeof options.kid !== "string" || !options.kid || options.kid.length > 128) return signatureFailure();
    checkTree(raw, { nodes: 0 });
    if (!Array.isArray(raw.signatures) || raw.signatures.length < 1 || raw.signatures.length > 8) return signatureFailure();
    const { key, jwk } = publicKey(options.key);
    const payload = Buffer.from(canonicalizeAgentCard(raw as unknown as AgentCard)).toString("base64url");
    let valid = false;
    for (const entry of raw.signatures) {
      if (!object(entry)) continue;
      try {
        const header = JSON.parse(decode(entry.protected, 4096).toString("utf8"));
        if (!object(header) || !["EdDSA", "Ed25519"].includes(String(header.alg)) || header.kid !== options.kid || typeof header.typ !== "string" || !header.typ || header.crit !== undefined || header.b64 !== undefined) continue;
        if (entry.header !== undefined && (!object(entry.header) || Object.keys(entry.header).some(k => Object.hasOwn(header, k) || ["crit", "b64"].includes(k)))) continue;
        if (verify(null, Buffer.from(`${entry.protected as string}.${payload}`), key, decode(entry.signature, 64, 64))) { valid = true; break; }
      } catch { /* Try the next signature without logging the peer's entry or crypto error. */ }
    }
    if (!valid) signatureFailure();
    return { endpoint: endpointOf(raw, options.cardUrl), fingerprint: peerKeyFingerprint(jwk), kid: options.kid };
  } catch { return signatureFailure(); }
}
