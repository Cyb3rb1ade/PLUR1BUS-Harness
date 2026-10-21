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

/** Real path of `p`; for a path that does not exist (yet) the real path of its nearest existing ancestor plus the missing
 *  tail. A root and a target must be resolved the same way, or one of them keeps a symlinked prefix the other lost (macOS:
 *  `/var` is `/private/var`, so a not-yet-created file under the temp dir would look outside it). A dangling symlink is
 *  judged by its own name inside the real parent, not by where it points. */
function realpathLoose(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    const parent = dirname(p);
    return parent === p ? p : join(realpathLoose(parent), basename(p));
  }
}

export function isInsideDir(root: string, target: string): boolean {
  const r = realpathLoose(resolve(root));
  const q = realpathLoose(resolve(target));
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
