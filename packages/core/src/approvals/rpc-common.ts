// What the grant.* and approval.* handlers share: who is calling (a person, established by the core), at which surface level, and the
// stores behind it. Every handler starts with `callerOf`, before any store is touched: an agent never causes the stores to open.
import type { GrantRecord } from "@plur1bus/rpc-schema";
import type { Attester } from "../attestation/index.ts";
import type { GrantStore } from "../grants/store.ts";
import type { PrincipalResolver } from "../rbac/guard.ts";
import type { SurfaceTrustLevel } from "../rbac/surface.ts";
import type { Principal } from "../rbac/types.ts";
import { RpcError } from "../rpc/errors.ts";
import type { CallContext, Handler } from "../rpc/server.ts";
import { SecretError } from "../secrets/types.ts";
import { toRpcError } from "../secrets/rpc.ts";
import { ApprovalChainError } from "./chain.ts";
import type { ApprovalService } from "./service.ts";

export interface PermissionHandles { service: ApprovalService; grants: GrantStore }

export interface ApprovalMethodDeps {
  /** The stores and the service. Opened on first use (not at core start); a failure to open is the handler's E_STORAGE / E_NOT_AVAILABLE. */
  permissions: () => Promise<PermissionHandles>;
  /** The same resolver the RBAC guard uses: who this connection is. Re-checked here, so a handler registered without the guard is still human-only. */
  principalOf: PrincipalResolver;
  /** The surface level of this connection for this principal, derived by the core (see rbac/connection-surface.ts). Never from params. */
  surfaceOf: (principal: Principal, ctx: CallContext) => SurfaceTrustLevel;
  /** Throws E_AGENT_UNKNOWN for an agent the core does not know. */
  requireAgent: (agentId: string) => void;
  clock: () => number;
  /** Issue #192: asks the OS for one confirmation that lifts a single approval of an unattested local connection (T1) to T2. Absent: nothing can be lifted. */
  attester?: Attester;
  /** `grant.changed` for grants this file creates or revokes (the service announces the ones a decision creates). */
  notify?: { grantChanged(change: "created" | "revoked", grant: GrantRecord): void };
}

export interface Caller { principal: Principal; person: string; surface: SurfaceTrustLevel }

/** A person, or an RpcError. An agent principal, a principal without `kind: "person"` and a missing person id are E_DENIED `agent-principal`. */
export async function callerOf(d: ApprovalMethodDeps, method: string, params: unknown, ctx: CallContext): Promise<Caller> {
  let principal: Principal | null | undefined;
  try { principal = await d.principalOf(ctx, method, params); }
  catch { throw new RpcError("E_UNAUTHORIZED", "authentication required", { reason: "resolver-failed" }); }
  if (principal === null || principal === undefined) throw new RpcError("E_UNAUTHORIZED", "authentication required", { reason: "no-principal" });
  if (typeof principal !== "object" || principal.kind !== "person" || typeof principal.userId !== "string" || principal.userId === "") {
    throw new RpcError("E_DENIED", `${method} is for a person; an agent can never call it`, { reason: "agent-principal" });
  }
  return { principal, person: principal.userId, surface: d.surfaceOf(principal, ctx) };
}

function mapFailure(e: unknown): unknown {
  if (e instanceof RpcError) return e;
  if (e instanceof SecretError) return toRpcError(e);
  if (e instanceof ApprovalChainError) return new RpcError("E_STORAGE", "the approval store failed its integrity check", { reason: "approval-chain-broken" });
  return e;
}

export function guarded(d: ApprovalMethodDeps) {
  return (method: string, fn: (params: any, caller: Caller, handles: PermissionHandles, ctx: CallContext) => Promise<unknown>): Handler =>
    async (params, ctx) => {
      try {
        const caller = await callerOf(d, method, params, ctx);
        let handles: PermissionHandles;
        try { handles = await d.permissions(); }
        catch (e) {
          const m = mapFailure(e);
          throw m !== e ? m : new RpcError("E_STORAGE", "the permission store could not be opened", { reason: "permission-store-unavailable" });
        }
        return await fn(params ?? {}, caller, handles, ctx);
      } catch (e) { throw mapFailure(e); }
    };
}
