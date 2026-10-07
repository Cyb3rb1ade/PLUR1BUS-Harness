// B5: `audit.verify`. Read-only on the log; the RBAC guard (rule `audit.verify` -> `audit.read`) decides who may call it.
import { RpcError } from "../rpc/errors.ts";
import type { Handler } from "../rpc/server.ts";
import type { AuditChain } from "./chain.ts";

export function buildAuditMethods(d: { chain: AuditChain }): Record<string, Handler> {
  return {
    "audit.verify": async () => {
      try { return d.chain.verify(); }
      catch (e) {
        // The log directory cannot be read or the writer lock never came free: say so, never claim the chain is fine.
        throw new RpcError("E_STORAGE", "the audit chain could not be read", { reason: "audit-unreadable", detail: e instanceof Error ? e.message : String(e) });
      }
    },
  };
}
