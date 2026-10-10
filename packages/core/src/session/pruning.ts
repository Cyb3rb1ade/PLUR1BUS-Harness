// ADR-003: hide only in the context view; the append-only events are the retrieval source.
import type { SessionStore } from './store.ts';
import type { EventRecord } from './types.ts';
export interface PruneConfig { enabled: boolean; keepLastTurns: number; decider: 'laya' | 'heuristic' | 'off'; maxMs: number; batchSize: number }
export const defaultPrune = (): PruneConfig => ({ enabled: true, keepLastTurns: 3, decider: 'laya', maxMs: 100, batchSize: 16 });
export interface ToolPair { ref: string; turnId: string; call: EventRecord; result: EventRecord; text: string; hidden: boolean; restored: boolean; reason?: string }
export interface Relevance { ref: string; relevant: boolean; reason: string }
/** Laya local CPU backend (D34). An absent/over-budget backend returns null; failures/timeouts retain everything. */
export type LayaDecisionPort = (batch: readonly ToolPair[], task: string, signal: AbortSignal) => Promise<Relevance[] | null>;
export interface PruneHooks { decide?: LayaDecisionPort; signal?: AbortSignal; emit?: (type: 'compaction.prune.hidden' | 'compaction.prune.restored', attrs: Record<string, unknown>) => void }
export class ToolPruner {
  readonly #store: SessionStore; readonly cfg: PruneConfig; readonly #hooks: PruneHooks;
  readonly #running = new Map<string, Promise<number>>();
  constructor(store: SessionStore, cfg = defaultPrune(), hooks: PruneHooks = {}) {
    if (!Number.isSafeInteger(cfg.batchSize) || cfg.batchSize < 1 || !Number.isSafeInteger(cfg.keepLastTurns) || cfg.keepLastTurns < 1 || !Number.isFinite(cfg.maxMs) || cfg.maxMs <= 0) throw Error('invalid prune config');
    this.#store = store; this.cfg = cfg; this.#hooks = hooks; }
  view(sessionId: string): ToolPair[] {
    const visibility = new Map(this.#store.toolVisibility(sessionId).map(p => [p.ref, p]));
    const boundary = this.#boundary(sessionId);
    const pending = new Map<string, EventRecord>(); const pairs: ToolPair[] = [];
    for (const event of this.#store.toolEvents(sessionId)) {
      const id = `${event.turnId}:${event.data.id}`;
      if (event.type === 'tool.call') { pending.set(id, event); continue; }
      const call = pending.get(id); if (!call || !call.turnId) continue;
      pending.delete(id);
      const ref = `event:${call.seq}`, state = visibility.get(ref);
      // A referenced result is immediately visible, even if the next job has not run yet.
      const raw = JSON.stringify({ call: call.data, result: event.data });
      const pair: ToolPair = { ref, turnId: call.turnId, call, result: event, text: raw, hidden: state?.hidden ?? false, restored: state?.hidden === false, ...(state ? { reason: state.reason } : {}) };
      if (this.#protected(sessionId, pair, boundary)) pair.hidden = false;
      if (pair.hidden) pair.text = `[tool output hidden; originals ${ref}, event:${event.seq}; call ${String(call.data.name).slice(0, 100)}]`;
      pairs.push(pair);
    }
    return pairs;
  }
  #boundary(sessionId: string) {
    const turns = this.#store.listTurns(sessionId);
    return { turns: new Map(turns.map(t => [t.id,t])), latest: turns.at(-1)?.seq ?? 0, assistant: this.#store.listMessages(sessionId).filter(m => m.role === 'assistant').at(-1)?.text ?? '' };
  }
  #protected(sessionId: string, pair: ToolPair, boundary = this.#boundary(sessionId)): boolean {
    const turn = boundary.turns.get(pair.turnId);
    if (!turn || turn.state !== 'completed' || turn.seq > boundary.latest - this.cfg.keepLastTurns || pair.restored) return true;
    // The background worker cannot weaken approval/audit evidence, even when a model says "no".
    if (/approval|audit|grant|attest|permission|policy/i.test(JSON.stringify({ call: pair.call.data, result: pair.result.data }))) return true;
    const assistant = boundary.assistant;
    const refs = [pair.ref, `event:${pair.result.seq}`, String(pair.call.data.id), pair.turnId, String(pair.call.data.name)];
    const collect = (value: unknown, key = '') => {
      if (typeof value === 'string' && /path|ref|uri|url|id/i.test(key) && value.length >= 4) refs.push(value);
      else if (value && typeof value === 'object') for (const [k,v] of Object.entries(value)) collect(v,k);
    };
    collect(pair.call.data.args);
    try { collect(JSON.parse(String(pair.result.data.output))); } catch { /* Plain output has no structured refs. */ }
    return refs.some(ref => ref.length > 0 && assistant.includes(ref));
  }
  restore(sessionId: string, ref: string): boolean {
    const pair = this.view(sessionId).find(p => p.ref === ref);
    const state = this.#store.toolVisibility(sessionId).find(p => p.ref === ref);
    if (!pair || !state?.hidden) return false;
    this.#store.setToolVisibility(sessionId, ref, false, 'explicit-restore');
    this.#hooks.emit?.('compaction.prune.restored', { sessionId, ref }); return true;
  }
  run(sessionId: string): Promise<number> {
    const prior = this.#running.get(sessionId); if (prior) return prior;
    const run = this.#run(sessionId); this.#running.set(sessionId, run);
    void run.finally(() => this.#running.delete(sessionId)).catch(() => {}); return run;
  }
  async #run(sessionId: string): Promise<number> {
    if (this.#hooks.signal?.aborted || !this.cfg.enabled || this.cfg.decider === 'off' || this.#store.runningTurn(sessionId)) return 0;
    const started = performance.now();
    const revision = this.#store.lastEventSeq(sessionId);
    const proposed: { pair: ToolPair; reason: string }[] = [];
    const initialBoundary = this.#boundary(sessionId);
    const candidates = this.view(sessionId).filter(p => !p.hidden && !this.#protected(sessionId, p, initialBoundary));
    if (!candidates.length) return 0;
    const abort = new AbortController(); const signal = this.#hooks.signal ? AbortSignal.any([abort.signal, this.#hooks.signal]) : abort.signal;
    const timer = setTimeout(() => abort.abort(Error('prune-timeout')), this.cfg.maxMs);
    const timedOut = new Promise<null>(resolve => signal.addEventListener('abort', () => resolve(null), { once: true }));
    const task = this.#store.listMessages(sessionId).filter(m => m.role === 'user').at(-1)?.text ?? '';
    let hidden = 0;
    try {
      for (let i = 0; i < candidates.length; i += this.cfg.batchSize) {
        if (signal.aborted || performance.now() - started >= this.cfg.maxMs) return 0;
        const batch = candidates.slice(i, i + this.cfg.batchSize);
        const heuristic = () => batch.map(p => ({ ref: p.ref, relevant: p.text.length < 1024, reason: 'old-large-unreferenced' }));
        let answer: Relevance[] | null;
        if (this.cfg.decider === 'laya' && this.#hooks.decide) {
          try { answer = await Promise.race([this.#hooks.decide(batch, task, signal), timedOut]); } catch { return 0; }
          if (signal.aborted) return 0;
          if (answer === null) answer = heuristic(); // unavailable/budget refusal, never a timeout
        } else answer = heuristic();
        if (!Array.isArray(answer) || answer.length !== batch.length || new Set(answer.map(a => a.ref)).size !== batch.length || answer.some(a => !batch.some(p => p.ref === a.ref) || typeof a.relevant !== 'boolean' || typeof a.reason !== 'string' || !a.reason.trim() || a.reason.length > 256)) continue;
        // Re-check all boundaries after the await. A new foreground turn makes this stale batch unusable.
        if (signal.aborted || this.#store.runningTurn(sessionId) || this.#store.lastEventSeq(sessionId) !== revision) return 0;
        const freshBoundary = this.#boundary(sessionId);
        const visibility = new Set(this.#store.toolVisibility(sessionId).map(p => p.ref));
        for (const decision of answer) {
          const pair = batch.find(p => p.ref === decision.ref)!;
          if (decision.relevant || this.#protected(sessionId, pair, freshBoundary) || visibility.has(pair.ref)) continue;
          proposed.push({ pair, reason: decision.reason });
        }
      }
      if (signal.aborted || performance.now() - started >= this.cfg.maxMs || this.#store.runningTurn(sessionId) || this.#store.lastEventSeq(sessionId) !== revision) return 0;
      const boundary = this.#boundary(sessionId);
      const visibility = new Set(this.#store.toolVisibility(sessionId).map(p => p.ref));
      const changes = proposed.filter(({pair}) => !this.#protected(sessionId,pair,boundary) && !visibility.has(pair.ref));
      this.#store.setToolVisibilities(sessionId,changes.map(({pair,reason}) => ({ref:pair.ref,hidden:true,reason})));
      hidden = changes.length;
      for (const {pair} of changes) this.#hooks.emit?.('compaction.prune.hidden',{sessionId,ref:pair.ref});
      return hidden;
    } finally { clearTimeout(timer); }
  }
}
