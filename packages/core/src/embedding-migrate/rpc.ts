// `admin.reembed.plan|run|status|abort` over the migration driver (rpc.schema.json). `run` returns at once and the
// migration continues in the background; `status` follows it. Like every `admin.*` method these are never offered over
// WebMCP (packages/webmcp FORBIDDEN_PREFIX) and are drained at stop.
import type { AdminReembedPlanParams, AdminReembedRunParams } from "@plur1bus/rpc-schema";
import type { HarnessLogger } from "../logger.ts";
import { RpcError } from "../rpc/errors.ts";
import type { Handler } from "../rpc/server.ts";
import { MigrationError, type MigrationDriver } from "./driver.ts";
import type { PrivacyAcknowledgment } from "@plur1bus/config-schema";
import { isLocalTarget, targetFromSpec, type TargetPolicy } from "./target.ts";
import { authenticatedPrincipal } from "../rbac/guard.ts";
import type { CallContext } from "../rpc/server.ts";
import { checkEngineEgress } from "../engine-config.ts";
import type { Egress } from "../egress/service.ts";

export const REEMBED_METHODS = ["admin.reembed.plan", "admin.reembed.run", "admin.reembed.status", "admin.reembed.abort"] as const;
export type ReembedMethod = (typeof REEMBED_METHODS)[number];

export interface ReembedRpcDeps {
  driver: MigrationDriver; isStopping: () => boolean; logger: Pick<HarnessLogger, "debug" | "info" | "warn">;
  /** The live privacy rules a cloud target is checked against (memory.embedding.privacyAck, privacy.localOnly). */
  targetPolicy?: () => TargetPolicy;
  /** A cloud target's endpoint must pass the harness egress policy, like the engine start (checkEngineEgress). */
  egress?: Pick<Egress, "decide">;
  now?: () => number;
}

/** The calling person (the CLI's owner); a connection without one is the local owner, as for config.set without a principal. */
function personOf(ctx: CallContext | undefined): string {
  try { return ctx ? authenticatedPrincipal(ctx).userId : "local-owner"; } catch { return "local-owner"; }
}

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
  function op<P, R>(method: ReembedMethod, fn: (p: P, ctx?: CallContext) => Promise<R>): Handler {
    return async (p: P, ctx?: CallContext) => {
      if (d.isStopping()) throw new RpcError("E_CORE_UNAVAILABLE", "core is stopping", { reason: "core-stopping" });
      try { return await fn(p, ctx); } catch (e) {
        const mapped = mapMigrationError(e);
        if (!mapped) throw e; // the server answers E_INTERNAL handler-threw
        d.logger.debug("re-embedding op refused", { method, error: mapped.error, reason: mapped.reason });
        throw mapped;
      }
    };
  }
  return {
    "admin.reembed.plan": op("admin.reembed.plan", async (p: AdminReembedPlanParams, ctx) => {
      // Every direction (local/cloud → local/cloud); only the provider rules refuse (they throw their own RpcError).
      const policy = d.targetPolicy?.() ?? {};
      // acknowledgePrivacy: the calling person acknowledges THIS cloud target now (bound to provider and endpoint). It is
      // what makes cloud → cloud possible while memory.embedding.privacyAck still admits the current provider; the
      // switch writes it together with the new embedding block, so the configuration is never half-acknowledged.
      const ack: PrivacyAcknowledgment | undefined = p.acknowledgePrivacy === true && !isLocalTarget(p.provider)
        ? { provider: p.provider!, acknowledgedAt: new Date((d.now ?? Date.now)()).toISOString(), by: personOf(ctx), ...(p.baseUrl !== undefined ? { endpoint: p.baseUrl } : {}) }
        : undefined;
      const t = targetFromSpec({ model: p.model, ...(p.provider !== undefined ? { provider: p.provider } : {}), ...(p.baseUrl !== undefined ? { baseUrl: p.baseUrl } : {}), ...(p.apiKeyEnv !== undefined ? { apiKeyEnv: p.apiKeyEnv } : {}), ...(p.dimensions !== undefined ? { dimensions: p.dimensions } : {}), ...(p.queryPrefix !== undefined ? { queryPrefix: p.queryPrefix } : {}), ...(p.passagePrefix !== undefined ? { passagePrefix: p.passagePrefix } : {}) }, ack ? { ...policy, privacyAck: ack } : policy);
      if (!t.ok) return { probe: t.probe, plan: null };
      if (!t.local) {
        if (d.egress) await checkEngineEgress({ embedding: t.block }, d.egress, (message, fields) => d.logger.warn(message, fields));
        if (ack) d.logger.info("re-embedding target privacy acknowledged", { provider: ack.provider, by: ack.by });
        return d.driver.plan({ target: t.fingerprint, remote: { apiKeyEnv: t.apiKeyEnv, ...(typeof t.block.baseUrl === "string" ? { baseUrl: t.block.baseUrl } : {}), ...(ack ? { privacyAck: ack } : {}) }, ...(p.throttleMs !== undefined ? { throttleMs: p.throttleMs } : {}) });
      }
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
