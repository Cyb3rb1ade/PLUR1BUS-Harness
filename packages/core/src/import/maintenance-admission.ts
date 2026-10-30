/** A restarted Core remains a read-only host until the same authenticated maintenance job releases it. */
import { RpcError } from "../rpc/errors.ts";
import type { Handler } from "../rpc/server.ts";

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$(?![\s\S])/;
const READS = new Set(["core.status", "core.capabilities", "events.subscribe", "agent.list", "config.get",
  "models.list", "models.status", "jobs.status", "jobs.history", "version", "user.list", "device.list",
  "admin.api.person.resolve", "admin.api.invite.validate", "admin.api.desktop.resolve"]);
const PRIVATE = new Set(["admin.import.runtime.complete", "admin.import.runtime.status", "admin.import.runtime.release"]);

export function createImportMaintenanceHold(runId: string | undefined) {
  if (runId !== undefined && !UUID.test(runId)) throw new Error("Import maintenance run is invalid");
  let held = runId !== undefined;
  let deferred: (() => Promise<void>) | undefined;
  const listeners = new Set<() => void | Promise<void>>();
  return {
    get runId() { return held ? runId : undefined; },
    get held() { return held; },
    onRelease(start: () => void | Promise<void>): () => void {
      if (!held) throw new Error("Import maintenance is not held");
      listeners.add(start);
      return () => { listeners.delete(start); };
    },
    defer(start: () => Promise<void>): boolean {
      if (!held) return false;
      if (deferred) throw new Error("Import maintenance routing is already deferred");
      deferred = start;
      return true;
    },
    async release(expectedRunId: string): Promise<void> {
      if (expectedRunId !== runId) throw new RpcError("E_DENIED", "Import maintenance job changed", { reason: "import-job-changed" });
      if (!held) return;
      const start = deferred;
      // Open public admission only after all deferred background startup is admitted successfully.
      for (const listener of listeners) {
        await listener();
        listeners.delete(listener);
      }
      if (start) await start();
      held = false;
      deferred = undefined;
    },
    methods(methods: Record<string, Handler>): Record<string, Handler> {
      return Object.fromEntries(Object.entries(methods).map(([method, inner]) => [method, async (params, ctx) => {
        // Semantic reads (including recall and transcript access) can reinforce or lazily create state.
        if (held && !READS.has(method) && !PRIVATE.has(method)) {
          throw new RpcError("E_CONFLICT", "Import maintenance is in progress", { reason: "busy" });
        }
        return inner(params, ctx);
      }]));
    },
  };
}
