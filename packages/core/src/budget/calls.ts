// Persistent pre-call port. No provider, session, RPC, logging or prompt-content dependency.
// Counts tokens, calls and media units (images, video seconds); no money dimension anywhere (owner decisions 2026-10-19).
// Output tokens include reported reasoning tokens. The legacy `budget_call.cost` column stays in the store, unused (always NULL).
import { randomUUID } from 'node:crypto';
import { deferMaintenanceStart, type CompositionMaintenance } from '../composition/maintenance.ts';
import { openBudgetDb, transaction, BudgetStoreError } from './store.ts';
import { periodBounds, validateTimeZone, type CallPeriod } from './period.ts';
import { BudgetInputError, METRICS, type Metric } from './service.ts';

export type CallScope = 'global' | 'user' | 'project' | 'agent' | 'turn' | 'session';
export interface CallRequest {
  principal: string; agent: string; project: string; model: string; provider?: string;
  estimatedInputTokens: number; maxOutputTokens: number;
  /** Media units the call asks for (images: `n` per request; video: the requested seconds). Absent: 0. */
  images?: number; videoSeconds?: number;
  turn?: string; session?: string;
}
export interface CallLimit { scope: CallScope; id: string; period: CallPeriod; metric: Metric; hard: number; soft?: number }
export interface CallRefusal {
  kind: 'refuse'; code: 'budget_exceeded'; reason: 'hard';
  scope: CallScope; limit: number; used: number; estimate: number; metric: Metric; id: string; resetsAt: number;
}
/** `estimatedTokens` is what the reservation holds: estimated input plus maximum output; `images`/`videoSeconds` appear when the call reserved any. */
export interface CallAllowance { kind: 'allow'; reservationId: string; estimatedTokens: number; images?: number; videoSeconds?: number }
export type CallDecision = CallAllowance | CallRefusal;
export type CallBudgetEvent =
  | { type: 'warn'; scope: CallScope; id: string; used: number; limit: number; metric: Metric }
  | { type: 'refuse'; refusal: CallRefusal }
  | ({ type: 'reserve'; reservationId: string; tokens: number } & MediaAmounts)
  | ({ type: 'settle'; reservationId: string; tokens: number; overages: CallRefusal[] } & MediaAmounts)
  | { type: 'release'; reservationId: string }
  | ({ type: 'expire'; reservationId: string; tokens: number; reservedAt: number } & MediaAmounts);
export interface BudgetEmitter { emit(event: CallBudgetEvent): void }
export interface CallBudgetOptions {
  maintenance?: CompositionMaintenance;
  path: string; clock: { now(): number }; emitter?: BudgetEmitter; defaultTimeZone?: string;
  securePath?: (p: string, o?: { mode?: number }) => void; busyTimeoutMs?: number;
  /**
   * Safety net for a reservation nobody settles or releases (a crashed process, a caller bug): after `reservedAt + ttl` it no longer
   * counts against any limit, and it is reconciled (released, with an `expire` event) on start and by `reconcileExpired()`.
   * Default 30 minutes; it must exceed the longest provider call, since a reservation older than this stops holding capacity.
   */
  reservationTtlMs?: number;
}
export const DEFAULT_RESERVATION_TTL_MS = 30 * 60_000;
/** Media units on an event or allowance; a unit that is 0 is left out, so token-only calls look as before. */
export interface MediaAmounts { images?: number; videoSeconds?: number }
/** `images`/`videoSeconds`: what a media call delivered (absent: 0). Fewer than reserved frees the rest. */
export interface ActualCallUsage { inputTokens: number; outputTokens: number; cacheReadTokens?: number; cacheWriteTokens?: number; images?: number; videoSeconds?: number }
export interface Settlement { recorded: boolean; overages: CallRefusal[] }
export class CallBudgetExceededError extends Error {
  readonly code = 'budget_exceeded';
  readonly refusal: CallRefusal;
  constructor(refusal: CallRefusal) {
    super(`budget exceeded: ${refusal.scope} ${refusal.id} ${refusal.metric}, limit ${refusal.limit}, used ${refusal.used}, estimate ${refusal.estimate}`);
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
  turn: string; session: string; ts: number; tokens: number; images: number; video_seconds: number; state: string;
}
type Amounts = Record<Metric, number>;
/** The column each metric is counted in: on a `budget_call` reservation, and summed on the `usage_event` ledger. */
const RESERVED: Record<Metric, string> = { tokens: 'tokens', images: 'images', videoSeconds: 'video_seconds' };
const SETTLED: Record<Metric, string> = { tokens: 'input_tokens+output_tokens', images: 'images', videoSeconds: 'video_seconds' };
const amountsOf = (r: CallRow): Amounts => ({ tokens: Number(r.tokens), images: Number(r.images), videoSeconds: Number(r.video_seconds) });
const media = (a: Amounts): MediaAmounts => ({ ...(a.images ? { images: a.images } : {}), ...(a.videoSeconds ? { videoSeconds: a.videoSeconds } : {}) });
/** Token limits gate every call (as before); a media-unit limit gates only a call that uses that unit, so an image limit never stops a chat. */
const applies = (l: { metric: Metric }, a: Amounts): boolean => l.metric === 'tokens' || a[l.metric] > 0;
const METRIC_LIST = METRICS.map(m => `'${m}'`).join(',');
interface LimitRow { scope: CallScope; id: string; period: CallPeriod; metric: Metric; hard: number | null; soft: number }
const COLUMN: Record<CallScope, string> = { global: '', user: 'principal', project: 'project', agent: 'agent', turn: 'turn', session: 'session' };

export function createCallBudget(o: CallBudgetOptions) {
  const defaultZone = validateTimeZone(o.defaultTimeZone ?? 'UTC');
  const db = openBudgetDb(o);
  // Additive, lazy extension: old RPC service/store shape stays compatible. No prompt/result columns.
  try {
    transaction(db, () => {
      const schema = db.prepare("SELECT value FROM settings WHERE key='budget_call_schema'").get() as { value: string } | undefined;
      if (schema && schema.value !== '1' && schema.value !== '2') throw new BudgetStoreError('newer-schema', 'unsupported budget call schema');
      db.exec(`
      CREATE TABLE IF NOT EXISTS budget_call (
        id TEXT PRIMARY KEY, principal TEXT NOT NULL, project TEXT NOT NULL, agent TEXT NOT NULL,
        model TEXT NOT NULL, provider TEXT NOT NULL, turn TEXT NOT NULL, session TEXT NOT NULL,
        ts INTEGER NOT NULL, tokens INTEGER NOT NULL CHECK(tokens >= 0), cost INTEGER CHECK(cost >= 0),
        state TEXT NOT NULL CHECK(state IN ('reserved','settled')),
        images INTEGER NOT NULL DEFAULT 0 CHECK(images >= 0), video_seconds INTEGER NOT NULL DEFAULT 0 CHECK(video_seconds >= 0)
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
      // Call schema 2 (media units): a schema-1 table gains the two unit columns, 0 on every older reservation.
      const cols = (db.prepare('PRAGMA table_info(budget_call)').all() as { name: string }[]).map(c => c.name);
      if (!cols.includes('images')) db.exec('ALTER TABLE budget_call ADD COLUMN images INTEGER NOT NULL DEFAULT 0 CHECK(images >= 0)');
      if (!cols.includes('video_seconds')) db.exec('ALTER TABLE budget_call ADD COLUMN video_seconds INTEGER NOT NULL DEFAULT 0 CHECK(video_seconds >= 0)');
      db.prepare("INSERT INTO settings VALUES ('budget_call_schema','2') ON CONFLICT(key) DO UPDATE SET value=excluded.value").run();
    });
  } catch (e) { db.close(); throw e; }
  const ttl = o.reservationTtlMs ?? DEFAULT_RESERVATION_TTL_MS;
  if (!Number.isSafeInteger(ttl) || ttl <= 0) { db.close(); throw new BudgetInputError('invalid reservation ttl'); }
  const emit = (e: CallBudgetEvent) => { try { o.emitter?.emit(e); } catch { /* audit availability must not corrupt committed accounting */ } };
  /** Reserved rows at or before this instant are expired: ignored on read, released by reconciliation. */
  const expiredBefore = () => o.clock.now() - ttl;
  function reconcileExpired(): number {
    const rows = transaction(db, () => {
      const stale = db.prepare("SELECT id, tokens, images, video_seconds, ts FROM budget_call WHERE state='reserved' AND ts < ?").all(expiredBefore()) as unknown as { id: string; tokens: number; images: number; video_seconds: number; ts: number }[];
      const del = db.prepare("DELETE FROM budget_call WHERE id=? AND state='reserved'");
      for (const r of stale) del.run(r.id);
      return stale;
    });
    for (const r of rows) emit({ type: 'expire', reservationId: r.id, tokens: Number(r.tokens), reservedAt: Number(r.ts), ...media({ tokens: 0, images: Number(r.images), videoSeconds: Number(r.video_seconds) }) });
    return rows.length;
  }
  const unwatchRecovery = deferMaintenanceStart(o.maintenance, () => { reconcileExpired(); });
  if (!unwatchRecovery) try { reconcileExpired(); } catch (e) { db.close(); throw e; }
  const zone = () => {
    const row = db.prepare("SELECT value FROM settings WHERE key='timezone'").get() as { value: string } | undefined;
    return validateTimeZone(row?.value ?? defaultZone);
  };
  /** The limits that cover this call and apply to what it uses (`a`, see `applies`). */
  function limits(r: CallRow, a: Amounts): LimitRow[] {
    // A limit row with metric 'cost' (written by an older core) is ignored: there is no money dimension any more.
    const own = db.prepare(`SELECT * FROM budget_call_limit WHERE metric IN (${METRIC_LIST})`).all() as unknown as LimitRow[];
    const legacy = db.prepare(`SELECT * FROM budget_limit WHERE metric IN (${METRIC_LIST})`).all() as unknown as { scope: 'global' | 'agent'; agent: string; period: CallPeriod; metric: Metric; hard: number | null; soft: number | null }[];
    return [...own, ...legacy.map(l => ({ ...l, id: l.agent, soft: l.soft ?? Math.floor((l.hard ?? 0) * 0.8) }))]
      .filter(l => applies(l, a))
      .filter(l => l.scope === 'global' || (r[COLUMN[l.scope] as keyof CallRow] !== '' && r[COLUMN[l.scope] as keyof CallRow] === l.id));
  }
  function usage(l: LimitRow, ts: number): { used: number; key: string; end: number } {
    const lifetime = l.scope === 'turn' || l.scope === 'session';
    const b = lifetime ? { start: 0, end: 8640000000000000, key: l.id } : periodBounds(ts, zone(), l.period);
    const col = COLUMN[l.scope];
    const filter = col ? ` AND ${col} = ?` : '';
    const params = col ? [l.id] : [];
    // Pending estimates count even across rollover, so a stalled request cannot free capacity; only past the reservation TTL
    // (an orphan nobody will settle) does a reservation stop counting.
    const unit = RESERVED[l.metric];
    const reserved = db.prepare(`SELECT COALESCE(SUM(${unit}),0) AS n FROM budget_call WHERE state='reserved' AND ts >= ?${filter}`).get(expiredBefore(), ...params) as { n: number };
    let settled: { n: number };
    if (l.scope === 'global' || l.scope === 'agent') {
      const where = l.scope === 'agent' ? ' AND agent=?' : '';
      settled = db.prepare(`SELECT COALESCE(SUM(${SETTLED[l.metric]}),0) AS n FROM usage_event WHERE ts>=? AND ts<?${where}`).get(b.start, b.end, ...(l.scope === 'agent' ? [l.id] : [])) as { n: number };
    } else {
      settled = db.prepare(`SELECT COALESCE(SUM(${unit}),0) AS n FROM budget_call WHERE state='settled' AND ts>=? AND ts<?${filter}`).get(b.start, b.end, ...params) as { n: number };
    }
    return { used: count(Number(reserved.n) + Number(settled.n)), key: b.key, end: b.end };
  }
  /** `uses` decides which limits apply; `add` is what this check adds on top of the use (the request, or nothing at settlement). */
  function breaches(r: CallRow, uses: Amounts, add: Amounts | null, ts: number): CallRefusal[] {
    return limits(r, uses).flatMap(l => {
      if (l.hard === null) return [];
      const u = usage(l, ts), n = add ? add[l.metric] : 0;
      if (n <= l.hard - u.used) return [];
      return [{ kind: 'refuse' as const, code: 'budget_exceeded' as const, reason: 'hard' as const, scope: l.scope, id: l.id, metric: l.metric, limit: l.hard, used: u.used, estimate: n, resetsAt: u.end }];
    }).sort((a, b) => (a.limit - a.used) - (b.limit - b.used));
  }
  function warnings(r: CallRow, uses: Amounts, add: Amounts | null, ts: number, events: CallBudgetEvent[]): void {
    for (const l of limits(r, uses)) {
      const u = usage(l, ts), n = add ? add[l.metric] : 0;
      if (u.used + n >= l.soft) {
        const first = db.prepare('INSERT OR IGNORE INTO budget_call_notice VALUES (?,?,?,?,?)').run(l.scope, l.id, l.period, l.metric, u.key);
        if (first.changes) events.push({ type: 'warn', scope: l.scope, id: l.id, metric: l.metric, used: u.used + n, limit: l.soft });
      }
    }
  }
  function setLimit(l: CallLimit): void {
    closed(l, ['scope', 'id', 'period', 'metric', 'hard', 'soft']);
    if (!Object.hasOwn(COLUMN, l.scope) || !['day', 'week', 'month'].includes(l.period) || !METRICS.includes(l.metric)) throw new BudgetInputError('invalid call limit');
    if (l.scope === 'global' ? l.id !== '' : !id(l.id)) throw new BudgetInputError('invalid limit id');
    count(l.hard); const soft = count(l.soft ?? Math.floor((l.hard ?? 0) * 0.8));
    if (soft > l.hard) throw new BudgetInputError('soft exceeds hard');
    db.prepare('INSERT INTO budget_call_limit VALUES (?,?,?,?,?,?) ON CONFLICT(scope,id,period,metric) DO UPDATE SET hard=excluded.hard, soft=excluded.soft').run(l.scope, l.id, l.period, l.metric, l.hard, soft);
  }
  function checkBeforeCall(request: CallRequest): CallDecision {
    closed(request, ['principal', 'agent', 'project', 'model', 'provider', 'estimatedInputTokens', 'maxOutputTokens', 'images', 'videoSeconds', 'turn', 'session']);
    for (const field of ['principal', 'agent', 'project', 'model'] as const) id(request[field]);
    for (const field of ['provider', 'turn', 'session'] as const) if (request[field] !== undefined) id(request[field]);
    const ts = count(o.clock.now()), tokens = count(count(request.estimatedInputTokens) + count(request.maxOutputTokens));
    const images = count(request.images ?? 0), videoSeconds = count(request.videoSeconds ?? 0);
    const r: CallRow = { id: randomUUID(), principal: request.principal, project: request.project, agent: request.agent, model: request.model, provider: request.provider ?? '', turn: request.turn ?? '', session: request.session ?? '', ts, tokens, images, video_seconds: videoSeconds, state: 'reserved' };
    const want = amountsOf(r);
    const events: CallBudgetEvent[] = [];
    const decision = transaction(db, (): CallDecision => {
      const refusal = breaches(r, want, want, ts)[0];
      if (refusal) { events.push({ type: 'refuse', refusal }); return refusal; }
      warnings(r, want, want, ts, events);
      db.prepare('INSERT INTO budget_call (id,principal,project,agent,model,provider,turn,session,ts,tokens,cost,state,images,video_seconds) VALUES (?,?,?,?,?,?,?,?,?,?,NULL,?,?,?)')
        .run(r.id, r.principal, r.project, r.agent, r.model, r.provider, r.turn, r.session, r.ts, r.tokens, r.state, r.images, r.video_seconds);
      events.push({ type: 'reserve', reservationId: r.id, tokens, ...media(want) });
      return { kind: 'allow', reservationId: r.id, estimatedTokens: tokens, ...media(want) };
    });
    events.forEach(emit); return decision;
  }
  function settle(reservationId: string, actual: ActualCallUsage): Settlement {
    id(reservationId); closed(actual, ['inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens', 'images', 'videoSeconds']);
    const u = { inputTokens: count(actual.inputTokens), outputTokens: count(actual.outputTokens), cacheReadTokens: count(actual.cacheReadTokens ?? 0), cacheWriteTokens: count(actual.cacheWriteTokens ?? 0), images: count(actual.images ?? 0), videoSeconds: count(actual.videoSeconds ?? 0) };
    const events: CallBudgetEvent[] = [];
    const result = transaction(db, (): Settlement => {
      const r = db.prepare('SELECT * FROM budget_call WHERE id=?').get(reservationId) as unknown as CallRow | undefined;
      if (!r) throw new BudgetInputError('unknown reservation');
      if (r.state === 'settled') return { recorded: false, overages: [] };
      const tokens = count(u.inputTokens + u.outputTokens);
      // Which limits concern this call: what it reserved or what it used, so a unit limit sees a delivery it did not reserve for.
      const reservedAmounts = amountsOf(r), got: Amounts = { tokens, images: u.images, videoSeconds: u.videoSeconds };
      const uses: Amounts = { tokens, images: Math.max(reservedAmounts.images, got.images), videoSeconds: Math.max(reservedAmounts.videoSeconds, got.videoSeconds) };
      db.prepare("UPDATE budget_call SET state='settled',tokens=?,images=?,video_seconds=? WHERE id=?").run(tokens, u.images, u.videoSeconds, r.id);
      db.prepare("INSERT INTO usage_event (ts,agent,provider,model,input_tokens,output_tokens,cache_read_tokens,cache_write_tokens,price_version,request_id,images,video_seconds) VALUES (?,?,?,?,?,?,?,?,'',?,?,?)").run(r.ts, r.agent, r.provider, r.model, u.inputTokens, u.outputTokens, u.cacheReadTokens, u.cacheWriteTokens, `budget-call:${r.id}`, u.images, u.videoSeconds);
      warnings(r, uses, null, r.ts, events);
      return { recorded: true, overages: breaches(r, uses, null, r.ts) };
    });
    events.forEach(emit);
    if (result.recorded) emit({ type: 'settle', reservationId, tokens: u.inputTokens + u.outputTokens, overages: result.overages, ...media({ tokens: 0, images: u.images, videoSeconds: u.videoSeconds }) });
    return result;
  }
  return {
    setLimit, checkBeforeCall, settle, reconcileExpired,
    /** Only a caller that knows nothing billable was sent (no provider request, or one refused before any output) may release. */
    releaseUnused(reservationId: string): void {
      id(reservationId);
      const r = db.prepare("DELETE FROM budget_call WHERE id=? AND state='reserved'").run(reservationId);
      if (r.changes) emit({ type: 'release', reservationId });
    },
    /** Read-only view of one reservation (tests, diagnostics): its state, or null once released/expired. */
    reservation(reservationId: string): ({ state: 'reserved' | 'settled'; tokens: number; expired: boolean } & MediaAmounts) | null {
      const r = db.prepare('SELECT state, tokens, images, video_seconds, ts FROM budget_call WHERE id=?').get(id(reservationId)) as { state: 'reserved' | 'settled'; tokens: number; images: number; video_seconds: number; ts: number } | undefined;
      return r ? { state: r.state, tokens: Number(r.tokens), ...media({ tokens: 0, images: Number(r.images), videoSeconds: Number(r.video_seconds) }), expired: r.state === 'reserved' && Number(r.ts) < expiredBefore() } : null;
    },
    /** Counts of reservations still pending (live) and expired-but-not-yet-reconciled. */
    pendingReservations(): { live: number; expired: number } {
      const r = db.prepare("SELECT COALESCE(SUM(ts >= ?),0) AS live, COALESCE(SUM(ts < ?),0) AS expired FROM budget_call WHERE state='reserved'").get(expiredBefore(), expiredBefore()) as { live: number; expired: number };
      return { live: Number(r.live), expired: Number(r.expired) };
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
    close(): void { unwatchRecovery?.(); db.close(); },
  };
}
export type CallBudget = ReturnType<typeof createCallBudget>;
