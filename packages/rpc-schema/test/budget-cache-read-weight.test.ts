import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { validateParams, validateResult } from "../src/index.ts";

const fixture = (name: string) => JSON.parse(readFileSync(new URL(`../fixtures/methods/${name}.json`, import.meta.url), "utf8"));

describe("R-2b cache-read weight RPC", () => {
  it("accepts weight-only updates, including zero and one, and refuses invalid values", () => {
    for (const weight of [0, 0.1, 0.1234567, 1]) {
      assert.equal(validateParams("budget.set", { cacheReadWeight: weight }).ok, true, String(weight));
    }
    for (const weight of [-0.1, 1.1, "0.1", null, true, Infinity, NaN]) {
      assert.equal(validateParams("budget.set", { cacheReadWeight: weight }).ok, false, String(weight));
    }
    assert.equal(validateParams("budget.set", {}).ok, false);
    assert.equal(validateParams("budget.set", { cacheReadWeight: 0.1, extra: true }).ok, false);
  });

  it("validates active weight and separate totals without requiring new fields from older producers", () => {
    const status = fixture("budget.status").result;
    const set = fixture("budget.set").result;
    // These fixtures deliberately also test the pre-extension response shape.
    delete status.cacheReadWeight;
    delete set.cacheReadWeight;
    for (const period of status.periods) {
      for (const total of [period.total, ...period.agents.flatMap((a: any) => [a.total, ...a.models])]) {
        delete total.freshInputTokens;
        delete total.countedTokens;
      }
    }
    assert.equal(validateResult("budget.status", status).ok, true);
    assert.equal(validateResult("budget.set", set).ok, true);
    status.cacheReadWeight = 0;
    set.cacheReadWeight = 0;
    for (const period of status.periods) {
      for (const total of [period.total, ...period.agents.flatMap((a: any) => [a.total, ...a.models])]) {
        total.freshInputTokens = 1200;
        total.countedTokens = 1600;
      }
    }
    assert.equal(validateResult("budget.status", status).ok, true);
    assert.equal(validateResult("budget.set", set).ok, true);
    status.periods[0].total.freshInputTokens = -1;
    assert.equal(validateResult("budget.status", status).ok, false);
    status.periods[0].total.freshInputTokens = 1200;
    status.periods[0].agents[0].models[0].countedTokens = 0.5;
    assert.equal(validateResult("budget.status", status).ok, false);
    set.cacheReadWeight = 2;
    assert.equal(validateResult("budget.set", set).ok, false);
  });
});
