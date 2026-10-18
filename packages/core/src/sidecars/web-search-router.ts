// web.search over several providers (D95): SearXNG (the sidecar, `web-search.ts`) and the keyed APIs Brave, Tavily and Exa
// (`tools/web/search-providers.ts`), chosen per agent from the existing configuration.
//
// Configuration. Nothing new in the schema: the settings live under `modules.web-search`, the free-form per-module
// section (docs/web-search.md has the full example):
//   providers       fallback order for every agent, e.g. ["brave", "searxng"]; absent means ["searxng"], which is the
//                   behaviour before the keyed providers existed
//   agents.<id>     { providers: [...] } replaces that order for one agent (an empty list switches search off for it)
//   keys.<provider> the NAME of the secret that holds the API key; default `web-search.<provider>`
//   timeoutMs, minIntervalMs.<provider>, enabled
// Unknown ids and malformed entries are ignored and reported by `providers()`, never guessed at.
//
// Per agent, not per turn (D95, ADR-010 R4): the chain chosen for an (agent, session) pair is kept for the life of that
// session, so a configuration change applies from the next session. Keys are read from the secret store on every call
// (rotation applies at once) and handed to the provider as a header value; they are held nowhere else.
//
// Egress. The keyed providers go through the egress policy (search-http.ts): their hosts must be in `egress.allowHosts`.
// SearXNG keeps its own narrower sidecar rule.
//
// Privacy. A trace carries the provider id, counts, timings and failure codes, never the query, the results or a key.
import { WebFailure, type WebFailureCode } from "../tools/web/failure.ts";
import { isSecretName } from "../secrets/types.ts";
import type { EgressConfig } from "../egress/policy.ts";
import type { Decision } from "../egress/gate.ts";
import { createWebSearch, type SearchProvider, type WebSearch, type WebSearchContext } from "../tools/web/search.ts";
import { createSearchApiClient } from "../tools/web/search-http.ts";
import { KEYED_PROVIDER_IDS, createKeyedProvider, createRateLimiter, type KeyedProviderId, type RateLimiter } from "../tools/web/search-providers.ts";
import { createSearxngWebSearch, resolveSearxngTarget, type SearxngWebSearch, type SearxngWebSearchOptions, type SidecarsConfig } from "./web-search.ts";

export const WEB_SEARCH_MODULE = "web-search";
export type SearchProviderId = "searxng" | KeyedProviderId;
export const SEARCH_PROVIDER_IDS: readonly SearchProviderId[] = ["searxng", ...KEYED_PROVIDER_IDS];

export interface WebSearchSettings {
  enabled: boolean;
  /** Global fallback order; undefined when the configuration names none. */
  providers: SearchProviderId[] | undefined;
  agents: Record<string, SearchProviderId[]>;
  keys: Record<KeyedProviderId, string>;
  timeoutMs: number | undefined;
  minIntervalMs: Partial<Record<KeyedProviderId, number>>;
  /** What was ignored, in words for a person. */
  problems: string[];
}

const isRecord = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);
const AGENT_ID = /^[a-z0-9][a-z0-9_-]{0,63}$/;

export function defaultKeyName(id: KeyedProviderId): string {
  return `web-search.${id}`;
}

function parseChain(raw: unknown, where: string, problems: string[]): SearchProviderId[] | undefined {
  if (!Array.isArray(raw)) {
    problems.push(`${where} must be a list of provider ids`);
    return undefined;
  }
  const out: SearchProviderId[] = [];
  for (const item of raw) {
    if (typeof item === "string" && (SEARCH_PROVIDER_IDS as readonly string[]).includes(item)) {
      if (!out.includes(item as SearchProviderId)) out.push(item as SearchProviderId);
    } else problems.push(`${where}: unknown provider ${JSON.stringify(typeof item === "string" ? item.slice(0, 40) : typeof item)} ignored`);
  }
  return out;
}

export function parseWebSearchSettings(raw: unknown): WebSearchSettings {
  const problems: string[] = [];
  const s: WebSearchSettings = { enabled: true, providers: undefined, agents: {}, keys: { brave: defaultKeyName("brave"), tavily: defaultKeyName("tavily"), exa: defaultKeyName("exa") }, timeoutMs: undefined, minIntervalMs: {}, problems };
  if (raw === undefined) return s;
  if (!isRecord(raw)) {
    problems.push(`modules.${WEB_SEARCH_MODULE} must be an object`);
    return s;
  }
  if (raw.enabled === false) s.enabled = false;
  if (raw.providers !== undefined) s.providers = parseChain(raw.providers, `modules.${WEB_SEARCH_MODULE}.providers`, problems);
  if (raw.agents !== undefined) {
    if (!isRecord(raw.agents)) problems.push(`modules.${WEB_SEARCH_MODULE}.agents must be an object`);
    else
      for (const [id, v] of Object.entries(raw.agents)) {
        const where = `modules.${WEB_SEARCH_MODULE}.agents.${id.slice(0, 64)}`;
        if (!AGENT_ID.test(id)) problems.push(`${where}: not an agent id`);
        else if (!isRecord(v) || v.providers === undefined) problems.push(`${where} needs a providers list`);
        else {
          const chain = parseChain(v.providers, `${where}.providers`, problems);
          if (chain) s.agents[id] = chain;
        }
      }
  }
  if (raw.keys !== undefined) {
    if (!isRecord(raw.keys)) problems.push(`modules.${WEB_SEARCH_MODULE}.keys must be an object`);
    else
      for (const [id, v] of Object.entries(raw.keys)) {
        if (!(KEYED_PROVIDER_IDS as readonly string[]).includes(id)) problems.push(`keys.${id.slice(0, 40)}: unknown provider ignored`);
        else if (!isSecretName(v)) problems.push(`keys.${id}: not a valid secret name; the default ${defaultKeyName(id as KeyedProviderId)} is used`);
        else s.keys[id as KeyedProviderId] = v;
      }
  }
  if (raw.timeoutMs !== undefined) {
    if (typeof raw.timeoutMs === "number" && Number.isInteger(raw.timeoutMs) && raw.timeoutMs >= 1000 && raw.timeoutMs <= 60_000) s.timeoutMs = raw.timeoutMs;
    else problems.push("timeoutMs must be an integer from 1000 to 60000; the default is used");
  }
  if (raw.minIntervalMs !== undefined) {
    if (!isRecord(raw.minIntervalMs)) problems.push("minIntervalMs must be an object");
    else
      for (const [id, v] of Object.entries(raw.minIntervalMs)) {
        if (!(KEYED_PROVIDER_IDS as readonly string[]).includes(id)) problems.push(`minIntervalMs.${id.slice(0, 40)}: unknown provider ignored`);
        else if (typeof v === "number" && Number.isInteger(v) && v >= 0 && v <= 60_000) s.minIntervalMs[id as KeyedProviderId] = v;
        else problems.push(`minIntervalMs.${id} must be an integer from 0 to 60000`);
      }
  }
  return s;
}

/** The chain for one agent: its own list, else the global one, else SearXNG alone. */
export function chainFor(s: WebSearchSettings, agentId: string | undefined): SearchProviderId[] {
  return (agentId !== undefined ? s.agents[agentId] : undefined) ?? s.providers ?? ["searxng"];
}

export interface ProviderStatus {
  id: SearchProviderId;
  /** In the global order (the one an agent without its own list uses). */
  selected: boolean;
  /** Keyed providers: whether a key is stored under the configured name. SearXNG: whether the sidecar is wired. `null` = unknown. */
  configured: boolean | null;
  /** Seconds left of a rate-limit cooldown. */
  coolingSeconds: number;
}

export interface ConfiguredWebSearchOptions extends Omit<SearxngWebSearchOptions, "config"> {
  config: () => { sidecars?: SidecarsConfig | undefined; modules?: Record<string, unknown> | undefined; egress: EgressConfig };
  /** The API key stored under `name`, or null when there is none. Must not log it. */
  readSecret(name: string): Promise<string | null>;
  /** Overrides the vendor URLs (tests point them at a local stub). */
  endpoints?: Partial<Record<KeyedProviderId, string>> | undefined;
  sleep?: ((ms: number, signal?: AbortSignal) => Promise<void>) | undefined;
  onEgressDecision?: ((d: Decision) => void) | undefined;
  tlsCa?: string | undefined;
}

export interface ConfiguredWebSearch extends SearxngWebSearch {
  providers(): Promise<{ providers: ProviderStatus[]; problems: string[] }>;
}

const MAX_SNAPSHOTS = 512;

export function createConfiguredWebSearch(o: ConfiguredWebSearchOptions): ConfiguredWebSearch {
  const now = o.now ?? Date.now;
  const settingsNow = (): WebSearchSettings => parseWebSearchSettings(o.config().modules?.[WEB_SEARCH_MODULE]);
  const client = createSearchApiClient({ egress: () => o.config().egress, resolver: o.resolver, timeoutMs: o.timeoutMs ?? 10_000, onDecision: o.onEgressDecision, tlsCa: o.tlsCa });
  // The sidecar part is the existing implementation, unchanged; it traces nothing itself (the router traces once).
  const searxng = createSearxngWebSearch({ config: () => o.config().sidecars, env: o.env, now, ...(o.resolver ? { resolver: o.resolver } : {}), ...(o.timeoutMs ? { timeoutMs: o.timeoutMs } : {}), ...(o.maxBytes ? { maxBytes: o.maxBytes } : {}) });
  const limiters = new Map<KeyedProviderId, { limiter: RateLimiter; interval: number }>();
  const snapshots = new Map<string, SearchProviderId[]>();

  const limiterFor = (id: KeyedProviderId, interval: number): RateLimiter => {
    const held = limiters.get(id);
    if (held && held.interval === interval) return held.limiter;
    const limiter = createRateLimiter({ now, minIntervalMs: interval });
    limiters.set(id, { limiter, interval });
    return limiter;
  };

  const sidecarWired = (): boolean => resolveSearxngTarget(o.config().sidecars, o.env).mode !== "off";

  function chainFromSnapshot(s: WebSearchSettings, ctx: WebSearchContext): SearchProviderId[] {
    const key = ctx.agentId !== undefined && ctx.sessionId !== undefined ? `${ctx.agentId}\u0000${ctx.sessionId}` : undefined;
    const held = key !== undefined ? snapshots.get(key) : undefined;
    if (held) return held;
    const chain = chainFor(s, ctx.agentId);
    if (key !== undefined) {
      if (snapshots.size >= MAX_SNAPSHOTS) snapshots.delete(snapshots.keys().next().value!);
      snapshots.set(key, chain);
    }
    return chain;
  }

  const search: WebSearch = {
    async search(args, ctx = {}) {
      const s = settingsNow();
      const ids = s.enabled ? chainFromSnapshot(s, ctx).filter((id) => id !== "searxng" || sidecarWired()) : [];
      const attempted = new Set<SearchProviderId>();
      const failed = new Map<SearchProviderId, WebFailure>();
      const wrap = (inner: SearchProvider): SearchProvider => ({
        id: inner.id,
        async search(q, signal) {
          attempted.add(inner.id as SearchProviderId);
          try {
            return await inner.search(q, signal);
          } catch (err) {
            failed.set(inner.id as SearchProviderId, err instanceof WebFailure ? err : new WebFailure("internal-error", "unexpected failure"));
            throw err;
          }
        },
      });
      const providers: SearchProvider[] = ids.map((id) =>
        id === "searxng"
          ? wrap({ id, async search(q, signal) { return (await searxng.search.search({ query: q.query, count: q.count, ...(q.freshness ? { freshness: q.freshness } : {}), ...(q.site ? { site: q.site } : {}), ...(q.lang ? { lang: q.lang } : {}) }, { signal })).results; } })
          : wrap(
              createKeyedProvider(id, {
                request: client,
                apiKey: () => o.readSecret(s.keys[id]),
                endpoint: o.endpoints?.[id],
                now,
                sleep: o.sleep,
                limiter: limiterFor(id, s.minIntervalMs[id] ?? 0),
              }),
            ),
      );
      const inner = createWebSearch({ providers, timeoutMs: s.timeoutMs ?? o.timeoutMs ?? 10_000, now, ...(o.trace ? { trace: o.trace } : {}) });
      try {
        return await inner.search(args, ctx);
      } catch (err) {
        if (!(err instanceof WebFailure) || err.code !== "provider-failed") throw err;
        // `createWebSearch` reports "all providers failed"; the person and the agent need the cause, in codes only.
        const causes = ids.filter((id) => attempted.has(id)).map((id) => ({ id, failure: failed.get(id) ?? new WebFailure("timeout", `provider ${id} timed out`) }));
        if (causes.length > 0 && causes.every((c) => c.failure.code === "no-provider")) throw new WebFailure("no-provider", `no search provider is usable: ${causes.map((c) => c.id).join(", ")} ${causes.length === 1 ? "has" : "have"} no API key`);
        const real = causes.filter((c) => c.failure.code !== "no-provider");
        if (real.length === 1) throw real[0]!.failure;
        const waits = real.map((c) => c.failure.extra.retryAfterSeconds).filter((n): n is number => typeof n === "number");
        throw new WebFailure("provider-failed", `all ${real.length} search providers failed (${real.map((c) => `${c.id}: ${c.failure.code as WebFailureCode}`).join(", ")})`, waits.length === real.length && waits.length > 0 ? { retryAfterSeconds: Math.min(...waits) } : {});
      }
    },
  };

  return {
    search,
    status: searxng.status,
    async providers() {
      const s = settingsNow();
      const selected = s.providers ?? ["searxng"];
      const out: ProviderStatus[] = [];
      for (const id of SEARCH_PROVIDER_IDS) {
        if (id === "searxng") {
          out.push({ id, selected: selected.includes(id), configured: sidecarWired(), coolingSeconds: 0 });
          continue;
        }
        let configured: boolean | null = null;
        try {
          configured = (await o.readSecret(s.keys[id])) !== null;
        } catch {
          configured = null;
        }
        const held = limiters.get(id);
        out.push({ id, selected: selected.includes(id), configured, coolingSeconds: held ? Math.ceil(held.limiter.coolingMs() / 1000) : 0 });
      }
      return { providers: out, problems: s.problems };
    },
  };
}
