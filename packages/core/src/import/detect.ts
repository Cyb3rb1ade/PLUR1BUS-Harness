// `import <source> --detect` (docs/import.md §8): the read-only report, `import.detect/1`.
import { existsSync } from "node:fs";
import { homedir as osHomedir } from "node:os";
import { targetIdentity, type TargetIdentity } from "./identity.ts";
import { planSkills } from "./skills-import.ts";
import { DEFAULT_MAX_SKILL_BYTES, DEFAULT_MAX_SKILL_FILES, scanSkills, type ScannedSkill } from "./skills-scan.ts";
import { detectHermes } from "./sources/hermes.ts";
import { detectOpenclaw } from "./sources/openclaw.ts";
import type { SourceReport, SourceType } from "./types.ts";

export interface SourceOptions {
  sourceType: SourceType;
  source?: string | undefined;
  profile?: string | undefined;
  home: string;
  env?: NodeJS.ProcessEnv;
  homedir?: string;
  maxBytes?: number;
}

export async function readSource(o: SourceOptions): Promise<{ report: SourceReport; target: TargetIdentity; skills: ScannedSkill[] }> {
  const target = targetIdentity(o.home);
  const ctx = { sourceType: o.sourceType, source: o.source, profile: o.profile, env: o.env ?? process.env, homedir: o.homedir ?? osHomedir(), home: o.home, target };
  const report = o.sourceType === "openclaw" ? await detectOpenclaw(ctx) : await detectHermes(ctx);
  const skills = scanSkills(report.skillRoots, { maxBytes: o.maxBytes ?? DEFAULT_MAX_SKILL_BYTES, maxFiles: DEFAULT_MAX_SKILL_FILES });
  return { report, target, skills };
}

export interface DetectSkill {
  id: string; name: string | null; description: string | null; path: string; tier: string; agentId: string | null;
  bytes: number; files: number; sha256: string | null; hasScripts: boolean; scripts: number;
  skipped: ScannedSkill["skipped"]; problems: string[]; shadowedBy: string | null;
  existsInHarness: boolean; harnessSha256: string | null; plannedAction: string; targetId: string | null; reason: string | null;
}

export type DetectReport = Omit<SourceReport, "skillRoots"> & {
  target: { home: string; configSource: string; embedding: TargetIdentity["embedding"]; reranker: TargetIdentity["reranker"]; warnings: string[] };
  skillRoots: { dir: string; tier: string; agentId: string | null; exists: boolean }[];
  skills: DetectSkill[];
  counts: Record<string, number>;
};

export async function detect(o: SourceOptions): Promise<DetectReport> {
  const { report, target, skills } = await readSource(o);
  const planned = planSkills(skills, o.home, o.sourceType, "skip");
  const detectSkills: DetectSkill[] = planned.map(({ skill: s, action, targetId, reason, harness }) => ({
    id: s.id, name: s.name, description: s.description, path: s.path, tier: s.tier, agentId: s.agentId,
    bytes: s.bytes, files: s.files, sha256: s.sha256, hasScripts: s.hasScripts, scripts: s.scripts,
    skipped: s.skipped, problems: s.problems, shadowedBy: s.shadowedBy,
    existsInHarness: harness.exists || harness.indexed, harnessSha256: harness.sha256, plannedAction: action, targetId, reason,
  }));
  const stores = report.plur1bus.stores;
  const counts: Record<string, number> = {
    agents: report.agents.length,
    stores: stores.length,
    storesTakeOver: stores.filter((s) => s.identity.plannedAction === "take-over").length,
    storesReembed: stores.filter((s) => s.identity.plannedAction === "re-embedding-migration").length,
    skills: detectSkills.length,
    skillsWithScripts: detectSkills.filter((s) => s.hasScripts).length,
    skillsToImport: detectSkills.filter((s) => s.plannedAction === "import" || s.plannedAction === "adopt").length,
    skillsConflicting: detectSkills.filter((s) => s.plannedAction === "conflict-skip").length,
    skillsRefused: detectSkills.filter((s) => s.plannedAction === "refuse").length,
    secretFiles: report.secrets.files.length,
  };
  return {
    ...report,
    target: { home: target.home, configSource: target.configSource, embedding: target.embedding, reranker: target.reranker, warnings: target.warnings },
    skillRoots: report.skillRoots.map((r) => ({ dir: r.dir, tier: r.tier, agentId: r.agentId, exists: existsSync(r.dir) })),
    skills: detectSkills,
    counts,
  };
}
