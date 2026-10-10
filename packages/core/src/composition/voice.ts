import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { createVoiceProviders, voiceEgressHosts, loadSdkClient } from '../../../voice-providers/src/index.ts';
import { createVoiceRuntime } from '../voice/runtime.ts';
import { createVoiceV2 } from '../voice/v2.ts';
import { voiceFetch, voiceSockets, pollyRequestHandler } from '../voice/transport.ts';
import { voiceBudget } from '../voice/budget.ts';
import { createAuthSecretStore } from '../auth/secret-store.ts';
import { decide } from '../policy/index.ts';
import type { CompositionDeps } from './index.ts';
import type { OpenAIRuntime } from '../openai-auth/runtime.ts';
import type { CallBudget } from '../budget/index.ts';
import type { SessionService } from '../session/service.ts';
/** One registration in composition. Existing D110 broker transports and handles retain their ownership. */
export function composeVoice(d: CompositionDeps, openai: OpenAIRuntime, budget: CallBudget | null, sessions: () => SessionService) {
  const { onVoice, ...options } = d.options ?? {};
  const native = createVoiceRuntime({ ...d, options }, openai, budget);
  const secrets = createAuthSecretStore(d.secrets);
  const ledger = budget ? voiceBudget({ path: join(d.home, 'state', 'voice-providers-usage.sqlite'), budget, clock: d.clock, dailySeconds: d.config().auth?.openai?.voiceDailySeconds ?? 3600, billingProvider: 'voice' }) : null;
  const v2 = createVoiceV2({ config: () => d.config().voice, modelsDir: join(d.home, 'models', 'voice'), signal: d.signal, clock: d.clock, sessions,
    budget: ledger?.port ?? { reserve: async () => false, record: async () => false, release: async () => {} },
    registry: (config, usage) => createVoiceProviders(config, { getSecret: ref => secrets.get(ref), fetch: voiceFetch(d.egress), wsFactory: voiceSockets(d.egress), usage, now: d.clock,
      pollyClientFactory: () => loadSdkClient({ ...(config?.polly?.region ? { region: config.polly.region } : {}), ...(config?.polly?.credentials?.profile ? { profile: config.polly.credentials.profile } : {}) }, pollyRequestHandler(d.egress)) }),
    localModelAllowed(provider) {
      const def = d.options?.definitions?.[provider] ?? d.config().providers[provider];
      if (!def || typeof def !== 'object' || !('profile' in def)) return false;
      const base = (def as import('./auth.ts').ProviderDefinition).profile.base_url;
      if (!base) return false;
      try { return ['localhost', '127.0.0.1', '[::1]'].includes(new URL(base).hostname); } catch { return false; }
    },
    async allowed(provider, operation, client, agent) {
      if (!d.agents.has(agent) || !client.approver.person) return false;
      await d.permissions.open();
      const actionHash = createHash('sha256').update(JSON.stringify({ provider, operation, agent, session: client.sessionId })).digest('hex');
      const policy = decide({ capability: 'net.submit', tool: `voice.${operation}`, flags: { outsideRoots: false, denyListHit: false }, actionHash }, { principal: { person: client.approver.person }, subject: { kind: 'agent', agentId: agent }, surface: client.approver.surface, sessionId: client.sessionId }, { grants: d.permissions.current()!.grants, clock: { now: d.clock } });
      d.audit.append({ at: d.clock(), actor: { user: client.principal, host: 'core' }, action: `voice.route.${policy.kind}`, target: provider, detail: { operation } });
      if (policy.kind !== 'allow') return false;
      const config = d.config().voice.providers;
      const declaration = voiceEgressHosts({ providers: { [provider]: config[provider] } });
      if (declaration.unresolved.length) return false;
      for (const host of declaration.hosts) if (!(await d.egress.decide(`https://${host.host}:${host.port}/`)).allowed) return false;
      return true;
    } });
  let closed = false;
  const result = { ...native, openTalk: v2.openTalk, metrics: v2.metrics, renderMetrics: v2.renderMetrics, async close() { if (closed) return; closed = true; try { await v2.close(); } finally { ledger?.close(); await native.close(); } } };
  onVoice?.(result); return result;
}
export type VoiceRuntime = ReturnType<typeof composeVoice>;
