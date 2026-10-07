// `authorize(principal, action, resource)`: pure and side-effect free (no clock, no I/O, no logging). Deny by default.
import { policyFor } from "./policy.ts";
import type { ActionSpec, AgentRight, AuthorizeContext, BreakGlassGrant, Decision, DenyReason, Grant, Principal, ProjectRight, Resource, Role } from "./types.ts";
import { PRINCIPAL_KINDS, ROLES } from "./types.ts";

const deny = (reason: DenyReason): Decision => ({ effect: "deny", reason });
const ROLE_SET: ReadonlySet<string> = new Set(ROLES);
const KIND_SET: ReadonlySet<string> = new Set(PRINCIPAL_KINDS);
const AGENT_RANK: Readonly<Record<string, number>> = { use: 1, manage: 2 };
const PROJECT_RANK: Readonly<Record<string, number>> = { member: 1, lead: 2 };

/** Own-property lookup only: ids come from callers and `__proto__`/`constructor` must never resolve to a right. */
function right<R extends string>(table: Readonly<Record<string, R>> | undefined, id: string): R | undefined {
  return table !== undefined && Object.hasOwn(table, id) ? table[id] : undefined;
}

function shapeOf(r: Resource): string {
  if (r.kind !== "memory") return r.kind;
  return r.scope === "user" ? "memory-user" : `memory-agent:${r.scope}`;
}

function idOf(r: Resource): unknown {
  switch (r.kind) {
    case "system": return "";
    case "user": return r.userId;
    case "agent": return r.agentId;
    case "project": return r.projectId;
    case "memory": return r.scope === "user" ? r.ownerUserId : r.agentId;
  }
}

function scopeMatches(scopes: readonly string[], action: string): boolean {
  return scopes.some((s) => s === action || (s.endsWith(".*") && action.startsWith(s.slice(0, -1))));
}

function holdsObjectRight(p: Principal, spec: ActionSpec, r: Resource, id: string): boolean {
  if (spec.needs === undefined) return false;
  if (r.kind === "project") {
    const have: ProjectRight | undefined = right(p.projectRights, id);
    return have !== undefined && (PROJECT_RANK[have] ?? 0) >= (PROJECT_RANK[spec.needs] ?? Infinity);
  }
  // Agent rights also cover the agent-scoped memory resources.
  const have: AgentRight | undefined = right(p.agentRights, id);
  return have !== undefined && (AGENT_RANK[have] ?? 0) >= (AGENT_RANK[spec.needs] ?? Infinity);
}

function liveBreakGlass(p: Principal, targetUserId: string, now: number | undefined): BreakGlassGrant | undefined {
  if (now === undefined || !Number.isFinite(now)) return undefined;
  return p.breakGlass?.find((g) =>
    g.holderUserId === p.userId && g.targetUserId === targetUserId && g.revokedAt === undefined && now >= g.issuedAt && now < g.expiresAt);
}

function evaluate(g: Grant, p: Principal, spec: ActionSpec, r: Resource, id: string, ctx: AuthorizeContext): Decision | null {
  switch (g) {
    case "allow": return { effect: "allow", reason: "role" };
    case "own": return id !== "" && id === p.userId ? { effect: "allow", reason: "own" } : null;
    case "object": return holdsObjectRight(p, spec, r, id) ? { effect: "allow", reason: "object-right" } : null;
    case "break-glass": {
      const live = id !== "" && id !== p.userId ? liveBreakGlass(p, id, ctx.now) : undefined;
      return live ? { effect: "allow", reason: "break-glass", breakGlassId: live.id } : null;
    }
  }
}

export function authorize(principal: Principal | null | undefined, action: string, resource: Resource, ctx: AuthorizeContext = {}): Decision {
  if (principal === null || principal === undefined) return deny("unauthenticated");
  if (typeof principal !== "object" || typeof principal.userId !== "string" || principal.userId === "" || !ROLE_SET.has(principal.role)) return deny("invalid-principal");
  if (principal.kind !== undefined && !KIND_SET.has(principal.kind)) return deny("invalid-principal");
  const spec = policyFor(action);
  if (!spec) return deny("unknown-action");
  // D109 D6, before anything else can say yes: a human-only action needs a principal that is explicitly a person.
  if (spec.humanOnly === true && principal.kind !== "person") return deny("agent-principal");
  if (typeof resource !== "object" || resource === null || shapeOf(resource) !== spec.resource) return deny("resource-mismatch");
  const id = idOf(resource);
  if (typeof id !== "string" || (resource.kind !== "system" && id === "")) return deny("resource-mismatch");
  if (principal.tokenScopes !== undefined && !scopeMatches(principal.tokenScopes, action)) return deny("token-scope");

  const role: Role = principal.role;
  const grants = Object.hasOwn(spec.grants, role) ? spec.grants[role] ?? [] : [];
  for (const g of grants) {
    const d = evaluate(g, principal, spec, resource, id, ctx);
    if (d) return d;
  }
  if (grants.length === 0) return deny("role-denied");
  // The most specific thing the role was missing, so a UI or an audit line can say why.
  if (grants.includes("break-glass")) return deny("break-glass-required");
  if (grants.includes("own")) return deny("not-owner");
  return deny("object-right-required");
}

/** Convenience for lists (`agent.list`): the resources the principal may see under `action`. */
export function canSee<R extends Resource>(principal: Principal | null | undefined, action: string, resources: readonly R[], ctx: AuthorizeContext = {}): R[] {
  return resources.filter((r) => authorize(principal, action, r, ctx).effect === "allow");
}
