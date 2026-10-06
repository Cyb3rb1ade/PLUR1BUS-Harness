import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createStateStore, MigrationStateError, type Checkpoint } from "../../src/embedding-migrate/state.ts";

const tmp = () => mkdtempSync(path.join(tmpdir(), "p1-reembed-"));
const cp = (over: Partial<Checkpoint> = {}): Checkpoint => ({
  v: 1, id: "m1", token: "tok", planDigest: "sha256:abc", createdAt: 1, updatedAt: 1, phase: "planned", sourceGeneration: "g0", targetGeneration: "generation-m1",
  target: { provider: "fake", model: "b", dimensions: 8 }, counts: { rows: 10, tables: 2, rowsDone: 0, batchesDone: 0 }, throttleMs: 0, abortRequested: false, error: null, ...over,
});

describe("migration checkpoint store", () => {
  it("round-trips and replaces atomically with 0600", () => {
    const dir = tmp();
    try {
      const s = createStateStore(dir);
      assert.equal(s.read(), null);
      s.write(cp());
      s.write(cp({ phase: "running", counts: { rows: 10, tables: 2, rowsDone: 8, batchesDone: 1 } }));
      assert.equal(s.read()?.phase, "running");
      assert.equal(s.read()?.counts.rowsDone, 8);
      if (process.platform !== "win32") assert.equal(statSync(s.path).mode & 0o777, 0o600);
      assert.deepEqual(readdirSync(path.dirname(s.path)), ["migration.json"]);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it("an injected crash between the temp write and the rename leaves the previous checkpoint whole", () => {
    const dir = tmp();
    try {
      createStateStore(dir).write(cp());
      const crashing = createStateStore(dir, { rename: () => { throw new Error("boom"); } });
      assert.throws(() => crashing.write(cp({ phase: "running" })), /boom/);
      const after = createStateStore(dir);
      assert.equal(after.read()?.phase, "planned");
      assert.deepEqual(readdirSync(path.dirname(after.path)), ["migration.json"], "temp file cleaned up");
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it("refuses a corrupt, oversized, unknown-phase or wrong-version file instead of resetting it", () => {
    const dir = tmp();
    try {
      const s = createStateStore(dir);
      s.write(cp());
      for (const [label, body] of [
        ["not json", "{"], ["unknown phase", JSON.stringify(cp({ phase: "bogus" as never }))], ["wrong version", JSON.stringify({ ...cp(), v: 2 })],
        ["oversized", JSON.stringify({ ...cp(), pad: "x".repeat(2 * 1024 * 1024) })], ["bad id", JSON.stringify(cp({ id: "../x" }))],
        ["negative counts", JSON.stringify(cp({ counts: { rows: -1, tables: 0, rowsDone: 0, batchesDone: 0 } }))],
      ] as const) {
        writeFileSync(s.path, body);
        assert.throws(() => s.read(), (e: unknown) => e instanceof MigrationStateError && e.code === "state-corrupt", label);
        assert.ok(existsSync(s.path), `${label}: file kept for inspection`);
      }
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it("never serialises anything but the checkpoint's own fields", () => {
    const dir = tmp();
    try {
      const s = createStateStore(dir);
      s.write({ ...cp(), secretish: "leak" } as never);
      assert.ok(!readFileSync(s.path, "utf8").includes("leak"));
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});
