import { AsyncLocalStorage } from "node:async_hooks";
import type { ApiPrincipal, ApiTransport } from "@plur1bus/module-api";
import type { CoreRpc } from "./core-rpc.ts";

export interface RequestCoreContext {
  principal?: ApiPrincipal | undefined;
  connectionKey?: string | undefined;
  transport?: ApiTransport | undefined;
  onTurnStart?: ((turnId: string, sessionId?: string) => void) | undefined;
}

/** REST handlers also delegate: asynchronous requests never share mutable identity state. */
export function requestCore(core: CoreRpc) {
  const current = new AsyncLocalStorage<RequestCoreContext>();
  return {
    core: {
      async call<T>(method: string, params: object = {}) {
        const identity = current.getStore();
        const principal = identity?.principal;
        if (!principal || !core.callAs) throw new Error("API principal required");
        const res = await core.callAs<T>(method, params, principal, "core", identity?.connectionKey, identity?.transport);
        if (method === "external.turn.start" && res && typeof (res as any).turnId === "string") {
          identity?.onTurnStart?.((res as any).turnId, (res as any).sessionId);
        }
        return res;
      },
      ...(core.callAs
        ? {
            async callAs<T>(
              method: string,
              params: object,
              principal: ApiPrincipal,
              endpoint: "core" | "supervisor",
              connectionKey?: string,
            ) {
              const identity = current.getStore();
              const res = await core.callAs!<T>(
                method,
                params,
                principal,
                endpoint,
                connectionKey,
                endpoint === "core" ? identity?.transport : undefined,
              );
              if (method === "external.turn.start" && res && typeof (res as any).turnId === "string") {
                identity?.onTurnStart?.((res as any).turnId, (res as any).sessionId);
              }
              return res;
            },
          }
        : {}),
    } satisfies CoreRpc,
    run<T>(
      principal: ApiPrincipal | undefined,
      call: () => T,
      connectionKey?: string,
      transport?: ApiTransport,
      onTurnStart?: (turnId: string, sessionId?: string) => void,
    ): T {
      return current.run(
        {
          ...(principal ? { principal } : {}),
          ...(connectionKey ? { connectionKey } : {}),
          ...(transport ? { transport } : {}),
          ...(onTurnStart ? { onTurnStart } : {}),
        },
        call,
      );
    },
  };
}
