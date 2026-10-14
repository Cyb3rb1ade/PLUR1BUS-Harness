import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { defaults } from "@plur1bus/config-schema";
import { buildEngineConfig } from "../src/engine-config.ts";
import { layout } from "../src/paths.ts";

describe("engine-config hardening (c10)", () => {
  const l = layout("/h/.plur1bus");
  it("an empty baseDbPathOverride does not relocate the database to the working directory", () => {
    for (const v of ["", "   "]) {
      const cfg = defaults(); cfg.engine.baseDbPathOverride = v;
      assert.equal((buildEngineConfig(cfg, l) as any).baseDbPath, "/h/.plur1bus/state/lancedb");
    }
  });
  it("non-object embedding/reranker/recall sections are replaced, not spread into index keys", () => {
    const cfg = defaults(); cfg.engine.embedding = "abc"; cfg.engine.reranker = ["x"]; cfg.engine.recall = { decisionTrace: "no" };
    const e = buildEngineConfig(cfg, l) as any;
    assert.deepEqual(Object.keys(e.embedding).sort(), ["local", "provider"]);
    assert.deepEqual(Object.keys(e.reranker).sort(), ["enabled", "local", "provider"]);
    assert.deepEqual(e.recall.decisionTrace, { enabled: true });
  });
  it("a __proto__ own key in engine.* is not copied into the engine config", () => {
    const cfg = defaults(); cfg.engine = JSON.parse('{"__proto__":{"polluted":1},"embedding":{"__proto__":{"x":1}},"recallMinScore":0.3}');
    const e = buildEngineConfig(cfg, l) as any;
    assert.equal(Object.hasOwn(e, "__proto__"), false);
    assert.equal(Object.hasOwn(e.embedding, "__proto__"), false);
    assert.equal(e.recallMinScore, 0.3);
    assert.equal(Object.assign({}, e).polluted, undefined);
  });
});
