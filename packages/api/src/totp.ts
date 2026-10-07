import { createHash, createHmac, randomBytes, randomInt, timingSafeEqual } from "node:crypto";
import type { Clock } from "./clock.ts";
import { ApiError } from "./errors.ts";
import type { TotpStore } from "./ports.ts";

// RFC 6238 (TOTP) over RFC 4226 (HOTP), SHA-1, 6 digits, 30 s: the parameters every authenticator app supports.
export const TOTP_STEP_SECONDS = 30;
const B32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

export function base32Encode(buf: Buffer): string {
  let bits = 0; let value = 0; let out = "";
  for (const byte of buf) { value = (value << 8) | byte; bits += 8; while (bits >= 5) { out += B32[(value >>> (bits - 5)) & 31]; bits -= 5; } }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}

/** RFC 4648 base32, upper or lower case, spaces and hyphens ignored, no padding needed; `undefined` for anything else. */
export function base32Decode(s: string): Buffer | undefined {
  if (typeof s !== "string") return undefined;
  const clean = s.toUpperCase().replace(/[\s-]/g, "").replace(/=+$/, "");
  if (clean === "") return undefined;
  let bits = 0; let value = 0; const out: number[] = [];
  for (const ch of clean) {
    const i = B32.indexOf(ch); if (i < 0) return undefined;
    value = (value << 5) | i; bits += 5;
    if (bits >= 8) { out.push((value >>> (bits - 8)) & 255); bits -= 8; }
  }
  return Buffer.from(out);
}

/** 160 bits, the size RFC 4226 recommends. */
export const generateSecret = (): string => base32Encode(randomBytes(20));

export function hotp(secret: Buffer, counter: number, digits = 6): string {
  const msg = Buffer.alloc(8); msg.writeBigUInt64BE(BigInt(counter));
  const h = createHmac("sha1", secret).update(msg).digest();
  const o = h[19]! & 0x0f;
  const bin = ((h[o]! & 0x7f) << 24) | (h[o + 1]! << 16) | (h[o + 2]! << 8) | h[o + 3]!;
  return String(bin % 10 ** digits).padStart(digits, "0");
}

const stepOf = (ms: number) => Math.floor(ms / 1000 / TOTP_STEP_SECONDS);

/** The code a correct authenticator shows at `ms` (tests and enrolment checks). */
export function totpCodeAt(secretB32: string, ms: number): string {
  const key = base32Decode(secretB32); if (!key) throw new Error("not a base32 secret");
  return hotp(key, stepOf(ms));
}

export type TotpCheck = { ok: true; step: number } | { ok: false };

/** Window of one step either side (clock skew). All three candidates are always computed and compared in constant time.
 *  `lastStep` is the newest step already accepted for this user: a code from that step or an older one is a replay. */
export function verifyTotp(secretB32: string, code: unknown, nowMs: number, lastStep = -1): TotpCheck {
  if (typeof code !== "string") return { ok: false };
  const c = code.replace(/\s/g, "");
  const key = base32Decode(secretB32);
  if (!key || !/^\d{6}$/.test(c)) return { ok: false };
  const cur = stepOf(nowMs); const given = Buffer.from(c);
  let hit = -1;
  for (const step of [cur - 1, cur, cur + 1]) {
    const want = Buffer.from(hotp(key, step));
    if (timingSafeEqual(given, want) && step > lastStep && step > hit) hit = step;
  }
  return hit >= 0 ? { ok: true, step: hit } : { ok: false };
}

/** `otpauth://totp/<issuer>:<account>?secret=…&issuer=…` — what a QR code carries (the Key URI format of Google Authenticator). */
export function otpauthUri(o: { issuer: string; account: string; secret: string }): string {
  const label = `${encodeURIComponent(o.issuer)}:${encodeURIComponent(o.account)}`;
  const q = new URLSearchParams({ secret: o.secret, issuer: o.issuer, algorithm: "SHA1", digits: "6", period: String(TOTP_STEP_SECONDS) });
  return `otpauth://totp/${label}?${q.toString().replace(/\+/g, "%20")}`;
}

// ---- Backup codes -----------------------------------------------------------------------------------------------

const BACKUP_ALPHABET = "abcdefghjkmnpqrstuvwxyz23456789"; // no 0/o/1/i/l
const BACKUP_COUNT = 10;
const sha256hex = (s: string) => createHash("sha256").update(s, "utf8").digest("hex");
const normBackup = (s: string) => s.toLowerCase().replace(/[\s-]/g, "");
const BACKUP_SHAPE = /^[a-z2-9]{10}$/;

function newBackupCode(): string {
  let s = ""; for (let i = 0; i < 10; i++) s += BACKUP_ALPHABET[randomInt(BACKUP_ALPHABET.length)];
  return `${s.slice(0, 5)}-${s.slice(5)}`;
}

export interface TotpServiceOptions { store: TotpStore; clock: Clock; issuer: string }
export type VerifyResult = { ok: true; method: "totp" | "backup" } | { ok: false };

export class TotpService {
  readonly #store: TotpStore; readonly #clock: Clock; readonly #issuer: string;
  readonly #chain = new Map<string, Promise<unknown>>();
  constructor(o: TotpServiceOptions) { this.#store = o.store; this.#clock = o.clock; this.#issuer = o.issuer; }

  /** One operation at a time per user, so two requests carrying the same code cannot both pass before the first is recorded. */
  #serial<T>(userId: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.#chain.get(userId) ?? Promise.resolve();
    const next = prev.then(fn, fn);
    this.#chain.set(userId, next.catch(() => undefined));
    return next;
  }

  async isEnabled(userId: string): Promise<boolean> { return (await this.#store.get(userId))?.enabled === true; }

  async status(userId: string): Promise<{ enabled: boolean; backupCodesRemaining: number }> {
    const r = await this.#store.get(userId);
    return { enabled: r?.enabled === true, backupCodesRemaining: r?.enabled ? r.backupHashes.length : 0 };
  }

  /** A fresh secret, pending until a code from it confirms. A live second factor is never replaced silently. */
  begin(userId: string, account: string): Promise<{ secret: string; otpauthUri: string }> {
    return this.#serial(userId, async () => {
      const cur = await this.#store.get(userId);
      if (cur?.enabled) throw new ApiError(409, "E_CONFLICT", "a second factor is already on", { reason: "totp-enabled" });
      const secret = generateSecret();
      await this.#store.put({ userId, secret, enabled: false, createdAt: this.#clock.now(), backupHashes: [] });
      return { secret, otpauthUri: otpauthUri({ issuer: this.#issuer, account, secret }) };
    });
  }

  /** Turns the pending factor on when a code from its secret is right; returns the backup codes, this once. */
  confirm(userId: string, code: unknown): Promise<{ ok: true; backupCodes: string[] } | { ok: false }> {
    return this.#serial(userId, async () => {
      const cur = await this.#store.get(userId);
      if (!cur || cur.enabled) return { ok: false } as const;
      const v = verifyTotp(cur.secret, code, this.#clock.now());
      if (!v.ok) return { ok: false } as const;
      const backupCodes = Array.from({ length: BACKUP_COUNT }, newBackupCode);
      await this.#store.put({ ...cur, enabled: true, lastStep: v.step, backupHashes: backupCodes.map((c) => sha256hex(normBackup(c))) });
      return { ok: true, backupCodes } as const;
    });
  }

  /** A TOTP code (six digits) or a backup code (consumed). Fails closed for a user without an enabled factor. */
  verify(userId: string, code: unknown): Promise<VerifyResult> {
    return this.#serial(userId, async () => {
      const cur = await this.#store.get(userId);
      if (!cur?.enabled || typeof code !== "string") return { ok: false } as const;
      const totp = verifyTotp(cur.secret, code, this.#clock.now(), cur.lastStep ?? -1);
      if (totp.ok) { await this.#store.put({ ...cur, lastStep: totp.step }); return { ok: true, method: "totp" } as const; }
      const n = normBackup(code);
      if (!BACKUP_SHAPE.test(n)) return { ok: false } as const;
      const h = Buffer.from(sha256hex(n), "hex");
      let at = -1;
      cur.backupHashes.forEach((x, i) => { if (timingSafeEqual(Buffer.from(x, "hex"), h) && at < 0) at = i; });
      if (at < 0) return { ok: false } as const;
      await this.#store.put({ ...cur, backupHashes: cur.backupHashes.filter((_, i) => i !== at) });
      return { ok: true, method: "backup" } as const;
    });
  }

  /** Removes the factor when a valid code is given. */
  disable(userId: string, code: unknown): Promise<boolean> {
    return this.#serial(userId, async () => {
      const v = await this.#verifyNoSerial(userId, code);
      if (!v) return false;
      await this.#store.delete(userId);
      return true;
    });
  }

  async #verifyNoSerial(userId: string, code: unknown): Promise<boolean> {
    const cur = await this.#store.get(userId);
    if (!cur?.enabled || typeof code !== "string") return false;
    if (verifyTotp(cur.secret, code, this.#clock.now(), cur.lastStep ?? -1).ok) return true;
    const n = normBackup(code);
    if (!BACKUP_SHAPE.test(n)) return false;
    const h = Buffer.from(sha256hex(n), "hex");
    return cur.backupHashes.some((x) => timingSafeEqual(Buffer.from(x, "hex"), h));
  }
}
