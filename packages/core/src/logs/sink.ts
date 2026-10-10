import { chmodSync, closeSync, existsSync, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync, readdirSync, renameSync, rmSync, statSync, utimesSync, writeSync } from "node:fs";
import path from "node:path";
import { acquireExclusiveLock, createSecurePath, type SecurePath } from "@plur1bus/module-api";
const DAY = 86400000;
/** No persistent descriptors: rotation/pruning also work on Windows. All writers of a role share the native lock. */
export function createSink(o: { dir: string; role: string; now: () => number; maxBytes?: number; keep?: number; retentionDays?: number; securePath?: SecurePath }) {
  if (!/^[a-z0-9][a-z0-9._-]{0,127}$/.test(o.role) || /^(audit|payload)(\.|$)/.test(o.role)) throw new RangeError("diagnostic role required");
  mkdirSync(o.dir, { recursive: true, mode: 0o700 });
  if (!lstatSync(o.dir).isDirectory()) throw new Error("log directory is not a directory");
  const securePath = o.securePath ?? createSecurePath();
  let securedIdentity: string | null = null; let dirty = false;
  const secure = (p: string, mode: number) => { const r = securePath(p, { mode }); if (!r.applied) throw new Error("cannot secure log path"); };
  const file = path.join(o.dir, `${o.role}.log`); let maxBytes = o.maxBytes ?? 20 * 1024 * 1024; let keep = o.keep ?? 5;
  const retentionDays = o.retentionDays ?? 14;
  if (!Number.isSafeInteger(retentionDays) || retentionDays < 0) throw new RangeError("invalid retention days");
  const locked = <T>(lockPath: string, waitMs: number, fn: () => T): T => {
    let lock = acquireExclusiveLock(lockPath); const deadline = Date.now() + waitMs;
    while (!lock) {
      if (Date.now() >= deadline) throw new Error("log writer busy");
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);
      lock = acquireExclusiveLock(lockPath);
    }
    try { return fn(); } finally { lock.release(); }
  };
  const directoryLock = path.join(o.dir, ".directory-security-lock");
  locked(directoryLock, 30_000, () => {
    secure(o.dir, 0o700);
    secure(directoryLock, 0o600);
  });
  const regular = (p: string) => { if (existsSync(p) && !lstatSync(p).isFile()) throw new Error("log path is not a regular file"); };
  // Caller holds the role lock. Info/debug appends are immediately visible; a timer,
  // explicit flush, warning, close or rotation pays the disk-sync cost once per batch.
  const syncDirty = (force = false) => {
    if (!dirty && !force) return;
    regular(file);
    const fd = openSync(file, "a", 0o600);
    try { fsyncSync(fd); dirty = false; } finally { closeSync(fd); }
  };
  const rotate = () => {
    // Another writer may have appended without syncing under the shared role
    // lock. Our own dirty flag cannot describe that writer's pending batch.
    syncDirty(true); // never rename an unsynced diagnostic batch
    regular(file); regular(`${file}.${keep}`); rmSync(`${file}.${keep}`, { force: true });
    for (let i = keep - 1; i >= 1; i--) { const p = `${file}.${i}`; regular(p); regular(`${file}.${i + 1}`); if (existsSync(p)) renameSync(p, `${file}.${i + 1}`); }
    if (existsSync(file)) renameSync(file, `${file}.1`);
    securedIdentity = null;
  };
  return {
    file,
    setRotation(r: { maxBytes: number; keep: number }) { if (!Number.isFinite(r.maxBytes) || r.maxBytes <= 0 || !Number.isInteger(r.keep) || r.keep < 1) throw new RangeError("invalid rotation"); maxBytes = r.maxBytes; keep = r.keep; },
    append(line: string, durable = true) {
      locked(`${file}.writer-lock`, 5000, () => {
        regular(file);
        if (existsSync(file)) { const st = statSync(file); if (st.size > 0 && (st.size + Buffer.byteLength(line) > maxBytes || Math.floor(st.mtimeMs / DAY) < Math.floor(o.now() / DAY))) rotate(); }
        const fd = openSync(file, "a", 0o600);
        try {
          const st = fstatSync(fd); const identity = `${st.dev}:${st.ino}:${st.birthtimeMs}`;
          if (identity !== securedIdentity) {
            if (process.platform !== "win32") chmodSync(file, 0o600);
            secure(file, 0o600); securedIdentity = identity;
          }
          const buf = Buffer.from(line); if (writeSync(fd, buf) !== buf.length) throw new Error("short log write");
          dirty = true;
          if (durable) { fsyncSync(fd); dirty = false; }
        }
        finally { closeSync(fd); }
        utimesSync(file, new Date(o.now()), new Date(o.now()));
      });
    },
    sync() {
      if (dirty) locked(`${file}.writer-lock`, 5000, syncDirty);
    },
    prune(): { files: number; bytes: number } {
      return locked(`${file}.writer-lock`, 5000, () => {
        let files = 0; let bytes = 0;
        if (retentionDays === 0) return { files, bytes };
        for (const name of readdirSync(o.dir)) {
          // Only this role's rotated diagnostics; never current, audit, payload or another writer's files.
          if (!name.startsWith(`${o.role}.log.`) || !/^\d+$/.test(name.slice(`${o.role}.log.`.length))) continue;
          const p = path.join(o.dir, name); const st = lstatSync(p);
          if (st.isFile() && st.mtimeMs < o.now() - retentionDays * DAY) { rmSync(p); files++; bytes += st.size; }
        }
        return { files, bytes };
      });
    },
  };
}
