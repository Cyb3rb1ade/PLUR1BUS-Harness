/** Logical target SQLite identity survives normal WAL checkpoint/close. A live target database is never opened. */
import { createHash } from "node:crypto";
import { lstat, mkdtemp, open, rm } from "node:fs/promises";
import { constants } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { DatabaseSync } from "node:sqlite";
import { setImmediate as yieldEventLoop, setTimeout as delay } from "node:timers/promises";
import { coldUnavailable, noLinkedSegments, streamRegular } from "./maintenance-files.ts";

const SQLITE_HEADER = Buffer.from("SQLite format 3\0");
const RETRIES = 3;
const quote = (name: string) => `"${name.replaceAll('"', '""')}"`;

async function stamp(path: string) {
  try {
    const value = await lstat(path);
    if (!value.isFile() || value.isSymbolicLink()) throw coldUnavailable();
    return { dev: value.dev, ino: value.ino, size: value.size, mtimeMs: value.mtimeMs };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

async function isSqlite(path: string): Promise<boolean> {
  await noLinkedSegments(path);
  const file = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const buffer = Buffer.alloc(SQLITE_HEADER.length);
    const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
    return bytesRead === SQLITE_HEADER.length && buffer.equals(SQLITE_HEADER);
  } finally {
    await file.close();
  }
}

function cell(value: unknown): unknown {
  if (value === null) return ["null"];
  if (typeof value === "bigint") return ["integer", value.toString()];
  if (typeof value === "number") return ["real", Object.is(value, -0) ? "-0" : value.toString()];
  if (typeof value === "string") return ["text", value];
  if (value instanceof Uint8Array) return ["blob", Buffer.from(value).toString("hex")];
  throw coldUnavailable();
}

async function logicalHash(path: string, signal?: AbortSignal): Promise<string> {
  const db = new DatabaseSync(path, { readOnly: true, allowExtension: false });
  try {
    db.exec("PRAGMA query_only=ON; PRAGMA trusted_schema=OFF; BEGIN");
    const digest = createHash("sha256");
    const add = (value: unknown) => digest.update(JSON.stringify(value) + "\n");
    add(["sqlite-logical/1", db.prepare("PRAGMA user_version").get(), db.prepare("PRAGMA application_id").get()]);
    const schema = db.prepare("SELECT type,name,tbl_name,sql FROM sqlite_schema"
      + " WHERE name NOT LIKE 'sqlite_stat%' ORDER BY type,name").all() as Record<string, unknown>[];
    for (const record of schema) add(record);
    for (const record of schema) {
      if (record.type !== "table" || typeof record.name !== "string") continue;
      signal?.throwIfAborted();
      const columns = db.prepare(`PRAGMA table_xinfo(${quote(record.name)})`).all() as {
        name: string; pk: number; hidden: number;
      }[];
      const primary = columns.filter(column => column.pk > 0).sort((a, b) => a.pk - b.pk);
      const alias = ["rowid", "_rowid_", "oid"].find(name => !columns.some(column => column.name === name));
      const withoutRowId = typeof record.sql === "string" && /\bWITHOUT\s+ROWID\b/i.test(record.sql);
      const order = primary.length ? primary.map(column => quote(column.name)).join(",")
        : alias && !withoutRowId ? quote(alias) : columns.map(column => quote(column.name)).join(",");
      const rows = db.prepare(`SELECT * FROM ${quote(record.name)}${order ? ` ORDER BY ${order}` : ""}`);
      rows.setReadBigInts(true);
      add(["table", record.name, columns.map(column => column.name)]);
      let count = 0;
      for (const row of rows.iterate()) {
        signal?.throwIfAborted();
        add(Object.values(row).map(cell));
        if (++count % 256 === 0) await yieldEventLoop(undefined, { signal });
      }
    }
    return digest.digest("hex");
  } finally {
    db.close();
  }
}

/** Copies db then WAL with before/after stamps and retries a busy source; no immutable fallback may miss pending rows. */
export async function logicalSqliteFingerprint(path: string, signal?: AbortSignal): Promise<string | undefined> {
  if (!await isSqlite(path)) return undefined;
  for (let attempt = 0; attempt < RETRIES; attempt++) {
    signal?.throwIfAborted();
    if (attempt) await delay(attempt * 50, undefined, { signal });
    const directory = await mkdtemp(join(tmpdir(), "p1b-target-sqlite-"));
    try {
      const before = [await stamp(path), await stamp(path + "-wal")];
      if (!before[0]) throw coldUnavailable();
      const copy = join(directory, "target.sqlite");
      await streamRegular(path, { destination: copy, signal });
      if (before[1]) await streamRegular(path + "-wal", { destination: copy + "-wal", signal });
      const after = [await stamp(path), await stamp(path + "-wal")];
      if (JSON.stringify(before) !== JSON.stringify(after)) continue;
      const db = new DatabaseSync(copy);
      try {
        const checked = db.prepare("PRAGMA quick_check").all();
        if (checked.length !== 1 || Object.values(checked[0]!)[0] !== "ok") continue;
      } finally {
        db.close();
      }
      return await logicalHash(copy, signal);
    } catch {
      if (signal?.aborted || attempt === RETRIES - 1) throw coldUnavailable();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }
  throw coldUnavailable();
}
