import { createSecurePath } from "../../module-api/src/secure-path.ts";
import { emptySafety, validSafety, type SyncSafetyState } from "./sync-safety.ts";
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
  #chain: Promise<void> = Promise.resolve();
  readonly #secure = createSecurePath();
  constructor(dir: string, name = "matrix-sync.json") {
    this.#file = join(dir, name);
  }
  async #read(): Promise<{ nextBatch?: string; safety: SyncSafetyState }> {
    let raw: string;
    try { raw = await readFile(this.#file, "utf8"); }
    catch (e) { if ((e as NodeJS.ErrnoException).code === "ENOENT") return { safety: emptySafety() }; throw new Error("matrix sync state is unreadable"); }
    try {
      const v = JSON.parse(raw);
      if (v.version === 2 && validSafety(v.safety) && (v.nextBatch === undefined || typeof v.nextBatch === "string" && TOKEN.test(v.nextBatch)))
        return { ...(v.nextBatch !== undefined ? { nextBatch: v.nextBatch } : {}), safety: v.safety };
      if (v.version === undefined && typeof v.nextBatch === "string" && TOKEN.test(v.nextBatch)) return { nextBatch: v.nextBatch, safety: emptySafety() };
    } catch { /* fixed error below */ }
    throw new Error("matrix sync state is invalid");
  }
  async load(): Promise<string | undefined> { await this.#chain; return (await this.#read()).nextBatch; }
  async loadSafety(): Promise<SyncSafetyState> { await this.#chain; return (await this.#read()).safety; }
  async save(token: string): Promise<void> {
    if (!TOKEN.test(token)) throw new Error("invalid matrix sync token");
    return this.#update(state => ({ ...state, nextBatch: token }));
  }
  async saveSafety(safety: SyncSafetyState): Promise<void> {
    if (!validSafety(safety)) throw new Error("invalid matrix sync safety state");
    const copy = structuredClone(safety);
    return this.#update(state => ({ ...state, safety: copy }));
  }
  #update(change: (state: { nextBatch?: string; safety: SyncSafetyState }) => { nextBatch?: string; safety: SyncSafetyState }): Promise<void> {
    const run = this.#chain.then(async () => {
      const state = change(await this.#read());
      await mkdir(dirname(this.#file), { recursive: true, mode: 0o700 });
      await this.#sweep();
      const tmp = `${this.#file}.${randomUUID()}.tmp`;
      try {
        const fh = await open(tmp, "wx", 0o600);
        try {
          const secured = this.#secure(tmp, { mode: 0o600 });
          if (!secured.applied) throw new Error("matrix sync permissions unavailable");
          await fh.writeFile(JSON.stringify({ version: 2, ...state }), "utf8");
          await fh.sync();
        } finally { await fh.close(); }
        await rename(tmp, this.#file);
        if (process.platform !== "win32") { const dir = await open(dirname(this.#file), "r"); try { await dir.sync(); } finally { await dir.close(); } }
      } finally { await rm(tmp, { force: true }); }
    });
    this.#chain = run.catch(() => {}); return run;
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
  #safety: SyncSafetyState = emptySafety();
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
  async loadSafety(): Promise<SyncSafetyState> { return structuredClone(this.#safety); }
  async saveSafety(state: SyncSafetyState): Promise<void> { if (!validSafety(state)) throw new Error("invalid matrix sync safety state"); this.#safety = structuredClone(state); }
}
