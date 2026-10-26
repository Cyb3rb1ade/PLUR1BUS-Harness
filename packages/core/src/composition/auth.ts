import type { OpenAIRuntime } from '../openai-auth/runtime.ts';
import type { OpenAIProviderBinding } from '../openai-auth/provider.ts';
import { createChatCompletionsAdapter, createAnthropicAdapter, createResponsesAdapter, createGeminiAdapter, ProviderError, resolveModelProfiles, cacheRouteForUrl, ANTHROPIC_DEFAULT_BASE_URL, RESPONSES_DEFAULT_BASE_URL, GEMINI_DEFAULT_BASE_URL, type CacheRoute, type ProviderRegistry, type StreamingAdapter, type ProfileTable } from '../../../providers/src/index.ts';
import { createCredentialsProvider, createAuthSecretStore, GoogleAdc, HttpRefresher, createOAuthHttp, type ProfileCredentials, type AuthorizationLease, AuthError } from '../auth/index.ts';
import type { SecretStore } from '../secrets/store.ts';
import type { Egress } from '../egress/service.ts';
import type { HarnessConfig } from '@plur1bus/config-schema';
import { stage, type PipelineLog } from './trace.ts';
import type { ProviderFamily } from '../toolcall/quirks.ts';
import { providerFetch } from './http.ts';
import type { BillingClass } from './provider.ts';

/** `billingPath` (ADR-005 D110 vocabulary): `chatgpt_plan`/`cli_login`/`plan` bill a subscription, `api_key`/`workload`/`paid` are metered. */
export interface ProviderDefinition extends ProfileCredentials { openai?: OpenAIProviderBinding; wireFormat: 'chat_completions' | 'anthropic_messages' | 'codex_responses' | 'gemini'; defaultModel?: string; models?: string[]; billingPath?: string }
const PLAN_PATHS = new Set(['chatgpt_plan', 'cli_login', 'plan']), PAID_PATHS = new Set(['api_key', 'workload', 'paid']);
const DEFAULT_BASE_URL: Record<ProviderDefinition['wireFormat'], string> = { anthropic_messages: ANTHROPIC_DEFAULT_BASE_URL, codex_responses: RESPONSES_DEFAULT_BASE_URL, gemini: GEMINI_DEFAULT_BASE_URL, chat_completions: 'https://api.openai.com/v1' };
/** Explicit billing path first; otherwise from the credential kind: keys and ADC are metered, interactive logins are a plan. */
export function billingClassOf(def: Pick<ProviderDefinition, 'billingPath' | 'profile'>): BillingClass | undefined {
  if (def.profile?.client_registration === 'dynamic_on_authorize') return 'plan'; // The credential kind fixes SIWC billing, regardless of a stale profile label.
  const path = def.billingPath ?? (def.profile as { billing_path?: string } | undefined)?.billing_path;
  if (path !== undefined) return PLAN_PATHS.has(path) ? 'plan' : PAID_PATHS.has(path) ? 'paid' : undefined;
  const kind = def.profile?.kind;
  return kind === 'api_key' || kind === 'adc' || kind === 'federated_token' ? 'paid' : kind === 'oauth_pkce' || kind === 'device_code' || kind === 'external_cli' ? 'plan' : undefined;
}
/**
 * Where a provider's requests go, for the cache profile and the cache emitter: the base URL (or the wire's default URL)
 * says which API a request reaches (a gateway, a platform, a provider's own API). The managed OpenAI binding billing
 * the ChatGPT plan is its own platform, whose fields differ from the API's.
 */
export function cacheRouteFor(def: ProviderDefinition, managed: boolean): CacheRoute {
  const route = cacheRouteForUrl(def.profile.base_url ?? DEFAULT_BASE_URL[def.wireFormat]);
  return managed && billingClassOf(def) === 'plan' ? { ...route, platform: 'chatgpt-plan' } : route;
}
/** A provider definition composition refused: it is not composed and never offered for a turn. `code` is always `E_CONFIG_INVALID`. */
export interface RefusedProvider { provider: string; code: 'E_CONFIG_INVALID'; reason: string }
/**
 * Fail closed (ADR-005 §Never): a provider whose billing class cannot be determined (misspelled or empty billing path, unknown
 * credential kind, missing profile) would never be refused for billing, so that provider is refused before anything is composed.
 * Only that provider: the others keep their class and keep serving turns.
 */
function classifyProviders(definitions: Readonly<Record<string, ProviderDefinition>>): { billing: Record<string, BillingClass>; refused: RefusedProvider[] } {
  const billing: Record<string, BillingClass> = {};
  const refused: RefusedProvider[] = [];
  for (const [id, def] of Object.entries(definitions)) {
    const profile = (def as Partial<ProviderDefinition> | undefined)?.profile;
    const cls = profile && typeof profile === 'object' ? billingClassOf(def) : undefined;
    if (cls) { billing[id] = cls; continue; }
    const path = def?.billingPath ?? (profile as { billing_path?: unknown } | undefined)?.billing_path;
    const reason = !profile || typeof profile !== 'object' ? 'the provider has no auth profile'
      : path !== undefined ? `billing path ${JSON.stringify(path)} is not one of ${[...PLAN_PATHS, ...PAID_PATHS].join(', ')}`
      : `credential kind ${JSON.stringify(profile.kind)} has no billing class`;
    refused.push({ provider: id, code: 'E_CONFIG_INVALID', reason: `billing class cannot be determined: ${reason}` });
  }
  return { billing, refused };
}
/** Model profiles lose the candidates that name a refused provider; a profile left without candidates is dropped. */
function withoutRefused(profiles: HarnessConfig['modelProfiles'], refused: ReadonlySet<string>): HarnessConfig['modelProfiles'] {
  if (!profiles || refused.size === 0) return profiles;
  const out: NonNullable<HarnessConfig['modelProfiles']> = {};
  const named = (ref: unknown) => typeof ref === 'string' && refused.has(ref.slice(0, ref.indexOf('/')));
  for (const [name, profile] of Object.entries(profiles)) {
    const candidates = Array.isArray(profile?.candidates) ? profile.candidates.filter(c => !named(c?.model)) : profile?.candidates;
    if (Array.isArray(profile?.candidates) && candidates!.length === 0 && profile.candidates.length > 0) continue;
    Object.defineProperty(out, name, { value: { ...profile, candidates }, enumerable: true, writable: true, configurable: true });
  }
  return out;
}
export function composeAuth(o: { config: HarnessConfig; definitions: Readonly<Record<string, ProviderDefinition>>; secrets: SecretStore; egress: Egress; log?: PipelineLog; fetch?: typeof fetch; openai?: OpenAIRuntime; registerSecret?: (value: string) => void }) {
  const { billing, refused } = classifyProviders(o.definitions);
  const refusedIds = new Set(refused.map(r => r.provider));
  const definitions = Object.fromEntries(Object.entries(o.definitions).filter(([id]) => !refusedIds.has(id)));
  // The leased value is registered for redaction (TurnToolError.detail): the whole header value and the bare credential.
  const registerCredential = (value: string) => { if (!o.registerSecret) return; o.registerSecret(value); const bare = value.replace(/^(?:Bearer|Basic)\s+/i, ''); if (bare !== value) o.registerSecret(bare); };
  const http = createOAuthHttp({ egress: o.egress });
  const credentials = createCredentialsProvider({ profiles: Object.values(definitions).filter(def => !o.openai?.handles(def)), store: createAuthSecretStore(o.secrets), clock: { now: Date.now }, refresher: new HttpRefresher(http), adc: new GoogleAdc({ http, clock: { now: Date.now } }) });
  // Read-only discovery access to the same pool/refresh owner. A changed profile cannot reuse a lease
  // registered for its previous origin or secret reference; composition must be restarted first.
  const discoveryProfiles = new Map(Object.values(definitions).map(def => [def.profile.id, JSON.stringify([def.profile, def.entries, def.strategy])]));
  const credentialsForDiscovery = (def: ProviderDefinition) => discoveryProfiles.get(def.profile.id) === JSON.stringify([def.profile, def.entries, def.strategy]) ? credentials : undefined;
  const registry: Map<string, ProviderRegistry extends ReadonlyMap<string, infer E> ? E : never> = new Map();
  const families: Record<string, ProviderFamily> = {};
  const cacheRoutes: Record<string, CacheRoute> = {};
  for (const [id, def] of Object.entries(definitions)) {
    const format = def.wireFormat;
    // The managed OpenAI binding builds its own transport with the same route (openai-auth/runtime.ts).
    const route = cacheRoutes[id] = cacheRouteFor(def, o.openai?.handles(def) === true);
    const fetch = providerFetch(o.egress, format, o.fetch, route);
    families[id] = format === 'anthropic_messages' ? 'anthropic' : format === 'codex_responses' ? 'openai-responses' : format === 'gemini' ? 'gemini' : 'openai-chat';
    const managed = o.openai?.handles(def) ? o.openai.adapter(def) : undefined;
    const wrapper: StreamingAdapter = { async *stream(request, options) {
      if (managed) { yield* managed.stream(request, options); return; }
      options?.signal?.throwIfAborted();
      let lease: AuthorizationLease | undefined;
      const header = async () => {
        lease = await stage('auth', options?.signal ?? new AbortController().signal, o.log ?? (() => {}), () => credentials.getAuthorization({ profileId: def.profile.id, model: request.model }));
        registerCredential(lease.header.value);
        options?.signal?.throwIfAborted(); return lease.header.value;
      };
      const config = { ...(def.profile.base_url ? { baseUrl: def.profile.base_url } : {}), fetch, ...(def.profile.extra_headers ? { headers: def.profile.extra_headers } : {}) };
      const adapter = format === 'anthropic_messages' ? createAnthropicAdapter({ ...config, credentials: { apiKey: header } }) : format === 'codex_responses' ? createResponsesAdapter({ ...config, credentials: { authorization: header } }) : format === 'gemini' ? createGeminiAdapter({ ...config, credentials: { apiKey: header } }) : createChatCompletionsAdapter({ ...config, baseUrl: def.profile.base_url ?? DEFAULT_BASE_URL.chat_completions, credentials: { authorization: header } });
      try {
        for await (const e of adapter.stream(request, options)) yield e;
        if (lease) await credentials.reportResult(lease, { ok: true, model: request.model });
      } catch (e) {
        if (lease && e instanceof ProviderError && e.status !== undefined) await credentials.reportResult(lease, { ok: false, status: e.status, model: request.model, ...(e.retryAfterMs !== undefined ? { retryAfterMs: e.retryAfterMs } : {}) });
        if (e instanceof AuthError) throw new ProviderError('auth', e.code, { cause: e });
        throw e;
      }
    } };
    registry.set(id, { adapter: wrapper, ...(def.defaultModel ? { defaultModel: def.defaultModel } : {}), ...(def.models ? { models: def.models } : {}) });
  }
  const resolved = resolveModelProfiles(withoutRefused(o.config.modelProfiles, refusedIds), registry);
  return { credentialsForDiscovery, profiles: resolved.table as ProfileTable, families, billing, refused, resolved, cacheRoutes, close: () => credentials.close() };
}
