import { createHash, verify } from "node:crypto";
import { importPublicKey, parseIndex } from "./ext-index/verify.ts";
import { CatalogError, type CatalogRoot, type SignedCatalogData, type CatalogRevocations, type CatalogIndex } from "./types.ts";

export const digest = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");
export const object = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
export const fail = (message: string): never => { throw new CatalogError("signature_invalid", message); };
export const integer = (v: unknown): v is number => Number.isSafeInteger(v) && Number(v) > 0;
export const timestamp = (v: unknown): number => {
  if (typeof v !== "string" || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{3})?Z$/.test(v) || !Number.isFinite(Date.parse(v))) return fail("invalid UTC timestamp");
  return Date.parse(v);
};
export function json(bytes: Uint8Array): unknown {
  try { return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); }
  catch { return fail("signed payload is not UTF-8 JSON"); }
}
function base64(v: unknown): Buffer {
  if (typeof v !== "string" || v.length === 0 || v.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(v)) return fail("invalid base64 encoding");
  const bytes = Buffer.from(v, "base64");
  if (bytes.toString("base64") !== v) return fail("non-canonical base64 encoding");
  return bytes;
}
export function envelope(v: unknown): SignedCatalogData {
  if (!object(v) || typeof v.payload !== "string" || !Array.isArray(v.signatures) || v.signatures.length > 64 || !v.signatures.every((s: unknown) => object(s) && typeof s.keyId === "string" && typeof s.signature === "string")) return fail("invalid signature envelope");
  return v as unknown as SignedCatalogData;
}
export function payload(e: SignedCatalogData): Buffer { return base64(e.payload); }
export function parseRoot(v: unknown): CatalogRoot {
  if (!object(v) || v.type !== "root" || !integer(v.version) || !Array.isArray(v.keys) || v.keys.length > 64) return fail("invalid trust root");
  const threshold = v.threshold ?? 1;
  if (!integer(threshold)) return fail("invalid threshold");
  if (!v.keys.length) throw new CatalogError("key_unknown", "no extension root keys provisioned");
  timestamp(v.expires);
  const ids = new Set<string>(); const material = new Set<string>();
  for (const k of v.keys) {
    if (!object(k) || typeof k.id !== "string" || !k.id || typeof k.publicKey !== "string") return fail("invalid root key");
    if (ids.has(k.id) || material.has(k.publicKey)) return fail("duplicate root key identity or material");
    if (base64(k.publicKey).length !== 32) return fail("root key must be raw 32-byte Ed25519");
    timestamp(k.expires); ids.add(k.id); material.add(k.publicKey);
  }
  if (threshold > ids.size) return fail("threshold exceeds number of keys");
  return { type: "root", version: v.version, threshold, expires: v.expires as string, keys: v.keys.map((k) => ({ id: k.id, publicKey: k.publicKey, expires: k.expires })) };
}
export function verifyEnvelope(raw: unknown, root: CatalogRoot, now: number, revoked: ReadonlySet<string> = new Set(), historical = false): { bytes: Buffer; signers: string[] } {
  const e = envelope(raw); const bytes = payload(e);
  if (!historical && timestamp(root.expires) <= now) throw new CatalogError("stale_index", "trust root expired; provision a fresh release root");
  const valid = new Set<string>();
  for (const s of e.signatures) {
    const k = root.keys.find((key) => key.id === s.keyId);
    if (!k) throw new CatalogError("key_unknown", `unknown signing key ${s.keyId}`);
    if (revoked.has(k.id)) throw new CatalogError("key_revoked", `signing key ${k.id} is revoked`);
    if (!historical && timestamp(k.expires) <= now) throw new CatalogError("signature_invalid", `signing key ${k.id} expired`);
    const sig = base64(s.signature);
    if (sig.length !== 64 || !verify(null, bytes, importPublicKey(k.id, k.publicKey), sig)) return fail(`invalid signature by ${k.id}`);
    valid.add(k.id);
  }
  if (valid.size < root.threshold) return fail(`need ${root.threshold} distinct trusted signatures, got ${valid.size}`);
  return { bytes, signers: [...valid] };
}
export function parseRevocations(bytes: Uint8Array): CatalogRevocations {
  const v = json(bytes);
  if (!object(v) || v.type !== "revocations" || !integer(v.version) || !integer(v.rootVersion) || !Array.isArray(v.keys) || !v.keys.every((k: unknown) => typeof k === "string" && k !== "") || new Set(v.keys).size !== v.keys.length || !Array.isArray(v.packages)) return fail("invalid revocation list");
  timestamp(v.expires);
  for (const p of v.packages) {
    if (!object(p) || typeof p.id !== "string" || !p.id || typeof p.reason !== "string" || !Array.isArray(p.versions) || !p.versions.length || !p.versions.every((s: unknown) => typeof s === "string" && s !== "")) return fail("invalid revoked package versions (exact versions required)");
  }
  return v as unknown as CatalogRevocations;
}
/** Reuses #162's package schema; test-origin HTTP is admitted only after caller URL policy validation. */
export function parseCatalogIndex(bytes: Uint8Array, testOrigin?: string): CatalogIndex {
  const raw = json(bytes);
  if (!object(raw) || !integer(raw.rootVersion) || !object(raw.revocation) || !integer(raw.revocation.version) || typeof raw.revocation.sha256 !== "string" || !/^[0-9a-f]{64}$/.test(raw.revocation.sha256)) return fail("index must pin rootVersion and revocation version/hash");
  if (raw.revocations !== undefined && (!Array.isArray(raw.revocations) || raw.revocations.length)) return fail("use the pinned signed revocation file, not embedded unvalidated revocations");
  // Shape validation only: preserve ORIGINAL payload bytes for all signature/hash comparisons.
  const copy = structuredClone(raw);
  try {
    if (testOrigin && Array.isArray(copy.packages)) for (const p of copy.packages) {
      if (object(p) && Array.isArray(p.versions)) for (const v of p.versions) {
        if (object(v) && typeof v.url === "string" && new URL(v.url).origin === testOrigin) v.url = v.url.replace(/^http:/, "https:");
      }
    }
    parseIndex(Buffer.from(JSON.stringify(copy)));
  } catch { return fail("invalid index/package metadata"); }
  const generated = timestamp(raw.generatedAt); const expires = timestamp(raw.expires);
  if (generated >= expires) return fail("index generatedAt must precede expires");
  for (const p of (raw as unknown as CatalogIndex).packages) {
    const versions = new Set<string>();
    for (const v of p.versions) { if (versions.has(v.version)) return fail("duplicate package version"); versions.add(v.version); }
  }
  return { ...raw, revocations: [] } as unknown as CatalogIndex;
}
