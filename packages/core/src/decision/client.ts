import { randomUUID } from 'node:crypto';
import { localOnlyFor } from '../privacy/local-only.ts';
import { triage, type TriageDecision } from '../triage/index.ts';
import { DecisionBackendError, type DecisionBackendName, type DecisionContext, type DecisionEvent, type DecisionFailure, type DecisionInput, type DecisionOptions, type DecisionPrimitive, type DecisionRequest, type DecisionResult, type ChoiceInput, type ScoreInput } from './types.ts';
const budgets = { triage: 2000, routing: 200, pruning: 100, skills: 2000, placement: 200, zoom: 150, compaction: 200 };
const floors = { triage: 0, routing: .7, pruning: .7, skills: .7, placement: .7, zoom: .35, compaction: .7 };
const unit = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 1;
const text = (v: unknown, max: number): v is string => typeof v === 'string' && v.length <= max;
const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
function distribution(values: unknown[], length: number): values is number[] { return values.length === length && values.every(unit) && Math.abs((values as number[]).reduce((a, b) => a + b, 0) - 1) <= 1e-6; }
/** One service per composition. Only bounded aggregates survive outside the authorised turn store. */
export class DecisionClient {
  readonly #options: DecisionOptions;
  #requests = 0; #failures = 0; readonly #samples: number[] = [];
  readonly #backends: Record<string, { requests: number; failures: number }> = {};
  constructor(options: DecisionOptions) { this.#options = options; }
  status() {
    const sorted = [...this.#samples].sort((a, b) => a - b);
    const percentile = (p: number) => sorted.length ? sorted[Math.ceil(sorted.length * p) - 1]! : 0;
    return { backend: String(this.#options.config().decision.backend ?? 'role'), installed: Object.keys(this.#options.backends), requests: this.#requests, failures: this.#failures, errorRate: this.#requests ? this.#failures / this.#requests : 0, p50Ms: percentile(.5), p95Ms: percentile(.95), backends: structuredClone(this.#backends) };
  }
  noul(input: DecisionInput, context: DecisionContext) { return this.#run<{ probability: number }>('noul', input, context); }
  choice(input: ChoiceInput, context: DecisionContext) { return this.#run<{ id: string; probabilities: Record<string, number> }>('choice', input, context); }
  score(input: ScoreInput, context: DecisionContext) { return this.#run<{ score: number; probabilities: number[] }>('score', input, context); }
  /** D105 compatibility bridge, not a fourth portable primitive. */
  triage(message: string, context: DecisionContext) { return this.#run<TriageDecision>('triage-compat', { useCase: 'triage', state: message, question: 'Classify the message using plur1bus.triage/1.' }, context); }
  async #run<T>(primitive: DecisionPrimitive, input: DecisionInput | ChoiceInput | ScoreInput, context: DecisionContext): Promise<DecisionResult<T>> {
    const started = performance.now(), requestId = randomUUID(), attempted: DecisionBackendName[] = [];
    const config = this.#options.config(), settings = config.decision;
    const selected = String(settings.backend ?? 'role');
    const cap = (settings.budgets as Record<string, number> | undefined)?.[input.useCase] ?? budgets[input.useCase];
    const deadline = Math.min(context.deadline ?? Infinity, started + Math.min(Number(settings.timeoutMs ?? 2000), cap));
    const floor = (settings.confidence as Record<string, number> | undefined)?.[input.useCase] ?? floors[input.useCase];
    const finish = (result: DecisionResult<T>): DecisionResult<T> => {
      this.#requests++; if (!result.ok) this.#failures++;
      this.#samples.push(result.elapsedMs); if (this.#samples.length > 512) this.#samples.shift();
      const event: DecisionEvent = { requestId, primitive, useCase: input.useCase, attempted: [...attempted], elapsedMs: result.elapsedMs, outcome: result.ok ? 'accepted' : result.reason, reasonCode: result.ok ? 'accepted' : result.reason, ...(result.ok ? { backend: result.backend, ...(result.modelRevision ? { modelRevision: result.modelRevision } : {}), confidence: result.confidence, confidenceSource: result.confidenceSource } : {}) };
      try { this.#options.emit?.(context, event); } catch { /* Telemetry cannot invalidate admission. */ }
      return result;
    };
    const fail = (reason: DecisionFailure) => finish({ ok: false, requestId, elapsedMs: performance.now() - started, reason, attempted: [...attempted] });
    if (context.signal.aborted) return fail('cancelled');
    if (!this.#validInput(primitive, input) || !Number.isFinite(deadline)) return fail('invalid');
    const order: DecisionBackendName[] = primitive === 'triage-compat' ? ['role'] : selected === 'auto' ? ['jev', 'kev', 'laya', 'role'] : [...new Set([selected as DecisionBackendName, 'role' as const])];
    let failure: DecisionFailure = 'unavailable';
    for (const name of order) {
      if (context.signal.aborted) return fail('cancelled');
      if (performance.now() >= deadline) return fail('timeout');
      const backend = this.#options.backends[name]; if (!backend) continue;
      if (name === 'jev' && context.cloudEligible !== true) {
        if (selected === 'jev') return fail('privacy');
        failure = 'privacy'; continue;
      }
      if (selected === 'auto' && (name === 'laya' || name === 'kev') && !backend.eligible) continue;
      let local: boolean | undefined;
      try {
        if (backend.eligible && !backend.eligible(context)) continue;
        local = backend.local(context);
      } catch { failure = 'unavailable'; continue; }
      const current = this.#options.config();
      // Cloud content eligibility is a caller policy; raw tool output sets forceLocal.
      const localRequired = context.forceLocal || localOnlyFor(current, context.agentId);
      if (local === undefined) continue;
      if (localRequired && !local) { if (selected !== 'auto' && name === selected) return fail('privacy'); failure = 'privacy'; continue; }
      attempted.push(name);
      const metric = this.#backends[name] ??= { requests: 0, failures: 0 }; metric.requests++;
      const controller = new AbortController();
      const abort = () => controller.abort(context.signal.reason);
      context.signal.addEventListener('abort', abort, { once: true }); if (context.signal.aborted) abort();
      const timer = setTimeout(() => controller.abort(new DecisionBackendError('timeout')), Math.max(0, deadline - performance.now()));
      let off: (() => void) | undefined;
      try {
        const request: DecisionRequest = { ...input, requestId, primitive, deadline, context };
        const raw = await Promise.race([Promise.resolve().then(() => backend.run(request, controller.signal)), new Promise<never>((_, reject) => {
          const interrupted = () => reject(new DecisionBackendError(context.signal.aborted ? 'cancelled' : 'timeout'));
          off = () => controller.signal.removeEventListener('abort', interrupted);
          controller.signal.addEventListener('abort', interrupted, { once: true }); if (controller.signal.aborted) interrupted();
        })]);
        if (context.signal.aborted) throw new DecisionBackendError('cancelled');
        if (performance.now() >= deadline) throw new DecisionBackendError('timeout');
        const normalized = this.#normalize(primitive, input, raw);
        if (normalized.confidence < floor) throw new DecisionBackendError('low-confidence');
        return finish({ ok: true, requestId, elapsedMs: performance.now() - started, backend: name, ...(object(raw) && text(raw.modelRevision, 256) ? { modelRevision: raw.modelRevision } : {}), value: normalized.value as T, confidence: normalized.confidence, confidenceSource: primitive === 'noul' ? 'derived' : name === 'role' ? 'uncalibrated' : 'backend', reasonCode: 'accepted' });
      } catch (error) {
        metric.failures++;
        failure = error instanceof DecisionBackendError ? error.reason : 'invalid';
        if (failure === 'privacy' || failure === 'cancelled' || failure === 'timeout') return fail(failure);
      } finally { clearTimeout(timer); off?.(); context.signal.removeEventListener('abort', abort); }
    }
    return fail(failure);
  }
  #validInput(primitive: DecisionPrimitive, input: DecisionInput | ChoiceInput | ScoreInput): boolean {
    if (!Object.hasOwn(budgets, input.useCase) || !text(input.state, primitive === 'triage-compat' ? 200_000 : 16_384) || !text(input.question, 2048)) return false;
    if (input.features && (Object.keys(input.features).length > 32 || Object.values(input.features).some(v => !(typeof v === 'boolean' || (typeof v === 'number' && Number.isFinite(v)) || text(v, 1024))))) return false;
    if (primitive === 'choice') { const options = (input as ChoiceInput).options; return Array.isArray(options) && options.length >= 2 && options.length <= 255 && new Set(options.map(o => o.id)).size === options.length && options.every(o => text(o.id, 128) && o.id.length > 0 && text(o.description, 1024)); }
    if (primitive === 'score') { const levels = (input as ScoreInput).levels; return Array.isArray(levels) && levels.length >= 2 && levels.length <= 10 && levels.every(l => text(l, 1024) && l.length > 0); }
    return true;
  }
  #normalize(primitive: DecisionPrimitive, input: DecisionInput, raw: unknown): { value: unknown; confidence: number } {
    if (!object(raw) || JSON.stringify(raw).length > 65_536) throw new DecisionBackendError('invalid');
    if (primitive === 'triage-compat') {
      const { modelRevision: _modelRevision, ...payload } = raw;
      const value = triage(input.state, { classifier: () => payload as unknown as TriageDecision });
      if (value.tasks.length > 32 || (['chat', 'followup'].includes(value.shape) && value.tasks.length) || (value.shape === 'single' && value.tasks.length !== 1) || (value.shape === 'multi' && value.tasks.length < 2)) throw new DecisionBackendError('invalid');
      return { value, confidence: Math.min(1, ...value.tasks.map(t => t.confidence)) };
    }
    if (primitive === 'noul') { if (!unit(raw.probability)) throw new DecisionBackendError('invalid'); return { value: { probability: raw.probability }, confidence: Math.max(raw.probability, 1 - raw.probability) }; }
    if (!unit(raw.confidence)) throw new DecisionBackendError('invalid');
    if (primitive === 'choice') {
      const options = (input as ChoiceInput).options, ids = options.map(o => o.id);
      if (typeof raw.id !== 'string' || !ids.includes(raw.id) || !object(raw.probabilities) || Object.keys(raw.probabilities).some(id => !ids.includes(id))) throw new DecisionBackendError('invalid');
      const probabilities = ids.map(id => (raw.probabilities as Record<string, unknown>)[id]);
      if (!distribution(probabilities, ids.length) || raw.probabilities[raw.id] !== Math.max(...probabilities)) throw new DecisionBackendError('invalid');
      return { value: { id: raw.id, probabilities: Object.fromEntries(ids.map((id, i) => [id, probabilities[i]])) }, confidence: raw.confidence };
    }
    const count = (input as ScoreInput).levels.length;
    if (!Array.isArray(raw.probabilities) || !distribution(raw.probabilities, count)) throw new DecisionBackendError('invalid');
    return { value: { score: raw.probabilities.reduce((sum, p, i) => sum + p * i, 0), probabilities: [...raw.probabilities] }, confidence: raw.confidence };
  }
}
