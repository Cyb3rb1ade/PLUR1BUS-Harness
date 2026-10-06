// The budget usage store (L8): one node:sqlite database under state/, migrated by PRAGMA user_version.
// The ledger holds counts and ids only: there is deliberately no column that could hold prompt or response content.
import { chmodSync, closeSync, mkdirSync, openSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

export const BUDGET_SCHEMA_VERSION = 1;

const MIGRATIONS: Record<number, string> = {
  1: `
    CREATE TABLE usage_event (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ts INTEGER NOT NULL,
      agent TEXT NOT NULL,
      provider TEXT NOT NULL DEFAULT '',
      model TEXT NOT NULL,
      input_tokens INTEGER NOT NULL CHECK (input_tokens >= 0),
      output_tokens INTEGER NOT NULL CHECK (output_tokens >= 0),
      cache_read_tokens INTEGER NOT NULL CHECK (cache_read_tokens >= 0),
      cache_write_tokens INTEGER NOT NULL CHECK (cache_write_tokens >= 0),
      cost_micros INTEGER CHECK (cost_micros IS NULL OR cost_micros >= 0),
      price_version TEXT NOT NULL,
      request_id TEXT UNIQUE
    );
    CREATE INDEX usage_event_agent_ts ON usage_event (agent, ts);
    CREATE INDEX usage_event_ts ON usage_event (ts);
    CREATE TABLE budget_limit (
      scope TEXT NOT NULL CHECK (scope IN ('global', 'agent')),
      agent TEXT NOT NULL,
      period TEXT NOT NULL CHECK (period IN ('day', 'month')),
      metric TEXT NOT NULL CHECK (metric IN ('cost', 'tokens')),
      soft INTEGER CHECK (soft IS NULL OR soft >= 0),
      hard INTEGER CHECK (hard IS NULL OR hard >= 0),
      CHECK (soft IS NOT NULL OR hard IS NOT NULL),
      CHECK (soft IS NULL OR hard IS NULL OR soft <= hard),
      CHECK ((scope = 'global' AND agent = '') OR (scope = 'agent' AND agent <> '')),
      PRIMARY KEY (scope, agent, period, metric)
    );
    CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE notice (
      kind TEXT NOT NULL CHECK (kind IN ('soft', 'hard')),
      scope TEXT NOT NULL,
      agent TEXT NOT NULL,
      period TEXT NOT NULL,
      metric TEXT NOT NULL,
      period_key TEXT NOT NULL,
      ts INTEGER NOT NULL,
      PRIMARY KEY (kind, scope, agent, period, metric, period_key)
    );
  `,
};

export class BudgetStoreError extends Error {
  readonly code: "newer-schema" | "open-failed";
  constructor(code: "newer-schema" | "open-failed", message: string) { super(message); this.name = "BudgetStoreError"; this.code = code; }
}

export interface OpenStoreOptions {
  path: string;
  /** Applies the platform's owner-only permissions (module-api's securePath); POSIX mode 0600 is always set. */
  securePath?: (p: string, o?: { mode?: number }) => void;
  busyTimeoutMs?: number;
}

export function openBudgetDb(o: OpenStoreOptions): DatabaseSync {
  try {
    mkdirSync(dirname(o.path), { recursive: true, mode: 0o700 });
    closeSync(openSync(o.path, "a", 0o600)); // created owner-only before SQLite (and its -wal/-shm, which inherit the mode) touches it
    try { chmodSync(o.path, 0o600); } catch { /* not POSIX */ }
    o.securePath?.(o.path, { mode: 0o600 });
  } catch (e) {
    throw new BudgetStoreError("open-failed", `cannot prepare ${o.path}: ${(e as Error).message}`);
  }
  const db = new DatabaseSync(o.path);
  try {
    db.exec(`PRAGMA busy_timeout = ${Math.max(0, Math.floor(o.busyTimeoutMs ?? 5000))}`);
    db.exec("PRAGMA journal_mode = WAL");
    db.exec("PRAGMA synchronous = NORMAL");
    migrate(db);
  } catch (e) {
    try { db.close(); } catch { /* already closed */ }
    throw e;
  }
  return db;
}

const userVersion = (db: DatabaseSync): number => Number((db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version);

function migrate(db: DatabaseSync): void {
  if (userVersion(db) === BUDGET_SCHEMA_VERSION) return;
  db.exec("BEGIN IMMEDIATE");
  try {
    let v = userVersion(db); // re-read under the write lock: another process may have migrated meanwhile
    if (v > BUDGET_SCHEMA_VERSION) throw new BudgetStoreError("newer-schema", `budget store schema ${v} is newer than this core's ${BUDGET_SCHEMA_VERSION}`);
    while (v < BUDGET_SCHEMA_VERSION) {
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

/** Runs `fn` in an IMMEDIATE transaction (write lock up front, so two processes serialise instead of failing on upgrade). */
export function transaction<T>(db: DatabaseSync, fn: () => T): T {
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
