// Skills import (docs/import.md §9): plan, apply, rollback. Copy-never-move, idempotent per folder hash, resumable
// after interruption, conflicts per --on-conflict, imported skills disabled unless --enable, snapshot + report per run.
import { randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { copyFileRetry, cpRetry, renameRetry, rmRetry } from "./fs-retry.ts";
import { basename, join, resolve, sep } from "node:path";
import { readSource, type SourceOptions } from "./source.ts";
import { acquireLock, harnessSkillState, importsDir, indexDigest, readIndex, skillsDir, storedIds, writeIndex, type HarnessSkillState, type SkillIndex } from "./skills-registry.ts";
import { scanSkill, SKILL_ID, type ScannedSkill } from "./skills-scan.ts";
import { ImportError, type SourceReport, type SourceType } from "./types.ts";

export type OnConflict = "skip" | "rename" | "replace";
export type SkillAction = "import" | "adopt" | "skip-identical" | "conflict-skip" | "rename" | "replace" | "refuse";
export interface PlannedSkill { skill: ScannedSkill; action: SkillAction; targetId: string | null; reason: string | null; harness: HarnessSkillState }

interface Taken { sha: string | null; text: string | null; origin: "harness" | "run"; state: HarnessSkillState }

function renameTarget(id: string, sourceType: SourceType, taken: Map<string, Taken>): string {
  for (let n = 1; n < 10_000; n++) {
    const suffix = n === 1 ? `-${sourceType}` : `-${sourceType}-${n}`;
    const cand = `${id.slice(0, 64 - suffix.length)}${suffix}`;
    if (SKILL_ID.test(cand) && !taken.has(cand)) return cand;
  }
  throw new Error(`no free rename target for ${id}`);
}

/** The action for every scanned skill, in scan order, against the harness store and the skills planned before it. */
export function planSkills(scanned: readonly ScannedSkill[], home: string, sourceType: SourceType, onConflict: OnConflict, idx: SkillIndex = readIndex(home)): PlannedSkill[] {
  const taken = new Map<string, Taken>();
  const none: HarnessSkillState = { exists: false, indexed: false, sha256: null };
  for (const id of new Set([...idx.skills.map((e) => e.id), ...storedIds(home)])) {
    const state = harnessSkillState(home, id, idx);
    taken.set(id, { sha: state.sha256, text: state.textSha256 ?? null, origin: "harness", state });
  }
  const out: PlannedSkill[] = [];
  for (const skill of scanned) {
    const t = taken.get(skill.id);
    const harness = t?.origin === "harness" ? t.state : none;
    if (skill.problems.length) { out.push({ skill, action: "refuse", targetId: null, reason: skill.problems.join(","), harness }); continue; }
    const claim = (id: string) => taken.set(id, { sha: skill.sha256, text: skill.textSha256, origin: "run", state: none });
    if (!t) { claim(skill.id); out.push({ skill, action: "import", targetId: skill.id, reason: null, harness }); continue; }
    // Same bytes, or the same text up to CRLF/BOM (a Windows checkout of the same skill, §9.2 text hash).
    const textTwin = t.sha !== skill.sha256 && t.text !== null && t.text === skill.textSha256;
    if (t.sha === skill.sha256 || textTwin) {
      if (t.origin === "run") out.push({ skill, action: "skip-identical", targetId: skill.id, reason: "duplicate-in-source", harness });
      else if (t.state.exists && !t.state.indexed) out.push({ skill, action: "adopt", targetId: skill.id, reason: "folder-present-not-indexed", harness });
      else if (!t.state.exists) { out.push({ skill, action: "import", targetId: skill.id, reason: "index-entry-without-folder", harness }); t.state = { ...t.state, exists: true }; }
      else out.push({ skill, action: "skip-identical", targetId: skill.id, reason: textTwin ? "line-endings-differ" : null, harness });
      continue;
    }
    if (t.origin === "harness" && !t.state.exists) {
      // Indexed but no folder, different hash: nothing on disk to protect.
      out.push({ skill, action: "import", targetId: skill.id, reason: "index-entry-without-folder", harness }); taken.set(skill.id, { sha: skill.sha256, text: skill.textSha256, origin: "run", state: none }); continue;
    }
    if (onConflict === "rename") { const id = renameTarget(skill.id, sourceType, taken); claim(id); out.push({ skill, action: "rename", targetId: id, reason: t.origin === "run" ? "shadowed-in-source" : "id-taken", harness }); continue; }
    if (onConflict === "replace" && t.origin === "harness") { taken.set(skill.id, { sha: skill.sha256, text: skill.textSha256, origin: "run", state: none }); out.push({ skill, action: "replace", targetId: skill.id, reason: "id-taken", harness }); continue; }
    out.push({ skill, action: "conflict-skip", targetId: null, reason: t.origin === "run" ? "shadowed-in-source" : "id-taken", harness });
  }
  return out;
}

export const RUN_ID = /^\d{8}T\d{6}Z-[0-9a-f]{8}$/;
export function newRunId(now: Date = new Date()): string {
  return `${now.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "")}-${randomBytes(4).toString("hex")}`;
}

export interface ReportSkill {
  id: string; targetId: string | null; tier: string; agentId: string | null; sourcePath: string; sha256: string | null;
  bytes: number; files: number; hasScripts: boolean; action: SkillAction;
  outcome: "planned" | "imported" | "renamed" | "replaced" | "adopted" | "skipped" | "refused" | "failed";
  reason: string | null; enabled: boolean | null; backupPath: string | null;
}

export interface SkillsReport {
  runId: string;
  sourceType: SourceType;
  source: { root: string; resolvedFrom: string; profile: string | null };
  version: SourceReport["version"];
  mode: "dry-run" | "apply";
  status: "planned" | "running" | "completed";
  options: { onConflict: OnConflict; enable: boolean; maxSkillBytes: number };
  startedAt: string;
  finishedAt: string | null;
  harness: { home: string; skillsDir: string };
  snapshot: { path: string; existed: boolean } | null;
  reportPath: string | null;
  indexSha256Before: string | null;
  indexSha256After: string | null;
  skills: ReportSkill[];
  counts: Record<string, number>;
  errors: { id: string; reason: string }[];
  warnings: string[];
}

export interface SkillsOptions extends SourceOptions { apply: boolean; enable: boolean; onConflict: OnConflict; maxBytes: number; now?: () => Date }

const insideDir = (root: string, p: string) => { const r = resolve(root); const q = resolve(p); return q === r || q.startsWith(r.endsWith(sep) ? r : r + sep); };

function counts(skills: readonly ReportSkill[]): Record<string, number> {
  const c: Record<string, number> = { total: skills.length };
  for (const s of skills) { c[`action:${s.action}`] = (c[`action:${s.action}`] ?? 0) + 1; c[`outcome:${s.outcome}`] = (c[`outcome:${s.outcome}`] ?? 0) + 1; }
  return c;
}

function writeReportFiles(runDir: string, r: SkillsReport, human: (r: SkillsReport) => string): void {
  mkdirSync(runDir, { recursive: true });
  const p = join(runDir, "report.json");
  writeFileSync(`${p}.tmp`, `${JSON.stringify(r, null, 2)}\n`, { mode: 0o600 });
  renameRetry(`${p}.tmp`, p);
  writeFileSync(join(runDir, "report.txt"), `${human(r)}\n`, { mode: 0o600 });
}

/** Copies one scanned skill into a fresh staging directory and verifies the copy's folder hash. */
function stage(skill: ScannedSkill, stagingRoot: string): string {
  const dir = join(stagingRoot, `${skill.id}-${randomBytes(4).toString("hex")}`);
  mkdirSync(dir, { recursive: true });
  for (const e of skill.entries) {
    const parts = e.rel.split("/");
    if (parts.some((x) => x === "" || x === "." || x === "..")) throw new Error(`refused path ${e.rel}`);
    const dest = join(dir, ...parts);
    if (!insideDir(dir, dest)) throw new Error(`refused path ${e.rel}`);
    mkdirSync(join(dest, ".."), { recursive: true });
    copyFileRetry(e.abs, dest);
    chmodSync(dest, (e.mode & 0o755) | 0o600);
  }
  const check = scanSkill(dir, { tier: "staging", agentId: null, precedence: 0 }, { maxBytes: Number.MAX_SAFE_INTEGER, maxFiles: Number.MAX_SAFE_INTEGER });
  if (check.sha256 !== skill.sha256) { rmRetry(dir, { recursive: true, force: true }); throw new Error("source-changed-during-copy"); }
  return dir;
}

export async function importSkills(o: SkillsOptions, human: (r: SkillsReport) => string): Promise<SkillsReport> {
  const now = o.now ?? (() => new Date());
  const { report: src, skills } = await readSource(o);
  const runId = newRunId(now());
  const home = resolve(o.home);
  const base: SkillsReport = {
    runId, sourceType: o.sourceType, source: { root: src.source.root, resolvedFrom: src.source.resolvedFrom, profile: src.source.profile }, version: src.version,
    mode: o.apply ? "apply" : "dry-run", status: o.apply ? "running" : "planned", options: { onConflict: o.onConflict, enable: o.enable, maxSkillBytes: o.maxBytes },
    startedAt: now().toISOString(), finishedAt: null, harness: { home, skillsDir: skillsDir(home) }, snapshot: null, reportPath: null,
    indexSha256Before: indexDigest(home), indexSha256After: null, skills: [], counts: {}, errors: [], warnings: [...src.warnings],
  };
  const toEntry = (p: PlannedSkill): ReportSkill => ({
    id: p.skill.id, targetId: p.targetId, tier: p.skill.tier, agentId: p.skill.agentId, sourcePath: p.skill.path, sha256: p.skill.sha256,
    bytes: p.skill.bytes, files: p.skill.files, hasScripts: p.skill.hasScripts, action: p.action, outcome: "planned", reason: p.reason, enabled: null, backupPath: null,
  });
  if (!o.apply) {
    const plan = planSkills(skills, home, o.sourceType, o.onConflict);
    base.skills = plan.map(toEntry);
    base.counts = counts(base.skills);
    base.finishedAt = now().toISOString();
    return base;
  }

  const release = acquireLock(home);
  try {
    const sdir = skillsDir(home);
    const staging = join(sdir, ".staging");
    rmRetry(staging, { recursive: true, force: true });
    const runDir = join(importsDir(home), runId);
    const snapDir = join(runDir, "snapshot");
    mkdirSync(snapDir, { recursive: true });
    const existed = existsSync(sdir);
    if (existed) cpRetry(sdir, join(snapDir, "skills"), { recursive: true, filter: (p) => basename(p) !== ".staging" });
    base.snapshot = { path: snapDir, existed };
    base.reportPath = join(runDir, "report.json");
    base.indexSha256Before = indexDigest(home);
    const idx = readIndex(home);
    const plan = planSkills(skills, home, o.sourceType, o.onConflict, idx);
    base.skills = plan.map(toEntry);
    const flush = () => { base.counts = counts(base.skills); base.indexSha256After = indexDigest(home); writeReportFiles(runDir, base, human); };
    flush();
    for (let i = 0; i < plan.length; i++) {
      const p = plan[i]!; const e = base.skills[i]!;
      try {
        if (p.action === "refuse") e.outcome = "refused";
        else if (p.action === "conflict-skip" || p.action === "skip-identical") e.outcome = "skipped";
        else {
          const targetId = p.targetId!;
          if (!SKILL_ID.test(targetId)) throw new Error("invalid-target-id");
          const dest = join(sdir, targetId);
          if (p.action !== "adopt") {
            const staged = stage(p.skill, staging);
            if (p.action === "replace") {
              const backup = join(runDir, "replaced", targetId);
              mkdirSync(join(runDir, "replaced"), { recursive: true });
              renameRetry(dest, backup);
              e.backupPath = backup;
            } else if (existsSync(dest)) { rmRetry(staged, { recursive: true, force: true }); throw new Error("target-exists"); }
            renameRetry(staged, dest);
          }
          const entries = idx.skills.filter((x) => x.id !== targetId);
          // An adopted folder may be the CRLF/LF twin of the source: the index records the bytes on disk.
          const sha256 = p.action === "adopt" ? p.harness.sha256 ?? p.skill.sha256! : p.skill.sha256!;
          entries.push({ id: targetId, source: o.sourceType, sourcePath: p.skill.path, sha256, enabled: o.enable, importedAt: now().toISOString() });
          idx.skills = entries;
          writeIndex(home, idx);
          e.enabled = o.enable;
          e.outcome = p.action === "adopt" ? "adopted" : p.action === "rename" ? "renamed" : p.action === "replace" ? "replaced" : "imported";
        }
      } catch (err) {
        e.outcome = "failed"; e.reason = (err as Error).message;
        base.errors.push({ id: e.id, reason: (err as Error).message });
      }
      flush();
    }
    rmRetry(staging, { recursive: true, force: true });
    base.status = "completed";
    base.finishedAt = now().toISOString();
    flush();
    return base;
  } finally {
    release();
  }
}

export interface RollbackReport {
  runId: string; sourceType: SourceType; mode: "dry-run" | "apply"; status: "planned" | "completed";
  reportPath: string; snapshot: { path: string; existed: boolean };
  changes: { id: string; change: "remove" | "restore" | "revert" | "unchanged" }[];
  movedAside: string | null;
}

/** Undoes one skills run by restoring its snapshot (docs/import.md §9.6). Dry-run unless `apply`. */
export function rollback(o: { home: string; reportPath: string; apply: boolean; sourceType: SourceType }): RollbackReport {
  const home = resolve(o.home);
  const invalid = (reason: string, msg: string) => new ImportError("E_ROLLBACK_INVALID", reason, msg);
  let rep: Partial<SkillsReport>;
  try { rep = JSON.parse(readFileSync(o.reportPath, "utf8")) as Partial<SkillsReport>; } catch (e) { throw invalid("report-unreadable", `${o.reportPath}: ${(e as Error).message}`); }
  if (typeof rep.runId !== "string" || !RUN_ID.test(rep.runId)) throw invalid("run-id-invalid", "the report's runId is not a run id");
  if (rep.mode !== "apply") throw invalid("not-an-apply-report", "only an --apply run can be rolled back");
  if (rep.sourceType !== o.sourceType) throw invalid("source-mismatch", `the report is for ${String(rep.sourceType)}, not ${o.sourceType}`);
  const runDir = join(importsDir(home), rep.runId);
  let real: string; let expected: string;
  try { real = realpathSync(o.reportPath); expected = realpathSync(join(runDir, "report.json")); } catch { throw invalid("report-outside-home", `the report is not ${join(runDir, "report.json")}`); }
  if (real !== expected) throw invalid("report-outside-home", `the report is not ${join(runDir, "report.json")}`);
  const snapPath = join(runDir, "snapshot");
  if (!rep.snapshot || resolve(rep.snapshot.path) !== snapPath || typeof rep.snapshot.existed !== "boolean") throw invalid("snapshot-invalid", `the report's snapshot is not ${snapPath}`);
  if (!existsSync(snapPath)) throw invalid("snapshot-missing", `${snapPath} is missing`);
  if (existsSync(join(runDir, "rolled-back"))) throw invalid("already-rolled-back", `run ${rep.runId} was already rolled back`);
  if (indexDigest(home) !== (rep.indexSha256After ?? null)) {
    throw new ImportError("E_ROLLBACK_STALE", "skills-changed-since", `skills/index.json changed after run ${rep.runId}; roll back later runs first`);
  }
  const snapSkills = join(snapPath, "skills");
  const hashOf = (dir: string) => scanSkill(dir, { tier: "harness", agentId: null, precedence: 0 }, { maxBytes: Number.MAX_SAFE_INTEGER, maxFiles: Number.MAX_SAFE_INTEGER }).sha256;
  const now = new Set(storedIds(home));
  const before = new Set(rep.snapshot.existed ? storedIds(snapPath) : []);
  const changes: RollbackReport["changes"] = [...new Set([...now, ...before])].sort().map((id) => ({
    id,
    change: !before.has(id) ? "remove" : !now.has(id) ? "restore" : hashOf(join(skillsDir(home), id)) === hashOf(join(snapSkills, id)) ? "unchanged" : "revert",
  }));
  const out: RollbackReport = { runId: rep.runId, sourceType: o.sourceType, mode: o.apply ? "apply" : "dry-run", status: "planned", reportPath: real, snapshot: { path: snapPath, existed: rep.snapshot.existed }, changes, movedAside: null };
  if (!o.apply) return out;
  const release = acquireLock(home);
  try {
    const aside = join(runDir, "rolled-back");
    mkdirSync(aside, { recursive: true });
    if (existsSync(skillsDir(home))) { renameRetry(skillsDir(home), join(aside, "skills")); out.movedAside = join(aside, "skills"); }
    if (rep.snapshot.existed) cpRetry(snapSkills, skillsDir(home), { recursive: true });
    out.status = "completed";
    return out;
  } finally {
    release();
  }
}
