// A memory op acts as the engine principal derived from `params.caller` (principal.ts). Without a binding to the authenticated
// person, anyone holding `use` on an agent could name another person's caller and read or change that person's user cards
// (audit rbac 2). memory.list/show are bound in breakglass-memory.ts; this wraps every other caller-taking op the same way
// session-access.ts binds session.*: the caller's v1 principal must belong to the authenticated person.
import type { CallerIdentity } from "@plur1bus/rpc-schema";
import { authenticatedPrincipal } from "../rbac/guard.ts";
import type { Principal } from "../rbac/types.ts";
import { userPrincipalHash, validIdentity } from "../principal.ts";
import { RpcError } from "./errors.ts";
import type { CallContext, Handler } from "./server.ts";

export const CALLER_BOUND_MEMORY_METHODS = ["memory.forget", "memory.correct", "memory.share", "memory.state",
  "memory.propose", "memory.proposals.list", "memory.proposals.accept", "memory.proposals.reject"] as const;

export interface MemoryCallerAccessDeps {
  methods: Record<string, Handler>;
  /** The principals (canonical, linked channel identities, and for the installation owner its OS caller) a person acts as; the composition root's `ownership`. */
  ownership: (who: Principal, params?: unknown) => string[];
  /** Resolves the principal of a call no guard has authenticated (the ops without an RPC rule). */
  resolve: (ctx: CallContext, method: string, params: unknown) => Principal | null | undefined | Promise<Principal | null | undefined>;
}

function guarded(ctx: CallContext): Principal | undefined {
  try { return authenticatedPrincipal(ctx); } catch { return undefined; }
}

export function memoryCallerAccess(d: MemoryCallerAccessDeps): Record<string, Handler> {
  const out: Record<string, Handler> = {};
  for (const method of CALLER_BOUND_MEMORY_METHODS) {
    const inner = d.methods[method]; if (!inner) continue;
    out[method] = async (p, ctx) => {
      const caller = p?.caller as CallerIdentity | undefined;
      // An invalid caller never yields a user principal (the op degrades a read and refuses a write with principal-invalid), so only a valid one is bound.
      if (caller && caller.channel === "cli" && validIdentity(caller.accountId) && validIdentity(caller.userId)) {
        const who = guarded(ctx) ?? await d.resolve(ctx, method, p);
        if (!who) throw new RpcError("E_UNAUTHORIZED", "authentication required", { reason: "no-principal" });
        if (!d.ownership(who, p).includes(userPrincipalHash(caller))) throw new RpcError("E_DENIED", "caller identity must be linked to the authenticated person", { reason: "caller-not-linked" });
      }
      return inner(p, ctx);
    };
  }
  return out;
}
