import { triage, applyAtBoundary, type TriageDecision, type TriageTask, type ModelClass, type CostPreference } from './index.ts';
export interface MessageDecision { decision: TriageDecision; modelClass?: ModelClass; effort?: TriageTask['effort']; coreOnly: boolean; fallback: boolean }
export interface TaskBoundary { id: string; atBoundary: boolean }
/** One owner per provider, with explicit task boundaries; a recommendation never switches the active task mid-flight. */
export class MessageTriage {
  readonly #active = new Map<string, { id: string; modelClass: ModelClass; effort: TriageTask['effort'] }>();
  async decide(message: string, scope: string, classify: (message: string, signal: AbortSignal) => Promise<TriageDecision>, o: { signal: AbortSignal; timeoutMs?: number; cost?: CostPreference; task?: TaskBoundary; onFallback?: () => void }): Promise<MessageDecision> {
    o.signal.throwIfAborted();
    const controller = new AbortController();
    const abort = () => controller.abort(o.signal.reason);
    o.signal.addEventListener('abort', abort, { once: true }); if (o.signal.aborted) abort();
    const timeout = setTimeout(() => controller.abort(new Error('triage deadline')), o.timeoutMs ?? 200);
    let off: (() => void) | undefined;
    try {
      const raw = await Promise.race([classify(message, controller.signal), new Promise<never>((_, reject) => {
        const onAbort = () => reject(new Error('triage interrupted'));
        off = () => controller.signal.removeEventListener('abort', onAbort);
        controller.signal.addEventListener('abort', onAbort, { once: true }); if (controller.signal.aborted) onAbort();
      })]);
      o.signal.throwIfAborted();
      const decision = triage(message, { classifier: () => raw, ...(o.cost ? { cost: o.cost } : {}) });
      if (decision.tasks.length > 32 || (['chat', 'followup'].includes(decision.shape) && decision.tasks.length) || (decision.shape === 'single' && decision.tasks.length !== 1) || (decision.shape === 'multi' && decision.tasks.length < 2)) throw Error('inconsistent triage shape');
      const previous = this.#active.get(scope);
      if (decision.shape === 'chat') return { decision, coreOnly: true, fallback: false };
      if (decision.shape === 'followup' && previous) return { decision, modelClass: previous.modelClass, effort: previous.effort, coreOnly: false, fallback: false };
      if (!decision.tasks.length) throw Error('triage tasks missing');
      const classes = ['small', 'medium', 'large', 'frontier'];
      const recommended = decision.tasks.reduce((a, b) => classes.indexOf(a.chosenClass) >= classes.indexOf(b.chosenClass) ? a : b);
      const boundary = o.task?.atBoundary ?? true;
      const modelClass = previous ? applyAtBoundary(previous.modelClass, recommended.chosenClass, boundary) : recommended.chosenClass;
      const effort = previous && !boundary ? previous.effort : recommended.effort;
      this.#active.set(scope, { id: o.task?.id ?? recommended.id, modelClass, effort });
      if (this.#active.size > 1024) this.#active.delete(this.#active.keys().next().value!);
      return { decision, modelClass, effort, coreOnly: false, fallback: false };
    } catch {
      o.signal.throwIfAborted(); o.onFallback?.();
      return { decision: { schema: 'plur1bus.triage/1', shape: 'chat', tasks: [] }, coreOnly: true, fallback: true };
    } finally { clearTimeout(timeout); off?.(); o.signal.removeEventListener('abort', abort); }
  }
}
