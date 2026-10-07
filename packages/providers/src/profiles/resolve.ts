import type { Candidate, RequestDefaults } from "../router/types.ts";
import {
  DEFAULT_PROFILE_NAME, ProfileConfigError,
  type ConfigIssue, type ModelProfileConfig, type ModelProfilesConfig, type ProviderRegistry,
  type ResolvedCandidate, type ResolvedProfile, type ResolvedProfiles,
} from "./types.ts";

const MOA_UNSUPPORTED = 'strategy "moa" (mixture of agents) is not executable by the router yet';
const LIST_CAP = 10;

function listCapped(items: readonly string[]): string {
  const shown = items.slice(0, LIST_CAP).join(", ");
  return items.length > LIST_CAP ? `${shown}, ... (${items.length - LIST_CAP} more)` : shown;
}

/** Resolves "provider/model" against the registry; pushes issues and returns undefined when it does not resolve. */
function resolveRef(ref: unknown, path: string, registry: ProviderRegistry, issues: ConfigIssue[]): { provider: string; model: string } | undefined {
  if (typeof ref !== "string") {
    issues.push({ path, code: "malformed_model_ref", message: 'expected a "provider/model" string' });
    return undefined;
  }
  const slash = ref.indexOf("/"); // first "/" only: "openrouter/anthropic/claude-x" -> openrouter + anthropic/claude-x
  if (slash <= 0 || slash === ref.length - 1) {
    issues.push({ path, code: "malformed_model_ref", message: `"${ref}" is not of the form "provider/model"` });
    return undefined;
  }
  const provider = ref.slice(0, slash);
  const model = ref.slice(slash + 1);
  const entry = registry.get(provider);
  if (entry === undefined) {
    const known = [...registry.keys()].sort();
    issues.push({ path, code: "unknown_provider", message: `unknown provider "${provider}" (known: ${known.length === 0 ? "none" : listCapped(known)})` });
    return undefined;
  }
  // RULING: models are verified only when the registry entry declares a `models` list. Without one (e.g. a gateway
  // that serves arbitrary ids) the model cannot be checked statically, so it is accepted rather than rejected.
  if (entry.models !== undefined && !entry.models.includes(model)) {
    issues.push({ path, code: "unknown_model", message: `provider "${provider}" has no model "${model}" (known: ${entry.models.length === 0 ? "none" : listCapped(entry.models)})` });
    return undefined;
  }
  return { provider, model };
}

function resolveProfile(name: string, cfg: ModelProfileConfig, registry: ProviderRegistry, issues: ConfigIssue[], warnings: ConfigIssue[]): ResolvedProfile | undefined {
  const base = `modelProfiles.${name}`;
  const before = issues.length;
  const rawStrategy: unknown = cfg.strategy;
  let strategy: "fallback" | "moa" = "fallback";
  if (rawStrategy === undefined || rawStrategy === "fallback" || rawStrategy === "moa") {
    if (rawStrategy === "moa") strategy = "moa";
  } else {
    issues.push({ path: `${base}.strategy`, code: "invalid_strategy", message: `unknown strategy ${JSON.stringify(rawStrategy)} (expected "fallback" or "moa")` });
  }

  const raw: unknown = cfg.candidates;
  const list = Array.isArray(raw) ? (raw as ModelProfileConfig["candidates"]) : [];
  const candidates: ResolvedCandidate[] = [];
  if (list.length === 0) {
    issues.push({ path: `${base}.candidates`, code: "empty_candidates", message: "a profile needs at least one candidate" });
  }
  const seen = new Set<string>();
  list.forEach((c, i) => {
    const path = `${base}.candidates[${i}].model`;
    const ref = resolveRef(c?.model, path, registry, issues);
    if (ref === undefined) return;
    const k = `${ref.provider}/${ref.model}`;
    if (seen.has(k)) {
      issues.push({ path, code: "duplicate_candidate", message: `"${k}" is already a candidate of this profile` });
      return;
    }
    seen.add(k);
    // RULING: weight is kept for information only; for "fallback" priority is list order, and moa is not executable yet.
    candidates.push({ provider: ref.provider, model: ref.model, weight: c.weight ?? 1 });
  });

  let aggregator: { provider: string; model: string } | undefined;
  if (cfg.aggregator !== undefined) {
    if (strategy !== "moa") {
      issues.push({ path: `${base}.aggregator`, code: "aggregator_without_moa", message: 'an aggregator is only valid with strategy "moa"' });
    } else {
      aggregator = resolveRef(cfg.aggregator, `${base}.aggregator`, registry, issues);
    }
  }
  if (strategy === "moa" && list.length > 0 && list.length < 2) {
    issues.push({ path: `${base}.candidates`, code: "moa_needs_two_candidates", message: 'strategy "moa" needs at least two candidates' });
  }
  if (issues.length > before) return undefined;

  if (strategy === "moa") {
    warnings.push({ path: base, code: "moa_not_executable", message: MOA_UNSUPPORTED });
  }

  const params: RequestDefaults = {};
  if (cfg.params?.temperature !== undefined) params.temperature = cfg.params.temperature;
  if (cfg.params?.topP !== undefined) params.topP = cfg.params.topP;
  if (cfg.params?.maxTokens !== undefined) params.maxTokens = cfg.params.maxTokens;
  // RULING: `cache` and `displayName` are carried in ResolvedProfile only; ChatRequest has no field for cache hints,
  // so the router cannot act on them (callers/adapters may read them from `resolved.profiles`).
  const cache: ResolvedProfile["cache"] = {};
  if (cfg.cache?.hint !== undefined) cache.hint = cfg.cache.hint;
  if (cfg.cache?.ttlSeconds !== undefined) cache.ttlSeconds = cfg.cache.ttlSeconds;

  const out: ResolvedProfile = { name, strategy, candidates, params, cache };
  if (cfg.displayName !== undefined) out.displayName = cfg.displayName;
  if (aggregator !== undefined) out.aggregator = aggregator;
  return out;
}

export function resolveModelProfiles(config: ModelProfilesConfig | undefined, registry: ProviderRegistry): ResolvedProfiles {
  const issues: ConfigIssue[] = [];
  const warnings: ConfigIssue[] = [];
  const profiles: Record<string, ResolvedProfile> = {};

  for (const [name, cfg] of Object.entries(config ?? {})) {
    const p = resolveProfile(name, cfg, registry, issues, warnings);
    if (p !== undefined) profiles[name] = p;
  }
  if (issues.length > 0) throw new ProfileConfigError(issues);

  // RULING: an explicit "default" profile always wins; otherwise one is synthesised from the registry (entries with a
  // defaultModel, in registry order). With none available there is simply no default: not an error, since callers may
  // always name a profile.
  if (profiles[DEFAULT_PROFILE_NAME] === undefined) {
    const candidates: ResolvedCandidate[] = [];
    for (const [provider, entry] of registry) {
      if (entry.defaultModel !== undefined) candidates.push({ provider, model: entry.defaultModel, weight: 1 });
    }
    if (candidates.length > 0) {
      profiles[DEFAULT_PROFILE_NAME] = { name: DEFAULT_PROFILE_NAME, strategy: "fallback", candidates, params: {}, cache: {} };
    }
  }

  const table: Record<string, readonly Candidate[]> = {};
  const defaults: Record<string, RequestDefaults> = {};
  const unsupported: Record<string, string> = {};
  for (const [name, p] of Object.entries(profiles)) {
    table[name] = p.candidates.map((c) => ({ provider: c.provider, model: c.model, adapter: registry.get(c.provider)!.adapter }));
    defaults[name] = { ...p.params };
    if (p.strategy === "moa") unsupported[name] = MOA_UNSUPPORTED;
  }
  return {
    profiles, table, defaults, unsupported,
    defaultProfile: profiles[DEFAULT_PROFILE_NAME] === undefined ? undefined : DEFAULT_PROFILE_NAME,
    warnings,
  };
}
