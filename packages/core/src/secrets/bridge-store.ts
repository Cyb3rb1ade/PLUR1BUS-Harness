import { RpcCallError, type CoreClient } from "@plur1bus/module-api";
import type { AuditAction, AuditDetail, AuditSink } from "./audit.ts";
import { createLeaseTable, type Lease, type LeaseInfo } from "./leases.ts";
import type { SecretRedaction } from "./redaction.ts";
import { NO_BACKEND, type SecretStartupStatus, type SecretStatus, type SecretStore, type SecretStoreLogger } from "./store.ts";
import { SecretError, isSecretName, type SecretMeta, type SecretPrincipal } from "./types.ts";

/**
 * The secret store of a core that runs behind the Rust front door while the front door owns the store (P4-20 flip B1,
 * docs/phase4/bridge.md). The same interface as `createSecretStore`; every operation of the store is a `bridge.secret.*`
 * call to the front door, which opens the files and the keyring, runs the gates and writes the audit records.
 *
 * What stays in this process:
 * - The redaction registry. Every value that arrives here (the start-up snapshot, a lease, a reveal, a value this
 *   process set) is registered before it is handed on, as the store does.
 * - The leases. The front door issues one (gate, record, read, id, expiry) and hands it out; it is held here, so
 *   `readLease`, `revokeLease` and `activeLeases` stay synchronous. Their gates and their two audit records
 *   (`secret.lease.read`, `secret.lease.revoke`) are written here, into the same chain.
 * - The change listeners (`onChange`), called after a `set` or a `delete` of this process came back committed.
 *
 * A connection opens with the preload (`bridge.secret.preload`): it names the keyring service this core derives from
 * its home, and the front door serves no other call of the store on a connection before it accepted that name. A
 * front door that names another store, or cannot hand over its snapshot, is a store that cannot be opened.
 *
 * Every answer of the front door carries the effects: which leases are void, the start-up state, a new snapshot. They
 * are applied before the call returns. An error carries none, so after an error the effects are asked for
 * (`bridge.secret.preload`) before the error is thrown.
 *
 * A bridge that does not answer within the budget, or is gone, is a store that is not available: every lease held
 * here is revoked and the operation fails with `backend-unavailable`, as when a helper process of the store fails.
 * The connection is closed, so that the front door stops serving what was still queued on it; the next call opens
 * a new one, which takes the store from the old (the front door serves the store on the connection that opened it
 * last). A bridge that could not be opened is not tried again for a second.
 */
export interface BridgeSecretStoreOptions {
  /** Opens the bridge connection: `connect()` to the front door's bridge address with the link credential. */
  open: () => Promise<Pick<CoreClient, "call" | "close" | "onClose">>;
  /** The keyring service this core derives from its home; the front door refuses a preload that names another. */
  service: string;
  redaction: SecretRedaction;
  /** For the records written here (a refused or a served `readLease`, `revokeLease`, `activeLeases`). */
  audit: AuditSink;
  clock?: () => number;
  logger?: SecretStoreLogger;
  /** The budget of one call, in milliseconds (the store's I/O budget). */
  budgetMs?: number;
}

/** How long a bridge that could not be opened is left alone. Every call within that time fails as the opening did. */
export const REOPEN_AFTER_MS = 1000;

type Effects = { startup: SecretStartupStatus; revoked: { all: boolean; names: string[] }; preloaded?: string[] };
type Answer<T> = T & { effects: Effects };
type WirePrincipal = { kind: "owner"; id?: string; surface?: number } | { kind: "core" } | { kind: "agent"; agentId?: string };

const STORE_CODES = new Set(["denied", "not-found", "invalid-name", "invalid-value", "invalid-description", "invalid-ttl", "no-backend",
  "backend-unavailable", "corrupt", "storage", "audit-unavailable", "lease-invalid"]);
/** The refusals that come before the store accepts a value: a value that met one of them is not registered. */
const NOT_ACCEPTED = new Set(["denied", "invalid-name", "invalid-value", "invalid-description"]);

/** The principal as the bridge carries it. Anything that is not one of the store's three kinds is an agent to the
 *  store (it refuses it and records it as one); a surface that is present but is not a level is the lowest one. */
function wire(p: SecretPrincipal): WirePrincipal {
  const kind = (p as { kind?: unknown } | null)?.kind;
  if (kind === "core") return { kind: "core" };
  if (kind === "owner") {
    const o = p as { id?: unknown; surface?: unknown };
    const level = o.surface === 0 || o.surface === 1 || o.surface === 2 || o.surface === 3 ? o.surface : 0;
    return { kind: "owner", ...(typeof o.id === "string" ? { id: text(o.id) } : {}), ...(o.surface !== undefined ? { surface: level } : {}) };
  }
  const agentId = kind === "agent" ? (p as { agentId?: unknown }).agentId : undefined;
  return { kind: "agent", ...(typeof agentId === "string" ? { agentId: text(agentId) } : {}) };
}
/** A lone surrogate, which the front door's reader refuses as a whole frame. */
const LONE_SURROGATE = /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/g;
/** A parameter as the bridge can carry it: the string, with U+FFFD where it is not well-formed (what the file backend
 *  stores for such a string), and the empty string for anything else (which the store refuses, as it refuses that). */
const text = (v: unknown): string => (typeof v === "string" ? v.replace(LONE_SURROGATE, "\ufffd") : "");

export function createBridgeSecretStore(o: BridgeSecretStoreOptions): SecretStore {
  const clock = o.clock ?? Date.now;
  const budgetMs = o.budgetMs ?? 3000;
  const redaction = o.redaction;
  const leases = createLeaseTable(clock);
  const startupGroup = Symbol("startup-store");
  const changeListeners = new Set<(name: string) => void>();
  let startup: SecretStartupStatus = { state: "idle", safeToFlush: false };
  type Client = Pick<CoreClient, "call" | "close" | "onClose">;
  let link: Promise<Client> | undefined;
  let preload: Promise<void> | undefined;
  let closed = false;
  /** Until when a bridge that could not be opened is not tried again, and what the opening failed with. */
  let reopenAt = 0, reopenError: unknown;

  const unavailable = () => new SecretError("backend-unavailable", "Secret-Store unavailable");
  const revokeAll = (): void => { for (const lease of leases.active()) leases.revoke(lease.leaseId); };
  /** Closes a connection that is given up. A request that is still queued on it must not be served for this process
   *  any more: the front door would hand its effects to a connection nobody reads. */
  const drop = (of: Promise<Client>): void => { void of.then((client) => client.close()).catch(() => { /* it never opened, or is gone */ }); };
  /** The connection `of` is gone or did not answer. It is closed. If it is the one in use (or none is), nothing held
   *  here can be vouched for any more; a connection that was replaced already takes nothing with it. */
  function lost(of: Promise<Client>): void {
    if (closed) return;
    drop(of);
    if (link !== undefined && link !== of) return;
    link = undefined;
    startup = { state: "unavailable", reason: "backend-unavailable", safeToFlush: false };
    revokeAll();
  }
  function apply(effects: Effects): void {
    if (closed) return;
    startup = { state: effects.startup.state, safeToFlush: effects.startup.safeToFlush, ...(effects.startup.reason ? { reason: effects.startup.reason } : {}) };
    if (effects.revoked.all) revokeAll();
    for (const name of effects.revoked.names) leases.revokeName(name);
    if (effects.preloaded) redaction.replaceGroup(startupGroup, effects.preloaded);
  }
  /** The store's own error for a refusal that carries one of its codes. */
  const refusal = (err: unknown): SecretError | undefined =>
    err instanceof RpcCallError && typeof err.reason === "string" && STORE_CODES.has(err.reason) ? new SecretError(err.reason as SecretError["code"], err.message) : undefined;
  /** The bridge connection, opened with the preload: its answer is the snapshot, and until the front door gave it the
   *  connection has no other call of the store. A connection whose preload failed is closed again. */
  function connection(): Promise<Client> {
    if (closed) return Promise.reject(unavailable());
    if (link) return link;
    if (clock() < reopenAt) return Promise.reject(reopenError);
    const mine: Promise<Client> = o.open().then(async (client) => {
      try { apply((await client.call<Answer<object>>("bridge.secret.preload", { service: o.service }, budgetMs)).effects); }
      catch (err) { try { await client.close(); } catch { /* it is gone already */ } throw err; }
      client.onClose(() => { lost(mine); });
      return client;
    });
    link = mine;
    mine.catch((err) => {
      if (link === mine) link = undefined;
      reopenAt = clock() + REOPEN_AFTER_MS; reopenError = err;
    });
    return mine;
  }
  /** One call of the store over the bridge: its answer with the effects applied, or the store's own error. */
  async function call<T>(method: string, params: object): Promise<T> {
    const mine = connection();
    let client: Client;
    try { client = await mine; } catch (err) { lost(mine); throw refusal(err) ?? unavailable(); }
    try {
      const answer = await client.call<Answer<T>>(`bridge.secret.${method}`, params, budgetMs);
      apply(answer.effects);
      return answer;
    } catch (err) {
      const refused = refusal(err);
      if (refused) {
        // What the failed call did (a lease it voided, a store that went away) is told with the next answer: ask for it.
        try { apply((await client.call<Answer<object>>("bridge.secret.preload", { service: o.service }, budgetMs)).effects); } catch { lost(mine); }
        throw refused;
      }
      lost(mine);
      throw unavailable();
    }
  }
  const changed = (name: string): void => {
    for (const listener of [...changeListeners]) {
      try { listener(name); } catch { /* observers cannot change a committed mutation */ }
    }
  };

  // The synchronous part: the leases held here. Gates and records as in the store.
  const audited = (p: SecretPrincipal, action: AuditAction, target: string | null, detail?: AuditDetail): void =>
    o.audit.record({ action, target, principal: p, ...(detail ? { detail } : {}) });
  function gate(p: SecretPrincipal, action: string): void {
    const kind = (p as { kind?: unknown } | null)?.kind;
    if (kind === "owner" || kind === "core") return;
    const known = kind === "agent";
    try { o.audit.record({ action: "secret.denied", target: null, principal: known ? p : { kind: "agent" }, detail: { method: action } }); } catch { /* the refusal stands */ }
    o.logger?.warn("secret access denied", { method: action, kind: String(kind ?? "unknown") });
    throw new SecretError("denied", "secret operations are available to the owner only", { method: action });
  }
  function assertAvailable(): void {
    if (startup.state === "unavailable" && startup.reason === "no-backend") throw new SecretError("no-backend", NO_BACKEND);
    if (startup.state !== "idle" && startup.state !== "ready") throw unavailable();
  }

  return {
    redaction,
    preloadRedaction(): Promise<void> {
      if (!preload || startup.state === "unavailable") {
        // A connection that is opened now begins with the preload; one that is open is asked once more.
        const again = link !== undefined;
        const opening = again ? undefined : connection();
        preload = (opening ? opening.catch((err) => { lost(opening); throw err; }) : call<object>("preload", { service: o.service })).then(() => undefined, () => undefined);
      }
      return preload;
    },
    startupStatus(): SecretStartupStatus { return { ...startup }; },
    backendUnavailable(reason: "startup-timeout" | "backend-unavailable" = "backend-unavailable"): void {
      if (closed) return;
      startup = { state: "unavailable", reason, safeToFlush: false };
      revokeAll();
    },
    async close(): Promise<void> {
      if (closed) return;
      closed = true;
      startup = { state: "closed", safeToFlush: false };
      revokeAll();
      const open = link; link = undefined;
      try { await (await open)?.close(); } catch { /* it never opened, or is gone */ }
    },
    onChange(listener: (name: string) => void): () => void {
      changeListeners.add(listener);
      return () => { changeListeners.delete(listener); };
    },

    async status(p: SecretPrincipal): Promise<SecretStatus> {
      const { status } = await call<{ status: SecretStatus }>("status", { principal: wire(p) });
      // The front door does not count the leases it handed out; they are held here.
      return { ...status, activeLeases: status.activeLeases + leases.active().length };
    },
    async set(p: SecretPrincipal, name: string, value: string, description?: string): Promise<SecretMeta> {
      try {
        const { secret } = await call<{ secret: SecretMeta }>("set", { principal: wire(p), name: text(name), value: text(value), ...(description !== undefined ? { description: text(description) } : {}) });
        redaction.register(value, name);
        changed(name);
        return secret;
      } catch (err) {
        // The store registers a value once it has accepted it, before it writes: a write that failed leaves it masked.
        if (err instanceof SecretError && !NOT_ACCEPTED.has(err.code) && typeof value === "string" && isSecretName(name)) redaction.register(value, name);
        throw err;
      }
    },
    async describe(p: SecretPrincipal, name: string, description: string): Promise<SecretMeta> {
      return (await call<{ secret: SecretMeta }>("describe", { principal: wire(p), name: text(name), description: text(description) })).secret;
    },
    async meta(p: SecretPrincipal, name: string): Promise<SecretMeta> {
      return (await call<{ secret: SecretMeta }>("meta", { principal: wire(p), name: text(name) })).secret;
    },
    async reveal(p: SecretPrincipal, name: string): Promise<{ meta: SecretMeta; value: string }> {
      const { secret, value } = await call<{ secret: SecretMeta; value: string }>("reveal", { principal: wire(p), name: text(name) });
      redaction.register(value, name);
      return { meta: secret, value };
    },
    async delete(p: SecretPrincipal, name: string): Promise<{ removed: true }> {
      await call<{ removed: true }>("delete", { principal: wire(p), name: text(name) });
      changed(name);
      return { removed: true };
    },
    async list(p: SecretPrincipal): Promise<SecretMeta[]> {
      return (await call<{ secrets: SecretMeta[] }>("list", { principal: wire(p) })).secrets;
    },

    async lease(p: SecretPrincipal, name: string, o2: { purpose: string; profileId: string; ttlMs?: number }): Promise<Lease> {
      // A lifetime JSON cannot carry (NaN, an infinity) is one the store refuses; so is this one.
      const ttlMs = o2?.ttlMs === undefined ? undefined : typeof o2.ttlMs === "number" && Number.isFinite(o2.ttlMs) ? o2.ttlMs : -1;
      const { lease } = await call<{ lease: Lease }>("lease", { principal: wire(p), name: text(name), purpose: text(o2?.purpose), profileId: text(o2?.profileId), ...(ttlMs !== undefined ? { ttlMs } : {}) });
      redaction.register(lease.value, lease.name);
      return leases.adopt(lease);
    },
    readLease(p: SecretPrincipal, leaseId: string): Lease {
      gate(p, "lease.read");
      assertAvailable();
      audited(p, "secret.lease.read", null, { leaseId });
      return leases.read(leaseId);
    },
    revokeLease(p: SecretPrincipal, leaseId: string): boolean {
      gate(p, "lease.revoke");
      audited(p, "secret.lease.revoke", null, { leaseId });
      return leases.revoke(leaseId);
    },
    activeLeases(p: SecretPrincipal): LeaseInfo[] { gate(p, "lease.list"); return leases.active(); },
  };
}
