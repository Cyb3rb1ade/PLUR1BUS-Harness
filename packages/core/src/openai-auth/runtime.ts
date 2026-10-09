import { join } from 'node:path';
import { mkdirSync } from 'node:fs';
import { AuthService } from './service.ts';
import { createOpenAIHttp } from './http.ts';
import { PlanUsageStore } from './usage.ts';
import { createAuthSecretStore } from '../auth/secret-store.ts';
import { openAIAdapter, isOpenAIManaged } from './provider.ts';
import type { CompositionDeps } from '../composition/index.ts';
import type { ProviderDefinition } from '../composition/auth.ts';
import { providerFetch } from '../composition/http.ts';
import { turnContext } from '../composition/context.ts';
export function createOpenAIRuntime(d: CompositionDeps) {
  const cfg = d.config().auth?.openai;
  const audit: import('./ports.ts').AuditPort = event => { const detail = { ...event }; d.audit.append({ at: d.clock(), actor: { user: 'core', host: 'core' }, action: 'auth.openai.' + event.kind, target: 'openai', detail }); d.logger.info('auth.openai.' + event.kind, detail); };
  const http = createOpenAIHttp({ egress: d.egress, ...(d.options?.fetch ? { fetch: d.options.fetch } : {}), timeoutMs: cfg?.httpTimeoutMs ?? 30000 });
  const baseStore = createAuthSecretStore(d.secrets);
  const guard = async () => { if (cfg?.storeBackend === 'keyring' && (await d.secrets.status({ kind: 'core' })).backend !== 'keyring') throw new (await import('./ports.ts')).OpenAIError('persist-failed'); };
  const store = { async get(ref: string) { await guard(); return baseStore.get(ref); }, async set(ref: string, value: string) { await guard(); await baseStore.set(ref, value); }, async delete(ref: string) { await guard(); await baseStore.delete(ref); } };
  const auth = new AuthService({ http, store, clock: { now: d.clock }, audit, timeoutMs: cfg?.loopbackTimeoutMs ?? 600000, refreshSkewMs: (cfg?.refreshSkewSeconds ?? 120) * 1000 });
  mkdirSync(join(d.home, 'state'), { recursive: true, mode: 0o700 });
  const usage = new PlanUsageStore(join(d.home, 'state', 'openai-plan-usage.sqlite'));
  d.options?.onOpenAI?.(auth);
  return { auth, usage, http, audit, handles: isOpenAIManaged, adapter: (definition: ProviderDefinition) => openAIAdapter({ definition: definition.profile.kind === 'federated_token' && definition.openai ? { ...definition, openai: { ...definition.openai, federated: definition.openai.federated ?? cfg?.federated ?? {} } } : definition, auth, usage, clock: d.clock, fetch: providerFetch(d.egress, 'codex_responses', d.options?.fetch), currentPerson: () => turnContext.getStore()?.approver?.person ?? turnContext.getStore()?.authenticatedPerson }), async close() { await auth.close(); usage.close(); } };
}
export type OpenAIRuntime = ReturnType<typeof createOpenAIRuntime>;
