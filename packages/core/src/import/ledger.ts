// Idempotency ledger for harness imports (docs/import.md §5.2, §5.3, Batch 4).
// Durably records every applied mutation under `<home>/imports/<runId>/ledger.jsonl`
// so that repeated or resumed runs are strictly idempotent.
import { createHash } from "node:crypto";
import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  statSync,
  writeSync,
} from "node:fs";
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
  | "rejected"
  | "repaired"
  | "adopted";

export interface LedgerEntry {
  ts: string;
  runId: string;
  entity: "agent" | "file" | "channel" | "cron" | "system" | "memory" | "store";
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

// `entries` are fingerprints (import/fingerprint.ts), never plain ids.
export function channelIdempotencyKey(platform: string, allowFrom: string[]): string {
  const sorted = allowFrom.slice().sort().join(",");
  const hash = createHash("sha256").update(sorted).digest("hex").slice(0, 16);
  return `channel:${platform}:${hash}`;
}

export function cronIdempotencyKey(jobId: string, schedule: string): string {
  const hash = createHash("sha256").update(schedule).digest("hex").slice(0, 16);
  return `cron:${jobId}:${hash}`;
}

export function cardIdempotencyKey(sourceType: string, profile: string, sourceFile: string, text: string): string {
  const hash = createHash("sha256").update(text.trim()).digest("hex").slice(0, 16);
  return `${sourceType}:${profile}:${sourceFile}:${hash}`;
}

export function memoryBatchIdempotencyKey(agentId: string, batchIdx: number, keysHash: string): string {
  return `memory:${agentId}:${batchIdx}:${keysHash}`;
}

export function storeIdempotencyKey(sourcePath: string): string {
  const hash = createHash("sha256").update(sourcePath).digest("hex").slice(0, 16);
  return `store:${hash}`;
}

export class ImportLedger {
  readonly filePath: string;
  readonly runId: string;
  private readonly entriesByKey = new Map<string, LedgerEntry>();
  private readonly all: LedgerEntry[] = [];
  corruptLineCount = 0;

  constructor(filePath: string, runId: string) {
    this.filePath = filePath;
    this.runId = runId;
    if (existsSync(filePath)) {
      try {
        const text = readFileSync(filePath, "utf8");
        const lines = text.split("\n");
        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed) continue;
          try {
            const entry = JSON.parse(trimmed) as LedgerEntry;
            if (entry && typeof entry.idempotencyKey === "string" && entry.entity) {
              this.entriesByKey.set(entry.idempotencyKey, entry);
              this.all.push(entry);
            } else {
              this.corruptLineCount++;
            }
          } catch {
            this.corruptLineCount++;
          }
        }
      } catch {
        this.corruptLineCount++;
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

    // If file exists and does not end with \n, append a newline and repair entry before recording new entry
    if (existsSync(this.filePath)) {
      const st = statSync(this.filePath);
      if (st.size > 0) {
        let lastByte = 0x0a;
        const fdRead = openSync(this.filePath, "r");
        try {
          const singleByteBuf = Buffer.alloc(1);
          readSync(fdRead, singleByteBuf, 0, 1, st.size - 1);
          lastByte = singleByteBuf[0] ?? 0x0a;
        } finally {
          closeSync(fdRead);
        }
        if (lastByte !== 0x0a) {
          const fdFix = openSync(this.filePath, "a", 0o600);
          try {
            const repairEntry: LedgerEntry = {
              ts: new Date().toISOString(),
              runId: this.runId,
              entity: "system",
              idempotencyKey: "repair:torn-line",
              action: "repaired",
            };
            writeSync(fdFix, "\n" + JSON.stringify(repairEntry) + "\n");
            fsyncSync(fdFix);
          } finally {
            closeSync(fdFix);
          }
        }
      }
    }

    const fd = openSync(this.filePath, "a", 0o600);
    try {
      writeSync(fd, JSON.stringify(entry) + "\n");
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }

    this.entriesByKey.set(entry.idempotencyKey, entry);
    this.all.push(entry);
    return entry;
  }

  entries(): readonly LedgerEntry[] {
    return this.all;
  }
}
