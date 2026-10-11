// Shareable invitation links (#386): a 256-bit one-time token, stored only as a hash, and the link built around it.
import { createHash, randomBytes } from "node:crypto";

export const INVITE_TTL_DEFAULT_MINUTES = 60;
/** 30 days: the upper bound of a link's validity. */
export const INVITE_TTL_MAX_MINUTES = 30 * 24 * 60;
/** The pairing code that rides along with an invitation keeps the Identity service's own 60-minute ceiling. */
export const INVITE_CODE_MAX_MINUTES = 60;

const TOKEN_BYTES = 32;
/** 32 bytes as unpadded base64url. */
const TOKEN_SHAPE = /^[A-Za-z0-9_-]{43}$/;

/** A fresh token: 256 bits from the CSPRNG. Returned to the inviter once; nothing else ever holds it in the clear. */
export const mintInviteToken = (): string => randomBytes(TOKEN_BYTES).toString("base64url");

export const isInviteTokenShape = (raw: unknown): raw is string => typeof raw === "string" && TOKEN_SHAPE.test(raw);

/**
 * Unsalted SHA-256: the token carries 256 random bits, so there is nothing to brute-force and no salt is needed. That is
 * what lets redeem do one indexed lookup instead of scanning every row.
 */
export const hashInviteToken = (token: string): string =>
  createHash("sha256").update("plur1bus-invite-v1\u0000", "utf8").update(token, "utf8").digest("hex");

/** `scheme://host[:port]` only (no userinfo, path, query or fragment); anything else is not a web origin. */
export function parseOrigin(raw: unknown): string | null {
  if (typeof raw !== "string" || raw.length === 0 || raw.length > 256) return null;
  let u: URL;
  try { u = new URL(raw); } catch { return null; }
  if (u.protocol !== "http:" && u.protocol !== "https:") return null;
  if (u.username !== "" || u.password !== "" || u.search !== "" || u.hash !== "" || (u.pathname !== "/" && u.pathname !== "")) return null;
  if (u.origin !== raw.replace(/\/$/, "")) return null;
  return u.origin;
}

/** The token travels in the URL fragment: a fragment is never sent to the server, so no access log can capture it. */
export const inviteLink = (origin: string, token: string): string => `${origin}/#/invite/${token}`;
