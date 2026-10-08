import { test } from "node:test";
import assert from "node:assert/strict";
import { FeatureLatencyRecorder, median, percentile } from "../src/realtime/latency.ts";

test("median and p95 (nearest rank) on known samples", () => {
  const s = Array.from({ length: 20 }, (_, i) => i + 1);
  assert.equal(median(s), 10.5);
  assert.equal(percentile(s, 0.95), 19);
  assert.equal(percentile([5], 0.95), 5);
  assert.equal(median([]), 0);
  assert.equal(percentile([], 0.95), 0);
  assert.equal(median([1, 2, 9]), 2);
});

test("report aggregates per feature across turns, counts budget overruns, and measures speech-end to first audio", () => {
  let t = 0;
  const rec = new FeatureLatencyRecorder({ now: () => t });
  for (let turn = 1; turn <= 4; turn++) {
    const id = `t${turn}`;
    rec.recordFeature(id, "autoRecall", turn * 10);
    if (turn === 4) rec.recordFeature(id, "autoRecall", 31, true);
    rec.recordFeature(id, "promptEnrichment", 5);
    t = 1000 * turn;
    rec.markSpeechEnd(id);
    t += 100 * turn;
    rec.markFirstAudio(id);
    rec.markFirstAudio(id); // second mark is ignored
  }
  const r = rec.report();
  assert.equal(r.turns, 4);
  assert.deepEqual(r.features["autoRecall"], { count: 5, medianMs: 30, p95Ms: 40, maxMs: 40, budgetExceeded: 1 });
  assert.deepEqual(r.features["promptEnrichment"], { count: 4, medianMs: 5, p95Ms: 5, maxMs: 5, budgetExceeded: 0 });
  assert.deepEqual(r.speechEndToFirstAudio, { count: 4, medianMs: 250, p95Ms: 400, maxMs: 400 });
  assert.deepEqual(Object.keys(r.features), ["autoRecall", "promptEnrichment"]);
});

test("time() measures with the injected clock and records even when the function throws", async () => {
  let t = 100;
  const rec = new FeatureLatencyRecorder({ now: () => t });
  assert.equal(await rec.time("a", "reranker", async () => { t += 12; return "x"; }), "x");
  await assert.rejects(rec.time("a", "reranker", async () => { t += 3; throw new Error("e"); }));
  const f = rec.report().features["reranker"]!;
  assert.deepEqual([f.count, f.maxMs, f.medianMs], [2, 12, 7.5]);
});

test("first audio without a recorded speech end is ignored; the window drops the oldest turns", () => {
  let t = 0;
  const rec = new FeatureLatencyRecorder({ now: () => t, maxTurns: 3 });
  rec.markFirstAudio("none");
  assert.equal(rec.report().speechEndToFirstAudio.count, 0);
  for (let i = 0; i < 5; i++) { rec.recordFeature(`t${i}`, "autoRecall", i); }
  const r = rec.report();
  assert.equal(r.turns, 3);
  assert.equal(r.features["autoRecall"]!.count, 3);
  assert.equal(r.features["autoRecall"]!.maxMs, 4);
  rec.reset();
  assert.equal(rec.report().turns, 0);
});
