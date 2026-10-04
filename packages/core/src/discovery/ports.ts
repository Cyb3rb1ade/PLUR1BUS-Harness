// The four narrow ports through which discovery reaches profiles, credentials, events and time (plan P1).
// Nothing outside this file and defaults.ts names a D15, D110 or D111 type.
import type { DiscoveryKind, ScanErrorInfo, ScanResultCode } from "./types.ts";

export interface ProfileInfo { id: string; discovery: DiscoveryKind; baseUrl: string; vendor?: string }
export interface ProfileSource { list(): readonly ProfileInfo[] }

export interface CredentialLease { origin: string; headerName: string; headerValue: string }
export class CredentialUnavailableError extends Error {
  readonly reason: "renew_sign_in" | "no_credential";
  constructor(reason: "renew_sign_in" | "no_credential") {
    super(`credential unavailable: ${reason}`);
    this.name = "CredentialUnavailableError";
    this.reason = reason;
  }
}
export interface CredentialResolver {
  /** null = the profile needs no credential. Throws CredentialUnavailableError; refuses an origin that is not the profile's own. */
  resolve(profileId: string, origin: string): Promise<CredentialLease | null>;
}

export interface DiscoveryEvents {
  discovered(e: { provider: string; count: number; models: string[]; reappeared: string[]; truncated: boolean; traceId: string }): void;
  unavailable(e: { provider: string; count: number; models: string[]; roles: string[]; truncated: boolean; traceId: string }): void;
  scanFailed(e: { provider: string; result: ScanResultCode; httpStatus?: number; retryAfterS?: number; nextScanAt: string; consecutiveFailures: number; err: ScanErrorInfo; traceId: string }): void;
  scanCompleted(e: { provider: string; result: ScanResultCode; durationMs: number; counts: { new: number; reappeared: number; unavailable: number; unchanged: number; duplicates: number }; traceId: string }): void;
}

export interface TimerHandle { cancel(): void }
export interface Clock { now(): number; setTimer(fn: () => void | Promise<void>, ms: number): TimerHandle }
export type Rng = () => number; // [0, 1)
