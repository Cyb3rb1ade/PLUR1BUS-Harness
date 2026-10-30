/** A held Core must finish passive local initialization before fixing the rollback target; routing stays closed. */
import { it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { defaults } from "@plur1bus/config-schema";
import { createEngine } from "@cyb3rb1ade/plur1bus-memory/engine/create-engine.js";
import { layout } from "../../src/paths.ts";
import { buildEngineConfig } from "../../src/engine-config.ts";
import { createTempHost } from "../../src/import/importers/hermes-stores.ts";
import { callerToPrincipal } from "../../src/principal.ts";
import { createCore } from "../../src/core.ts";
import { createImportRecords } from "../../src/import/maintenance-records.ts";
import { openMaintenanceJournal, readMaintenanceJournal } from "../../src/import/maintenance-journal.ts";
import { fingerprintImportTarget } from "../../src/import/maintenance-worker.ts";
import { DreamStore } from "../../src/dreams/store.ts";
import { SystemJobsLedger } from "../../src/system-jobs/ledger.ts";
import { connect } from "../helpers/connect.ts";
import { flatEmbedder, flatTestInternals } from "../helpers/flat-embedder.ts";
import { WARMUP_QUERY } from "../../src/warmup.ts";
import { useTempDirs } from "./helpers.ts";

const temp = useTempDirs();
async function fixture(seedDreams = false, restored = false) {
  const home = temp();
  const config = defaults();
  config.agents.main = {};
  config.engine = { neo: { enabled: false }, gc: { enabled: false }, obsidianBridge: { enabled: false },
    merging: { enabled: false }, dreaming: { enabled: false }, skillMiner: { enabled: false },
    temporalContext: { enabled: false }, conversationReactivationRecall: { enabled: false }, reranker: { enabled: false } };
  writeFileSync(join(home, "config.json"), JSON.stringify(config));
  mkdirSync(join(home, "state"));
  // A restored running installation already has this recent sweep; an unrelated first-ever scheduled job must
  // not obscure whether lazy local constructors append state after the held generation's final hash.
  const now = Date.now();
  new SystemJobsLedger({ ledgerPath: join(home, "state/system-jobs/ledger.jsonl"), securePath: () => {}, logger: { warn() {} } }).finish({
    runId: "8874bc2a-bdda-40f6-b4a0-07d9ca3329d2", job: "knowledge.update", trigger: "cron",
    startedAt: now, finishedAt: now, durationMs: 0, outcome: "completed" });
  const dreamsPath = join(home, "state/dreams/dreams.db");
  if (seedDreams) {
    // A real imported card is already present at cold-worker commit. An empty table does not exercise the lazy
    // read pool's writable bootstrap cleanup, which is the Lance transaction observed in the Native regression.
    const l = layout(home);
    mkdirSync(l.workspaceDir("main"), { recursive: true });
    const engine = createEngine(createTempHost(l.state, async id => l.workspaceDir(id)),
      buildEngineConfig(config, l), { internals: flatTestInternals() });
    try {
      const principal = callerToPrincipal({ channel: "cli", accountId: "fixture", userId: "fixture" }, "main", l.workspaceDir("main")).principal;
      const imported = await engine.memory.import({ agentId: "main", principal, cards: [{ idempotencyKey: "passive-target-card",
        text: "The imported maintenance card stays stable across Core activation.", provenance: "imported", scope: "agent-private" }] },
        principal, { origin: "system", background: false });
      assert.ok(imported.cards.some(card => card.outcome === "created"));
    } finally { await engine.close({ budgetMs: 5000 }); }
    const store = new DreamStore(dreamsPath);
    for (const phase of ["light", "rem", "deep"] as const) {
      store.insertScheduleIfAbsent({ agentId: "main", phase, cron: "0 * * * *", timezone: "UTC", enabled: false,
        staggerOffsetS: 0, nextRunAt: Date.now() + 3_600_000 });
    }
    store.close();
  }
  const { record: plan, sha256 } = await createImportRecords(home).putPlan({ ownerId: "local-owner",
    sourceId: "6e72c789-8ef9-4738-bd8a-9333d6d7db33", snapshotId: "a".repeat(43), sourceType: "openclaw",
    sourceSha256: "b".repeat(64), configRevision: "r", options: {}, roots: [{ id: "state",
      path: join(home, "state"), kind: "directory", preserve: ["core.lock"] }],
    importBytes: 0, coldBytes: 0, entities: 0, unresolvedConflicts: 0 });
  const journal = openMaintenanceJournal(home, plan.runId);
  journal.advance("snapshotting");
  journal.advance("snapshot-complete", { snapshotSha256: "a".repeat(64) });
  journal.advance("applying");
  journal.advance("committed", { targetSha256: "b".repeat(64) });
  const invocationId = "d273b2cb-5c92-4773-9a28-772d90294e17";
  writeFileSync(join(home, "imports", plan.runId, "maintenance-run.json"), JSON.stringify({ version: 1,
    job: { runId: plan.runId, planId: plan.id, planSha256: sha256, ownerId: "local-owner", role: "owner",
      attempt: 1, invocationId, mode: restored ? "rollback" : "apply" }, run: { state: "restarting-core" } }));
  writeFileSync(join(home, "imports", plan.runId, "activation.json"), JSON.stringify({ version: 1,
    runId: plan.runId, planSha256: sha256, attempt: 1, invocationId,
    result: { ok: true, status: "completed", restored, resumable: false } }));
  process.env.PLUR1BUS_IMPORT_MAINTENANCE = plan.runId;
  const queries: string[] = [];
  const internals = flatTestInternals(), embedding = internals.embeddings as ReturnType<typeof flatEmbedder>;
  const query = async (text: unknown) => { if (typeof text === "string") queries.push(text); return embedding.embedQuery(); };
  internals.embeddings = { ...embedding, embed: query, embedQuery: query };
  const core = createCore({ home, testInternals: internals,
    discovery: { scheduler: false }, dreams: { scheduler: false } });
  await core.start();
  const client = await connect({ address: core.address, token: core.token });
  const control = { runId: plan.runId, planId: plan.id, planSha256: sha256 };
  return { home, plan, dreamsPath, core, client, control, queries: () => queries, close: async () => { await client.close(); await core.stop(); } };
}
async function complete(f: Awaited<ReturnType<typeof fixture>>): Promise<void> {
  await f.client.call("admin.import.runtime.complete", f.control);
  const deadline = Date.now() + 10_000;
  while ((await f.client.call<{ state: string }>("admin.import.runtime.status", f.control)).state !== "completed") {
    assert.ok(Date.now() < deadline, "the authenticated passive target initialization completes");
    await new Promise(resolve => setTimeout(resolve, 20));
  }
}

const before = { allow: process.env.PLUR1BUS_ALLOW_TEST_INTERNALS, hold: process.env.PLUR1BUS_IMPORT_MAINTENANCE };
process.env.PLUR1BUS_ALLOW_TEST_INTERNALS = "1";

it("the authenticated held completion creates the new agent's passive dreams state before final hashing", async () => {
  const f = await fixture();
  try {
    await complete(f);
    assert.ok(existsSync(f.dreamsPath), "dreams constructor must finish while the target is still held");
    const db = new DatabaseSync(f.dreamsPath, { readOnly: true });
    try { assert.equal((db.prepare("SELECT COUNT(*) AS n FROM dream_schedule WHERE agent_id='main'").get() as { n: number }).n, 3); }
    finally { db.close(); }
    await assert.rejects(f.client.call("dreams.status", {}), { error: "E_CONFLICT", reason: "busy" });
  } finally { await f.close(); }
});

it("release and deferred model warmup cannot append a later Lance transaction to a finalized target", async () => {
  const f = await fixture(true);
  try {
    await complete(f);
    const expected = readMaintenanceJournal(f.home, f.plan.runId).targetSha256;
    assert.equal(await fingerprintImportTarget(f.home, f.plan.roots), expected);
    assert.equal(f.queries().length, 0, "passive held initialization never calls an embedder");
    await f.client.call("admin.import.runtime.release", f.control);
    const deadline = Date.now() + 10_000;
    while (!(await f.client.call<{ engine: { ready: boolean } }>("core.status", {})).engine.ready) {
      assert.ok(Date.now() < deadline, "the real model warmup completes");
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    assert.ok(f.queries().includes(WARMUP_QUERY), "the full recall-path warmup still runs after successful apply release");
    await f.client.call("dreams.status", {});
    assert.equal(await fingerprintImportTarget(f.home, f.plan.roots), expected,
      "passive startup must settle before the immutable final target, not after public release");
  } finally { await f.close(); }
});

it("a restored populated target is not rewritten by optional post-release recall warmup", async () => {
  const f = await fixture(true, true);
  try {
    const expected = await fingerprintImportTarget(f.home, f.plan.roots);
    await complete(f);
    await f.client.call("admin.import.runtime.release", f.control);
    const deadline = Date.now() + 10_000;
    while (!(await f.client.call<{ engine: { ready: boolean } }>("core.status", {})).engine.ready) {
      assert.ok(Date.now() < deadline, "the real model warmup completes after restoration");
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    assert.equal(f.queries().includes(WARMUP_QUERY), false, "restored generations load models without querying populated databases");
    assert.equal(await fingerprintImportTarget(f.home, f.plan.roots), expected,
      "restoration preserves the original populated mutable roots through release");
  } finally { await f.close(); }
});

process.on("exit", () => {
  if (before.allow === undefined) delete process.env.PLUR1BUS_ALLOW_TEST_INTERNALS;
  else process.env.PLUR1BUS_ALLOW_TEST_INTERNALS = before.allow;
  if (before.hold === undefined) delete process.env.PLUR1BUS_IMPORT_MAINTENANCE;
  else process.env.PLUR1BUS_IMPORT_MAINTENANCE = before.hold;
});
