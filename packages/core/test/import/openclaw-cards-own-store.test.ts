// openclaw-cards-own-store.test.ts — owner decision 2026-10-19 (replaces the blanket skip of 2026-10-18, PR 582): OpenClaw
// memory cards are imported for EVERY agent, also for an agent with a PLUR1BUS store of its own.
//   - store taken over: each card is checked against that store first; a card that is already there (engine duplicate
//     rule) is not written again but linked to the existing memory (report outcome "linked", ledger action "linked" with
//     the memory id); a new card is written into the store, embedded in the harness's vector space.
//   - store routed to the re-embedding migration: the cards are parked ("pending-reembed", counted, in the ledger), never
//     embedded into a vector space the store is not in; the run that takes the store over imports them.
//   - no store of its own: unchanged.
// Stub embedders only (no model load, no network).
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { layout } from "../../src/paths.ts";
import { importOpenclaw, type OpenclawImportReport } from "../../src/import/importers/openclaw.ts";
import { renderOpenclaw, renderRollback } from "../../src/import/render.ts";
import { rollbackImport } from "../../src/import/rollback.ts";
import { createTempHost } from "../../src/import/importers/hermes-stores.ts";
import { buildEngineConfig } from "../../src/engine-config.ts";
import { createEngine } from "@cyb3rb1ade/plur1bus-memory/engine/create-engine.js";
import { defaults } from "@plur1bus/config-schema";
import { loadLanceDb } from "../../src/import/readonly.ts";
import { tempDir } from "../helpers/temp-dir.ts";
import { flatTestInternals } from "../helpers/flat-embedder.ts";
import { addOpenclawAgentWithoutStore, buildM7OpenclawFixture, CONTENT_MARKER, lanceStore, write, type M7OpenclawFixture } from "./fixtures.ts";

const timeout = 90_000;
const DIM = 384;
const ROW = (i: number) => `00000000-0000-4000-8000-00000000000${i}`;
/** The engine columns a recall reads (the plugin writes them; the shared fixture rows carry only id/text/vector). */
const ENGINE_COLUMNS = {
  type: "memory", confirmed: false, summary: "", origin: "dm", importance: 0.5, category: "other", createdAt: 1_760_000_000_000,
  expiresAt: 0, scope: "agent-private", status: "active", updatedAt: 1_760_000_000_000, ownerUserId: "",
};

/** A deterministic stub "model" (as in openclaw-store-takeover.test.ts): text ending in `<n>` -> unit vector at n, text
 *  without a trailing number -> unit vector at 0. The fixture rows `<marker> <i>` carry the unit vector at i, so this is the
 *  model that wrote the matching stores. */
function modelInternals() {
  const hot = (text: string) => Number(/(\d+)\s*$/.exec(text)?.[1] ?? 0);
  const vector = (text: string) => Array.from({ length: DIM }, (_, i) => (i === hot(text) ? 1 : 0));
  const one = async (text: string) => vector(text);
  return { embeddings: { embed: one, embedQuery: one, embedPassage: one, embedBatch: async (texts: string[]) => texts.map(vector), shutdown: async () => {} }, reranker: null };
}

const storeRoot = (fx: M7OpenclawFixture) => join(fx.root, "memory", "lancedb-namespaced");

/** The M7 fixture with alpha's store as the plugin writes it (taken over with the stub model) and the schema marker; beta
 *  keeps its 768-d store (routed to the re-embedding migration). alpha's MEMORY.md holds one card that is already in its
 *  store (the text of row 1) and one new card (unit vector 7, in no row). */
async function fixture(): Promise<M7OpenclawFixture> {
  const fx = await buildM7OpenclawFixture();
  rmSync(join(storeRoot(fx), "alpha"), { recursive: true, force: true });
  await lanceStore(join(storeRoot(fx), "alpha"), DIM, 3, { ...ENGINE_COLUMNS, agentId: "alpha" });
  write(join(storeRoot(fx), "_schema.json"), JSON.stringify({ schemaVersion: "1" }));
  write(fx.curatedFiles.memory, `${CONTENT_MARKER} 1\n§\n${CONTENT_MARKER} a new fact 7\n`);
  return fx;
}

const mem = (r: OpenclawImportReport, id: string) => {
  const a = r.agents.find((x) => x.harnessAgentId === id);
  assert.ok(a?.memory, `agent ${id} has no memory result`);
  return a.memory;
};
const ledgerOf = (r: OpenclawImportReport) => readFileSync(r.ledgerPath!, "utf8").trim().split("\n").map((x) => JSON.parse(x));

/** Every row of one partition: id, text and the index of its unit vector, with the vector's dimension. */
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

describe("OpenClaw memory cards of agents with their own store (owner decision 2026-10-19)", () => {
  it("store taken over: a card already in the store is linked to it, a new card is written into the store", { timeout }, async () => {
    const fx = await fixture();
    try {
      const home = tempDir("p1b-oc-cards-link-");
      const r = await importOpenclaw({ home, source: fx.root, apply: true, testInternals: modelInternals() });

      assert.equal(r.stores.find((s) => s.storeId === "agent:alpha")?.action, "taken-over");
      assert.deepEqual(r.errors, [], JSON.stringify(r.errors));
      const alpha = mem(r, "alpha");
      const [dup, fresh] = alpha.cardResults.filter((c) => c.idempotencyKey.includes(":MEMORY.md:"));
      assert.equal(dup!.outcome, "linked");
      assert.equal(dup!.reason, "duplicate-of-existing");
      assert.equal(dup!.linkedTo, ROW(1), "linked to the memory it duplicates");
      assert.equal(fresh!.outcome, "created");
      assert.equal(alpha.linkedCount, 1);
      assert.equal(alpha.importedCount, 1);
      assert.equal(r.counts.memoryCardsLinked, 1);
      assert.equal(r.counts.memoryCardsImported, 1);

      // The store: the three source rows unchanged plus exactly the new card, embedded by the harness model (384-d,
      // unit vector 7); the duplicate was not written a second time.
      const rows = await rowsOf(join(layout(home).lancedb, "alpha"));
      assert.equal(rows.length, 4);
      assert.equal(rows.filter((x) => x.text === `${CONTENT_MARKER} 1`).length, 1, "the duplicate is not in the store twice");
      const added = rows.find((x) => x.text.endsWith("a new fact 7"));
      assert.ok(added && added.dimension === DIM && added.hot === 7, "the new card is in alpha's store, in the harness vector space");

      // The link is in the ledger (card source -> existing memory id) and in the human report.
      const linked = ledgerOf(r).filter((e) => e.entity === "memory" && e.action === "linked");
      assert.equal(linked.length, 1);
      assert.equal(linked[0].targetRef, `memory:${ROW(1)}`);
      assert.match(linked[0].sourceRef, /^openclaw:alpha:MEMORY\.md#1;run=/);
      assert.match(renderOpenclaw(r), /1 linked/);
      assert.ok(!JSON.stringify(r).includes(CONTENT_MARKER), "the report carries no card text");

      // A second run reuses the link (no new card, no second link target) and writes nothing to the store.
      const before = await rowsOf(join(layout(home).lancedb, "alpha"));
      const again = await importOpenclaw({ home, source: fx.root, apply: true, testInternals: modelInternals() });
      const alpha2 = mem(again, "alpha").cardResults.filter((c) => c.idempotencyKey.includes(":MEMORY.md:"));
      assert.deepEqual(alpha2.map((c) => [c.outcome, c.linkedTo ?? null]), [["linked", ROW(1)], ["matched-existing", null]]);
      assert.deepEqual(await rowsOf(join(layout(home).lancedb, "alpha")), before);
    } finally {
      fx.close();
    }
  });

  it("store in the re-embedding migration: cards are pending-reembed, and imported in the target space once the store is taken over", { timeout }, async () => {
    const fx = await fixture();
    try {
      write(join(fx.root, "ws-beta", "MEMORY.md"), `${CONTENT_MARKER} beta fact 9\n`);
      const home = tempDir("p1b-oc-cards-pending-");
      const l = layout(home);
      const first = await importOpenclaw({ home, source: fx.root, apply: true, testInternals: modelInternals() });

      assert.equal(first.stores.find((s) => s.storeId === "agent:beta")?.action, "re-embedding-migration");
      const beta = mem(first, "beta");
      assert.equal(beta.pendingReembedCount, 1);
      assert.deepEqual(beta.cardResults.map((c) => [c.outcome, c.reason]), [["pending-reembed", "agent-store-reembed-migration"]]);
      assert.equal(beta.importedCount, 0);
      assert.equal(first.counts.memoryCardsPendingReembed, 1);
      assert.ok(!readdirSync(l.lancedb).includes("beta"), "no beta partition: nothing embedded in a space beta's store is not in");
      const parked = ledgerOf(first).filter((e) => e.entity === "memory" && e.action === "pending-reembed");
      assert.equal(parked.length, 1);
      assert.match(parked[0].sourceRef, /^openclaw:beta:MEMORY\.md#1;run=/);
      assert.match(renderOpenclaw(first), /1 pending-reembed/);

      // The migration is done: beta's store now carries vectors of the harness model (384-d, rows at 0 and 1). beta's card
      // (unit vector 9) is a new memory. The harness already has a store, so the take-over swaps it whole.
      rmSync(join(storeRoot(fx), "beta"), { recursive: true, force: true });
      await lanceStore(join(storeRoot(fx), "beta"), DIM, 2, { ...ENGINE_COLUMNS, agentId: "beta" });
      const second = await importOpenclaw({ home, source: fx.root, apply: true, onConflict: "replace", testInternals: modelInternals() });

      assert.equal(second.stores.find((s) => s.storeId === "agent:beta")?.action, "taken-over");
      const beta2 = mem(second, "beta");
      assert.equal(beta2.pendingReembedCount, 0);
      assert.deepEqual(beta2.cardResults.map((c) => c.outcome), ["created"]);
      assert.equal(second.counts.memoryCardsPendingReembed, 0);
      const rows = await rowsOf(join(l.lancedb, "beta"));
      assert.equal(rows.length, 3);
      const card = rows.find((x) => x.text.endsWith("beta fact 9"));
      assert.ok(card && card.dimension === DIM && card.hot === 9, "beta's card is in beta's store, in the target vector space");
      assert.ok(rows.every((x) => x.dimension === DIM));
    } finally {
      fx.close();
    }
  });

  it("an agent without a store of its own is imported as before; parked agents never reach the engine or state/lancedb", { timeout }, async () => {
    const fx = await buildM7OpenclawFixture();
    try {
      addOpenclawAgentWithoutStore(fx.root, "gamma", { memory: `${CONTENT_MARKER} gamma card one\n§\n${CONTENT_MARKER} gamma card two\n` });
      const calls: { agentId: string; n: number; dryRun: boolean }[] = [];
      const engine = {
        memory: {
          import: async (req: { agentId: string; cards: { idempotencyKey: string }[]; dryRun: boolean }) => {
            calls.push({ agentId: req.agentId, n: req.cards.length, dryRun: req.dryRun });
            return { created: req.dryRun ? 0 : req.cards.length, matchedExisting: 0, rejected: 0, cards: req.cards.map((c) => ({ idempotencyKey: c.idempotencyKey, outcome: "created" })) };
          },
        },
      } as any;
      // Without the schema marker alpha's store is not taken over (schema-mismatch): its cards are deferred. beta's 768-d
      // store goes to the re-embedding migration: its card is pending-reembed.
      const home = tempDir("p1b-oc-cards-nostore-");
      const r = await importOpenclaw({ home, source: fx.root, apply: true, engine, testInternals: flatTestInternals() });

      assert.deepEqual(calls, [{ agentId: "gamma", n: 2, dryRun: false }], "only the agent without a store reaches the engine");
      assert.equal(mem(r, "gamma").importedCount, 2);
      assert.equal(mem(r, "gamma").pendingReembedCount + mem(r, "gamma").deferredCount + mem(r, "gamma").linkedCount, 0);
      // alpha's MEMORY.md card is deferred; its USER.md card has no user binding: unresolved-user-scope, never parked
      // (ADR-007 Q4 first, the Hermes rule).
      assert.equal(mem(r, "alpha").deferredCount, 1, "alpha: the MEMORY.md card");
      assert.deepEqual(mem(r, "alpha").cardResults.map((c) => [c.outcome, c.reason]), [["deferred", "agent-store-not-taken-over"], ["unresolved-user-scope", "unambiguous-user-required"]]);
      assert.equal(mem(r, "alpha").unresolvedUserScopeCount, 1);
      assert.equal(mem(r, "beta").pendingReembedCount, 1);
      assert.equal(r.counts.memoryCardsImported, 2);
      assert.equal(r.counts.memoryCardsPendingReembed, 1);
      assert.equal(r.counts.memoryCardsDeferred, 1);
      assert.deepEqual(ledgerOf(r).filter((e) => e.entity === "memory" && e.action === "deferred").length, 1);

      // Without an injected engine the card path opens none for parked cards: no partition of alpha or beta appears.
      const home2 = tempDir("p1b-oc-cards-nostore-noengine-");
      const r2 = await importOpenclaw({ home: home2, source: fx.root, apply: true, testInternals: flatTestInternals() });
      assert.equal(r2.counts.memoryCardsPendingReembed + r2.counts.memoryCardsDeferred, 2);
      const lancedb = layout(home2).lancedb;
      const partitions = existsSync(lancedb) ? readdirSync(lancedb) : [];
      assert.ok(!partitions.includes("alpha") && !partitions.includes("beta"), `the card path wrote a parked agent's partition: ${partitions.join(",")}`);
    } finally {
      fx.close();
    }
  });

  it("engine-side link (contract 1.16.0): the existing memory carries the card's source; rolling the run back unlinks it", { timeout }, async () => {
    const fx = await fixture();
    try {
      const home = tempDir("p1b-oc-cards-engine-link-");
      const l = layout(home);
      // Run 1 takes alpha's store over with the new card only; run 2 brings the duplicate of row 1 (no store action).
      write(fx.curatedFiles.memory, `${CONTENT_MARKER} a new fact 7\n`);
      const first = await importOpenclaw({ home, source: fx.root, apply: true, testInternals: modelInternals() });
      assert.equal(first.stores.find((s) => s.storeId === "agent:alpha")?.action, "taken-over");
      write(fx.curatedFiles.memory, `${CONTENT_MARKER} 1\n§\n${CONTENT_MARKER} a new fact 7\n`);
      const second = await importOpenclaw({ home, source: fx.root, apply: true, testInternals: modelInternals() });
      assert.deepEqual(second.errors, [], JSON.stringify(second.errors));
      const run2 = second.runId!;

      const [dup] = mem(second, "alpha").cardResults.filter((c) => c.idempotencyKey.includes(":MEMORY.md:"));
      assert.deepEqual([dup!.outcome, dup!.reason, dup!.linkedTo], ["linked", "duplicate-of-existing", ROW(1)]);
      assert.match(dup!.linkId ?? "", /^[0-9a-f]{32}$/, "the report carries the engine link id");
      const entry = ledgerOf(second).find((e) => e.entity === "memory" && e.action === "linked");
      assert.deepEqual([entry.details.linkId, entry.details.engineLink, entry.details.agentId], [dup!.linkId, "linked", "alpha"]);

      // The engine: the existing memory gained the card's source as a link of run 2; its own row is unchanged.
      const linksOf = async () => {
        const engine = createEngine(createTempHost(l.state, async (id: string) => l.workspaceDir(id)), buildEngineConfig(defaults(), l) as any, { internals: modelInternals() });
        try {
          const card = await engine.memory.show(ROW(1), { agentId: "alpha", workspace: "workspace:v1:main", channel: "cli", accountId: "default", chat: { id: "c1", kind: "direct" }, trust: "proved" } as any, { origin: "user", background: false });
          return { links: card.links ?? [], text: card.text };
        } finally { await engine.close({ budgetMs: 5_000 }); }
      };
      const linked = await linksOf();
      assert.equal(linked.text, `${CONTENT_MARKER} 1`);
      assert.equal(linked.links.length, 1);
      assert.deepEqual([linked.links[0]!.linkId, linked.links[0]!.provenance, linked.links[0]!.importRunId], [dup!.linkId, "imported", run2]);
      assert.match(linked.links[0]!.sourceRef, new RegExp(`^openclaw:alpha:MEMORY\\.md#1;run=${run2}$`));
      assert.equal((await rowsOf(join(l.lancedb, "alpha"))).filter((x) => x.text === `${CONTENT_MARKER} 1`).length, 1, "no duplicate row");

      // Rollback of run 2: the dry run plans the unlink, the apply unlinks; the memory itself stays.
      const plan = await rollbackImport({ home, reportPath: second.reportPath!, apply: false, sourceType: "openclaw", testInternals: modelInternals() });
      assert.deepEqual(plan.memoryLinks && [plan.memoryLinks.recorded, plan.memoryLinks.status, plan.memoryLinks.selected], [1, "planned", 1]);
      assert.equal((await linksOf()).links.length, 1, "the dry run unlinks nothing");
      const done = await rollbackImport({ home, reportPath: second.reportPath!, apply: true, sourceType: "openclaw", testInternals: modelInternals() });
      assert.deepEqual(done.memoryLinks && [done.memoryLinks.recorded, done.memoryLinks.status, done.memoryLinks.selected, done.memoryLinks.unlinked], [1, "unlinked", 1, 1]);
      assert.match(renderRollback(done), /Memory links: 1 recorded, 1 selected, 1 unlinked/);
      const after = await linksOf();
      assert.deepEqual([after.links.length, after.text], [0, `${CONTENT_MARKER} 1`], "unlinked, the linked memory stays");

      // A later run links the card again (the rolled-back run's link is not reused).
      const third = await importOpenclaw({ home, source: fx.root, apply: true, testInternals: modelInternals() });
      const [again] = mem(third, "alpha").cardResults.filter((c) => c.idempotencyKey.includes(":MEMORY.md:"));
      assert.deepEqual([again!.outcome, again!.reason], ["linked", "duplicate-of-existing"]);
      const relinked = await linksOf();
      assert.deepEqual(relinked.links.map((x) => x.importRunId), [third.runId]);
    } finally {
      fx.close();
    }
  });
});
