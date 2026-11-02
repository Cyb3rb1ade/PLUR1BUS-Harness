// Public trust coordinates have a closed projection bound to the exact internal action, not free display text.
import { createHash } from "node:crypto";
import { secretFormsOf } from "../logs/redact.ts";
import type { ApprovalAsk } from "../tools/approval.ts";

/** Keep public endpoint/key identity visible; refuse any coordinate containing an actual known secret. */
export function peerTrustDisplay(
  ask: Pick<ApprovalAsk, "tool" | "args" | "publicPeerTrust">,
  secrets: Iterable<string> = [],
): string | undefined {
  const trust = ask.publicPeerTrust;
  if (!trust) return undefined;
  const args = ask.args as Record<string, unknown> | null;
  const invalid = (): never => { throw new Error("invalid public trust display"); };
  if (ask.tool !== "peer.a2a_trust" || !args || typeof args !== "object") return invalid();
  const url = new URL(trust.endpoint);
  if (trust.endpoint.length > 2048 || url.toString() !== trust.endpoint
    || !["https:", "http:"].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    return invalid();
  }
  if (!/^sha256:[A-Za-z0-9_-]{43}$/.test(trust.fingerprint)
    || !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(trust.revision)
    || args.endpointHash !== createHash("sha256").update(trust.endpoint).digest("hex")
    || args.fingerprint !== trust.fingerprint || args.revision !== trust.revision) return invalid();
  const text = `Endpoint: ${trust.endpoint}\nKey fingerprint: ${trust.fingerprint}\nRevision: ${trust.revision}`;
  for (const value of secrets) {
    if (secretFormsOf(value).some(form => form && text.includes(form))) return invalid();
  }
  return text;
}
