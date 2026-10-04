// `import <source> --detect` (docs/import.md §8): the read-only report, `import.detect/1`.
import { existsSync } from "node:fs";
import type { TargetIdentity } from "./identity.ts";
import { targetIdentity } from "./identity.ts";
import { readSource, type SourceOptions } from "./source.ts";
import { planSkills } from "./skills-import.ts";
import type { ScannedSkill } from "./skills-scan.ts";
import { ImportError, type SourceReport } from "./types.ts";
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
  const wslWarnings: string[] = [];
  if (!o.source && (o.platform ?? process.platform) === "win32") {
    try {
      const all = await enumerateWslCandidates({ runner: o.wslRunner, probeWsl: o.probeWsl });
      const matching = all.filter((c) => c.sourceType === o.sourceType);
      if (matching.length > 0) candidates = matching;
    } catch (e: any) {
      const reason = e instanceof ImportError ? e.reason : (e.message ?? String(e));
      wslWarnings.push(`WSL candidate discovery failed: ${reason}`);
    }
  }
  let reportResult: { report: SourceReport; target: TargetIdentity; skills: ScannedSkill[] };
  try {
    reportResult = await readSource(o);
  } catch (err) {
    if (((candidates && candidates.length > 0) || wslWarnings.length > 0) && err instanceof ImportError && err.code === "E_SOURCE_MISSING") {
      const target = targetIdentity(o.home);
      return {
        sourceType: o.sourceType,
        source: { root: "(none)", resolvedFrom: "no native source", configPath: null, profile: o.profile ?? null },
        version: { release: null, stateSchema: null, configVersion: null, sessionsSchema: null, supported: false, warnings: [] },
        agents: [],
        skillRoots: [],
        skills: [],
        plur1bus: { installed: false, plugin: null, storeRoot: null, embeddingCache: null, reembedding: null, stores: [] },
        rerankers: [],
        portability: {
          origin: "native",
          flavour: (o.platform ?? process.platform) === "win32" ? "win32" : "posix",
          sourceRoot: "",
          sourceHome: null,
          movedFrom: [],
          mapped: [],
          unmapped: [],
          problems: [],
        },
        secrets: { files: [], envKeys: [], configKeys: [] },
        other: {},
        warnings: [
          candidates && candidates.length > 0
            ? "No native source installation found; choose a candidate with --source wsl:<distro>:<path>"
            : "No native source installation found",
          ...wslWarnings,
        ],
        target: { home: target.home, configSource: target.configSource, embedding: target.embedding, reranker: target.reranker, warnings: target.warnings },
        counts: { agents: 0, stores: 0, storesTakeOver: 0, storesReembed: 0, skills: 0, skillsWithScripts: 0, skillsToImport: 0, skillsConflicting: 0, skillsRefused: 0, secretFiles: 0 },
        candidates: candidates ?? [],
      };
    }
    throw err;
  }
  const { report, target, skills } = reportResult;
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
