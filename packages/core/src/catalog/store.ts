import { mkdir, open, readFile, rename, rm, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { CatalogError, type CatalogCheckpoint, type CatalogSnapshot, type CatalogStore } from "./types.ts";
import { object, integer } from "./verify.ts";

const queues = new Map<string, Promise<unknown>>();
async function readJson(path: string, limit: number): Promise<unknown> {
  try {
    if ((await stat(path)).size > limit) throw new Error("cache file too large");
    return JSON.parse(await readFile(path, "utf8"));
  } catch (e) { if ((e as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw e; }
}
function checkpoint(v: unknown): CatalogCheckpoint | null {
  if (v === undefined) return null;
  const sha = (s: unknown) => typeof s === "string" && /^[0-9a-f]{64}$/.test(s);
  if (!object(v) || !Number.isSafeInteger(v.serial) || Number(v.serial) < 0 || !sha(v.indexHash) || !integer(v.rootVersion) || !sha(v.rootHash) || !integer(v.revocationVersion) || !sha(v.revocationHash) || !Array.isArray(v.revokedKeys) || !v.revokedKeys.every((k: unknown) => typeof k === "string") || !Array.isArray(v.rotationHashes) || !v.rotationHashes.every(sha) || !Array.isArray(v.revokedPublicKeys) || !v.revokedPublicKeys.every((k: unknown) => typeof k === "string") || !Array.isArray(v.revokedPackages) || !v.revokedPackages.every((p: unknown) => object(p) && typeof p.id === "string" && typeof p.reason === "string" && Array.isArray(p.versions) && p.versions.every((s: unknown) => typeof s === "string"))) throw new CatalogError("rollback_detected", "security checkpoint damaged; refusing to reset trust history");
  return v as unknown as CatalogCheckpoint;
}
async function atomic(dir: string, name: string, value: unknown): Promise<void> {
  const tmp = join(dir, `.${name}.${randomUUID()}`);
  try {
    const file = await open(tmp, "wx", 0o600);
    try { await file.writeFile(JSON.stringify(value)); await file.sync(); } finally { await file.close(); }
    await rename(tmp, join(dir, name));
    // Persist rename ordering on POSIX. Windows does not expose directory fsync through node:fs.
    if (process.platform !== "win32") {
      const directory = await open(dir, "r");
      try { await directory.sync(); } finally { await directory.close(); }
    }
  } finally { await rm(tmp, { force: true }); }
}
export function createCatalogFileStore(directory: string): CatalogStore {
  const dir = resolve(directory);
  return {
    async exclusive(operation) {
      const prior = queues.get(dir) ?? Promise.resolve();
      const next = prior.catch(() => {}).then(operation);
      queues.set(dir, next);
      try { return await next; } finally { if (queues.get(dir) === next) queues.delete(dir); }
    },
    async read() {
      let floor: CatalogCheckpoint | null;
      try { floor = checkpoint(await readJson(join(dir, "checkpoint.json"), 16 * 1024 * 1024)); }
      catch (e) { if (e instanceof CatalogError) throw e; throw new CatalogError("rollback_detected", "security checkpoint unreadable; refusing to reset history"); }
      let snapshot: CatalogSnapshot | null = null;
      let snapshotPresent = false;
      try {
        const v = await readJson(join(dir, "snapshot.json"), 32 * 1024 * 1024);
        snapshotPresent = v !== undefined;
        if (object(v) && typeof v.fetchedAt === "number" && Number.isFinite(v.fetchedAt) && Array.isArray(v.rotations)) snapshot = v as unknown as CatalogSnapshot;
      } catch { snapshotPresent = true; /* A corrupt payload can be replaced only if the separate floor survives. */ }
      if (snapshotPresent && !floor) throw new CatalogError("rollback_detected", "cached data without its security checkpoint");
      let legacySerial: number | undefined;
      if (!floor) {
        try {
          const text = await readFile(join(dir, "last-serial"), "utf8");
          const value = Number(text.trim());
          if (!/^\d+$/.test(text.trim()) || !Number.isSafeInteger(value)) throw new Error("invalid old serial");
          legacySerial = value;
        } catch (e) {
          if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw new CatalogError("rollback_detected", "legacy serial floor unreadable; refusing to reset history");
        }
      }
      return { checkpoint: floor, snapshot, ...(legacySerial === undefined ? {} : { legacySerial }) };
    },
    async write(floor, snapshot) {
      await mkdir(dir, { recursive: true, mode: 0o700 });
      // Raise the floor FIRST: a crash may require refetch, but can never authorize older metadata.
      await atomic(dir, "checkpoint.json", floor);
      await atomic(dir, "snapshot.json", snapshot);
    },
  };
}
