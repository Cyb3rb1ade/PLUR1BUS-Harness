// Hermes memory cards migration via Engine.memory.import (docs/import.md §3.2, M7 Batch 3).
// Splits memories/MEMORY.md and memories/USER.md on \n§\n delimiter.
// Normalizes CRLF, discards whitespace-only cards, enforces <= 500 cards batch limit.
// Idempotency keys are deterministic from (profile, sourceFile, cardHash), never from runId.
// USER.md cards are reported as unresolved-user-scope unless an unambiguous user principal is provided.
// Generates curated memories.md markdown mirror in l.workspaceDir(agentId) for imported cards.
// NEVER writes directly to LanceDB or imports external vector store libraries.
import { createHash } from "node:crypto";
import { existsSync, lstatSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Layout } from "../../paths.ts";
import { isFile, readBounded } from "../readonly.ts";
import {
  cardIdempotencyKey,
  fileIdempotencyKey,
  memoryBatchIdempotencyKey,
  type ImportLedger,
} from "../ledger.ts";
import { writeAtomicSync } from "../fs-atomic.ts";
import type { Engine, Principal } from "@cyb3rb1ade/plur1bus-memory/types/engine.js";

export const IMPORT_CARD_BATCH_LIMIT = 500;
export const MAX_MEMORY_FILE_BYTES = 16 * 1024 * 1024; // 16 MiB

export function splitHermesCards(content: string): string[] {
  if (!content) return [];
  // Normalize CRLF to LF
  const normalized = content.replace(/\r\n/g, "\n");
  // Split on \n§\n, leading §\n, trailing \n§, or isolated §
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

export interface HermesMemoryImportResult {
  importedCount: number;
  skippedDuplicateCount: number;
  rejectedCount: number;
  unresolvedUserScopeCount: number;
  totalCards: number;
  cardResults: Array<{
    idempotencyKey: string;
    outcome: "created" | "matched-existing" | "rejected";
    reason?: string | undefined;
  }>;
}

export async function importHermesMemories(opts: {
  profileDir: string;
  profileName: string;
  agentId: string;
  l: Layout;
  engine: Engine;
  isApply: boolean;
  ledger?: ImportLedger | undefined;
  userPrincipal?: any | undefined;
}): Promise<HermesMemoryImportResult> {
  const { profileDir, profileName, agentId, l, engine, isApply, ledger, userPrincipal } = opts;

  let totalCards = 0;
  let importedCount = 0;
  let skippedDuplicateCount = 0;
  let rejectedCount = 0;
  let unresolvedUserScopeCount = 0;
  const cardResults: HermesMemoryImportResult["cardResults"] = [];

  const successfulMemoryTexts: string[] = [];

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

  // 1. Process memories/MEMORY.md (agent-scoped)
  const memoryMdPath = join(profileDir, "memories", "MEMORY.md");
  if (isFile(memoryMdPath)) {
    try {
      const st = lstatSync(memoryMdPath);
      if (!st.isSymbolicLink()) {
        const text = readBounded(memoryMdPath, MAX_MEMORY_FILE_BYTES);
        if (text) {
          const rawCards = splitHermesCards(text);
          totalCards += rawCards.length;

          // Prepare card inputs with deterministic idempotency keys
          const cardInputs: Array<{
            idempotencyKey: string;
            text: string;
            provenance: "imported";
            sourceRef: string;
            scope: "agent-private";
          }> = [];

          for (let i = 0; i < rawCards.length; i++) {
            const cardText = rawCards[i];
            if (!cardText) continue;
            const key = cardIdempotencyKey("hermes", profileName, "memories/MEMORY.md", cardText);
            cardInputs.push({
              idempotencyKey: key,
              text: cardText,
              provenance: "imported",
              sourceRef: `hermes:${profileName}:memories/MEMORY.md#${i + 1}`,
              scope: "agent-private",
            });
          }

          // Chunk into batches of at most 500 cards
          for (let b = 0; b < cardInputs.length; b += IMPORT_CARD_BATCH_LIMIT) {
            const batchIdx = Math.floor(b / IMPORT_CARD_BATCH_LIMIT);
            const batch = cardInputs.slice(b, b + IMPORT_CARD_BATCH_LIMIT);

            const result = await engine.memory.import(
              {
                agentId,
                principal,
                cards: batch,
                dryRun: !isApply,
              },
              principal,
              systemAgent,
            );

            importedCount += result.created;
            skippedDuplicateCount += result.matchedExisting;
            rejectedCount += result.rejected;

            // Track card results
            for (let j = 0; j < result.cards.length; j++) {
              const cr = result.cards[j];
              const batchCard = batch[j];
              if (!cr || !batchCard) continue;
              cardResults.push({
                idempotencyKey: cr.idempotencyKey,
                outcome: cr.outcome,
                reason: cr.reason,
              });

              if (cr.outcome === "created" || cr.outcome === "matched-existing") {
                successfulMemoryTexts.push(batchCard.text);
              }
            }

            // Record batch in ledger if applying
            if (isApply && ledger) {
              const keysCombined = batch.map((c) => c.idempotencyKey).join(";");
              const keysHash = createHash("sha256").update(keysCombined).digest("hex").slice(0, 16);
              const batchAction =
                result.created > 0
                  ? "created"
                  : result.matchedExisting > 0
                  ? "matched-existing"
                  : "rejected";

              ledger.record({
                entity: "memory",
                idempotencyKey: memoryBatchIdempotencyKey(agentId, batchIdx, keysHash),
                action: batchAction,
                sourceRef: `memories/MEMORY.md#batch-${batchIdx}`,
                details: {
                  batchIndex: batchIdx,
                  count: batch.length,
                  created: result.created,
                  matchedExisting: result.matchedExisting,
                  rejected: result.rejected,
                  keysHash,
                },
              });
            }
          }
        }
      }
    } catch {
      // Memory read error handled safely
    }
  }

  // 2. Process memories/USER.md
  // ADR-007 Q4: without an unambiguous user binding, USER.md memories are NOT imported to LanceDB.
  // They are reported as unresolved-user-scope.
  const userMdPath = join(profileDir, "memories", "USER.md");
  if (isFile(userMdPath)) {
    try {
      const st = lstatSync(userMdPath);
      if (!st.isSymbolicLink()) {
        const text = readBounded(userMdPath, MAX_MEMORY_FILE_BYTES);
        if (text) {
          const userCards = splitHermesCards(text);
          totalCards += userCards.length;

          if (userPrincipal) {
            // Explicit user binding provided: import to user scope
            const cardInputs = userCards.map((cardText, i) => ({
              idempotencyKey: cardIdempotencyKey("hermes", profileName, "memories/USER.md", cardText),
              text: cardText,
              provenance: "imported" as const,
              sourceRef: `hermes:${profileName}:memories/USER.md#${i + 1}`,
              scope: "user" as const,
            }));

            for (let b = 0; b < cardInputs.length; b += IMPORT_CARD_BATCH_LIMIT) {
              const batchIdx = Math.floor(b / IMPORT_CARD_BATCH_LIMIT);
              const batch = cardInputs.slice(b, b + IMPORT_CARD_BATCH_LIMIT);

              const result = await engine.memory.import(
                {
                  agentId,
                  principal: userPrincipal,
                  cards: batch,
                  dryRun: !isApply,
                },
                principal,
                systemAgent,
              );

              importedCount += result.created;
              skippedDuplicateCount += result.matchedExisting;
              rejectedCount += result.rejected;

              for (const cr of result.cards) {
                cardResults.push({
                  idempotencyKey: cr.idempotencyKey,
                  outcome: cr.outcome,
                  reason: cr.reason,
                });
              }

              if (isApply && ledger) {
                const keysCombined = batch.map((c) => c.idempotencyKey).join(";");
                const keysHash = createHash("sha256").update(keysCombined).digest("hex").slice(0, 16);
                ledger.record({
                  entity: "memory",
                  idempotencyKey: memoryBatchIdempotencyKey(agentId, 1000 + batchIdx, keysHash),
                  action: result.created > 0 ? "created" : "matched-existing",
                  sourceRef: `memories/USER.md#batch-${batchIdx}`,
                  details: {
                    batchIndex: batchIdx,
                    count: batch.length,
                    created: result.created,
                    matchedExisting: result.matchedExisting,
                    rejected: result.rejected,
                    keysHash,
                  },
                });
              }
            }
          } else {
            // No unambiguous user binding: fail-closed per ADR-007 Q4
            unresolvedUserScopeCount += userCards.length;
            for (let i = 0; i < userCards.length; i++) {
              const uc = userCards[i];
              if (!uc) continue;
              const key = cardIdempotencyKey("hermes", profileName, "memories/USER.md", uc);
              cardResults.push({
                idempotencyKey: key,
                outcome: "rejected",
                reason: "unresolved-user-scope",
              });
            }
          }
        }
      }
    } catch {
      // Ignored
    }
  }

  // 3. Write curated markdown mirror to l.workspaceDir(agentId)/memories.md
  // Only from cards that were actually created or matched-existing in the store
  if (isApply && successfulMemoryTexts.length > 0) {
    const wsDir = l.workspaceDir(agentId);
    if (existsSync(wsDir)) {
      const mirrorContent = successfulMemoryTexts.join("\n\n§\n\n") + "\n";
      const mirrorPath = join(wsDir, "memories.md");
      const sha = createHash("sha256").update(mirrorContent).digest("hex");
      writeAtomicSync(mirrorPath, mirrorContent, 0o600);

      if (ledger) {
        ledger.record({
          entity: "file",
          idempotencyKey: fileIdempotencyKey(agentId, "workspace/memories.md", sha),
          action: "created",
          sourceRef: "memories/MEMORY.md",
          targetRef: `agents/${agentId}/workspace/memories.md`,
          sha256: sha,
        });
      }
    }
  }

  return {
    importedCount,
    skippedDuplicateCount,
    rejectedCount,
    unresolvedUserScopeCount,
    totalCards,
    cardResults,
  };
}
