// Store round-trip helper (P4-02, parity mode B), TypeScript side.
//
// The Rust stores read and write the same SQLite files as the TypeScript core (owner ruling 4: same files, no migration).
// Parity for a store is therefore: TS writes a file, Rust reads and writes it, TS reads it again, at every schema version.
// This helper opens a COPY of a core store in a temp dir (the original is never touched, and a live WAL is copied along),
// and exposes write, read and a check of `PRAGMA user_version`, integrity and foreign keys. A Rust test drives the same
// copy through the files: it gets the copy's path from `StoreCopy.path` or builds a version fixture with
// `createStoreAtVersion` and hands it to the Rust side.
import { copyFileSync, existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { DatabaseSync } from "node:sqlite";

export type SqlValue = string | number | bigint | null | Uint8Array;
export interface StoreCheck { userVersion: number; integrity: string; foreignKeyViolations: number; journalMode: string }

/** Creates `path` with the first `version` of `migrations` applied through the store's own `migrate` function, so the
 *  file is what the core wrote at that schema version. */
export function createStoreAtVersion(o: { path: string; migrations: readonly string[]; version: number; migrate(db: DatabaseSync, migrations: readonly string[]): number }): void {
  if (!Number.isInteger(o.version) || o.version < 1 || o.version > o.migrations.length) throw new RangeError(`version must be 1..${o.migrations.length}, got ${o.version}`);
  const db = new DatabaseSync(o.path);
  try {
    const reached = o.migrate(db, o.migrations.slice(0, o.version));
    if (reached !== o.version) throw new Error(`migrate() reached ${reached}, wanted ${o.version}`);
  } finally { db.close(); }
}

export class StoreCopy {
  readonly path: string;
  readonly #dir: string;
  #db: DatabaseSync | null = null;

  private constructor(dir: string, path: string) { this.#dir = dir; this.path = path; }

  /** Copies `source` (and `-wal`/`-shm` when present) into a fresh temp dir. The copy is not opened until first used. */
  static open(source: string): StoreCopy {
    if (!existsSync(source)) throw new Error(`store not found: ${source}`);
    const dir = mkdtempSync(join(tmpdir(), "p1b-store-copy-"));
    const path = join(dir, basename(source));
    copyFileSync(source, path);
    for (const suffix of ["-wal", "-shm"]) if (existsSync(source + suffix)) copyFileSync(source + suffix, path + suffix);
    return new StoreCopy(dir, path);
  }

  get #handle(): DatabaseSync { return (this.#db ??= new DatabaseSync(this.path)); }

  userVersion(): number { return Number(this.#handle.prepare("PRAGMA user_version").get()!.user_version); }

  assertUserVersion(expected: number): void {
    const found = this.userVersion();
    if (found !== expected) throw new Error(`${basename(this.path)}: user_version is ${found}, expected ${expected}`);
  }

  /** Runs one statement in an immediate transaction (the single-writer discipline of the core); returns the changes. */
  write(sql: string, ...params: SqlValue[]): number {
    const db = this.#handle;
    db.exec("BEGIN IMMEDIATE");
    try { const r = db.prepare(sql).run(...params); db.exec("COMMIT"); return Number(r.changes); }
    catch (e) { db.exec("ROLLBACK"); throw e; }
  }

  read(sql: string, ...params: SqlValue[]): Array<Record<string, SqlValue>> {
    return this.#handle.prepare(sql).all(...params).map((row) => ({ ...row })) as Array<Record<string, SqlValue>>; // node:sqlite rows have a null prototype
  }

  /** Applies the store's own migrate function to the copy (the upgrade path the Rust runner must match). */
  migrateWith(migrate: (db: DatabaseSync) => number): number { return migrate(this.#handle); }

  check(): StoreCheck {
    const db = this.#handle;
    const integrity = db.prepare("PRAGMA integrity_check").all().map((r) => String(r.integrity_check)).join("; ");
    return {
      userVersion: this.userVersion(), integrity,
      foreignKeyViolations: db.prepare("PRAGMA foreign_key_check").all().length,
      journalMode: String(db.prepare("PRAGMA journal_mode").get()!.journal_mode),
    };
  }

  /** Closes the copy and removes its temp dir. */
  dispose(): void {
    try { this.#db?.close(); } catch { /* already closed */ }
    this.#db = null;
    rmSync(this.#dir, { recursive: true, force: true });
  }
}
