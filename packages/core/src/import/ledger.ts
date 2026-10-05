// Idempotency ledger for harness imports (docs/import.md §5.2, §5.3, Batch 4).
// Durably records every applied mutation under `<home>/imports/<runId>/ledger.jsonl`
// so that repeated or resumed runs are strictly idempotent.
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";

export type ConflictStrategy = "skip" | "rename" | "replace";

export type LedgerAction =
  | "created"
  | "matched-existing"
  | "conflict-skip"
  | "rename"
  | "replace"
  | "deferred"
  | "skipped"
  | "rejected";

export interface LedgerEntry {
  ts: string;
  runId: string;
  entity: "agent" | "file" | "channel" | "cron";
  idempotencyKey: string;
  action: LedgerAction;
  sourceRef?: string | undefined;
  targetRef?: string | undefined;
  sha256?: string | null | undefined;
  reason?: string | null | undefined;
  details?: Record<string, unknown> | undefined;
}

export function agentIdempotencyKey(sourceType: string, agentId: string): string {
  return `agent:${sourceType}:${agentId}`;
}

export function fileIdempotencyKey(agentId: string, relTarget: string, sha: string): string {
  return `file:${agentId}:${relTarget}:${sha}`;
}

export function channelIdempotencyKey(platform: string, allowFrom: string[]): string {
  const sorted = allowFrom.slice().sort().join(",");
  return `channel:${platform}:${sorted}`;
}

export function cronIdempotencyKey(jobId: string, schedule: string): string {
  return `cron:${jobId}:${schedule}`;
}

export class ImportLedger {
  readonly filePath: string;
  readonly runId: string;
  private readonly entriesByKey = new Map<string, LedgerEntry>();
  private readonly all: LedgerEntry[] = [];

  constructor(filePath: string, runId: string) {
    this.filePath = filePath;
    this.runId = runId;
    if (existsSync(filePath)) {
      try {
        const lines = readFileSync(filePath, "utf8").split("\n");
        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed) continue;
          const entry = JSON.parse(trimmed) as LedgerEntry;
          this.entriesByKey.set(entry.idempotencyKey, entry);
          this.all.push(entry);
        }
      } catch {
        // Corrupt or unparseable lines skipped on reload
      }
    }
  }

  has(idempotencyKey: string): boolean {
    return this.entriesByKey.has(idempotencyKey);
  }

  get(idempotencyKey: string): LedgerEntry | undefined {
    return this.entriesByKey.get(idempotencyKey);
  }

  record(
    item: Omit<LedgerEntry, "ts" | "runId"> & { now?: () => Date },
  ): LedgerEntry {
    const ts = item.now ? item.now().toISOString() : new Date().toISOString();
    const entry: LedgerEntry = {
      ts,
      runId: this.runId,
      entity: item.entity,
      idempotencyKey: item.idempotencyKey,
      action: item.action,
      sourceRef: item.sourceRef,
      targetRef: item.targetRef,
      sha256: item.sha256 ?? null,
      reason: item.reason ?? null,
      details: item.details,
    };

    mkdirSync(dirname(this.filePath), { recursive: true, mode: 0o700 });
    appendFileSync(this.filePath, JSON.stringify(entry) + "\n", { mode: 0o600 });

    this.entriesByKey.set(entry.idempotencyKey, entry);
    this.all.push(entry);
    return entry;
  }

  entries(): readonly LedgerEntry[] {
    return this.all;
  }
}
