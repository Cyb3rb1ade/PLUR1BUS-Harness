/** Read-only target freshness proof, shared by live preflight and the stopped maintenance worker. */
import { createHash } from "node:crypto";
import { lstat } from "node:fs/promises";
import { join } from "node:path";
import { coldUnavailable, normalizedRoots, readColdBytes, scanMutationRoot, streamRegular,
  type ColdRoot, type MutationRoot } from "./maintenance-files.ts";
import { logicalSqliteFingerprint } from "./sqlite-fingerprint.ts";

export async function readTargetConfigBytes(home: string): Promise<Buffer | null> {
  const path = join(home, "config.json");
  const exists = await lstat(path).catch(error => {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    return undefined;
  });
  return exists ? readColdBytes(path, 4 * 1024 * 1024) : null;
}

export async function fingerprintImportTarget(home: string, mutationRoots: readonly MutationRoot[],
  signal?: AbortSignal): Promise<string> {
  const roots = await fingerprintMutationRoots(mutationRoots, signal);
  const config = await readTargetConfigBytes(home);
  return createHash("sha256").update(roots).update(config === null ? "absent" : "present")
    .update(config ?? Buffer.alloc(0)).digest("hex");
}


/** Byte and path identity, excluding independently owned roots; modified mtimes alone are not a user conflict. */
export async function fingerprintMutationRoots(roots: readonly MutationRoot[], signal?: AbortSignal): Promise<string> {
  try {
    const scanned: ColdRoot[] = [];
    for (const root of normalizedRoots(roots)) {
      const sqlite = new Set<string>();
      const state = await scanMutationRoot(root, { signal, file: async (full, path) => {
        if (["-wal", "-shm"].some(suffix => path.endsWith(suffix) && sqlite.has(path.slice(0, -suffix.length)))) {
          return { sha256: "0".repeat(64), size: 0 };
        }
        const logical = await logicalSqliteFingerprint(full, signal);
        if (logical) {
          sqlite.add(path);
          return { sha256: logical, size: 0 };
        }
        return streamRegular(full, { signal });
      } });
      state.entries = state.entries.filter(entry => !["-wal", "-shm"]
        .some(suffix => entry.path.endsWith(suffix) && sqlite.has(entry.path.slice(0, -suffix.length))));
      scanned.push(state);
    }
    return createHash("sha256").update(JSON.stringify(scanned)).digest("hex");
  } catch {
    throw coldUnavailable();
  }
}
