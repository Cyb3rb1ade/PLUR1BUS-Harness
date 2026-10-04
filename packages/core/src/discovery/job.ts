// Models scan system job handler (spec §2.3; plan Task 7).
import type { SystemJobHandler, SystemJobOutcome, SystemJobSpec } from "../system-jobs/index.ts";
import type { DiscoveryService, ScanSettings } from "./service.ts";
import type { RunTrigger } from "./types.ts";
import { RpcError } from "../rpc/errors.ts";

export const MODELS_SCAN_JOB_SPEC: SystemJobSpec = {
  name: "models.scan",
  needsLlm: false,
  singleton: true,
  schedule: {
    every: 86_400_000,
    jitter: 0.1,
  },
};

export function createModelsScanJob(
  svc: DiscoveryService,
  settings: () => ScanSettings,
): SystemJobHandler {
  return {
    get spec(): SystemJobSpec {
      return {
        ...MODELS_SCAN_JOB_SPEC,
        schedule: {
          every: settings().intervalHours * 3_600_000,
          jitter: 0.1,
        },
      };
    },

    nextRunAt(): number | null {
      return svc.nextRunAt();
    },

    validateArgs(args: unknown): Record<string, unknown> {
      if (args === undefined || args === null) {
        return {};
      }
      if (typeof args !== "object" || Array.isArray(args)) {
        throw new RpcError("E_INVALID_PARAMS", "args must be an object", { detail: "args" });
      }

      const keys = Object.keys(args);
      for (const k of keys) {
        if (k !== "provider") {
          throw new RpcError("E_INVALID_PARAMS", `unknown arg: ${k}`, { detail: k });
        }
      }

      const res: Record<string, unknown> = {};
      if ("provider" in args && (args as any).provider !== undefined) {
        const p = (args as any).provider;
        if (typeof p !== "string") {
          throw new RpcError("E_INVALID_PARAMS", "provider must be a string", { detail: "provider" });
        }
        if (!svc.hasProfile(p)) {
          throw new RpcError("E_INVALID_PARAMS", `unknown provider: ${p}`, {
            reason: "unknown-provider",
            detail: "provider",
          });
        }
        res.provider = p;
      }
      return res;
    },

    async run(
      args: Record<string, unknown>,
      ctx: { runId: string; trigger: RunTrigger; signal: AbortSignal },
    ): Promise<SystemJobOutcome> {
      const provider = typeof args.provider === "string" ? args.provider : undefined;
      const results = await svc.scanAll(
        {
          trigger: ctx.trigger,
          signal: ctx.signal,
          runId: ctx.runId,
        },
        provider,
      );

      if (ctx.signal.aborted || (results.length > 0 && results.every((r) => r.error?.reason === "aborted"))) {
        return {
          outcome: "abandoned",
          reason: "aborted",
          detail: results,
        };
      }

      const anyFailed = results.some((r) => r.result.startsWith("failed:"));
      if (anyFailed) {
        return {
          outcome: "failed",
          reason: "provider_failed",
          detail: results,
        };
      }

      const allSkipped =
        results.length > 0 &&
        results.every(
          (r) => r.result === "already_running" || r.result === "disabled" || r.result === "no-scanner",
        );

      if (allSkipped) {
        const firstReason = results[0]!.result;
        const allSame = results.every((r) => r.result === firstReason);
        const reason = allSame ? firstReason : "mixed";
        const alreadyRunningResult = results.find(
          (r) => r.result === "already_running" && r.runningRunId,
        );
        return {
          outcome: "skipped",
          reason,
          ...(alreadyRunningResult?.runningRunId
            ? { runningRunId: alreadyRunningResult.runningRunId }
            : {}),
          detail: results,
        };
      }

      return {
        outcome: "completed",
        detail: results,
      };
    },
  };
}
