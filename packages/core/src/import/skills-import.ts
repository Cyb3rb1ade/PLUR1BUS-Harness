// Skills import (docs/import.md §9): plan, apply, rollback. Copy-never-move, idempotent per folder hash, resumable
// after interruption, conflicts per --on-conflict, imported skills disabled unless --enable, snapshot + report per run.
import { harnessSkillState, readIndex, storedIds, type HarnessSkillState, type SkillIndex } from "./skills-registry.ts";
import { SKILL_ID, type ScannedSkill } from "./skills-scan.ts";
import type { SourceType } from "./types.ts";

export type OnConflict = "skip" | "rename" | "replace";
export type SkillAction = "import" | "adopt" | "skip-identical" | "conflict-skip" | "rename" | "replace" | "refuse";
export interface PlannedSkill { skill: ScannedSkill; action: SkillAction; targetId: string | null; reason: string | null; harness: HarnessSkillState }

interface Taken { sha: string | null; origin: "harness" | "run"; state: HarnessSkillState }

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
    taken.set(id, { sha: state.sha256, origin: "harness", state });
  }
  const out: PlannedSkill[] = [];
  for (const skill of scanned) {
    const t = taken.get(skill.id);
    const harness = t?.origin === "harness" ? t.state : none;
    if (skill.problems.length) { out.push({ skill, action: "refuse", targetId: null, reason: skill.problems.join(","), harness }); continue; }
    const claim = (id: string) => taken.set(id, { sha: skill.sha256, origin: "run", state: none });
    if (!t) { claim(skill.id); out.push({ skill, action: "import", targetId: skill.id, reason: null, harness }); continue; }
    if (t.sha === skill.sha256) {
      if (t.origin === "run") out.push({ skill, action: "skip-identical", targetId: skill.id, reason: "duplicate-in-source", harness });
      else if (t.state.exists && !t.state.indexed) out.push({ skill, action: "adopt", targetId: skill.id, reason: "folder-present-not-indexed", harness });
      else if (!t.state.exists) { out.push({ skill, action: "import", targetId: skill.id, reason: "index-entry-without-folder", harness }); t.state = { ...t.state, exists: true }; }
      else out.push({ skill, action: "skip-identical", targetId: skill.id, reason: null, harness });
      continue;
    }
    if (t.origin === "harness" && !t.state.exists) {
      // Indexed but no folder, different hash: nothing on disk to protect.
      out.push({ skill, action: "import", targetId: skill.id, reason: "index-entry-without-folder", harness }); taken.set(skill.id, { sha: skill.sha256, origin: "run", state: none }); continue;
    }
    if (onConflict === "rename") { const id = renameTarget(skill.id, sourceType, taken); claim(id); out.push({ skill, action: "rename", targetId: id, reason: t.origin === "run" ? "shadowed-in-source" : "id-taken", harness }); continue; }
    if (onConflict === "replace" && t.origin === "harness") { taken.set(skill.id, { sha: skill.sha256, origin: "run", state: none }); out.push({ skill, action: "replace", targetId: skill.id, reason: "id-taken", harness }); continue; }
    out.push({ skill, action: "conflict-skip", targetId: null, reason: t.origin === "run" ? "shadowed-in-source" : "id-taken", harness });
  }
  return out;
}
