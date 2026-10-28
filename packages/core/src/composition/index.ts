import { restoreSessionSkills } from './session-skills.ts';
import { ruleSkills, selectDecisionSkills } from '../decision/skills.ts';
import { SessionModelRouting } from './model-routing.ts';
import { DecisionClient } from '../decision/client.ts';
import { createSystemOneBackend } from '../decision/system-one.ts';
import { decisionPruningPort } from '../decision/pruning.ts';
import { DEFAULT_PRUNE_CONFIDENCE } from '../session/pruning.ts';
import { toWireEvent } from '../session/methods.ts';
import { SkillMining } from '../skill-mining/miner.ts';
import { SkillReview, UnavailableSkillProposals } from '../skill-mining/review.ts';
import { WorkflowEvidence } from '../skill-mining/evidence.ts';
import { toolEntry } from '../toolcall/live-index.ts';
import { testModel } from './model-test.ts';
import { authenticatedPrincipal } from '../rbac/guard.ts';
import { loadClassProfiles } from '../triage/classes.ts';
import { ExtensionCapabilityFeed } from '../toolcall/extension-feed.ts';
import { LiveCapabilityIndex } from '../toolcall/live-index.ts';
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
import { createCallBudget, type CallBudget } from '../budget/index.ts';
import { createPolicyAudit } from '../policy/audit.ts';
import type { GrantSource } from '../policy/index.ts';
import { createMcpRegistry } from '../mcp/index.ts';
import { composeMedia, type MediaDefinition } from './media.ts';
import { composeAuth, type ProviderDefinition, type RefusedProvider } from './auth.ts';
import { composeTools, type ToolCompositionOptions } from './tools.ts';
import { agentSecretRefs } from '../agents/secrets.ts';
import type { SecretNamesPort } from '../tools/secret-names.ts';
import { createWriter } from '../logs/writer.ts';
import { createTurnProvider, type TurnProviderOptions } from './provider.ts';
import { NO_REASONING, type ReasoningDescriptor } from '../../../providers/src/reasoning.ts';
import { fitToWire } from '../discovery/reasoning.ts';
import type { ChatModelSources } from '../session/chat-models.ts';
import { ToolRegistry } from '../tools/registry.ts';
import { createCollab, alsAgentScopePort, type Collab } from '../collab/index.ts';
import { liveLogsRedactionPort } from '../collab/ports.ts';
import { ChatPromotion, promotionMethods } from '../collab/chat-promotion.ts';
import { CodingGate } from '../collab/coding-gate.ts';
import { sandboxVerifier } from '../collab/verifier.ts';
import { codingMethods, reviewHooks, type CodingCompletion } from '../collab/coding-surface.ts';
import { composedAgentRunner } from './collaboration.ts';
import { legacyAdapter } from './legacy.ts';
import { composeMediaSearch, mediaSearchMethods } from './media-search.ts';
import { mediaToInbox } from '../inbox/producers.ts';
import { isLocalEndpoint, localEndpoints, localOnlyFor, localOnlyShared, LOCAL_ONLY_REASON, LOCAL_ONLY_HINT } from '../privacy/local-only.ts';

export interface CompositionOptions {
  /** Internal loopback-only System One test endpoint; never a configuration or RPC field. */
  decisionTestOrigin?: string;
  projectWorktrees?: import("../collab/coding-surface.ts").ProjectWorktreePort;
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
  mediaHostFetchReady?: boolean;
  supervised?: boolean;
  systemJobs?: import('../system-jobs/index.ts').SystemJobs;
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
  /** Final session-turn observations for the core's metrics aggregate. */
  onTurnTelemetry?: (telemetry: import("../session/turn-telemetry.ts").TurnTelemetry) => void;
  provider?: ChatProvider; options?: CompositionOptions;
  /** Inbox notices for media-index events; absent: the events only reach the log. */
  inbox?: import('../inbox/service.ts').InboxPort;
  /** web.search over the SearXNG sidecar (`sidecars/web-search.ts`); absent, no search tool is registered. */
  webSearch?: import('../tools/web/search.ts').WebSearch;
  /** Per-chat model choice (D112 catalog): reasoning per model before the wire fit, catalog facts and provider endpoints. */
  chatModels?: Pick<ChatModelSources, 'catalog' | 'endpoint'> & { reasoning(provider: string, model: string): ReasoningDescriptor };
}
export interface TurnComposition { /** The turn call budget (L8), shared with the re-embedding run; null when its store could not be opened. */ budget: CallBudget | null; skillReview: SkillReview; mining: SkillMining; capabilities: LiveCapabilityIndex; /** Provider definitions refused at composition (`E_CONFIG_INVALID`); they serve no turn. Empty when all were composed. */ refusedProviders: readonly RefusedProvider[]; discoveryCredentials: (definition: ProviderDefinition) => import("../auth/credentials.ts").CredentialsProvider | undefined; voice: VoiceRuntime; openai: OpenAIRuntime; sessions: SessionService; collab: Collab | null; surfaceMethods: Record<string, Handler>; chatModels: ChatModelSources; close(): Promise<void> }
/** secret_names backend: the agent's configured secret references, with presence from the store's metadata (never a value). */
export function secretNamesPort(d: Pick<CompositionDeps, 'config' | 'secrets'>): SecretNamesPort {
  return {
    async namesFor(agentId) {
      const cfg = d.config(), agent = Object.hasOwn(cfg.agents, agentId) ? cfg.agents[agentId] : undefined;
      if (!agent) return [];
      const refs = agentSecretRefs(cfg, agent);
      let held: Map<string, string | undefined> | undefined;
      try { const status = await d.secrets.status({ kind: 'core' }); if (status.secrets) held = new Map(status.secrets.map(s => [s.name, s.description])); } catch { /* presence stays unknown; the names are still true */ }
      return refs.map(r => { const description = held?.get(r.name); return { name: r.name, scope: r.scope, ...(held ? { present: held.has(r.name) } : {}), ...(description ? { description } : {}) }; });
    },
  };
}
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
  const budget = isolated('turn budget', () => createCallBudget({ path: join(d.home, 'state', 'budget.sqlite'), clock: { now: d.clock }, emitter: { emit(event) {
    if (event.type === 'refuse') d.audit.append({ at: d.clock(), actor: { user: 'core', host: 'core' }, action: 'budget.refused', target: event.refusal.id || 'global', detail: { ...event.refusal } });
    else if (event.type === 'expire') d.logger.warn('budget.reservation_expired', { ...event });
  } } }));
  if (budget) disposers.push(() => budget.close());
  // Everything after the first disposer runs under this try: a partial initialisation closes what it already opened.
  try {
    const capabilities = new LiveCapabilityIndex(d.home, d.clock, d.engine);
    if (d.supervised) { const feed = new ExtensionCapabilityFeed(d.home); capabilities.extensionFeed = feed; feed.onChanged = () => { void capabilities.syncExtensions().catch(() => {}); }; disposers.push(() => feed.close()); }
    disposers.push(() => capabilities.close());
    const workflowEvidence = new WorkflowEvidence(join(d.home, 'state', 'skill-mining.sqlite')); disposers.push(() => workflowEvidence.close());
    capabilities.recheck(); capabilities.watchSkills();
    if (d.systemJobs) {
      const job = capabilities.job(); d.systemJobs.register(job);
      const timer = setInterval(() => { if (!d.signal.aborted && (job.nextRunAt() ?? Infinity) <= d.clock()) void d.systemJobs!.run(job.spec.name, {}, { trigger: 'cron', signal: d.signal }).catch(err => d.logger.warn('capability recheck failed', { err })); }, 60_000);
      timer.unref(); disposers.push(() => clearInterval(timer));
    }
    const definitions = options.definitions ?? Object.fromEntries(Object.entries(cfg.providers).filter(([, value]) => !!value && typeof value === 'object' && 'wireFormat' in value)) as Record<string, ProviderDefinition>;
    const openai = createOpenAIRuntime(d); disposers.push(() => openai.close());
    let sessions: SessionService;
    const voice = composeVoice(d, openai, budget, () => sessions); disposers.push(() => voice.close());
    // Secret values this composition leased (provider credentials, media keys), newest kept; a failed tool's
    // TurnToolError.detail is redacted against them before anyone stores or sends it.
    const registered = new Set<string>();
    const registerSecret = (value: string) => { d.secrets.redaction?.register(value); registered.delete(value); registered.add(value); if (registered.size > 256) registered.delete(registered.values().next().value!); };
    disposers.push(() => registered.clear());
    const auth = isolated('turn providers', () => composeAuth({ config: cfg, definitions, openai, secrets: d.secrets, egress: d.egress, registerSecret, log: record => d.logger.info('turn.stage', { ...record }), ...(options.fetch ? { fetch: options.fetch } : {}) }));
    if (auth) disposers.push(() => auth.close());
    for (const r of auth?.refused ?? []) d.logger.error('turn provider refused', { code: r.code, provider: r.provider, reason: r.reason });
    const hostctl = createHostctlPool({ config: cfg.tools?.hostctl, audit: event => d.audit.append({ at: d.clock(), actor: { user: event.principal, host: 'local' }, action: event.operation, target: event.paths.join(';'), detail: { ...event } }) });
    disposers.push(() => hostctl.close());
    const audit = createPolicyAudit({ sink: d.audit, clock: { now: d.clock }, ...(d.secrets.redaction ? { redactor: d.secrets.redaction.redactor() } : {}) });
    const execOutput = createWriter({ dir: join(d.home, 'logs'), role: 'core.out', source: { kind: 'harness', id: 'exec', version: '0.1.0' }, now: d.clock });
    disposers.push(d.secrets.redaction?.subscribe((value, info) => execOutput.registerSecret(value, info)) ?? (() => {}), () => execOutput.close());
    const grants: GrantSource = { maxGrantDays: () => d.config().approvals?.maxGrantDays ?? 90, list: q => d.permissions.current()?.grants.list(q) ?? [], get: id => d.permissions.current()?.grants.get(id) };
    // MCP-stdio stderr is child output like exec's: the same envelope (process.output.line, untrusted, redacted, line-capped), attributed to the harness's MCP client.
    // Registered before the registry so shutdown (reverse order) stops the servers, and flushes their last lines, before this writer closes.
    const mcpOutput = createWriter({ dir: join(d.home, 'logs'), role: 'core.out', source: { kind: 'harness', id: 'mcp', version: '0.1.0' }, now: d.clock });
    disposers.push(d.secrets.redaction?.subscribe(value => mcpOutput.registerSecret(value)) ?? (() => {}), () => mcpOutput.close());
    const mcp = isolated('turn MCP', () => createMcpRegistry({ logger: d.logger, output: mcpOutput, secrets: d.secrets, egress: d.egress, policy: { allowedCommands: ((cfg.providers.mcp as { allowedCommands?: string[] } | undefined)?.allowedCommands ?? []) } }));
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
    const mediaSearch = await composeMediaSearch({ home: d.home, config: d.config, engine: d.engine, hostFetchReady: d.mediaHostFetchReady === true, agents: d.agents, logger: d.logger, store: media?.store ?? null, budget, privacyPinned: () => localOnlyShared(d.config()), ...(d.inbox ? { emit: (name, payload) => { d.logger.info(name, payload); mediaToInbox(d.inbox!, name, payload); } } : {}) }); disposers.push(() => mediaSearch.close());
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
    let coding: CodingCompletion | undefined;
    const toolsForTurn = (req: ChatRequest) => composeTools({ sandbox: { required: cfg.tools.sandbox.required, maxTasks: d.config().tools.sandbox.maxTasks }, home: d.home, roots: options.tools?.roots ?? [{ id: req.agentId, path: d.agents.workspaceOf(req.agentId) ?? join(d.home, 'agents', req.agentId, 'workspace') }], grants, audit: d.audit, hostctl, output: execOutput, ...(coding ? { coding } : {}), ...(collab ? { collaboration: {
      ...(coding ? { review: reviewHooks(coding) } : {}),
      collab, enabled: () => d.config().collaboration.fanoutEnabled,
      repair: async (input: unknown, issues: readonly string[]) => {
        if (!provider) throw new Error('no-provider');
        let text = '';
        for await (const chunk of provider.stream({ ...req, role: 'summarize', toolView: [], summaries: [], memory: '', peerResults: [{ id: randomUUID(), name: 'handoff_repair', text: JSON.stringify({ kind: 'tool_result', trust: 'untrusted', input, issues }) }], messages: [{ role: 'user', text: 'Repair the supplied handoff JSON once to match the reported schema/size issues. Preserve authority bindings. Return only JSON.' }] })) if (chunk.type === 'delta') text += chunk.text;
        return JSON.parse(text);
      },
      principal: (request: ChatRequest) => { const id = request.approver?.person ?? request.authenticatedPerson; return id ? d.resolveCollaborationPerson?.(id) ?? null : null; },
      authority: { approvals: { get: (id: string) => d.permissions.current()?.stores.approvals.get(id) }, grants: { get: (id: string) => d.permissions.current()?.grants.get(id) }, now: d.clock, audit: (event: { reason: string; person: string; taskId: string }) => { d.audit.append({ at: d.clock(), actor: { user: event.person, host: 'core' }, action: 'collab.handoff.refused', target: event.taskId, detail: { reason: event.reason } }); } }
    } } : {}), ...(d.webSearch ? { webSearch: d.webSearch } : {}), secretNames: secretNamesPort(d), ...(budget ? { budget } : {}), degraded: (service, error) => d.logger.warn('turn tool service degraded', { service, err: error }), ...options.tools, ...(media ? { media: { adapter: media.adapter, store: mediaSurface.storeFor(req.agentId, principal(req)) } } : {}), ...(options.tools?.mcp ? {} : mcp ? { mcp: { port: mcp, servers } } : {}) }, { ...req, principal: principal(req) });
    // M2: isolated additive Session wiring; the existing turn/tool composition below is unchanged.
    const families = options.providers?.family ?? auth?.families ?? {};
    const reasoningFor = (provider: string, model: string): ReasoningDescriptor => fitToWire(d.chatModels?.reasoning(provider, model) ?? NO_REASONING, families[provider] ?? 'openai-chat');
    const chatModels: ChatModelSources = {
      profiles: () => Object.fromEntries(Object.entries(profiles).map(([name, candidates]) => [name, candidates.map(c => ({ provider: c.provider, model: c.model }))])),
      defaultProfile: () => auth?.resolved.defaultProfile ?? (profiles.default ? 'default' : undefined),
      reasoning: reasoningFor, config: () => d.config(),
      ...(d.chatModels?.catalog ? { catalog: d.chatModels.catalog } : {}), ...(d.chatModels?.endpoint ? { endpoint: d.chatModels.endpoint } : {}),
    };
    const decisionOptions = { config: d.config, egress: d.egress, secrets: d.secrets, budget,
      ...(options.decisionTestOrigin ? { testOrigin: options.decisionTestOrigin } : {}) };
    const decisionBackends = { jev: createSystemOneBackend('jev', decisionOptions), kev: createSystemOneBackend('kev', decisionOptions) };
    let decisions = new DecisionClient({ config: d.config, backends: decisionBackends });
    const create = sessionRoleFactory(options.createTurnProvider ?? createTurnProvider, d.config, {
      backends: decisionBackends,
      onClient: client => { decisions = client; },
      emit: (context, event) => {
        // Raw state and model prose never enter telemetry. Incognito uses the volatile store.
        d.logger.info('decision.completed', { ...event });
        if (!context.sessionId || !context.turnId) return;
        const service = sessions.forSession(context.sessionId);
        const session = service.store.getSession(context.sessionId);
        if (!session || session.agentId !== context.agentId || session.owner !== context.principal) return;
        const stored = service.store.appendEvent(context.turnId, 'decision.completed', { ...event });
        d.notify('session.event', { agentId: session.agentId, event: toWireEvent(stored) }, { optIn: true });
      },
    });
    const maintenance = sessionMaintenance(d.home, cfg);
    // D105: a configured decision role is required for every foreground message (failure/timeout = default profile, core set only);
    // without modelRoles.decision the rule triage selects the shortlist as before.
    const modelRouting = new SessionModelRouting({ decision: () => decisions, agent: id => d.config().agents[id], localOnly: agentId => localOnlyFor(d.config(), agentId), isLocal: isLocalProvider,
      restore: request => {
        const store = sessions.forSession(request.sessionId).store, session = store.getSession(request.sessionId);
        if (!session || session.archivedAt !== null || session.agentId !== request.agentId || session.owner !== request.principal) return undefined;
        // Walk metadata pages backwards; a large streamed reply must not hide its earlier selection event.
        for (let after = Math.max(0, (store.lastEventSeq(session.id) ?? 0) - 2000);; after = Math.max(0, after - 2000)) {
          const events = store.listEvents(session.id, after, 2000);
          for (const event of events.reverse()) {
            if (event.type !== 'model.selected' || event.data.source !== 'auto' || !event.turnId || store.getTurn(event.turnId)?.state !== 'completed') continue;
            const { profile, provider, model } = event.data;
            if (typeof profile === 'string' && typeof provider === 'string' && typeof model === 'string') return { profile, provider, model };
          }
          if (after === 0) return undefined;
        }
      },
    });
    const provider = budget && Object.keys(profiles).length ? create({ ...options.providers, modelRouting,
      restoreSkills: request => restoreSessionSkills(sessions.forSession(request.sessionId).store, request),
      skillCatalogueSnapshot: (request, catalogue) => {
        const store = sessions.forSession(request.sessionId).store;
        const session = store.getSession(request.sessionId);
        if (!session || session.agentId !== request.agentId || session.owner !== request.principal) return catalogue;
        return store.freezeSkillCatalogue(request.sessionId, catalogue);
      }, onModelRouting: (event, turn) => {
      const service = sessions.forSession(turn.sessionId), session = service.store.getSession(turn.sessionId);
      if (!session || session.agentId !== turn.agentId || session.owner !== turn.principal || service.store.getTurn(turn.turnId)?.sessionId !== session.id) return;
      const stored = service.store.appendEvent(turn.turnId, 'model.selected', { ...event });
      d.notify('session.event', { agentId: session.agentId, event: toWireEvent(stored) }, { optIn: true });
    }, onExecution: execution => { try { workflowEvidence.record(execution); } catch { d.logger.warn('mining execution evidence unavailable'); } }, selectSkills: async (request,candidates,signal) => {
      const selection = d.config().agents[request.agentId]?.skills ?? {};
      const work = async (signal:AbortSignal) => selectDecisionSkills(decisions,{query:request.messages.filter(m=>m.role==='user').at(-1)?.text ?? '',candidates,...selection,maxMs:Math.min(Number(d.config().decision.timeoutMs ?? 200),Number((d.config().decision.budgets as Record<string,number>|undefined)?.skills ?? 100))},{agentId:request.agentId,sessionId:request.sessionId,...(request.turnId?{turnId:request.turnId}:{}),...(request.principal?{principal:request.principal}:{}),signal,chat:request});
      const selected=request.turnProfile ? await request.turnProfile.run('decisionService',work,ruleSkills({query:'',candidates,...selection}),signal) : await work(signal);
      if(request.turnId){const store=sessions.forSession(request.sessionId).store;const session=store.getSession(request.sessionId);if(session?.agentId===request.agentId&&session.owner===request.principal){const event=store.appendEvent(request.turnId,'skills.selected',{skills:selected.map(s=>({id:s.id,source:s.source,...('confidence' in s && s.confidence!==undefined?{confidence:s.confidence}:{})}))});d.notify('session.event',{agentId:request.agentId,event:toWireEvent(event)},{optIn:true});}}
      return selected.map(s=>s.id);
    }, requireTriage: !!cfg.modelRoles.decision, triageTimeoutMs: typeof cfg.decision.timeoutMs === 'number' ? cfg.decision.timeoutMs : 200, profileForAgent: agent => d.config().agents[agent]?.model, capabilities, skillsForAgent: agent => d.config().agents[agent]?.skills ?? {}, profiles, reasoningFor, profile: auth?.resolved.defaultProfile ?? 'default', profileForClass: modelClass => loadClassProfiles(join(d.home, 'model-class-profiles.json'), (d.config().decision.classProfiles as Record<string, string> | undefined) ?? classProfiles)[modelClass as import('../triage/classes.ts').ModelClass], router: { profileDefaults: auth?.resolved.defaults ?? {}, unsupportedProfiles: auth?.resolved.unsupported ?? {}, ...options.providers?.router }, family: options.providers?.family ?? auth?.families ?? {}, billing: options.providers?.billing ?? auth?.billing ?? {}, cacheRoutes: auth?.cacheRoutes ?? {}, profileCache: Object.fromEntries(Object.entries(auth?.resolved.profiles ?? {}).map(([name, p]) => [name, p.cache])), allowCrossBilling: name => profilePolicy[name]?.allowCrossBilling === true, localOnly: agentId => localOnlyFor(d.config(), agentId), isLocalProvider, secrets: () => registered, onRouterEvent: routerEventSink(d), policyContext: approvalPolicyContext(d.permissions), registry: new ToolRegistry(), budget, principal, toolsForTurn, snapshot: (req, memory) => req.projectId ? memory : sessions.forSession(req.sessionId).store.freezePromptSnapshot(req.sessionId, memory), onUsage: record => d.logger.info('provider.cache_usage', { ...record }), onPrompt: prompt => { options.providers?.onPrompt?.(prompt); for (const event of prompt.events) d.logger.info(event.type, { ...event }); }, beforeTools: async () => { await d.permissions.open(); }, grants, grantUse: { markUsed: id => d.permissions.current()!.grants.markUsed(id), consumeOnce: (id, binding) => d.permissions.current()!.grants.consumeOnce(id, binding) }, approval: { request: async ask => (await d.permissions.open()).service.request(ask), begin: (answer, ask) => d.permissions.current()?.service.begin(answer, ask) ?? false }, audit, log: record => d.logger.info('turn.stage', { ...record }), resultStore: { async put(value) {
      const dir = join(d.home, 'state', 'tool-results'); await mkdir(dir, { recursive: true, mode: 0o700 });
      const id = randomUUID(); await writeFile(join(dir, `${id}.json`), JSON.stringify(value), { flag: 'wx', mode: 0o600 }); return `tool-result:${id}`;
    } } }) : null;
    voice.setDelegate(provider);
    collab = budget ? isolated('collaboration', () => createCollab({ path: join(d.home, 'state', 'collab.sqlite'), clock: d.clock, sessions: () => sessions.store, redact: liveLogsRedactionPort(() => registered),
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
        if (admission.kind === 'refuse') return { allowed: false, reason: 'token-budget' };
        budget.releaseUnused(admission.reservationId); return { allowed: true };
      }, record: usage => d.logger.info('collab.usage', { ...usage }) },
    })) : null;
    if (collab) {
      disposers.push(() => collab.shutdown());
      const gate = new CodingGate({ path: join(d.home, 'state', 'coding-gate.sqlite'),
        verifier: sandboxVerifier(60000, { limitsHelper: join(d.home, 'bin', 'plur1bus-sandbox-limits'), maxTasks: () => d.config().tools.sandbox.maxTasks }), audit: event => { d.audit.append({ at: d.clock(), actor: { user: 'core', host: 'core' }, action: 'coding.gate', target: 'task', detail: { ...event } }); } });
      disposers.push(() => gate.close());
      coding = { collab, gate, worktrees: options.projectWorktrees ?? { root: agentId => d.agents.workspaceOf(agentId) ?? null } };
    }
    sessions = openSessionService({ ...maintenance, pruneConfidence: () => { const floor = (d.config().decision.confidence as Record<string, number> | undefined)?.pruning; return typeof floor === 'number' && Number.isFinite(floor) ? floor : DEFAULT_PRUNE_CONFIDENCE; }, laya: decisionPruningPort(decisions, (pair, signal) => {
      const service = sessions.forSession(pair.call.sessionId);
      const session = service.store.getSession(pair.call.sessionId);
      if (!session) throw new Error('pruning-session-unavailable');
      // Background request has no running turn; trace remains aggregate without transcript data.
      return { sessionId: session.id, agentId: session.agentId, principal: session.owner, signal, chat: { sessionId: session.id, agentId: session.agentId, principal: session.owner, role: 'decision', incognito: session.memoryMode === 'incognito', signal, summaries: [], memory: '', messages: [] } };
    }), dbPath: join(d.home, 'state', 'sessions.sqlite'), clock: d.clock, logger: d.logger, agents: d.agents, isStopping: d.isStopping, memory, provider: () => provider, notify: d.notify, signal: d.signal, onSessionEnd: id => {
      void hostctl.endSession(id).catch(err => d.logger.warn('hostctl session cleanup failed', { err }));
      const cur = d.permissions.current();
      if (cur) {
        try { cur.grants.endSession(id); } catch (err) { d.logger.warn('grant session end failed', { err }); }
        return;
      }
      void d.permissions.open().then(p => p.grants.endSession(id)).catch(err => d.logger.warn('grant session end failed', { err }));
    }, ...(d.approver ? { approver: d.approver } : {}), ...(d.onTurnTelemetry ? { onTurnTelemetry: d.onTurnTelemetry } : {}) });
    const skillProposals = new UnavailableSkillProposals();
    const skillReview = new SkillReview(skillProposals, { request: async ask => (await d.permissions.open()).service.request(ask), begin: (answer, ask) => d.permissions.current()?.service.begin(answer, ask) ?? false });
    const mining = new SkillMining(sessions.store, async scope => {
      if (!d.agents.has(scope.agentId)) throw new RpcError('E_AGENT_UNKNOWN', 'mining agent is not registered');
      const registry = await toolsForTurn({ sessionId: 'skill-mining-catalogue', agentId: scope.agentId, principal: scope.owner, summaries: [], memory: '', messages: [], signal: d.signal });
      return registry.entries().map(t => ({ name: t.name, version: toolEntry(t, JSON.stringify([scope.agentId, scope.owner])).version }));
    }, workflowEvidence, skillProposals);
    const promotions = collab ? new ChatPromotion({ path: join(d.home, 'state', 'chat-promotions.sqlite'), sessions: () => sessions, collab, now: d.clock, audit: event => { d.audit.append({ at: d.clock(), actor: { user: String(event.person), host: 'core' }, action: 'chat.promoted', target: 'project', detail: event }); } }) : null;
    if (promotions) disposers.push(() => promotions.close());
    let closed = false;
    const opened = sessions;
    return { budget, skillReview, mining, capabilities, refusedProviders: auth?.refused ?? [], discoveryCredentials: definition => auth?.credentialsForDiscovery(definition), voice, openai, sessions: opened, collab, chatModels, surfaceMethods: { 'decision.status': async () => decisions.status(), 'decision.test': async (p: { agentId: string }, ctx) => {
      if (!d.agents.has(p.agentId)) throw new RpcError('E_AGENT_UNKNOWN', 'Unknown agent');
      const principal = deriveUserPrincipal(authenticatedPrincipal(ctx).userId);
      const result = await decisions.choice({ useCase: 'routing', state: '2', question: 'Is this integer even or odd?', options: [{ id: 'even', description: 'Divisible by two' }, { id: 'odd', description: 'Not divisible by two' }] }, { agentId: p.agentId, principal, cloudEligible: true, signal: AbortSignal.any([ctx.signal, d.signal]) });
      return { ok: result.ok && result.value.id === 'even', durationMs: result.elapsedMs, outcome: result.ok ? (result.value.id === 'even' ? 'accepted' : 'invalid') : result.reason, ...(result.ok ? { backend: result.backend } : {}) };
    }, ...(promotions ? promotionMethods(promotions) : {}), ...(coding ? codingMethods(coding) : {}), "models.test": async (p: { model: string }, ctx) => {
      if (!budget) throw new RpcError('E_NOT_AVAILABLE', 'Model budget unavailable');
      const person = authenticatedPrincipal(ctx).userId;
      const budgetPrincipal = deriveUserPrincipal(person);
      return testModel(p.model, profiles, selected => (options.createTurnProvider ?? createTurnProvider)({
        profiles: selected, profile: 'probe', profileForClass: () => 'probe', registry: new ToolRegistry(), budget,
        principal: () => budgetPrincipal, grants, approval: { async request() { throw new Error('tools-disabled'); } },
        localOnly: agentId => localOnlyFor(d.config(), agentId), isLocalProvider,
        log: () => {}, resultStore: { async put() { throw new Error('tools-disabled'); } }, maxTokens: 16, maxRounds: 1,
        system: ['Reply with OK. Do not call tools.'],
        router: { profileDefaults: auth?.resolved.defaults ?? {}, unsupportedProfiles: auth?.resolved.unsupported ?? {} },
      }), budgetPrincipal, Object.keys(d.config().agents)[0] ?? 'model-test', AbortSignal.any([ctx.signal, d.signal]), { localOnly: agentId => localOnlyFor(d.config(), agentId), isLocalProvider });
    }, ...mediaSurface.methods, ...mediaSearchMethods({ home: d.home, config: d.config, agents: d.agents }, mediaSearch) }, async close() {
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
