import { inspect } from "node:util";
import { AuthError } from "./errors.ts";

/** The only way the engine persists or reads a secret. Task 2 supplies the keychain/encrypted-file implementation;
 *  `InMemorySecretStore` is the test fake. `ref` is a profile's `secret_ref` (a handle, never a value). */
export interface SecretStore {
  get(ref: string): Promise<string | undefined>;
  set(ref: string, value: string): Promise<void>;
  delete(ref: string): Promise<void>;
}

export class InMemorySecretStore implements SecretStore {
  readonly #m = new Map<string, string>();
  /** Test seam: make the next `set` calls fail. */
  failSets = 0;
  setCalls = 0;
  async get(ref: string) { return this.#m.get(ref); }
  async set(ref: string, value: string) {
    this.setCalls++;
    if (this.failSets > 0) { this.failSets--; throw new Error("store unavailable"); }
    this.#m.set(ref, value);
  }
  async delete(ref: string) { this.#m.delete(ref); }
}

/** OAuth credential record, stored as JSON under the credential's `secret_ref`. API keys and user-pasted tokens are
 *  stored as the bare value instead. Times are epoch milliseconds. */
export interface OAuthRecord {
  v: 1;
  accessToken: string;
  refreshToken?: string;
  expiresAt?: number;
  /** Known end of life of the refresh token itself, when the vendor reports it. */
  refreshExpiresAt?: number;
  /** Incremented by every refresh; a lease carries it so a late 401 cannot invalidate a newer token. */
  generation: number;
  /** Set once the vendor rejected the refresh token: no further refresh is attempted until a new login replaces it. */
  reauthRequired?: boolean;
}

/** Only this explicit persistence boundary serializes token values. */
export function encodeRecord(r: OAuthRecord): string {
  return JSON.stringify({ v: r.v, accessToken: r.accessToken, refreshToken: r.refreshToken, expiresAt: r.expiresAt, refreshExpiresAt: r.refreshExpiresAt, generation: r.generation, reauthRequired: r.reauthRequired });
}
export function protectRecord(r: OAuthRecord): OAuthRecord {
  Object.defineProperty(r, "toJSON", { value: () => ({ v: r.v, generation: r.generation, expiresAt: r.expiresAt, reauthRequired: r.reauthRequired, token: "[redacted]" }), configurable: true });
  Object.defineProperty(r, inspect.custom, { value: () => ({ v: r.v, generation: r.generation, token: "[redacted]" }), configurable: true });
  return r;
}

export function decodeRecord(raw: string, profileId: string): OAuthRecord {
  let o: unknown;
  try { o = JSON.parse(raw); } catch { throw invalid(profileId); }
  const r = o as Partial<OAuthRecord> | null;
  if (!r || typeof r !== "object" || r.v !== 1 || typeof r.accessToken !== "string" || typeof r.generation !== "number") throw invalid(profileId);
  for (const k of ["refreshToken"] as const) if (r[k] !== undefined && typeof r[k] !== "string") throw invalid(profileId);
  for (const k of ["expiresAt", "refreshExpiresAt"] as const) if (r[k] !== undefined && typeof r[k] !== "number") throw invalid(profileId);
  return protectRecord(r as OAuthRecord);
}

function invalid(profileId: string) {
  return new AuthError("invalid_secret_record", "The stored credential is unreadable; sign in again.", { profileId, action: `plur1bus login ${profileId}` });
}

/** Bridge to the existing audited secrets service. Reads use a short core lease and immediately revoke it;
 *  mutations use the existing owner API, after the caller has authorized an in-process login. */
export function createAuthSecretStore(service: import("../secrets/store.ts").SecretStore): SecretStore {
  return {
    async get(ref) {
      try {
        const lease = await service.lease({ kind: "core" }, ref, { purpose: "auth", profileId: "auth" });
        try { return lease.value; } finally { service.revokeLease({ kind: "core" }, lease.leaseId); }
      } catch (e) {
        if (e && typeof e === "object" && "code" in e && e.code === "not-found") return undefined;
        throw new AuthError("invalid_secret_record", "Stored credential could not be read.");
      }
    },
    async set(ref, value) { try { await service.set({ kind: "owner" }, ref, value); } catch { throw new AuthError("persist_failed", "Credential could not be saved."); } },
    async delete(ref) { try { await service.delete({ kind: "owner" }, ref); } catch (e) { if (!(e && typeof e === "object" && "code" in e && e.code === "not-found")) throw new AuthError("persist_failed", "Credential could not be removed."); } },
  };
}
