import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { UidState, UidStore } from "./port.ts";

function valid(v: unknown): v is UidState {
  if (!v || typeof v !== "object") return false;
  const s = v as Record<string, unknown>;
  return (
    typeof s.folder === "string" &&
    s.folder.length > 0 &&
    s.folder.length < 512 &&
    Number.isSafeInteger(s.uidValidity) &&
    (s.uidValidity as number) >= 0 &&
    Number.isSafeInteger(s.lastUid) &&
    (s.lastUid as number) >= 0
  );
}

/** One JSON file replaced atomically (temp file in the same directory, then rename). Corrupt state THROWS (fail closed). */
export class FileUidStore implements UidStore {
  readonly #file: string;
  constructor(dir: string, name = "email-uid.json") {
    this.#file = join(dir, name);
  }
  async load(): Promise<UidState | undefined> {
    let raw: string;
    try {
      raw = await readFile(this.#file, "utf8");
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw new Error("email uid state is unreadable");
    }
    try {
      const v: unknown = JSON.parse(raw);
      if (valid(v)) return { folder: v.folder, uidValidity: v.uidValidity, lastUid: v.lastUid };
    } catch {
      /* fixed error below: never expose file contents or paths */
    }
    throw new Error("email uid state is invalid");
  }
  async save(state: UidState): Promise<void> {
    if (!valid(state)) throw new Error("invalid email uid state");
    await mkdir(dirname(this.#file), { recursive: true });
    const tmp = `${this.#file}.${randomUUID()}.tmp`;
    try {
      await writeFile(tmp, JSON.stringify({ folder: state.folder, uidValidity: state.uidValidity, lastUid: state.lastUid }), "utf8");
      await rename(tmp, this.#file);
    } finally {
      await rm(tmp, { force: true });
    }
  }
}

export class MemoryUidStore implements UidStore {
  #v: UidState | undefined;
  constructor(initial?: UidState) {
    this.#v = initial && { ...initial };
  }
  async load(): Promise<UidState | undefined> {
    return this.#v && { ...this.#v };
  }
  async save(state: UidState): Promise<void> {
    this.#v = { ...state };
  }
}
