import { readHostEvalReports } from './toolcall/host-eval-store.ts';
import { hostEvalGate, type ModelRef } from './toolcall/host-eval.ts';
import { join } from "node:path";
import { detectSandbox } from "./tools/sandbox/index.ts";
import { execFile } from "node:child_process";
import { homedir } from "node:os";
import { authorize } from "./rbac/authorize.ts";
import { authenticatedPrincipal } from "./rbac/guard.ts";
import { RpcError } from "./rpc/errors.ts";
import type { Handler } from "./rpc/server.ts";
import { createRedactor, type Redactor } from "./logs/redact.ts";

type Status = "ok" | "warn" | "fail" | "skipped";
type Check = { id: string; status: Status; summary: string; repair?: { kind: string; label: string } };
type Report = { generatedAt: string; groups: { id: string; title: string; checks: Check[] }[] };
export function runFirstAid(home: string, binary = process.env.PLUR1BUS_BIN ?? "plur1bus"): Promise<unknown> {
  return new Promise((resolve, reject) => {
    execFile(binary, ["--home", home, "--json", "1staid", "check"], { timeout: 8000, maxBuffer: 1024 * 1024, windowsHide: true }, (error, stdout) => {
      try {
        // Failing checks exit nonzero but still produce the authoritative JSON report.
        const doc: unknown = JSON.parse(stdout);
        resolve(doc);
      } catch { reject(new RpcError("E_NOT_AVAILABLE", "installation diagnostics are unavailable", { reason: error ? "firstaid-unavailable" : "firstaid-invalid" })); }
    });
  });
}
export function buildDoctorMethods(o: { home: string; clock: () => number; sandboxRequired?: () => boolean; toolEvalDefaults?: () => readonly ModelRef[]; redactor?: Redactor; /** Problems the Core itself found while composing (a refused turn provider); added to the report as checks. */ compositionChecks?: () => Check[]; check?: () => Promise<unknown>; miningStatus?: () => { available: boolean } | undefined; capabilityStatus?: () => { mode: string; sourceError: boolean; lastRecheck: number | null } | undefined; scheduleInitial?: (start: () => Promise<unknown>) => void;
  /** Checks the core answers itself from its live configuration (e.g. privacy.local-only); appended to the provisioning group. */
  coreChecks?: () => Check[] }): Record<string, Handler> {
  let cached: Report | null = null;
  let lastStarted = -Infinity;
  let inFlight: Promise<Report> | null = null;
  const redactor = o.redactor ?? createRedactor({ pii: true });
  // Replacing "" would interleave the marker between every character, and "/" would eat every path separator.
  const literal = (text: string, home: string, marker: string): string => {
    const root = home.replace(/[\\/]+$/, "");
    return root.length > 1 ? text.split(root).join(marker) : text;
  };
  // Another person's home directory (the CLI may report any path it touched) is personal data: keep only the marker.
  const FOREIGN_HOME = /(?:[A-Za-z]:)?[\\/](?:home|Users)[\\/][^\s"'<>|:;,()[\]{}\\/]+/gi;
  const safe = (text: string): string => literal(literal(redactor.text(text), o.home, "[home]"), homedir(), "[user-home]").replace(FOREIGN_HOME, "[user-home]").slice(0, 4096);
  async function generate(): Promise<Report> {
    lastStarted = o.clock();
    // Whatever the probe throws (a spawn error carries paths) is not shown to the caller.
    const raw = await (o.check ?? (() => runFirstAid(o.home)))().catch((e: unknown) => { throw e instanceof RpcError ? e : new RpcError("E_NOT_AVAILABLE", "installation diagnostics are unavailable", { reason: "firstaid-unavailable" }); }) as { schema?: unknown; checks?: unknown };
    if (!raw || raw.schema !== "1staid.check/1" || !Array.isArray(raw.checks)) throw new RpcError("E_NOT_AVAILABLE", "installation diagnostics are unavailable", { reason: "firstaid-invalid" });
    const checks: Check[] = raw.checks.map((item: unknown) => {
      const c = item as { id?: unknown; status?: unknown; summary?: unknown; hint?: unknown };
      if (!c || typeof c.id !== "string" || !/^[a-z0-9._-]{1,100}$/.test(c.id) || typeof c.summary !== "string" || !["ok", "info", "warn", "fail", "skip"].includes(String(c.status))) throw new RpcError("E_NOT_AVAILABLE", "installation diagnostics are unavailable", { reason: "firstaid-invalid" });
      const status: Status = c.status === "info" ? "ok" : c.status === "skip" ? "skipped" : c.status as Status;
      return { id: c.id, status, summary: safe(c.summary), ...(typeof c.hint === "string" ? { repair: { kind: "hint", label: safe(c.hint) } } : {}) };
    });
    if (o.sandboxRequired?.() === false) checks.push({ id: "tools.sandbox.bypass", status: "warn", summary: "NOT SANDBOXED: owner disabled tools.sandbox.required; each process launch is audited." });
    for (const c of o.coreChecks?.() ?? []) if (!checks.some(x => x.id === c.id)) checks.push({ ...c, summary: safe(c.summary), ...(c.repair ? { repair: { kind: c.repair.kind, label: safe(c.repair.label) } } : {}) });
    const sandbox = await detectSandbox(join(o.home, "bin", "plur1bus-sandbox-limits"));
    checks.push({ id: "tools.sandbox", status: sandbox.available ? "warn" : "fail", summary: safe(`${sandbox.backend} (${sandbox.strength}): ${sandbox.reason}`), ...(sandbox.hint ? { repair: { kind: "hint", label: safe(sandbox.hint) } } : {}) });
    const toolGate = hostEvalGate(o.toolEvalDefaults?.() ?? [], await readHostEvalReports(o.home, o.clock()));
    checks.push({ id: "tools.tool-eval", status: toolGate.passed ? "ok" : toolGate.models.some(m => m.label === "limited tool use") ? "fail" : "warn", summary: safe(toolGate.models.length ? toolGate.models.map(m => `${m.provider}/${m.model}: ${m.label}`).join("; ") : "Host tool use unknown: no default model inventory/evidence available.") });
    // These categories have no authoritative 1staid check in this revision. Report that explicitly; do not invent probes.
    for (const id of ["containers", "secrets", "certificates", "ports", "disks"]) if (!checks.some(c => c.id === id || c.id.startsWith(`${id}.`))) checks.push({ id, status: "skipped", summary: "No authoritative provisioning check is available in this installation." });
    for (const c of o.compositionChecks?.() ?? []) if (!checks.some(x => x.id === c.id)) checks.push({ ...c, summary: safe(c.summary) });
    cached = { generatedAt: new Date(o.clock()).toISOString(), groups: [{ id: "provisioning", title: "Provisioning", checks }] };
    return cached;
  }
  function currentReport(report: Report): Report {
    const copy = structuredClone(report);
    // Privacy is checked from the live configuration even while the expensive provisioning snapshot is cached.
    const group=copy.groups[0];
    if(group)for(const check of o.coreChecks?.()??[]){
      const next={...check,summary:safe(check.summary),...(check.repair?{repair:{kind:check.repair.kind,label:safe(check.repair.label)}}:{})};
      const at=group.checks.findIndex(c=>c.id===check.id);if(at<0)group.checks.push(next);else group.checks[at]=next;
    }
    const capability = o.capabilityStatus?.();
    if (capability) copy.groups[0]?.checks.push({ id: 'capabilities.index', status: capability.sourceError ? 'fail' : capability.mode === 'fts5-only' ? 'warn' : 'ok', summary: `Capability index: ${capability.mode}. Last recheck: ${capability.lastRecheck ?? 'pending'}.` });
    const mining = o.miningStatus?.();
    if (mining) copy.groups[0]?.checks.push({ id: 'skills.mining', status: mining.available ? 'ok' : 'skipped', summary: mining.available ? 'Skill mining proposes inactive artifacts for human review.' : 'Skill mining unavailable: the engine exposes memory corrections but no skill-artifact proposal API.' });
    return copy;
  }
  function start(): Promise<Report> {
    if (inFlight) return inFlight;
    inFlight = generate().finally(() => { inFlight = null; });
    return inFlight;
  }
  // Initial snapshot is an internal startup check; reading never requests a refresh.
  if (o.scheduleInitial) o.scheduleInitial(start);
  else void start().catch(() => {});
  return { "doctor.report": async (p: { refresh?: boolean }, ctx) => {
    const principal = authenticatedPrincipal(ctx);
    if (p?.refresh === true) {
      if (authorize(principal, "doctor.run", { kind: "system" }, { now: o.clock() }).effect !== "allow") throw new RpcError("E_DENIED", "diagnostic refresh requires an operator");
      if (inFlight || o.clock() - lastStarted < 30000) throw new RpcError("E_CONFLICT", "diagnostics were refreshed recently", { reason: "refresh-rate-limit" });
      return currentReport(await start());
    }
    if (inFlight) return currentReport(await inFlight);
    // A failed startup snapshot must not leave readers without a report until an operator refreshes: retry lazily,
    // inside the same rate limit as a refresh.
    if (!cached && o.clock() - lastStarted >= 30000) return currentReport(await start());
    if (!cached) throw new RpcError("E_NOT_AVAILABLE", "installation diagnostics are unavailable", { reason: "firstaid-unavailable" });
    return currentReport(cached);
  } };
}
