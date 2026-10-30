/** Whitelisted GUI discovery projection. Imported text, filesystem paths and decoded configurations never leave it. */
import { createHash } from "node:crypto";
import { relative, sep } from "node:path";
import type { ImportDetection } from "@plur1bus/rpc-schema";
import type { readSource } from "./source.ts";
import type { SnapshotMetadata } from "./snapshot.ts";
import { discoveryLabel } from "./discovery-identity.ts";
import { ImportError, type SourceType } from "./types.ts";
import { isSourceCredential } from "./source-seal.ts";
import { sourceStoreModel } from "./source-store-model.ts";
import { CATALOG } from "./catalog.ts";

export function sourceAgentId(source: SourceType, id: string): string {
  return createHash("sha256").update(JSON.stringify([source, id])).digest("hex");
}

export function sourceView(input: {
  sourceId: string; sourceType: SourceType; sourceSha256: string; expiresAt: string; root: string;
  read: Awaited<ReturnType<typeof readSource>>; metadata: SnapshotMetadata; channels: number;
}): ImportDetection {
  const { report, skills, discovery } = input.read;
  const agents = report.agents.map(agent => {
    const prefix = agent.workspace ? relative(input.root, agent.workspace).split(sep).join("/") : "";
    const directory = prefix ? prefix + "/" : "";
    const files = input.metadata.files.filter(file => file.path.startsWith(directory));
    const profile = discoveryLabel(agent.agentId);
    return { id: sourceAgentId(input.sourceType, agent.agentId), displayName: discoveryLabel(agent.agentId),
      hasPersona: files.some(file => file.path === directory + "SOUL.md"), files: files.length,
      skills: skills.filter(skill => skill.agentId === null || skill.agentId === agent.agentId).length,
      plugins: discovery.plugins.filter(plugin => plugin.profile === null || plugin.profile === profile).length,
      mcpServers: discovery.mcpCandidates.filter(candidate => candidate.profile === null || candidate.profile === profile).length,
      stores: report.plur1bus.stores.filter(store => store.kind === "shared" || store.agentId === agent.agentId).length,
      channels: input.channels };
  });
  const names = new Set(report.secrets.envKeys.flatMap(group => group.keys));
  for (const item of report.secrets.configKeys) names.add(item.path);
  const memories = typeof report.other.memoryFiles === "number" ? report.other.memoryFiles : 0;
  const unmapped: NonNullable<ImportDetection["portability"]>["unmapped"] = [];
  for (const item of report.portability.unmapped) {
    const key = item.key;
    const kind = /^agents\.[^.]+\.workspace$/.test(key) ? "workspace"
      : /^plugins\.entries\.memory-lancedb-namespaced\.config\.baseDbPath$/.test(key) ? "store"
      : /^skills\.load\.extraDirs\[\d+\]$/.test(key)
        || /^(?:profiles\/[^/]+\/)?config\.yaml:skills\.external_dirs\[\d+\]$/.test(key) ? "skills" : undefined;
    const normalized = item.value.replaceAll("\\", "/");
    if (!kind || item.value.length > 4096 || !/^(?:\/|\\\\|[A-Za-z]:[\\/])/.test(item.value)
      || /[\x00-\x1f\x7f]/.test(item.value) || isSourceCredential(normalized)
      || normalized.split("/").some(part => [".ssh", ".aws", ".gnupg", "secrets"].includes(part.toLowerCase()))) continue;
    const agent = report.agents.find(agent => key === `agents.${agent.agentId}.workspace`
      || key.startsWith(`profiles/${agent.agentId}/config.yaml:`));
    unmapped.push({ path: item.value, kind, reason: item.reason,
      ...(agent ? { agentId: sourceAgentId(input.sourceType, agent.agentId) } : {}) });
  }
  if (unmapped.length > 256) throw new ImportError("E_LIMIT_EXCEEDED", "source-map-limit", "Too many source mappings");
  return { sourceId: input.sourceId, sourceType: input.sourceType, sourceSha256: input.sourceSha256,
    expiresAt: input.expiresAt, agents, counts: { agents: agents.length, skills: skills.length, memories,
      stores: report.plur1bus.stores.length, channels: input.channels,
      extensions: discovery.mcpCandidates.length, secrets: names.size },
    stores: report.plur1bus.stores.map(store => {
      let candidate: ReturnType<typeof sourceStoreModel> | undefined;
      try { candidate = sourceStoreModel(report, store.storeId); } catch (error) {
        if (!(error instanceof ImportError)) throw error;
      }
      const profile = candidate ? CATALOG[candidate.model]! : undefined;
      return { id: store.storeId,
      displayName: discoveryLabel(store.agentId ?? store.namespace ?? store.storeId), kind: store.kind,
      ...(store.agentId === null ? {} : { agentId: sourceAgentId(input.sourceType, store.agentId) }),
      ...(store.rows !== null && Number.isSafeInteger(store.rows) && store.rows >= 0 ? { rows: store.rows } : {}),
      ...(candidate && profile ? { sourceModelCandidate: { model: candidate.model, dimensions: candidate.dimensions,
        revision: profile.revision, licence: profile.licence, nonCommercial: profile.licenceClass === "non-commercial" } } : {}),
    }; }),
    portability: { unmapped },
    plugins: discovery.plugins.map(plugin => ({ id: createHash("sha256").update(JSON.stringify(plugin)).digest("hex"),
      name: plugin.name, classification: plugin.classification, reason: plugin.reasons[0] ?? "incomplete-declaration" })),
    mcpServers: discovery.mcpCandidates.map(candidate => ({ id: candidate.fingerprint, name: candidate.name,
      transport: candidate.transport.type === "http" ? "http" : "stdio", enabled: false,
      needsSetup: candidate.requiredSecrets.length > 0 || candidate.transport.type === "manual" })),
    unsupported: ["cron", "sessions"], warnings: report.warnings.map(() => ({ code: "E_SOURCE_UNSUPPORTED",
      reason: "source-warning" })) };
}
