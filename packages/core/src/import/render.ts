// Human renderings of the importer's documents — the same data as the JSON, as short sections. Never content, never
// secret values (the documents they render carry none).
import type { DetectReport } from "./detect.ts";
import type { Field } from "./identity.ts";

const fmtVal = (v: unknown) => (v === null ? "—" : typeof v === "object" ? JSON.stringify(v) : String(v));
const fmtField = (x: Field) => `${fmtVal(x.value)} [${x.source}]`;
const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? "" : "s"}`;

export function renderDetect(r: DetectReport): string {
  const L: string[] = [];
  const v = r.version;
  const ver = r.sourceType === "openclaw" ? `release ${v.release ?? "unknown"}, state schema ${v.stateSchema ?? "unknown"}` : `config version ${v.configVersion}, sessions schema ${v.sessionsSchema ?? "unknown"}`;
  L.push(`Source: ${r.sourceType} at ${r.source.root} (${r.source.resolvedFrom}${r.source.profile ? `, profile ${r.source.profile}` : ""}) — ${ver}${v.supported ? "" : " — NOT TESTED"}`);
  for (const w of v.warnings) L.push(`  ! ${w}`);
  L.push(`Target: harness at ${r.target.home} (${r.target.configSource}) — ${r.target.embedding.model.value} ${r.target.embedding.dimension.value}-d, reranker ${r.target.reranker.model}`);
  L.push("", `Agents (${r.agents.length}):`);
  for (const a of r.agents) L.push(`  ${a.agentId}  workspace ${a.workspace ?? "—"} [${a.workspaceSource}]`);
  L.push("", "PLUR1BUS:");
  if (!r.plur1bus.installed) L.push(`  not installed${r.plur1bus.note ? ` — ${r.plur1bus.note}` : ""}`);
  else {
    const p = r.plur1bus.plugin ?? {};
    L.push(`  plugin ${p.id ?? "—"} ${p.version ?? "version unknown"}${p.enabled === false ? " (disabled)" : ""}; store root ${r.plur1bus.storeRoot?.baseDbPath ?? "—"} (${r.plur1bus.storeRoot?.layout ?? "—"})`);
    for (const s of r.plur1bus.stores) {
      const c = s.identity.comparison;
      L.push(`  ${s.storeId}: ${s.rows ?? "?"} rows, ${s.identity.distinctIdentities} ${s.identity.distinctIdentities === 1 ? "identity" : "identities"} → ${c.verdict} → ${s.identity.plannedAction}${s.identity.reasons.length ? ` (${s.identity.reasons.join(", ")})` : ""}`);
      for (const [k, f] of Object.entries(s.identity.fields)) L.push(`      ${k.padEnd(13)} ${fmtField(f)}  ${c.fields[k as keyof typeof c.fields]}${f.note ? `  — ${f.note}` : ""}`);
    }
  }
  L.push("", "Reranker:");
  if (!r.rerankers.length) L.push("  not applicable");
  for (const rr of r.rerankers) L.push(`  ${rr.scope}: ${rr.provider} ${rr.model ?? ""} (${rr.locality}, ${rr.licenceClass ?? "no licence"}) → ${rr.comparison.verdict}; ${rr.comparison.recommendation}`);
  L.push("", `Skills (${r.skills.length}):`);
  for (const s of r.skills) {
    const flags = [s.hasScripts ? "scripts" : "", s.skipped.symlinkEscapes.length ? `${s.skipped.symlinkEscapes.length} symlink escape(s) skipped` : "", s.skipped.secretFiles ? `${s.skipped.secretFiles} secret file(s) skipped` : "", s.shadowedBy ? "shadowed" : "", s.existsInHarness ? "id in harness" : ""].filter(Boolean);
    L.push(`  ${s.id.padEnd(24)} ${s.tier}${s.agentId ? `/${s.agentId}` : ""}  ${s.files} files ${s.bytes} B  → ${s.plannedAction}${s.reason ? ` (${s.reason})` : ""}${flags.length ? `  [${flags.join("; ")}]` : ""}`);
  }
  L.push("", "Secrets (presence only):");
  if (!r.secrets.files.length && !r.secrets.configKeys.length) L.push("  none found");
  for (const f of r.secrets.files) L.push(`  ${f.path} (${f.kind})`);
  for (const e of r.secrets.envKeys) L.push(`  ${e.file} keys: ${e.keys.join(", ") || "—"}`);
  if (r.secrets.configKeys.length) L.push(`  config: ${r.secrets.configKeys.length} secret-shaped value(s): ${r.secrets.configKeys.map((k) => `${k.path} (${k.form})`).join(", ")}`);
  const warnings = [...r.target.warnings, ...r.warnings];
  if (warnings.length) { L.push("", "Warnings:"); for (const w of warnings) L.push(`  ! ${w}`); }
  L.push("", `Summary: ${plural(r.counts.agents ?? 0, "agent")}, ${plural(r.counts.stores ?? 0, "store")} (${r.counts.storesTakeOver} take-over, ${r.counts.storesReembed} re-embed), ${plural(r.counts.skills ?? 0, "skill")} (${r.counts.skillsToImport} to import, ${r.counts.skillsConflicting} conflicting, ${r.counts.skillsRefused} refused). Nothing was written.`);
  return L.join("\n");
}
