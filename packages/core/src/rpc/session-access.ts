// Existing session mutations consume the stored agent rights. A break-glass grant is read-only and cannot satisfy this gate.
import type { Handler } from "./server.ts";
import { authenticatedPrincipal } from "../rbac/guard.ts";
import { authorize } from "../rbac/authorize.ts";
import type { Principal } from "../rbac/types.ts";
import type { SessionStore } from "../session/store.ts";
import { ownerOf } from "../session/methods.ts";
import { RpcError } from "./errors.ts";
export function sessionWriteAccess(d: { methods: Record<string, Handler>; sessions: () => SessionStore | null; ownership: (a: Principal, p: unknown) => string[]; validateCaller?: boolean }): Record<string, Handler> {
  const out: Record<string, Handler>={};
  for (const method of ["session.create","session.submit","session.cancel","session.archive"]) {
    const inner=d.methods[method];if(!inner)continue;
    out[method]=async(p,ctx)=>{
      const who=authenticatedPrincipal(ctx);
      if(d.validateCaller && !d.ownership(who,p).includes(ownerOf(p.caller))) throw new RpcError("E_DENIED","caller identity must be linked to the authenticated person",{reason:"caller-not-linked"});
      let agentId=p.agentId;
      if(method!=="session.create") {
        const session=d.sessions()?.getSession(p.sessionId);
        if(!session || !d.ownership(who,p).includes(session.owner))throw new RpcError("E_NOT_FOUND","session not found");
        agentId=session.agentId;
      }
      if(authorize(who,"agent.use",{kind:"agent",agentId}).effect!=="allow")throw new RpcError("E_DENIED","agent use right required");
      return inner(p,ctx);
    };
  }
  return out;
}
