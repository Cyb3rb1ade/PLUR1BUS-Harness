/** Successful source snapshots expire independently of durable cold backups and resumable failed jobs. */
import { it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createSourceRegistry } from "../../src/import/source-registry.ts";
import { createImportRecords } from "../../src/import/maintenance-records.ts";
import { useTempDirs } from "./helpers.ts";

const temp = useTempDirs();
const owner = { userId: "owner", role: "owner" as const, kind: "person" as const };

async function fixture() {
  const module = await import("../../src/import/source-cleanup.ts").catch(() => undefined);
  assert.equal(typeof module?.cleanupCompletedSource, "function");
  const home = temp();
  const root = temp();
  writeFileSync(join(root, "config.yaml"), "_config_version: 45\n");
  const registry = createSourceRegistry({ home });
  const detected = await registry.detect({ kind: "path", family: "hermes", path: root }, owner);
  const source = await registry.get(detected.sourceId, owner);
  const records = createImportRecords(home);
  const input = { ownerId: owner.userId, sourceId: detected.sourceId, snapshotId: source.record.snapshotId,
    sourceType: "hermes" as const, sourceSha256: detected.sourceSha256, configRevision: "r", options: {},
    roots: [{ id: "state", path: join(home, "state"), kind: "directory" as const }],
    importBytes: 0, coldBytes: 0, entities: 0, unresolvedConflicts: 0 };
  const { record } = await records.putPlan(input);
  return { api: module!, home, source, records, input, plan: record };
}

it("removes only the completed plan's unshared sealed source and preserves cold snapshot/report metadata", async () => {
  const f = await fixture();
  const run = join(f.home, "imports", f.plan.runId);
  mkdirSync(join(run, "cold-snapshot"), { recursive: true });
  writeFileSync(join(run, "report.json"), "retained report");
  await f.api.cleanupCompletedSource({ home: f.home, plan: f.plan });
  assert.equal(existsSync(f.source.root), false);
  assert.equal(existsSync(join(run, "cold-snapshot")), true);
  assert.equal(existsSync(join(run, "report.json")), true);
});

it("retains a source shared by another valid plan, then removes it after that reference expires", async () => {
  const f = await fixture();
  await f.records.putPlan(f.input);
  await f.api.cleanupCompletedSource({ home: f.home, plan: f.plan });
  assert.equal(existsSync(f.source.root), true);
  await f.api.cleanupCompletedSource({ home: f.home, plan: f.plan, now: () => Date.now() + 2 * 24 * 60 * 60 * 1000 });
  assert.equal(existsSync(f.source.root), false);
});
