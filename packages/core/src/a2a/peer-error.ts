export type A2aPeerFailure =
  | "denied"
  | "invalid-peer" | "invalid-key" | "peer-exists" | "peer-not-found" | "peer-untrusted" | "peer-revoked"
  | "card-signature" | "egress-denied" | "local-only" | "approval-required" | "budget-exceeded"
  | "request-failed" | "unavailable" | "too-large" | "aborted";

const MESSAGES: Record<A2aPeerFailure, string> = {
  "denied": "A2A peer management requires an Owner person",
  "invalid-peer": "A2A peer settings are invalid", "invalid-key": "A2A public key is invalid",
  "peer-exists": "A2A peer already exists", "peer-not-found": "A2A peer was not found",
  "peer-untrusted": "A2A peer requires explicit Owner trust", "peer-revoked": "A2A peer trust was revoked",
  "card-signature": "A2A peer card verification failed", "egress-denied": "A2A peer egress was denied",
  "local-only": "A2A peer is outside loopback and Tailnet", "approval-required": "A2A peer call requires approval",
  "budget-exceeded": "A2A peer call exceeds its budget", "request-failed": "A2A peer request failed",
  "unavailable": "A2A client is unavailable", "too-large": "A2A peer message exceeds its size limit",
  "aborted": "A2A peer call was aborted",
};

/** Peer/transport input is never interpolated into errors or attached as an Error cause. */
export class A2aPeerError extends Error {
  readonly code: A2aPeerFailure;
  constructor(code: A2aPeerFailure) { super(MESSAGES[code]); this.name = "A2aPeerError"; this.code = code; }
}
