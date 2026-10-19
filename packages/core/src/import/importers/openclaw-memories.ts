// OpenClaw memory cards migration via Engine.memory.import (docs/import.md §1, §2.2, M7).
// Reads agent MEMORY.md and USER.md from agent workspaces.
// Delimited by \n§\n or treated as single trimmed card if § is absent.
// Normalizes CRLF, discards whitespace-only cards, enforces <= 500 cards batch limit.
// Idempotency keys are deterministic from ("openclaw", agentId, sourceFile, cardHash), never from runId.
// Provenance: "imported", sourceRef: "openclaw:<agentId>:<sourceFile>#<n>;run=<runId>".
// USER.md cards are reported as unresolved-user-scope unless an unambiguous user principal is provided.
// Errors from memory.import are tracked in errors[] and counted as rejected, never swallowed.
// NEVER writes directly to LanceDB or imports external vector store libraries.
// Agents with a store of their own (owner decision 2026-10-19, docs/import.md §2.2): their cards are imported too.
//   - store taken over / matched: before a card is written, the agent's store is asked whether the same memory is already
//     there (engine duplicate rule, card-links.ts DUPLICATE_SCORE); a duplicate is not written again but linked: ledger action
//     "linked" with the existing memory id, report outcome "linked"; with engine contract 1.16.0 also in the engine
//     (`memory.link`, report/ledger linkId). A second copy of a linked card in the same file is matched-existing.
//   - store routed to the re-embedding migration: the cards are parked (outcome / ledger action "pending-reembed") and
//     never embedded into a vector space the agent's store is not in; a later run that takes the store over imports them.
//   - store not taken over for another reason (skipped): the cards are deferred (outcome / ledger action "deferred").
//   - USER.md without a user binding stays unresolved-user-scope in every case (ADR-007 Q4 first, as for Hermes): never parked.
// The rule's building blocks (duplicate check, ledger links, parking) are shared with the Hermes importer: card-links.ts.
import { createHash } from "node:crypto";
import { basename, dirname, join, relative } from "node:path";
import type { Layout } from "../../paths.ts";
import {
  cardIdempotencyKey,
  fileIdempotencyKey,
  type ConflictStrategy,
  type ImportLedger,
} from "../ledger.ts";
import { writeAtomicSync } from "../fs-atomic.ts";
import { existsNoFollow, readSourceFileSafe, readSourceTextSafe } from "../fs-safe.ts";
import { ImportError } from "../types.ts";
import type { Engine, Principal } from "@cyb3rb1ade/plur1bus-memory/types/engine.js";
import { createCardLinker, recordParkedCard, type CardLink, type LinkCandidate, type OwnStoreCardMode } from "./card-links.ts";

export const IMPORT_CARD_BATCH_LIMIT = 500;
export const MAX_MEMORY_FILE_BYTES = 16 * 1024 * 1024; // 16 MiB

export function splitOpenclawCards(content: string): string[] {
  if (!content) return [];
  const normalized = content.replace(/\r\n/g, "\n");
  const chunks = normalized.split(/(?:^|\n)§(?:\n|$)/);
  const cards: string[] = [];
  for (const chunk of chunks) {
    const trimmed = chunk.trim();
    if (trimmed.length > 0) {
      cards.push(trimmed);
    }
  }
  return cards;
}

/** A reason code only (never message text, which could echo card content): a short token, else "storage". */
function importErrorCode(err: any): string {
  const raw = err?.code ?? err?.reason;
  return typeof raw === "string" && /^[A-Za-z0-9_.-]{1,64}$/.test(raw) ? raw : "storage";
}

/** Whether the workspace holds a card file (MEMORY.md / USER.md, any case the importer reads). */
export function hasOpenclawCardFiles(workspaceDir: string): boolean {
  return ["MEMORY.md", "memory.md", "USER.md", "user.md"].some((n) => existsNoFollow(join(workspaceDir, n)));
}

export interface OpenclawMemoryImportResult {
  importedCount: number;
  skippedDuplicateCount: number;
  rejectedCount: number;
  unresolvedUserScopeCount: number;
  totalCards: number;
  /** Cards that duplicate a memory already in the agent's own store: not written again, linked to it. */
  linkedCount: number;
  /** Cards parked until the agent's store has gone through the re-embedding migration (never in a foreign vector space). */
  pendingReembedCount: number;
  /** Cards of an agent whose own store was not taken over for another reason (skipped): written by a later run. */
  deferredCount: number;
  cardResults: Array<{
    idempotencyKey: string;
    outcome: "created" | "matched-existing" | "rejected" | "unresolved-user-scope" | "linked" | "pending-reembed" | "deferred";
    reason?: string | undefined;
    /** outcome "linked": the id of the memory the card duplicates. */
    linkedTo?: string | undefined;
    /** outcome "linked": the engine link id (`memory.link`, contract 1.16.0); absent for a ledger-only link. */
    linkId?: string | undefined;
  }>;
  errors: Array<{ sourceRef: string; reason: string }>;
}

export async function importOpenclawMemories(opts: {
  workspaceDir: string;
  agentId: string;
  l: Layout;
  engine?: Engine | undefined;
  isApply: boolean;
  ledger?: ImportLedger | undefined;
  userPrincipal?: any | undefined;
  onConflict?: ConflictStrategy | undefined;
  replacedBackupDir?: string | undefined;
  /** Set for an agent that has a memory store of its own (see OwnStoreCardMode). */
  ownStore?: OwnStoreCardMode | undefined;
}): Promise<OpenclawMemoryImportResult> {
  const {
    workspaceDir,
    agentId,
    l,
    engine,
    isApply,
    ledger,
    userPrincipal,
  } = opts;

  let totalCards = 0;
  let importedCount = 0;
  let skippedDuplicateCount = 0;
  let rejectedCount = 0;
  let unresolvedUserScopeCount = 0;
  let linkedCount = 0;
  let pendingReembedCount = 0;
  let deferredCount = 0;
  const cardResults: OpenclawMemoryImportResult["cardResults"] = [];
  const errors: Array<{ sourceRef: string; reason: string }> = [];

  // Principal for system import
  const principal: Principal = {
    agentId,
    workspace: "workspace:v1:main",
    channel: "cli",
    accountId: "default",
    chat: { id: "c1", kind: "direct" },
    trust: "proved",
  };
  const systemAgent = { origin: "system", background: false } as const;
  const runSuffix = ledger ? `;run=${ledger.runId}` : "";


  const summary = (): OpenclawMemoryImportResult => ({
    importedCount, skippedDuplicateCount, rejectedCount, unresolvedUserScopeCount, linkedCount, pendingReembedCount, deferredCount, totalCards, cardResults, errors,
  });

  /** Fail-closed user scoping (ADR-007 Q4): USER.md cards without an unambiguous user binding are reported, never written. */
  const unresolvedUserCards = (userCards: string[]) => {
    unresolvedUserScopeCount += userCards.length;
    for (let i = 0; i < userCards.length; i++) {
      const uc = userCards[i];
      if (!uc) continue;
      const key = cardIdempotencyKey("openclaw", agentId, "USER.md", uc);
      cardResults.push({
        idempotencyKey: key,
        outcome: "unresolved-user-scope",
        reason: "unambiguous-user-required",
      });
      if (isApply && ledger) {
        const sha = createHash("sha256").update(uc.replace(/\r\n/g, "\n").trim()).digest("hex");
        ledger.record({
          entity: "memory",
          idempotencyKey: key,
          action: "skipped",
          sourceRef: `openclaw:${agentId}:USER.md#${i + 1}${runSuffix}`,
          targetRef: `agents/${agentId}/workspace/USER.md`,
          sha256: sha,
          reason: "unambiguous-user-required",
        });
      }
    }
  };

  // Agent whose own store is not in the harness yet (re-embedding migration, or not taken over): its cards are parked, never
  // embedded now (they would land in a vector space the store is not in, or create a partition that blocks the take-over).
  if (opts.ownStore?.kind === "park") {
    const park = opts.ownStore;
    const { outcome: parkOutcome, reason: parkReason } = park;
    for (const [names, file] of [[["MEMORY.md", "memory.md"], "MEMORY.md"], [["USER.md", "user.md"], "USER.md"]] as const) {
      const found = names.map((n) => join(workspaceDir, n)).find((cand) => existsNoFollow(cand));
      if (found === undefined) continue;
      let content: string;
      try {
        content = readSourceTextSafe(found, MAX_MEMORY_FILE_BYTES);
      } catch (error) {
        errors.push({ sourceRef: `${agentId}:${file}`, reason: error instanceof ImportError ? error.reason : "source-unreadable" });
        continue;
      }
      const cards = splitOpenclawCards(content);
      totalCards += cards.length;
      // ADR-007 Q4 comes first: without a user binding USER.md is never imported, so it is not parked for later either.
      if (file === "USER.md" && !userPrincipal) {
        unresolvedUserCards(cards);
        continue;
      }
      if (parkOutcome === "pending-reembed") pendingReembedCount += cards.length;
      else deferredCount += cards.length;
      cards.forEach((text, i) => {
        const key = cardIdempotencyKey("openclaw", agentId, file, text);
        cardResults.push({ idempotencyKey: key, outcome: parkOutcome, reason: parkReason });
        if (isApply) {
          recordParkedCard(ledger, park, {
            idempotencyKey: key,
            text,
            sourceRef: `openclaw:${agentId}:${file}#${i + 1}${runSuffix}`,
            targetRef: `agents/${agentId}/workspace/${file === "MEMORY.md" ? "memories.md" : "USER.md"}`,
          });
        }
      });
    }
    return summary();
  }

  // Agent whose own store is in the harness (taken over or matched): a card that is already there is linked, not written
  // again. Apply only: a dry run has no target store to compare against (it plans every new card as created).
  const linker = createCardLinker({
    engine, agentId, isApply, mode: opts.ownStore, ledger,
    // No proof either way: the card is imported (never dropped), the failed check is reported.
    onError: (sourceRef, reason) => errors.push({ sourceRef, reason }),
  });
  /** Splits the cards the engine would create into duplicates of a memory already in the store (linked) and the rest. */
  const linkDuplicates = (batch: LinkCandidate[], bind: Principal, fileRef: string): Promise<Map<string, CardLink>> =>
    linker.split(batch, { request: bind, caller: bind }, fileRef);
  /** Reports the linked cards of one batch. A second copy of a linked card in the same file is what the engine reports for
   *  an in-batch duplicate (matched-existing), never a second link (same rule as the Hermes importer). */
  const recordLinked = async (fullBatch: LinkCandidate[], linked: Map<string, CardLink>, bind: Principal, targetRefFile: string) => {
    for (const c of fullBatch) {
      const hit = linked.get(c.idempotencyKey);
      if (!hit) continue;
      if (c.isDuplicateInRun) {
        skippedDuplicateCount++;
        cardResults.push({ idempotencyKey: c.idempotencyKey, outcome: "matched-existing", reason: "duplicate-in-batch" });
        continue;
      }
      const done = await linker.link(c, hit, bind, targetRefFile);
      linkedCount++;
      cardResults.push({
        idempotencyKey: c.idempotencyKey, outcome: "linked", reason: done.reason, linkedTo: done.id,
        ...(done.linkId !== undefined ? { linkId: done.linkId } : {}),
      });
    }
  };

  // 1. Process MEMORY.md / memory.md (agent-scoped)
  let memoryMdPath: string | null = null;
  for (const cand of [join(workspaceDir, "MEMORY.md"), join(workspaceDir, "memory.md")]) {
    if (existsNoFollow(cand)) {
      memoryMdPath = cand;
      break;
    }
  }

  if (memoryMdPath !== null) {
    let content: string | null = null;
    try {
      content = readSourceTextSafe(memoryMdPath, MAX_MEMORY_FILE_BYTES);
    } catch (error) {
      errors.push({ sourceRef: `${agentId}:MEMORY.md`, reason: error instanceof ImportError ? error.reason : "source-unreadable" });
    }
    if (content !== null) {
      const rawCards = splitOpenclawCards(content);
      totalCards += rawCards.length;

      const seenKeysInRun = new Set<string>();
      const cardInputs: Array<{
        idempotencyKey: string;
        text: string;
        provenance: "imported";
        sourceRef: string;
        scope: "agent-private";
        isDuplicateInRun: boolean;
      }> = [];

      for (let i = 0; i < rawCards.length; i++) {
        const cardText = rawCards[i];
        if (!cardText) continue;
        const key = cardIdempotencyKey("openclaw", agentId, "MEMORY.md", cardText);
        const isDuplicateInRun = seenKeysInRun.has(key);
        seenKeysInRun.add(key);
        cardInputs.push({
          idempotencyKey: key,
          text: cardText,
          provenance: "imported",
          sourceRef: `openclaw:${agentId}:MEMORY.md#${i + 1}${runSuffix}`,
          scope: "agent-private",
          isDuplicateInRun,
        });
      }

      if (!engine && !isApply) {
        // Pure dry-run preview without engine: compute planned counts directly
        for (const c of cardInputs) {
          if (c.isDuplicateInRun) {
            skippedDuplicateCount++;
            cardResults.push({
              idempotencyKey: c.idempotencyKey,
              outcome: "matched-existing",
              reason: "duplicate-in-batch",
            });
          } else {
            importedCount++;
            cardResults.push({
              idempotencyKey: c.idempotencyKey,
              outcome: "created",
            });
          }
        }
      } else if (engine) {
        // Chunk into batches of at most 500 cards
        for (let b = 0; b < cardInputs.length; b += IMPORT_CARD_BATCH_LIMIT) {
          const batchIdx = Math.floor(b / IMPORT_CARD_BATCH_LIMIT);
          const fullBatch = cardInputs.slice(b, b + IMPORT_CARD_BATCH_LIMIT);
          const linked = await linkDuplicates(fullBatch, principal, "MEMORY.md");
          await recordLinked(fullBatch, linked, principal, `agents/${agentId}/workspace/memories.md`);
          const batch = fullBatch.filter((c) => !linked.has(c.idempotencyKey));
          if (batch.length === 0) continue;

          let result: any;
          try {
            result = await engine.memory.import(
              {
                agentId,
                principal,
                cards: batch.map(({ idempotencyKey, text, provenance, sourceRef, scope }) => ({
                  idempotencyKey,
                  text,
                  provenance,
                  sourceRef,
                  scope,
                })),
                dryRun: !isApply,
              },
              principal,
              systemAgent,
            );
          } catch (err: any) {
            const code = importErrorCode(err);
            errors.push({
              sourceRef: `${agentId}:MEMORY.md#batch-${batchIdx}`,
              reason: `memory-import-failed:${code}`,
            });
            rejectedCount += batch.length;
            for (const batchCard of batch) {
              cardResults.push({
                idempotencyKey: batchCard.idempotencyKey,
                outcome: "rejected",
                reason: code,
              });
            }
            continue;
          }

          let batchCreated = result.created;
          let batchMatchedExisting = result.matchedExisting;
          let batchRejected = result.rejected;

          // Grok engine #217 edge case: duplicate-in-batch reported under rejected
          const cards = result.cards ?? [];
          for (const cr of cards) {
            if (cr.outcome === "rejected" && cr.reason === "duplicate-in-batch") {
              batchMatchedExisting++;
              if (batchRejected > 0) batchRejected--;
            }
          }

          importedCount += batchCreated;
          skippedDuplicateCount += batchMatchedExisting;
          rejectedCount += batchRejected;

          for (const cr of cards) {
            const outcome = cr.outcome === "rejected" && cr.reason === "duplicate-in-batch"
              ? "matched-existing"
              : cr.outcome;
            cardResults.push({
              idempotencyKey: cr.idempotencyKey,
              outcome,
              reason: cr.reason,
            });
          }

          // Record in ledger
          if (isApply && ledger) {
            for (let j = 0; j < batch.length; j++) {
              const batchCard = batch[j]!;
              const cr = cards.find((c: any) => c.idempotencyKey === batchCard.idempotencyKey);
              let cardOutcome = cr?.outcome ?? (batchCard.isDuplicateInRun ? "matched-existing" : "created");
              if (cardOutcome === "rejected" && cr?.reason === "duplicate-in-batch") {
                cardOutcome = "matched-existing";
              }
              const sha = createHash("sha256").update(batchCard.text.replace(/\r\n/g, "\n").trim()).digest("hex");
              ledger.record({
                entity: "memory",
                idempotencyKey: batchCard.idempotencyKey,
                action: cardOutcome === "created" ? "created" : cardOutcome === "matched-existing" ? "matched-existing" : "rejected",
                sourceRef: batchCard.sourceRef,
                targetRef: `agents/${agentId}/workspace/memories.md`,
                sha256: sha,
                reason: cr?.reason,
              });
            }
          }
        }
      }
    }
  }

  // 2. Process USER.md / user.md (user-scoped)
  let userMdPath: string | null = null;
  for (const cand of [join(workspaceDir, "USER.md"), join(workspaceDir, "user.md")]) {
    if (existsNoFollow(cand)) {
      userMdPath = cand;
      break;
    }
  }

  if (userMdPath !== null) {
    let content: string | null = null;
    try {
      content = readSourceTextSafe(userMdPath, MAX_MEMORY_FILE_BYTES);
    } catch (error) {
      errors.push({ sourceRef: `${agentId}:USER.md`, reason: error instanceof ImportError ? error.reason : "source-unreadable" });
    }
    if (content !== null) {
      const userCards = splitOpenclawCards(content);
      totalCards += userCards.length;

      // Fail-closed user scoping (ADR-007 Q4): require unambiguous user binding
      if (!userPrincipal) {
        unresolvedUserCards(userCards);
      } else {
        // Proved user provided: import as user-scope cards
        const userScopePrincipal: Principal = {
          ...principal,
          user: userPrincipal.user ?? userPrincipal.userId,
        };

        const seenKeysInRun = new Set<string>();
        const userCardInputs = userCards.map((text, i) => {
          const key = cardIdempotencyKey("openclaw", agentId, "USER.md", text);
          const isDuplicateInRun = seenKeysInRun.has(key);
          seenKeysInRun.add(key);
          return {
            idempotencyKey: key,
            text,
            provenance: "imported" as const,
            sourceRef: `openclaw:${agentId}:USER.md#${i + 1}${runSuffix}`,
            scope: "user" as const,
            isDuplicateInRun,
          };
        });

        if (!engine && !isApply) {
          for (const c of userCardInputs) {
            if (c.isDuplicateInRun) {
              skippedDuplicateCount++;
              cardResults.push({ idempotencyKey: c.idempotencyKey, outcome: "matched-existing", reason: "duplicate-in-batch" });
            } else {
              importedCount++;
              cardResults.push({ idempotencyKey: c.idempotencyKey, outcome: "created" });
            }
          }
        } else if (engine) {
          for (let b = 0; b < userCardInputs.length; b += IMPORT_CARD_BATCH_LIMIT) {
            const batchIdx = Math.floor(b / IMPORT_CARD_BATCH_LIMIT);
            const fullBatch = userCardInputs.slice(b, b + IMPORT_CARD_BATCH_LIMIT);
            const linked = await linkDuplicates(fullBatch, userScopePrincipal, "USER.md");
            await recordLinked(fullBatch, linked, userScopePrincipal, `agents/${agentId}/workspace/USER.md`);
            const batch = fullBatch.filter((c) => !linked.has(c.idempotencyKey));
            if (batch.length === 0) continue;

            let result: any;
            try {
              result = await engine.memory.import(
                {
                  agentId,
                  principal: userScopePrincipal,
                  cards: batch.map(({ idempotencyKey, text, provenance, sourceRef, scope }) => ({
                    idempotencyKey,
                    text,
                    provenance,
                    sourceRef,
                    scope,
                  })),
                  dryRun: !isApply,
                },
                userScopePrincipal,
                systemAgent,
              );
            } catch (err: any) {
              const code = importErrorCode(err);
              errors.push({ sourceRef: `${agentId}:USER.md#batch-${batchIdx}`, reason: `memory-import-failed:${code}` });
              rejectedCount += batch.length;
              for (const batchCard of batch) {
                cardResults.push({ idempotencyKey: batchCard.idempotencyKey, outcome: "rejected", reason: code });
              }
              continue;
            }

            let batchCreated = result.created;
            let batchMatchedExisting = result.matchedExisting;
            let batchRejected = result.rejected;
            const cards = result.cards ?? [];
            for (const cr of cards) {
              if (cr.outcome === "rejected" && cr.reason === "duplicate-in-batch") {
                batchMatchedExisting++;
                if (batchRejected > 0) batchRejected--;
              }
            }

            importedCount += batchCreated;
            skippedDuplicateCount += batchMatchedExisting;
            rejectedCount += batchRejected;

            for (const cr of cards) {
              const outcome = cr.outcome === "rejected" && cr.reason === "duplicate-in-batch" ? "matched-existing" : cr.outcome;
              cardResults.push({ idempotencyKey: cr.idempotencyKey, outcome, reason: cr.reason });
            }

            if (isApply && ledger) {
              for (const batchCard of batch) {
                const cr = cards.find((c: any) => c.idempotencyKey === batchCard.idempotencyKey);
                let cardOutcome = cr?.outcome ?? (batchCard.isDuplicateInRun ? "matched-existing" : "created");
                if (cardOutcome === "rejected" && cr?.reason === "duplicate-in-batch") cardOutcome = "matched-existing";
                const sha = createHash("sha256").update(batchCard.text.replace(/\r\n/g, "\n").trim()).digest("hex");
                ledger.record({
                  entity: "memory",
                  idempotencyKey: batchCard.idempotencyKey,
                  action: cardOutcome === "created" ? "created" : cardOutcome === "matched-existing" ? "matched-existing" : "rejected",
                  sourceRef: batchCard.sourceRef,
                  targetRef: `agents/${agentId}/workspace/USER.md`,
                  sha256: sha,
                  reason: cr?.reason,
                });
              }
            }
          }
        }
      }
    }
  }

  return summary();
}
