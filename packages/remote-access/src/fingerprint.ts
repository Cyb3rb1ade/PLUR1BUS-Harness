// SHA-256 fingerprints and the pin format used in the pairing payload (desktop spec §6.2): `sha256:<base64url of the
// 32 hash bytes, no padding>`. A certificate pin hashes the DER certificate (the leaf, or the root CA for company-ca);
// an SPKI pin hashes the SubjectPublicKeyInfo and survives a certificate renewal with the same key.
import { X509Certificate, createHash, timingSafeEqual } from "node:crypto";

export type Pin = `sha256:${string}`;
export type CertInput = string | Uint8Array | X509Certificate;

export function toX509(input: CertInput): X509Certificate {
  if (input instanceof X509Certificate) return input;
  return new X509Certificate(typeof input === "string" ? input : Buffer.from(input.buffer, input.byteOffset, input.byteLength));
}

export function sha256(bytes: Uint8Array): Buffer {
  return createHash("sha256").update(bytes).digest();
}

export function pinOf(bytes: Uint8Array): Pin {
  return `sha256:${sha256(bytes).toString("base64url")}`;
}

/** The 32 hash bytes of a well-formed pin, else undefined. Strict: lowercase prefix, unpadded base64url, 32 bytes. */
export function parsePin(text: string): Buffer | undefined {
  const m = /^sha256:([A-Za-z0-9_-]{43})$/.exec(text);
  if (!m) return undefined;
  const bytes = Buffer.from(m[1]!, "base64url");
  return bytes.length === 32 && bytes.toString("base64url") === m[1] ? bytes : undefined;
}

/** Constant-time pin comparison. A pin that does not parse never matches anything, itself included. */
export function pinsEqual(a: string, b: string): boolean {
  const x = parsePin(a);
  const y = parsePin(b);
  return x !== undefined && y !== undefined && timingSafeEqual(x, y);
}

export function certPin(cert: CertInput): Pin {
  return pinOf(toX509(cert).raw);
}

export function spkiPin(cert: CertInput): Pin {
  return pinOf(toX509(cert).publicKey.export({ type: "spki", format: "der" }));
}

/** `AB:CD:…` as shown by browsers and `X509Certificate.fingerprint256`. */
export function formatHex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0").toUpperCase()).join(":");
}
