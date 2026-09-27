// The core's RPC server is module-api's shared server with the `core` role (H3B-R12): `core.auth`, the core-served
// methods, subscriptions and the drain for G17.
import { createRpcServer as createSharedRpcServer, type RpcServer, type RpcServerOptions } from "@plur1bus/module-api";
import type { Capabilities } from "@plur1bus/rpc-schema";

export { MAX_PENDING_BYTES, type CallContext, type DrainResult, type Handler, type NotifyOptions, type RpcServer, type Subscription } from "@plur1bus/module-api";

/** `core.auth`'s result. */
export interface Hello { contract: string; rpc: string; instanceId: string; pid: number; capabilities?: Capabilities }

export function createRpcServer(o: Omit<RpcServerOptions, "server" | "hello"> & { hello: () => Hello }): RpcServer {
  return createSharedRpcServer({ ...o, server: "core" });
}
