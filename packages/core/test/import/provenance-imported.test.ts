// provenance-imported.test.ts — M7 provenance: "imported" (docs/import.md §6.4, M7 acceptance 6). Every memory card an importer
// writes goes through Engine.memory.import and so carries provenance "imported", the source it came from, the import run and a
// time. Real engine on a temp home, stub embedder, synthetic Hermes fixture; no model, no network.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { defaults } from "@plur1bus/config-schema";
import { createEngine } from "@cyb3rb1ade/plur1bus-memory/engine/create-engine.js";
import { layout } from "../../src/paths.ts";
import { buildEngineConfig } from "../../src/engine-config.ts";
import { importHermes, type HermesImportReport } from "../../src/import/importers/hermes.ts";
import { createTempHost } from "../../src/import/importers/hermes-stores.ts";
import { rollbackImport } from "../../src/import/rollback.ts";
import { tempDir } from "../helpers/temp-dir.ts";
import { flatTestInternals } from "../helpers/flat-embedder.ts";
import { buildM7HermesFixture, CONTENT_MARKER } from "./fixtures.ts";
import { treeDigest } from "./tree.ts";

const timeout = 90_000;
const USER_V1 = `user:v1:${"a".repeat(64)}`;
const operator = (agentId: string, user?: string) =>
  ({ agentId, channel: user ? "telegram" : "cli", accountId: "default", chat: { id: "c1", kind: "direct" }, trust: "proved", ...(user ? { user } : {}) }) as any;
const userAgent = { origin: "user", background: false } as const;

async function withEngine<T>(home: string, fn: (e: ReturnType<typeof createEngine>) => Promise<T>): Promise<T> {
  const l = layout(home);
  const engine = createEngine(
    createTempHost(l.state, async (id: string) => l.workspaceDir(id)),
    buildEngineConfig(defaults(), l) as any,
    { internals: flatTestInternals() },
  );
  try { return await fn(engine); } finally { await engine.close({ budgetMs: 5_000 }); }
}

async function runHermes(home: string, source: string): Promise<{ r: HermesImportReport; runId: string; from: number; to: number }> {
  const from = Date.now();
  const r = await importHermes({ home, source, apply: true, testInternals: flatTestInternals() as any, userPrincipal: operator("default", USER_V1) });
  return { r, runId: basename(dirname(r.reportPath!)), from, to: Date.now() };
}

async function cards(home: string, agentId: string, user?: string) {
  return withEngine(home, async (e) => (await e.memory.list({ since: 0, limit: 100 }, operator(agentId, user), userAgent)).items);
}

describe("provenance \"imported\" (M7 acceptance 6)", () => {
  it("every imported Hermes card (MEMORY.md and USER.md) carries provenance, source, import run and time", { timeout }, async () => {
    const fx = await buildM7HermesFixture();
    const home = tempDir("p2-prov-hermes-");
    const { r, runId, from, to } = await runHermes(home, fx.root);
    assert.ok(r.counts.memoryCardsImported >= 4, "fixture has two MEMORY.md and two USER.md cards for the default profile");

    const agent = await cards(home, "default");
    const user = await cards(home, "default", USER_V1);
    const all = [...agent.filter((c) => c.scope === "agent-private"), ...user.filter((c) => c.scope === "user")];
    assert.equal(all.filter((c) => c.scope === "agent-private").length, 2);
    assert.equal(all.filter((c) => c.scope === "user").length, 2);
    for (const c of all) {
      assert.equal(c.provenance, "imported", `card ${c.id} lost its provenance`);
      assert.match(String(c.sourceRef), new RegExp(`^hermes:default:memories/(MEMORY|USER)\\.md#[12];run=${runId}$`), "source file, position and run id");
      assert.ok(typeof c.createdAt === "number" && c.createdAt >= from - 5_000 && c.createdAt <= to + 5_000, "time is the import time");
      assert.ok(c.text.includes(CONTENT_MARKER));
    }
    // The engine's import sidecar records the time the card was imported next to the same source reference.
    const sidecars = readdirSync(layout(home).lancedb, { recursive: true }).map(String).filter((n) => /_imports[\\/]default\.jsonl$/.test(n));
    assert.equal(sidecars.length, 1);
    const lines = readFileSync(join(layout(home).lancedb, sidecars[0]!), "utf8").trim().split("\n").map((x) => JSON.parse(x));
    assert.equal(lines.length, 4);
    for (const line of lines) {
      assert.ok(line.importedAt >= from - 5_000 && line.importedAt <= to + 5_000);
      assert.ok(String(line.sourceRef).endsWith(`;run=${runId}`));
    }
  });

  it("a second run keeps the origin of the first (matched-existing, no new run id on the cards)", { timeout }, async () => {
    const fx = await buildM7HermesFixture();
    const home = tempDir("p2-prov-rerun-");
    const first = await runHermes(home, fx.root);
    const second = await runHermes(home, fx.root);
    assert.notEqual(first.runId, second.runId);
    assert.equal(second.r.counts.memoryCardsImported, 0);
    const refs = (await cards(home, "default")).map((c) => c.sourceRef);
    assert.ok(refs.length > 0 && refs.every((x) => String(x).endsWith(`;run=${first.runId}`)));
  });

  it("KNOWN GAP: editing a card (memory.correct) writes a new card id, so the new version loses provenance; the origin stays on the archived original", { timeout }, async () => {
    // The engine's origin marker is keyed by card id (the import sidecar), and `correct` supersedes the row with a new id.
    // Preserving the origin on edit needs an engine change (carry the sidecar entry over, or keep the id), which this
    // package may not make. This test pins today's behaviour and fails the day the engine fixes it, so the gap is
    // closed on purpose and not forgotten.
    const fx = await buildM7HermesFixture();
    const home = tempDir("p2-prov-edit-");
    const { runId } = await runHermes(home, fx.root);
    const { before, edited } = await withEngine(home, async (e) => {
      const before = (await e.memory.list({ since: 0, limit: 100 }, operator("default"), userAgent)).items.find((c) => c.scope === "agent-private")!;
      const res = await e.memory.correct(before.id, `${before.text} (edited)`, operator("default"), userAgent);
      return { before, edited: await e.memory.show(res.id, operator("default"), userAgent) };
    });
    assert.match(String(before.sourceRef), new RegExp(`;run=${runId}$`), "the original had its origin");
    assert.ok(edited.text.endsWith("(edited)"));
    assert.equal(edited.provenance, undefined, "KNOWN GAP closed by the engine: assert provenance imported and the run id here, and update docs/import.md section 11");
  });

  it("rollback reports exactly this run's cards as not reverted (the engine has no undo) and touches no card of any run", { timeout }, async () => {
    // KNOWN GAP (docs/import.md section 11): "rollback removes exactly the cards of the run" is not possible today. The engine has
    // no undo, and forgetting a card writes a tombstone that blocks the same card from ever being imported again, so a
    // rollback through forget would make the next import silently lose those cards. Rollback therefore states the
    // number of cards of THIS run that stay and leaves the store byte-identical.
    const fx = await buildM7HermesFixture();
    const home = tempDir("p2-prov-rollback-");
    const first = await runHermes(home, fx.root);
    const memoryFile = join(fx.root, "memories", "MEMORY.md");
    writeFileSync(memoryFile, `${readFileSync(memoryFile, "utf8")}§\n${CONTENT_MARKER} a third card, only in the second run\n`);
    const second = await runHermes(home, fx.root);
    assert.equal(second.r.counts.memoryCardsImported, 1, "the second run adds exactly the new card");
    const store = treeDigest(layout(home).lancedb);
    const rb = await rollbackImport({ home, reportPath: second.r.reportPath!, apply: true, sourceType: "hermes" });
    assert.equal(rb.memoryCardsNotReverted, 1, "exactly the cards of the second run, not the first run's");
    assert.equal(rb.memoryUndoStatus, "not-reverted (engine has no undo)");
    assert.equal(treeDigest(layout(home).lancedb), store, "the store is untouched by a rollback");
    const rbFirst = await rollbackImport({ home, reportPath: first.r.reportPath!, apply: false, sourceType: "hermes" });
    assert.equal(rbFirst.memoryCardsNotReverted, first.r.counts.memoryCardsImported);
  });
});
