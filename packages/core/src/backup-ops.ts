// `admin.backup.snapshot` (M8 backup, docs/superpowers/plans/2026-10-06-m8-backup-restore.md): stages the consistent,
// engine-owned part of a backup. The CLI (`plur1bus backup create`) packs what lands here and removes the directory.
//
// RULING R1: the pinned engine has no snapshot method on `Engine.admin`; what it ships is the Node module
// `lib/snapshot/store-snapshot.js` (HM1-R8: LanceDB-aware copy that re-checks the table manifest, `node:` builtins
// only). It is bound here, nothing in Rust copies store files. An engine `admin.snapshot` would replace the deep import.
// RULING R6: SQLite databases under `state/` go through the SQLite backup API (`node:sqlite` `backup`), never a file copy.
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, readFile, readdir, stat } from "node:fs/promises";
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

const toPosix = (p: string): string => p.split(sep).join("/");

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
      else if (ent.isFile() && SQLITE_EXT.test(ent.name) && ent.name !== "core.lock") out.push(p);
    }
  };
  await walk(state);
  return out.sort();
}

export function buildBackupMethods(d: BackupDeps): Record<(typeof BACKUP_METHODS)[number], Handler> {
  const stopping = () => new RpcError("E_CORE_UNAVAILABLE", "core is stopping", { reason: "core-stopping" });

  return {
    "admin.backup.snapshot": async (p: AdminBackupSnapshotParams): Promise<AdminBackupSnapshotResult> => {
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
          const db = new DatabaseSync(src, { readOnly: true });
          try { await backup(db, dest); } finally { db.close(); }
          const copy = new DatabaseSync(dest, { readOnly: true });
          try {
            const row = copy.prepare("PRAGMA quick_check").get() as { quick_check?: string } | undefined;
            if (row?.quick_check !== "ok") throw new RpcError("E_STORAGE", `SQLite copy of ${relPath} failed its integrity check`, { reason: "sqlite-corrupt" });
          } finally { copy.close(); }
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
    },
  };
}
