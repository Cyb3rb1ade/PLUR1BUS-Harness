// Single-writer lock for harness import operations (docs/import.md §1, D28).
// Ensures no core is currently running against the target harness home and holds the exclusive
// core.lock for the duration of all write operations. Fail-closed on any undetermined state.
//
// Phase 4 seam (P4-10, security review M3): behind the Rust front door, state/core.lock is the front door's and the
// TypeScript core behind it (core-legacy) holds run/core-legacy.lock and records itself in run/core-legacy.pid. When the
// front door dies abruptly the kernel frees state/core.lock while that legacy core may still be stopping, so the import
// also probes run/core-legacy.pid and takes run/core-legacy.lock after state/core.lock (never waiting for either: the
// same order as every other holder, so none can deadlock).
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { acquireExclusiveLock } from "@plur1bus/module-api";
import type { Layout } from "../paths.ts";
import { ImportError } from "./types.ts";
import { assertNoPendingMaintenance } from "./pending-maintenance.ts";

function checkCorePid(l: Layout): void {
  checkPidFile(l.corePid, "core.pid");
  checkPidFile(join(l.run, "core-legacy.pid"), "core-legacy.pid");
}

function checkPidFile(pidFile: string, name: string): void {
  if (!existsSync(pidFile)) return;
  try {
    const content = readFileSync(pidFile, "utf8").trim();
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
    throw new ImportError("E_CORE_RUNNING", "target-running", `target harness ${name} exists but cannot be read: ${e.message ?? e}`);
  }
}

/**
 * Acquires the target home's core lock, runs `fn`, and releases the lock in `finally`.
 * Fail-closed: any failure to determine lock state or acquire lock throws ImportError.
 */
export async function withTargetLock<T>(l: Layout, fn: () => Promise<T> | T,
  options: { maintenanceRunId?: string } = {}): Promise<T> {
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

  const release = (held: { release(): void }) => {
    try {
      held.release();
    } catch {
      // Release error ignored during teardown
    }
  };
  // A legacy core exists only where a front door made run/ before it spawned one, and no new one can start while
  // state/core.lock is held here: without run/ there is nothing to exclude (and a fresh home stays without it).
  let legacy: { release(): void } | null = null;
  if (existsSync(l.run)) {
    try {
      legacy = acquireExclusiveLock(join(l.run, "core-legacy.lock"), { instanceId: "import" });
    } catch (e: any) {
      release(lock);
      throw new ImportError("E_CORE_RUNNING", "lock-unavailable", `target harness run/core-legacy.lock cannot be opened: ${e.message ?? e}`);
    }
    if (!legacy) {
      release(lock);
      throw new ImportError("E_CORE_RUNNING", "target-running", "target harness run/core-legacy.lock is held by a legacy core that is still stopping");
    }
  }

  try {
    assertNoPendingMaintenance(l.home, options.maintenanceRunId);
    return await fn();
  } finally {
    if (legacy) release(legacy);
    release(lock);
  }
}
