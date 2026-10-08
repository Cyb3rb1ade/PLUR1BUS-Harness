import { createChatCompletionsAdapter, createAnthropicAdapter, createResponsesAdapter, createGeminiAdapter, ProviderError, resolveModelProfiles, type ProviderRegistry, type StreamingAdapter, type ProfileTable } from '../../../providers/src/index.ts';
import { createCredentialsProvider, createAuthSecretStore, GoogleAdc, HttpRefresher, createOAuthHttp, type ProfileCredentials, type AuthorizationLease, AuthError } from '../auth/index.ts';
import type { SecretStore } from '../secrets/store.ts';
import type { Egress } from '../egress/service.ts';
import type { HarnessConfig } from '@plur1bus/config-schema';
import { stage, type PipelineLog } from './trace.ts';
import type { ProviderFamily } from '../toolcall/quirks.ts';
import { providerFetch } from './http.ts';

export interface ProviderDefinition extends ProfileCredentials { wireFormat: 'chat_completions' | 'anthropic_messages' | 'codex_responses' | 'gemini'; defaultModel?: string; models?: string[] }
export function composeAuth(o: { config: HarnessConfig; definitions: Readonly<Record<string, ProviderDefinition>>; secrets: SecretStore; egress: Egress; log?: PipelineLog; fetch?: typeof fetch }) {
  const http = createOAuthHttp({ egress: o.egress });
  const credentials = createCredentialsProvider({ profiles: Object.values(o.definitions), store: createAuthSecretStore(o.secrets), clock: { now: Date.now }, refresher: new HttpRefresher(http), adc: new GoogleAdc({ http, clock: { now: Date.now } }) });
  const registry: Map<string, ProviderRegistry extends ReadonlyMap<string, infer E> ? E : never> = new Map();
  const families: Record<string, ProviderFamily> = {};
  for (const [id, def] of Object.entries(o.definitions)) {
    const format = def.wireFormat;
    const fetch = providerFetch(o.egress, format, o.fetch);
    families[id] = format === 'anthropic_messages' ? 'anthropic' : format === 'codex_responses' ? 'openai-responses' : format === 'gemini' ? 'gemini' : 'openai-chat';
    const wrapper: StreamingAdapter = { async *stream(request, options) {
      options?.signal?.throwIfAborted();
      let lease: AuthorizationLease | undefined;
      const header = async () => { lease = await stage('auth', options?.signal ?? new AbortController().signal, o.log ?? (() => {}), () => credentials.getAuthorization({ profileId: def.profile.id, model: request.model })); options?.signal?.throwIfAborted(); return lease.header.value; };
      const config = { ...(def.profile.base_url ? { baseUrl: def.profile.base_url } : {}), fetch, ...(def.profile.extra_headers ? { headers: def.profile.extra_headers } : {}) };
      const adapter = format === 'anthropic_messages' ? createAnthropicAdapter({ ...config, credentials: { apiKey: header } }) : format === 'codex_responses' ? createResponsesAdapter({ ...config, credentials: { authorization: header } }) : format === 'gemini' ? createGeminiAdapter({ ...config, credentials: { apiKey: header } }) : createChatCompletionsAdapter({ ...config, baseUrl: def.profile.base_url ?? 'https://api.openai.com/v1', credentials: { authorization: header } });
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
  const resolved = resolveModelProfiles(o.config.modelProfiles, registry);
  return { profiles: resolved.table as ProfileTable, families, resolved, close: () => credentials.close() };
}
