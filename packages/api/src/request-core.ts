import { AsyncLocalStorage } from "node:async_hooks";
import type { ApiPrincipal } from "@plur1bus/module-api";
import type { CoreRpc } from "./core-rpc.ts";

/** REST handlers also delegate: asynchronous requests never share mutable identity state. */
export function requestCore(core: CoreRpc) {
  const current = new AsyncLocalStorage<{ principal: ApiPrincipal; connectionKey?: string }>();
  return {
    core: { async call<T>(method: string, params: object = {}) {
      const identity = current.getStore();
      const principal = identity?.principal;
      if (!principal || !core.callAs) throw new Error("API principal required");
      return core.callAs<T>(method, params, principal, "core", identity?.connectionKey);
    } } satisfies CoreRpc,
    run<T>(principal: ApiPrincipal, call: () => T, connectionKey?: string): T { return current.run({ principal, ...(connectionKey ? { connectionKey } : {}) }, call); },
  };
}
