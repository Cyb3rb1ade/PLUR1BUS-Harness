// Memory cards of agents with a store of their own (owner decision 2026-10-19, docs/import.md §10.3), shared by the
// OpenClaw and Hermes card importers:
//   - store in the harness (taken over / matched): before a card is written, the agent's store is asked whether the same
//     memory is already there (engine duplicate rule, see DUPLICATE_SCORE); a duplicate is not written again but linked:
//     ledger action "linked" with the existing memory id, report outcome "linked". A later run reuses the ledger link.
//   - store routed to the re-embedding migration: the cards are parked (outcome / ledger action "pending-reembed") and never
//     embedded into a vector space the store is not in; a later run that takes the store over imports them.
//   - store not taken over for another reason: the cards are deferred (outcome / ledger action "deferred").
// Only the engine's public contract is used (memory.import dry run, memory.list); NEVER writes to LanceDB directly.
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { ImportLedger } from "../ledger.ts";
import type { Engine, Principal } from "@cyb3rb1ade/plur1bus-memory/types/engine.js";

/** The engine's capture duplicate threshold: `cfg.duplicateThreshold ?? 0.95` (engine/create-engine.js), compared against
 *  `distanceToScore(d) = 1 / (1 + d)` (lib/score.js) in MemoryDB.findSimilar. The harness never sets duplicateThreshold. */
export const DUPLICATE_SCORE = 0.95;
/** `memory.list` accepts a topic of at most this many characters (engine/memory-ops/read.js MAX_TOPIC_LENGTH). */
const MAX_TOPIC_LENGTH = 2_000;

const normalizeCard = (text: string): string => text.replace(/\r\n/g, "\n").trim();
/** sha256 of the normalized card text (what the ledger records for a card, never the text itself). */
export const cardSha256 = (text: string): string => createHash("sha256").update(normalizeCard(text)).digest("hex");

/** A reason code only (never message text, which could echo card content): a short token, else "storage". */
function errorCode(err: any): string {
  const raw = err?.code ?? err?.reason;
  return typeof raw === "string" && /^[A-Za-z0-9_.-]{1,64}$/.test(raw) ? raw : "storage";
}

/**
 * The engine's capture duplicate rule over its public contract: `memory.list({ topic })` (vector search in the agent's
 * store and the pools its principal reaches) scores a hit `max(0, 1 - d)` (lib/db-adapter.js searchByTopic), so the capture
 * score `1 / (1 + d)` is `1 / (2 - score)`. A hit is the same memory when that reaches DUPLICATE_SCORE or its text is the
 * card's text (findSimilar's `r.text === text`). A text-search fallback (score 0.5) never counts as a vector match.
 */
export async function findExistingMemory(engine: Engine, text: string, principal: Principal): Promise<{ id: string; score: number } | null> {
  const want = normalizeCard(text);
  if (want.length === 0 || want.length > MAX_TOPIC_LENGTH) return null;
  const res = await engine.memory.list({ topic: want, limit: 5 }, principal, { origin: "system", background: false });
  let best: { id: string; score: number } | null = null;
  for (const item of res.items ?? []) {
    if (typeof item?.id !== "string") continue;
    if (typeof item.text === "string" && normalizeCard(item.text) === want) return { id: item.id, score: 1 };
    const listScore = typeof item.score === "number" && item.score > 0 ? Math.min(1, item.score) : 0;
    const score = listScore > 0 ? 1 / (2 - listScore) : 0;
    if (score >= DUPLICATE_SCORE && (!best || score > best.score)) best = { id: item.id, score };
  }
  return best;
}

/** The import runs of a home that were not rolled back, oldest first, with their ledger text. */
function liveRunLedgers(importsDir: string): Array<{ run: string; text: string }> {
  let runs: string[];
  try { runs = readdirSync(importsDir); } catch { return []; }
  const out: Array<{ run: string; text: string }> = [];
  for (const run of runs.sort()) {
    const dir = join(importsDir, run);
    if (existsSync(join(dir, "rolled-back", "status.json"))) continue;
    try { out.push({ run, text: readFileSync(join(dir, "ledger.jsonl"), "utf8") }); } catch { /* no ledger: nothing recorded */ }
  }
  return out;
}

function* ledgerEntries(text: string): Generator<any> {
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try { yield JSON.parse(line); } catch { /* torn line: the ledger loader repairs it */ }
  }
}

/**
 * Cards an earlier, not rolled-back run of this home already linked (ledger action "linked", targetRef `memory:<id>`):
 * idempotency key -> memory id. A re-run reuses the link instead of asking the store again: a duplicate check goes through
 * `memory.list`, whose store handle the engine opens in write mode (MemoryDB.init's bootstrap-row cleanup commits a
 * LanceDB transaction even when nothing changes), so asking again would write to the store on every run.
 */
export function readPriorCardLinks(importsDir: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const { text } of liveRunLedgers(importsDir)) {
    for (const e of ledgerEntries(text)) {
      if (e?.entity !== "memory" || e?.action !== "linked" || typeof e?.idempotencyKey !== "string") continue;
      const m = /^memory:([A-Za-z0-9-]{1,128})$/.exec(String(e.targetRef ?? ""));
      if (m) out.set(e.idempotencyKey, m[1]!);
    }
  }
  return out;
}

/**
 * The store-ledger key of the last store swapped into state/lancedb by a not rolled-back import run of this home (ledger
 * entity "store", action "adopted" or "replace", targetRef "state/lancedb"), or null when no run took a store over.
 * Tells whether the harness store IS a given source store (taken over earlier), as opposed to some other store.
 */
export function lastTakenOverStoreKey(importsDir: string): string | null {
  let last: string | null = null;
  for (const { text } of liveRunLedgers(importsDir)) {
    for (const e of ledgerEntries(text)) {
      if (e?.entity === "store" && (e?.action === "adopted" || e?.action === "replace") && e?.targetRef === "state/lancedb" && typeof e?.idempotencyKey === "string") {
        last = e.idempotencyKey;
      }
    }
  }
  return last;
}

/** How the cards of an agent with a store of its own are handled (absent: an agent without one, the plain import). */
export type OwnStoreCardMode =
  | { kind: "link"; priorLinks?: ReadonlyMap<string, string> | undefined }
  | { kind: "park"; outcome: "pending-reembed" | "deferred"; reason: string };

export const PARK_PENDING_REEMBED: OwnStoreCardMode = { kind: "park", outcome: "pending-reembed", reason: "agent-store-reembed-migration" };
export const PARK_DEFERRED: OwnStoreCardMode = { kind: "park", outcome: "deferred", reason: "agent-store-not-taken-over" };

/** Records one parked card (pending-reembed / deferred) in the ledger: nothing was embedded or written. */
export function recordParkedCard(
  ledger: ImportLedger | undefined,
  mode: Extract<OwnStoreCardMode, { kind: "park" }>,
  card: { idempotencyKey: string; text: string; sourceRef: string; targetRef: string },
): void {
  ledger?.record({
    entity: "memory",
    idempotencyKey: card.idempotencyKey,
    action: mode.outcome,
    sourceRef: card.sourceRef,
    targetRef: card.targetRef,
    sha256: cardSha256(card.text),
    reason: mode.reason,
  });
}

export interface LinkCandidate {
  idempotencyKey: string;
  text: string;
  sourceRef: string;
  provenance: "imported";
  scope: "agent-private" | "user";
  isDuplicateInRun?: boolean | undefined;
}
export interface CardLink { id: string; score: number; reason: string }

/**
 * Duplicate linking for one agent whose store is in the harness. `split` finds, among the cards the engine would create,
 * those that duplicate a memory already in the store (reused ledger link first, then the engine duplicate rule); `record`
 * writes the ledger entry of a linked card. Inactive (no links) for a dry run, without an engine, or outside link mode:
 * a dry run has no target store to compare against and plans every new card as created.
 */
export function createCardLinker(o: {
  engine: Engine | undefined;
  agentId: string;
  isApply: boolean;
  mode: OwnStoreCardMode | undefined;
  ledger: ImportLedger | undefined;
  /** A failed duplicate check: reported, and the card is imported (never dropped). */
  onError: (sourceRef: string, reason: string) => void;
}) {
  const engine = o.engine;
  const active = o.mode?.kind === "link" && o.isApply && engine !== undefined;
  const prior = o.mode?.kind === "link" ? o.mode.priorLinks : undefined;
  const systemAgent = { origin: "system", background: false } as const;

  const split = async (
    batch: readonly LinkCandidate[],
    principals: { request: Principal; caller: Principal },
    fileRef: string,
  ): Promise<Map<string, CardLink>> => {
    const linked = new Map<string, CardLink>();
    if (!active || !engine) return linked;
    for (const c of batch) {
      const id = prior?.get(c.idempotencyKey);
      if (id !== undefined && !c.isDuplicateInRun) linked.set(c.idempotencyKey, { id, score: 1, reason: "already-linked" });
    }
    const open = batch.filter((c) => !linked.has(c.idempotencyKey));
    if (open.length === 0) return linked;
    let planned: Set<string>;
    try {
      // The engine's own idempotency first: a card it already imported stays matched-existing, never "linked" to itself.
      const dry = await engine.memory.import(
        {
          agentId: o.agentId,
          principal: principals.request,
          cards: open.map(({ idempotencyKey, text, provenance, sourceRef, scope }) => ({ idempotencyKey, text, provenance, sourceRef, scope })),
          dryRun: true,
        },
        principals.caller,
        systemAgent,
      );
      planned = new Set((dry.cards ?? []).filter((c: any) => c.outcome === "created").map((c: any) => c.idempotencyKey));
    } catch {
      return linked; // the real import reports the failure
    }
    for (const c of open) {
      if (c.isDuplicateInRun || !planned.has(c.idempotencyKey)) continue;
      try {
        const hit = await findExistingMemory(engine, c.text, principals.request);
        if (hit) linked.set(c.idempotencyKey, { ...hit, reason: "duplicate-of-existing" });
      } catch (err) {
        o.onError(`${o.agentId}:${fileRef}`, `duplicate-check-failed:${errorCode(err)}`);
      }
    }
    return linked;
  };

  const record = (c: LinkCandidate, hit: CardLink, cardRef: string): void => {
    o.ledger?.record({
      entity: "memory",
      idempotencyKey: c.idempotencyKey,
      action: "linked",
      sourceRef: c.sourceRef,
      targetRef: `memory:${hit.id}`,
      sha256: cardSha256(c.text),
      reason: hit.reason,
      details: { score: Math.round(hit.score * 1000) / 1000, card: cardRef },
    });
  };

  return { split, record };
}
