import { canonicalJson } from '../tools/dispatcher.ts';
import { createHash } from 'node:crypto';
import defaults from './defaults.json' with { type: 'json' };
import type { SessionStore } from '../session/store.ts';
import type { SessionRecord, EventRecord } from '../session/types.ts';
import { RpcError } from '../rpc/errors.ts';
import type { SystemJobHandler } from '../system-jobs/index.ts';
import { UnavailableSkillProposals } from './review.ts';
export interface MiningScope { owner: string; agentId: string; scope: string }
export interface ExecutionProof { verified(scope: MiningScope, sessionId: string, turnId: string, callId: string, tool: string, version: string): boolean }
export interface MiningTool { name: string; version: string }
export interface MiningConfig { minSessions: number; minSteps: number; maxSteps: number; maxSessions: number; maxEvents: number }
export type MiningSessions = Pick<SessionStore, 'listSessions' | 'listTurns' | 'listEvents'>;
export interface SkillCandidate {
  schema: 'plur1bus.skill-candidate/1'; kind: 'skill'; author: 'agent'; enabled: false;
  name: string; workflowHash: string; skillMd: string; reason: string; sessionIds: string[];
}
export interface SkillProposalQueue {
  /** Only an engine-owned additive artifact proposal API may implement this port; memory correction is insufficient. */
  readonly supportsSkillArtifacts: true;
  readonly state?: 'ready' | 'engine-unavailable';
  find(scope: MiningScope, workflowHash: string): Promise<{ id: string; status: 'pending' | 'accepted' | 'rejected' } | null>;
  propose(scope: MiningScope, candidate: SkillCandidate): Promise<{ id: string; status: 'pending' }>;
}
const hash = (value: unknown) => createHash('sha256').update(canonicalJson(value)).digest('hex');
export function miningConfig(value: MiningConfig = defaults): Readonly<MiningConfig> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(defaults).some(k => !Number.isSafeInteger(value[k as keyof MiningConfig])) || value.minSessions < 2 || value.minSteps < 1 || value.maxSteps < value.minSteps || value.maxSteps > 100 || value.maxSessions < value.minSessions || value.maxSessions > 200 || value.maxEvents < 1 || value.maxEvents > 20000) throw new RpcError('E_INVALID_PARAMS', 'invalid mining bounds');
  return Object.freeze({ ...value });
}
function boundScope(scope: MiningScope): MiningScope {
  if (!scope || [scope.owner, scope.agentId, scope.scope].some(v => typeof v !== 'string' || !v || v.length > 256)) throw new RpcError('E_INVALID_PARAMS', 'mining requires an exact scope');
  return Object.freeze({ owner: scope.owner, agentId: scope.agentId, scope: scope.scope });
}
function sameScope(session: SessionRecord, scope: MiningScope): boolean { return session.owner === scope.owner && session.agentId === scope.agentId && session.scope === scope.scope && session.memoryMode === 'remember' && session.archivedAt !== null; }
/** Arguments, result contents, transcripts, titles and tool descriptions are never copied into a candidate. */
export function mineSessionWorkflows(store: MiningSessions, scope: MiningScope, tools: readonly MiningTool[], proof: ExecutionProof, settings?: MiningConfig): SkillCandidate[] {
  scope = boundScope(scope);
  const config = miningConfig(settings);
  const registered = new Map(tools.filter(t => /^[a-z][a-z0-9_.-]{0,63}$/.test(t.name) && /^[a-f0-9]{64}$/.test(t.version)).map(t => [t.name, t]));
  const listed = store.listSessions({ owner: scope.owner, agentId: scope.agentId, archived: 'only', limit: config.maxSessions });
  if (listed.truncated) throw new RpcError('E_NOT_AVAILABLE', 'mining session window is truncated');
  const groups = new Map<string, { steps: MiningTool[]; sessions: Set<string> }>();
  for (const session of listed.sessions) {
    if (!sameScope(session, scope) || !/^[a-zA-Z0-9_-]{1,128}$/.test(session.id)) continue;
    const turns = new Map(store.listTurns(session.id).filter(t => t.state === 'completed' && !t.incognito && t.endedAt !== null).map(t => [t.id, t]));
    if (!turns.size) continue;
    const events: EventRecord[] = []; let after = 0;
    for (;;) {
      const page = store.listEvents(session.id, after, Math.min(2000, config.maxEvents + 1 - events.length));
      if (!page.length) break;
      // Recheck source identity; a buggy adapter must not introduce events from a different session or loop a page.
      if (page.some(e => e.sessionId !== session.id || e.seq <= after)) throw new RpcError('E_STORAGE', 'invalid mining event page');
      events.push(...page); after = page.at(-1)!.seq;
      if (events.length > config.maxEvents) throw new RpcError('E_NOT_AVAILABLE', 'mining event window exceeds bound');
    }
    const sessionWorkflows = new Map<string, MiningTool[]>();
    for (const turn of turns.values()) {
      const relevant = events.filter(e => e.turnId === turn.id);
      const calls = relevant.filter(e => e.type === 'tool.call');
      if (calls.length < config.minSteps || calls.length > config.maxSteps) continue;
      const ids = new Set<string>(); const steps: MiningTool[] = []; let valid = true;
      for (const call of calls) {
        const id = call.data.id, name = call.data.name;
        if (typeof id !== 'string' || ids.has(id) || typeof name !== 'string' || !registered.has(name)) { valid = false; break; }
        const tool = registered.get(name)!;
        if (!proof.verified(scope, session.id, turn.id, id, name, tool.version)) { valid = false; break; }
        ids.add(id);
        const results = relevant.filter(e => e.type === 'tool.result' && e.data.id === id && e.seq > call.seq);
        if (results.length !== 1 || results[0]!.data.isError === true || typeof results[0]!.data.output !== 'string') { valid = false; break; }
        // Only the dispatcher's/capper's literal success marker counts; model prose claiming success never does.
        try { if ((JSON.parse(results[0]!.data.output) as { isError?: unknown }).isError !== false) { valid = false; break; } } catch { valid = false; break; }
        steps.push(registered.get(name)!);
      }
      if (!valid) continue;
      const key = hash([scope, steps]); sessionWorkflows.set(key, steps);
    }
    for (const [key, steps] of sessionWorkflows) { const group = groups.get(key) ?? { steps, sessions: new Set<string>() }; group.sessions.add(session.id); groups.set(key, group); }
  }
  return [...groups].filter(([, g]) => g.sessions.size >= config.minSessions).sort(([a], [b]) => a.localeCompare(b)).map(([workflowHash, group]): SkillCandidate => {
    const name = `mined-workflow-${workflowHash.slice(0, 16)}`;
    const skillMd = `---\nname: ${name}\ndescription: Repeat a reviewed sequence of approved tool operations.\n---\n\n# Reviewed workflow\n\nBefore each step, derive arguments from the current authorized request. Preserve every dispatcher policy check and approval. Do not reuse session arguments, paths, output, secrets or identities.\n\n${group.steps.map((t, i) => `${i + 1}. Invoke ${t.name} through the central dispatcher and verify its result.`).join('\n')}\n`;
    return { schema: 'plur1bus.skill-candidate/1', kind: 'skill', author: 'agent', enabled: false, name, workflowHash, skillMd, reason: `${group.steps.length} approved tool steps succeeded in ${group.sessions.size} completed sessions in the same scope.`, sessionIds: [...group.sessions].sort() };
  });
}
/** Proposal-only orchestration: no filesystem writer, installer, enabling hook, or fallback local queue exists here. */
export class SkillMining {
  readonly #running = new Map<string, Promise<{ ids: string[]; duplicates: number }>>();
  readonly #source: MiningSessions; readonly #tools: (scope: MiningScope) => readonly MiningTool[] | Promise<readonly MiningTool[]>; readonly #proof: ExecutionProof; readonly #queue: SkillProposalQueue;
  constructor(source: MiningSessions, tools: (scope: MiningScope) => readonly MiningTool[] | Promise<readonly MiningTool[]>, proof: ExecutionProof, queue: SkillProposalQueue = new UnavailableSkillProposals()) { this.#source = source; this.#tools = tools; this.#proof = proof; this.#queue = queue; }
  status() { const available = this.#queue.supportsSkillArtifacts === true && this.#queue.state !== 'engine-unavailable'; return { available, state: available ? 'ready' as const : 'engine-unavailable' as const, activeByDefault: false, humanReviewRequired: true }; }
  async preview(scope: MiningScope): Promise<SkillCandidate[]> { const bound = boundScope(scope); return mineSessionWorkflows(this.#source, bound, await this.#tools(bound), this.#proof); }
  propose(scope: MiningScope): Promise<{ ids: string[]; duplicates: number }> {
    const bound = boundScope(scope), key = canonicalJson(bound);
    let running = this.#running.get(key);
    if (!running) { running = this.#propose(bound).finally(() => this.#running.delete(key)); this.#running.set(key, running); }
    return running;
  }
  async #propose(scope: MiningScope): Promise<{ ids: string[]; duplicates: number }> {
    if (!this.status().available) throw new RpcError('E_NOT_AVAILABLE', 'the engine has no skill-artifact proposal contract', { reason: 'skill-proposal-contract-unavailable' });
    const ids: string[] = []; let duplicates = 0;
    for (const candidate of await this.preview(scope)) {
      if (await this.#queue.find(scope, candidate.workflowHash)) { duplicates++; continue; }
      const result = await this.#queue.propose(scope, candidate);
      if (result.status !== 'pending') throw new RpcError('E_STORAGE', 'proposal queue did not retain human review');
      ids.push(result.id);
    }
    return { ids, duplicates };
  }
  /** Register only after the host has established a scope and an engine-backed artifact queue. */
  job(scope: MiningScope): SystemJobHandler {
    const bound = boundScope(scope);
    return { spec: { name: 'skills.mine', needsLlm: false, singleton: true, schedule: { every: 86_400_000, jitter: 0 } }, nextRunAt: () => null,
      validateArgs(args) { if (args != null && (typeof args !== 'object' || Array.isArray(args) || Object.keys(args).length)) throw new RpcError('E_INVALID_PARAMS', 'mining scope is host-owned'); return {}; },
      run: async (_args, context) => { context.signal.throwIfAborted(); if (!this.status().available) return { outcome: 'skipped', reason: 'skill-proposal-contract-unavailable', detail: this.status() }; const detail = await this.propose(bound); return { outcome: 'completed', detail }; } };
  }
}
