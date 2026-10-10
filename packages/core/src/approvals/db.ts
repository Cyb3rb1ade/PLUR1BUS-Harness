// D109 §6: the approval store's SQLite file (grants, approvals, approval_chain) under state/, migrated by PRAGMA user_version.
// One file for all three tables so a grant and the chain entry that proves it commit in one transaction.
import { chmodSync, closeSync, mkdirSync, openSync } from "node:fs";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { layout } from "../paths.ts";

export const APPROVALS_SCHEMA_VERSION = 2;
export const APPROVALS_DB_FILE = "approvals.sqlite";

/** `<home>/state/approvals.sqlite`, via the harness layout (never config.json, D109 §6). */
export function approvalsDbPath(home: string): string {
  return join(layout(home).state, APPROVALS_DB_FILE);
}

const MIGRATIONS: Record<number, string> = {
  1: `
    CREATE TABLE grants (
      id TEXT PRIMARY KEY,
      person TEXT NOT NULL,
      agent TEXT NOT NULL,
      capability TEXT NOT NULL,
      effect TEXT,
      match_kind TEXT NOT NULL CHECK (match_kind IN ('action', 'capability', 'path')),
      match_path TEXT,
      match_access TEXT CHECK (match_access IS NULL OR match_access IN ('read', 'write')),
      match_recursive INTEGER CHECK (match_recursive IS NULL OR match_recursive IN (0, 1)),
      duration TEXT NOT NULL CHECK (duration IN ('once', 'task', 'session', 'always')),
      created_by TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      expires_at INTEGER,
      revoked_at INTEGER,
      end_reason TEXT,
      last_used_at INTEGER,
      consumed_at INTEGER,
      action_hash TEXT,
      task_id TEXT,
      session_id TEXT,
      project_id TEXT,
      job_id TEXT,
      delegable INTEGER NOT NULL DEFAULT 0 CHECK (delegable IN (0, 1)),
      surface INTEGER NOT NULL CHECK (surface BETWEEN 0 AND 3),
      acknowledged_unsandboxed INTEGER NOT NULL DEFAULT 0 CHECK (acknowledged_unsandboxed IN (0, 1)),
      def_hash TEXT NOT NULL,
      chain_seq INTEGER NOT NULL,
      CHECK (match_kind <> 'path' OR (match_path IS NOT NULL AND match_access IS NOT NULL AND match_recursive IS NOT NULL))
    );
    CREATE INDEX grants_lookup ON grants (person, agent, capability);
    CREATE INDEX grants_task ON grants (task_id) WHERE task_id IS NOT NULL;
    CREATE INDEX grants_session ON grants (session_id) WHERE session_id IS NOT NULL;

    CREATE TABLE approvals (
      id TEXT PRIMARY KEY,
      principal TEXT NOT NULL,
      subject_kind TEXT NOT NULL,
      subject_id TEXT NOT NULL,
      capability TEXT NOT NULL,
      action_hash TEXT NOT NULL,
      turn_id TEXT NOT NULL,
      task_id TEXT NOT NULL,
      session_id TEXT NOT NULL,
      nonce TEXT NOT NULL UNIQUE,
      status TEXT NOT NULL CHECK (status IN ('pending', 'approved', 'denied', 'used', 'cancelled')),
      created_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL,
      decided_at INTEGER,
      decided_by TEXT,
      decision_surface INTEGER CHECK (decision_surface IS NULL OR decision_surface BETWEEN 0 AND 3),
      used_at INTEGER,
      delegable INTEGER NOT NULL DEFAULT 0 CHECK (delegable IN (0, 1))
    );
    CREATE INDEX approvals_status ON approvals (status, expires_at);

    CREATE TABLE approval_chain (
      seq INTEGER PRIMARY KEY,
      ts INTEGER NOT NULL,
      kind TEXT NOT NULL,
      ref_id TEXT NOT NULL,
      nonce TEXT,
      payload TEXT NOT NULL,
      prev_mac TEXT NOT NULL,
      mac TEXT NOT NULL
    );
    CREATE UNIQUE INDEX approval_chain_once ON approval_chain (kind, ref_id) WHERE kind LIKE 'approval.%';
    CREATE INDEX approval_chain_ref ON approval_chain (ref_id);

    CREATE TABLE chain_head (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      seq INTEGER NOT NULL,
      mac TEXT NOT NULL,
      tag TEXT NOT NULL
    );
  `,
  // #192 option C: where a grant came from when an OS confirmation lifted its approval to T2 ("attested:<method>"). NULL for every earlier row.
  2: `ALTER TABLE grants ADD COLUMN attested_via TEXT;`,
};

export class ApprovalsDbError extends Error {
  readonly code: "newer-schema" | "open-failed";
  constructor(code: "newer-schema" | "open-failed", message: string) { super(message); this.name = "ApprovalsDbError"; this.code = code; }
}

export interface OpenApprovalsDbOptions {
  path: string;
  /** Applies the platform's owner-only permissions (module-api's securePath); POSIX mode 0600 is always set. */
  securePath?: (p: string, o?: { mode?: number }) => void;
  busyTimeoutMs?: number;
}

export function openApprovalsDb(o: OpenApprovalsDbOptions): DatabaseSync {
  try {
    mkdirSync(dirname(o.path), { recursive: true, mode: 0o700 });
    closeSync(openSync(o.path, "a", 0o600)); // owner-only before SQLite (and its -wal/-shm) touches it
    try { chmodSync(o.path, 0o600); } catch { /* not POSIX */ }
    o.securePath?.(o.path, { mode: 0o600 });
  } catch (e) {
    throw new ApprovalsDbError("open-failed", `cannot prepare ${o.path}: ${(e as Error).message}`);
  }
  const db = new DatabaseSync(o.path);
  try {
    db.exec(`PRAGMA busy_timeout = ${Math.max(0, Math.floor(o.busyTimeoutMs ?? 5000))}`);
    db.exec("PRAGMA journal_mode = WAL");
    db.exec("PRAGMA synchronous = FULL"); // a decision that was reported must survive a crash
    migrate(db);
  } catch (e) {
    try { db.close(); } catch { /* already closed */ }
    throw e;
  }
  return db;
}

const userVersion = (db: DatabaseSync): number => Number((db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version);

function migrate(db: DatabaseSync): void {
  if (userVersion(db) === APPROVALS_SCHEMA_VERSION) return;
  db.exec("BEGIN IMMEDIATE");
  try {
    let v = userVersion(db); // re-read under the write lock: another process may have migrated meanwhile
    if (v > APPROVALS_SCHEMA_VERSION) throw new ApprovalsDbError("newer-schema", `approvals store schema ${v} is newer than this core's ${APPROVALS_SCHEMA_VERSION}; refusing to open it (upgrade the core)`);
    while (v < APPROVALS_SCHEMA_VERSION) {
      v += 1;
      db.exec(MIGRATIONS[v]!);
      db.exec(`PRAGMA user_version = ${v}`);
    }
    db.exec("COMMIT");
  } catch (e) {
    try { db.exec("ROLLBACK"); } catch { /* nothing open */ }
    throw e;
  }
}

/** Runs `fn` in an IMMEDIATE transaction (write lock up front, so two connections serialise instead of failing). */
export function transaction<T>(db: DatabaseSync, fn: () => T): T {
  if (db.isTransaction) return fn(); // nested: the outer transaction commits or rolls back everything
  db.exec("BEGIN IMMEDIATE");
  try {
    const r = fn();
    db.exec("COMMIT");
    return r;
  } catch (e) {
    try { db.exec("ROLLBACK"); } catch { /* already rolled back */ }
    throw e;
  }
}
