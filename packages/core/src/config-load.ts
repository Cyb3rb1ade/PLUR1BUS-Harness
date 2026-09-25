import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { defaults, migrate, validate, type HarnessConfig } from "@plur1bus/config-schema";

export class ConfigInvalid extends Error {
  errors: string[];
  constructor(path: string, errors: string[]) { super(`${path}: ${errors.join("; ")}`); this.name = "ConfigInvalid"; this.errors = errors; }
}

export function writeConfigAtomic(path: string, config: HarnessConfig): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp-${process.pid}`;
  writeFileSync(tmp, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  renameSync(tmp, path);
}

/** H1: the core reads config.json itself. H2: the supervisor's config.get snapshot replaces this call site. */
export function loadConfig(path: string): { config: HarnessConfig; created: boolean } {
  if (!existsSync(path)) { const d = defaults(); writeConfigAtomic(path, d); return { config: d, created: true }; }
  let raw: unknown;
  try { raw = JSON.parse(readFileSync(path, "utf8")); } catch (e) { throw new ConfigInvalid(path, [`not JSON: ${(e as Error).message}`]); }
  const m = migrate(raw);
  const r = validate(m.config);
  if (!r.ok) throw new ConfigInvalid(path, r.errors);
  if (m.applied) { writeFileSync(`${path}.bak-${m.from}`, readFileSync(path)); writeConfigAtomic(path, r.config); }
  return { config: r.config, created: false };
}
