import { inspect } from "node:util";
import type { Clock } from "./clock.ts";
import { AuthError } from "./errors.ts";
import { noLog, type AuthLog } from "./log.ts";
import { CredentialPool, type Failure, type PoolEntry, type Strategy } from "./pool.ts";
import { validateProfile, isRefreshable, parseHeaderScheme, type AuthProfile } from "./profile.ts";
import { RefreshOwner, type Refresher } from "./refresh.ts";
import type { SecretStore } from "./secret-store.ts";

/** The header a provider adapter attaches, plus when it stops being valid. The value is a secret: it is held privately and
 *  `toJSON`, `String()` and `util.inspect` all print a redacted form, so logging a lease cannot leak it. */
export class AuthorizationLease {
  readonly profileId: string;
  readonly credentialId: string;
  /** Epoch ms, or null when the credential does not expire (an API key). */
  readonly expiresAt: number | null;
  /** True when this lease carries a token minted by a refresh just now (or joined one). */
  readonly refreshed: boolean;
  /** @internal token generation, for 401 handling. */
  readonly generation: number | null;
  readonly #name: string;
  readonly #value: string;
  constructor(o: { profileId: string; credentialId: string; name: string; value: string; expiresAt: number | null; refreshed: boolean; generation: number | null }) {
    this.profileId = o.profileId; this.credentialId = o.credentialId; this.expiresAt = o.expiresAt; this.refreshed = o.refreshed; this.generation = o.generation;
    this.#name = o.name; this.#value = o.value;
  }
  /** `{ name: "Authorization", value: "Bearer …" }` (or `x-api-key`, per the profile's scheme). */
  get header(): { name: string; value: string } { return { name: this.#name, value: this.#value }; }
  /** All headers for a request: the credential header over the profile's `extra_headers`. */
  headers(extra: Record<string, string> = {}): Record<string, string> { return { ...extra, [this.#name]: this.#value }; }
  toJSON() { return { profileId: this.profileId, credentialId: this.credentialId, header: this.#name, expiresAt: this.expiresAt, value: "[redacted]" }; }
  toString() { return `AuthorizationLease(${this.profileId}/${this.credentialId})`; }
  [inspect.custom]() { return this.toString(); }
}

export interface LeaseRequest { profileId: string; model?: string }
export type CallResult = { ok: true; model?: string } | ({ ok: false } & Failure);

/** What provider adapters consume. One call per request: get a lease, send, report the outcome so the pool and the
 *  refresh owner learn from it. */
export interface CredentialsProvider {
  getAuthorization(req: LeaseRequest): Promise<AuthorizationLease>;
  reportResult(lease: AuthorizationLease, result: CallResult): Promise<void>;
}

/** Ambient Google credential (ADC): the port a Vertex adapter implements; the engine stores nothing for it. */
export interface AdcTokenSource { token(profile: AuthProfile): Promise<{ accessToken: string; expiresAt: number | null }> }

export interface ProfileCredentials { profile: AuthProfile; entries: PoolEntry[]; strategy?: Strategy }

export interface CredentialsProviderOptions {
  profiles: ProfileCredentials[];
  store: SecretStore;
  clock: Clock;
  refresher: Refresher;
  adc?: AdcTokenSource;
  log?: AuthLog;
}

export function createCredentialsProvider(o: CredentialsProviderOptions): CredentialsProvider & { pool(profileId: string): CredentialPool | undefined; close(): void } {
  const log = o.log ?? noLog;
  const owner = new RefreshOwner({ store: o.store, clock: o.clock, refresher: o.refresher, log });
  const byId = new Map<string, { profile: AuthProfile; pool: CredentialPool }>();
  for (const pc of o.profiles) {
    validateProfile(pc.profile);
    // A profile without pool entries but with a `secret_ref` is a pool of one.
    const entries = pc.entries.length ? pc.entries : pc.profile.secret_ref ? [{ id: "default", secretRef: pc.profile.secret_ref }] : [];
    byId.set(pc.profile.id, { profile: pc.profile, pool: new CredentialPool({ profileId: pc.profile.id, entries, ...(pc.strategy ? { strategy: pc.strategy } : {}), clock: o.clock, log }) });
  }
  const lookup = (id: string) => {
    const x = byId.get(id);
    if (!x) throw new AuthError("unknown_profile", `No auth profile named ${id}.`, { profileId: id });
    return x;
  };
  const fmt = (p: AuthProfile, token: string) => { const h = parseHeaderScheme(p.id, p.auth_header_scheme); return { name: h.name, value: h.template.split("{token}").join(token) }; };

  return {
    close: () => owner.close(),
    pool: (id) => byId.get(id)?.pool,

    async getAuthorization(req) {
      const { profile, pool } = lookup(req.profileId);
      if (profile.kind === "external_cli") throw new AuthError("delegated_login", `${profile.display_name} signs in through the vendor's own CLI; the harness holds no credential for it.`, { profileId: profile.id });
      if (profile.kind === "adc") {
        if (!o.adc) throw new AuthError("adc_unavailable", `No application-default credential source is available for ${profile.display_name}.`, { profileId: profile.id });
        let t: Awaited<ReturnType<AdcTokenSource["token"]>>;
        try { t = await o.adc.token(profile); } catch { throw new AuthError("adc_unavailable", `Could not obtain an application-default credential for ${profile.display_name}.`, { profileId: profile.id, retryable: true }); }
        const h = fmt(profile, t.accessToken);
        return new AuthorizationLease({ profileId: profile.id, credentialId: "adc", name: h.name, value: h.value, expiresAt: t.expiresAt, refreshed: false, generation: null });
      }
      // Failover loop: a credential whose secret is missing or dead is cooled and the next one is tried.
      const tried = new Set<string>();
      for (;;) {
        const entry = pool.select(req.model !== undefined ? { model: req.model } : {});
        if (tried.has(entry.id)) throw new AuthError("all_cooling_down", `No usable credential is left for ${profile.display_name}.`, { profileId: profile.id, retryable: false });
        tried.add(entry.id);
        try {
          if (isRefreshable(profile)) {
            const f = await owner.fresh(profile, entry.secretRef, entry.id);
            const h = fmt(profile, f.record.accessToken);
            return new AuthorizationLease({ profileId: profile.id, credentialId: entry.id, name: h.name, value: h.value, expiresAt: f.record.expiresAt ?? null, refreshed: f.refreshed, generation: f.record.generation });
          }
          const raw = await o.store.get(entry.secretRef);
          if (raw === undefined) throw new AuthError("no_credential", `No key is stored for ${profile.display_name}.`, { profileId: profile.id, credentialId: entry.id, action: `plur1bus login ${profile.id}` });
          const h = fmt(profile, raw);
          return new AuthorizationLease({ profileId: profile.id, credentialId: entry.id, name: h.name, value: h.value, expiresAt: null, refreshed: false, generation: null });
        } catch (e) {
          // A dead login on one pooled credential is a confirmed auth failure for that credential; fail over if another exists.
          const dead = e instanceof AuthError && (e.code === "reauth_required" || e.code === "no_credential");
          if (!dead || pool.size < 2) throw e;
          pool.reportFailure(entry.id, { status: 401 });
        }
      }
    },

    async reportResult(lease, result) {
      const { profile, pool } = lookup(lease.profileId);
      if (result.ok) { pool.reportSuccess(lease.credentialId, result.model); return; }
      const entry = pool.entry(lease.credentialId);
      if (result.status === 401 && isRefreshable(profile) && !lease.refreshed && lease.generation !== null && entry) {
        // A token believed valid was rejected: spend one refresh on it before blaming the credential.
        await owner.invalidate(profile, entry.secretRef, entry.id, lease.generation);
        log("auth.lease.rejected", { profileId: profile.id, credentialId: entry.id, action: "refresh-next" });
        return;
      }
      pool.reportFailure(lease.credentialId, result);
    },
  };
}
