import { createHash, timingSafeEqual } from "node:crypto";

export const MIN_VERIFIER_LENGTH = 43;
export const MAX_VERIFIER_LENGTH = 128;
// RFC 7636 Section 4.1: characters [A-Z], [a-z], [0-9], "-", ".", "_", "~"
const VERIFIER_PATTERN = /^[A-Za-z0-9_.~-]{43,128}$/;

/**
 * Validates PKCE code_verifier against code_challenge using method S256.
 * "plain" is strictly prohibited per OAuth 2.1 (RFC 6749bis) and Festlegung 3.
 */
export function verifyPkce(codeVerifier: unknown, codeChallenge: unknown, method: unknown): boolean {
  if (method !== "S256") {
    return false;
  }
  if (typeof codeVerifier !== "string" || !VERIFIER_PATTERN.test(codeVerifier)) {
    return false;
  }
  if (typeof codeChallenge !== "string" || codeChallenge.length === 0) {
    return false;
  }
  const computed = createHash("sha256").update(codeVerifier, "utf8").digest("base64url");
  const a = Buffer.from(computed);
  const b = Buffer.from(codeChallenge);
  if (a.length !== b.length) {
    return false;
  }
  return timingSafeEqual(a, b);
}

/**
 * Computes S256 code challenge for a given code verifier.
 */
export function computeCodeChallenge(verifier: string): string {
  if (!VERIFIER_PATTERN.test(verifier)) {
    throw new Error(`Invalid PKCE verifier length or characters`);
  }
  return createHash("sha256").update(verifier, "utf8").digest("base64url");
}
