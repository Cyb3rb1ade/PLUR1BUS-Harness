// Hermes importer pipeline (docs/import.md §3, §5, M7 Batch 3).
// Migrates profiles to agents, persona (SOUL.md) and USER.md into `l.workspaceDir(id)`,
// ingests memory cards via Engine.memory.import (batch size <= 500),
// extracts channel pairings (approved hashed, pending excluded),
// reports cron as deferred (zero disk writes),
// supports existing store take-over via Engine.stores.adopt (--adopt-store),
// enforces single-writer lock withTargetLock,
// writes pre-apply snapshot for rollback, records atomic ledger.jsonl, and supports conflict strategies.
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaults, validate } from "@plur1bus/config-schema";
import { layout } from "../../paths.ts";
import {
  channelIdempotencyKey,
  cronIdempotencyKey,
  ImportLedger,
  type ConflictStrategy,
} from "../ledger.ts";
import { isFile, readBounded } from "../readonly.ts";
import { createTargetSnapshot } from "../snapshot-target.ts";
import { detectHermes } from "../sources/hermes.ts";
import { newRunId } from "../skills-import.ts";
import { withTargetLock } from "../single-writer.ts";
import { targetIdentity } from "../identity.ts";
import { ImportError, type SourceCtx } from "../types.ts";
import { writeAtomicSync } from "../fs-atomic.ts";
import { RUN_ID_RE } from "../rollback.ts";
import { planAndMigrateHermesAgent } from "./hermes-agents.ts";
import { importHermesMemories, type HermesMemoryImportResult } from "./hermes-memories.ts";
import { readHermesPairings, type HermesChannelAllowlistReport } from "./hermes-platforms.ts";
import { readHermesCronJobs, type HermesCronJob } from "./hermes-cron.ts";
import { adoptStore, type StoreAdoptReport } from "./hermes-stores.ts";
import { createEngine } from "@cyb3rb1ade/plur1bus-memory/engine/create-engine.js";
import { buildEngineConfig } from "../../engine-config.ts";
import { platformCapabilities } from "../../platform.ts";
import type { AgentImportReport } from "./openclaw-agents.ts";
import type { Engine, HostServices } from "@cyb3rb1ade/plur1bus-memory/types/engine.js";

function createImportHost(stateDir: string, workspaceDir: (id: string) => Promise<string>): HostServices {
  return {
    logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
    stateDir,
    configPath: () => join(stateDir, "config.json"),
    workspaceDir: async (id: string) => workspaceDir(id),
    config: () => ({} as any),
    platform: {
      os: process.platform,
      arch: process.arch,
      memoryTotalBytes: () => 0,
      memoryFreeBytes: () => 0,
      ...platformCapabilities,
    },
    runtime: null,
  } as unknown as HostServices;
}

export interface HermesImportOptions {
  home: string;
  source?: string | undefined;
  profile?: string | undefined;
  apply?: boolean | undefined;
  migrateSecrets?: boolean | undefined;
  onConflict?: ConflictStrategy | undefined;
  resume?: string | undefined;
  adoptStore?: string | undefined;
  env?: NodeJS.ProcessEnv | undefined;
  homedir?: string | undefined;
  platform?: NodeJS.Platform | undefined;
  probeWsl?: boolean | undefined;
  allowLiveCopy?: boolean | undefined;
  now?: () => Date;
  engine?: Engine | undefined;
  testInternals?: Record<string, unknown> | undefined;
  userPrincipal?: any | undefined;
}

export interface HermesProfileImportReport extends AgentImportReport {
  memory?: HermesMemoryImportResult | undefined;
}

export interface HermesImportReport {
  importId: string;
  runId: string;
  schema: "import.hermes/1";
  sourceType: "hermes";
  sourceVersion: string;
  source: {
    root: string;
    resolvedFrom: string;
    configPath: string | null;
    profile: string | null;
  };
  mode: "dry-run" | "apply";
  harness: {
    home: string;
  };
  profilesOrAgents: HermesProfileImportReport[];
  agents: HermesProfileImportReport[]; // backward compatibility alias
  channels: HermesChannelAllowlistReport[];
  cron: {
    status: "deferred";
    count: number;
    jobs: HermesCronJob[];
    excludedCount: number;
  };
  storeAdopt?: StoreAdoptReport | undefined;
  secrets: {
    opted_in: boolean;
    allowlistedKeysImported: string[];
    foundNotImported: string[];
    unmigrated_secrets: string[];
    count: number;
  };
  archived: Array<{ kind: string; path: string }>;
  errors: Array<{ sourceRef: string; reason: string }>;
  counts: {
    agentsCreated: number;
    agentsMatched: number;
    agentsRejected: number;
    filesCreated: number;
    filesMatched: number;
    filesConflicted: number;
    filesRenamed: number;
    filesReplaced: number;
    filesSkipped: number;
    memoryCardsImported: number;
    memoryCardsSkippedDuplicate: number;
    memoryCardsRejected: number;
    unresolvedUserScope: number;
    channelsDeferred: number;
    cronJobsDeferred: number;
    corruptLedgerLines?: number;
  };
  snapshot: {
    path: string;
    existed: boolean;
    manifestSha256?: string;
  } | null;
  ledgerPath: string | null;
  reportPath: string | null;
  startedAt: string;
  finishedAt: string;
}

export async function importHermes(opts: HermesImportOptions): Promise<HermesImportReport> {
  const env = opts.env ?? process.env;
  const homedir = opts.homedir ?? (process.platform === "win32" ? env.USERPROFILE ?? "" : env.HOME ?? "");
  const platform = opts.platform ?? process.platform;
  const l = layout(opts.home);
  const startDate = opts.now ? opts.now() : new Date();

  const startedAt = startDate.toISOString();
  const onConflict: ConflictStrategy = opts.onConflict ?? "skip";

  // Refuse --migrate-secrets until M2
  if (opts.migrateSecrets) {
    throw new ImportError("E_SECRET_STORE_UNAVAILABLE", "secret-store-unavailable", "secret store unavailable until M2");
  }

  const executeImport = async (isApply: boolean): Promise<HermesImportReport> => {
    let runId: string;
    if (opts.resume) {
      if (!RUN_ID_RE.test(opts.resume)) {
        throw new ImportError("E_INVALID_PARAMS", "resume-id-invalid", `--resume must be a valid run ID: ${opts.resume}`);
      }
      runId = opts.resume;
      const runDir = join(l.home, "imports", runId);
      if (!existsSync(runDir)) {
        throw new ImportError("E_RESUME_INVALID", "run-not-resumable", `resumed run does not exist: ${runId}`);
      }
      const rolledBackStatus = join(runDir, "rolled-back", "status.json");
      if (existsSync(rolledBackStatus)) {
        throw new ImportError("E_RESUME_INVALID", "run-not-resumable", `cannot resume a run that has already been rolled back: ${runId}`);
      }
      const snapManifest = join(runDir, "snapshot", "manifest.json");
      if (!existsSync(snapManifest)) {
        throw new ImportError("E_RESUME_INVALID", "run-not-resumable", `run ${runId} is missing snapshot manifest`);
      }
      try {
        const manifestRaw = readFileSync(snapManifest, "utf8");
        JSON.parse(manifestRaw);
      } catch (err: any) {
        throw new ImportError("E_RESUME_INVALID", "run-not-resumable", `run ${runId} snapshot manifest is unreadable or corrupt: ${err.message}`);
      }
    } else {
      runId = newRunId(startDate);
    }

    const repDir = join(l.home, "imports", runId);

    // Detect Hermes source
    const ctx: SourceCtx = {
      sourceType: "hermes",
      source: opts.source,
      profile: opts.profile,
      env,
      homedir,
      platform,
      home: opts.home,
      target: targetIdentity(opts.home),
      probeWsl: opts.probeWsl,
      allowLiveCopy: opts.allowLiveCopy,
    };
    const sourceReport = await detectHermes(ctx);

    const touchedAgentIds = sourceReport.agents.map((a) => a.agentId);

    // Read target config.json if present, else defaults
    let rawConfig: any;
    if (existsSync(l.configPath)) {
      try {
        rawConfig = JSON.parse(readFileSync(l.configPath, "utf8"));
      } catch (e: any) {
        throw new ImportError("E_CONFIG_INVALID", "target-config-corrupt", `target config is not valid JSON: ${e.message}`);
      }
    } else {
      rawConfig = defaults();
    }

    rawConfig.agents = rawConfig.agents ?? {};
    const existingAgentIds = new Set(Object.keys(rawConfig.agents));

    // Pre-apply snapshot of target state
    let snapshotResult: { path: string; existed: boolean; manifestSha256: string } | null = null;
    let ledger: ImportLedger | undefined = undefined;
    let ledgerPath: string | null = null;
    let replacedBackupDir: string | undefined = undefined;

    if (isApply) {
      mkdirSync(repDir, { recursive: true, mode: 0o700 });
      if (opts.resume) {
        const snapManifestPath = join(repDir, "snapshot", "manifest.json");
        const manifestRaw = readFileSync(snapManifestPath, "utf8");
        const manifestSha256 = createHash("sha256").update(manifestRaw).digest("hex");
        const parsedManifest = JSON.parse(manifestRaw);
        snapshotResult = {
          path: join(repDir, "snapshot"),
          existed: parsedManifest.configExisted || parsedManifest.agentsExisted,
          manifestSha256,
        };
      } else {
        snapshotResult = createTargetSnapshot(l, repDir, runId, touchedAgentIds, () => startDate);
      }
      ledgerPath = join(repDir, "ledger.jsonl");
      ledger = new ImportLedger(ledgerPath, runId);
      replacedBackupDir = join(repDir, "replaced");
    }

    // Obtain Engine instance for memory cards and store adoption
    let engine = opts.engine;
    let createdEngineLocally = false;
    if (!engine) {
      engine = createEngine(
        createImportHost(l.state, async (id: string) => l.workspaceDir(id)),
        buildEngineConfig(rawConfig, l) as any,
        opts.testInternals ? { internals: opts.testInternals } : undefined,
      );
      createdEngineLocally = true;
    }

    try {
      // 1. Store Take-Over (--adopt-store)
      let storeAdoptReport: StoreAdoptReport | undefined = undefined;
      if (opts.adoptStore) {
        storeAdoptReport = await adoptStore({
          sourceStorePath: opts.adoptStore,
          l,
          engine,
          isApply,
          ledger,
          onConflict,
          replacedBackupDir,
        });

        if (storeAdoptReport.verdict === "incompatible") {
          throw new ImportError(
            "E_STORE_INCOMPATIBLE",
            storeAdoptReport.reason ?? "identity-mismatch",
            `store adoption failed: ${storeAdoptReport.reason}`,
          );
        }
      }

      // 2. Migrate agents, SOUL.md, USER.md and memory cards
      const profileReports: HermesProfileImportReport[] = [];
      const seenProfileAgentIds = new Set<string>();
      let configChanged = false;

      let totalCardsImported = 0;
      let totalCardsSkippedDuplicate = 0;
      let totalCardsRejected = 0;
      let totalUnresolvedUserScope = 0;

      for (const agent of sourceReport.agents) {
        const normId = typeof agent.agentId === "string" ? agent.agentId.toLowerCase() : "";
        if (seenProfileAgentIds.has(normId)) {
          profileReports.push({
            sourceId: agent.agentId,
            harnessAgentId: agent.agentId,
            action: "rejected",
            reason: "duplicate-agent-id",
            workspaceDir: "",
            files: [],
            counts: {
              filesCreated: 0,
              filesMatched: 0,
              filesConflicted: 0,
              filesRenamed: 0,
              filesReplaced: 0,
              filesSkipped: 0,
            },
          });
          continue;
        }
        seenProfileAgentIds.add(normId);

        const agentWorkspace = agent.workspace ?? sourceReport.source.root;

        // Migrate agent persona and files
        const { report: agentReport, isNewAgent } = planAndMigrateHermesAgent(
          agent.agentId,
          agentWorkspace,
          sourceReport.source.root,
          l,
          existingAgentIds,
          isApply,
          onConflict,
          ledger,
          replacedBackupDir,
        );

        if (agentReport.action !== "rejected" && isNewAgent && isApply) {
          rawConfig.agents[agent.agentId] = { createdAt: startDate.toISOString() };
          configChanged = true;
        }

        // Migrate memory cards
        const memoryRes = await importHermesMemories({
          profileDir: agentWorkspace,
          profileName: agent.agentId,
          agentId: agent.agentId,
          l,
          engine,
          isApply,
          ledger,
          userPrincipal: opts.userPrincipal,
        });

        totalCardsImported += memoryRes.importedCount;
        totalCardsSkippedDuplicate += memoryRes.skippedDuplicateCount;
        totalCardsRejected += memoryRes.rejectedCount;
        totalUnresolvedUserScope += memoryRes.unresolvedUserScopeCount;

        profileReports.push({
          ...agentReport,
          memory: memoryRes,
        });
      }

      // 3. Read pairing allowlists
      const searchDirs = [
        ...new Set(
          [sourceReport.source.root, ...sourceReport.agents.map((a) => a.workspace)].filter(
            (w): w is string => typeof w === "string" && w.length > 0,
          ),
        ),
      ];
      const channelReports = readHermesPairings(searchDirs);
      if (isApply && ledger) {
        for (const ch of channelReports) {
          ledger.record({
            entity: "channel",
            idempotencyKey: channelIdempotencyKey(ch.platform, ch.allowFromHashes),
            action: "deferred",
            sourceRef: `platforms/pairing/${ch.platform}-approved.json`,
            details: { platform: ch.platform, count: ch.count },
          });
        }
      }

      // 4. Read user cron jobs
      const cronProfiles = sourceReport.agents
        .filter((a): a is typeof a & { workspace: string } => typeof a.workspace === "string" && a.workspace.length > 0)
        .map((a) => ({ agentId: a.agentId, dir: a.workspace }));
      const { userJobs, excludedCount: cronExcludedCount } = readHermesCronJobs(cronProfiles);
      if (isApply && ledger) {
        for (const job of userJobs) {
          ledger.record({
            entity: "cron",
            idempotencyKey: cronIdempotencyKey(job.id, job.schedule),
            action: "deferred",
            sourceRef: job.id,
            details: { id: job.id, schedule: job.schedule },
          });
        }
      }

      // 5. Collect secret key names
      const secretKeySet = new Set<string>();
      for (const envGroup of sourceReport.secrets.envKeys) {
        for (const k of envGroup.keys) secretKeySet.add(k);
      }
      for (const ck of sourceReport.secrets.configKeys) {
        secretKeySet.add(ck.path);
      }
      for (const sf of sourceReport.secrets.files) {
        secretKeySet.add(sf.path);
      }
      const unmigratedSecrets = [...secretKeySet].sort();

      // If applying and config changed, validate schema and write target config.json
      if (isApply && (configChanged || !existsSync(l.configPath))) {
        const check = validate(rawConfig);
        if (!check.ok) {
          throw new ImportError("E_CONFIG_INVALID", "config-invalid", check.errors.join("; "));
        }
        writeAtomicSync(l.configPath, `${JSON.stringify(rawConfig, null, 2)}\n`, 0o600);
      }

      // Compute counts
      const agentsCreated = profileReports.filter((a) => a.action === "created").length;
      const agentsMatched = profileReports.filter((a) => a.action === "matched-existing").length;
      const agentsRejected = profileReports.filter((a) => a.action === "rejected").length;
      const filesCreated = profileReports.reduce((n, a) => n + a.counts.filesCreated, 0);
      const filesMatched = profileReports.reduce((n, a) => n + a.counts.filesMatched, 0);
      const filesConflicted = profileReports.reduce((n, a) => n + a.counts.filesConflicted, 0);
      const filesRenamed = profileReports.reduce((n, a) => n + a.counts.filesRenamed, 0);
      const filesReplaced = profileReports.reduce((n, a) => n + a.counts.filesReplaced, 0);
      const filesSkipped = profileReports.reduce((n, a) => n + a.counts.filesSkipped, 0);

      const errors: Array<{ sourceRef: string; reason: string }> = [];
      for (const a of profileReports) {
        if (a.action === "rejected") {
          errors.push({ sourceRef: a.sourceId, reason: a.reason ?? "rejected" });
        }
      }

      const finishedDate = opts.now ? opts.now() : new Date();
      let reportPath: string | null = null;

      const resultReport: HermesImportReport = {
        importId: runId,
        runId,
        schema: "import.hermes/1",
        sourceType: "hermes",
        sourceVersion: sourceReport.version?.configVersion ? String(sourceReport.version.configVersion) : "unknown",
        source: {
          root: sourceReport.source.root,
          resolvedFrom: sourceReport.source.resolvedFrom,
          configPath: sourceReport.source.configPath,
          profile: sourceReport.source.profile,
        },
        mode: isApply ? "apply" : "dry-run",
        harness: {
          home: l.home,
        },
        profilesOrAgents: profileReports,
        agents: profileReports,
        channels: channelReports,
        cron: {
          status: "deferred",
          count: userJobs.length,
          jobs: userJobs,
          excludedCount: cronExcludedCount,
        },
        storeAdopt: storeAdoptReport,
        secrets: {
          opted_in: false,
          allowlistedKeysImported: [],
          foundNotImported: unmigratedSecrets,
          unmigrated_secrets: unmigratedSecrets,
          count: unmigratedSecrets.length,
        },
        archived: [],
        errors: [
          ...errors,
          ...(ledger && ledger.corruptLineCount > 0
            ? [{ sourceRef: ledger.filePath, reason: `corrupt-ledger-lines:${ledger.corruptLineCount}` }]
            : []),
        ],
        counts: {
          agentsCreated,
          agentsMatched,
          agentsRejected,
          filesCreated,
          filesMatched,
          filesConflicted,
          filesRenamed,
          filesReplaced,
          filesSkipped,
          memoryCardsImported: totalCardsImported,
          memoryCardsSkippedDuplicate: totalCardsSkippedDuplicate,
          memoryCardsRejected: totalCardsRejected,
          unresolvedUserScope: totalUnresolvedUserScope,
          channelsDeferred: channelReports.length,
          cronJobsDeferred: userJobs.length,
          corruptLedgerLines: ledger?.corruptLineCount ?? 0,
        },
        snapshot: snapshotResult
          ? {
              path: snapshotResult.path,
              existed: snapshotResult.existed,
              manifestSha256: snapshotResult.manifestSha256,
            }
          : null,
        ledgerPath,
        reportPath,
        startedAt,
        finishedAt: finishedDate.toISOString(),
      };

      if (isApply) {
        reportPath = join(repDir, "report.json");
        resultReport.reportPath = reportPath;
        writeAtomicSync(reportPath, `${JSON.stringify(resultReport, null, 2)}\n`, 0o600);
      }

      return resultReport;
    } finally {
      if (createdEngineLocally && engine) {
        await engine.close({ budgetMs: 5_000 });
      }
    }
  };

  // Pre-flight check for store adoption: if incompatible, abort before acquiring lock or touching target
  if (opts.adoptStore) {
    let rawConfig: any;
    if (existsSync(l.configPath)) {
      try {
        rawConfig = JSON.parse(readFileSync(l.configPath, "utf8"));
      } catch (e: any) {
        throw new ImportError("E_CONFIG_INVALID", "target-config-corrupt", `target config is not valid JSON: ${e.message}`);
      }
    } else {
      rawConfig = defaults();
    }
    let preflightEngine = opts.engine;
    let tmpCheckDir: string | null = null;
    if (!preflightEngine) {
      tmpCheckDir = mkdtempSync(join(tmpdir(), "p1b-adopt-check-"));
      preflightEngine = createEngine(
        createImportHost(join(tmpCheckDir, "state"), async (id: string) => join(tmpCheckDir!, "workspaces", id)),
        buildEngineConfig(rawConfig, layout(tmpCheckDir)) as any,
        opts.testInternals ? { internals: opts.testInternals } : undefined,
      );
    }
    try {
      const preCheck = await adoptStore({
        sourceStorePath: opts.adoptStore,
        l,
        engine: preflightEngine,
        isApply: false,
      });
      if (preCheck.verdict === "incompatible") {
        throw new ImportError(
          "E_STORE_INCOMPATIBLE",
          preCheck.reason ?? "identity-mismatch",
          `store adoption failed: ${preCheck.reason}`,
        );
      }
    } finally {
      if (tmpCheckDir) {
        try {
          await preflightEngine.close({ budgetMs: 1_000 });
        } catch {}
        rmSync(tmpCheckDir, { recursive: true, force: true });
      }
    }
  }

  if (opts.apply) {
    return await withTargetLock(l, async () => {
      return await executeImport(true);
    });
  }

  return await executeImport(false);
}
