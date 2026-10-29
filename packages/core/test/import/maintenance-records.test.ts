/** GUI plans are immutable owner-bound records, so a Core restart cannot replace preflight with caller state. */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { readFileSync, writeFileSync, symlinkSync, mkdirSync } from "node:fs";
import { useTempDirs } from "./helpers.ts";

const temp = useTempDirs();
const HASH = "a".repeat(64);
const SOURCE = "f27152b4-ce98-4612-8f80-f5be315087c8";
const SNAPSHOT = "s".repeat(43);

async function factory() {
  const module = await import("../../src/import/maintenance-records.ts").catch(() => undefined);
  assert.equal(typeof module?.createImportRecords, "function", "GUI imports need durable authenticated records");
  return module!;
}

function plan(home: string) {
  return { ownerId: "owner", sourceId: SOURCE, snapshotId: SNAPSHOT, sourceType: "openclaw" as const,
    sourceSha256: HASH, configRevision: "rev-1", options: { onConflict: "skip" as const, migrateSecrets: false },
    roots: [{ id: "state", path: join(home, "state"), kind: "directory" as const, preserve: ["core.lock", "api"] }],
    importBytes: 100, coldBytes: 200, entities: 2, unresolvedConflicts: 0 };
}

describe("durable GUI import records", () => {
  it("persists an immutable plan with a content digest and retrieves it after Core restart for the same Owner", async () => {
    const api = await factory();
    const home = temp();
    const records = api.createImportRecords(home);
    const created = await records.putPlan(plan(home));
    assert.match(created.record.id, /^[a-f0-9-]{36}$/);
    assert.match(created.record.runId, /^[a-f0-9-]{36}$/);
    assert.match(created.sha256, /^[a-f0-9]{64}$/);
    const reopened = api.createImportRecords(home);
    assert.deepEqual(await reopened.readPlan(created.record.id, "owner"), created);
    await assert.rejects(reopened.readPlan(created.record.id, "another-owner"));
    const raw = readFileSync(join(home, "imports", "plans", created.record.id + ".json"));
    await assert.rejects(reopened.readPlan(created.record.id, "owner", "b".repeat(64)));
    assert.deepEqual(readFileSync(join(home, "imports", "plans", created.record.id + ".json")), raw);
  });

  it("binds preflight to exact plan/source/target hashes, operation and Owner without embedding target config", async () => {
    const api = await factory();
    const home = temp();
    const records = api.createImportRecords(home);
    const created = await records.putPlan(plan(home));
    const ticket = await records.putPreflight({ ownerId: "owner", planId: created.record.id,
      runId: created.record.runId, planSha256: created.sha256, sourceSha256: HASH, targetSha256: "b".repeat(64),
      operation: "apply" });
    assert.equal((await records.readPreflight(ticket.id, "owner")).planSha256, created.sha256);
    assert.ok(!readFileSync(join(home, "imports", "preflight", ticket.id + ".json"), "utf8").includes("config"));
    await assert.rejects(records.readPreflight(ticket.id, "another-owner"));
  });

  it("binds a supervised source embedding candidate to the selected store and final model without accepting source config", async () => {
    const api = await factory();
    const home = temp();
    const records = api.createImportRecords(home);
    const sourceEmbedding = { model: "jinaai/jina-embeddings-v5-text-nano-retrieval", dimensions: 768,
      storeId: "agent:alpha", agentId: "alpha" };
    const input = { ...plan(home), options: { adoptStoreId: "agent:alpha", adoptStrategy: "re-embed" as const,
      reembed: { model: "intfloat/multilingual-e5-small" } }, sourceEmbedding };
    const saved = await records.putPlan(input);
    assert.deepEqual((await records.readPlan(saved.record.id, "owner", saved.sha256)).record.sourceEmbedding, sourceEmbedding);
    await assert.rejects(records.putPlan({ ...input, sourceEmbedding: { ...sourceEmbedding, storeId: "agent:other" } }));
    await assert.rejects(records.putPlan({ ...input, sourceEmbedding: { ...sourceEmbedding, token: "never-persist" } } as never));
    await assert.rejects(records.putPlan({ ...input, options: {} }));
    await assert.rejects(records.putPlan({ ...plan(home), options: input.options }),
      "a requested source transfer cannot resume an older plan that never bound its source model");
  });

  it("rejects unknown source families, unknown fields, linked storage and expired records", async () => {
    const api = await factory();
    const home = temp();
    let now = Date.now();
    const records = api.createImportRecords(home, { now: () => now });
    await assert.rejects(records.putPlan({ ...plan(home), sourceType: "unsupported" } as never));
    await assert.rejects(records.putPlan({ ...plan(home), credentials: "never-store" } as never));
    const created = await records.putPlan(plan(home));
    now += 24 * 60 * 60 * 1000 + 1;
    await assert.rejects(records.readPlan(created.record.id, "owner"));
    const outside = temp();
    const linked = temp();
    mkdirSync(join(linked, "imports"));
    symlinkSync(outside, join(linked, "imports", "plans"), process.platform === "win32" ? "junction" : "dir");
    await assert.rejects(api.createImportRecords(linked).putPlan(plan(linked)));
    const path = join(home, "imports", "plans", created.record.id + ".json");
    const raw = JSON.parse(readFileSync(path, "utf8"));
    raw.sourceType = "unsupported";
    writeFileSync(path, JSON.stringify(raw));
    await assert.rejects(api.createImportRecords(home).readPlan(created.record.id, "owner"));
  });
});
