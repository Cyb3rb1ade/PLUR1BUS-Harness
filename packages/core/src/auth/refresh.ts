import type { Clock } from "./clock.ts";
import { AuthError } from "./errors.ts";
import { noLog, type AuthLog } from "./log.ts";
import { validateProfile, refreshSkewMs, type AuthProfile } from "./profile.ts";
import { protectRecord, decodeRecord, encodeRecord, type OAuthRecord, type SecretStore } from "./secret-store.ts";

export interface RefreshResult {
  accessToken: string;
  /** Absent for a vendor that does not rotate: the old refresh token stays. */
  refreshToken?: string | undefined;
  expiresInSeconds?: number | undefined;
  refreshExpiresInSeconds?: number | undefined;
}

/** What a `Refresher` throws: `invalid_grant` means the vendor rejected the refresh token (expired, revoked, already
 *  used); `transient` means the endpoint could not be reached or answered 5xx. The message is constant so a response
 *  body can never travel in it. */
export class RefreshRejected extends Error {
  readonly reason: "invalid_grant" | "transient";
  constructor(reason: "invalid_grant" | "transient") { super(`refresh ${reason}`); this.name = "RefreshRejected"; this.reason = reason; }
}

/** The token-endpoint call (RFC 6749 §6). Implemented by HttpRefresher in http.ts. */
export interface Refresher { refresh(req: { profile: AuthProfile; refreshToken: string }): Promise<RefreshResult> }

export interface RefreshTimer { schedule(callback: () => void, delayMs: number): () => void }
const systemTimer: RefreshTimer = { schedule(callback, delayMs) { const timer = setTimeout(callback, Math.min(delayMs, 2_147_483_647)); timer.unref(); return () => clearTimeout(timer); } };
export interface RefreshOwnerOptions { store: SecretStore; clock: Clock; refresher: Refresher; log?: AuthLog; timer?: RefreshTimer; random?: () => number }

export interface FreshRecord { record: OAuthRecord; /** true when this call ran, or joined, a refresh */ refreshed: boolean }

const reauth = (p: AuthProfile, credentialId: string) =>
  new AuthError("reauth_required", `Sign-in for ${p.display_name} has expired or was revoked. Sign in again.`, { profileId: p.id, credentialId, action: `plur1bus login ${p.id}` });

/** The single refresh owner (ADR-005 "Token lifecycle"): the core is the only process that refreshes, and inside it
 *  one in-flight refresh exists per credential, so a rotating, single-use refresh token is spent exactly once however
 *  many turns ask at the same moment. A rotated token is persisted before any waiter is released. */
export class RefreshOwner {
  readonly #o: Required<RefreshOwnerOptions>;
  readonly #flights = new Map<string, Promise<FreshRecord>>();
  readonly #timers = new Map<string, () => void>();
  readonly #due = new Map<string, { generation: number; expiresAt: number | undefined; at: number }>();
  readonly #backoff = new Map<string, { attempts: number; until: number; generation: number }>();
  #closed = false;
  /** Rotated records the store refused; never spend the previous refresh token again. */
  readonly #unpersisted = new Map<string, OAuthRecord>();

  constructor(o: RefreshOwnerOptions) { this.#o = { log: noLog, timer: systemTimer, random: Math.random, ...o }; }

  /** A credential whose access token is valid beyond the profile's refresh skew. Refreshes first when it is not. */
  async fresh(profile: AuthProfile, ref: string, credentialId: string): Promise<FreshRecord> {
    validateProfile(profile);
    const rec = await this.#load(profile, ref, credentialId);
    if (this.#isFresh(profile, rec, ref)) { this.#schedule(profile, ref, credentialId, rec); return { record: rec, refreshed: false }; }
    const retry = this.#backoff.get(ref);
    if (retry && retry.generation === rec.generation && retry.until > this.#o.clock.now()) {
      if (rec.expiresAt === undefined || rec.expiresAt > this.#o.clock.now()) return { record: rec, refreshed: false };
      throw this.#retryError(profile, credentialId, retry.until);
    }
    const flight = this.#flights.get(ref) ?? this.#start(profile, ref, credentialId);
    return flight;
  }

  /** Mark the access token of `generation` unusable (a 401 on a token believed valid). No-op when a newer one exists. */
  async invalidate(profile: AuthProfile, ref: string, credentialId: string, generation: number): Promise<void> {
    if (this.#flights.has(ref)) return;
    const rec = await this.#load(profile, ref, credentialId).catch(() => undefined);
    if (!rec || rec.generation !== generation || !rec.refreshToken) return;
    this.#due.delete(ref); this.#backoff.delete(ref);
    await this.#save(ref, { ...rec, expiresAt: 0 }, profile, credentialId);
  }

  #start(profile: AuthProfile, ref: string, credentialId: string): Promise<FreshRecord> {
    const p = this.#run(profile, ref, credentialId).finally(() => { this.#flights.delete(ref); });
    this.#flights.set(ref, p);
    return p;
  }

  async #run(profile: AuthProfile, ref: string, credentialId: string): Promise<FreshRecord> {
    const { clock, refresher, log } = this.#o;
    const rec = await this.#load(profile, ref, credentialId); // re-read: a refresh may have finished since the caller looked
    if (this.#isFresh(profile, rec, ref)) { this.#schedule(profile, ref, credentialId, rec); return { record: rec, refreshed: true }; }
    const now = clock.now();
    const stillValid = rec.expiresAt === undefined || rec.expiresAt > now;
    if (!rec.refreshToken) {
      if (stillValid) return { record: rec, refreshed: false };
      throw reauth(profile, credentialId);
    }
    if (rec.refreshExpiresAt !== undefined && rec.refreshExpiresAt <= now) {
      await this.#markReauth(profile, ref, credentialId, rec);
      throw reauth(profile, credentialId);
    }
    log("auth.refresh.start", { profileId: profile.id, credentialId });
    let res: Awaited<ReturnType<Refresher["refresh"]>>;
    try {
      res = await refresher.refresh({ profile, refreshToken: rec.refreshToken });
    } catch (e) {
      const reason = e instanceof RefreshRejected ? e.reason : "transient"; // an unknown failure is never taken as proof the login is dead
      if (reason === "invalid_grant") {
        log("auth.refresh.rejected", { profileId: profile.id, credentialId });
        await this.#markReauth(profile, ref, credentialId, rec);
        throw reauth(profile, credentialId);
      }
      const attempts = Math.min((this.#backoff.get(ref)?.attempts ?? 0) + 1, 10);
      const delay = Math.min(60_000, 1000 * 2 ** (attempts - 1)) + Math.floor(this.#random() * 1000);
      const until = clock.now() + delay;
      this.#backoff.set(ref, { attempts, until, generation: rec.generation });
      this.#scheduleAt(profile, ref, credentialId, until);
      log("auth.refresh.transient", { profileId: profile.id, credentialId, usable: stillValid });
      if (stillValid) return { record: rec, refreshed: false }; // inside the skew window the old token still works
      throw this.#retryError(profile, credentialId, until);
    }
    const t = clock.now();
    const next: OAuthRecord = protectRecord({
      v: 1, accessToken: res.accessToken, generation: rec.generation + 1,
      refreshToken: res.refreshToken ?? rec.refreshToken,
      ...(res.expiresInSeconds !== undefined ? { expiresAt: t + res.expiresInSeconds * 1000 } : {}),
      ...(res.refreshExpiresInSeconds !== undefined ? { refreshExpiresAt: t + res.refreshExpiresInSeconds * 1000 } : rec.refreshExpiresAt !== undefined && !res.refreshToken ? { refreshExpiresAt: rec.refreshExpiresAt } : {}),
    });
    await this.#save(ref, next, profile, credentialId);
    this.#backoff.delete(ref); this.#due.delete(ref);
    this.#schedule(profile, ref, credentialId, next);
    log("auth.refresh.ok", { profileId: profile.id, credentialId, generation: next.generation });
    return { record: next, refreshed: true };
  }

  async #load(profile: AuthProfile, ref: string, credentialId: string): Promise<OAuthRecord> {
    const pending = this.#unpersisted.get(ref);
    if (pending) { await this.#save(ref, pending, profile, credentialId); return this.#unpersisted.get(ref) ?? pending; }
    let raw: string | undefined;
    try { raw = await this.#o.store.get(ref); } catch { throw new AuthError("invalid_secret_record", "Stored credential could not be read.", { profileId: profile.id }); }
    if (raw === undefined) throw new AuthError("no_credential", `No sign-in is stored for ${profile.display_name}.`, { profileId: profile.id, credentialId, action: `plur1bus login ${profile.id}` });
    const rec = decodeRecord(raw, profile.id);
    if (rec.reauthRequired) throw reauth(profile, credentialId);
    return rec;
  }

  /** Persist, or hold in memory and retry on the next access: the vendor has already invalidated the previous token. */
  async #save(ref: string, rec: OAuthRecord, profile: AuthProfile, credentialId: string): Promise<void> {
    try { await this.#o.store.set(ref, encodeRecord(rec)); this.#unpersisted.delete(ref); }
    catch { this.#unpersisted.set(ref, protectRecord(rec)); this.#o.log("auth.persist.failed", { profileId: profile.id, credentialId }); throw new AuthError("persist_failed", "Refreshed credential could not be saved; retry before restarting.", { retryable: true }); }
  }

  async #markReauth(profile: AuthProfile, ref: string, credentialId: string, rec: OAuthRecord) {
    // Keep the record (the access token may still work) but stop every further refresh attempt until a new login replaces it.
    this.#timers.get(ref)?.(); this.#timers.delete(ref); this.#backoff.delete(ref);
    await this.#save(ref, { ...rec, reauthRequired: true }, profile, credentialId);
  }

  #random(): number { const n = this.#o.random(); return Number.isFinite(n) ? Math.max(0, Math.min(1, n)) : 0; }
  #refreshAt(profile: AuthProfile, rec: OAuthRecord, ref: string): number {
    const held = this.#due.get(ref);
    if (held?.generation === rec.generation && held.expiresAt === rec.expiresAt) return held.at;
    const skew = refreshSkewMs(profile);
    const at = (rec.expiresAt ?? Infinity) - skew - Math.floor(this.#random() * Math.min(30_000, skew / 4));
    this.#due.set(ref, { generation: rec.generation, expiresAt: rec.expiresAt, at }); return at;
  }
  #isFresh(profile: AuthProfile, rec: OAuthRecord, ref: string): boolean {
    return rec.expiresAt === undefined || this.#refreshAt(profile, rec, ref) > this.#o.clock.now();
  }
  #retryError(profile: AuthProfile, credentialId: string, until: number) {
    return new AuthError("refresh_failed", "Could not refresh sign-in; try again shortly.", { profileId: profile.id, credentialId, retryable: true, retryAfterMs: Math.max(0, until - this.#o.clock.now()) });
  }
  #schedule(profile: AuthProfile, ref: string, credentialId: string, rec: OAuthRecord) {
    if (rec.reauthRequired || !rec.refreshToken || rec.expiresAt === undefined) return;
    // Very short-lived tokens would otherwise spin at zero delay forever inside the skew window.
    this.#scheduleAt(profile, ref, credentialId, Math.max(this.#o.clock.now() + 1000, this.#refreshAt(profile, rec, ref)));
  }
  #scheduleAt(profile: AuthProfile, ref: string, credentialId: string, at: number) {
    this.#timers.get(ref)?.();
    if (this.#closed) return;
    this.#timers.set(ref, this.#o.timer.schedule(() => {
      this.#timers.delete(ref);
      void this.fresh(profile, ref, credentialId).catch(() => { /* classified/logged by the single owner */ });
    }, Math.max(0, at - this.#o.clock.now())));
  }
  /** Cancel background work on core shutdown. In-flight token rotation still finishes/persists. */
  close(): void { this.#closed = true; for (const cancel of this.#timers.values()) cancel(); this.#timers.clear(); }
}
