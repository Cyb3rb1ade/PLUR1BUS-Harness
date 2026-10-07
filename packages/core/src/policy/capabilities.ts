// D109 §2/§4: the capability taxonomy and every default number, in one data table.
// Owner questions Q12–Q19 may still change these; change them here and nowhere else.
import type { Effect } from "./effects.ts";

export type PolicyClass = "allowed" | "approval" | "never";
const CLASS_STRICTNESS: Record<PolicyClass, number> = { allowed: 0, approval: 1, never: 2 };
export function stricterClass(a: PolicyClass, b: PolicyClass): PolicyClass {
  return CLASS_STRICTNESS[a] >= CLASS_STRICTNESS[b] ? a : b;
}

export const GRANT_SCOPES = ["once", "task", "session", "always"] as const;
export type GrantScope = (typeof GRANT_SCOPES)[number];
export function scopeRank(s: GrantScope): number {
  return GRANT_SCOPES.indexOf(s);
}

export const RISKS = ["low", "medium", "high", "critical"] as const;
export type Risk = (typeof RISKS)[number];
export function riskRank(r: Risk): number {
  return RISKS.indexOf(r);
}

/** D109 §5 surface trust: T0 nothing, T1 editor (low only), T2 private linked chat / web, T3 app, CLI TTY, step-up web. */
export type SurfaceTrust = 0 | 1 | 2 | 3;

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

export const DEFAULTS = {
  lifetimes: {
    onceUnusedMs: 10 * MIN, // §4: once ends on use, or 10 min unused
    taskMs: 24 * HOUR, // task: task done/aborted, or 24 h
    sessionIdleMs: 7 * DAY, // session: end/archive, or 7 days idle
    alwaysUnusedMs: 90 * DAY, // always: 90 days unused (Q13)
  },
  reviewNudgeAgeMs: 90 * DAY, // Q13: nudge at 90 days of age
  maxPromptsPerTaskPerHour: 10, // Q15
  batchTargetsOver: 20, // D106 dry run
  surfaceByRisk: { low: 1, medium: 2, high: 2, critical: 3 } as Record<Risk, SurfaceTrust>,
} as const;

export interface CapabilityDef {
  readonly id: string;
  /** What the capability covers (documentation; shown in the generated rule editor). */
  readonly covers: string;
  /** The lowest effect this capability can have; a tool's declared effect can raise it, never lower it. */
  readonly intrinsicEffect: Effect;
  readonly base: { readonly inside: PolicyClass; readonly outside: PolicyClass };
  /** Highest grant scope; null = no standing grant (approval, when forced, is `once`). */
  readonly ceiling: GrantScope | null;
  /** Lowest surface that may decide; null = never asks. */
  readonly minSurface: SurfaceTrust | null;
  readonly baseRisk: Risk;
  /** A person may move it between allowed and approval per agent. */
  readonly lowerable: boolean;
  /** Standing grants are suspended in a tainted turn that read private data (§8). */
  readonly taintSensitive: boolean;
}

const A: PolicyClass = "allowed";
const P: PolicyClass = "approval";
const N: PolicyClass = "never";
const same = (c: PolicyClass) => ({ inside: c, outside: c });

function def(d: Omit<CapabilityDef, "taintSensitive" | "lowerable"> & Partial<Pick<CapabilityDef, "taintSensitive" | "lowerable">>): CapabilityDef {
  return Object.freeze({ taintSensitive: false, lowerable: d.ceiling !== "once" && d.minSurface !== 3 && d.base.inside !== "never", ...d });
}

const TABLE: readonly CapabilityDef[] = [
  def({ id: "fs.read", covers: "fs.list/stat/read/search", intrinsicEffect: "read", base: { inside: A, outside: P }, ceiling: "always", minSurface: 1, baseRisk: "low" }),
  def({ id: "fs.write", covers: "fs.write/edit/mkdir/copy/move, fs.trash inside roots", intrinsicEffect: "local-write", base: { inside: A, outside: P }, ceiling: "always", minSurface: 1, baseRisk: "low" }),
  def({ id: "fs.delete", covers: "fs.delete, fs.trash outside roots", intrinsicEffect: "local-destructive", base: same(P), ceiling: "task", minSurface: 2, baseRisk: "high" }),
  def({ id: "shell.exec", covers: "shell.*, skill scripts", intrinsicEffect: "local-write", base: same(P), ceiling: "always", minSurface: 2, baseRisk: "medium" }),
  def({ id: "proc.signal", covers: "proc.signal/kill, apps.quit with unsaved state", intrinsicEffect: "local-destructive", base: same(P), ceiling: "session", minSurface: 2, baseRisk: "medium" }),
  def({ id: "pkg.change", covers: "pkg.install/upgrade/remove", intrinsicEffect: "local-destructive", base: same(P), ceiling: "once", minSurface: 2, baseRisk: "high" }),
  def({ id: "sys.read", covers: "sys.*, proc.list", intrinsicEffect: "read", base: same(A), ceiling: null, minSurface: null, baseRisk: "low" }),
  def({ id: "clipboard.read", covers: "clipboard.read", intrinsicEffect: "read", base: same(P), ceiling: "session", minSurface: 1, baseRisk: "low" }),
  def({ id: "net.fetch", covers: "web.fetch, browser.navigate/read", intrinsicEffect: "read", base: same(A), ceiling: null, minSurface: null, baseRisk: "low" }),
  def({ id: "net.submit", covers: "form submission, downloads, external MCP tools, non-read-only webmcp", intrinsicEffect: "external", base: same(P), ceiling: "session", minSurface: 2, baseRisk: "medium", taintSensitive: true }),
  def({ id: "comm.send", covers: "mail/messages/posts as the person", intrinsicEffect: "external", base: same(P), ceiling: "session", minSurface: 2, baseRisk: "high", taintSensitive: true }),
  def({ id: "net.publish", covers: "tailnet / public publishing", intrinsicEffect: "external", base: same(P), ceiling: "always", minSurface: 2, baseRisk: "high", taintSensitive: true }),
  def({ id: "money.spend", covers: "purchases, paid top-ups, money tools", intrinsicEffect: "money", base: same(P), ceiling: "once", minSurface: 3, baseRisk: "critical" }),
  def({ id: "os.privilege", covers: "sudo, doas, pkexec, polkit, UAC, runas", intrinsicEffect: "local-destructive", base: same(P), ceiling: "once", minSurface: 3, baseRisk: "critical" }),
  def({ id: "os.grant", covers: "TCC / privacy toggles / portals", intrinsicEffect: "local-write", base: same(P), ceiling: "always", minSurface: 3, baseRisk: "high" }),
  def({ id: "os.script", covers: "os.shortcuts.run, os.script.run", intrinsicEffect: "local-write", base: same(P), ceiling: "session", minSurface: 2, baseRisk: "medium" }),
  def({ id: "screen.capture", covers: "screen.capture", intrinsicEffect: "read", base: same(P), ceiling: "session", minSurface: 2, baseRisk: "medium" }),
  def({ id: "ui.control", covers: "ui.*", intrinsicEffect: "local-write", base: same(P), ceiling: "session", minSurface: 2, baseRisk: "high" }),
  def({ id: "secrets.use", covers: "leasing a secret slot into a tool or script", intrinsicEffect: "read", base: same(A), ceiling: null, minSurface: null, baseRisk: "low" }),
  def({ id: "agent.delegate", covers: "delegate/handoff, MoA", intrinsicEffect: "read", base: same(A), ceiling: null, minSurface: null, baseRisk: "low" }),
  def({ id: "remote.control", covers: "D108 session start", intrinsicEffect: "external", base: same(P), ceiling: "always", minSurface: 3, baseRisk: "critical" }),
  // never: a floor nobody lowers
  def({ id: "harness.admin", covers: "config writes, extension install/enable, grants and approvals themselves", intrinsicEffect: "local-write", base: same(N), ceiling: null, minSurface: null, baseRisk: "critical" }),
  def({ id: "credential.entry", covers: "typing passwords or OTPs into any UI", intrinsicEffect: "external", base: same(N), ceiling: null, minSurface: null, baseRisk: "critical" }),
  def({ id: "captcha.solve", covers: "solving CAPTCHAs", intrinsicEffect: "external", base: same(N), ceiling: null, minSurface: null, baseRisk: "critical" }),
  def({ id: "input.monitor", covers: "keystroke capture", intrinsicEffect: "read", base: same(N), ceiling: null, minSurface: null, baseRisk: "critical" }),
  def({ id: "policy.bypass", covers: "disabling the sandbox, editing the policy or the store", intrinsicEffect: "local-write", base: same(N), ceiling: null, minSurface: null, baseRisk: "critical" }),
];

export type CapabilityId = string;

export const CAPABILITIES: ReadonlyMap<CapabilityId, CapabilityDef> = new Map(TABLE.map((d) => [d.id, d]));

/** Capabilities that no agent, grant, override or surface can ever reach. */
export const NEVER_CAPABILITIES: readonly CapabilityId[] = TABLE.filter((d) => d.base.inside === "never").map((d) => d.id);

export function capabilityOf(id: string): CapabilityDef | undefined {
  return CAPABILITIES.get(id);
}
