// M2 acceptance 6, quality half: after a migration to a different embedding identity the store answers every query with
// the same ranked ids as before, and every migrated row provably carries the NEW identity's vector.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createMigrationDriver } from "../../src/embedding-migrate/driver.ts";
import { createStateStore } from "../../src/embedding-migrate/state.ts";
import { createFakeEngine, embed, fp } from "./fake-engine.ts";

// Each query is the text of one stored fact; the fact itself must come back first.
const WANT = Array.from({ length: 12 }, (_, i) => ({ id: `${i % 2 ? "shared" : "memories"}-${(i * 5) % 12}`, t: i % 2 ? "shared" : "memories", n: (i * 5) % 12 }));
const QUERIES = WANT.map((w) => `fact ${w.t} ${w.n} about topic${w.n % 4} and item${w.n}`);

describe("migration quality (fake embedders, identity verified)", () => {
  it("recall is identical before and after, and every vector is the target identity's", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "p1-reembed-q-"));
    try {
      const fake = createFakeEngine({ rows: { memories: 30, shared: 12 }, sourceModel: "perm-1", sourceDims: 64, batchSize: 5 });
      const driver = createMigrationDriver({ engine: fake.engine, store: createStateStore(dir), switchPort: fake.switchPort, sleep: async () => {}, newId: () => "q1" });
      const before = QUERIES.map((q) => fake.recall(q, 5));
      const hitRate = (lists: string[][]) => lists.filter((l, i) => l[0] === WANT[i]!.id).length;
      assert.equal(hitRate(before), 12, "the baseline recall is meaningful, not vacuous");

      const target = fp("perm-2", 80); // different model, different dimensions
      const plan = await driver.plan({ target, throttleMs: 0 });
      assert.equal(plan.plan?.rows, 42); assert.equal(plan.plan?.batches, 6 + 3);
      assert.equal((await driver.run()).phase, "ready-to-switch");
      assert.deepEqual(QUERIES.map((q) => fake.recall(q, 5)), before, "still the old store until the switch");
      assert.equal((await driver.switch()).phase, "switched");

      const after = QUERIES.map((q) => fake.recall(q, 5));
      assert.deepEqual(after, before, "identical ranked ids for every query");
      assert.equal(hitRate(after), hitRate(before));

      // Identity verified, row by row.
      const g = fake.state.generations.get("generation-q1")!;
      const rows = [...g.tables.values()].flat();
      assert.equal(rows.length, 42);
      for (const r of rows) {
        const want = embed(target, r.text);
        assert.equal(r.vector.length, 80, `${r.id} has the target's dimensions`);
        r.vector.forEach((x, i) => assert.ok(Math.abs(x - want[i]!) < 1e-12, `${r.id}[${i}] is embed(target, text)`));
      }
      const rec = fake.state.records.get("q1")!;
      assert.notEqual(rec.target.fingerprintId, rec.source.fingerprintId);
      assert.deepEqual(g.fingerprint, target); assert.deepEqual(fake.state.activeFingerprint, target);
      // The old store is intact until the owner confirms.
      assert.equal(fake.state.generations.get("g0")!.tables.get("memories")!.length, 30);
      assert.equal(fake.state.generations.get("g0")!.tables.get("memories")![0]!.vector.length, 64);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});
