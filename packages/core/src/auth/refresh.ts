import type { Clock } from "./clock.ts";
import { AuthError } from "./errors.ts";
import { noLog, type AuthLog } from "./log.ts";
import { refreshSkewMs, type AuthProfile } from "./profile.ts";
import { decodeRecord, encodeRecord, type OAuthRecord, type SecretStore } from "./secret-store.ts";

export interface RefreshResult {
  accessToken: string;
  /** Absent for a vendor that does not rotate: the old refresh token stays. */
  refreshToken?: string;
  expiresInSeconds?: number;
  refreshExpiresInSeconds?: number;
}

/** What a `Refresher` throws: `invalid_grant` means the vendor rejected the refresh token (expired, revoked, already
 *  used); `transient` means the endpoint could not be reached or answered 5xx. The message is constant so a response
 *  body can never travel in it. */
export class RefreshRejected extends Error {
  readonly reason: "invalid_grant" | "transient";
  constructor(reason: "invalid_grant" | "transient") { super(`refresh ${reason}`); this.name = "RefreshRejected"; this.reason = reason; }
}

/** The token-endpoint call (RFC 6749 §6). Implemented by an HTTP adapter outside this engine. */
export interface Refresher { refresh(req: { profile: AuthProfile; refreshToken: string }): Promise<RefreshResult> }

export interface RefreshOwnerOptions { store: SecretStore; clock: Clock; refresher: Refresher; log?: AuthLog }

export interface FreshRecord { record: OAuthRecord; /** true when this call ran, or joined, a refresh */ refreshed: boolean }

const reauth = (p: AuthProfile, credentialId: string) =>
  new AuthError("reauth_required", `Sign-in for ${p.display_name} has expired or was revoked. Sign in again.`, { profileId: p.id, credentialId, action: `plur1bus login ${p.id}` });

/** The single refresh owner (ADR-005 "Token lifecycle"): the core is the only process that refreshes, and inside it
 *  one in-flight refresh exists per credential, so a rotating, single-use refresh token is spent exactly once however
 *  many turns ask at the same moment. A rotated token is persisted before any waiter is released. */
export class RefreshOwner {
  readonly #o: Required<RefreshOwnerOptions>;
  readonly #flights = new Map<string, Promise<FreshRecord>>();
  /** Rotated records the store refused; the vendor already spent the old token, so this copy is the only one. */
  readonly #unpersisted = new Map<string, OAuthRecord>();

  constructor(o: RefreshOwnerOptions) { this.#o = { log: noLog, ...o }; }

  /** A credential whose access token is valid beyond the profile's refresh skew. Refreshes first when it is not. */
  async fresh(profile: AuthProfile, ref: string, credentialId: string): Promise<FreshRecord> {
    const rec = await this.#load(profile, ref, credentialId);
    if (this.#isFresh(profile, rec)) return { record: rec, refreshed: false };
    const flight = this.#flights.get(ref) ?? this.#start(profile, ref, credentialId);
    return flight;
  }

  /** Mark the access token of `generation` unusable (a 401 on a token believed valid). No-op when a newer one exists. */
  async invalidate(profile: AuthProfile, ref: string, credentialId: string, generation: number): Promise<void> {
    if (this.#flights.has(ref)) return;
    const rec = await this.#load(profile, ref, credentialId).catch(() => undefined);
    if (!rec || rec.generation !== generation || !rec.refreshToken) return;
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
    if (this.#isFresh(profile, rec)) return { record: rec, refreshed: true };
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
      log("auth.refresh.transient", { profileId: profile.id, credentialId, usable: stillValid });
      if (stillValid) return { record: rec, refreshed: false }; // inside the skew window the old token still works
      throw new AuthError("refresh_failed", `Could not refresh the sign-in for ${profile.display_name}; try again shortly.`, { profileId: profile.id, credentialId, retryable: true });
    }
    const t = clock.now();
    const next: OAuthRecord = {
      v: 1, accessToken: res.accessToken, generation: rec.generation + 1,
      refreshToken: res.refreshToken ?? rec.refreshToken,
      ...(res.expiresInSeconds !== undefined ? { expiresAt: t + res.expiresInSeconds * 1000 } : {}),
      ...(res.refreshExpiresInSeconds !== undefined ? { refreshExpiresAt: t + res.refreshExpiresInSeconds * 1000 } : rec.refreshExpiresAt !== undefined && !res.refreshToken ? { refreshExpiresAt: rec.refreshExpiresAt } : {}),
    };
    await this.#save(ref, next, profile, credentialId);
    log("auth.refresh.ok", { profileId: profile.id, credentialId, generation: next.generation });
    return { record: next, refreshed: true };
  }

  async #load(profile: AuthProfile, ref: string, credentialId: string): Promise<OAuthRecord> {
    const pending = this.#unpersisted.get(ref);
    if (pending) { await this.#save(ref, pending, profile, credentialId); return this.#unpersisted.get(ref) ?? pending; }
    const raw = await this.#o.store.get(ref);
    if (raw === undefined) throw new AuthError("no_credential", `No sign-in is stored for ${profile.display_name}.`, { profileId: profile.id, credentialId, action: `plur1bus login ${profile.id}` });
    const rec = decodeRecord(raw, profile.id);
    if (rec.reauthRequired) throw reauth(profile, credentialId);
    return rec;
  }

  /** Persist, or hold in memory and retry on the next access: the vendor has already invalidated the previous token. */
  async #save(ref: string, rec: OAuthRecord, profile: AuthProfile, credentialId: string): Promise<void> {
    try { await this.#o.store.set(ref, encodeRecord(rec)); this.#unpersisted.delete(ref); }
    catch { this.#unpersisted.set(ref, rec); this.#o.log("auth.persist.failed", { profileId: profile.id, credentialId }); }
  }

  async #markReauth(profile: AuthProfile, ref: string, credentialId: string, rec: OAuthRecord) {
    // Keep the record (the access token may still work) but stop every further refresh attempt until a new login replaces it.
    await this.#save(ref, { ...rec, reauthRequired: true }, profile, credentialId);
  }

  #isFresh(profile: AuthProfile, rec: OAuthRecord): boolean {
    return rec.expiresAt === undefined || rec.expiresAt - refreshSkewMs(profile) > this.#o.clock.now();
  }
}
