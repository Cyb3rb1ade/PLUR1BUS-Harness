// A rig for the grant.* / approval.* handlers: the real stores and service on a fake clock, the real schema validators on
// every request and every result (so a handler can never answer something the wire schema forbids).
import assert from "node:assert/strict";
import { validateParams, validateResult } from "@plur1bus/rpc-schema";
import { RpcError } from "../../src/rpc/errors.ts";
import type { CallContext, Handler } from "../../src/rpc/server.ts";
import { buildApprovalMethods, type ApprovalMethodDeps } from "../../src/approvals/rpc.ts";
import { connectionSurface, type ConnectionAttestation } from "../../src/rbac/connection-surface.ts";
import type { Principal } from "../../src/rbac/types.ts";
import { askFor, lastNonce, rig, tick, type Rig } from "./service-helpers.ts";

export const PERSON: Principal = { userId: "christian", kind: "person", role: "owner" };
export const OTHER_PERSON: Principal = { userId: "anna", kind: "person", role: "owner" };
export const AGENT_PRINCIPAL: Principal = { userId: "christian", kind: "agent", role: "owner" };

export interface RpcRig extends Rig {
  methods: Record<string, Handler>;
  /** Who the next call is made by. */
  who: Principal | null;
  attestation: ConnectionAttestation | undefined;
  grantChanged: { change: string; grant: any }[];
  call<T = any>(method: string, params?: unknown, o?: { validate?: boolean }): Promise<T>;
  /** Parks an approval request of `christian`; returns its id and nonce, and the pending answer. */
  park(o?: Parameters<typeof askFor>[0]): Promise<{ id: string; nonce: string; answer: Promise<any> }>;
}

export async function rpcRig(o: { attest?: ConnectionAttestation; unknownAgent?: string; deps?: Partial<ApprovalMethodDeps> } = {}): Promise<RpcRig> {
  const r = await rig();
  const x = { who: PERSON as Principal | null, attestation: o.attest } as { who: Principal | null; attestation: ConnectionAttestation | undefined };
  const grantChanged: RpcRig["grantChanged"] = [];
  const methods: Record<string, Handler> = buildApprovalMethods({
    permissions: async () => ({ service: r.service, grants: r.stores.grants }),
    principalOf: () => x.who,
    surfaceOf: (principal) => connectionSurface({ principal, now: r.clock.now(), attestation: x.attestation }),
    requireAgent: (id) => { if (id === (o.unknownAgent ?? "ghost")) throw new RpcError("E_AGENT_UNKNOWN", `agent not registered: ${id}`, { reason: "not-registered" }); },
    clock: () => r.clock.now(),
    notify: { grantChanged: (change, grant) => { grantChanged.push({ change, grant }); } },
    ...o.deps,
  });
  const ctx: CallContext = { requestId: "1", connectionId: "c1", signal: new AbortController().signal };
  const rr = {
    ...r, methods, grantChanged,
    get who() { return x.who; }, set who(v: Principal | null) { x.who = v; },
    get attestation() { return x.attestation; }, set attestation(v: ConnectionAttestation | undefined) { x.attestation = v; },
    async call(method: string, params: unknown = {}, opt: { validate?: boolean } = {}) {
      const h = methods[method];
      assert.ok(h, `no handler for ${method}`);
      if (opt.validate !== false) { const v = validateParams(method, params); assert.ok(v.ok, `params of ${method} violate the schema: ${JSON.stringify(v)}`); }
      const result = await h(params, ctx);
      const rv = validateResult(method, result);
      assert.ok(rv.ok, `result of ${method} violates the schema: ${JSON.stringify(rv)} ${JSON.stringify(result)}`);
      return result;
    },
    async park(ask: Parameters<typeof askFor>[0] = {}) {
      const answer = r.service.request(askFor({ actionHash: "ab".padEnd(64, "0"), ...ask }));
      await tick();
      return { ...lastNonce(r), answer };
    },
  } as unknown as RpcRig;
  return rr;
}

export async function refused(p: Promise<unknown>): Promise<{ error: string; reason?: string; detail?: string }> {
  try { await p; } catch (e) {
    assert.ok(e instanceof RpcError, `expected an RpcError, got ${String(e)}`);
    return { error: e.error, ...(e.reason !== undefined ? { reason: e.reason } : {}), ...(e.detail !== undefined ? { detail: e.detail } : {}) };
  }
  assert.fail("expected the call to be refused");
}
