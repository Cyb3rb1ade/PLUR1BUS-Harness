// Shared importer types (docs/import.md §8, §9).
import type { Mount, PortabilityReport } from "./paths.ts";
import type { Comparison, Identity, RerankerComparison, RerankerInfo, TargetIdentity } from "./identity.ts";
import sourceCatalog from "./source-catalog.json" with { type: "json" };

export type SourceType = keyof typeof sourceCatalog;

/** Display metadata for host source pickers; runtime membership remains owned by this import boundary. */
export const SOURCE_CATALOG: readonly { readonly id: SourceType; readonly displayName: string }[] = Object.freeze(
  Object.entries(sourceCatalog).map(([id, metadata]) => Object.freeze({ id: id as SourceType, displayName: metadata.displayName })),
);

/** Validate an importer source family without duplicating foreign format names in host applications. */
export function isSourceType(value: unknown): value is SourceType {
  return typeof value === "string" && Object.hasOwn(sourceCatalog, value);
}

/** A refusal or failure the CLI reports as an `error/1` document with this code, reason and exit code. */
export class ImportError extends Error {
  code: string; reason: string; exit: number;
  constructor(code: string, reason: string, message: string, exit = 2) { super(message); this.name = "ImportError"; this.code = code; this.reason = reason; this.exit = exit; }
}

export interface SourceCtx {
  /** All live source reads use this run-scoped six-operation port. */
  reader?: import("./source-reader.ts").SourceReader | undefined;
  sourceType: SourceType;
  /** Internal A13 tap for decoded source facts. Values can contain credentials: never serialize or retain them. */
  onSourceConfig?: ((config: unknown, profile: string | null) => void) | undefined;
  source?: string | undefined;
  profile?: string | undefined;
  env: NodeJS.ProcessEnv;
  homedir: string;
  /** The host platform whose path rules apply (injected by tests; default: this process's). */
  platform?: NodeJS.Platform | undefined;
  /** The platform of the volume the harness copies to, for name hazards (default: `platform`). */
  targetPlatform?: NodeJS.Platform | undefined;
  /** `--map <source-prefix>=<local-prefix>` rules (§B.4). */
  maps?: Mount[] | undefined;
  /** The harness home the target is read from (never written by detect). */
  home: string;
  target: TargetIdentity;
  probeWsl?: boolean | undefined;
  allowLiveCopy?: boolean | undefined;
  wslRunner?: any;
}

export interface SkillRoot { dir: string; tier: string; agentId: string | null; precedence: number }

export interface AgentInfo { agentId: string; workspace: string | null; workspaceSource: string; agentDir: string | null; foundIn: string[] }

export interface StoreReport {
  storeId: string;
  kind: "agent" | "shared";
  agentId: string | null;
  namespace: string | null;
  path: string;
  rows: number | null;
  identity: {
    fields: Identity;
    distinctIdentities: number;
    evidence: Record<string, unknown>[];
    comparison: Comparison;
    plannedAction: "take-over" | "re-embedding-migration";
    reasons: string[];
  };
}

export interface RerankerReport extends RerankerInfo { comparison: RerankerComparison; plannedAction: "report-only" }

export interface SecretsReport {
  files: { path: string; kind: string; present: true; entries?: number }[];
  envKeys: { file: string; keys: string[] }[];
  configKeys: { path: string; form: "inline" | "env-ref" | "object" }[];
}

export interface SourceReport {
  errors?: Array<{ sourceRef: string; reason: string }>;
  sourceType: SourceType;
  source: { root: string; resolvedFrom: string; configPath: string | null; profile: string | null };
  version: { release: string | null; stateSchema: number | null; configVersion: number | null; sessionsSchema: number | null; supported: boolean; warnings: string[] };
  agents: AgentInfo[];
  plur1bus: {
    installed: boolean;
    plugin: Record<string, unknown> | null;
    storeRoot: Record<string, unknown> | null;
    embeddingCache: Record<string, unknown> | null;
    reembedding: Record<string, unknown> | null;
    stores: StoreReport[];
    note?: string;
  };
  rerankers: RerankerReport[];
  skillRoots: SkillRoot[];
  secrets: SecretsReport;
  other: Record<string, unknown>;
  /** How the source's config paths were mapped onto this host (plugin-distribution spec §B.4). */
  portability: PortabilityReport;
  warnings: string[];
}

const SECRET_KEY = /(api[-_]?key|apikey|token|secret|password|passwd|authorization|cookie|private[-_]?key|headers|credential)s?$/i;
/** Paths of secret-shaped keys with a non-empty value in a parsed config — the value itself is never returned. */
export function secretConfigKeys(value: unknown, prefix = "", out: SecretsReport["configKeys"] = []): SecretsReport["configKeys"] {
  if (out.length >= 200 || !value || typeof value !== "object") return out;
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    const path = prefix ? `${prefix}.${k}` : k;
    if (SECRET_KEY.test(k) && v !== null && v !== "" && v !== undefined) {
      if (typeof v === "string") out.push({ path, form: /^\$\{[A-Za-z_][A-Za-z0-9_]*\}$/.test(v.trim()) ? "env-ref" : "inline" });
      else if (typeof v === "object") out.push({ path, form: "object" });
      continue;
    }
    if (typeof v === "object") secretConfigKeys(v, path, out);
  }
  return out;
}
