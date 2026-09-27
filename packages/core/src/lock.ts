import { acquireExclusiveLock } from "@plur1bus/module-api";
import { RpcError } from "./rpc/errors.ts";

/** The core's single-instance lock (`state/core.lock`): module-api's `acquireExclusiveLock`, refused as `E_LOCKED`
 *  (reason `core-lock-held`) when another core holds it or the lock file cannot be opened. */
export function acquireCoreLock(path: string, instanceId: string): { release(): void } {
  let lock: { release(): void } | null;
  try {
    lock = acquireExclusiveLock(path, { instanceId });
  } catch (e) {
    throw new RpcError("E_LOCKED", "another core holds the lock", { reason: "core-lock-held", detail: (e as Error).message });
  }
  if (!lock) throw new RpcError("E_LOCKED", "another core holds the lock", { reason: "core-lock-held", detail: "database is locked" });
  return lock;
}
