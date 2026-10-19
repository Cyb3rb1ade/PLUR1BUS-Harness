// Atomic file utilities for import pipeline and rollback (Batch 4).
// Synchronously writes to temporary files, fsyncs, renames into place,
// and enforces boundary-aware path containment.
import { randomBytes } from "node:crypto";
import {
  closeSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmdirSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join, resolve, sep } from "node:path";

export const _testFsAtomicHooks: {
  beforeRename?: ((tmp: string, targetPath: string) => void) | undefined;
} = {};

export function writeAtomicSync(targetPath: string, content: Buffer | string, mode = 0o600): void {
  const dir = dirname(targetPath);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const rnd = randomBytes(4).toString("hex");
  const tmp = join(dir, `.${basename(targetPath)}.tmp.${process.pid}.${Date.now()}.${rnd}`);
  try {
    const fd = openSync(tmp, "w", mode);
    try {
      writeFileSync(fd, content);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    if (_testFsAtomicHooks.beforeRename) {
      _testFsAtomicHooks.beforeRename(tmp, targetPath);
    }
    renameSync(tmp, targetPath);
  } catch (err) {
    try { unlinkSync(tmp); } catch {}
    throw err;
  }

  // Best-effort directory fsync on platforms where opening directory fd is supported
  try {
    const dirFd = openSync(dir, "r");
    try {
      fsyncSync(dirFd);
    } finally {
      closeSync(dirFd);
    }
  } catch {
    // Ignored on platforms (Windows) or filesystems where directory fd is not supported
  }
}

export function copyAtomicSync(srcPath: string, destPath: string, mode = 0o600): void {
  const buf = readFileSync(srcPath);
  writeAtomicSync(destPath, buf, mode);
}

// A new destination has no realpath yet. Resolve its nearest existing ancestor
// and append only the missing suffix, so aliases such as /var and /private/var
// compare consistently while respecting resolvable symlinks in the path.
function canonicalPath(target: string): string | undefined {
  let current = resolve(target);
  const missing: string[] = [];
  for (;;) {
    try {
      return join(realpathSync.native(current), ...missing);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") return undefined;
      const parent = dirname(current);
      if (parent === current) return undefined;
      missing.unshift(basename(current));
      current = parent;
    }
  }
}

export function isInsideDir(root: string, target: string): boolean {
  const r = canonicalPath(root);
  const q = canonicalPath(target);
  if (r === undefined || q === undefined) return false;
  if (process.platform === "win32" || process.platform === "darwin") {
    const rLower = r.toLowerCase();
    const qLower = q.toLowerCase();
    const prefix = rLower.endsWith(sep) ? rLower : rLower + sep;
    return qLower === rLower || qLower.startsWith(prefix);
  }
  const prefix = r.endsWith(sep) ? r : r + sep;
  return q === r || q.startsWith(prefix);
}

export function cleanEmptyDirs(dir: string, stopAt: string): void {
  const normDir = resolve(dir);
  const normStop = resolve(stopAt);
  if (normDir === normStop || !isInsideDir(normStop, normDir)) return;
  try {
    const entries = readdirSync(normDir);
    if (entries.length === 0) {
      rmdirSync(normDir);
      cleanEmptyDirs(dirname(normDir), normStop);
    }
  } catch {
    // Non-empty or permission error safely ignored
  }
}
