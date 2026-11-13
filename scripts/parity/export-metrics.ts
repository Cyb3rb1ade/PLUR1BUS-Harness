// Parity vectors (mode V) for the metrics registry and the harness's metric set (P4-11 task 5b): scripted sequences of
// registry operations (`counter`, `gauge`, `gaugeFn`, `histogram`, `inc`, `set`, `observe`, `initAll`, `render`) and of
// `createMetrics` calls (`rpcCall`, `turn`, `providerError`, `inboxPublished`, `learnRun`, `learnFinding`,
// `turnTelemetry`, `turnTelemetrySummary`, `render`), each with the TypeScript result of every step: `{ ok }`,
// `{ error: <message> }`, `{ text: <exposition> }` or `{ summary }`. The exposition text must be byte-identical in Rust:
// metric and label order, HELP/TYPE lines, label escaping, `localeCompare` series order and JavaScript's `String(number)`.
// `crates/plur1bus-core/src/metrics/metrics.rs` (module `vectors`) replays every case. Recorded, never edited by hand.
//
// A number that JSON cannot hold, or that must keep its exact JavaScript spelling, is a string (`"NaN"`, `"Infinity"`,
// `"-0"`, `"1e21"`): both sides read it with `Number(text)` / `str::parse::<f64>`. A label specification is a list of
// `[name, [values]]` pairs, since the order of the names is the order of the labels and a fixture's object keys are sorted.
// Label values are ASCII: the Rust collation is ICU's root order for ASCII and falls back to code points beyond it.
//
//   node --experimental-strip-types --conditions=source --no-warnings=ExperimentalWarning scripts/parity/export-metrics.ts [--check]
import { fileURLToPath } from "node:url";
import { METHODS_BY_SERVER } from "../../packages/rpc-schema/src/index.ts";
import { createMetrics } from "../../packages/core/src/metrics/metrics.ts";
import { createRegistry, type Counter, type Gauge, type Histogram, type LabelSpec } from "../../packages/core/src/metrics/registry.ts";
import { exporterMain } from "./lib.mjs";

type Num = string;
/** Label values: a list, or `{ gen, count }` for `gen0 .. gen<count-1>` (the large enumerations of the cap cases). */
type Values = string[] | { gen: string; count: number };
type Spec = [string, Values][];
const expand = (v: Values): string[] => (Array.isArray(v) ? v : Array.from({ length: v.count }, (_, i) => `${v.gen}${i}`));
const toSpec = (spec: Spec): LabelSpec => Object.fromEntries(spec.map(([n, v]) => [n, expand(v)]));
const num = (n: Num): number => Number(n);

type RegistryOp =
  | { op: "counter"; id: string; name: string; help: string; labels: Spec; maxSeries?: number }
  | { op: "gauge"; id: string; name: string; help: string; labels: Spec }
  | { op: "gaugeFn"; name: string; help: string; value: Num | "throw" }
  | { op: "histogram"; id: string; name: string; help: string; labels: Spec; buckets: Num[] }
  | { op: "inc"; id: string; labels?: Record<string, string>; by?: Num }
  | { op: "set"; id: string; labels?: Record<string, string>; value: Num }
  | { op: "observe"; id: string; labels?: Record<string, string>; value: Num }
  | { op: "initAll"; id: string }
  | { op: "render" };

type Result = { ok: true } | { error: string } | { text: string };

function runRegistry(ops: RegistryOp[]): Result[] {
  const r = createRegistry();
  const handles = new Map<string, Counter | Gauge | Histogram>();
  return ops.map((o): Result => {
    try {
      switch (o.op) {
        case "counter": handles.set(o.id, r.counter(o.name, o.help, toSpec(o.labels), o.maxSeries === undefined ? undefined : { maxSeries: o.maxSeries })); break;
        case "gauge": handles.set(o.id, r.gauge(o.name, o.help, toSpec(o.labels))); break;
        case "gaugeFn": r.gaugeFn(o.name, o.help, () => { if (o.value === "throw") throw new Error("boom"); return num(o.value); }); break;
        case "histogram": handles.set(o.id, r.histogram(o.name, o.help, toSpec(o.labels), o.buckets.map(num))); break;
        case "inc": (handles.get(o.id) as Counter).inc(o.labels ?? {}, o.by === undefined ? undefined : num(o.by)); break;
        case "set": (handles.get(o.id) as Gauge).set(o.labels ?? {}, num(o.value)); break;
        case "observe": (handles.get(o.id) as Histogram).observe(o.labels ?? {}, num(o.value)); break;
        case "initAll": (handles.get(o.id) as Counter | Histogram).initAll(); break;
        case "render": return { text: r.render() };
      }
      return { ok: true };
    } catch (e) {
      return { error: (e as Error).message };
    }
  });
}

const counter = (id: string, name: string, labels: Spec = [], extra: Partial<RegistryOp> = {}): RegistryOp => ({ op: "counter", id, name, help: `Help of ${name}.`, labels, ...extra }) as RegistryOp;
const render: RegistryOp = { op: "render" };

function registryCases(): { name: string; note?: string; ops: RegistryOp[]; results?: Result[] }[] {
  const cases: { name: string; note?: string; ops: RegistryOp[] }[] = [];
  const add = (name: string, ops: RegistryOp[], note?: string) => cases.push({ name, ops, ...(note ? { note } : {}) });

  add("empty-registry", [render]);
  add("basic-counter-gauge-histogram", [
    { op: "counter", id: "c", name: "t_calls_total", help: "Calls.", labels: [["result", ["ok", "error"]]] },
    { op: "inc", id: "c", labels: { result: "ok" } }, { op: "inc", id: "c", labels: { result: "ok" }, by: "2" }, { op: "inc", id: "c", labels: { result: "error" } },
    { op: "gauge", id: "g", name: "t_open", help: "Open things.", labels: [] },
    { op: "set", id: "g", value: "4" },
    { op: "gaugeFn", name: "t_live", help: "Computed.", value: "7" },
    { op: "histogram", id: "h", name: "t_seconds", help: "Durations.", labels: [["outcome", ["ok"]]], buckets: ["0.1", "1"] },
    { op: "observe", id: "h", labels: { outcome: "ok" }, value: "0.05" }, { op: "observe", id: "h", labels: { outcome: "ok" }, value: "0.5" }, { op: "observe", id: "h", labels: { outcome: "ok" }, value: "5" },
    render,
  ]);
  add("fold-into-other", [
    { op: "counter", id: "c", name: "t_x_total", help: "X.", labels: [["who", ["a", "b"]]] },
    ...Array.from({ length: 30 }, (_, i): RegistryOp => ({ op: "inc", id: "c", labels: { who: `user-${i}` } })),
    { op: "inc", id: "c", labels: { who: "a" } }, { op: "inc", id: "c", labels: { who: "other" } }, { op: "inc", id: "c", labels: {} }, { op: "inc", id: "c", labels: { unknown: "b" } },
    render,
  ]);
  add("duplicate-values-in-a-label-enumeration", [
    { op: "counter", id: "c", name: "t_dup_vals_total", help: "d", labels: [["a", ["x", "y", "x", "other", "y"]]] },
    { op: "initAll", id: "c" }, render,
  ]);
  add("counter-ignores-negative-and-non-finite-increments", [
    counter("c", "t_n_total"), { op: "inc", id: "c", by: "-5" }, { op: "inc", id: "c", by: "NaN" }, { op: "inc", id: "c", by: "Infinity" }, { op: "inc", id: "c", by: "-Infinity" }, render,
    { op: "inc", id: "c" }, { op: "inc", id: "c", by: "0" }, render,
  ]);
  add("gauge-ignores-non-finite-values-and-keeps-the-last", [
    { op: "gauge", id: "g", name: "t_g", help: "g", labels: [["k", ["a", "b"]]] },
    { op: "set", id: "g", labels: { k: "a" }, value: "NaN" }, { op: "set", id: "g", labels: { k: "a" }, value: "Infinity" }, render,
    { op: "set", id: "g", labels: { k: "a" }, value: "1" }, { op: "set", id: "g", labels: { k: "a" }, value: "2.5" }, { op: "set", id: "g", labels: { k: "b" }, value: "-0" }, render,
  ]);
  add("histogram-ignores-non-finite-and-negative-observations", [
    { op: "histogram", id: "h", name: "t_h_seconds", help: "H.", labels: [], buckets: ["1"] },
    { op: "initAll", id: "h" }, { op: "observe", id: "h", value: "NaN" }, { op: "observe", id: "h", value: "-1" }, { op: "observe", id: "h", value: "Infinity" }, render,
    { op: "observe", id: "h", value: "1" }, { op: "observe", id: "h", value: "0" }, { op: "observe", id: "h", value: "1.0000000001" }, render,
  ]);
  add("histogram-sums-and-bucket-bounds-print-like-javascript", [
    { op: "histogram", id: "h", name: "t_js_seconds", help: "H.", labels: [], buckets: ["1e-7", "0.000001", "0.5", "100", "1e21", "1.5e21"] },
    { op: "observe", id: "h", value: "0.1" }, { op: "observe", id: "h", value: "0.2" }, { op: "observe", id: "h", value: "1e-7" }, { op: "observe", id: "h", value: "1e21" }, render,
  ]);
  const printed = ["0", "-0", "1", "-1", "1.5", "100", "0.30000000000000004", "1e20", "1e21", "1.5e21", "123456789012345680000", "0.000001", "1e-7", "1.5e-7", "5e-324", "1.7976931348623157e308", "-1e21", "-1e-7", "4503599627370496", "9007199254740993", "0.1", "123456789.123456789", "1e300", "2.5e-10", "999999999999999900000", "1e22", "12345.678", "0.00001234"];
  add("number-formatting-of-gauge-values", [
    { op: "gauge", id: "g", name: "t_num", help: "n", labels: [["n", printed.map((_, i) => `n${String(i).padStart(2, "0")}`)]] },
    ...printed.map((v, i): RegistryOp => ({ op: "set", id: "g", labels: { n: `n${String(i).padStart(2, "0")}` }, value: v })),
    render,
  ]);
  add("number-formatting-of-counter-sums", [
    counter("c", "t_sum_total", [["k", ["a", "b", "c", "d", "e"]]]),
    { op: "inc", id: "c", labels: { k: "a" }, by: "0.1" }, { op: "inc", id: "c", labels: { k: "a" }, by: "0.2" },
    { op: "inc", id: "c", labels: { k: "b" }, by: "1e21" }, { op: "inc", id: "c", labels: { k: "b" }, by: "1e21" },
    { op: "inc", id: "c", labels: { k: "c" }, by: "1e-7" },
    { op: "inc", id: "c", labels: { k: "d" }, by: "9007199254740992" }, { op: "inc", id: "c", labels: { k: "d" }, by: "1" },
    { op: "inc", id: "c", labels: { k: "e" }, by: "1.7976931348623157e308" }, { op: "inc", id: "c", labels: { k: "e" }, by: "1.7976931348623157e308" },
    render,
  ]);
  add("gauge-fn-values-and-failures", [
    { op: "gaugeFn", name: "t_f_zero", help: "z", value: "-0" }, { op: "gaugeFn", name: "t_f_big", help: "b", value: "1e21" }, { op: "gaugeFn", name: "t_f_nan", help: "n", value: "NaN" },
    { op: "gaugeFn", name: "t_f_inf", help: "i", value: "Infinity" }, { op: "gaugeFn", name: "t_f_ninf", help: "i", value: "-Infinity" }, { op: "gaugeFn", name: "t_f_throw", help: "t", value: "throw" },
    { op: "gaugeFn", name: "t_f_sum", help: "s", value: "0.30000000000000004" }, { op: "gaugeFn", name: "t_f_neg", help: "s", value: "-12.5" }, render,
  ]);
  add("escaping-of-help-and-label-values", [
    { op: "counter", id: "c", name: "t_esc_total", help: "Line1\nLine2 \\ end. \"quoted\" \r\t", labels: [["v", ['a"b\\c\nd', "plain", "tab\tcr\r", "back\\slash", "q\"q", "nl\nnl", "\\n", "\\\\"]]] },
    { op: "inc", id: "c", labels: { v: 'a"b\\c\nd' } }, { op: "inc", id: "c", labels: { v: "tab\tcr\r" } }, { op: "inc", id: "c", labels: { v: "back\\slash" } }, { op: "inc", id: "c", labels: { v: "q\"q" } },
    { op: "inc", id: "c", labels: { v: "nl\nnl" } }, { op: "inc", id: "c", labels: { v: "\\n" } }, { op: "inc", id: "c", labels: { v: "\\\\" } }, { op: "inc", id: "c", labels: { v: "plain" } },
    render,
  ]);
  const punct = ["b", "B", "a", "A", "a_b", "a-b", "a.b", "a b", "ab", "aB", "Ab", "AB", "a1", "a0", "a9", "a:b", "a;b", "a,b", "a!b", "a?b", "a'b", "a\"b", "a(b", "a)b", "a[b", "a]b", "a{b", "a}b", "a@b", "a*b", "a/b", "a\\b", "a&b", "a#b", "a%b", "a`b", "a^b", "a+b", "a<b", "a=b", "a>b", "a|b", "a~b", "a$b", "a\tb", "a\nb", "a\u0001b", "a\u007fb", "0", "9", "z", "Z", "", "_", "-", "10", "2", "waiting-h3", "openai", "openai_compatible", "skill_load", "skill_read", "skill-load"];
  add("series-order-follows-icu-locale-compare", [
    { op: "counter", id: "c", name: "t_collate_total", help: "c", labels: [["v", punct]] },
    // Inserted in reverse so that the order is the collation's, not the insertion's.
    ...[...punct].reverse().map((v): RegistryOp => ({ op: "inc", id: "c", labels: { v } })),
    render,
  ]);
  add("series-order-ignores-the-separator-and-keeps-insertion-order-on-ties", [
    // The joined keys "xa\0y" and "x\0ay" differ only in an ignorable control character: they compare equal and keep the
    // order in which the series were first seen (a stable sort).
    { op: "counter", id: "c", name: "t_tie_total", help: "c", labels: [["a", ["x", "xa", "xb"]], ["b", ["ay", "y", "by"]]] },
    { op: "inc", id: "c", labels: { a: "xa", b: "y" } }, { op: "inc", id: "c", labels: { a: "x", b: "ay" } },
    { op: "inc", id: "c", labels: { a: "xb", b: "y" } }, { op: "inc", id: "c", labels: { a: "x", b: "by" } },
    render,
    { op: "counter", id: "d", name: "t_tie2_total", help: "c", labels: [["a", ["x", "xa"]], ["b", ["ay", "y"]]] },
    { op: "inc", id: "d", labels: { a: "x", b: "ay" } }, { op: "inc", id: "d", labels: { a: "xa", b: "y" } }, render,
  ]);
  add("init-all-orders-the-cartesian-product-by-collation", [
    { op: "counter", id: "c", name: "t_init_total", help: "c", labels: [["provider", ["openai", "anthropic", "Google"]], ["kind", ["auth", "rate_limit", "timeout"]]] },
    { op: "initAll", id: "c" }, { op: "inc", id: "c", labels: { provider: "anthropic", kind: "auth" } }, render,
  ]);
  add("histogram-with-labels-sorted-and-an-unlabelled-one", [
    { op: "histogram", id: "h", name: "t_hl_seconds", help: "h", labels: [["outcome", ["ok", "error", "aborted"]]], buckets: ["0.1", "1", "10"] },
    { op: "observe", id: "h", labels: { outcome: "ok" }, value: "0.05" }, { op: "observe", id: "h", labels: { outcome: "error" }, value: "5" }, { op: "observe", id: "h", labels: { outcome: "zzz" }, value: "50" },
    { op: "initAll", id: "h" }, render,
    { op: "histogram", id: "u", name: "t_hu_seconds", help: "h", labels: [], buckets: ["1"] },
    { op: "observe", id: "u", value: "1" }, render,
  ]);
  add("family-without-series-prints-only-help-and-type", [counter("c", "t_none_total", [["k", ["a"]]]), { op: "gauge", id: "g", name: "t_none", help: "g", labels: [] }, render]);
  add("families-keep-declaration-order", [
    counter("z", "t_zzz_total"), { op: "gauge", id: "g", name: "t_aaa", help: "g", labels: [] }, { op: "gaugeFn", name: "t_mmm", help: "m", value: "1" }, { op: "inc", id: "z" }, { op: "set", id: "g", value: "2" }, render,
  ]);

  // Refusals and their messages.
  const gen = (count: number): Values => ({ gen: "v", count });
  const big = gen(33);
  const exact = gen(1024);
  const hard = gen(16384);
  add("refusals-of-names", [
    counter("a", "bad name"), counter("b", "1abc"), counter("c", ""), counter("d", "ok:name_1"),
    counter("e", "t_ok_total", [["bad-label", ["a"]]]), counter("f", "t_ok_total", [["le", ["a"]]]), counter("g", "t_ok_total", [["__x", ["a"]]]), counter("h", "t_ok_total", [["1x", ["a"]]]),
    counter("i", "t_ok_total", [["", ["a"]]]), counter("j", "t_ok_total", [["_ok1", ["a"]]]),
    counter("k", "t_dup_total"), counter("l", "t_dup_total"), { op: "gauge", id: "m", name: "t_dup_total", help: "g", labels: [] }, { op: "gaugeFn", name: "t_dup_total", help: "g", value: "1" },
    counter("n", "café_total"), counter("o", "quote\"_total"),
    render,
  ]);
  add("refusals-of-the-series-cap", [
    counter("a", "t_big_total", [["a", big], ["b", big]]),
    counter("b", "t_fits_total", [["a", big]]),
    counter("c", "t_open_total", [["a", exact]]),
    counter("d", "t_closed_total", [["a", exact]], { maxSeries: 1025 }),
    counter("e", "t_tight_total", [["a", exact]], { maxSeries: 1024 }),
    counter("f", "t_huge_total", [["a", hard]], { maxSeries: 16385 }),
    counter("g", "t_huge2_total", [["a", hard]], { maxSeries: 16384 }),
    counter("h", "t_hard_ok_total", [["a", gen(16383)]], { maxSeries: 16384 }),
    counter("i", "t_zero_total", [], { maxSeries: 0 }),
    counter("j", "t_neg_total", [], { maxSeries: -1 }),
    counter("k", "t_frac_total", [], { maxSeries: 1.5 }),
    counter("l", "t_one_total", [], { maxSeries: 1 }),
    { op: "gauge", id: "m", name: "t_gbig", help: "g", labels: [["a", big], ["b", big]] },
    { op: "histogram", id: "n", name: "t_hbig_seconds", help: "h", labels: [["a", big]], buckets: ["1", "2"] },
    { op: "histogram", id: "o", name: "t_hfit_seconds", help: "h", labels: [["a", gen(200)]], buckets: ["1", "2"] },
    { op: "histogram", id: "p", name: "t_hover_seconds", help: "h", labels: [["a", gen(201)]], buckets: ["1", "2"] },
  ]);
  add("refusals-of-buckets", [
    { op: "histogram", id: "a", name: "t_b1_seconds", help: "h", labels: [], buckets: [] },
    { op: "histogram", id: "b", name: "t_b2_seconds", help: "h", labels: [], buckets: ["1", "1"] },
    { op: "histogram", id: "c", name: "t_b3_seconds", help: "h", labels: [], buckets: ["2", "1"] },
    { op: "histogram", id: "d", name: "t_b4_seconds", help: "h", labels: [], buckets: ["NaN"] },
    { op: "histogram", id: "e", name: "t_b5_seconds", help: "h", labels: [], buckets: ["1", "Infinity"] },
    { op: "histogram", id: "f", name: "t_b6_seconds", help: "h", labels: [], buckets: ["-1", "0", "1"] },
    { op: "histogram", id: "g", name: "t_b7_seconds", help: "h", labels: [], buckets: ["1", "2", "NaN"] },
    render,
  ]);
  for (const suffix of ["_bucket", "_sum", "_count"]) {
    add(`histogram-series-names-collide${suffix}`, [
      { op: "histogram", id: "h", name: "job_seconds", help: "h", labels: [], buckets: ["1", "2"] },
      counter("c", `job_seconds${suffix}`),
      counter("d", "other_seconds"),
      { op: "histogram", id: "h2", name: "job_seconds", help: "h", labels: [], buckets: ["1"] },
      render,
    ]);
    add(`counter-named-like-a-histogram-series${suffix}`, [
      counter("c", `job_seconds${suffix}`),
      { op: "histogram", id: "h", name: "job_seconds", help: "h", labels: [], buckets: ["1", "2"] },
      render,
    ]);
  }
  add("failed-declaration-leaves-the-name-free", [
    counter("a", "t_free_total", [["le", ["a"]]]), counter("b", "t_free_total", [["k", ["a"]]]), { op: "inc", id: "b", labels: { k: "a" } }, render,
  ]);
  add("operations-after-a-histogram-name-failure", [
    { op: "histogram", id: "h", name: "t_hh_seconds", help: "h", labels: [], buckets: ["1"] },
    { op: "histogram", id: "h2", name: "t_hh_seconds_count", help: "h", labels: [], buckets: ["1"] },
    { op: "observe", id: "h", value: "0.5" }, render,
  ]);
  return cases.map((c) => ({ ...c, results: runRegistry(c.ops) }));
}

// ---- the harness's metric set -------------------------------------------------------------------------------------

type TelemetryIn = {
  rounds: Num; toolCalls: Num; metaCalls: { search: Num; skillLoad: Num; skillRead: Num }; skills: { injected: Num; loaded: Num };
  toolChoice: { status: string; forced: boolean }; toolNeed: { detected: boolean; reasons: string[] }; errorsReturned: Num;
  endReason: string; triageDurationMs: Num | null;
};
type MetricsOp =
  | { op: "rpcCall"; method: string; result: string }
  | { op: "rpcCalls"; methods: "core" | "first5"; results: string[] }
  | { op: "turn"; seconds: Num; outcome: string }
  | { op: "providerError"; provider: string; kind: string }
  | { op: "inboxPublished"; kind: string }
  | { op: "learnRun"; outcome: string | null; reason: string | null; findings: { desiredTier: string; status: string }[]; tokens: Num }
  | { op: "learnFinding"; tier: string; status: string }
  | { op: "turnTelemetry"; t: TelemetryIn }
  | { op: "repeatTelemetry"; t: TelemetryIn; triageFrom: number; count: number }
  | { op: "summary" }
  | { op: "render" };
interface MetricsCase {
  name: string; note?: string;
  memory: { rss: Num; heapTotal: Num; heapUsed: Num; external: Num; arrayBuffers: Num };
  connections: Num;
  health: null | { ready: boolean; journalBacklog: Num; agents: Num; uptimeSeconds: Num };
  ops: MetricsOp[];
}
type MetricsResult = { ok: true } | { text: string } | { summary: unknown };

const telemetry = (o: Partial<TelemetryIn> = {}): TelemetryIn => ({
  rounds: "0", toolCalls: "0", metaCalls: { search: "0", skillLoad: "0", skillRead: "0" }, skills: { injected: "0", loaded: "0" },
  toolChoice: { status: "auto", forced: false }, toolNeed: { detected: false, reasons: [] }, errorsReturned: "0", endReason: "completed", triageDurationMs: null, ...o,
});
const toTelemetry = (t: TelemetryIn, triage?: number): any => ({
  rounds: num(t.rounds), toolCalls: num(t.toolCalls), metaCalls: { search: num(t.metaCalls.search), skillLoad: num(t.metaCalls.skillLoad), skillRead: num(t.metaCalls.skillRead) },
  skills: { injected: num(t.skills.injected), loaded: num(t.skills.loaded) }, toolChoice: { ...t.toolChoice }, toolNeed: { detected: t.toolNeed.detected, reasons: [...t.toolNeed.reasons] },
  errorsReturned: num(t.errorsReturned), endReason: t.endReason, triageDurationMs: triage !== undefined ? triage : t.triageDurationMs === null ? null : num(t.triageDurationMs),
});

function runMetrics(c: MetricsCase): MetricsResult[] {
  const m = createMetrics({
    connections: () => num(c.connections),
    memoryUsage: () => ({ rss: num(c.memory.rss), heapTotal: num(c.memory.heapTotal), heapUsed: num(c.memory.heapUsed), external: num(c.memory.external), arrayBuffers: num(c.memory.arrayBuffers) }),
    ...(c.health ? { health: () => ({ ready: c.health!.ready, journalBacklog: num(c.health!.journalBacklog), agents: num(c.health!.agents), uptimeSeconds: num(c.health!.uptimeSeconds) }) } : {}),
  });
  const core = METHODS_BY_SERVER.core;
  return c.ops.map((o): MetricsResult => {
    switch (o.op) {
      case "rpcCall": m.rpcCall(o.method, o.result); break;
      case "rpcCalls": for (const method of o.methods === "core" ? core : core.slice(0, 5)) for (const r of o.results) m.rpcCall(method, r); break;
      case "turn": m.turn(num(o.seconds), o.outcome); break;
      case "providerError": m.providerError(o.provider, o.kind); break;
      case "inboxPublished": m.inboxPublished(o.kind); break;
      case "learnRun": m.learnRun({ outcome: o.outcome, reason: o.reason }, o.findings, num(o.tokens)); break;
      case "learnFinding": m.learnFinding(o.tier, o.status); break;
      case "turnTelemetry": m.turnTelemetry(toTelemetry(o.t)); break;
      case "repeatTelemetry": for (let i = 0; i < o.count; i++) m.turnTelemetry(toTelemetry(o.t, o.triageFrom + i)); break;
      case "summary": return { summary: m.turnTelemetrySummary() };
      case "render": return { text: m.render() };
    }
    return { ok: true };
  });
}

const baseMemory = { rss: "100", heapTotal: "50", heapUsed: "40", external: "7", arrayBuffers: "3" };

function metricsCases(): (MetricsCase & { results: MetricsResult[] })[] {
  const cases: MetricsCase[] = [];
  const add = (name: string, ops: MetricsOp[], o: Partial<MetricsCase> = {}) => cases.push({ name, memory: baseMemory, connections: "0", health: null, ops, ...o });
  const allResults = ["ok", "E_INVALID_PARAMS", "E_UNAUTHORIZED", "E_DENIED", "E_APPROVAL_REQUIRED", "E_NOT_FOUND", "E_AGENT_UNKNOWN", "E_MODULE_UNKNOWN", "E_NOT_AVAILABLE", "E_CORE_UNAVAILABLE", "E_LOCKED", "E_INTERNAL", "E_STORAGE", "E_CONFIG_INVALID", "E_X", "e_internal", "constructor", "__proto__", "toString", ""];

  add("initial-exposition", [{ op: "render" }]);
  add("rpc-calls-every-core-method", [{ op: "rpcCalls", methods: "core", results: ["ok"] }, { op: "render" }]);
  add("rpc-calls-every-result-class", [{ op: "rpcCalls", methods: "first5", results: allResults }, { op: "render" }]);
  add("rpc-calls-fold-unknown-methods-and-codes", [
    ...Array.from({ length: 20 }, (_, i): MetricsOp => ({ op: "rpcCall", method: `agent.${i}.secret`, result: `E_WEIRD_${i}` })),
    { op: "rpcCall", method: "memory.recall", result: "constructor" }, { op: "rpcCall", method: "__proto__", result: "__proto__" }, { op: "rpcCall", method: "core.status", result: "hasOwnProperty" },
    { op: "render" },
  ]);
  add("rpc-calls-per-method-and-result", [
    { op: "rpcCall", method: "memory.recall", result: "ok" }, { op: "rpcCall", method: "memory.recall", result: "ok" }, { op: "rpcCall", method: "memory.recall", result: "E_UNAUTHORIZED" },
    { op: "rpcCall", method: "core.status", result: "E_INTERNAL" }, { op: "render" },
  ]);
  add("turn-durations", [
    { op: "turn", seconds: "0.4", outcome: "ok" }, { op: "turn", seconds: "70", outcome: "error" }, { op: "turn", seconds: "1", outcome: "who-knows" },
    { op: "turn", seconds: "0.1", outcome: "aborted" }, { op: "turn", seconds: "120", outcome: "aborted" }, { op: "turn", seconds: "120.5", outcome: "aborted" },
    { op: "turn", seconds: "NaN", outcome: "ok" }, { op: "turn", seconds: "-1", outcome: "ok" }, { op: "turn", seconds: "Infinity", outcome: "ok" }, { op: "turn", seconds: "0.30000000000000004", outcome: "ok" },
    { op: "render" },
  ]);
  add("provider-errors", [
    { op: "providerError", provider: "anthropic", kind: "rate_limit" }, { op: "providerError", provider: "my-private-endpoint.example", kind: "weird" }, { op: "providerError", provider: "openai_compatible", kind: "network" },
    { op: "providerError", provider: "openai", kind: "timeout" }, { op: "providerError", provider: "openai", kind: "timeout" }, { op: "render" },
  ]);
  add("inbox-and-learning", [
    { op: "inboxPublished", kind: "approval" }, { op: "inboxPublished", kind: "not-a-kind" }, { op: "inboxPublished", kind: "job-failed" }, { op: "inboxPublished", kind: "approval" },
    { op: "learnRun", outcome: "completed", reason: null, findings: [{ desiredTier: "A", status: "pending" }, { desiredTier: "D", status: "accepted" }], tokens: "1234" },
    { op: "learnRun", outcome: null, reason: "zzz", findings: [], tokens: "NaN" }, { op: "learnRun", outcome: "failed", reason: "budget", findings: [], tokens: "-5" },
    { op: "learnRun", outcome: "skipped", reason: "disabled", findings: [], tokens: "0.5" },
    { op: "learnFinding", tier: "B", status: "waiting-h3" }, { op: "learnFinding", tier: "B", status: "nope" }, { op: "render" },
  ]);
  add("turn-telemetry-bounded-usage", [
    { op: "turnTelemetry", t: telemetry({ rounds: "3", toolCalls: "2", metaCalls: { search: "1", skillLoad: "2", skillRead: "3" }, skills: { injected: "1", loaded: "2" }, toolChoice: { status: "required", forced: true }, toolNeed: { detected: true, reasons: ["path", "url"] }, errorsReturned: "1", endReason: "completed", triageDurationMs: "25" }) },
    { op: "render" }, { op: "summary" },
  ]);
  add("turn-telemetry-need-reasons", [
    { op: "turnTelemetry", t: telemetry() },
    { op: "turnTelemetry", t: telemetry({ toolNeed: { detected: true, reasons: [] } }) },
    { op: "turnTelemetry", t: telemetry({ toolNeed: { detected: true, reasons: ["path", "path", "triage"] }, toolCalls: "1" }) },
    { op: "turnTelemetry", t: telemetry({ toolNeed: { detected: false, reasons: ["url"] } }) },
    { op: "turnTelemetry", t: telemetry({ toolChoice: { status: "unsupported", forced: false }, endReason: "round-limit", triageDurationMs: "0" }) },
    { op: "turnTelemetry", t: telemetry({ toolChoice: { status: "named", forced: true }, endReason: "approval-required", triageDurationMs: "0.5" }) },
    { op: "render" }, { op: "summary" },
  ]);
  add("turn-telemetry-folds-unknown-strings-and-bad-numbers", [
    { op: "turnTelemetry", t: telemetry({ rounds: "NaN", toolCalls: "-3", metaCalls: { search: "Infinity", skillLoad: "-1", skillRead: "2.5" }, skills: { injected: "NaN", loaded: "1e3" }, toolChoice: { status: "private-value", forced: false }, toolNeed: { detected: true, reasons: ["private-value", "other"] }, errorsReturned: "-1", endReason: "private-value", triageDurationMs: "NaN" }) },
    { op: "turnTelemetry", t: telemetry({ endReason: "", triageDurationMs: "-5" }) },
    { op: "turnTelemetry", t: telemetry({ rounds: "0.5", errorsReturned: "1e21", triageDurationMs: "1e-7" }) },
    { op: "render" }, { op: "summary" },
  ]);
  add("turn-telemetry-ring-keeps-the-latest-1024-triage-samples", [
    { op: "repeatTelemetry", t: telemetry({ rounds: "1", toolChoice: { status: "private-value", forced: false }, toolNeed: { detected: true, reasons: ["private-value"] }, endReason: "private-value" }), triageFrom: 0, count: 1100 },
    { op: "render" }, { op: "summary" },
  ]);
  add("turn-telemetry-quantiles-small-samples", [
    { op: "summary" },
    { op: "turnTelemetry", t: telemetry({ triageDurationMs: "7" }) }, { op: "summary" },
    { op: "turnTelemetry", t: telemetry({ triageDurationMs: "3" }) }, { op: "summary" },
    { op: "turnTelemetry", t: telemetry({ triageDurationMs: "11" }) }, { op: "turnTelemetry", t: telemetry({ triageDurationMs: "5" }) }, { op: "summary" },
    { op: "render" },
  ]);
  add("gauges-from-health-memory-and-connections", [{ op: "render" }], { connections: "3", health: { ready: true, journalBacklog: "4", agents: "2", uptimeSeconds: "12" } });
  add("gauges-print-numbers-like-javascript", [{ op: "render" }], {
    connections: "1e21", memory: { rss: "123456789012", heapTotal: "0.1", heapUsed: "1e-7", external: "-0", arrayBuffers: "9007199254740993" },
    health: { ready: false, journalBacklog: "1.5", agents: "100000000000000000000", uptimeSeconds: "86400.123456789" },
  });
  add("gauges-skip-non-finite-readings", [{ op: "render" }], {
    connections: "NaN", memory: { rss: "Infinity", heapTotal: "-Infinity", heapUsed: "NaN", external: "5", arrayBuffers: "6" },
    health: { ready: true, journalBacklog: "NaN", agents: "Infinity", uptimeSeconds: "-1" },
  });
  return cases.map((c) => ({ ...c, results: runMetrics(c) }));
}

export async function buildMetricsVectors(): Promise<Record<string, unknown>> {
  return {
    registry: { cases: registryCases() },
    metrics: { methods: [...METHODS_BY_SERVER.core], cases: metricsCases() },
  };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  process.exit(await exporterMain({ area: "metrics", build: buildMetricsVectors }));
}
