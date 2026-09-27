import { acquireExclusiveLock } from "@plur1bus/module-api";
import { RpcError } from "./rpc/errors.ts";

/** The core's single-instance lock (`state/core.lock`): module-api's `acquireExclusiveLock`. Only a lock another core
 *  holds is `E_LOCKED` (reason `core-lock-held`; bin.ts exits 3, which the supervisor retries). A lock file that cannot
 *  be opened (an unwritable directory, a corrupt file) throws as is, so the core exits 1 ("start failed"). */
export function acquireCoreLock(path: string, instanceId: string): { release(): void } {
  const lock = acquireExclusiveLock(path, { instanceId });
  if (!lock) throw new RpcError("E_LOCKED", "another core holds the lock", { reason: "core-lock-held", detail: "database is locked" });
  return lock;
}
