// hermes-cards-own-store.test.ts — owner decision 2026-10-19, "the same rule for Hermes" (the OpenClaw rule of PR 593,
// openclaw-cards-own-store.test.ts): Hermes memory cards are imported also when --adopt-store takes a store over.
//   - store taken over in the harness vector space: each card is checked against that store first; a card already in it
//     (engine duplicate rule) is not written again but linked (report outcome "linked", ledger action "linked" with the
//     memory id); a new card is written into the store.
//   - --adopt-strategy reembed (store taken over as-is for the re-embedding migration): the cards are parked
//     ("pending-reembed"), the engine is never opened, the store stays exactly the source copy; the first run after the
//     migration imports them (linked or created).
//   - store not taken over for another reason (another harness store left untouched): "deferred".
//   - no store / --adopt-strategy import: unchanged (m7-gaps-closed.test.ts, hermes-batch3*.test.ts).
// Stub embedders only (no model load, no network).
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { layout } from "../../src/paths.ts";
import { importHermes, type HermesImportReport } from "../../src/import/importers/hermes.ts";
import { renderHermes } from "../../src/import/render.ts";
import { rollbackImport } from "../../src/import/rollback.ts";
import { createTempHost } from "../../src/import/importers/hermes-stores.ts";
import { buildEngineConfig } from "../../src/engine-config.ts";
import { createEngine } from "@cyb3rb1ade/plur1bus-memory/engine/create-engine.js";
import { defaults } from "@plur1bus/config-schema";
import { loadLanceDb } from "../../src/import/readonly.ts";
import { tempDir } from "../helpers/temp-dir.ts";
import { buildM7HermesFixture, CONTENT_MARKER, lanceStore, write, type M7HermesFixture } from "./fixtures.ts";
import type { Engine } from "@cyb3rb1ade/plur1bus-memory/types/engine.js";

const timeout = 90_000;
const DIM = 384;
const ROW = (i: number) => `00000000-0000-4000-8000-00000000000${i}`;
/** The engine columns a recall reads (as in openclaw-cards-own-store.test.ts). */
const ENGINE_COLUMNS = {
  type: "memory", confirmed: false, summary: "", origin: "dm", importance: 0.5, category: "other", createdAt: 1_760_000_000_000,
  expiresAt: 0, scope: "agent-private", status: "active", updatedAt: 1_760_000_000_000, ownerUserId: "",
};

/** The deterministic stub "model" of openclaw-cards-own-store.test.ts: text ending in `<n>` -> unit vector at n. The
 *  fixture rows `<marker> <i>` written with the default hotOf carry the unit vector at i, so this model wrote them. */
function modelInternals() {
  const hot = (text: string) => Number(/(\d+)\s*$/.exec(text)?.[1] ?? 0);
  const vector = (text: string) => Array.from({ length: DIM }, (_, i) => (i === hot(text) ? 1 : 0));
  const one = async (text: string) => vector(text);
  return { embeddings: { embed: one, embedQuery: one, embedPassage: one, embedBatch: async (texts: string[]) => texts.map(vector), shutdown: async () => {} }, reranker: null };
}

/** A Hermes PLUR1BUS store (schema marker + the `default` agent's partition, 3 rows). `hotOf` shifts the vectors: rows
 *  written by another model (the stub model's probe then sees identity-mismatch). */
async function hermesStore(hotOf?: (i: number) => number): Promise<string> {
  const store = join(tempDir("p1b-hm-cards-src-"), "store");
  mkdirSync(store, { recursive: true, mode: 0o700 });
  writeFileSync(join(store, "_schema.json"), JSON.stringify({ schemaVersion: "1" }));
  await lanceStore(join(store, "default"), DIM, 3, { ...ENGINE_COLUMNS, agentId: "default" }, hotOf);
  return store;
}

/** The M7 Hermes fixture with the default profile only; its MEMORY.md holds one card that is already in the store (the
 *  text of row 1) and one new card (unit vector 7, in no row). USER.md stays (no user binding: unresolved-user-scope). */
async function fixture(): Promise<M7HermesFixture> {
  const fx = await buildM7HermesFixture();
  rmSync(join(fx.root, "profiles", "work"), { recursive: true, force: true });
  write(join(fx.root, "memories", "MEMORY.md"), `${CONTENT_MARKER} 1\n§\n${CONTENT_MARKER} a new fact 7\n`);
  return fx;
}

const mem = (r: HermesImportReport) => {
  const a = r.profilesOrAgents.find((x) => x.harnessAgentId === "default");
  assert.ok(a?.memory, "profile default has no memory result");
  return a.memory;
};
const memoryCards = (r: HermesImportReport) => mem(r).cardResults.filter((c) => c.idempotencyKey.includes(":memories/MEMORY.md:"));
const userCards = (r: HermesImportReport) => mem(r).cardResults.filter((c) => c.idempotencyKey.includes(":memories/USER.md:"));
const ledgerOf = (r: HermesImportReport) => readFileSync(r.ledgerPath!, "utf8").trim().split("\n").map((x) => JSON.parse(x));

async function rowsOf(partition: string): Promise<{ id: string; text: string; hot: number; dimension: number }[]> {
  const lancedb = (await loadLanceDb())!;
  const db = await lancedb.connect(partition) as any;
  const t = await db.openTable("memories");
  const rows = await t.query().select(["id", "text", "vector"]).toArray();
  t.close(); db.close();
  return rows.map((r: any) => {
    const v = Array.from(r.vector.toArray() as Float32Array);
    return { id: String(r.id), text: String(r.text), hot: v.indexOf(1), dimension: v.length };
  });
}

/** Relative path -> sha256 of every file of a tree, sorted (dirs as "dir"). */
function treeDigest(dir: string): string {
  const out: [string, string][] = [];
  const walk = (d: string) => {
    for (const ent of readdirSync(d, { withFileTypes: true })) {
      const full = join(d, ent.name);
      const rel = relative(dir, full).replaceAll("\\", "/");
      if (ent.isDirectory()) { out.push([rel, "dir"]); walk(full); } else out.push([rel, createHash("sha256").update(readFileSync(full)).digest("hex")]);
    }
  };
  if (existsSync(dir)) walk(dir);
  return JSON.stringify(out.sort(([a], [b]) => a.localeCompare(b)));
}

/** An engine stub that records every memory.import / memory.list call and creates every card. */
function recordingEngine() {
  const calls: { op: string; dryRun?: boolean; n?: number }[] = [];
  const engine = {
    memory: {
      import: async (req: { cards: { idempotencyKey: string }[]; dryRun: boolean }) => {
        calls.push({ op: "import", dryRun: req.dryRun, n: req.cards.length });
        return { created: req.dryRun ? 0 : req.cards.length, matchedExisting: 0, rejected: 0, cards: req.cards.map((c) => ({ idempotencyKey: c.idempotencyKey, outcome: "created" })) };
      },
      list: async () => { calls.push({ op: "list" }); return { items: [] }; },
    },
    close: async () => {},
  } as unknown as Engine;
  return { engine, calls };
}

describe("Hermes memory cards with --adopt-store (owner decision 2026-10-19, same rule as OpenClaw)", () => {
  it("store taken over: a card already in the store is linked to it, a new card is written into the store", { timeout }, async () => {
    const fx = await fixture();
    const src = await hermesStore();
    const home = tempDir("p1b-hm-cards-link-");
    const l = layout(home);
    const r = await importHermes({ home, source: fx.root, adoptStore: src, apply: true, testInternals: modelInternals() });

    assert.equal(r.storeAdopt?.verdict, "ok");
    assert.equal(r.storeAdopt?.action, "taken-over");
    assert.deepEqual(r.errors, [], JSON.stringify(r.errors));
    const [dup, fresh] = memoryCards(r);
    assert.deepEqual([dup!.outcome, dup!.reason, dup!.linkedTo], ["linked", "duplicate-of-existing", ROW(1)]);
    assert.equal(fresh!.outcome, "created");
    assert.equal(mem(r).linkedCount, 1);
    assert.equal(mem(r).importedCount, 1);
    assert.deepEqual(userCards(r).map((c) => [c.outcome, c.reason]), [["rejected", "unresolved-user-scope"], ["rejected", "unresolved-user-scope"]], "USER.md without a binding stays unresolved");
    assert.deepEqual([r.counts.memoryCardsLinked, r.counts.memoryCardsImported, r.counts.memoryCardsPendingReembed, r.counts.memoryCardsDeferred], [1, 1, 0, 0]);

    // The store: the three source rows plus exactly the new card, embedded by the harness model; the duplicate is not
    // written a second time.
    const rows = await rowsOf(join(l.lancedb, "default"));
    assert.equal(rows.length, 4);
    assert.equal(rows.filter((x) => x.text === `${CONTENT_MARKER} 1`).length, 1, "the duplicate is not in the store twice");
    const added = rows.find((x) => x.text.endsWith("a new fact 7"));
    assert.ok(added && added.dimension === DIM && added.hot === 7, "the new card is in the store, in the harness vector space");

    // Ledger link (card source -> existing memory id), human report, no card text in the report; the mirror keeps the
    // source order and carries the linked card (its memory is in the store).
    const linked = ledgerOf(r).filter((e) => e.entity === "memory" && e.action === "linked");
    assert.equal(linked.length, 1);
    assert.equal(linked[0].targetRef, `memory:${ROW(1)}`);
    assert.match(linked[0].sourceRef, /^hermes:default:memories\/MEMORY\.md#1;run=/);
    assert.match(renderHermes(r), /1 linked/);
    assert.ok(!JSON.stringify(r).includes(CONTENT_MARKER), "the report carries no card text");
    const rawMirror = `${CONTENT_MARKER} 1\n\n§\n\n${CONTENT_MARKER} a new fact 7\n`;
    const marker = createHash("sha256").update(`hermes-agent-memory-import\0${rawMirror}`).digest("hex");
    assert.equal(readFileSync(join(l.workspaceDir("default"), "memory", "KNOWLEDGE.md"), "utf8"), `<!-- plur1bus-imported-knowledge:${marker} -->\n## Imported agent knowledge\n\n> ${CONTENT_MARKER} 1\n> \n> §\n> \n> ${CONTENT_MARKER} a new fact 7\n> \n`);

    // A second run with the same --adopt-store: the harness store is that store (last recorded take-over), so it is not
    // copied again and the link is reused; nothing is written to the store.
    const before = await rowsOf(join(l.lancedb, "default"));
    const again = await importHermes({ home, source: fx.root, adoptStore: src, apply: true, testInternals: modelInternals() });
    assert.equal(again.storeAdopt?.reason, "store-exists-skipped");
    assert.deepEqual(memoryCards(again).map((c) => [c.outcome, c.reason, c.linkedTo ?? null]), [["linked", "already-linked", ROW(1)], ["matched-existing", "already-imported", null]]);
    assert.deepEqual(again.errors, [], JSON.stringify(again.errors));
    assert.deepEqual(await rowsOf(join(l.lancedb, "default")), before);
  });

  it("--adopt-strategy reembed: cards are pending-reembed, the store stays the source copy; after the migration they are imported", { timeout }, async () => {
    const fx = await fixture();
    const src = await hermesStore((i) => i + 50); // written by "another model"
    const home = tempDir("p1b-hm-cards-pending-");
    const l = layout(home);
    const first = await importHermes({ home, source: fx.root, adoptStore: src, adoptStrategy: "reembed", apply: true, testInternals: modelInternals() });

    assert.equal(first.storeAdopt?.action, "taken-over");
    assert.equal(first.storeAdopt?.routedTo, "reembed");
    assert.deepEqual(memoryCards(first).map((c) => [c.outcome, c.reason]), [["pending-reembed", "agent-store-reembed-migration"], ["pending-reembed", "agent-store-reembed-migration"]]);
    assert.equal(userCards(first).every((c) => c.reason === "unresolved-user-scope"), true, "USER.md without a binding is not parked");
    assert.deepEqual([first.counts.memoryCardsPendingReembed, first.counts.memoryCardsImported, first.counts.memoryCardsLinked, first.counts.unresolvedUserScope], [2, 0, 0, 2]);
    assert.equal(treeDigest(l.lancedb), treeDigest(src), "nothing embedded into the foreign-space store: it is exactly the source copy");
    assert.ok(!existsSync(join(l.workspaceDir("default"), "memory", "KNOWLEDGE.md")), "no mirror for parked cards");
    const parked = ledgerOf(first).filter((e) => e.entity === "memory" && e.action === "pending-reembed");
    assert.deepEqual(parked.map((e) => e.sourceRef.replace(/;run=.*$/, "")), ["hermes:default:memories/MEMORY.md#1", "hermes:default:memories/MEMORY.md#2"]);
    assert.ok(parked.every((e) => e.targetRef === "agents/default/workspace/memory/KNOWLEDGE.md" && /^[0-9a-f]{64}$/.test(e.sha256)));
    assert.match(renderHermes(first), /2 pending-reembed/);

    // Not migrated yet: a re-run keeps them parked and leaves the store as it is (the identity check only reads it).
    const notYet = await importHermes({ home, source: fx.root, adoptStore: src, apply: true, testInternals: modelInternals() });
    assert.equal(notYet.storeAdopt?.reason, "store-exists-skipped");
    assert.deepEqual(memoryCards(notYet).map((c) => c.outcome), ["pending-reembed", "pending-reembed"]);
    assert.equal(treeDigest(l.lancedb), treeDigest(src));

    // The migration is done: the harness store now carries vectors of the harness model (rows at 0, 1, 2). The next run
    // imports the parked cards in that space: the duplicate of row 1 is linked, the new card created.
    rmSync(join(l.lancedb, "default"), { recursive: true, force: true });
    await lanceStore(join(l.lancedb, "default"), DIM, 3, { ...ENGINE_COLUMNS, agentId: "default" });
    const after = await importHermes({ home, source: fx.root, adoptStore: src, apply: true, testInternals: modelInternals() });
    assert.deepEqual(after.errors, [], JSON.stringify(after.errors));
    assert.deepEqual(memoryCards(after).map((c) => [c.outcome, c.linkedTo ?? null]), [["linked", ROW(1)], ["created", null]]);
    assert.deepEqual([after.counts.memoryCardsPendingReembed, after.counts.memoryCardsLinked, after.counts.memoryCardsImported], [0, 1, 1]);
    const rows = await rowsOf(join(l.lancedb, "default"));
    assert.equal(rows.length, 4);
    const card = rows.find((x) => x.text.endsWith("a new fact 7"));
    assert.ok(card && card.dimension === DIM && card.hot === 7, "the parked card is in the store, in the target vector space");
  });

  it("another harness store is left untouched: cards are deferred and never reach the engine; parked runs never call it", { timeout }, async () => {
    const fx = await fixture();
    const src = await hermesStore();
    // A home whose store came from elsewhere (a plain import without --adopt-store wrote it).
    const home = tempDir("p1b-hm-cards-deferred-");
    const l = layout(home);
    await importHermes({ home, source: fx.root, apply: true, testInternals: modelInternals() });
    const before = treeDigest(l.lancedb);

    const { engine, calls } = recordingEngine();
    const r = await importHermes({ home, source: fx.root, adoptStore: src, apply: true, engine, testInternals: modelInternals() });
    assert.equal(r.storeAdopt?.reason, "store-exists-skipped");
    assert.deepEqual(calls, [], "deferred cards never reach the engine");
    assert.deepEqual(memoryCards(r).map((c) => [c.outcome, c.reason]), [["deferred", "agent-store-not-taken-over"], ["deferred", "agent-store-not-taken-over"]]);
    assert.deepEqual([r.counts.memoryCardsDeferred, r.counts.memoryCardsImported], [2, 0]);
    assert.equal(ledgerOf(r).filter((e) => e.entity === "memory" && e.action === "deferred").length, 2);
    assert.equal(treeDigest(l.lancedb), before);
    assert.match(renderHermes(r), /2 deferred/);

    // --adopt-strategy reembed with an injected engine: parked, the engine is not called either.
    const home2 = tempDir("p1b-hm-cards-pending-stub-");
    const foreign = await hermesStore((i) => i + 50);
    const rec2 = recordingEngine();
    const r2 = await importHermes({ home: home2, source: fx.root, adoptStore: foreign, adoptStrategy: "reembed", apply: true, engine: rec2.engine, testInternals: modelInternals() });
    assert.deepEqual(rec2.calls, []);
    assert.equal(r2.counts.memoryCardsPendingReembed, 2);
  });

  it("dry run: a matching store plans the cards as created, a reembed route plans them as pending-reembed, nothing is written", { timeout }, async () => {
    const fx = await fixture();
    const home = tempDir("p1b-hm-cards-dry-");
    const ok = await importHermes({ home, source: fx.root, adoptStore: await hermesStore(), apply: false, testInternals: modelInternals() });
    assert.equal(ok.storeAdopt?.action, "preview-ok");
    assert.deepEqual(memoryCards(ok).map((c) => c.outcome), ["created", "created"]);
    const re = await importHermes({ home, source: fx.root, adoptStore: await hermesStore((i) => i + 50), adoptStrategy: "reembed", apply: false, testInternals: modelInternals() });
    assert.equal(re.storeAdopt?.routedTo, "reembed");
    assert.deepEqual(memoryCards(re).map((c) => c.outcome), ["pending-reembed", "pending-reembed"]);
    assert.equal(re.counts.memoryCardsPendingReembed, 2);
    assert.ok(!existsSync(join(home, "state", "lancedb")) && !existsSync(join(home, "imports")), "dry run wrote nothing");
  });

  it("engine-side link (contract 1.16.0): the existing memory carries the card's source; a rollback of the take-over run reverts it with the store", { timeout }, async () => {
    const fx = await fixture();
    const src = await hermesStore();
    const home = tempDir("p1b-hm-cards-engine-link-");
    const l = layout(home);
    const r = await importHermes({ home, source: fx.root, adoptStore: src, apply: true, testInternals: modelInternals() });
    assert.deepEqual(r.errors, [], JSON.stringify(r.errors));
    const [dup] = memoryCards(r);
    assert.deepEqual([dup!.outcome, dup!.linkedTo], ["linked", ROW(1)]);
    assert.match(dup!.linkId ?? "", /^[0-9a-f]{32}$/);
    const entry = ledgerOf(r).find((e) => e.entity === "memory" && e.action === "linked");
    assert.deepEqual([entry.details.linkId, entry.details.engineLink, entry.details.agentId], [dup!.linkId, "linked", "default"]);

    const engine = createEngine(createTempHost(l.state, async (id: string) => l.workspaceDir(id)), buildEngineConfig(defaults(), l) as any, { internals: modelInternals() });
    try {
      const card = await engine.memory.show(ROW(1), { agentId: "default", workspace: "workspace:v1:main", channel: "cli", accountId: "default", chat: { id: "c1", kind: "direct" }, trust: "proved" } as any, { origin: "user", background: false });
      assert.equal(card.links?.length, 1);
      assert.deepEqual([card.links![0]!.linkId, card.links![0]!.importRunId], [dup!.linkId, r.runId]);
      assert.match(card.links![0]!.sourceRef, /^hermes:default:memories\/MEMORY\.md#1;run=/);
    } finally { await engine.close({ budgetMs: 5_000 }); }

    // The run took the store over: rolling it back removes the store, and the link with it (nothing to unlink).
    const plan = await rollbackImport({ home, reportPath: r.reportPath!, apply: false, sourceType: "hermes", testInternals: modelInternals() });
    assert.equal(plan.storeUndoStatus, "removed");
    assert.deepEqual(plan.memoryLinks, { recorded: 1, status: "reverted-with-store" });
  });
  it.todo("KNOWN GAP: a run without --adopt-store after a reembed take-over imports the parked cards without duplicate linking (no store named, the plain import); the documented path is to re-run with the same --adopt-store");
});
