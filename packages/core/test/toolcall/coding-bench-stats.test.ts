/** B1 paired inference: exact probabilities, stable large samples, explicit missing evidence. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { exactPairedSignP, comparePairedOutcomes } from "../../src/toolcall/coding-bench-stats.ts";

test("exact paired sign probabilities include the no-discordance and balanced cases", () => {
  for (const [improved, regressed, expected] of [
    [0, 0, 1],
    [1, 0, 1],
    [2, 0, 0.5],
    [6, 0, 0.03125],
    [4, 1, 0.375],
    [4, 4, 1],
  ]) {
    assert.ok(Math.abs(exactPairedSignP(improved!, regressed!) - expected!) < 1e-12);
    assert.ok(Math.abs(exactPairedSignP(regressed!, improved!) - expected!) < 1e-12);
  }
});

test("large discordant samples remain finite without overflowing binomial coefficients", () => {
  const balanced = exactPairedSignP(5000, 5000);
  assert.ok(Number.isFinite(balanced) && Math.abs(balanced - 1) < 1e-9);
  const oneSided = exactPairedSignP(1000, 0);
  assert.ok(oneSided > 0 && oneSided < 1e-290);
});

test("invalid or unbounded sign-test counts are refused", () => {
  for (const pair of [
    [-1, 0],
    [0.5, 1],
    [NaN, 1],
    [Infinity, 0],
    [1_000_000, 1],
  ]) {
    assert.throws(() => exactPairedSignP(pair[0]!, pair[1]!), RangeError);
  }
});

test("paired counts show both concordances, both discordances, and unmatched rows", () => {
  const baseline = [
    { key: "a", resolved: true },
    { key: "b", resolved: false },
    { key: "c", resolved: true },
    { key: "d", resolved: false },
    { key: "e", resolved: true },
    { key: "z", resolved: false },
  ];
  const candidate = [
    { key: "a", resolved: true },
    { key: "b", resolved: false },
    { key: "c", resolved: false },
    { key: "d", resolved: true },
    { key: "f", resolved: true },
  ];
  assert.deepEqual(comparePairedOutcomes(baseline, candidate), {
    bothResolved: 1,
    bothUnresolved: 1,
    improved: 1,
    regressed: 1,
    unmatchedBaseline: 2,
    unmatchedCandidate: 1,
    paired: 4,
    deltaResolved: 0,
    signP: 1,
  });
});

test("row order cannot change pairing and duplicate keys never silently overwrite evidence", () => {
  const baseline = [
    { key: "a", resolved: false },
    { key: "b", resolved: true },
  ];
  const candidate = [
    { key: "a", resolved: true },
    { key: "b", resolved: true },
  ];
  assert.deepEqual(
    comparePairedOutcomes(baseline, candidate),
    comparePairedOutcomes([...baseline].reverse(), [...candidate].reverse()),
  );
  assert.throws(() => comparePairedOutcomes([...baseline, baseline[0]!], candidate), /duplicate pair key/);
  assert.throws(() => comparePairedOutcomes(baseline, [...candidate, candidate[0]!]), /duplicate pair key/);
});
