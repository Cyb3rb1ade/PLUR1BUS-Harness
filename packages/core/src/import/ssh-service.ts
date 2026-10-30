/** E2/E3: human-owned Ed25519 identity, endpoint configuration and explicit host-key trust for read-only imports. */
import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, randomBytes } from "node:crypto";
import { isAbsolute, posix } from "node:path";
import { createSftpFs, probeSftpHostKey, RemoteFsError, type VerifiedWorker, type SftpOptions,
  type ProbeOptions, type SftpSession, type ReadonlyFs } from "@plur1bus/remote-fs";
import { authorize } from "../rbac/authorize.ts";
import type { Principal } from "../rbac/types.ts";
import type { AuditSink } from "../rbac/audit.ts";
import type { PrincipalResolver } from "../rbac/guard.ts";
import type { SurfaceTrustLevel } from "../rbac/surface.ts";
import { connectionSurface } from "../rbac/connection-surface.ts";
import { RpcError } from "../rpc/errors.ts";
import type { Handler, CallContext } from "../rpc/server.ts";
import type { SecretStore } from "../secrets/store.ts";
import { acquireLease } from "../secrets/acquisition.ts";
import { resolveSshEndpoint } from "./ssh-egress.ts";
import type { Resolver } from "../tools/web/guard.ts";
import { compileEgressPolicy, hostAllowed, type EgressConfig } from "../egress/policy.ts";
import { domainToASCII } from "node:url";
import { readonlySshInstructions } from "./ssh-instructions.ts";

const KEY_NAME = "import.ssh.key";
const ID = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const FINGERPRINT = /^SHA256:[A-Za-z0-9+/]{43}$/;
const PROBE_TTL_MS = 5 * 60_000;

export interface SshConnectionConfig {
  host: string;
  port: number;
  user: string;
  roots: string[];
  allowPrivate: boolean;
  hostKey?: { sha256: string; algorithm?: string };
}
export interface SshConnectionInput {
  id: string; host: string; port?: number; user: string; roots: string[]; allowPrivate?: boolean;
}
export interface SshKeyStatus { configured: boolean; publicKey?: string; fingerprint?: string; instructions?: string }
interface SshImportOptions {
  audit: AuditSink;
  store: Pick<SecretStore, "status" | "set" | "delete" | "lease" | "revokeLease" | "onChange">;
  config(): Readonly<Record<string, SshConnectionConfig>>;
  egress(): EgressConfig;
  setConnections(connections: Record<string, SshConnectionConfig>): Promise<void> | null;
  worker?(): VerifiedWorker | undefined;
  clock?(): number;
  resolver?: Resolver;
  /** Production re-reads the current person role; the original token scopes continue to narrow every read. */
  person?(userId: string): Principal | null;
  probe?(options: ProbeOptions): ReturnType<typeof probeSftpHostKey>;
  connect?(options: SftpOptions): ReturnType<typeof createSftpFs>;
}
interface Probe {
  owner: string; id: string; revision: string; fingerprint: string; algorithm?: string; expiresAt: number;
}
interface Session { id: string; controller: AbortController; close?: () => Promise<void> }

function gate(principal: Principal | null, action: "read" | "manage", ownerOnly = false): asserts principal is Principal {
  if (principal?.kind !== "person" || ownerOnly && principal.role !== "owner" ||
    authorize(principal, `imports.${action}`, { kind: "system" }).effect !== "allow") {
    throw new RpcError("E_DENIED", "SSH import operation is unavailable to this principal", { reason: "ssh-person-required" });
  }
}
function unavailable(reason: string): RpcError {
  return new RpcError("E_NOT_AVAILABLE", "SSH import setup is incomplete", { reason });
}
function safeError(error: unknown): RpcError {
  if (error instanceof RpcError) return error;
  if (error instanceof RemoteFsError) return unavailable(`ssh-${error.reason}`);
  return new RpcError("E_STORAGE", "SSH import operation could not be completed", { reason: "ssh-storage" });
}
function revision(connection: SshConnectionConfig): string { return JSON.stringify(connection); }
function checkedConnection(input: SshConnectionInput): SshConnectionConfig {
  if (!input || !ID.test(input.id) || typeof input.host !== "string" || input.host.length > 253 || !input.host ||
    /[\s/\\@\x00-\x1f\x7f]/.test(input.host) || typeof input.user !== "string" || !input.user || input.user.length > 128 ||
    /[\x00-\x1f\x7f]/.test(input.user) || !Number.isInteger(input.port ?? 22) || (input.port ?? 22) < 1 ||
    (input.port ?? 22) > 65535 || input.allowPrivate !== undefined && typeof input.allowPrivate !== "boolean" ||
    !Array.isArray(input.roots) || input.roots.length < 1 || input.roots.length > 32 ||
    new Set(input.roots).size !== input.roots.length || input.roots.some(root => typeof root !== "string" ||
      root.length > 4096 || !root.startsWith("/") || /[\x00-\x1f\x7f\\]/.test(root) || posix.normalize(root) !== root)) {
    throw new RpcError("E_INVALID_PARAMS", "SSH connection metadata is invalid", { reason: "ssh-connection-invalid" });
  }
  return { host: input.host, port: input.port ?? 22, user: input.user, roots: [...input.roots], allowPrivate: input.allowPrivate ?? false };
}
function publicStatus(value: string): SshKeyStatus {
  const key = createPrivateKey(value);
  if (key.asymmetricKeyType !== "ed25519") throw unavailable("ssh-key-invalid");
  const raw = Buffer.from(createPublicKey(key).export({ format: "jwk" }).x!, "base64url");
  const wire = Buffer.alloc(19 + raw.length);
  wire.writeUInt32BE(11); wire.write("ssh-ed25519", 4); wire.writeUInt32BE(raw.length, 15); raw.copy(wire, 19);
  const publicKey = `ssh-ed25519 ${wire.toString("base64")}`;
  return { configured: true, publicKey,
    fingerprint: `SHA256:${createHash("sha256").update(wire).digest("base64").replace(/=+$/, "")}`,
    instructions: readonlySshInstructions(publicKey) };
}

/** The native launcher supplies both values; an absent/invalid pair never falls back to PATH. The client verifies the file. */
export function nativeSshWorker(env: NodeJS.ProcessEnv = process.env): VerifiedWorker | undefined {
  const path = env.PLUR1BUS_NATIVE_BIN, sha256 = env.PLUR1BUS_NATIVE_SHA256;
  return path && isAbsolute(path) && typeof sha256 === "string" && /^[a-f0-9]{64}$/.test(sha256)
    ? { path, sha256, mode: "harness" } : undefined;
}

export function createSshImportService(options: SshImportOptions) {
  const clock = options.clock ?? Date.now;
  const auditReasons = new Set(["ssh-person-required", "ssh-egress-denied", "ssh-root-denied", "ssh-host-key-required",
    "ssh-host-key-invalid", "ssh-host-key-mismatch", "ssh-connection-changed", "ssh-key-required", "ssh-key-exists",
    "ssh-key-invalid", "ssh-probe-expired", "ssh-connection-invalid", "ssh-worker-unavailable", "ssh-connections-limit",
    "ssh-supervisor-required", "ssh-secret-backend-unavailable", "ssh-audit-unavailable", "ssh-storage", "ssh-permission-denied"]);
  const reasonOf = (error: unknown): string => {
    const reason = error instanceof RpcError ? error.reason : undefined;
    return typeof reason === "string" && auditReasons.has(reason) ? reason : "ssh-operation-failed";
  };
  const audit = (principal: Principal | null, action: string, id: string, outcome: string, reason?: string) => {
    try {
      options.audit.append({ at: clock(), actor: { user: principal?.userId ?? "unauthenticated", host: "core" },
        action: `import.ssh.${action}`, target: ID.test(id) ? id : "invalid",
        detail: { outcome, ...(reason ? { reason } : {}) } });
    } catch { throw new RpcError("E_STORAGE", "SSH lifecycle audit is unavailable", { reason: "ssh-audit-unavailable" }); }
  };
  const audited = async <T>(principal: Principal | null, action: string, id: string, operation: () => Promise<T>,
    cleanup?: (result: T) => Promise<void>): Promise<T> => {
    audit(principal, action, id, "intent");
    let result: T | undefined;
    try {
      result = await operation(); audit(principal, action, id, "completed"); return result;
    } catch (error) {
      if (result !== undefined) {
        // Cleanup must finish even when its own audit fails; the failed operation remains unavailable.
        await cleanup?.(result).catch(() => {});
      }
      const safe = safeError(error);
      try { audit(principal, action, id, safe.error === "E_DENIED" ? "denied" : "failed", reasonOf(safe)); } catch { /* original fixed failure remains authoritative */ }
      throw safe;
    }
  };

  const probes = new Map<string, Probe>(), sessions = new Set<Session>();
  let closed = false, keyRevision = 0, write: Promise<unknown> = Promise.resolve();
  const centralAllowed = (connection: SshConnectionConfig): boolean => {
    try {
      const policy = compileEgressPolicy(options.egress());
      return hostAllowed(policy, connection.host) || hostAllowed(policy, domainToASCII(connection.host))
        ? policy.allowPorts.includes(connection.port) : false;
    } catch { return false; }
  };
  const requireEgress = (connection: SshConnectionConfig) => {
    if (!centralAllowed(connection)) throw new RpcError("E_DENIED", "SSH destination is denied by egress policy", {
      reason: "ssh-egress-denied",
    });
  };
  const mutate = <T>(run: () => Promise<T>): Promise<T> => {
    const next = write.then(run, run); write = next.catch(() => {}); return next;
  };
  const invalidate = (id?: string): Promise<void> => {
    for (const [key, probe] of probes) if (!id || probe.id === id) probes.delete(key);
    const affected = [...sessions].filter(session => !id || session.id === id);
    for (const session of affected) session.controller.abort();
    return Promise.all(affected.map(session => session.close?.().catch(() => {}))).then(() => {});
  };
  const unwatch = options.store.onChange(name => {
    if (name === KEY_NAME) { keyRevision++; void invalidate(); }
  });
  const current = (id: string): SshConnectionConfig => {
    if (closed) throw unavailable("ssh-closed");
    const all = options.config();
    if (!ID.test(id) || !Object.hasOwn(all, id)) throw new RpcError("E_NOT_FOUND", "SSH connection not found");
    const connection = all[id]!;
    const checked = checkedConnection({ ...connection, id });
    if (connection.hostKey) {
      if (!FINGERPRINT.test(connection.hostKey.sha256)) throw unavailable("ssh-host-key-invalid");
      checked.hostKey = { sha256: connection.hostKey.sha256,
        ...(connection.hostKey.algorithm ? { algorithm: connection.hostKey.algorithm.slice(0, 128) } : {}) };
    }
    return checked;
  };
  const worker = (): VerifiedWorker => {
    const result = (options.worker ?? nativeSshWorker)();
    if (!result) throw unavailable("ssh-worker-unavailable");
    return result;
  };
  const keyPresent = async (): Promise<boolean> => {
    const status = await options.store.status({ kind: "core" });
    if (!status.secrets) throw unavailable("ssh-secret-backend-unavailable");
    return status.secrets.some(secret => secret.name === KEY_NAME);
  };
  const keyStatus = async (principal: Principal | null): Promise<SshKeyStatus> => {
    gate(principal, "read", true);
    try {
      if (!await keyPresent()) return { configured: false };
      const lease = await options.store.lease({ kind: "core" }, KEY_NAME, { purpose: "ssh-public-key", profileId: "import" });
      try { return publicStatus(lease.value); } finally { options.store.revokeLease({ kind: "core" }, lease.leaseId); }
    } catch (error) { throw safeError(error); }
  };
  const putKey = (principal: Principal | null, rotate: boolean, surface?: SurfaceTrustLevel) => mutate(async () => {
    gate(principal, "manage", true);
    try {
      const present = await keyPresent();
      if (present !== rotate) {
        if (present) throw new RpcError("E_CONFLICT", "SSH key already exists", { reason: "ssh-key-exists" });
        throw unavailable("ssh-key-required");
      }
      const { privateKey } = generateKeyPairSync("ed25519");
      const encoded = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
      await options.store.set({ kind: "owner", id: principal.userId,
        surface: surface ?? connectionSurface({ principal, now: clock() }) }, KEY_NAME,
      encoded);
      await invalidate();
      return publicStatus(encoded);
    } catch (error) { throw safeError(error); }
  });
  const save = async (next: Record<string, SshConnectionConfig>) => {
    const result = options.setConnections(next);
    if (!result) throw unavailable("ssh-supervisor-required");
    await result;
  };
  const service = {
    keyStatus,
    generateKey: (principal: Principal | null, surface?: SurfaceTrustLevel) => putKey(principal, false, surface),
    rotateKey: (principal: Principal | null, surface?: SurfaceTrustLevel) => putKey(principal, true, surface),
    deleteKey: (principal: Principal | null, surface?: SurfaceTrustLevel) => mutate(async () => {
      gate(principal, "manage", true);
      try {
        if (!await keyPresent()) return { deleted: false };
        await options.store.delete({ kind: "owner", id: principal.userId,
          surface: surface ?? connectionSurface({ principal, now: clock() }) }, KEY_NAME);
        await invalidate(); return { deleted: true };
      } catch (error) { throw safeError(error); }
    }),
    async listConnections(principal: Principal | null) {
      gate(principal, "read");
      return { connections: Object.keys(options.config()).sort().map(id => ({ id, ...current(id) })) };
    },
    setConnection: (principal: Principal | null, input: SshConnectionInput) => mutate(async () => {
      gate(principal, "manage", true);
      const connection = checkedConnection(input), all = options.config();
      if (!Object.hasOwn(all, input.id) && Object.keys(all).length >= 128) throw unavailable("ssh-connections-limit");
      const previous = Object.hasOwn(all, input.id) ? current(input.id) : undefined;
      if (previous?.hostKey && previous.host === connection.host && previous.port === connection.port && previous.user === connection.user) {
        connection.hostKey = previous.hostKey;
      }
      try { await save({ ...all, [input.id]: connection }); await invalidate(input.id); }
      catch (error) { throw safeError(error); }
      return { connection: { id: input.id, ...connection } };
    }),
    deleteConnection: (principal: Principal | null, id: string) => mutate(async () => {
      gate(principal, "manage", true);
      if (!ID.test(id)) throw new RpcError("E_INVALID_PARAMS", "SSH connection identifier is invalid");
      const all = { ...options.config() }, deleted = Object.hasOwn(all, id); delete all[id];
      try { if (deleted) { await save(all); await invalidate(id); } } catch (error) { throw safeError(error); }
      return { id, deleted };
    }),
    async probeHostKey(principal: Principal | null, id: string) {
      gate(principal, "manage", true);
      const connection = current(id), before = revision(connection);
      const session: Session = { id, controller: new AbortController() };
      sessions.add(session);
      try {
        requireEgress(connection);
        const endpoint = await resolveSshEndpoint(connection.host, connection.port, connection.allowPrivate, options.resolver);
        requireEgress(connection);
        session.controller.signal.throwIfAborted();
        const result = await (options.probe ?? probeSftpHostKey)({ worker: worker(), endpoint, limits: { timeoutMs: 15_000 },
          signal: session.controller.signal });
        requireEgress(connection);
        if (closed || before !== revision(current(id))) throw unavailable("ssh-connection-changed");
        if (!FINGERPRINT.test(result.hostKeySha256)) throw unavailable("ssh-host-key-invalid");
        for (const [key, probe] of probes) if (probe.expiresAt <= clock()) probes.delete(key);
        if (probes.size >= 32) probes.delete(probes.keys().next().value!);
        const probeId = randomBytes(32).toString("base64url");
        const algorithm = result.hostKeyAlgorithm?.slice(0, 128);
        probes.set(probeId, { owner: principal.userId, id, revision: before, fingerprint: result.hostKeySha256,
          expiresAt: clock() + PROBE_TTL_MS, ...(algorithm ? { algorithm } : {}) });
        return { connectionId: id, probeId, hostKeySha256: result.hostKeySha256,
          ...(algorithm ? { hostKeyAlgorithm: algorithm } : {}), changed: !!connection.hostKey && connection.hostKey.sha256 !== result.hostKeySha256 };
      } catch (error) { requireEgress(connection); throw safeError(error); }
      finally { sessions.delete(session); }
    },
    trustHostKey: (principal: Principal | null, id: string, probeId: string, fingerprint: string) => mutate(async () => {
      gate(principal, "manage", true);
      const probe = probes.get(probeId), connection = current(id);
      if (!probe || probe.owner !== principal.userId || probe.id !== id || probe.fingerprint !== fingerprint ||
        probe.expiresAt <= clock() || probe.revision !== revision(connection)) {
        throw new RpcError("E_NOT_FOUND", "SSH host-key probe is unavailable", { reason: "ssh-probe-expired" });
      }
      connection.hostKey = { sha256: fingerprint, ...(probe.algorithm ? { algorithm: probe.algorithm } : {}) };
      try { await save({ ...options.config(), [id]: connection }); await invalidate(id); }
      catch (error) { throw safeError(error); }
      return { connection: { id, ...connection } };
    }),
    async open(id: string, root: string, principal: Principal | null, signal?: AbortSignal): Promise<SftpSession> {
      gate(principal, "read");
      const connection = current(id), before = revision(connection), keyBefore = keyRevision;
      if (!connection.roots.includes(root)) throw new RpcError("E_DENIED", "SSH source root is not configured", { reason: "ssh-root-denied" });
      if (!connection.hostKey) throw unavailable("ssh-host-key-required");
      requireEgress(connection);
      try { if (!await keyPresent()) throw unavailable("ssh-key-required"); }
      catch (error) { throw safeError(error); }
      const session: Session = { id, controller: new AbortController() }; sessions.add(session);
      const combined = signal ? AbortSignal.any([signal, session.controller.signal]) : session.controller.signal;
      const livePrincipal = () => {
        const live = options.person ? options.person(principal.userId) : principal;
        return live && principal.tokenScopes ? { ...live, tokenScopes: principal.tokenScopes } : live;
      };
      const valid = () => {
        try {
          return !closed && !combined.aborted && centralAllowed(connection)
            && keyBefore === keyRevision && before === revision(current(id)) &&
            livePrincipal()?.kind === "person" && authorize(livePrincipal(), "imports.read", { kind: "system" }).effect === "allow";
        } catch { return false; }
      };
      try {
        const endpoint = await resolveSshEndpoint(connection.host, connection.port, connection.allowPrivate, options.resolver);
        if (!valid()) throw unavailable("ssh-connection-changed");
        const remote = await (options.connect ?? createSftpFs)({ worker: worker(), endpoint: { ...endpoint,
          username: connection.user, hostKeySha256: connection.hostKey.sha256 }, root, signal: combined,
        leaseKey: async leaseSignal => {
          if (!valid()) throw unavailable("ssh-connection-changed");
          const revoke = (lease: { leaseId: string }) => { options.store.revokeLease({ kind: "core" }, lease.leaseId); };
          const lease = await acquireLease(() => options.store.lease({ kind: "core" }, KEY_NAME,
            { purpose: "ssh-import", profileId: id, ttlMs: 30_000 }), revoke, leaseSignal);
          if (!valid() || leaseSignal.aborted) { revoke(lease); throw unavailable("ssh-connection-changed"); }
          const key = Buffer.from(lease.value);
          let released = false;
          return { key, release() { if (!released) { released = true; key.fill(0); revoke(lease); } } };
        } });
        let stopped = false;
        session.close = async () => {
          if (stopped) return; stopped = true; session.controller.abort(); sessions.delete(session);
          let failure: unknown;
          try { audit(principal, "close", id, "intent"); } catch (error) { failure = error; }
          try { await remote.close(); } catch (error) { failure ??= safeError(error); }
          try { audit(principal, "close", id, failure ? "failed" : "completed", failure ? reasonOf(failure) : undefined); }
          catch (error) { failure ??= error; }
          if (failure) throw safeError(failure);
        };
        if (!valid()) { await session.close(); throw unavailable("ssh-connection-changed"); }
        const guarded = Object.fromEntries(Object.entries(remote.fs).map(([name, method]) => [name, async (...args: unknown[]) => {
          try {
            gate(livePrincipal(), "read");
            if (!valid()) throw new RpcError("E_DENIED", "SSH read authorization changed", { reason: "ssh-connection-changed" });
            const result = await method(...args);
            if (!valid()) {
              if (Buffer.isBuffer(result)) result.fill(0);
              throw new RpcError("E_DENIED", "SSH read authorization changed", { reason: "ssh-connection-changed" });
            }
            return result;
          } catch (error) {
            const safe = safeError(error);
            let auditFailure: unknown;
            try { audit(principal, "read", id, safe.error === "E_DENIED" ? "denied" : "failed", reasonOf(safe)); }
            catch (failure) { auditFailure = failure; }
            if (!valid() || auditFailure) {
              // Closing revokes the session even when the audit sink cannot record that cleanup.
              await session.close?.().catch(() => {});
            }
            // This is a private six-operation port: readers must distinguish optional absence from fatal budgets.
            // Public RPC boundaries still map these fixed-reason errors to sanitized failures.
            throw auditFailure ?? (error instanceof RemoteFsError && valid() ? error : safe);
          }
        }])) as unknown as ReadonlyFs;
        return { fs: Object.freeze(guarded), close: session.close };
      } catch (error) { sessions.delete(session); session.controller.abort(); throw safeError(error); }
    },
    configChanged() { void invalidate(); },
    async close() { closed = true; unwatch(); await invalidate(); },
  };
  return { ...service,
    keyStatus: (principal: Principal | null) =>
      audited(principal, "key.status", "key", () => service.keyStatus(principal)),
    generateKey: (principal: Principal | null, surface?: SurfaceTrustLevel) =>
      audited(principal, "key.generate", "key", () => service.generateKey(principal, surface)),
    rotateKey: (principal: Principal | null, surface?: SurfaceTrustLevel) =>
      audited(principal, "key.rotate", "key", () => service.rotateKey(principal, surface)),
    deleteKey: (principal: Principal | null, surface?: SurfaceTrustLevel) =>
      audited(principal, "key.delete", "key", () => service.deleteKey(principal, surface)),
    listConnections: (principal: Principal | null) =>
      audited(principal, "connections.list", "connections", () => service.listConnections(principal)),
    setConnection: (principal: Principal | null, input: SshConnectionInput) =>
      audited(principal, "connections.set", input?.id, () => service.setConnection(principal, input)),
    deleteConnection: (principal: Principal | null, id: string) =>
      audited(principal, "connections.delete", id, () => service.deleteConnection(principal, id)),
    probeHostKey: (principal: Principal | null, id: string) =>
      audited(principal, "hostKey.probe", id, () => service.probeHostKey(principal, id)),
    trustHostKey: (principal: Principal | null, id: string, probeId: string, fingerprint: string) =>
      audited(principal, "hostKey.trust", id, () => service.trustHostKey(principal, id, probeId, fingerprint)),
    open: (id: string, root: string, principal: Principal | null, signal?: AbortSignal) =>
      audited(principal, "open", id, () => service.open(id, root, principal, signal), session => session.close()),
  };
}
export type SshImportService = ReturnType<typeof createSshImportService>;

/** Resolve the authenticated person for each operation; neither role nor secret surface can come from RPC params. */
export function buildSshImportMethods(service: SshImportService, resolve: PrincipalResolver,
  surfaceOf?: (principal: Principal, ctx: CallContext) => SurfaceTrustLevel): Record<string, Handler> {
  const methods: Record<string, Handler> = {};
  const add = (name: string, run: (principal: Principal | null, params: any, surface?: SurfaceTrustLevel) => unknown) => {
    const method = `admin.import.ssh.${name}`;
    methods[method] = async (params, ctx) => {
      const principal = await resolve(ctx, method, params);
      return run(principal ?? null, params, principal ? surfaceOf?.(principal, ctx) : undefined);
    };
  };
  add("key.status", p => service.keyStatus(p));
  add("key.generate", (p, _params, surface) => service.generateKey(p, surface));
  add("key.rotate", (p, _params, surface) => service.rotateKey(p, surface));
  add("key.delete", (p, _params, surface) => service.deleteKey(p, surface));
  add("connections.list", p => service.listConnections(p));
  add("connections.set", (p, params) => service.setConnection(p, params.connection));
  add("connections.delete", (p, params) => service.deleteConnection(p, params.id));
  add("hostKey.probe", (p, params) => service.probeHostKey(p, params.id));
  add("hostKey.trust", (p, params) => service.trustHostKey(p, params.connectionId, params.probeId, params.hostKeySha256));
  return methods;
}
