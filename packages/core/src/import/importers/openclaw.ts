// OpenClaw importer pipeline (docs/import.md §1, §2, M7 Batch 2).
// Migrates agents, persona (SOUL.md), D15 curated files into `l.workspaceDir(id)`,
// extracts channel allowlists, reports cron as deferred (zero disk writes),
// reports secrets by key name only, and enforces the single-writer rule withTargetLock.
import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { defaults, validate, type HarnessConfig } from "@plur1bus/config-schema";
import { layout } from "../../paths.ts";
import { parseJson5 } from "../json5.ts";
import { isFile, readBounded } from "../readonly.ts";
import { detectOpenclaw } from "../sources/openclaw.ts";
import { newRunId } from "../skills-import.ts";
import { withTargetLock } from "../single-writer.ts";
import { targetIdentity } from "../identity.ts";
import { ImportError, type SourceCtx } from "../types.ts";
import { planAndMigrateAgent, type AgentImportReport } from "./openclaw-agents.ts";
import { readOpenclawChannels, type ChannelAllowlistReport } from "./openclaw-channels.ts";
import { readOpenclawCronJobs, type OpenclawCronJob } from "./openclaw-cron.ts";

export interface OpenclawImportOptions {
  home: string;
  source?: string | undefined;
  apply?: boolean | undefined;
  migrateSecrets?: boolean | undefined;
  onConflict?: "skip" | "replace" | undefined;
  env?: NodeJS.ProcessEnv | undefined;
  homedir?: string | undefined;
  platform?: NodeJS.Platform | undefined;
  probeWsl?: boolean | undefined;
  allowLiveCopy?: boolean | undefined;
  now?: () => Date;
}

export interface OpenclawImportReport {
  runId: string;
  schema: "import.openclaw/1";
  sourceType: "openclaw";
  source: {
    root: string;
    resolvedFrom: string;
    configPath: string | null;
  };
  mode: "dry-run" | "apply";
  harness: {
    home: string;
  };
  agents: AgentImportReport[];
  channels: ChannelAllowlistReport[];
  cron: {
    status: "deferred";
    count: number;
    jobs: OpenclawCronJob[];
    excludedCount: number;
  };
  secrets: {
    opted_in: boolean;
    unmigrated_secrets: string[];
    count: number;
  };
  counts: {
    agentsCreated: number;
    agentsMatched: number;
    agentsRejected: number;
    filesCreated: number;
    filesMatched: number;
    filesConflicted: number;
    filesSkipped: number;
    channelsDeferred: number;
    channelsImported: number; // backward compatibility
    cronJobsDeferred: number;
  };
  reportPath: string | null;
  startedAt: string;
  finishedAt: string;
}

function writeConfigAtomicWithFsync(configPath: string, rawConfig: unknown): void {
  mkdirSync(dirname(configPath), { recursive: true, mode: 0o700 });
  const tmp = `${configPath}.tmp.${process.pid}.${Date.now()}`;
  const fd = openSync(tmp, "w", 0o600);
  try {
    writeFileSync(fd, `${JSON.stringify(rawConfig, null, 2)}\n`);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(tmp, configPath);
}

export async function importOpenclaw(opts: OpenclawImportOptions): Promise<OpenclawImportReport> {
  const env = opts.env ?? process.env;
  const homedir = opts.homedir ?? (process.platform === "win32" ? env.USERPROFILE ?? "" : env.HOME ?? "");
  const platform = opts.platform ?? process.platform;
  const l = layout(opts.home);
  const startDate = opts.now ? opts.now() : new Date();
  const runId = newRunId(startDate);
  const startedAt = startDate.toISOString();

  // P4: Refuse --migrate-secrets until M2
  if (opts.migrateSecrets) {
    throw new ImportError("E_SECRET_STORE_UNAVAILABLE", "secret-store-unavailable", "secret store unavailable until M2");
  }

  const executeImport = async (isApply: boolean): Promise<OpenclawImportReport> => {
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

    // Migrate agents and curated files
    const agentReports: AgentImportReport[] = [];
    const seenSourceAgentIds = new Set<string>();
    let configChanged = false;

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
        opts.onConflict ?? "skip",
      );

      if (report.action !== "rejected" && isNewAgent && isApply) {
        rawConfig.agents[agent.agentId] = { createdAt: startDate.toISOString() };
        configChanged = true;
      }
      agentReports.push(report);
    }

    // Read channels from openclaw.json
    let channelReports: ChannelAllowlistReport[] = [];
    if (sourceReport.source.configPath && isFile(sourceReport.source.configPath)) {
      try {
        const cfgText = readBounded(sourceReport.source.configPath, 16 * 1024 * 1024);
        if (cfgText) {
          const rawCfg = parseJson5(cfgText) as Record<string, unknown>;
          channelReports = readOpenclawChannels(rawCfg);
        }
      } catch {
        // Ignored if unparseable
      }
    }

    // Read user cron jobs from state/openclaw.sqlite (P5: deferred, zero writes)
    const { userJobs, excludedCount: cronExcludedCount } = readOpenclawCronJobs(sourceReport.source.root);

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

    // C4: If applying and config changed, validate schema and write target config.json atomically
    if (isApply && (configChanged || !existsSync(l.configPath))) {
      const check = validate(rawConfig);
      if (!check.ok) {
        throw new ImportError("E_CONFIG_INVALID", "config-invalid", check.errors.join("; "));
      }
      writeConfigAtomicWithFsync(l.configPath, rawConfig);
    }

    // Compute counts
    const agentsCreated = agentReports.filter((a) => a.action === "created").length;
    const agentsMatched = agentReports.filter((a) => a.action === "matched-existing").length;
    const agentsRejected = agentReports.filter((a) => a.action === "rejected").length;
    const filesCreated = agentReports.reduce((n, a) => n + a.counts.filesCreated, 0);
    const filesMatched = agentReports.reduce((n, a) => n + a.counts.filesMatched, 0);
    const filesConflicted = agentReports.reduce((n, a) => n + a.counts.filesConflicted, 0);
    const filesSkipped = agentReports.reduce((n, a) => n + a.counts.filesSkipped, 0);

    const finishedDate = opts.now ? opts.now() : new Date();
    let reportPath: string | null = null;

    const resultReport: OpenclawImportReport = {
      runId,
      schema: "import.openclaw/1",
      sourceType: "openclaw",
      source: {
        root: sourceReport.source.root,
        resolvedFrom: sourceReport.source.resolvedFrom,
        configPath: sourceReport.source.configPath,
      },
      mode: isApply ? "apply" : "dry-run",
      harness: {
        home: l.home,
      },
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
        unmigrated_secrets: unmigratedSecrets,
        count: unmigratedSecrets.length,
      },
      counts: {
        agentsCreated,
        agentsMatched,
        agentsRejected,
        filesCreated,
        filesMatched,
        filesConflicted,
        filesSkipped,
        channelsDeferred: channelReports.length,
        channelsImported: channelReports.length,
        cronJobsDeferred: userJobs.length,
      },
      reportPath,
      startedAt,
      finishedAt: finishedDate.toISOString(),
    };

    // If applying, write report to <home>/imports/<runId>/report.json
    if (isApply) {
      const repDir = join(l.home, "imports", runId);
      mkdirSync(repDir, { recursive: true, mode: 0o700 });
      reportPath = join(repDir, "report.json");
      resultReport.reportPath = reportPath;
      writeFileSync(reportPath, JSON.stringify(resultReport, null, 2) + "\n", { mode: 0o600 });
    }

    return resultReport;
  };

  // C1: Single-writer lock held across the entire apply pipeline (reads, writes, report)
  if (opts.apply) {
    return await withTargetLock(l, async () => {
      return await executeImport(true);
    });
  }

  return await executeImport(false);
}
