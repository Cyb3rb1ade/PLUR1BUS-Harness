import { createHash, randomBytes, randomInt, timingSafeEqual } from "node:crypto";

/** 32 symbols without 0, O, 1 and I: unambiguous when read aloud or typed from a phone (Hermes's pairing alphabet, ADR-007). */
export const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
export const CODE_LENGTH = 8;

/** A fresh code: 8 symbols from a CSPRNG (`randomInt` is unbiased), 40 bits. */
export function generateCode(): string {
  let s = "";
  for (let i = 0; i < CODE_LENGTH; i++) s += CODE_ALPHABET[randomInt(CODE_ALPHABET.length)];
  return s;
}

/** What a person types: case, spaces and hyphens are forgiven; anything else stays and simply fails to match. */
export function normalizeCode(raw: string): string {
  return raw.toUpperCase().replace(/[\s-]/g, "");
}

export const newSalt = (): string => randomBytes(16).toString("hex");

/** Salted SHA-256: the code is high-entropy only for a short time, so it is stored as a hash and never in the clear. */
export function hashCode(salt: string, code: string): string {
  return createHash("sha256").update(salt, "utf8").update("\u0000").update(code, "utf8").digest("hex");
}

export function hashesEqual(a: string, b: string): boolean {
  const x = Buffer.from(a, "hex"); const y = Buffer.from(b, "hex");
  return x.length === y.length && timingSafeEqual(x, y);
}

/** UUIDv7 (ADR-007: `harnessUserId` is an opaque UUIDv7): 48-bit ms timestamp, version, 74 random bits. */
export function uuidv7(nowMs: number): string {
  const b = randomBytes(16);
  b.writeUIntBE(nowMs, 0, 6);
  b[6] = (b[6]! & 0x0f) | 0x70;
  b[8] = (b[8]! & 0x3f) | 0x80;
  const h = b.toString("hex");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}
