import { randomUUID } from "node:crypto";
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
    let raw: string;
    try {
      raw = await readFile(this.#file, "utf8");
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw new Error("telegram offset state is unreadable");
    }
    try {
      const v = JSON.parse(raw) as { offset?: unknown };
      if (typeof v.offset === "number" && Number.isSafeInteger(v.offset) && v.offset >= 0) return v.offset;
    } catch {
      /* Fixed error below never exposes file contents or paths. */
    }
    throw new Error("telegram offset state is invalid");
  }
  async loadMigrations(): Promise<Readonly<Record<string, string>>> {
    let raw: string;
    try {
      raw = await readFile(`${this.#file}.migrations`, "utf8");
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return {};
      throw new Error("telegram migration state is unreadable");
    }
    try {
      const v: unknown = JSON.parse(raw);
      if (
        v &&
        typeof v === "object" &&
        !Array.isArray(v) &&
        Object.entries(v).every(([k, t]) => /^-?\d{1,20}$/.test(k) && typeof t === "string" && /^-?\d{1,20}$/.test(t))
      )
        return v as Record<string, string>;
    } catch {
      /* Fixed error below. */
    }
    throw new Error("telegram migration state is invalid");
  }
  async saveMigration(from: string, to: string): Promise<void> {
    const current = await this.loadMigrations();
    await this.#write(`${this.#file}.migrations`, JSON.stringify({ ...current, [from]: to }));
  }
  async save(offset: number): Promise<void> {
    if (!Number.isSafeInteger(offset) || offset < 0) throw new Error("invalid telegram offset");
    await this.#write(this.#file, JSON.stringify({ offset }));
  }
  async #write(file: string, text: string): Promise<void> {
    await mkdir(dirname(file), { recursive: true });
    const tmp = `${file}.${randomUUID()}.tmp`;
    try {
      await writeFile(tmp, text, "utf8");
      await rename(tmp, file);
    } finally {
      await rm(tmp, { force: true });
    }
  }
}

export class MemoryOffsetStore implements OffsetStore {
  #v: number | undefined;
  readonly #migrations: Record<string, string> = {};
  constructor(initial?: number) {
    this.#v = initial;
  }
  async loadMigrations(): Promise<Readonly<Record<string, string>>> {
    return { ...this.#migrations };
  }
  async saveMigration(from: string, to: string): Promise<void> {
    this.#migrations[from] = to;
  }
  async load(): Promise<number | undefined> {
    return this.#v;
  }
  async save(offset: number): Promise<void> {
    this.#v = offset;
  }
}
