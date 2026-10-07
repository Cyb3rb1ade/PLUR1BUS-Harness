import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { OffsetStore } from "./port.ts";

/** One JSON file, replaced atomically (temp file in the same directory, then rename). Plain `path.join`, no POSIX modes. */
export class FileOffsetStore implements OffsetStore {
  readonly #file: string;
  constructor(dir: string, name = "telegram-offset.json") {
    this.#file = join(dir, name);
  }
  async load(): Promise<number | undefined> {
    try {
      const v = JSON.parse(await readFile(this.#file, "utf8")) as { offset?: unknown };
      return typeof v.offset === "number" && Number.isSafeInteger(v.offset) && v.offset >= 0 ? v.offset : undefined;
    } catch {
      return undefined; // missing or unreadable: start from what Telegram still holds
    }
  }
  async save(offset: number): Promise<void> {
    await mkdir(dirname(this.#file), { recursive: true });
    const tmp = `${this.#file}.${process.pid}.tmp`;
    try {
      await writeFile(tmp, JSON.stringify({ offset }), "utf8");
      await rename(tmp, this.#file);
    } finally {
      await rm(tmp, { force: true });
    }
  }
}

export class MemoryOffsetStore implements OffsetStore {
  #v: number | undefined;
  constructor(initial?: number) {
    this.#v = initial;
  }
  async load(): Promise<number | undefined> {
    return this.#v;
  }
  async save(offset: number): Promise<void> {
    this.#v = offset;
  }
}
