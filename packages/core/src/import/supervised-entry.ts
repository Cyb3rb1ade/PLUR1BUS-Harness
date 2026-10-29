/** Fixed import.js --supervised entry. The Supervisor supplies one authenticated job on private stdin. */
import { createHash } from "node:crypto";
import { join } from "node:path";
import { createSecurePath } from "@plur1bus/module-api";
import { createLocalFs } from "@plur1bus/remote-fs";
import { readConfigFile } from "../config-load.ts";
import { layout } from "../paths.ts";
import { createCoreSecretStore } from "../secrets/runtime.ts";
import type { SecretStore } from "../secrets/store.ts";
import { importOpenclaw, type OpenclawImportReport } from "./importers/openclaw.ts";
import { importHermes, type HermesImportReport } from "./importers/hermes.ts";
import { createImportRecords, type ImportPlanRecord } from "./maintenance-records.ts";
import { readColdBytes, streamRegular } from "./maintenance-files.ts";
import { openMaintenanceJournal } from "./maintenance-journal.ts";
import { runImportMaintenance, type ImportMaintenanceResult } from "./maintenance-worker.ts";
import { openImportWorkerPort, type ImportWorkerPort } from "./worker-port.ts";
import { verifySourceSnapshot } from "./snapshot-source.ts";
import { migrateImportSecrets, rollbackImportSecrets } from "./secret-migration.ts";
import { writeAtomicSync } from "./fs-atomic.ts";
import type { ImportConfigPort } from "./execution.ts";
import type { ImportedExtensionPort, ImportedExtensionReceipt } from "./extensions-import.ts";
import { ImportError } from "./types.ts";
import { readSource } from "./source.ts";
import { resolveImportOptions } from "./plan-options.ts";
import { importSkills } from "./skills-import.ts";
import { renderSkills } from "./render.ts";
import { sourceStoreModel } from "./source-store-model.ts";
import { sourceStoreChanges, sourceStoreCopyProbe, configuredStoreCopyProbe, supervisedStoreInternals } from "./source-store-transfer.ts";
import { buildEngineConfig } from "../engine-config.ts";
import { normalizeEmbeddingConfig } from "@cyb3rb1ade/plur1bus-memory/lib/providers/config-normalize.js";
import { assertImportReportComplete } from "./report-complete.ts";
import { requireSelectedStoreTransfer } from "./selected-store.ts";

const unavailable = () => new ImportError("E_IMPORT_FAILED", "worker-control-unavailable",
  "Import worker control is unavailable");

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw unavailable();
  return value as Record<string, unknown>;
}

function configPort(port: ImportWorkerPort): ImportConfigPort {
  return {
    async get() {
      const response = object(await port.request("config.get", {}));
      const config = response.config ?? (response.key === null ? response.value : undefined);
      if (!config || typeof config !== "object" || Array.isArray(config)
        || typeof response.revision !== "string") throw unavailable();
      return { config, revision: response.revision };
    },
    async set(params) {
      const response = object(await port.request("config.set", params));
      if (typeof response.revision !== "string") throw unavailable();
      return { revision: response.revision };
    },
  };
}

function extensionPort(port: ImportWorkerPort): ImportedExtensionPort {
  return {
    async plan(candidate) {
      const response = object(await port.request("extension.plan", { candidate }));
      if (!["install", "existing", "conflict"].includes(String(response.action))) throw unavailable();
      return { action: response.action as "install" | "existing" | "conflict" };
    },
    async install(candidate, runId) {
      return await port.request("extension.install", { candidate, runId }) as ImportedExtensionReceipt;
    },
    async rollback(receipt) {
      await port.request("extension.rollback", { receipt });
    },
  };
}

async function verifySource(home: string, plan: ImportPlanRecord): Promise<string> {
  const source = join(home, "import", plan.snapshotId, "snapshot");
  if (!verifySourceSnapshot(source, home)) throw new ImportError("E_CONFLICT", "source-changed", "Import source changed");
  const manifest = await readColdBytes(join(source, "snapshot.json"), 8 * 1024 * 1024);
  if (createHash("sha256").update(manifest).digest("hex") !== plan.sourceSha256) {
    throw new ImportError("E_CONFLICT", "source-changed", "Import source changed");
  }
  return source;
}

async function perform(port: ImportWorkerPort): Promise<ImportMaintenanceResult> {
  const job = port.job;
  const { record: plan } = await createImportRecords(job.home).readPlan(job.plan.id, job.ownerId, job.plan.sha256,
    job.mode !== "apply");
  if (plan.runId !== job.runId || job.mode !== "recover" && !job.automaticRollback && !job.targetSha256) throw unavailable();
  const journal = openMaintenanceJournal(job.home, job.runId);
  const l = layout(job.home);
  let store: SecretStore | undefined;
  const secretStore = () => store ??= createCoreSecretStore({ layout: l, securePath: createSecurePath(),
    fileFallback: () => readConfigFile(l.configPath).secrets.fileFallback.enabled });
  let report: OpenclawImportReport | HermesImportReport | undefined;
  const entityProgress = async (event: Parameters<typeof port.progress>[0]) => {
    await port.progress(event);
    // Release/system tests exercise the real rollback path after an actual completed entity. The public protocol
    // cannot select a hook, path or error, and ordinary installations never honor this environment field.
    if (process.env.PLUR1BUS_ALLOW_TEST_INTERNALS === "1"
      && process.env.PLUR1BUS_TEST_IMPORT_FAIL_AFTER_ENTITY === "1" && event.entity && event.completed === 1) {
      throw new ImportError("E_IMPORT_FAILED", "test-entity-failed", "Import entity failed");
    }
  };
  const result = await runImportMaintenance({ home: job.home, runId: job.runId, mode: job.mode, roots: plan.roots,
    attempt: job.attempt,
    ...(job.automaticRollback ? { automaticRollback: true } : {}),
    signal: port.signal, onProgress: event => port.progress(event),
    ...(job.targetSha256 ? { expectedTargetSha256: job.targetSha256 } : {}),
    verifySource: async () => { await verifySource(job.home, plan); },
    restoreConfig: async sha256 => { await port.request("config.restore", { sha256 }); },
    rollbackSecrets: async active => {
      if (active.read().secrets.length) await rollbackImportSecrets({ runId: job.runId, store: secretStore(), journal: active });
    },
    apply: async () => {
      let migrated: { imported: string[]; skipped: string[] } | undefined;
      if (plan.options.migrateSecrets) {
        migrated = await migrateImportSecrets({ runId: job.runId, store: secretStore(), journal,
          lease: await port.takeSourceSecrets(), signal: port.signal });
      }
      const source = await verifySource(job.home, plan);
      const reader = { root: source, fs: await createLocalFs({ root: source,
        limits: { timeoutMs: 600_000, maxFileBytes: 512 * 1024 * 1024, maxTotalBytes: 1024 ** 3,
          maxEntries: 100_000 }, signal: port.signal }) };
      const read = await readSource({ sourceType: plan.sourceType, source, home: job.home, reader, signal: port.signal,
        ...(plan.options.maps ? { maps: plan.options.maps } : {}) });
      const metadata = JSON.parse((await readColdBytes(join(source, "snapshot.json"), 8 * 1024 * 1024)).toString("utf8"));
      const captured = { record: { sourceType: plan.sourceType }, read, root: source, metadata };
      const selected = resolveImportOptions(captured, plan.options);
      const config = configPort(port);
      if (plan.sourceEmbedding) {
        const candidate = sourceStoreModel(read.report, plan.sourceEmbedding.storeId);
        if (JSON.stringify(candidate) !== JSON.stringify(plan.sourceEmbedding)) throw unavailable();
        const current = await config.get();
        await config.set({ changes: sourceStoreChanges(current.config, candidate), dryRun: false, ifRevision: current.revision });
      }
      const activeConfig = readConfigFile(l.configPath);
      const engineConfig = buildEngineConfig(activeConfig, l);
      const activeEmbedding = normalizeEmbeddingConfig(engineConfig.embedding as Record<string, unknown>);
      const testInternals = supervisedStoreInternals(Number(activeEmbedding.dimensions));
      const common = { home: job.home, source, apply: true, runId: job.runId, signal: port.signal,
        ...selected, reader,
        ...(plan.options.adoptStoreId ? { probeSourceStoreId: plan.options.adoptStoreId, targetStoreRoot: String(engineConfig.baseDbPath),
          storeProbe: plan.sourceEmbedding ? sourceStoreCopyProbe(activeConfig, plan.sourceEmbedding, job.home, testInternals)
            : configuredStoreCopyProbe(activeConfig, job.home, testInternals) } : {}),
        ...(testInternals ? { testInternals } : {}),
        maintenanceRunId: job.runId,
        onProgress: entityProgress,
        onConflict: plan.options.onConflict ?? "skip", configPort: config, extensionPort: extensionPort(port),
        targetLock: <T>(run: () => Promise<T>) => run() };
      report = plan.sourceType === "openclaw" ? await importOpenclaw(common) : await importHermes({ ...common,
        ...(plan.options.mapProfiles ? { mapProfiles: Object.fromEntries(plan.options.mapProfiles
          .map(mapping => [mapping.profile, mapping.agentId])) } : {}),
        mergeProfiles: plan.options.mergeProfiles ?? false,
        ...(plan.options.adoptStrategy === "re-embed" ? { adoptStrategy: "reembed" } : {}),
      });
      assertImportReportComplete(report);
      requireSelectedStoreTransfer(report, plan.options);
      const skills = await importSkills({ home: job.home, source, reader, sourceType: plan.sourceType,
        ...selected,
        runId: job.runId, reportNamespace: "skills", importLock: () => () => {},
        apply: true, enable: false, onConflict: plan.options.onConflict ?? "skip", maxBytes: 16 * 1024 * 1024,
        signal: port.signal, onProgress: entityProgress }, renderSkills);
      if (skills.errors.length || skills.skills.some(skill => skill.outcome === "failed" || skill.outcome === "refused")) {
        throw new ImportError("E_IMPORT_FAILED", "entity-failed", "Import entity failed");
      }
      if (migrated) {
        report.secrets.opted_in = true;
        report.secrets.allowlistedKeysImported = migrated.imported;
        const imported = new Set(migrated.imported);
        report.secrets.foundNotImported = report.secrets.foundNotImported.filter(name => !imported.has(name));
        report.secrets.unmigrated_secrets = report.secrets.foundNotImported;
        report.secrets.count = report.secrets.foundNotImported.length;
        writeAtomicSync(join(job.home, "imports", job.runId, "report.json"), JSON.stringify(report, null, 2) + "\n");
      }
    },
  });
  if (report && result.ok) {
    const digest = await streamRegular(join(job.home, "imports", job.runId, "report.json"));
    result.report = { schema: report.schema, sha256: digest.sha256, bytes: digest.size };
  }
  return result;
}

/** Fixed diagnostics only. A broken parent channel leaves a durable recoverable journal and returns nonzero. */
export async function runSupervisedImport(): Promise<number> {
  let port: ImportWorkerPort | undefined;
  try {
    port = await openImportWorkerPort({ input: process.stdin, output: process.stdout });
    const result = await perform(port);
    await port.result(result);
    return result.ok ? 0 : 1;
  } catch {
    if (port) await port.result({ ok: false, status: "failed", restored: false, resumable: true,
      error: { code: "E_IMPORT_FAILED", reason: "worker-unavailable" } }).catch(() => {});
    else process.stderr.write("Import worker is unavailable\n");
    return 1;
  } finally {
    port?.close();
  }
}
