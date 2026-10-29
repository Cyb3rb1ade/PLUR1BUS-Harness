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
    const timeout = setTimeout(() => controller.abort(new Error('triage deadline')), o.timeoutMs ?? 2000);
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
      if (!decision.tasks.length && decision.shape !== 'chat' && !(decision.shape === 'followup' && this.#active.has(scope))) throw Error('triage tasks missing');
      return this.#resolve(decision, scope, o.task, false);
    } catch {
      o.signal.throwIfAborted(); o.onFallback?.();
      // A decision role may fail; its absence must retain the rule path's skills and capabilities (N-D4).
      const previous = this.#active.get(scope);
      return this.#resolve(triage(message, { ...(o.cost ? { cost: o.cost } : {}), ...(previous ? { activeTask: previous.id } : {}) }), scope, o.task, true);
    } finally { clearTimeout(timeout); off?.(); o.signal.removeEventListener('abort', abort); }
  }
  #resolve(decision: TriageDecision, scope: string, task: TaskBoundary | undefined, fallback: boolean): MessageDecision {
    const previous = this.#active.get(scope);
    if (decision.shape === 'followup' && previous) return { decision, modelClass: previous.modelClass, effort: previous.effort, coreOnly: false, fallback };
    if (!decision.tasks.length) return { decision, coreOnly: false, fallback };
    const classes = ['small', 'medium', 'large', 'frontier'];
    const recommended = decision.tasks.reduce((a, b) => classes.indexOf(a.chosenClass) >= classes.indexOf(b.chosenClass) ? a : b);
    const boundary = task?.atBoundary ?? true;
    const modelClass = previous ? applyAtBoundary(previous.modelClass, recommended.chosenClass, boundary) : recommended.chosenClass;
    const effort = previous && !boundary ? previous.effort : recommended.effort;
    this.#active.set(scope, { id: task?.id ?? recommended.id, modelClass, effort });
    if (this.#active.size > 1024) this.#active.delete(this.#active.keys().next().value!);
    return { decision, modelClass, effort, coreOnly: false, fallback };
  }
}
