// Parity vectors (mode V) for the capability index of the tool-call runtime (P4-K K9b, plan P4-42): the in-memory index
// with its ranking, the usage prior, the calibration file, and the two functions of the JavaScript math library the
// ranking stands on. `crates/plur1bus-core/src/toolcall/capability_vectors.rs` replays every case.
//
// A ranking is only the same ranking if the scores are the same doubles, so a score is recorded as `JSON.stringify`
// prints it (the shortest text that reads back as the same double) and compared as text. The scenarios are chosen so
// that their scores do not depend on the machine (see `fdlibmLog` below for why that is a question at all).
//
//   node --experimental-strip-types --conditions=source --no-warnings=ExperimentalWarning scripts/parity/export-capabilities.ts [--check]
import { fileURLToPath } from "node:url";
import { exporterMain } from "./lib.mjs";
import { answer, mulberry32, pick, thrown } from "./toolcall-support.ts";
import { CapabilityIndex, capabilitiesSearch } from "../../packages/core/src/toolcall/capabilities.ts";
import { loadCalibration, usagePrior } from "../../packages/core/src/toolcall/calibration.ts";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const text = (v: unknown) => JSON.stringify(v);
const attempt = (fn: () => unknown, full = true): unknown => { try { return answer(text(fn()) ?? "undefined", full); } catch (e) { return thrown(e); } };
const bits = (x: number) => new BigUint64Array(new Float64Array([x]).buffer)[0]!.toString(16).padStart(16, "0");

const fromBits = (hex: string) => new Float64Array(new BigUint64Array([BigInt(`0x${hex}`)]).buffer)[0]!;
const LN2_HI = fromBits("3fe62e42fee00000"), LN2_LO = fromBits("3dea39ef35793c76"), TWO54 = fromBits("4350000000000000"), THIRD = fromBits("3fd5555555555555");
const LG = ["3fe5555555555593", "3fd999999997fa04", "3fd2492494229359", "3fcc71c51d8e78af", "3fc7466496cb03de", "3fc39a09d078c69f", "3fc2f112df3e5244"].map(fromBits);

/**
 * fdlibm's `__ieee754_log` (the routine V8 carries as `base::ieee754::log`), every operation rounded on its own. This is
 * the one place an exporter computes instead of recording, and the reason is that `Math.log` itself is not one function:
 * where V8 was compiled with fused multiply-add (the arm64 builds) it rounds some products and sums together and differs
 * from this routine in the last place for a few arguments in a hundred (K9b-D1). A vector has to be the same file on every
 * machine, so it holds the unfused routine, which is what the Rust core computes; `parity.test.ts` states how far
 * `Math.log` of the running machine is from it.
 */
export function fdlibmLog(x: number): number {
  const view = new DataView(new ArrayBuffer(8));
  const high = (v: number) => { view.setFloat64(0, v); return view.getInt32(0); };
  const low = (v: number) => { view.setFloat64(0, v); return view.getUint32(4); };
  const withHigh = (v: number, h: number) => { view.setFloat64(0, v); view.setInt32(0, h); return view.getFloat64(0); };
  let hx = high(x), k = 0;
  if (hx < 0x00100000) {
    if (((hx & 0x7fffffff) | low(x)) === 0) return -Infinity;
    if (hx < 0) return NaN;
    k -= 54; x *= TWO54; hx = high(x);
  }
  if (hx >= 0x7ff00000) return x + x;
  k += (hx >> 20) - 1023;
  hx &= 0x000fffff;
  const i = (hx + 0x95f64) & 0x100000;
  x = withHigh(x, hx | (i ^ 0x3ff00000));
  k += i >> 20;
  const f = x - 1, dk = k;
  if ((0x000fffff & (2 + hx)) < 3) {
    if (f === 0) return k === 0 ? 0 : dk * LN2_HI + dk * LN2_LO;
    const r = f * f * (0.5 - THIRD * f);
    return k === 0 ? f - r : dk * LN2_HI - ((r - dk * LN2_LO) - f);
  }
  const s = f / (2 + f), z = s * s, w = z * z;
  const t1 = w * (LG[1]! + w * (LG[3]! + w * LG[5]!));
  const t2 = z * (LG[0]! + w * (LG[2]! + w * (LG[4]! + w * LG[6]!)));
  const r = t2 + t1;
  if (((hx - 0x6147a) | (0x6b851 - hx)) > 0) {
    const hfsq = 0.5 * f * f;
    return k === 0 ? f - (hfsq - s * (hfsq + r)) : dk * LN2_HI - ((hfsq - (s * (hfsq + r) + dk * LN2_LO)) - f);
  }
  return k === 0 ? f - s * (f - r) : dk * LN2_HI - ((s * (f - r) - dk * LN2_LO) - f);
}

/** The arguments of the `log` vector (also read by `parity.test.ts`). */
export function logArguments(): number[] {
  const rnd = mulberry32(0x10_6a17);
  const xs: number[] = [1, 2, 0.5, 10, 100, Math.E, Math.SQRT2, 1e-300, 5e-324, 2.2250738585072014e-308, 1e308, 1.7976931348623157e308, 1.0000001, 0.9999999, 1 + 2 ** -20, 1 - 2 ** -20, 1 + 2 ** -21, 1 + 2 ** -52, 0, -0, -1, Infinity, 3, 1.5, 0.75, 1.4142135623730951, 0.7071067811865476];
  // The arguments the ranking produces: 1 + (N - df + .5) / (df + .5).
  for (let n = 1; n <= 36; n++) for (let df = 1; df <= n; df++) xs.push(1 + (n - df + .5) / (df + .5));
  for (let i = 0; i < 500; i++) xs.push(pick(rnd, [rnd() * 4, 1 + rnd() * 1e-3, rnd() * 1e6, 2 ** Math.floor(rnd() * 80 - 40) * (1 + rnd()), rnd()]));
  return xs;
}

function buildMath() {
  const log = logArguments().map(x => `${bits(x)}:${bits(fdlibmLog(x))}`);
  // Decay weights, 2 ** (-age / half-life). `2 ** x` is the platform's `pow`; only an integer exponent has the same
  // answer on every platform, so only those are recorded.
  const exps: number[] = [0, -1, -2, -10, -52, -1022, -1023, -1074, -1075, -2000, 1, 3, 1023, 1024];
  const pow2 = exps.map(x => `${bits(x)}:${bits(2 ** x)}`);
  return { log, pow2, seed: "0x106a17" };
}

function buildCalibration() {
  const dir = mkdtempSync(join(tmpdir(), "p4k-calibration-"));
  const good = { minOffers: 10, maxBonus: 0.2, maxPenalty: 0.2, halfLifeDays: 14, successTarget: 0.8, successWeight: 0.5, searchWeight: 0.1 };
  const files: string[] = [
    text(good), text({ ...good, minOffers: 1, halfLifeDays: 0.5, maxBonus: 1, maxPenalty: 0, successTarget: 1, successWeight: 100, searchWeight: 0 }), text({ searchWeight: 0.1, ...good }),
    text({ ...good, minOffers: 0.5 }), text({ ...good, minOffers: 0 }), text({ ...good, halfLifeDays: 0 }), text({ ...good, maxBonus: 1.01 }), text({ ...good, maxPenalty: 1.5 }), text({ ...good, successTarget: 1.1 }), text({ ...good, successWeight: -1 }),
    text({ ...good, searchWeight: "0.1" }), text({ ...good, searchWeight: null }), text({ ...good, extra: 1 }), text({ ...good, minOffers: undefined }), '{"minOffers":1e400,"maxBonus":0.2,"maxPenalty":0.2,"halfLifeDays":14,"successTarget":0.8,"successWeight":0.5,"searchWeight":0.1}',
    `${text(good).slice(0, -1)},"minOffers":0}`, `${text(good).slice(0, -1)},"minOffers":20}`, "null", "[]", "5", "\"x\"", "{}", "true", "", "{", "{'minOffers':10}", ` ${text(good)}\n`, String.fromCharCode(0xfeff) + text(good), text({ ...good, minOffers: -0 }), text({ ...good, maxBonus: -0 }),
  ];
  const load: unknown[] = [["", attempt(() => loadCalibration())]];
  try {
    files.forEach((content, i) => { const path = join(dir, `c${i}.json`); writeFileSync(path, content); load.push([content, attempt(() => loadCalibration(path))]); });
  } finally { rmSync(dir, { recursive: true, force: true }); }
  const rnd = mulberry32(0xca11_b8a7);
  const stat = () => { const offered = pick(rnd, [0, 1, 9, 10, 11, 9.999, 10.5, 50, 1000]) * (rnd() < 0.3 ? rnd() : 1); const used = Math.min(offered, pick(rnd, [0, 0, 1, 5, 9, 40]) * rnd()); return { offered, used, foundBySearch: pick(rnd, [0, 0, 1, 3, 20, 2000]) * rnd(), succeeded: used * pick(rnd, [0, 0.5, 1, rnd()]) }; };
  const configs = [good, { ...good, minOffers: 1 }, { ...good, maxBonus: 0, maxPenalty: 1 }, { ...good, successWeight: 5, searchWeight: 3 }, { ...good, successTarget: 0 }, { ...good, successTarget: 1, successWeight: 0.01 }];
  const prior: unknown[] = [];
  for (let i = 0; i < 400; i++) { const a = stat(), g = stat(), c = pick(rnd, configs); prior.push([text(a), text(g), text(c), text(usagePrior(a, g, c))]); }
  return { load, prior, seed: "0xca11b8a7" };
}

const base = (id: string, over: Record<string, unknown> = {}) => ({ id, name: id, description: "Create a document report", category: "docs.create", kind: "tool", effect: "read", risk: "low", source: "synthetic", version: "1", ...over });

/** Runs scripted operations against one index; the ports answer from the scenario's tables. */
function runIndex(name: string, world: { embedding?: Record<string, number>; lexical?: Record<string, number>; prior?: Record<string, number> }, ops: any[]) {
  const map = (o: Record<string, number>) => new Map(Object.entries(o));
  const index = new CapabilityIndex(
    world.embedding ? { score: () => map(world.embedding!) } : undefined,
    world.lexical ? (_query, entries) => new Map(entries.filter(e => Object.hasOwn(world.lexical!, e.id)).map(e => [e.id, world.lexical![e.id]!])) : undefined,
    world.prior ? e => world.prior![e.id] ?? 0 : undefined,
  );
  const steps = ops.map(op => {
    switch (op.op) {
      case "upsert": return attempt(() => { index.upsert(JSON.parse(op.entry)); return null; });
      case "remove": return attempt(() => { index.remove(op.id); return null; });
      case "search": return attempt(() => capabilitiesSearch(index, op.query, op.filters), op.full !== false);
      case "route": return attempt(() => index.route(op.query, Object.fromEntries(op.distribution), ...(op.topK !== undefined ? [op.topK, ...(op.confidence !== undefined ? [op.confidence] : [])] : [])), op.full !== false);
      case "prefix": return attempt(() => index.categoriesPrefix(), false);
      default: throw new Error(op.op);
    }
  });
  return { name, world, ops, steps };
}

function buildIndex() {
  const up = (id: string, over: Record<string, unknown> = {}) => ({ op: "upsert", entry: text(base(id, over)) });
  const search = (query: string, filters?: Record<string, unknown>) => ({ op: "search", query, ...(filters ? { filters } : {}) });
  const route = (query: string, distribution: [string, number][], topK?: number, confidence?: number) => ({ op: "route", query, distribution, ...(topK !== undefined ? { topK } : {}), ...(confidence !== undefined ? { confidence } : {}) });
  const corpus = [
    up("write_report", { description: "Create a document report from notes", useWhen: "The person wants a written report", inputs: "title notes" }),
    up("read_file", { description: "Read a file from disk", category: "files.read", secondaryCategories: ["docs.read", "code.navigate"] }),
    up("search_web", { description: "Search the web for current pages", category: "web.search", effect: "external", risk: "medium", source: "mcp" }),
    up("send_mail", { description: "Send an email report to a person", category: "comm.email", kind: "mcp-tool", effect: "external", risk: "high", source: "mcp" }),
    up("skill:report", { name: "report", description: "Report writing skill, report report", category: "docs.create", kind: "skill" }),
    up("disabled", { description: "A disabled report tool", enabled: false }),
    up("Zeta", { description: "Größe ΣΊΣΥΦΟΣ İstanbul straße déjà_vu 123 a1b2", category: "general.chat" }),
  ];
  const scenarios: unknown[] = [];
  scenarios.push(runIndex("lexical ranking", {}, [...corpus,
    search("report"), search("REPORT document"), search("report report"), search("file"), search("nothing matches this"), search(""), search("größe"), search("σίσυφος"), search("istanbul"), search("i̇stanbul"), search("déjà_vu 123"), search("a1b2 A1B2"), search("re-port, web/pages!"),
    search("report", { limit: 0 }), search("report", { limit: 2 }), search("report", { limit: 128 }), search("report", { limit: 129 }), search("report", { limit: -1 }), search("report", { limit: 1.5 }),
    search("report", { category: "docs.create" }), search("report", { category: "docs.read" }), search("file", { category: "code.navigate" }), search("report", { category: "" }), search("report", { kind: "skill" }), search("report", { kind: "mcp-tool", effect: "external", source: "mcp" }),
    search("report", { effect: "read", source: "synthetic", limit: 3 }), search("report", { source: "nope" }), { op: "prefix" },
    { op: "remove", id: "write_report" }, search("report"), { op: "remove", id: "write_report" }, up("write_report", { description: "back again report" }), search("report"), up("read_file", { description: "now also a report" }), search("report"),
  ]));
  const invalid: Record<string, unknown>[] = [{ id: "" }, { name: "" }, { description: "" }, { version: "" }, { source: "" }, { kind: "widget" }, { effect: "write" }, { risk: "none" }, { category: "docs" }, { category: "Docs.create" }, { category: "docs.create.x" }, { category: "docs.create\n" }, { category: "1docs.create" }, { category: "d-o.c-1" },
    { secondaryCategories: ["a.b", "c.d", "e.f"] }, { secondaryCategories: ["a.b", "c.d"] }, { secondaryCategories: [] }, { effect: "network.a2a", risk: "critical", kind: "channel-action" }, { effect: "money", kind: "plugin-command" }, { kind: "extension", effect: "local-destructive" }, { effect: "local-write" }, { extra: { nested: [1, 2] }, generatedFields: ["category"], notFor: "x" }];
  scenarios.push(runIndex("registration", {}, [...invalid.map((over, i) => up(`e${i}`, over)), { op: "upsert", entry: "{}" }, { op: "upsert", entry: text({ ...base("x"), id: undefined }) }, search("report", { limit: 128 })]));
  scenarios.push(runIndex("ports", { embedding: { write_report: 0.25, read_file: 0.9, search_web: -1, send_mail: 0, missing: 5, "skill:report": 0.25 }, prior: { write_report: 0.2, read_file: -0.2, send_mail: 1 } }, [...corpus, search("report"), search("zzz"), search("file web"), search("report", { limit: 1 })]));
  scenarios.push(runIndex("the store's ranking replaces the lexical score", { lexical: { read_file: 1, write_report: 0.5, send_mail: 0, search_web: 1 / 3 }, embedding: { send_mail: 0.5, Zeta: 0.125 }, prior: { read_file: 0.125, Zeta: 9, "skill:report": 3 } }, [...corpus, search("report"), search("file"), search("report", { category: "docs.create" })]));
  const many = Array.from({ length: 40 }, (_, i) => up(`t${String(i).padStart(2, "0")}`, { description: `tool number ${i} ${i % 3 ? "alpha" : "beta"} ${i % 5 ? "" : "gamma gamma"}`, category: ["docs.create", "web.search", "files.read", "comm.email"][i % 4] }));
  scenarios.push(runIndex("routing", {}, [...many,
    route("alpha", [["docs.create", 0.6], ["web.search", 0.3], ["files.read", 0.1]]), route("alpha", [["docs.create", 0.6], ["web.search", 0.3], ["files.read", 0.1]]), route("alpha", [["files.read", 0.1], ["web.search", 0.3], ["docs.create", 0.6]]),
    route("alpha", [["docs.create", 0.6], ["web.search", 0.3], ["files.read", 0.1]], 12, 0.4), route("alpha", [["docs.create", 0.6], ["web.search", 0.3], ["files.read", 0.1]], 12, 0.4),
    route("gamma", [["docs.create", 1], ["web.search", 1], ["files.read", 1], ["comm.email", 1]], 5), route("gamma", [["docs.create", 0.98], ["web.search", 0.01], ["files.read", 0.01]], 3, 0.1), route("gamma", [["docs.create", 0.98], ["web.search", 0.01], ["files.read", 0.01]], 2, 0.1),
    route("beta", [["nope.none", 1]], 4), route("beta", [["docs.create", 0], ["web.search", 0.5]], 4, 0.49), route("beta", [["docs.create", 0.5]], 0), route("beta", [["docs.create", 0.5]], 128), route("beta", [["docs.create", 0.5]], 129), route("beta", [["docs.create", 0.5]], 1.5),
    route("beta", [["docs.create", 0.5]], 4, 1.01), route("beta", [["docs.create", 0.5]], 4, -0.1), route("beta", [["docs.create", -0.5]], 4), route("beta", [], 4), route("beta", [["docs.create", 0], ["web.search", 0]], 4), route("beta", [["a.a", 0.1], ["b.b", 0.2], ["c.c", 0.3], ["d.d", -1]], 4),
    route("tool", [["docs.create", 1 / 3], ["web.search", 1 / 3], ["files.read", 1 / 3]], 10), route("tool", [["docs.create", 0.5], ["web.search", 0.5]], 7, 0.5), route("tool", [["comm.email", 0.2], ["docs.create", 0.2], ["files.read", 0.2], ["web.search", 0.2]], 6, 0),
    up("t00", { description: "changed", category: "docs.create" }), route("alpha", [["docs.create", 0.6], ["web.search", 0.3], ["files.read", 0.1]]), { op: "remove", id: "nope" }, route("alpha", [["docs.create", 0.6], ["web.search", 0.3], ["files.read", 0.1]]),
  ]));
  const rnd = mulberry32(0x1d3_c0de);
  const WORDS = ["report", "file", "web", "mail", "alpha", "beta", "gamma", "delta", "read", "write", "search", "ÉCOLE", "naïve", "x1", "_", "東京", "tokyo"];
  const words = (n: number) => Array.from({ length: 1 + Math.floor(rnd() * n) }, () => pick(rnd, WORDS)).join(pick(rnd, [" ", " ", "-", ", "]));
  const CATS = ["docs.create", "web.search", "files.read", "comm.email", "general.chat"];
  for (let s = 0; s < 12; s++) {
    const n = 3 + Math.floor(rnd() * 25);
    const ops: any[] = Array.from({ length: n }, (_, i) => up(`g${i}`, { name: words(2), description: words(9), category: pick(rnd, CATS), ...(rnd() < .3 ? { useWhen: words(5) } : {}), ...(rnd() < .2 ? { inputs: words(3) } : {}), ...(rnd() < .2 ? { secondaryCategories: [pick(rnd, CATS)] } : {}), ...(rnd() < .1 ? { enabled: rnd() < .5 } : {}) }));
    for (let q = 0; q < 14; q++) ops.push(rnd() < .7 ? { ...search(words(3), rnd() < .3 ? { category: pick(rnd, CATS), limit: Math.floor(rnd() * 6) } : undefined), full: q < 2 } : { ...route(words(3), CATS.filter(() => rnd() < .6).map(c => [c, Math.round(rnd() * 100) / 100] as [string, number]), Math.floor(rnd() * 9), pick(rnd, [1, 0.3, 0.5, 0.9])), full: q < 2 });
    const table = () => Object.fromEntries(Array.from({ length: n }, (_, i) => [`g${i}`, pick(rnd, [0, 0.1, 0.5, 1 / 3, -0.2, 1])]).filter(() => rnd() < .6));
    scenarios.push(runIndex(`generated ${s}`, { ...(s % 3 === 1 ? { embedding: table() } : {}), ...(s % 4 === 2 ? { lexical: table() } : {}), ...(s % 2 === 1 ? { prior: table() } : {}) }, ops));
  }
  return { scenarios, seed: "0x1d3c0de" };
}

export async function buildCapabilityVectors() {
  return { math: buildMath(), calibration: buildCalibration(), index: buildIndex() };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) process.exit(await exporterMain({ area: "capabilities", build: buildCapabilityVectors }));
