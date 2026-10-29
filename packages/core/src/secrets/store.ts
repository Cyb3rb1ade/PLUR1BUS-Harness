import { surfaceSatisfies } from "../rbac/surface.ts";
import { MIN_SECRET_SURFACE, MIN_DESCRIPTION_VALUE_CHARS, SecretError, checkDescription, checkName, checkValue, isSecretName, type BackendKind, type SecretBackend, type SecretMeta, type SecretPrincipal } from "./types.ts";
import { createLeaseTable, type Lease, type LeaseInfo } from "./leases.ts";
import type { AuditAction, AuditDetail, AuditSink } from "./audit.ts";
import { createSecretRedaction } from "./redaction.ts";

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
  secrets?: (Pick<SecretMeta, "name" | "backend"> & Partial<Omit<SecretMeta, "name" | "backend">>)[];
  remedy?: string;
}

const NO_BACKEND = "no secret backend is available: the OS keyring is not usable and the encrypted-file fallback is disabled; set secrets.fileFallback.enabled to true (plur1bus config set secrets.fileFallback.enabled true) to use the encrypted file";
const LABEL = /^[A-Za-z0-9][A-Za-z0-9._:/@-]{0,127}$/;

export function createSecretStore(o: SecretStoreOptions) {
  const clock = o.clock ?? Date.now;
  const leases = createLeaseTable(clock);
  /** Every value this store writes or reads is registered before it is returned, so no log, audit or report redactor misses it. */
  const redaction = createSecretRedaction();
  const changeListeners = new Set<(name: string) => void>();
  const changed = (name: string): void => {
    for (const listener of [...changeListeners]) {
      try { listener(name); } catch { /* observers cannot change a committed mutation */ }
    }
  };
  const now = () => new Date(clock());

  const allowed = (p: SecretPrincipal, kinds: readonly string[]): boolean => !!p && typeof p === "object" && typeof (p as { kind?: unknown }).kind === "string" && kinds.includes(p.kind);

  /** Fail closed: anything not named in `kinds` is refused, and the attempt is audited (best effort: a refusal needs no audit to hold). */
  function gate(p: SecretPrincipal, action: string, name: string | null, kinds: readonly string[]): void {
    if (allowed(p, kinds)) return;
    deny(p, action, name);
  }
  /** The write, delete and reveal paths: an owner who came in on a connection must have the level `MIN_SECRET_SURFACE` asks
   *  for. A level that is present but not exactly 1, 2 or 3 (`NaN`, a string, `null`) fails. An owner with no `surface` at all
   *  is an in-process caller (the engine's own stores) and has no connection to judge. */
  function gateSurface(p: SecretPrincipal, action: string, name: string | null): void {
    if (p.kind !== "owner" || p.surface === undefined) return;
    if (!surfaceSatisfies(p.surface, MIN_SECRET_SURFACE)) deny(p, action, name);
  }
  function deny(p: SecretPrincipal, action: string, name: string | null): never {
    // The target is only ever a well-formed name (a refused caller's free text, which may itself be a pasted secret, is not
    // written), and the principal is only ever one of the known kinds.
    const known = p && typeof p === "object" && (p.kind === "owner" || p.kind === "core" || p.kind === "agent");
    try { o.audit.record({ action: "secret.denied", target: isSecretName(name) ? name : null, principal: known ? p : { kind: "agent" }, detail: { method: action } }); } catch { /* the refusal stands */ }
    o.logger?.warn("secret access denied", { method: action, kind: String((p as { kind?: unknown })?.kind ?? "unknown") });
    throw new SecretError("denied", "secret operations are available to the owner only", { method: action });
  }
  /** The audit line comes first; when it cannot be made durable, nothing is released or changed (R4). */
  const audited = (p: SecretPrincipal, action: AuditAction, target: string | null, detail?: AuditDetail): void =>
    o.audit.record({ action, target, principal: p, ...(detail ? { detail } : {}) });

  interface Selection { kind: BackendKind | "none"; backend: SecretBackend | null; other: SecretBackend | null; keyring: { available: boolean; reason?: string }; fileAvailable: boolean | null; fileReason?: string }
  /** Bumped before and after every write or delete, so a lease read that overlapped one is detected and redone. */
  let epoch = 0;
  let writing = 0;
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

  const ms = (iso: unknown): number => { const t = typeof iso === "string" ? Date.parse(iso) : Number.NaN; return Number.isFinite(t) ? t : 0; };
  const core: SecretPrincipal = { kind: "core" };
  /** One writer at a time: a write, a delete and the sync below read a copy and then change it, so they must not interleave. */
  let tail: Promise<unknown> = Promise.resolve();
  const exclusive = <T>(fn: () => Promise<T>): Promise<T> => { const run = tail.then(fn, fn); tail = run.then(() => undefined, () => undefined); return run; };
  /** Runs a change of one name with the lease bookkeeping around it: a lease read that overlapped it is redone, and what was leased from the old value is revoked. */
  async function changing<T>(name: string, fn: () => Promise<T>): Promise<T> {
    epoch++; writing++;
    try { return await fn(); } finally { epoch++; writing--; leases.revokeName(name); }
  }

  /** Names deleted while the keyring was away (file backend, read while the keyring serves again). */
  async function tombstonesOf(s: Selection): Promise<Record<string, string>> {
    if (!s.other?.tombstones) return {};
    try { return await s.other.tombstones(); } catch { o.logger?.warn("secret tombstones could not be read"); return {}; }
  }
  const buried = (tomb: Record<string, string>, m: SecretMeta | undefined): boolean => !!m && Object.hasOwn(tomb, m.name) && ms(m.updatedAt) <= ms(tomb[m.name]);

  /**
   * The value of `name`, and where it came from. With the file fallback on, a name can exist in both backends (a keyring that was
   * away while the name was rotated or deleted: audit secrets #1): the newer `updatedAt` wins, a keyring copy not newer than a
   * tombstone of the file is a deleted one, and on a tie the keyring wins. Only the winner is decrypted.
   */
  async function find(name: string): Promise<{ value: string; from: SecretBackend } | null> {
    const s = await select();
    const primary = need(s);
    const other = s.other;
    const take = (value: string, from: SecretBackend) => { redaction.register(value, name); return { value, from }; };
    if (!other) { const v = await primary.get(name); return v === null ? null : take(v, primary); }
    const om = (await other.list()).find((m) => m.name === name);
    const tomb = await tombstonesOf(s);
    let pv = await primary.get(name);
    let pm: SecretMeta | undefined;
    if (pv !== null && (om || Object.hasOwn(tomb, name))) {
      pm = (await primary.list()).find((m) => m.name === name);
      if (buried(tomb, pm ?? { name, backend: primary.kind, createdAt: "", updatedAt: "" })) pv = null;
    }
    if (pv !== null && !(om && ms(om.updatedAt) > ms(pm?.updatedAt))) return take(pv, primary);
    if (!om) return null;
    const ov = await other.get(name);
    return ov === null ? null : take(ov, other);
  }

  interface Plan { purge: string[]; promote: string[]; dropOther: string[]; clear: string[] }
  /** Every name the owner can see, newest version winning, plus what the two backends owe each other (see `settle`). */
  async function merged(s: Selection): Promise<{ metas: Map<string, SecretMeta>; primary: SecretMeta[]; plan: Plan }> {
    const primary = s.backend ? await s.backend.list() : [];
    const other = s.other ? await s.other.list() : [];
    const tomb = await tombstonesOf(s);
    const plan: Plan = { purge: [], promote: [], dropOther: [], clear: Object.keys(tomb) };
    const metas = new Map<string, SecretMeta>();
    for (const m of primary) { if (buried(tomb, m)) plan.purge.push(m.name); else metas.set(m.name, m); }
    for (const m of other) {
      const mine = metas.get(m.name);
      if (!mine) metas.set(m.name, m);
      else if (ms(m.updatedAt) > ms(mine.updatedAt)) { metas.set(m.name, m); plan.promote.push(m.name); }
      else plan.dropOther.push(m.name);
    }
    return { metas, primary: primary.filter((m) => !buried(tomb, m)), plan };
  }
  const idle = (p: Plan): boolean => p.purge.length + p.promote.length + p.dropOther.length + p.clear.length === 0;

  /**
   * The keyring is serving and the file holds something that happened while it was not: bring the keyring in line (a rotated
   * value moves in, a deleted name is purged, a stale file copy is dropped) and forget the tombstones that have done their work.
   * Audited like any other change, never fatal: a failed step is retried by the next owner read, and `find` already answers right.
   */
  async function settle(plan: Plan): Promise<void> {
    if (idle(plan)) return;
    await exclusive(async () => {
      const s = await select();
      if (s.kind !== "keyring" || !s.other) return;
      const { plan: fresh } = await merged(s);
      const keyring = s.backend!; const file = s.other;
      const done = new Set<string>();
      const step = async (name: string, action: AuditAction, detail: AuditDetail, fn: () => Promise<unknown>): Promise<boolean> => {
        try { audited(core, action, name, { reason: "keyring-sync", ...detail }); await changing(name, fn); return true; }
        catch { o.logger?.warn("secret copies could not be brought in line", { name }); return false; }
      };
      for (const name of fresh.purge) if (await step(name, "secret.delete", { backend: "keyring" }, () => keyring.delete(name))) done.add(name);
      for (const name of fresh.promote) {
        const meta = (await file.list()).find((m) => m.name === name);
        const value = meta ? await file.get(name).catch(() => null) : null;
        if (!meta || value === null) continue;
        // the time of the rotation is kept, not the time of the sync
        await step(name, "secret.set", { backend: "keyring" }, async () => { await keyring.put(name, value, new Date(ms(meta.updatedAt) || clock()), meta.updatedBy, meta.description ?? ""); await file.delete(name); });
      }
      for (const name of fresh.dropOther) await step(name, "secret.delete", { backend: "file" }, () => file.delete(name));
      for (const name of fresh.clear) {
        const wasPurged = fresh.purge.includes(name);
        if (wasPurged && !done.has(name)) continue; // the keyring copy is still there: the tombstone keeps hiding it
        try { await file.clearTombstone?.(name); } catch { o.logger?.warn("a secret tombstone could not be cleared", { name }); }
      }
    }).catch(() => { /* a sync that cannot run is not a failure of the read that asked for it */ });
  }

  /** A description may not carry any value the store holds: not the one being written (checked with the text), not another secret's, not an older one of this name. */
  async function assertDescriptionHoldsNoValue(text: string, s: Selection): Promise<void> {
    const leak = (): never => { throw new SecretError("invalid-description", "secret description must not contain a secret value"); };
    if (redaction.contains(text)) leak();
    let names: string[];
    try { names = [...(await merged(s)).metas.keys()]; } catch { return; }
    for (const n of names) {
      let hit: { value: string } | null = null;
      try { hit = await find(n); } catch { continue; } // an entry that cannot be read cannot be compared; the others still are
      if (hit && hit.value.length >= MIN_DESCRIPTION_VALUE_CHARS && text.includes(hit.value)) leak();
    }
  }

  return {
    redaction,
    /** In-process committed-value notifications contain names only and never delay the secret operation. */
    onChange(listener: (name: string) => void): () => void {
      changeListeners.add(listener);
      return () => { changeListeners.delete(listener); };
    },
    async status(p: SecretPrincipal): Promise<SecretStatus> {
      gate(p, "status", null, ["owner", "core"]);
      const s = await select();
      let count: number | null = null;
      let secrets: SecretMeta[] | undefined;
      if (s.backend) {
        try {
          const m = await merged(s);
          count = m.primary.length;
          secrets = [...m.metas.values()].sort((a, b) => a.name.localeCompare(b.name));
          await settle(m.plan);
        } catch { secrets = undefined; }
      }
      return {
        backend: s.kind, degraded: s.kind !== "keyring",
        keyring: { available: s.keyring.available, ...(s.keyring.reason ? { reason: s.keyring.reason } : {}) },
        file: { enabled: o.fileFallback(), available: s.fileAvailable, ...(s.fileReason ? { reason: s.fileReason } : {}) },
        count, activeLeases: leases.active().length,
        ...(secrets ? { secrets: secrets.map(m => ({ name: m.name, backend: m.backend, ...(typeof m.createdAt === "string" && m.createdAt ? { createdAt: m.createdAt } : {}), ...(typeof m.updatedAt === "string" && m.updatedAt ? { updatedAt: m.updatedAt } : {}), ...(typeof m.updatedBy === "string" && m.updatedBy ? { updatedBy: m.updatedBy } : {}), ...(typeof m.description === "string" && m.description ? { description: redaction.mask(m.description) } : {}) })) } : {}),
        ...(s.kind === "none" ? { remedy: NO_BACKEND } : {}),
      };
    },

    /** `description` is optional: omitted, a rotation keeps the stored one; an empty one removes it. A short value is accepted (see `shortValueWarning`). */
    async set(p: SecretPrincipal, name: string, value: string, description?: string): Promise<SecretMeta> {
      gate(p, "set", typeof name === "string" ? name : null, ["owner"]);
      gateSurface(p, "set", typeof name === "string" ? name : null);
      checkName(name); checkValue(value);
      const text = checkDescription(description, value);
      return exclusive(async () => {
        const s = await select();
        const backend = need(s);
        if (text) {
          await assertDescriptionHoldsNoValue(text, s);
          // The text may also not echo an older value of this very name, which `put` replaces (and which the other names' check above
          // sees only in full): fragments of it are refused too.
          const previous = await find(name);
          if (previous) checkDescription(text, previous.value);
        }
        redaction.register(value, name);
        audited(p, "secret.set", name, { backend: backend.kind });
        const result = await changing(name, async () => {
          const meta = await backend.put(name, value, now(), p.kind === "owner" ? p.id : undefined, text, previous => redaction.register(previous));
          // A copy of the old value in the other backend would come back when this one goes away: rotation removes it, and a
          // tombstone of an earlier delete has nothing left to hide.
          if (s.other) {
            try { await s.other.delete(name); await s.other.clearTombstone?.(name); } catch { o.logger?.warn("stale secret copy could not be removed", { name }); }
          }
          return meta;
        });
        changed(name);
        return result;
      });
    },

    /** Owner-only metadata edit; the backend never writes the credential or revokes its leases. */
    async describe(p: SecretPrincipal, name: string, description: string): Promise<SecretMeta> {
      gate(p, "describe", typeof name === "string" ? name : null, ["owner"]);
      gateSurface(p, "describe", typeof name === "string" ? name : null);
      checkName(name); const text = checkDescription(description);
      if (text === undefined) throw new SecretError("invalid-description", "description is required");
      return exclusive(async () => {
        const s = await select();
        need(s);
        const found = await find(name);
        if (!found) throw new SecretError("not-found", "secret does not exist");
        if (text) await assertDescriptionHoldsNoValue(text, s);
        checkDescription(text, found.value);
        audited(p, "secret.describe", name, { backend: found.from.kind });
        return found.from.describe(name, text, now(), p.kind === "owner" ? p.id : undefined, value => redaction.register(value));
      });
    },

    /** Metadata only: no value is read. */
    async meta(p: SecretPrincipal, name: string): Promise<SecretMeta> {
      gate(p, "get", typeof name === "string" ? name : null, ["owner"]);
      checkName(name);
      audited(p, "secret.get", name);
      const s = await select();
      const m = s.backend ? (await merged(s)).metas.get(name) : undefined;
      if (m) return m;
      throw new SecretError("not-found", `no secret named ${name}`, { name });
    },

    /** The one call that returns a value to the owner (`secret get --reveal`). */
    async reveal(p: SecretPrincipal, name: string): Promise<{ meta: SecretMeta; value: string }> {
      gate(p, "reveal", typeof name === "string" ? name : null, ["owner"]);
      gateSurface(p, "reveal", typeof name === "string" ? name : null);
      checkName(name);
      audited(p, "secret.reveal", name);
      const hit = await find(name);
      if (hit === null) throw new SecretError("not-found", `no secret named ${name}`, { name });
      const meta = (await hit.from.list()).find((x) => x.name === name) ?? { name, backend: hit.from.kind, createdAt: "", updatedAt: "" };
      return { meta, value: hit.value };
    },

    async delete(p: SecretPrincipal, name: string): Promise<{ removed: true }> {
      gate(p, "delete", typeof name === "string" ? name : null, ["owner"]);
      gateSurface(p, "delete", typeof name === "string" ? name : null);
      checkName(name);
      return exclusive(async () => {
        const s = await select();
        need(s);
        audited(p, "secret.delete", name);
        let removed = false;
        await changing(name, async () => {
          // The file is all that can be changed while the keyring is away, so a delete there leaves a tombstone: the keyring's older
          // copy would otherwise come back with the keyring (audit secrets #1).
          const at = s.backend === o.file ? now() : undefined;
          for (const b of [s.backend, s.other]) if (b && (await b.delete(name, b === o.file ? at : undefined))) removed = true;
          if (s.other) { try { await s.other.clearTombstone?.(name); } catch { o.logger?.warn("a secret tombstone could not be cleared", { name }); } }
          // An entry in the file backend stays on disk when the fallback is switched off or the file is not the backend in use:
          // a delete must not leave it to reappear when the flag is turned back on.
          if (s.backend !== o.file && s.other !== o.file) {
            try { if (await o.file.delete(name)) removed = true; } catch { o.logger?.warn("file backend copy could not be checked", { name }); }
          }
        });
        if (!removed) throw new SecretError("not-found", `no secret named ${name}`, { name });
        changed(name);
        return { removed: true as const };
      });
    },

    /** Names and metadata, never values. */
    async list(p: SecretPrincipal): Promise<SecretMeta[]> {
      gate(p, "list", null, ["owner"]);
      const s = await select();
      const b = need(s);
      audited(p, "secret.list", null, { backend: b.kind });
      const m = await merged(s);
      await settle(m.plan);
      return [...m.metas.values()].sort((a, b2) => a.name.localeCompare(b2.name));
    },

    /** ADR-005 action 6: a short-lived, revocable lease for the engine. In-process only (there is no RPC for it). */
    async lease(p: SecretPrincipal, name: string, o2: { purpose: string; profileId: string; ttlMs?: number }): Promise<Lease> {
      gate(p, "lease", typeof name === "string" ? name : null, ["owner", "core"]);
      checkName(name);
      if (typeof o2?.purpose !== "string" || typeof o2.profileId !== "string" || !LABEL.test(o2.purpose) || !LABEL.test(o2.profileId)) throw new SecretError("invalid-value", "lease purpose and profileId must be short identifiers");
      audited(p, "secret.lease", name, { purpose: o2.purpose, profileId: o2.profileId, ...(o2.ttlMs !== undefined ? { ttlMs: o2.ttlMs } : {}) });
      // A write that overlaps the read makes its value suspect: read again, and give up rather than lease a stale value.
      for (let attempt = 0; attempt < 3; attempt++) {
        const before = epoch;
        const hit = await find(name);
        if (hit === null) throw new SecretError("not-found", `no secret named ${name}`, { name });
        if (epoch === before && writing === 0) return leases.issue(name, hit.value, o2);
      }
      throw new SecretError("lease-invalid", "the secret changed while the lease was being issued; try again");
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
