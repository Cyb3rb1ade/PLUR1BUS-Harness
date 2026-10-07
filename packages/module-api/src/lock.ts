import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

/** Handle keeping a per-module OS lock held until {@link release} is called. */
export interface ExclusiveLock { release(): void }

/** SQLITE_BUSY: another connection holds the database (here: its EXCLUSIVE transaction). */
const SQLITE_BUSY = 5;

/**
 * An OS-held exclusive lock without a native addon: an open SQLite EXCLUSIVE transaction is an fcntl/LockFileEx lock
 * the kernel releases when the process dies. A second BEGIN EXCLUSIVE fails at once (busy_timeout 0). Verified on
 * Node 24.21 (plan H1 pre-check): refused while held, free after SIGKILL. The holder row (`pid`, `instance`, `at`)
 * names the process that holds it, for a human reading the file.
 *
 * Returns null when another process holds the lock; any other failure (an unwritable directory, a corrupt file)
 * throws. Keep the returned handle reachable: a collected DatabaseSync is closed, which frees the lock.
 */
export function acquireExclusiveLock(path: string, o: { instanceId?: string } = {}): ExclusiveLock | null {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const db = new DatabaseSync(path);
  try {
    db.exec("PRAGMA busy_timeout=0; PRAGMA locking_mode=EXCLUSIVE;");
    db.exec("CREATE TABLE IF NOT EXISTS holder(pid INTEGER NOT NULL, instance TEXT NOT NULL, at INTEGER NOT NULL)");
    db.exec("BEGIN EXCLUSIVE");
    db.prepare("DELETE FROM holder").run();
    db.prepare("INSERT INTO holder VALUES (?, ?, ?)").run(process.pid, o.instanceId ?? "", Date.now());
  } catch (e) {
    db.close();
    if ((e as { errcode?: unknown }).errcode === SQLITE_BUSY) return null;
    throw e;
  }
  return { release() { try { db.exec("ROLLBACK"); } catch { /* already gone */ } db.close(); } };
}
