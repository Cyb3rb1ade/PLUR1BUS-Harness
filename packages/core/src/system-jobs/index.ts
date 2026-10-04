// System jobs registry and lifecycle (spec §2.3; plan Task 7).
import { randomUUID } from "node:crypto";
import type { Clock } from "../discovery/ports.ts";
import type { RunTrigger } from "../discovery/types.ts";
import { RpcError } from "../rpc/errors.ts";
import { SystemJobsLedger } from "./ledger.ts";

export interface SystemJobSpec {
  name: string;
  needsLlm: false;
  singleton: true;
  schedule: { every: number; jitter: number };
}

export interface SystemJobOutcome {
  outcome: "completed" | "skipped" | "failed" | "abandoned" | "incomplete";
  reason?: string;
  runningRunId?: string;
  detail: unknown;
}

export interface SystemJobHandler {
  readonly spec: SystemJobSpec;
  nextRunAt(): number | null;
  validateArgs(args: unknown): Record<string, unknown>; // throws RpcError E_INVALID_PARAMS
  run(
    args: Record<string, unknown>,
    ctx: { runId: string; trigger: RunTrigger; signal: AbortSignal },
  ): Promise<SystemJobOutcome>;
}

export interface SystemRunRecord {
  runId: string;
  job: string;
  kind: "system";
  trigger: RunTrigger;
  startedAt: number;
  finishedAt: number;
  durationMs: number;
  outcome: "completed" | "skipped" | "incomplete" | "failed" | "abandoned";
  reason?: string;
  runningRunId?: string;
  attempt: 1;
  args?: Record<string, unknown>;
}

export interface SystemJobEntry {
  name: string;
  kind: "system";
  needsLlm: false;
  singleton: true;
  schedule: { every: number; jitter: number };
  nextRunAt: number | null;
}

export interface SystemJobs {
  register(h: SystemJobHandler): void;
  has(name: string): boolean;
  list(): SystemJobEntry[];
  run(
    name: string,
    args: unknown,
    o: { trigger: RunTrigger; signal?: AbortSignal },
  ): Promise<{ record: SystemRunRecord; detail: unknown }>;
  history(q: { job?: string; since?: number; limit?: number }): SystemRunRecord[];
}

export interface CreateSystemJobsOptions {
  ledgerPath: string;
  clock: Clock;
  securePath: (p: string) => unknown;
  logger: { warn(m: string, f?: object): void };
  engineHasJob: (name: string) => boolean;
}

export function createSystemJobs(options: CreateSystemJobsOptions): SystemJobs {
  const handlers = new Map<string, SystemJobHandler>();
  const inFlight = new Set<string>();
  const ledger = new SystemJobsLedger({
    ledgerPath: options.ledgerPath,
    securePath: options.securePath,
    logger: options.logger,
  });

  function register(h: SystemJobHandler): void {
    if (options.engineHasJob?.(h.spec.name)) {
      throw new Error(`job name conflict: engine already has job ${h.spec.name}`);
    }
    if (handlers.has(h.spec.name)) {
      throw new Error(`system job already registered: ${h.spec.name}`);
    }
    handlers.set(h.spec.name, h);
  }

  function has(name: string): boolean {
    return handlers.has(name);
  }

  function list(): SystemJobEntry[] {
    return Array.from(handlers.values()).map((h) => ({
      name: h.spec.name,
      kind: "system",
      needsLlm: false,
      singleton: true,
      schedule: { ...h.spec.schedule },
      nextRunAt: h.nextRunAt(),
    }));
  }

  async function run(
    name: string,
    rawArgs: unknown,
    o: { trigger: RunTrigger; signal?: AbortSignal },
  ): Promise<{ record: SystemRunRecord; detail: unknown }> {
    const handler = handlers.get(name);
    if (!handler) {
      throw new RpcError("E_INVALID_PARAMS", `unknown system job ${name}`, { detail: "job" });
    }

    const validatedArgs = handler.validateArgs(rawArgs);
    const runId = randomUUID();
    const startedAt = options.clock.now();
    const argsToStore = Object.keys(validatedArgs).length > 0 ? validatedArgs : undefined;

    ledger.begin({
      runId,
      job: name,
      trigger: o.trigger,
      startedAt,
      ...(argsToStore !== undefined ? { args: argsToStore } : {}),
    });

    inFlight.add(runId);
    try {
      const outcome = await handler.run(validatedArgs, {
        runId,
        trigger: o.trigger,
        signal: o.signal ?? new AbortController().signal,
      });

      const finishedAt = options.clock.now();
      const durationMs = Math.max(0, finishedAt - startedAt);

      const record: SystemRunRecord = {
        runId,
        job: name,
        kind: "system",
        trigger: o.trigger,
        startedAt,
        finishedAt,
        durationMs,
        outcome: outcome.outcome,
        attempt: 1,
        ...(outcome.reason !== undefined ? { reason: outcome.reason } : {}),
        ...(outcome.runningRunId !== undefined ? { runningRunId: outcome.runningRunId } : {}),
        ...(argsToStore !== undefined ? { args: argsToStore } : {}),
      };

      ledger.finish(record);
      return { record, detail: outcome.detail };
    } catch (err) {
      const finishedAt = options.clock.now();
      const durationMs = Math.max(0, finishedAt - startedAt);

      const failedRecord: SystemRunRecord = {
        runId,
        job: name,
        kind: "system",
        trigger: o.trigger,
        startedAt,
        finishedAt,
        durationMs,
        outcome: "failed",
        reason: "exception",
        attempt: 1,
        ...(argsToStore !== undefined ? { args: argsToStore } : {}),
      };

      ledger.finish(failedRecord);
      throw err;
    } finally {
      inFlight.delete(runId);
    }
  }

  function history(q: { job?: string; since?: number; limit?: number }): SystemRunRecord[] {
    let runs = ledger.readAll(inFlight);
    runs.reverse();
    if (q.job) {
      runs = runs.filter((r) => r.job === q.job);
    }
    if (q.since !== undefined) {
      runs = runs.filter((r) => r.finishedAt >= q.since!);
    }
    if (q.limit !== undefined && q.limit >= 0) {
      runs = runs.slice(0, q.limit);
    }
    return runs;
  }

  return {
    register,
    has,
    list,
    run,
    history,
  };
}
