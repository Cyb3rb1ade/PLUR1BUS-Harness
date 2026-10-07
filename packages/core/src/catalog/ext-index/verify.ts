// Ed25519 verification of the detached signature over the exact index bytes (node:crypto), and shape validation.
import { createPublicKey, verify, type KeyObject } from "node:crypto";
import { ExtIndexError, type ExtIndex, type IndexPackage, type IndexVersion } from "./types.ts";

const SPKI_ED25519_PREFIX = Buffer.from("302a300506032b6570032100", "hex");
const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;

export function importPublicKey(keyId: string, b64: string): KeyObject {
  if (typeof b64 !== "string" || !BASE64.test(b64)) throw new ExtIndexError("invalid-config", `public key ${JSON.stringify(keyId)} is not base64`);
  const raw = Buffer.from(b64, "base64");
  if (raw.length !== 32) throw new ExtIndexError("invalid-config", `public key ${JSON.stringify(keyId)} must be a raw 32-byte Ed25519 key`);
  return createPublicKey({ key: Buffer.concat([SPKI_ED25519_PREFIX, raw]), format: "der", type: "spki" });
}

export function importKeys(publicKeys: Record<string, string>): Map<string, KeyObject> {
  const keys = new Map<string, KeyObject>();
  for (const [id, b64] of Object.entries(publicKeys)) keys.set(id, importPublicKey(id, b64));
  if (keys.size === 0) throw new ExtIndexError("no-trusted-key", "no extension public key is configured");
  return keys;
}

/** Returns the id of the key that verifies `bytes`. Fails closed on anything that is not a 64-byte base64 signature. */
export function verifySignature(bytes: Uint8Array, signatureB64: string, keys: Map<string, KeyObject>): string {
  const text = signatureB64.trim();
  if (!BASE64.test(text)) throw new ExtIndexError("signature-invalid", "signature is not base64");
  const sig = Buffer.from(text, "base64");
  if (sig.length !== 64) throw new ExtIndexError("signature-invalid", "signature is not a 64-byte Ed25519 signature");
  for (const [id, key] of keys) {
    if (verify(null, bytes, key, sig)) return id;
  }
  throw new ExtIndexError("signature-invalid", "signature does not verify with any configured key");
}

const SHA256 = /^[0-9a-f]{64}$/;
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const bad = (what: string): never => {
  throw new ExtIndexError("malformed", `index: ${what}`);
};

function parseTime(v: unknown, field: string): number {
  if (typeof v !== "string") return bad(`${field} is not a string`);
  const t = Date.parse(v);
  if (!Number.isFinite(t)) return bad(`${field} is not a timestamp`);
  return t;
}

/** Parses already-verified bytes into an `ExtIndex`; every field a client acts on is checked (fail closed). */
export function parseIndex(bytes: Uint8Array): { index: ExtIndex; expiresAt: number } {
  let raw: unknown;
  try {
    raw = JSON.parse(Buffer.from(bytes).toString("utf8"));
  } catch {
    return bad("not JSON");
  }
  if (!isObj(raw)) return bad("not an object");
  if (raw.format !== 1) throw new ExtIndexError("unsupported-format", `index format ${JSON.stringify(raw.format)} is not supported`);
  const serial = raw.serial;
  if (typeof serial !== "number" || !Number.isSafeInteger(serial) || serial < 0) return bad("serial is not a non-negative integer");
  parseTime(raw.generatedAt, "generatedAt");
  const expiresAt = parseTime(raw.expires, "expires");
  if (!Array.isArray(raw.packages)) return bad("packages is not an array");
  const seen = new Set<string>();
  for (const p of raw.packages as unknown[]) {
    if (!isObj(p)) return bad("package entry is not an object");
    const { id, kind, name, versions } = p as Partial<IndexPackage> & Record<string, unknown>;
    if (typeof id !== "string" || id === "" || typeof kind !== "string" || typeof name !== "string") return bad("package id/kind/name missing");
    if (seen.has(id)) return bad(`duplicate package id ${id}`);
    seen.add(id);
    if (!Array.isArray(versions)) return bad(`${id}: versions is not an array`);
    for (const v of versions as unknown[]) {
      if (!isObj(v)) return bad(`${id}: version entry is not an object`);
      const { version, url, sha256, size } = v as Partial<IndexVersion>;
      if (typeof version !== "string" || version === "") return bad(`${id}: version missing`);
      if (typeof sha256 !== "string" || !SHA256.test(sha256)) return bad(`${id}@${version}: sha256 is not 64 lowercase hex`);
      if (typeof size !== "number" || !Number.isSafeInteger(size) || size <= 0) return bad(`${id}@${version}: size is not a positive integer`);
      let u: URL | null = null;
      try {
        u = typeof url === "string" ? new URL(url) : null;
      } catch {
        u = null;
      }
      if (!u || u.protocol !== "https:" || u.username !== "" || u.password !== "") return bad(`${id}@${version}: url is not a plain https URL`);
    }
  }
  const revocations = raw.revocations ?? [];
  if (!Array.isArray(revocations)) return bad("revocations is not an array");
  return { index: { ...raw, format: 1, serial, revocations } as ExtIndex, expiresAt };
}
