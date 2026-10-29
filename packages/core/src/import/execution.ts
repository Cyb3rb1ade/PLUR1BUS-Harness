/** Importer ports keep supervised configuration authority and entity-boundary cancellation outside format readers. */
import { validate } from "@plur1bus/config-schema";
import { ImportError } from "./types.ts";
import type { ImportProgress } from "./maintenance-types.ts";
import type { ConflictStrategy } from "./ledger.ts";

export interface ImportStoreProbeResult {
  verdict: "ok" | "incompatible";
  reason?: string | undefined;
  identitySource?: "manifest" | "probe" | undefined;
  schemaVersion?: string | undefined;
}
export type ImportStoreProbe = (path: string, expectedIdentity?: unknown) => Promise<ImportStoreProbeResult>;

export interface ImportConfigChange { key: string; value: unknown }
export interface ImportConfigPort {
  get(): Promise<{ config: object; revision: string }>;
  set(params: { changes: ImportConfigChange[]; dryRun: boolean; ifRevision?: string }): Promise<{ revision: string }>;
}

export interface ImportExecutionOptions {
  /** Set only by the trusted GUI service; CLI generation is unchanged. */
  runId?: string;
  signal?: AbortSignal;
  onProgress?: (event: ImportProgress) => void | Promise<void>;
  configPort?: ImportConfigPort;
  /** A worker holding both locks supplies the already-owned target gate. Never exposed in RPC params. */
  targetLock?: <T>(run: () => Promise<T>) => Promise<T>;
  /** Private worker-owned recovery exception. No CLI flag or public RPC field can supply it. */
  maintenanceRunId?: string;
  /** Private resolved selections; public opaque IDs are checked against the authenticated source before injection. */
  sourceAgentIds?: readonly string[];
  sourceStoreIds?: readonly string[];
  /** Private source-model route still requires the Engine to probe the staged selected store. No CLI/RPC flag. */
  probeSourceStoreId?: string;
  /** Selected only from the validated active target configuration by the supervised worker. */
  targetStoreRoot?: string;
  /** GUI file-conflict previews retain the separately chosen store conflict policy. */
  storeConflict?: ConflictStrategy;
  fileConflict?: (sourceAgent: string, targetFile: string) => ConflictStrategy;
  /** Live preflight uses the existing Core Engine owner. The offline legacy path keeps its scratch probe. */
  storeProbe?: ImportStoreProbe;
  maps?: import("./paths.ts").Mount[] | undefined;
}

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$(?![\s\S])/;

export function executionRunId(requested: string | undefined, generated: string): string {
  if (requested === undefined) return generated;
  if (!UUID.test(requested)) throw new ImportError("E_INVALID_PARAMS", "run-id-invalid", "Import run ID is invalid");
  return requested;
}

export function checkImportAbort(signal?: AbortSignal): void {
  if (signal?.aborted) throw new ImportError("E_IMPORT_FAILED", "aborted", "Import was aborted");
}

export async function importCheckpoint(options: Pick<ImportExecutionOptions, "signal" | "onProgress">,
  runId: string, entity: ImportProgress["entity"], completed: number, total?: number): Promise<void> {
  checkImportAbort(options.signal);
  await options.onProgress?.({ runId, phase: "apply", completed,
    ...(entity ? { entity } : {}), ...(total === undefined ? {} : { total }) });
  checkImportAbort(options.signal);
}

/** Importers currently add agent registrations only. Never forward the full target or unchanged legacy credentials. */
export function planImportConfig(before: Record<string, unknown>, after: Record<string, unknown>): ImportConfigChange[] {
  const checked = validate(after);
  if (!checked.ok) throw new ImportError("E_CONFIG_INVALID", "config-invalid", "Import config is invalid");
  const { agents: previous, ...restBefore } = before;
  const { agents: current, ...restAfter } = after;
  if (JSON.stringify(restBefore) !== JSON.stringify(restAfter)) {
    throw new ImportError("E_CONFIG_INVALID", "config-change-unsupported", "Import config change is unsupported");
  }
  const oldAgents = previous && typeof previous === "object" ? previous as Record<string, unknown> : {};
  const newAgents = current && typeof current === "object" ? current as Record<string, unknown> : {};
  const changes: ImportConfigChange[] = [];
  for (const name of Object.keys(newAgents).sort()) {
    if (JSON.stringify(newAgents[name]) === JSON.stringify(oldAgents[name])) continue;
    if (!/^[a-z0-9][a-z0-9_-]{0,63}$(?![\s\S])/.test(name)) {
      throw new ImportError("E_CONFIG_INVALID", "config-agent-invalid", "Import config agent is invalid");
    }
    changes.push({ key: `agents.${name}`, value: newAgents[name] });
  }
  if (changes.length > 64) throw new ImportError("E_LIMIT_EXCEEDED", "config-changes-limit", "Import config exceeds limit");
  return changes;
}

export async function writeImportConfig(port: ImportConfigPort, before: Record<string, unknown>,
  after: Record<string, unknown>, apply: boolean, revision: string): Promise<void> {
  const changes = planImportConfig(before, after);
  if (!changes.length) return;
  await port.set({ changes, dryRun: !apply, ifRevision: revision });
}
