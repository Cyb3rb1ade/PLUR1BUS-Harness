// D109 §9.7: start + daily HMAC/Ed25519 integrity check of the approval chain.
import type { Clock } from "../policy/decide.ts";
import { RpcError } from "../rpc/errors.ts";
import type { SystemJobHandler, SystemJobOutcome, SystemJobSpec } from "../system-jobs/index.ts";
import type { VerifyResult } from "./chain.ts";

export const APPROVALS_INTEGRITY_JOB_SPEC: SystemJobSpec = {
  name: "approvals.integrity",
  needsLlm: false,
  singleton: true,
  schedule: { every: 86_400_000, jitter: 0.1 },
};

export interface ApprovalsIntegrityJobDeps {
  verify: () => VerifyResult | Promise<VerifyResult>;
  /** When false, nothing to check (the store has never been opened). */
  present?: () => boolean | Promise<boolean>;
  clock: Clock;
}

export function createApprovalsIntegrityJob(deps: ApprovalsIntegrityJobDeps): SystemJobHandler {
  let lastRunAt: number | null = null;
  return {
    get spec(): SystemJobSpec {
      return APPROVALS_INTEGRITY_JOB_SPEC;
    },
    nextRunAt(): number | null {
      return lastRunAt === null ? deps.clock.now() : lastRunAt + APPROVALS_INTEGRITY_JOB_SPEC.schedule.every;
    },
    validateArgs(args: unknown): Record<string, unknown> {
      if (args === undefined || args === null) return {};
      if (typeof args !== "object" || Array.isArray(args)) {
        throw new RpcError("E_INVALID_PARAMS", "args must be an object", { detail: "args" });
      }
      if (Object.keys(args as object).length > 0) {
        throw new RpcError("E_INVALID_PARAMS", "approvals.integrity takes no args", { detail: "args" });
      }
      return {};
    },
    async run(_args, ctx): Promise<SystemJobOutcome> {
      lastRunAt = deps.clock.now();
      if (ctx.signal.aborted) return { outcome: "abandoned", reason: "aborted", detail: null };
      if (deps.present && !(await deps.present())) {
        return { outcome: "skipped", reason: "store-absent", detail: null };
      }
      const v = await deps.verify();
      if (!v.ok) return { outcome: "failed", reason: v.reason, detail: v };
      return { outcome: "completed", detail: v };
    },
  };
}
