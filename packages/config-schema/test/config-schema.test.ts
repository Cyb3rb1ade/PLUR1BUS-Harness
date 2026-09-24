import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { CONFIG_SCHEMA, SCHEMA_VERSION, defaults, migrate, restartClassOf, restartPlan, validate } from "../src/index.ts";

function walk(node: any, path: string[], out: string[][]) {
  if (!node || typeof node !== "object" || !node.properties) return;
  for (const [k, v] of Object.entries<any>(node.properties)) {
    if (v.type === "object" && v.properties) walk(v, [...path, k], out);
    else out.push([...path, k]);
  }
}

describe("config-schema", () => {
  it("every leaf key carries x-restart", () => {
    const leaves: string[][] = [];
    walk(CONFIG_SCHEMA, [], leaves);
    assert.ok(leaves.length >= 8);
    for (const leaf of leaves) {
      const cls = restartClassOf(leaf.join("."));
      assert.match(cls, /^(live|core|module:[a-z0-9-]+)$/, `${leaf.join(".")} has ${cls}`);
    }
  });

  it("defaults validate and carry schemaVersion", () => {
    const d = defaults();
    assert.equal(d.schemaVersion, SCHEMA_VERSION);
    assert.deepEqual(validate(d), { ok: true, config: d });
  });

  it("rejects an unknown key, a wrong type and a missing schemaVersion", () => {
    assert.equal(validate({ ...defaults(), bogus: 1 }).ok, false);
    assert.equal(validate({ ...defaults(), core: { ...defaults().core, logLevel: 3 } }).ok, false);
    const { schemaVersion, ...rest } = defaults();
    assert.equal(validate(rest).ok, false);
  });

  it("restart plan names only what changed, with its class", () => {
    const a = defaults();
    const b = structuredClone(a);
    b.core.logLevel = "debug";
    b.engine.baseDbPathOverride = "/tmp/x";
    const plan = restartPlan(a, b);
    assert.deepEqual(plan.changed.sort(), ["core.logLevel", "engine.baseDbPathOverride"]);
    assert.deepEqual(plan.restart, { live: ["core.logLevel"], core: true, modules: [] });
  });

  it("agents is live: adding an agent restarts nothing", () => {
    const a = defaults();
    const b = structuredClone(a);
    b.agents.bernd = { createdAt: "2026-09-24T00:00:00Z" };
    assert.deepEqual(restartPlan(a, b).restart, { live: ["agents.bernd"], core: false, modules: [] });
  });

  it("migrate is identity at version 1", () => {
    const r = migrate(defaults());
    assert.deepEqual(r, { config: defaults(), from: 1, to: 1, applied: false });
  });

  it("reserved namespaces exist and are live", () => {
    for (const ns of ["providers", "oauth", "decision"]) {
      assert.equal(restartClassOf(ns), "live", ns);
      assert.deepEqual((defaults() as any)[ns], {});
    }
  });
});
