// D109 §2–§9: the decision evaluator. Pure: no I/O, no store, no clock of its own, no mutation of its inputs.
// Not wired into any dispatcher (that is a later part). Grants arrive through `GrantSource`; time through `Clock`.
//
// Precedence (first match wins): deny-list > never > tools.deny > grants > roots > default (approval outside roots).
import {
  CAPABILITIES, DEFAULTS, GRANT_SCOPES, RISKS, riskRank, scopeRank, stricterClass,
  type CapabilityDef, type GrantScope, type PolicyClass, type Risk, type SurfaceTrust,
} from "./capabilities.ts";
import { effectRank, isEffect, maxEffect, type Effect } from "./effects.ts";

export type SubjectKind = "agent" | "subagent" | "acp-agent" | "mcp-client" | "acp-editor" | "a2a-peer" | "remote-harness";

/** Flags the harness computes per call (D109 §2); never taken from the model or the tool. */
export interface CallFlags {
  outsideRoots: boolean;
  /** Computed by the path layer (deny-list, case-folded, NFC); this package never inspects a path for it. */
  denyListHit: boolean;
  privileged?: boolean;
  irreversible?: boolean;
  batch?: boolean;
  /** `shell.exec`: the command is on the per-OS read-only allowlist. */
  shellAllowlisted?: boolean;
  /** `shell.exec`: an OS sandbox holds on this system. */
  sandboxed?: boolean;
  /** `secrets.use`: the slot is declared by the tool/extension. */
  secretSlotDeclared?: boolean;
  /** `net.publish`: the target is public (not tailnet). */
  publishPublic?: boolean;
  /** A target is a home/drive root or system tree (§3): grants there are T3 and at most `task`. */
  systemTree?: boolean;
}

export interface Call {
  capability: string;
  tool: string;
  /** The tool's declared effect; it can raise the capability's intrinsic effect, never lower it. */
  effect?: Effect;
  flags: CallFlags;
  /** Canonical, resolved targets (path layer). */
  targets?: readonly string[];
  access?: "read" | "write";
  /** Hash over capability, tool, canonical arguments, resolved targets, cwd, env names. */
  actionHash: string;
}

export interface Context {
  principal: { person: string };
  subject: { kind: SubjectKind; agentId: string };
  /** Trust of the surface the call originates from. Echoed into the request for audit; see RULING in `decide`. */
  surface: SurfaceTrust;
  sessionId?: string;
  taskId?: string;
  projectId?: string;
  /** Present on headless/unattended runs: only standing grants created for this job count. */
  headless?: { jobId: string };
  /** ADR-003 behaviour-layer `tools.deny`: tool names or capability ids, `prefix.*` allowed. */
  toolsDeny?: readonly string[];
  /** Per-agent moves between `allowed` and `approval` (never a floor). */
  overrides?: Readonly<Record<string, "allowed" | "approval">>;
  taint?: { tainted: boolean; readPrivate: boolean };
  /** Sub-agent via hand-off (D104): `scope` = capability ids from `constraints.scope`; `approvalsHeld` = store ids. */
  handoff?: { scope: readonly string[]; taskId: string; approvalsHeld: readonly string[] };
  /** Inbound MCP/ACP token scopes: narrow only. */
  tokenScopes?: readonly string[];
  /** Action hashes a person already denied in this task (§5: refused without asking). */
  deniedActionHashes?: readonly string[];
  promptsThisHour?: number;
}

export type GrantMatch =
  | { kind: "action" } // `once`: bound to `actionHash`
  | { kind: "capability" } // whole capability inside roots
  | { kind: "path"; path: string; access: "read" | "write"; recursive: boolean };

export interface Grant {
  id: string;
  capability: string;
  person: string;
  agent: string;
  scope: GrantScope;
  match: GrantMatch;
  createdAt: number;
  lastUsedAt?: number;
  /** Explicit expiry on top of the scope's own bound. */
  expiresAt?: number;
  revoked?: boolean;
  /** `once`: already consumed. */
  consumedAt?: number;
  actionHash?: string;
  taskId?: string;
  sessionId?: string;
  projectId?: string;
  /** Standing grant created for a headless job. */
  jobId?: string;
  /** Marked by the person when deciding ("including helpers", §6). */
  delegable?: boolean;
  /** Trust of the surface the person decided on; a grant below the call's required surface never applies. */
  surface: SurfaceTrust;
  /** `shell.exec` without a sandbox: the person knowingly accepted "not sandboxed" (Q17). */
  acknowledgedUnsandboxed?: boolean;
}

export interface GrantSource {
  list(q: { person: string; agent: string; capability: string }): readonly Grant[];
  /** For ids a hand-off references (D104). Unknown or foreign ids return undefined. */
  get(id: string): Grant | undefined;
}
export interface Clock { now(): number }
export interface Deps { grants: GrantSource; clock: Clock }

export type DenyReason = "policy-never" | "deny-list" | "surface-untrusted" | "repeat-denied" | "prompt-cap";

export interface GrantOption { scope: GrantScope; requiredSurface: SurfaceTrust }
export interface ApprovalRequest {
  capability: string;
  tool: string;
  effect: Effect;
  flags: CallFlags;
  risk: Risk;
  reversible: boolean;
  actionHash: string;
  /** Narrowest first; the first entry is the pre-selected one. */
  grantOptions: readonly GrantOption[];
  /** Surface needed to decide even the narrowest option. */
  requiredSurface: SurfaceTrust;
  tainted: boolean;
  /** Standing grants were set aside by the §8 taint rule. */
  taintSuspended: boolean;
  originSurface: SurfaceTrust;
}

export type Decision =
  | { kind: "allow"; via: "default" | "override" | "grant"; grantId?: string; reviewDue?: boolean }
  | { kind: "ask"; request: ApprovalRequest; /** Headless: the job parks and notifies (§9). */ park: boolean; why: string }
  | { kind: "deny"; reason: DenyReason; rule: string };

const deny = (reason: DenyReason, rule: string): Decision => ({ kind: "deny", reason, rule });

/** One canonical form for every name compared against a config list: trimmed, case-folded. */
function canon(s: string): string {
  return s.trim().toLowerCase();
}

/**
 * ADR-003 `tools.deny` entries: an exact tool or capability name, or a glob where `*` matches any run of characters
 * (`*`, `fs*`, `fs.*`), compared case-folded. RULING: an entry that is not a non-empty string cannot be read as a rule,
 * so it denies everything (fail closed) instead of being skipped silently.
 */
function matchesDeny(list: readonly unknown[], call: Call, capability: string): "invalid" | boolean {
  const names = [canon(call.tool), capability];
  let hit = false;
  for (const entry of list) {
    if (typeof entry !== "string" || canon(entry).length === 0) return "invalid";
    const re = new RegExp(`^${canon(entry).split("*").map((p) => p.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join(".*")}$`);
    if (names.some((n) => re.test(n))) hit = true;
  }
  return hit;
}

function validGrant(g: Grant): boolean {
  const str = (v: unknown) => typeof v === "string" && v.length > 0;
  const time = (v: unknown) => typeof v === "number" && Number.isFinite(v);
  return (
    g !== null && typeof g === "object" &&
    str(g.id) && str(g.capability) && str(g.person) && str(g.agent) &&
    (GRANT_SCOPES as readonly string[]).includes(g.scope) &&
    time(g.createdAt) && (g.lastUsedAt === undefined || time(g.lastUsedAt)) && (g.expiresAt === undefined || time(g.expiresAt)) &&
    (g.surface === 0 || g.surface === 1 || g.surface === 2 || g.surface === 3) &&
    g.match !== null && typeof g.match === "object" &&
    (g.match.kind === "action" || g.match.kind === "capability" || (g.match.kind === "path" && str(g.match.path) && (g.match.access === "read" || g.match.access === "write") && typeof g.match.recursive === "boolean"))
  );
}

// ---- scope / surface / risk helpers (exported: grant creation and the surfaces reuse them) ----

/** Highest scope a grant for this call may have. */
export function maxScopeFor(def: CapabilityDef, flags: CallFlags): GrantScope {
  let max: GrantScope = def.ceiling ?? "once";
  const cap = (s: GrantScope) => { if (scopeRank(s) < scopeRank(max)) max = s; };
  if (isBatch(flags, undefined)) cap("once");
  if (flags.systemTree) cap("task");
  if (flags.publishPublic) cap("once");
  return max;
}

function isBatch(flags: CallFlags, targets: readonly string[] | undefined): boolean {
  return flags.batch === true || (targets?.length ?? 0) > DEFAULTS.batchTargetsOver;
}

export function riskOf(def: CapabilityDef, flags: CallFlags): Risk {
  let r = riskRank(def.baseRisk);
  if (flags.outsideRoots && effectRank(def.intrinsicEffect) >= effectRank("local-write")) r += 1;
  if (flags.irreversible) r += 1;
  if (flags.privileged) r += 1;
  if (flags.publishPublic || flags.systemTree) r = 3;
  return RISKS[Math.min(r, 3)]!;
}

/** The surface needed to decide (or to have created a grant) at `scope` for this call. */
export function requiredSurface(def: CapabilityDef, scope: GrantScope, flags: CallFlags): SurfaceTrust {
  let s: number = Math.max(def.minSurface ?? 1, DEFAULTS.surfaceByRisk[riskOf(def, flags)]);
  if (scope === "always" && flags.outsideRoots && (def.id === "fs.write" || def.id === "shell.exec")) s = 3;
  if (scope === "always" && (def.id === "net.publish" || def.id === "remote.control")) s = 3;
  if (flags.publishPublic || flags.systemTree) s = 3;
  return s as SurfaceTrust;
}

/** §5 channel trust: may a decision made on `surface` be accepted for this request? T0 never. */
export function surfaceMayDecide(req: Pick<ApprovalRequest, "capability" | "risk" | "flags">, surface: SurfaceTrust, scope: GrantScope): boolean {
  const def = CAPABILITIES.get(req.capability);
  if (!def || surface <= 0) return false;
  if (surface === 1 && !(req.risk === "low" && ["fs.read", "fs.write", "clipboard.read"].includes(def.id))) return false;
  return surface >= requiredSurface(def, scope, req.flags) && scopeRank(scope) <= scopeRank(maxScopeFor(def, req.flags));
}

/** Expiry per scope; `always` expires 90 days after last use (creation if never used). */
export function grantExpiry(g: Grant): number {
  const L = DEFAULTS.lifetimes;
  const bound =
    g.scope === "once" ? g.createdAt + L.onceUnusedMs
    : g.scope === "task" ? g.createdAt + L.taskMs
    : g.scope === "session" ? (g.lastUsedAt ?? g.createdAt) + L.sessionIdleMs
    : (g.lastUsedAt ?? g.createdAt) + L.alwaysUnusedMs;
  return g.expiresAt === undefined ? bound : Math.min(bound, g.expiresAt);
}

/** §4/Q13: an `always` grant gets a review nudge at 90 days of age. */
export function grantReviewDue(g: Grant, now: number): boolean {
  return g.scope === "always" && now - g.createdAt >= DEFAULTS.reviewNudgeAgeMs;
}

const ABS = /^(?:\/|[A-Za-z]:[\\/]|\\\\)/;
function segments(p: string): string[] | null {
  if (p.length === 0 || p.includes("\0") || !ABS.test(p)) return null;
  const segs = p.split(/[\\/]+/).filter((s) => s.length > 0);
  return segs.some((s) => s === "." || s === "..") ? null : segs;
}

/** Exact-form, case-sensitive coverage on already-canonical paths; ambiguity resolves toward "not covered". */
export function pathCovered(grantPath: string, recursive: boolean, target: string): boolean {
  const g = segments(grantPath);
  const t = segments(target);
  if (!g || !t || g.length === 0) return false;
  if (g.length > t.length || !g.every((s, i) => s === t[i])) return false;
  return recursive ? true : t.length === g.length + 1;
}

// ---- the evaluator ----

export function decide(call: Call, ctx: Context, deps: Deps): Decision {
  const capability = typeof call.capability === "string" ? canon(call.capability) : "";
  const def = CAPABILITIES.get(capability);
  if (!def) return deny("policy-never", "unknown-capability"); // RULING: an unknown capability id is never, not approval
  const flags = call.flags;

  // (1) credential deny-list
  if (flags.denyListHit) return deny("deny-list", "deny-list");
  // (2) never capabilities (and an undeclared secret slot)
  if (def.base.inside === "never") return deny("policy-never", "never");
  if (def.id === "secrets.use" && flags.secretSlotDeclared !== true) return deny("policy-never", "never:secret-slot");
  // (3) tools.deny
  if (ctx.toolsDeny) {
    const m = matchesDeny(ctx.toolsDeny, call, def.id);
    if (m === "invalid") return deny("policy-never", "tools.deny:invalid");
    if (m) return deny("policy-never", "tools.deny");
  }
  // Subject limits: narrowing only (ADR-003, ADR-008, D104).
  // RULING: an A2A peer reaches no tool through this evaluator at all (D109 §1: only the harness functions ADR-008 exposes).
  if (ctx.subject.kind === "a2a-peer") return deny("surface-untrusted", "a2a-peer");
  if (ctx.tokenScopes && !ctx.tokenScopes.some((c) => canon(c) === def.id)) return deny("policy-never", "token-scope");
  if (ctx.subject.kind === "subagent" && !(ctx.handoff && ctx.handoff.scope.some((c) => canon(c) === def.id))) {
    return deny("policy-never", "handoff-scope"); // RULING: a sub-agent without hand-off scope covering the capability is refused
  }

  // RULING: an effect string outside the vocabulary is the strictest one (money), never harmless.
  const effect = call.effect === undefined ? def.intrinsicEffect : isEffect(call.effect) ? maxEffect(call.effect, def.intrinsicEffect) : "money";
  const batch = isBatch(flags, call.targets);
  const tainted = ctx.taint?.tainted === true;
  const taintSuspends = tainted && ctx.taint?.readPrivate === true && (def.taintSensitive || effect === "external");

  // (5/6) class from roots and defaults, then the person's per-agent move, then the floors no override lowers.
  let cls: PolicyClass = flags.outsideRoots ? def.base.outside : def.base.inside;
  if (def.id === "shell.exec" && flags.shellAllowlisted === true && !flags.outsideRoots && flags.privileged !== true) cls = "allowed";
  let via: "default" | "override" = "default";
  const ov = overrideFor(ctx.overrides, def.id);
  if (ov && def.lowerable) {
    if (ov === "approval") cls = stricterClass(cls, "approval");
    // RULING (Q12): roots are a hard limit; a per-agent "allowed" never lifts the approval that applies outside them.
    else if (ov === "allowed" && cls === "approval" && !flags.outsideRoots) { cls = "allowed"; via = "override"; }
  }
  const floored =
    flags.privileged === true || flags.irreversible === true || batch ||
    effect === "money" || effect === "external" || effect === "local-destructive" ||
    (flags.outsideRoots && effectRank(effect) >= effectRank("local-write"));
  if (floored) cls = stricterClass(cls, "approval");

  if (cls === "allowed") {
    // An override is a standing permission; the taint rule suspends it like any standing grant (§8).
    if (via === "override" && taintSuspends) return ask(def, call, ctx, effect, true, "taint-suspended");
    return { kind: "allow", via };
  }

  // (4) grants
  const now = deps.clock.now();
  for (const g of Number.isFinite(now) ? candidateGrants(call, ctx, deps, def.id) : []) {
    if (validGrant(g) && grantApplies(g, def, call, ctx, flags, effect, batch, taintSuspends, now)) {
      const out: Decision = { kind: "allow", via: "grant", grantId: g.id };
      if (grantReviewDue(g, now)) out.reviewDue = true;
      return out;
    }
  }

  if (ctx.deniedActionHashes?.includes(call.actionHash)) return deny("repeat-denied", "fatigue:repeat-denied");
  if ((ctx.promptsThisHour ?? 0) >= DEFAULTS.maxPromptsPerTaskPerHour) return deny("prompt-cap", "fatigue:prompt-cap"); // RULING: over the cap = refused, not queued
  return ask(def, call, ctx, effect, taintSuspends, taintSuspends ? "taint-suspended" : cls === "approval" ? "approval-class" : "approval");
}

function overrideFor(o: Context["overrides"], id: string): "allowed" | "approval" | undefined {
  if (!o) return undefined;
  let out: "allowed" | "approval" | undefined;
  for (const [k, v] of Object.entries(o)) {
    if (canon(k) !== id) continue;
    if (v === "approval") return "approval"; // the stricter of duplicate spellings wins
    if (v === "allowed") out = "allowed";
  }
  return out;
}

function ask(def: CapabilityDef, call: Call, ctx: Context, effect: Effect, taintSuspended: boolean, why: string): Decision {
  const flags = call.flags;
  const max = scopeRank(maxScopeFor(def, { ...flags, batch: isBatch(flags, call.targets) }));
  const options: GrantOption[] = GRANT_SCOPES.filter((s) => scopeRank(s) <= max).map((scope) => ({ scope, requiredSurface: requiredSurface(def, scope, flags) }));
  const risk = riskOf(def, flags);
  return {
    kind: "ask",
    park: ctx.headless !== undefined,
    why,
    request: {
      capability: def.id, tool: call.tool, effect, flags: { ...flags }, risk,
      reversible: flags.irreversible !== true && effect !== "local-destructive" && effect !== "money",
      actionHash: call.actionHash, grantOptions: options, requiredSurface: options[0]!.requiredSurface,
      tainted: ctx.taint?.tainted === true, taintSuspended, originSurface: ctx.surface,
    },
  };
}

function candidateGrants(call: Call, ctx: Context, deps: Deps, capability: string): Grant[] {
  const own = deps.grants.list({ person: ctx.principal.person, agent: ctx.subject.agentId, capability });
  const held: Grant[] = [];
  if (ctx.subject.kind === "subagent" && ctx.handoff) {
    for (const id of ctx.handoff.approvalsHeld) {
      const g = deps.grants.get(id); // a forged or foreign id resolves to nothing, or to a grant the checks below refuse
      if (g && g.delegable === true && g.taskId === ctx.handoff.taskId && g.person === ctx.principal.person) held.push(g);
    }
  }
  return [...own, ...held];
}

function grantApplies(
  g: Grant, def: CapabilityDef, call: Call, ctx: Context, flags: CallFlags,
  effect: Effect, batch: boolean, taintSuspends: boolean, now: number,
): boolean {
  if (g.revoked === true || canon(g.capability) !== def.id || g.person !== ctx.principal.person) return false;
  if (!GRANT_SCOPES.includes(g.scope)) return false;
  if (ctx.headless) { if (g.jobId !== ctx.headless.jobId || g.scope !== "always") return false; } // §9
  else if (g.jobId !== undefined) return false;
  const ownAgent = g.agent === ctx.subject.agentId;
  if (!ownAgent && !(ctx.subject.kind === "subagent" && ctx.handoff?.approvalsHeld.includes(g.id))) return false;
  if (scopeRank(g.scope) > scopeRank(maxScopeFor(def, { ...flags, batch }))) return false;
  if (g.createdAt > now || now >= grantExpiry(g)) return false; // a grant from the future is not valid yet (fail closed)
  if (g.surface < requiredSurface(def, g.scope, flags)) return false;
  if (taintSuspends && g.scope !== "once") return false;
  if (g.projectId !== undefined && g.projectId !== ctx.projectId) return false;

  switch (g.scope) {
    case "once": if (g.consumedAt !== undefined || g.actionHash === undefined || g.actionHash !== call.actionHash || g.match.kind !== "action") return false; return true;
    case "task": if (g.taskId === undefined || g.taskId !== (ownAgent ? ctx.taskId : ctx.handoff?.taskId)) return false; break;
    case "session": if (g.sessionId === undefined || g.sessionId !== ctx.sessionId) return false; break;
    case "always": break;
  }
  if (g.match.kind === "action") return false; // an action-bound grant is `once` by construction
  if (batch || flags.privileged === true || effect === "money") return false;
  if (g.match.kind === "capability") {
    if (flags.outsideRoots) return false;
    if (def.id === "shell.exec" && flags.sandboxed !== true && g.acknowledgedUnsandboxed !== true) return false;
    return true;
  }
  const m = g.match;
  if (!call.targets || call.targets.length === 0 || call.access === undefined) return false;
  if (m.access === "read" && call.access === "write") return false;
  return call.targets.every((t) => pathCovered(m.path, m.recursive, t));
}
