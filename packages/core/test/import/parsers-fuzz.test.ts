// core/import parsers, generative robustness: json5.ts and yaml-lite.ts, 1 200 seeded cases each (spec minimum 1 000):
// valid documents rendered with random decoration (comments, trailing commas, odd whitespace, hex numbers, line continuations)
// and parsed back, truncated documents, character soup, single-character mutations. Never an exception other than the
// documented parse error, never a prototype change. Deep nesting up to 10 000 levels is covered separately.
//
// Each batch runs in a worker thread under a watchdog: when a single case makes no progress for WATCHDOG_MS the worker is
// terminated and the test fails naming the seed and the case. (A synchronous hang cannot be interrupted from inside its own
// thread, and the test runner's timeout cannot fire while the thread is busy.)
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { Worker } from "node:worker_threads";
import { parseJson5 } from "../../src/import/json5.ts";
import { readYaml } from "../../src/import/yaml-lite.ts";
import { mulberry32, prototypeFingerprint } from "./helpers.ts";

const WATCHDOG_MS = 8000; // per case with no progress; each case takes well under a millisecond when the parser behaves

interface Report { done: true; failures: string[]; failureCount: number; counts: Record<string, number> }
function runBatch(parser: "json5" | "yaml", seed: number, cases: number): Promise<Report> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL("./fuzz-worker.ts", import.meta.url), { workerData: { parser, seed, cases } });
    let lastCase = -1; let timer: NodeJS.Timeout | undefined;
    const arm = () => { clearTimeout(timer); timer = setTimeout(() => { void worker.terminate(); reject(new Error(`seed=0x${seed.toString(16)} parser=${parser}: case ${lastCase + 1} made no progress for ${WATCHDOG_MS} ms (hang)`)); }, WATCHDOG_MS); };
    arm();
    worker.on("message", (m: { progress?: number } & Partial<Report>) => { if (typeof m.progress === "number") { lastCase = m.progress; arm(); } else if (m.done) { clearTimeout(timer); resolve(m as Report); } });
    worker.on("error", (e) => { clearTimeout(timer); reject(new Error(`seed=0x${seed.toString(16)} parser=${parser}: worker crashed after case ${lastCase}: ${e.message}`)); });
    worker.on("exit", (code) => { clearTimeout(timer); if (code !== 0) reject(new Error(`seed=0x${seed.toString(16)} parser=${parser}: worker exited with ${code} after case ${lastCase}`)); });
  });
}

describe("parseJson5: 1 200 seeded cases", () => {
  for (const seed of [0x15a5e001, 0x15a5e002, 0x15a5e003]) {
    it(`seed 0x${seed.toString(16)}: 400 cases (round trip, truncation, soup, mutation)`, { timeout: 60_000 }, async () => {
      const r = await runBatch("json5", seed, 400);
      assert.deepEqual(r.failures, [], `${r.failureCount} failing cases, first ones listed; counts ${JSON.stringify(r.counts)}`);
      assert.ok(r.counts["roundTrip"]! >= 150 && r.counts["truncated"]! >= 100 && r.counts["soup"]! >= 60 && r.counts["mutated"]! >= 30, JSON.stringify(r.counts));
      assert.ok(r.counts["accepted"]! >= 150 && r.counts["rejected"]! >= 100, `the generator must produce both accepted and rejected inputs: ${JSON.stringify(r.counts)}`);
    });
  }
});

describe("readYaml: 1 200 seeded cases", () => {
  for (const seed of [0x7a3110a1, 0x7a3110a2, 0x7a3110a3]) {
    it(`seed 0x${seed.toString(16)}: 400 cases (round trip, truncation, soup, mutation)`, { timeout: 60_000 }, async () => {
      const r = await runBatch("yaml", seed, 400);
      assert.deepEqual(r.failures, [], `${r.failureCount} failing cases, first ones listed; counts ${JSON.stringify(r.counts)}`);
      assert.ok(r.counts["roundTrip"]! >= 150 && r.counts["truncated"]! >= 100 && r.counts["soup"]! >= 60 && r.counts["mutated"]! >= 30, JSON.stringify(r.counts));
    });
  }
});

describe("deep nesting up to 10 000 levels", () => {
  it("parseJson5: random bracket/brace/comment/string mixtures of depth 1..10 000 give a value or the documented SyntaxError, in bounded time", { timeout: 60_000 }, () => {
    const SEED = 0xdee91;
    const rnd = mulberry32(SEED);
    const fingerprint = prototypeFingerprint();
    for (let i = 0; i < 120; i++) {
      const depth = i < 10 ? i * 25 : 1 + Math.floor(rnd() * 10_000);
      const parts = ["[", "{a:", "[{\"b\":", "{'__proto__':", "[ /*c*/ ", "{k:[1,"];
      const open = Array.from({ length: depth }, () => parts[Math.floor(rnd() * parts.length)]!).join("");
      const text = rnd() < 0.5 ? open : open + "1" + Array.from({ length: depth }, () => "]").join("");
      const ctx = `seed=0x${SEED.toString(16)} case=${i} depth=${depth}`;
      try { parseJson5(text); } catch (e) { assert.ok(e instanceof SyntaxError && /^JSON5: /.test(e.message), `${ctx}: ${e instanceof Error ? e.constructor.name + ": " + e.message.slice(0, 80) : String(e)}`); }
    }
    assert.equal(prototypeFingerprint(), fingerprint);
  });

  it("parseJson5: a 10 000-level document gives 'nesting too deep' without reading the rest of the input", () => {
    const text = "[".repeat(10_000) + "]".repeat(10_000);
    assert.throws(() => parseJson5(text), /nesting too deep at offset 20[12]$/);
  });

  it("readYaml: nested flow lists and chained '- ' markers of depth 10 000 are one line and are handled without recursion", () => {
    const flow = readYaml(`a: ${"[".repeat(10_000)}1${"]".repeat(10_000)}\nb: 2`);
    assert.deepStrictEqual(flow.value, { b: 2 }); assert.equal(flow.unsupported.length, 1);
    const dashes = readYaml(`${"- ".repeat(10_000)}x`);
    assert.ok(Array.isArray(dashes.value) && dashes.value.length === 1);
    const braces = readYaml(`a: ${"{".repeat(10_000)}\nb: 1`);
    assert.deepStrictEqual(braces.value, { b: 1 });
  });

  it("readYaml: indentation nesting of 2 000 mappings, sequences and mixed levels (what a 4 MiB config can hold) parses to the exact depth", () => {
    const chain = (n: number, kind: "map" | "seq" | "mixed"): string => Array.from({ length: n }, (_, i) => " ".repeat(i) + (kind === "map" ? "k:" : kind === "seq" ? "-" : i % 2 ? "- " + "" : "k:").trimEnd()).join("\n") + (kind === "map" ? " 1" : kind === "seq" ? " 1" : "\n" + " ".repeat(n) + "- 1");
    for (const kind of ["map", "seq"] as const) {
      let v = readYaml(chain(2000, kind)).value; let depth = 0;
      while (v !== null && typeof v === "object") { v = Array.isArray(v) ? v[0] : (v as Record<string, unknown>)["k"]; depth++; }
      assert.equal(depth, 2000, kind);
    }
    assert.doesNotThrow(() => readYaml(chain(1500, "mixed")));
  });

  it("readYaml: 100 000-character lines without whitespace runs (quote, colon, bracket and dash soups) finish and never throw", () => {
    for (const unit of ["'", "\"", "a:", "[", "-", "- a: ", "a: |\n  ", "#", "&a ", "'a''"]) {
      const text = unit.repeat(Math.ceil(100_000 / unit.length));
      assert.doesNotThrow(() => readYaml(text), unit);
      assert.doesNotThrow(() => readYaml(`k: ${text}`), unit);
    }
  });
});
