import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { CONFIG_SCHEMA, defaults, validate, type HarnessConfig } from "@plur1bus/config-schema";
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

describe("native-only Neo keys stay out of the Node engine config (RE-D169)", () => {
  const l = layout("/h/.plur1bus");
  const NATIVE = ["maxRecords", "appendDedupeTailRecords", "retention"];
  const loaded = (neo: Record<string, unknown>) => {
    const r = validate({ $schema: CONFIG_SCHEMA.$id, schemaVersion: 1, engine: { neo } });
    assert.equal(r.ok, true);
    return (r as { ok: true; config: HarnessConfig }).config;
  };
  it("the loader fills the native defaults, buildEngineConfig drops them for the installed schema", () => {
    const cfg = loaded({ enabled: false, retention: {} }); // the retention object has no default of its own, its members do
    for (const k of NATIVE) assert.equal(Object.hasOwn(cfg.engine.neo as object, k), true, `loader default ${k}`);
    assert.equal((cfg.engine.neo as any).maxRecords, 40000);
    const neo = (buildEngineConfig(cfg, l) as any).neo;
    assert.equal(neo.enabled, false);
    for (const k of NATIVE) assert.equal(Object.hasOwn(neo, k), false, k);
  });
  it("explicit native values are dropped as well, and the input config is not mutated", () => {
    const cfg = loaded({ enabled: false, retention: { days: 30 }, maxRecords: 600 });
    const neo = (buildEngineConfig(cfg, l) as any).neo;
    for (const k of NATIVE) assert.equal(Object.hasOwn(neo, k), false, k);
    assert.equal((cfg.engine.neo as any).maxRecords, 600);
    assert.equal((cfg.engine.neo as any).retention.days, 30);
  });
  it("a schema that declares the keys keeps them", () => {
    const cfg = loaded({ enabled: false, maxRecords: 600, retention: { days: 30 } });
    const schema = { properties: { neo: { properties: { enabled: {}, maxRecords: {}, appendDedupeTailRecords: {}, retention: {} } } } };
    const neo = (buildEngineConfig(cfg, l, schema) as any).neo;
    assert.equal(neo.maxRecords, 600);
    for (const k of NATIVE) assert.equal(Object.hasOwn(neo, k), true, k);
  });
  it("an unknown key stays so the engine still rejects a typo", () => {
    const cfg = loaded({ enabled: false });
    (cfg.engine.neo as any).bogus = 1;
    assert.equal((buildEngineConfig(cfg, l) as any).neo.bogus, 1);
  });
  it("without engine.neo no neo key appears", () => {
    assert.equal(Object.hasOwn(buildEngineConfig(defaults(), l), "neo"), false);
  });
});
