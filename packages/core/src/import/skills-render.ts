/** Live skills report rendering has no dependency on offline full-import entries. */
import type { SkillsReport } from "./skills-import.ts";

export function renderSkills(r: SkillsReport): string {
  const L: string[] = [];
  L.push(`Skills import from ${r.sourceType} at ${r.source.root} — ${r.mode === "dry-run" ? "DRY RUN (nothing written; add --apply)" : `applied, run ${r.runId} (${r.status})`}`);
  L.push(`Target: ${r.harness.skillsDir}; on conflict: ${r.options.onConflict}; imported skills ${r.options.enable ? "ENABLED (--enable)" : "disabled (enable them after review)"}`);
  for (const s of r.skills) {
    const target = s.targetId && s.targetId !== s.id ? ` as ${s.targetId}` : "";
    L.push(`  ${s.id.padEnd(24)} ${s.tier}${s.agentId ? `/${s.agentId}` : ""}  ${s.action}${target} → ${s.outcome}${s.reason ? ` (${s.reason})` : ""}${s.hasScripts ? "  [scripts]" : ""}${s.backupPath ? `  backup ${s.backupPath}` : ""}`);
  }
  if (r.errors.length) { L.push("Errors:"); for (const e of r.errors) L.push(`  ${e.id}: ${e.reason}`); }
  if (r.warnings.length) { L.push("Warnings:"); for (const w of r.warnings) L.push(`  ! ${w}`); }
  if (r.snapshot) L.push(`Snapshot: ${r.snapshot.path}`);
  if (r.reportPath) L.push(`Report: ${r.reportPath} — undo with: plur1bus import ${r.sourceType} --rollback ${r.reportPath}`);
  const c = r.counts;
  L.push(`Summary: ${c.total ?? 0} skills; ${Object.entries(c).filter(([k]) => k.startsWith(r.mode === "dry-run" ? "action:" : "outcome:")).map(([k, n]) => `${k.split(":")[1]} ${n}`).join(", ") || "nothing to do"}.`);
  return L.join("\n");
}
