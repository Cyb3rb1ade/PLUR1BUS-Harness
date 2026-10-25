// `model.memory.status`: what the Memory step of the first-run wizard shows and pre-selects. The models are the ones the running
// engine was built with; whether another embedding can still be written is the store's answer (embedding-migrate/selection.ts).
// `admin.embedding.check`: what one `plur1bus config set` does to that embedding before it is written (the CLI moves a store with
// data through the re-embedding migration instead); like every admin.* method it is CLI-only (RBAC, never WebMCP).
import type { AdminEmbeddingCheckParams, AdminEmbeddingCheckResult } from "@plur1bus/rpc-schema";
import type { Handler } from "./server.ts";
import { authenticatedPrincipal } from "../rbac/guard.ts";
import { RpcError } from "./errors.ts";
import type { EmbeddingChange, MemoryModelStatus } from "../embedding-migrate/selection.ts";

export function buildMemoryModelsSurface(d: {
  status(): MemoryModelStatus;
  check(changes: AdminEmbeddingCheckParams["changes"]): EmbeddingChange;
  /** Whether the engine can validate a re-embedded generation, so that a migration reaches its switch. */
  canSwitch(): boolean;
}): Record<string, Handler> {
  return {
    "admin.embedding.check": async (p: AdminEmbeddingCheckParams): Promise<AdminEmbeddingCheckResult> => ({ ...d.check(p.changes), canSwitch: d.canSwitch() }),
    "model.memory.status": async (_p, ctx) => {
      const who = authenticatedPrincipal(ctx);
      if (who.kind !== "person" || !["owner", "admin"].includes(who.role)) throw new RpcError("E_DENIED", "the memory model status requires Owner/Admin");
      return d.status();
    },
  };
}
