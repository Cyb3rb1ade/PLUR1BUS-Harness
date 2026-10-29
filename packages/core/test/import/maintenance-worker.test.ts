/** Maintenance failure and GUI abort must restore a full baseline before the supervisor can restart Core. */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { acquireExclusiveLock } from "@plur1bus/module-api";
import { openMaintenanceJournal } from "../../src/import/maintenance-journal.ts";
import { createColdSnapshot } from "../../src/import/maintenance-snapshot.ts";
import { useTempDirs } from "./helpers.ts";

const temp = useTempDirs();
const RUN = "27c72c58-7afc-4c22-9832-a2680d6f6ae3";
const MARKER = "fixture-failed-engine-secret-must-not-leak";

async function factory() {
  const module = await import("../../src/import/maintenance-worker.ts").catch(() => undefined);
  assert.equal(typeof module?.runImportMaintenance, "function", "a supervised importer needs a recoverable worker");
  return module!;
}

function fixture() {
  const home = temp();
  mkdirSync(join(home, "state"));
  writeFileSync(join(home, "state", "cards"), "before cards");
  writeFileSync(join(home, "config.json"), '{"before":true}\n');
  const roots = [{ id: "state", path: join(home, "state"), kind: "directory" as const, preserve: ["core.lock"] }];
  return { home, roots, runId: RUN, restoreConfig: async () => {
    const path = join(home, "imports", RUN, "cold-snapshot", "config.json");
    writeFileSync(join(home, "config.json"), readFileSync(path));
  } };
}

describe("supervised import maintenance worker", () => {
  it("holds both writer locks and durably records applying before a mutation, then commits a target fingerprint", async () => {
    const api = await factory();
    const options = fixture();
    const progress: string[] = [];
    const result = await api.runImportMaintenance({ ...options, mode: "apply", onProgress: event => {
      progress.push(event.phase);
      assert.ok(!JSON.stringify(event).includes(MARKER));
    }, apply: async () => {
      assert.equal(openMaintenanceJournal(options.home, RUN).read().phase, "applying");
      assert.equal(acquireExclusiveLock(join(options.home, "state", "core.lock"), { instanceId: "other" }), null);
      assert.equal(existsSync(join(options.home, "imports", ".lock")), true);
      writeFileSync(join(options.home, "state", "cards"), "after cards");
    } });
    assert.deepEqual(result, { ok: true, status: "completed", restored: false, resumable: false });
    const journal = openMaintenanceJournal(options.home, RUN).read();
    assert.equal(journal.phase, "committed");
    assert.match(journal.targetSha256!, /^[a-f0-9]{64}$/);
    assert.ok(progress.includes("snapshot") && progress.includes("complete"));
    assert.equal(existsSync(join(options.home, "imports", ".lock")), false);
  });

  it("closes Engine resources before automatically restoring failed mutations and resetting resume receipts", async () => {
    const api = await factory();
    const options = fixture();
    let closed = false;
    const result = await api.runImportMaintenance({ ...options, mode: "apply", closeResources: async () => {
      closed = true;
    }, restoreConfig: async () => {
      assert.equal(closed, true);
      await options.restoreConfig();
    }, apply: async () => {
      writeFileSync(join(options.home, "state", "cards"), "partial imported cards");
      writeFileSync(join(options.home, "state", "new-card"), "partial new card");
      writeFileSync(join(options.home, "config.json"), '{"after":true}');
      writeFileSync(join(options.home, "imports", RUN, "ledger.jsonl"), '{"applied":true}\n');
      writeFileSync(join(options.home, "imports", RUN, "extensions.json"), '{"installed":true}\n');
      throw new Error(MARKER);
    } });
    assert.equal(result.ok, false);
    assert.equal(result.restored, true);
    assert.equal(result.resumable, true);
    assert.ok(!JSON.stringify(result).includes(MARKER));
    assert.equal(readFileSync(join(options.home, "state", "cards"), "utf8"), "before cards");
    assert.equal(existsSync(join(options.home, "state", "new-card")), false);
    assert.equal(readFileSync(join(options.home, "config.json"), "utf8"), '{"before":true}\n');
    assert.equal(existsSync(join(options.home, "imports", RUN, "ledger.jsonl")), false);
    assert.equal(existsSync(join(options.home, "imports", RUN, "extensions.json")), false);
    assert.equal(openMaintenanceJournal(options.home, RUN).read().phase, "restored");
  });

  it("automatically restores a GUI abort, then resumes the same original baseline with a new attempt", async () => {
    const api = await factory();
    const options = fixture();
    const controller = new AbortController();
    const result = await api.runImportMaintenance({ ...options, mode: "apply", signal: controller.signal,
      apply: async () => {
        writeFileSync(join(options.home, "state", "cards"), "entity one");
        controller.abort(new Error(MARKER));
      } });
    assert.equal(result.status, "aborted");
    assert.equal(result.restored, true);
    const originalHash = openMaintenanceJournal(options.home, RUN).read().snapshotSha256;
    const resumed = await api.runImportMaintenance({ ...options, mode: "apply", apply: async () => {
      assert.equal(readFileSync(join(options.home, "state", "cards"), "utf8"), "before cards");
      writeFileSync(join(options.home, "state", "cards"), "complete retry");
    } });
    assert.equal(resumed.ok, true);
    const journal = openMaintenanceJournal(options.home, RUN).read();
    assert.equal(journal.attempt, 2);
    assert.equal(journal.snapshotSha256, originalHash);
  });

  it("recovers an interrupted applying journal without running the importer again", async () => {
    const api = await factory();
    const options = fixture();
    const journal = openMaintenanceJournal(options.home, RUN);
    journal.advance("snapshotting");
    const baseline = await createColdSnapshot({ ...options, config: readFileSync(join(options.home, "config.json")) });
    journal.advance("snapshot-complete", { snapshotSha256: baseline.sha256 });
    journal.advance("applying");
    writeFileSync(join(options.home, "state", "cards"), "killed mid apply");
    const result = await api.runImportMaintenance({ ...options, mode: "recover", apply: async () => {
      assert.fail("recovery must not re-run the importer");
    } });
    assert.equal(result.restored, true);
    assert.equal(readFileSync(join(options.home, "state", "cards"), "utf8"), "before cards");
  });

  it("refuses manual rollback of user changes and keeps a failed restoration recoverable", async () => {
    const api = await factory();
    const options = fixture();
    await api.runImportMaintenance({ ...options, mode: "apply", apply: async () => {
      writeFileSync(join(options.home, "state", "cards"), "committed import");
    } });
    writeFileSync(join(options.home, "state", "cards"), "later user memory");
    const conflict = await api.runImportMaintenance({ ...options, mode: "rollback", apply: async () => {} });
    assert.equal(conflict.error?.reason, "target-changed");
    assert.equal(readFileSync(join(options.home, "state", "cards"), "utf8"), "later user memory");
    const failing = fixture();
    const result = await api.runImportMaintenance({ ...failing, mode: "apply", restoreConfig: async () => {
      throw new Error(MARKER);
    }, apply: async () => { throw new Error(MARKER); } });
    assert.equal(result.restored, false);
    assert.equal(result.error?.reason, "restore-failed");
    assert.equal(openMaintenanceJournal(failing.home, RUN).read().phase, "rolling-back");
    const recovered = await api.runImportMaintenance({ ...failing, mode: "recover", apply: async () => {} });
    assert.equal(recovered.restored, true);
  });

  it("undoes a late abort or failed Core restart within the same gated job after the worker committed", async () => {
    const api = await factory();
    for (const change of ["committed before late abort", "Core startup touched target before failing health"]) {
      const options = fixture();
      const applied = await api.runImportMaintenance({ ...options, mode: "apply", apply: async () => {
        writeFileSync(join(options.home, "state", "cards"), "committed import");
      } });
      assert.equal(applied.ok, true);
      const committed = openMaintenanceJournal(options.home, RUN).read();
      writeFileSync(join(options.home, "state", "cards"), change);
      const undone = await api.runImportMaintenance({ ...options, mode: "rollback", automaticRollback: true,
        expectedTargetSha256: committed.targetSha256!, apply: async () => { assert.fail("undo cannot import"); } });
      assert.equal(undone.ok, true);
      assert.equal(undone.restored, true);
      assert.equal(undone.resumable, true);
      assert.equal(readFileSync(join(options.home, "state", "cards"), "utf8"), "before cards");
      const restored = openMaintenanceJournal(options.home, RUN).read();
      assert.equal(restored.phase, "restored");
      assert.equal(restored.history.at(-1)?.reason, "automatic-rollback");
      assert.equal(restored.snapshotSha256, committed.snapshotSha256);
    }
  });

  it("rechecks the consumed preflight target proof before cold backup or importer mutation", async () => {
    const api = await factory();
    assert.equal(typeof api.fingerprintImportTarget, "function");
    const options = fixture();
    const targetSha256 = await api.fingerprintImportTarget(options.home, options.roots);
    writeFileSync(join(options.home, "state", "cards"), "changed after preflight");
    const result = await api.runImportMaintenance({ ...options, mode: "apply", expectedTargetSha256: targetSha256,
      apply: async () => { assert.fail("stale preflight must never reach apply"); } });
    assert.equal(result.error?.reason, "target-changed");
    assert.equal(existsSync(join(options.home, "imports", RUN, "cold-snapshot")), false);
    assert.equal(readFileSync(join(options.home, "state", "cards"), "utf8"), "changed after preflight");
  });

  it("refuses resume after later user changes instead of restoring an older baseline over them", async () => {
    const api = await factory();
    const options = fixture();
    await api.runImportMaintenance({ ...options, mode: "apply", apply: async () => { throw new Error(MARKER); } });
    writeFileSync(join(options.home, "state", "cards"), "new user work after automatic restore");
    const result = await api.runImportMaintenance({ ...options, mode: "apply", apply: async () => {
      throw new Error("retry failed after later user work");
    } });
    assert.equal(result.error?.reason, "target-changed");
    assert.equal(readFileSync(join(options.home, "state", "cards"), "utf8"), "new user work after automatic restore");
  });

  it("keeps the original cold manifest digest authoritative when a restored run resumes", async () => {
    const api = await factory();
    const options = fixture();
    await api.runImportMaintenance({ ...options, mode: "apply", apply: async () => { throw new Error(MARKER); } });
    const manifest = join(options.home, "imports", RUN, "cold-snapshot", "manifest.json");
    writeFileSync(manifest, readFileSync(manifest, "utf8") + "\n");
    let called = false;
    const result = await api.runImportMaintenance({ ...options, mode: "apply", apply: async () => { called = true; } });
    assert.equal(called, false);
    assert.equal(result.ok, false);
    assert.equal(result.restored, false);
  });

  it("records an abort before cold copy as unmutated and starts a resumable new attempt", async () => {
    const api = await factory();
    const options = fixture();
    const controller = new AbortController();
    const aborted = await api.runImportMaintenance({ ...options, mode: "apply", signal: controller.signal,
      onProgress: event => { if (event.phase === "snapshot") controller.abort(); },
      apply: async () => { assert.fail("aborted before the cold copy"); } });
    assert.equal(aborted.status, "aborted");
    assert.equal(aborted.restored, true);
    assert.equal(openMaintenanceJournal(options.home, RUN).read().phase, "prepared");
    const resumed = await api.runImportMaintenance({ ...options, mode: "apply", apply: async () => {} });
    assert.equal(resumed.ok, true);
    assert.equal(openMaintenanceJournal(options.home, RUN).read().attempt, 2);
  });

  it("recovers interrupted cold preparation as proven unmutated and preserves its baseline proof for resume", async () => {
    const api = await factory();
    const options = fixture();
    const baseline = await api.fingerprintImportTarget(options.home, options.roots);
    const journal = openMaintenanceJournal(options.home, RUN);
    journal.advance("snapshotting", { targetSha256: baseline });
    const result = await api.runImportMaintenance({ ...options, mode: "recover", apply: async () => {
      assert.fail("recovery during cold preparation cannot apply");
    } });
    assert.equal(result.ok, true);
    assert.equal(result.restored, true);
    assert.equal(result.resumable, true);
    assert.equal(journal.read().snapshotSha256, undefined);
    const saved = openMaintenanceJournal(options.home, RUN).read();
    assert.equal(saved.phase, "prepared");
    assert.equal(saved.targetSha256, baseline);
  });
});
