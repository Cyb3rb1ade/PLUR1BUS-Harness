// The harness skill store (docs/import.md §9.1): `<home>/skills/<id>/` plus `<home>/skills/index.json`
// `{version: 1, skills: [{id, source, sourcePath, sha256, enabled, importedAt}]}`. Kept minimal on purpose for the
// extensions-ecosystem spec to adopt: writers preserve fields they do not own, the file is replaced atomically.
import { createHash } from "node:crypto";
import { closeSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { isDir } from "./readonly.ts";
import { scanSkill, SKILL_ID } from "./skills-scan.ts";
import { ImportError } from "./types.ts";

export const INDEX_VERSION = 1;
export interface IndexEntry { id: string; source: string; sourcePath: string; sha256: string; enabled: boolean; importedAt: string; [k: string]: unknown }
export interface SkillIndex { version: number; skills: IndexEntry[]; [k: string]: unknown }

export const skillsDir = (home: string) => join(home, "skills");
export const indexPath = (home: string) => join(skillsDir(home), "index.json");
const RESERVED = new Set(["index.json", ".staging"]);

export function readIndex(home: string): SkillIndex {
  const p = indexPath(home);
  if (!existsSync(p)) return { version: INDEX_VERSION, skills: [] };
  let v: unknown;
  try { v = JSON.parse(readFileSync(p, "utf8")); } catch (e) { throw new ImportError("E_IMPORT_FAILED", "index-invalid", `${p}: ${(e as Error).message}`, 1); }
  const idx = v as SkillIndex;
  if (!idx || typeof idx !== "object" || !Array.isArray(idx.skills)) throw new ImportError("E_IMPORT_FAILED", "index-invalid", `${p}: expected {version, skills: [...]}`, 1);
  if (typeof idx.version === "number" && idx.version > INDEX_VERSION) throw new ImportError("E_IMPORT_FAILED", "index-newer", `${p}: index version ${idx.version} is newer than ${INDEX_VERSION}`, 1);
  for (const e of idx.skills) if (!e || typeof e.id !== "string" || !SKILL_ID.test(e.id)) throw new ImportError("E_IMPORT_FAILED", "index-invalid", `${p}: invalid skill id ${JSON.stringify(e?.id)}`, 1);
  return idx;
}

/** SHA-256 of index.json's bytes, or null when there is none — what a rollback checks for staleness. */
export function indexDigest(home: string): string | null {
  const p = indexPath(home);
  return existsSync(p) ? `sha256:${createHash("sha256").update(readFileSync(p)).digest("hex")}` : null;
}

export function writeIndex(home: string, idx: SkillIndex): void {
  mkdirSync(skillsDir(home), { recursive: true });
  const sorted: SkillIndex = { ...idx, version: INDEX_VERSION, skills: [...idx.skills].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)) };
  const p = indexPath(home);
  const tmp = `${p}.tmp-${process.pid}`;
  writeFileSync(tmp, `${JSON.stringify(sorted, null, 2)}\n`, { mode: 0o600 });
  renameSync(tmp, p);
}

/** Skill folder ids present in the store (not the reserved names). */
export function storedIds(home: string): string[] {
  const d = skillsDir(home);
  if (!isDir(d)) return [];
  const out: string[] = [];
  for (const n of readdirSafe(d)) if (!RESERVED.has(n) && SKILL_ID.test(n) && isDir(join(d, n))) out.push(n);
  return out.sort();
}

function readdirSafe(d: string): string[] { try { return readdirSync(d); } catch { return []; } }

export interface HarnessSkillState { exists: boolean; indexed: boolean; sha256: string | null; textSha256?: string | null }
/** The harness's own copy of `id`: present on disk and/or in the index, and its folder hash (from disk). */
export function harnessSkillState(home: string, id: string, idx: SkillIndex = readIndex(home)): HarnessSkillState {
  const dir = join(skillsDir(home), id);
  const exists = isDir(dir);
  const entry = idx.skills.find((e) => e.id === id);
  if (!exists) return { exists, indexed: !!entry, sha256: entry?.sha256 ?? null, textSha256: null };
  const s = scanSkill(dir, { tier: "harness", agentId: null, precedence: 0 }, { maxBytes: 1024 * 1024 * 1024, maxFiles: 1_000_000, targetPlatform: "linux" });
  return { exists, indexed: !!entry, sha256: s.sha256, textSha256: s.textSha256 };
}

export const importsDir = (home: string) => join(home, "imports");

/** Takes `<home>/imports/.lock` (exclusive create, holding our pid) — outside `skills/`, so a rollback that swaps the
 *  whole `skills/` directory never moves its own lock. A lock whose pid is gone is taken over; a live holder is
 *  E_LOCKED. Returns the release function. */
export function acquireLock(home: string): () => void {
  mkdirSync(importsDir(home), { recursive: true });
  const p = join(importsDir(home), ".lock");
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = openSync(p, "wx", 0o600);
      writeFileSync(fd, JSON.stringify({ pid: process.pid, at: new Date().toISOString() }));
      closeSync(fd);
      return () => { try { const cur = JSON.parse(readFileSync(p, "utf8")) as { pid?: number }; if (cur.pid === process.pid) rmSync(p, { force: true }); } catch { /* gone */ } };
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
      let pid: number | undefined;
      try { pid = (JSON.parse(readFileSync(p, "utf8")) as { pid?: number }).pid; } catch { /* unreadable: treat as stale */ }
      if (pid !== undefined && pid !== process.pid && alive(pid)) throw new ImportError("E_LOCKED", "skills-locked", `another import (pid ${pid}) holds ${p}`, 3);
      rmSync(p, { force: true });
    }
  }
  throw new ImportError("E_LOCKED", "skills-locked", `could not take ${p}`, 3);
}

function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch (e) { return (e as NodeJS.ErrnoException).code === "EPERM"; }
}
