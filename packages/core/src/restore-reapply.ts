// Forgotten memories stay forgotten across a `plur1bus backup restore`.
//
// A restore swaps the store directory for the backup's rows (crates/plur1bus/src/backup/restore.rs). The engine's tombstone
// registry (`<dirname of the store>/_tombstones`, i.e. `state/_tombstones`) is a sibling of the store and not part of any
// backup, so it survives the restore as it was: the memories forgotten after the backup are recorded there as committed
// tombstones, but their rows are active again in the restored store. The restore leaves RESTORE_REAPPLY_MARKER behind; this
// module runs at core start, before the engine is built and before the socket listens (so before the first recall), and
// re-applies the committed tombstones to the restored rows.
//
// The engine function is `reapplyCommittedTombstones` of `lib/tombstone-reapply.js` (engine PR #259). The pinned engine does
// not ship it yet and there is no `engine.capabilities` flag for it, so it is feature-detected by importing the module: while
// it is missing the marker stays, the core logs a warning on every start and the gap is open (KNOWN GAP, see
// docs/ops/backup-restore.md). There is no harness-side recall filter over the registry that could stand in for it.
import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { HarnessLogger } from "./logger.ts";
import type { Layout } from "./paths.ts";

/** File name inside `state/`; the same path as `REAPPLY_MARKER` in crates/plur1bus/src/backup/restore.rs (a test keeps them equal). */
export const RESTORE_REAPPLY_MARKER_NAME = ".restore-reapply-tombstones";
/** The engine module that holds the re-apply (engine PR #259); a deep import like `lib/snapshot/store-snapshot.js`. */
export const ENGINE_REAPPLY_MODULE = "@cyb3rb1ade/plur1bus-memory/lib/tombstone-reapply.js";

export interface TombstoneReapplyReport {
  applied: unknown[]; alreadyTombstoned: unknown[]; notFound: unknown[];
  errors: unknown[]; registryErrors: unknown[]; activeAfterReapply: unknown[];
}
export interface EngineTombstoneReapply {
  reapplyCommittedTombstones(o: { baseDbPath: string; apply?: boolean }): Promise<TombstoneReapplyReport>;
  reapplyFailed(report: TombstoneReapplyReport): boolean;
}
/** Resolves the engine's re-apply, or `null` when the pinned engine does not have it. Rejects on any other failure. */
export type LoadEngineReapply = () => Promise<EngineTombstoneReapply | null>;

export type ReapplyOutcome =
  | { status: "no-marker" }
  /** Re-applied and verified; the marker is gone. */
  | { status: "applied"; applied: number; alreadyTombstoned: number; notFound: number }
  /** The engine has no `reapplyCommittedTombstones` yet: the marker stays. */
  | { status: "unsupported" }
  /** The engine ran but could not complete or verify it (unreadable registry, a row still active): the marker stays. */
  | { status: "incomplete"; problems: number }
  /** The engine's function threw: the marker stays. */
  | { status: "failed"; error: string };

export const restoreReapplyMarker = (layout: Pick<Layout, "state">): string => join(layout.state, RESTORE_REAPPLY_MARKER_NAME);

/** The default feature detection: a missing module is "not there yet", anything else (a broken module) is an error. */
export const loadEngineReapply: LoadEngineReapply = async () => {
  let m: Partial<EngineTombstoneReapply>;
  try {
    m = await import("@cyb3rb1ade/plur1bus-memory/lib/tombstone-reapply.js");
  } catch (e) {
    const code = (e as NodeJS.ErrnoException | undefined)?.code;
    const message = e instanceof Error ? e.message : String(e);
    // The engine file itself is missing (the pinned engine predates PR #259). A module that file imports being missing
    // names that other module instead, and stays an error.
    if ((code === "ERR_MODULE_NOT_FOUND" || code === "ERR_PACKAGE_PATH_NOT_EXPORTED") && (message.includes("tombstone-reapply") || message.includes("'@cyb3rb1ade/plur1bus-memory'"))) return null;
    throw e;
  }
  return typeof m.reapplyCommittedTombstones === "function" && typeof m.reapplyFailed === "function" ? m as EngineTombstoneReapply : null;
};

export interface ReapplyAfterRestoreDeps {
  layout: Pick<Layout, "state">;
  /** The engine's store path as the core configured it (`buildEngineConfig`); the registry is its sibling `_tombstones`. */
  baseDbPath: string;
  logger: Pick<HarnessLogger, "info" | "warn">;
  /** Test seam; default `loadEngineReapply`. */
  load?: LoadEngineReapply;
}

/** When the restore left its marker: the restore's own time (ms), `undefined` for a marker whose body is unreadable. */
function markerTime(path: string): number | undefined {
  try {
    const t = (JSON.parse(readFileSync(path, "utf8")) as { restoredAtMs?: unknown }).restoredAtMs;
    return typeof t === "number" && Number.isFinite(t) ? t : undefined;
  } catch { return undefined; }
}

/** Runs once per core start, before the engine exists. Never throws: whatever goes wrong leaves the marker in place and a
 *  warning in the log, and the core starts. Counts only in the log, never a memory id or text. */
export async function reapplyTombstonesAfterRestore(d: ReapplyAfterRestoreDeps): Promise<ReapplyOutcome> {
  const marker = restoreReapplyMarker(d.layout);
  if (!existsSync(marker)) return { status: "no-marker" };
  const t = markerTime(marker);
  const restored = t === undefined ? "at an unknown time" : `at ${new Date(t).toISOString()}`;
  const owed = `a backup restore ${restored} left committed tombstones to re-apply`;
  const stays = "the marker stays and the re-apply is retried on the next start";
  try {
    const engine = await (d.load ?? loadEngineReapply)();
    if (!engine) {
      d.logger.warn(`${owed}, but the pinned engine has no ${ENGINE_REAPPLY_MODULE}: memories forgotten after that backup may be recallable again until the engine is updated; ${stays}`, { marker });
      return { status: "unsupported" };
    }
    const report = await engine.reapplyCommittedTombstones({ baseDbPath: d.baseDbPath, apply: true });
    if (engine.reapplyFailed(report)) {
      const problems = report.errors.length + report.registryErrors.length + report.activeAfterReapply.length;
      d.logger.warn(`${owed}, but re-applying them is incomplete (${problems} problem(s)): memories forgotten after that backup may be recallable again; ${stays}`, {
        marker, errors: report.errors.length, registryErrors: report.registryErrors.length, activeAfterReapply: report.activeAfterReapply.length,
      });
      return { status: "incomplete", problems };
    }
    const out = { applied: report.applied.length, alreadyTombstoned: report.alreadyTombstoned.length, notFound: report.notFound.length };
    try { rmSync(marker, { force: true }); } catch (e) {
      d.logger.warn("tombstones were re-applied after a backup restore, but the marker could not be removed; it is retried on the next start (re-applying is idempotent)", { marker, err: e });
    }
    d.logger.info("re-applied committed tombstones after a backup restore", out);
    return { status: "applied", ...out };
  } catch (e) {
    const error = e instanceof Error ? e.message : String(e);
    d.logger.warn(`${owed}, but re-applying them failed: memories forgotten after that backup may be recallable again; ${stays}`, { marker, err: e });
    return { status: "failed", error };
  }
}
