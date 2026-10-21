import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  RESTORE_REAPPLY_MARKER_NAME, loadEngineReapply, reapplyTombstonesAfterRestore, restoreReapplyMarker,
  type EngineTombstoneReapply, type TombstoneReapplyReport,
} from "../src/restore-reapply.ts";
import { layout } from "../src/paths.ts";
import { tempDir } from "./helpers/temp-dir.ts";

type Line = { level: "info" | "warn"; msg: string; fields?: Record<string, unknown> };
const recorder = () => {
  const lines: Line[] = [];
  return {
    lines,
    logger: {
      info: (msg: string, fields?: Record<string, unknown>) => { lines.push({ level: "info", msg, ...(fields ? { fields } : {}) }); },
      warn: (msg: string, fields?: Record<string, unknown>) => { lines.push({ level: "warn", msg, ...(fields ? { fields } : {}) }); },
    },
  };
};

const empty = (): TombstoneReapplyReport => ({ applied: [], alreadyTombstoned: [], notFound: [], errors: [], registryErrors: [], activeAfterReapply: [] });
const failed = (r: TombstoneReapplyReport) => r.errors.length > 0 || r.registryErrors.length > 0 || r.activeAfterReapply.length > 0;

/** A home whose last backup restore left its marker (the shape crates/plur1bus/src/backup/restore.rs writes). */
function restoredHome(): { home: string; l: ReturnType<typeof layout>; marker: string } {
  const home = tempDir("p1b-restore-reapply-");
  const l = layout(home);
  mkdirSync(l.state, { recursive: true });
  const marker = restoreReapplyMarker(l);
  writeFileSync(marker, JSON.stringify({ schema: "plur1bus.restore-reapply-tombstones/1", restoredAtMs: Date.UTC(2026, 9, 20, 8, 30) }));
  return { home, l, marker };
}

describe("tombstone re-apply after a backup restore", () => {
  it("does nothing without the restore's marker: the engine is not even looked up", async () => {
    const home = tempDir("p1b-restore-reapply-"); const l = layout(home);
    const { lines, logger } = recorder();
    let loaded = 0;
    const out = await reapplyTombstonesAfterRestore({ layout: l, baseDbPath: l.lancedb, logger, load: async () => { loaded++; return null; } });
    assert.deepEqual(out, { status: "no-marker" });
    assert.equal(loaded, 0);
    assert.deepEqual(lines, []);
  });

  it("re-applies the committed tombstones to the store the engine will open, then removes the marker", async () => {
    const { l, marker } = restoredHome();
    const { lines, logger } = recorder();
    const calls: Array<{ baseDbPath: string; apply?: boolean }> = [];
    const engine: EngineTombstoneReapply = {
      reapplyCommittedTombstones: async (o) => { calls.push(o); return { ...empty(), applied: [{}, {}], alreadyTombstoned: [{}] }; },
      reapplyFailed: failed,
    };
    const out = await reapplyTombstonesAfterRestore({ layout: l, baseDbPath: l.lancedb, logger, load: async () => engine });
    assert.deepEqual(out, { status: "applied", applied: 2, alreadyTombstoned: 1, notFound: 0 });
    assert.deepEqual(calls, [{ baseDbPath: l.lancedb, apply: true }], "apply, not a dry run, against the configured store");
    assert.equal(existsSync(marker), false, "done: nothing owed any more");
    assert.deepEqual(lines.map((x) => x.level), ["info"]);
    assert.doesNotMatch(JSON.stringify(lines), /memoryId/, "counts only in the log");
  });

  it("keeps the marker and warns loudly while the engine has no re-apply (KNOWN GAP), and never throws", async () => {
    const { l, marker } = restoredHome();
    const { lines, logger } = recorder();
    const out = await reapplyTombstonesAfterRestore({ layout: l, baseDbPath: l.lancedb, logger, load: async () => null });
    assert.deepEqual(out, { status: "unsupported" });
    assert.equal(existsSync(marker), true, "the debt stays on record");
    assert.equal(lines.length, 1);
    assert.equal(lines[0]!.level, "warn");
    assert.match(lines[0]!.msg, /2026-10-20T08:30:00\.000Z/, "says when the restore happened");
    assert.match(lines[0]!.msg, /forgotten after that backup may be recallable again/);
    assert.match(lines[0]!.msg, /tombstone-reapply\.js/);
  });

  it("an engine that has it later settles the debt on a later start (the marker survived)", async () => {
    const { l, marker } = restoredHome();
    const { logger } = recorder();
    assert.equal((await reapplyTombstonesAfterRestore({ layout: l, baseDbPath: l.lancedb, logger, load: async () => null })).status, "unsupported");
    const engine: EngineTombstoneReapply = { reapplyCommittedTombstones: async () => empty(), reapplyFailed: failed };
    assert.equal((await reapplyTombstonesAfterRestore({ layout: l, baseDbPath: l.lancedb, logger, load: async () => engine })).status, "applied");
    assert.equal(existsSync(marker), false);
    assert.equal((await reapplyTombstonesAfterRestore({ layout: l, baseDbPath: l.lancedb, logger, load: async () => engine })).status, "no-marker");
  });

  it("a re-apply the engine reports as incomplete (unreadable registry, a row still active) keeps the marker and says how many problems", async () => {
    const { l, marker } = restoredHome();
    const { lines, logger } = recorder();
    const engine: EngineTombstoneReapply = {
      reapplyCommittedTombstones: async () => ({ ...empty(), errors: [{}], registryErrors: [{}], activeAfterReapply: [{}, {}] }),
      reapplyFailed: failed,
    };
    const out = await reapplyTombstonesAfterRestore({ layout: l, baseDbPath: l.lancedb, logger, load: async () => engine });
    assert.deepEqual(out, { status: "incomplete", problems: 4 });
    assert.equal(existsSync(marker), true);
    assert.equal(lines[0]!.level, "warn");
    assert.match(lines[0]!.msg, /incomplete \(4 problem\(s\)\)/);
    assert.deepEqual(lines[0]!.fields, { marker, errors: 1, registryErrors: 1, activeAfterReapply: 2 });
  });

  it("an engine function that throws, or a module that cannot be loaded, keeps the marker and does not stop the start", async () => {
    for (const load of [
      async (): Promise<EngineTombstoneReapply> => ({ reapplyCommittedTombstones: async () => { throw new Error("lance table is locked"); }, reapplyFailed: failed }),
      async (): Promise<EngineTombstoneReapply> => { throw new SyntaxError("broken engine module"); },
    ]) {
      const { l, marker } = restoredHome();
      const { lines, logger } = recorder();
      const out = await reapplyTombstonesAfterRestore({ layout: l, baseDbPath: l.lancedb, logger, load });
      assert.equal(out.status, "failed");
      assert.match((out as { error: string }).error, /locked|broken/);
      assert.equal(existsSync(marker), true);
      assert.equal(lines[0]!.level, "warn");
      assert.match(lines[0]!.msg, /re-applying them failed/);
    }
  });

  it("an unreadable marker body still counts: existence is what is owed", async () => {
    const { l, marker } = restoredHome();
    writeFileSync(marker, "not json");
    const { lines, logger } = recorder();
    const engine: EngineTombstoneReapply = { reapplyCommittedTombstones: async () => empty(), reapplyFailed: failed };
    assert.equal((await reapplyTombstonesAfterRestore({ layout: l, baseDbPath: l.lancedb, logger, load: async () => engine })).status, "applied");
    assert.equal(existsSync(marker), false);
    assert.deepEqual(lines.map((x) => x.level), ["info"]);
  });

  it("names the same marker file as the Rust restore (crates/plur1bus/src/backup/restore.rs)", () => {
    const rust = readFileSync(new URL("../../../crates/plur1bus/src/backup/restore.rs", import.meta.url), "utf8");
    const m = /pub const REAPPLY_MARKER: &str = "([^"]+)";/.exec(rust);
    assert.ok(m, "REAPPLY_MARKER not found in restore.rs");
    assert.equal(m[1], `state/${RESTORE_REAPPLY_MARKER_NAME}`);
    const l = layout(tempDir("p1b-restore-reapply-"));
    assert.equal(restoreReapplyMarker(l), join(l.state, RESTORE_REAPPLY_MARKER_NAME));
  });

  // KNOWN GAP tripwire. The pinned engine (98dfe2f0, contract 1.16.0) has no `lib/tombstone-reapply.js`; it arrives with engine PR #259
  // and has no `engine.capabilities` flag, so it is feature-detected by importing it. This test is green while the gap is open and
  // turns red the moment a pin bump brings the module: then drop this test and the KNOWN GAP paragraph in docs/ops/backup-restore.md,
  // and flip tests/system/backup.test.ts: its restore step asserts that the memory forgotten after the backup is back (the gap), and must
  // then assert the opposite (forget after the backup, restore, start: the memory is gone from list and recall).
  it("KNOWN GAP: the pinned engine does not ship lib/tombstone-reapply.js yet", async () => {
    assert.equal(
      await loadEngineReapply(), null,
      "the engine now ships lib/tombstone-reapply.js: remove this tripwire and the KNOWN GAP in docs/ops/backup-restore.md, and add the end-to-end restore test",
    );
  });
});
