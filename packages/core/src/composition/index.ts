import { join } from 'node:path';
import { mkdir, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import type { HarnessConfig } from '@plur1bus/config-schema';
import type { Engine } from '@cyb3rb1ade/plur1bus-memory/types/engine.js';
import type { AgentRegistry } from '../agents.ts';
import type { HarnessLogger } from '../logger.ts';
import type { SecretStore } from '../secrets/store.ts';
import type { Egress } from '../egress/service.ts';
import type { PermissionRuntime } from '../approvals/runtime.ts';
import type { AuditSink } from '../rbac/audit.ts';
import type { IdentityService } from '../identity/service.ts';
import { deriveUserPrincipal } from '../identity/principals.ts';
import { createRecallScopeProvider } from '../identity/recall.ts';
import { engineTurnMemory } from '../session/memory-port.ts';
import { openSessionService, type SessionService } from '../session/service.ts';
import type { ChatProvider, ChatRequest } from '../session/provider.ts';
import { createCallBudget, PriceBook, SHIPPED_PRICE_TABLES, type CallBudget } from '../budget/index.ts';
import { createPolicyAudit } from '../policy/audit.ts';
import type { GrantSource } from '../policy/index.ts';
import { createMcpRegistry } from '../mcp/index.ts';
import { composeMedia, type MediaDefinition } from './media.ts';
import { composeAuth, type ProviderDefinition } from './auth.ts';
import { composeTools, type ToolCompositionOptions } from './tools.ts';
import { createTurnProvider, type TurnProviderOptions } from './provider.ts';
import { ToolRegistry } from '../tools/registry.ts';
import { createCollab, alsAgentScopePort, type Collab } from '../collab/index.ts';
import { composedAgentRunner } from './collaboration.ts';
import { legacyAdapter } from './legacy.ts';

export interface CompositionOptions {
  definitions?: Readonly<Record<string, ProviderDefinition>>;
  fetch?: typeof fetch;
  providers?: Pick<TurnProviderOptions, 'profiles' | 'family' | 'router' | 'onPrompt' | 'maxTokens' | 'topK' | 'maxRounds'>;
  tools?: Partial<Pick<ToolCompositionOptions, 'roots' | 'deny' | 'exec' | 'host' | 'extra' | 'mcp' | 'media'>>;
}
export interface CompositionDeps {
  home: string; config: () => HarnessConfig; engine: Engine; agents: AgentRegistry; logger: HarnessLogger;
  secrets: SecretStore; egress: Egress; permissions: PermissionRuntime; audit: AuditSink; identity: IdentityService;
  clock: () => number; signal: AbortSignal; isStopping: () => boolean;
  notify: (method: string, params: object, opts: { optIn: true }) => void;
  authenticatedPerson?: import("../session/methods.ts").SessionMethodDeps["authenticatedPerson"];
  onStoredCapture?: (agentId: string) => void;
  provider?: ChatProvider; options?: CompositionOptions; prices?: PriceBook;
}
export interface TurnComposition { sessions: SessionService; collab: Collab | null; close(): Promise<void> }
/** Composition owns session lifetime and its dependent turn services. Bootstrap retains engine/secret/RPC ownership. */
export async function openTurnComposition(d: CompositionDeps): Promise<TurnComposition> {
  const disposers: (() => void | Promise<void>)[] = [];
  const isolated = <T>(name: string, create: () => T): T | null => { try { return create(); } catch (e) { d.logger.error(`${name} unavailable`, { err: e }); return null; } };
  const options = d.options ?? {};
  const principal = (req: ChatRequest) => {
    const linked = req.caller && d.identity.resolve(req.caller);
    return linked ? deriveUserPrincipal(linked.humanId) : req.principal!;
  };
  const scope = createRecallScopeProvider(d.identity);
  const memory = engineTurnMemory({ engine: d.engine, config: d.config, agents: d.agents, logger: d.logger, captureSignal: d.signal, isStopping: d.isStopping, ...(d.onStoredCapture ? { onStoredCapture: d.onStoredCapture } : {}), identity: d.identity, scope });
  const cfg = d.config();
  const budget = isolated('turn budget', () => createCallBudget({ path: join(d.home, 'state', 'budget.sqlite'), clock: { now: d.clock }, prices: d.prices ?? new PriceBook(SHIPPED_PRICE_TABLES), emitter: { emit(event) {
    if (event.type === 'refuse') d.audit.append({ at: d.clock(), actor: { user: 'core', host: 'core' }, action: 'budget.refused', target: event.refusal.id || 'global', detail: { ...event.refusal } });
  } } }));
  if (budget) disposers.push(() => budget.close());
  const definitions = options.definitions ?? Object.fromEntries(Object.entries(cfg.providers).filter(([, value]) => !!value && typeof value === 'object' && 'wireFormat' in value)) as Record<string, ProviderDefinition>;
  const auth = isolated('turn providers', () => composeAuth({ config: cfg, definitions, secrets: d.secrets, egress: d.egress, log: record => d.logger.info('turn.stage', { ...record }), ...(options.fetch ? { fetch: options.fetch } : {}) }));
  if (auth) disposers.push(() => auth.close());
  const audit = createPolicyAudit({ sink: d.audit, clock: { now: d.clock } });
  const grants: GrantSource = { list: q => d.permissions.current()?.grants.list(q) ?? [], get: id => d.permissions.current()?.grants.get(id) };
  const mcp = isolated('turn MCP', () => createMcpRegistry({ logger: d.logger, secrets: d.secrets, egress: d.egress, policy: { allowedCommands: ((cfg.providers.mcp as { allowedCommands?: string[] } | undefined)?.allowedCommands ?? []) } }));
  const servers: string[] = [];
  if (mcp) {
    disposers.push(() => mcp.shutdown());
    const definitions = (cfg.providers.mcp as { servers?: unknown[] } | undefined)?.servers ?? [];
    for (const raw of definitions) { const registered = isolated('MCP server', () => mcp.register(raw)); if (registered) servers.push(registered.name); }
  }
  const mediaConfig = cfg.providers.media as { adapters?: MediaDefinition[] } | undefined;
  let media = options.tools?.media ?? null;
  if (!media) try { media = await composeMedia(d.home, mediaConfig?.adapters ?? [], d.secrets, d.egress); }
  catch (e) { d.logger.error('turn media unavailable', { err: e }); }
  const profiles = options.providers?.profiles ?? (d.provider ? { default: [{ provider: 'fixture', model: 'gpt-4.1', adapter: legacyAdapter(d.provider) }] } : auth?.profiles ?? {});
  const classProfiles = cfg.decision.classProfiles as Record<string, string> | undefined;
  const toolsForTurn = (req: ChatRequest) => composeTools({ home: d.home, roots: options.tools?.roots ?? [{ id: req.agentId, path: d.agents.workspaceOf(req.agentId) ?? join(d.home, 'agents', req.agentId, 'workspace') }], grants, audit: d.audit, ...(budget ? { budget } : {}), degraded: (service, error) => d.logger.warn('turn tool service degraded', { service, err: error }), ...options.tools, ...(media ? { media } : {}), ...(options.tools?.mcp ? {} : mcp ? { mcp: { port: mcp, servers } } : {}) }, { ...req, principal: principal(req) });
  let sessions: SessionService;
  const provider = budget && Object.keys(profiles).length ? createTurnProvider({ ...options.providers, profiles, profile: auth?.resolved.defaultProfile ?? 'default', profileForClass: modelClass => classProfiles?.[modelClass], router: { profileDefaults: auth?.resolved.defaults ?? {}, unsupportedProfiles: auth?.resolved.unsupported ?? {}, ...options.providers?.router }, family: options.providers?.family ?? auth?.families ?? {}, registry: new ToolRegistry(), budget, principal, toolsForTurn, snapshot: (req, memory) => req.projectId ? memory : sessions.store.freezePromptSnapshot(req.sessionId, memory), onUsage: record => d.logger.info('provider.cache_usage', { ...record }), onPrompt: prompt => { options.providers?.onPrompt?.(prompt); for (const event of prompt.events) d.logger.info(event.type, { ...event }); }, beforeTools: async () => { await d.permissions.open(); }, grants, grantUse: { markUsed: id => d.permissions.current()!.grants.markUsed(id), consumeOnce: (id, binding) => d.permissions.current()!.grants.consumeOnce(id, binding) }, approval: { request: async ask => (await d.permissions.open()).service.request(ask), begin: (answer, ask) => d.permissions.current()?.service.begin(answer, ask) ?? false }, audit, log: record => d.logger.info('turn.stage', { ...record }), resultStore: { async put(value) {
    const dir = join(d.home, 'state', 'tool-results'); await mkdir(dir, { recursive: true, mode: 0o700 });
    const id = randomUUID(); await writeFile(join(dir, `${id}.json`), JSON.stringify(value), { flag: 'wx', mode: 0o600 }); return `tool-result:${id}`;
  } } }) : null;
  const collab = provider && budget ? isolated('collaboration', () => createCollab({ path: join(d.home, 'state', 'collab.sqlite'), clock: d.clock,
    runner: composedAgentRunner(provider, alsAgentScopePort(), d.home), directory: { get: id => d.agents.has(id) ? { id, state: 'active' } : null },
    emit: { emit: event => d.logger.info(event.type, { projectId: event.projectId, traceId: event.traceId }) },
    budget: { check(estimate) {
      const candidate = Object.values(profiles)[0]?.[0]; if (!candidate) return { allowed: false, reason: 'token-budget' };
      const admission = budget.checkBeforeCall({ principal: 'collab-admission', agent: estimate.agentId, project: estimate.projectId, turn: estimate.chainId, model: candidate.model, provider: candidate.provider, estimatedInputTokens: estimate.tokens, maxOutputTokens: 0 });
      if (admission.kind === 'refuse') return { allowed: false, reason: admission.metric === 'cost' ? 'cost-budget' : 'token-budget' };
      budget.releaseUnused(admission.reservationId); return { allowed: true };
    }, record: usage => d.logger.info('collab.usage', { ...usage }) },
  })) : null;
  if (collab) disposers.push(() => collab.shutdown());
  try {
    sessions = openSessionService({ dbPath: join(d.home, 'state', 'sessions.sqlite'), clock: d.clock, logger: d.logger, agents: d.agents, isStopping: d.isStopping, memory, provider: () => provider, notify: d.notify, signal: d.signal, ...(d.authenticatedPerson ? { authenticatedPerson: d.authenticatedPerson } : {}) });
  } catch (e) { for (const close of disposers.reverse()) await close(); throw e; }
  let closed = false;
  return { sessions, collab, async close() {
    if (closed) return; closed = true;
    await sessions.close();
    for (const close of disposers.reverse()) try { await close(); } catch (e) { d.logger.warn('turn service shutdown failed', { err: e }); }
  } };
}
