// Hermes importer pipeline (docs/import.md §3, §5, M7 Batch 3).
// Migrates profiles to agents, persona (SOUL.md) and USER.md into `l.workspaceDir(id)`,
// ingests memory cards via Engine.memory.import (batch size <= 500),
// extracts channel pairings (approved hashed, pending excluded),
// reports cron as deferred (zero disk writes),
// supports existing store take-over via Engine.stores.adopt (--adopt-store); the cards of a taken-over store follow the
// owner decision 2026-10-19 (hermesCardMode below: linked / pending-reembed / deferred, docs/import.md §10.3),
// enforces single-writer lock withTargetLock,
// writes pre-apply snapshot for rollback, records atomic ledger.jsonl, and supports conflict strategies.
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { defaults, validate } from "@plur1bus/config-schema";
import { layout } from "../../paths.ts";
import {
  channelIdempotencyKey,
  cronIdempotencyKey,
  ImportLedger,
  recordCreatedConfig,
  type ConflictStrategy,
} from "../ledger.ts";
import { createTargetSnapshot } from "../snapshot-target.ts";
import { detectHermes } from "../sources/hermes.ts";
import { newRunId } from "../skills-import.ts";
import { withTargetLock } from "../single-writer.ts";
import { targetIdentity } from "../identity.ts";
import { ImportError, type SourceCtx } from "../types.ts";
import { writeAtomicSync } from "../fs-atomic.ts";
import { RUN_ID_RE } from "../rollback.ts";
import { planAndMigrateHermesAgent } from "./hermes-agents.ts";
import { hasHermesCardFiles, importHermesMemories, type HermesMemoryImportResult } from "./hermes-memories.ts";
import { readHermesPairings, type HermesChannelAllowlistReport } from "./hermes-platforms.ts";
import { readHermesCronJobs, type HermesCronJob } from "./hermes-cron.ts";
import {
  abortStoreAdopt,
  commitStoreAdopt,
  inspectStoreAdopt,
  prepareStoreAdopt,
  type PreparedStoreAdopt,
  type StoreAdoptReport,
} from "./hermes-stores.ts";
import { lastTakenOverStoreKey, PARK_DEFERRED, PARK_PENDING_REEMBED, readPriorCardLinks, type OwnStoreCardMode, type PriorCardLink } from "./card-links.ts";
import { ROUTED_REASONS } from "./openclaw-stores.ts";
import { storeIdempotencyKey } from "../ledger.ts";
import { createEngine } from "@cyb3rb1ade/plur1bus-memory/engine/create-engine.js";
import { buildEngineConfig } from "../../engine-config.ts";
import { platformCapabilities } from "../../platform.ts";
import type { AgentImportReport } from "./openclaw-agents.ts";
import type { Engine, HostServices } from "@cyb3rb1ade/plur1bus-memory/types/engine.js";

const SAFE_READ_REFUSALS = new Set(["unsafe-symlink", "not-regular-file", "file-too-large", "source-unreadable"]);

/**
 * How the memory cards are handled when --adopt-store names a store (owner decision 2026-10-19, docs/import.md §10.3). A
 * Hermes take-over swaps the whole harness store, so one verdict covers every profile:
 *   - no --adopt-store, or --adopt-strategy import (the store is deliberately left out): undefined, the plain card import;
 *   - --adopt-strategy reembed (taken over in a foreign vector space for `memory reembed`): parked as pending-reembed;
 *   - taken over / dry-run preview-ok with a matching identity: imported, a card already in the store is linked;
 *   - the harness store is this source's store from an earlier take-over (store-exists-skipped with the last recorded
 *     take-over of this home naming the same source, or already-adopted-in-run on --resume): decided by the engine's
 *     identity check on state/lancedb itself, so the run after the re-embedding migration imports the parked cards;
 *   - anything else (another harness store left untouched, aborted): deferred.
 */
async function hermesCardMode(o: {
  report: StoreAdoptReport | undefined;
  importsDir: string;
  lancedb: string;
  priorLinks: ReadonlyMap<string, PriorCardLink>;
  targetConfig: unknown;
  testInternals: Record<string, unknown> | undefined;
  errors: Array<{ sourceRef: string; reason: string }>;
}): Promise<OwnStoreCardMode | undefined> {
  const r = o.report;
  if (!r || r.routedTo === "import") return undefined;
  if (r.routedTo === "reembed") return PARK_PENDING_REEMBED;
  const link: OwnStoreCardMode = { kind: "link", priorLinks: o.priorLinks };
  if (r.verdict === "ok" && (r.action === "taken-over" || r.action === "preview-ok")) return link;
  const sameStore = r.action === "skipped"
    && (r.reason === "already-adopted-in-run" || r.reason === "store-exists-skipped")
    && lastTakenOverStoreKey(o.importsDir) === storeIdempotencyKey(r.sourcePath);
  if (!sameStore) return PARK_DEFERRED;
  let check: Awaited<ReturnType<typeof inspectStoreAdopt>>;
  try {
    // Engine.stores.adopt dry run: reads the store, never writes it (the same check a dry run runs on a source store).
    check = await inspectStoreAdopt({ storePath: o.lancedb, targetConfig: o.targetConfig, testInternals: o.testInternals });
  } catch (err) {
    const code = (err as { code?: unknown } | null)?.code;
    o.errors.push({ sourceRef: "state/lancedb", reason: `store-check-failed:${typeof code === "string" && /^[A-Za-z0-9_.-]{1,64}$/.test(code) ? code : "engine-unavailable"}` });
    return PARK_DEFERRED;
  }
  if (check.verdict === "ok") return link;
  return ROUTED_REASONS.has(check.reason ?? "identity-unverifiable") ? PARK_PENDING_REEMBED : PARK_DEFERRED;
}

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
  adoptStrategy?: "reembed" | "import" | string | undefined;
  mapProfiles?: Record<string, string> | undefined;
  mergeProfiles?: boolean | undefined;
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
  mergedProfiles?: Array<{ agentId: string; profiles: string[] }> | undefined;
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
    /** Cards that duplicate a memory already in the taken-over store: linked to it, not written again. */
    memoryCardsLinked: number;
    /** Cards of a store taken over for the re-embedding migration: parked, imported by a later run. */
    memoryCardsPendingReembed: number;
    /** Cards of a store that was not taken over for another reason: deferred to a later run. */
    memoryCardsDeferred: number;
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

    // 1. Store take-over (--adopt-store), part one: validate, stage a copy, inspect the copy. Runs before the
    // snapshot, the ledger and any engine, so an abort (incompatible, copy failure, rename refused) leaves the
    // target byte-identical: the only thing created is the staging dir, and prepare removes it on failure.
    const mapProfiles = opts.mapProfiles ?? {};
    const mergeProfiles = opts.mergeProfiles === true;

    // Check profile collisions under target mapping
    const profilesByTarget = new Map<string, string[]>();
    for (const agent of sourceReport.agents) {
      const targetId = mapProfiles[agent.agentId] ?? agent.agentId;
      const norm = targetId.toLowerCase();
      const list = profilesByTarget.get(norm) ?? [];
      list.push(agent.agentId);
      profilesByTarget.set(norm, list);
    }

    const mergedProfiles: Array<{ agentId: string; profiles: string[] }> = [];
    for (const [norm, profiles] of profilesByTarget.entries()) {
      if (profiles.length > 1) {
        const targetId = mapProfiles[profiles[0]!] ?? profiles[0]!;
        if (!mergeProfiles) {
          throw new ImportError(
            "E_PROFILE_COLLISION",
            "profile-collision",
            `multiple profiles map to agent '${targetId}': ${profiles.join(", ")}; pass --merge-profiles to allow merging`,
          );
        }
        mergedProfiles.push({ agentId: targetId, profiles });
      }
    }

    // 1. Store take-over (--adopt-store), part one: validate, stage a copy, inspect the copy. Runs before the
    // snapshot, the ledger and any engine, so an abort (incompatible, copy failure, rename refused) leaves the
    // target byte-identical: the only thing created is the staging dir, and prepare removes it on failure.
    let preparedAdopt: PreparedStoreAdopt | undefined = undefined;
    if (opts.adoptStore) {
      if (opts.adoptStrategy && opts.adoptStrategy !== "reembed" && opts.adoptStrategy !== "import") {
        throw new ImportError(
          "E_INVALID_PARAMS",
          "adopt-strategy-invalid",
          `--adopt-strategy must be 'reembed' or 'import', got '${opts.adoptStrategy}'`,
        );
      }
      preparedAdopt = await prepareStoreAdopt({
        sourceStorePath: opts.adoptStore,
        l,
        isApply,
        runId,
        onConflict,
        targetConfig: rawConfig,
        testInternals: opts.testInternals,
        adoptStrategy: opts.adoptStrategy,
        resumeLedgerText: opts.resume && existsSync(join(repDir, "ledger.jsonl"))
          ? readFileSync(join(repDir, "ledger.jsonl"), "utf8")
          : undefined,
      });
      if (isApply && preparedAdopt.report.verdict === "incompatible" && !opts.adoptStrategy) {
        throw new ImportError(
          "E_STORE_INCOMPATIBLE",
          preparedAdopt.report.reason ?? "identity-mismatch",
          `store adoption aborted: ${preparedAdopt.report.reason ?? "identity-mismatch"}; choose --adopt-strategy reembed (adopt store and run 'memory reembed') or --adopt-strategy import (import cards with target embeddings)`,
        );
      }
    }

    // Pre-apply snapshot of target state
    let snapshotResult: { path: string; existed: boolean; manifestSha256: string } | null = null;
    let ledger: ImportLedger | undefined = undefined;
    let ledgerPath: string | null = null;
    let replacedBackupDir: string | undefined = undefined;

    let storeAdoptReport: StoreAdoptReport | undefined = preparedAdopt?.report;
    let engine = opts.engine;
    let createdEngineLocally = false;
    try {
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

      // 1b. Store take-over, part two: swap the verified copy into state/lancedb, BEFORE any engine opens or
      // initialises the target store (a fresh engine would otherwise create state/lancedb itself).
      if (preparedAdopt && isApply) {
        storeAdoptReport = commitStoreAdopt(preparedAdopt, { l, ledger, replacedBackupDir });
      }

      // 2. Engine for memory cards: apply mode only. A dry run never opens an engine on the target (it would create
      // state/lancedb and engine marker files); its card counts are planned counts derived from the source.
      const testInternals = opts.testInternals;

      // Opened on first use only: an import with no card to write (no card files, or only parked cards) never creates or
      // touches state/lancedb through it, so a store taken over for the re-embedding migration stays exactly as copied.
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
          createImportHost(l.state, async (id: string) => l.workspaceDir(id)),
          buildEngineConfig(engineConfigTarget, l) as any,
          testInternals ? { internals: testInternals } : undefined,
        );
        createdEngineLocally = true;
      };

      const errors: Array<{ sourceRef: string; reason: string }> = [...(sourceReport.errors ?? [])];
      const cardMode = await hermesCardMode({
        report: storeAdoptReport,
        importsDir: join(l.home, "imports"),
        lancedb: l.lancedb,
        priorLinks: isApply ? readPriorCardLinks(join(l.home, "imports")) : new Map<string, PriorCardLink>(),
        targetConfig: rawConfig,
        testInternals,
        errors,
      });

      try {

        // 2. Migrate agents, SOUL.md, USER.md and memory cards
        const profileReports: HermesProfileImportReport[] = [];
        const seenProfileAgentIds = new Set<string>();
        let configChanged = false;

        let totalCardsImported = 0;
        let totalCardsSkippedDuplicate = 0;
        let totalCardsRejected = 0;
        let totalUnresolvedUserScope = 0;
        let totalCardsLinked = 0;
        let totalCardsPendingReembed = 0;
        let totalCardsDeferred = 0;

        for (const agent of sourceReport.agents) {
          const sourceProfile = agent.agentId;
          const targetAgentId = mapProfiles[sourceProfile] ?? sourceProfile;
          const normId = targetAgentId.toLowerCase();
          const alreadySeen = seenProfileAgentIds.has(normId);

          if (alreadySeen && !mergeProfiles) {
            profileReports.push({
              sourceId: sourceProfile,
              harnessAgentId: targetAgentId,
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
          const userBindingActive = opts.userPrincipal !== undefined && opts.userPrincipal !== null && opts.userPrincipal.agentId === targetAgentId;

          // Migrate agent persona and files
          const { report: agentReport, isNewAgent } = planAndMigrateHermesAgent(
            targetAgentId,
            agentWorkspace,
            sourceReport.source.root,
            l,
            existingAgentIds,
            isApply,
            onConflict,
            ledger,
            replacedBackupDir,
            userBindingActive,
          );
          // A refused source file (symlink, FIFO, oversized, unreadable) is an error, not a quiet skip.
          for (const f of agentReport.files) {
            if (f.action === "skipped" && f.reason && SAFE_READ_REFUSALS.has(f.reason)) {
              errors.push({ sourceRef: `${sourceProfile}:${f.targetFile}`, reason: f.reason });
            }
          }

          if (agentReport.action !== "rejected" && isNewAgent && isApply) {
            rawConfig.agents[targetAgentId] = { createdAt: startDate.toISOString() };
            configChanged = true;
          }

          // Migrate memory cards (the engine is opened only for a profile with cards to write, never for parked ones)
          const userPrincipal = userBindingActive ? opts.userPrincipal : undefined;
          if (cardMode?.kind !== "park" && hasHermesCardFiles(agentWorkspace, userPrincipal !== undefined)) ensureEngine();
          const memoryRes: HermesMemoryImportResult = await importHermesMemories({
            profileDir: agentWorkspace,
            profileName: sourceProfile,
            agentId: targetAgentId,
            l,
            engine,
            isApply,
            ledger,
            userPrincipal,
            onConflict,
            replacedBackupDir,
            ...(cardMode ? { ownStore: cardMode } : {}),
          });

          totalCardsImported += memoryRes.importedCount;
          totalCardsSkippedDuplicate += memoryRes.skippedDuplicateCount;
          totalCardsRejected += memoryRes.rejectedCount;
          totalUnresolvedUserScope += memoryRes.unresolvedUserScopeCount;
          totalCardsLinked += memoryRes.linkedCount;
          totalCardsPendingReembed += memoryRes.pendingReembedCount;
          totalCardsDeferred += memoryRes.deferredCount;

          if (memoryRes.errors.length > 0) {
            for (const err of memoryRes.errors) {
              errors.push(err);
            }
          }

          profileReports.push({
            ...agentReport,
            sourceId: sourceProfile,
            harnessAgentId: targetAgentId,
            ...(alreadySeen ? { action: "merged" as any } : {}),
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
        const channelReports = readHermesPairings(searchDirs, errors);
        if (isApply && ledger) {
          for (const ch of channelReports) {
            ledger.record({
              entity: "channel",
              idempotencyKey: channelIdempotencyKey(ch.platform, ch.allowFromFingerprints),
              action: "deferred",
              sourceRef: `platforms/pairing/${ch.platform}-approved.json`,
              details: { platform: ch.platform, count: ch.allowFromCount },
            });
          }
        }

        // 4. Read user cron jobs
        const cronProfiles = sourceReport.agents
          .filter((a): a is typeof a & { workspace: string } => typeof a.workspace === "string" && a.workspace.length > 0)
          .map((a) => ({ agentId: a.agentId, dir: a.workspace }));
        const { userJobs, excludedCount: cronExcludedCount } = readHermesCronJobs(cronProfiles, errors);
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
          const configText = `${JSON.stringify(rawConfig, null, 2)}\n`;
          const hadConfig = existsSync(l.configPath);
          writeAtomicSync(l.configPath, configText, 0o600);
          recordCreatedConfig(ledger, hadConfig, configText);
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
          mergedProfiles: mergedProfiles.length > 0 ? mergedProfiles : undefined,
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
            memoryCardsLinked: totalCardsLinked,
            memoryCardsPendingReembed: totalCardsPendingReembed,
            memoryCardsDeferred: totalCardsDeferred,
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
    } finally {
      // A staged store copy that was never committed (any failure before the swap) is removed.
      abortStoreAdopt(preparedAdopt);
    }
  };

  if (opts.apply) {
    return await withTargetLock(l, async () => {
      return await executeImport(true);
    });
  }

  return await executeImport(false);
}
