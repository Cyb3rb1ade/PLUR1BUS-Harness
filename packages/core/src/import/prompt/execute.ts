import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type * as E from "@cyb3rb1ade/plur1bus-memory/types/engine.js";
import { RpcError } from "../../rpc/errors.ts";
import type {
  EntryTarget,
  ParsedEntry,
  PromptImportResult,
  PromptRollbackResult,
} from "./types.ts";

export interface ExecutePromptImportOptions {
  entries: ParsedEntry[];
  targets: EntryTarget[];
  principal: E.Principal;
  home: string;
  engine: E.Engine;
  agents?: { workspaceOf(id: string): string | undefined; defaultAgentId?(): string } | undefined;
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
      if (principal.trust !== "proved") {
        throw new RpcError("E_DENIED", "user-scope cards require a proved person principal", {
          reason: "principal-unresolved",
        });
      }
    }
  }

  const runId = `prompt-${now()}-${randomBytes(4).toString("hex")}`;
  const runDir = join(home, "imports", runId);
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
    writeFileSync(reportPath, JSON.stringify(report, null, 2) + "\n", {
      mode: 0o600,
    });
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
    writeFileSync(ledgerPath, line, { flag: "a", mode: 0o600 });
  };

  writeReport();

  // Group cards by agentId
  // Cards can be:
  // - target "user": routed through fallbackAgent with scope "user"
  // - target "workspace": routed through fallbackAgent with scope "workspace"
  // - target "agent": routed through each agent in agentIds with scope "agent-private"
  type CardTask = {
    card: E.MemoryImportCardInput;
    entry: ParsedEntry;
  };
  const agentBatches = new Map<string, CardTask[]>();

  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i]!;
    const target = targets[i]!;

    if (target.target === "skip") {
      report.counts.skipped++;
      appendLedger(entry.idempotencyKey, "skipped", { reason: target.reason });
      continue;
    }

    if (target.target === "propose-rule") {
      const targetAgent = target.agentIds?.[0] ?? fallbackAgent;
      affectedAgents.add(targetAgent);
      const propId = `prop-${now()}-${randomBytes(4).toString("hex")}`;
      report.proposals.push({
        id: propId,
        category: entry.category,
        text: entry.text,
        agentId: targetAgent,
        status: "open",
        createdAt: new Date(now()).toISOString(),
      });
      report.counts.proposedRules++;
      appendLedger(entry.idempotencyKey, "deferred", { proposalId: propId, targetAgent });
      continue;
    }

    const cardInput: E.MemoryImportCardInput = {
      idempotencyKey: entry.idempotencyKey,
      text: entry.text,
      kind: entry.category,
      provenance: "imported",
      sourceRef: `prompt-import;run=${runId};category=${entry.category}`,
      ...(entry.recordedAt ? { createdAt: new Date(entry.recordedAt).getTime() } : {}),
    };

    if (target.target === "user") {
      cardInput.scope = "user";
      affectedAgents.add(fallbackAgent);
      const list = agentBatches.get(fallbackAgent) ?? [];
      list.push({ card: cardInput, entry });
      agentBatches.set(fallbackAgent, list);
    } else if (target.target === "workspace") {
      cardInput.scope = "workspace";
      affectedAgents.add(fallbackAgent);
      const list = agentBatches.get(fallbackAgent) ?? [];
      list.push({ card: cardInput, entry });
      agentBatches.set(fallbackAgent, list);
    } else if (target.target === "agent") {
      const destAgents = target.agentIds && target.agentIds.length > 0 ? target.agentIds : [fallbackAgent];
      for (const ag of destAgents) {
        affectedAgents.add(ag);
        const copyInput: E.MemoryImportCardInput = {
          ...cardInput,
          scope: "agent-private",
          idempotencyKey: createHash("sha256")
            .update(ag + ":" + entry.idempotencyKey)
            .digest("hex"),
        };
        const list = agentBatches.get(ag) ?? [];
        list.push({ card: copyInput, entry });
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
                agentId,
              });
            } else if (cardRes.outcome === "matched-existing") {
              // Duplicate found: link to existing card via engine.memory.link
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
                    agentId,
                  });
                } catch {
                  // If link failed (e.g. conflict/limit), count as skipped
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
      proposedRules: report.counts.proposedRules,
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
}

export async function rollbackPromptImport(
  opts: RollbackPromptImportOptions,
): Promise<PromptRollbackResult> {
  const { runId, home, engine, principal } = opts;
  const reportPath = join(home, "imports", runId, "report.json");

  if (!existsSync(reportPath)) {
    throw new RpcError("E_NOT_FOUND", `import run not found: ${runId}`, {
      reason: "run-not-found",
    });
  }

  const report: PromptImportReport = JSON.parse(readFileSync(reportPath, "utf8"));
  let rolledBackCount = 0;

  for (const agentId of report.affectedAgents ?? []) {
    try {
      const res = await engine.memory.unimport(
        { agentId, importRunId: runId, dryRun: false },
        principal,
        SYSTEM_CONTEXT,
      );
      rolledBackCount += res.unimported ?? 0;
    } catch (e) {
      // ignore not found or lock error
    }
  }

  // Discard open proposals
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
  writeFileSync(reportPath, JSON.stringify(report, null, 2) + "\n", { mode: 0o600 });

  return {
    rolledBack: rolledBackCount,
    discardedProposals,
    unhandledProposals,
  };
}
