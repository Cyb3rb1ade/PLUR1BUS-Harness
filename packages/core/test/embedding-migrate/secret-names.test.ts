import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { CONFIG_SCHEMA } from "@plur1bus/config-schema";
import { createEngineSecrets } from "../../src/engine-host-ports.ts";
import { engineSecretScope } from "../../src/engine/secret-scope.ts";
import { createMigrationDriver, type MigrationDriver } from "../../src/embedding-migrate/driver.ts";
import { createPlannedTargets, type PlannedTargets } from "../../src/embedding-migrate/secret-names.ts";
import { createStateStore } from "../../src/embedding-migrate/state.ts";
import { createMemoryAuditSink } from "../../src/secrets/audit.ts";
import { createMemoryBackend } from "../../src/secrets/memory-backend.ts";
import { createSecretStore } from "../../src/secrets/store.ts";
import { createFakeEngine, fp, type FakeOptions } from "./fake-engine.ts";

// P4D-29, R-20-38: the planned target of a migration that is under way counts for the engine's secret names as an
// `engine.embedding` block that is there: the name its parameters gave, and the default names of the block.
const NAMED = "MY_TARGET_KEY";
/** The default names of the embedding block, read from the schema as the set reads them. */
const DEFAULTS: string[] = (CONFIG_SCHEMA as any).properties.engine["x-value-schema"].properties.embedding["x-secret-default"];
const target = fp("b", 12);
const remote = { apiKeyEnv: NAMED, baseUrl: "https://models.example/v1" };

interface Rig { driver: MigrationDriver; targets: PlannedTargets; fake: ReturnType<typeof createFakeEngine>; dir: string; advance(ms: number): void; during: { plan: string[][]; batch: string[][] }; done(): void }
function rig(o: FakeOptions = {}): Rig {
  const dir = mkdtempSync(path.join(tmpdir(), "p1-reembed-names-"));
  let clock = 1_000;
  const fake = createFakeEngine({ now: () => clock, withValidate: true, ...o });
  const store = createStateStore(dir);
  const targets = createPlannedTargets({ store, now: () => clock });
  const during = { plan: [] as string[][], batch: [] as string[][] };
  const seen = () => [...targets.names()].sort();
  // What the engine could resolve while it works on a call: read inside the call, as its `host.secret.get` would be.
  const engine = { ...fake.engine,
    plan: async (req: Parameters<typeof fake.engine.plan>[0]) => { during.plan.push(seen()); return fake.engine.plan(req); },
    apply: async (a: Parameters<typeof fake.engine.apply>[0]) => { during.batch.push(seen()); return fake.engine.apply(a); },
    resume: async (a: Parameters<typeof fake.engine.resume>[0]) => { during.batch.push(seen()); return fake.engine.resume(a); } };
  let n = 0;
  const driver = createMigrationDriver({ newId: () => `m${++n}`, engine, store, switchPort: fake.switchPort, now: () => clock, sleep: async () => {}, targets });
  return { driver, targets, fake, dir, during, advance: (ms) => { clock += ms; }, done: () => rmSync(dir, { recursive: true, force: true }) };
}
const all = [...DEFAULTS, NAMED].sort();
const names = (r: Rig) => [...r.targets.names()].sort();

test("the default names of the embedding block are in the schema", () => {
  assert.ok(DEFAULTS.length > 0 && DEFAULTS.every(n => typeof n === "string"));
});

test("without a migration the planned target names nothing", () => {
  const r = rig(); try { assert.deepEqual(names(r), []); } finally { r.done(); }
});

test("a remote target counts while the engine is asked for the plan, and from the plan on", async () => {
  const r = rig(); try {
    const out = await r.driver.plan({ target, remote });
    assert.ok(out.plan);
    assert.deepEqual(r.during.plan, [all], "the engine probes the target's provider before there is a plan");
    assert.deepEqual(names(r), all, "planned");
  } finally { r.done(); }
});

test("a local target names nothing, planned or running", async () => {
  const r = rig(); try {
    await r.driver.plan({ target });
    assert.deepEqual(r.during.plan, [[]]);
    assert.deepEqual(names(r), []);
    await r.driver.run();
    assert.ok(r.during.batch.length > 0 && r.during.batch.every(seen => seen.length === 0));
  } finally { r.done(); }
});

test("a remote target counts for every batch of the run and until the switch", async () => {
  const r = rig(); try {
    await r.driver.plan({ target, remote });
    const end = await r.driver.run();
    assert.equal(end.phase, "ready-to-switch");
    assert.ok(r.during.batch.length > 1 && r.during.batch.every(seen => seen.join() === all.join()), JSON.stringify(r.during.batch));
    assert.deepEqual(names(r), all, "ready to switch: the engine checks the sealed plan");
  } finally { r.done(); }
});

test("after the switch the target is the configuration's business: without a block there it names nothing", async () => {
  const r = rig(); try {
    await r.driver.plan({ target, remote });
    await r.driver.run();
    assert.equal((await r.driver.switch()).phase, "switched");
    assert.deepEqual(names(r), []);
  } finally { r.done(); }
});

test("after an abort the target names nothing, and a run that goes on names it again", async () => {
  const r = rig(); try {
    await r.driver.plan({ target, remote });
    assert.equal((await r.driver.abort()).phase, "aborted");
    assert.deepEqual(names(r), []);
    await r.driver.run();
    assert.ok(r.during.batch.every(seen => seen.join() === all.join()));
  } finally { r.done(); }
});

test("a run that failed for good names nothing", async () => {
  const r = rig({ failBatch: { n: 2, error: new Error("reembedding source version drift: memories") } }); try {
    await r.driver.plan({ target, remote });
    assert.equal((await r.driver.run()).phase, "failed");
    assert.deepEqual(names(r), []);
  } finally { r.done(); }
});

test("a plan that was never run stops counting when its confirmation expires", async () => {
  const r = rig(); try {
    await r.driver.plan({ target, remote });
    r.advance(60 * 60 * 1000 - 1);
    assert.deepEqual(names(r), all);
    r.advance(1);
    assert.deepEqual(names(r), []);
  } finally { r.done(); }
});

test("a plan the engine refuses leaves nothing behind", async () => {
  const r = rig({ diskFree: 0 }); try {
    await assert.rejects(r.driver.plan({ target, remote }));
    assert.deepEqual(r.during.plan, [all]);
    assert.deepEqual(names(r), []);
  } finally { r.done(); }
});

test("a checkpoint that cannot be read names nothing", async () => {
  const r = rig(); try {
    await r.driver.plan({ target, remote });
    mkdirSync(path.join(r.dir, "reembed"), { recursive: true });
    writeFileSync(path.join(r.dir, "reembed", "migration.json"), "{ not json");
    assert.deepEqual(names(r), []);
  } finally { r.done(); }
});

test("the engine's port: the planned target's names are resolved while the migration is under way, and only then", async () => {
  const r = rig(); try {
    const audit = createMemoryAuditSink();
    const store = createSecretStore({ keyring: createMemoryBackend(), file: createMemoryBackend(), fileFallback: () => false, audit });
    const owner = { kind: "owner" } as const;
    await store.set(owner, DEFAULTS[0]!, "default-value");
    await store.set(owner, NAMED, "named-value");
    await store.set(owner, "personal/bank-token", "bank-value");
    // A configuration without an embedding block: the installation runs the default local model.
    const secrets = createEngineSecrets(store, engineSecretScope(() => ({ engine: {} }), () => r.targets.names()));
    for (const name of [DEFAULTS[0]!, NAMED]) await assert.rejects(() => secrets.resolve(name, "memory-engine"), /could not be resolved/u, `no migration: ${name}`);
    await r.driver.plan({ target, remote });
    assert.equal(await secrets.resolve(DEFAULTS[0]!, "memory-engine"), "default-value");
    assert.equal(await secrets.resolve(NAMED, "memory-engine"), "named-value");
    await assert.rejects(() => secrets.resolve("personal/bank-token", "memory-engine"), /could not be resolved/u, "a migration opens its target's names and no other");
    await r.driver.run();
    assert.equal(await secrets.resolve(NAMED, "memory-engine"), "named-value");
    await r.driver.switch();
    for (const name of [DEFAULTS[0]!, NAMED]) await assert.rejects(() => secrets.resolve(name, "memory-engine"), /could not be resolved/u, `switched, no block: ${name}`);
    // The switch wrote the block: from here on the configuration names them.
    const switched = createEngineSecrets(store, engineSecretScope(() => ({ engine: { embedding: { apiKeyEnv: NAMED } } }), () => r.targets.names()));
    assert.equal(await switched.resolve(NAMED, "memory-engine"), "named-value");
  } finally { r.done(); }
});

test("a planned target that cannot be asked for refuses, as a configuration that cannot be read does", async () => {
  const store = createSecretStore({ keyring: createMemoryBackend(), file: createMemoryBackend(), fileFallback: () => false, audit: createMemoryAuditSink() });
  await store.set({ kind: "owner" }, "in-config", "v");
  const secrets = createEngineSecrets(store, engineSecretScope(() => ({ engine: { merging: { apiKeyRef: "in-config" } } }), () => { throw new Error("state unreadable"); }));
  assert.equal(await secrets.resolve("in-config", "memory-engine"), "v", "the configuration's own names do not depend on the migration");
  await assert.rejects(() => secrets.resolve("OPENAI_API_KEY", "memory-engine"), /could not be resolved/u);
});
