// `admin.backup.snapshot` (M8 backup, docs/superpowers/plans/2026-10-06-m8-backup-restore.md): stages the consistent,
// engine-owned part of a backup. The CLI (`plur1bus backup create`) packs what lands here and removes the directory.
//
// RULING R1: the pinned engine has no snapshot method on `Engine.admin`; what it ships is the Node module
// `lib/snapshot/store-snapshot.js` (HM1-R8: LanceDB-aware copy that re-checks the table manifest, `node:` builtins
// only). It is bound here, nothing in Rust copies store files. An engine `admin.snapshot` would replace the deep import.
// RULING R6: SQLite databases under `state/` go through the SQLite backup API (`node:sqlite` `backup`), never a file copy.
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import * as nodeFs from "node:fs/promises";
import { mkdir, readFile, readdir, rm, stat } from "node:fs/promises";
import { DatabaseSync, backup } from "node:sqlite";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import type * as E from "@cyb3rb1ade/plur1bus-memory/types/engine.js";
import { SnapshotError, createSnapshot, verifySnapshot } from "@cyb3rb1ade/plur1bus-memory/lib/snapshot/store-snapshot.js";
import type { AdminBackupSnapshotParams, AdminBackupSnapshotResult } from "@plur1bus/rpc-schema";
import type { HarnessLogger } from "./logger.ts";
import type { Layout } from "./paths.ts";
import { RpcError } from "./rpc/errors.ts";
import type { Handler } from "./rpc/server.ts";

export const BACKUP_METHODS = ["admin.backup.snapshot"] as const;

/** Where staged snapshots live: inside the state dir, never the engine's own `memory/.snapshots`. */
export const STAGING_DIR = "backup-staging";
const SQLITE_EXT = /\.(sqlite|sqlite3|db)$/i;

export interface BackupDeps {
  engine: E.Engine; layout: Layout; logger: HarnessLogger; isStopping: () => boolean;
  /** The engine's store path as the core configured it (`buildEngineConfig`). */
  baseDbPath: string;
  /** Test seam: a clock for the snapshot id. */
  now?: () => number;
}

const sha256File = (path: string): Promise<string> => new Promise((ok, fail) => {
  const h = createHash("sha256");
  createReadStream(path).on("data", (c) => h.update(c)).on("error", fail).on("end", () => ok(h.digest("hex")));
});

/** The engine's `createSnapshot` fsyncs every file it stages and the staging directories (`hashAndSync`, `fsyncDir`).
 *  On macOS libuv's fsync is `F_FULLFSYNC` (a drive cache flush, far slower than on Linux). Measured on a Mac: this is NOT
 *  what made the call time out (that was the lost event-loop wake-up of `backup()`, see `withLoopKeepalive`), but it is
 *  pure cost all the same. The staging directory is scratch: the caller packs it into the archive (which is what must
 *  be durable) and removes it, and a failed or killed snapshot is swept as stale staging. So the staged copy is never
 *  fsynced. */
export function stagingFs(base: typeof nodeFs = nodeFs): typeof nodeFs {
  return {
    ...base,
    open: (async (...args: Parameters<typeof nodeFs.open>) => {
      const fh = await base.open(...args);
      return new Proxy(fh, {
        get(target, prop) {
          if (prop === "sync" || prop === "datasync") return async () => {};
          const v = Reflect.get(target, prop, target);
          return typeof v === "function" ? v.bind(target) : v;
        },
      });
    }) as typeof nodeFs.open,
  };
}

const toPosix = (p: string): string => p.split(sep).join("/");

/** `node:sqlite`'s `backup()` can leave its promise pending while the event loop sleeps: the step finishes on the
 *  thread pool, but nothing wakes the loop to run the continuation. The promise then settles only when some unrelated
 *  timer or socket event happens to wake it (observed on macOS, Node 26: stalls of 0.1 s, 8 s, 16 s and up to the 30 s
 *  call timeout, with the main thread and every pool thread idle in the meantime; the handler then "finished" after the
 *  caller had already given up). A short, ref'd interval bounds the loop's sleep for as long as the snapshot runs. */
export async function withLoopKeepalive<T>(fn: () => Promise<T>, everyMs = 20): Promise<T> {
  const tick = setInterval(() => {}, everyMs);
  try { return await fn(); } finally { clearInterval(tick); }
}

/** SQLite's sidecar files (`<db>-wal`, `<db>-shm`, `<db>-journal`): live-connection state, never part of a backup. */
export const isSqliteSidecar = (name: string): boolean => /-(wal|shm|journal)$/i.test(name);

/** Copies one database with the SQLite backup API (a consistent snapshot that includes what is still in the WAL) and
 *  leaves a self-contained single file: the copy inherits the WAL journal mode of its source, so it is switched to
 *  `DELETE`, which folds the WAL in and removes `-wal`/`-shm` again. Opening it read-only instead would CREATE those
 *  sidecars next to the copy, and they would end up in the archive plan ("unit state/x.sqlite-shm is not allowed"). */
export async function copyDatabase(src: string, dest: string, shown: string = dest): Promise<void> {
  const db = new DatabaseSync(src, { readOnly: true });
  try { await withLoopKeepalive(() => backup(db, dest)); } finally { db.close(); }
  const copy = new DatabaseSync(dest);
  try {
    copy.exec("PRAGMA journal_mode=DELETE");
    const row = copy.prepare("PRAGMA quick_check").get() as { quick_check?: string } | undefined;
    if (row?.quick_check !== "ok") throw new RpcError("E_STORAGE", `SQLite copy of ${shown} failed its integrity check`, { reason: "sqlite-corrupt" });
  } finally { copy.close(); }
  for (const side of ["-wal", "-shm", "-journal"]) await rm(dest + side, { force: true });
}

/** `state/<…>` databases to back up: not the lock, the store, the engine's snapshots or this staging area. Symlinks are never followed. */
async function findDatabases(state: string, skip: readonly string[]): Promise<string[]> {
  const out: string[] = [];
  const walk = async (dir: string): Promise<void> => {
    let entries;
    try { entries = await readdir(dir, { withFileTypes: true }); } catch (e) { if ((e as NodeJS.ErrnoException).code === "ENOENT") return; throw e; }
    for (const ent of entries) {
      const p = join(dir, ent.name);
      if (skip.some((s) => p === s)) continue;
      if (ent.isDirectory()) await walk(p);
      else if (ent.isFile() && SQLITE_EXT.test(ent.name) && !isSqliteSidecar(ent.name) && ent.name !== "core.lock") out.push(p);
    }
  };
  await walk(state);
  return out.sort();
}

export function buildBackupMethods(d: BackupDeps): Record<(typeof BACKUP_METHODS)[number], Handler> {
  const stopping = () => new RpcError("E_CORE_UNAVAILABLE", "core is stopping", { reason: "core-stopping" });

  return {
    "admin.backup.snapshot": (p: AdminBackupSnapshotParams): Promise<AdminBackupSnapshotResult> => withLoopKeepalive(async () => {
      if (d.isStopping()) throw stopping();
      const home = resolve(d.layout.home); const state = resolve(d.layout.state); const base = resolve(d.baseDbPath);
      // RULING R8: a store outside the home cannot be restored to a place the manifest names; refuse, do not guess.
      const rel = relative(home, base);
      if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) {
        throw new RpcError("E_STORAGE", "the store lives outside the home and cannot be part of a backup", { reason: "store-outside-home" });
      }
      const root = join(state, STAGING_DIR);
      await mkdir(root, { recursive: true, mode: 0o700 });
      try {
        const snap = await createSnapshot({
          stateDir: state, baseDbPath: base, snapshotsDir: root, ...(p.label !== undefined ? { label: p.label } : {}),
          // The engine implements `fsImpl` (its JSDoc) but its .d.ts omits it, hence the spread of a variable.
          ...({ fsImpl: stagingFs() } as object),
          ...(d.now ? { now: d.now } : {}),
        });
        // Belt and braces: the engine's own digests, re-read from the copy before anything else is added to it.
        await verifySnapshot({ dir: snap.dir });
        const files: AdminBackupSnapshotResult["files"] = [];
        const manifest = JSON.parse(await readFile(join(snap.dir, "snapshot.json"), "utf8")) as { files: Array<{ path: string; bytes: number; sha256: string }> };
        for (const f of manifest.files) files.push({ path: f.path, bytes: f.bytes, sha256: f.sha256 });

        const dbs = await findDatabases(state, [join(state, "core.lock"), base, join(state, "memory", ".snapshots"), join(state, "journal"), join(state, "system-jobs"), root]);
        for (const src of dbs) {
          if (d.isStopping()) throw stopping();
          const relPath = `sqlite/${toPosix(relative(state, src))}`;
          const dest = join(snap.dir, ...relPath.split("/"));
          await mkdir(dirname(dest), { recursive: true });
          await copyDatabase(src, dest, relPath);
          files.push({ path: relPath, bytes: (await stat(dest)).size, sha256: await sha256File(dest) });
        }
        const es = await d.engine.status();
        d.logger.info("backup snapshot staged", { id: snap.id, files: files.length, bytes: snap.bytes });
        return {
          id: snap.id, dir: snap.dir, storeTarget: toPosix(rel), engine: { contract: d.engine.contract, storeSchema: es.storeSchema?.current ?? null },
          files: files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0)),
        };
      } catch (e) {
        if (e instanceof SnapshotError) {
          throw new RpcError("E_STORAGE", e.message, { reason: e.reason });
        }
        throw e;
      }
    }),
  };
}
