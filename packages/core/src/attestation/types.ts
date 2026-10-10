// OS-backed attestation (issue #192, option C): one human confirmation by the operating system (Touch ID / Windows Hello / UAC
// consent / polkit) lifts ONE approval from the unattested local level (T1) to T2. The core asks, the core reads the answer; a
// field of a request never reaches this code. A confirmation is valid for exactly the approval it was asked for (nonce and action
// hash bound), once, for at most 60 s.

/** Why an attestation did not happen. `replay` and `mismatch` mean the helper's answer did not belong to this attempt. */
export type AttestFailure = "cancelled" | "timeout" | "unavailable" | "failed" | "replay" | "mismatch";

export type AttestResult = { ok: true; method: string; at: number } | { ok: false; reason: AttestFailure };

/** What the core asks the person to confirm. */
export interface AttestInput {
  /** Hash of the concrete approval (action, scope, duration, agent): the one thing this confirmation covers. */
  actionHash: string;
  /** Plain-language sentence shown in the OS dialog. */
  text: string;
  /** For the audit line only. */
  person?: string;
  requestId?: string;
  agentId?: string;
  scope?: string;
  /** Capped at MAX_ATTEST_TTL_MS. */
  ttlMs?: number;
}

export type AttestProbe = { available: true; method: string } | { available: false; reason: "unavailable" };

export interface Attester {
  /** Asks the OS for a fresh confirmation. Never throws. */
  attest(input: AttestInput): Promise<AttestResult>;
  /** Reports whether a confirmation could be asked for, without showing any dialog. Never throws. */
  probe(): Promise<AttestProbe>;
}

/** The request the helper receives on stdin (one JSON line). */
export interface HelperRequest { v: 1; nonce: string; actionHash: string; text: string; ttlMs: number }
