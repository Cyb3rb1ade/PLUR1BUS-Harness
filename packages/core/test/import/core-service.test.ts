/** Production Core RPC composition must mount the importer, not just expose injectable unit ports. */
import { it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { defaults } from "@plur1bus/config-schema";
import type { ImportDetection, AdminImportSkillsResult } from "@plur1bus/rpc-schema";
import { createCore } from "../../src/core.ts";
import type { Principal } from "../../src/rbac/types.ts";
import { connect } from "../helpers/connect.ts";
import { flatTestInternals } from "../helpers/flat-embedder.ts";
import { useTempDirs } from "./helpers.ts";
import { createImportRecords } from "../../src/import/maintenance-records.ts";
import { openMaintenanceJournal } from "../../src/import/maintenance-journal.ts";
import { loadLanceDb } from "../../src/import/readonly.ts";
import { fingerprintMutationRoots } from "../../src/import/maintenance-snapshot.ts";

const temp = useTempDirs();
async function completeRuntime(client: Awaited<ReturnType<typeof connect>>, control: import("../../src/import/runtime.ts").ImportRunControl) {
  await client.call("admin.import.runtime.complete", control);
  const deadline = Date.now() + 10_000;
  for (;;) {
    const status = await client.call<import("../../src/import/runtime.ts").ImportRuntimeStatus>("admin.import.runtime.status", control);
    assert.notEqual(status.state, "failed", "authenticated target finalization succeeds");
    if (status.state === "completed") return status;
    assert.ok(Date.now() < deadline, "authenticated target finalization completes");
    await new Promise(resolve => setTimeout(resolve, 20));
  }
}

it("actual Core detects and imports skills live and rejects agent authority on the mounted methods", { timeout: 60_000 }, async () => {
  const home = temp();
  const source = temp();
  const skill = join(source, "workspace", "skills", "useful");
  mkdirSync(skill, { recursive: true });
  writeFileSync(join(skill, "SKILL.md"), "---\nname: useful\ndescription: useful\n---\nprivate source body");
  writeFileSync(join(source, "openclaw.json"), JSON.stringify({ meta: { lastTouchedVersion: "2026.9.5" },
    agents: { defaults: { workspace: "./workspace" } } }));
  writeFileSync(join(home, "config.json"), JSON.stringify(defaults()));
  const before = process.env.PLUR1BUS_ALLOW_TEST_INTERNALS;
  process.env.PLUR1BUS_ALLOW_TEST_INTERNALS = "1";
  let who: Principal = { kind: "person", role: "owner", userId: "local-owner" };
  const core = createCore({ home, testInternals: flatTestInternals(), discovery: { scheduler: false },
    dreams: { scheduler: false }, rbac: { resolve: () => who } });
  let client: Awaited<ReturnType<typeof connect>> | undefined;
  try {
    await core.start();
    client = await connect({ address: core.address, token: core.token });
    const detected = await client.call<ImportDetection>("admin.import.detect", {
      source: { family: "openclaw", kind: "path", path: source },
    });
    assert.equal(detected.counts.skills, 1);
    const imported = await client.call<AdminImportSkillsResult>("admin.import.skills", { sourceId: detected.sourceId, apply: true });
    assert.equal(imported.counts.imported, 1);
    assert.equal(imported.skills[0]?.enabled, false);
    assert.match(readFileSync(join(home, "skills", "useful", "SKILL.md"), "utf8"), /private source body/);
    assert.equal(core.status().process.state, "ready");
    const audit = readFileSync(join(home, "logs", "audit.log"), "utf8");
    assert.ok(audit.includes("import.detect") && audit.includes("import.skills"));
    assert.ok(!audit.includes(source) && !audit.includes("private source body"));
    who = { ...who, kind: "agent" };
    await assert.rejects(client.call("admin.import.detect", { source: { family: "openclaw", kind: "path", path: source } }),
      (error: { error?: string }) => error.error === "E_DENIED");
  } finally {
    await client?.close();
    await core.stop();
    if (before === undefined) delete process.env.PLUR1BUS_ALLOW_TEST_INTERNALS;
    else process.env.PLUR1BUS_ALLOW_TEST_INTERNALS = before;
  }
});

it("held actual Core preserves seeded card and retrieval counters until normal recall resumes after release", { timeout: 60_000 }, async () => {
  const home = temp();
  const cfg = defaults();
  cfg.agents.bernd = {};
  cfg.engine = { neo: { enabled: false }, gc: { enabled: false }, obsidianBridge: { enabled: false },
    merging: { enabled: false }, dreaming: { enabled: false }, skillMiner: { enabled: false },
    temporalContext: { enabled: false }, conversationReactivationRecall: { enabled: false }, reranker: { enabled: false } };
  writeFileSync(join(home, "config.json"), JSON.stringify(cfg));
  const caller = { channel: "cli", accountId: "local", userId: "owner" };
  const readCounts = async () => {
    const lance = await loadLanceDb();
    assert.ok(lance, "actual pinned Engine's LanceDB must be available");
    const partitions: string[] = [];
    const walk = (directory: string) => {
      if (!existsSync(directory)) return;
      for (const entry of readdirSync(directory, { withFileTypes: true })) if (entry.isDirectory()) {
        if (entry.name === "memories.lance") partitions.push(directory);
        else walk(join(directory, entry.name));
      }
    };
    walk(join(home, "state", "lancedb"));
    const counts: number[] = [];
    for (const path of partitions) {
      const db = await lance.connect(path, { readConsistencyInterval: 0 });
      const table = await db.openTable("memories");
      try { counts.push(...(await table.query().select(["retrievalCount"]).toArray()).map(row => Number(row.retrievalCount))); }
      finally { table.close(); db.close(); }
    }
    assert.ok(counts.length > 0, "a real Engine card was seeded");
    return counts;
  };
  const retrievals = () => {
    let count = 0;
    const walk = (directory: string) => {
      if (!existsSync(directory)) return;
      for (const entry of readdirSync(directory, { withFileTypes: true })) {
        const path = join(directory, entry.name);
        if (entry.isDirectory()) walk(path);
        else if (entry.isFile() && entry.name === "retrieval-ledger.jsonl") count += readFileSync(path, "utf8").trim().split("\n").filter(Boolean).length;
      }
    };
    walk(join(home, "state", "lancedb", "_neo"));
    return count;
  };
  const before = { internals: process.env.PLUR1BUS_ALLOW_TEST_INTERNALS, hold: process.env.PLUR1BUS_IMPORT_MAINTENANCE };
  process.env.PLUR1BUS_ALLOW_TEST_INTERNALS = "1";
  delete process.env.PLUR1BUS_IMPORT_MAINTENANCE;
  let core = createCore({ home, testInternals: flatTestInternals(), discovery: { scheduler: false }, dreams: { scheduler: false } });
  let client: Awaited<ReturnType<typeof connect>> | undefined;
  try {
    await core.start();
    client = await connect({ address: core.address, token: core.token });
    const captured = await client.call<{ stored: number }>("memory.capture", { caller, agentId: "bernd", sessionKey: "seed",
      messages: [{ role: "user", content: "Please remember the Atlas review is Tuesday at ten." }], wait: true, waitMs: 10_000 });
    assert.equal(captured.stored, 1);
    await client.close(); client = undefined;
    await core.stop();
    const { record: plan, sha256 } = await createImportRecords(home).putPlan({ ownerId: "local-owner",
      sourceId: "6e72c789-8ef9-4738-bd8a-9333d6d7db33", snapshotId: "a".repeat(43), sourceType: "openclaw",
      sourceSha256: "b".repeat(64), configRevision: "r", options: {}, roots: [{ id: "state", path: join(home, "state"),
        kind: "directory", preserve: ["core.lock"] }], importBytes: 0, coldBytes: 0, entities: 0, unresolvedConflicts: 0 });
    const journal = openMaintenanceJournal(home, plan.runId);
    journal.advance("snapshotting"); journal.advance("snapshot-complete", { snapshotSha256: "a".repeat(64) });
    journal.advance("applying"); journal.advance("committed", { targetSha256: "b".repeat(64) });
    const invocationId = "d273b2cb-5c92-4773-9a28-772d90294e17";
    writeFileSync(join(home, "imports", plan.runId, "maintenance-run.json"), JSON.stringify({ version: 1,
      job: { runId: plan.runId, planId: plan.id, planSha256: sha256, ownerId: "local-owner", role: "owner", attempt: 1,
        invocationId, mode: "apply" }, run: { state: "restarting-core" } }));
    writeFileSync(join(home, "imports", plan.runId, "activation.json"), JSON.stringify({ version: 1,
      runId: plan.runId, planSha256: sha256, attempt: 1, invocationId,
      result: { ok: true, status: "completed", restored: false, resumable: false } }));
    process.env.PLUR1BUS_IMPORT_MAINTENANCE = plan.runId;
    core = createCore({ home, testInternals: flatTestInternals(), discovery: { scheduler: false }, dreams: { scheduler: false } });
    await core.start();
    client = await connect({ address: core.address, token: core.token });
    const counts = await readCounts();
    const retrieved = retrievals();
    const recall = { caller, agentId: "bernd", query: "Atlas review Tuesday ten", budget: { softMs: 10_000, hardMs: 15_000 } };
    await assert.rejects(client.call("memory.recall", recall), (error: { reason?: string }) => error.reason === "busy");
    assert.deepEqual(await readCounts(), counts, "a refused semantic read cannot reinforce any card");
    assert.equal(retrievals(), retrieved, "a refused semantic read cannot append the Engine retrieval ledger");
    const control = { runId: plan.runId, planId: plan.id, planSha256: sha256 };
    await completeRuntime(client, control);
    await client.call("admin.import.runtime.release", control);
    const recalled = await client.call<{ blocks: { text: string }[] }>("memory.recall", recall);
    assert.ok(recalled.blocks.some(block => block.text.includes("Atlas review")));
    for (let n = 0; n < 100 && retrievals() === retrieved; n++) {
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    assert.ok(retrievals() > retrieved, "normal recall appends a real retrieval for the seeded card after release");
  } finally {
    await client?.close(); await core.stop();
    if (before.internals === undefined) delete process.env.PLUR1BUS_ALLOW_TEST_INTERNALS;
    else process.env.PLUR1BUS_ALLOW_TEST_INTERNALS = before.internals;
    if (before.hold === undefined) delete process.env.PLUR1BUS_IMPORT_MAINTENANCE;
    else process.env.PLUR1BUS_IMPORT_MAINTENANCE = before.hold;
  }
});

it("actual held Core answers reads but refuses a new secret write before any backend access", { timeout: 60_000 }, async () => {
  const home = temp();
  const cfg = defaults(); cfg.agents.main = {};
  writeFileSync(join(home, "config.json"), JSON.stringify(cfg));
  mkdirSync(join(home, "state"));
  const { record: plan, sha256 } = await createImportRecords(home).putPlan({ ownerId: "local-owner",
    sourceId: "6e72c789-8ef9-4738-bd8a-9333d6d7db33", snapshotId: "a".repeat(43), sourceType: "openclaw",
    sourceSha256: "b".repeat(64), configRevision: "r", options: {},
    roots: [{ id: "state", path: join(home, "state"), kind: "directory" }], importBytes: 0, coldBytes: 0,
    entities: 0, unresolvedConflicts: 0 });
  mkdirSync(join(home, "imports", plan.runId));
  const journal = openMaintenanceJournal(home, plan.runId);
  journal.advance("snapshotting");
  journal.advance("snapshot-complete", { snapshotSha256: "a".repeat(64) });
  journal.advance("applying");
  journal.advance("committed", { targetSha256: "b".repeat(64) });
  writeFileSync(join(home, "imports", plan.runId, "maintenance-run.json"), JSON.stringify({ version: 1,
    job: { runId: plan.runId, planId: plan.id, planSha256: sha256, ownerId: "local-owner", role: "owner", attempt: 1,
      invocationId: "d273b2cb-5c92-4773-9a28-772d90294e17", mode: "apply" },
    run: { state: "restarting-core" } }));
  writeFileSync(join(home, "imports", plan.runId, "activation.json"), JSON.stringify({ version: 1,
    runId: plan.runId, planSha256: sha256, attempt: 1, invocationId: "d273b2cb-5c92-4773-9a28-772d90294e17",
    result: { ok: true, status: "completed", restored: false, resumable: false } }));
  const before = { internals: process.env.PLUR1BUS_ALLOW_TEST_INTERNALS,
    hold: process.env.PLUR1BUS_IMPORT_MAINTENANCE, keyring: process.env.PLUR1BUS_SECRETS_KEYRING };
  process.env.PLUR1BUS_ALLOW_TEST_INTERNALS = "1";
  process.env.PLUR1BUS_SECRETS_KEYRING = "memory";
  process.env.PLUR1BUS_IMPORT_MAINTENANCE = plan.runId;
  const core = createCore({ home, testInternals: flatTestInternals(), discovery: { scheduler: false },
    dreams: { scheduler: false } });
  let client: Awaited<ReturnType<typeof connect>> | undefined;
  try {
    await core.start();
    client = await connect({ address: core.address, token: core.token });
    await client.call("core.status", {});
    await assert.rejects(client.call("secret.set", { name: "import-new-user-write", value: "synthetic-new-user-secret" }),
      (error: { reason?: string }) => error.reason === "busy");
    const control = { runId: plan.runId, planId: plan.id, planSha256: sha256 };
    const completed = await completeRuntime(client, control);
    assert.equal(completed.state, "completed");
    assert.equal(completed.restartRequired, false);
    const partition = join(home, "state", "lancedb", "main");
    assert.equal(existsSync(join(partition, "memories.lance")), true, "held completion provisions an empty imported agent before finalizing rollback");
    const roots = [{ id: "main", path: partition, kind: "directory" as const }];
    const provisioned = await fingerprintMutationRoots(roots);
    await client.call("admin.import.runtime.release", control);
    for (let n = 0; n < 100 && core.status().engine.degraded !== null; n++) await new Promise(resolve => setTimeout(resolve, 10));
    assert.equal(await fingerprintMutationRoots(roots), provisioned, "deferred model/read warmup cannot create new agent tables after the rollback reference");
    await client.call("secret.set", { name: "import-new-user-write", value: "synthetic-new-user-secret" });
  } finally {
    await client?.close();
    await core.stop();
    for (const [name, value] of [["PLUR1BUS_ALLOW_TEST_INTERNALS", before.internals],
      ["PLUR1BUS_IMPORT_MAINTENANCE", before.hold], ["PLUR1BUS_SECRETS_KEYRING", before.keyring]]) {
      if (value === undefined) delete process.env[name!];
      else process.env[name!] = value;
    }
  }
});
