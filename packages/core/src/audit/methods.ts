// `audit.verify` over RPC (rpc.schema.json): a thin, read-only projection of `AuditChain.verify`. Who may call it is
// decided by the guard (`RPC_RULES`: `audit.read`, Owner and Admin), not here.
import { RpcError } from "../rpc/errors.ts";
import type { Handler } from "../rpc/server.ts";
import type { AuditChain } from "./writer.ts";

export function buildAuditMethods(d: { chain: AuditChain }): Record<string, Handler> {
  return {
    "audit.verify": async () => {
      try { return d.chain.verify(); }
      catch {
        // the cause (a path, an errno) stays out of the reply; the core's own log has the stack
        throw new RpcError("E_STORAGE", "the audit chain could not be read", { reason: "audit-unreadable" });
      }
    },
  };
}
