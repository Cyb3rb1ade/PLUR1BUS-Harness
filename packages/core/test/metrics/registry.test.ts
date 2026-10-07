import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createRegistry, MAX_SERIES_PER_METRIC } from "../../src/metrics/registry.ts";
import { parseExposition } from "./exposition-parser.ts";

describe("metrics registry", () => {
  it("renders counters, gauges and histograms in a format a strict parser accepts", () => {
    const r = createRegistry();
    const c = r.counter("t_calls_total", "Calls.", { result: ["ok", "error"] });
    c.inc({ result: "ok" }); c.inc({ result: "ok" }, 2); c.inc({ result: "error" });
    const g = r.gauge("t_open", "Open things.", {});
    g.set({}, 4);
    r.gaugeFn("t_live", "Computed.", () => 7);
    const h = r.histogram("t_seconds", "Durations.", { outcome: ["ok"] }, [0.1, 1]);
    h.observe({ outcome: "ok" }, 0.05); h.observe({ outcome: "ok" }, 0.5); h.observe({ outcome: "ok" }, 5);
    const fams = parseExposition(r.render());
    const by = Object.fromEntries(fams.map((f) => [f.name, f]));
    assert.equal(by.t_calls_total!.type, "counter");
    assert.equal(by.t_calls_total!.samples.find((s) => s.labels.result === "ok")!.value, 3);
    assert.equal(by.t_open!.samples[0]!.value, 4);
    assert.equal(by.t_live!.samples[0]!.value, 7);
    const hs = by.t_seconds!.samples;
    assert.deepEqual(hs.filter((s) => s.name === "t_seconds_bucket").map((s) => [s.labels.le, s.value]), [["0.1", 1], ["1", 2], ["+Inf", 3]]);
    assert.equal(hs.find((s) => s.name === "t_seconds_count")!.value, 3);
    assert.equal(hs.find((s) => s.name === "t_seconds_sum")!.value, 5.55);
  });

  it("folds a label value outside its enumeration into 'other' (bounded cardinality)", () => {
    const r = createRegistry();
    const c = r.counter("t_x_total", "X.", { who: ["a", "b"] });
    for (let i = 0; i < 1000; i++) c.inc({ who: `user-${i}` });
    const f = parseExposition(r.render())[0]!;
    assert.deepEqual(f.samples.map((s) => s.labels.who), ["other"]);
    assert.equal(f.samples[0]!.value, 1000);
  });

  it("refuses a metric whose label space could exceed the series cap", () => {
    const r = createRegistry();
    const big = Array.from({ length: Math.ceil(Math.sqrt(MAX_SERIES_PER_METRIC)) + 1 }, (_, i) => `v${i}`);
    assert.throws(() => r.counter("t_big_total", "Big.", { a: big, b: big }), /series/);
  });

  it("refuses invalid metric and label names, and duplicate registration", () => {
    const r = createRegistry();
    assert.throws(() => r.counter("bad name", "x", {}));
    assert.throws(() => r.counter("t_ok_total", "x", { "bad-label": ["a"] }));
    assert.throws(() => r.counter("t_ok_total", "x", { le: ["a"] }));
    r.counter("t_dup_total", "x", {});
    assert.throws(() => r.counter("t_dup_total", "x", {}));
  });

  it("escapes label values and help text", () => {
    const r = createRegistry();
    r.counter("t_esc_total", "Line1\nLine2 \\ end.", { v: ['a"b\\c\nd'] }).inc({ v: 'a"b\\c\nd' });
    const f = parseExposition(r.render())[0]!;
    assert.equal(f.samples[0]!.labels.v, 'a"b\\c\nd');
  });

  it("ignores negative counter increments and non-finite observations", () => {
    const r = createRegistry();
    const c = r.counter("t_n_total", "N.", {}); c.inc({}, -5); c.inc({}, Number.NaN); c.inc({});
    const h = r.histogram("t_h_seconds", "H.", {}, [1]); h.observe({}, Number.NaN); h.observe({}, -1);
    const fams = parseExposition(r.render());
    assert.equal(fams[0]!.samples[0]!.value, 1);
    assert.equal(fams[1]!.samples.find((s) => s.name === "t_h_seconds_count")!.value, 0);
  });
});
