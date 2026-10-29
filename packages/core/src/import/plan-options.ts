/** Resolve public opaque selections exclusively against the authenticated sealed source. */
import { createHash } from "node:crypto";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import type { ImportPlanOptions } from "./maintenance-records.ts";
import type { ImportExecutionOptions } from "./execution.ts";
import type { SourceReport, SourceType } from "./types.ts";
import { sourceAgentId } from "./source-view.ts";
import { ImportError } from "./types.ts";

interface Source {
  record: { sourceType: SourceType };
  read: { report: SourceReport };
  metadata: { sourceRoot: string };
  root: string;
}
export function fileConflictId(sourceType: string, agent: string, file: string): string {
  return createHash("sha256").update(JSON.stringify([sourceType, agent, file])).digest("hex");
}

export function resolveImportOptions(source: Source, options: ImportPlanOptions): ImportExecutionOptions & {
  adoptStore?: string;
  maps?: { from: string; to: string }[];
} {
  const fail = (reason: string): never => { throw new ImportError("E_INVALID_PARAMS", reason, "Import selection is invalid"); };
  const agents = source.read.report.agents;
  const selected = options.agentIds?.map(id => agents.find(agent => sourceAgentId(source.record.sourceType, agent.agentId) === id)
    ?? fail("source-agent-invalid"));
  const store = options.adoptStoreId === undefined ? undefined : source.read.report.plur1bus.stores
    .find(item => item.storeId === options.adoptStoreId) ?? fail("source-store-invalid");
  const choices = new Map(options.conflicts?.map(answer => [answer.id, answer.choice]));
  const maps = options.maps?.map(mapping => {
    const sealed = relative(resolve(source.root), resolve(mapping.to));
    if (sealed !== ".." && !sealed.startsWith(".." + sep) && !isAbsolute(sealed)) return { ...mapping };
    const part = relative(resolve(source.metadata.sourceRoot), resolve(mapping.to));
    if (part === ".." || part.startsWith(".." + sep) || isAbsolute(part)) fail("source-map-unsealed");
    return { from: mapping.from, to: join(source.root, part) };
  });
  return { ...(selected ? { sourceAgentIds: selected.map(agent => agent.agentId) } : {}),
    ...(store ? { sourceStoreIds: [store.storeId], adoptStore: store.path } : {}),
    ...(maps ? { maps } : {}),
    fileConflict: (agent, file) => choices.get(fileConflictId(source.record.sourceType, agent, file))
      ?? options.onConflict ?? "skip" };
}
