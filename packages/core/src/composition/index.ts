import { createHostctlPool } from '../../../hostctl/src/pool.ts';
import { composeVoice, type VoiceRuntime } from './voice.ts';
import { createOpenAIRuntime, type OpenAIRuntime } from '../openai-auth/runtime.ts';
import { createMediaSurface, mediaActionHash } from '../rpc/media-surface.ts';
import { decide } from '../policy/index.ts';
import { connectionSurface } from '../rbac/connection-surface.ts';
import { RpcError } from '../rpc/errors.ts';
import type { Handler } from '../rpc/server.ts';
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
import { sessionRoleFactory, sessionMaintenance } from '../session/maintenance.ts';
import type { ChatProvider, ChatRequest } from '../session/provider.ts';
import { createCallBudget, PriceBook, SHIPPED_PRICE_TABLES, type CallBudget } from '../budget/index.ts';
import { createPolicyAudit } from '../policy/audit.ts';
import type { GrantSource } from '../policy/index.ts';
import { createMcpRegistry } from '../mcp/index.ts';
import { composeMedia, type MediaDefinition } from './media.ts';
import { composeAuth, type ProviderDefinition, type RefusedProvider } from './auth.ts';
import { composeTools, type ToolCompositionOptions } from './tools.ts';
import { createWriter } from '../logs/writer.ts';
import { createTurnProvider, type TurnProviderOptions } from './provider.ts';
import { ToolRegistry } from '../tools/registry.ts';
import { createCollab, alsAgentScopePort, type Collab } from '../collab/index.ts';
import { composedAgentRunner } from './collaboration.ts';
import { legacyAdapter } from './legacy.ts';
import { composeMediaSearch, mediaSearchMethods } from './media-search.ts';
import { mediaToInbox } from '../inbox/producers.ts';
import { isLocalEndpoint, localEndpoints, localOnlyFor, localOnlyShared, LOCAL_ONLY_REASON, LOCAL_ONLY_HINT } from '../privacy/local-only.ts';

export interface CompositionOptions {
  delegationTargets?: readonly import("../collab/target.ts").DelegationTarget[];
  /** Trusted in-process surfaces register here; no auth RPC is added. */
  voiceAudio?: import("../voice/v3.ts").VoiceV3Deps["audio"];
  onOpenAI?: (auth: import('../openai-auth/service.ts').AuthService) => void;
  onVoice?: (voice: import("../voice/runtime.ts").VoiceRuntime & Partial<Pick<VoiceRuntime, "openTalk" | "metrics" | "renderMetrics" | "v3">>) => void;
  definitions?: Readonly<Record<string, ProviderDefinition>>;
  fetch?: typeof fetch;
  providers?: Pick<TurnProviderOptions, 'profiles' | 'family' | 'router' | 'onPrompt' | 'maxTokens' | 'topK' | 'maxRounds' | 'billing'>;
  /** Test seam: replaces the turn provider factory (e.g. to prove partial initialisation closes what it opened). */
  createTurnProvider?: typeof createTurnProvider;
  tools?: Partial<Pick<ToolCompositionOptions, 'roots' | 'deny' | 'exec' | 'host' | 'extra' | 'mcp' | 'media' | 'documents'>>;
}
export interface CompositionDeps {
  resolveCollaborationPerson?: (id: string) => import("../rbac/types.ts").Principal | null;
  voiceConfigSource?: import("../voice/v3.ts").VoiceV3Deps["set"];
  resolvePrincipal?: import("../rbac/guard.ts").PrincipalResolver;
  home: string; config: () => HarnessConfig; engine: Engine; agents: AgentRegistry; logger: HarnessLogger;
  /** Already admitted turns retain memory access if the agent is paused while their reply is running. */
  memoryAgents?: AgentRegistry;
  secrets: SecretStore; egress: Egress; permissions: PermissionRuntime; audit: AuditSink; identity: IdentityService;
  clock: () => number; signal: AbortSignal; isStopping: () => boolean;
  notify: (method: string, params: object, opts: import("../rpc/server.ts").NotifyOptions) => void;
  approver?: import("../session/methods.ts").SessionMethodDeps["approver"];
  onStoredCapture?: (agentId: string) => void;
  provider?: ChatProvider; options?: CompositionOptions; prices?: PriceBook;
  /** Inbox notices for media-index events; absent: the events only reach the log. */
  inbox?: import('../inbox/service.ts').InboxPort;
  /** web.search over the SearXNG sidecar (`sidecars/web-search.ts`); absent, no search tool is registered. */
  webSearch?: import('../tools/web/search.ts').WebSearch;
}
export interface TurnComposition { /** Provider definitions refused at composition (`E_CONFIG_INVALID`); they serve no turn. Empty when all were composed. */ refusedProviders: readonly RefusedProvider[]; discoveryCredentials: (definition: ProviderDefinition) => import("../auth/credentials.ts").CredentialsProvider | undefined; voice: VoiceRuntime; openai: OpenAIRuntime; sessions: SessionService; collab: Collab | null; surfaceMethods: Record<string, Handler>; close(): Promise<void> }
/**
 * D109: the approval service's repeat-denied / prompt-cap context for one dispatched call. The permission stores are opened by
 * `beforeTools` before any dispatch; if they are not, this throws and the dispatcher refuses the call (fail closed).
 */
export function approvalPolicyContext(permissions: Pick<PermissionRuntime, 'current'>): NonNullable<TurnProviderOptions['policyContext']> {
  return ctx => {
    const opened = permissions.current();
    if (!opened) throw new Error('approval service unavailable');
    return opened.service.policyContext()(ctx);
  };
}
/** Router events and billing refusals go to the core log and the audit log, tagged with their turn. */
export function routerEventSink(d: Pick<CompositionDeps, 'logger' | 'audit' | 'clock'>): NonNullable<TurnProviderOptions['onRouterEvent']> {
  return (event, turn) => {
    const { type, ...detail } = event;
    const fields = { ...detail, ...turn };
    if (type === 'provider.breaker' || type === 'provider.retry') d.logger.info(type, fields); else d.logger.warn(type, fields);
    try { d.audit.append({ at: d.clock(), actor: { user: 'core', host: 'core' }, action: type, target: 'target' in event ? `${event.target.provider}/${event.target.model}` : `${event.to.provider}/${event.to.model}`, detail: fields }); }
    catch (e) { d.logger.warn('router event audit failed', { err: e, type }); }
  };
}
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
  const memory = engineTurnMemory({ engine: d.engine, config: d.config, agents: d.memoryAgents ?? d.agents, logger: d.logger, captureSignal: d.signal, isStopping: d.isStopping, ...(d.onStoredCapture ? { onStoredCapture: d.onStoredCapture } : {}), identity: d.identity, scope });
  const cfg = d.config();
  const budget = isolated('turn budget', () => createCallBudget({ path: join(d.home, 'state', 'budget.sqlite'), clock: { now: d.clock }, prices: d.prices ?? new PriceBook(SHIPPED_PRICE_TABLES), emitter: { emit(event) {
    if (event.type === 'refuse') d.audit.append({ at: d.clock(), actor: { user: 'core', host: 'core' }, action: 'budget.refused', target: event.refusal.id || 'global', detail: { ...event.refusal } });
    else if (event.type === 'expire') d.logger.warn('budget.reservation_expired', { ...event });
  } } }));
  if (budget) disposers.push(() => budget.close());
  // Everything after the first disposer runs under this try: a partial initialisation closes what it already opened.
  try {
    const definitions = options.definitions ?? Object.fromEntries(Object.entries(cfg.providers).filter(([, value]) => !!value && typeof value === 'object' && 'wireFormat' in value)) as Record<string, ProviderDefinition>;
    const openai = createOpenAIRuntime(d); disposers.push(() => openai.close());
    let sessions: SessionService;
    const voice = composeVoice(d, openai, budget, () => sessions); disposers.push(() => voice.close());
    // Secret values this composition leased (provider credentials, media keys), newest kept; a failed tool's
    // TurnToolError.detail is redacted against them before anyone stores or sends it.
    const registered = new Set<string>();
    const registerSecret = (value: string) => { registered.delete(value); registered.add(value); if (registered.size > 256) registered.delete(registered.values().next().value!); };
    disposers.push(() => registered.clear());
    const auth = isolated('turn providers', () => composeAuth({ config: cfg, definitions, openai, secrets: d.secrets, egress: d.egress, registerSecret, log: record => d.logger.info('turn.stage', { ...record }), ...(options.fetch ? { fetch: options.fetch } : {}) }));
    if (auth) disposers.push(() => auth.close());
    for (const r of auth?.refused ?? []) d.logger.error('turn provider refused', { code: r.code, provider: r.provider, reason: r.reason });
    const hostctl = createHostctlPool({ config: cfg.tools?.hostctl, audit: event => d.audit.append({ at: d.clock(), actor: { user: event.principal, host: 'local' }, action: event.operation, target: event.paths.join(';'), detail: { ...event } }) });
    disposers.push(() => hostctl.close());
    const audit = createPolicyAudit({ sink: d.audit, clock: { now: d.clock } });
    const execOutput = createWriter({ dir: join(d.home, 'logs'), role: 'core.out', source: { kind: 'harness', id: 'exec', version: '0.1.0' }, now: d.clock });
    disposers.push(() => execOutput.close());
    const grants: GrantSource = { maxGrantDays: () => d.config().approvals?.maxGrantDays ?? 90, list: q => d.permissions.current()?.grants.list(q) ?? [], get: id => d.permissions.current()?.grants.get(id) };
    const mcp = isolated('turn MCP', () => createMcpRegistry({ logger: d.logger, secrets: d.secrets, egress: d.egress, policy: { allowedCommands: ((cfg.providers.mcp as { allowedCommands?: string[] } | undefined)?.allowedCommands ?? []) } }));
    const servers: string[] = [];
    if (mcp) {
      disposers.push(() => mcp.shutdown());
      const definitions = (cfg.providers.mcp as { servers?: unknown[] } | undefined)?.servers ?? [];
      for (const raw of definitions) { const registered = isolated('MCP server', () => mcp.register(raw)); if (registered) servers.push(registered.name); }
    }
    const mediaConfig = cfg.providers.media as { adapters?: MediaDefinition[] } | undefined;
    let media = options.tools?.media ?? null;
    // privacy.localOnly for media generation: per agent inside a turn, installation-wide for a direct RPC call.
    const mediaPrivacy = { localOnly: (agentId?: string) => localOnlyFor(d.config(), agentId), localEndpoints: () => localEndpoints(d.config()) };
    const mediaLocal = new Map<string, () => boolean>();
    if (!media) try { const composed = await composeMedia(d.home, mediaConfig?.adapters ?? [], d.secrets, d.egress, registerSecret, mediaPrivacy); if (composed) mediaLocal.set(composed.adapter.id, composed.local); media = composed; }
    catch (e) { d.logger.error('turn media unavailable', { err: e }); }
    const adapters = media ? [media.adapter] : [];
    for (const definition of (mediaConfig?.adapters ?? []).slice(1)) {
      try {
        const configured = await composeMedia(d.home, [definition], d.secrets, d.egress, registerSecret, mediaPrivacy);
        if (configured) { adapters.push(configured.adapter); mediaLocal.set(configured.adapter.id, configured.local); }
      } catch (error) { d.logger.error('media adapter unavailable', { err: error }); }
    }
    const mediaSurface = createMediaSurface({ home: d.home, adapters, store: media?.store ?? new (await import('../../../media/src/index.ts')).OutputStore(join(d.home,'media','outputs')), budget, signal: d.signal,
      notify: (method, params, opts) => d.notify(method,params,opts),
      async policy(operation, request, agentId, principal, ctx, adapterId) {
        if (!d.agents.has(agentId)) throw new RpcError('E_AGENT_UNKNOWN','unknown media agent');
        // An adapter composed elsewhere (a test seam) has no locality record and counts as cloud.
        if (localOnlyFor(d.config(), agentId) && !(adapterId !== undefined && mediaLocal.get(adapterId)?.() === true)) throw new RpcError('E_DENIED', `media adapter ${adapterId ?? 'unknown'} is not a local model; ${LOCAL_ONLY_HINT}`, { reason: LOCAL_ONLY_REASON });
        await d.permissions.open();
        const decision = decide({ capability: `media.${operation}`, tool: `media.${operation}`, flags: { outsideRoots: false, denyListHit: false }, actionHash: mediaActionHash(operation,request,agentId) },
          { principal: { person: principal.userId }, subject: { kind: 'agent', agentId }, surface: connectionSurface({ principal, now: d.clock() }) }, { grants, clock: { now: d.clock } });
        d.audit.append({ at: d.clock(), actor: { user: principal.userId, host: 'rpc' }, action: `media.${operation}.${decision.kind}`, target: agentId, detail: { capability: `media.${operation}` } });
        if (decision.kind !== 'allow') throw new RpcError(decision.kind === 'ask' ? 'E_APPROVAL_REQUIRED' : 'E_DENIED','media policy refused',{ reason: decision.kind === 'deny' ? decision.reason : 'approval-required' });
      }
    });
    await mediaSurface.recover();
    disposers.push(() => mediaSurface.close());
    // The media index is shared like the engine: its cloud tiers (media embedding, captioning) are pinned off while the
    // installation or any agent is local-only (the existing privacy-pin refusal, E_MEDIA_PRIVACY reason privacy-pin).
    const mediaSearch = await composeMediaSearch({ home: d.home, config: d.config, engine: d.engine, agents: d.agents, logger: d.logger, store: media?.store ?? null, budget, privacyPinned: () => localOnlyShared(d.config()), ...(d.inbox ? { emit: (name, payload) => { d.logger.info(name, payload); mediaToInbox(d.inbox!, name, payload); } } : {}) }); disposers.push(() => mediaSearch.close());
    const profiles = options.providers?.profiles ?? (d.provider ? { default: [{ provider: 'fixture', model: 'gpt-4.1', adapter: legacyAdapter(d.provider) }] } : auth?.profiles ?? {});
    // privacy.localOnly: a chat/role provider is local when its endpoint is loopback or listed in privacy.localEndpoints.
    // No base_url means the vendor's cloud default; a managed OpenAI login is always cloud. The in-process test provider
    // (`fixture`, only with PLUR1BUS_TEST_CHAT_PROVIDER) sends nothing anywhere.
    const isLocalProvider = (id: string): boolean => {
      if (id === 'fixture' && d.provider) return true;
      const def = definitions[id];
      if (!def || openai.handles(def)) return false;
      const base = def.profile?.base_url;
      return typeof base === 'string' && isLocalEndpoint(base, localEndpoints(d.config()));
    };
    const classProfiles = cfg.decision.classProfiles as Record<string, string> | undefined;
    // Reserved `providers` namespace: `providers.modelProfilePolicy.<profile>.allowCrossBilling: true` opts one profile into
    // plan<->paid fallback; absent, a fallback across billing classes is refused.
    const profilePolicy = (cfg.providers as { modelProfilePolicy?: Record<string, { allowCrossBilling?: unknown }> }).modelProfilePolicy ?? {};
    let collab: Collab | null = null;
    const toolsForTurn = (req: ChatRequest) => composeTools({ home: d.home, roots: options.tools?.roots ?? [{ id: req.agentId, path: d.agents.workspaceOf(req.agentId) ?? join(d.home, 'agents', req.agentId, 'workspace') }], grants, audit: d.audit, hostctl, output: execOutput, ...(collab ? { collaboration: {
      collab, enabled: () => d.config().collaboration.fanoutEnabled,
      repair: async (input: unknown, issues: readonly string[]) => {
        if (!provider) throw new Error('no-provider');
        let text = '';
        for await (const chunk of provider.stream({ ...req, role: 'summarize', toolView: [], summaries: [], memory: '', peerResults: [{ id: randomUUID(), name: 'handoff_repair', text: JSON.stringify({ kind: 'tool_result', trust: 'untrusted', input, issues }) }], messages: [{ role: 'user', text: 'Repair the supplied handoff JSON once to match the reported schema/size issues. Preserve authority bindings. Return only JSON.' }] })) if (chunk.type === 'delta') text += chunk.text;
        return JSON.parse(text);
      },
      principal: (request: ChatRequest) => { const id = request.approver?.person ?? request.authenticatedPerson; return id ? d.resolveCollaborationPerson?.(id) ?? null : null; },
      authority: { approvals: { get: (id: string) => d.permissions.current()?.stores.approvals.get(id) }, grants: { get: (id: string) => d.permissions.current()?.grants.get(id) }, now: d.clock, audit: (event: { reason: string; person: string; taskId: string }) => { d.audit.append({ at: d.clock(), actor: { user: event.person, host: 'core' }, action: 'collab.handoff.refused', target: event.taskId, detail: { reason: event.reason } }); } }
    } } : {}), ...(d.webSearch ? { webSearch: d.webSearch } : {}), ...(budget ? { budget } : {}), degraded: (service, error) => d.logger.warn('turn tool service degraded', { service, err: error }), ...options.tools, ...(media ? { media: { adapter: media.adapter, store: mediaSurface.storeFor(req.agentId, principal(req)) } } : {}), ...(options.tools?.mcp ? {} : mcp ? { mcp: { port: mcp, servers } } : {}) }, { ...req, principal: principal(req) });
    // M2: isolated additive Session wiring; the existing turn/tool composition below is unchanged.
    const create = sessionRoleFactory(options.createTurnProvider ?? createTurnProvider, cfg);
    const maintenance = sessionMaintenance(d.home, cfg);
    const provider = budget && Object.keys(profiles).length ? create({ ...options.providers, profiles, profile: auth?.resolved.defaultProfile ?? 'default', profileForClass: modelClass => classProfiles?.[modelClass], router: { profileDefaults: auth?.resolved.defaults ?? {}, unsupportedProfiles: auth?.resolved.unsupported ?? {}, ...options.providers?.router }, family: options.providers?.family ?? auth?.families ?? {}, billing: options.providers?.billing ?? auth?.billing ?? {}, allowCrossBilling: name => profilePolicy[name]?.allowCrossBilling === true, localOnly: agentId => localOnlyFor(d.config(), agentId), isLocalProvider, secrets: () => registered, onRouterEvent: routerEventSink(d), policyContext: approvalPolicyContext(d.permissions), registry: new ToolRegistry(), budget, principal, toolsForTurn, snapshot: (req, memory) => req.projectId ? memory : sessions.forSession(req.sessionId).store.freezePromptSnapshot(req.sessionId, memory), onUsage: record => d.logger.info('provider.cache_usage', { ...record }), onPrompt: prompt => { options.providers?.onPrompt?.(prompt); for (const event of prompt.events) d.logger.info(event.type, { ...event }); }, beforeTools: async () => { await d.permissions.open(); }, grants, grantUse: { markUsed: id => d.permissions.current()!.grants.markUsed(id), consumeOnce: (id, binding) => d.permissions.current()!.grants.consumeOnce(id, binding) }, approval: { request: async ask => (await d.permissions.open()).service.request(ask), begin: (answer, ask) => d.permissions.current()?.service.begin(answer, ask) ?? false }, audit, log: record => d.logger.info('turn.stage', { ...record }), resultStore: { async put(value) {
      const dir = join(d.home, 'state', 'tool-results'); await mkdir(dir, { recursive: true, mode: 0o700 });
      const id = randomUUID(); await writeFile(join(dir, `${id}.json`), JSON.stringify(value), { flag: 'wx', mode: 0o600 }); return `tool-result:${id}`;
    } } }) : null;
    voice.setDelegate(provider);
    collab = budget ? isolated('collaboration', () => createCollab({ path: join(d.home, 'state', 'collab.sqlite'), clock: d.clock, sessions: () => sessions.store,
      runner: provider ? composedAgentRunner(provider, alsAgentScopePort(), d.home, options.delegationTargets) : { async run() { throw new Error('no-provider'); } }, directory: { get: id => d.agents.has(id) || options.delegationTargets?.some(t => t.accepts(id)) ? { id, state: 'active' } : null },
      emit: { emit: event => d.logger.info(event.type, { projectId: event.projectId, traceId: event.traceId }) },
      logWarn: (msg, fields) => d.logger.warn(msg, fields),
      grants: { endTask: (taskId, by) => {
        const cur = d.permissions.current();
        if (cur) return cur.grants.endTask(taskId, by);
        void d.permissions.open().then(p => p.grants.endTask(taskId, by)).catch(err => d.logger.warn('grant task end failed', { err }));
        return 0;
      } },
      budget: { check(estimate) {
        const candidate = Object.values(profiles)[0]?.[0]; if (!candidate) return { allowed: false, reason: 'token-budget' };
        const admission = budget.checkBeforeCall({ principal: 'collab-admission', agent: estimate.agentId, project: estimate.projectId, turn: estimate.chainId, model: candidate.model, provider: candidate.provider, estimatedInputTokens: estimate.tokens, maxOutputTokens: 2000 });
        if (admission.kind === 'refuse') return { allowed: false, reason: admission.metric === 'cost' ? 'cost-budget' : 'token-budget' };
        budget.releaseUnused(admission.reservationId); return { allowed: true };
      }, record: usage => d.logger.info('collab.usage', { ...usage }) },
    })) : null;
    if (collab) disposers.push(() => collab.shutdown());
    sessions = openSessionService({ ...maintenance, dbPath: join(d.home, 'state', 'sessions.sqlite'), clock: d.clock, logger: d.logger, agents: d.agents, isStopping: d.isStopping, memory, provider: () => provider, notify: d.notify, signal: d.signal, onSessionEnd: id => {
      void hostctl.endSession(id).catch(err => d.logger.warn('hostctl session cleanup failed', { err }));
      const cur = d.permissions.current();
      if (cur) {
        try { cur.grants.endSession(id); } catch (err) { d.logger.warn('grant session end failed', { err }); }
        return;
      }
      void d.permissions.open().then(p => p.grants.endSession(id)).catch(err => d.logger.warn('grant session end failed', { err }));
    }, ...(d.approver ? { approver: d.approver } : {}) });
    let closed = false;
    const opened = sessions;
    return { refusedProviders: auth?.refused ?? [], discoveryCredentials: definition => auth?.credentialsForDiscovery(definition), voice, openai, sessions: opened, collab, surfaceMethods: { ...mediaSurface.methods, ...mediaSearchMethods({ home: d.home, config: d.config, agents: d.agents }, mediaSearch) }, async close() {
      if (closed) return; closed = true;
      await collab?.shutdown();
      await opened.close();
      for (const close of disposers.reverse()) try { await close(); } catch (e) { d.logger.warn('turn service shutdown failed', { err: e }); }
    } };
  } catch (e) {
    for (const close of disposers.reverse()) try { await close(); } catch (err) { d.logger.warn('turn service shutdown failed', { err }); }
    throw e;
  }
}
