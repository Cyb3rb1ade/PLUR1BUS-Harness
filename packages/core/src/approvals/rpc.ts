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
import { createHash } from "node:crypto";
import { buildGrantMethods } from "../grants/rpc.ts";
import { surfaceMayDecide, type GrantScope } from "../policy/index.ts";
import { RpcError } from "../rpc/errors.ts";
import type { Handler } from "../rpc/server.ts";
import { grantRecordOf, page, approvalRecordOf } from "./wire.ts";
import { guarded, type ApprovalMethodDeps, type Caller, type PermissionHandles } from "./rpc-common.ts";
import type { ApprovalView } from "./service.ts";

export type { ApprovalMethodDeps, PermissionHandles } from "./rpc-common.ts";

export const APPROVAL_METHODS = [
  "grant.list", "grant.create", "grant.revoke", "approval.list", "approval.get", "approval.verify", "approval.decide", "approval.cancel",
] as const;
export type ApprovalMethodName = (typeof APPROVAL_METHODS)[number];

const notFound = (id: string): RpcError => new RpcError("E_NOT_FOUND", `no approval request ${String(id).slice(0, 64)}`);

const SCOPE_WORDS: Record<GrantScope, string> = {
  once: "one time only", task: "for this task", session: "for this session", always: "until revoked (at most 90 days unused)",
};
const printable = (v: string): string => v.replace(/[^\x20-\x7e]/g, "?").slice(0, 64);

/** What one OS confirmation covers: the concrete approval (request, action, capability, scope and so duration, agent, person). Nothing else. */
function attestationHash(v: ApprovalView, scope: GrantScope): string {
  return createHash("sha256").update(JSON.stringify(["plur1bus.attest/1", v.id, v.actionHash, v.capability, scope, v.delegable, v.subject.kind, v.subject.id, v.principal])).digest("hex");
}

export function buildApprovalMethods(d: ApprovalMethodDeps): Record<ApprovalMethodName, Handler> {
  const guard = guarded(d);
  // One dialog per request at a time: a second decision of the same request must not queue another OS prompt.
  const asking = new Set<string>();
  const unavailable = (): RpcError => new RpcError("E_NOT_AVAILABLE", "no OS confirmation is available here; this connection can decide low-risk requests only", { reason: "attestation-unavailable" });

  /** Issue #192: does this decision need, and may it get, one OS confirmation? `attested` is the surface-2 lift for exactly this call. */
  async function liftWithAttestation(p: ApprovalDecideParams, c: Caller, h: PermissionHandles): Promise<{ attestedVia: string } | undefined> {
    if (p.decision !== "approve" || p.nonce !== undefined || c.surface !== 1) return undefined; // a relayed (nonce) decision never opens a host dialog
    const view = h.service.get(p.id, c.person);
    if (!view || view.status !== "pending" || view.risk === undefined || view.flags === undefined) return undefined;
    const scope: GrantScope = p.scope ?? "once";
    const req = { capability: view.capability, risk: view.risk as never, flags: view.flags as never };
    if (surfaceMayDecide(req, 1, scope) || !surfaceMayDecide(req, 2, scope)) return undefined; // T1 suffices, or even T2 would not (T3 needs the embedder's attestation)
    const attester = d.attester;
    if (!attester) return undefined; // no attestation wired in at all (an embedder that never asked for it): the D109 refusal stands unchanged
    if (asking.has(p.id)) throw new RpcError("E_CONFLICT", "another decision of this request is waiting for its OS confirmation", { reason: "attestation-in-progress" });
    if (p.attest !== true) {
      const probe = await attester.probe();
      if (!probe.available) throw unavailable();
      throw new RpcError("E_APPROVAL_REQUIRED", `this decision needs one confirmation by the operating system (${probe.method})`, { reason: "attestation-required", detail: probe.method });
    }
    asking.add(p.id);
    try {
      const r = await attester.attest({
        actionHash: attestationHash(view, scope), person: c.person, requestId: view.id, agentId: view.subject.id, scope,
        text: `Allow agent "${printable(view.subject.id)}" to use ${printable(view.capability)} ${SCOPE_WORDS[scope]}`,
      });
      if (!r.ok) {
        if (r.reason === "unavailable") throw unavailable();
        throw new RpcError("E_DENIED", `the OS confirmation did not happen: ${r.reason}`, { reason: "attestation-failed", detail: r.reason });
      }
      return { attestedVia: `attested:${r.method}` };
    } finally { asking.delete(p.id); }
  }

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
      const lift = await liftWithAttestation(p, c, h);
      const input = {
        requestId: p.id, decision: p.decision, person: c.person, surface: lift ? (2 as const) : c.surface,
        ...(p.scope !== undefined ? { scope: p.scope } : {}), ...(p.delegable === true ? { delegable: true } : {}),
        ...(lift ? { attestedVia: lift.attestedVia } : {}),
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
