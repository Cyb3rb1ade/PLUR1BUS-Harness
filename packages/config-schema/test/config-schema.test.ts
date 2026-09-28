import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { CONFIG_SCHEMA, SCHEMA_VERSION, defaults, migrate, restartClassOf, restartPlan, tierOf, validate } from "../src/index.ts";

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

  it("modules.<name> resolves module:$key to module:<name> (B13)", () => {
    assert.equal(restartClassOf("modules"), "live");
    assert.equal(restartClassOf("modules.x.enabled"), "module:x");
    assert.equal(restartClassOf("modules.fixture.greeting"), "module:fixture");
    assert.equal(restartClassOf("modules.fixture-b"), "module:fixture-b");
    assert.deepEqual((defaults() as any).modules, {});
    const base = defaults();
    const withFixture = structuredClone(base) as any; withFixture.modules.fixture = { greeting: "hello" };
    assert.equal(validate(withFixture).ok, true);
    assert.equal((validate(withFixture) as any).config.modules.fixture.enabled, true, "enabled defaults to true");
    assert.equal(validate({ ...structuredClone(base), modules: { fixture: { enabled: "yes" } } }).ok, false);
    const changed = structuredClone(withFixture); changed.modules.fixture.greeting = "hi";
    assert.deepEqual(restartPlan(withFixture, changed).restart, { live: [], core: false, modules: ["fixture"] });
    const added = structuredClone(withFixture); added.modules["fixture-b"] = { enabled: true };
    assert.deepEqual(restartPlan(withFixture, added).restart, { live: [], core: false, modules: ["fixture-b"] });
  });

  it("removing agents.bernd reports symmetric changed list", () => {
    const a = defaults();
    const b = structuredClone(a);
    b.agents.bernd = { createdAt: "2026-09-24T00:00:00Z" };
    const c = structuredClone(b);
    delete c.agents.bernd;
    const plan = restartPlan(b, c);
    assert.deepEqual(plan.changed, ["agents.bernd"]);
    assert.deepEqual(plan.restart, { live: ["agents.bernd"], core: false, modules: [] });
  });

  it("renaming agent (bernd removed, karl added) reports both at container level", () => {
    const a = defaults();
    const b = structuredClone(a);
    b.agents.bernd = { createdAt: "2026-09-24T00:00:00Z" };
    const c = structuredClone(b);
    delete c.agents.bernd;
    c.agents.karl = { createdAt: "2026-09-25T00:00:00Z" };
    const plan = restartPlan(b, c);
    assert.deepEqual(plan.changed.sort(), ["agents.bernd", "agents.karl"]);
    assert.deepEqual(plan.restart, { live: ["agents.bernd", "agents.karl"], core: false, modules: [] });
  });

  it("nested leaf change reports exactly that path", () => {
    const a = defaults();
    const b = structuredClone(a);
    b.core.recall.softBudgetMs = 500;
    const plan = restartPlan(a, b);
    assert.deepEqual(plan.changed, ["core.recall.softBudgetMs"]);
    assert.deepEqual(plan.restart, { live: [], core: true, modules: [] });
  });

  it("adding entry to empty open map reports at entry level", () => {
    const a = defaults();
    const b = structuredClone(a);
    (b.providers as any).nvidia = {};
    const plan = restartPlan(a, b);
    assert.deepEqual(plan.changed, ["providers.nvidia"]);
    assert.deepEqual(plan.restart, { live: ["providers.nvidia"], core: false, modules: [] });
  });

  it("extensions.* and agents.<id>.skills are live, advanced, with the X1-R21 defaults", () => {
    assert.equal(restartClassOf("extensions.trashDays"), "live");
    assert.equal(restartClassOf("extensions.limits.skillBytes"), "live");
    assert.equal(restartClassOf("agents.bernd.skills.blocked"), "live");
    assert.equal(tierOf("agents.bernd.skills.blocked"), "advanced");
    assert.equal(tierOf("extensions.allowUnsigned"), "advanced");
    const d: any = defaults();
    assert.deepEqual(d.extensions, { allowUnsigned: true, trashDays: 14, limits: { packageBytes: 268435456, skillBytes: 16777216 } });
    assert.equal(validate(d).ok, true);
  });

  it("extensions.* and agents.<id>.skills refuse out-of-range or unknown values", () => {
    const mk = (f: (c: any) => void) => { const c: any = defaults(); f(c); return validate(c).ok; };
    assert.equal(mk((c) => { c.agents.bernd = { skills: { blocked: ["a"], pinned: [], applyAt: "next-turn" } }; }), true);
    assert.equal(mk((c) => { c.agents.bernd = { skills: { applyAt: "never" } }; }), false);
    assert.equal(mk((c) => { c.agents.bernd = { skills: { bogus: 1 } }; }), false);
    assert.equal(mk((c) => { c.extensions.trashDays = 0; }), false);
    assert.equal(mk((c) => { c.extensions.trashDays = 366; }), false);
    assert.equal(mk((c) => { c.extensions.limits.packageBytes = 1048575; }), false);
    assert.equal(mk((c) => { c.extensions.limits.skillBytes = 1073741825; }), false);
    assert.equal(mk((c) => { c.extensions.bogus = 1; }), false);
  });
});
