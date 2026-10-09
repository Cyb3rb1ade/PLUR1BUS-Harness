import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { GatewaySession, GatewayStateStore } from "./port.ts";

/** Only wss URLs on Discord's gateway domains are ever dialled for a resume, whether they came from READY or from disk. */
export function isGatewayUrl(u: unknown): u is string {
  if (typeof u !== "string" || u.length > 256) return false;
  try {
    const url = new URL(u);
    return url.protocol === "wss:" && !url.username && !url.password && /(^|\.)discord\.(gg|media)$/.test(url.hostname);
  } catch {
    return false;
  }
}

function valid(v: unknown): v is GatewaySession {
  if (!v || typeof v !== "object") return false;
  const s = v as Record<string, unknown>;
  return (
    typeof s.sessionId === "string" &&
    /^[A-Za-z0-9_-]{1,128}$/.test(s.sessionId) &&
    typeof s.seq === "number" &&
    Number.isSafeInteger(s.seq) &&
    s.seq >= 0 &&
    typeof s.botId === "string" &&
    /^\d{1,20}$/.test(s.botId) &&
    isGatewayUrl(s.resumeGatewayUrl)
  );
}

/** One JSON file replaced atomically. Existing but unreadable/invalid state is an error (fail closed), never silently ignored. */
export class FileGatewayStateStore implements GatewayStateStore {
  readonly #file: string;
  constructor(dir: string, name = "discord-gateway.json") {
    this.#file = join(dir, name);
  }
  async load(): Promise<GatewaySession | undefined> {
    let raw: string;
    try {
      raw = await readFile(this.#file, "utf8");
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw new Error("discord gateway state is unreadable");
    }
    try {
      const v: unknown = JSON.parse(raw);
      if (valid(v)) return v;
    } catch {
      /* Fixed error below never exposes file contents or paths. */
    }
    throw new Error("discord gateway state is invalid");
  }
  async save(session: GatewaySession): Promise<void> {
    if (!valid(session)) throw new Error("invalid discord gateway state");
    await mkdir(dirname(this.#file), { recursive: true });
    const tmp = `${this.#file}.${randomUUID()}.tmp`;
    try {
      await writeFile(tmp, JSON.stringify(session), { encoding: "utf8", mode: 0o600 });
      await rename(tmp, this.#file);
    } finally {
      await rm(tmp, { force: true });
    }
  }
  async clear(): Promise<void> {
    await rm(this.#file, { force: true });
  }
}

export class MemoryGatewayStateStore implements GatewayStateStore {
  #v: GatewaySession | undefined;
  constructor(initial?: GatewaySession) {
    this.#v = initial;
  }
  async load(): Promise<GatewaySession | undefined> {
    return this.#v && { ...this.#v };
  }
  async save(session: GatewaySession): Promise<void> {
    this.#v = { ...session };
  }
  async clear(): Promise<void> {
    this.#v = undefined;
  }
}
