// RBAC for human principals (ADR-007). Not D109 `policy.decide`, which governs what an *agent* may do.

export const ROLES = ["owner", "admin", "operator", "member", "viewer"] as const;
export type Role = (typeof ROLES)[number];

/** Object rights (ADR-007 "Object rights"): per agent `use` < `manage`, per project `member` < `lead`. */
export type AgentRight = "use" | "manage";
export type ProjectRight = "member" | "lead";

/** A live break-glass grant (`break-glass.ts` mints them). Read access to one target user's `user`-scope cards. */
export interface BreakGlassGrant {
  readonly id: string;
  readonly holderUserId: string;
  readonly targetUserId: string;
  readonly reason: string;
  readonly issuedAt: number;
  readonly expiresAt: number;
  readonly revokedAt?: number;
}

export interface Principal {
  /** The opaque harness user id (ADR-007 `harnessUserId`). */
  readonly userId: string;
  readonly role: Role;
  readonly agentRights?: Readonly<Record<string, AgentRight>>;
  readonly projectRights?: Readonly<Record<string, ProjectRight>>;
  /** API-token scopes: exact action names or `prefix.*`. Absent = a session (no narrowing); present = role ∩ scopes. */
  readonly tokenScopes?: readonly string[];
  readonly breakGlass?: readonly BreakGlassGrant[];
}

export type MemoryAgentScope = "agent-private" | "workspace";

export type Resource =
  | { readonly kind: "system" }
  | { readonly kind: "user"; readonly userId: string }
  | { readonly kind: "agent"; readonly agentId: string }
  | { readonly kind: "project"; readonly projectId: string }
  | { readonly kind: "memory"; readonly scope: "user"; readonly ownerUserId: string }
  | { readonly kind: "memory"; readonly scope: MemoryAgentScope; readonly agentId: string };

/** What an action's resource must look like; `memory-user` / `memory-agent:<scope>` pin the card scope. */
export type ResourceShape = "system" | "user" | "agent" | "project" | "memory-user" | "memory-agent:agent-private" | "memory-agent:workspace";

/** How a role may satisfy an action. A role may list several; the first that holds wins. */
export type Grant = "allow" | "own" | "object" | "break-glass";

export interface ActionSpec {
  readonly action: string;
  readonly resource: ResourceShape;
  /** The right `object` grants need on the agent or project; manage implies use, lead implies member. */
  readonly needs?: AgentRight | ProjectRight;
  readonly grants: Readonly<Partial<Record<Role, readonly Grant[]>>>;
}

export type AllowReason = "role" | "own" | "object-right" | "break-glass";
export type DenyReason =
  | "unauthenticated" | "invalid-principal" | "unknown-action" | "resource-mismatch" | "token-scope"
  | "role-denied" | "not-owner" | "object-right-required" | "break-glass-required";

export type Decision =
  | { readonly effect: "allow"; readonly reason: AllowReason; readonly breakGlassId?: string }
  | { readonly effect: "deny"; readonly reason: DenyReason };

export interface AuthorizeContext {
  /** Epoch ms. Absent ⇒ no break-glass grant is honoured (authorize never reads a clock). */
  readonly now?: number;
}
