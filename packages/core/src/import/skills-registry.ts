// The harness skill store (docs/import.md §9.1): `<home>/skills/<id>/` plus `<home>/skills/index.json`
// `{version: 1, skills: [{id, source, sourcePath, sha256, enabled, importedAt}]}`. Kept minimal on purpose for the
// extensions-ecosystem spec to adopt: writers preserve fields they do not own, the file is replaced atomically.
import { createHash, randomUUID } from "node:crypto";
import { closeSync, existsSync, fstatSync, linkSync, mkdirSync, openSync, readdirSync, readFileSync, writeFileSync, type BigIntStats } from "node:fs";
import { renameRetry, rmRetry } from "./fs-retry.ts";
import { dirname, join } from "node:path";
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
  renameRetry(tmp, p);
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

/** A lock with no readable pid younger than this is a holder between its exclusive create and its write, not a
 *  leftover: it is refused, not taken over. */
export const LOCK_UNREADABLE_GRACE_MS = 10_000;

interface LockBody { pid?: number; nonce?: string }
/** Which file a path named: dev/ino (bigint, so NTFS file ids keep their low bits) plus mtime and birthtime in ns —
 *  two empty lock files at one path differ in their times even when the inode number is reused. */
interface FileIdent { dev: bigint; ino: bigint; mtimeNs: bigint; birthtimeNs: bigint }
/** One consistent view of a lock: contents and identity read through the same open handle (R2 M1). */
interface Snapshot { text: string | null; id: FileIdent }

const parseLock = (t: string | null): LockBody | null => {
  if (t === null) return null;
  try { const v = JSON.parse(t) as unknown; return v && typeof v === "object" ? v as LockBody : null; } catch { return null; }
};
const lockPid = (b: LockBody | null): number | undefined => (Number.isInteger(b?.pid) && b!.pid! > 0 ? b!.pid : undefined);
const identOf = (s: BigIntStats): FileIdent => ({ dev: s.dev, ino: s.ino, mtimeNs: s.mtimeNs, birthtimeNs: s.birthtimeNs });
const sameIdent = (a: FileIdent, b: FileIdent) => a.dev === b.dev && a.ino === b.ino && a.mtimeNs === b.mtimeNs && a.birthtimeNs === b.birthtimeNs;

/** Opens `p` once; fstat and read go through that handle. null when it is gone; throws on any other open error. */
function snapshot(p: string): Snapshot | null {
  let fd: number;
  try { fd = openSync(p, "r"); } catch (e) { if ((e as NodeJS.ErrnoException).code === "ENOENT") return null; throw e; }
  try {
    const id = identOf(fstatSync(fd, { bigint: true }));
    let text: string | null;
    try { text = readFileSync(fd, "utf8"); } catch { text = null; }
    return { text, id };
  } finally {
    closeSync(fd);
  }
}
const trySnapshot = (p: string): Snapshot | null => { try { return snapshot(p); } catch { return null; } };

/** Stale = the holder pid is dead, or it is ours (ext mutations are serialised in-process, X1-R15), or there is no
 *  readable pid and the file is older than the grace. A live foreign holder is never stale. */
function lockStale(s: Snapshot): boolean {
  const pid = lockPid(parseLock(s.text));
  if (pid === undefined) return Date.now() - Number(s.id.mtimeNs / 1_000_000n) > LOCK_UNREADABLE_GRACE_MS;
  return pid === process.pid || !alive(pid);
}

/** Puts a moved-aside lock back without overwriting a newer one (link fails with EEXIST), then drops the moved name. */
function putBack(moved: string, p: string): void {
  try { linkSync(moved, p); } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code !== "EEXIST" && code !== "ENOENT" && !existsSync(p)) { try { renameRetry(moved, p); return; } catch { /* leftover: swept */ } }
  }
  try { rmRetry(moved, { force: true }); } catch { /* leftover: swept */ }
}

/** Removes the judged lock only if the moved-aside file is still it (same identity incl. times, same contents). */
function breakStale(p: string, judged: Snapshot): boolean {
  const moved = `${p}.break-${randomUUID()}`;
  try { renameRetry(p, moved); } catch { return false; }
  const now = trySnapshot(moved);
  if (now && sameIdent(now.id, judged.id) && now.text === judged.text) {
    try { rmRetry(moved, { force: true }); } catch { /* leftover: swept */ }
    return true;
  }
  putBack(moved, p); // a fresh lock took its place meanwhile: never delete it
  return false;
}

/** Sweeps `.lock.rel-*` / `.lock.break-*` leftovers (a crash mid-release) by the same stale rule. */
function sweepLeftovers(p: string): void {
  const dir = dirname(p);
  let names: string[];
  try { names = readdirSync(dir); } catch { return; }
  for (const n of names) {
    if (!/^\.lock\.(rel|break)-/.test(n)) continue;
    const q = join(dir, n);
    const s = trySnapshot(q);
    if (s && lockStale(s)) { try { rmRetry(q, { force: true }); } catch { /* next time */ } }
  }
}

/** Releases only a lock that still holds `nonce`: rename aside, re-read, delete or put back (no check-then-unlink). A
 *  failed re-read is retried once; what cannot be read is put back, never deleted. */
function releaseLock(p: string, nonce: string): void {
  const moved = `${p}.rel-${nonce}`;
  try { renameRetry(p, moved); } catch { return; } // gone (taken over) or busy: nothing of ours to delete
  const read = () => { try { return readFileSync(moved, "utf8"); } catch { return null; } };
  const text = read() ?? read();
  if (text === null || parseLock(text)?.nonce !== nonce) { putBack(moved, p); return; } // someone else's: never delete
  try { rmRetry(moved, { force: true }); } catch { /* leftover: swept */ }
}

/** Takes `<home>/imports/.lock` (exclusive create, holding `{pid, at, nonce}`) — outside `skills/`, so a rollback that
 *  swaps the whole `skills/` directory never moves its own lock. A live foreign holder is E_LOCKED; a lock whose pid is
 *  gone (or ours, or unreadable for longer than the grace) is taken over — judged from one open handle, then moved
 *  aside and re-verified as the judged file. The returned release function removes the lock only while it still holds
 *  our nonce (N1: it used to check the pid, then delete, so a lock taken over in between was deleted too). Shared with
 *  the CLI's `ext::index::lock_skills`. */
export function acquireLock(home: string): () => void {
  mkdirSync(importsDir(home), { recursive: true });
  const p = join(importsDir(home), ".lock");
  sweepLeftovers(p);
  for (let attempt = 0; attempt < 2; attempt++) {
    let fd: number;
    try {
      fd = openSync(p, "wx", 0o600);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
      let judged: Snapshot | null;
      try { judged = snapshot(p); } catch (err) {
        throw new ImportError("E_LOCKED", "skills-locked", `cannot judge ${p} (${(err as Error).message}); another import may hold it`, 3);
      }
      if (!judged) continue; // gone meanwhile: try again
      if (!lockStale(judged)) {
        const pid = lockPid(parseLock(judged.text));
        throw new ImportError("E_LOCKED", "skills-locked", pid === undefined ? `another import is taking ${p}` : `another import (pid ${pid}) holds ${p}`, 3);
      }
      breakStale(p, judged);
      continue;
    }
    const nonce = randomUUID();
    try {
      writeFileSync(fd, JSON.stringify({ pid: process.pid, at: new Date().toISOString(), nonce }));
    } catch (e) {
      let own: Snapshot | null = null;
      try { own = { text: (() => { try { return readFileSync(p, "utf8"); } catch { return null; } })(), id: identOf(fstatSync(fd, { bigint: true })) }; } catch { /* unknown */ }
      try { closeSync(fd); } catch { /* ignore */ }
      if (own) breakStale(p, own); // our own nonce-less file, identified through its handle
      throw e;
    }
    closeSync(fd);
    let released = false;
    return () => { if (!released) { released = true; releaseLock(p, nonce); } };
  }
  throw new ImportError("E_LOCKED", "skills-locked", `could not take ${p}`, 3);
}

function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch (e) { return (e as NodeJS.ErrnoException).code === "EPERM"; }
}
