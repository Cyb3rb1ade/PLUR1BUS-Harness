// `import <source> --detect` (docs/import.md §8): the read-only report, `import.detect/1`.
import { existsSync } from "node:fs";
import type { TargetIdentity } from "./identity.ts";
import { readSource, type SourceOptions } from "./source.ts";
import { planSkills } from "./skills-import.ts";
import type { ScannedSkill } from "./skills-scan.ts";
import type { SourceReport } from "./types.ts";
import { enumerateWslCandidates, type WslCandidate } from "./wsl.ts";

export interface DetectSkill {
  id: string; name: string | null; description: string | null; path: string; tier: string; agentId: string | null;
  bytes: number; files: number; sha256: string | null; textSha256: string | null; hasScripts: boolean; scripts: number;
  skipped: ScannedSkill["skipped"]; problems: string[]; shadowedBy: string | null;
  existsInHarness: boolean; harnessSha256: string | null; plannedAction: string; targetId: string | null; reason: string | null;
}

export type DetectReport = Omit<SourceReport, "skillRoots"> & {
  target: { home: string; configSource: string; embedding: TargetIdentity["embedding"]; reranker: TargetIdentity["reranker"]; warnings: string[] };
  skillRoots: { dir: string; tier: string; agentId: string | null; exists: boolean }[];
  skills: DetectSkill[];
  counts: Record<string, number>;
  candidates?: WslCandidate[];
};

export async function detect(o: SourceOptions): Promise<DetectReport> {
  let candidates: WslCandidate[] | undefined;
  if (!o.source && (o.platform ?? process.platform) === "win32") {
    try {
      const all = await enumerateWslCandidates({ runner: o.wslRunner, probeWsl: o.probeWsl });
      const matching = all.filter((c) => c.sourceType === o.sourceType);
      if (matching.length > 0) candidates = matching;
    } catch {}
  }
  const { report, target, skills } = await readSource(o);
  const planned = planSkills(skills, o.home, o.sourceType, "skip");
  const detectSkills: DetectSkill[] = planned.map(({ skill: s, action, targetId, reason, harness }) => ({
    id: s.id, name: s.name, description: s.description, path: s.path, tier: s.tier, agentId: s.agentId,
    bytes: s.bytes, files: s.files, sha256: s.sha256, textSha256: s.textSha256, hasScripts: s.hasScripts, scripts: s.scripts,
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
    ...(candidates ? { candidates } : {}),
  };
}
