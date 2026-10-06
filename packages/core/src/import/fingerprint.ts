// Non-reversible fingerprints for source-side identifiers (docs/import.md "Report privacy").
// Reports, ledgers and terminal output never carry plain channel user/group ids; an operator who needs to
// correlate an entry (e.g. "is this the id I expect?") compares fingerprints instead.
// NOTE: numeric chat ids are low-entropy, so this is a correlation aid, not protection against someone
// who can enumerate candidate ids — hence only 8 hex chars and never the full digest.
import { createHash } from "node:crypto";

export const FINGERPRINT_DOMAIN = "plur1bus-import-v1";

export function idFingerprint(channel: string, id: string): string {
  return createHash("sha256").update(`${FINGERPRINT_DOMAIN}:${channel}:${id}`).digest("hex").slice(0, 8);
}

export function idFingerprints(channel: string, ids: readonly string[]): string[] {
  return ids.map((id) => idFingerprint(channel, id)).sort();
}
