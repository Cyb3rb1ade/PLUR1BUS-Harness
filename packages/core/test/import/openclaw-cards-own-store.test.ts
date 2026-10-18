// openclaw-cards-own-store.test.ts — owner decision 18.10. (PR 582): OpenClaw memory cards are written only for agents
// WITHOUT a store of their own. An agent that has its own PLUR1BUS store partition in the source keeps its memory
// there: its cards are skipped, listed in the report with the reason `agent-has-own-store`, counted, and recorded in
// the ledger as skipped (no silent loss). The engine is a recording stub: nothing is embedded, no model is loaded.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { layout } from "../../src/paths.ts";
import { importOpenclaw } from "../../src/import/importers/openclaw.ts";
import { renderOpenclaw } from "../../src/import/render.ts";
import { tempDir } from "../helpers/temp-dir.ts";
import { flatTestInternals } from "../helpers/flat-embedder.ts";
import { addOpenclawAgentWithoutStore, buildM7OpenclawFixture, CONTENT_MARKER, type M7OpenclawFixture } from "./fixtures.ts";

const REASON = "agent-has-own-store";

/** The M7 fixture (alpha and beta each own a store partition and have MEMORY.md; alpha also USER.md) plus `gamma`:
 *  no store of its own, two memory cards. */
async function fixture(): Promise<M7OpenclawFixture> {
  const fx = await buildM7OpenclawFixture();
  addOpenclawAgentWithoutStore(fx.root, "gamma", { memory: `${CONTENT_MARKER} gamma card one\n§\n${CONTENT_MARKER} gamma card two\n` });
  return fx;
}

/** A recording engine stub: `memory.import` reports every card as created and remembers which agent it was asked for. */
function recordingEngine() {
  const calls: { agentId: string; texts: string[]; dryRun: boolean }[] = [];
  const engine = {
    memory: {
      import: async (req: { agentId: string; cards: { idempotencyKey: string; text: string }[]; dryRun: boolean }) => {
        calls.push({ agentId: req.agentId, texts: req.cards.map((c) => c.text), dryRun: req.dryRun });
        return {
          created: req.dryRun ? 0 : req.cards.length, matchedExisting: 0, rejected: 0,
          cards: req.cards.map((c) => ({ idempotencyKey: c.idempotencyKey, outcome: "created" })),
        };
      },
    },
  } as any;
  return { engine, calls };
}

const mem = (r: Awaited<ReturnType<typeof importOpenclaw>>, id: string) => {
  const a = r.agents.find((x) => x.harnessAgentId === id);
  assert.ok(a, `agent ${id} missing from the report`);
  assert.ok(a.memory, `agent ${id} has no memory result`);
  return a.memory;
};

describe("OpenClaw memory cards: agents with their own store are excluded (PR 582 owner decision)", () => {
  it("an agent with its own store is skipped and listed with the reason; an agent without one is imported", { timeout: 60_000 }, async () => {
    const fx = await fixture();
    try {
      const home = tempDir("p1b-oc-cards-own-");
      const { engine, calls } = recordingEngine();

      const r = await importOpenclaw({ home, source: fx.root, apply: true, engine, testInternals: flatTestInternals() });

      assert.deepEqual(r.errors.filter((e) => /MEMORY|USER|memory-import/.test(`${e.sourceRef} ${e.reason}`)), [], "no card error");
      // gamma has no store: imported.
      assert.deepEqual(calls.map((c) => c.agentId), ["gamma"], "only the agent without a store reaches the engine");
      assert.equal(calls[0]!.texts.length, 2);
      assert.equal(mem(r, "gamma").importedCount, 2);
      assert.equal(mem(r, "gamma").skippedOwnStoreCount, 0);
      // alpha (MEMORY.md + USER.md) and beta (MEMORY.md) own a store: skipped, not lost.
      const alpha = mem(r, "alpha");
      assert.equal(alpha.importedCount, 0);
      assert.equal(alpha.skippedOwnStoreCount, 2, "alpha: one MEMORY.md card and one USER.md card");
      assert.equal(alpha.cardResults.length, 2);
      assert.ok(alpha.cardResults.every((c) => c.outcome === "skipped" && c.reason === REASON), JSON.stringify(alpha.cardResults));
      const beta = mem(r, "beta");
      assert.equal(beta.importedCount, 0);
      assert.equal(beta.skippedOwnStoreCount, 1);
      assert.ok(beta.cardResults.every((c) => c.outcome === "skipped" && c.reason === REASON));
      assert.equal(r.counts.memoryCardsImported, 2);
      assert.equal(r.counts.memoryCardsSkippedOwnStore, 3);
      assert.equal(r.counts.memoryCardsRejected, 0);
      // The skip is in the ledger, with the reason.
      const ledger = readFileSync(r.ledgerPath!, "utf8").trim().split("\n").map((l) => JSON.parse(l));
      const skipped = ledger.filter((e) => e.entity === "memory" && e.action === "skipped" && e.reason === REASON);
      assert.equal(skipped.length, 3);
      assert.ok(skipped.every((e) => /^openclaw:(alpha|beta):/.test(e.sourceRef)));
      // And in the human report.
      const human = renderOpenclaw(r);
      assert.ok(human.includes(`2 skipped (${REASON})`) && human.includes(`1 skipped (${REASON})`), human);
      assert.ok(human.includes(`3 skipped (${REASON})`), "the summary line carries the total");
    } finally {
      fx.close();
    }
  });

  it("dry run plans the same split and never calls the engine", { timeout: 60_000 }, async () => {
    const fx = await fixture();
    try {
      const home = tempDir("p1b-oc-cards-own-dry-");
      const { engine, calls } = recordingEngine();

      const r = await importOpenclaw({ home, source: fx.root, engine, testInternals: flatTestInternals() });

      assert.equal(r.mode, "dry-run");
      assert.equal(mem(r, "alpha").skippedOwnStoreCount, 2);
      assert.equal(mem(r, "beta").skippedOwnStoreCount, 1);
      assert.equal(r.counts.memoryCardsSkippedOwnStore, 3);
      assert.ok(calls.every((c) => c.agentId === "gamma"), "no dry-run engine call for an agent with its own store");
    } finally {
      fx.close();
    }
  });

  it("when every agent with cards owns a store, the card path opens no engine and writes no partition", { timeout: 60_000 }, async () => {
    const fx = await buildM7OpenclawFixture();
    try {
      const home = tempDir("p1b-oc-cards-own-noengine-");
      // No injected engine: the card path would have to open one (and write beta's partition into state/lancedb) to
      // import anything. Both agents with cards own a store, so it must not.
      const r = await importOpenclaw({ home, source: fx.root, apply: true, testInternals: flatTestInternals() });

      assert.equal(r.counts.memoryCardsImported, 0);
      assert.equal(r.counts.memoryCardsSkippedOwnStore, 3);
      const lancedb = layout(home).lancedb;
      const partitions = existsSync(lancedb) ? readdirSync(lancedb) : [];
      assert.ok(!partitions.includes("beta"), `the card path wrote beta's partition: ${partitions.join(",")}`);
    } finally {
      fx.close();
    }
  });
});
