import { acquireExclusiveLock } from "@plur1bus/module-api";
import { RpcError } from "./rpc/errors.ts";

/** The core's single-instance lock (`state/core.lock`): module-api's `acquireExclusiveLock`. Only a lock another core
 *  holds is `E_LOCKED` (reason `core-lock-held`; bin.ts exits 3, which the supervisor retries). A lock file that cannot
 *  be opened (an unwritable directory, a corrupt file) throws as is, so the core exits 1 ("start failed").
 *
 *  `legacy` (Phase 4 seam P4-10, security review M3): a core that is not behind the Rust front door also takes
 *  `run/core-legacy.lock`, after `state/core.lock` and without waiting. A front door holds `state/core.lock` and its legacy
 *  core `run/core-legacy.lock`; when the front door dies abruptly, the kernel frees `state/core.lock` at once while the
 *  legacy core may still be stopping. The second lock keeps a stock core off the stores until that legacy core is gone
 *  (`E_LOCKED core-lock-held`, retried like any held lock). The order is the same everywhere (`state/core.lock`, then
 *  `run/core-legacy.lock`) and neither lock is waited for, so no two holders can deadlock. */
export function acquireCoreLock(path: string, instanceId: string, o: { legacy?: string } = {}): { release(): void } {
  const lock = acquireExclusiveLock(path, { instanceId });
  if (!lock) throw new RpcError("E_LOCKED", "another core holds the lock", { reason: "core-lock-held", detail: "database is locked" });
  let legacy: { release(): void } | null = null;
  if (o.legacy !== undefined) {
    try { legacy = acquireExclusiveLock(o.legacy, { instanceId }); } catch (e) { lock.release(); throw e; }
    if (!legacy) {
      lock.release();
      throw new RpcError("E_LOCKED", "a legacy core behind a stopped front door still holds run/core-legacy.lock", { reason: "core-lock-held", detail: "run/core-legacy.lock is locked" });
    }
  }
  // module-api's release() closes the database, which throws on a second call: a shutdown path that releases twice
  // (signal handler plus normal exit) must not turn into a crash that skips the rest of the cleanup.
  let released = false;
  return { release() { if (released) return; released = true; try { legacy?.release(); } finally { lock.release(); } } };
}
