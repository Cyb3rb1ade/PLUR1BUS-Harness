import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { SyncTokenStore } from "./port.ts";

const TOKEN = /^[\x21-\x7e]{1,1024}$/;

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
    const tmp = `${this.#file}.${randomUUID()}.tmp`;
    try {
      await writeFile(tmp, JSON.stringify({ nextBatch: token }), "utf8");
      await rename(tmp, this.#file);
    } finally {
      await rm(tmp, { force: true });
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
