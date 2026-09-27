import { readFileSync } from "node:fs";
import { timingSafeEqual } from "node:crypto";

const HEX64 = /^[0-9a-f]{64}$/; // both sides are lower-cased before the comparison

/** Why an adoption nonce was refused; the token file's state is what gets logged (never the nonce). */
export type AdoptionCheck = { ok: true } | { ok: false; tokenFile: "missing" | "present" | "malformed" };

/**
 * `core.adopt` / `module.adopt` (S3, S4, B9): the nonce must equal the current `run/supervisor.token` (64 hex), compared
 * in constant time after lower-casing both. A missing or malformed token file refuses every nonce.
 */
export function checkAdoptionNonce(supervisorTokenFile: string, nonce: string): AdoptionCheck {
  let expected: string | null = null;
  try { expected = readFileSync(supervisorTokenFile, "utf8").trim().toLowerCase(); } catch { /* missing: refused below */ }
  const given = nonce.toLowerCase();
  const ok = expected !== null && HEX64.test(expected) && HEX64.test(given) && timingSafeEqual(Buffer.from(given, "utf8"), Buffer.from(expected, "utf8"));
  if (ok) return { ok: true };
  return { ok: false, tokenFile: expected === null ? "missing" : HEX64.test(expected) ? "present" : "malformed" };
}
