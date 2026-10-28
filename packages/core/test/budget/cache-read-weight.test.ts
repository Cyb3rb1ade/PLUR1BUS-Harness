// RE-D29 (RE-14/P5): the weight with which cache reads count against token limits, a budget setting beside the time
// zone. Provider adapters report `inputTokens` as the whole prompt, cache reads and writes included; a token limit
// counts input - cacheRead × (1 - w) + output. Weight 1, the default, is the behaviour from before the setting.
import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { open } from "./helpers.ts";

const SET_STORED = "INSERT OR REPLACE INTO settings (key, value) VALUES ('cache_read_weight', ?)";

describe("cache-read weight setting", () => {
  const closers: (() => void)[] = [];
  afterEach(() => { for (const c of closers.splice(0)) c(); });
  const mk = (...a: Parameters<typeof open>) => { const r = open(...a); closers.push(() => r.svc.close()); return r; };

  it("starts at full weight and keeps a set weight across a reopen", () => {
    const first = open();
    assert.equal(first.svc.cacheReadWeight(), 1);
    assert.equal(first.svc.setCacheReadWeight(0.1), 0.1);
    assert.equal(first.svc.cacheReadWeight(), 0.1);
    first.svc.close();
    const again = mk({ dir: first.dir, clock: first.clock });
    assert.equal(again.svc.cacheReadWeight(), 0.1);
    assert.equal(again.svc.setCacheReadWeight(0), 0);
    assert.equal(again.svc.cacheReadWeight(), 0);
    assert.equal(again.svc.setCacheReadWeight(1), 1);
    assert.equal(again.svc.cacheReadWeight(), 1);
  });

  it("refuses a weight below 0, above 1, not finite or not a number, and keeps the stored one", () => {
    const { svc } = mk();
    svc.setCacheReadWeight(0.5);
    const bad = [
      -0.01, 1.01, -1, 2, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, "0.5", null, undefined, {},
    ];
    for (const w of bad) {
      const refused = (e: unknown) => e instanceof RangeError && /cache read weight/.test(e.message);
      assert.throws(() => svc.setCacheReadWeight(w as never), refused, String(w));
    }
    assert.equal(svc.cacheReadWeight(), 0.5);
  });

  it("applies a weight in millionths: a finer value is rounded to the nearest millionth", () => {
    const { svc } = mk();
    assert.equal(svc.setCacheReadWeight(0.1234567), 0.123457);
    assert.equal(svc.cacheReadWeight(), 0.123457);
    assert.equal(svc.setCacheReadWeight(0.0000004), 0);
  });

  it("reads a stored weight it cannot parse as full weight, so every cache read counts", () => {
    const { svc, path } = mk();
    const db = new DatabaseSync(path);
    try {
      for (const value of ["", " ", "abc", "-0.5", "1.5", "NaN", "Infinity"]) {
        db.prepare(SET_STORED).run(value);
        assert.equal(svc.cacheReadWeight(), 1, JSON.stringify(value));
      }
    } finally { db.close(); }
  });
});
