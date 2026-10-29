/** Prepares real sealed source/plan metadata for Native's fixed built import worker; never prints source body. */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { defaults } from "@plur1bus/config-schema";
import { createSnapshot } from "../../src/import/snapshot.ts";
import { createImportRecords } from "../../src/import/maintenance-records.ts";
import { fingerprintImportTarget } from "../../src/import/maintenance-worker.ts";

const [home, revision] = process.argv.slice(2);
const source = join(home, "source-fixture");
await mkdir(join(source, "workspace"), { recursive: true });
await writeFile(join(source, "workspace", "SOUL.md"), "actual private worker persona");
await writeFile(join(source, "openclaw.json"), JSON.stringify({ meta: { lastTouchedVersion: "2026.9.5" },
  agents: { list: [{ id: "alpha", workspace: join(source, "workspace") }] } }));
await mkdir(join(home, "state"));
await writeFile(join(home, "state", "prior-data"), "old target data");
await writeFile(join(home, "config.json"), JSON.stringify(defaults()) + "\n", { mode: 0o600 });
const id = "s".repeat(43);
const snapshot = await createSnapshot({ home, sourceType: "openclaw", sourceRoot: source,
  stagingDir: join(home, "import", id, "snapshot") });
const sourceSha256 = createHash("sha256").update(await readFile(join(snapshot.stagingDir, "snapshot.json"))).digest("hex");
const roots = [{ id: "state", path: join(home, "state"), kind: "directory", preserve: ["core.lock", "api"] },
  { id: "agents", path: join(home, "agents"), kind: "directory" }, { id: "skills", path: join(home, "skills"), kind: "directory" }];
const targetSha256 = await fingerprintImportTarget(home, roots);
const plan = await createImportRecords(home).putPlan({ ownerId: "owner", sourceId: "67862ffb-45b8-4485-8f9b-7acfde923dee",
  snapshotId: id, sourceType: "openclaw", sourceSha256, configRevision: revision, options: { onConflict: "skip" },
  roots, importBytes: 1000, coldBytes: 1000, entities: 1, unresolvedConflicts: 0 });
process.stdout.write(JSON.stringify({ invocationId: randomUUID(), runId: plan.record.runId, planId: plan.record.id, planSha256: plan.sha256,
  ownerId: "owner", role: "owner", sourceType: plan.record.sourceType, mode: "apply", attempt: 1,
  preflightId: null, targetSha256, migrateSecrets: false, automaticRollback: false }) + "\n");
