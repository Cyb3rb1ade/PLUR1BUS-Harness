import { createHash, randomBytes } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
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
  principalFor?: ((agentId: string) => E.Principal) | undefined;
  importedBy?: string | undefined;
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
  status: "started" | "completed" | "failed" | "rolled-back" | "partial";
  startedAt: string;
  finishedAt?: string;
  rolledBackAt?: string;
  rolledBackBy?: string;
  importedBy?: string | undefined;
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
    importedBy: opts.importedBy ?? principal.user ?? principal.accountId,
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

  const totalEntries = entries.length;
  const runNow = now();
  const undatedBase = runNow - (totalEntries + 1000) * 1000;

  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i]!;
    const target = targets[i]!;

    // Instructions category, explicit skip targets, or rule proposals are skipped
    if (
      target.target === "skip" ||
      entry.category === "Instructions" ||
      target.target === "propose-rule"
    ) {
      report.counts.skipped++;
      const reason =
        entry.category === "Instructions" || target.target === "propose-rule"
          ? "instructions-not-imported"
          : (target.reason ?? "user-skipped");
      appendLedger(entry.idempotencyKey || `entry-${i}`, "skipped", { reason });
      continue;
    }

    const normalizedText = entry.text.trim().toLowerCase();
    const kind = mapCategoryToKind(entry.category);

    let createdAt: number;
    let isDateUnknown = false;

    if (entry.recordedAt) {
      const parsed = new Date(entry.recordedAt).getTime();
      if (Number.isFinite(parsed) && parsed >= 0) {
        // R1/R2: identical dates get distinct timestamps (index offset), and no card is dated after the import:
        // the cap runNow - (N - i) * 10 is strictly increasing in i, so even many future-dated entries stay distinct.
        const cap = runNow - (totalEntries - i) * 10;
        createdAt = Math.min(parsed + i, cap);
      } else {
        isDateUnknown = true;
        createdAt = undatedBase + i * 1000;
      }
    } else {
      isDateUnknown = true;
      createdAt = undatedBase + i * 1000;
    }

    const baseCard: Omit<E.MemoryImportCardInput, "idempotencyKey"> = {
      text: entry.text,
      ...(kind ? { kind } : {}),
      provenance: "imported",
      sourceRef: `prompt-import;run=${runId};category=${entry.category}${isDateUnknown ? ";dateUnknown=1" : ""}`,
      createdAt,
    };

    if (target.target === "user") {
      // H1: Server-side idempotency key scoped to user principal
      const ownerKey = principal.user ?? principal.accountId;
      const idempotencyKey = createHash("sha256")
        .update(`user:${ownerKey}:${entry.category}:${normalizedText}`)
        .digest("hex");

      // M2: a user-scope card lives in the table of the agent it is written through (the engine keeps
      // `ownerUserId` on the agent's table), so the chosen target agents receive it; default: the first agent.
      const userAgents = target.agentIds && target.agentIds.length > 0 ? target.agentIds : [fallbackAgent];
      for (const ag of userAgents) {
        const cardInput: E.MemoryImportCardInput = {
          ...baseCard,
          scope: "user",
          idempotencyKey,
        };
        affectedAgents.add(ag);
        const list = agentBatches.get(ag) ?? [];
        list.push({ card: cardInput, entry });
        agentBatches.set(ag, list);
      }
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
      const agentPrincipal = opts.principalFor ? opts.principalFor(agentId) : { ...principal, agentId };
      for (let i = 0; i < tasks.length; i += 500) {
        const chunk = tasks.slice(i, i + 500);
        const cardsInput = chunk.map((t) => t.card);

        const importReq: E.MemoryImportRequest = {
          agentId,
          principal: agentPrincipal,
          cards: cardsInput,
          dryRun,
          importRunId: runId,
        };

        const result: E.MemoryImportResult = await engine.memory.import(
          importReq,
          agentPrincipal,
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
                scope: task.card.scope,
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
                    agentPrincipal,
                    SYSTEM_CONTEXT,
                  );
                  report.counts.linked++;
                  appendLedger(task.card.idempotencyKey, "linked", {
                    existingCardId: cardRes.id,
                    targetRef: cardRes.id,
                    sourceRef: task.card.sourceRef,
                    agentId,
                    scope: task.card.scope,
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
        const agentPrincipal = opts.principalFor ? opts.principalFor(agentId) : { ...principal, agentId };
        try {
          await engine.memory.unimport(
            { agentId, importRunId: runId, dryRun: false },
            agentPrincipal,
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
  principalFor?: ((agentId: string) => E.Principal) | undefined;
  callerUserId?: string | undefined;
  isOwner?: boolean | undefined;
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

  // N4 & L1: a report without importedBy is foreign to everybody; only the owner may then roll it back.
  const isForeignRun = report.importedBy
    ? Boolean(opts.callerUserId && report.importedBy !== opts.callerUserId)
    : true;

  if (isForeignRun && !opts.isOwner) {
    throw new RpcError("E_DENIED", "cannot rollback an import run belonging to another user", {
      reason: "foreign-import-run",
    });
  }

  // B6: Refuse second rollback if fully completed
  if (report.status === "rolled-back") {
    throw new RpcError("E_CONFLICT", "run already rolled back", {
      reason: "already-rolled-back",
    });
  }

  // Foreign run (owner override): only agent-scoped cards and links are removed. The importer's user-scope cards
  // are preserved and counted separately; a ledger line without a scope is treated as user scope (fail safe).
  let preservedUserScope = 0;
  const agentKeyFilters = new Map<string, string[]>();

  if (isForeignRun) {
    const ledgerPath = join(runDir, "ledger.jsonl");
    let ledgerText: string;
    try {
      ledgerText = readFileSync(ledgerPath, "utf8");
    } catch {
      // Without the ledger the run's cards cannot be told apart: refuse, change nothing, keep the status.
      throw new RpcError("E_STORAGE", "run ledger is missing or unreadable; the run cannot be rolled back by another user", {
        reason: "ledger-unreadable",
      });
    }
    for (const line of ledgerText.split("\n").filter(Boolean)) {
      try {
        const entry = JSON.parse(line);
        if (entry.action !== "created" && entry.action !== "linked") continue;
        const scope = entry.details?.scope;
        const agentId = entry.details?.agentId;
        if (scope !== "agent-private") {
          if (entry.action === "created") preservedUserScope++;
        } else if (typeof agentId === "string" && typeof entry.idempotencyKey === "string") {
          const list = agentKeyFilters.get(agentId) ?? [];
          list.push(entry.idempotencyKey);
          agentKeyFilters.set(agentId, list);
        }
      } catch {
        // ignore malformed line
      }
    }
  }

  let rolledBackCount = 0;
  let failedCount = 0;
  let remainingCount = 0;
  let keptModifiedCount = 0;
  let unlinkedCount = 0;

  for (const agentId of report.affectedAgents ?? []) {
    // In a foreign run, skip agents that have no agent-scoped cards to unimport
    if (isForeignRun && !agentKeyFilters.has(agentId)) {
      continue;
    }
    // The engine accepts at most 500 idempotency keys per unimport call.
    const keys = isForeignRun ? agentKeyFilters.get(agentId)! : undefined;
    const chunks: Array<string[] | undefined> = keys ? [] : [undefined];
    if (keys) for (let i = 0; i < keys.length; i += 500) chunks.push(keys.slice(i, i + 500));
    // An agent whose principal cannot be built (no workspace directory) fails alone: the other agents are still
    // rolled back and the run is reported `partial`.
    let agentPrincipal: E.Principal;
    try {
      agentPrincipal = opts.principalFor ? opts.principalFor(agentId) : { ...principal, agentId };
    } catch {
      failedCount += 1;
      remainingCount += 1;
      continue;
    }
    for (const chunk of chunks) {
      try {
        const req: E.MemoryUnimportRequest = {
          agentId,
          importRunId: runId,
          dryRun: false,
          ...(chunk ? { idempotencyKeys: chunk } : {}),
        };
        const res = await engine.memory.unimport(req, agentPrincipal, SYSTEM_CONTEXT);
        rolledBackCount += res.unimported ?? 0;
        unlinkedCount += res.links?.unlinked ?? 0;
        keptModifiedCount += res.keptModified ?? 0;
        failedCount += res.failed ?? 0;
        remainingCount += res.remaining ?? 0;
      } catch {
        failedCount += 1;
        remainingCount += 1;
      }
    }
  }

  if (isForeignRun && preservedUserScope > 0) {
    const ledgerLine = JSON.stringify({
      ts: new Date(now()).toISOString(),
      runId,
      entity: "memory",
      idempotencyKey: "foreign-user-scope-preserved",
      action: "skipped",
      details: {
        reason: "foreign-user-scope-preserved",
        count: preservedUserScope,
        callerUserId: opts.callerUserId,
      },
    }) + "\n";
    try {
      appendFileSync(join(runDir, "ledger.jsonl"), ledgerLine, { mode: 0o600 });
    } catch {
      // ignore append failure
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

  // A foreign rollback that kept the importer's user-scope cards is not complete: the importer can still roll the
  // run back themselves, so the run stays `partial`.
  if (failedCount === 0 && remainingCount === 0 && preservedUserScope === 0) {
    report.status = "rolled-back";
  } else {
    report.status = "partial";
  }
  report.rolledBackAt = new Date(now()).toISOString();
  report.rolledBackBy = opts.callerUserId ?? principal.user ?? principal.accountId;
  writeAtomicSync(reportPath, JSON.stringify(report, null, 2) + "\n", 0o600);

  return {
    rolledBack: rolledBackCount,
    failed: failedCount,
    remaining: remainingCount,
    keptModified: keptModifiedCount,
    unlinked: unlinkedCount,
    preservedUserScope,
    discardedProposals,
    unhandledProposals,
  };
}

/**
 * Agents through which `userId` imported by prompt (from the `affectedAgents` of their own run reports). A user-scope
 * card can only be in the table of an agent it was written through, so these are the extra agents an export reads.
 */
export function agentsOfOwnPromptRuns(home: string, userId: string, maxRuns = 1000): string[] {
  const root = join(home, "imports");
  let names: string[];
  try {
    names = readdirSync(root).filter((n) => PROMPT_RUN_ID_RE.test(n)).sort().slice(-maxRuns);
  } catch {
    return [];
  }
  const agents = new Set<string>();
  for (const name of names) {
    try {
      const r = JSON.parse(readFileSync(join(root, name, "report.json"), "utf8")) as Partial<PromptImportReport>;
      if (r.source === "prompt" && r.importedBy === userId) {
        for (const a of r.affectedAgents ?? []) if (typeof a === "string") agents.add(a);
      }
    } catch {
      // unreadable report: not this person's evidence
    }
  }
  return [...agents];
}
