/** Recovery cannot be bypassed by direct Core startup or the historical offline importer entry. */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { defaults } from "@plur1bus/config-schema";
import { createCore } from "../../src/core.ts";
import { importOpenclaw } from "../../src/import/importers/openclaw.ts";
import { openMaintenanceJournal } from "../../src/import/maintenance-journal.ts";
import { withTargetLock } from "../../src/import/single-writer.ts";
import { layout } from "../../src/paths.ts";
import { flatTestInternals } from "../helpers/flat-embedder.ts";
import { useTempDirs } from "./helpers.ts";

const temp = useTempDirs();
const RUN = "72e1ad29-5d2b-4e1b-9f64-d33e5bb466d5";

async function factory() {
  const module = await import("../../src/import/pending-maintenance.ts").catch(() => undefined);
  assert.equal(typeof module?.assertNoPendingMaintenance, "function", "dirty maintenance must block every Engine owner");
  return module!;
}

function dirty(home: string) {
  const journal = openMaintenanceJournal(home, RUN);
  journal.advance("snapshotting");
  journal.advance("snapshot-complete", { snapshotSha256: "a".repeat(64) });
  journal.advance("applying");
  return journal;
}

function source() {
  const root = temp();
  mkdirSync(join(root, "workspace"));
  writeFileSync(join(root, "workspace", "SOUL.md"), "unrelated new import");
  writeFileSync(join(root, "openclaw.json"), JSON.stringify({ meta: { lastTouchedVersion: "2026.9.5" },
    agents: { list: [{ id: "alpha", workspace: join(root, "workspace") }] } }));
  return root;
}

const required = (error: unknown) => {
  assert.equal((error as { reason?: string }).reason, "maintenance-recovery-required");
  return true;
};

describe("pending import recovery guard", () => {
  it("blocks dirty or malformed journals without rewriting metadata and permits only the internal matching run", async () => {
    const api = await factory();
    const home = temp();
    const journal = dirty(home);
    const file = join(home, "imports", RUN, "maintenance.json");
    const before = readFileSync(file);
    assert.throws(() => api.assertNoPendingMaintenance(home), required);
    api.assertNoPendingMaintenance(home, RUN);
    assert.throws(() => api.assertNoPendingMaintenance(home, "another-run"), required);
    assert.deepEqual(readFileSync(file), before);
    journal.advance("committed", { targetSha256: "b".repeat(64) });
    api.assertNoPendingMaintenance(home);
    writeFileSync(file, "malformed private metadata");
    assert.throws(() => api.assertNoPendingMaintenance(home), required);
  });

  it("rejects unsupervised Core startup before creating an Engine and allows a completed clean journal", async () => {
    const home = temp();
    writeFileSync(join(home, "config.json"), JSON.stringify(defaults()));
    const journal = dirty(home);
    let inspected = 0;
    const core = createCore({ home, testInternals: flatTestInternals(), inspectHost: () => { inspected++; } });
    try {
      await assert.rejects(core.start(), required);
      assert.equal(inspected, 0);
    } finally {
      await core.stop({ budgetMs: 3000 });
    }
    journal.advance("committed", { targetSha256: "b".repeat(64) });
    const clean = createCore({ home, testInternals: flatTestInternals() });
    try {
      await clean.start();
      assert.ok(["ready", "degraded"].includes(clean.status().process.state));
    } finally {
      await clean.stop({ budgetMs: 5000 });
    }
  });

  it("blocks historical apply and dry-run before source migration while recovery owns its internal lock exception", async () => {
    const home = temp();
    dirty(home);
    const original = readFileSync(join(home, "imports", RUN, "maintenance.json"));
    for (const apply of [false, true]) {
      await assert.rejects(importOpenclaw({ home, source: source(), apply, testInternals: flatTestInternals() }), required);
    }
    assert.equal(existsSync(join(home, "agents")), false);
    await assert.rejects(withTargetLock(layout(home), async () => {}), required);
    await withTargetLock(layout(home), async () => {}, { maintenanceRunId: RUN });
    assert.deepEqual(readFileSync(join(home, "imports", RUN, "maintenance.json")), original);
  });
});
