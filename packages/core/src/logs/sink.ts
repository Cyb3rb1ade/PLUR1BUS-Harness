import { chmodSync, closeSync, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, readdirSync, renameSync, rmSync, statSync, utimesSync, writeSync } from "node:fs";
import path from "node:path";
import { acquireExclusiveLock, createSecurePath } from "@plur1bus/module-api";
const DAY = 86400000;
/** No persistent descriptors: rotation/pruning also work on Windows. All writers of a role share the native lock. */
export function createSink(o: { dir: string; role: string; now: () => number; maxBytes?: number; keep?: number; retentionDays?: number }) {
  if (!/^[a-z0-9][a-z0-9._-]{0,127}$/.test(o.role) || /^(audit|payload)(\.|$)/.test(o.role)) throw new RangeError("diagnostic role required");
  mkdirSync(o.dir, { recursive: true, mode: 0o700 });
  if (!lstatSync(o.dir).isDirectory()) throw new Error("log directory is not a directory");
  const securePath = createSecurePath();
  const secure = (p: string, mode: number) => { const r = securePath(p, { mode }); if (!r.applied) throw new Error("cannot secure log path"); };
  secure(o.dir, 0o700);
  const file = path.join(o.dir, `${o.role}.log`); let maxBytes = o.maxBytes ?? 20 * 1024 * 1024; let keep = o.keep ?? 5;
  const retentionDays = o.retentionDays ?? 14;
  if (!Number.isSafeInteger(retentionDays) || retentionDays < 0) throw new RangeError("invalid retention days");
  const locked = <T>(fn: () => T): T => {
    let lock = acquireExclusiveLock(`${file}.writer-lock`); const deadline = Date.now() + 5000;
    while (!lock) {
      if (Date.now() >= deadline) throw new Error("log writer busy");
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);
      lock = acquireExclusiveLock(`${file}.writer-lock`);
    }
    try { return fn(); } finally { lock.release(); }
  };
  const regular = (p: string) => { if (existsSync(p) && !lstatSync(p).isFile()) throw new Error("log path is not a regular file"); };
  const rotate = () => {
    regular(file); regular(`${file}.${keep}`); rmSync(`${file}.${keep}`, { force: true });
    for (let i = keep - 1; i >= 1; i--) { const p = `${file}.${i}`; regular(p); regular(`${file}.${i + 1}`); if (existsSync(p)) renameSync(p, `${file}.${i + 1}`); }
    if (existsSync(file)) renameSync(file, `${file}.1`);
  };
  return {
    file,
    setRotation(r: { maxBytes: number; keep: number }) { if (!Number.isFinite(r.maxBytes) || r.maxBytes <= 0 || !Number.isInteger(r.keep) || r.keep < 1) throw new RangeError("invalid rotation"); maxBytes = r.maxBytes; keep = r.keep; },
    append(line: string) {
      locked(() => {
        regular(file);
        if (existsSync(file)) { const st = statSync(file); if (st.size > 0 && (st.size + Buffer.byteLength(line) > maxBytes || Math.floor(st.mtimeMs / DAY) < Math.floor(o.now() / DAY))) rotate(); }
        const fd = openSync(file, "a", 0o600);
        try { if (process.platform !== "win32") chmodSync(file, 0o600); secure(file, 0o600); const buf = Buffer.from(line); if (writeSync(fd, buf) !== buf.length) throw new Error("short log write"); fsyncSync(fd); }
        finally { closeSync(fd); }
        utimesSync(file, new Date(o.now()), new Date(o.now()));
      });
    },
    prune(): { files: number; bytes: number } {
      return locked(() => {
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
