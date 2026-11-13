// Parity vectors (mode V) for the doctor report (P4-11 task 6): each case drives the real `buildDoctorMethods` of
// `packages/core/src/doctor-report.ts` through `guardMethods` (a viewer reads) with an injected probe, sandbox detection,
// platform, user home, clock and live checks, and records the report `doctor.report` returns, or the refusal
// (`{ error: { code, reason } }`). The Rust port (`crates/plur1bus-core/src/doctor/vectors.rs`) replays every case and
// must produce the same report, byte for byte as JSON: the status mapping, hints as repairs, validation of the probe
// output, path cleaning (redactor with PII, the core's home, the user's home, other persons' homes, the 4096 cut), the
// sandbox / process-cap / external-agent rows for each platform, the skipped categories, composition and core checks,
// and the live overlays (capability index, skill mining, turn usage). Recorded, never edited by hand.
//
// Not covered here: the host tool-eval gate (its reports are files read by a module that is not ported; the Rust deps
// take it as a seam, so the vectors run with an empty default model inventory), the probe process itself
// (`runFirstAid`, tested in Rust with fake binaries) and caching / in-flight behaviour (Rust tests with an injected clock).
//
// A string with `{ parts: [...] }` is the concatenation of the parts, so that a canary-shaped value never sits in the
// source as a literal. `platform` replaces `process.platform` for the case (`externalAgentRefusal` reads it);
// `HOME` is fixed so that `homedir()` is deterministic.
//
//   node --experimental-strip-types --conditions=source --no-warnings=ExperimentalWarning scripts/parity/export-doctor.ts [--check]
import { fileURLToPath } from "node:url";
import { buildDoctorMethods } from "../../packages/core/src/doctor-report.ts";
import { guardMethods } from "../../packages/core/src/rbac/guard.ts";
import { RpcError } from "../../packages/core/src/rpc/errors.ts";
import { TURN_END_REASONS } from "../../packages/core/src/session/turn-telemetry.ts";
import { exporterMain } from "./lib.mjs";

export const USER_HOME = "/fake-user";
const CLOCK_MS = 1_700_000_000_123;

type Text = string | { parts: string[] };
type Check = { id: string; status: string; summary: Text; repair?: { kind: string; label: Text } };
type Probe = { doc: unknown } | { throws: "plain" } | { throws: "rpc"; reason: string };
type Sandbox = { available: boolean; backend: string; strength: string; reason: Text; hint?: Text; tasks: { mechanism: "namespace-limit" | "fork-denied" | "none"; reason: Text; hint?: Text } };
type Usage = { turns: number; rounds: number; toolCalls: number; metaCalls: { search: number; skillLoad: number; skillRead: number }; skills: { injected: number; loaded: number };
  errorsReturned: number; toolNeedTurns: number; forcedTurns: number; withoutNeededTool: number; toolChoiceUnsupported: number; endReasons: Record<string, number>;
  triage: { count: number; p50Ms?: number; p95Ms?: number } };
type Case = {
  name: string; platform: "linux" | "darwin" | "win32"; home: string; probe: Probe; sandbox: Sandbox; maxTasks?: number; sandboxRequired?: boolean;
  coreChecks?: Check[]; compositionChecks?: Check[]; capability?: { mode: string; sourceError: boolean; lastRecheck: number | null }; mining?: { available: boolean }; usage?: Usage;
};

const resolve = (v: unknown): unknown => {
  if (Array.isArray(v)) return v.map(resolve);
  if (v && typeof v === "object") {
    const o = v as Record<string, unknown>;
    if (Object.keys(o).length === 1 && Array.isArray(o.parts)) return (o.parts as string[]).join("");
    return Object.fromEntries(Object.entries(o).map(([k, x]) => [k, resolve(x)]));
  }
  return v;
};

const okSandbox = (over: Partial<Sandbox> & { mechanism?: "namespace-limit" | "fork-denied" | "none" } = {}): Sandbox => ({
  available: true, backend: "bubblewrap", strength: "partial", reason: "available", ...over,
  tasks: { mechanism: over.mechanism ?? "namespace-limit", reason: "measured", ...(over.tasks ?? {}) },
});
const doc = (checks: unknown[]) => ({ schema: "1staid.check/1", checks });
const base = (name: string, over: Partial<Case> = {}): Case => ({
  name, platform: "linux", home: "/private/home/example", probe: { doc: doc([]) }, sandbox: okSandbox(), ...over,
});

function cases(): Case[] {
  const out: Case[] = [];
  const add = (name: string, over: Partial<Case> = {}) => out.push(base(name, over));
  const family = ["s", "k", "-"];
  add("status-mapping-and-hints", { probe: { doc: doc([
    { id: "models.cache", status: "ok", summary: "models in /private/home/example/models", detail: "must not escape", hint: "plur1bus setup" },
    { id: "a.info", status: "info", summary: "info row" }, { id: "a.skip", status: "skip", summary: "skip row", hint: "mail anna@example.org" },
    { id: "a.warn", status: "warn", summary: "warn row" }, { id: "a.fail", status: "fail", summary: "fail row", hint: 7 },
    { id: "a_b-c.9", status: "ok", summary: "" },
  ]) } });
  for (const [name, d] of [
    ["invalid-not-an-object", 7], ["invalid-null", null], ["invalid-schema", { schema: "x", checks: [] }], ["invalid-no-checks", { schema: "1staid.check/1" }],
    ["invalid-checks-not-an-array", { schema: "1staid.check/1", checks: {} }],
    ["invalid-id-upper", doc([{ id: "Bad", status: "ok", summary: "s" }])], ["invalid-id-empty", doc([{ id: "", status: "ok", summary: "s" }])],
    ["invalid-id-too-long", doc([{ id: "a".repeat(101), status: "ok", summary: "s" }])], ["invalid-id-max-length-is-fine", doc([{ id: "a".repeat(100), status: "ok", summary: "s" }])],
    ["invalid-id-not-a-string", doc([{ id: 1, status: "ok", summary: "s" }])], ["invalid-status", doc([{ id: "a", status: "bad", summary: "s" }])],
    ["invalid-status-missing", doc([{ id: "a", summary: "s" }])], ["invalid-summary-missing", doc([{ id: "a", status: "ok" }])],
    ["invalid-summary-not-a-string", doc([{ id: "a", status: "ok", summary: 5 }])], ["invalid-item-null", doc([null])], ["invalid-item-string", doc(["a"])],
  ] as [string, unknown][]) add(name, { probe: { doc: d } });
  add("probe-throws-a-plain-error", { probe: { throws: "plain" } });
  add("probe-throws-an-rpc-error", { probe: { throws: "rpc", reason: "firstaid-invalid" } });
  add("path-cleaning-foreign-homes-and-mail", { home: "/srv/plur1bus", probe: { doc: doc([
    { id: "x.paths", status: "warn", summary: "cannot open /home/bob/notes.txt and C:\\Users\\Carol\\x.db and /Users/anna/Library/foo", hint: "mail anna@example.org about /home/dave/.cache" },
    { id: "x.own", status: "warn", summary: "/srv/plur1bus/models and /fake-user/.cache and /srv/plur1bus2/x and /fake-user" },
    { id: "x.drive", status: "warn", summary: "D:/users/Eve/a and e:\\HOME\\Frank\\b and /home/ and /home/ x" },
  ]) } });
  for (const home of ["", "/", "/srv/plur1bus/", "C:\\data\\plur1bus\\"]) add(`home-${home === "" ? "empty" : home.replace(/[^a-z0-9]+/gi, "-").replace(/^-|-$/g, "") || "root"}`, { home, probe: { doc: doc([{ id: "x", status: "warn", summary: `cache /var/lib/x in ${home || "(none)"}models is stale` }]) } });
  add("redaction-happens-before-the-clip", { probe: { doc: doc([{ id: "models.cache", status: "warn", summary: { parts: [" ".repeat(4088), ...family, "fixture".repeat(20)] } }]) } });
  add("clip-at-4096-units", { probe: { doc: doc([{ id: "x.long", status: "warn", summary: "a".repeat(5000), hint: "é".repeat(5000) }]) } });
  add("clip-keeps-the-first-4096-ascii", { probe: { doc: doc([{ id: "x.edge", status: "ok", summary: "b".repeat(4096) }, { id: "x.edge2", status: "ok", summary: "b".repeat(4097) }]) } });
  // The sandbox matrix: platform x mechanism x availability x maxTasks.
  for (const platform of ["linux", "darwin", "win32"] as const) {
    for (const [mechanism, available] of [["namespace-limit", true], ["fork-denied", true], ["none", true], ["none", false], ["namespace-limit", false]] as const) {
      for (const maxTasks of [0, 1, 7, 512, 1.5, -1]) {
        add(`sandbox-${platform}-${mechanism}-${available ? "available" : "unavailable"}-${maxTasks === 1.5 ? "1p5" : maxTasks === -1 ? "minus1" : maxTasks}`, {
          platform, maxTasks, sandbox: okSandbox({ available, mechanism, backend: platform === "darwin" ? "seatbelt" : "bubblewrap" }),
        });
      }
    }
  }
  add("sandbox-default-max-tasks", { sandbox: okSandbox() });
  add("sandbox-hints-and-private-paths", { sandbox: okSandbox({ mechanism: "none", reason: "probe at /private/home/example/bin failed for /home/bob", hint: "fix /private/home/example/bin",
    tasks: { mechanism: "none", reason: "no cap in /private/home/example", hint: "Run PLUR1BUS as a normal user in /home/bob." } }) });
  add("sandbox-unavailable-with-a-hint", { sandbox: okSandbox({ available: false, backend: "none", strength: "none", reason: "no bubblewrap", hint: "install bubblewrap", mechanism: "none" }) });
  add("sandbox-bypass-row", { sandboxRequired: false });
  add("sandbox-required-row-absent", { sandboxRequired: true });
  add("core-checks-appended-and-deduplicated", { probe: { doc: doc([{ id: "privacy.local-only", status: "ok", summary: "cached off" }, { id: "x.a", status: "ok", summary: "a" }]) },
    coreChecks: [{ id: "privacy.local-only", status: "fail", summary: "active cloud refusal in /private/home/example", repair: { kind: "hint", label: "see /home/bob" } },
      { id: "core.new", status: "warn", summary: "new core row", repair: { kind: "hint", label: "mail anna@example.org" } }, { id: "core.new", status: "ok", summary: "second row with the same id" }] });
  add("composition-checks-deduplicated-repair-untouched", { probe: { doc: doc([{ id: "models.cache", status: "ok", summary: "fine" }]) },
    compositionChecks: [{ id: "providers.broken", status: "fail", summary: "provider broken refused (E_CONFIG_INVALID): billing path \"enterprise\" is not one of plan in /private/home/example", repair: { kind: "hint", label: "see /private/home/example/x and /home/bob" } },
      { id: "models.cache", status: "fail", summary: "already present" }] });
  add("skipped-categories-stand-for-prefixed-ids", { probe: { doc: doc([{ id: "containers.runtime", status: "ok", summary: "c" }, { id: "ports", status: "warn", summary: "p" }, { id: "secretsx", status: "ok", summary: "s" }]) } });
  for (const [label, capability] of [["fts5-only", { mode: "fts5-only", sourceError: false, lastRecheck: 1700000000000 }], ["full", { mode: "hybrid", sourceError: false, lastRecheck: null }],
    ["source-error", { mode: "hybrid", sourceError: true, lastRecheck: 12.5 }], ["huge-recheck", { mode: "fts5-only", sourceError: false, lastRecheck: 1e21 }], ["zero-recheck", { mode: "fts5-only", sourceError: false, lastRecheck: 0 }]] as const) add(`overlay-capability-${label}`, { capability });
  add("overlay-mining-available", { mining: { available: true } });
  add("overlay-mining-unavailable", { mining: { available: false } });
  const endReasons = (over: Record<string, number> = {}) => Object.fromEntries(TURN_END_REASONS.map((r) => [r, over[r] ?? 0]));
  const usage = (over: Partial<Usage> = {}): Usage => ({ turns: 0, rounds: 0, toolCalls: 0, metaCalls: { search: 0, skillLoad: 0, skillRead: 0 }, skills: { injected: 0, loaded: 0 }, errorsReturned: 0,
    toolNeedTurns: 0, forcedTurns: 0, withoutNeededTool: 0, toolChoiceUnsupported: 0, endReasons: endReasons(), triage: { count: 0 }, ...over });
  add("overlay-usage-empty", { usage: usage() });
  add("overlay-usage-busy", { usage: usage({ turns: 12, rounds: 30, toolCalls: 44, metaCalls: { search: 3, skillLoad: 2, skillRead: 1 }, skills: { injected: 5, loaded: 4 }, errorsReturned: 2, toolNeedTurns: 7, forcedTurns: 1,
    endReasons: endReasons({ completed: 9, "tool-error": 2, failed: 1 }), triage: { count: 11, p50Ms: 40, p95Ms: 120.5 } }) });
  add("overlay-usage-warns-on-unsupported-tool-choice", { usage: usage({ turns: 1, toolChoiceUnsupported: 1, endReasons: endReasons({ completed: 1 }), triage: { count: 1, p50Ms: 0, p95Ms: 0 } }) });
  add("overlay-usage-warns-on-unused-tools", { usage: usage({ turns: 2, withoutNeededTool: 1, toolNeedTurns: 1, endReasons: endReasons({ aborted: 1, "round-limit": 1 }) }) });
  add("overlays-in-order", { capability: { mode: "fts5-only", sourceError: false, lastRecheck: null }, mining: { available: true }, usage: usage({ turns: 1, endReasons: endReasons({ command: 1 }) }),
    coreChecks: [{ id: "core.live", status: "ok", summary: "live" }] });
  return out;
}

async function run(c: Case): Promise<unknown> {
  const descriptor = Object.getOwnPropertyDescriptor(process, "platform")!;
  Object.defineProperty(process, "platform", { ...descriptor, value: c.platform });
  try {
    const sandbox = resolve(c.sandbox) as Sandbox;
    let start: (() => Promise<unknown>) | undefined;
    let now = CLOCK_MS;
    const methods = guardMethods(buildDoctorMethods({
      home: c.home, clock: () => now,
      check: async () => {
        if ("throws" in c.probe) { if (c.probe.throws === "plain") throw new Error(`spawn ${c.home}/bin/plur1bus failed`); throw new RpcError("E_NOT_AVAILABLE", "installation diagnostics are unavailable", { reason: c.probe.reason }); }
        return resolve(c.probe.doc);
      },
      detectSandbox: async () => sandbox as never,
      scheduleInitial: (s) => { start = s; },
      ...(c.maxTasks !== undefined ? { sandboxMaxTasks: () => c.maxTasks! } : {}),
      ...(c.sandboxRequired !== undefined ? { sandboxRequired: () => c.sandboxRequired! } : {}),
      ...(c.coreChecks ? { coreChecks: () => resolve(c.coreChecks) as never } : {}),
      ...(c.compositionChecks ? { compositionChecks: () => resolve(c.compositionChecks) as never } : {}),
      ...(c.capability ? { capabilityStatus: () => c.capability! } : {}),
      ...(c.mining ? { miningStatus: () => c.mining! } : {}),
      ...(c.usage ? { turnTelemetry: () => c.usage as never } : {}),
    }), { resolve: () => ({ kind: "person", role: "viewer", userId: "person-alice" }), now: () => now });
    await start!().catch(() => {});
    // A failed startup snapshot is retried by the read once the 30 s window has passed: that read shows the real refusal.
    now += 30_000;
    try {
      return { ok: await methods["doctor.report"]!({}, { requestId: "request", connectionId: "connection", signal: new AbortController().signal }) };
    } catch (e) {
      const err = e as { error?: string; data?: { reason?: string }; reason?: string };
      return { error: { code: err.error, reason: err.data?.reason ?? err.reason ?? null } };
    }
  } finally { Object.defineProperty(process, "platform", descriptor); }
}

export async function buildDoctorVectors(): Promise<Record<string, unknown>> {
  const home = process.env.HOME;
  process.env.HOME = USER_HOME;
  try {
    const list = cases();
    const done = [];
    // One at a time: a case replaces `process.platform` while it runs.
    for (const c of list) done.push({ ...c, expected: await run(c) });
    return { report: { clockMs: CLOCK_MS, userHome: USER_HOME, cases: done } };
  } finally { if (home === undefined) delete process.env.HOME; else process.env.HOME = home; }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  process.exit(await exporterMain({ area: "doctor", build: buildDoctorVectors }));
}
