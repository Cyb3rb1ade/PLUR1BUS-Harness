// Reads one source installation: the source report, the harness target identity and the scanned skills. Shared by
// detect and the skills import; read-only.
import { homedir as osHomedir } from "node:os";
import type { Mount } from "./paths.ts";
import { targetIdentity, type TargetIdentity } from "./identity.ts";
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
  platform?: NodeJS.Platform | undefined;
  maps?: Mount[] | undefined;
  /** The platform of the volume the harness copies to, for name hazards (default: `platform`). */
  targetPlatform?: NodeJS.Platform | undefined;
  maxBytes?: number;
}

export async function readSource(o: SourceOptions): Promise<{ report: SourceReport; target: TargetIdentity; skills: ScannedSkill[] }> {
  const target = targetIdentity(o.home);
  const ctx = { sourceType: o.sourceType, source: o.source, profile: o.profile, env: o.env ?? process.env, homedir: o.homedir ?? osHomedir(), platform: o.platform, targetPlatform: o.targetPlatform, maps: o.maps, home: o.home, target };
  const report = o.sourceType === "openclaw" ? await detectOpenclaw(ctx) : await detectHermes(ctx);
  const skills = scanSkills(report.skillRoots, { maxBytes: o.maxBytes ?? DEFAULT_MAX_SKILL_BYTES, maxFiles: DEFAULT_MAX_SKILL_FILES, targetPlatform: o.targetPlatform ?? o.platform ?? process.platform });
  return { report, target, skills };
}

