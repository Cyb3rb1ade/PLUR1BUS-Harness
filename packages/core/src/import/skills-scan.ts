// Skill discovery and the folder hash `plur1bus-skill-sha256/v1` (docs/import.md §8.4, §9.2, §9.3). A skill is a
// directory holding SKILL.md. The scan decides exactly which files a copy would carry — symlink escapes, directory
// symlinks, credential files and VCS metadata are left out — and hashes those, so detect, the import and a later
// re-check all agree on one number.
import { createHash } from "node:crypto";
import { lstatSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { basename, extname, join, sep } from "node:path";
import { isSecretFileName } from "./readonly.ts";
import { frontmatter } from "./yaml-lite.ts";
import type { SkillRoot } from "./types.ts";

export const SKILL_ID = /^[a-z0-9][a-z0-9._-]{0,63}$/;
export const DEFAULT_MAX_SKILL_BYTES = 8 * 1024 * 1024;
export const DEFAULT_MAX_SKILL_FILES = 2000;
const SKIP_NAMES = new Set([".git", ".DS_Store", "__pycache__", ".hg", ".svn"]);
const SCRIPT_EXT = new Set([".sh", ".bash", ".zsh", ".fish", ".py", ".js", ".mjs", ".cjs", ".ts", ".rb", ".pl", ".php", ".ps1", ".psm1", ".bat", ".cmd", ".exe", ".bin"]);

export interface CopyEntry { rel: string; abs: string; mode: number; bytes: number; sha256: string }

export interface ScannedSkill {
  id: string;
  name: string | null;
  description: string | null;
  path: string;
  realPath: string;
  rootIsSymlink: boolean;
  tier: string;
  agentId: string | null;
  precedence: number;
  bytes: number;
  files: number;
  sha256: string | null;
  hasScripts: boolean;
  scripts: number;
  skipped: { symlinkEscapes: string[]; symlinkDirs: string[]; secretFiles: number; vcs: number };
  problems: string[];
  shadowedBy: string | null;
  entries: CopyEntry[];
}

export interface ScanOptions { maxBytes?: number; maxFiles?: number }

/** Directories under `root` that hold a SKILL.md, down to `maxDepth` levels (Hermes nests `<category>/<name>`).
 *  A found skill is not descended into; dot-directories are skipped; a symlinked candidate directory is followed. */
export function findSkillDirs(root: string, maxDepth = 3): string[] {
  const out: string[] = [];
  const walk = (dir: string, depth: number) => {
    let names: string[];
    try { names = readdirSync(dir).sort(); } catch { return; }
    for (const name of names) {
      if (name.startsWith(".") || SKIP_NAMES.has(name) || name === "node_modules") continue;
      const p = join(dir, name);
      let st;
      try { st = statSync(p); } catch { continue; }
      if (!st.isDirectory()) continue;
      let hasSkill = false;
      try { hasSkill = lstatSync(join(p, "SKILL.md")).isFile() || statSync(join(p, "SKILL.md")).isFile(); } catch { /* none */ }
      if (hasSkill) out.push(p);
      else if (depth < maxDepth) walk(p, depth + 1);
    }
  };
  walk(root, 1);
  return out;
}

const inside = (root: string, p: string) => p === root || p.startsWith(root.endsWith(sep) ? root : root + sep);

/** The v1 folder hash over copy entries (already sorted by rel). */
export function folderHash(entries: readonly CopyEntry[]): string {
  const h = createHash("sha256");
  for (const e of [...entries].sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0))) h.update(`${e.rel}\0${e.sha256}\n`);
  return `sha256:${h.digest("hex")}`;
}

export function scanSkill(dir: string, root: Pick<SkillRoot, "tier" | "agentId" | "precedence">, opts: ScanOptions = {}): ScannedSkill {
  const maxBytes = opts.maxBytes ?? DEFAULT_MAX_SKILL_BYTES;
  const maxFiles = opts.maxFiles ?? DEFAULT_MAX_SKILL_FILES;
  const id = basename(dir).toLowerCase();
  const problems: string[] = [];
  if (!SKILL_ID.test(id)) problems.push("invalid-id");
  let rootIsSymlink = false;
  try { rootIsSymlink = lstatSync(dir).isSymbolicLink(); } catch { /* reported below */ }
  let realRoot = dir;
  try { realRoot = realpathSync(dir); } catch { problems.push("unreadable"); }
  const skipped = { symlinkEscapes: [] as string[], symlinkDirs: [] as string[], secretFiles: 0, vcs: 0 };
  const entries: CopyEntry[] = [];
  let bytes = 0; let tooLarge = false;
  const walk = (abs: string, rel: string, depth: number) => {
    if (depth > 32 || tooLarge) return;
    let names: string[];
    try { names = readdirSync(abs).sort(); } catch { problems.push(`unreadable:${rel || "."}`); return; }
    for (const name of names) {
      if (tooLarge) return;
      const a = join(abs, name);
      const r = rel ? `${rel}/${name}` : name;
      if (SKIP_NAMES.has(name)) { skipped.vcs++; continue; }
      let st;
      try { st = lstatSync(a); } catch { continue; }
      if (isSecretFileName(name) && !st.isDirectory()) { skipped.secretFiles++; continue; }
      let source = a;
      if (st.isSymbolicLink()) {
        let target: string;
        try { target = realpathSync(a); } catch { skipped.symlinkEscapes.push(r); continue; }
        if (!inside(realRoot, target)) { skipped.symlinkEscapes.push(r); continue; }
        try { st = statSync(target); } catch { skipped.symlinkEscapes.push(r); continue; }
        if (st.isDirectory()) { skipped.symlinkDirs.push(r); continue; }
        source = target;
      }
      if (st.isDirectory()) { walk(a, r, depth + 1); continue; }
      if (!st.isFile()) continue;
      bytes += st.size;
      if (bytes > maxBytes || entries.length + 1 > maxFiles) { tooLarge = true; return; }
      const content = readFileSync(source);
      entries.push({ rel: r, abs: source, mode: st.mode & 0o777, bytes: st.size, sha256: createHash("sha256").update(content).digest("hex") });
    }
  };
  if (!problems.includes("unreadable")) walk(realRoot, "", 0);
  if (tooLarge) problems.push("too-large");
  const skillMd = entries.find((e) => e.rel === "SKILL.md");
  if (!tooLarge && !skillMd) problems.push("no-skill-md");
  let name: string | null = null; let description: string | null = null;
  if (skillMd) {
    try {
      const fm = frontmatter(readFileSync(skillMd.abs, "utf8").slice(0, 64 * 1024));
      if (typeof fm?.name === "string") name = fm.name.slice(0, 200);
      if (typeof fm?.description === "string") { const d = fm.description.trim().replace(/\s+/g, " "); description = d.length > 300 ? `${d.slice(0, 299)}…` : d; }
    } catch { /* frontmatter stays null */ }
  }
  const scriptEntries = entries.filter((e) => (e.mode & 0o111) !== 0 || SCRIPT_EXT.has(extname(e.rel).toLowerCase()) || e.rel.startsWith("scripts/") || startsWithShebang(e.abs));
  return {
    id, name, description, path: dir, realPath: realRoot, rootIsSymlink, tier: root.tier, agentId: root.agentId, precedence: root.precedence,
    bytes: tooLarge ? bytes : entries.reduce((n, e) => n + e.bytes, 0), files: entries.length,
    sha256: tooLarge ? null : folderHash(entries), hasScripts: scriptEntries.length > 0 || skipped.symlinkDirs.some((d) => d.startsWith("scripts")), scripts: scriptEntries.length,
    skipped, problems, shadowedBy: null, entries: tooLarge ? [] : entries,
  };
}

function startsWithShebang(path: string): boolean {
  try { const b = readFileSync(path).subarray(0, 2); return b[0] === 0x23 && b[1] === 0x21; } catch { return false; }
}

/** Every skill under `roots`, highest precedence first (within a precedence, in root order); a later skill with an id
 *  already seen gets `shadowedBy` = the winner's path. */
export function scanSkills(roots: readonly SkillRoot[], opts: ScanOptions = {}): ScannedSkill[] {
  const ordered = roots.map((r, i) => ({ r, i })).sort((a, b) => b.r.precedence - a.r.precedence || a.i - b.i).map((x) => x.r);
  const seenDirs = new Set<string>();
  const winners = new Map<string, string>();
  const out: ScannedSkill[] = [];
  for (const root of ordered) {
    for (const dir of findSkillDirs(root.dir)) {
      let real = dir;
      try { real = realpathSync(dir); } catch { /* scanSkill reports it */ }
      if (seenDirs.has(real)) continue;
      seenDirs.add(real);
      const s = scanSkill(dir, root, opts);
      const w = winners.get(s.id);
      if (w) s.shadowedBy = w; else winners.set(s.id, s.path);
      out.push(s);
    }
  }
  return out;
}
