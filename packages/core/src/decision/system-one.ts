// One bounded System One transport. No SDK, retries, discovery, raw response logging or model installation.
import type { HarnessConfig } from '@plur1bus/config-schema';
import type { Egress } from '../egress/service.ts';
import type { SecretStore } from '../secrets/store.ts';
import type { CallBudget, ActualCallUsage } from '../budget/calls.ts';
import { localOnlyFor } from '../privacy/local-only.ts';
import { WebFailure } from '../tools/web/failure.ts';
import { DecisionBackendError, type DecisionBackend, type DecisionRequest } from './types.ts';

const BYTE_CAP = 65_536;
const MAX_OUTPUT = 65_536; // finite conservative reservation; never a request for generated prose
const JEV_URL = 'https://api.typesafe.ai/v1/systemone';
interface Settings { enabled?: boolean; model?: string; secretRef?: string; endpoint?: string }
interface Options {
  config(): HarnessConfig; egress: Egress; secrets: Pick<SecretStore, 'lease' | 'readLease' | 'revokeLease'>;
  budget: CallBudget | null;
  /** Internal loopback test seam. Never read from configuration. */
  testOrigin?: string;
  /** Native spike admission, not a config flag. Absent means Kev is unavailable even when explicitly selected. */
  kevEligible?: () => boolean;
}
const invalid = (): never => { throw new DecisionBackendError('invalid'); };
const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const unit = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 1;
function closed(v: unknown, keys: readonly string[]): asserts v is Record<string, unknown> {
  if (!object(v) || Object.keys(v).some(k => !keys.includes(k))) invalid();
}
function literalLoopback(raw: string, path: string): boolean {
  try {
    const u = new URL(raw);
    return /^https?:\/\/(?:127(?:\.\d{1,3}){3}|\[::1\])(?::\d{1,5})?(?:\/v1\/systemone)?$/.test(raw) &&
      ['http:', 'https:'].includes(u.protocol) && !u.username && !u.password && !u.search && !u.hash && u.pathname === path;
  } catch { return false; }
}
function distribution(raw: unknown, keys: readonly string[], kind: 'jev' | 'kev'): number[] {
  closed(raw, keys);
  if (Object.keys(raw).length !== keys.length) invalid();
  const values = keys.map(k => { const value = raw[k]; if (!unit(value)) invalid(); return value as number; });
  const sum = values.reduce((s, v) => s + v, 0);
  // Kev's documented four-decimal API rounding can move a K-way sum by at most K * 0.00005.
  const tolerance = kind === 'kev' ? keys.length * .00005 + 1e-12 : 1e-6;
  if (sum <= 0 || Math.abs(sum - 1) > tolerance) invalid();
  return values.map(v => v / sum);
}
function usage(raw: unknown): ActualCallUsage | undefined {
  if (!object(raw) || Object.keys(raw).some(k => !['input_tokens', 'output_tokens'].includes(k))) return undefined;
  const count = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0;
  if (!count(raw.input_tokens) || !count(raw.output_tokens) || !Number.isSafeInteger(raw.input_tokens + raw.output_tokens)) return undefined;
  return { inputTokens: raw.input_tokens, outputTokens: raw.output_tokens };
}
function normalize(raw: unknown, request: DecisionRequest, kind: 'jev' | 'kev', model: string): unknown {
  closed(raw, kind === 'kev' ? ['model', 'answers', 'usage', 'latency_ms'] : ['model', 'answers', 'usage']);
  if (raw.model !== model || !usage(raw.usage)) invalid();
  if (raw.latency_ms !== undefined && (typeof raw.latency_ms !== 'number' || !Number.isFinite(raw.latency_ms) || raw.latency_ms < 0)) invalid();
  closed(raw.answers, ['decision']); const answer = raw.answers.decision;
  if (request.primitive === 'noul') {
    closed(answer, ['type', 'noul']); if (answer.type !== 'noul' || !unit(answer.noul)) invalid();
    return { probability: answer.noul, modelRevision: model };
  }
  if (request.primitive === 'choice') {
    closed(answer, ['type', 'choice', 'confidence', 'probabilities']);
    const keys = request.options!.map(o => o.id), values = distribution(answer.probabilities, keys, kind);
    if (answer.type !== 'choice' || typeof answer.choice !== 'string' || !unit(answer.confidence) || !keys.includes(answer.choice) || values[keys.indexOf(answer.choice)] !== Math.max(...values)) invalid();
    return { id: answer.choice, probabilities: Object.fromEntries(keys.map((k, i) => [k, values[i]])), confidence: answer.confidence, modelRevision: model };
  }
  if (request.primitive !== 'score') invalid();
  closed(answer, ['type', 'score', 'legend', 'confidence', 'probabilities']);
  const keys = request.levels!.map((_, i) => String(i)), values = distribution(answer.probabilities, keys, kind);
  const legend = answer.legend; closed(legend, keys);
  if (Object.keys(legend).length !== keys.length || keys.some((k, i) => legend[k] !== request.levels![i])) invalid();
  const expected = values.reduce((s, p, i) => s + p * i, 0);
  if (answer.type !== 'score' || !unit(answer.confidence) || typeof answer.score !== 'number' || !Number.isFinite(answer.score) || answer.score < 0 || answer.score > keys.length - 1 || Math.abs(answer.score - expected) > (kind === 'kev' ? .00005 * keys.length ** 2 + 1e-12 : 1e-6)) invalid();
  return { probabilities: values, confidence: answer.confidence, modelRevision: model };
}

export function createSystemOneBackend(kind: 'jev' | 'kev', o: Options): DecisionBackend {
  if (o.testOrigin !== undefined && !literalLoopback(o.testOrigin, '/')) throw new DecisionBackendError('unavailable');
  const settings = (): Settings => {
    const cfg = o.config().decision.systemOne;
    return object(cfg) && object(cfg[kind]) ? cfg[kind] as Settings : {};
  };
  const available = () => {
    const s = settings();
    if (s.enabled !== true || !o.budget) return false;
    if (kind === 'jev') return s.model === 'jev-1.13.0' && typeof s.secretRef === 'string' && s.secretRef.length > 0;
    return o.kevEligible?.() === true && typeof s.model === 'string' && /^[A-Za-z0-9._/@-]{1,128}$/.test(s.model) && typeof s.endpoint === 'string' && literalLoopback(s.endpoint, '/v1/systemone');
  };
  return {
    local: () => available() ? kind === 'kev' : undefined,
    eligible: () => available(),
    async run(request, signal) {
      const interrupted = () => { if (signal.aborted || request.context.signal.aborted) throw new DecisionBackendError('cancelled'); if (performance.now() >= request.deadline) throw new DecisionBackendError('timeout'); };
      interrupted();
      if (request.primitive === 'triage-compat' || !available()) throw new DecisionBackendError('unavailable');
      if (kind === 'jev' && (request.context.cloudEligible !== true || request.context.forceLocal || localOnlyFor(o.config(), request.context.agentId))) throw new DecisionBackendError('privacy');
      const principal = request.context.principal ?? request.context.chat?.principal;
      if (!principal || !request.context.agentId) throw new DecisionBackendError('unavailable');
      const s = { ...settings() }, model = s.model!;
      const question = { type: request.primitive, instructions: request.question,
        ...(request.primitive === 'choice' ? { criteria: Object.fromEntries(request.options!.map(x => [x.id, x.description])) } : request.primitive === 'score' ? { criteria: [...request.levels!] } : {}) };
      const body = JSON.stringify({ model, state: request.features ? { text: request.state, features: request.features } : request.state, questions: { decision: question } });
      const bytes = Buffer.byteLength(body); if (bytes > BYTE_CAP) invalid();
      const estimate = { inputTokens: bytes + 1024, outputTokens: MAX_OUTPUT };
      const reservation = o.budget!.checkBeforeCall({ principal, agent: request.context.agentId, project: request.context.chat?.projectId ?? 'decision', model, provider: kind,
        estimatedInputTokens: estimate.inputTokens, maxOutputTokens: estimate.outputTokens,
        ...(request.context.sessionId ? { session: request.context.sessionId } : {}), ...(request.context.turnId ? { turn: request.context.turnId } : {}) });
      if (reservation.kind === 'refuse') throw new DecisionBackendError('unavailable');
      let leaseId: string | undefined, sent = false, actual: ActualCallUsage | undefined;
      try {
        const headers: Record<string, string> = { 'content-type': 'application/json' };
        if (kind === 'jev') {
          const lease = await o.secrets.lease({ kind: 'core' }, s.secretRef!, { purpose: 'decision', profileId: 'decision-service', ttlMs: Math.max(1, Math.min(60_000, Math.ceil(request.deadline - performance.now()))) });
          leaseId = lease.leaseId; interrupted();
          const fresh = o.secrets.readLease({ kind: 'core' }, leaseId);
          if (fresh.purpose !== 'decision' || fresh.profileId !== 'decision-service' || !fresh.value || fresh.value.length > 4096 || /[\r\n\0]/.test(fresh.value)) throw new DecisionBackendError('unavailable');
          headers.authorization = `Bearer ${fresh.value}`;
        }
        interrupted();
        // Config is live. Do not send if admission was withdrawn while issuing the lease.
        const current = settings();
        if (!available() || current.model !== s.model || current.secretRef !== s.secretRef || current.endpoint !== s.endpoint) throw new DecisionBackendError('unavailable');
        if (kind === 'jev' && (request.context.cloudEligible !== true || request.context.forceLocal || localOnlyFor(o.config(), request.context.agentId))) throw new DecisionBackendError('privacy');
        const remaining = Math.max(1, Math.ceil(request.deadline - performance.now()));
        const deadline = AbortSignal.timeout(remaining);
        sent = true;
        const response = await o.egress.request(kind === 'jev' ? o.testOrigin ? `${o.testOrigin}/v1/systemone` : JEV_URL : s.endpoint!, {
          method: 'POST', headers, body, maxRequestBytes: BYTE_CAP, maxBytes: BYTE_CAP, maxRedirects: 0, errorBodyBytes: 0,
          timeoutMs: remaining, signal: AbortSignal.any([signal, request.context.signal, deadline]), userAgent: 'PLUR1BUS-decision', accept: 'application/json',
          acceptType: type => /^application\/json(?:\s*;|$)/i.test(type ?? ''),
        });
        if (response.status !== 200 || response.body.length > BYTE_CAP) throw new DecisionBackendError('unavailable');
        let raw: unknown;
        try { raw = JSON.parse(response.body.toString('utf8')); } catch { invalid(); }
        actual = object(raw) ? usage(raw.usage) : undefined;
        interrupted();
        return normalize(raw, request, kind, model);
      } catch (error) {
        if (request.context.signal.aborted || signal.aborted) throw new DecisionBackendError('cancelled');
        // Egress reports both of its limits, timeoutMs and the deadline signal, as `timeout`. Node fires those timers on a
        // whole-millisecond loop clock, sometimes just before performance.now() reaches the deadline, so the cause decides.
        if ((error instanceof WebFailure && error.code === 'timeout') || performance.now() >= request.deadline) throw new DecisionBackendError('timeout');
        throw error instanceof DecisionBackendError ? error : new DecisionBackendError('unavailable');
      } finally {
        try {
          if (sent) o.budget!.settle(reservation.reservationId, actual ?? estimate);
          else o.budget!.releaseUnused(reservation.reservationId);
        } finally {
          if (leaseId) {
            try { o.secrets.revokeLease({ kind: 'core' }, leaseId); } catch { throw new DecisionBackendError('unavailable'); }
          }
        }
      }
    },
  };
}
