// Single-writer lock for harness import operations (docs/import.md §1, D28).
// Ensures no core is currently running against the target harness home and holds the exclusive
// core.lock for the duration of all write operations. Fail-closed on any undetermined state.
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import { acquireExclusiveLock } from "@plur1bus/module-api";
import type { Layout } from "../paths.ts";
import { ImportError } from "./types.ts";

function checkCorePid(l: Layout): void {
  if (!existsSync(l.corePid)) return;
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
    // Corrupt or unreadable PID file while file exists: fail closed
    throw new ImportError("E_CORE_RUNNING", "target-running", `target harness core.pid exists but cannot be read: ${e.message ?? e}`);
  }
}

/**
 * Acquires the target home's core lock, runs `fn`, and releases the lock in `finally`.
 * Fail-closed: any failure to determine lock state or acquire lock throws ImportError.
 */
export async function withTargetLock<T>(l: Layout, fn: () => Promise<T> | T): Promise<T> {
  // Check core.pid advisory hint
  checkCorePid(l);

  // Ensure state directory exists
  try {
    mkdirSync(dirname(l.coreLock), { recursive: true, mode: 0o700 });
  } catch (e: any) {
    throw new ImportError("E_CORE_RUNNING", "lock-unavailable", `cannot create state directory for core.lock: ${e.message ?? e}`);
  }

  let lock: { release(): void } | null = null;
  try {
    lock = acquireExclusiveLock(l.coreLock, { instanceId: "import" });
  } catch (e: any) {
    if (e instanceof ImportError) throw e;
    throw new ImportError("E_CORE_RUNNING", "lock-unavailable", `target harness core.lock cannot be opened: ${e.message ?? e}`);
  }

  if (!lock) {
    throw new ImportError("E_CORE_RUNNING", "target-running", "target harness core.lock is held by an active core");
  }

  try {
    return await fn();
  } finally {
    try {
      lock.release();
    } catch {
      // Release error ignored during teardown
    }
  }
}
