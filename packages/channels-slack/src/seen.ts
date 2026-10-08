import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { SeenStore } from "./port.ts";

const MAX_IDS = 2048;
const ID = /^[A-Za-z0-9_.:-]{1,128}$/;

/** One JSON file, replaced atomically (temp file in the same directory, then rename). Corrupt state fails closed. */
export class FileSeenStore implements SeenStore {
  readonly #file: string;
  constructor(dir: string, name = "slack-seen.json") {
    this.#file = join(dir, name);
  }
  async load(): Promise<string[] | undefined> {
    let raw: string;
    try {
      raw = await readFile(this.#file, "utf8");
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw new Error("slack dedupe state is unreadable");
    }
    try {
      const v = JSON.parse(raw) as { ids?: unknown };
      if (Array.isArray(v.ids) && v.ids.length <= MAX_IDS && v.ids.every((x) => typeof x === "string" && ID.test(x)))
        return v.ids as string[];
    } catch {
      /* Fixed error below never exposes file contents or paths. */
    }
    throw new Error("slack dedupe state is invalid");
  }
  async save(ids: readonly string[]): Promise<void> {
    if (ids.length > MAX_IDS || ids.some((x) => !ID.test(x))) throw new Error("invalid slack dedupe state");
    await mkdir(dirname(this.#file), { recursive: true });
    const tmp = `${this.#file}.${randomUUID()}.tmp`;
    try {
      await writeFile(tmp, JSON.stringify({ ids }), "utf8");
      await rename(tmp, this.#file);
    } finally {
      await rm(tmp, { force: true });
    }
  }
}

export class MemorySeenStore implements SeenStore {
  #ids: string[] | undefined;
  constructor(initial?: readonly string[]) {
    this.#ids = initial ? [...initial] : undefined;
  }
  async load(): Promise<string[] | undefined> {
    return this.#ids ? [...this.#ids] : undefined;
  }
  async save(ids: readonly string[]): Promise<void> {
    this.#ids = [...ids];
  }
}
export const SEEN_MAX_IDS = MAX_IDS;
