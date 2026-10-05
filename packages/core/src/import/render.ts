// Human renderings of the importer's documents — the same data as the JSON, as short sections. Never content, never
// secret values (the documents they render carry none).
import type { DetectReport } from "./detect.ts";
import type { Field } from "./identity.ts";
import type { RollbackReport, SkillsReport } from "./skills-import.ts";
import type { OpenclawImportReport } from "./importers/openclaw.ts";

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
  const pt = r.portability;
  if (pt.origin !== "native" || pt.movedFrom.length || pt.mapped.length || pt.unmapped.length) {
    L.push("", `Portability: ${pt.origin} source, ${pt.flavour} paths (source root ${pt.sourceRoot})`);
    for (const m of pt.mapped) L.push(`  ${m.key}: ${m.value} → ${m.path} [${m.how}]`);
    for (const u of pt.unmapped) L.push(`  ${u.key}: ${u.value} — unmapped (${u.reason})`);
  }
  if (r.candidates && r.candidates.length) {
    L.push("", `Candidates (WSL, ${r.candidates.length}):`);
    for (const c of r.candidates) {
      const state = c.state === "Running" ? "running" : "stopped";
      const info = c.probed ? c.sourceRoot : (c.reason ?? "not probed");
      L.push(`  ${c.distro} (${state}): ${info}`);
    }
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

export function renderRollback(r: RollbackReport): string {
  const L: string[] = [];
  L.push(`Rollback of run ${r.runId} (${r.sourceType}) — ${r.mode === "dry-run" ? "DRY RUN (nothing written; add --apply)" : "applied"}`);
  L.push(`Snapshot: ${r.snapshot.path}${r.snapshot.existed ? "" : " (there was no skills/ before the run: it is removed)"}`);
  for (const c of r.changes) L.push(`  ${c.id.padEnd(24)} ${c.change}`);
  if (r.movedAside) L.push(`The replaced skills/ was moved to ${r.movedAside}`);
  return L.join("\n");
}

export function renderOpenclaw(r: OpenclawImportReport): string {
  const L: string[] = [];
  L.push(`OpenClaw import from ${r.source.root} — ${r.mode === "dry-run" ? "DRY RUN (nothing written; add --apply)" : `applied, run ${r.runId}`}`);
  L.push(`Target: ${r.harness.home}`);
  L.push("", `Agents (${r.agents.length}):`);
  for (const a of r.agents) {
    const details = a.action === "rejected"
      ? `rejected (${a.reason ?? "invalid"})`
      : `${a.action} (${a.counts.filesCreated} files created, ${a.counts.filesMatched} matched${a.counts.filesConflicted ? `, ${a.counts.filesConflicted} conflicted` : ""})`;
    L.push(`  ${a.harnessAgentId.padEnd(16)} ${details}`);
    for (const f of a.files) {
      L.push(`    ${f.targetFile.padEnd(28)} ${f.action}${f.reason ? ` (${f.reason})` : ""} (${f.bytes} B)`);
    }
  }
  if (r.channels.length > 0) {
    L.push("", `Channels (${r.channels.length}):`);
    for (const ch of r.channels) {
      L.push(`  ${ch.platform.padEnd(16)} allowFrom: ${ch.allowFrom.length ? ch.allowFrom.join(", ") : "—"}${ch.groups ? ` groups: ${ch.groups.join(", ")}` : ""}`);
    }
  }
  L.push("", `Cron jobs (${r.cron.count} deferred, ${r.cron.excludedCount} managed excluded):`);
  if (r.cron.jobs.length === 0) {
    L.push("  none found");
  }
  for (const j of r.cron.jobs) {
    L.push(`  ${j.id.padEnd(16)} schedule: ${j.schedule || "—"} (${j.status})`);
  }
  L.push("", `Secrets (${r.secrets.count} unmigrated):`);
  if (r.secrets.unmigrated_secrets.length === 0) {
    L.push("  none found");
  } else {
    L.push(`  keys: ${r.secrets.unmigrated_secrets.join(", ")}`);
  }
  if (r.reportPath) {
    L.push("", `Report: ${r.reportPath}`);
  }
  const c = r.counts;
  L.push("", `Summary: ${c.agentsCreated} agents created, ${c.agentsMatched} matched${c.agentsRejected ? `, ${c.agentsRejected} rejected` : ""}; ${c.filesCreated} files created, ${c.filesMatched} matched${c.filesConflicted ? `, ${c.filesConflicted} conflicted` : ""}; ${c.channelsDeferred ?? c.channelsImported} channels deferred; ${c.cronJobsDeferred} cron jobs deferred.`);
  return L.join("\n");
}

