import { SecretError, checkName, checkValue, type BackendKind, type SecretBackend, type SecretMeta, type SecretPrincipal } from "./types.ts";
import { createLeaseTable, type Lease, type LeaseInfo } from "./leases.ts";
import type { AuditAction, AuditDetail, AuditSink } from "./audit.ts";

export interface SecretStoreLogger { debug(msg: string, fields?: Record<string, unknown>): void; info(msg: string, fields?: Record<string, unknown>): void; warn(msg: string, fields?: Record<string, unknown>): void }

export interface SecretStoreOptions {
  /** The OS keyring backend (tried first) and the encrypted-file backend (used only when `fileFallback()` is true). */
  keyring: SecretBackend;
  file: SecretBackend;
  /** `secrets.fileFallback.enabled`, read per use (a live key). */
  fileFallback: () => boolean;
  audit: AuditSink;
  clock?: () => number;
  logger?: SecretStoreLogger;
}

export interface SecretStatus {
  /** The backend values go to now; `none` when neither can serve. */
  backend: BackendKind | "none";
  /** True whenever the keyring is not the backend in use. */
  degraded: boolean;
  keyring: { available: boolean; reason?: string };
  file: { enabled: boolean; available: boolean | null; reason?: string };
  /** Names held in the selected backend, null when it cannot be listed. */
  count: number | null;
  activeLeases: number;
  remedy?: string;
}

const NO_BACKEND = "no secret backend is available: the OS keyring is not usable and the encrypted-file fallback is disabled; set secrets.fileFallback.enabled to true (plur1bus config set secrets.fileFallback.enabled true) to use the encrypted file";
const LABEL = /^[A-Za-z0-9][A-Za-z0-9._:/@-]{0,127}$/;

export function createSecretStore(o: SecretStoreOptions) {
  const clock = o.clock ?? Date.now;
  const leases = createLeaseTable(clock);
  const now = () => new Date(clock());

  const allowed = (p: SecretPrincipal, kinds: readonly string[]): boolean => !!p && typeof p === "object" && typeof (p as { kind?: unknown }).kind === "string" && kinds.includes(p.kind);

  /** Fail closed: anything not named in `kinds` is refused, and the attempt is audited (best effort: a refusal needs no audit to hold). */
  function gate(p: SecretPrincipal, action: string, name: string | null, kinds: readonly string[]): void {
    if (allowed(p, kinds)) return;
    try { o.audit.record({ action: "secret.denied", target: name, principal: p?.kind ? p : { kind: "agent" }, detail: { method: action } }); } catch { /* the refusal stands */ }
    o.logger?.warn("secret access denied", { method: action, kind: String((p as { kind?: unknown })?.kind ?? "unknown") });
    throw new SecretError("denied", "secret operations are available to the owner only", { method: action });
  }
  /** The audit line comes first; when it cannot be made durable, nothing is released or changed (R4). */
  const audited = (p: SecretPrincipal, action: AuditAction, target: string | null, detail?: AuditDetail): void =>
    o.audit.record({ action, target, principal: p, ...(detail ? { detail } : {}) });

  interface Selection { kind: BackendKind | "none"; backend: SecretBackend | null; other: SecretBackend | null; keyring: { available: boolean; reason?: string }; fileAvailable: boolean | null; fileReason?: string }
  let lastKind: string | null = null;
  async function select(): Promise<Selection> {
    const kp = await o.keyring.probe();
    const enabled = o.fileFallback();
    const fp = enabled ? await o.file.probe() : null;
    const sel: Selection = kp.available
      ? { kind: "keyring", backend: o.keyring, other: fp?.available ? o.file : null, keyring: kp, fileAvailable: fp?.available ?? null }
      : fp?.available
        ? { kind: "file", backend: o.file, other: null, keyring: kp, fileAvailable: true }
        : { kind: "none", backend: null, other: null, keyring: kp, fileAvailable: fp ? false : null };
    if (fp?.reason) sel.fileReason = fp.reason;
    if (sel.kind !== lastKind) { lastKind = sel.kind; o.logger?.info("secret backend selected", { backend: sel.kind, ...(kp.reason ? { keyringReason: kp.reason } : {}) }); }
    return sel;
  }
  const need = (s: Selection): SecretBackend => { if (!s.backend) throw new SecretError("no-backend", NO_BACKEND); return s.backend; };

  /** The selected backend first, then the other one when it is enabled and available (a keyring that appears later must not hide file entries). */
  async function find(name: string): Promise<{ value: string; from: SecretBackend } | null> {
    const s = await select();
    for (const b of [need(s), s.other]) {
      if (!b) continue;
      const value = await b.get(name);
      if (value !== null) return { value, from: b };
    }
    return null;
  }

  return {
    async status(p: SecretPrincipal): Promise<SecretStatus> {
      gate(p, "status", null, ["owner", "core"]);
      const s = await select();
      let count: number | null = null;
      if (s.backend) { try { count = (await s.backend.list()).length; } catch { count = null; } }
      return {
        backend: s.kind, degraded: s.kind !== "keyring",
        keyring: { available: s.keyring.available, ...(s.keyring.reason ? { reason: s.keyring.reason } : {}) },
        file: { enabled: o.fileFallback(), available: s.fileAvailable, ...(s.fileReason ? { reason: s.fileReason } : {}) },
        count, activeLeases: leases.active().length,
        ...(s.kind === "none" ? { remedy: NO_BACKEND } : {}),
      };
    },

    async set(p: SecretPrincipal, name: string, value: string): Promise<SecretMeta> {
      gate(p, "set", typeof name === "string" ? name : null, ["owner"]);
      checkName(name); checkValue(value);
      const s = await select();
      const backend = need(s);
      audited(p, "secret.set", name, { backend: backend.kind });
      const meta = await backend.put(name, value, now());
      leases.revokeName(name); // a rotated secret invalidates what was leased from the old value
      return meta;
    },

    /** Metadata only: no value is read. */
    async meta(p: SecretPrincipal, name: string): Promise<SecretMeta> {
      gate(p, "get", typeof name === "string" ? name : null, ["owner"]);
      checkName(name);
      audited(p, "secret.get", name);
      const s = await select();
      const hit = [s.backend, s.other].flatMap((b) => (b ? [b] : []));
      for (const b of hit) { const m = (await b.list()).find((x) => x.name === name); if (m) return m; }
      throw new SecretError("not-found", `no secret named ${name}`, { name });
    },

    /** The one call that returns a value to the owner (`secret get --reveal`). */
    async reveal(p: SecretPrincipal, name: string): Promise<{ meta: SecretMeta; value: string }> {
      gate(p, "reveal", typeof name === "string" ? name : null, ["owner"]);
      checkName(name);
      audited(p, "secret.reveal", name);
      const hit = await find(name);
      if (hit === null) throw new SecretError("not-found", `no secret named ${name}`, { name });
      const meta = (await hit.from.list()).find((x) => x.name === name) ?? { name, backend: hit.from.kind, createdAt: "", updatedAt: "" };
      return { meta, value: hit.value };
    },

    async delete(p: SecretPrincipal, name: string): Promise<{ removed: true }> {
      gate(p, "delete", typeof name === "string" ? name : null, ["owner"]);
      checkName(name);
      const s = await select();
      need(s);
      audited(p, "secret.delete", name);
      let removed = false;
      for (const b of [s.backend, s.other]) if (b && (await b.delete(name))) removed = true;
      leases.revokeName(name);
      if (!removed) throw new SecretError("not-found", `no secret named ${name}`, { name });
      return { removed: true };
    },

    /** Names and metadata, never values. */
    async list(p: SecretPrincipal): Promise<SecretMeta[]> {
      gate(p, "list", null, ["owner"]);
      const s = await select();
      const b = need(s);
      audited(p, "secret.list", null, { backend: b.kind });
      const seen = new Map<string, SecretMeta>();
      for (const x of [s.backend, s.other]) if (x) for (const m of await x.list()) if (!seen.has(m.name)) seen.set(m.name, m);
      return [...seen.values()].sort((a, b2) => a.name.localeCompare(b2.name));
    },

    /** ADR-005 action 6: a short-lived, revocable lease for the engine. In-process only (there is no RPC for it). */
    async lease(p: SecretPrincipal, name: string, o2: { purpose: string; profileId: string; ttlMs?: number }): Promise<Lease> {
      gate(p, "lease", typeof name === "string" ? name : null, ["owner", "core"]);
      checkName(name);
      if (!LABEL.test(o2?.purpose ?? "") || !LABEL.test(o2?.profileId ?? "")) throw new SecretError("invalid-value", "lease purpose and profileId must be short identifiers");
      audited(p, "secret.lease", name, { purpose: o2.purpose, profileId: o2.profileId, ...(o2.ttlMs !== undefined ? { ttlMs: o2.ttlMs } : {}) });
      const hit = await find(name);
      if (hit === null) throw new SecretError("not-found", `no secret named ${name}`, { name });
      return leases.issue(name, hit.value, o2);
    },
    /** Re-reads a live lease. */
    readLease(p: SecretPrincipal, leaseId: string): Lease {
      gate(p, "lease.read", null, ["owner", "core"]);
      audited(p, "secret.lease.read", null, { leaseId });
      return leases.read(leaseId);
    },
    revokeLease(p: SecretPrincipal, leaseId: string): boolean {
      gate(p, "lease.revoke", null, ["owner", "core"]);
      audited(p, "secret.lease.revoke", null, { leaseId });
      return leases.revoke(leaseId);
    },
    activeLeases(p: SecretPrincipal): LeaseInfo[] { gate(p, "lease.list", null, ["owner", "core"]); return leases.active(); },
  };
}
export type SecretStore = ReturnType<typeof createSecretStore>;
