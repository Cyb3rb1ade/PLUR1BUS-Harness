/** Production import ports bind the existing Engine and Supervisor; Core never stops itself for an import. */
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { access, lstat, statfs } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { connect, readRecordedPid, readRunToken, supervisorAddress, supervisorPidPath,
  supervisorTokenPath } from "@plur1bus/module-api";
import { pinnedLocalModelProfile, validatePinnedModelArtifacts } from "@cyb3rb1ade/plur1bus-memory/lib/providers/local-model-artifacts.js";
import { resolveNamespaceLayout } from "@cyb3rb1ade/plur1bus-memory/lib/namespace-config.js";
import type { Engine } from "@cyb3rb1ade/plur1bus-memory/types/engine.js";
import type { ConfigSource } from "../config-source.ts";
import { buildEngineConfig } from "../engine-config.ts";
import type { LicenceLedger } from "../licences/ledger.ts";
import { memoryModel } from "../licences/memory.ts";
import { layout } from "../paths.ts";
import type { PrincipalResolver } from "../rbac/guard.ts";
import type { Principal } from "../rbac/types.ts";
import type { AuditSink } from "../rbac/audit.ts";
import type { SecretStore } from "../secrets/store.ts";
import { createSourceRegistry } from "../import/source-registry.ts";
import { createImportSourceSecrets } from "../import/source-secrets.ts";
import { startImportSourceSecretBroker } from "../import/source-secret-broker.ts";
import { buildImportMethods, createImportService, type ImportTargetPreflight } from "../import/service.ts";
import { normalizedRoots, noLinkedSegments, scanMutationRoot, type MutationRoot } from "../import/maintenance-files.ts";
import type { ImportProgress } from "../import/maintenance-types.ts";
import type { SshImportService } from "../import/ssh-service.ts";
import { ImportError } from "../import/types.ts";
import { probeSourceStoreTransfer } from "../import/source-store-transfer.ts";

const unavailable = () => new ImportError("E_NOT_AVAILABLE", "import-supervisor-unavailable", "Import Supervisor is unavailable");
const inside = (root: string, path: string) => {
  const part = relative(resolve(root), resolve(path));
  return part !== ".." && !part.startsWith(".." + sep) && !isAbsolute(part);
};

async function modelStatus(options: ImportCompositionOptions, model: string, licenceId: string | undefined,
  principal: Principal): Promise<{ present: boolean; licenceAccepted: boolean }> {
  const profile = pinnedLocalModelProfile(model);
  if (!profile || profile.role !== "embedding") return { present: false, licenceAccepted: false };
  const embedding = options.config.current().engine.embedding as { local?: { cacheDir?: string } } | undefined;
  const present = (await validatePinnedModelArtifacts(profile, embedding?.local?.cacheDir ?? layout(options.home).models,
    { signal: options.signal })).ok;
  if (profile.commercialUse !== false) return { present, licenceAccepted: true };
  const accepted = memoryModel(model);
  const config = options.config.current();
  const licenceAccepted = (licenceId === undefined || licenceId === accepted.licence)
    && config.embedding.useClass !== "commercial" && config.embedding.acceptedNcLicence === true
    && options.licences.has(principal.userId, accepted.model, accepted.licence, accepted.revision);
  return { present, licenceAccepted };
}

export interface ImportCompositionOptions {
  home: string;
  config: ConfigSource;
  engine: Engine;
  secrets: SecretStore;
  licences: LicenceLedger;
  audit: AuditSink;
  resolvePrincipal: PrincipalResolver;
  ssh?: SshImportService;
  clock(): number;
  signal: AbortSignal;
  progress?: (event: ImportProgress, personId: string) => void;
  testInternals?: Record<string, unknown>;
}

/** Derive every target authority from the validated configuration, never from source files or RPC parameters. */
export async function importMutationTarget(options: Pick<ImportCompositionOptions, "home" | "config" | "signal">):
  Promise<ImportTargetPreflight> {
  const l = layout(options.home);
  const config = options.config.current();
  const roots: MutationRoot[] = normalizedRoots([
    { id: "state", path: l.state, kind: "directory", preserve: ["core.lock", "api", "secrets"] },
    ...["agents", "skills", "extensions", "mcp", "modules", "channels", "data"].map(id =>
      ({ id, path: join(options.home, id), kind: "directory" as const })),
  ]);
  let completeCoverage = true;
  const engine = buildEngineConfig(config, l);
  const namespace = resolveNamespaceLayout(String(engine.baseDbPath), config.engine.namespaces,
    { explicit: Object.hasOwn(config.engine, "namespaces") });
  if (!inside(l.state, namespace.baseDir)) completeCoverage = false;
  const inspect = (value: unknown, path: string) => {
    if (!value || typeof value !== "object") return;
    for (const [key, child] of Object.entries(value)) {
      const location = path ? path + "." + key : key;
      // Local model caches are read-only during maintenance. Unknown configured file/DB authorities refuse coverage.
      if (typeof child === "string" && /(?:path|dir)$/i.test(key) && key !== "cacheDir" && isAbsolute(child)
        && !roots.some(root => inside(root.path, child)) && location !== "baseDbPathOverride") completeCoverage = false;
      else if (child && typeof child === "object") inspect(child, location);
    }
  };
  inspect(config.engine, "");
  let writable = true;
  let coldBytes = 0;
  for (const root of roots) {
    options.signal.throwIfAborted();
    await noLinkedSegments(root.path, true);
    let existing = root.path;
    while (!await lstat(existing).catch(error => {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      return undefined;
    })) existing = dirname(existing);
    try { await access(existing, constants.W_OK | constants.R_OK); } catch { writable = false; }
    const state = await scanMutationRoot(root, { signal: options.signal });
    coldBytes += state.entries.reduce((sum, entry) => sum + (entry.size ?? 0), 0);
  }
  const capacity = await statfs(options.home, { bigint: true });
  const available = capacity.bavail * capacity.bsize;
  return { roots, coldBytes, availableBytes: Number(available > BigInt(Number.MAX_SAFE_INTEGER)
    ? BigInt(Number.MAX_SAFE_INTEGER) : available), writable,
  foreignLock: false, completeCoverage,
  exclusiveWriter: options.config.source === "supervisor" && config.engine.implementation !== "rust" };
}

/** Composition is lazy with respect to source credentials and the role-i socket. */
export function composeImports(options: ImportCompositionOptions) {
  const sources = createSourceRegistry({ home: options.home, ...(options.ssh ? { ssh: options.ssh } : {}), now: options.clock });
  const sourceSecrets = createImportSourceSecrets({ now: options.clock });
  let broker: Awaited<ReturnType<typeof startImportSourceSecretBroker>> | undefined;
  const service = createImportService({ home: options.home, sources, sourceSecrets, now: options.clock,
    audit: options.audit,
    config: {
      get: async () => {
        const config = structuredClone(options.config.current());
        const revision = options.config.revision() ?? createHash("sha256").update(JSON.stringify(config)).digest("hex");
        return { config, revision };
      },
      set: async params => {
        if (!params.dryRun || options.config.source !== "supervisor") throw unavailable();
        const pid = readRecordedPid(supervisorPidPath(options.home));
        if (process.platform === "win32" && pid === undefined) throw unavailable();
        const client = await connect({ address: supervisorAddress(options.home), endpoint: "supervisor",
          token: readRunToken(options.home, supervisorTokenPath(options.home)), connectTimeoutMs: 1000,
          callTimeoutMs: 10_000, ...(pid === undefined ? {} : { expectedServerPid: pid }) });
        try { return await client.call<{ revision: string }>("config.set", params); }
        finally { await client.close(); }
      },
    },
    target: () => importMutationTarget(options),
    store: async () => {
      const schema = (await options.engine.status()).storeSchema;
      return { supported: schema.current === null || schema.current === schema.expected };
    },
    storeProbe: async (path, requestedIdentity) => {
      const identity = requestedIdentity ?? options.engine.embedding.identities()[0];
      if (!identity) return { verdict: "incompatible", reason: "identity-unverifiable" };
      const result = await options.engine.stores.adopt({ path,
        expectedIdentity: identity as ReturnType<Engine["embedding"]["identities"]>[number], dryRun: true });
      return { verdict: result.verdict === "ok" ? "ok" : "incompatible", reason: result.reason ?? undefined,
        identitySource: result.identitySource, schemaVersion: result.storeSchema?.current ?? undefined };
    },
    model: (model, licenceId, principal) => modelStatus(options, model, licenceId, principal),
    sourceStoreProbe: (source, candidate, config, signal) => probeSourceStoreTransfer({ home: options.home,
      source, candidate, config, ...(signal ? { signal } : {}),
      ...(options.testInternals ? { testInternals: options.testInternals } : {}) }),
    secrets: options.secrets,
    ...(options.progress ? { progress: (event, principal) => options.progress!(event, principal.userId) } : {}),
  });
  return { service, methods: buildImportMethods(service, options.resolvePrincipal),
    model: (model: string, licenceId: string | undefined, principal: Principal) => modelStatus(options, model, licenceId, principal),
    async listen(token: string): Promise<void> {
      if (broker) throw unavailable();
      broker = await startImportSourceSecretBroker({ home: options.home, token, secrets: sourceSecrets,
        binding: (planId, preflightId) => service.binding(planId, preflightId) });
    },
    async close(): Promise<void> {
      service.close();
      await broker?.close();
      broker = undefined;
    },
  };
}
