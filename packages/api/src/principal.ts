import { randomUUID } from "node:crypto";
import type { Session } from "./session.ts";
import type { ApiPrincipal } from "@plur1bus/module-api";
import type { RbacPrincipal } from "./rbac-bridge.ts";
/** Explicit bootstrap mapping; no browser-supplied principal or actAs reaches this function. */
export function webPrincipal(p: RbacPrincipal, bootstrapOwner = false): ApiPrincipal {
  if (p.kind !== "person" && p.kind !== "agent") throw new Error("authenticated principal required");
  return { userId: bootstrapOwner && p.userId === "owner" ? "local-owner" : p.userId, kind: p.kind, role: p.role,
    ...(p.agentRights ? { agentRights: p.agentRights } : {}), ...(p.projectRights ? { projectRights: p.projectRights } : {}), ...(p.tokenScopes ? { tokenScopes: p.tokenScopes } : {}),
    ...(p.tokenId !== undefined ? { tokenId: p.tokenId } : {}), ...(p.binding !== undefined ? { binding: p.binding } : {}) };
}

const connections = new WeakMap<Session, string>();
/** A logical connection for one authenticated session, never the cookie value or a browser authority claim. */
export function webConnection(session: Session): string {
  let key = connections.get(session); if (!key) { key = randomUUID(); connections.set(session, key); } return key;
}

export function forgetWebConnection(session: Session): void { connections.delete(session); }
