// The model catalog's file (spec §2.6, R18; plan Task 1): core-owned, one writer, one in-process mutation lock.
// Written to models.json.tmp-<pid>, fsynced, renamed; the previous file is kept once as models.json.prev; a file that
// fails validation is moved to models.json.corrupt-<ts>.
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readdirSync, readFileSync, renameSync, statSync, unlinkSync, writeSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { CAPABILITIES, MODEL_KINDS, emptyCatalog } from "./types.ts";
import type { CatalogFile } from "./types.ts";
import type { Clock } from "./ports.ts";

export const MAX_CATALOG_BYTES = 16 * 1024 * 1024;

export class CatalogWriteError extends Error {
  readonly cause: unknown;
  constructor(cause: unknown) {
    super(`catalog write failed: ${cause instanceof Error ? cause.message : String(cause)}`);
    this.name = "CatalogWriteError";
    this.cause = cause;
  }
}

const STATUSES = ["available", "unavailable", "manual"];
const SOURCES = ["scan", "table", "manual"];
const RESULTS = ["ok", "failed:auth", "failed:network", "failed:server", "failed:invalid", "failed:empty"];
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const isStr = (v: unknown): v is string => typeof v === "string";
const isPosInt = (v: unknown): v is number => typeof v === "number" && Number.isInteger(v) && v > 0;

function checkApi(v: unknown, where: string, errors: string[]): void {
  if (!isObj(v)) { errors.push(`${where} must be an object`); return; }
  if (v.displayName !== undefined && !isStr(v.displayName)) errors.push(`${where}.displayName must be a string`);
  if (v.kind !== undefined && !(MODEL_KINDS as readonly unknown[]).includes(v.kind)) errors.push(`${where}.kind is not a model kind`);
  if (v.contextWindow !== undefined && !isPosInt(v.contextWindow)) errors.push(`${where}.contextWindow must be a positive integer`);
  if (v.capabilities !== undefined && !(Array.isArray(v.capabilities) && v.capabilities.every((c) => (CAPABILITIES as readonly unknown[]).includes(c)))) errors.push(`${where}.capabilities is not a capability list`);
  if (v.aliases !== undefined && !(Array.isArray(v.aliases) && v.aliases.every(isStr))) errors.push(`${where}.aliases must be strings`);
}

/** Hand-written, strict on the fields it knows (no ajv). */
export function validateCatalog(raw: unknown): { ok: true; file: CatalogFile } | { ok: false; errors: string[] } {
  const errors: string[] = [];
  if (!isObj(raw)) return { ok: false, errors: ["catalog must be an object"] };
  if (raw.schema !== "plur1bus.model-catalog/1") errors.push("schema must be plur1bus.model-catalog/1");
  if (!(typeof raw.revision === "number" && Number.isInteger(raw.revision) && raw.revision >= 0)) errors.push("revision must be a non-negative integer");
  if (!isStr(raw.tableRevision)) errors.push("tableRevision must be a string");
  if (raw.acknowledgedAt !== undefined && !isStr(raw.acknowledgedAt)) errors.push("acknowledgedAt must be a string");
  if (!isObj(raw.providers)) errors.push("providers must be an object");
  else {
    for (const [id, st] of Object.entries(raw.providers)) {
      if (!isObj(st)) { errors.push(`providers.${id} must be an object`); continue; }
      for (const k of ["lastScanAt", "nextScanAt"]) if (st[k] !== undefined && !isStr(st[k])) errors.push(`providers.${id}.${k} must be a string`);
      if (st.lastResult !== undefined && !RESULTS.includes(st.lastResult as string)) errors.push(`providers.${id}.lastResult is not a result code`);
      if (st.consecutiveFailures !== undefined && !(typeof st.consecutiveFailures === "number" && Number.isInteger(st.consecutiveFailures) && st.consecutiveFailures >= 0)) errors.push(`providers.${id}.consecutiveFailures must be a non-negative integer`);
    }
  }
  if (!Array.isArray(raw.models)) errors.push("models must be an array");
  else {
    const seen = new Set<string>();
    raw.models.forEach((m: unknown, i: number) => {
      const w = `models[${i}]`;
      if (!isObj(m)) { errors.push(`${w} must be an object`); return; }
      if (!isStr(m.provider) || m.provider === "") errors.push(`${w}.provider must be a non-empty string`);
      if (!isStr(m.id) || m.id === "") errors.push(`${w}.id must be a non-empty string`);
      if (isStr(m.provider) && isStr(m.id)) {
        const key = JSON.stringify([m.provider, m.id]);
        if (seen.has(key)) errors.push(`${w} duplicates another (provider, id)`);
        seen.add(key);
      }
      if (!isStr(m.displayName)) errors.push(`${w}.displayName must be a string`);
      if (!(MODEL_KINDS as readonly unknown[]).includes(m.kind)) errors.push(`${w}.kind is not a model kind`);
      if (m.contextWindow !== undefined && !isPosInt(m.contextWindow)) errors.push(`${w}.contextWindow must be a positive integer`);
      if (!(Array.isArray(m.capabilities) && m.capabilities.every((c) => (CAPABILITIES as readonly unknown[]).includes(c)))) errors.push(`${w}.capabilities is not a capability list`);
      if (!(Array.isArray(m.aliases) && m.aliases.every(isStr))) errors.push(`${w}.aliases must be strings`);
      if (!STATUSES.includes(m.status as string)) errors.push(`${w}.status is not a status`);
      if (!isStr(m.firstSeen) || !isStr(m.lastSeen)) errors.push(`${w}.firstSeen and lastSeen must be strings`);
      if (!SOURCES.includes(m.source as string)) errors.push(`${w}.source is not a source`);
      if (!isObj(m.overrides)) errors.push(`${w}.overrides must be an object`); else checkApi(m.overrides, `${w}.overrides`, errors);
      if (m.api !== undefined) checkApi(m.api, `${w}.api`, errors);
    });
  }
  return errors.length === 0 ? { ok: true, file: raw as unknown as CatalogFile } : { ok: false, errors };
}

export interface LoadResult { file: CatalogFile; recovered: "none" | "prev" | "empty"; quarantinedTo?: string }
export interface CatalogStore {
  /** Sync, at core start: removes stray models.json.tmp-*, quarantines an invalid file, recovers from .prev (P12). */
  load(): LoadResult;
  /** A deep copy of the current in-memory file. */
  read(): CatalogFile;
  /** One lock; revision + 1; the durable write happens before memory changes; throws CatalogWriteError. */
  mutate<T>(fn: (c: CatalogFile) => { next: CatalogFile; result: T }): Promise<T>;
}
export interface CatalogStoreOptions {
  path: string; tableRevision: string; clock: Clock; securePath: (p: string) => unknown;
  logger: { info(m: string, f?: object): void; warn(m: string, f?: object): void };
  hooks?: { beforeRename?: () => void };
}

function tryRead(p: string): { ok: true; file: CatalogFile } | { ok: false; missing: boolean; why: string } {
  if (!existsSync(p)) return { ok: false, missing: true, why: "missing" };
  try {
    if (statSync(p).size > MAX_CATALOG_BYTES) return { ok: false, missing: false, why: "file larger than 16 MiB" };
    const v = validateCatalog(JSON.parse(readFileSync(p, "utf8")));
    return v.ok ? v : { ok: false, missing: false, why: v.errors[0] ?? "invalid" };
  } catch (e) {
    return { ok: false, missing: false, why: e instanceof SyntaxError ? "not valid JSON" : "unreadable" };
  }
}

function writeFileSynced(p: string, data: string): void {
  const fd = openSync(p, "w", 0o600);
  try { writeSync(fd, data); fsyncSync(fd); } finally { closeSync(fd); }
}

export function createCatalogStore(o: CatalogStoreOptions): CatalogStore {
  const prevPath = `${o.path}.prev`;
  let current: CatalogFile = emptyCatalog(o.tableRevision);
  let lock: Promise<unknown> = Promise.resolve();

  function load(): LoadResult {
    const dir = dirname(o.path);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const prefix = `${basename(o.path)}.tmp-`;
    for (const f of readdirSync(dir)) if (f.startsWith(prefix)) { try { unlinkSync(join(dir, f)); } catch { /* best effort */ } }
    const main = tryRead(o.path);
    if (main.ok) { current = main.file; return { file: structuredClone(current), recovered: "none" }; }
    let quarantinedTo: string | undefined;
    if (!main.missing) {
      quarantinedTo = `${o.path}.corrupt-${o.clock.now()}`;
      try { renameSync(o.path, quarantinedTo); } catch { quarantinedTo = undefined; }
      o.logger.warn("model catalog failed validation and was quarantined", { reason: main.why });
    }
    const prev = tryRead(prevPath);
    if (prev.ok) {
      // A rescan follows: the first catch-up must see every provider as never scanned (P12).
      const file = structuredClone(prev.file);
      for (const st of Object.values(file.providers)) delete st.lastScanAt;
      current = file;
      o.logger.info("model catalog recovered from the previous copy");
      return { file: structuredClone(current), recovered: "prev", ...(quarantinedTo ? { quarantinedTo } : {}) };
    }
    current = emptyCatalog(o.tableRevision);
    return { file: structuredClone(current), recovered: main.missing && prev.missing ? "none" : "empty", ...(quarantinedTo ? { quarantinedTo } : {}) };
  }

  function persist(next: CatalogFile, previous: CatalogFile): void {
    const tmp = `${o.path}.tmp-${process.pid}`;
    try {
      writeFileSynced(tmp, `${JSON.stringify(next, null, 2)}\n`);
      o.securePath(tmp);
      if (previous.revision > 0) {
        writeFileSynced(prevPath, `${JSON.stringify(previous, null, 2)}\n`);
        o.securePath(prevPath);
      }
    } catch (e) {
      try { unlinkSync(tmp); } catch { /* best effort */ }
      throw e;
    }
    o.hooks?.beforeRename?.(); // a throw here leaves the temp file, as a kill would; load() removes it
    renameSync(tmp, o.path);
  }

  function mutate<T>(fn: (c: CatalogFile) => { next: CatalogFile; result: T }): Promise<T> {
    const run = async (): Promise<T> => {
      const previous = current;
      const { next, result } = fn(structuredClone(previous));
      const candidate: CatalogFile = { ...next, revision: previous.revision + 1 };
      const v = validateCatalog(candidate);
      if (!v.ok) throw new CatalogWriteError(new Error(`refusing to write an invalid catalog: ${v.errors[0]}`));
      try { persist(candidate, previous); } catch (e) { throw new CatalogWriteError(e); }
      current = candidate;
      return result;
    };
    const p = lock.then(run, run);
    lock = p.catch(() => undefined);
    return p;
  }

  return { load, read: () => structuredClone(current), mutate };
}
