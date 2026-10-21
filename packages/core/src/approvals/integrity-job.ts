// D109 §9.7: start + daily HMAC/Ed25519 integrity check of the approval chain.
import type { Clock } from "../policy/decide.ts";
import { RpcError } from "../rpc/errors.ts";
import type { SystemJobHandler, SystemJobOutcome, SystemJobSpec, SystemJobs } from "../system-jobs/index.ts";
import type { VerifyResult } from "./chain.ts";

export const APPROVALS_INTEGRITY_JOB_SPEC: SystemJobSpec = {
  name: "approvals.integrity",
  needsLlm: false,
  singleton: true,
  schedule: { every: 86_400_000, jitter: 0.1 },
  exclusive: true, // the start run, the daily timer and a manual jobs.run must not verify the chain at the same time
};

export interface ApprovalsIntegrityJobDeps {
  verify: () => VerifyResult | Promise<VerifyResult>;
  /** When false, nothing to check (the store has never been opened). */
  present?: () => boolean | Promise<boolean>;
  clock: Clock;
  /** [0, 1); used to jitter `nextRunAt` the same way discovery jitters regular scans. */
  rng?: () => number;
  /** After a successful verify: announce due grants / always-grant inbox sweep. Never fails the job. */
  onOk?: () => void;
  /**
   * The host skipped the start run (no store yet, nothing to verify): the first scheduled run is a day away instead of
   * due now, so an absent store leaves no ledger row at start.
   */
  deferFirstRun?: boolean;
}

export function createApprovalsIntegrityJob(deps: ApprovalsIntegrityJobDeps): SystemJobHandler {
  let lastRunAt: number | null = deps.deferFirstRun ? deps.clock.now() : null;
  const rng = deps.rng ?? Math.random;
  return {
    get spec(): SystemJobSpec {
      return APPROVALS_INTEGRITY_JOB_SPEC;
    },
    nextRunAt(): number | null {
      if (lastRunAt === null) return deps.clock.now();
      const every = APPROVALS_INTEGRITY_JOB_SPEC.schedule.every;
      const jitter = APPROVALS_INTEGRITY_JOB_SPEC.schedule.jitter;
      return lastRunAt + every * (1 + (rng() * 2 - 1) * jitter);
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
      try { deps.onOk?.(); } catch { /* a sweep never fails the integrity job */ }
      return { outcome: "completed", detail: v };
    },
  };
}

export interface IntegrityArmTimers {
  now(): number;
  setTimer(fn: () => void | Promise<void>, ms: number): unknown;
}

/** Arms a timer for the job's nextRunAt, runs it as cron, then re-arms. Tests drive this with FakeClock.setTimer. */
export function armApprovalsIntegrity(
  jobs: Pick<SystemJobs, "run" | "list">,
  timers: IntegrityArmTimers,
): { cancel: () => void } {
  let cancelled = false;
  const schedule = (): void => {
    if (cancelled) return;
    const next = jobs.list().find((j) => j.name === "approvals.integrity")?.nextRunAt;
    const delay = Math.max(0, (next ?? timers.now()) - timers.now());
    timers.setTimer(async () => {
      if (cancelled) return;
      try { await jobs.run("approvals.integrity", {}, { trigger: "cron" }); } catch { /* re-arm anyway */ }
      schedule();
    }, delay);
  };
  schedule();
  return { cancel: () => { cancelled = true; } };
}
