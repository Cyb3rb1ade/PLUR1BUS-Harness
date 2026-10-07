// Filesystem cache `<dir>` (= extensions/catalog/): index.json, index.json.minisig, last-serial, meta.json. Atomic writes.
import { mkdir, readFile, rename, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import type { CachedIndex, IndexCacheStore } from "./types.ts";

async function readOpt(path: string): Promise<Buffer | null> {
  try {
    return await readFile(path);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw e;
  }
}

async function atomicWrite(dir: string, name: string, data: string | Uint8Array): Promise<void> {
  const tmp = join(dir, `.${name}.tmp-${process.pid}`);
  try {
    await writeFile(tmp, data);
    await rename(tmp, join(dir, name));
  } finally {
    await rm(tmp, { force: true });
  }
}

export function createFileCacheStore(dir: string): IndexCacheStore {
  return {
    async read() {
      const serialText = await readOpt(join(dir, "last-serial"));
      let lastSerial = -1;
      if (serialText) {
        const n = Number(serialText.toString("utf8").trim());
        // RULING: an unreadable last-serial counts as "no history" only if there is no cache either; with a cache, fail closed.
        lastSerial = Number.isSafeInteger(n) && n >= 0 ? n : Number.MAX_SAFE_INTEGER;
      }
      const [indexBytes, sig, meta] = await Promise.all([readOpt(join(dir, "index.json")), readOpt(join(dir, "index.json.minisig")), readOpt(join(dir, "meta.json"))]);
      if (!indexBytes || !sig || !meta) return { cached: null, lastSerial };
      let fetchedAt = NaN;
      try {
        fetchedAt = Number((JSON.parse(meta.toString("utf8")) as { fetchedAt?: unknown }).fetchedAt);
      } catch {
        /* falls through to "no cache" */
      }
      if (!Number.isFinite(fetchedAt)) return { cached: null, lastSerial };
      const cached: CachedIndex = { indexBytes: new Uint8Array(indexBytes), signature: sig.toString("utf8"), fetchedAt };
      return { cached, lastSerial };
    },
    async write(cached, serial) {
      await mkdir(dir, { recursive: true });
      await atomicWrite(dir, "index.json", cached.indexBytes);
      await atomicWrite(dir, "index.json.minisig", cached.signature);
      await atomicWrite(dir, "meta.json", JSON.stringify({ fetchedAt: cached.fetchedAt }));
      await atomicWrite(dir, "last-serial", String(serial));
    },
  };
}

export function createMemoryCacheStore(): IndexCacheStore & { snapshot(): { cached: CachedIndex | null; lastSerial: number } } {
  let state: { cached: CachedIndex | null; lastSerial: number } = { cached: null, lastSerial: -1 };
  return {
    async read() {
      return { ...state };
    },
    async write(cached, serial) {
      state = { cached, lastSerial: serial };
    },
    snapshot: () => ({ ...state }),
  };
}
