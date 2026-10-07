// Pure logic of the Usage & Quota page, no DOM and no i18n: tolerant parsing of budget.status, limit state at the boundaries,
// amount parsing (dollars <-> micro-USD without float drift) and the params of budget.set.
import type { BudgetMetric, BudgetPeriod, BudgetPeriodName, BudgetSetParams, UsageTotals } from "./rpc-types.ts";

export type Limit = {
  scope: string; agentId?: string; period: BudgetPeriodName; metric: BudgetMetric; soft: number | null; hard: number | null; used: number; state: "ok" | "soft" | "hard" | undefined;
};
export type Status = { timeZone: string; priceVersion: string; now: string; periods: BudgetPeriod[]; limits: Limit[] };

const rec = (v: unknown): Record<string, unknown> => (typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : {});
const str = (v: unknown): string => (typeof v === "string" ? v : "");
const nat = (v: unknown): number => (typeof v === "number" && Number.isSafeInteger(v) && v >= 0 ? v : 0);
const bound = (v: unknown): number | null => (typeof v === "number" && Number.isSafeInteger(v) && v >= 0 ? v : null);

function totals(v: unknown): UsageTotals {
  const o = rec(v);
  return { events: nat(o.events), inputTokens: nat(o.inputTokens), outputTokens: nat(o.outputTokens), cacheReadTokens: nat(o.cacheReadTokens), cacheWriteTokens: nat(o.cacheWriteTokens), costMicros: nat(o.costMicros), unpricedEvents: nat(o.unpricedEvents) };
}

export function normalizeStatus(raw: unknown): Status {
  const o = rec(raw);
  const limits: Limit[] = [];
  for (const l of Array.isArray(o.limits) ? o.limits : []) {
    const r = rec(l);
    const scope = str(r.scope), agentId = str(r.agentId);
    const period = r.period === "day" || r.period === "month" ? r.period : null;
    const metric = r.metric === "cost" || r.metric === "tokens" ? r.metric : null;
    if (!scope || !period || !metric || (scope === "agent" && !agentId)) continue;
    limits.push({ scope, ...(agentId ? { agentId } : {}), period, metric, soft: bound(r.soft), hard: bound(r.hard), used: nat(r.used), state: r.state === "ok" || r.state === "soft" || r.state === "hard" ? r.state : undefined });
  }
  const periods: BudgetPeriod[] = [];
  for (const p of Array.isArray(o.periods) ? o.periods : []) {
    const r = rec(p);
    if (r.period !== "day" && r.period !== "month") continue;
    periods.push({
      period: r.period, key: str(r.key), start: str(r.start), end: str(r.end), total: totals(r.total),
      agents: (Array.isArray(r.agents) ? r.agents : []).map((a) => {
        const x = rec(a);
        return { agentId: str(x.agentId), total: totals(x.total), models: (Array.isArray(x.models) ? x.models : []).map((m) => ({ model: str(rec(m).model), ...totals(m) })) };
      }).filter((a) => a.agentId !== ""),
    });
  }
  return { timeZone: str(o.timeZone), priceVersion: str(o.priceVersion), now: str(o.now), periods, limits };
}

/** Global limits, per-agent limits, and any scope this UI does not know yet (project, user, ...), which is shown rather than hidden. */
export function groupLimits(limits: readonly Limit[]): { global: Limit[]; agents: Limit[]; other: Limit[] } {
  // A stable order whatever the server sends (agent, day before month, cost before tokens): a limit that is changed keeps its place,
  // so a reload does not move the element the user is working on (a moved element loses keyboard focus).
  const order = (a: Limit, b: Limit): number =>
    (a.scope + (a.agentId ?? "")).localeCompare(b.scope + (b.agentId ?? "")) || (a.period === b.period ? 0 : a.period === "day" ? -1 : 1) || a.metric.localeCompare(b.metric);
  const pick = (f: (l: Limit) => boolean): Limit[] => limits.filter(f).sort(order);
  return { global: pick((l) => l.scope === "global"), agents: pick((l) => l.scope === "agent"), other: pick((l) => l.scope !== "global" && l.scope !== "agent") };
}

export type LimitStatus = "ok" | "warn" | "exceeded";
export type LimitView = { status: LimitStatus; /** The limit the bar runs against: the hard one, else the soft one. */ bound: number | null; percent: number; barValue: number };

/** The server's `state` is authoritative; without a usable one it is derived: reaching a bound (used >= bound) is already that state. */
export function limitView(l: Limit): LimitView {
  const derived: LimitStatus = l.hard !== null && l.used >= l.hard ? "exceeded" : l.soft !== null && l.used >= l.soft ? "warn" : "ok";
  const status: LimitStatus = l.state === "hard" ? "exceeded" : l.state === "soft" ? "warn" : l.state === "ok" ? "ok" : derived;
  const b = l.hard ?? l.soft;
  const percent = b === null ? 0 : b > 0 ? Math.floor((l.used / b) * 100) : l.used > 0 ? 100 : 0;
  return { status, bound: b, percent, barValue: b === null ? 0 : Math.min(l.used, b) };
}

/** Text of a bound -> number, null for blank, "invalid" otherwise. Cost is dollars (comma or dot, up to 6 decimals) -> micro-USD. */
export function parseAmount(metric: BudgetMetric, text: string): number | null | "invalid" {
  const s = text.trim();
  if (s === "") return null;
  if (metric === "tokens") {
    if (!/^\d+$/.test(s)) return "invalid";
    const n = Number(s);
    return Number.isSafeInteger(n) ? n : "invalid";
  }
  const m = /^(\d+)(?:[.,](\d{1,6}))?$/.exec(s);
  if (!m) return "invalid";
  const n = Number(m[1]) * 1_000_000 + Number((m[2] ?? "").padEnd(6, "0"));
  return Number.isSafeInteger(n) ? n : "invalid";
}

export function microsToInput(micros: number): string {
  const whole = Math.floor(micros / 1_000_000), frac = String(micros % 1_000_000).padStart(6, "0").replace(/0+$/, "");
  return frac ? `${whole}.${frac}` : String(whole);
}

export type LimitKey = { scope: "global" | "agent"; agentId?: string; period: BudgetPeriodName; metric: BudgetMetric };
/** Params of budget.set. "A bound left out stays as it is; null clears it": a new limit leaves empty bounds out, an edit sends null for
 *  a bound that was set and has been emptied, and nothing for one that was empty and still is. */
export function buildSetParams(key: LimitKey, next: { soft: number | null; hard: number | null }, before: { soft: number | null; hard: number | null } | null): BudgetSetParams {
  const limit: NonNullable<BudgetSetParams["limit"]> = { scope: key.scope, ...(key.scope === "agent" && key.agentId ? { agentId: key.agentId } : {}), period: key.period, metric: key.metric };
  for (const b of ["soft", "hard"] as const) {
    if (next[b] !== null) limit[b] = next[b];
    else if (before !== null && before[b] !== null) limit[b] = null;
  }
  return { limit };
}
