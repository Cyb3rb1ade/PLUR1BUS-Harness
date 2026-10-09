import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { EmailError } from "./wire.ts";

/** Per thread: who we talk to and the Message-ID chain (root first, most recent last). */
export interface ThreadRecord {
  peer: string;
  subject: string;
  chain: string[];
}
export interface ThreadStore {
  get(key: string): Promise<ThreadRecord | undefined>;
  put(key: string, rec: ThreadRecord): Promise<void>;
}

export const MAX_REFERENCES_CHARS = 900;
const MAX_THREADS = 5000;

/** One email thread == one chat. The key is derived from the root Message-ID, so it is opaque and stable. */
export function threadKey(rootMessageId: string): string {
  return `t-${createHash("sha256").update(rootMessageId, "utf8").digest("hex").slice(0, 32)}`;
}

/** "Re: " once, case-insensitive; an existing "Re:" is kept as-is. */
export function replySubject(subject: string): string {
  const s = subject.replace(/[\r\n\t]+/g, " ").trim();
  if (!s) return "Re:";
  return /^re:/i.test(s) ? s : `Re: ${s}`;
}

/**
 * The References chain for a reply: parent's chain plus the parent itself, capped. The root (first) entry is always kept;
 * the oldest middle entries are dropped first.
 */
export function capReferences(chain: readonly string[], max = MAX_REFERENCES_CHARS): string[] {
  const out = [...chain];
  const len = (xs: readonly string[]) => xs.reduce((n, x) => n + x.length + 3, 0);
  while (out.length > 1 && len(out) > max) out.splice(1, 1);
  return out;
}

/** Inbound: the chain for a message is its own References followed by its own Message-ID (when present). */
export function chainFor(references: readonly string[], messageId: string | undefined): string[] {
  const base = [...references];
  if (messageId && !base.includes(messageId)) base.push(messageId);
  return capReferences(base);
}

/** Bounded in-memory store. */
export class MemoryThreadStore implements ThreadStore {
  readonly #m = new Map<string, ThreadRecord>();
  async get(key: string): Promise<ThreadRecord | undefined> {
    const r = this.#m.get(key);
    return r && { ...r, chain: [...r.chain] };
  }
  async put(key: string, rec: ThreadRecord): Promise<void> {
    this.#m.delete(key);
    this.#m.set(key, { ...rec, chain: [...rec.chain] });
    while (this.#m.size > MAX_THREADS) this.#m.delete(this.#m.keys().next().value!);
  }
}

function validRecord(v: unknown): v is ThreadRecord {
  if (!v || typeof v !== "object") return false;
  const r = v as Record<string, unknown>;
  return (
    typeof r.peer === "string" &&
    r.peer.length > 0 &&
    r.peer.length <= 320 &&
    typeof r.subject === "string" &&
    r.subject.length <= 998 &&
    Array.isArray(r.chain) &&
    r.chain.length <= 64 &&
    r.chain.every((x) => typeof x === "string" && x.length > 0 && x.length <= 998 && !/[\s<>]/.test(x))
  );
}

/** One JSON file, replaced atomically. Corrupt state THROWS so the channel fails closed. */
export class FileThreadStore implements ThreadStore {
  readonly #file: string;
  constructor(dir: string, name = "email-threads.json") {
    this.#file = join(dir, name);
  }
  async #load(): Promise<Record<string, ThreadRecord>> {
    let raw: string;
    try {
      raw = await readFile(this.#file, "utf8");
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return {};
      throw new EmailError("state", "email thread state is unreadable");
    }
    try {
      const v: unknown = JSON.parse(raw);
      if (v && typeof v === "object" && !Array.isArray(v) && Object.entries(v).every(([k, r]) => /^t-[0-9a-f]{32}$/.test(k) && validRecord(r)))
        return v as Record<string, ThreadRecord>;
    } catch {
      /* fixed error below */
    }
    throw new EmailError("state", "email thread state is invalid");
  }
  async get(key: string): Promise<ThreadRecord | undefined> {
    return (await this.#load())[key];
  }
  async put(key: string, rec: ThreadRecord): Promise<void> {
    if (!validRecord(rec)) throw new EmailError("state", "invalid email thread record");
    const all = await this.#load();
    delete all[key];
    all[key] = rec;
    const keys = Object.keys(all);
    for (const k of keys.slice(0, Math.max(0, keys.length - MAX_THREADS))) delete all[k];
    await mkdir(dirname(this.#file), { recursive: true });
    const tmp = `${this.#file}.${randomUUID()}.tmp`;
    try {
      await writeFile(tmp, JSON.stringify(all), "utf8");
      await rename(tmp, this.#file);
    } finally {
      await rm(tmp, { force: true });
    }
  }
}
