import { createHash, randomBytes } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type * as E from "@cyb3rb1ade/plur1bus-memory/types/engine.js";
import { RpcError } from "../../rpc/errors.ts";
import { isInsideDir, writeAtomicSync } from "../fs-atomic.ts";
import type {
  EntryTarget,
  ParsedEntry,
  PromptImportResult,
  PromptRollbackResult,
} from "./types.ts";

export const PROMPT_RUN_ID_RE = /^prompt-[0-9]+-[0-9a-f]+$/;

export interface ExecutePromptImportOptions {
  entries: ParsedEntry[];
  targets: EntryTarget[];
  principal: E.Principal;
  home: string;
  engine: E.Engine;
  agents?: { workspaceOf(id: string): string | undefined; defaultAgentId?(): string; has?(id: string): boolean } | undefined;
  defaultAgentId?: string | undefined;
  dryRun?: boolean | undefined;
  now?: (() => number) | undefined;
}

export interface PromptReportProposal {
  id: string;
  category: string;
  text: string;
  agentId: string;
  status: "open" | "accepted" | "rejected" | "discarded";
  createdAt: string;
}

export interface PromptImportReport {
  runId: string;
  source: "prompt";
  status: "started" | "completed" | "failed" | "rolled-back";
  startedAt: string;
  finishedAt?: string;
  rolledBackAt?: string;
  rolledBackBy?: string;
  dryRun: boolean;
  targets: EntryTarget[];
  counts: {
    total: number;
    imported: number;
    linked: number;
    proposedRules: number;
    skipped: number;
  };
  proposals: PromptReportProposal[];
  affectedAgents: string[];
  error?: string;
}

const SYSTEM_CONTEXT: E.AgentContext = Object.freeze({
  origin: "system",
  background: false,
});

/** Map export categories onto engine lowercase MEMORY_CATEGORIES */
function mapCategoryToKind(category: string): string | undefined {
  switch (category) {
    case "Preferences":
      return "preference";
    case "Identity":
    case "Career":
      return "fact";
    case "Projects":
      return "fact";
    case "Other":
      return "other";
    default:
      return undefined;
  }
}

export async function executePromptImport(
  opts: ExecutePromptImportOptions,
): Promise<PromptImportResult> {
  const { entries, targets, principal, home, engine, dryRun = false } = opts;
  const now = opts.now ?? (() => Date.now());

  if (entries.length !== targets.length) {
    throw new RpcError("E_INVALID_PARAMS", "entries and targets arrays must have equal length", {
      reason: "length-mismatch",
    });
  }

  // Preflight check: user scope requires proved principal
  for (const t of targets) {
    if (t.target === "user") {
      if (principal.trust !== "proved" || !principal.user) {
        throw new RpcError("E_DENIED", "user-scope cards require a proved person principal", {
          reason: "principal-unresolved",
        });
      }
    }
  }

  const runId = `prompt-${now()}-${randomBytes(4).toString("hex")}`;
  const importsDir = join(home, "imports");
  const runDir = join(importsDir, runId);
  if (!dryRun) {
    mkdirSync(runDir, { recursive: true, mode: 0o700 });
  }
  const reportPath = join(runDir, "report.json");
  const ledgerPath = join(runDir, "ledger.jsonl");

  const fallbackAgent = opts.defaultAgentId ?? opts.agents?.defaultAgentId?.() ?? "default";
  const affectedAgents = new Set<string>();

  const report: PromptImportReport = {
    runId,
    source: "prompt",
    status: "started",
    startedAt: new Date(now()).toISOString(),
    dryRun,
    targets,
    counts: {
      total: entries.length,
      imported: 0,
      linked: 0,
      proposedRules: 0,
      skipped: 0,
    },
    proposals: [],
    affectedAgents: [],
  };

  const writeReport = () => {
    if (dryRun) return;
    writeAtomicSync(reportPath, JSON.stringify(report, null, 2) + "\n", 0o600);
  };

  const appendLedger = (
    idempotencyKey: string,
    action: "created" | "linked" | "deferred" | "skipped",
    details: Record<string, unknown>,
  ) => {
    if (dryRun) return;
    const line = JSON.stringify({
      ts: new Date(now()).toISOString(),
      runId,
      entity: "memory",
      idempotencyKey,
      action,
      details,
    }) + "\n";
    try {
      appendFileSync(ledgerPath, line, { mode: 0o600 });
    } catch {
      // ignore append failure in edge cases
    }
  };

  writeReport();

  type CardTask = {
    card: E.MemoryImportCardInput;
    entry: ParsedEntry;
  };
  const agentBatches = new Map<string, CardTask[]>();

  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i]!;
    const target = targets[i]!;

    // Instructions and explicit skip targets are never imported directly (B7 prompt injection mitigation)
    if (target.target === "skip" || entry.category === "Instructions" || target.target === "propose-rule") {
      report.counts.skipped++;
      const reason = entry.category === "Instructions" || target.target === "propose-rule"
        ? "instructions-not-imported"
        : (target.reason ?? "user-skipped");
      appendLedger(entry.idempotencyKey || `entry-${i}`, "skipped", { reason });
      continue;
    }

    const normalizedText = entry.text.trim().toLowerCase();
    const kind = mapCategoryToKind(entry.category);

    const baseCard: Omit<E.MemoryImportCardInput, "idempotencyKey"> = {
      text: entry.text,
      ...(kind ? { kind } : {}),
      provenance: "imported",
      sourceRef: `prompt-import;run=${runId};category=${entry.category}`,
      ...(entry.recordedAt ? { createdAt: new Date(entry.recordedAt).getTime() } : {}),
    };

    if (target.target === "user") {
      // H1: Server-side idempotency key scoped to user principal
      const ownerKey = principal.user ?? principal.accountId;
      const idempotencyKey = createHash("sha256")
        .update(`user:${ownerKey}:${entry.category}:${normalizedText}`)
        .digest("hex");

      const cardInput: E.MemoryImportCardInput = {
        ...baseCard,
        scope: "user",
        idempotencyKey,
      };
      affectedAgents.add(fallbackAgent);
      const list = agentBatches.get(fallbackAgent) ?? [];
      list.push({ card: cardInput, entry });
      agentBatches.set(fallbackAgent, list);
    } else if (target.target === "workspace") {
      // H1 & H3: Server-side idempotency key scoped to workspace
      const targetWsAgent = (target.workspaceId && opts.agents?.has?.(target.workspaceId))
        ? target.workspaceId
        : fallbackAgent;
      const ownerKey = target.workspaceId ?? targetWsAgent;
      const idempotencyKey = createHash("sha256")
        .update(`workspace:${ownerKey}:${entry.category}:${normalizedText}`)
        .digest("hex");

      const cardInput: E.MemoryImportCardInput = {
        ...baseCard,
        scope: "workspace",
        idempotencyKey,
      };
      affectedAgents.add(targetWsAgent);
      const list = agentBatches.get(targetWsAgent) ?? [];
      list.push({ card: cardInput, entry });
      agentBatches.set(targetWsAgent, list);
    } else if (target.target === "agent") {
      // H1: Server-side idempotency key scoped per target agent
      const destAgents = target.agentIds && target.agentIds.length > 0 ? target.agentIds : [fallbackAgent];
      for (const ag of destAgents) {
        affectedAgents.add(ag);
        const idempotencyKey = createHash("sha256")
          .update(`agent:${ag}:${entry.category}:${normalizedText}`)
          .digest("hex");

        const cardInput: E.MemoryImportCardInput = {
          ...baseCard,
          scope: "agent-private",
          idempotencyKey,
        };
        const list = agentBatches.get(ag) ?? [];
        list.push({ card: cardInput, entry });
        agentBatches.set(ag, list);
      }
    }
  }

  report.affectedAgents = Array.from(affectedAgents);

  // Execute import batches (<= 500 cards per engine call)
  const appliedRunsPerAgent = new Set<string>();

  try {
    for (const [agentId, tasks] of agentBatches.entries()) {
      for (let i = 0; i < tasks.length; i += 500) {
        const chunk = tasks.slice(i, i + 500);
        const cardsInput = chunk.map((t) => t.card);

        const importReq: E.MemoryImportRequest = {
          agentId,
          principal,
          cards: cardsInput,
          dryRun,
          importRunId: runId,
        };

        const result: E.MemoryImportResult = await engine.memory.import(
          importReq,
          principal,
          SYSTEM_CONTEXT,
        );
        appliedRunsPerAgent.add(agentId);

        if (dryRun) {
          report.counts.imported += result.created;
          report.counts.linked += result.matchedExisting;
          report.counts.skipped += result.rejected;
        } else {
          // Process individual card outcomes
          for (let j = 0; j < result.cards.length; j++) {
            const cardRes = result.cards[j]!;
            const task = chunk[j]!;

            if (cardRes.outcome === "created") {
              report.counts.imported++;
              appendLedger(task.card.idempotencyKey, "created", {
                cardId: cardRes.id,
                targetRef: cardRes.id,
                sourceRef: task.card.sourceRef,
                agentId,
              });
            } else if (cardRes.outcome === "matched-existing") {
              // Duplicate found: link to existing card via engine.memory.link (M8)
              if (cardRes.id && typeof engine.memory.link === "function") {
                try {
                  await engine.memory.link(
                    cardRes.id,
                    {
                      sourceRef: task.card.sourceRef ?? `prompt-import;run=${runId}`,
                      provenance: "imported",
                      importRunId: runId,
                      idempotencyKey: task.card.idempotencyKey,
                      dryRun: false,
                    },
                    principal,
                    SYSTEM_CONTEXT,
                  );
                  report.counts.linked++;
                  appendLedger(task.card.idempotencyKey, "linked", {
                    existingCardId: cardRes.id,
                    targetRef: cardRes.id,
                    sourceRef: task.card.sourceRef,
                    agentId,
                  });
                } catch {
                  // If link failed (e.g. duplicate link or limit), count as skipped
                  report.counts.skipped++;
                }
              } else {
                report.counts.linked++;
              }
            } else {
              report.counts.skipped++;
              appendLedger(task.card.idempotencyKey, "skipped", {
                reason: cardRes.reason,
              });
            }
          }
        }
      }
    }

    report.status = "completed";
    report.finishedAt = new Date(now()).toISOString();
    writeReport();

    return {
      runId,
      imported: report.counts.imported,
      linked: report.counts.linked,
      proposedRules: 0,
      skipped: report.counts.skipped,
      reportPath,
    };
  } catch (err) {
    report.status = "failed";
    report.error = String((err as Error)?.message ?? err);
    report.finishedAt = new Date(now()).toISOString();
    writeReport();

    // Rollback already written batches for this runId
    if (!dryRun) {
      for (const agentId of appliedRunsPerAgent) {
        try {
          await engine.memory.unimport(
            { agentId, importRunId: runId, dryRun: false },
            principal,
            SYSTEM_CONTEXT,
          );
        } catch {
          // Keep best effort cleanup
        }
      }
    }

    throw err;
  }
}

export interface RollbackPromptImportOptions {
  runId: string;
  home: string;
  engine: E.Engine;
  principal: E.Principal;
  now?: (() => number) | undefined;
}

export async function rollbackPromptImport(
  opts: RollbackPromptImportOptions,
): Promise<PromptRollbackResult> {
  const { runId, home, engine, principal } = opts;
  const now = opts.now ?? (() => Date.now());

  // B6: Validate runId format
  if (!PROMPT_RUN_ID_RE.test(runId)) {
    throw new RpcError("E_INVALID_PARAMS", `invalid prompt import runId format: ${runId}`, {
      reason: "invalid-run-id",
    });
  }

  // B6: Path traversal containment check
  const importsRoot = join(home, "imports");
  const runDir = join(importsRoot, runId);
  if (!isInsideDir(importsRoot, runDir)) {
    throw new RpcError("E_INVALID_PARAMS", "path traversal detected", {
      reason: "path-traversal",
    });
  }

  const reportPath = join(runDir, "report.json");
  if (!existsSync(reportPath)) {
    throw new RpcError("E_NOT_FOUND", `import run not found: ${runId}`, {
      reason: "run-not-found",
    });
  }

  let report: PromptImportReport;
  try {
    report = JSON.parse(readFileSync(reportPath, "utf8"));
  } catch {
    throw new RpcError("E_STORAGE", "unreadable run report", {
      reason: "corrupt-report",
    });
  }

  // B6: Require source === "prompt"
  if (report.source !== "prompt") {
    throw new RpcError("E_DENIED", "cannot rollback non-prompt import run with this method", {
      reason: "wrong-import-source",
    });
  }

  // B6: Refuse second rollback
  if (report.status === "rolled-back") {
    throw new RpcError("E_CONFLICT", "run already rolled back", {
      reason: "already-rolled-back",
    });
  }

  let rolledBackCount = 0;

  for (const agentId of report.affectedAgents ?? []) {
    try {
      const res = await engine.memory.unimport(
        { agentId, importRunId: runId, dryRun: false },
        principal,
        SYSTEM_CONTEXT,
      );
      rolledBackCount += res.unimported ?? 0;
    } catch {
      // Continue for remaining agents
    }
  }

  // Discard open proposals if any
  let discardedProposals = 0;
  let unhandledProposals = 0;

  for (const prop of report.proposals ?? []) {
    if (prop.status === "open") {
      prop.status = "discarded";
      discardedProposals++;
    } else {
      unhandledProposals++;
    }
  }

  report.status = "rolled-back";
  report.rolledBackAt = new Date(now()).toISOString();
  report.rolledBackBy = principal.user ?? principal.accountId;
  writeAtomicSync(reportPath, JSON.stringify(report, null, 2) + "\n", 0o600);

  return {
    rolledBack: rolledBackCount,
    discardedProposals,
    unhandledProposals,
  };
}
