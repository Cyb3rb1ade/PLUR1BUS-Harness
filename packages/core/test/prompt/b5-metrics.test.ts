import assert from "node:assert/strict";
import test from "node:test";
import { evaluateB5 } from "../../../../tests/nightly/b5-metrics.ts";
test("B5 live evaluator uses reported counts, checks every turn from 3, and refuses missing/invalid usage", () => {
  const rows = Array.from({ length: 6 }, (_, i) => ({ turn: i + 1, inputTokens: 1000, cachedInputTokens: i === 0 ? 0 : 950 }));
  assert.equal(evaluateB5(rows).pass, true);
  assert.equal(evaluateB5(rows).cacheReadShare, 0.95);
  assert.equal(evaluateB5(rows.map(r => r.turn === 3 ? { ...r, cachedInputTokens: 899 } : r)).pass, false);
  for (const invalid of [rows.slice(0, 5), rows.map(r => ({ ...r, cachedInputTokens: NaN })), rows.map(r => ({ ...r, inputTokens: 0 })), rows.map(r => ({ ...r, cachedInputTokens: 1001 }))]) assert.throws(() => evaluateB5(invalid), /invalid B5/);
});
