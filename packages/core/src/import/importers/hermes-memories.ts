// Hermes memory cards migration via Engine.memory.import (docs/import.md §3.2, M7 Batch 3).
// Splits memories/MEMORY.md and memories/USER.md on \n§\n delimiter.
// Normalizes CRLF, discards whitespace-only cards, enforces <= 500 cards batch limit.
// Idempotency keys are deterministic from (profile, sourceFile, cardHash), never from runId.
// USER.md cards are reported as unresolved-user-scope unless an unambiguous user principal is provided.
// Generates curated memories.md and USER.md markdown mirrors in l.workspaceDir(agentId) for imported cards,
// routed through the conflict strategy (skip/rename/replace).
// Errors from memory.import are tracked in errors[] and counted as rejected, never swallowed.
// NEVER writes directly to LanceDB or imports external vector store libraries.
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { basename, dirname, join, relative } from "node:path";
import type { Layout } from "../../paths.ts";
import {
  cardIdempotencyKey,
  fileIdempotencyKey,
  memoryBatchIdempotencyKey,
  type ConflictStrategy,
  type ImportLedger,
} from "../ledger.ts";
import { writeAtomicSync } from "../fs-atomic.ts";
import { existsNoFollow, readHermesSourceFileSafe } from "./hermes-fs-safe.ts";
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

/** A reason code only (never message text, which could echo card content): a short token, else "storage". */
function importErrorCode(err: any): string {
  const raw = err?.code ?? err?.reason;
  return typeof raw === "string" && /^[A-Za-z0-9_.-]{1,64}$/.test(raw) ? raw : "storage";
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
  errors: Array<{ sourceRef: string; reason: string }>;
}

function writeMirrorWithConflict(opts: {
  targetPath: string;
  content: string;
  relTarget: string;
  sourceRef: string;
  agentId: string;
  onConflict: ConflictStrategy;
  replacedBackupDir?: string | undefined;
  ledger?: ImportLedger | undefined;
  l: Layout;
}): void {
  const { targetPath, content, relTarget, sourceRef, agentId, onConflict, replacedBackupDir, ledger, l } = opts;
  const sha = createHash("sha256").update(content).digest("hex");

  if (!existsSync(targetPath)) {
    writeAtomicSync(targetPath, content, 0o600);
    if (ledger) {
      ledger.record({
        entity: "file",
        idempotencyKey: fileIdempotencyKey(agentId, relTarget, sha),
        action: "created",
        sourceRef,
        targetRef: relative(l.home, targetPath).replaceAll("\\", "/"),
        sha256: sha,
      });
    }
    return;
  }

  // Target exists: check if content matches
  let existingContent = "";
  try {
    existingContent = readFileSync(targetPath, "utf8");
  } catch {
    existingContent = "";
  }
  const existingSha = createHash("sha256").update(existingContent).digest("hex");
  if (existingSha === sha) {
    if (ledger) {
      ledger.record({
        entity: "file",
        idempotencyKey: fileIdempotencyKey(agentId, relTarget, sha),
        action: "matched-existing",
        sourceRef,
        targetRef: relative(l.home, targetPath).replaceAll("\\", "/"),
        sha256: sha,
      });
    }
    return;
  }

  // Content differs: apply conflict strategy
  if (onConflict === "skip") {
    if (ledger) {
      ledger.record({
        entity: "file",
        idempotencyKey: fileIdempotencyKey(agentId, relTarget, sha),
        action: "conflict-skip",
        sourceRef,
        targetRef: relative(l.home, targetPath).replaceAll("\\", "/"),
        sha256: sha,
        reason: "content-differs",
      });
    }
    return;
  }

  if (onConflict === "replace") {
    if (replacedBackupDir) {
      const rel = relative(l.home, targetPath).replaceAll("\\", "/");
      const bkp = join(replacedBackupDir, rel);
      mkdirSync(dirname(bkp), { recursive: true, mode: 0o700 });
      writeAtomicSync(bkp, existingContent, 0o600);
    }
    writeAtomicSync(targetPath, content, 0o600);
    if (ledger) {
      ledger.record({
        entity: "file",
        idempotencyKey: fileIdempotencyKey(agentId, relTarget, sha),
        action: "replace",
        sourceRef,
        targetRef: relative(l.home, targetPath).replaceAll("\\", "/"),
        sha256: sha,
      });
    }
    return;
  }

  if (onConflict === "rename") {
    const dir = dirname(targetPath);
    const ext = ".md";
    const base = basename(targetPath, ext);
    let idx = 1;
    let renamePath = join(dir, `${base}.imported${ext}`);
    while (existsSync(renamePath)) {
      idx++;
      renamePath = join(dir, `${base}.imported-${idx}${ext}`);
    }
    writeAtomicSync(renamePath, content, 0o600);
    if (ledger) {
      ledger.record({
        entity: "file",
        idempotencyKey: fileIdempotencyKey(agentId, relative(l.workspaceDir(agentId), renamePath), sha),
        action: "rename",
        sourceRef,
        targetRef: relative(l.home, renamePath).replaceAll("\\", "/"),
        sha256: sha,
      });
    }
  }
}

export async function importHermesMemories(opts: {
  profileDir: string;
  profileName: string;
  agentId: string;
  l: Layout;
  engine?: Engine | undefined;
  isApply: boolean;
  ledger?: ImportLedger | undefined;
  userPrincipal?: any | undefined;
  onConflict?: ConflictStrategy | undefined;
  replacedBackupDir?: string | undefined;
}): Promise<HermesMemoryImportResult> {
  const {
    profileDir,
    profileName,
    agentId,
    l,
    engine,
    isApply,
    ledger,
    userPrincipal,
    onConflict = "skip",
    replacedBackupDir,
  } = opts;

  let totalCards = 0;
  let importedCount = 0;
  let skippedDuplicateCount = 0;
  let rejectedCount = 0;
  let unresolvedUserScopeCount = 0;
  const cardResults: HermesMemoryImportResult["cardResults"] = [];
  const errors: Array<{ sourceRef: string; reason: string }> = [];

  const successfulMemoryTexts: string[] = [];
  const successfulUserTexts: string[] = [];
  // A file with any failed batch gets no mirror: a partial mirror would later conflict with the complete one.
  let memoryBatchFailed = false;
  let userBatchFailed = false;

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
  if (existsNoFollow(memoryMdPath)) {
    const readRes = readHermesSourceFileSafe(memoryMdPath, MAX_MEMORY_FILE_BYTES);
    if (!readRes.ok) {
      errors.push({ sourceRef: `${profileName}:memories/MEMORY.md`, reason: readRes.error });
    } else {
      const rawCards = splitHermesCards(readRes.content);
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
        const key = cardIdempotencyKey("hermes", profileName, "memories/MEMORY.md", cardText);
        const isDuplicateInRun = seenKeysInRun.has(key);
        seenKeysInRun.add(key);
        cardInputs.push({
          idempotencyKey: key,
          text: cardText,
          provenance: "imported",
          sourceRef: `hermes:${profileName}:memories/MEMORY.md#${i + 1}`,
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
            successfulMemoryTexts.push(c.text);
          }
        }
      } else if (engine) {
        // Chunk into batches of at most 500 cards
        for (let b = 0; b < cardInputs.length; b += IMPORT_CARD_BATCH_LIMIT) {
          const batchIdx = Math.floor(b / IMPORT_CARD_BATCH_LIMIT);
          const batch = cardInputs.slice(b, b + IMPORT_CARD_BATCH_LIMIT);

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
              sourceRef: `${profileName}:memories/MEMORY.md#batch-${batchIdx}`,
              reason: `memory-import-failed:${code}`,
            });
            memoryBatchFailed = true;
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

          // Grok engine #217 edge case: if engine reports duplicate-in-batch cards under rejected,
          // attribute them to matchedExisting instead of rejected
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

          for (let j = 0; j < cards.length; j++) {
            const cr = cards[j];
            const batchCard = batch[j];
            if (!cr || !batchCard) continue;
            const effectiveOutcome = (cr.outcome === "rejected" && cr.reason === "duplicate-in-batch")
              ? "matched-existing"
              : cr.outcome;
            cardResults.push({
              idempotencyKey: cr.idempotencyKey,
              outcome: effectiveOutcome,
              reason: cr.reason,
            });

            if (effectiveOutcome === "created" || effectiveOutcome === "matched-existing") {
              successfulMemoryTexts.push(batchCard.text);
            }
          }

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
  }

  // 2. Process memories/USER.md
  // ADR-007 Q4: without an unambiguous user binding, USER.md memories are NOT imported to LanceDB.
  // They are reported as unresolved-user-scope.
  const userMdPath = join(profileDir, "memories", "USER.md");
  if (existsNoFollow(userMdPath)) {
    const readRes = readHermesSourceFileSafe(userMdPath, MAX_MEMORY_FILE_BYTES);
    if (!readRes.ok) {
      errors.push({ sourceRef: `${profileName}:memories/USER.md`, reason: readRes.error });
    } else {
      const userCards = splitHermesCards(readRes.content);
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

        if (!engine && !isApply) {
          for (const c of cardInputs) {
            importedCount++;
            cardResults.push({
              idempotencyKey: c.idempotencyKey,
              outcome: "created",
            });
            successfulUserTexts.push(c.text);
          }
        } else if (engine) {
          for (let b = 0; b < cardInputs.length; b += IMPORT_CARD_BATCH_LIMIT) {
            const batchIdx = Math.floor(b / IMPORT_CARD_BATCH_LIMIT);
            const batch = cardInputs.slice(b, b + IMPORT_CARD_BATCH_LIMIT);

            let result: any;
            try {
              result = await engine.memory.import(
                {
                  agentId,
                  principal: userPrincipal,
                  cards: batch,
                  dryRun: !isApply,
                },
                principal,
                systemAgent,
              );
            } catch (err: any) {
              const code = importErrorCode(err);
              errors.push({
                sourceRef: `${profileName}:memories/USER.md#batch-${batchIdx}`,
                reason: `memory-import-failed:${code}`,
              });
              userBatchFailed = true;
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

            importedCount += result.created;
            skippedDuplicateCount += result.matchedExisting;
            rejectedCount += result.rejected;

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
                successfulUserTexts.push(batchCard.text);
              }
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

  // 3. Write curated markdown mirrors in l.workspaceDir(agentId)
  // Only from cards that were actually created or matched-existing in the store
  if (isApply) {
    const wsDir = l.workspaceDir(agentId);
    if (existsSync(wsDir)) {
      if (successfulMemoryTexts.length > 0 && !memoryBatchFailed) {
        const mirrorContent = successfulMemoryTexts.join("\n\n§\n\n") + "\n";
        writeMirrorWithConflict({
          targetPath: join(wsDir, "memories.md"),
          content: mirrorContent,
          relTarget: "workspace/memories.md",
          sourceRef: "memories/MEMORY.md",
          agentId,
          onConflict,
          replacedBackupDir,
          ledger,
          l,
        });
      }

      if (successfulUserTexts.length > 0 && !userBatchFailed) {
        const userMirrorContent = successfulUserTexts.join("\n\n§\n\n") + "\n";
        writeMirrorWithConflict({
          targetPath: join(wsDir, "USER.md"),
          content: userMirrorContent,
          relTarget: "workspace/USER.md",
          sourceRef: "memories/USER.md",
          agentId,
          onConflict,
          replacedBackupDir,
          ledger,
          l,
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
    errors,
  };
}
