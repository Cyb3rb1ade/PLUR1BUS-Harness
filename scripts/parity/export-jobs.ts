// Parity vectors (mode V) for jobs (P4-K K7a, plan P4-51): the cron evaluator the user jobs schedule with
// (`packages/core/src/dreams/cron.ts`), the user jobs (`packages/core/src/user-jobs/index.ts`) and the system jobs registry with
// its run ledger (`packages/core/src/system-jobs/{index,ledger}.ts`), plus `armApprovalsIntegrity`
// (`packages/core/src/approvals/integrity-job.ts`). The real TypeScript implementation runs over temporary files with a scripted
// clock, scripted ids (`randomUUID` of `k3b-support.ts`) and scripted ports; `crates/plur1bus-core/src/jobs/*/vectors.rs`
// replays every case and must give the same answers, the same audit lines and events, the same rows and files.
// Recorded, never edited by hand.
//
//   cron.json    parseCron over expressions (what JavaScript's `\s`, `\d`, `Number` and `split` make of them) and nextAfter over zones
//                with the DST edges generated from the zone's own offsets, 29 February, month ends and the day-of-month/week rule
//   user.json    scenarios over a real `user-jobs.sqlite`: validation of a definition field by field, who may create, see, change,
//                trigger and delete, takeover by `update`, runs and their outcomes, rights lost since the job was saved, claims,
//                history limits, restart, corrupt rows, a closed or stopping service; each op with its answer, audit lines and events
//   system.json  scenarios over a real ledger directory: the registry (conflicts, exclusive lock, exceptions, clock steps back),
//                the ledger file after every op (torn last line, rotation at 1 MiB, unreadable and corrupt rows, abandoned runs),
//                `history` queries, and the arm of the approvals integrity job against recorded timers
//
// Lone surrogates cannot be held by the Rust side (`J`), and a job definition that holds one is not in the vectors.
//
//   node --experimental-strip-types --conditions=source --no-warnings=ExperimentalWarning scripts/parity/export-jobs.ts [--check]
import { mkdirSync, mkdtempSync, readFileSync, existsSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { exporterMain } from "./lib.mjs";
import { installScriptedRandom, schemaOf } from "./k3b-support.ts";

/** Every row of the two tables in `rowid` order; a column that is not JSON is `{ "$raw": text }` (a corrupt row is a case). */
function dumpTables(path: string, tables: Record<string, string[]>): Record<string, unknown[][]> {
  const db = new DatabaseSync(path);
  try {
    const out: Record<string, unknown[][]> = {};
    for (const [t, jsonCols] of Object.entries(tables)) {
      const rows = db.prepare(`SELECT * FROM ${t} ORDER BY rowid`).all() as Record<string, unknown>[];
      out[t] = rows.map((r) => Object.entries(r).map(([k, v]) => { if (jsonCols.includes(k) && typeof v === "string") { try { return JSON.parse(v); } catch { return { $raw: v }; } } return v; }));
    }
    return out;
  } finally { db.close(); }
}

const { parseCron, nextAfter, isValidTimezone } = await import("../../packages/core/src/dreams/cron.ts");
const { UserJobs } = await import("../../packages/core/src/user-jobs/index.ts");
const { createSystemJobs } = await import("../../packages/core/src/system-jobs/index.ts");
const { armApprovalsIntegrity } = await import("../../packages/core/src/approvals/integrity-job.ts");
const { RpcError } = await import("../../packages/core/src/rpc/errors.ts");

const MIN = 60_000, HOUR = 3_600_000, DAY = 86_400_000;
/** A number JSON cannot hold, or one a scenario spells out. */
const num = (x: unknown): unknown => (x && typeof x === "object" && "$num" in (x as object) ? Number((x as { $num: string }).$num) : x);
/** An error as a vector holds it: the RPC code with its text and detail, or the class name and message for anything else. */
const errOf = (e: unknown): Record<string, unknown> => {
  const err = e as { error?: unknown; name?: string; message?: string; reason?: string; detail?: string };
  return typeof err?.error === "string" && err.error.startsWith("E_")
    ? { code: err.error, message: String(err.message), ...(err.reason !== undefined ? { reason: err.reason } : {}), ...(err.detail !== undefined ? { detail: err.detail } : {}) }
    : { name: err?.name ?? "Error", message: String(err?.message) };
};

// --- cron -----------------------------------------------------------------------------------------------------------------
const PARSE_EXPRS = [
  "* * * * *", "0 0 * * *", "*/15 * * * *", "5/20 * * * *", "0-59/7 * * * *", "1,2,3 4,5 6,7 8,9 0,1", "0 0 * * 7", "0 0 * * 0", "0 0 * * 0,7", "0 0 1 1 *", "59 23 31 12 6", "0 0 29 2 *",
  "*/2 * * * *", "0 0 */2 * *", "0 0 * * */2", "0 0 1-5 * 1-5", "0 0 * 1-12/3 *", "0 0 * * 5-7", "0 0 * * 6-7", "0 0 * * 7-7", "10-5 * * * *",
  "", " ", "* * * *", "* * * * * *", "0 0 * * mon", "0 0 * jan *", "@daily", "L * * * *", "0 0 ? * *", "H * * * *",
  "+1 * * * *", "-1 * * * *", "1.5 * * * *", "1e1 * * * *", "0x1 * * * *", "0b1 * * * *", "٣ * * * *", "３ * * * *", "1_0 * * * *", "01 * * * *", "007 * * * *", "00 * * * *", "060 * * * *",
  "60 * * * *", "* 24 * * *", "* * 0 * *", "* * 32 * *", "* * * 0 *", "* * * 13 *", "* * * * 8", "0-60 * * * *", "* 0-24 * * *", "* * 1-32 * *",
  "1,,2 * * * *", ",1 * * * *", "1, * * * *", "1//2 * * * *", "5/ * * * *", "/5 * * * *", "*/ * * * *", "*/0 * * * *", "*/-1 * * * *", "*/+1 * * * *", "*/1.5 * * * *", "*/００ * * * *", "1-2-3 * * * *", "1- * * * *", "-5 * * * *", "*-5 * * * *", "**/2 * * * *", "* /2 * * * *", "*/2/3 * * * *",
  "﻿0 0 * * *", "0﻿0 * * *", "0 0 * * *﻿", "0 0 0 * *", "0 0 0 * *", "0\u00850 0 * *", "0​0 0 * *", "0᠎0 0 * *", "0　0 0 * *", "0\t0\n0\r*\u000B*", "0\u000C0 0 * *",
  "0 0 * * *\n", "0 0 * * *\n0", "  0   0   *  *  *  ", "9".repeat(400) + " * * * *", "0/" + "9".repeat(400) + " * * * *", "0-" + "9".repeat(400) + " * * * *", "0/0000000001 * * * *", "0/1e3 * * * *",
  "*,5 * * * *", "5,* * * * *", "*/20,5 * * * *", "5,*/20 * * * *", "0,0,0 * * * *", "59,0 * * * *", "0 0,12,23 * * *", "0 0 1,15,31 * *", "0 0 * 2,4,6 *",
  "0 0 31 * 1", "0 0 31 * *", "0 0 * * 1", "0 0 15 * 1,3", "0 0 */5 * */3", "0 0 1-31/2 * *",
];
function cronVectors() {
  const parse = PARSE_EXPRS.map((expr) => {
    try { const c = parseCron(expr); return { expr, ok: { minutes: c.minutes, hours: c.hours, doms: c.doms, months: c.months, dows: c.dows, domRestricted: c.domRestricted, dowRestricted: c.dowRestricted } }; }
    catch (e) { return { expr, err: String((e as Error).message) }; }
  });
  const ZONES = ["UTC", "utc", "Europe/Berlin", "europe/BERLIN", "America/New_York", "Australia/Lord_Howe", "Asia/Kolkata", "America/St_Johns", "Pacific/Chatham", "Asia/Kathmandu", "Europe/Dublin", "America/Sao_Paulo", "Pacific/Apia", "Pacific/Kiritimati", "Antarctica/Troll", "+05:30", "-0330", "+00", "−01:00", "Etc/GMT+5", "America/Havana", "Asia/Tehran"];
  const BAD_ZONES = ["", " ", "Europe/Berlin ", " Europe/Berlin", "Europe/Nowhere", "UTC+1", "GMT+1", "+24:00", "+0160", "+1", "+001", "Z", "EST", "est", "CET", "Europe\\Berlin", "europe/berlin\n", "Asia/Calcutta", "Asia/Kolkata\u0000", "+05:30:00", "±05:30"];
  // The zone's own transitions in 2025 and 2026: found by walking its offsets, so a case sits exactly on each edge.
  const offsetAt = (tz: string, ms: number) => { const f = new Intl.DateTimeFormat("en-US", { timeZone: tz, hourCycle: "h23", year: "numeric", month: "numeric", day: "numeric", hour: "numeric", minute: "numeric", second: "numeric" }); const p: Record<string, number> = {}; for (const x of f.formatToParts(new Date(ms))) if (x.type !== "literal") p[x.type] = Number(x.value); return Date.UTC(p.year!, p.month! - 1, p.day!, p.hour! % 24, p.minute!, p.second!) - ms; };
  const transitions = (tz: string): number[] => {
    const out: number[] = []; let prev = offsetAt(tz, Date.UTC(2025, 0, 1));
    for (let t = Date.UTC(2025, 0, 1) + 6 * HOUR; t < Date.UTC(2027, 0, 1); t += 6 * HOUR) {
      const o = offsetAt(tz, t);
      if (o !== prev) { let lo = t - 6 * HOUR, hi = t; while (hi - lo > 1000) { const mid = Math.floor((lo + hi) / 2000) * 1000; if (offsetAt(tz, mid) === prev) lo = mid; else hi = mid; } out.push(hi); prev = o; }
    }
    return out;
  };
  const next: unknown[] = [];
  // Beyond 2037 the Rust zone tables (chrono-tz) hold no DST rules; a case there carries `later` and the replay allows the
  // known gap for zones that observe DST (finding K7-D4). Africa/Casablanca is left out: its rules differ between tz database
  // releases (the ICU of this Node and the tables of the Rust crate), so a recording of it would depend on the machine.
  const add = (cron: string, tz: string, from: number, note?: string) => {
    const later = from > Date.UTC(2037, 11, 31) && from < 8e15 ? { later: true } : {};
    try { const c = parseCron(cron); next.push({ cron, tz, from, next: nextAfter(c, tz, from), ...later, ...(note ? { note } : {}) }); }
    catch (e) { next.push({ cron, tz, from, err: String((e as Error).message), ...later, ...(note ? { note } : {}) }); }
  };
  const EDGE_CRONS = ["30 2 * * *", "0 2 * * *", "30 1 * * *", "0 3 * * *", "59 1 * * *", "0 0 * * *", "*/30 * * * *", "15,45 1-3 * * *", "0 12 * * *", "0 0 * * 1", "30 2 25-31 3,10 0"];
  for (const tz of ZONES) {
    for (const t of transitions(tz)) {
      for (const cron of EDGE_CRONS.slice(0, tz === "Europe/Berlin" || tz === "America/New_York" || tz === "Australia/Lord_Howe" || tz === "Pacific/Chatham" ? EDGE_CRONS.length : 4)) {
        for (const from of [t - 2 * HOUR, t - MIN, t - 1, t, t + MIN, t + HOUR, t + 2 * HOUR, t + DAY]) add(cron, tz, from);
      }
    }
  }
  const FROMS = [0, 1, Date.UTC(2024, 0, 31, 23, 59), Date.UTC(2024, 1, 28, 23, 59, 59), Date.UTC(2024, 1, 29, 0, 0), Date.UTC(2025, 1, 28, 12, 0), Date.UTC(2026, 11, 31, 23, 59, 59, 999), Date.UTC(2027, 4, 15, 8, 30), Date.UTC(2100, 1, 28, 12, 0), Date.UTC(1969, 11, 31, 23, 59), Date.UTC(1900, 0, 1)];
  const CALENDAR = ["0 0 29 2 *", "0 0 30 2 *", "0 0 31 * *", "0 0 30 * *", "0 0 31 4,6,9,11 *", "0 0 1 * *", "59 23 L * *", "0 0 * * 7", "0 0 * * 0", "0 0 13 * 5", "0 0 13 * *", "0 0 * * 5", "0 0 1,15 * 1", "0 0 */2 * *", "*/15 * * * *", "* * * * *", "0 0 29-31 * *", "0 0 1 1 *", "0 0 29 2 1", "0 0 31 12 *", "0 0 31 2 *", "30 23 28-31 * *"];
  for (const cron of CALENDAR) for (const tz of ["UTC", "Europe/Berlin", "America/New_York", "Pacific/Auckland", "Pacific/Kiritimati", "+13:00"]) for (const from of FROMS) add(cron, tz, from);
  for (const tz of BAD_ZONES) for (const from of [0, Date.UTC(2026, 5, 1)]) { add("0 0 * * *", tz, from, isValidTimezone(tz) ? "accepted" : "unknown zone"); }
  // The edges of Date: the last and first instants a Date holds, and one beyond.
  // Near the earliest instant the real function answers with an instant in the far future (the year arithmetic wraps); Rust refuses it (finding K7-D5), so those two are not recorded.
  for (const from of [8.64e15, 8.64e15 - DAY, 8.64e15 + 1, -8.64e15 - 1]) for (const tz of ["UTC", "Europe/Berlin", "+05:30"]) add("0 0 * * *", tz, from, "edge of Date");
  // Years before 1900: the zone's local mean time, with offsets in seconds.
  for (const tz of ["Europe/Amsterdam", "Europe/Berlin", "America/New_York", "Asia/Kolkata", "Australia/Sydney"]) for (const from of [Date.UTC(1850, 5, 1), Date.UTC(1899, 11, 31), Date.UTC(1920, 3, 1), Date.UTC(1937, 5, 1)]) for (const cron of ["0 0 * * *", "30 12 * * *", "*/20 * * * *"]) add(cron, tz, from, "historic offset");
  const validTz = [...ZONES, ...BAD_ZONES].map((tz) => ({ tz, valid: isValidTimezone(tz) }));
  return { parse, next, validTz };
}

// --- user jobs ------------------------------------------------------------------------------------------------------------
const T0 = Date.UTC(2026, 5, 1, 8, 0);
const PRINCIPALS: Record<string, any> = {
  olga: { role: "owner", kind: "person" },
  adam: { role: "admin", kind: "person" },
  otto: { role: "operator", kind: "person" },
  mia: { role: "member", kind: "person" },
  mel: { role: "member", kind: "person", agentRights: { main: "manage" } },
  mu: { role: "member", kind: "person", agentRights: { main: "use" } },
  mon: { role: "member", kind: "person", agentRights: { other: "manage", main: "use" } },
  vera: { role: "viewer", kind: "person", agentRights: { main: "manage" } },
  bot: { role: "owner", kind: "agent" },
  nokind: { role: "owner" },
};
const uworld = (over: Record<string, unknown> = {}) => ({ now: T0, principals: PRINCIPALS, agents: ["main", "other", "helper"], agentList: null as string[] | null, blocked: [] as string[], deliveryOk: ["chan:ok"], validate: true, displayNames: { olga: "Olga", mel: "Mel" } as Record<string, string> | null, ...over });
const who = (id: string, over: Record<string, unknown> = {}) => (PRINCIPALS[id] === undefined && !over.role ? { userId: id } : { userId: id, ...PRINCIPALS[id], ...over });
const job = (over: Record<string, unknown> = {}) => ({ name: "Daily", agentId: "main", prompt: "Summarize", schedule: { cron: "0 9 * * *", timezone: "Europe/Berlin" }, enabled: true, ...over });

async function userRun(name: string, w0: any, ops: any[]) {
  const dir = mkdtempSync(join(tmpdir(), "p4k-jobs-"));
  const path = join(dir, "state", "user-jobs.sqlite");
  const w = structuredClone(w0);
  const audit: any[] = [], events: any[] = [], calls: any[] = [], ids: string[] = [];
  const steps: unknown[] = [];
  const submits: any[] = [];
  random.reset();
  const options = () => ({
    path, clock: () => w.now,
    audit: { append: (e: any) => { if (w.auditFail) throw new Error("audit unavailable"); audit.push(structuredClone(e)); } },
    agentExists: (id: string) => w.agents.includes(id),
    agents: () => w.agentList ?? w.agents,
    resolve: (id: string) => { const p = w.principals[id]; return p ? { userId: id, ...structuredClone(p) } : null; },
    ...(w.displayNames === null ? {} : { displayName: (id: string) => { if (w.displayThrows) throw new Error("display"); return w.displayNames[id]; } }),
    budgetBlocked: (a: string) => w.blocked.includes(a),
    notify: (r: any) => { events.push({ notify: structuredClone(r) }); if (w.notifyThrows) throw new Error("notify"); },
    onRecorded: (r: any) => { events.push({ recorded: structuredClone(r) }); if (w.recordedThrows) throw new Error("recorded"); },
    submitTurn: async (j: any, person: any) => {
      events.push({ turn: { job: j.id, runAs: j.runAs, person: person.userId, role: person.role } });
      const s = submits.shift() ?? {};
      if (s.advance) w.now += s.advance;
      if (s.during) { const nested = []; for (const op of s.during) nested.push({ op, out: await apply(op) }); events.push({ nested }); }
      if (s.throws) throw new Error("turn failed");
      return s.outcome ?? "completed";
    },
    ...(w.validate ? { validateDelivery: (id: string, person: string, agentId: string) => { calls.push([id, person, agentId]); if (!w.deliveryOk.includes(id)) throw new RpcError("E_DENIED", "delivery destination denied", { reason: "delivery" }); } } : {}),
    isStopping: () => w.stopping === true,
  });
  let d = new UserJobs(options() as any);
  const idOf = (op: any) => (op.nth !== undefined ? ids[op.nth] : op.id);
  const note = (r: any) => { if (r && typeof r.id === "string" && r.id.startsWith("user:") && !ids.includes(r.id)) ids.push(r.id); return r; };
  const withId = (patch: any, op: any) => ({ ...patch, ...(op.nth !== undefined ? { id: ids[op.nth] } : {}) });
  async function apply(op: any): Promise<unknown> {
    try {
      switch (op.op) {
        case "create": return { ok: note(d.create(op.input, op.caller)) };
        case "update": return { ok: d.update(withId(op.patch, op), op.caller) };
        case "delete": return { ok: d.delete(idOf(op), op.confirm, op.caller) };
        case "list": return { ok: d.list(op.caller) };
        case "targets": return { ok: d.targets(op.caller) };
        case "history": return { ok: d.history(op.id !== undefined ? op.id : op.nth !== undefined ? ids[op.nth] : undefined, op.caller, op.limit === undefined ? undefined : num(op.limit) as number) };
        case "get": return { ok: d.get(idOf(op)) };
        case "has": return { ok: d.has(idOf(op)) };
        case "tick": await d.tick(); return { ok: null };
        case "run": return { ok: await d.run(idOf(op), op.caller) };
        case "advance": w.now += op.ms; return { ok: w.now };
        case "world": Object.assign(w, op.patch); return { ok: null };
        case "principal": if (op.principal === null) delete w.principals[op.person]; else w.principals[op.person] = op.principal; return { ok: null };
        case "submit": submits.push(...op.steps); return { ok: null };
        case "close": d.close(); return { ok: null };
        case "reopen": d.close(); d = new UserJobs(options() as any); return { ok: null };
        case "raw": { const db = new DatabaseSync(path); db.prepare(op.sql).run(...(op.args ?? [])); db.close(); return { ok: null }; }
        case "rawJob": { const db = new DatabaseSync(path); const j = { ...structuredClone(op.job), id: op.job.id ?? ids[op.nth] }; db.prepare("INSERT INTO user_jobs VALUES (?,?) ON CONFLICT(id) DO UPDATE SET definition=excluded.definition").run(j.id, JSON.stringify(j)); db.close(); return { ok: null }; }
        case "has-id": return { ok: ids.length };
        default: throw new Error(`unknown op ${op.op}`);
      }
    } catch (e) { return { err: errOf(e) }; }
  }
  try {
    for (const op of ops) {
      audit.length = 0; events.length = 0; calls.length = 0;
      const out = await apply(op);
      steps.push({ op, out, ...(audit.length ? { audit: audit.map((a) => ({ at: a.at, user: a.actor.user, host: a.actor.host, action: a.action, target: a.target, detail: a.detail })) } : {}), ...(events.length ? { events: structuredClone(events) } : {}), ...(calls.length ? { calls: structuredClone(calls) } : {}) });
    }
    d.close();
    return { name, world: w0, ops: steps, final: { tables: dumpTables(path, { user_jobs: ["definition"], user_job_runs: ["record"] }), schema: schemaOf(path), ids } };
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

const create = (caller: string, over: Record<string, unknown> = {}, extra: Record<string, unknown> = {}) => ({ op: "create", caller: who(caller), input: job(over), ...extra });
const createRaw = (caller: string, input: unknown) => ({ op: "create", caller: who(caller), input });
const update = (caller: string, patch: Record<string, unknown>, extra: Record<string, unknown> = {}) => ({ op: "update", caller: who(caller), nth: 0, patch, ...extra });
const del = (caller: string, extra: Record<string, unknown> = {}) => ({ op: "delete", caller: who(caller), nth: 0, confirm: true, ...extra });
const list = (caller: string) => ({ op: "list", caller: who(caller) });
const history = (caller: string, extra: Record<string, unknown> = {}) => ({ op: "history", caller: who(caller), ...extra });
const run = (caller: string, extra: Record<string, unknown> = {}) => ({ op: "run", caller: who(caller), nth: 0, ...extra });
const tick = { op: "tick" };
const advance = (ms: number) => ({ op: "advance", ms });
const submit = (...steps: Record<string, unknown>[]) => ({ op: "submit", steps });
const NAMES = ["", " ", " ﻿ ", "\u0085", "᠎", "a", " padded ", "x".repeat(128), "x".repeat(129), "😀".repeat(64), "😀".repeat(65), "a\u0000b", "a\u001fb", "a\u007fb", "a\u0080b", "a\nb", "a\tb", "é", "​", "퟿", "￿"];
const PROMPTS = ["", "   ", "﻿ ", "\u0085", "x", "x".repeat(4000), "x".repeat(4001), "😀".repeat(2000), "😀".repeat(2001), "a\u0000b", "a\nb\tc", "\u0000"];
const AGENT_IDS = ["main", "other", "helper", "Main", "MAIN", "-main", "_main", "9a", "a", "a".repeat(64), "a".repeat(65), "a\n", "main\n", "ma in", "ma.in", "ma/in", "ａ", "é", "", "unknown", "ghost-agent", "a-b_c"];
const CRONS = ["0 9 * * *", "* * * * *", "0 0 30 2 *", "0 0 31 4 *", "0 0 29 2 *", "bad", "", "0 9 * *", "﻿0 9 * * *", "0 9 * * 7", "+0 9 * * *", "0 9 * * *" + " ".repeat(119), "0 9 * * *" + " ".repeat(120), "0 0 * * mon", "*/0 * * * *", "٠ 9 * * *"];
const ZONES2 = ["Europe/Berlin", "UTC", "utc", "+05:30", "", " ", "Europe/Nowhere", "Europe/Berlin ", "x".repeat(128), "x".repeat(129), "EUROPE/berlin", "America/St_Johns"];

async function userScenarios() {
  const out: unknown[] = [];
  const W = uworld();
  // 1. The definition, field by field.
  out.push(await userRun("create-name-and-prompt", W, [
    ...NAMES.map((n) => create("olga", { name: n })), ...PROMPTS.map((p) => create("olga", { prompt: p })),
    create("olga", { name: 5 }), create("olga", { name: null }), create("olga", { name: ["a"] }), create("olga", { prompt: 5 }), create("olga", { prompt: null }),
  ]));
  out.push(await userRun("create-agent-and-enabled", W, [
    ...AGENT_IDS.map((a) => create("olga", { agentId: a })),
    create("olga", { agentId: 5 }), create("olga", { agentId: null }), create("olga", { agentId: ["main"] }), create("olga", { agentId: { toString: "main" } }),
    ...[true, false, "true", "false", 1, 0, null, "", [], {}].map((e) => create("olga", { enabled: e })),
    createRaw("olga", { ...job(), enabled: undefined }), createRaw("olga", { name: "x", agentId: "main", prompt: "p", schedule: job().schedule }),
  ]));
  out.push(await userRun("create-schedule", W, [
    ...CRONS.map((c) => create("olga", { schedule: { cron: c, timezone: "Europe/Berlin" } })),
    ...ZONES2.map((z) => create("olga", { schedule: { cron: "0 9 * * *", timezone: z } })),
    create("olga", { schedule: null }), create("olga", { schedule: 0 }), create("olga", { schedule: "" }), create("olga", { schedule: "0 9 * * *" }), create("olga", { schedule: [] }), create("olga", { schedule: ["0 9 * * *", "UTC"] }),
    create("olga", { schedule: { cron: "0 9 * * *" } }), create("olga", { schedule: { timezone: "UTC" } }), create("olga", { schedule: { cron: 5, timezone: "UTC" } }), create("olga", { schedule: { cron: "0 9 * * *", timezone: 5 } }),
    create("olga", { schedule: { cron: "0 9 * * *", timezone: "UTC", extra: 1 } }), create("olga", { schedule: { cron: "0 9 * * *", timezone: "UTC", every: null } }),
    create("olga", { schedule: { cron: "0 0 30 2 *", timezone: "UTC" }, enabled: false }),
  ]));
  out.push(await userRun("create-keys-and-delivery", W, [
    createRaw("olga", { ...job(), runAs: "bob" }), createRaw("olga", { ...job(), id: "user:x" }), createRaw("olga", { ...job(), kind: "user" }), createRaw("olga", { ...job(), nextRunAt: 1 }), createRaw("olga", { ...job(), extra: 1 }),
    createRaw("olga", []), createRaw("olga", "x"), createRaw("olga", 5), createRaw("olga", {}),
    create("olga", { deliveryTarget: "chan:ok" }), create("olga", { deliveryTarget: "chan:no" }), create("olga", { deliveryTarget: "" }), create("olga", { deliveryTarget: 5 }), create("olga", { deliveryTarget: null }), create("olga", { deliveryTarget: false }), create("olga", { deliveryTarget: ["chan:ok"] }),
    { op: "world", patch: { validate: false } }, create("olga", { deliveryTarget: "chan:ok" }), create("olga", { deliveryTarget: "" }), create("olga"),
  ]));
  // 2. Who may create.
  out.push(await userRun("create-rights", W, [
    ...["olga", "adam", "otto", "mia", "mel", "mu", "mon", "vera", "bot", "nokind"].flatMap((p) => [create(p), create(p, { agentId: "other" }), create(p, { agentId: "ghost-agent" })]),
    { op: "create", caller: { userId: "", role: "owner", kind: "person" }, input: job() }, { op: "create", caller: { userId: "x", role: "superuser", kind: "person" }, input: job() }, { op: "create", caller: { userId: "x", role: "owner", kind: "agent" }, input: job() },
    { op: "world", patch: { stopping: true } }, create("olga"), { op: "world", patch: { stopping: false, auditFail: true } }, create("olga"), list("olga"), { op: "world", patch: { auditFail: false } }, create("olga"),
  ]));
  // 3. Visibility.
  const PEOPLE = ["olga", "adam", "otto", "mia", "mel", "mu", "mon", "vera", "bot", "nokind"];
  out.push(await userRun("visibility", W, [
    create("mel"), create("olga", { agentId: "other", name: "Other" }), create("adam", { agentId: "helper", name: "Helper" }), create("mel", { name: "Second" }),
    ...PEOPLE.flatMap((p) => [list(p), history(p), { op: "targets", caller: who(p) }]),
    tick, ...PEOPLE.flatMap((p) => [history(p), history(p, { nth: 0 })]),
    { op: "principal", person: "mu", principal: { role: "member", kind: "person", agentRights: { main: "use", other: "use" } } }, list("mu"), { op: "principal", person: "mel", principal: { role: "member", kind: "person" } }, list("mel"), history("mel"),
    { op: "world", patch: { agentList: ["main", "ghost", "other", "helper"], agents: ["main", "other"] } }, { op: "targets", caller: who("olga") }, { op: "targets", caller: who("mon") },
  ]));
  // 4. Update: takeover, rights, validation.
  out.push(await userRun("update", W, [
    create("mel"), update("mel", { name: "  Renamed  " }), update("olga", { prompt: "New prompt" }), update("adam", { enabled: false }), update("olga", { enabled: true }), update("mia", { name: "x" }), update("mu", { name: "x" }), update("vera", { name: "x" }),
    update("mel", {}), update("mel", { id: "user:nope" }), { op: "update", caller: who("mel"), patch: { id: "other:job", name: "x" } },
    update("mel", { runAs: "x" }), update("mel", { kind: "system" }), update("mel", { nextRunAt: 5 }), update("mel", { createdBy: "x" }), update("mel", { agentId: "other" }), update("mel", { agentId: "ghost-agent" }), update("olga", { agentId: "other" }),
    update("mel", { schedule: { cron: "0 0 30 2 *", timezone: "UTC" } }), update("mel", { schedule: { cron: "0 8 * * *", timezone: "Asia/Kolkata" } }), update("mel", { name: "" }), update("mel", { deliveryTarget: "chan:ok" }), update("mel", { deliveryTarget: "chan:no" }), update("mel", { deliveryTarget: null }), update("mel", { deliveryTarget: "" }),
    { op: "get", nth: 0 }, { op: "get", id: "user:nope" }, { op: "get", id: "system:x" }, { op: "get", id: "" }, { op: "has", nth: 0 }, { op: "has", id: "user:nope" },
    { op: "principal", person: "mel", principal: null }, update("mel", { enabled: true }), update("mel", { enabled: false }), update("olga", { enabled: true }),
    { op: "principal", person: "adam", principal: { role: "admin", kind: "agent" } }, update("adam", { enabled: true }), update("adam", { enabled: false }),
    { op: "world", patch: { auditFail: true } }, update("olga", { name: "audit fails" }), { op: "world", patch: { auditFail: false } }, update("olga", { name: "audit works" }),
    { op: "world", patch: { agents: ["other"] } }, update("olga", { name: "agent gone" }), update("olga", { agentId: "other" }),
  ]));
  out.push(await userRun("update-enable-needs-live-use-right", W, [
    create("mel"), { op: "principal", person: "mel", principal: { role: "member", kind: "person", agentRights: { main: "use" } } }, update("mel", { enabled: false }), update("mel", { enabled: true }),
    { op: "principal", person: "mel", principal: { role: "member", kind: "person", agentRights: { main: "manage" } } }, update("mel", { enabled: true }),
    { op: "principal", person: "mel", principal: { role: "member", kind: "person", agentRights: { other: "manage" } } }, update("mel", { enabled: false }),
  ]));
  // 5. Delete.
  out.push(await userRun("delete", W, [
    create("mel"), create("olga", { agentId: "other" }),
    { op: "delete", caller: who("mel"), nth: 0, confirm: false }, { op: "delete", caller: who("mel"), nth: 0, confirm: "true" }, { op: "delete", caller: who("mel"), nth: 0, confirm: 1 }, { op: "delete", caller: who("mel"), nth: 0 }, { op: "delete", caller: who("mel"), nth: 0, confirm: null },
    del("mia"), del("mu"), del("vera"), del("bot"), del("nokind"), { op: "delete", caller: who("mel"), nth: 1, confirm: true }, { op: "delete", caller: who("mel"), id: "user:nope", confirm: true }, { op: "delete", caller: who("mel"), id: "system:x", confirm: true },
    { op: "world", patch: { auditFail: true } }, del("mel"), { op: "world", patch: { auditFail: false } }, list("olga"), del("adam"), del("adam"), list("olga"), history("olga"),
  ]));
  return out;
}

// Runs, claims and the rights a job meets when it runs (appended to the scenarios above).
async function userRunScenarios() {
  const out: unknown[] = [];
  const W = uworld();
  const due = (ms = 0) => [advance(DAY + ms)];
  out.push(await userRun("tick-due-boundaries", W, [
    create("mel"), create("mel", { name: "Hourly", schedule: { cron: "0 * * * *", timezone: "UTC" } }), create("mel", { name: "Off", enabled: false }),
    tick, { op: "get", nth: 0 }, advance(HOUR - 1), tick, advance(1), tick, history("olga"), { op: "get", nth: 1 },
    ...due(), tick, history("olga"), tick, { op: "get", nth: 0 }, list("olga"),
  ]));
  out.push(await userRun("outcomes", W, [
    create("mel"), create("mel", { name: "B", agentId: "main" }), create("mel", { name: "C" }), create("mel", { name: "D" }), create("mel", { name: "E" }), create("mel", { name: "F" }), create("mel", { name: "G" }),
    ...due(), submit({ outcome: "completed" }, { throws: true }, { outcome: "approval_timeout" }, { outcome: "skipped_agent_inactive" }, { outcome: "abandoned" }, { outcome: "failed" }, { outcome: "skipped_budget" }), tick, history("olga"), list("olga"),
    { op: "world", patch: { notifyThrows: true, recordedThrows: true } }, { op: "get", nth: 0 },
  ]));
  out.push(await userRun("skipped-runs-switch-the-job-off", W, [
    create("mel"), create("mel", { name: "B" }), create("mel", { name: "C" }), create("mel", { name: "D", agentId: "main" }), create("mel", { name: "E" }),
    ...due(),
    { op: "principal", person: "mel", principal: { role: "member", kind: "person" } }, tick, history("olga"), list("olga"),
    { op: "principal", person: "mel", principal: { role: "member", kind: "person", agentRights: { main: "manage" } } }, update("mel", { enabled: true }, { nth: 0 }), { op: "get", nth: 0 },
    advance(DAY), { op: "principal", person: "mel", principal: null }, tick, history("olga"), { op: "get", nth: 0 },
    { op: "principal", person: "mel", principal: { role: "member", kind: "agent", agentRights: { main: "manage" } } }, update("olga", { enabled: true }, { nth: 0 }), advance(DAY), tick, { op: "get", nth: 0 },
    { op: "principal", person: "olga", principal: { role: "owner", kind: "person" } }, update("olga", { enabled: true }, { nth: 0 }), advance(DAY), { op: "world", patch: { agents: ["other"] } }, tick, { op: "get", nth: 0 }, history("olga"),
  ]));
  out.push(await userRun("rights-lost-since-the-job-was-saved", W, [
    create("mel"), create("mel", { name: "Second" }), { op: "principal", person: "mel", principal: { role: "member", kind: "person", agentRights: { main: "use" } } },
    ...due(), tick, history("olga"), { op: "get", nth: 0 },
    update("olga", { enabled: true }, { nth: 0 }), { op: "principal", person: "olga", principal: { role: "viewer", kind: "person" } }, advance(DAY), tick, history("adam"), { op: "get", nth: 0 },
    { op: "principal", person: "olga", principal: { role: "owner", kind: "person" } }, run("olga", { nth: 1 }), { op: "get", nth: 1 },
  ]));
  out.push(await userRun("budget-delivery-and-ports", W, [
    create("mel", { deliveryTarget: "chan:ok" }), create("mel", { name: "B" }), create("mel", { name: "C" }), create("mel", { name: "D" }),
    ...due(), { op: "world", patch: { blocked: ["main"] } }, tick, history("olga"), { op: "world", patch: { blocked: [], deliveryOk: [] } },
    update("mel", { enabled: true }, { nth: 1 }), advance(DAY), tick, history("olga", { limit: 2 }), { op: "world", patch: { deliveryOk: ["chan:ok"] } },
    { op: "world", patch: { displayThrows: true } }, advance(DAY), tick, history("olga", { limit: 1 }), { op: "world", patch: { displayThrows: false, displayNames: null } }, advance(DAY), tick, history("olga", { limit: 1 }),
    { op: "world", patch: { displayNames: { mel: "" } } }, advance(DAY), tick, history("olga", { limit: 1 }),
  ]));
  out.push(await userRun("manual-run", W, [
    create("mel"), create("mel", { name: "Off", enabled: false }),
    run("olga"), history("olga"), run("mia"), run("mu"), run("mel"), run("vera"), run("bot"), run("nokind"), run("olga", { nth: 1 }), run("olga", { id: "user:nope" }), run("olga", { id: "system:x" }),
    { op: "world", patch: { stopping: true } }, run("olga"), tick, { op: "world", patch: { stopping: false } }, { op: "get", nth: 0 }, list("olga"), history("olga", { nth: 0 }), history("olga", { id: "" }), history("olga", { id: "user:nope" }),
    submit({ throws: true }), run("olga"), submit({ outcome: "skipped_budget" }), run("adam"), history("mel"),
  ]));
  out.push(await userRun("the-clock-and-the-claim", W, [
    create("mel"), ...due(), submit({ advance: 2500 }), tick, history("olga"), { op: "get", nth: 0 },
    advance(DAY), submit({ advance: -5000 }), tick, history("olga", { limit: 1 }), { op: "get", nth: 0 },
    create("mel", { name: "Never", schedule: { cron: "0 0 29 2 *", timezone: "UTC" } }), { op: "rawJob", nth: 1, job: { enabled: true, nextRunAt: 1 } },
  ]));
  out.push(await userRun("concurrency-through-the-turn", W, [
    create("mel"), create("mel", { name: "Second" }), ...due(),
    submit({ during: [tick, { op: "delete", caller: who("mel"), nth: 0, confirm: true }, run("olga"), { op: "delete", caller: who("mel"), nth: 1, confirm: true }, update("mel", { name: "during" }, { nth: 0 }), list("mel")] }, { outcome: "completed" }),
    tick, history("olga"), list("olga"), { op: "get", nth: 0 },
    { op: "get", nth: 1 }, submit({ during: [{ op: "close" }] }), run("olga", { nth: 0 }), list("olga"), history("olga"),
  ]));
  out.push(await userRun("audit-and-stop", W, [
    create("mel"), { op: "world", patch: { stopping: true } }, tick, list("olga"), history("olga"), { op: "targets", caller: who("olga") }, create("olga"), update("olga", { name: "x" }), del("olga"), run("olga"), { op: "get", nth: 0 }, { op: "has", nth: 0 },
    { op: "world", patch: { stopping: false } }, { op: "close" }, { op: "get", nth: 0 }, { op: "has", nth: 0 }, list("olga"), tick, create("olga"), run("olga"),
    { op: "reopen" }, list("olga"),
  ]));
  out.push(await userRun("restart-abandons-interrupted-runs", W, [
    create("mel"), create("mel", { name: "Two" }),
    { op: "raw", sql: "INSERT INTO user_job_runs VALUES (?,?,?)", args: ["r-run", "user:x", JSON.stringify({ runId: "r-run", jobId: "user:x", agentId: "main", job: "n", kind: "user", runAs: "mel", runAsDisplayName: "mel", trigger: "recurring", startedAt: T0 - 5000, finishedAt: T0 - 5000, durationMs: 0, outcome: "running" })] },
    { op: "raw", sql: "INSERT INTO user_job_runs VALUES (?,?,?)", args: ["r-done", "user:x", JSON.stringify({ runId: "r-done", jobId: "user:x", agentId: "main", job: "n", kind: "user", runAs: "mel", runAsDisplayName: "mel", trigger: "recurring", startedAt: T0 - 9000, finishedAt: T0 - 8000, durationMs: 1000, outcome: "completed" })] },
    { op: "raw", sql: "INSERT INTO user_job_runs VALUES (?,?,?)", args: ["r-nostart", "user:x", JSON.stringify({ runId: "r-nostart", jobId: "user:x", agentId: "main", job: "n", kind: "user", runAs: "mel", outcome: "running" })] },
    { op: "raw", sql: "INSERT INTO user_job_runs VALUES (?,?,?)", args: ["r-future", "user:x", JSON.stringify({ runId: "r-future", jobId: "user:x", agentId: "main", job: "n", kind: "user", runAs: "mel", startedAt: T0 + 9000, outcome: "running" })] },
    { op: "raw", sql: "INSERT INTO user_job_runs VALUES (?,?,?)", args: ["r-odd", "user:x", JSON.stringify({ runId: "r-odd", jobId: "user:x", agentId: "main", job: "n", kind: "user", runAs: "mel", startedAt: "5", outcome: "running" })] },
    { op: "reopen" }, history("olga"), history("olga", { limit: 3 }),
    { op: "raw", sql: "INSERT INTO user_job_runs VALUES (?,?,?)", args: ["r-bad", "user:x", "{not json"] }, { op: "reopen" }, history("olga"), list("olga"),
  ]));
  out.push(await userRun("history-limits-and-filters", W, [
    create("mel"), create("olga", { agentId: "other", name: "Other" }), ...due(),
    ...Array.from({ length: 4 }, () => [tick, advance(DAY)]).flat(),
    ...[undefined, 0, -5, -0.5, 0.5, 1, 1.9, 2, 2.5, 3, 199, 200, 201, 1e9, { $num: "NaN" }, { $num: "Infinity" }, { $num: "-Infinity" }].map((limit) => history("olga", { limit })),
    history("olga", { nth: 0 }), history("olga", { nth: 1 }), history("olga", { id: "" }), history("olga", { id: "x" }), history("mel", { nth: 1 }), history("mon"), history("mu"), history("mia"),
  ]));
  out.push(await userRun("stored-definitions-the-code-did-not-write", W, [
    { op: "rawJob", job: { id: "user:legacy-1", name: "Legacy", kind: "user", needsLlm: true, singleton: true, agentId: "main", prompt: "p", schedule: { cron: "0 9 * * *", timezone: "UTC" }, enabled: true, runAs: "mel", createdBy: "mel", createdAt: 1, updatedAt: 1, nextRunAt: T0 - 1 } },
    { op: "rawJob", job: { id: "user:legacy-2", name: "No next", kind: "user", agentId: "main", prompt: "p", schedule: { cron: "0 9 * * *", timezone: "UTC" }, enabled: true, runAs: "mel", nextRunAt: null } },
    { op: "rawJob", job: { id: "user:legacy-3", name: "String next", kind: "user", agentId: "main", prompt: "p", schedule: { cron: "0 9 * * *", timezone: "UTC" }, enabled: true, runAs: "mel", nextRunAt: "1" } },
    { op: "rawJob", job: { id: "user:legacy-4", name: "Bad cron", kind: "user", agentId: "main", prompt: "p", schedule: { cron: "nonsense", timezone: "UTC" }, enabled: true, runAs: "mel", nextRunAt: 1 } },
    { op: "rawJob", job: { id: "user:legacy-5", name: "Off but due", kind: "user", agentId: "main", prompt: "p", schedule: { cron: "0 9 * * *", timezone: "UTC" }, enabled: false, runAs: "mel", nextRunAt: 1 } },
    list("olga"), list("mel"), list("mu"), tick, history("olga"), list("olga"),
    { op: "raw", sql: "INSERT INTO user_jobs VALUES (?,?)", args: ["user:corrupt", "{oops"] }, list("olga"), tick, { op: "get", id: "user:corrupt" }, { op: "has", id: "user:corrupt" },
  ]));
  return out;
}

// --- system jobs ----------------------------------------------------------------------------------------------------------
// A scenario is `{ name, world, ops }` over a real ledger directory. Handlers are scripted: `behaviour` says what `run` does.
//   { do: "complete", detail }  { do: "outcome", outcome, reason?, runningRunId?, detail? }  { do: "throw" }
//   { do: "nested", name, args?, trigger? }  runs another registry call while this run is in flight, then completes
//   { do: "advance", ms }  moves the clock inside the run (negative: the system clock stepping back)
// Every answer is `{ ok }` or `{ err }`; `warns` lists what the logger heard, `secure` the paths the hook was asked about.
const sworld = (over: Record<string, unknown> = {}) => ({ now: T0, engine: [] as string[], secureOk: true, handlers: [] as any[], ...over });
const H = (name: string, over: Record<string, unknown> = {}) => ({ name, every: 60_000, jitter: 0.1, exclusive: false, nextRunAt: null as number | null, args: "any", behaviour: { do: "complete", detail: { done: true } }, ...over });

async function systemRun(name: string, w0: any, ops: any[]) {
  const dir = mkdtempSync(join(tmpdir(), "p4k-sysjobs-"));
  const ledgerPath = join(dir, "state", "system-jobs", "ledger.jsonl");
  const w = structuredClone(w0);
  const warns: any[] = [], secure: string[] = [], recorded: any[] = [], failed: any[] = [];
  const clean = (v: unknown): unknown => JSON.parse(JSON.stringify(v, (_k, x) => (typeof x === "string" ? x.split(dir).join("$ROOT") : x)) ?? "null");
  random.reset();
  let jobs: any;
  const make = () => {
    jobs = createSystemJobs({
      ledgerPath, clock: { now: () => w.now, setTimer: () => ({}) as any } as any,
      securePath: (p: string) => { secure.push(p); return w.secureOk ? { applied: true } : { applied: false }; },
      logger: { warn: (m: string, f?: object) => { warns.push({ m, f: f ?? null }); } },
      engineHasJob: (n: string) => w.engine.includes(n),
      onRecorded: (r: any) => { recorded.push(structuredClone(r)); if (w.recordedThrows) throw new Error("recorded"); },
      onFailed: (r: any) => { failed.push(structuredClone(r)); if (w.failedThrows) throw new Error("failed"); },
    });
  };
  make();
  const handler = (h: any) => ({
    spec: { name: h.name, needsLlm: false as const, singleton: true as const, schedule: { every: h.every, jitter: h.jitter }, ...(h.exclusive ? { exclusive: true } : {}) },
    nextRunAt: () => (h.nextRunAtFn === "now" ? w.now : h.nextRunAt),
    validateArgs: (a: unknown) => {
      if (h.args === "none") { if (a !== undefined && a !== null && !(typeof a === "object" && Object.keys(a as object).length === 0 && !Array.isArray(a))) throw new RpcError("E_INVALID_PARAMS", "takes no args", { detail: "args" }); return {}; }
      if (a === undefined || a === null) return {};
      if (typeof a !== "object" || Array.isArray(a)) throw new RpcError("E_INVALID_PARAMS", "args must be an object", { detail: "args" });
      return a as Record<string, unknown>;
    },
    run: async (args: Record<string, unknown>, ctx: any) => {
      const b = h.behaviour;
      if (w.seenCtx) w.seenCtx.push({ trigger: ctx.trigger, aborted: ctx.signal.aborted, args: structuredClone(args) });
      if (b.mutate) args.mutated = true;
      if (b.do === "throw") throw new Error("handler failed");
      if (b.do === "rpc-throw") throw new RpcError("E_DENIED", "handler denied");
      if (b.do === "advance") { w.now += b.ms; return { outcome: "completed", detail: null }; }
      if (b.do === "outcome") return { outcome: b.outcome, ...(b.reason !== undefined ? { reason: b.reason } : {}), ...(b.runningRunId !== undefined ? { runningRunId: b.runningRunId } : {}), detail: b.detail ?? null };
      if (b.do === "nested") {
        const o = await apply({ op: "run", name: b.name, args: b.args, trigger: b.trigger ?? "manual" });
        w.nested = [...(w.nested ?? []), o];
        return { outcome: "completed", detail: { nested: o } };
      }
      return { outcome: "completed", detail: b.detail ?? null };
    },
  });
  const read = (p: string) => (existsSync(p) ? (statSync(p).isDirectory() ? "$dir" : readFileSync(p, "utf8")) : null);
  // A file past 8 KiB (the rotation cases pad to 1 MiB) is its size, the SHA-256 of its bytes and its last 200 bytes in hex.
  const shown = (p: string) => { const t = read(p); if (t === null || t === "$dir" || Buffer.byteLength(t) <= 8192) return clean(t); const b = readFileSync(p); return { size: b.length, sha256: createHash("sha256").update(b).digest("hex"), tailHex: b.subarray(b.length - 200).toString("hex") }; };
  const files = () => ({ ledger: shown(ledgerPath), rotated: shown(`${ledgerPath}.1`) });
  const history: unknown[] = [];
  async function apply(op: any): Promise<unknown> {
    try {
      switch (op.op) {
        case "register": jobs.register(handler(op.handler)); return { ok: null };
        case "has": return { ok: jobs.has(op.name) };
        case "list": return { ok: jobs.list() };
        case "run": { const r = await jobs.run(op.name, op.args, { trigger: op.trigger ?? "manual", ...(op.aborted ? { signal: AbortSignal.abort() } : {}) }); return { ok: { record: r.record, detail: r.detail } }; }
        case "history": return { ok: jobs.history({ ...(op.job !== undefined ? { job: op.job } : {}), ...(op.since !== undefined ? { since: num(op.since) } : {}), ...(op.limit !== undefined ? { limit: num(op.limit) } : {}) }) };
        case "advance": w.now += op.ms; return { ok: w.now };
        case "world": Object.assign(w, op.patch); return { ok: null };
        case "write": { mkdirSync(join(dir, "state", "system-jobs"), { recursive: true }); writeFileSync(op.rotated ? `${ledgerPath}.1` : ledgerPath, typeof op.text === "string" ? op.text : op.lines.map((l: unknown) => (typeof l === "string" ? l : JSON.stringify(l))).join("\n") + (op.noEol ? "" : "\n")); return { ok: null }; }
        case "pad": { const cur = read(ledgerPath) ?? ""; const need = op.bytes - Buffer.byteLength(cur); if (need > 0) writeFileSync(ledgerPath, cur + (cur === "" || cur.endsWith("\n") ? "" : "\n") + "\n".repeat(Math.max(0, need - (cur === "" || cur.endsWith("\n") ? 0 : 1)))); return { ok: statSync(ledgerPath).size }; }
        case "mkdir": mkdirSync(op.rotated ? `${ledgerPath}.1` : ledgerPath, { recursive: true }); return { ok: null };
        case "rm": rmSync(op.rotated ? `${ledgerPath}.1` : ledgerPath, { recursive: true, force: true }); return { ok: null };
        case "reopen": make(); for (const h of w.handlers) jobs.register(handler(h)); return { ok: null };
        default: throw new Error(`unknown op ${op.op}`);
      }
    } catch (e) { return { err: clean(errOf(e)) }; }
  }
  try {
    for (const h of w.handlers) jobs.register(handler(h));
    for (const op of ops) {
      warns.length = 0; secure.length = 0; recorded.length = 0; failed.length = 0; w.nested = undefined;
      const out = await apply(op);
      history.push({ op, out: clean(out), ...(warns.length ? { warns: clean(warns) } : {}), ...(secure.length ? { secure: clean(secure) } : {}), ...(recorded.length ? { recorded: clean(recorded) } : {}), ...(failed.length ? { failed: clean(failed) } : {}), files: files() });
    }
    return { name, world: w0, ops: history };
  } finally { rmSync(dir, { recursive: true, force: true }); }
}
const sop = (op: string, extra: Record<string, unknown> = {}) => ({ op, ...extra });
// The fixture sorts object keys, but a ledger row keeps the order of the arguments as written: `argsText` is their JSON as
// TypeScript wrote it, and the replay parses that, so the member order survives.
const srun = (name: string, extra: Record<string, unknown> = {}) => sop("run", { name, ...extra, ...(extra.args !== undefined ? { argsText: JSON.stringify(extra.args) } : {}) });
const ROW_STARTED = (id: string, job = "j", at = 100, over: Record<string, unknown> = {}) => ({ v: 1, phase: "started", runId: id, job, trigger: "cron", startedAt: at, ...over });
const ROW_FINISHED = (id: string, job = "j", at = 100, over: Record<string, unknown> = {}) => ({ v: 1, phase: "finished", runId: id, job, trigger: "cron", startedAt: at, finishedAt: at + 5, durationMs: 5, outcome: "completed", attempt: 1, ...over });

async function systemScenarios() {
  const out: unknown[] = [];
  out.push(await systemRun("registry", sworld({ engine: ["engine.job"], handlers: [H("a", { nextRunAt: 5 }), H("b", { exclusive: true, nextRunAt: 7.5 })] }), [
    sop("has", { name: "a" }), sop("has", { name: "c" }), sop("has", { name: "" }), sop("list"),
    sop("register", { handler: H("a") }), sop("register", { handler: H("engine.job") }), sop("register", { handler: H("c", { every: 1.5, jitter: 0 }) }), sop("list"),
    srun("nope"), srun("a"), srun("a", { args: {} }), srun("a", { args: null }), srun("a", { args: { x: 1, y: [1, 2], z: { k: "v" } } }), srun("a", { args: [1] }), srun("a", { args: "s" }), srun("a", { args: 5 }),
    srun("a", { trigger: "cron" }), srun("a", { trigger: "harness" }), srun("a", { aborted: true }), sop("history"),
  ]));
  out.push(await systemRun("outcomes-and-exceptions", sworld({ handlers: [
    H("ok", { behaviour: { do: "complete", detail: { n: 1 } } }), H("skip", { behaviour: { do: "outcome", outcome: "skipped", reason: "nothing-to-do" } }), H("fail", { behaviour: { do: "outcome", outcome: "failed", reason: "boom", detail: { why: 1 } } }),
    H("inc", { behaviour: { do: "outcome", outcome: "incomplete", reason: "partial" } }), H("ab", { behaviour: { do: "outcome", outcome: "abandoned", reason: "aborted" } }), H("thr", { behaviour: { do: "throw" } }), H("rpc", { behaviour: { do: "rpc-throw" } }),
    H("mut", { behaviour: { do: "complete", mutate: true } }), H("noargs", { args: "none" }), H("run-id-reason", { behaviour: { do: "outcome", outcome: "skipped", reason: "already_running", runningRunId: "other-run" } }),
  ] }), [
    srun("ok"), srun("skip"), srun("fail"), srun("inc"), srun("ab"), srun("thr"), srun("rpc"), srun("mut", { args: { a: 1 } }), srun("mut"), srun("noargs"), srun("noargs", { args: { x: 1 } }), srun("noargs", { args: {} }), srun("run-id-reason"),
    sop("world", { patch: { recordedThrows: true, failedThrows: true } }), srun("fail"), srun("thr"), srun("ok"), sop("history"), sop("history", { job: "fail" }), sop("history", { job: "" }), sop("history", { limit: 2 }),
  ]));
  out.push(await systemRun("exclusive-lock", sworld({ handlers: [
    H("lock", { exclusive: true, behaviour: { do: "nested", name: "lock", args: { inner: true } } }), H("free", { behaviour: { do: "nested", name: "plain" } }), H("plain"), H("chain", { exclusive: true, behaviour: { do: "nested", name: "lock2" } }), H("lock2", { exclusive: true, behaviour: { do: "throw" } }), H("thrower", { exclusive: true, behaviour: { do: "throw" } }),
  ] }), [srun("lock"), srun("lock"), srun("free"), srun("chain"), srun("thrower"), srun("thrower"), sop("history")]));
  out.push(await systemRun("the-clock-in-a-run", sworld({ handlers: [H("slow", { behaviour: { do: "advance", ms: 2500 } }), H("back", { behaviour: { do: "advance", ms: -4000 } })] }), [
    srun("slow"), srun("back"), sop("advance", { ms: 10 }), srun("slow"), sop("history"), sop("history", { since: 0 }), sop("history", { since: T0 + 2500 }), sop("history", { since: T0 + 2501 }), sop("history", { since: { $num: "NaN" } }), sop("history", { since: { $num: "-Infinity" } }), sop("history", { since: { $num: "Infinity" } }),
    ...[0, 1, 2, 2.9, 1e9, -1, -0.5, { $num: "NaN" }, { $num: "Infinity" }, { $num: "-Infinity" }].map((limit) => sop("history", { limit })),
  ]));
  // The file: what a run leaves, and what the reader makes of what it finds.
  out.push(await systemRun("ledger-rows-and-restart", sworld({ handlers: [H("j", { behaviour: { do: "complete", detail: 1 } })] }), [
    srun("j", { args: { b: 2, a: 1, "10": "x", "2": "y", nested: { z: [1, { q: null }], "😀": "é " }, big: 1e21, small: 1e-7, neg0: -0, text: "line\nbreak \"q\" \\ \u0000 \u007f" } }), srun("j"), sop("history"),
    sop("reopen"), sop("history"), srun("j"), sop("history", { limit: 1 }),
  ]));
  out.push(await systemRun("ledger-torn-and-unfinished", sworld({ handlers: [H("j")] }), [
    sop("write", { lines: [ROW_STARTED("r1"), ROW_FINISHED("r1"), ROW_STARTED("r2", "j", 200, { args: { k: 1 } }), ROW_STARTED("r3", "other", 300, { trigger: 5 })], noEol: true }), sop("history"), srun("j"), sop("history"),
    sop("write", { text: JSON.stringify(ROW_STARTED("t1")) }), srun("j"), sop("history"),
    sop("write", { text: "{\"v\":1,\"phase\":\"started\",\"runId\":\"t2\",\"job\":\"j\",\"startedAt\":1" }), srun("j"), sop("history"),
    sop("write", { text: "\r\n﻿" + JSON.stringify(ROW_STARTED("t3")) + " \n  " + JSON.stringify(ROW_FINISHED("t3")) + "  \r\n\n\n" }), sop("history"),
  ]));
  const BAD = [
    "not json", "{", "[]", "null", "5", "\"s\"", "true", "{}", JSON.stringify({ v: 2, phase: "started", runId: "a" }), JSON.stringify({ v: "1", phase: "started", runId: "a" }), JSON.stringify({ v: 1.0, phase: "started", runId: "v-float", job: "j", startedAt: 1 }),
    JSON.stringify({ v: 1, phase: "started", runId: 5 }), JSON.stringify({ v: 1, phase: "started", runId: null }), JSON.stringify({ v: 1, phase: "started", runId: ["x"] }), JSON.stringify({ v: 1, phase: "started", runId: {} }), JSON.stringify({ v: 1, phase: "started" }),
    JSON.stringify({ v: 1, phase: "started", runId: "b1" }), JSON.stringify({ v: 1, phase: "started", runId: "b2", job: 5, startedAt: 1 }), JSON.stringify({ v: 1, phase: "started", runId: "b3", job: "j" }), JSON.stringify({ v: 1, phase: "started", runId: "b4", job: "j", startedAt: "1" }), JSON.stringify({ v: 1, phase: "started", runId: "b5", job: "j", startedAt: null }),
    JSON.stringify({ v: 1, phase: "started", runId: "ok-a", job: "j", startedAt: 1.5, trigger: null, args: null }), JSON.stringify({ v: 1, phase: "started", runId: "ok-b", job: "j", startedAt: -1, args: [1, 2] }), JSON.stringify({ v: 1, phase: "started", runId: "ok-c", job: "", startedAt: 0, trigger: { x: 1 } }),
    JSON.stringify({ v: 1, phase: "finished", runId: "f1" }), JSON.stringify({ v: 1, phase: "finished", runId: "f2", job: "j", outcome: "completed", startedAt: 1, finishedAt: 2 }), JSON.stringify({ v: 1, phase: "finished", runId: "f3", job: "j", outcome: "weird", startedAt: 1, finishedAt: 2, durationMs: 1 }),
    JSON.stringify({ v: 1, phase: "finished", runId: "f4", job: 5, outcome: "completed", startedAt: 1, finishedAt: 2, durationMs: 1 }), JSON.stringify({ v: 1, phase: "finished", runId: "f5", job: "j", outcome: "completed", startedAt: "1", finishedAt: 2, durationMs: 1 }),
    JSON.stringify({ v: 1, phase: "finished", runId: "ok-d", job: "j", outcome: "skipped", startedAt: 1, finishedAt: 2, durationMs: 1, reason: null, runningRunId: 7, args: { a: null } }), JSON.stringify({ v: 1, phase: "finished", runId: "ok-e", job: "j", outcome: "incomplete", startedAt: 1, finishedAt: 0, durationMs: -1.5, trigger: "x", attempt: 7, kind: "other" }),
    JSON.stringify({ v: 1, phase: "weird", runId: "p1" }), JSON.stringify({ v: 1, runId: "p2" }), JSON.stringify({ v: 1, phase: 5, runId: "p3" }), JSON.stringify({ v: 1, phase: null, runId: "p4" }), JSON.stringify({ v: 1, phase: ["started"], runId: "p5" }), JSON.stringify({ v: 1, phase: "Started", runId: "p6" }),
    "{\"v\":1,\"phase\":\"started\",\"runId\":\"dup\",\"job\":\"j\",\"startedAt\":1,\"startedAt\":2}", "{\"v\":1,\"phase\":\"started\",\"runId\":\"__proto__\",\"job\":\"j\",\"startedAt\":3}", "{\"v\":1,\"phase\":\"started\",\"runId\":\"constructor\",\"job\":\"toString\",\"startedAt\":4}",
  ];
  out.push(await systemRun("ledger-lenient-reader", sworld({ handlers: [H("j")] }), [
    sop("write", { lines: BAD }), sop("history"), sop("history", { job: "j" }), sop("history", { job: "toString" }),
    sop("write", { lines: [ROW_STARTED("same", "j", 1), ROW_STARTED("same", "j2", 2), ROW_FINISHED("same", "j3", 3), ROW_FINISHED("same", "j4", 9, { outcome: "failed" }), ROW_STARTED("later", "j", 4)] }), sop("history"),
    sop("write", { lines: [ROW_FINISHED("fin-first", "j", 1), ROW_STARTED("fin-first", "j", 1)] }), sop("history"),
    sop("write", { lines: [ROW_STARTED("old-run", "j", 1)], rotated: true }), sop("write", { lines: [ROW_FINISHED("old-run", "j", 1), ROW_STARTED("new-run", "j", 5)] }), sop("history"), sop("rm"), sop("history"), sop("rm", { rotated: true }), sop("history"),
    sop("mkdir"), sop("history"), srun("j"),
  ]));
  out.push(await systemRun("ledger-rotation", sworld({ handlers: [H("j")] }), [
    srun("j"), sop("pad", { bytes: 1048575 }), srun("j"), sop("history", { limit: 3 }), sop("pad", { bytes: 1048576 }), srun("j"), sop("history", { limit: 3 }), sop("pad", { bytes: 2000000 }), srun("j"), sop("history", { limit: 3 }),
    sop("write", { text: "stale\n", rotated: true }), sop("pad", { bytes: 1048576 }), srun("j"), sop("history"),
    sop("mkdir", { rotated: true }), sop("rm", { rotated: true }), sop("mkdir", { rotated: true }), sop("pad", { bytes: 1048576 }), srun("j"),
  ]));
  out.push(await systemRun("ledger-permissions", sworld({ handlers: [H("j")] }), [
    srun("j"), srun("j"), sop("world", { patch: { secureOk: false } }), srun("j"), sop("rm"), srun("j"), sop("world", { patch: { secureOk: true } }), srun("j"), sop("rm"), sop("rm", { rotated: true }), sop("pad", { bytes: 1048576 }), srun("j"),
    sop("world", { patch: { secureOk: false } }), sop("history"), sop("reopen"), srun("j"),
  ]));
  return out;
}

// The arm of the approvals integrity job: a recorded timer, the callback run by the scenario.
async function armScenario(name: string, ops: any[]) {
  const dir = mkdtempSync(join(tmpdir(), "p4k-arm-"));
  const w: any = { now: T0, next: null as number | null, throws: false };
  const timers: { fn: () => void | Promise<void>; ms: number }[] = [];
  const setLog: number[] = [];
  random.reset();
  const jobs = createSystemJobs({
    ledgerPath: join(dir, "state", "system-jobs", "ledger.jsonl"), clock: { now: () => w.now, setTimer: () => ({}) as any } as any, securePath: () => ({ applied: true }), logger: { warn: () => {} }, engineHasJob: () => false,
  });
  if (!w.noHandler) jobs.register({ spec: { name: "approvals.integrity", needsLlm: false, singleton: true, schedule: { every: 86_400_000, jitter: 0.1 }, exclusive: true }, nextRunAt: () => w.next, validateArgs: () => ({}), run: async () => { if (w.throws) throw new Error("verify failed"); return { outcome: "completed", detail: null }; } } as any);
  let arm: { cancel(): void } | undefined;
  const steps: unknown[] = [];
  try {
    for (const op of ops) {
      const mark = setLog.length;
      let out: unknown = null;
      switch (op.op) {
        case "arm": arm = armApprovalsIntegrity(jobs, { now: () => w.now, setTimer: (fn, ms) => { timers.push({ fn, ms }); setLog.push(ms); return {}; } }); break;
        case "world": Object.assign(w, op.patch); break;
        case "advance": w.now += op.ms; break;
        case "fire": { const t = timers.shift(); if (t) await t.fn(); else out = "no timer"; break; }
        case "cancel": arm!.cancel(); break;
        case "drop": jobs.list; break;
      }
      const runs = jobs.history({}).length;
      steps.push({ op, out, set: setLog.slice(mark), runs });
    }
    return { name, ops: steps };
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

let random: ReturnType<typeof installScriptedRandom>;

export async function buildJobsVectors() {
  random = installScriptedRandom();
  try {
    const arm = [
      await armScenario("arm-and-fire", [{ op: "arm" }, { op: "fire" }, { op: "world", patch: { next: T0 + 5000.5 } }, { op: "fire" }, { op: "advance", ms: 9000 }, { op: "fire" }, { op: "fire" }]),
      await armScenario("arm-throwing-job-and-cancel", [{ op: "world", patch: { next: T0 - 100 } }, { op: "arm" }, { op: "world", patch: { throws: true } }, { op: "fire" }, { op: "fire" }, { op: "cancel" }, { op: "fire" }, { op: "fire" }]),
      await armScenario("arm-cancel-before-fire", [{ op: "arm" }, { op: "cancel" }, { op: "fire" }, { op: "fire" }]),
    ];
    return { cron: cronVectors(), user: [...(await userScenarios()), ...(await userRunScenarios())], system: [...(await systemScenarios()), ...arm] };
  } finally { random.restore(); }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  process.exitCode = await exporterMain({ area: "jobs", build: buildJobsVectors });
}
