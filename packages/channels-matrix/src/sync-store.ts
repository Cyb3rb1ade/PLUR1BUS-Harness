import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, readdir, rename, rm, stat } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import type { SyncTokenStore } from "./port.ts";

const TOKEN = /^[\x21-\x7e]{1,1024}$/;
/** A temp file left by a process that died between writing and renaming is swept once it is older than this. */
const STALE_TMP_MS = 60_000;

/** One JSON file, replaced atomically (temp file in the same directory, then rename). One file per bot account. */
export class FileSyncTokenStore implements SyncTokenStore {
  readonly #file: string;
  constructor(dir: string, name = "matrix-sync.json") {
    this.#file = join(dir, name);
  }
  async load(): Promise<string | undefined> {
    let raw: string;
    try {
      raw = await readFile(this.#file, "utf8");
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw new Error("matrix sync state is unreadable");
    }
    try {
      const v = JSON.parse(raw) as { nextBatch?: unknown };
      if (typeof v.nextBatch === "string" && TOKEN.test(v.nextBatch)) return v.nextBatch;
    } catch {
      /* Fixed error below never exposes file contents or paths. */
    }
    throw new Error("matrix sync state is invalid");
  }
  async save(token: string): Promise<void> {
    if (!TOKEN.test(token)) throw new Error("invalid matrix sync token");
    await mkdir(dirname(this.#file), { recursive: true });
    await this.#sweep();
    const tmp = `${this.#file}.${randomUUID()}.tmp`;
    try {
      // The data must be on disk before the rename publishes it, or a power loss can leave an empty file under the final name.
      const fh = await open(tmp, "w");
      try {
        await fh.writeFile(JSON.stringify({ nextBatch: token }), "utf8");
        await fh.sync();
      } finally {
        await fh.close();
      }
      await rename(tmp, this.#file);
    } finally {
      await rm(tmp, { force: true });
    }
  }

  /** Best effort: removes old `<file>.<uuid>.tmp` leftovers of a crashed save. Never touches anything else. */
  async #sweep(): Promise<void> {
    const dir = dirname(this.#file);
    const prefix = `${basename(this.#file)}.`;
    try {
      for (const name of await readdir(dir)) {
        if (!name.startsWith(prefix) || !/^[0-9a-f-]{36}\.tmp$/.test(name.slice(prefix.length))) continue;
        const path = join(dir, name);
        const st = await stat(path).catch(() => undefined);
        if (st?.isFile() && Date.now() - st.mtimeMs > STALE_TMP_MS) await rm(path, { force: true });
      }
    } catch {
      /* A failed sweep must not fail the save. */
    }
  }
}

export class MemorySyncTokenStore implements SyncTokenStore {
  #v: string | undefined;
  constructor(initial?: string) {
    this.#v = initial;
  }
  async load(): Promise<string | undefined> {
    return this.#v;
  }
  async save(token: string): Promise<void> {
    if (!TOKEN.test(token)) throw new Error("invalid matrix sync token");
    this.#v = token;
  }
}
