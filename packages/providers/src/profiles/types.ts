import type { ProfileTable, RequestDefaults, StreamingAdapter } from "../router/types.ts";

/**
 * Structural mirror of `modelProfiles` in the config schema. Deliberately not imported from the config-schema
 * package: this package has no runtime dependencies and takes plain data.
 */
export interface ModelProfileCandidateConfig {
  /** "provider/model"; split at the FIRST "/" (the model part may itself contain "/"). */
  model: string;
  weight?: number;
}

export interface ModelProfileConfig {
  displayName?: string;
  strategy?: "fallback" | "moa";
  candidates: readonly ModelProfileCandidateConfig[];
  aggregator?: string;
  params?: { temperature?: number; topP?: number; maxTokens?: number };
  cache?: { hint?: "auto" | "none" | "prefer"; ttlSeconds?: number };
}

export type ModelProfilesConfig = Readonly<Record<string, ModelProfileConfig>>;

export interface ProviderRegistryEntry {
  adapter: StreamingAdapter;
  /** Known model ids; when absent, models of this provider cannot be verified and are accepted. */
  models?: readonly string[];
  /** Model used for the synthesised default profile. */
  defaultModel?: string;
}

/** Provider id -> entry. Iteration order matters (it orders the synthesised default profile). */
export type ProviderRegistry = ReadonlyMap<string, ProviderRegistryEntry>;

export type ConfigIssueCode =
  | "malformed_model_ref"
  | "unknown_provider"
  | "unknown_model"
  | "duplicate_candidate"
  | "empty_candidates"
  | "invalid_strategy"
  | "aggregator_without_moa"
  | "moa_needs_two_candidates"
  | "moa_not_executable";

export interface ConfigIssue {
  /** Config path, e.g. `modelProfiles.fast.candidates[1].model`. */
  path: string;
  code: ConfigIssueCode;
  message: string;
}

export class ProfileConfigError extends Error {
  readonly issues: readonly ConfigIssue[];
  constructor(issues: readonly ConfigIssue[]) {
    const first = issues[0];
    const head = first === undefined ? "invalid model profiles" : `${first.path}: ${first.message}`;
    super(issues.length > 1 ? `${head} (+${issues.length - 1} more)` : head);
    this.name = "ProfileConfigError";
    this.issues = issues;
  }
}

export interface ResolvedCandidate { provider: string; model: string; weight: number }

export interface ResolvedProfile {
  name: string;
  displayName?: string;
  strategy: "fallback" | "moa";
  candidates: readonly ResolvedCandidate[];
  aggregator?: { provider: string; model: string };
  params: RequestDefaults;
  cache: { hint?: "auto" | "none" | "prefer"; ttlSeconds?: number };
}

export interface ResolvedProfiles {
  profiles: Readonly<Record<string, ResolvedProfile>>;
  table: ProfileTable;
  defaults: Record<string, RequestDefaults>;
  unsupported: Record<string, string>;
  defaultProfile: string | undefined;
  warnings: readonly ConfigIssue[];
}

export const DEFAULT_PROFILE_NAME = "default";
