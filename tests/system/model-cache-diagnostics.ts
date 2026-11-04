import { lstatSync, opendirSync, type Dir } from "node:fs";
import { join } from "node:path";

/** Bounded metadata for synthetic system-test model caches; never reads file contents or emits names. */
export interface ModelCacheSnapshot {
  files: number;
  bytes: number;
  partialFiles: number;
  partialBytes: number;
  truncated: boolean;
  unavailable: boolean;
}

export function modelCacheSnapshot(testHome: string): ModelCacheSnapshot {
  const result: ModelCacheSnapshot = { files: 0, bytes: 0, partialFiles: 0, partialBytes: 0, truncated: false, unavailable: false };
  let remaining = 256;
  function scan(path: string, depth: number): void {
    let directory: Dir | undefined;
    try {
      directory = opendirSync(path);
      for (;;) {
        if (remaining <= 0) { result.truncated = true; return; }
        remaining -= 1;
        const entry = directory.readSync();
        if (entry === null) return;
        // The top-level models junction is intentional (linkModelCache); nested aliases are not traversed.
        if (entry.isSymbolicLink()) continue;
        const child = join(path, entry.name);
        if (entry.isDirectory()) {
          if (depth < 8) scan(child, depth + 1);
          else result.truncated = true;
        } else if (entry.isFile()) {
          try {
            const info = lstatSync(child);
            if (!info.isFile()) continue;
            result.files += 1; result.bytes += info.size;
            if (entry.name.includes(".part-")) { result.partialFiles += 1; result.partialBytes += info.size; }
          } catch { result.unavailable = true; } // a downloader can rename a partial while this snapshot runs
        }
      }
    } catch { result.unavailable = true; }
    finally { try { directory?.closeSync(); } catch { result.unavailable = true; } }
  }
  scan(join(testHome, "models"), 0);
  return result;
}
