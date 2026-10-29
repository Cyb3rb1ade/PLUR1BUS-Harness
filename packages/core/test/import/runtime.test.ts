/** Restart completion derives business actions from the immutable plan and a live native maintenance job. */
import { it } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { bindApiPrincipal, bindClientContext } from "@plur1bus/module-api";
import { createImportRecords } from "../../src/import/maintenance-records.ts";
import { useTempDirs } from "./helpers.ts";
import type { Principal } from "../../src/rbac/types.ts";
import { openMaintenanceJournal } from "../../src/import/maintenance-journal.ts";
import { fingerprintImportTarget } from "../../src/import/maintenance-worker.ts";

const temp = useTempDirs();
const OWNER = { userId: "owner", kind: "person" as const, role: "owner" as const };
const ctx = { requestId: "r", connectionId: "c", signal: new AbortController().signal };

async function fixture(reembed = false, restored = false, sourceAlreadyTarget = false) {
  const module = await import("../../src/import/runtime.ts").catch(() => undefined);
  assert.equal(typeof module?.createImportRuntime, "function", "Core must finish the selected existing reembed job");
  const home = temp();
  mkdirSync(join(home, "state"));
  const records = createImportRecords(home);
  const { record: plan, sha256 } = await records.putPlan({ ownerId: "actor", sourceId: "6e72c789-8ef9-4738-bd8a-9333d6d7db33",
    snapshotId: "a".repeat(43), sourceType: "openclaw", sourceSha256: "b".repeat(64), configRevision: "r",
    options: reembed ? { reembed: { model: "intfloat/multilingual-e5-small" }, ...(sourceAlreadyTarget ? {
      adoptStoreId: "agent:alpha", adoptStrategy: "re-embed" as const } : {}) } : {},
    ...(sourceAlreadyTarget ? { sourceEmbedding: { model: "intfloat/multilingual-e5-small", dimensions: 384,
      storeId: "agent:alpha", agentId: "alpha" } } : {}),
    roots: [{ id: "state", path: join(home, "state"), kind: "directory" }], importBytes: 0,
    coldBytes: 0, entities: 0, unresolvedConflicts: 0 });
  mkdirSync(join(home, "imports", plan.runId));
  const journal = openMaintenanceJournal(home, plan.runId);
  journal.advance("snapshotting");
  journal.advance("snapshot-complete", { snapshotSha256: "a".repeat(64) });
  journal.advance("applying");
  journal.advance("committed", { targetSha256: await fingerprintImportTarget(home, plan.roots) });
  const invocationId = "d273b2cb-5c92-4773-9a28-772d90294e17";
  writeFileSync(join(home, "imports", plan.runId, "maintenance-run.json"), JSON.stringify({ version: 1,
    job: { runId: plan.runId, planId: plan.id, planSha256: sha256, ownerId: "actor", role: "admin", attempt: 1,
      mode: restored ? "rollback" : "apply", invocationId },
    run: { state: "restarting-core" } }));
  const activation = { version: 1, runId: plan.runId, planSha256: sha256, invocationId, attempt: 1,
    result: { ok: true, status: "completed", restored, resumable: false } };
  writeFileSync(join(home, "imports", plan.runId, "activation.json"), JSON.stringify(activation));
  let runningModel = sourceAlreadyTarget ? "intfloat/multilingual-e5-small" : "old-model";
  let switches = 0;
  let releases = 0;
  let caller: Principal | null = OWNER;
  let actor: Principal | null = { ...OWNER, userId: "actor", role: "admin" };
  const methods = module!.createImportRuntime({ home, heldRunId: () => plan.runId,
    resolvePrincipal: () => caller, person: () => actor,
    model: async () => ({ present: true, licenceAccepted: true }), runningModel: () => runningModel,
    release: async () => { releases++; },
    driver: () => ({
      plan: async () => ({ plan: { id: "migration" }, probe: {} }),
      start: async () => ({ checkpoint: {}, done: Promise.resolve({ phase: "ready-to-switch" }) }),
      switch: async () => { switches++; return { phase: "switched" }; },
      status: async () => ({ checkpoint: { id: "migration", phase: switches ? "switched" : "ready-to-switch" },
        progress: { rowsDone: switches ? 2 : 0, rows: 2 } }),
      stop: async () => {},
    }) as never,
  });
  const control = { runId: plan.runId, planId: plan.id, planSha256: sha256 };
  return { methods, control, home, plan, setRunning: () => { runningModel = plan.options.reembed!.model; },
    setCaller: (principal: Principal | null) => { caller = principal; },
    revoke: () => { actor = null; },
    staleActivation: () => writeFileSync(join(home, "imports", plan.runId, "activation.json"),
      JSON.stringify({ ...activation, invocationId: "c".repeat(36) })),
    switches: () => switches, releases: () => releases };
}

it("completes a no-action import and releases routing only for the exact private bound job", async () => {
  const f = await fixture();
  try {
    const status = await f.methods.methods["admin.import.runtime.complete"]!(f.control, ctx);
    assert.deepEqual(status, { runId: f.control.runId, state: "completed", completed: 0, restartRequired: false });
    await assert.rejects(f.methods.methods["admin.import.runtime.release"]!({ ...f.control, planSha256: "c".repeat(64) }, ctx));
    assert.equal(f.releases(), 0);
    await f.methods.methods["admin.import.runtime.release"]!(f.control, ctx);
    assert.equal(f.releases(), 1);
  } finally { await f.methods.close(); }
});

it("private completion, status and release deny non-Owner roles and delegated or scoped peers before any action", async () => {
  const f = await fixture();
  const names = ["admin.import.runtime.complete", "admin.import.runtime.status", "admin.import.runtime.release"];
  const refused = { error: "E_DENIED", reason: "local-core-only" };
  try {
    for (const principal of [null, { ...OWNER, kind: "agent" as const },
      ...["admin", "operator", "member", "viewer"].map(role => ({ ...OWNER, role } as Principal))]) {
      f.setCaller(principal);
      for (const name of names) await assert.rejects(f.methods.methods[name]!(f.control, ctx), refused);
    }
    f.setCaller(OWNER);
    const delegatedOwner = { ...ctx }, delegatedService = { ...ctx }, scopedClient = { ...ctx };
    bindApiPrincipal(delegatedOwner, OWNER);
    bindApiPrincipal(delegatedService, null);
    bindClientContext(scopedClient);
    for (const peer of [delegatedOwner, delegatedService, scopedClient]) {
      for (const name of names) await assert.rejects(f.methods.methods[name]!(f.control, peer), refused);
    }
    assert.equal(f.switches(), 0);
    assert.equal(f.releases(), 0);
    assert.equal(existsSync(join(f.home, "imports", f.plan.runId, "runtime.json")), false);
    assert.equal((await f.methods.methods[names[0]!]!(f.control, ctx) as { state: string }).state, "completed");
  } finally { await f.methods.close(); }
});

it("binds rollback to held bootstrap changes once and never absorbs a later target mutation", async () => {
  const f = await fixture();
  try {
    const before = openMaintenanceJournal(f.home, f.plan.runId).read().targetSha256;
    writeFileSync(join(f.home, "state", "new-agent-bootstrap"), "legitimate held initialization");
    const expected = await fingerprintImportTarget(f.home, f.plan.roots);
    assert.notEqual(expected, before);
    await f.methods.methods["admin.import.runtime.complete"]!(f.control, ctx);
    assert.equal(openMaintenanceJournal(f.home, f.plan.runId).read().targetSha256, expected);
    writeFileSync(join(f.home, "state", "later-user-change"), "must remain a rollback conflict");
    await f.methods.methods["admin.import.runtime.status"]!(f.control, ctx);
    await f.methods.methods["admin.import.runtime.complete"]!(f.control, ctx);
    assert.equal(openMaintenanceJournal(f.home, f.plan.runId).read().targetSha256, expected);
    assert.notEqual(await fingerprintImportTarget(f.home, f.plan.roots), expected);
  } finally { await f.methods.close(); }
});

it("runs the persisted selected model once and requires the selected Engine generation before release", async () => {
  const f = await fixture(true);
  try {
    await f.methods.methods["admin.import.runtime.complete"]!(f.control, ctx);
    let before: unknown;
    for (let n = 0; n < 100; n++) {
      before = await f.methods.methods["admin.import.runtime.status"]!(f.control, ctx);
      if ((before as { state: string }).state !== "pending") break;
      await new Promise(resolve => setTimeout(resolve, 5));
    }
    assert.equal((before as { restartRequired: boolean }).restartRequired, true);
    assert.equal(f.switches(), 1);
    await assert.rejects(f.methods.methods["admin.import.runtime.release"]!(f.control, ctx));
    f.setRunning();
    const ready = await f.methods.methods["admin.import.runtime.complete"]!(f.control, ctx);
    assert.equal((ready as { restartRequired: boolean }).restartRequired, false);
    assert.equal(f.switches(), 1);
    await f.methods.methods["admin.import.runtime.release"]!(f.control, ctx);
    assert.equal(f.releases(), 1);
  } finally { await f.methods.close(); }
});

it("never re-applies the selected model after the native job restored the baseline", async () => {
  const f = await fixture(true, true);
  try {
    f.revoke();
    const result = await f.methods.methods["admin.import.runtime.complete"]!(f.control, ctx);
    assert.deepEqual(result, { runId: f.control.runId, state: "completed", completed: 0, restartRequired: false });
    assert.equal(f.switches(), 0);
    await f.methods.methods["admin.import.runtime.release"]!(f.control, ctx);
    assert.equal(f.releases(), 1);
  } finally { await f.methods.close(); }
});

it("accepts a proven source store already in the selected target vector space without a redundant migration", async () => {
  const f = await fixture(true, false, true);
  try {
    const ready = await f.methods.methods["admin.import.runtime.complete"]!(f.control, ctx) as { state: string; restartRequired: boolean };
    assert.equal(ready.state, "completed");
    assert.equal(ready.restartRequired, false);
    assert.equal(f.switches(), 0);
    await f.methods.methods["admin.import.runtime.release"]!(f.control, ctx);
    assert.equal(f.releases(), 1);
  } finally { await f.methods.close(); }
});

it("denies a revoked initiator's apply action and a stale activation from another invocation", async () => {
  const f = await fixture(true);
  try {
    f.revoke();
    await assert.rejects(f.methods.methods["admin.import.runtime.complete"]!(f.control, ctx), { error: "E_DENIED" });
    assert.equal(f.switches(), 0);
  } finally { await f.methods.close(); }
  const other = await fixture();
  try {
    await other.methods.methods["admin.import.runtime.complete"]!(other.control, ctx);
    other.staleActivation();
    await assert.rejects(other.methods.methods["admin.import.runtime.release"]!(other.control, ctx));
    assert.equal(other.releases(), 0);
  } finally { await other.methods.close(); }
});
