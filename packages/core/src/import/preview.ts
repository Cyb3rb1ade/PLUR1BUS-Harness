/** Live preview owns read plans and private scratch probes, never offline full-import mutation authority. */
import { randomUUID } from "node:crypto";
import { validate } from "@plur1bus/config-schema";
import { layout } from "../paths.ts";
import { SourceReader } from "./source-reader.ts";
import type { SourceRegistry } from "./source-registry.ts";
import type { ImportPlanRecord } from "./maintenance-records.ts";
import type { ImportConfigPort, ImportStoreProbe } from "./execution.ts";
import { planImportConfig } from "./execution.ts";
import { planOpenclawAgent, type AgentImportReport } from "./importers/openclaw-agent-plan.ts";
import { planHermesAgent } from "./importers/hermes-agent-plan.ts";
import { planOpenclawStores, planHermesStore, type OpenclawStoreReport, type StoreAdoptReport } from "./store-preview.ts";
import { previewSourceCards } from "./card-source.ts";
import { planProfileTargets } from "./profile-plan.ts";
import { targetIdentity } from "./identity.ts";
import { ImportError, type SourceType } from "./types.ts";
import { resolveImportOptions } from "./plan-options.ts";

type Source = Awaited<ReturnType<SourceRegistry["get"]>>;
export interface ImportPreview {
  sourceType: SourceType;
  agents: (AgentImportReport & { memory?: { totalCards: number } })[];
  stores?: OpenclawStoreReport[];
  storeAdopt?: StoreAdoptReport;
  errors: { sourceRef: string; reason: string }[];
}

/** Parameters deliberately contain no apply flag, Engine writer, target lock, ledger or extension installation port. */
export async function previewImport(options: { home: string; source: Source; settings: ImportPlanRecord["options"];
  config: ImportConfigPort; storeProbe?: ImportStoreProbe; signal?: AbortSignal;
  storeConflict?: ImportPlanRecord["options"]["onConflict"] | null }): Promise<ImportPreview> {
  const { source, settings, config, signal } = options;
  const selected = resolveImportOptions(source, settings);
  const read = source.read.report;
  const agents = read.agents.filter(agent => !selected.sourceAgentIds || selected.sourceAgentIds.includes(agent.agentId));
  const stores = read.plur1bus.stores.filter(store => selected.sourceStoreIds ? selected.sourceStoreIds.includes(store.storeId)
    : !selected.sourceAgentIds || store.kind !== "agent" || !!store.agentId && selected.sourceAgentIds.includes(store.agentId));
  const reader = new SourceReader({ ...source.reader, ...(signal ? { signal } : {}) });
  const l = layout(options.home);
  const current = await config.get();
  const checked = validate(structuredClone(current.config));
  if (!checked.ok) throw new ImportError("E_CONFIG_INVALID", "config-invalid", "Import config is invalid");
  const before = structuredClone(checked.config);
  const next = structuredClone(before);
  const existing = new Set(Object.keys(next.agents));
  const onConflict = settings.onConflict ?? "skip";
  const report: ImportPreview = { sourceType: read.sourceType, agents: [], errors: [...(read.errors ?? [])] };
  const storeConflict = options.storeConflict ?? onConflict;
  if (read.sourceType === "openclaw") {
    const planned = await planOpenclawStores({ reader, stores, storeRoot: read.plur1bus.storeRoot, l,
      runId: randomUUID(), onConflict: storeConflict, targetConfig: before, targetEmbedding: targetIdentity(options.home).embedding,
      ...(settings.adoptStoreId && settings.adoptStrategy !== "re-embed" ? { probeSourceStoreId: settings.adoptStoreId } : {}),
      ...(options.storeProbe ? { probe: options.storeProbe } : {}) });
    report.stores = planned.stores;
    if (planned.adoptReport) report.storeAdopt = planned.adoptReport;
    report.errors.push(...planned.errors);
  } else if (selected.adoptStore) {
    report.storeAdopt = (await planHermesStore({ reader, sourceStorePath: selected.adoptStore, l, runId: randomUUID(),
      onConflict, targetConfig: before, ...(settings.adoptStrategy === "re-embed" ? { adoptStrategy: "reembed" } : {}),
      ...(options.storeProbe ? { probe: options.storeProbe } : {}) })).report;
  }
  const mapping = Object.fromEntries(settings.mapProfiles?.map(item => [item.profile, item.agentId]) ?? []);
  if (read.sourceType === "hermes") planProfileTargets(agents, mapping, settings.mergeProfiles === true);
  const seen = new Set<string>();
  for (const agent of agents) {
    signal?.throwIfAborted();
    const targetId = read.sourceType === "hermes" ? mapping[agent.agentId] ?? agent.agentId : agent.agentId;
    const duplicate = seen.has(targetId.toLowerCase());
    seen.add(targetId.toLowerCase());
    if (duplicate && (read.sourceType !== "hermes" || !settings.mergeProfiles)) {
      throw new ImportError("E_CONFIG_INVALID", "duplicate-agent-id", "Import source has duplicate agents");
    }
    const choose = selected.fileConflict ? (file: string) => selected.fileConflict!(agent.agentId, file) : undefined;
    const planned = read.sourceType === "openclaw"
      ? await planOpenclawAgent(agent, read.source.root, l, existing, undefined, onConflict, undefined, undefined, reader, choose)
      : await planHermesAgent(targetId, agent.workspace ?? read.source.root, read.source.root, l, existing,
        undefined, onConflict, undefined, undefined, false, reader, choose);
    const result = { ...planned.report, sourceId: agent.agentId, harnessAgentId: targetId,
      ...(duplicate ? { action: "merged" as const } : {}) };
    if (result.action !== "rejected" && planned.isNewAgent) next.agents[targetId] = { createdAt: new Date().toISOString() };
    if (read.sourceType === "hermes") for (const file of result.files) {
      if (file.action === "skipped" && ["unsafe-symlink", "not-regular-file", "file-too-large", "source-unreadable"].includes(file.reason ?? "")) {
        report.errors.push({ sourceRef: `${agent.agentId}:${file.targetFile}`, reason: file.reason! });
      }
    }
    const cards = result.action === "rejected" ? undefined
      : await previewSourceCards(reader, read.sourceType, agent.workspace ?? read.source.root, agent.agentId);
    if (cards) report.errors.push(...cards.errors);
    report.agents.push({ ...result, ...(cards ? { memory: { totalCards: cards.totalCards } } : {}) });
  }
  const changes = planImportConfig(before as unknown as Record<string, unknown>, next as unknown as Record<string, unknown>);
  if (changes.length) await config.set({ changes, dryRun: true, ifRevision: current.revision });
  return report;
}
