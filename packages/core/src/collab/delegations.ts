/** D124 structured concurrency: only the starting turn may collect its children. No durable team scheduler lives here. */
import { CollabError } from './errors.ts';
import type { ReturnEnvelope } from './handoff.ts';

export interface DelegationResult {
  kind: 'tool_result';
  trust: 'untrusted';
  taskId: string;
  provenance: object;
  result?: ReturnEnvelope;
  error?: { code: string; message: string };
}
export interface ChildOutput { result: ReturnEnvelope; provenance?: object; [key: string]: unknown }
type DeliveryReceipt = (settled: (accepted: boolean) => void) => void;
interface Child {
  projectId: string;
  cardBound: boolean;
  abort: AbortController;
  done: Promise<ChildOutput>;
  result?: DelegationResult;
  reported?: boolean;
  claim?: symbol;
}

/** Turn-local handles are never resolved from model-supplied project or task identities. */
export class TurnDelegations {
  readonly #children = new Map<string, Child>();
  readonly #closed = new Set<() => void>();
  #finishing = false;

  /** Trace owners close only after turn completion and all children, including card-bound ones, have settled. */
  onClosed(callback: () => void): void { this.#closed.add(callback); this.#closeIfIdle(); }

  #closeIfIdle(): void {
    if (!this.#finishing || [...this.#children.values()].some(child => !child.result)) return;
    for (const callback of this.#closed) { try { callback(); } catch { /* trace bookkeeping cannot discard a return */ } }
    this.#closed.clear();
  }

  start(taskId: string, projectId: string, cardBound: boolean, abort: AbortController, run: () => Promise<ChildOutput>, origin: object = {}): Promise<ChildOutput> {
    if (this.#finishing) throw new CollabError('aborted', 'delegating turn already ended');
    // The executor observes abort and returns its partial envelope; racing it here would discard that progress.
    const completion = Promise.withResolvers<ChildOutput>(), done = completion.promise;
    const child: Child = { projectId, cardBound, abort, done };
    this.#children.set(taskId, child);
    const provenance = { ...origin, projectId, taskId };
    void done.then(output => { child.result = { kind: 'tool_result', trust: 'untrusted', taskId, provenance: output.provenance ?? provenance, result: output.result }; this.#closeIfIdle(); }, error => {
      // Never truncate an unredacted provider message: a split credential would evade the later full-value redactor.
      child.result = { kind: 'tool_result', trust: 'untrusted', taskId, provenance, error: { code: error instanceof CollabError ? error.code : 'invalid', message: error instanceof CollabError ? `delegation failed (${error.guardrail ?? error.code})` : 'delegation failed' } };
      this.#closeIfIdle();
    });
    // Register before executing sender repair or hooks; a re-entrant turn close must already see this child.
    try { void run().then(completion.resolve, completion.reject); } catch (error) { completion.reject(error); }
    return done;
  }

  projects(taskIds: readonly string[]): string[] {
    return [...new Set(taskIds.map(id => this.#child(id).projectId))];
  }

  /** Claim a blocking result now; only its consumer can commit successful delivery. */
  delivered(taskId: string, receipt?: DeliveryReceipt): void { this.#collect([this.#child(taskId)], receipt); }

  #collect(children: Child[], receipt?: DeliveryReceipt): DelegationResult[] {
    const claimed = children.filter(child => child.result && !child.reported && !child.claim);
    if (!claimed.length) return [];
    const claim = Symbol('delivery');
    for (const child of claimed) child.claim = claim;
    const settle = (accepted: boolean) => {
      for (const child of claimed) {
        if (child.claim !== claim) continue;
        if (accepted) child.reported = true;
        delete child.claim;
      }
    };
    if (receipt) receipt(settle); else settle(true);
    return claimed.map(child => child.result!);
  }

  #child(id: string): Child {
    const child = this.#children.get(id);
    if (!child) throw new CollabError('not-found', 'delegation does not belong to this turn');
    return child;
  }

  /** A timeout stops waiting, never the child. The caller can poll again using the same ids. */
  async wait(taskIds: readonly string[], timeoutMs: number, signal: AbortSignal, receipt?: DeliveryReceipt): Promise<{ results: DelegationResult[]; running: string[] }> {
    const ids = [...new Set(taskIds)], children = ids.map(id => this.#child(id));
    signal.throwIfAborted();
    if (timeoutMs > 0 && children.some(child => !child.result)) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const ended = Promise.withResolvers<void>();
      const abort = () => ended.reject(signal.reason);
      signal.addEventListener('abort', abort, { once: true });
      try {
        timer = setTimeout(() => ended.resolve(), timeoutMs);
        await Promise.race([Promise.allSettled(children.map(child => child.done)), ended.promise]);
      } finally { if (timer) clearTimeout(timer); signal.removeEventListener('abort', abort); }
    }
    const results = this.#collect(children, receipt);
    return {
      results,
      running: ids.filter((_, i) => !children[i]!.result),
    };
  }

  /** Handoff stops the sender's unbound work while preserving its returns for the final join. */
  cancelUnbound(except: string): void {
    for (const [id, child] of this.#children) if (id !== except && !child.cardBound && !child.result) child.abort.abort(new Error('sender handed off ownership'));
  }

  /** The starting turn owns every child until collection; cancellation stops them before joining. */
  async finish(cancel = false, receipt?: (taskId: string, settle: (accepted: boolean) => void) => void): Promise<DelegationResult[]> {
    this.#finishing = true;
    const children = [...this.#children.values()];
    if (cancel) for (const child of children) child.abort.abort(new Error('parent turn ended'));
    await Promise.allSettled(children.map(child => child.done));
    this.#closeIfIdle();
    return children.flatMap(child => this.#collect([child], receipt ? settle => receipt(child.result!.taskId, settle) : undefined));
  }
}
