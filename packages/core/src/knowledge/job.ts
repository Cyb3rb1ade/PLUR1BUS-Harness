// A2: the harness schedules a model-free system job; only the Engine owns promotion.
import { RpcError } from "../rpc/errors.ts";
import type { SystemJobHandler, SystemJobOutcome } from "../system-jobs/index.ts";

export const KNOWLEDGE_RETRY_BACKOFF_MS = 30_000;
export const KNOWLEDGE_UPDATE_INTERVAL_MS = 15 * 60_000;
export interface KnowledgeJobEngine {
  jobs: {
    list(): { name: string }[];
    run(job: string, agentId: string, options: { trigger: "manual" | "cron" | "harness"; signal: AbortSignal }): Promise<{ runId?: string; outcome: string; reason?: string }>;
  };
}
export interface KnowledgeJobDeps { engine: KnowledgeJobEngine; agents(): string[]; now(): number }

/** Compatibility boundary: Engine 1.17.0 is required for knowledge-update; older pins report an explicit skip. */
export function createKnowledgeUpdateJob(deps: KnowledgeJobDeps): SystemJobHandler {
  let next = deps.now();
  let running = false;
  return {
    spec: { name: "knowledge.update", needsLlm: false, singleton: true, schedule: { every: KNOWLEDGE_UPDATE_INTERVAL_MS, jitter: 0 } },
    nextRunAt: () => next,
    validateArgs(raw): Record<string, unknown> {
      if (raw === null || raw === undefined) return {};
      if (typeof raw !== "object" || Array.isArray(raw)) throw new RpcError("E_INVALID_PARAMS", "args must be an object");
      if (Object.keys(raw).some(key => key !== "agentId")) throw new RpcError("E_INVALID_PARAMS", "unknown knowledge.update argument");
      const id = (raw as { agentId?: unknown }).agentId;
      if (id !== undefined && (typeof id !== "string" || !deps.agents().includes(id))) throw new RpcError("E_INVALID_PARAMS", "unknown agent");
      return id === undefined ? {} : { agentId: id };
    },
    async run(args, context): Promise<SystemJobOutcome> {
      if (context.signal.aborted) return { outcome: "abandoned", reason: "aborted", detail: null };
      if (running) return { outcome: "skipped", reason: "already-running", detail: null };
      next = deps.now() + KNOWLEDGE_UPDATE_INTERVAL_MS;
      if (!deps.engine.jobs.list().some(job => job.name === "knowledge-update")) return { outcome: "skipped", reason: "engine-contract-unavailable", detail: { requiredContract: "1.17.0" } };
      running = true;
      const results: { agentId: string; runId?: string; outcome: string; reason?: string }[] = [];
      try {
        const ids = typeof args.agentId === "string" ? [args.agentId] : deps.agents();
        for (const agentId of ids) {
          if (context.signal.aborted) return { outcome: "abandoned", reason: "aborted", detail: results };
          // Recheck registration immediately before dispatch, including manual args.
          if (!deps.agents().includes(agentId)) continue;
          const run = await deps.engine.jobs.run("knowledge-update", agentId, { trigger: context.trigger, signal: context.signal });
          if (!["completed", "skipped", "failed", "incomplete", "abandoned"].includes(run.outcome)) {
            return { outcome: "failed", reason: "engine-job-invalid-result", detail: results };
          }
          results.push({ agentId, ...(run.runId ? { runId: run.runId } : {}), outcome: run.outcome, ...(run.reason ? { reason: run.reason } : {}) });
        }
        if (context.signal.aborted) return { outcome: "abandoned", reason: "aborted", detail: results };
        const failed = results.some(run => ["failed", "incomplete", "abandoned"].includes(run.outcome));
        return { outcome: failed ? "failed" : "completed", ...(failed ? { reason: "engine-job-failed" } : {}), detail: results };
      } finally { running = false; }
    },
  };
}

export interface KnowledgeTimers { now(): number; setTimer(fn: () => void | Promise<void>, ms: number): { cancel(): void } }
/** Run through the system registry, including its ledger; stop timers and in-flight dispatch on core shutdown. */
export function armKnowledgeUpdate(
  jobs: { list(): { name: string; nextRunAt: number | null }[]; run(name: string, args: unknown, options: { trigger: "cron"; signal: AbortSignal }): Promise<unknown> },
  timers: KnowledgeTimers, signal: AbortSignal, logger: { warn(message: string, fields?: object): void },
): void {
  let timer: { cancel(): void } | undefined;
  const schedule = (minimumDelay = 0): void => {
    if (signal.aborted) return;
    const next = jobs.list().find(job => job.name === "knowledge.update")?.nextRunAt;
    if (next === undefined || next === null) return;
    timer = timers.setTimer(async () => {
      if (signal.aborted) return;
      let retry = false;
      try { await jobs.run("knowledge.update", {}, { trigger: "cron", signal }); }
      catch { retry = true; logger.warn("knowledge.update system job failed"); }
      schedule(retry ? KNOWLEDGE_RETRY_BACKOFF_MS : 0);
    }, Math.max(minimumDelay, next - timers.now()));
  };
  signal.addEventListener("abort", () => timer?.cancel(), { once: true });
  schedule();
}
