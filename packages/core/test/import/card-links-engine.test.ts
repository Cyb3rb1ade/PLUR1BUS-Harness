// card-links-engine.test.ts — engine contract 1.16.0 (`memory.link`, `engine.capabilities.memoryLink`) in the shared card
// linker (card-links.ts) through the OpenClaw card importer, against a scripted engine (no store, no model):
//   - with the capability every duplicate found is linked in the engine too (sourceRef, provenance "imported", the run,
//     the card's idempotency key); report and ledger carry the engine link id;
//   - without it, or when the engine refuses the link, the link stays ledger-only (the card is never written twice);
//   - a link an earlier run already made in the engine is reused, not made again;
//   - a second copy of a linked card in the same file is matched-existing (duplicate-in-batch), never a second link;
//   - USER.md without a user binding is unresolved-user-scope also for a parked agent (ADR-007 Q4 first, as for Hermes).
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { layout } from "../../src/paths.ts";
import { cardIdempotencyKey, ImportLedger } from "../../src/import/ledger.ts";
import { importOpenclawMemories } from "../../src/import/importers/openclaw-memories.ts";
import { PARK_PENDING_REEMBED, readPriorCardLinks, type OwnStoreCardMode, type PriorCardLink } from "../../src/import/importers/card-links.ts";
import { tempDir } from "../helpers/temp-dir.ts";

const RUN = "R1";
const MEMORY_ID = "00000000-0000-4000-8000-000000000001";
const DUP = "card-links probe: the user prefers tea";
const FRESH = "card-links probe: a new fact";
const linkIdOf = (id: string, sourceRef: string) => createHash("sha256").update(`${id}\n${sourceRef}`).digest("hex").slice(0, 32);

interface LinkCall { id: string; req: Record<string, unknown>; principal: Record<string, unknown>; agent: Record<string, unknown> }

/** A scripted engine: `existing` maps a memory text to its id (memory.list finds it by exact text); import creates every card. */
function scriptedEngine(o: { capability: boolean; linkError?: { code: string } }) {
  const existing = new Map([[DUP, MEMORY_ID]]);
  const links: LinkCall[] = [];
  const imports: { n: number; dryRun: boolean }[] = [];
  const engine = {
    ...(o.capability ? { capabilities: Object.freeze({ memoryLink: true }) } : {}),
    memory: {
      import: async (req: { cards: { idempotencyKey: string }[]; dryRun: boolean }) => {
        imports.push({ n: req.cards.length, dryRun: req.dryRun });
        return { created: req.dryRun ? 0 : req.cards.length, matchedExisting: 0, rejected: 0, cards: req.cards.map((c) => ({ idempotencyKey: c.idempotencyKey, outcome: "created" })) };
      },
      list: async (q: { topic: string }) => {
        const id = existing.get(q.topic);
        return { items: id ? [{ id, text: q.topic, score: 1 }] : [] };
      },
      link: async (id: string, req: Record<string, unknown>, principal: Record<string, unknown>, agent: Record<string, unknown>) => {
        links.push({ id, req, principal, agent });
        if (o.linkError) throw Object.assign(new Error("refused"), o.linkError);
        return { id, linkId: linkIdOf(id, String(req.sourceRef)), outcome: "linked", importRunId: req.importRunId ?? null, dryRun: false };
      },
    },
  } as any;
  return { engine, links, imports };
}

function workspace(files: { memory?: string; user?: string }) {
  const home = tempDir("p1b-card-links-engine-");
  const ws = join(home, "src-ws");
  mkdirSync(ws, { recursive: true });
  if (files.memory !== undefined) writeFileSync(join(ws, "MEMORY.md"), files.memory);
  if (files.user !== undefined) writeFileSync(join(ws, "USER.md"), files.user);
  const ledgerPath = join(home, "imports", RUN, "ledger.jsonl");
  return { home, ws, l: layout(home), ledgerPath, ledger: new ImportLedger(ledgerPath, RUN) };
}

const ledgerLines = (path: string) => readFileSync(path, "utf8").trim().split("\n").map((x) => JSON.parse(x));
const keyOf = (file: string, text: string) => cardIdempotencyKey("openclaw", "alpha", file, text);

async function run(o: { files: { memory?: string; user?: string }; capability?: boolean; linkError?: { code: string }; mode?: OwnStoreCardMode; userPrincipal?: unknown }) {
  const w = workspace(o.files);
  const s = scriptedEngine({ capability: o.capability ?? true, ...(o.linkError ? { linkError: o.linkError } : {}) });
  const r = await importOpenclawMemories({
    workspaceDir: w.ws, agentId: "alpha", l: w.l, engine: s.engine, isApply: true, ledger: w.ledger,
    ownStore: o.mode ?? { kind: "link" }, userPrincipal: o.userPrincipal,
  });
  return { r, ...s, ...w };
}

describe("card linker with engine contract 1.16.0 (memory.link)", () => {
  it("links a duplicate in the engine: sourceRef, provenance, run and key; report and ledger carry the link id", async () => {
    const { r, links, imports, ledgerPath } = await run({ files: { memory: `${DUP}\n§\n${FRESH}\n` } });

    assert.deepEqual(r.errors, []);
    assert.equal(links.length, 1);
    const call = links[0]!;
    assert.equal(call.id, MEMORY_ID);
    assert.deepEqual(call.req, { sourceRef: `openclaw:alpha:MEMORY.md#1;run=${RUN}`, provenance: "imported", importRunId: RUN, idempotencyKey: keyOf("MEMORY.md", DUP) });
    assert.equal(call.principal.agentId, "alpha");
    assert.deepEqual(call.agent, { origin: "system", background: false });
    const linkId = linkIdOf(MEMORY_ID, `openclaw:alpha:MEMORY.md#1;run=${RUN}`);
    assert.deepEqual(r.cardResults.map((c) => [c.outcome, c.linkedTo ?? null, c.linkId ?? null]), [["linked", MEMORY_ID, linkId], ["created", null, null]]);
    assert.equal(r.linkedCount, 1);
    assert.equal(r.importedCount, 1);
    assert.deepEqual(imports.filter((x) => !x.dryRun), [{ n: 1, dryRun: false }], "only the new card is written");

    const linked = ledgerLines(ledgerPath).filter((e) => e.entity === "memory" && e.action === "linked");
    assert.equal(linked.length, 1);
    assert.equal(linked[0].targetRef, `memory:${MEMORY_ID}`);
    assert.deepEqual([linked[0].details.linkId, linked[0].details.engineLink, linked[0].details.agentId], [linkId, "linked", "alpha"]);
  });

  it("a second copy of a linked card in the same file is matched-existing, not linked a second time", async () => {
    const { r, links, ledgerPath } = await run({ files: { memory: `${DUP}\n§\n${DUP}\n§\n${FRESH}\n` } });

    assert.deepEqual(r.errors, []);
    assert.deepEqual(r.cardResults.map((c) => [c.outcome, c.reason ?? null]), [["linked", "duplicate-of-existing"], ["matched-existing", "duplicate-in-batch"], ["created", null]]);
    assert.equal(r.linkedCount, 1);
    assert.equal(r.skippedDuplicateCount, 1);
    assert.equal(links.length, 1, "one engine link for the card");
    assert.equal(ledgerLines(ledgerPath).filter((e) => e.action === "linked").length, 1, "one ledger link for the card");
  });

  it("without the capability the link stays ledger-only (memory.link is never called)", async () => {
    const { r, links, ledgerPath } = await run({ files: { memory: `${DUP}\n` }, capability: false });

    assert.deepEqual(r.errors, []);
    assert.equal(links.length, 0);
    assert.deepEqual(r.cardResults.map((c) => [c.outcome, c.linkedTo ?? null, c.linkId ?? null]), [["linked", MEMORY_ID, null]]);
    const linked = ledgerLines(ledgerPath).filter((e) => e.action === "linked");
    assert.equal(linked.length, 1);
    assert.equal(linked[0].details.linkId, undefined);
    assert.equal(linked[0].details.engineLink, undefined);
  });

  it("a refused engine link is reported; the card stays linked in the ledger and is not written", async () => {
    const { r, links, imports, ledgerPath } = await run({ files: { memory: `${DUP}\n` }, linkError: { code: "conflict" } });

    assert.equal(links.length, 1);
    assert.deepEqual(r.errors, [{ sourceRef: "alpha:agents/alpha/workspace/memories.md", reason: "memory-link-failed:conflict" }]);
    assert.deepEqual(r.cardResults.map((c) => [c.outcome, c.linkId ?? null]), [["linked", null]]);
    assert.deepEqual(imports.filter((x) => !x.dryRun), [], "the duplicate is not written");
    const linked = ledgerLines(ledgerPath).filter((e) => e.action === "linked");
    assert.equal(linked.length, 1);
    assert.equal(linked[0].details.linkId, undefined);
  });

  it("a link an earlier run made in the engine is reused; an earlier ledger-only link is linked in the engine now", async () => {
    const key = keyOf("MEMORY.md", DUP);
    const earlierLinkId = "b".repeat(32);
    const reused = await run({ files: { memory: `${DUP}\n` }, mode: { kind: "link", priorLinks: new Map<string, PriorCardLink>([[key, { id: MEMORY_ID, linkId: earlierLinkId }]]) } });
    assert.equal(reused.links.length, 0, "no second engine link");
    assert.deepEqual(reused.r.cardResults.map((c) => [c.outcome, c.reason, c.linkId ?? null]), [["linked", "already-linked", earlierLinkId]]);
    const reusedEntry = ledgerLines(reused.ledgerPath).find((e) => e.action === "linked");
    assert.equal(reusedEntry.details.engineLink, undefined, "this run made no engine link (rollback leaves the earlier run's link alone)");

    const upgraded = await run({ files: { memory: `${DUP}\n` }, mode: { kind: "link", priorLinks: new Map<string, PriorCardLink>([[key, { id: MEMORY_ID }]]) } });
    assert.equal(upgraded.links.length, 1);
    assert.equal(upgraded.r.cardResults[0]!.reason, "already-linked");
    assert.equal(upgraded.r.cardResults[0]!.linkId, linkIdOf(MEMORY_ID, `openclaw:alpha:MEMORY.md#1;run=${RUN}`));
  });

  it("readPriorCardLinks carries the engine link id of a live run and keeps it across a later reuse", () => {
    const home = tempDir("p1b-card-links-prior-");
    const key = keyOf("MEMORY.md", DUP);
    const entry = (run: string, details: Record<string, unknown>) =>
      JSON.stringify({ ts: "2026-10-19T00:00:00.000Z", runId: run, entity: "memory", idempotencyKey: key, action: "linked", targetRef: `memory:${MEMORY_ID}`, details });
    for (const [run, details] of [["R1", { linkId: "c".repeat(32), engineLink: "linked" }], ["R2", { score: 1 }]] as const) {
      mkdirSync(join(home, "imports", run), { recursive: true });
      writeFileSync(join(home, "imports", run, "ledger.jsonl"), `${entry(run, details)}\n`);
    }
    assert.deepEqual(readPriorCardLinks(join(home, "imports")).get(key), { id: MEMORY_ID, linkId: "c".repeat(32) });

    // R1 rolled back: its engine link is gone, R2's ledger-only link remains (no link id).
    mkdirSync(join(home, "imports", "R1", "rolled-back"), { recursive: true });
    writeFileSync(join(home, "imports", "R1", "rolled-back", "status.json"), "{}");
    assert.deepEqual(readPriorCardLinks(join(home, "imports")).get(key), { id: MEMORY_ID, linkId: undefined });
  });

  it("parked agent: USER.md without a user binding is unresolved-user-scope, never parked (ADR-007 Q4 first)", async () => {
    const { r, links, imports, ledgerPath } = await run({ files: { memory: `${FRESH}\n`, user: "card-links probe: user card\n" }, mode: PARK_PENDING_REEMBED });

    assert.deepEqual(r.cardResults.map((c) => [c.outcome, c.reason]), [["pending-reembed", "agent-store-reembed-migration"], ["unresolved-user-scope", "unambiguous-user-required"]]);
    assert.deepEqual([r.pendingReembedCount, r.unresolvedUserScopeCount, r.totalCards], [1, 1, 2]);
    assert.deepEqual([links.length, imports.length], [0, 0], "a parked agent never reaches the engine");
    assert.deepEqual(ledgerLines(ledgerPath).map((e) => [e.action, e.reason]), [["pending-reembed", "agent-store-reembed-migration"], ["skipped", "unambiguous-user-required"]]);

    // With a user binding the USER.md card is parked like the MEMORY.md card.
    const bound = await run({ files: { user: "card-links probe: user card\n" }, mode: PARK_PENDING_REEMBED, userPrincipal: { user: `user:v1:${"a".repeat(64)}` } });
    assert.deepEqual(bound.r.cardResults.map((c) => c.outcome), ["pending-reembed"]);
  });
});
