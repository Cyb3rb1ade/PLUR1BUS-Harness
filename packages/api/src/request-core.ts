import { AsyncLocalStorage } from "node:async_hooks";
import type { ApiPrincipal, ApiTransport } from "@plur1bus/module-api";
import type { CoreRpc } from "./core-rpc.ts";

/** REST handlers also delegate: asynchronous requests never share mutable identity state. */
export function requestCore(core: CoreRpc) {
  const current = new AsyncLocalStorage<{ principal: ApiPrincipal; connectionKey?: string; transport?: ApiTransport }>();
  return {
    core: { async call<T>(method: string, params: object = {}) {
      const identity = current.getStore();
      const principal = identity?.principal;
      if (!principal || !core.callAs) throw new Error("API principal required");
      return core.callAs<T>(method, params, principal, "core", identity?.connectionKey, identity?.transport);
    }, ...(core.callAs ? { async callAs<T>(method: string, params: object, principal: ApiPrincipal, endpoint: "core" | "supervisor", connectionKey?: string) {
      return core.callAs!<T>(method, params, principal, endpoint, connectionKey, endpoint === "core" ? current.getStore()?.transport : undefined);
    } } : {}) } satisfies CoreRpc,
    run<T>(principal: ApiPrincipal, call: () => T, connectionKey?: string, transport?: ApiTransport): T { return current.run({ principal, ...(connectionKey ? { connectionKey } : {}), ...(transport ? { transport } : {}) }, call); },
  };
}
