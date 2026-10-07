// D109 §5/§6: approval.list | get | decide | cancel | verify, and (through buildGrantMethods) grant.list | create | revoke: the eight
// methods of the permission model. All of them are for a person only (the RBAC guard says so by `humanOnly`; `callerOf` says it again).
//
//  - The person, `createdBy` and the surface level of a decision come from the authenticated connection (`deps.principalOf`,
//    `deps.surfaceOf`), never from params. The nonce of a request never leaves the core: a session decides with `decideForSession`; a
//    nonce in the params is only compared (a channel relay holds one), never returned.
//  - A request of another person is invisible: E_NOT_FOUND, exactly like an unknown id.
//  - Refusals: E_DENIED reason approval-mismatch | approval-used | approval-expired | surface-untrusted | policy-never | agent-principal;
//    E_INVALID_PARAMS reason scope-unavailable | bad-cursor | ceiling-exceeded | invalid-grant; E_CONFLICT reason not-pending (cancel).
import type {
  ApprovalCancelParams, ApprovalDecideParams, ApprovalDecideResult, ApprovalGetParams, ApprovalListParams, ApprovalRecord, ApprovalVerifyResult,
} from "@plur1bus/rpc-schema";
import { buildGrantMethods } from "../grants/rpc.ts";
import { RpcError } from "../rpc/errors.ts";
import type { Handler } from "../rpc/server.ts";
import { grantRecordOf, page, approvalRecordOf } from "./wire.ts";
import { guarded, type ApprovalMethodDeps, type Caller, type PermissionHandles } from "./rpc-common.ts";

export type { ApprovalMethodDeps, PermissionHandles } from "./rpc-common.ts";

export const APPROVAL_METHODS = [
  "grant.list", "grant.create", "grant.revoke", "approval.list", "approval.get", "approval.verify", "approval.decide", "approval.cancel",
] as const;
export type ApprovalMethodName = (typeof APPROVAL_METHODS)[number];

const notFound = (id: string): RpcError => new RpcError("E_NOT_FOUND", `no approval request ${String(id).slice(0, 64)}`);

export function buildApprovalMethods(d: ApprovalMethodDeps): Record<ApprovalMethodName, Handler> {
  const guard = guarded(d);
  const record = (h: PermissionHandles, c: Caller, id: string): ApprovalRecord => {
    const v = h.service.get(id, c.person);
    if (!v) throw notFound(id);
    return approvalRecordOf(v);
  };

  return {
    ...buildGrantMethods(d),

    "approval.list": guard("approval.list", async (p: ApprovalListParams = {}, c: Caller, h) => {
      const views = h.service.list({ principal: c.person, ...(p.status !== undefined ? { status: p.status } : {}) })
        .filter((v) => p.agent === undefined || v.subject.id === p.agent);
      const out = page("a", views, { filter: { agent: p.agent, status: p.status }, ...(p.limit !== undefined ? { limit: p.limit } : {}), ...(p.cursor !== undefined ? { cursor: p.cursor } : {}) });
      return { approvals: out.items.map(approvalRecordOf), ...(out.nextCursor ? { nextCursor: out.nextCursor } : {}) };
    }),

    "approval.get": guard("approval.get", async (p: ApprovalGetParams, c: Caller, h) => record(h, c, p.id)),

    "approval.decide": guard("approval.decide", async (p: ApprovalDecideParams, c: Caller, h): Promise<ApprovalDecideResult> => {
      if (!h.service.get(p.id, c.person)) throw notFound(p.id);
      const input = {
        requestId: p.id, decision: p.decision, person: c.person, surface: c.surface,
        ...(p.scope !== undefined ? { scope: p.scope } : {}), ...(p.delegable === true ? { delegable: true } : {}),
      };
      const res = p.nonce !== undefined ? h.service.decide({ ...input, nonce: p.nonce }) : h.service.decideForSession(input);
      if (!res.ok) {
        if (res.reason === "scope-unavailable") throw new RpcError("E_INVALID_PARAMS", "that scope is not available for this request", { reason: "scope-unavailable", detail: "scope" });
        throw new RpcError("E_DENIED", `the decision was refused: ${res.reason}`, { reason: res.reason });
      }
      const approval = record(h, c, p.id);
      const first = res.scope !== undefined && res.scope !== "once" ? res.grantIds[0] : undefined;
      const view = first !== undefined ? h.grants.inspect({ person: c.person }).find((v) => v.grant.id === first) : undefined;
      return { approval, grant: view ? grantRecordOf(view.grant, view.state) : null };
    }),

    "approval.cancel": guard("approval.cancel", async (p: ApprovalCancelParams, c: Caller, h) => {
      if (!h.service.get(p.id, c.person)) throw notFound(p.id);
      const res = h.service.cancel({ requestId: p.id, person: c.person });
      if (!res.ok) throw new RpcError("E_CONFLICT", "the request is no longer pending", { reason: "not-pending" });
      return record(h, c, p.id);
    }),

    "approval.verify": guard("approval.verify", async (_p: unknown, _c: Caller, h): Promise<ApprovalVerifyResult> => {
      const v = h.service.verify();
      // A broken chain is a finding. It has no trustworthy head to pin, so `head` is null then.
      return v.ok ? { ok: true, entries: v.entries, head: v.head } : { ok: false, entries: v.entries, head: null, brokenAt: v.brokenAt, reason: v.reason };
    }),
  };
}
