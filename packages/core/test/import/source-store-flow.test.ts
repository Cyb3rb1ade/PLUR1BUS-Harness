/** Real worker/Engine/Lance/coordinator proof using the existing deterministic model seam, without downloaded weights. */
import { it } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { validate } from "@plur1bus/config-schema";
import { createEngine } from "@cyb3rb1ade/plur1bus-memory/engine/create-engine.js";
import { createImportService } from "../../src/import/service.ts";
import { createImportSourceSecrets } from "../../src/import/source-secrets.ts";
import { createImportRecords } from "../../src/import/maintenance-records.ts";
import { fingerprintImportTarget, runImportMaintenance } from "../../src/import/maintenance-worker.ts";
import { openMaintenanceJournal } from "../../src/import/maintenance-journal.ts";
import { probeSourceStoreTransfer, configuredStoreCopyProbe, storeModelPreparation } from "../../src/import/source-store-transfer.ts";
import { createImportRuntime } from "../../src/import/runtime.ts";
import { createTempHost } from "../../src/import/importers/hermes-stores.ts";
import { createEnginePort } from "../../src/embedding-migrate/engine-port.ts";
import { createMigrationDriver } from "../../src/embedding-migrate/driver.ts";
import { createStateStore } from "../../src/embedding-migrate/state.ts";
import { createConfigSwitchPort } from "../../src/embedding-migrate/switch.ts";
import { buildEngineConfig } from "../../src/engine-config.ts";
import { layout } from "../../src/paths.ts";
import { memoryAuditSink } from "../../src/rbac/audit.ts";
import { loadLanceDb } from "../../src/import/readonly.ts";
import { foreignStoreFixture } from "./source-store-fixture.ts";
import { treeDigest } from "./tree.ts";
import { CONTENT_MARKER, NANO } from "./fixtures.ts";

const OWNER = { userId: "owner", kind: "person" as const, role: "owner" as const };
const embeddings = (dimensions: number) => {
  const one = async () => Array.from({ length: dimensions }, (_, i) => i === 0 ? 1 : 0);
  return { embed: one, embedQuery: one, embedPassage: one,
    embedBatch: async (texts: string[]) => Promise.all(texts.map(one)), shutdown: async () => {} };
};
function updateConfig(home: string, changes: { key: string; value: unknown }[], dryRun = false) {
  const file = join(home, "config.json");
  const config = JSON.parse(readFileSync(file, "utf8"));
  for (const { key, value } of changes) {
    assert.ok(key.startsWith("agents.") || ["engine.embedding", "engine.reembedding", "engine.modelPreparation"].includes(key));
    const [root, name] = key.split(".");
    if (key === "engine.reembedding" && value === null) delete config.engine.reembedding;
    else config[root!] = { ...config[root!], [name!]: value };
  }
  const checked = validate(config); assert.equal(checked.ok, true);
  if (!dryRun) writeFileSync(file, JSON.stringify(config));
}
const current = (home: string) => {
  const bytes = readFileSync(join(home, "config.json"));
  return { config: JSON.parse(bytes.toString()), revision: createHash("sha256").update(bytes).digest("hex") };
};

async function rows(path: string) {
  const db = await (await loadLanceDb())!.connect(path, { readConsistencyInterval: 0 });
  const table = await db.openTable("memories");
  try {
    const width = (await table.schema()).fields.find(field => field.name === "vector")?.type.listSize;
    const cards = await table.query().select(["id", "text", "agentId", "scope", "createdAt", "importance", "origin"]).toArray();
    return { width, cards: cards.map(card => Object.fromEntries(Object.entries(card).map(([key, value]) =>
      [key, typeof value === "bigint" ? value.toString() : value]))).sort((a, b) => String(a.id).localeCompare(String(b.id))) };
  } finally { table.close(); db.close(); }
}

function serviceFor(f: Awaited<ReturnType<typeof foreignStoreFixture>>, roots: import("../../src/import/maintenance-files.ts").MutationRoot[]) {
  return createImportService({ home: f.home, sources: f.registry, sourceSecrets: createImportSourceSecrets(), audit: memoryAuditSink(),
    config: { get: async () => current(f.home), set: async params => {
      updateConfig(f.home, params.changes, params.dryRun); return { revision: current(f.home).revision };
    } }, target: async () => ({ roots, coldBytes: 64 * 1024, availableBytes: 1024 ** 3, writable: true,
      foreignLock: false, completeCoverage: true, exclusiveWriter: true }), store: async () => ({ supported: true }),
    // Artifact availability is supplied by the deterministic fixture model; production checks its pinned cache and live licence ledger.
    model: async model => ({ present: [NANO, "intfloat/multilingual-e5-small"].includes(model), licenceAccepted: true }),
    secrets: { status: async () => { throw new Error("no source secret migration requested"); } },
    sourceStoreProbe: (source, candidate, config, signal) => probeSourceStoreTransfer({ home: f.home, source, candidate,
      config, ...(signal ? { signal } : {}), testInternals: { embeddings, reranker: null } }),
    storeProbe: configuredStoreCopyProbe(f.config, f.home, { embeddings: embeddings(384), reranker: null }),
  });
}

it("requires an actual target-model sample before takeover, including an identical existing unverified partition", async () => {
  for (const [model, hot, existing] of [[NANO, 0, false], ["intfloat/multilingual-e5-small", 1, false],
    ["intfloat/multilingual-e5-small", 1, true], ["intfloat/multilingual-e5-small", 0, true]] as const) {
    const f = await foreignStoreFixture(hot, model);
    const l = layout(f.home);
    if (existing) {
      mkdirSync(l.lancedb, { recursive: true });
      cpSync(join(f.source.root, "memory", "lancedb-namespaced", "alpha"), join(l.lancedb, "alpha"), { recursive: true });
      writeFileSync(join(l.lancedb, "_schema.json"), '{"schemaVersion":"1"}');
    }
    const before = treeDigest(l.state);
    const config = readFileSync(l.configPath);
    const service = serviceFor(f, [{ id: "state", path: l.state, kind: "directory", preserve: ["core.lock"] }]);
    try {
      const run = () => service.plan({ sourceId: f.detected.sourceId,
        options: { adoptStoreId: "agent:alpha", adoptStrategy: "take-over", onConflict: "skip" } }, OWNER);
      if (hot === 0 && existing) assert.equal((await run()).counts.stores, 1);
      else await assert.rejects(run(), { reason: "source-store-probe-failed" });
      assert.equal(treeDigest(l.state), before);
      assert.deepEqual(readFileSync(l.configPath), config);
    } finally { service.close(); }
  }
});

it("copies proven foreign cards, migrates all rows to the target model, and cold rollback restores the full original baseline", { timeout: 90_000 }, async () => {
  for (const mode of ["migration", "configured-root", "reuse"] as const) {
  const configuredRoot = mode === "configured-root";
  const reuse = mode === "reuse";
  const f = await foreignStoreFixture(0, reuse ? "intfloat/multilingual-e5-small" : NANO);
  const l = layout(f.home);
  const storeRoot = configuredRoot ? join(l.state, "configured-store") : l.lancedb;
  if (configuredRoot) {
    f.config.engine.baseDbPathOverride = storeRoot;
    writeFileSync(l.configPath, JSON.stringify(f.config));
  }
  const originalConfig = readFileSync(l.configPath);
  const originalState = treeDigest(l.state);
  const originalSource = treeDigest(f.root);
  const roots = [{ id: "state", path: l.state, kind: "directory" as const, preserve: ["core.lock"] },
    { id: "agents", path: l.agents, kind: "directory" as const }, { id: "skills", path: l.skills, kind: "directory" as const }];
  const originalTarget = await fingerprintImportTarget(f.home, roots);
  const service = serviceFor(f, roots);
  let engine: ReturnType<typeof createEngine> | undefined;
  let runtime: ReturnType<typeof createImportRuntime> | undefined;
  try {
    const planned = await service.plan({ sourceId: f.detected.sourceId,
      options: { adoptStoreId: "agent:alpha", adoptStrategy: reuse ? "take-over" : "re-embed", onConflict: "replace" } }, OWNER);
    const saved = await createImportRecords(f.home).readPlan(planned.planId, OWNER.userId, planned.planSha256);
    assert.deepEqual(saved.record.sourceEmbedding, reuse ? undefined : f.candidate);
    assert.equal(saved.record.options.reembed?.model, reuse ? undefined : "intfloat/multilingual-e5-small");
    const preflight = await service.preflight({ planId: planned.planId }, OWNER);
    assert.equal(preflight.ok, true, JSON.stringify(preflight.issues));
    assert.deepEqual(readFileSync(l.configPath), originalConfig);
    assert.equal(treeDigest(l.state), originalState);
    const ticket = await createImportRecords(f.home).readPreflight(preflight.preflightId!, OWNER.userId);
    const child = spawn(process.execPath, ["--experimental-strip-types", "--conditions=source",
      fileURLToPath(new URL("../../src/import-bin.ts", import.meta.url)), "--supervised"], { stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env, PLUR1BUS_ALLOW_TEST_INTERNALS: "1", PLUR1BUS_TEST_INTERNALS: "flat-embedder" } });
    const envelopes: Record<string, unknown>[] = [];
    let pending = ""; let stderr = "";
    child.stdin.on("error", () => {});
    child.stderr.setEncoding("utf8").on("data", text => { stderr += text; });
    child.stdout.setEncoding("utf8").on("data", text => {
      pending += text;
      for (let index; (index = pending.indexOf("\n")) >= 0;) {
        const line = pending.slice(0, index); pending = pending.slice(index + 1);
        assert.ok(Buffer.byteLength(line) < 65_536 && !line.includes(CONTENT_MARKER));
        const envelope = JSON.parse(line); envelopes.push(envelope);
        if (envelope.type !== "request") continue;
        const params = envelope.params;
        const response = { v: 1, type: "response", runId: planned.runId, id: envelope.id, ok: true };
        if (envelope.method === "config.get") child.stdin.write(JSON.stringify({ ...response, result: current(f.home) }) + "\n");
        else if (envelope.method === "config.set") {
          assert.ok(!JSON.stringify(params).includes(CONTENT_MARKER));
          updateConfig(f.home, params.changes, params.dryRun);
          child.stdin.write(JSON.stringify({ ...response, result: { revision: current(f.home).revision } }) + "\n");
        } else assert.fail("unexpected private host control");
      }
    });
    child.stdin.write(JSON.stringify({ v: 1, runId: planned.runId, mode: "apply", home: f.home,
      plan: { id: planned.planId, sha256: planned.planSha256 }, ownerId: OWNER.userId, attempt: 1,
      preflightId: preflight.preflightId, targetSha256: ticket.targetSha256 }) + "\n");
    const timer = setTimeout(() => child.kill("SIGKILL"), 30_000);
    const code = await new Promise<number | null>((resolve, reject) => { child.once("error", reject); child.once("close", resolve); });
    clearTimeout(timer); child.stdin.destroy();
    assert.equal(code, 0, stderr);
    assert.equal(envelopes.find(event => event.type === "result")?.ok, true);
    if (!reuse) assert.equal(current(f.home).config.engine.embedding.local.model, NANO);
    const originalRows = await rows(join(f.source.root, "memory", "lancedb-namespaced", "alpha"));
    const copied = await rows(join(storeRoot, "alpha"));
    assert.equal(copied.width, reuse ? 384 : 768);
    assert.deepEqual(copied.cards, originalRows.cards);
    const invocationId = randomUUID();
    writeFileSync(join(f.home, "imports", planned.runId, "maintenance-run.json"), JSON.stringify({ version: 1,
      job: { runId: planned.runId, planId: planned.planId, planSha256: planned.planSha256, ownerId: OWNER.userId,
        attempt: 1, invocationId, mode: "apply" }, run: { state: "restarting-core" } }));
    const control = { runId: planned.runId, planId: planned.planId, planSha256: planned.planSha256 };
    const ctx = { requestId: "r", connectionId: "local-native", signal: new AbortController().signal };
    let released = false;
    const open = () => {
      const config = current(f.home).config;
      const width = (buildEngineConfig(config, l).embedding as { local: { dimensions: number } }).local.dimensions;
      return createEngine(createTempHost(l.state, async id => l.workspaceDir(id), f.home), buildEngineConfig(config, l),
        { internals: { embeddings: embeddings(width), reranker: null,
          reembeddingTargetProvider: ({ fingerprint }: { fingerprint: { dimensions: number } }) => embeddings(fingerprint.dimensions) } });
    };
    const createRuntime = () => createImportRuntime({ home: f.home, heldRunId: () => planned.runId, resolvePrincipal: () => OWNER,
      person: () => OWNER, model: async () => ({ present: true, licenceAccepted: true }),
      runningModel: () => engine!.embedding.identities()[0]?.model, release: async () => { released = true; },
      prepareTarget: async () => { const handle = await engine!.open("alpha"); await handle.close(); },
      driver: () => createMigrationDriver({ engine: createEnginePort(engine!), store: createStateStore(l.state),
        switchPort: createConfigSwitchPort({ layout: l, config: { current: () => current(f.home).config, set: async changes => {
          const block = changes.find(change => change.key === "engine.embedding")!.value as { local: { model: string; dimensions: number } };
          updateConfig(f.home, [...changes, storeModelPreparation(block.local.model, block.local.dimensions)]);
        } } }), sleep: async () => {} }),
    });
    engine = open(); runtime = createRuntime();
    await runtime.methods["admin.import.runtime.complete"]!(control, ctx);
    let status: { state?: string; restartRequired?: boolean; total?: number } = {};
    for (let count = 0; count < 500; count++) {
      status = await runtime.methods["admin.import.runtime.status"]!(control, ctx) as typeof status;
      if (status.state !== "pending") break;
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    assert.equal(status.state, "completed"); assert.equal(status.restartRequired, !reuse);
    if (!reuse) {
      assert.equal(status.total, 3);
      await assert.rejects(runtime.methods["admin.import.runtime.release"]!(control, ctx));
    }
    await runtime.close(); runtime = undefined; await engine.close(); engine = undefined;
    engine = open(); runtime = createRuntime();
    const ready = await runtime.methods["admin.import.runtime.complete"]!(control, ctx) as { state: string; restartRequired: boolean };
    assert.equal(ready.state, "completed"); assert.equal(ready.restartRequired, false);
    assert.equal(engine.embedding.identities()[0]?.model, "intfloat/multilingual-e5-small");
    const selected = current(f.home).config.engine.reembedding?.activeGeneration;
    const converted = await rows(selected ? join(storeRoot, "generations", selected, "alpha") : join(storeRoot, "alpha"));
    assert.equal(converted.width, 384); assert.deepEqual(converted.cards, originalRows.cards);
    assert.equal(treeDigest(f.root), originalSource);
    writeFileSync(join(f.home, "imports", planned.runId, "activation.json"), JSON.stringify({ version: 1,
      runId: planned.runId, planSha256: planned.planSha256, attempt: 1, invocationId,
      result: { ok: true, status: "completed", restored: false, resumable: false } }));
    await runtime.methods["admin.import.runtime.release"]!(control, ctx); assert.equal(released, true);
    await runtime.close(); runtime = undefined; await engine.close(); engine = undefined;
    const journal = openMaintenanceJournal(f.home, planned.runId).read();
    assert.equal(journal.targetSha256, await fingerprintImportTarget(f.home, roots));
    const rollback = await runImportMaintenance({ home: f.home, runId: planned.runId, roots, mode: "rollback",
      apply: async () => { assert.fail("rollback must never re-import a source"); },
      expectedTargetSha256: journal.targetSha256!, restoreConfig: async () => {
        writeFileSync(l.configPath, readFileSync(join(f.home, "imports", planned.runId, "cold-snapshot", "config.json")));
      } });
    assert.equal(rollback.ok, true); assert.equal(rollback.restored, true);
    assert.deepEqual(readFileSync(l.configPath), originalConfig);
    assert.equal(await fingerprintImportTarget(f.home, roots), originalTarget, "all configured mutation roots and raw config return to the original baseline");
    assert.equal(existsSync(join(l.agents, "alpha")), false);
  } finally { service.close(); await runtime?.close(); await engine?.close(); }
  }
});
