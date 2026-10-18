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
export function buildDoctorMethods(o: { home: string; clock: () => number; redactor?: Redactor; check?: () => Promise<unknown>; scheduleInitial?: (start: () => Promise<unknown>) => void;
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
    for (const c of o.coreChecks?.() ?? []) if (!checks.some(x => x.id === c.id)) checks.push({ ...c, summary: safe(c.summary), ...(c.repair ? { repair: { kind: c.repair.kind, label: safe(c.repair.label) } } : {}) });
    // These categories have no authoritative 1staid check in this revision. Report that explicitly; do not invent probes.
    for (const id of ["containers", "secrets", "certificates", "ports", "disks"]) if (!checks.some(c => c.id === id || c.id.startsWith(`${id}.`))) checks.push({ id, status: "skipped", summary: "No authoritative provisioning check is available in this installation." });
    cached = { generatedAt: new Date(o.clock()).toISOString(), groups: [{ id: "provisioning", title: "Provisioning", checks }] };
    return cached;
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
      return await start();
    }
    if (inFlight) return await inFlight;
    // A failed startup snapshot must not leave readers without a report until an operator refreshes: retry lazily,
    // inside the same rate limit as a refresh.
    if (!cached && o.clock() - lastStarted >= 30000) return await start();
    if (!cached) throw new RpcError("E_NOT_AVAILABLE", "installation diagnostics are unavailable", { reason: "firstaid-unavailable" });
    return structuredClone(cached);
  } };
}
