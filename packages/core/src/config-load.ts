import { chmodSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, renameSync, statSync, unlinkSync, writeSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { basename, dirname, join } from "node:path";
import { defaults, migrate, validate, type HarnessConfig } from "@plur1bus/config-schema";

export class ConfigInvalid extends Error {
  errors: string[];
  constructor(path: string, errors: string[]) { super(`${path}: ${errors.join("; ")}`); this.name = "ConfigInvalid"; this.errors = errors; }
}

/** A real config.json is a few KB; anything beyond this is refused before it is read into memory. */
export const MAX_CONFIG_BYTES = 8 * 1024 * 1024;
const MAX_DEPTH = 64;
const FORBIDDEN_KEYS = new Set(["__proto__"]);

/** Iterative (no stack use) scan for keys that poison Object.assign/merge consumers and for absurd nesting. Own
 *  `__proto__` keys only exist in parsed JSON; no schema section needs one. */
export function structureErrors(value: unknown): string[] {
  const errors: string[] = [];
  const stack: [unknown, string, number][] = [[value, "", 0]];
  while (stack.length > 0 && errors.length < 10) {
    const [v, path, depth] = stack.pop()!;
    if (v === null || typeof v !== "object") continue;
    if (depth > MAX_DEPTH) { errors.push(`${path || "/"} is nested deeper than ${MAX_DEPTH} levels`); continue; }
    if (Array.isArray(v)) { v.forEach((x, i) => stack.push([x, `${path}/${i}`, depth + 1])); continue; }
    for (const k of Object.getOwnPropertyNames(v)) {
      if (FORBIDDEN_KEYS.has(k)) errors.push(`${path}/${k} is a forbidden key`);
      else stack.push([(v as Record<string, unknown>)[k], `${path}/${k}`, depth + 1]);
    }
  }
  return errors;
}

/** `validate` behind the structure scan; never throws (a value the schema walk cannot handle is reported as invalid). */
export function validateConfig(value: unknown): ReturnType<typeof validate> {
  const bad = structureErrors(value);
  if (bad.length > 0) return { ok: false, errors: bad };
  try { return validate(value); } catch { return { ok: false, errors: ["/ could not be processed"] }; }
}

/** The file as parsed JSON. Failures are ConfigInvalid with texts that never quote file content (JSON.parse's own
 *  message carries a snippet of the input, which can be a secret). */
function readJson(path: string): unknown {
  let text: string;
  try {
    if (statSync(path).size > MAX_CONFIG_BYTES) throw new ConfigInvalid(path, [`file too large (limit ${MAX_CONFIG_BYTES} bytes)`]);
    text = readFileSync(path, "utf8");
  } catch (e) {
    if (e instanceof ConfigInvalid) throw e;
    throw new ConfigInvalid(path, [`not readable: ${(e as NodeJS.ErrnoException).code ?? "error"}`]);
  }
  if (text.length > MAX_CONFIG_BYTES) throw new ConfigInvalid(path, [`file too large (limit ${MAX_CONFIG_BYTES} bytes)`]);
  try { return JSON.parse(text); } catch (e) {
    const at = /position (\d+)/.exec((e as Error).message)?.[1];
    throw new ConfigInvalid(path, [`not JSON${at ? ` (syntax error at position ${at})` : ""}`]);
  }
}

function migrateChecked(path: string, raw: unknown): ReturnType<typeof migrate> {
  const bad = structureErrors(raw);
  if (bad.length > 0) throw new ConfigInvalid(path, bad);
  try { return migrate(raw); } catch { throw new ConfigInvalid(path, ["/ could not be processed"]); }
}

export function writeConfigAtomic(path: string, config: HarnessConfig): void {
  mkdirSync(dirname(path), { recursive: true });
  // A fresh, exclusively created temp file: a stale one (same pid after a crash) must not lend its permissions.
  const tmp = join(dirname(path), `${basename(path)}.tmp-${process.pid}-${randomBytes(4).toString("hex")}`);
  try {
    const fd = openSync(tmp, "wx", 0o600);
    try { writeSync(fd, `${JSON.stringify(config, null, 2)}\n`); } finally { closeSync(fd); }
    renameSync(tmp, path);
  } catch (e) {
    try { unlinkSync(tmp); } catch { /* already gone */ }
    throw e;
  }
}

/** A private copy (0600) of the file as it was before a migration rewrote it. */
function writeBackup(path: string, from: number): void {
  const bak = `${path}.bak-${from}`;
  try { unlinkSync(bak); } catch { /* none yet */ }
  const fd = openSync(bak, "wx", 0o600);
  try { writeSync(fd, readFileSync(path)); } finally { closeSync(fd); }
  try { chmodSync(bak, 0o600); } catch { /* best effort on filesystems without modes */ }
}

/** H1: the core reads config.json itself. H2: the supervisor's config.get snapshot replaces this call site. */
export function loadConfig(path: string): { config: HarnessConfig; created: boolean } {
  if (!existsSync(path)) { const d = defaults(); writeConfigAtomic(path, d); return { config: d, created: true }; }
  const m = migrateChecked(path, readJson(path));
  const r = validateConfig(m.config);
  if (!r.ok) throw new ConfigInvalid(path, r.errors);
  if (m.applied) { writeBackup(path, m.from); writeConfigAtomic(path, r.config); }
  return { config: r.config, created: false };
}

/** config.json as it is, never written (the supervisor owns it): the defaults when it is missing, migrated in memory.
 *  Throws ConfigInvalid like loadConfig. */
export function readConfigFile(path: string): HarnessConfig {
  if (!existsSync(path)) return defaults();
  const r = validateConfig(migrateChecked(path, readJson(path)).config);
  if (!r.ok) throw new ConfigInvalid(path, r.errors);
  return r.config;
}
