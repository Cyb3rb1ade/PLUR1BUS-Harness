// Read-only primitives for the importer (docs/import.md §8.2). Nothing here writes to a source path: SQLite is read
// from a private copy (or opened immutable), LanceDB is resolved through the pinned engine package, `.env` files
// yield key names only.
import { copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { pathToFileURL } from "node:url";

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

export interface SqliteHandle { db: DatabaseSync; mode: "copy" | "immutable"; close(): void }

/** Opens a SQLite database without ever writing next to it: a copy (db + WAL) in a private temp dir up to
 *  `maxCopyBytes`, else `immutable=1` read-only (the WAL is then not consulted). */
export function openSqliteReadOnly(path: string, opts: { maxCopyBytes?: number } = {}): SqliteHandle {
  const limit = opts.maxCopyBytes ?? SQLITE_COPY_LIMIT;
  const abs = resolve(path);
  const wal = `${abs}-wal`;
  const size = statSync(abs).size + (existsSync(wal) ? statSync(wal).size : 0);
  if (size <= limit) {
    const dir = mkdtempSync(join(tmpdir(), "p1b-import-sqlite-"));
    try {
      const copy = join(dir, basename(abs));
      copyFileSync(abs, copy);
      if (existsSync(wal)) copyFileSync(wal, `${copy}-wal`);
      const db = new DatabaseSync(copy);
      return { db, mode: "copy", close: () => { try { db.close(); } finally { rmSync(dir, { recursive: true, force: true }); } } };
    } catch (e) {
      rmSync(dir, { recursive: true, force: true });
      throw e;
    }
  }
  const url = new URL(`${pathToFileURL(abs).href}?immutable=1&mode=ro`);
  const db = new DatabaseSync(url, { readOnly: true });
  return { db, mode: "immutable", close: () => db.close() };
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
