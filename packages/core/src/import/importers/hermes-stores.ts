/** Offline Hermes store staging and atomic commit; read-only decisions and scratch probing are shared. */
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { Layout } from "../../paths.ts";
import { storeIdempotencyKey, type ImportLedger } from "../ledger.ts";
import { renameRetry } from "../fs-retry.ts";
import { ImportError } from "../types.ts";
import { copyStoreDirectorySafe, type PreparedStoreAdopt, type StoreAdoptReport } from "../store-probe.ts";
import { planHermesStore, type PlanHermesStoreOptions } from "../hermes-store-plan.ts";
export { createTempHost, copyStoreDirectorySafe, inspectStoreAdopt } from "../store-probe.ts";
export type { AdoptStrategy, PreparedStoreAdopt, StoreAdoptReport } from "../store-probe.ts";

/** Preserved offline API: apply adds the writer-owned staging adapter to the shared planner. */
export type PrepareStoreAdoptOptions = PlanHermesStoreOptions & { isApply: boolean };

/** Supplies target staging only for an offline apply; legacy dry-run uses the identical planner without it. */
export async function prepareStoreAdopt(opts: PrepareStoreAdoptOptions): Promise<PreparedStoreAdopt> {
  if (!opts.isApply) return planHermesStore(opts);
  const stagingDir = join(opts.l.state, `lancedb.adopt-${opts.runId}`);
  return planHermesStore(opts, {
    async stage(source, reader) {
      rmSync(stagingDir, { recursive: true, force: true });
      try {
        await copyStoreDirectorySafe(source, stagingDir, reader);
      } catch (err: any) {
        rmSync(stagingDir, { recursive: true, force: true });
        if (err instanceof ImportError) throw err;
        throw new ImportError("E_STORE_INCOMPATIBLE", "copy-failed", `failed copying store: ${err?.code ?? "io"}`);
      }
      return stagingDir;
    },
    discard() { rmSync(stagingDir, { recursive: true, force: true }); },
  });
}

/** Removes a staged copy that was never committed. Idempotent. */
export function abortStoreAdopt(prepared: PreparedStoreAdopt | undefined): void {
  if (prepared?.stagingDir) {
    rmSync(prepared.stagingDir, { recursive: true, force: true });
    prepared.stagingDir = undefined;
  }
}

/**
 * Swaps a verified staged copy into state/lancedb (apply mode, after snapshot + ledger exist). When a store is replaced
 * that is two renames (live store aside, staged copy in). If either fails the live store is put back at once and the
 * error is rethrown with no ledger entry: nothing was taken over. Should even the put-back fail (the process dies or the
 * lock persists), the live store stays in `replacedBackupDir/lancedb` with state/lancedb missing and rollback restores it
 * from there (rollback.ts). `opts.rename` is a test seam; the default retries transient Windows locks (fs-retry.ts).
 */
export function commitStoreAdopt(
  prepared: PreparedStoreAdopt,
  opts: {
    l: Layout; ledger?: ImportLedger | undefined; replacedBackupDir?: string | undefined; extraDetails?: Record<string, unknown> | undefined;
    rename?: ((from: string, to: string) => void) | undefined;
  },
): StoreAdoptReport {
  const { l, ledger, replacedBackupDir, extraDetails } = opts;
  const rename = opts.rename ?? ((from: string, to: string) => renameRetry(from, to));
  const stagingDir = prepared.stagingDir;
  if (!stagingDir) return prepared.report;
  const targetStore = l.lancedb;
  const replacing = existsSync(targetStore);
  let bkp: string | undefined;
  if (replacing) {
    if (!replacedBackupDir) {
      throw new ImportError("E_STORE_INCOMPATIBLE", "store-backup-unavailable", "cannot replace a store without a backup location");
    }
    mkdirSync(replacedBackupDir, { recursive: true, mode: 0o700 });
    bkp = join(replacedBackupDir, "lancedb");
    rmSync(bkp, { recursive: true, force: true });
  }
  let movedAside = false;
  try {
    if (bkp) { rename(targetStore, bkp); movedAside = true; }
    rename(stagingDir, targetStore);
  } catch (err) {
    if (movedAside && bkp) {
      try { rename(bkp, targetStore); } catch { /* the store stays in replaced/lancedb; rollback restores it */ }
    }
    throw err;
  }
  prepared.stagingDir = undefined;

  ledger?.record({
    entity: "store",
    idempotencyKey: storeIdempotencyKey(prepared.resolvedSource),
    action: replacing ? "replace" : "adopted",
    sourceRef: prepared.resolvedSource,
    targetRef: "state/lancedb",
    details: {
      identitySource: prepared.report.identitySource,
      schemaVersion: prepared.report.schemaVersion,
      ...extraDetails,
    },
  });

  prepared.report = { ...prepared.report, action: "taken-over" };
  return prepared.report;
}
