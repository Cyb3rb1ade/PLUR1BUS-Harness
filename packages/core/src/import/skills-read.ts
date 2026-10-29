/** Asynchronous skill read graph; pure hashes and portability rules remain shared with the legacy projection. */
import { createHash } from "node:crypto";
import { isSecretFileName } from "./readonly.ts";
import { frontmatter } from "./yaml-lite.ts";
import { SourceReader } from "./source-reader.ts";
import type { SkillRoot } from "./types.ts";
import { SKIP_NAMES, SCRIPT_EXT, SKILL_ID, DEFAULT_MAX_SKILL_BYTES, DEFAULT_MAX_SKILL_FILES, caseInsensitiveTarget,
  caseCollisions, unportableName, folderHash, folderTextHash, textHashOf, type CopyEntry, type ScannedSkill, type ScanOptions } from "./skills-scan.ts";

async function findSkillDirs(root: string, reader: SourceReader, maxDepth = 3): Promise<string[]> {
  const { join } = reader.paths;
  const out: string[] = [];
  const walk = async (dir: string, depth: number): Promise<void> => {
    let names: string[];
    try { names = await reader.names(dir); } catch (error) { SourceReader.refuseFatal(error); return; }
    for (const name of names) {
      if (name.startsWith(".") || SKIP_NAMES.has(name) || name === "node_modules") continue;
      const p = join(dir, name);
      let st;
      try { st = await reader.stat(p); } catch (error) { SourceReader.refuseFatal(error); continue; }
      if (st?.type !== "directory") continue;
      let hasSkill = false;
      try { hasSkill = await reader.isFile(join(p, "SKILL.md")); } catch (error) { SourceReader.refuseFatal(error); /* none */ }
      if (hasSkill) out.push(p);
      else if (depth < maxDepth) await walk(p, depth + 1);
    }
  };
  await walk(root, 1);
  return out;
}

async function scanSkill(dir: string, root: Pick<SkillRoot, "tier" | "agentId" | "precedence">, reader: SourceReader, opts: ScanOptions = {}): Promise<ScannedSkill> {
  const { basename, join, relative, sep, extname } = reader.paths;
  const inside = (base: string, path: string) => path === base || path.startsWith(base.endsWith(sep) ? base : base + sep);
  const real = (path: string) => reader.fs.realpath(path);
  const maxBytes = opts.maxBytes ?? DEFAULT_MAX_SKILL_BYTES;
  const maxFiles = opts.maxFiles ?? DEFAULT_MAX_SKILL_FILES;
  const target = opts.targetPlatform ?? process.platform;
  const id = basename(dir).toLowerCase();
  const problems: string[] = [];
  if (!SKILL_ID.test(id)) problems.push("invalid-id");
  else if (target === "win32" && unportableName(id)) problems.push(`unportable-name:${id}`);
  let rootIsSymlink = false;
  try { rootIsSymlink = (await reader.stat(dir, false))?.type === "symlink"; } catch (error) { SourceReader.refuseFatal(error); /* reported below */ }
  let realRoot = dir;
  try { realRoot = await real(dir); } catch (error) { SourceReader.refuseFatal(error); problems.push("unreadable"); }
  const skipped = { symlinkEscapes: [] as string[], symlinkDirs: [] as string[], secretFiles: 0, vcs: 0 };
  const entries: CopyEntry[] = [];
  const shebang = new Set<string>();
  let bytes = 0; let tooLarge = false;
  const walk = async (abs: string, rel: string, depth: number): Promise<void> => {
    if (depth > 32 || tooLarge) return;
    let names: string[];
    try { names = await reader.names(abs); } catch (error) { SourceReader.refuseFatal(error); problems.push(`unreadable:${rel || "."}`); return; }
    for (const name of names) {
      if (tooLarge) return;
      const a = join(abs, name);
      const r = rel ? `${rel}/${name}` : name;
      if (SKIP_NAMES.has(name)) { skipped.vcs++; continue; }
      let st;
      try { st = await reader.stat(a, false); if (!st) continue; } catch (error) { SourceReader.refuseFatal(error); continue; }
      if (isSecretFileName(name) && st.type !== "directory") { skipped.secretFiles++; continue; }
      let source = a;
      if (st.type === "symlink") {
        let target: string;
        try { target = await real(a); } catch (error) { SourceReader.refuseFatal(error); skipped.symlinkEscapes.push(r); continue; }
        if (!inside(realRoot, target)) { skipped.symlinkEscapes.push(r); continue; }
        try { st = await reader.stat(target); if (!st) continue; } catch (error) { SourceReader.refuseFatal(error); skipped.symlinkEscapes.push(r); continue; }
        if (st.type === "directory") { skipped.symlinkDirs.push(r); continue; }
        // A link under a harmless name must not carry a credential or VCS file of the same skill into the copy: the name
        // check above saw only the link's own name, so the resolved target's name (and, for VCS metadata, every folder on
        // its way, as the walk skips those folders) is checked too. Fail closed: such a link is left out and counted.
        if (isSecretFileName(basename(target))) { skipped.secretFiles++; continue; }
        if (relative(realRoot, target).split(sep).some((n) => SKIP_NAMES.has(n))) { skipped.vcs++; continue; }
        source = target;
      }
      if (st.type === "directory") { await walk(a, r, depth + 1); continue; }
      if (st.type !== "file") continue;
      bytes += st.size;
      if (bytes > maxBytes || entries.length + 1 > maxFiles) { tooLarge = true; return; }
      const content = await reader.read(source, maxBytes);
      if (content[0] === 35 && content[1] === 33) shebang.add(r);
      const sha256 = createHash("sha256").update(content).digest("hex");
      entries.push({ rel: r, abs: source, mode: st.mode ?? 0o644, bytes: st.size, sha256, textSha256: textHashOf(content, sha256) });
    }
  };
  if (!problems.includes("unreadable")) await walk(realRoot, "", 0);
  if (tooLarge) problems.push("too-large");
  if (!tooLarge && target === "win32") for (const e of entries) if (e.rel.split("/").some((n) => unportableName(n))) problems.push(`unportable-name:${e.rel}`);
  if (!tooLarge && caseInsensitiveTarget(target)) for (const [a, b] of caseCollisions(entries.map((e) => e.rel))) problems.push(`case-collision:${a}|${b}`);
  const skillMd = entries.find((e) => e.rel === "SKILL.md");
  if (!tooLarge && !skillMd) problems.push("no-skill-md");
  let name: string | null = null; let description: string | null = null;
  if (skillMd) {
    try {
      const fm = frontmatter((await reader.text(skillMd.abs, maxBytes)).slice(0, 64 * 1024));
      if (typeof fm?.name === "string") name = fm.name.slice(0, 200);
      if (typeof fm?.description === "string") { const d = fm.description.trim().replace(/\s+/g, " "); description = d.length > 300 ? `${d.slice(0, 299)}…` : d; }
    } catch (error) { SourceReader.refuseFatal(error); /* frontmatter stays null */ }
  }
  const scriptEntries = entries.filter((e) => (e.mode & 0o111) !== 0 || SCRIPT_EXT.has(extname(e.rel).toLowerCase()) || e.rel.startsWith("scripts/") || shebang.has(e.rel));
  return {
    id, name, description, path: dir, realPath: realRoot, rootIsSymlink, tier: root.tier, agentId: root.agentId, precedence: root.precedence,
    bytes: tooLarge ? bytes : entries.reduce((n, e) => n + e.bytes, 0), files: entries.length,
    sha256: tooLarge ? null : folderHash(entries), textSha256: tooLarge ? null : folderTextHash(entries), hasScripts: scriptEntries.length > 0 || skipped.symlinkDirs.some((d) => d.startsWith("scripts")), scripts: scriptEntries.length,
    skipped, problems, shadowedBy: null, entries: tooLarge ? [] : entries,
  };
}

export async function scanSkillsAsync(roots: readonly SkillRoot[], opts: ScanOptions & { reader: SourceReader }): Promise<ScannedSkill[]> {
  const { reader } = opts;
  const { dirname, basename } = reader.paths;
  const ordered = roots.map((r, i) => ({ r, i })).sort((a, b) => b.r.precedence - a.r.precedence || a.i - b.i).map((x) => x.r);
  const seenDirs = new Set<string>();
  const winners = new Map<string, { path: string; root: SkillRoot }>();
  const out: ScannedSkill[] = [];
  for (const root of ordered) {
    for (const dir of await findSkillDirs(root.dir, reader)) {
      let r = dir;
      try { r = await reader.fs.realpath(dir); } catch (error) { SourceReader.refuseFatal(error); /* scanSkill reports it */ }
      if (seenDirs.has(r)) continue;
      seenDirs.add(r);
      const s = await scanSkill(dir, root, reader, opts);
      const w = winners.get(s.id);
      if (!w) winners.set(s.id, { path: s.path, root });
      else if (w.root === root && dirname(w.path) === dirname(s.path) && basename(w.path) !== basename(s.path)) s.problems.push(`case-collision:${basename(w.path)}|${basename(s.path)}`);
      else s.shadowedBy = w.path;
      out.push(s);
    }
  }
  return out;
}
