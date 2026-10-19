// openclaw-store-takeover.test.ts — M7 acceptance 2 and 5 (docs/import.md §6.3), OpenClaw side: a PLUR1BUS store whose
// embedding identity matches the harness is taken over without re-embedding; a store with another identity is routed
// to the guided re-embedding migration and never lands in state/lancedb. Everything runs in temp dirs with a stub
// embedder (no model load, no network); the fixtures are the synthetic M7 OpenClaw tree.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, lstatSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { join, relative } from "node:path";
import { defaults } from "@plur1bus/config-schema";
import { createEngine } from "@cyb3rb1ade/plur1bus-memory/engine/create-engine.js";
import { layout } from "../../src/paths.ts";
import { buildEngineConfig } from "../../src/engine-config.ts";
import { importOpenclaw, type OpenclawImportReport } from "../../src/import/importers/openclaw.ts";
import { createTempHost } from "../../src/import/importers/hermes-stores.ts";
import { rollbackImport } from "../../src/import/rollback.ts";
import { renderOpenclaw } from "../../src/import/render.ts";
import { splitOpenclawCards } from "../../src/import/importers/openclaw-memories.ts";
import { loadLanceDb } from "../../src/import/readonly.ts";
import { tempDir } from "../helpers/temp-dir.ts";
import { buildM7OpenclawFixture, CONTENT_MARKER, FAKE_TOKEN, lanceStore, write, type M7OpenclawFixture } from "./fixtures.ts";
import { treeDigest, treeEntries } from "./tree.ts";

const timeout = 90_000;
const DIM = 384;

/** A deterministic stub "model": the text `<marker> <n>` maps to the unit vector at n + offset. The fixture rows
 *  are `<marker> <i>` with the unit vector at i, so `modelEmbedder(0)` is the model that wrote the matching stores and
 *  `modelEmbedder(10)` is "another model of the same dimension". It counts calls made for the adopt probe
 *  (`purpose: "adopt-probe"`) apart from any other embedding work, and records the texts of that other work: the take-over
 *  itself embeds nothing else; since the owner decision of 2026-10-19 the only other embedding is the card path's (an
 *  agent's MEMORY.md / USER.md cards, checked against and written to the agent's own store). */
function modelEmbedder(offset = 0) {
  const calls = { probe: 0, other: 0, probeTexts: 0, otherTexts: [] as string[] };
  const hot = (text: string) => Number(/(\d+)\s*$/.exec(text)?.[1] ?? 0) + offset;
  const vector = (text: string) => Array.from({ length: DIM }, (_, i) => (i === hot(text) ? 1 : 0));
  const count = (opts: unknown, texts: string[]) => {
    if ((opts as { purpose?: string } | undefined)?.purpose === "adopt-probe") { calls.probe += 1; calls.probeTexts += texts.length; } else { calls.other += 1; calls.otherTexts.push(...texts); }
  };
  const one = async (text: string, opts?: unknown) => { count(opts, [text]); return vector(text); };
  return {
    calls,
    embeddings: {
      embed: one, embedQuery: one, embedPassage: one,
      embedBatch: async (texts: string[], _size?: number, opts?: unknown) => { count(opts, texts); return texts.map(vector); },
      shutdown: async () => {},
    },
  };
}

const storeRoot = (fx: M7OpenclawFixture) => join(fx.root, "memory", "lancedb-namespaced");
/** The schema marker a marker-aware PLUR1BUS plugin leaves at the store root; the engine's adopt refuses a store without it. */
const markStoreCurrent = (fx: M7OpenclawFixture) => write(join(storeRoot(fx), "_schema.json"), JSON.stringify({ schemaVersion: "1" }));

/** The M7 fixture (alpha 384-d matching, beta 768-d mismatched, a matching shared pool) plus, optionally, `gamma`:
 *  384-d like the harness, but written by another model, which only the cosine probe can tell. */
async function fixture(opts: { gamma?: boolean; marker?: boolean } = {}): Promise<M7OpenclawFixture> {
  const fx = await buildM7OpenclawFixture();
  // alpha as the plugin writes it: the engine columns a recall reads (the shared fixture rows carry only id/text/vector).
  rmSync(join(storeRoot(fx), "alpha"), { recursive: true, force: true });
  await lanceStore(join(storeRoot(fx), "alpha"), DIM, 3, {
    type: "memory", confirmed: false, summary: "", origin: "dm", importance: 0.5, category: "other", createdAt: 1_760_000_000_000,
    expiresAt: 0, agentId: "alpha", scope: "agent-private", status: "active", updatedAt: 1_760_000_000_000, ownerUserId: "",
  });
  if (opts.marker !== false) markStoreCurrent(fx);
  if (opts.gamma) await lanceStore(join(storeRoot(fx), "gamma"), DIM, 3, {}, (i) => i + 10);
  return fx;
}

/** Relative path -> "<sha256>" for every entry (treeEntries carries the content hash) plus its permission bits. */
function manifestWithModes(root: string): string {
  return treeEntries(root).map((entry) => {
    const rel = entry.slice(2).split(" ")[0]!;
    const mode = lstatSync(join(root, rel)).mode & 0o777;
    return `${entry} mode=${mode.toString(8)}`;
  }).join("\n");
}

const outsideImports = (dir: string) => treeEntries(dir, { mtime: false }).filter((e) => !/^[DFL] imports(\/|$| )/.test(e)).join("\n");
const stagingLeftovers = (home: string) => (existsSync(layout(home).state) ? readdirSync(layout(home).state).filter((n) => n.startsWith("lancedb.adopt-")) : []);
const byId = (r: OpenclawImportReport, id: string) => {
  const s = r.stores.find((x) => x.storeId === id);
  assert.ok(s, `store ${id} missing from the report: ${r.stores.map((x) => x.storeId).join(", ")}`);
  return s;
};

/** Every row's vector in every partition of a store root: its dimension and the index it points at. */
async function vectorsOf(root: string): Promise<{ partition: string; dimension: number; hot: number[] }[]> {
  const lancedb = (await loadLanceDb())!;
  const out: { partition: string; dimension: number; hot: number[] }[] = [];
  const walk = async (dir: string) => {
    for (const ent of readdirSync(dir, { withFileTypes: true })) {
      if (!ent.isDirectory()) continue;
      const full = join(dir, ent.name);
      if (ent.name === "memories.lance") {
        const db = await lancedb.connect(dir) as any;
        const t = await db.openTable("memories");
        const dimension = (await t.schema()).fields.find((f: any) => f.name === "vector").type.listSize as number;
        const rows = await t.query().select(["vector"]).toArray();
        out.push({ partition: relative(root, dir).replaceAll("\\", "/"), dimension, hot: rows.map((r: any) => Array.from(r.vector.toArray() as Float32Array).indexOf(1)) });
        t.close(); db.close();
      } else await walk(full);
    }
  };
  await walk(root);
  return out;
}

/** Every row of one partition (id, text, vector), ordered by id. */
async function rowsOf(partition: string): Promise<{ id: string; text: string; vector: number[] }[]> {
  const lancedb = (await loadLanceDb())!;
  const db = await lancedb.connect(partition) as any;
  const t = await db.openTable("memories");
  const rows = await t.query().select(["id", "text", "vector"]).toArray();
  t.close(); db.close();
  return rows.map((r: any) => ({ id: String(r.id), text: String(r.text), vector: Array.from(r.vector.toArray() as Float32Array) })).sort((a: any, b: any) => a.id.localeCompare(b.id));
}

/** Recall through a real engine on the target home, against the adopted store. */
async function recallTexts(home: string, agentId: string, topic: string, embeddings: unknown): Promise<string[]> {
  const l = layout(home);
  const engine = createEngine(
    createTempHost(l.state, async (id: string) => l.workspaceDir(id)),
    buildEngineConfig(defaults(), l) as any,
    { internals: { embeddings, reranker: null } },
  );
  try {
    const principal = { agentId, workspace: "workspace:v1:main", channel: "cli", accountId: "default", chat: { id: "c1", kind: "direct" }, trust: "proved" } as const;
    const res = await engine.memory.list({ topic }, principal as any, { origin: "user", background: false });
    return res.items.map((c: any) => String(c.text));
  } finally {
    await engine.close({ budgetMs: 5_000 });
  }
}

describe("OpenClaw store take-over (M7 acceptance 2 and 5)", () => {
  it("P1.1: a store with the harness identity is taken over without re-embedding, recall finds the old memories, the source is byte-identical", { timeout }, async () => {
    const fx = await fixture();
    const home = tempDir("p1b-oc-store-take-");
    const model = modelEmbedder(0);
    const sourceBefore = manifestWithModes(fx.base);

    const r = await importOpenclaw({ home, source: fx.root, apply: true, testInternals: { embeddings: model.embeddings } });

    assert.equal(r.errors.length, 0, JSON.stringify(r.errors));
    assert.equal(byId(r, "agent:alpha").action, "taken-over");
    assert.equal(byId(r, "agent:alpha").plannedAction, "take-over");
    assert.equal(byId(r, "agent:alpha").rows, 3);
    assert.equal(byId(r, `shared:workspaces:${fx.sharedPool.key}`).action, "taken-over");
    assert.equal(r.counts.storesTakenOver, 2);
    // Owner decision 2026-10-19: alpha's cards are imported into alpha's own (taken-over) store, so the card path embeds
    // alpha's MEMORY.md card for the duplicate check against that store. Nothing else is embedded outside the probe.
    const alphaCards = splitOpenclawCards(readFileSync(fx.curatedFiles.memory, "utf8"));
    assert.ok(model.calls.other > 0, "the card path checks alpha's card against alpha's store");
    assert.ok(model.calls.otherTexts.every((t) => alphaCards.includes(t)), "outside the adopt probe only alpha's card is embedded (no store row is re-embedded)");
    assert.ok(model.calls.probe > 0 && model.calls.probeTexts <= 16 * 3, "the probe samples a few rows per store, it does not re-embed the store");
    // The stub model maps alpha's card onto the vector of row 0: the same memory, so it is linked, not written again.
    const alphaMem = r.agents.find((a) => a.harnessAgentId === "alpha")!.memory!;
    const memoryCard = alphaMem.cardResults.find((c) => c.idempotencyKey.includes(":MEMORY.md:"))!;
    assert.equal(memoryCard.outcome, "linked");
    assert.equal(memoryCard.linkedTo, "00000000-0000-4000-8000-000000000000");
    assert.equal(r.counts.memoryCardsLinked, 1);
    assert.equal(r.counts.memoryCardsImported, 0);

    const l = layout(home);
    // The engine opened alpha's partition for the duplicate check (schema upgrade, bootstrap-row cleanup), so its files
    // are no longer byte-identical; its data is: the same rows with the same vectors, no row added, none re-embedded.
    assert.deepEqual(await rowsOf(join(l.lancedb, "alpha")), await rowsOf(join(storeRoot(fx), "alpha")), "the adopted partition holds exactly the source rows and vectors");
    assert.ok(existsSync(join(l.lancedb, ".plur1bus-shared", "workspaces", fx.sharedPool.key, "memories.lance")));
    assert.ok(existsSync(join(l.lancedb, "_schema.json")));
    assert.deepEqual(stagingLeftovers(home), []);
    const ledger = JSON.parse(readLedgerStoreEntry(r));
    assert.equal(ledger.action, "adopted");

    const texts = await recallTexts(home, "alpha", `${CONTENT_MARKER} 1`, model.embeddings);
    assert.ok(texts.some((t) => t.endsWith(" 1")), `pre-import memory not found through the engine: ${texts.join(" | ")}`);
    assert.ok(texts.length >= 3, "all three pre-import memories of alpha are there");

    assert.equal(manifestWithModes(fx.base), sourceBefore, "the source tree (content and permission bits) is untouched");
    fx.close();
  });

  it("P1.2: 768-d and same-dimension foreign-model stores go to the re-embedding migration and never reach state/lancedb", { timeout }, async () => {
    const fx = await fixture({ gamma: true });
    const home = tempDir("p1b-oc-store-route-");
    const model = modelEmbedder(0);

    const dry = await importOpenclaw({ home, source: fx.root, testInternals: { embeddings: model.embeddings } });
    assert.equal(dry.mode, "dry-run");
    assert.equal(byId(dry, "agent:alpha").action, "preview-ok");
    assert.equal(byId(dry, "agent:beta").action, "re-embedding-migration");
    assert.equal(byId(dry, "agent:gamma").action, "re-embedding-migration");
    assert.equal(treeEntries(home).length, 0, "a dry run writes nothing to the target");

    const r = await importOpenclaw({ home, source: fx.root, apply: true, testInternals: { embeddings: model.embeddings } });
    const alpha = byId(r, "agent:alpha");
    const beta = byId(r, "agent:beta");
    const gamma = byId(r, "agent:gamma");
    assert.equal(alpha.action, "taken-over");
    assert.equal(beta.action, "re-embedding-migration");
    assert.equal(beta.plannedAction, "re-embedding-migration");
    assert.ok(beta.reasons.includes("dimension-differs"), beta.reasons.join(","));
    assert.equal(gamma.plannedAction, "take-over", "the recorded evidence says it matches ...");
    assert.equal(gamma.action, "re-embedding-migration", "... the cosine probe says it does not");
    assert.ok(gamma.reasons.includes("identity-mismatch"), gamma.reasons.join(","));
    for (const s of [beta, gamma]) {
      assert.match(s.nextStep ?? "", /plur1bus memory reembed/);
      assert.ok(!(s.nextStep ?? "").includes(CONTENT_MARKER));
    }
    assert.equal(r.counts.storesTakenOver, 2);
    assert.equal(r.counts.storesReembedMigration, 2);
    // beta's card waits for its store (owner decision 2026-10-19): parked, not embedded into the harness store.
    assert.equal(r.counts.memoryCardsPendingReembed, 1);

    // Nothing of beta or gamma is in the harness store: no partition, and every vector in it is a 384-d vector of the
    // harness model (alpha rows point at 0..2; gamma's foreign vectors point at 10..12).
    const l = layout(home);
    const target = await vectorsOf(l.lancedb);
    assert.deepEqual(target.map((t) => t.partition).sort(), [`.plur1bus-shared/workspaces/${fx.sharedPool.key}`, "alpha"]);
    for (const t of target) {
      assert.equal(t.dimension, DIM, `${t.partition} has a foreign dimension`);
      assert.ok(t.hot.every((h) => h >= 0 && h < 3), `${t.partition} holds vectors of another model: ${t.hot.join(",")}`);
    }
    assert.ok(!treeEntries(l.state).some((e) => /\b(beta|gamma)\b/.test(e)), "no trace of the routed stores under state/");
    assert.deepEqual(stagingLeftovers(home), []);

    const human = renderOpenclaw(r);
    assert.match(human, /re-embedding-migration/);
    assert.match(human, /plur1bus memory reembed/);
    assert.ok(!human.includes(CONTENT_MARKER) && !human.includes(FAKE_TOKEN));
    assert.ok(!JSON.stringify(r).includes(CONTENT_MARKER));
    fx.close();
  });

  it("P1.2b: a store without the schema marker is not blindly copied (schema-mismatch), nothing lands in state/lancedb", { timeout }, async () => {
    const fx = await fixture({ marker: false });
    const home = tempDir("p1b-oc-store-legacy-");
    const r = await importOpenclaw({ home, source: fx.root, apply: true, testInternals: { embeddings: modelEmbedder(0).embeddings } });
    const alpha = byId(r, "agent:alpha");
    assert.equal(alpha.action, "skipped");
    assert.ok(alpha.reasons.includes("schema-mismatch"), alpha.reasons.join(","));
    assert.match(alpha.nextStep ?? "", /schema/i);
    assert.equal(r.counts.storesTakenOver, 0);
    assert.ok(!existsSync(layout(home).lancedb));
    assert.deepEqual(stagingLeftovers(home), []);
    fx.close();
  });

  it("P1.3: an abort in the middle of the take-over leaves no staging dir; resume completes it and rollback removes the adopted store", { timeout }, async () => {
    for (const step of ["store-staged", "store-committed"] as const) {
      const fx = await fixture();
      const home = tempDir(`p1b-oc-store-abort-${step}-`);
      const l = layout(home);
      const model = modelEmbedder(0);
      const sourceBefore = manifestWithModes(fx.base);

      await assert.rejects(importOpenclaw({ home, source: fx.root, apply: true, failAfterStep: step, testInternals: { embeddings: model.embeddings } }), /failAfterStep/);
      assert.deepEqual(stagingLeftovers(home), [], `${step}: a staging or probe dir was left behind`);
      assert.equal(existsSync(l.lancedb), step === "store-committed", `${step}: state/lancedb must exist exactly when the swap happened`);

      const runDirs = readdirSync(join(home, "imports"));
      assert.equal(runDirs.length, 1, "the aborted run keeps its snapshot and ledger so it can be resumed");
      const resumed = await importOpenclaw({ home, source: fx.root, apply: true, resume: runDirs[0]!, testInternals: { embeddings: model.embeddings } });
      assert.equal(resumed.runId, runDirs[0]);
      assert.equal(byId(resumed, "agent:alpha").action, "taken-over");
      assert.ok(existsSync(join(l.lancedb, "alpha", "memories.lance")));
      assert.deepEqual(stagingLeftovers(home), []);

      const rb = await rollbackImport({ home, reportPath: resumed.reportPath!, apply: true, sourceType: "openclaw" });
      assert.equal(rb.status, "completed");
      assert.equal(rb.storeUndoStatus, "removed");
      assert.ok(!existsSync(l.lancedb), "rollback removes the adopted store");
      assert.equal(manifestWithModes(fx.base), sourceBefore);
      fx.close();
    }
  });

  it("P1.4: a second apply run is idempotent: stores are matched-existing, nothing outside imports/ changes", { timeout }, async () => {
    const fx = await fixture({ gamma: true });
    const home = tempDir("p1b-oc-store-idem-");
    const model = modelEmbedder(0);
    const first = await importOpenclaw({ home, source: fx.root, apply: true, testInternals: { embeddings: model.embeddings } });
    assert.equal(first.counts.storesTakenOver, 2);
    const after = outsideImports(home);
    const sourceAfter = manifestWithModes(fx.base);

    const second = await importOpenclaw({ home, source: fx.root, apply: true, testInternals: { embeddings: model.embeddings } });
    assert.equal(byId(second, "agent:alpha").action, "matched-existing");
    assert.equal(byId(second, `shared:workspaces:${fx.sharedPool.key}`).action, "matched-existing");
    assert.equal(byId(second, "agent:beta").action, "re-embedding-migration");
    assert.equal(byId(second, "agent:gamma").action, "re-embedding-migration", "the probe verdict does not change between runs");
    assert.equal(second.counts.storesTakenOver, 0);
    assert.equal(second.counts.storesMatched, 2);
    assert.equal(second.counts.storesReembedMigration, 2);
    assert.equal(outsideImports(home), after, "zero new writes outside imports/");
    assert.equal(manifestWithModes(fx.base), sourceAfter);
    assert.deepEqual(stagingLeftovers(home), []);
    fx.close();
  });

  it("P1.6: when the probe engine cannot start with the target config nothing is vouched for: stores are skipped, the rest of the import goes on", { timeout }, async () => {
    const fx = await fixture();
    const home = tempDir("p1b-oc-store-badcfg-");
    const l = layout(home);
    write(l.configPath, JSON.stringify({ ...defaults(), engine: { customEngineSetting: "rejected-by-the-engine" } }, null, 2));
    const r = await importOpenclaw({ home, source: fx.root, apply: true, testInternals: { embeddings: modelEmbedder(0).embeddings } });
    assert.equal(byId(r, "agent:alpha").action, "skipped");
    assert.deepEqual(byId(r, "agent:alpha").reasons, ["store-check-failed"]);
    assert.ok(r.errors.some((e) => e.sourceRef === "agent:alpha" && e.reason.startsWith("store-check-failed:")));
    assert.equal(r.counts.agentsCreated, 2, "agents and files are imported regardless");
    assert.ok(!existsSync(l.lancedb));
    assert.deepEqual(stagingLeftovers(home), []);
    fx.close();
  });

  it("P1.5: an existing harness store is never merged: skip leaves it, replace swaps it whole and rollback restores it", { timeout }, async () => {
    const fx = await fixture();
    const model = modelEmbedder(0);
    const home = tempDir("p1b-oc-store-conflict-");
    const l = layout(home);
    write(join(l.lancedb, "_schema.json"), JSON.stringify({ schemaVersion: "1" }));
    write(join(l.lancedb, "own", "marker.txt"), "the harness's own store");
    const own = treeDigest(l.lancedb);

    const skipped = await importOpenclaw({ home, source: fx.root, apply: true, testInternals: { embeddings: model.embeddings } });
    assert.equal(byId(skipped, "agent:alpha").action, "skipped");
    assert.ok(byId(skipped, "agent:alpha").reasons.includes("store-exists-skipped"));
    assert.equal(treeDigest(l.lancedb), own, "skip leaves the existing store untouched");

    const replaced = await importOpenclaw({ home, source: fx.root, apply: true, onConflict: "replace", testInternals: { embeddings: model.embeddings } });
    assert.equal(byId(replaced, "agent:alpha").action, "taken-over");
    assert.ok(!existsSync(join(l.lancedb, "own")), "replace is a whole swap, never a merge");
    const rb = await rollbackImport({ home, reportPath: replaced.reportPath!, apply: true, sourceType: "openclaw" });
    assert.equal(rb.storeUndoStatus, "restored");
    assert.equal(treeDigest(l.lancedb), own, "rollback restores the previous store byte-identically");
    fx.close();
  });
});

function readLedgerStoreEntry(r: OpenclawImportReport): string {
  const line = readFileSync(r.ledgerPath!, "utf8").split("\n").find((l) => l.includes('"entity":"store"'));
  assert.ok(line, "the ledger records the store take-over");
  return line;
}
