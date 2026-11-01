/** Apparent upload bytes and newest modification time; symlinks are counted, never traversed. */
import { lstat, readdir } from "node:fs/promises";
import { join } from "node:path";

export interface UploadDiskEntry { id: string; path: string; bytes: number; modifiedAt: number }

export async function uploadDiskEntries(root: string): Promise<UploadDiskEntry[]> {
  const entries: UploadDiskEntry[] = [];
  for (const name of await readdir(root)) {
    const path = join(root, name), pending = [path];
    let bytes = 0, modifiedAt = 0;
    while (pending.length) {
      const next = pending.pop()!;
      let info;
      try { info = await lstat(next); }
      catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") continue; throw error; }
      modifiedAt = Math.max(modifiedAt, info.mtimeMs);
      if (info.isDirectory()) for (const child of await readdir(next)) pending.push(join(next, child));
      else bytes += info.size;
    }
    entries.push({ id: name, path, bytes, modifiedAt });
  }
  return entries;
}
