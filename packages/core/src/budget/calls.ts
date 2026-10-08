// Persistent pre-call port. No provider, session, RPC, logging or prompt-content dependency.
import { randomUUID } from 'node:crypto';
import { openBudgetDb, transaction, BudgetStoreError } from './store.ts';
import { periodBounds, validateTimeZone, type CallPeriod } from './period.ts';
import { PriceBook, costMicros, mediaCostMicros, type MediaUnits, type TokenCounts } from './prices.ts';
import { BudgetInputError, type Metric } from './service.ts';

export type CallScope = 'global' | 'user' | 'project' | 'agent' | 'turn' | 'session';
export interface CallRequest {
  principal: string; agent: string; project: string; model: string; provider?: string;
  estimatedInputTokens: number; maxOutputTokens: number;
  turn?: string; session?: string; media?: readonly MediaUnits[];
}
export interface CallLimit { scope: CallScope; id: string; period: CallPeriod; metric: Metric; hard: number; soft?: number }
export interface CallRefusal {
  kind: 'refuse'; code: 'budget_exceeded'; reason: 'hard' | 'unpriced-model';
  scope: CallScope; limit: number; used: number; estimate: number | null; metric: Metric; id: string; resetsAt: number;
}
export interface CallAllowance { kind: 'allow'; reservationId: string; estimatedCostMicros: number | null }
export type CallDecision = CallAllowance | CallRefusal;
export type CallBudgetEvent =
  | { type: 'warn'; scope: CallScope; id: string; used: number; limit: number; metric: Metric }
  | { type: 'refuse'; refusal: CallRefusal }
  | { type: 'reserve'; reservationId: string; tokens: number; costMicros: number | null }
  | { type: 'settle'; reservationId: string; tokens: number; costMicros: number | null; overages: CallRefusal[] };
export interface BudgetEmitter { emit(event: CallBudgetEvent): void }
export interface CallBudgetOptions {
  path: string; clock: { now(): number }; prices: PriceBook; emitter?: BudgetEmitter; defaultTimeZone?: string;
  securePath?: (p: string, o?: { mode?: number }) => void; busyTimeoutMs?: number;
}
export interface ActualCallUsage { inputTokens: number; outputTokens: number; cacheReadTokens?: number; cacheWriteTokens?: number; media?: readonly MediaUnits[] }
export interface Settlement { recorded: boolean; costMicros: number | null; overages: CallRefusal[] }
export class CallBudgetExceededError extends Error {
  readonly code = 'budget_exceeded';
  readonly refusal: CallRefusal;
  constructor(refusal: CallRefusal) {
    super(`budget exceeded: ${refusal.scope} ${refusal.id} ${refusal.metric}, limit ${refusal.limit}, used ${refusal.used}, estimate ${refusal.estimate ?? 'unpriced'}`);
    this.name = 'CallBudgetExceededError'; this.refusal = refusal;
  }
}
export class CallUsagePendingError extends Error {
  readonly code = 'budget_usage_pending';
  readonly reservationId: string;
  constructor(reservationId: string, cause: unknown) {
    super('call failed without settled usage; reconcile the budget reservation', { cause });
    this.name = 'CallUsagePendingError'; this.reservationId = reservationId;
  }
}
const id = (v: unknown): string => {
  if (typeof v !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:/@+=-]{0,127}$/.test(v)) throw new BudgetInputError('invalid budget identifier');
  return v;
};
const count = (v: number): number => {
  if (!Number.isSafeInteger(v) || v < 0) throw new BudgetInputError('invalid budget count');
  return v;
};
const closed = (value: object, keys: readonly string[]) => {
  if (!value || typeof value !== 'object') throw new BudgetInputError('expected budget object');
  for (const key of Object.keys(value)) if (!keys.includes(key)) throw new BudgetInputError(`unknown property ${key}`);
};
interface CallRow {
  id: string; principal: string; project: string; agent: string; model: string; provider: string;
  turn: string; session: string; ts: number; tokens: number; cost: number | null; state: string;
}
interface LimitRow { scope: CallScope; id: string; period: CallPeriod; metric: Metric; hard: number | null; soft: number }
const COLUMN: Record<CallScope, string> = { global: '', user: 'principal', project: 'project', agent: 'agent', turn: 'turn', session: 'session' };

export function createCallBudget(o: CallBudgetOptions) {
  const defaultZone = validateTimeZone(o.defaultTimeZone ?? 'UTC');
  const db = openBudgetDb(o);
  // Additive, lazy extension: old RPC service/store shape stays compatible. No prompt/result columns.
  try {
    transaction(db, () => {
      const schema = db.prepare("SELECT value FROM settings WHERE key='budget_call_schema'").get() as { value: string } | undefined;
      if (schema && schema.value !== '1') throw new BudgetStoreError('newer-schema', 'unsupported budget call schema');
      db.exec(`
      CREATE TABLE IF NOT EXISTS budget_call (
        id TEXT PRIMARY KEY, principal TEXT NOT NULL, project TEXT NOT NULL, agent TEXT NOT NULL,
        model TEXT NOT NULL, provider TEXT NOT NULL, turn TEXT NOT NULL, session TEXT NOT NULL,
        ts INTEGER NOT NULL, tokens INTEGER NOT NULL CHECK(tokens >= 0), cost INTEGER CHECK(cost >= 0),
        state TEXT NOT NULL CHECK(state IN ('reserved','settled'))
      );
      CREATE INDEX IF NOT EXISTS budget_call_state_ts ON budget_call(state, ts);
      CREATE TABLE IF NOT EXISTS budget_call_limit (
        scope TEXT NOT NULL, id TEXT NOT NULL, period TEXT NOT NULL, metric TEXT NOT NULL,
        hard INTEGER NOT NULL CHECK(hard >= 0), soft INTEGER NOT NULL CHECK(soft >= 0 AND soft <= hard),
        PRIMARY KEY(scope,id,period,metric)
      );
      CREATE TABLE IF NOT EXISTS budget_call_notice (
        scope TEXT NOT NULL, id TEXT NOT NULL, period TEXT NOT NULL, metric TEXT NOT NULL, period_key TEXT NOT NULL,
        PRIMARY KEY(scope,id,period,metric,period_key)
      );
    `);
      db.prepare("INSERT OR IGNORE INTO settings VALUES ('budget_call_schema','1')").run();
    });
  } catch (e) { db.close(); throw e; }
  const emit = (e: CallBudgetEvent) => { try { o.emitter?.emit(e); } catch { /* audit availability must not corrupt committed accounting */ } };
  const zone = () => {
    const row = db.prepare("SELECT value FROM settings WHERE key='timezone'").get() as { value: string } | undefined;
    return validateTimeZone(row?.value ?? defaultZone);
  };
  function limits(r: CallRow): LimitRow[] {
    const own = db.prepare('SELECT * FROM budget_call_limit').all() as unknown as LimitRow[];
    const legacy = db.prepare('SELECT * FROM budget_limit').all() as unknown as { scope: 'global' | 'agent'; agent: string; period: CallPeriod; metric: Metric; hard: number | null; soft: number | null }[];
    return [...own, ...legacy.map(l => ({ ...l, id: l.agent, soft: l.soft ?? Math.floor((l.hard ?? 0) * 0.8) }))]
      .filter(l => l.scope === 'global' || (r[COLUMN[l.scope] as keyof CallRow] !== '' && r[COLUMN[l.scope] as keyof CallRow] === l.id));
  }
  function usage(l: LimitRow, ts: number): { used: number; unpriced: number; key: string; end: number } {
    const lifetime = l.scope === 'turn' || l.scope === 'session';
    const b = lifetime ? { start: 0, end: 8640000000000000, key: l.id } : periodBounds(ts, zone(), l.period);
    const col = COLUMN[l.scope];
    const filter = col ? ` AND ${col} = ?` : '';
    const params = col ? [l.id] : [];
    const amount = l.metric === 'cost' ? 'cost' : 'tokens';
    // All pending estimates count even across rollover, so a stalled request cannot free capacity.
    const reserved = db.prepare(`SELECT COALESCE(SUM(${amount}),0) AS n, COALESCE(SUM(cost IS NULL),0) AS u FROM budget_call WHERE state='reserved'${filter}`).get(...params) as { n: number; u: number };
    let settled: { n: number; u: number };
    if (l.scope === 'global' || l.scope === 'agent') {
      const where = l.scope === 'agent' ? ' AND agent=?' : '';
      settled = db.prepare(`SELECT COALESCE(SUM(${l.metric === 'cost' ? 'cost_micros' : 'input_tokens+output_tokens'}),0) AS n, COALESCE(SUM(cost_micros IS NULL),0) AS u FROM usage_event WHERE ts>=? AND ts<?${where}`).get(b.start, b.end, ...(l.scope === 'agent' ? [l.id] : [])) as { n: number; u: number };
    } else {
      settled = db.prepare(`SELECT COALESCE(SUM(${amount}),0) AS n, COALESCE(SUM(cost IS NULL),0) AS u FROM budget_call WHERE state='settled' AND ts>=? AND ts<?${filter}`).get(b.start, b.end, ...params) as { n: number; u: number };
    }
    return { used: count(Number(reserved.n) + Number(settled.n)), unpriced: Number(reserved.u) + Number(settled.u), key: b.key, end: b.end };
  }
  function breaches(r: CallRow, tokens: number, cost: number | null, ts: number): CallRefusal[] {
    return limits(r).flatMap(l => {
      if (l.hard === null) return [];
      const u = usage(l, ts), estimate = l.metric === 'cost' ? cost : tokens;
      const unpriced = l.metric === 'cost' && (estimate === null || u.unpriced > 0);
      if (!unpriced && estimate! <= l.hard - u.used) return [];
      return [{ kind: 'refuse' as const, code: 'budget_exceeded' as const, reason: unpriced ? 'unpriced-model' as const : 'hard' as const, scope: l.scope, id: l.id, metric: l.metric, limit: l.hard, used: u.used, estimate, resetsAt: u.end }];
    }).sort((a, b) => (a.limit - a.used) - (b.limit - b.used));
  }
  function warnings(r: CallRow, tokens: number, cost: number | null, ts: number, events: CallBudgetEvent[]): void {
    for (const l of limits(r)) {
      const u = usage(l, ts), n = l.metric === 'cost' ? cost : tokens;
      if (n !== null && u.used + n >= l.soft) {
        const first = db.prepare('INSERT OR IGNORE INTO budget_call_notice VALUES (?,?,?,?,?)').run(l.scope, l.id, l.period, l.metric, u.key);
        if (first.changes) events.push({ type: 'warn', scope: l.scope, id: l.id, metric: l.metric, used: u.used + n, limit: l.soft });
      }
    }
  }
  const price = (model: string, provider: string, ts: number, u: TokenCounts, media: readonly MediaUnits[] = []) => {
    const table = o.prices.at(ts);
    if (!table) return null;
    const tokenCost = costMicros(table, model, provider || undefined, u);
    const mediaCost = mediaCostMicros(table, model, provider || undefined, media);
    return tokenCost === null || mediaCost === null ? null : count(tokenCost + mediaCost);
  };
  function setLimit(l: CallLimit): void {
    closed(l, ['scope', 'id', 'period', 'metric', 'hard', 'soft']);
    if (!Object.hasOwn(COLUMN, l.scope) || !['day', 'week', 'month'].includes(l.period) || !['cost', 'tokens'].includes(l.metric)) throw new BudgetInputError('invalid call limit');
    if (l.scope === 'global' ? l.id !== '' : !id(l.id)) throw new BudgetInputError('invalid limit id');
    count(l.hard); const soft = count(l.soft ?? Math.floor((l.hard ?? 0) * 0.8));
    if (soft > l.hard) throw new BudgetInputError('soft exceeds hard');
    db.prepare('INSERT INTO budget_call_limit VALUES (?,?,?,?,?,?) ON CONFLICT(scope,id,period,metric) DO UPDATE SET hard=excluded.hard, soft=excluded.soft').run(l.scope, l.id, l.period, l.metric, l.hard, soft);
  }
  function checkBeforeCall(request: CallRequest): CallDecision {
    closed(request, ['principal', 'agent', 'project', 'model', 'provider', 'estimatedInputTokens', 'maxOutputTokens', 'turn', 'session', 'media']);
    for (const field of ['principal', 'agent', 'project', 'model'] as const) id(request[field]);
    for (const field of ['provider', 'turn', 'session'] as const) if (request[field] !== undefined) id(request[field]);
    const ts = count(o.clock.now()), tokens = count(count(request.estimatedInputTokens) + count(request.maxOutputTokens));
    const r: CallRow = { id: randomUUID(), principal: request.principal, project: request.project, agent: request.agent, model: request.model, provider: request.provider ?? '', turn: request.turn ?? '', session: request.session ?? '', ts, tokens, cost: price(request.model, request.provider ?? '', ts, { inputTokens: request.estimatedInputTokens, outputTokens: request.maxOutputTokens, cacheReadTokens: 0, cacheWriteTokens: 0 }, request.media), state: 'reserved' };
    const events: CallBudgetEvent[] = [];
    const decision = transaction(db, (): CallDecision => {
      const refusal = breaches(r, r.tokens, r.cost, ts)[0];
      if (refusal) { events.push({ type: 'refuse', refusal }); return refusal; }
      warnings(r, tokens, r.cost, ts, events);
      db.prepare('INSERT INTO budget_call VALUES (?,?,?,?,?,?,?,?,?,?,?,?)').run(r.id, r.principal, r.project, r.agent, r.model, r.provider, r.turn, r.session, r.ts, r.tokens, r.cost, r.state);
      events.push({ type: 'reserve', reservationId: r.id, tokens, costMicros: r.cost });
      return { kind: 'allow', reservationId: r.id, estimatedCostMicros: r.cost };
    });
    events.forEach(emit); return decision;
  }
  function settle(reservationId: string, actual: ActualCallUsage): Settlement {
    id(reservationId); closed(actual, ['inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens', 'media']);
    const u = { inputTokens: count(actual.inputTokens), outputTokens: count(actual.outputTokens), cacheReadTokens: count(actual.cacheReadTokens ?? 0), cacheWriteTokens: count(actual.cacheWriteTokens ?? 0) };
    const events: CallBudgetEvent[] = [];
    const result = transaction(db, (): Settlement => {
      const r = db.prepare('SELECT * FROM budget_call WHERE id=?').get(reservationId) as unknown as CallRow | undefined;
      if (!r) throw new BudgetInputError('unknown reservation');
      if (r.state === 'settled') return { recorded: false, costMicros: r.cost, overages: [] };
      const cost = price(r.model, r.provider, r.ts, u, actual.media), tokens = count(u.inputTokens + u.outputTokens);
      db.prepare("UPDATE budget_call SET state='settled',tokens=?,cost=? WHERE id=?").run(tokens, cost, r.id);
      db.prepare('INSERT INTO usage_event (ts,agent,provider,model,input_tokens,output_tokens,cache_read_tokens,cache_write_tokens,cost_micros,price_version,request_id) VALUES (?,?,?,?,?,?,?,?,?,?,?)').run(r.ts, r.agent, r.provider, r.model, u.inputTokens, u.outputTokens, u.cacheReadTokens, u.cacheWriteTokens, cost, o.prices.at(r.ts)?.version ?? 'unpriced', `budget-call:${r.id}`);
      warnings(r, 0, 0, r.ts, events);
      return { recorded: true, costMicros: cost, overages: breaches(r, 0, 0, r.ts) };
    });
    events.forEach(emit);
    if (result.recorded) emit({ type: 'settle', reservationId, tokens: u.inputTokens + u.outputTokens, costMicros: result.costMicros, overages: result.overages });
    return result;
  }
  return {
    setLimit, checkBeforeCall, settle,
    /** Only a caller that has NOT invoked the provider may release a refused retry's unused reservation. */
    releaseUnused(reservationId: string): void {
      id(reservationId);
      db.prepare("DELETE FROM budget_call WHERE id=? AND state='reserved'").run(reservationId);
    },
    clearLimit(l: Pick<CallLimit, 'scope' | 'id' | 'period' | 'metric'>): void { db.prepare('DELETE FROM budget_call_limit WHERE scope=? AND id=? AND period=? AND metric=?').run(l.scope, l.id, l.period, l.metric); },
    /** Convenience provider hook. On failure without authoritative usage, keep reservation until reconciled by settle. */
    async run<T>(request: CallRequest, invoke: () => Promise<{ value: T; usage: ActualCallUsage }>): Promise<T> {
      const decision = checkBeforeCall(request);
      if (decision.kind === 'refuse') throw new CallBudgetExceededError(decision);
      try {
        const result = await invoke();
        settle(decision.reservationId, result.usage); return result.value;
      } catch (cause) { throw new CallUsagePendingError(decision.reservationId, cause); }
    },
    close(): void { db.close(); },
  };
}
export type CallBudget = ReturnType<typeof createCallBudget>;
