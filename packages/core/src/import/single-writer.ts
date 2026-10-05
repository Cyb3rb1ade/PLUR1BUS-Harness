// Single-writer check for harness import operations (docs/import.md §1, D28).
// Ensures no core is currently running against the target harness home before any writes occur.
import { existsSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import { acquireExclusiveLock } from "@plur1bus/module-api";
import type { Layout } from "../paths.ts";
import { ImportError } from "./types.ts";

/**
 * Asserts that no active core is currently running on the target harness home.
 * Checks both `l.corePid` and `l.coreLock`.
 * Throws ImportError with code "E_CORE_RUNNING" and reason "target-running" if active.
 */
export function assertTargetNotRunning(l: Layout): void {
  // Check core.pid
  if (existsSync(l.corePid)) {
    try {
      const content = readFileSync(l.corePid, "utf8").trim();
      const pidStr = content.split(/\s+/)[0];
      const pid = parseInt(pidStr ?? "", 10);
      if (Number.isSafeInteger(pid) && pid > 0) {
        try {
          process.kill(pid, 0);
          throw new ImportError("E_CORE_RUNNING", "target-running", `target harness has an active core running (pid ${pid})`);
        } catch (e: any) {
          if (e instanceof ImportError) throw e;
          if (e.code === "EPERM") {
            throw new ImportError("E_CORE_RUNNING", "target-running", `target harness has an active core running (pid ${pid})`);
          }
          // ESRCH means process is no longer running (stale pid file)
        }
      }
    } catch (e: any) {
      if (e instanceof ImportError) throw e;
    }
  }

  // Check core.lock if state directory or lock file exists
  if (existsSync(l.coreLock) || existsSync(dirname(l.coreLock))) {
    try {
      const lock = acquireExclusiveLock(l.coreLock, { instanceId: "import-check" });
      if (!lock) {
        throw new ImportError("E_CORE_RUNNING", "target-running", "target harness core.lock is held by an active core");
      }
      lock.release();
    } catch (e: any) {
      if (e instanceof ImportError) throw e;
      if (e.name === "RpcError" || (e as any).code === "E_LOCKED" || (e as any).reason === "core-lock-held") {
        throw new ImportError("E_CORE_RUNNING", "target-running", "target harness core.lock is held by an active core");
      }
    }
  }
}
