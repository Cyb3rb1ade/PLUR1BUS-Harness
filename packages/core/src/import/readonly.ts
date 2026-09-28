// Read-only primitives for the importer (docs/import.md §8.2). Nothing here writes to a source path: SQLite is read
// from a private copy (or opened immutable), LanceDB is resolved through the pinned engine package, `.env` files
// yield key names only.
import { copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { pathToFileURL } from "node:url";
import { ImportError } from "./types.ts";

/** Databases up to this size (plus WAL) are copied to a temp dir and read there. */
export const SQLITE_COPY_LIMIT = 256 * 1024 * 1024;

/** A regular file's text (a symlink is followed: dotfile managers link config files), or null when it is missing,
 *  not a regular file or larger than `max`. Skill contents never go through this; the skill scan has its own rules. */
export function readBounded(path: string, max: number): string | null {
  try {
    const st = statSync(path);
    if (!st.isFile() || st.size > max) return null;
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
}

export function isFile(path: string): boolean {
  try { return statSync(path).isFile(); } catch { return false; }
}

export function isDir(path: string): boolean {
  try { return statSync(path).isDirectory(); } catch { return false; }
}

/** Key names of a dotenv file. The value part of each line is dropped as the line is parsed; nothing of it is returned. */
export function envKeyNames(path: string): string[] {
  const text = readBounded(path, 1024 * 1024);
  if (text === null) return [];
  const keys: string[] = [];
  for (const line of text.split(/\r?\n/)) {
    const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/.exec(line);
    if (m && !keys.includes(m[1]!)) keys.push(m[1]!);
  }
  return keys;
}

const SECRET_NAMES = new Set([".env", "auth.json", "credentials.json", ".netrc", ".npmrc", ".pypirc"]);
/** File names a skill copy never carries and a report never reads (credentials by convention). */
export function isSecretFileName(name: string): boolean {
  const n = name.toLowerCase();
  return SECRET_NAMES.has(n) || n.startsWith(".env.") || n.endsWith(".pem") || n.endsWith(".key") || n.startsWith("id_rsa") || n.startsWith("id_ed25519") || n.startsWith("id_ecdsa");
}

export interface SqliteHandle {
  db: DatabaseSync;
  mode: "copy" | "immutable";
  /** Why the database was opened `immutable=1` (its WAL not consulted): above the copy limit, or it kept changing
   *  while it was copied. */
  immutableReason: "too-large" | "source-busy" | null;
  /** Copy attempts made (0 for a database above the copy limit). */
  attempts: number;
  close(): void;
}

export interface SqliteOpenOptions {
  maxCopyBytes?: number;
  /** Where the private copy is made (default: the OS temp dir). */
  stagingDir?: string;
  /** A database that keeps changing: `immutable` (detect: warn and read without the WAL) or `throw` E_SOURCE_BUSY. */
  onBusy?: "immutable" | "throw";
  /** Test hooks: runs after each copy (attempt number, path of the copied db); replaces the backoff sleep. */
  afterCopy?: (attempt: number, copy: string) => void;
  sleep?: (ms: number) => void;
}

/** Copy attempts before a changing database counts as busy (one copy plus three retries, spec §B.5). */
export const SQLITE_COPY_ATTEMPTS = 4;
const BACKOFF_MS = [50, 200, 800];
const sleeper = new Int32Array(new SharedArrayBuffer(4));

type Stamp = { size: number; mtimeMs: number } | null;
const stamp = (p: string): Stamp => { try { const st = statSync(p); return { size: st.size, mtimeMs: st.mtimeMs }; } catch { return null; } };
const same = (a: Stamp, b: Stamp) => (a === null ? b === null : b !== null && a.size === b.size && a.mtimeMs === b.mtimeMs);

/** Opens a SQLite database without ever writing next to it (§8.2, plugin-distribution spec §B.5): a checked copy
 *  (db, then WAL) in a private staging dir up to `maxCopyBytes` — size and mtime of both are recorded before and
 *  after, and the copy must pass `PRAGMA quick_check`; a change or failure is retried with backoff, and after
 *  [SQLITE_COPY_ATTEMPTS] attempts the database is busy. Above the limit (or busy, by default) it is opened
 *  `immutable=1` read-only, and its WAL is then not consulted. */
export function openSqliteReadOnly(path: string, opts: SqliteOpenOptions = {}): SqliteHandle {
  const limit = opts.maxCopyBytes ?? SQLITE_COPY_LIMIT;
  const abs = resolve(path);
  const wal = `${abs}-wal`;
  const size = statSync(abs).size + (existsSync(wal) ? statSync(wal).size : 0);
  const immutable = (reason: "too-large" | "source-busy", attempts: number): SqliteHandle => {
    const url = new URL(`${pathToFileURL(abs).href}?immutable=1&mode=ro`);
    const db = new DatabaseSync(url, { readOnly: true });
    return { db, mode: "immutable", immutableReason: reason, attempts, close: () => db.close() };
  };
  if (size > limit) return immutable("too-large", 0);
  const sleep = opts.sleep ?? ((ms: number) => { Atomics.wait(sleeper, 0, 0, ms); });
  let lastError: unknown = null;
  for (let attempt = 1; attempt <= SQLITE_COPY_ATTEMPTS; attempt++) {
    if (attempt > 1) sleep(BACKOFF_MS[attempt - 2] ?? 800);
    const dir = mkdtempSync(join(opts.stagingDir ?? tmpdir(), "p1b-import-sqlite-"));
    const drop = () => rmSync(dir, { recursive: true, force: true });
    let db: DatabaseSync | null = null;
    try {
      const before = [stamp(abs), stamp(wal)] as const;
      const copy = join(dir, basename(abs));
      copyFileSync(abs, copy);
      if (before[1] !== null) copyFileSync(wal, `${copy}-wal`);
      opts.afterCopy?.(attempt, copy);
      if (!same(before[0], stamp(abs)) || !same(before[1], stamp(wal))) { drop(); lastError = new Error("changed during copy"); continue; }
      db = new DatabaseSync(copy);
      const check = db.prepare("PRAGMA quick_check").all() as Record<string, unknown>[];
      if (check.length !== 1 || Object.values(check[0]!)[0] !== "ok") { db.close(); drop(); lastError = new Error("quick_check failed"); continue; }
      const open = db;
      return { db: open, mode: "copy", immutableReason: null, attempts: attempt, close: () => { try { open.close(); } finally { drop(); } } };
    } catch (e) {
      try { db?.close(); } catch { /* already closed */ }
      drop();
      lastError = e;
    }
  }
  if (opts.onBusy === "throw") throw new ImportError("E_SOURCE_BUSY", "source-busy", `${abs} kept changing while it was copied (${SQLITE_COPY_ATTEMPTS} attempts; last: ${(lastError as Error)?.message ?? lastError}); stop the source and retry`, 3);
  return immutable("source-busy", SQLITE_COPY_ATTEMPTS);
}

/** The report warning for a database read `immutable=1`, or null for a checked copy. */
export function sqliteWarning(h: SqliteHandle, label: string): string | null {
  if (h.immutableReason === "too-large") return `${label}: larger than the copy limit, read without its WAL`;
  if (h.immutableReason === "source-busy") return `${label}: kept changing while it was copied (source-busy); read without its WAL — stop the source for an exact read`;
  return null;
}

/** Table names of an open database. */
export function sqliteTables(db: DatabaseSync): string[] {
  return (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[]).map((r) => r.name);
}

// The engine's own LanceDB: the source store is read with the library version the engine writes it with. Resolved
// from the pinned engine package (it is the engine's dependency, not the core's); null when unavailable.
type LanceDb = { connect(uri: string, opts?: Record<string, unknown>): Promise<LanceConnection> };
export interface LanceConnection { tableNames(): Promise<string[]>; openTable(name: string): Promise<LanceTable>; close(): void }
export interface LanceTable {
  schema(): Promise<{ fields: { name: string; type: { listSize?: number; toString(): string } }[] }>;
  countRows(): Promise<number>;
  query(): { select(cols: string[]): { toArray(): Promise<Record<string, unknown>[]> } };
  close(): void;
}
let lanceCache: Promise<LanceDb | null> | undefined;
export function loadLanceDb(): Promise<LanceDb | null> {
  lanceCache ??= (async () => {
    try {
      const require = createRequire(import.meta.resolve("@cyb3rb1ade/plur1bus-memory/package.json"));
      return require("@lancedb/lancedb") as LanceDb;
    } catch {
      return null;
    }
  })();
  return lanceCache;
}
