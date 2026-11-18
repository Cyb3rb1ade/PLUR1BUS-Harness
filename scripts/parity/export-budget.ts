// Parity vectors (mode V) for the pure parts of budgets (P4-K K1, plan P4-24): periods and time zones, the cache-read
// weight, the zone allocation of the context window, the retry rules, the subagent result cap, the media-unit mapping and the
// text of a breach. `crates/plur1bus-core/src/budget/vectors.rs` replays every case. Recorded, never edited by hand.
//
// What these vectors do not hold is the stateful part (limits, reservations, notices, the call port): that is proven against
// the real store file (mode B, `tests/core-parity/budget-b-driver.ts`) and by Rust tests that follow the TypeScript tests.
//
// Encoding: a number JSON cannot hold is the string "NaN", "Infinity", "-Infinity" or "-0" where a number is expected.
// Periods carry the zone as given, so a vector can pin that ICU accepts `utc` and `europe/berlin` (a time-zone database
// keyed by exact name does not): those cases carry a `note`.
//
//   node --experimental-strip-types --conditions=source --no-warnings=ExperimentalWarning scripts/parity/export-budget.ts [--check]
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { allocateContext, checkZones, DEFAULT_ZONE_POLICY, type ZonePolicy } from "../../packages/core/src/budget/context.ts";
import { mediaCallUnits } from "../../packages/core/src/budget/media.ts";
import { periodBounds, validateTimeZone, type CallPeriod } from "../../packages/core/src/budget/period.ts";
import { RetryBudget, type RetryPolicy } from "../../packages/core/src/budget/retry.ts";
import { capSubagentResult } from "../../packages/core/src/budget/subagent.ts";
import { countedTokens, storedCacheReadWeight, validateCacheReadWeight } from "../../packages/core/src/budget/cache-read-weight.ts";
import { describeBreach, type Breach } from "../../packages/core/src/budget/service.ts";
import { exporterMain, sortKeysDeep } from "./lib.mjs";

const num = (v: unknown): number => (typeof v === "string" ? ({ NaN: Number.NaN, Infinity: Infinity, "-Infinity": -Infinity, "-0": -0 } as Record<string, number>)[v]! : (v as number));
const tag = (n: number): number | string => (Number.isNaN(n) ? "NaN" : n === Infinity ? "Infinity" : n === -Infinity ? "-Infinity" : Object.is(n, -0) ? "-0" : n);
const fail = (e: unknown) => ({ error: (e as Error).name, message: (e as Error).message });

// --- periods -----------------------------------------------------------------------------------------------------------------
const ZONES = ["UTC", "Europe/Berlin", "America/Los_Angeles", "Asia/Kolkata", "Pacific/Kiritimati", "Etc/GMT+12", "Australia/Lord_Howe", "Pacific/Apia", "America/Sao_Paulo"];
/** Instants around the changes of 2026 (DST in Berlin, Los Angeles, Lord Howe), the year boundary, a leap day and the three
 *  unusual days of the TypeScript tests (Apia's skipped 30 Dec 2011, Sao Paulo's skipped midnight 2018). */
const INSTANTS = [
  Date.UTC(2026, 9, 6, 13, 30), Date.UTC(2026, 9, 6, 23, 30), Date.UTC(2026, 2, 29, 12), Date.UTC(2026, 9, 25, 12), Date.UTC(2026, 2, 8, 12),
  Date.UTC(2026, 10, 1, 12), Date.UTC(2026, 9, 3, 20), Date.UTC(2026, 3, 4, 12), Date.UTC(2026, 11, 31, 20), Date.UTC(2027, 0, 1), Date.UTC(2028, 1, 29, 12),
  Date.UTC(2026, 5, 15, 11), Date.UTC(2011, 11, 29, 12), Date.UTC(2011, 11, 30, 12), Date.UTC(2018, 10, 4, 12), Date.UTC(2026, 9, 31, 22, 59, 59, 999),
];
const PERIODS: CallPeriod[] = ["day", "week", "month"];

function periodCases() {
  const rows: unknown[][] = [];
  const seen = new Set<string>();
  for (const zone of ZONES) for (const period of PERIODS) for (const base of INSTANTS) {
    const b = periodBounds(base, zone, period);
    for (const ts of [base, b.start - 1, b.start, b.end - 1, b.end]) {
      const id = `${zone}|${period}|${ts}`;
      if (seen.has(id)) continue;
      seen.add(id);
      const r = periodBounds(ts, zone, period);
      rows.push([zone, period, ts, r.key, r.start, r.end]);
    }
  }
  const errors: unknown[] = [];
  for (const zone of ["Mars/Olympus", "not a zone", "", "x".repeat(65)]) {
    try { periodBounds(Date.UTC(2026, 9, 6), zone, "day"); errors.push({ zone, period: "day", ts: Date.UTC(2026, 9, 6), error: "none" }); }
    catch (e) { errors.push({ zone, period: "day", ts: Date.UTC(2026, 9, 6), ...fail(e) }); }
  }
  const validate: unknown[] = [];
  for (const zone of ["Europe/Berlin", "UTC", "", "x".repeat(64), "x".repeat(65), "not a zone", "Mars/Olympus", "utc", "europe/berlin", "Etc/GMT+12", "Pacific/Kiritimati", "😀"]) {
    let note: string | undefined;
    if (zone === "utc" || zone === "europe/berlin") note = "ICU matches zone names case-insensitively; an adapter over a database keyed by exact name must fold the case";
    try { validate.push({ zone, ok: validateTimeZone(zone), ...(note ? { note } : {}) }); } catch (e) { validate.push({ zone, ...fail(e), ...(note ? { note } : {}) }); }
  }
  return { columns: ["zone", "period", "ts", "key", "start", "end"], rows, errors, validate };
}

// --- cache-read weight -------------------------------------------------------------------------------------------------------
function weightCases() {
  const inputs: (number | string)[] = [0, 1, 0.5, 0.1, 0.25, 0.333333, 0.0000004, 0.0000005, 0.0000006, 0.1234565, 0.999999, 0.9999995, "-0", -0.1, 1.0000001, "NaN", "Infinity", "-Infinity", 2, 1e-9];
  const validate = inputs.map((w) => { try { return { weight: w, ok: validateCacheReadWeight(num(w)) }; } catch (e) { return { weight: w, ...fail(e) }; } });
  const counted: unknown[] = [];
  for (const [io, cr] of [[1000, 900], [0, 0], [1, 1], [7, 3], [290, 0], [1_099_511_627_776, 549_755_813_888], [123_456_789, 98_765_432], [100, 100], [10, 5], [3, 1], [3, 2], [1_000_000, 999_999]] as const)
    for (const w of [0, 0.1, 0.25, 0.5, 0.333333, 0.000001, 0.999999, 1]) counted.push({ inputOutput: io, cacheReads: cr, weight: w, counted: countedTokens(io, cr, w) });
  const stored = ["0.1", "1", "0", "1.0000", "0.000001", "abc", "-0.5", "1.5", "", ".5", "1e-1", " 0.5", "0.5\n", "00.5", "0.50", "1.", "0.0000004", "0.9999995", "1.0000001", "２"].map((value) => {
    const db = new DatabaseSync(":memory:");
    db.exec("CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
    db.prepare("INSERT INTO settings VALUES ('cache_read_weight', ?)").run(value);
    const w = storedCacheReadWeight(db);
    db.close();
    return { value, weight: w };
  });
  const absent = (() => { const db = new DatabaseSync(":memory:"); db.exec("CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)"); const w = storedCacheReadWeight(db); db.close(); return w; })();
  return { validate, counted, stored, absent };
}

// --- context zones -----------------------------------------------------------------------------------------------------------
function zonePolicyFor(seed: number): ZonePolicy {
  return Object.fromEntries(Object.keys(DEFAULT_ZONE_POLICY).map((z, i) => [z, { minShare: ((seed * (i + 3)) % 10) / 100, maxShare: 0.4 }])) as ZonePolicy;
}
function contextCases() {
  const policies: Record<string, ZonePolicy> = {
    default: DEFAULT_ZONE_POLICY,
    impossible: { ...DEFAULT_ZONE_POLICY, tools: { minShare: 0.9, maxShare: 0.9 }, system: { minShare: 0.9, maxShare: 0.9 } },
    minMoreThanMax: { ...DEFAULT_ZONE_POLICY, memory: { minShare: 0.5, maxShare: 0.25 } },
    minAboveMaxTokens: { ...DEFAULT_ZONE_POLICY, memory: { minShare: 0.2, maxShare: 0.5, maxTokens: 10 } },
    badShare: { ...DEFAULT_ZONE_POLICY, volatile: { minShare: 0, maxShare: 1.5 } },
    badTokens: { ...DEFAULT_ZONE_POLICY, volatile: { minShare: 0, maxShare: 0.2, maxTokens: -1 } },
    unusedWindow: { ...DEFAULT_ZONE_POLICY, tools: { minShare: 0, maxShare: 0.05 }, system: { minShare: 0, maxShare: 0.05 } },
  };
  for (let seed = 1; seed <= 12; seed++) policies[`seed-${seed}`] = zonePolicyFor(seed);
  const windows = [0, 1, 3, 7, 13, 19, 100, 1000, 8192, 131072, 200_000, 2 ** 40, -1, 2 ** 53];
  const allocate: unknown[] = [];
  for (const [name, policy] of Object.entries(policies)) for (const window of windows) {
    try { allocate.push({ policy: name, window, result: allocateContext(window, policy) }); } catch (e) { allocate.push({ policy: name, window, ...fail(e) }); }
  }
  const zones = ["tools", "system", "memory", "conversation", "volatile"] as const;
  const check: unknown[] = [];
  const budgets = { tools: 10, system: 20, memory: 30, conversation: 40, volatile: 5 };
  for (const used of [{}, { tools: 10 }, { tools: 11 }, { tools: 11, volatile: 6, memory: 31 }, { conversation: 0 }, { tools: -1 }, { memory: 2 ** 53 }])
    try { check.push({ budgets, used, result: checkZones(budgets as never, used) }); } catch (e) { check.push({ budgets, used, ...fail(e) }); }
  try { check.push({ budgets: { ...budgets, system: -1 }, used: {}, result: checkZones({ ...budgets, system: -1 } as never, {}) }); } catch (e) { check.push({ budgets: { ...budgets, system: -1 }, used: {}, ...fail(e) }); }
  return { zones, policies, allocate, check };
}

// --- retry -------------------------------------------------------------------------------------------------------------------
type Op = { op: "consume"; turn: string; cls: string; tokens: number } | { op: "settle"; ticket: number; tokens: number } | { op: "end"; turn: string };
function retryScenario(name: string, policy: RetryPolicy | null, turnTokens: number | null, ops: Op[]) {
  const rb = new RetryBudget(policy ?? undefined, turnTokens ?? undefined);
  const results = ops.map((o) => {
    try {
      if (o.op === "consume") return { ticket: rb.consume(o.turn, o.cls as never, o.tokens) };
      if (o.op === "settle") return { settled: rb.settle(o.ticket, o.tokens) };
      rb.endTurn(o.turn); return { ended: true };
    } catch (e) {
      const x = e as Error & { failureClass?: string; reason?: string; code?: string };
      return x.code === "retry_budget_exceeded" ? { error: "exceeded", class: x.failureClass, reason: x.reason, message: x.message } : fail(e);
    }
  });
  return { name, policy, turnTokens, ops, results };
}
const uniform = (maxAttempts: number, maxTokens: number): RetryPolicy => Object.fromEntries(["rate_limit", "overloaded", "network", "timeout", "tool_call_invalid"].map((k) => [k, { maxAttempts, maxTokens }])) as never;
const graded = Object.fromEntries(["rate_limit", "overloaded", "network", "timeout", "tool_call_invalid"].map((k, i) => [k, { maxAttempts: i + 1, maxTokens: 100 }])) as never as RetryPolicy;
function retryCases() {
  const c = (turn: string, cls: string, tokens: number): Op => ({ op: "consume", turn, cls, tokens });
  const s = (ticket: number, tokens: number): Op => ({ op: "settle", ticket, tokens });
  return [
    retryScenario("defaults, attempts per class", null, null, [c("t", "rate_limit", 10), c("t", "rate_limit", 10), c("t", "rate_limit", 10), c("t", "rate_limit", 10), c("t", "timeout", 10), c("t", "timeout", 10), c("t", "overloaded", 1), c("t", "overloaded", 1), c("t", "overloaded", 1)]),
    retryScenario("classes and turns are independent, the ceiling is shared across a turn", uniform(2, 10), 15, [c("t1", "network", 5), c("t1", "network", 5), c("t1", "network", 0), c("t1", "timeout", 5), c("t1", "rate_limit", 1), c("t2", "network", 5), c("t3", "overloaded", 11)]),
    retryScenario("each class has its own attempt cap and a refusal consumes nothing", graded, 1000, [...["rate_limit", "overloaded", "network", "timeout", "tool_call_invalid"].flatMap((cls, i) => [...Array.from({ length: i + 1 }, () => c("turn", cls, 1)), c("turn", cls, 1)])]),
    retryScenario("a rejected reservation changes nothing", graded, 2, [c("x", "network", 3), c("x", "network", 2), c("x", "network", 1)]),
    retryScenario("actual tokens reconcile once and block later retries", null, 10, [c("t", "network", 5), s(1, 11), s(1, 11), c("t", "timeout", 0)]),
    retryScenario("settling below the estimate frees tokens", uniform(5, 100), 100, [c("t", "network", 60), s(1, 10), c("t", "network", 60), c("t", "network", 60)]),
    retryScenario("end of a turn forgets it and its tickets", uniform(1, 10), 10, [c("t", "network", 10), c("t", "network", 1), { op: "end", turn: "t" }, c("t", "network", 10), s(1, 1), s(2, 3)]),
    retryScenario("invalid input", null, null, [c("", "network", 1), c("t", "network", -1), c("t", "network", 9007199254740992), c("t", "toString", 0), c("t", "constructor", 0), c("t", "__proto__", 0), c("t", "hasOwnProperty", 0), c("t", "", 0), s(99, 1), c("t", "network", 1), s(1, -1), s(1, 9007199254740992)]),
    retryScenario("settle overage on a class, not on the turn", uniform(3, 10), 100, [c("t", "network", 5), s(1, 11), c("t", "network", 0), c("t", "timeout", 5)]),
    retryScenario("zero attempts and zero tokens", uniform(0, 0), 0, [c("t", "network", 0)]),
  ];
}

// --- subagent cap ------------------------------------------------------------------------------------------------------------
const COUNTERS: Record<string, (s: string) => number> = { bytes: (s) => Buffer.byteLength(s, "utf8"), codepoints: (s) => [...s].length, utf16: (s) => s.length };
function subagentCases() {
  const paragraphs = "First paragraph.\n\n" + "👩‍💻 next paragraph ".repeat(200);
  const full = { items: Array.from({ length: 1000 }, (_, i) => ({ i, text: "one paragraph.\n\n" })) };
  const cases: { name: string; value: unknown; limit?: number; counter: string; pointer: string; note?: string }[] = [
    { name: "small string passes whole", value: "small", counter: "bytes", pointer: "result:1" },
    { name: "structured result capped, full result through the port", value: sortKeysDeep(full), limit: 100, counter: "bytes", pointer: "result:123" },
    { name: "structured result within the default limit", value: { a: 1, b: [1, 2, 3], c: { d: "e" } }, counter: "bytes", pointer: "result:2" },
    { name: "empty containers print as []", value: { a: [], b: {} }, limit: 5, counter: "bytes", pointer: "p" },
    { name: "unicode and paragraph boundaries", value: paragraphs, limit: 80, counter: "bytes", pointer: "peer:full" },
    { name: "unicode, counted in code points", value: paragraphs, limit: 80, counter: "codepoints", pointer: "peer:full" },
    { name: "counted in UTF-16 units", value: "😀".repeat(40), limit: 30, counter: "utf16", pointer: "peer:full" },
    { name: "no whitespace to cut at", value: "x".repeat(500), limit: 50, counter: "bytes", pointer: "ptr" },
    { name: "a line boundary", value: "line one\nline two\nline three\nline four", limit: 40, counter: "bytes", pointer: "p" },
    { name: "limit cannot fit a marker", value: "x".repeat(100), limit: 1, counter: "bytes", pointer: "p" },
    { name: "limit cannot fit the pointer", value: "x".repeat(100), limit: 30, counter: "bytes", pointer: "a".repeat(100) },
    { name: "invalid pointer (space)", value: "x".repeat(100), limit: 80, counter: "bytes", pointer: "bad pointer" },
    { name: "invalid pointer (leading dot)", value: "x".repeat(100), limit: 80, counter: "bytes", pointer: ".x" },
    { name: "empty pointer", value: "x".repeat(100), limit: 80, counter: "bytes", pointer: "" },
    { name: "pointer of 256 characters", value: "x".repeat(2000), limit: 400, counter: "bytes", pointer: "a".repeat(256) },
    { name: "pointer of 257 characters", value: "x".repeat(2000), limit: 400, counter: "bytes", pointer: "a".repeat(257) },
    { name: "limit zero", value: "x", limit: 0, counter: "bytes", pointer: "p" },
    { name: "limit exactly the size", value: "x".repeat(10), limit: 10, counter: "bytes", pointer: "p" },
    { name: "limit one below the size", value: "x".repeat(11), limit: 10, counter: "bytes", pointer: "p" },
    { name: "number value", value: 12345, limit: 3, counter: "bytes", pointer: "p" },
    { name: "null value", value: null, limit: 1, counter: "bytes", pointer: "p" },
  ];
  return cases.map((c) => {
    let stored: unknown = "unset";
    try {
      const r = capSubagentResult(c.value, { ...(c.limit === undefined ? {} : { limit: c.limit }), countTokens: COUNTERS[c.counter]!, port: { store(v) { stored = v; return c.pointer; } } });
      return { ...c, stored: stored === "unset" ? "none" : "value", result: r.kind === "complete" ? { kind: "complete" } : r };
    } catch (e) { return { ...c, stored: stored === "unset" ? "none" : "value", ...fail(e) }; }
  });
}

// --- media units -------------------------------------------------------------------------------------------------------------
function mediaCases() {
  const units: ({ unit: "image" | "videoSecond"; quantity: number | string } | null)[] = [
    { unit: "image", quantity: 3 }, { unit: "videoSecond", quantity: 8 }, { unit: "videoSecond", quantity: 4.2 }, { unit: "image", quantity: 2.5 }, { unit: "image", quantity: 0 },
    { unit: "videoSecond", quantity: 0.0001 }, { unit: "image", quantity: "-0" }, { unit: "image", quantity: -1 }, { unit: "image", quantity: "NaN" }, { unit: "videoSecond", quantity: "Infinity" }, null,
  ];
  return units.map((u) => { try { return { units: u, result: mediaCallUnits(u === null ? null : { unit: u.unit, quantity: num(u.quantity) }) }; } catch (e) { return { units: u, ...fail(e) }; } });
}

// --- breach text -------------------------------------------------------------------------------------------------------------
function breachCases() {
  const out: unknown[] = [];
  for (const scope of ["global", "agent"] as const) for (const period of ["day", "month"] as const) for (const metric of ["tokens", "images", "videoSeconds"] as const)
    for (const resetsAt of [Date.UTC(2026, 9, 7), Date.UTC(2026, 10, 1, 7), 0, 8_640_000_000_000_000]) {
      const b: Breach = { kind: "hard", scope, ...(scope === "agent" ? { agentId: "a1" } : {}), period, metric, limit: 2000, used: 1900, estimate: 200, periodKey: "k", resetsAt };
      out.push({ breach: b, text: describeBreach(b) });
    }
  return out;
}

export async function buildBudgetVectors() {
  return { period: periodCases(), weight: weightCases(), context: contextCases(), retry: retryCases(), subagent: subagentCases(), media: mediaCases(), breach: breachCases() };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  process.exitCode = await exporterMain({ area: "budget", build: buildBudgetVectors });
}
void tag;
