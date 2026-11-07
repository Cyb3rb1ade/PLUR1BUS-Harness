import type { HarnessConfig } from '@plur1bus/config-schema';
import type { Principal } from '../../rbac/types.ts';
import type { InboxPort } from '../../inbox/service.ts';
import { RpcError } from '../../rpc/errors.ts';
import { calibration, scoreFinding } from './calibration.ts';
import { learnConfig, learnTargets } from './config.ts';
import { parseExtraction } from './aggregation.ts';
import { evidenceView, refuteFinding, wordFinding } from './refutation.ts';
import { digest, validateTarget } from './selection.ts';
import { LearnRunner } from './runner.ts';
import { LearnStore } from './store.ts';
import { verifyFinding, type LearnReadPort } from './verify.ts';
import { LearnError, LIMITS, type Finding, type SelectionSource, type Target, type Transcript, type Window } from './types.ts';
import type { LearnModel } from './model.ts';

export interface LearnCard { text: string; scope: string; origin: string | null; sharedBy?: string | undefined }
export interface LearnServiceOptions {
  metrics?: Pick<import('../../metrics/metrics.ts').Metrics, 'learnRun' | 'learnFinding'>;
  store: LearnStore; source: SelectionSource; model: LearnModel; config(): HarnessConfig; now(): number;
  principal(owner: string): Principal | null;
  mayReadTarget(target: Target, principal: Principal): boolean;
  readPort(target: Target): Promise<LearnReadPort | null>;
  card(finding: Finding): Promise<LearnCard | null>;
  inbox?: InboxPort;
  erasures?(): { sessionId: string }[];
  onErasure?(listener: () => void): () => void;
  signal: AbortSignal;
  /** Future public H3 adapter; absent at the pinned Engine. Must honor the supplied idempotency key. */
  h3?: { available(): boolean; submit(input: { finding: Finding; idempotencyKey: string }): Promise<{ receiptId: string }> };

}
export type PublicMemoryCall = (method: string, params: Record<string, unknown>) => Promise<unknown>;
const denied = () => new RpcError('E_DENIED', 'Learning review is not available for this person', { reason: 'learn-access' });
const unavailable = (reason: string) => new RpcError('E_NOT_AVAILABLE', 'Learning action is unavailable', { reason });
const DAY = 86_400_000;

export class LearnService {
  readonly #o: LearnServiceOptions;
  readonly runner: LearnRunner;
  #admit: <T>(work: () => Promise<T>) => Promise<T> = work => work();
  #offErasure: (() => void) | undefined;
  readonly #deciding = new Set<string>();
  constructor(o: LearnServiceOptions) {
    this.#o = o;
    this.reconcile();
    this.#offErasure = o.onErasure?.(() => this.reconcile());
    this.runner = new LearnRunner({ ...o, observe: (run, findings, tokens) => o.metrics?.learnRun(run, findings, tokens), config: t => learnConfig(o.config(), t),
      review: async (finding, _selected, call, signal) => {
        const person = this.person(finding.target.owner); this.authorize(finding.target, person);
        const transcripts = this.transcripts(finding, person);
        // Trust is recomputed from live source provenance, including channel-link revocation.
        const evidence = transcripts.flatMap(t => parseExtraction(JSON.stringify([{ kind: finding.kind, change: finding.change,
          text: finding.text, contentKey: 'trust-refresh', evidence: finding.evidence.filter(e => e.sessionId === t.session.id).map(e => ({ source: e.source, id: e.sourceId })) }]), t)[0]!.evidence);
        let f = { ...finding, evidence };
        f.verify = await verifyFinding(f, await o.readPort(f.target), signal);
        const card = f.memoryId ? await o.card(f) : null;
        const expectedScope = f.target.scope === 'project' ? 'workspace' : 'agent-private';
        const targetVerified = !f.memoryId ? f.change === 'add' : card?.scope === expectedScope;
        if (card) f.agreement = card.text.normalize('NFKC').trim() === f.text.normalize('NFKC').trim() ? 'agrees' : 'unknown';
        // Imported/user-authored or unclassified existing cards are never automatic candidates.
        const safety = { personAuthored: !!f.memoryId && card?.origin !== 'capture', sensitive: false, targetVerified };
        f = scoreFinding(f, safety);
        f = await refuteFinding(f, transcripts, call);
        f = await wordFinding(f, call);
        return scoreFinding(f, safety);
      },
      notice: (run, counts) => o.inbox?.publish({ userId: run.target.owner, kind: 'system', severity: 'info',
        titleKey: 'memory.learn.notice', params: { pending: counts.pending, waitingH3: counts.waitingH3 },
        ref: { route: '/memories/dreams', objectId: run.id }, dedupeKey: `system:learn:${run.id}` }),
    });
  }
  reconcile(invalidate?: { agentId?: string; owner?: string }): void {
    const validTarget = (t: Target): boolean => { try { return t.owner !== invalidate?.owner && t.agentId !== invalidate?.agentId && this.#o.mayReadTarget(t, this.person(t.owner)); } catch { return false; } };
    this.store.reconcile({ now: this.#o.now(), checkpointDays: this.#o.config().dreams?.learn?.checkpointDays ?? 7,
      erased: new Set(this.#o.erasures?.().map(e => e.sessionId) ?? []), validTarget,
      validSession: (id, t) => { const s = this.#o.source.session?.(id); try { return !!s && s.agentId !== invalidate?.agentId && validTarget(t) && this.#o.source.mayRead(t, s, this.person(t.owner)); } catch { return false; } },
      validEvidence: (e, t) => { const s = this.#o.source.session?.(e.sessionId); try { return e.agentId !== invalidate?.agentId && validTarget(t) && !!s && this.#o.source.mayRead(t, s, this.person(t.owner)); } catch { return false; } } });
  }
  setAdmission(admit: <T>(work: () => Promise<T>) => Promise<T>): void { this.#admit = admit; }
  get store(): LearnStore { return this.#o.store; }
  person(owner: string): Principal { const p = this.#o.principal(owner); if (!p || p.kind !== 'person' || p.userId !== owner) throw denied(); return p; }
  authorize(target: Target, person: Principal): void {
    validateTarget(target);
    if (person.kind !== 'person' || person.userId !== target.owner || !this.#o.mayReadTarget(target, person)) throw denied();
  }
  targets(owner: string): Target[] { return learnTargets(this.#o.config()).filter(t => t.owner === owner); }
  window(target: Target): Window {
    const to = Math.floor(this.#o.now() / DAY) * DAY;
    return { from: Math.max(0, to - learnConfig(this.#o.config(), target).windowDays * DAY), to };
  }
  run(target: Target, person: Principal, signal: AbortSignal): Promise<import('./types.ts').LearnRun> {
    this.reconcile(); this.authorize(target, person);
    return this.#admit(() => this.runner.run(target, this.window(target), AbortSignal.any([signal, this.#o.signal])));
  }
  status(target: Target, person: Principal) {
    this.authorize(target, person);
    const config = learnConfig(this.#o.config(), target);
    return { target, enabled: config.enabled, lastRun: this.store.runs(target.owner, target)[0] ?? null,
      nextRunAt: config.enabled ? (Math.floor(this.#o.now() / DAY) + 1) * DAY : null,
      breakerOpen: this.store.breakerOpen(target, this.#o.now()) };
  }
  async due(signal: AbortSignal): Promise<void> {
    this.reconcile(); await this.handoff();
    // Same scheduler lifecycle, sequential targets; no additional cron or unbounded fanout.
    for (const target of learnTargets(this.#o.config())) {
      if (signal.aborted || this.#o.signal.aborted) return;
      if (!learnConfig(this.#o.config(), target).enabled) continue;
      const previous = this.store.runs(target.owner, target)[0];
      if (previous?.window.to === this.window(target).to && previous.outcome !== null) continue;
      try { await this.run(target, this.person(target.owner), signal); } catch { /* Fixed authorization refusal, no content log. */ }
    }
  }
  async handoff(): Promise<void> {
    const port = this.#o.h3; if (!port?.available()) return;
    for (const target of learnTargets(this.#o.config())) {
      for (let offset = 0; ; offset += 100) {
        const page = this.store.targetFindings(target, 100, offset);
        for (const finding of page) {
          if (finding.status !== 'waiting-h3') continue;
          try {
            this.transcripts(finding, this.person(target.owner));
            const hash = digest(finding); if (this.store.handoff(finding.id, hash)) continue;
            const result = await port.submit({ finding, idempotencyKey: `learn:${finding.id}:${hash}` });
            this.store.handedOff(finding.id, hash, result.receiptId);
          } catch { /* Missing capability/rights stays read-only; retry uses the same idempotency key. */ }
        }
        if (page.length < 100) break;
      }
    }
  }

  nextRunAt(): number | null { return learnTargets(this.#o.config()).some(t => learnConfig(this.#o.config(), t).enabled) ? (Math.floor(this.#o.now() / DAY) + 1) * DAY : null; }
  transcripts(finding: Finding, person: Principal): Transcript[] {
    this.authorize(finding.target, person);
    const result: Transcript[] = [];
    for (const id of new Set(finding.evidence.map(e => e.sessionId))) {
      const session = this.#o.source.session?.(id);
      if (!session || !this.#o.source.mayRead(finding.target, session, person)) throw denied();
      const refs = finding.evidence.filter(e => e.sessionId === id);
      if (refs.some(e => e.owner !== session.owner || e.agentId !== session.agentId)) throw denied();
      if (finding.target.scope === 'installation' && finding.toolPattern) continue;
      const t = this.#o.source.evidence?.(session, refs);
      if (!t || t.messages.length > LIMITS.messages || t.events.length > LIMITS.events || Buffer.byteLength(JSON.stringify(t)) > LIMITS.bytes) throw new LearnError('transcript-cap');
      result.push(t);
    }
    return result;
  }
  get(id: string, person: Principal) {
    this.reconcile();
    const finding = this.store.finding(id); if (!finding) throw unavailable('finding-not-found');
    const transcripts = this.transcripts(finding, person);
    const evidence = finding.toolPattern ? [] : evidenceView(finding, transcripts);
    return { finding, evidence, prediction: this.store.prediction(id), contentHash: digest(finding), action: this.store.action(id, finding.revision ?? 1) };
  }
  list(target: Target, person: Principal, offset = 0) {
    this.reconcile(); this.authorize(target, person);
    const rows = this.store.targetFindings(target, 51, offset);
    const items = rows.slice(0, 50).flatMap(f => {
      try { this.transcripts(f, person); } catch { return []; }
      return [{ id: f.id, kind: f.kind, change: f.change, status: f.status, score: f.score, desiredTier: f.desiredTier,
        skeptic: f.skeptic, prevalence: f.prevalence, revision: f.revision ?? 1 }];
    });
    return { items, nextOffset: rows.length > 50 ? offset + 50 : null };
  }
  calibration(target: Target, person: Principal) { this.authorize(target, person); return calibration(this.store, target, ['small', 'large']); }
  async decide(input: { id: string; contentHash: string; outcome: 'accepted' | 'rejected'; staleAction?: 'correct' | 'forget' }, person: Principal, call: PublicMemoryCall) {
    if (this.#deciding.has(input.id)) throw unavailable('decision-in-progress');
    this.#deciding.add(input.id);
    try {
      const { finding: f, contentHash } = this.get(input.id, person);
      if (contentHash !== input.contentHash) throw new RpcError('E_INVALID_PARAMS', 'Finding changed; reload review', { reason: 'finding-changed' });
      if (f.status !== 'pending' || f.kind !== 'knowledge') throw unavailable(f.kind === 'procedural' ? 'waiting-h3' : 'finding-not-pending');
      const inProgress = this.store.action(f.id, f.revision ?? 1);
      if (inProgress && inProgress.state !== 'refused') throw unavailable('action-awaits-reconciliation');
      if (input.outcome === 'rejected') { this.store.decide(f.id, person.userId, 'rejected', this.#o.now(), {}); this.#o.metrics?.learnFinding(f.desiredTier, 'rejected'); return { status: 'rejected' }; }
      const caller = { channel: 'cli', accountId: 'learn-review', userId: person.userId };
      let method: string, params: Record<string, unknown>;
      if (f.change === 'add') {
        if (f.target.scope !== 'agent') throw unavailable('unsupported-target');
        method = 'memory.importText.apply';
        params = { entries: [{ category: 'Other', sourceType: 'chat', text: f.text, warnings: [], idempotencyKey: `learn-${f.id}-${f.revision ?? 1}` }],
          targets: [{ target: 'agent', agentIds: [f.target.agentId] }], dryRun: false };
      } else {
        if (!f.memoryId) throw unavailable('memory-id-required');
        const shown = await call('memory.show', { agentId: f.target.agentId, id: f.memoryId, caller }) as { card?: LearnCard };
        const card = shown?.card;
        if (!card || card.scope !== (f.target.scope === 'project' ? 'workspace' : 'agent-private')) throw denied();
        const action = f.change === 'stale' ? input.staleAction : f.change === 'correct' ? 'correct' : 'forget';
        if (!action) throw unavailable('stale-choice-required');
        if (card.sharedBy) { method = 'memory.propose'; params = { agentId: f.target.agentId, sharedId: f.memoryId, text: f.text, caller }; }
        else if (action === 'correct') { method = 'memory.correct'; params = { agentId: f.target.agentId, id: f.memoryId, text: f.text, caller }; }
        else { method = 'memory.forget'; params = { agentId: f.target.agentId, id: f.memoryId, caller }; }
      }
      // Recheck after awaited reads and journal before the first public mutation.
      if (this.get(input.id, this.person(person.userId)).contentHash !== input.contentHash) throw unavailable('finding-changed');
      this.store.startAction(f);
      let result: Record<string, unknown>;
      try { result = await call(method, params) as Record<string, unknown>; }
      catch (e) {
        if (e instanceof RpcError && ['E_DENIED', 'E_INVALID_PARAMS', 'E_UNAUTHORIZED'].includes(e.error)) this.store.finishAction(f, 'refused', {});
        throw e;
      }
      const receipt: Record<string, string | number> = { operation: method };
      for (const key of ['runId', 'proposalId', 'id', 'tombstoneId']) if (typeof result[key] === 'string') receipt[key] = result[key];
      if (method === 'memory.importText.apply' && (typeof result.runId !== 'string' || !(Number(result.imported) + Number(result.linked) >= 1))) throw unavailable('import-not-applied');
      this.store.decide(f.id, person.userId, 'accepted', this.#o.now(), receipt); this.#o.metrics?.learnFinding(f.desiredTier, 'accepted');
      this.store.finishAction(f, 'completed', receipt);
      return { status: 'accepted', receipt };
    } finally { this.#deciding.delete(input.id); }
  }
  async rollback(id: string, person: Principal, call: PublicMemoryCall) {
    const { finding } = this.get(id, person), action = this.store.action(id, finding.revision ?? 1);
    if (action?.state !== 'completed' || action.receipt.operation !== 'memory.importText.apply' || typeof action.receipt.runId !== 'string') throw unavailable('rollback-unavailable');
    return call('memory.importText.rollback', { runId: action.receipt.runId });
  }
  async close(): Promise<void> { await this.runner.idle(); this.#offErasure?.(); this.store.close(); }
}
