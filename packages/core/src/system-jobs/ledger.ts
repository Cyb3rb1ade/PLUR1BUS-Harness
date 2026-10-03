// System jobs ledger: append-only JSONL with 0600 permissions, fsync and crash-recovery (spec §2.3; plan Task 7).
import { closeSync, existsSync, fsyncSync, openSync, readFileSync, writeSync } from "node:fs";
import { dirname } from "node:path";
import { mkdirSync } from "node:fs";
import type { RunTrigger } from "../discovery/types.ts";
import type { SystemRunRecord } from "./index.ts";

export interface LedgerDeps {
  ledgerPath: string;
  securePath: (p: string) => unknown;
  logger: { warn(m: string, f?: object): void };
}

export interface StartedEntry {
  runId: string;
  job: string;
  trigger: RunTrigger;
  startedAt: number;
  args?: Record<string, unknown>;
}

export interface FinishedEntry {
  runId: string;
  job: string;
  trigger: RunTrigger;
  startedAt: number;
  finishedAt: number;
  durationMs: number;
  outcome: "completed" | "skipped" | "incomplete" | "failed" | "abandoned";
  reason?: string;
  runningRunId?: string;
  args?: Record<string, unknown>;
}

export class SystemJobsLedger {
  private readonly path: string;
  private readonly securePath: (p: string) => unknown;
  private readonly logger: { warn(m: string, f?: object): void };

  constructor(deps: LedgerDeps) {
    this.path = deps.ledgerPath;
    this.securePath = deps.securePath;
    this.logger = deps.logger;
  }

  private appendLine(row: Record<string, unknown>): void {
    const dir = dirname(this.path);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true, mode: 0o700 });
    }
    const line = JSON.stringify(row) + "\n";
    const fd = openSync(this.path, "a", 0o600);
    try {
      writeSync(fd, line);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    this.securePath(this.path);
  }

  begin(entry: StartedEntry): void {
    const row: Record<string, unknown> = {
      v: 1,
      phase: "started",
      runId: entry.runId,
      job: entry.job,
      trigger: entry.trigger,
      startedAt: entry.startedAt,
      ...(entry.args !== undefined ? { args: entry.args } : {}),
    };
    this.appendLine(row);
  }

  finish(entry: FinishedEntry): void {
    const row: Record<string, unknown> = {
      v: 1,
      phase: "finished",
      runId: entry.runId,
      job: entry.job,
      trigger: entry.trigger,
      startedAt: entry.startedAt,
      finishedAt: entry.finishedAt,
      durationMs: entry.durationMs,
      outcome: entry.outcome,
      ...(entry.reason !== undefined ? { reason: entry.reason } : {}),
      ...(entry.runningRunId !== undefined ? { runningRunId: entry.runningRunId } : {}),
      attempt: 1,
      ...(entry.args !== undefined ? { args: entry.args } : {}),
    };
    this.appendLine(row);
  }

  readAll(inFlightRunIds: ReadonlySet<string>): SystemRunRecord[] {
    if (!existsSync(this.path)) {
      return [];
    }
    let content: string;
    try {
      content = readFileSync(this.path, "utf8");
    } catch (err) {
      this.logger.warn("failed to read system jobs ledger", { error: String(err) });
      return [];
    }

    const startedMap = new Map<string, StartedEntry>();
    const recordsMap = new Map<string, SystemRunRecord>();
    const order: string[] = [];

    const rawLines = content.split("\n");
    for (const rawLine of rawLines) {
      const trimmed = rawLine.trim();
      if (!trimmed) continue;
      let parsed: any;
      try {
        parsed = JSON.parse(trimmed);
      } catch {
        this.logger.warn("unreadable line in system jobs ledger", { line: trimmed });
        continue;
      }

      if (!parsed || typeof parsed !== "object" || parsed.v !== 1 || typeof parsed.runId !== "string") {
        this.logger.warn("corrupt entry in system jobs ledger", { entry: parsed });
        continue;
      }

      if (parsed.phase === "started") {
        startedMap.set(parsed.runId, {
          runId: parsed.runId,
          job: parsed.job,
          trigger: parsed.trigger,
          startedAt: parsed.startedAt,
          ...(parsed.args !== undefined ? { args: parsed.args } : {}),
        });
        if (!order.includes(parsed.runId)) {
          order.push(parsed.runId);
        }
      } else if (parsed.phase === "finished") {
        const rec: SystemRunRecord = {
          runId: parsed.runId,
          job: parsed.job,
          kind: "system",
          trigger: parsed.trigger,
          startedAt: parsed.startedAt,
          finishedAt: parsed.finishedAt,
          durationMs: parsed.durationMs,
          outcome: parsed.outcome,
          attempt: 1,
          ...(parsed.reason !== undefined ? { reason: parsed.reason } : {}),
          ...(parsed.runningRunId !== undefined ? { runningRunId: parsed.runningRunId } : {}),
          ...(parsed.args !== undefined ? { args: parsed.args } : {}),
        };
        recordsMap.set(parsed.runId, rec);
        if (!order.includes(parsed.runId)) {
          order.push(parsed.runId);
        }
      } else {
        this.logger.warn("unknown phase in system jobs ledger", { phase: parsed.phase });
      }
    }

    // Now reconcile started entries without a finished entry
    for (const [runId, started] of startedMap.entries()) {
      if (recordsMap.has(runId)) {
        continue;
      }
      if (inFlightRunIds.has(runId)) {
        // Still running in-process
        continue;
      }
      // Started without finished and not in flight => abandoned
      recordsMap.set(runId, {
        runId,
        job: started.job,
        kind: "system",
        trigger: started.trigger,
        startedAt: started.startedAt,
        finishedAt: started.startedAt,
        durationMs: 0,
        outcome: "abandoned",
        reason: "core_stopped",
        attempt: 1,
        ...(started.args !== undefined ? { args: started.args } : {}),
      });
    }

    const results: SystemRunRecord[] = [];
    for (const runId of order) {
      const rec = recordsMap.get(runId);
      if (rec) {
        results.push(rec);
      }
    }
    return results;
  }
}
