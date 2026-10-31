// Budget service (L8, ADR-010 §4): usage accounting, soft/hard limits, and the check that runs before every model call.
// Provider adapters call `recordUsage` after a call and `check`/`enforce` before it. The service never sees prompt content.
// Budgets count tokens and media units: images and video seconds (owner decisions 2026-10-19: no money dimension anywhere;
// price tables and cost limits were removed). The call port (`calls.ts`) enforces all three; `check`/`enforce` here are tokens only.
import type { DatabaseSync } from "node:sqlite";
import { CACHE_READS_SQL, countedTokens, storedCacheReadWeight, writeCacheReadWeight } from "./cache-read-weight.ts";
import { periodBounds, validateTimeZone, type Period } from "./period.ts";
import { openBudgetDb, transaction } from "./store.ts";

export type LimitScope = "global" | "agent";
/** `tokens`: input + output (output includes the reasoning tokens a provider reports); `images`: generated images;
 *  `videoSeconds`: seconds of generated video (whole seconds, a fraction is rounded up). */
export type Metric = "tokens" | "images" | "videoSeconds";
export const PERIODS: readonly Period[] = ["day", "month"];
export const METRICS: readonly Metric[] = ["tokens", "images", "videoSeconds"];
interface TokenCounts { inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number }

/** What a provider adapter reports after a call. Closed: any other property (a prompt, a message list) is refused. */
export interface UsageEvent {
  agent: string; model: string; provider?: string;
  inputTokens: number; outputTokens: number; cacheReadTokens?: number; cacheWriteTokens?: number;
  /** ms since epoch; defaults to the service clock. */
  ts?: number;
  /** An id the adapter makes stable across retries; a repeat is ignored. */
  requestId?: string;
}
export interface RecordResult { recorded: boolean }

export interface UsageEstimate { provider?: string; inputTokens: number; outputTokens?: number }

export interface Limit { scope: LimitScope; agentId?: string; period: Period; metric: Metric; soft: number | null; hard: number | null }
export interface LimitKey { scope: LimitScope; agentId?: string; period: Period; metric: Metric }

export interface Breach {
  kind: "hard";
  scope: LimitScope; agentId?: string; period: Period; metric: Metric;
  limit: number; used: number; estimate: number; periodKey: string; resetsAt: number;
}
export interface Warning {
  scope: LimitScope; agentId?: string; period: Period; metric: Metric;
  limit: number; used: number; estimate: number; periodKey: string;
  /** true when this call is the first to cross the soft limit in this period (the event was emitted). */
  notified: boolean;
}
export interface CheckDecision { allowed: boolean; breaches: Breach[]; warnings: Warning[] }

export interface BudgetEvent {
  kind: "budget.soft" | "budget.hard";
  scope: LimitScope; agentId?: string; period: Period; metric: Metric; limit: number; used: number; periodKey: string;
}

export class BudgetExceededError extends Error {
  readonly code = "budget-exceeded" as const;
  readonly decision: CheckDecision;
  constructor(decision: CheckDecision, agent: string, model: string) {
    super(`budget exceeded for agent "${agent}" calling ${model}: ${decision.breaches.map(describeBreach).join("; ")}`);
    this.name = "BudgetExceededError";
    this.decision = decision;
  }
}
export class BudgetInputError extends RangeError { constructor(m: string) { super(m); this.name = "BudgetInputError"; } }

const UNIT: Record<Metric, string> = { tokens: "tokens", images: "images", videoSeconds: "video seconds" };
export function describeBreach(b: Breach): string {
  const fmt = (n: number) => `${n} ${UNIT[b.metric]}`;
  const who = b.scope === "global" ? "global" : `agent ${b.agentId}`;
  const when = `${b.period === "day" ? "daily" : "monthly"} ${b.metric}`;
  return `${who} ${when} hard limit ${fmt(b.limit)} would be exceeded (used ${fmt(b.used)}, this call ~${fmt(b.estimate)}; resets ${new Date(b.resetsAt).toISOString()})`;
}

export interface UsageTotals {
  events: number; inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number;
  /** Input outside the cache, clamped to zero per event if a provider reports inconsistent cache counts. */
  freshInputTokens: number;
  /** Input plus output after weighing cache reads; rounded once for this aggregate. */
  countedTokens: number;
  images: number; videoSeconds: number;
}
export interface StatusLimit extends Limit { used: number; state: "ok" | "soft" | "hard" }
export interface StatusPeriod {
  period: Period; key: string; start: number; end: number; total: UsageTotals;
  agents: { agentId: string; total: UsageTotals; models: ({ model: string } & UsageTotals)[] }[];
}
export interface BudgetStatus { timeZone: string; cacheReadWeight: number; now: number; periods: StatusPeriod[]; limits: StatusLimit[] }
export type BudgetLimitUpdate = LimitKey & { soft?: number | null; hard?: number | null };
export interface BudgetSettings { timeZone?: string; cacheReadWeight?: number; limit?: BudgetLimitUpdate }
export interface BudgetSettingsResult { timeZone: string; cacheReadWeight: number; limit?: Limit | null; limits: Limit[] }

export interface BudgetServiceOptions {
  path: string;
  clock: { now(): number };
  events?: (e: BudgetEvent) => void;
  securePath?: (p: string, o?: { mode?: number }) => void;
  defaultTimeZone?: string;
  busyTimeoutMs?: number;
}

const ID = /^[A-Za-z0-9][A-Za-z0-9._:/@+=-]{0,127}$/;
const EVENT_KEYS = new Set(["agent", "model", "provider", "inputTokens", "outputTokens", "cacheReadTokens", "cacheWriteTokens", "ts", "requestId"]);
/** The largest instant a `Date` can hold; anything later cannot be bucketed into a period. */
const MAX_TS = 8_640_000_000_000_000;
const ESTIMATE_KEYS = new Set(["provider", "inputTokens", "outputTokens"]);

function ident(name: string, v: unknown): string {
  if (typeof v !== "string" || !ID.test(v)) throw new BudgetInputError(`${name} must be an identifier (1-128 chars of A-Z a-z 0-9 . _ : / @ + = -)`);
  return v;
}
function count(name: string, v: unknown, optional = false): number {
  if (v === undefined && optional) return 0;
  if (typeof v !== "number" || !Number.isSafeInteger(v) || v < 0) throw new BudgetInputError(`${name} must be a non-negative integer`);
  return v;
}
function closed(what: string, o: object, allowed: Set<string>): void {
  for (const k of Object.keys(o)) if (!allowed.has(k)) throw new BudgetInputError(`${what}: unknown property "${k}" (the budget store holds counts and ids only)`);
}

/** `ri`: the cache reads a token limit may weigh, each event's at most its own input (`CACHE_READS_SQL`). */
interface Row { n: number; i: number; o: number; cr: number; cw: number; im: number; vs: number; ri: number; fresh: number }
const ZERO_ROW: Row = { n: 0, i: 0, o: 0, cr: 0, cw: 0, im: 0, vs: 0, ri: 0, fresh: 0 };
const totals = (r: Row, weight: number): UsageTotals => ({
  events: r.n, inputTokens: r.i, outputTokens: r.o, cacheReadTokens: r.cr, cacheWriteTokens: r.cw,
  freshInputTokens: r.fresh, countedTokens: countedTokens(r.i + r.o, r.ri, weight), images: r.im, videoSeconds: r.vs,
});
const SUMS = `COUNT(*) AS n, COALESCE(SUM(input_tokens),0) AS i, COALESCE(SUM(output_tokens),0) AS o, COALESCE(SUM(cache_read_tokens),0) AS cr, COALESCE(SUM(cache_write_tokens),0) AS cw, COALESCE(SUM(images),0) AS im, COALESCE(SUM(video_seconds),0) AS vs, COALESCE(SUM(${CACHE_READS_SQL}),0) AS ri, COALESCE(SUM(MAX(0, input_tokens - cache_read_tokens - cache_write_tokens)),0) AS fresh`;
/** The use a limit counts. Token limits weigh cache reads with the stored weight (RE-D29), applied at query time. */
const USED: Record<Metric, (r: Row, cacheReadWeight: number) => number> = { tokens: (r, w) => countedTokens(r.i + r.o, r.ri, w), images: (r) => r.im, videoSeconds: (r) => r.vs };
/**
 * The legacy money columns of `usage_event` (schema 1: the cost and the price-table version) stay in the store, unused:
 * new rows leave the cost NULL and write an empty price version.
 * A `budget_limit` row with metric 'cost' written by an older core is ignored (never read, never enforced) rather than
 * dropped by a migration, so an older core can still open the store.
 */
const TOKEN_LIMITS = "metric = 'tokens'";
/** Every limit this core knows (status, limits, setLimit); `check`/`recordUsage` notices stay on token limits. */
const KNOWN_LIMITS = `metric IN (${METRICS.map((m) => `'${m}'`).join(", ")})`;

export interface BudgetService {
  recordUsage(e: UsageEvent): RecordResult;
  check(agent: string, model: string, estimate: UsageEstimate): CheckDecision;
  /** `check`, throwing `BudgetExceededError` on a breach. Returns the decision (with any soft warnings) otherwise. */
  enforce(agent: string, model: string, estimate: UsageEstimate): CheckDecision;
  status(o?: { agentId?: string }): BudgetStatus;
  limits(): Limit[];
  /** `undefined` leaves a bound as it is, `null` clears it; a limit with neither bound left is removed. */
  setLimit(l: BudgetLimitUpdate): Limit | null;
  /** Applies all supplied settings atomically; a rejected setting rolls back the entire update. */
  updateSettings(settings: BudgetSettings): BudgetSettingsResult;
  timeZone(): string;
  setTimeZone(tz: string): string;
  /** Weight (0 to 1) of cache reads in token limits (RE-D29); 1, the default, counts them in full. */
  cacheReadWeight(): number;
  /** Stores a weight from 0 to 1, rounded to millionths, and returns it as stored; anything else is a RangeError. */
  setCacheReadWeight(w: number): number;
  prune(beforeTs: number): number;
  close(): void;
}

export function createBudgetService(o: BudgetServiceOptions): BudgetService {
  const db: DatabaseSync = openBudgetDb({ path: o.path, ...(o.securePath ? { securePath: o.securePath } : {}), ...(o.busyTimeoutMs !== undefined ? { busyTimeoutMs: o.busyTimeoutMs } : {}) });
  const defaultTz = validateTimeZone(o.defaultTimeZone ?? "UTC");
  const emit = (e: BudgetEvent) => { try { o.events?.(e); } catch { /* a sink must not break accounting */ } };

  const getTz = (): string => {
    const r = db.prepare("SELECT value FROM settings WHERE key = 'timezone'").get() as { value: string } | undefined;
    if (!r) return defaultTz;
    try { return validateTimeZone(r.value); } catch { return defaultTz; }
  };

  const sums = (start: number, end: number, agent?: string): Row =>
    (agent === undefined
      ? db.prepare(`SELECT ${SUMS} FROM usage_event WHERE ts >= ? AND ts < ?`).get(start, end)
      : db.prepare(`SELECT ${SUMS} FROM usage_event WHERE ts >= ? AND ts < ? AND agent = ?`).get(start, end, agent)) as unknown as Row;
  const usedFor = (l: { scope: LimitScope; agent: string; period: Period; metric: Metric }, ts: number, tz: string, w: number) => {
    const b = periodBounds(ts, tz, l.period);
    const r = sums(b.start, b.end, l.scope === "agent" ? l.agent : undefined);
    return { used: USED[l.metric](r, w), bounds: b };
  };

  interface LimitRow { scope: LimitScope; agent: string; period: Period; metric: Metric; soft: number | null; hard: number | null }
  const limitRows = (agent?: string, which = TOKEN_LIMITS): LimitRow[] =>
    (agent === undefined
      ? db.prepare(`SELECT scope, agent, period, metric, soft, hard FROM budget_limit WHERE ${which} ORDER BY scope, agent, period, metric`).all()
      : db.prepare(`SELECT scope, agent, period, metric, soft, hard FROM budget_limit WHERE ${which} AND (scope = 'global' OR agent = ?) ORDER BY scope, agent, period, metric`).all(agent)) as unknown as LimitRow[];
  const toLimit = (r: LimitRow): Limit => ({ scope: r.scope, ...(r.scope === "agent" ? { agentId: r.agent } : {}), period: r.period, metric: r.metric, soft: r.soft, hard: r.hard });

  /** Inserts the notice and reports whether this is the first one for the period (a restart does not re-warn). */
  const firstNotice = (kind: "soft" | "hard", r: LimitRow, periodKey: string, ts: number): boolean =>
    Number(db.prepare("INSERT OR IGNORE INTO notice (kind, scope, agent, period, metric, period_key, ts) VALUES (?,?,?,?,?,?,?)").run(kind, r.scope, r.agent, r.period, r.metric, periodKey, ts).changes) === 1;

  const eventFor = (kind: BudgetEvent["kind"], r: LimitRow, limit: number, used: number, periodKey: string): BudgetEvent =>
    ({ kind, scope: r.scope, ...(r.scope === "agent" ? { agentId: r.agent } : {}), period: r.period, metric: r.metric, limit, used, periodKey });

  function check(agent: string, model: string, est: UsageEstimate, out: BudgetEvent[] | null): CheckDecision {
    ident("agent", agent); ident("model", model);
    if (typeof est !== "object" || est === null) throw new BudgetInputError("estimate must be an object");
    closed("estimate", est, ESTIMATE_KEYS);
    count("estimate.inputTokens", est.inputTokens); count("estimate.outputTokens", est.outputTokens, true);
    if (est.provider !== undefined) ident("provider", est.provider);
    const now = o.clock.now(), tz = getTz(), weight = storedCacheReadWeight(db);
    const breaches: Breach[] = [], warnings: Warning[] = [];
    const estimate = est.inputTokens + (est.outputTokens ?? 0);
    const pending: { w: Warning; r: LimitRow; key: string; used: number }[] = [];
    for (const r of limitRows(agent)) {
      const { used, bounds } = usedFor(r, now, tz, weight);
      const base = { scope: r.scope, ...(r.scope === "agent" ? { agentId: r.agent } : {}), period: r.period, metric: r.metric, used, estimate, periodKey: bounds.key };
      if (r.hard !== null) {
        if (used + estimate > r.hard) { breaches.push({ ...base, kind: "hard", limit: r.hard, resetsAt: bounds.end }); continue; }
      }
      if (r.soft !== null && used + estimate > r.soft) {
        const w: Warning = { ...base, limit: r.soft, notified: false };
        warnings.push(w);
        pending.push({ w, r, key: bounds.key, used });
      }
    }
    // A refused call never happens, so it notifies nobody; an allowed one warns once per limit and period.
    if (breaches.length === 0 && out) {
      for (const p of pending) {
        p.w.notified = firstNotice("soft", p.r, p.key, now);
        if (p.w.notified) out.push(eventFor("budget.soft", p.r, p.r.soft!, p.used, p.key));
      }
    }
    return { allowed: breaches.length === 0, breaches, warnings };
  }

  /** Events leave only after the commit: a sink runs without the write lock, may call back into the service, and never announces a rolled-back notice. */
  function checked(agent: string, model: string, estimate: UsageEstimate): CheckDecision {
    const out: BudgetEvent[] = [];
    const d = transaction(db, () => check(agent, model, estimate, out));
    out.forEach(emit);
    return d;
  }

  function storeLimit(l: BudgetLimitUpdate): Limit | null {
    if (l.scope !== "global" && l.scope !== "agent") throw new BudgetInputError("scope must be global or agent");
    if (!PERIODS.includes(l.period)) throw new BudgetInputError("period must be day or month");
    if (!METRICS.includes(l.metric)) throw new BudgetInputError("metric must be tokens, images or videoSeconds");
    const agent = l.scope === "agent" ? ident("agentId", l.agentId) : "";
    if (l.scope === "global" && l.agentId !== undefined) throw new BudgetInputError("a global limit takes no agentId");
    const bound = (n: string, v: number | null | undefined) => (v === undefined || v === null ? v : count(n, v));
    const soft = bound("soft", l.soft), hard = bound("hard", l.hard);
    const cur = db.prepare("SELECT soft, hard FROM budget_limit WHERE scope = ? AND agent = ? AND period = ? AND metric = ?").get(l.scope, agent, l.period, l.metric) as { soft: number | null; hard: number | null } | undefined;
    const nextSoft = soft === undefined ? (cur?.soft ?? null) : soft;
    const nextHard = hard === undefined ? (cur?.hard ?? null) : hard;
    if (nextSoft === null && nextHard === null) {
      db.prepare("DELETE FROM budget_limit WHERE scope = ? AND agent = ? AND period = ? AND metric = ?").run(l.scope, agent, l.period, l.metric);
      return null;
    }
    if (nextSoft !== null && nextHard !== null && nextSoft > nextHard) throw new BudgetInputError("soft limit must not exceed the hard limit");
    db.prepare(
      `INSERT INTO budget_limit (scope, agent, period, metric, soft, hard) VALUES (?,?,?,?,?,?)
       ON CONFLICT (scope, agent, period, metric) DO UPDATE SET soft = excluded.soft, hard = excluded.hard`,
    ).run(l.scope, agent, l.period, l.metric, nextSoft, nextHard);
    return toLimit({ scope: l.scope, agent, period: l.period, metric: l.metric, soft: nextSoft, hard: nextHard });
  }

  function storeTimeZone(tz: string): string {
    const v = validateTimeZone(tz);
    db.prepare("INSERT INTO settings (key, value) VALUES ('timezone', ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value").run(v);
    return v;
  }

  return {
    recordUsage(e) {
      if (typeof e !== "object" || e === null) throw new BudgetInputError("usage event must be an object");
      closed("usage event", e, EVENT_KEYS);
      const agent = ident("agent", e.agent), model = ident("model", e.model);
      const provider = e.provider === undefined ? "" : ident("provider", e.provider);
      const requestId = e.requestId === undefined ? null : ident("requestId", e.requestId);
      const u: TokenCounts = {
        inputTokens: count("inputTokens", e.inputTokens), outputTokens: count("outputTokens", e.outputTokens),
        cacheReadTokens: count("cacheReadTokens", e.cacheReadTokens, true), cacheWriteTokens: count("cacheWriteTokens", e.cacheWriteTokens, true),
      };
      const ts = e.ts === undefined ? o.clock.now() : count("ts", e.ts);
      if (ts > MAX_TS) throw new BudgetInputError("ts is outside the range of dates");
      if (!Number.isSafeInteger(u.inputTokens + u.outputTokens)) throw new BudgetInputError("the token count of this event exceeds the range the ledger can hold");
      const tz = getTz(), weight = storedCacheReadWeight(db);
      const out: BudgetEvent[] = [];
      const result = transaction(db, () => {
        const res = db.prepare(
          `INSERT OR IGNORE INTO usage_event (ts, agent, provider, model, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, price_version, request_id)
           VALUES (?,?,?,?,?,?,?,?,?,?)`,
        ).run(ts, agent, provider, model, u.inputTokens, u.outputTokens, u.cacheReadTokens, u.cacheWriteTokens, "", requestId);
        const recorded = Number(res.changes) === 1;
        if (recorded) {
          for (const r of limitRows(agent)) {
            const { used, bounds } = usedFor(r, ts, tz, weight);
            if (r.hard !== null && used > r.hard) {
              // Past the hard limit the soft notice is moot: consume it silently so it is not announced late, after the hard one.
              if (r.soft !== null) firstNotice("soft", r, bounds.key, ts);
              if (firstNotice("hard", r, bounds.key, ts)) out.push(eventFor("budget.hard", r, r.hard, used, bounds.key));
            } else if (r.soft !== null && used > r.soft && firstNotice("soft", r, bounds.key, ts)) out.push(eventFor("budget.soft", r, r.soft, used, bounds.key));
          }
        }
        return { recorded };
      });
      out.forEach(emit);
      return result;
    },

    check(agent, model, estimate) { return checked(agent, model, estimate); },
    enforce(agent, model, estimate) {
      const d = checked(agent, model, estimate);
      if (!d.allowed) throw new BudgetExceededError(d, agent, model);
      return d;
    },

    status(opts = {}) {
      const now = o.clock.now(), tz = getTz(), weight = storedCacheReadWeight(db);
      if (opts.agentId !== undefined) ident("agentId", opts.agentId);
      const periods: StatusPeriod[] = PERIODS.map((period) => {
        const b = periodBounds(now, tz, period);
        const total = totals(sums(b.start, b.end, opts.agentId), weight);
        const where = opts.agentId === undefined ? "" : " AND agent = @agent";
        const params = { start: b.start, end: b.end, ...(opts.agentId === undefined ? {} : { agent: opts.agentId }) };
        const rows = db.prepare(`SELECT agent, model, ${SUMS} FROM usage_event WHERE ts >= @start AND ts < @end${where} GROUP BY agent, model ORDER BY agent, model`).all(params) as unknown as (Row & { agent: string; model: string })[];
        const agents = new Map<string, { row: Row; models: StatusPeriod["agents"][number]["models"] }>();
        for (const r of rows) {
          let a = agents.get(r.agent);
          if (!a) { a = { row: { ...ZERO_ROW }, models: [] }; agents.set(r.agent, a); }
          a.models.push({ model: r.model, ...totals(r, weight) });
          // Keep unrounded counts until the agent total is complete; summing rounded model totals overcounts.
          for (const k of Object.keys(ZERO_ROW) as (keyof Row)[]) a.row[k] += r[k];
        }
        return { period, key: b.key, start: b.start, end: b.end, total,
          agents: [...agents].map(([agentId, a]) => ({ agentId, total: totals(a.row, weight), models: a.models })),
        };
      });
      const limits: StatusLimit[] = limitRows(opts.agentId, KNOWN_LIMITS).map((r) => {
        const { used } = usedFor(r, now, tz, weight);
        return { ...toLimit(r), used, state: r.hard !== null && used >= r.hard ? "hard" : r.soft !== null && used >= r.soft ? "soft" : "ok" };
      });
      return { timeZone: tz, cacheReadWeight: weight, now, periods, limits };
    },

    limits: () => limitRows(undefined, KNOWN_LIMITS).map(toLimit),

    setLimit(l) { return transaction(db, () => storeLimit(l)); },
    updateSettings(settings) {
      return transaction(db, () => {
        const set = settings.limit === undefined ? {} : { limit: storeLimit(settings.limit) };
        if (settings.timeZone !== undefined) storeTimeZone(settings.timeZone);
        if (settings.cacheReadWeight !== undefined) writeCacheReadWeight(db, settings.cacheReadWeight);
        return { timeZone: getTz(), cacheReadWeight: storedCacheReadWeight(db), ...set, limits: limitRows(undefined, KNOWN_LIMITS).map(toLimit) };
      });
    },

    timeZone: getTz,
    setTimeZone: storeTimeZone,
    cacheReadWeight: () => storedCacheReadWeight(db),
    setCacheReadWeight: (w) => writeCacheReadWeight(db, w),
    prune: (beforeTs) => Number(db.prepare("DELETE FROM usage_event WHERE ts < ?").run(count("beforeTs", beforeTs)).changes),
    close: () => db.close(),
  };
}
