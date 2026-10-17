// The core's RPC server is module-api's shared server with the `core` role (H3B-R12): `core.auth`, the core-served
// methods, subscriptions and the drain for G17.
import { createRpcServer as createSharedRpcServer, type Handler, type RpcServer, type RpcServerOptions } from "@plur1bus/module-api";
import type { Capabilities } from "@plur1bus/rpc-schema";
import { fromRpcMeta, withTrace } from "../logs/trace.ts";

export { MAX_PENDING_BYTES, type CallContext, type DrainResult, type Handler, type NotifyOptions, type RpcServer, type Subscription } from "@plur1bus/module-api";

/** `core.auth`'s result. */
export interface Hello { contract: string; rpc: string; instanceId: string; pid: number; capabilities?: Capabilities }

/** Authenticated dispatch only: adopt a valid `params._meta.traceparent`, else start a new trace. */
function withRpcTrace(handler: Handler): Handler {
  return (params, ctx) => {
    let meta: unknown;
    let rest = params;
    if (params && typeof params === "object" && !Array.isArray(params) && Object.hasOwn(params, "_meta")) {
      const { _meta, ...keep } = params as Record<string, unknown>;
      meta = _meta;
      rest = keep;
    }
    return withTrace(fromRpcMeta(meta, true), () => handler(rest, ctx));
  };
}

export function createRpcServer(o: Omit<RpcServerOptions, "server" | "hello"> & { hello: () => Hello }): RpcServer {
  const methods = Object.fromEntries(Object.entries(o.methods).map(([name, handler]) => [name, withRpcTrace(handler)]));
  return createSharedRpcServer({ ...o, server: "core", methods });
}
