// `model.memory.status`: what the Memory step of the first-run wizard shows and pre-selects. The models are the ones the running
// engine was built with; whether another embedding can still be written is the store's answer (embedding-migrate/selection.ts).
import type { Handler } from "./server.ts";
import { authenticatedPrincipal } from "../rbac/guard.ts";
import { RpcError } from "./errors.ts";
import type { MemoryModelStatus } from "../embedding-migrate/selection.ts";

export function buildMemoryModelsSurface(d: { status(): MemoryModelStatus }): Record<string, Handler> {
  return {
    "model.memory.status": async (_p, ctx) => {
      const who = authenticatedPrincipal(ctx);
      if (who.kind !== "person" || !["owner", "admin"].includes(who.role)) throw new RpcError("E_DENIED", "the memory model status requires Owner/Admin");
      return d.status();
    },
  };
}
