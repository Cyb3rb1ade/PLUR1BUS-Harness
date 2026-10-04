import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  renameSync,
  statSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { dirname } from "node:path";
import type { RunTrigger } from "../discovery/types.ts";
import type { SystemRunRecord } from "./index.ts";

const MAX_LEDGER_BYTES = 1024 * 1024; // 1 MiB

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
  private secured = false;

  constructor(deps: LedgerDeps) {
    this.path = deps.ledgerPath;
    this.securePath = deps.securePath;
    this.logger = deps.logger;
  }

  private secureOnce(p: string): void {
    const res = this.securePath(p) as { applied?: boolean } | undefined;
    if (res && res.applied === false) {
      throw new Error(`securePath failed to apply permissions to ${p}`);
    }
  }

  private appendLine(row: Record<string, unknown>): void {
    const dir = dirname(this.path);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      this.secureOnce(dir);
    }

    if (existsSync(this.path)) {
      try {
        const st = statSync(this.path);
        if (st.size >= MAX_LEDGER_BYTES) {
          const rotated = `${this.path}.1`;
          if (existsSync(rotated)) {
            try {
              unlinkSync(rotated);
            } catch {
              // ignore
            }
          }
          renameSync(this.path, rotated);
          this.secured = false;
        }
      } catch (err) {
        this.logger.warn("failed to rotate system jobs ledger", { error: String(err) });
      }
    }

    const fileExisted = existsSync(this.path);
    let prefix = "";
    if (fileExisted) {
      try {
        const st = statSync(this.path);
        if (st.size > 0) {
          const rfd = openSync(this.path, "r");
          try {
            const buf = Buffer.alloc(1);
            const n = readSync(rfd, buf, 0, 1, st.size - 1);
            if (n === 1 && buf[0] !== 0x0a) {
              prefix = "\n";
            }
          } finally {
            closeSync(rfd);
          }
        }
      } catch {
        // ignore read error
      }
    }

    const line = prefix + JSON.stringify(row) + "\n";
    const fd = openSync(this.path, "a", 0o600);
    try {
      writeSync(fd, line);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }

    if (!fileExisted || !this.secured) {
      this.secureOnce(this.path);
      this.secured = true;
    }
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
    const filesToRead: string[] = [];
    const rotated = `${this.path}.1`;
    if (existsSync(rotated)) {
      filesToRead.push(rotated);
    }
    if (existsSync(this.path)) {
      filesToRead.push(this.path);
    }
    if (filesToRead.length === 0) {
      return [];
    }

    const startedMap = new Map<string, StartedEntry>();
    const recordsMap = new Map<string, SystemRunRecord>();
    const seenOrder = new Set<string>();
    const order: string[] = [];

    for (const filePath of filesToRead) {
      let content: string;
      try {
        content = readFileSync(filePath, "utf8");
      } catch (err) {
        this.logger.warn("failed to read system jobs ledger", { path: filePath, error: String(err) });
        continue;
      }

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
          if (!seenOrder.has(parsed.runId)) {
            seenOrder.add(parsed.runId);
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
          if (!seenOrder.has(parsed.runId)) {
            seenOrder.add(parsed.runId);
            order.push(parsed.runId);
          }
        } else {
          this.logger.warn("unknown phase in system jobs ledger", { phase: parsed.phase });
        }
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
