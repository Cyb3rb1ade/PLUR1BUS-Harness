/** Offline per-partition store staging and commit; the shared planner owns all decisions and report wording. */
import { existsSync, mkdirSync, renameSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Layout } from "../../paths.ts";
import type { ImportLedger } from "../ledger.ts";
import { writeAtomicSync } from "../fs-atomic.ts";
import { commitStoreAdopt } from "./hermes-stores.ts";
import { planOpenclawStores, type PlanOpenclawStoresOptions, type PreparedOpenclawStores } from "../openclaw-store-plan.ts";
export { ROUTED_REASONS } from "../openclaw-store-plan.ts";
export type { OpenclawStoreAction, OpenclawStoreReport, PreparedOpenclawStores } from "../openclaw-store-plan.ts";

/** Preserved offline API: apply adds the writer-owned staging adapter to the shared planner. */
export type PrepareOpenclawStoresOptions = PlanOpenclawStoresOptions & { isApply: boolean };

/** Target staging is supplied only by the legacy offline apply wrapper, after it holds the target writer lock. */
export async function prepareOpenclawStores(o: PrepareOpenclawStoresOptions): Promise<PreparedOpenclawStores> {
  if (!o.isApply) return planOpenclawStores(o);
  const stagingDir = join(o.l.state, `lancedb.adopt-${o.runId}`);
  const probeBase = join(o.l.state, `lancedb.adopt-${o.runId}.probe`);
  return planOpenclawStores(o, {
    probeBase,
    begin() {
      rmSync(stagingDir, { recursive: true, force: true });
      rmSync(probeBase, { recursive: true, force: true });
      mkdirSync(probeBase, { recursive: true, mode: 0o700 });
    },
    accept(root, relative, marker, first) {
      if (first) {
        mkdirSync(stagingDir, { recursive: true, mode: 0o700 });
        if (marker) writeAtomicSync(join(stagingDir, "_schema.json"), marker, 0o600);
      }
      const destination = join(stagingDir, ...relative.split("/"));
      mkdirSync(dirname(destination), { recursive: true, mode: 0o700 });
      renameSync(join(root, "probe"), destination);
    },
    abort() { rmSync(stagingDir, { recursive: true, force: true }); },
    close() { rmSync(probeBase, { recursive: true, force: true }); },
    prepared(report, source, replacesExisting) {
      return existsSync(stagingDir) ? { report, resolvedSource: source, stagingDir, replacesExisting } : undefined;
    },
  });
}

/** Swaps the verified staging dir into state/lancedb (apply, after snapshot + ledger exist). */
export function commitOpenclawStores(p: PreparedOpenclawStores, opts: { l: Layout; ledger?: ImportLedger | undefined; replacedBackupDir?: string | undefined }): void {
  if (!p.adopt?.stagingDir) return;
  const rows = () => p.stores.map((s) => ({ storeId: s.storeId, action: s.action === "preview-ok" ? "taken-over" : s.action, reasons: s.reasons }));
  p.adoptReport = commitStoreAdopt(p.adopt, { ...opts, extraDetails: { stores: rows() } });
  for (const s of p.stores) if (s.action === "preview-ok") s.action = "taken-over";
}
