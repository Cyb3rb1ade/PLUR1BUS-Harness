/** Delete only an activated plan's sealed source; durable plans, cold backups and reports remain independent. */
import { lstat, readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { noLinkedSegments, readColdBytes } from "./maintenance-files.ts";
import { createImportRecords, type ImportPlanRecord } from "./maintenance-records.ts";

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const SNAPSHOT = /^[A-Za-z0-9_-]{43}$/;

async function activated(home: string, plan: ImportPlanRecord, sha256: string): Promise<boolean> {
  try {
    const root = join(home, "imports", plan.runId);
    const marker = JSON.parse((await readColdBytes(join(root, "activation.json"), 8192)).toString("utf8"));
    const native = JSON.parse((await readColdBytes(join(root, "maintenance-run.json"), 256 * 1024)).toString("utf8"));
    return marker.version === 1 && marker.runId === plan.runId && marker.planSha256 === sha256
      && marker.invocationId === native.job?.invocationId && marker.attempt === native.job?.attempt
      && native.job?.mode === "apply" && marker.result?.ok === true && marker.result?.restored === false;
  } catch { return false; }
}

/** Invoked only after the private activation marker and runtime actor/model checks succeeded. */
export async function cleanupCompletedSource(options: { home: string; plan: ImportPlanRecord; now?: () => number }):
  Promise<{ removed: boolean }> {
  const { home, plan } = options;
  if (!SNAPSHOT.test(plan.snapshotId) || !UUID.test(plan.id)) return { removed: false };
  const records = createImportRecords(home);
  const directory = join(home, "imports", "plans");
  await noLinkedSegments(directory);
  const files = await readdir(directory);
  if (files.length > 10_000) return { removed: false };
  const protectedSnapshots = new Set<string>();
  let metadataBytes = 0;
  for (const file of files) {
    const id = file.endsWith(".json") ? file.slice(0, -5) : "";
    if (!UUID.test(id) || id === plan.id) continue;
    try {
      const bytes = await readColdBytes(join(directory, file), 8 * 1024 * 1024);
      metadataBytes += bytes.length;
      if (metadataBytes > 64 * 1024 * 1024) return { removed: false };
      const owner = JSON.parse(bytes.toString("utf8"))?.ownerId;
      if (typeof owner !== "string") return { removed: false };
      const other = await records.readPlan(id, owner, undefined, true);
      if (Date.parse(other.record.expiresAt) <= (options.now?.() ?? Date.now())) continue;
      if (!await activated(home, other.record, other.sha256)) {
        protectedSnapshots.add(other.record.snapshotId);
        for (const snapshot of other.record.sourceSnapshots ?? []) protectedSnapshots.add(snapshot.id);
      }
    } catch { return { removed: false }; }
  }
  let removed = false;
  for (const snapshot of [{ id: plan.snapshotId, sha256: plan.sourceSha256 }, ...plan.sourceSnapshots ?? []]) {
    if (protectedSnapshots.has(snapshot.id)) continue;
    const source = join(home, "import", snapshot.id);
    await noLinkedSegments(source, true);
    const present = await lstat(source).catch(error => {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      return undefined;
    });
    if (present && !present.isDirectory()) continue;
    if (present) {
      const manifest = await readColdBytes(join(source, "snapshot", "snapshot.json"), 8 * 1024 * 1024);
      if (createHash("sha256").update(manifest).digest("hex") !== snapshot.sha256) continue;
    }
    await rm(source, { recursive: true, force: true });
    if (snapshot.id === plan.snapshotId) removed = true;
  }
  return { removed };
}
