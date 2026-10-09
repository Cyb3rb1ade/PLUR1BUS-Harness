import { authorize } from "../rbac/authorize.ts";
import type { Principal } from "../rbac/types.ts";
import type { Actor } from "./service.ts";
import { IdentityError } from "./store.ts";

export type IdentityAction = "create" | "link" | "unlink" | "pair" | "confirm" | "backfill";
export interface AuthorizePort {
  authorize(actor: Actor, action: IdentityAction, harnessUserId: string): boolean;
}
/** Reuse existing RBAC actions; identity-specific policy additions are outside this work package. */
export const rbacAuthorizePort: AuthorizePort = {
  authorize(actor, action, harnessUserId) {
    if (actor.kind !== "person" || !actor.role) return false;
    const principal: Principal = { userId: actor.user, role: actor.role, kind: actor.kind,
      ...(actor.tokenScopes !== undefined ? { tokenScopes: actor.tokenScopes } : {}) };
    if (action === "backfill" || action === "create") return authorize(principal, "users.manage", { kind: "system" }).effect === "allow";
    const elevated = authorize(principal, "users.manage", { kind: "system" }).effect === "allow";
    const own = actor.user === harnessUserId && authorize(principal, "my.write", { kind: "user", userId: harnessUserId }).effect === "allow";
    return elevated || own;
  },
};
export function requireAuthorization(port: AuthorizePort, actor: Actor, action: IdentityAction, user: string): void {
  // An injected policy can narrow or extend human rights, but never authorize an agent.
  if (actor.kind !== "person" || !port.authorize(actor, action, user)) throw new IdentityError("denied", "identity action denied");
}
