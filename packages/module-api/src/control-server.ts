import type { HarnessLogger } from "./logger.ts";
import { silentLogger } from "./logger.ts";
import { createRpcServer } from "./rpc-server.ts";

export interface ControlServerOptions {
  address: string; token: string;
  /** `module.auth`'s result. */
  hello: () => object;
  /** The module-served methods (`x-server: "module"`) other than `module.auth`; params arrive validated. */
  handlers: Record<string, (p: any, ctx: { connectionId: string }) => Promise<unknown>>;
  onConnectionClosed?: (id: string) => void;
  /** An unauthenticated connection is closed after this long (default 30 s). */
  authIdleMs?: number;
  logger?: HarnessLogger;
}
export interface ControlServer { listen(): Promise<void>; close(): Promise<void> }

/** A module process's control endpoint (B9): the shared RPC server with the `module` role — the `module.auth`
 *  handshake against the module's token, params and result validation, and the module-served methods only. On
 *  Windows the pipe keeps Node's default DACL, as the core's does (ruling C2). */
export function createControlServer(o: ControlServerOptions): ControlServer {
  const server = createRpcServer({
    server: "module", address: o.address, token: o.token, hello: o.hello, logger: o.logger ?? silentLogger(),
    methods: Object.fromEntries(Object.entries(o.handlers).map(([m, h]) => [m, (p: unknown, ctx: { connectionId: string }) => h(p, { connectionId: ctx.connectionId })])),
    ...(o.authIdleMs !== undefined ? { authIdleMs: o.authIdleMs } : {}),
    ...(o.onConnectionClosed ? { onConnectionClosed: o.onConnectionClosed } : {}),
  });
  return { listen: () => server.listen(), close: () => server.close({ graceMs: 1000 }) };
}
