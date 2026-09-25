import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { RpcError } from "./rpc/errors.ts";

/**
 * An OS-held exclusive lock without a native addon: an open SQLite EXCLUSIVE
 * transaction is an fcntl/LockFileEx lock the kernel releases when the process
 * dies. A second BEGIN EXCLUSIVE fails at once (busy_timeout 0). Verified on
 * Node 24.21 (plan H1 pre-check): refused while held, free after SIGKILL.
 */
export function acquireCoreLock(path: string, instanceId: string): { release(): void } {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const db = new DatabaseSync(path);
  try {
    db.exec("PRAGMA busy_timeout=0; PRAGMA locking_mode=EXCLUSIVE;");
    db.exec("CREATE TABLE IF NOT EXISTS holder(pid INTEGER NOT NULL, instance TEXT NOT NULL, at INTEGER NOT NULL)");
    db.exec("BEGIN EXCLUSIVE");
    db.prepare("DELETE FROM holder").run();
    db.prepare("INSERT INTO holder VALUES (?, ?, ?)").run(process.pid, instanceId, Date.now());
  } catch (e) {
    db.close();
    throw new RpcError("E_LOCKED", "another core holds the lock", { reason: "core-lock-held", detail: (e as Error).message });
  }
  return { release() { try { db.exec("ROLLBACK"); } catch { /* already gone */ } db.close(); } };
}
