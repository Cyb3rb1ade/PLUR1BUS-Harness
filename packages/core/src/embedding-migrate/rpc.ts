// `admin.reembed.plan|run|status|abort` over the migration driver (rpc.schema.json). `run` returns at once and the
// migration continues in the background; `status` follows it. Like every `admin.*` method these are never offered over
// WebMCP (packages/webmcp FORBIDDEN_PREFIX) and are drained at stop.
import type { AdminReembedPlanParams, AdminReembedRunParams } from "@plur1bus/rpc-schema";
import type { HarnessLogger } from "../logger.ts";
import { RpcError } from "../rpc/errors.ts";
import type { Handler } from "../rpc/server.ts";
import { MigrationError, type MigrationDriver } from "./driver.ts";
import { targetFromModel } from "./target.ts";

export const REEMBED_METHODS = ["admin.reembed.plan", "admin.reembed.run", "admin.reembed.status", "admin.reembed.abort"] as const;
export type ReembedMethod = (typeof REEMBED_METHODS)[number];

export interface ReembedRpcDeps { driver: MigrationDriver; isStopping: () => boolean; logger: Pick<HarnessLogger, "debug" | "info" | "warn"> }

/** The wire error for a driver failure; the reason is the driver's stable code. */
export function mapMigrationError(e: unknown): RpcError | null {
  if (!(e instanceof MigrationError)) return null;
  const error = ({
    "migration-active": "E_CONFLICT", "migration-running": "E_CONFLICT", "not-runnable": "E_CONFLICT", "not-abortable": "E_CONFLICT", "not-ready-to-switch": "E_CONFLICT",
    "no-migration": "E_NOT_FOUND", "plan-refused": "E_INVALID_PARAMS", "switch-unavailable": "E_NOT_AVAILABLE", "switch-failed": "E_STORAGE",
    "state-corrupt": "E_STORAGE", "state-unreadable": "E_STORAGE",
  } as const)[e.code];
  return new RpcError(error, e.message, { reason: e.code });
}

export function buildReembedMethods(d: ReembedRpcDeps): Record<ReembedMethod, Handler> {
  function op<P, R>(method: ReembedMethod, fn: (p: P) => Promise<R>): Handler {
    return async (p: P) => {
      if (d.isStopping()) throw new RpcError("E_CORE_UNAVAILABLE", "core is stopping", { reason: "core-stopping" });
      try { return await fn(p); } catch (e) {
        const mapped = mapMigrationError(e);
        if (!mapped) throw e; // the server answers E_INTERNAL handler-threw
        d.logger.debug("re-embedding op refused", { method, error: mapped.error, reason: mapped.reason });
        throw mapped;
      }
    };
  }
  return {
    "admin.reembed.plan": op("admin.reembed.plan", async (p: AdminReembedPlanParams) => {
      const t = targetFromModel({ model: p.model, ...(p.dimensions !== undefined ? { dimensions: p.dimensions } : {}), ...(p.queryPrefix !== undefined ? { queryPrefix: p.queryPrefix } : {}), ...(p.passagePrefix !== undefined ? { passagePrefix: p.passagePrefix } : {}) });
      if (!t.ok) return { probe: t.probe, plan: null };
      return d.driver.plan({ target: t.fingerprint, ...(p.throttleMs !== undefined ? { throttleMs: p.throttleMs } : {}) });
    }),

    "admin.reembed.run": op("admin.reembed.run", async (p: AdminReembedRunParams) => {
      const doSwitch = p.switch !== false;
      const cur = (await d.driver.status()).checkpoint;
      // A copied and validated generation only needs its switch.
      if (cur?.phase === "ready-to-switch") return { checkpoint: doSwitch ? await d.driver.switch() : cur };
      const { checkpoint, done } = await d.driver.start();
      d.logger.info("re-embedding run started", { id: checkpoint.id });
      void done
        .then(async (cp) => { if (cp.phase === "ready-to-switch" && doSwitch) await d.driver.switch(); })
        .catch((err) => d.logger.warn("re-embedding follow-up failed", { err })); // the checkpoint carries the reason
      return { checkpoint };
    }),

    "admin.reembed.status": op("admin.reembed.status", async () => d.driver.status()),

    "admin.reembed.abort": op("admin.reembed.abort", async () => ({ checkpoint: await d.driver.abort() })),
  };
}
