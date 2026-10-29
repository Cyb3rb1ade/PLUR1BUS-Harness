import { SourceReader } from "../source-reader.ts";
import { importCheckpoint, type ImportExecutionOptions } from "../execution.ts";
// Hermes memory cards migration via Engine.memory.import (docs/import.md §3.2, M7 Batch 3).
// Splits memories/MEMORY.md and memories/USER.md on \n§\n delimiter.
// Normalizes CRLF, discards whitespace-only cards, enforces <= 500 cards batch limit.
// Idempotency keys are deterministic from (profile, sourceFile, cardHash), never from runId.
// USER.md cards are reported as unresolved-user-scope unless an unambiguous user principal is provided.
// Generates memory/KNOWLEDGE.md and USER.md markdown mirrors in l.workspaceDir(agentId) for imported cards,
// routed through the conflict strategy (skip/rename/replace).
// Errors from memory.import are tracked in errors[] and counted as rejected, never swallowed.
// NEVER writes directly to LanceDB or imports external vector store libraries.
// A store named by --adopt-store (owner decision 2026-10-19, docs/import.md §10.3; the same rule as the OpenClaw cards, its
// building blocks shared in card-links.ts): store in the harness vector space -> a card already in it is linked, not
// written again; store routed to the re-embedding migration -> cards parked as "pending-reembed"; store not taken over for
// another reason -> cards "deferred". USER.md without a user binding stays unresolved-user-scope in every case (ADR-007 Q4).
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import { basename, dirname, join, relative } from "node:path";
import { assertKnowledgeTarget, formatImportedKnowledge, writeImportedKnowledge } from "../../knowledge/file.ts";
import type { Layout } from "../../paths.ts";
import {
  cardIdempotencyKey,
  fileIdempotencyKey,
  memoryBatchIdempotencyKey,
  type ConflictStrategy,
  type ImportLedger,
} from "../ledger.ts";
import { writeAtomicSync } from "../fs-atomic.ts";
import { existsNoFollow, readSourceFileSafe } from "../fs-safe.ts";
import { ImportError } from "../types.ts";
import { isOperationalCardRejection } from "../report-complete.ts";
import type { Engine, Principal } from "@cyb3rb1ade/plur1bus-memory/types/engine.js";
import { createCardLinker, recordParkedCard, type CardLink, type LinkCandidate, type OwnStoreCardMode } from "./card-links.ts";

export const IMPORT_CARD_BATCH_LIMIT = 500;
export const MAX_MEMORY_FILE_BYTES = 16 * 1024 * 1024; // 16 MiB

import { CARD_FILES, splitImportedCards as splitHermesCards } from "../card-source.ts";
export { splitImportedCards as splitHermesCards } from "../card-source.ts";

/** A reason code only (never message text, which could echo card content): a short token, else "storage". */
function importErrorCode(err: any): string {
  const raw = err?.code ?? err?.reason;
  return typeof raw === "string" && /^[A-Za-z0-9_.-]{1,64}$/.test(raw) ? raw : "storage";
}

/** Whether the profile holds a card the import would hand to the engine (MEMORY.md; USER.md only with a user binding). */
export async function hasHermesCardFiles(profileDir: string, userBinding: boolean, sourceReader?: SourceReader): Promise<boolean> {
  const reader = sourceReader ?? await SourceReader.local();
  return await reader.exists(reader.paths.join(profileDir, ...CARD_FILES.hermes[0][0][0].split("/"))) || userBinding && await reader.exists(reader.paths.join(profileDir, ...CARD_FILES.hermes[1][0][0].split("/")));
}

export interface HermesMemoryImportResult {
  importedCount: number;
  skippedDuplicateCount: number;
  rejectedCount: number;
  unresolvedUserScopeCount: number;
  totalCards: number;
  /** Cards that duplicate a memory already in the taken-over store: not written again, linked to it. */
  linkedCount: number;
  /** Cards parked while the taken-over store waits for the re-embedding migration (never in a foreign vector space). */
  pendingReembedCount: number;
  /** Cards of a store that was not taken over for another reason: written by a later run. */
  deferredCount: number;
  cardResults: Array<{
    idempotencyKey: string;
    outcome: "created" | "matched-existing" | "rejected" | "linked" | "pending-reembed" | "deferred";
    reason?: string | undefined;
    /** outcome "linked": the id of the memory the card duplicates. */
    linkedTo?: string | undefined;
    /** outcome "linked": the engine link id (`memory.link`, contract 1.16.0); absent for a ledger-only link. */
    linkId?: string | undefined;
  }>;
  errors: Array<{ sourceRef: string; reason: string }>;
}

/**
 * Writes one curated mirror file (memory/KNOWLEDGE.md / USER.md) under the conflict strategy. Returns a reason when the file was
 * deliberately left alone because of a problem the caller reports (`target-unreadable`: the existing file cannot be read,
 * so with --conflict replace its content could not be backed up and overwriting it would lose it), else undefined.
 */
export function writeMirrorWithConflict(opts: {
  targetPath: string;
  content: string;
  relTarget: string;
  sourceRef: string;
  legacyContent?: string;
  agentId: string;
  onConflict: ConflictStrategy;
  replacedBackupDir?: string | undefined;
  ledger?: ImportLedger | undefined;
  l: Layout;
}): "target-unreadable" | undefined {
  const { targetPath, content, relTarget, sourceRef, legacyContent, agentId, onConflict, replacedBackupDir, ledger, l } = opts;
  const canonicalKnowledge = relTarget === "workspace/memory/KNOWLEDGE.md";
  const workspace = l.workspaceDir(agentId);
  if (canonicalKnowledge) assertKnowledgeTarget(workspace, l.home);
  const writeTarget = (bytes: string) => {
    if (canonicalKnowledge) writeImportedKnowledge(workspace, bytes, l.home);
    else writeAtomicSync(targetPath, bytes, 0o600);
  };
  const sha = createHash("sha256").update(content).digest("hex");

  if (!existsSync(targetPath)) {
    writeTarget(content);
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
    return undefined;
  }

  // Target exists: check if content matches
  let existingContent = "";
  let unreadable = false;
  try {
    existingContent = readFileSync(targetPath, "utf8");
  } catch {
    unreadable = true;
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
    return undefined;
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
    return undefined;
  }

  if (onConflict === "replace") {
    if (unreadable) {
      // Never overwrite what cannot be read and so cannot be backed up (an empty backup would be a silent data loss).
      ledger?.record({
        entity: "file",
        idempotencyKey: fileIdempotencyKey(agentId, relTarget, sha),
        action: "conflict-skip",
        sourceRef,
        targetRef: relative(l.home, targetPath).replaceAll("\\", "/"),
        sha256: sha,
        reason: "target-unreadable",
      });
      return "target-unreadable";
    }
    if (replacedBackupDir) {
      const rel = relative(l.home, targetPath).replaceAll("\\", "/");
      const bkp = join(replacedBackupDir, rel);
      mkdirSync(dirname(bkp), { recursive: true, mode: 0o700 });
      writeAtomicSync(bkp, existingContent, 0o600);
    }
    writeTarget(content);
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
    return undefined;
  }

  if (onConflict === "rename") {
    const dir = dirname(targetPath);
    const ext = ".md";
    const base = basename(targetPath, ext);
    for (const name of readdirSync(dir).sort()) {
      if (name !== `${base}.imported${ext}` && !(name.startsWith(`${base}.imported-`) && name.endsWith(ext))) continue;
      const matchPath = join(dir, name);
      let existing: Buffer;
      try {
        existing = readSourceFileSafe(matchPath, Math.max(Buffer.byteLength(content), Buffer.byteLength(legacyContent ?? "")));
      } catch {
        continue;
      }
      const matchSha = createHash("sha256").update(existing).digest("hex");
      const legacySha = canonicalKnowledge && legacyContent !== undefined ? createHash("sha256").update(legacyContent).digest("hex") : null;
      if (matchSha === sha || matchSha === legacySha) {
        ledger?.record({
          entity: "file",
          idempotencyKey: fileIdempotencyKey(agentId, relative(l.workspaceDir(agentId), matchPath), matchSha),
          action: "matched-existing",
          sourceRef,
          targetRef: relative(l.home, matchPath).replaceAll("\\", "/"),
          sha256: matchSha,
        });
        return undefined;
      }
    }
    let idx = 1;
    let renamePath = join(dir, `${base}.imported-${idx}${ext}`);
    while (existsNoFollow(renamePath)) {
      idx++;
      renamePath = join(dir, `${base}.imported-${idx}${ext}`);
    }
    if (canonicalKnowledge) assertKnowledgeTarget(workspace, l.home);
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
  return undefined;
}

export async function importHermesMemories(opts: {
  reader?: SourceReader;
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
  /** Set when --adopt-store names a store (see OwnStoreCardMode); absent: no store, the plain import. */
  ownStore?: OwnStoreCardMode | undefined;
} & Pick<ImportExecutionOptions, "runId" | "signal" | "onProgress">): Promise<HermesMemoryImportResult> {
  const reader = opts.reader ?? await SourceReader.local();
  let completedBatches = 0;
  const checkpoint = () => importCheckpoint(opts, opts.runId ?? opts.ledger?.runId ?? "legacy", "memory", completedBatches++);
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
  let linkedCount = 0;
  let pendingReembedCount = 0;
  let deferredCount = 0;
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
  // The import run is part of the card's origin (provenance "imported" + source + run + time). The card id and the
  // idempotency key do not depend on it, so a re-run matches the existing card and keeps the first run's origin.
  const runSuffix = ledger ? `;run=${ledger.runId}` : "";

  const summary = (): HermesMemoryImportResult => ({
    importedCount, skippedDuplicateCount, rejectedCount, unresolvedUserScopeCount, totalCards, linkedCount, pendingReembedCount, deferredCount, cardResults, errors,
  });
  const unresolvedUserCards = (userCards: string[]) => {
    unresolvedUserScopeCount += userCards.length;
    for (const uc of userCards) {
      cardResults.push({ idempotencyKey: cardIdempotencyKey("hermes", profileName, "memories/USER.md", uc), outcome: "rejected", reason: "unresolved-user-scope" });
    }
  };

  // Store not in the harness vector space (re-embedding migration) or not taken over: the cards are parked, never embedded
  // now (they would land in a vector space the store is not in). The engine is not asked at all.
  if (opts.ownStore?.kind === "park") {
    const park = opts.ownStore;
    for (const [, file] of CARD_FILES.hermes) {
      const path = reader.paths.join(profileDir, ...file.split("/"));
      if (!await reader.exists(path)) continue;
      let content: string;
      try {
        content = await reader.text(path, MAX_MEMORY_FILE_BYTES);
      } catch (error) {
      SourceReader.refuseFatal(error);
        errors.push({ sourceRef: `${profileName}:${file}`, reason: error instanceof ImportError ? error.reason : "source-unreadable" });
        continue;
      }
      const cards = splitHermesCards(content);
      totalCards += cards.length;
      // ADR-007 Q4 comes first: without a user binding USER.md is never imported, so it is not parked for later either.
      if (file === "memories/USER.md" && !userPrincipal) {
        unresolvedUserCards(cards);
        continue;
      }
      if (park.outcome === "pending-reembed") pendingReembedCount += cards.length;
      else deferredCount += cards.length;
      cards.forEach((text, i) => {
        const key = cardIdempotencyKey("hermes", profileName, file, text);
        cardResults.push({ idempotencyKey: key, outcome: park.outcome, reason: park.reason });
        if (isApply) {
          recordParkedCard(ledger, park, {
            idempotencyKey: key,
            text,
            sourceRef: `hermes:${profileName}:${file}#${i + 1}${runSuffix}`,
            targetRef: `agents/${agentId}/workspace/${file === "memories/MEMORY.md" ? "memory/KNOWLEDGE.md" : "USER.md"}`,
          });
        }
      });
    }
    return summary();
  }

  // Store taken over into the harness vector space: a card already in it is linked, not written again (apply only).
  const linker = createCardLinker({
    engine, agentId, isApply, mode: opts.ownStore, ledger,
    // No proof either way: the card is imported (never dropped), the failed check is reported.
    onError: (sourceRef, reason) => errors.push({ sourceRef, reason }),
  });
  const recordLinked = async (c: LinkCandidate, hit: CardLink, linkPrincipal: Principal, cardRef: string) => {
    const done = await linker.link(c, hit, linkPrincipal, cardRef);
    linkedCount++;
    cardResults.push({
      idempotencyKey: c.idempotencyKey, outcome: "linked", reason: done.reason, linkedTo: done.id,
      ...(done.linkId !== undefined ? { linkId: done.linkId } : {}),
    });
  };

  // 1. Process memories/MEMORY.md (agent-scoped)
  const memoryMdPath = reader.paths.join(profileDir, ...CARD_FILES.hermes[0][0][0].split("/"));
  if (await reader.exists(memoryMdPath)) {
    let content: string | null = null;
    try {
      content = await reader.text(memoryMdPath, MAX_MEMORY_FILE_BYTES);
    } catch (error) {
      SourceReader.refuseFatal(error);
      errors.push({ sourceRef: `${profileName}:memories/MEMORY.md`, reason: error instanceof ImportError ? error.reason : "source-unreadable" });
    }
    if (content !== null) {
      const rawCards = splitHermesCards(content);
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
          sourceRef: `hermes:${profileName}:memories/MEMORY.md#${i + 1}${runSuffix}`,
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
          await checkpoint();
          const batchIdx = Math.floor(b / IMPORT_CARD_BATCH_LIMIT);
          const fullBatch = cardInputs.slice(b, b + IMPORT_CARD_BATCH_LIMIT);
          const linked = await linker.split(fullBatch, { request: principal, caller: principal }, "memories/MEMORY.md");
          for (const c of fullBatch) {
            const hit = linked.get(c.idempotencyKey);
            if (!hit) continue;
            if (c.isDuplicateInRun) {
              // A second copy of a linked card in the same file: what the engine reports for an in-batch duplicate.
              skippedDuplicateCount++;
              cardResults.push({ idempotencyKey: c.idempotencyKey, outcome: "matched-existing", reason: "duplicate-in-batch" });
            } else {
              await recordLinked(c, hit, principal, `agents/${agentId}/workspace/memory/KNOWLEDGE.md`);
            }
          }
          const batch = fullBatch.filter((c) => !linked.has(c.idempotencyKey));
          // The mirror keeps the source order: a linked card's memory is in the store, so its text belongs in it.
          const okCards = new Set(fullBatch.filter((c) => linked.has(c.idempotencyKey)));
          const pushMirror = () => {
            for (const c of fullBatch) if (okCards.has(c)) successfulMemoryTexts.push(c.text);
          };
          if (batch.length === 0) {
            pushMirror();
            continue;
          }

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
            okCards.clear();
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
          for (const reason of new Set(cards.filter(isOperationalCardRejection).map(importErrorCode))) {
            errors.push({ sourceRef: `${profileName}:memories/MEMORY.md#batch-${batchIdx}`,
              reason: `memory-import-failed:${reason}` });
            memoryBatchFailed = true;
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
              okCards.add(batchCard);
            }
          }
          pushMirror();

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
  const userMdPath = reader.paths.join(profileDir, ...CARD_FILES.hermes[1][0][0].split("/"));
  if (await reader.exists(userMdPath)) {
    let content: string | null = null;
    try {
      content = await reader.text(userMdPath, MAX_MEMORY_FILE_BYTES);
    } catch (error) {
      SourceReader.refuseFatal(error);
      errors.push({ sourceRef: `${profileName}:memories/USER.md`, reason: error instanceof ImportError ? error.reason : "source-unreadable" });
    }
    if (content !== null) {
      const userCards = splitHermesCards(content);
      totalCards += userCards.length;

      if (userPrincipal) {
        // Explicit user binding provided: import to user scope
        const cardInputs = userCards.map((cardText, i) => ({
          idempotencyKey: cardIdempotencyKey("hermes", profileName, "memories/USER.md", cardText),
          text: cardText,
          provenance: "imported" as const,
          sourceRef: `hermes:${profileName}:memories/USER.md#${i + 1}${runSuffix}`,
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
          const linkedUserKeys = new Set<string>();
          for (let b = 0; b < cardInputs.length; b += IMPORT_CARD_BATCH_LIMIT) {
            await checkpoint();
            const batchIdx = Math.floor(b / IMPORT_CARD_BATCH_LIMIT);
            const fullBatch = cardInputs.slice(b, b + IMPORT_CARD_BATCH_LIMIT);
            const linked = await linker.split(fullBatch, { request: userPrincipal, caller: principal }, "memories/USER.md");
            for (const c of fullBatch) {
              const hit = linked.get(c.idempotencyKey);
              if (!hit) continue;
              if (linkedUserKeys.has(c.idempotencyKey)) {
                // A second copy of a linked card in the same file: an in-batch duplicate, never a second link.
                skippedDuplicateCount++;
                cardResults.push({ idempotencyKey: c.idempotencyKey, outcome: "matched-existing", reason: "duplicate-in-batch" });
                continue;
              }
              linkedUserKeys.add(c.idempotencyKey);
              await recordLinked(c, hit, userPrincipal, `agents/${agentId}/workspace/USER.md`);
            }
            const batch = fullBatch.filter((c) => !linked.has(c.idempotencyKey));
            const okCards = new Set(fullBatch.filter((c) => linked.has(c.idempotencyKey)));
            const pushMirror = () => {
              for (const c of fullBatch) if (okCards.has(c)) successfulUserTexts.push(c.text);
            };
            if (batch.length === 0) {
              pushMirror();
              continue;
            }

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
              okCards.clear();
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
            for (const reason of new Set(result.cards.filter(isOperationalCardRejection).map(importErrorCode))) {
              errors.push({ sourceRef: `${profileName}:memories/USER.md#batch-${batchIdx}`,
                reason: `memory-import-failed:${reason}` });
              userBatchFailed = true;
            }

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
                okCards.add(batchCard);
              }
            }
            pushMirror();

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
        unresolvedUserCards(userCards);
      }
    }
  }

  // 3. Write curated markdown mirrors in l.workspaceDir(agentId)
  // Only from cards that were actually created or matched-existing in the store
  if (isApply) {
    const wsDir = l.workspaceDir(agentId);
    if (existsSync(wsDir)) {
      if (successfulMemoryTexts.length > 0 && !memoryBatchFailed) {
        const mirrorContent = formatImportedKnowledge(successfulMemoryTexts.join("\n\n§\n\n") + "\n", "hermes-agent-memory-import");
        const mirrorProblem = writeMirrorWithConflict({
          targetPath: join(wsDir, "memory", "KNOWLEDGE.md"),
          content: mirrorContent,
          legacyContent: successfulMemoryTexts.join("\n\n§\n\n") + "\n",
          relTarget: "workspace/memory/KNOWLEDGE.md",
          sourceRef: "memories/MEMORY.md",
          agentId,
          onConflict,
          replacedBackupDir,
          ledger,
          l,
        });
        if (mirrorProblem) errors.push({ sourceRef: `${profileName}:memories/MEMORY.md`, reason: mirrorProblem });
      }

      if (successfulUserTexts.length > 0 && !userBatchFailed) {
        const userMirrorContent = successfulUserTexts.join("\n\n§\n\n") + "\n";
        const userMirrorProblem = writeMirrorWithConflict({
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
        if (userMirrorProblem) errors.push({ sourceRef: `${profileName}:memories/USER.md`, reason: userMirrorProblem });
      }
    }
  }

  return summary();
}
