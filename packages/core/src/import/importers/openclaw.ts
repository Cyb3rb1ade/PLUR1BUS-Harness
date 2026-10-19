// OpenClaw importer pipeline (docs/import.md §1, §2, §5, M7 Batch 2 & Batch 4).
// Migrates agents, persona (SOUL.md), D15 curated files into `l.workspaceDir(id)`,
// extracts channel allowlists, reports cron as deferred (zero disk writes),
// reports secrets by key name only, enforces single-writer lock withTargetLock,
// writes pre-apply snapshot for rollback, records atomic ledger.jsonl, and supports conflict strategies.
import { importedProfile } from "../../openai-auth/profiles.ts";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
} from "node:fs";
import { join } from "node:path";
import { defaults, validate } from "@plur1bus/config-schema";
import { layout } from "../../paths.ts";
import { parseJson5 } from "../json5.ts";
import {
  channelIdempotencyKey,
  cronIdempotencyKey,
  ImportLedger,
  type ConflictStrategy,
} from "../ledger.ts";
import { existsNoFollow, readSourceTextSafe } from "../fs-safe.ts";
import { createTargetSnapshot } from "../snapshot-target.ts";
import { detectOpenclaw } from "../sources/openclaw.ts";
import { newRunId } from "../skills-import.ts";
import { withTargetLock } from "../single-writer.ts";
import { targetIdentity } from "../identity.ts";
import { ImportError, type SourceCtx } from "../types.ts";
import { planAndMigrateAgent, type AgentImportReport } from "./openclaw-agents.ts";
import { readOpenclawChannels, type ChannelAllowlistReport } from "./openclaw-channels.ts";
import { readOpenclawCronJobs, type OpenclawCronJob } from "./openclaw-cron.ts";
import { writeAtomicSync } from "../fs-atomic.ts";
import { RUN_ID_RE } from "../rollback.ts";
import { readConfigFile } from "../../config-load.ts";
import { abortStoreAdopt, createTempHost, type StoreAdoptReport } from "./hermes-stores.ts";
import { commitOpenclawStores, prepareOpenclawStores, type OpenclawStoreReport, type PreparedOpenclawStores } from "./openclaw-stores.ts";
import { createEngine } from "@cyb3rb1ade/plur1bus-memory/engine/create-engine.js";
import { buildEngineConfig } from "../../engine-config.ts";
import type { Engine } from "@cyb3rb1ade/plur1bus-memory/types/engine.js";
import { hasOpenclawCardFiles, importOpenclawMemories, type OpenclawMemoryImportResult } from "./openclaw-memories.ts";
import { PARK_DEFERRED, PARK_PENDING_REEMBED, readPriorCardLinks, type OwnStoreCardMode, type PriorCardLink } from "./card-links.ts";

export interface OpenclawImportOptions {
  home: string;
  source?: string | undefined;
  apply?: boolean | undefined;
  migrateSecrets?: boolean | undefined;
  onConflict?: ConflictStrategy | undefined;
  resume?: string | undefined;
  env?: NodeJS.ProcessEnv | undefined;
  homedir?: string | undefined;
  platform?: NodeJS.Platform | undefined;
  probeWsl?: boolean | undefined;
  allowLiveCopy?: boolean | undefined;
  now?: () => Date;
  userPrincipal?: any | undefined;
  engine?: Engine | undefined;
  /** Test seam: the engine internals (e.g. a stub embedder) used for the store take-over probe. */
  testInternals?: Record<string, unknown> | undefined;
  /** Test seam: throw right after this step of the store take-over (`store-staged`: copy verified, not yet swapped;
   *  `store-committed`: swapped into state/lancedb) to prove abort cleanup and resume. */
  failAfterStep?: "store-staged" | "store-committed" | undefined;
}

export interface OpenclawImportReport {
  importId: string;
  runId: string;
  schema: "import.openclaw/1";
  sourceType: "openclaw";
  sourceVersion: string;
  source: {
    root: string;
    resolvedFrom: string;
    configPath: string | null;
  };
  mode: "dry-run" | "apply";
  harness: {
    home: string;
  };
  disabledAuthProfiles?: ReturnType<typeof importedProfile>[];
  profilesOrAgents: (AgentImportReport & { memory?: OpenclawMemoryImportResult | undefined })[];
  agents: (AgentImportReport & { memory?: OpenclawMemoryImportResult | undefined })[]; // backward compatibility alias
  channels: ChannelAllowlistReport[];
  cron: {
    status: "deferred";
    count: number;
    jobs: OpenclawCronJob[];
    excludedCount: number;
  };
  secrets: {
    opted_in: boolean;
    allowlistedKeysImported: string[];
    foundNotImported: string[];
    unmigrated_secrets: string[]; // backward compatibility alias
    count: number;
  };
  /** One entry per PLUR1BUS store partition of the source: taken over, matched, routed to re-embedding, or skipped. */
  stores: OpenclawStoreReport[];
  storeAdopt?: StoreAdoptReport | undefined;
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
    /** Cards of agents with their own store that duplicate a memory already in it: linked to it, not written again. */
    memoryCardsLinked: number;
    /** Cards of agents whose own store is routed to the re-embedding migration: parked, imported by a later run. */
    memoryCardsPendingReembed: number;
    /** Cards of agents whose own store was not taken over for another reason: deferred to a later run. */
    memoryCardsDeferred: number;
    unresolvedUserScope: number;
    channelsDeferred: number;
    channelsImported: number; // backward compatibility
    cronJobsDeferred: number;
    storesTakenOver: number;
    storesMatched: number;
    storesReembedMigration: number;
    storesSkipped: number;
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

/** The config the probe engine is built from: the validated target config, like `targetIdentity` reads it (the defaults
 *  when the file is missing or invalid, so the identity compared against is the one the report names). */
function engineTargetConfig(configPath: string) {
  try { return readConfigFile(configPath); } catch { return defaults(); }
}

export async function importOpenclaw(opts: OpenclawImportOptions): Promise<OpenclawImportReport> {
  const env = opts.env ?? process.env;
  const homedir = opts.homedir ?? (process.platform === "win32" ? env.USERPROFILE ?? "" : env.HOME ?? "");
  const platform = opts.platform ?? process.platform;
  const l = layout(opts.home);
  const startDate = opts.now ? opts.now() : new Date();

  const startedAt = startDate.toISOString();
  const onConflict: ConflictStrategy = opts.onConflict ?? "skip";

  // P4: Refuse --migrate-secrets until M2
  if (opts.migrateSecrets) {
    throw new ImportError("E_SECRET_STORE_UNAVAILABLE", "secret-store-unavailable", "secret store unavailable until M2");
  }

  // A staged store copy that never reached the swap (any failure before it) is removed again by the caller's finally.
  let preparedStores: PreparedOpenclawStores | undefined;

  const executeImport = async (isApply: boolean): Promise<OpenclawImportReport> => {
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

    // Detect OpenClaw source
    const ctx: SourceCtx = {
      sourceType: "openclaw",
      source: opts.source,
      env,
      homedir,
      platform,
      home: opts.home,
      target: targetIdentity(opts.home),
      probeWsl: opts.probeWsl,
      allowLiveCopy: opts.allowLiveCopy,
    };
    const sourceReport = await detectOpenclaw(ctx);

    const touchedAgentIds = sourceReport.agents.map((a) => a.agentId);

    // Pre-apply snapshot of target state (taken after detect and validation, under lock)
    let snapshotResult: { path: string; existed: boolean; manifestSha256: string } | null = null;
    let ledger: ImportLedger | undefined = undefined;
    let ledgerPath: string | null = null;
    let replacedBackupDir: string | undefined = undefined;

    if (isApply) {
      mkdirSync(repDir, { recursive: true, mode: 0o700 });
      if (opts.resume) {
        const snapManifestPath = join(repDir, "snapshot", "manifest.json");
        if (!existsSync(snapManifestPath)) {
          throw new ImportError("E_RESUME_INVALID", "run-not-resumable", `run ${runId} is missing snapshot manifest`);
        }
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

    // PLUR1BUS stores: each partition is taken over (identity matches, no re-embedding) or routed to the guided
    // re-embedding migration. Staged and verified on a COPY, swapped in under the lock, before anything else is written.
    preparedStores = await prepareOpenclawStores({
      stores: sourceReport.plur1bus.stores,
      storeRoot: sourceReport.plur1bus.storeRoot,
      l,
      isApply,
      runId,
      onConflict,
      targetConfig: engineTargetConfig(l.configPath),
      targetEmbedding: ctx.target.embedding,
      testInternals: opts.testInternals,
      resumeLedgerText: opts.resume && ledgerPath && existsSync(ledgerPath) ? readFileSync(ledgerPath, "utf8") : undefined,
    });
    if (opts.failAfterStep === "store-staged") throw new Error("failAfterStep: store-staged");
    if (isApply) commitOpenclawStores(preparedStores, { l, ledger, replacedBackupDir });
    if (opts.failAfterStep === "store-committed") throw new Error("failAfterStep: store-committed");

    let engine = opts.engine;
    let createdEngineLocally = false;
    const testInternals = opts.testInternals;

    // The engine is opened on first use only: an import with no card to write (no MEMORY.md / USER.md, or only cards that
    // are parked) never creates or touches state/lancedb through it.
    const ensureEngine = (): void => {
      if (!isApply || engine) return;
      const engineDefaults = defaults().engine;
      const engineConfigTarget = {
        ...defaults(),
        ...rawConfig,
        core: {
          ...defaults().core,
          ...(rawConfig.core ?? {}),
          recall: {
            ...defaults().core.recall,
            ...(rawConfig.core?.recall ?? {}),
          },
        },
        engine: {
          ...engineDefaults,
          ...(rawConfig.engine?.baseDbPathOverride ? { baseDbPathOverride: rawConfig.engine.baseDbPathOverride } : {}),
          ...(rawConfig.engine?.embedding ? { embedding: rawConfig.engine.embedding } : {}),
          ...(rawConfig.engine?.reranker ? { reranker: rawConfig.engine.reranker } : {}),
          ...(rawConfig.engine?.recall ? { recall: rawConfig.engine.recall } : {}),
        },
      };

      engine = createEngine(
        createTempHost(l.state, async (id: string) => l.workspaceDir(id)),
        buildEngineConfig(engineConfigTarget, l) as any,
        testInternals ? { internals: testInternals } : undefined,
      );
      createdEngineLocally = true;
    };

    try {
      // Migrate agents, curated files and memory cards
      const agentReports: (AgentImportReport & { memory?: OpenclawMemoryImportResult | undefined })[] = [];
      const seenSourceAgentIds = new Set<string>();
      let configChanged = false;
      let totalCardsImported = 0;
      let totalCardsSkippedDuplicate = 0;
      let totalCardsRejected = 0;
      let totalUnresolvedUserScope = 0;
      let totalCardsLinked = 0;
      let totalCardsPendingReembed = 0;
      let totalCardsDeferred = 0;
      // Agents with a PLUR1BUS store partition of their own (owner decision 2026-10-19): their cards are imported too.
      // Store in the harness (taken over, matched, dry-run preview-ok) -> import with duplicate linking; store routed to
      // the re-embedding migration -> parked as pending-reembed; store not taken over (skipped) -> deferred.
      const ownStoreModes = new Map<string, OwnStoreCardMode>();
      const priorLinks = isApply ? readPriorCardLinks(join(l.home, "imports")) : new Map<string, PriorCardLink>();
      for (const st of preparedStores.stores) {
        if (st.kind !== "agent" || !st.agentId) continue;
        const id = st.agentId.toLowerCase();
        const mode: OwnStoreCardMode = st.action === "re-embedding-migration"
          ? PARK_PENDING_REEMBED
          : st.action === "skipped"
            ? PARK_DEFERRED
            : { kind: "link", priorLinks };
        const prev = ownStoreModes.get(id);
        // Several partitions for one agent: the most cautious verdict wins (pending-reembed > deferred > link).
        const rank = (m: OwnStoreCardMode) => (m.kind === "link" ? 0 : m.outcome === "deferred" ? 1 : 2);
        if (!prev || rank(mode) > rank(prev)) ownStoreModes.set(id, mode);
      }
      const errors: Array<{ sourceRef: string; reason: string }> = [...(sourceReport.errors ?? []), ...preparedStores.errors];

      for (const agent of sourceReport.agents) {
        const normId = typeof agent.agentId === "string" ? agent.agentId.toLowerCase() : "";
        if (seenSourceAgentIds.has(normId)) {
          // C3: Duplicate agent IDs in source rejected
          agentReports.push({
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
        seenSourceAgentIds.add(normId);

        const { report, isNewAgent } = planAndMigrateAgent(
          agent,
          sourceReport.source.root,
          l,
          existingAgentIds,
          isApply,
          onConflict,
          ledger,
          replacedBackupDir,
        );

        if (report.action !== "rejected" && isNewAgent && isApply) {
          rawConfig.agents[agent.agentId] = { createdAt: startDate.toISOString() };
          configChanged = true;
        }

        let memoryRes: OpenclawMemoryImportResult | undefined;
        if (report.action !== "rejected") {
          const agentWs = agent.workspace ?? sourceReport.source.root;
          const ownStore = ownStoreModes.get(normId);
          if (ownStore?.kind !== "park" && hasOpenclawCardFiles(agentWs)) ensureEngine();
          memoryRes = await importOpenclawMemories({
            workspaceDir: agentWs,
            agentId: agent.agentId,
            l,
            engine,
            isApply,
            ledger,
            userPrincipal: opts.userPrincipal,
            onConflict,
            replacedBackupDir,
            ...(ownStore ? { ownStore } : {}),
          });
          totalCardsLinked += memoryRes.linkedCount;
          totalCardsPendingReembed += memoryRes.pendingReembedCount;
          totalCardsDeferred += memoryRes.deferredCount;
          totalCardsImported += memoryRes.importedCount;
          totalCardsSkippedDuplicate += memoryRes.skippedDuplicateCount;
          totalCardsRejected += memoryRes.rejectedCount;
          totalUnresolvedUserScope += memoryRes.unresolvedUserScopeCount;
          if (memoryRes.errors.length > 0) {
            for (const err of memoryRes.errors) errors.push(err);
          }
        }

        agentReports.push({
          ...report,
          ...(memoryRes ? { memory: memoryRes } : {}),
        });
      }

    // Read channels from openclaw.json
    let channelReports: ChannelAllowlistReport[] = [];
    let disabledAuthProfiles: ReturnType<typeof importedProfile>[] = [];
    if (sourceReport.source.configPath && existsNoFollow(sourceReport.source.configPath)) {
      let cfgText: string | null = null;
      try {
        cfgText = readSourceTextSafe(sourceReport.source.configPath, 16 * 1024 * 1024);
      } catch (error) {
        errors.push({
          sourceRef: "openclaw.json",
          reason: error instanceof ImportError ? error.reason : "source-unreadable",
        });
      }
      if (cfgText !== null) {
        try {
          const rawCfg = parseJson5(cfgText) as Record<string, unknown>;
          channelReports = readOpenclawChannels(rawCfg);
          // Metadata only. Never open another client's token store or retain its issued ID.
          const auth = rawCfg.auth as { profiles?: Record<string, { provider?: unknown; mode?: unknown }> } | undefined;
          const oldId = "openai:chatgpt-oauth-restricted";
          if (auth?.profiles && Object.entries(auth.profiles).some(([id, p]) => id === oldId ||
              (p && ["openai", "openai-codex"].includes(String(p.provider)) && p.mode === "oauth"))) {
            disabledAuthProfiles = [importedProfile(oldId)];
          }
          if (isApply && ledger) {
            for (const ch of channelReports) {
              ledger.record({
                entity: "channel",
                idempotencyKey: channelIdempotencyKey(ch.platform, [...ch.allowFromFingerprints, ...ch.groupFingerprints.map((f) => `g:${f}`)]),
                action: "deferred",
                sourceRef: `${ch.platform}:allowFrom`,
                details: { count: ch.allowFromCount, groups: ch.groupsCount },
              });
            }
          }
        } catch {
          // Ignored if unparseable
        }
      }
    }

    // Read user cron jobs from state/openclaw.sqlite (P5: deferred, zero writes)
    const { userJobs, excludedCount: cronExcludedCount } = readOpenclawCronJobs(sourceReport.source.root);
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

    // Collect secret key names (P4: names only, zero values)
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

    // C4 & B2: If applying and config changed, validate schema and write target config.json atomically
    if (isApply && (configChanged || !existsSync(l.configPath))) {
      const check = validate(rawConfig);
      if (!check.ok) {
        throw new ImportError("E_CONFIG_INVALID", "config-invalid", check.errors.join("; "));
      }
      writeAtomicSync(l.configPath, `${JSON.stringify(rawConfig, null, 2)}\n`, 0o600);
    }

    // Compute counts
    const agentsCreated = agentReports.filter((a) => a.action === "created").length;
    const agentsMatched = agentReports.filter((a) => a.action === "matched-existing").length;
    const agentsRejected = agentReports.filter((a) => a.action === "rejected").length;
    const filesCreated = agentReports.reduce((n, a) => n + a.counts.filesCreated, 0);
    const filesMatched = agentReports.reduce((n, a) => n + a.counts.filesMatched, 0);
    const filesConflicted = agentReports.reduce((n, a) => n + a.counts.filesConflicted, 0);
    const filesRenamed = agentReports.reduce((n, a) => n + a.counts.filesRenamed, 0);
    const filesReplaced = agentReports.reduce((n, a) => n + a.counts.filesReplaced, 0);
    const filesSkipped = agentReports.reduce((n, a) => n + a.counts.filesSkipped, 0);

    for (const a of agentReports) {
      if (a.action === "rejected") {
        errors.push({ sourceRef: a.sourceId, reason: a.reason ?? "rejected" });
      }
    }

    const finishedDate = opts.now ? opts.now() : new Date();
    let reportPath: string | null = null;

    const resultReport: OpenclawImportReport = {
      importId: runId,
      runId,
      schema: "import.openclaw/1",
      sourceType: "openclaw",
      sourceVersion: sourceReport.version?.release ?? "unknown",
      source: {
        root: sourceReport.source.root,
        resolvedFrom: sourceReport.source.resolvedFrom,
        configPath: sourceReport.source.configPath,
      },
      mode: isApply ? "apply" : "dry-run",
      harness: {
        home: l.home,
      },
      disabledAuthProfiles,
      profilesOrAgents: agentReports,
      agents: agentReports,
      channels: channelReports,
      cron: {
        status: "deferred",
        count: userJobs.length,
        jobs: userJobs,
        excludedCount: cronExcludedCount,
      },
      secrets: {
        opted_in: false,
        allowlistedKeysImported: [],
        foundNotImported: unmigratedSecrets,
        unmigrated_secrets: unmigratedSecrets,
        count: unmigratedSecrets.length,
      },
      stores: preparedStores.stores,
      ...(preparedStores.adoptReport ? { storeAdopt: preparedStores.adoptReport } : {}),
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
        memoryCardsLinked: totalCardsLinked,
        memoryCardsPendingReembed: totalCardsPendingReembed,
        memoryCardsDeferred: totalCardsDeferred,
        unresolvedUserScope: totalUnresolvedUserScope,
        channelsDeferred: channelReports.length,
        channelsImported: channelReports.length,
        cronJobsDeferred: userJobs.length,
        storesTakenOver: preparedStores.stores.filter((x) => x.action === "taken-over" || x.action === "preview-ok").length,
        storesMatched: preparedStores.stores.filter((x) => x.action === "matched-existing").length,
        storesReembedMigration: preparedStores.stores.filter((x) => x.action === "re-embedding-migration").length,
        storesSkipped: preparedStores.stores.filter((x) => x.action === "skipped").length,
        corruptLedgerLines: ledger?.corruptLineCount ?? 0,
      },
      snapshot: snapshotResult ? {
        path: snapshotResult.path,
        existed: snapshotResult.existed,
        manifestSha256: snapshotResult.manifestSha256,
      } : null,
      ledgerPath,
      reportPath,
      startedAt,
      finishedAt: finishedDate.toISOString(),
    };

    // If applying, write report atomically to <home>/imports/<runId>/report.json
    if (isApply) {
      reportPath = join(repDir, "report.json");
      resultReport.reportPath = reportPath;
      writeAtomicSync(reportPath, `${JSON.stringify(resultReport, null, 2)}\n`, 0o600);
    }

    return resultReport;
    } finally {
      if (createdEngineLocally && engine) {
        try {
          await (engine as any).close?.({ budgetMs: 1_000 });
        } catch {}
      }
    }
  };

  // C1: Single-writer lock held across the entire apply pipeline (reads, writes, report)
  if (opts.apply) {
    return await withTargetLock(l, async () => {
      try {
        return await executeImport(true);
      } finally {
        abortStoreAdopt(preparedStores?.adopt);
      }
    });
  }

  return await executeImport(false);
}
