// Read-only primitives for the importer (docs/import.md §8.2). Nothing here writes to a source path: SQLite is read
// from a private copy (or opened immutable), LanceDB is resolved through the pinned engine package, `.env` files
// yield key names only.
import { closeSync, existsSync, fstatSync, mkdtempSync, openSync, readFileSync, readSync, rmSync, statSync, writeSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { pathToFileURL } from "node:url";
import { readSourceFileSafe } from "./fs-safe.ts";
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
  let text: string;
  try {
    text = readSourceFileSafe(path, 1024 * 1024).toString("utf8");
  } catch {
    return [];
  }
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
  /** Test seam: custom file copy implementation (defaults to copyFileBounded). */
  copyFile?: (src: string, dst: string, limit: number) => void;
}

/** Copy attempts before a changing database counts as busy (one copy plus three retries, spec §B.5). */
export const SQLITE_COPY_ATTEMPTS = 4;
const BACKOFF_MS = [50, 200, 800];
const sleeper = new Int32Array(new SharedArrayBuffer(4));

const COPY_CHUNK_SIZE = 64 * 1024;

/** Safely copies a file up to maxBytes without hanging if the source shrinks or is truncated concurrently (§8.2). */
export function copyFileBounded(src: string, dst: string, maxBytes: number): { bytesCopied: number; initialSize: number } {
  const srcFd = openSync(src, "r");
  let dstFd: number | null = null;
  try {
    const st = fstatSync(srcFd);
    if (st.size > maxBytes) {
      throw new Error(`file ${src} exceeds copy limit (${st.size} > ${maxBytes})`);
    }
    const targetSize = st.size;
    dstFd = openSync(dst, "w", 0o600);
    if (targetSize === 0) {
      return { bytesCopied: 0, initialSize: 0 };
    }
    const buf = Buffer.allocUnsafe(Math.min(COPY_CHUNK_SIZE, targetSize));
    let bytesCopied = 0;
    const maxChunks = Math.ceil(targetSize / COPY_CHUNK_SIZE) + 1;
    for (let chunk = 0; chunk < maxChunks && bytesCopied < targetSize; chunk++) {
      const toRead = Math.min(buf.length, targetSize - bytesCopied);
      const n = readSync(srcFd, buf, 0, toRead, bytesCopied);
      if (n === 0) break; // EOF reached early (source shrunk / truncated concurrently)
      writeSync(dstFd, buf, 0, n);
      bytesCopied += n;
    }
    return { bytesCopied, initialSize: targetSize };
  } finally {
    try { closeSync(srcFd); } catch {}
    if (dstFd !== null) {
      try { closeSync(dstFd); } catch {}
    }
  }
}

type Stamp = { size: number; mtimeMs: number } | null;
const stamp = (p: string): Stamp => { try { const st = statSync(p); return { size: st.size, mtimeMs: st.mtimeMs }; } catch { return null; } };
const same = (a: Stamp, b: Stamp) => (a === null ? b === null : b !== null && a.size === b.size && a.mtimeMs === b.mtimeMs);

/** SQLite primary error codes that indicate a database changing under an immutable reader:
 *  5: SQLITE_BUSY, 6: SQLITE_LOCKED, 10: SQLITE_IOERR (e.g. short read), 11: SQLITE_CORRUPT, 26: SQLITE_NOTADB (§B.5). */
export function isTornReadError(e: unknown): boolean {
  if (!e || typeof e !== "object") return false;
  const err = e as { errcode?: number };
  if (typeof err.errcode !== "number") return false;
  const primary = err.errcode & 0xff;
  return primary === 5 || primary === 6 || primary === 10 || primary === 11 || primary === 26;
}

export function wrapImmutableDb(db: DatabaseSync, abs: string): DatabaseSync {
  function translateError(e: unknown): never {
    if (e instanceof ImportError) throw e;
    if (isTornReadError(e)) {
      const errcode = (e as { errcode?: number }).errcode;
      throw new ImportError(
        "E_SOURCE_BUSY",
        "source-busy",
        `${abs} changed while reading immutable fallback (sqlite errcode ${errcode}); stop the source and retry`,
        3
      );
    }
    throw e;
  }

  function wrapIterator(iter: any): any {
    return {
      [Symbol.iterator]() {
        return this;
      },
      next(...args: any[]) {
        try {
          return iter.next(...args);
        } catch (e) {
          translateError(e);
        }
      },
      return(...args: any[]) {
        try {
          return typeof iter.return === "function" ? iter.return(...args) : { done: true, value: undefined };
        } catch (e) {
          translateError(e);
        }
      },
    };
  }

  function wrapStatement(stmt: any): any {
    return new Proxy(stmt, {
      get(target, prop, receiver) {
        const val = Reflect.get(target, prop, receiver);
        if (typeof val === "function") {
          return function (...args: any[]) {
            try {
              const res = val.apply(target, args);
              // Callers of the immutable path in packages/core/src/import use .all() or .get(),
              // but wrap iterators defensively so next() translates errors if iterate() is used.
              if (prop === "iterate" && res && typeof res.next === "function") {
                return wrapIterator(res);
              }
              return res;
            } catch (e) {
              translateError(e);
            }
          };
        }
        return val;
      },
    });
  }

  return new Proxy(db, {
    get(target, prop, receiver) {
      if (prop === "prepare") {
        return function (sql: string) {
          try {
            const stmt = target.prepare(sql);
            return wrapStatement(stmt);
          } catch (e) {
            translateError(e);
          }
        };
      }
      if (prop === "exec") {
        return function (sql: string) {
          try {
            return target.exec(sql);
          } catch (e) {
            translateError(e);
          }
        };
      }
      const val = Reflect.get(target, prop, receiver);
      if (typeof val === "function") {
        return function (...args: any[]) {
          try {
            return val.apply(target, args);
          } catch (e) {
            translateError(e);
          }
        };
      }
      return val;
    },
  });
}

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
    let rawDb: DatabaseSync;
    try {
      rawDb = new DatabaseSync(url, { readOnly: true });
    } catch (e) {
      if (isTornReadError(e)) {
        const errcode = (e as { errcode?: number }).errcode;
        throw new ImportError("E_SOURCE_BUSY", "source-busy", `${abs} kept changing while opening immutable fallback (sqlite errcode ${errcode}); stop the source and retry`, 3);
      }
      throw e;
    }
    const db = wrapImmutableDb(rawDb, abs);
    return { db, mode: "immutable", immutableReason: reason, attempts, close: () => rawDb.close() };
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
      const doCopy = opts.copyFile ?? copyFileBounded;
      doCopy(abs, copy, limit);
      if (before[1] !== null) doCopy(wal, `${copy}-wal`, limit);
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
