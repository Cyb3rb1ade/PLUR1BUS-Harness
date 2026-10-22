import type { ModelRoutingPolicy } from '@plur1bus/config-schema';
import type { Candidate, ProfileTable } from '../../../providers/src/index.ts';
import type { DecisionClient } from '../decision/client.ts';
import type { ChatRequest } from '../session/provider.ts';
import type { TriageDecision } from '../triage/index.ts';
export interface ModelRouteChoice { profile: string; provider: string; model: string }
export interface ModelRoutingEvent extends ModelRouteChoice { source: 'auto' | 'fixed' | 'explicit'; reasonCode: string; requestedProfile: string }
export interface ModelSelection {
  profile: string; candidates: readonly Candidate[]; reasonCode: string; source: 'auto' | 'fixed' | 'explicit';
  served(provider: string, model: string): ModelRoutingEvent;
  finish(success: boolean): void;
}
interface RoutingOptions {
  decision(): DecisionClient;
  agent(agentId: string): { model?: string; modelPolicy?: ModelRoutingPolicy } | undefined;
  localOnly(agentId: string): boolean;
  isLocal(provider: string): boolean;
  /** Metadata only, from a completed owned session turn. Incognito resolves through the volatile store. */
  restore?(request: ChatRequest): ModelRouteChoice | undefined;
}
const identity = (provider: string, model: string) => JSON.stringify([provider, model]);
/** The cache belongs to composition, not to a provider instance recreated by live role changes. */
export class SessionModelRouting {
  readonly #options: RoutingOptions;
  readonly #cache = new Map<string, ModelRouteChoice>();
  readonly #outcomes = new Map<string, 'completed' | 'failed'>();
  constructor(options: RoutingOptions) { this.#options = options; }
  contextProfiles(agentId: string): readonly string[] {
    const agent = this.#options.agent(agentId);
    return agent?.modelPolicy?.mode === 'auto' ? agent.modelPolicy.tiers : agent?.model ? [agent.model] : [];
  }
  async select(request: ChatRequest, profiles: ProfileTable, defaultProfile: string, triage?: TriageDecision, supported: (name: string) => boolean = () => true): Promise<ModelSelection | undefined> {
    if (request.role) return undefined;
    const agent = this.#options.agent(request.agentId), policy = agent?.modelPolicy;
    if (!policy) return undefined;
    request.signal.throwIfAborted();
    const key = JSON.stringify([request.agentId, request.principal, request.sessionId]);
    const source = request.modelProfile ? 'explicit' : policy.mode === 'fixed' ? 'fixed' : 'auto';
    let chosen = request.modelProfile ?? agent?.model ?? defaultProfile, reasonCode: string = source;
    let cached: ModelRouteChoice | undefined;
    const allowed = () => policy.tiers.filter(name => supported(name) && Object.hasOwn(profiles, name) && profiles[name]?.length && this.#eligible(request, profiles[name]![0]!));
    let tiers = source === 'auto' ? allowed() : [chosen];
    if (!tiers.length || !Object.hasOwn(profiles, chosen) && source !== 'auto') throw new Error('model-policy-unavailable');
    if (source === 'auto') {
      cached = this.#cache.get(key);
      if (!cached) try { cached = this.#options.restore?.(request); } catch { throw new Error('model-policy-state-unavailable'); }
      if (cached && (!tiers.includes(cached.profile) || !profiles[cached.profile]?.some(c => c.provider === cached!.provider && c.model === cached!.model && this.#eligible(request, c)))) cached = undefined;
      if (cached && !policy.perTurn) { chosen = cached.profile; reasonCode = 'session-cache'; }
      else if (tiers.length === 1) { chosen = tiers[0]!; reasonCode = 'only-eligible-tier'; }
      else {
        const decide = (signal: AbortSignal) => this.#options.decision().choice({ useCase: 'routing', state: request.messages.filter(m => m.role === 'user').at(-1)?.text ?? '', question: 'Choose the least capable tier that can reliably complete this turn. The supplied profiles are ordered by increasing capability and cost.', features: {
          contextChars: request.messages.reduce((sum, message) => sum + message.text.length, 0), taskCount: triage?.tasks.length ?? 0,
          plannedToolCount: request.toolView?.length ?? 0, previousOutcome: this.#outcomes.get(key) ?? 'unknown',
        }, options: tiers.map((id, index) => ({ id, description: `Capability/cost tier ${index + 1} of ${tiers.length}` })) }, { agentId: request.agentId, sessionId: request.sessionId, ...(request.turnId ? { turnId: request.turnId } : {}), ...(request.principal ? { principal: request.principal } : {}), signal, chat: request });
        const voice = request.turnProfile;
        const response = voice?.localRealtime.enabled && voice.localRealtime.features.decisionService.mode !== 'on' ? undefined : voice ? await voice.run('decisionService', decide, undefined, request.signal) : await decide(request.signal);
        request.signal.throwIfAborted();
        // Privacy can change while the classifier is running. Its answer confers no admission.
        tiers = allowed(); if (!tiers.length) throw new Error('model-policy-unavailable');
        if (response?.ok && tiers.includes(response.value.id)) { chosen = response.value.id; reasonCode = 'decision'; }
        else { chosen = cached && tiers.includes(cached.profile) ? cached.profile : tiers.includes(agent?.model ?? '') ? agent!.model! : tiers[0]!; reasonCode = `fallback-${response?.ok ? 'privacy' : response?.reason ?? 'disabled'}`; }
      }
    }
    const after = source === 'auto' ? tiers.slice(tiers.indexOf(chosen)) : [chosen];
    const rows = after.flatMap(profile => (profiles[profile] ?? []).filter(candidate => source !== 'auto' || this.#eligible(request, candidate)).map(candidate => ({ profile, candidate })));
    const seen = new Set<string>(); let candidates = rows.filter(row => { const id = identity(row.candidate.provider, row.candidate.model); if (seen.has(id)) return false; seen.add(id); return true; });
    if (reasonCode === 'session-cache' && cached) {
      const offset = candidates.findIndex(row => row.candidate.provider === cached!.provider && row.candidate.model === cached!.model);
      if (offset >= 0) candidates = candidates.slice(offset);
    }
    if (!candidates.length) throw new Error('model-policy-unavailable');
    let served: ModelRouteChoice | undefined, finished = false;
    return { profile: chosen, reasonCode, source, candidates: candidates.map(row => row.candidate),
      served(provider, model) {
        const row = candidates.find(row => row.candidate.provider === provider && row.candidate.model === model);
        if (!row) throw new Error('model-policy-unlisted-provider');
        served = { profile: row.profile, provider, model };
        return { ...served, source, reasonCode, requestedProfile: chosen };
      },
      finish: success => {
        if (finished) return; finished = true;
        const accepted = success && !request.signal.aborted;
        this.#outcomes.set(key, accepted ? 'completed' : 'failed');
        if (accepted && source === 'auto' && served) this.#cache.set(key, served);
        if (this.#cache.size > 1024) this.#cache.delete(this.#cache.keys().next().value!);
        if (this.#outcomes.size > 1024) this.#outcomes.delete(this.#outcomes.keys().next().value!);
      },
    };
  }
  #eligible(request: ChatRequest, candidate: Candidate): boolean {
    try { return (!this.#options.localOnly(request.agentId) || this.#options.isLocal(candidate.provider)) && (!request.turnProfile?.allowModel || request.turnProfile.allowModel(candidate.provider, candidate.model)); }
    catch { return false; }
  }
}
