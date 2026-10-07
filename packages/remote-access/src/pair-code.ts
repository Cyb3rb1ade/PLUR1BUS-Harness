// The typed pairing code (desktop spec §6.2, C10): `XXXX-XXXX`, 8 characters from an unambiguous 32-character alphabet
// (40 bits), one use, one hour (ADR-007's pairing-store parameters, at most 3 pending).
//
// Storage: the plaintext code lives only in the return value of issue(). The store keeps a random salt, the Argon2id
// key K derived from the code (needed in memory for pair-proof, spec step 2) and a SHA-256 verifier of K. Nothing is
// persisted: open codes die with the process, which the one-hour life makes acceptable (ADR-007: pending codes are
// ephemeral, never exported).
import { argon2Sync, createHash, randomBytes, randomInt, timingSafeEqual } from "node:crypto";
import type { EpochMs } from "./types.ts";

export const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
export const CODE_LENGTH = 8;
export const CODE_TTL_MS = 3_600_000;
export const MAX_PENDING = 3;

export interface Argon2Params { readonly memoryKiB: number; readonly passes: number; readonly parallelism: number }
/** OWASP's minimum profile for Argon2id (19 MiB, 2 passes): well under a second on a phone, and fixed by the API so
 *  server and client derive the same key. */
export const DEFAULT_ARGON2: Argon2Params = Object.freeze({ memoryKiB: 19456, passes: 2, parallelism: 1 });

export function generateCode(): string {
  let s = "";
  for (let i = 0; i < CODE_LENGTH; i++) s += CODE_ALPHABET[randomInt(CODE_ALPHABET.length)];
  return formatCode(s);
}

export function formatCode(normalized: string): string {
  return `${normalized.slice(0, 4)}-${normalized.slice(4)}`;
}

/** Upper-cases and drops spaces and hyphens; undefined unless exactly 8 alphabet characters remain. */
export function normalizeCode(input: string): string | undefined {
  const s = input.toUpperCase().replace(/[\s-]/g, "");
  return /^[A-HJ-NP-Z2-9]{8}$/.test(s) ? s : undefined;
}

export type DeriveKey = (normalizedCode: string, salt: Uint8Array, params: Argon2Params) => Buffer;

export const deriveKey: DeriveKey = (code, salt, params) =>
  Buffer.from(argon2Sync("argon2id", {
    message: Buffer.from(code, "utf8"),
    nonce: salt,
    parallelism: params.parallelism,
    tagLength: 32,
    memory: params.memoryKiB,
    passes: params.passes,
  }));

const verifierOf = (key: Uint8Array): Buffer => createHash("sha256").update("plur1bus-pair-redeem-v1").update(key).digest();

interface Entry {
  readonly id: string;
  readonly salt: Buffer;
  readonly key: Buffer;
  readonly verifier: Buffer;
  readonly expiresAt: EpochMs;
  used: boolean;
  failures: number;
}

export interface PairCodeStoreOptions {
  readonly params?: Argon2Params;
  readonly ttlMs?: number;
  readonly maxPending?: number;
  /** Injected so tests can count derivations. */
  readonly derive?: DeriveKey;
  /** Failed redeems (from anyone) after which an open code is burned. Default 10. */
  readonly maxCodeFailures?: number;
  /** Failed redeems from one source inside `sourceWindowMs` that lock that source. Default 5. */
  readonly sourceMaxFailures?: number;
  readonly sourceWindowMs?: number;
  readonly sourceLockMs?: number;
}

export interface IssuedCode { readonly id: string; readonly code: string; readonly expiresAt: EpochMs }
export interface OpenCode { readonly id: string; readonly salt: Buffer; readonly key: Buffer; readonly expiresAt: EpochMs }
export type RedeemResult =
  | { readonly ok: true; readonly id: string }
  | { readonly ok: false; readonly reason: "invalid" }
  | { readonly ok: false; readonly reason: "locked"; readonly retryAfterMs: number };
export interface SnapshotEntry {
  readonly id: string; readonly salt: string; readonly verifier: string;
  readonly expiresAt: EpochMs; readonly used: boolean; readonly failures: number;
}

export class PairCodeStore {
  readonly params: Argon2Params;
  protected readonly ttlMs: number;
  protected readonly maxPending: number;
  protected readonly derive: DeriveKey;
  protected readonly maxCodeFailures: number;
  protected readonly sourceMaxFailures: number;
  protected readonly sourceWindowMs: number;
  protected readonly sourceLockMs: number;
  protected entries: Entry[] = [];
  protected sources = new Map<string, { fails: EpochMs[]; lockedUntil: EpochMs }>();

  constructor(opts: PairCodeStoreOptions) {
    this.params = opts.params ?? DEFAULT_ARGON2;
    this.ttlMs = opts.ttlMs ?? CODE_TTL_MS;
    this.maxPending = opts.maxPending ?? MAX_PENDING;
    this.derive = opts.derive ?? deriveKey;
    this.maxCodeFailures = opts.maxCodeFailures ?? 10;
    this.sourceMaxFailures = opts.sourceMaxFailures ?? 5;
    this.sourceWindowMs = opts.sourceWindowMs ?? 600_000;
    this.sourceLockMs = opts.sourceLockMs ?? 900_000;
  }

  protected isOpen(e: Entry, now: EpochMs): boolean {
    return !e.used && now < e.expiresAt;
  }

  issue(now: EpochMs): IssuedCode {
    this.entries = this.entries.filter((e) => now < e.expiresAt);
    if (this.entries.filter((e) => this.isOpen(e, now)).length >= this.maxPending) {
      throw new Error(`too many pending pairing codes (at most ${this.maxPending})`);
    }
    const code = generateCode();
    const salt = randomBytes(16);
    const key = this.derive(normalizeCode(code)!, salt, this.params);
    const entry: Entry = { id: randomBytes(9).toString("base64url"), salt, key, verifier: verifierOf(key), expiresAt: now + this.ttlMs, used: false, failures: 0 };
    this.entries.push(entry);
    return { id: entry.id, code, expiresAt: entry.expiresAt };
  }

  /** The codes that can still be redeemed, newest first. K is returned for pair-proof; never expose it further. */
  open(now: EpochMs): OpenCode[] {
    return this.entries.filter((e) => this.isOpen(e, now)).reverse().map((e) => ({ id: e.id, salt: e.salt, key: e.key, expiresAt: e.expiresAt }));
  }

  revoke(id: string): void {
    this.entries = this.entries.filter((e) => e.id !== id);
  }

  /** Does the same work (one Argon2id per open code, one dummy when none is open) and the same constant-time
   *  comparisons whatever the input looks like. Answers only "invalid" — except that a source with too many recent
   *  failures is refused up front as "locked", before any work is done for it. Every failure counts against every open
   *  code (the guesser's target is unknown) and burns a code at `maxCodeFailures`, so the 40 bits of a code cannot be
   *  searched from any number of sources. A burned or redeemed code is "spent". */
  redeem(input: string, now: EpochMs, source = "unknown"): RedeemResult {
    const state = this.sources.get(source);
    if (state !== undefined && now < state.lockedUntil) return { ok: false, reason: "locked", retryAfterMs: state.lockedUntil - now };

    const code = normalizeCode(input);
    const probe = code ?? "AAAAAAAA";
    const open = this.entries.filter((e) => this.isOpen(e, now));
    let hit: Entry | undefined;
    if (open.length === 0) {
      this.derive(probe, Buffer.alloc(16), this.params);
    }
    for (const e of open) {
      const candidate = verifierOf(this.derive(probe, e.salt, this.params));
      if (timingSafeEqual(candidate, e.verifier) && code !== undefined) hit = e;
    }
    if (hit !== undefined) {
      hit.used = true;
      this.sources.delete(source);
      return { ok: true, id: hit.id };
    }
    this.recordFailure(source, now, open);
    return { ok: false, reason: "invalid" };
  }

  protected recordFailure(source: string, now: EpochMs, open: readonly Entry[]): void {
    for (const e of open) {
      e.failures++;
      if (e.failures >= this.maxCodeFailures) e.used = true;
    }
    const fails = (this.sources.get(source)?.fails ?? []).filter((t) => t > now - this.sourceWindowMs);
    fails.push(now);
    if (fails.length >= this.sourceMaxFailures) this.sources.set(source, { fails: [], lockedUntil: now + this.sourceLockMs });
    else this.sources.set(source, { fails, lockedUntil: 0 });
    for (const [key, st] of this.sources) {
      if (now >= st.lockedUntil && !st.fails.some((t) => t > now - this.sourceWindowMs)) this.sources.delete(key);
    }
  }

  snapshot(_now: EpochMs): SnapshotEntry[] {
    return this.entries.map((e) => ({
      id: e.id, salt: e.salt.toString("base64url"), verifier: e.verifier.toString("base64url"),
      expiresAt: e.expiresAt, used: e.used, failures: e.failures,
    }));
  }
}
