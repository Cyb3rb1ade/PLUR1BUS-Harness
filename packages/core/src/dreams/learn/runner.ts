import type { Principal } from '../../rbac/types.ts';
import { aggregate, parseExtraction, vocabulary } from './aggregation.ts';
import { prompt, usage, type LearnModel, type LearnModelResult, type Stage } from './model.ts';
import { digest, targetHash, selectTranscriptsWithCounts, selectionDigest } from './selection.ts';
import { LearnStore } from './store.ts';
import { LearnError, type Finding, type LearnConfig, type LearnRun, type RawFinding, type SelectionSource, type Target, type Transcript, type Window } from './types.ts';

export interface LearnRunnerOptions {
  store: LearnStore; source: SelectionSource; model: LearnModel; now(): number;
  principal(owner: string): Principal | null;
  config(target: Target): LearnConfig;
  /** Host-owned stages; they receive only this already scoped selection. */
  review?(finding: Finding, transcripts: readonly Transcript[], call: (stage: Stage, key: string, data: unknown) => Promise<LearnModelResult>, signal: AbortSignal): Promise<Finding>;
  notice?(run: LearnRun, counts: { pending: number; waitingH3: number }): void;
}
export class LearnRunner {
  readonly #o: LearnRunnerOptions;
  readonly #tails = new Map<string, Promise<LearnRun>>();
  readonly #active = new Map<string, Promise<LearnRun>>();
  constructor(options: LearnRunnerOptions) { this.#o = options; }
  run(target: Target, window: Window, signal: AbortSignal): Promise<LearnRun> {
    const key = digest([targetHash(target), window.from, window.to]); const active = this.#active.get(key); if (active) return active;
    const scope = targetHash(target), before = this.#tails.get(scope);
    const task = Promise.resolve(before).catch(() => undefined).then(() => this.#run(target, window, signal)).finally(() => {
      this.#active.delete(key); if (this.#tails.get(scope) === task) this.#tails.delete(scope);
    });
    this.#tails.set(scope, task); this.#active.set(key, task); return task;
  }
  async idle(): Promise<void> { await Promise.allSettled([...this.#active.values()]); }
  async #run(target: Target, window: Window, signal: AbortSignal): Promise<LearnRun> {
    const o = this.#o, run = o.store.begin(target, window, o.now());
    if (run.outcome === 'completed') return run;
    const cfg = o.config(target);
    run.outcome = null; run.reason = null; run.finishedAt = null; o.store.save(run);
    try {
      // Ledger exists before disabled, rights, breaker, selection or provider work.
      if (!cfg.enabled) throw new LearnError('disabled');
      if (o.store.breakerOpen(target, o.now())) throw new LearnError('breaker-open');
      signal.throwIfAborted();
      const principal = o.principal(target.owner);
      if (!principal) throw new LearnError('rights-changed');
      o.store.step(run.id, 'selection', 'started');
      const selection = selectTranscriptsWithCounts(o.source, target, principal, window, cfg.maxSessions);
      const selected = selection.transcripts; run.truncated = selection.truncated; run.omittedSessions = selection.omittedSessions;
      const currentDigest = selectionDigest(selected);
      if (run.digest && currentDigest !== run.digest) throw new LearnError('rights-changed');
      run.sessionIds = selected.map(t => t.session.id); run.digest = currentDigest; o.store.save(run); o.store.step(run.id, 'selection', 'completed');
      if (!selected.length) throw new LearnError('no-sessions');
      const call = async (stage: Stage, key: string, data: unknown): Promise<LearnModelResult> => {
        const checkpointKey = `${stage}:${key}`;
        const previous = o.store.payload<LearnModelResult>(run.id, checkpointKey); if (previous) return previous;
        signal.throwIfAborted();
        const freshPrincipal = o.principal(target.owner);
        if (!freshPrincipal || selected.some(t => !o.source.mayRead(target, t.session, freshPrincipal))) throw new LearnError('rights-changed');
        const instructions = prompt(stage), envelope = JSON.stringify({ type: 'UNTRUSTED_DATA', data });
        const maxOutputTokens = 4096, reserved = Buffer.byteLength(instructions + envelope) + maxOutputTokens;
        if (reserved > cfg.maxTokens - run.tokens) throw new LearnError('budget');
        // Reserve the conservative byte bound before calling; a crash never frees already-started work.
        run.tokens += reserved; o.store.save(run); o.store.step(run.id, checkpointKey, 'started');
        const result = await o.model.complete({ target, stage, modelClass: stage === 'extract' ? 'small' : 'large', instructions, data: envelope, maxOutputTokens, signal });
        const actual = usage(result); run.tokens += actual - reserved; o.store.save(run);
        if (run.tokens > cfg.maxTokens) throw new LearnError('budget');
        o.store.checkpoint(run.id, checkpointKey, result); return result;
      };
      const authorized = (f: Finding): boolean => f.evidence.every(e => {
        const session = selected.find(t => t.session.id === e.sessionId)?.session ?? o.source.session?.(e.sessionId);
        return !!session && session.owner === e.owner && o.source.mayRead(target, session, principal);
      });
      const prior = o.store.targetFindings(target).filter(authorized);
      const seed = o.store.payload<ReturnType<typeof vocabulary>>(run.id, 'vocabulary') ?? vocabulary(prior);
      if (!o.store.payload(run.id, 'vocabulary')) o.store.checkpoint(run.id, 'vocabulary', seed);
      const raw: RawFinding[] = [], models = new Set<string>();
      for (const transcript of selected) {
        const result = await call('extract', transcript.session.id, { focus: cfg.focus, vocabulary: [...seed, ...vocabulary(raw)].slice(0, 100), messages: transcript.messages, events: transcript.events });
        raw.push(...parseExtraction(result.text, transcript)); models.add(result.model);
      }
      o.store.step(run.id, 'aggregate', 'started');
      const findings = aggregate(raw, target, run.id, selected.length); o.store.step(run.id, 'aggregate', 'completed');
      const reviewed: Finding[] = [];
      for (const next of findings) {
        const f = o.store.prepareCandidate(next); if (!f) continue;
        if (!authorized(f)) throw new LearnError('rights-changed');
        f.models = [...models].sort(); reviewed.push(o.review ? await o.review(f, selected, call, signal) : f);
      }
      signal.throwIfAborted();
      const freshPrincipal = o.principal(target.owner);
      if (!freshPrincipal || selected.some(t => !o.source.mayRead(target, t.session, freshPrincipal))) throw new LearnError('rights-changed');
      o.store.step(run.id, 'publish', 'started'); o.store.publish(run, reviewed, o.now()); o.store.step(run.id, 'publish', 'completed');
      o.notice?.(run, { pending: reviewed.filter(f => f.status === 'pending').length, waitingH3: reviewed.filter(f => f.status === 'waiting-h3').length });
    } catch (error) {
      const reason = signal.aborted ? 'interrupted' : error instanceof LearnError ? error.reason : 'provider-failed';
      o.store.finish(run, reason === 'transcript-cap' ? 'deferred' : ['invalid-output', 'provider-failed', 'source-unavailable'].includes(reason) ? 'failed' : 'skipped', reason, o.now());
    }
    return run;
  }
}
