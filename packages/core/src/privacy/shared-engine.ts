import { engineModelEndpoints } from "../composition/embedding-policy.ts";
import { RpcError } from "../rpc/errors.ts";
import { isLocalEndpoint, localEndpoints, localOnlyAgents, localOnlyShared, LOCAL_ONLY_HINT } from "./local-only.ts";

/** Policy only: no engine internals, network probes, provider preference or vector-space replacement. */
export function sharedEnginePrivacy(cfg: unknown, runningEngine?: Record<string, unknown>) {
 const c=cfg&&typeof cfg==="object"?cfg as Record<string,unknown>:{};
 const agents=localOnlyAgents(cfg),required=localOnlyShared(cfg),listed=localEndpoints(cfg);
 const engine=c.engine&&typeof c.engine==="object"&&!Array.isArray(c.engine)?c.engine as Record<string,unknown>:{};
 const blocked=required?engineModelEndpoints(runningEngine ?? engine).filter(e=>e.endpoint===undefined||!isLocalEndpoint(e.endpoint,listed)).map(e=>e.role).sort():[];
 return {required,agents,blocked};
}
export function assertSharedEnginePrivacy(cfg: unknown, runningEngine?: Record<string, unknown>): void {
 const policy=sharedEnginePrivacy(cfg, runningEngine);if(!policy.blocked.length)return;
 const source=policy.agents.length?`agents ${policy.agents.join(", ")}`:"privacy.localOnly";
 throw new RpcError("E_DENIED",`Shared engine ${policy.blocked.join(", ")} must use local endpoints because of ${source}; ${LOCAL_ONLY_HINT}`,{reason:policy.agents.length?"local-only-shared-engine":"local-only"});
}
