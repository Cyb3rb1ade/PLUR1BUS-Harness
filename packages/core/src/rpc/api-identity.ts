import { apiPrincipal, type ApiPrincipal } from "@plur1bus/module-api";
import type { Principal } from "../rbac/types.ts";
import type { CallContext } from "./server.ts";

/** API connections never fall back to LOCAL_OWNER. Current stored roles/rights win over forwarded claims. */
export function apiIdentities(resolve: (p: ApiPrincipal) => Principal | null) {
  const connections = new Map<string, ApiPrincipal | null>();
  return {
    forwarded(principal: ApiPrincipal): ApiPrincipal | null { const p = resolve(principal); return p ? { ...p, kind: principal.kind } : null; },
    authenticated(id: string, principal: ApiPrincipal | null) { connections.set(id, principal); },
    services(): string[] { return [...connections].filter(([, p]) => p === null).map(([id]) => id); },
    closed(id: string) { connections.delete(id); },
    resolve(ctx: CallContext): Principal | null | undefined {
      const forwarded = apiPrincipal(ctx);
      // Explicitly absent API identity must not fall back to a connection snapshot or the local owner.
      const p = forwarded === undefined ? connections.get(ctx.connectionId) : forwarded;
      if (p === undefined) return undefined;
      return p === null ? null : resolve(p);
    },
  };
}
