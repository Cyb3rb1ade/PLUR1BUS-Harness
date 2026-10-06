import { randomBytes } from "node:crypto";
import { SecretError } from "./types.ts";

export const DEFAULT_LEASE_TTL_MS = 60_000;
export const MAX_LEASE_TTL_MS = 5 * 60_000;

/** ADR-005 action 6: `{ value, expiresAt, purpose, profileId }` plus the id that revokes it. */
export interface Lease { leaseId: string; name: string; value: string; expiresAt: number; purpose: string; profileId: string }
export type LeaseInfo = Omit<Lease, "value">;

interface Held { lease: Lease; revoked: boolean }

/** Short-lived, revocable, in-memory only. Expiry is checked against the injected clock on every use; an expired or
 *  revoked lease drops its value at once. Never persisted, never logged. */
export function createLeaseTable(clock: () => number) {
  const held = new Map<string, Held>();
  const sweep = (): void => { const now = clock(); for (const [id, h] of held) if (h.revoked || h.lease.expiresAt <= now) held.delete(id); };
  return {
    issue(name: string, value: string, o: { purpose: string; profileId: string; ttlMs?: number }): Lease {
      sweep();
      const ttl = o.ttlMs ?? DEFAULT_LEASE_TTL_MS;
      if (!Number.isInteger(ttl) || ttl < 1 || ttl > MAX_LEASE_TTL_MS) throw new SecretError("invalid-ttl", `lease ttlMs must be an integer in 1..${MAX_LEASE_TTL_MS}`);
      const lease: Lease = { leaseId: `lse_${randomBytes(16).toString("hex")}`, name, value, expiresAt: clock() + ttl, purpose: o.purpose, profileId: o.profileId };
      held.set(lease.leaseId, { lease, revoked: false });
      return lease;
    },
    /** The value while the lease is live; `lease-invalid` once it expired, was revoked, or never existed. */
    read(leaseId: string): Lease {
      const h = held.get(leaseId);
      if (!h || h.revoked || h.lease.expiresAt <= clock()) { held.delete(leaseId); throw new SecretError("lease-invalid", "lease is expired, revoked or unknown"); }
      return h.lease;
    },
    revoke(leaseId: string): boolean { const h = held.get(leaseId); if (!h) return false; held.delete(leaseId); return true; },
    /** A rotated or deleted secret invalidates every lease on it. */
    revokeName(name: string): number { let n = 0; for (const [id, h] of held) if (h.lease.name === name) { held.delete(id); n++; } return n; },
    active(): LeaseInfo[] { sweep(); return [...held.values()].map(({ lease: { value: _v, ...info } }) => info); },
  };
}
export type LeaseTable = ReturnType<typeof createLeaseTable>;
