// Activity feed model (pure): maps log records of the audit and diagnostic streams onto condensed feed entries, groups them by
// day and builds the "Open in log" link. No I/O, no clock (callers pass `now`), so it is unit-testable in plain node.
//
// Source of the entries: `logs.query`. Audit stream: `auth.login`, `auth.logout`, `user.break_glass`. Diagnostic stream:
// `scheduler.run.completed|failed|skipped`, classified by the job name into dreams, model scan, backup or (everything else that
// names an agent) agent run. Anything else is dropped: the feed is a summary, the log viewer is the full record.

export type LogRecord = { ts: string; level: string | null; component: string; stream: "diagnostic" | "audit"; record: Record<string, unknown> };

export type ActivityKind = "agentRun" | "dreams" | "modelScan" | "backup" | "login" | "logout" | "breakGlass";
export type ActivityOutcome = "completed" | "failed" | "skipped" | "none";

export type ActivityEntry = {
  /** Stable key: stream, timestamp, event and trace/target. */
  id: string;
  kind: ActivityKind;
  outcome: ActivityOutcome;
  /** Epoch ms of the record. */
  at: number;
  /** The person, agent or "" when the system acted (the view then says "System"). */
  actor: string;
  /** Sentence parameters: agent, job, profile, target. Empty string when unknown. */
  params: { agent: string; job: string; profile: string; target: string };
  stream: "diagnostic" | "audit";
  /** What the "Open in log" link searches for: the trace id, else the most specific name the record has. */
  query: string;
};

const str = (v: unknown): string => (typeof v === "string" ? v : "");
const obj = (v: unknown): Record<string, unknown> => (typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : {});

/** Which feed category a scheduler job belongs to. */
export function jobKind(job: string, hasAgent: boolean): ActivityKind | null {
  const j = job.toLowerCase();
  if (/dream|consolidat|(^|[.:_-])(light|rem|deep)($|[.:_-])/.test(j)) return "dreams";
  if (/model[s]?[.:_-]?scan|scan[.:_-]?model/.test(j)) return "modelScan";
  if (/backup|snapshot/.test(j)) return "backup";
  return hasAgent ? "agentRun" : null;
}

/** One log record -> one feed entry, or null when the record is not one the feed summarises. */
export function classify(rec: LogRecord): ActivityEntry | null {
  const at = Date.parse(rec.ts);
  if (!Number.isFinite(at)) return null;
  const r = rec.record;
  const event = str(r.event) || str(r.action);
  const trace = str(r.trace_id);
  const agent = str(r.agent);
  const base = { at, stream: rec.stream, params: { agent, job: "", profile: "", target: "" } };

  if (rec.stream === "audit") {
    const detail = obj(r.detail);
    const actor = str(obj(r.actor).user);
    if (event === "auth.login" || event === "auth.logout") {
      const profile = str(detail.profile);
      return { ...base, id: `a|${rec.ts}|${event}|${trace || profile}`, kind: event === "auth.login" ? "login" : "logout", outcome: "none", actor, params: { ...base.params, profile }, query: trace || profile || event };
    }
    if (event === "user.break_glass") {
      const target = str(detail.target) || str(r.target);
      return { ...base, id: `a|${rec.ts}|${event}|${trace || target}`, kind: "breakGlass", outcome: "none", actor, params: { ...base.params, target }, query: trace || target || event };
    }
    return null;
  }

  const m = /^scheduler\.run\.(completed|failed|skipped)$/.exec(event);
  if (!m) return null;
  const job = str(obj(r.attrs).job);
  const kind = jobKind(job, agent !== "");
  if (kind === null) return null;
  return {
    ...base, id: `d|${rec.ts}|${event}|${trace || job}`, kind, outcome: m[1] as ActivityOutcome,
    actor: str(r.principal) || agent, params: { ...base.params, job }, query: trace || job || event,
  };
}

/** Classified entries, newest first (ties keep their input order). */
export function toEntries(records: readonly LogRecord[]): ActivityEntry[] {
  const out: ActivityEntry[] = [];
  for (const rec of records) { const e = classify(rec); if (e) out.push(e); }
  return out.sort((a, b) => b.at - a.at);
}

/** Merge pages without duplicates (by id), newest first. */
export function mergeEntries(a: readonly ActivityEntry[], b: readonly ActivityEntry[]): ActivityEntry[] {
  const seen = new Set<string>();
  const out: ActivityEntry[] = [];
  for (const e of [...a, ...b]) if (!seen.has(e.id)) { seen.add(e.id); out.push(e); }
  return out.sort((x, y) => y.at - x.at);
}

export type GroupId = "today" | "yesterday" | "week" | "older";
export type ActivityGroup = { id: GroupId; entries: ActivityEntry[] };

const startOfDay = (ms: number): number => { const d = new Date(ms); d.setHours(0, 0, 0, 0); return d.getTime(); };

/** Which heading an instant falls under, in the viewer's local time. Today and Yesterday are calendar days; "Earlier this week"
 *  is everything since Monday 00:00 that is not one of those; a timestamp in the future counts as today. */
export function groupOf(at: number, now: number): GroupId {
  const today = startOfDay(now);
  if (at >= today) return "today";
  const yest = new Date(today); yest.setDate(yest.getDate() - 1);
  if (at >= yest.getTime()) return "yesterday";
  const mon = new Date(today); mon.setDate(mon.getDate() - ((mon.getDay() + 6) % 7));
  return at >= mon.getTime() ? "week" : "older";
}

/** Entries (any order) -> non-empty groups in heading order, newest first inside each. */
export function groupEntries(entries: readonly ActivityEntry[], now: number): ActivityGroup[] {
  const order: GroupId[] = ["today", "yesterday", "week", "older"];
  const by = new Map<GroupId, ActivityEntry[]>(order.map((g) => [g, []]));
  for (const e of [...entries].sort((a, b) => b.at - a.at)) by.get(groupOf(e.at, now))!.push(e);
  return order.filter((g) => by.get(g)!.length > 0).map((g) => ({ id: g, entries: by.get(g)! }));
}

/** Hash route into the log viewer: `q` is the text filter (the viewer matches it with `logs.query` `text`), `stream` names the
 *  stream the entry came from. Both are encoded; the viewer owns the receiving side. */
export function logLink(e: Pick<ActivityEntry, "query" | "stream">): string {
  return `#/logs?q=${encodeURIComponent(e.query)}&stream=${e.stream}`;
}

/** The i18n key of an entry's sentence. */
export function sentenceKey(e: Pick<ActivityEntry, "kind" | "outcome">): `activity.s.${string}` {
  return e.outcome === "none" ? `activity.s.${e.kind}` : `activity.s.${e.kind}.${e.outcome}`;
}

import { t, type Key } from "../../../i18n.ts";
import { registerArea } from "../../../i18n/index.ts";
import * as activityArea from "../../../i18n/activity.ts";

registerArea("activity", activityArea);

/** The entry as a sentence in the current language. A parameter the record lacks reads "unknown". */
export function sentence(e: ActivityEntry): string {
  const p = (v: string): string => (v === "" ? t("activity.unknown") : v);
  return t(sentenceKey(e) as Key, { agent: p(e.params.agent), job: p(e.params.job), profile: p(e.params.profile), target: p(e.params.target) });
}
