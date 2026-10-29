/** Restart completion derives business actions from the immutable plan and a live native maintenance job. */
import { it } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import promises from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { bindApiPrincipal, bindClientContext } from "@plur1bus/module-api";
import { createImportRecords } from "../../src/import/maintenance-records.ts";
import { useTempDirs } from "./helpers.ts";
import type { Principal } from "../../src/rbac/types.ts";
import { openMaintenanceJournal } from "../../src/import/maintenance-journal.ts";
import { fingerprintImportTarget } from "../../src/import/maintenance-worker.ts";
import { writeAtomicSync } from "../../src/import/fs-atomic.ts";

const temp = useTempDirs();
const OWNER = { userId: "owner", kind: "person" as const, role: "owner" as const };
const ctx = { requestId: "r", connectionId: "c", signal: new AbortController().signal };

async function fixture(reembed = false, restored = false, sourceAlreadyTarget = false,
  options: { prepareTarget?: (signal: AbortSignal) => Promise<void> } = {}) {
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
    ...(options.prepareTarget ? { prepareTarget: options.prepareTarget } : {}),
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

async function complete(f: Awaited<ReturnType<typeof fixture>>) {
  let result = await f.methods.methods["admin.import.runtime.complete"]!(f.control, ctx) as { state: string; restartRequired?: boolean };
  for (let n = 0; n < 200 && result.state === "pending"; n++) {
    await new Promise(resolve => setTimeout(resolve, 5));
    result = await f.methods.methods["admin.import.runtime.status"]!(f.control, ctx) as typeof result;
  }
  assert.notEqual(result.state, "pending", "held completion must eventually publish a terminal result");
  return result;
}

it("returns pending promptly while one held target preparation is running and blocks release until it finishes", async () => {
  let finish!: () => void;
  const prepared = new Promise<void>(resolve => { finish = resolve; });
  let preparations = 0;
  const f = await fixture(false, false, false, { prepareTarget: async () => { preparations++; await prepared; } });
  let phase = "first complete";
  const prompt = async (method: string) => {
    let timer: NodeJS.Timeout | undefined;
    try {
      return await Promise.race([f.methods.methods[method]!(f.control, ctx), new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`held runtime RPC waited for target preparation (${method}, ${phase})`)), 1000);
      })]);
    } finally { clearTimeout(timer); }
  };
  try {
    const original = openMaintenanceJournal(f.home, f.plan.runId).read().targetSha256;
    const first = await prompt("admin.import.runtime.complete") as { state: string };
    assert.equal(first.state, "pending");
    phase = "held statuses";
    const statuses = await Promise.all(Array.from({ length: 4 }, () => prompt("admin.import.runtime.status")));
    assert.ok(statuses.every(result => (result as { state: string }).state === "pending"));
    for (let n = 0; n < 100 && preparations === 0; n++) await new Promise(resolve => setTimeout(resolve, 5));
    assert.equal(preparations, 1);
    await assert.rejects(f.methods.methods["admin.import.runtime.release"]!(f.control, ctx));
    assert.equal(f.releases(), 0);
    assert.equal(openMaintenanceJournal(f.home, f.plan.runId).read().targetSha256, original);
    writeFileSync(join(f.home, "state", "held-bootstrap"), "fully prepared before final proof");
    finish();
    phase = "publishing statuses";
    const publishing = await Promise.all(Array.from({ length: 16 }, () => prompt("admin.import.runtime.status")));
    assert.ok(publishing.every(result => ["pending", "completed"].includes((result as { state: string }).state)));
    let current: { state: string } = { state: "pending" };
    for (let n = 0; n < 100 && current.state === "pending"; n++) {
      current = await f.methods.methods["admin.import.runtime.status"]!(f.control, ctx) as { state: string };
      if (current.state === "pending") await new Promise(resolve => setTimeout(resolve, 5));
    }
    assert.equal(current.state, "completed");
    assert.equal(preparations, 1);
    assert.equal(openMaintenanceJournal(f.home, f.plan.runId).read().targetSha256,
      await fingerprintImportTarget(f.home, f.plan.roots));
    await f.methods.methods["admin.import.runtime.release"]!(f.control, ctx);
    assert.equal(f.releases(), 1);
  } finally { finish(); await f.methods.close(); }
});

it("fails closed when asynchronous preparation fails and leaves the prior rollback proof intact", async () => {
  let preparations = 0;
  const f = await fixture(false, false, false, { prepareTarget: async () => { preparations++; throw new Error("private bootstrap failure"); } });
  try {
    const original = openMaintenanceJournal(f.home, f.plan.runId).read().targetSha256;
    const result = await complete(f);
    assert.equal(result.state, "failed");
    assert.equal(JSON.stringify(result).includes("private bootstrap failure"), false);
    assert.equal(openMaintenanceJournal(f.home, f.plan.runId).read().targetSha256, original);
    assert.equal((await complete(f)).state, "failed");
    assert.equal(preparations, 1);
    await assert.rejects(f.methods.methods["admin.import.runtime.release"]!(f.control, ctx));
    assert.equal(f.releases(), 0);
  } finally { await f.methods.close(); }
});

for (const changedJob of [false, true]) {
  it(`rechecks the exact held job after an atomic native ${changedJob ? "plan" : "progress"} replacement`, async t => {
    let replace = false;
    let replacements = 0;
    const f = await fixture(false, false, false, { prepareTarget: async () => { replace = true; } });
    const nativePath = join(f.home, "imports", f.plan.runId, "maintenance-run.json");
    const open = promises.open;
    t.mock.method(promises, "open", async (path: Parameters<typeof open>[0], flags: Parameters<typeof open>[1],
      mode?: Parameters<typeof open>[2]) => {
      if (path === nativePath && replace) {
        replace = false;
        replacements++;
        const native = JSON.parse(readFileSync(nativePath, "utf8"));
        native.run.progress = { runId: f.plan.runId, phase: "verify", entity: "memory", completed: 0 };
        if (changedJob) native.job.planSha256 = "f".repeat(64);
        // Native publishes its first held-runtime progress between this reader's lstat and open.
        writeAtomicSync(nativePath, JSON.stringify(native));
      }
      return open(path, flags, mode);
    });
    syncBuiltinESMExports();
    try {
      if (changedJob) {
        await assert.rejects(complete(f));
        await assert.rejects(f.methods.methods["admin.import.runtime.release"]!(f.control, ctx));
        assert.equal(f.releases(), 0, "a changed immutable job never releases the held target");
      } else {
        assert.equal((await complete(f)).state, "completed");
        await f.methods.methods["admin.import.runtime.release"]!(f.control, ctx);
        assert.equal(f.releases(), 1);
      }
      assert.equal(replacements, 1, "the actual native metadata replacement races the verified read");
    } finally {
      t.mock.restoreAll();
      syncBuiltinESMExports();
      await f.methods.close();
    }
  });
}

it("refuses to finalize if the journal leaves the exact committed snapshot while preparation is pending", async () => {
  let begin!: () => void;
  let finish!: () => void;
  const started = new Promise<void>(resolve => { begin = resolve; });
  const gate = new Promise<void>(resolve => { finish = resolve; });
  const f = await fixture(false, false, false, { prepareTarget: async () => { begin(); await gate; } });
  try {
    assert.equal((await f.methods.methods["admin.import.runtime.complete"]!(f.control, ctx) as { state: string }).state, "pending");
    await started;
    const journal = openMaintenanceJournal(f.home, f.plan.runId);
    const original = journal.read().targetSha256;
    journal.advance("rolling-back");
    writeFileSync(join(f.home, "state", "changed-during-prepare"), "must never become a new committed proof");
    finish();
    assert.equal((await complete(f)).state, "failed");
    assert.equal(openMaintenanceJournal(f.home, f.plan.runId).read().phase, "rolling-back");
    assert.equal(openMaintenanceJournal(f.home, f.plan.runId).read().targetSha256, original);
    await assert.rejects(f.methods.methods["admin.import.runtime.release"]!(f.control, ctx));
    assert.equal(f.releases(), 0);
  } finally { finish(); await f.methods.close(); }
});

it("cancels and drains held preparation before close returns without finalizing or admitting release", async () => {
  let started = false;
  let interrupted = false;
  let settled = false;
  const f = await fixture(false, false, false, { prepareTarget: async signal => {
    started = true;
    try {
      await new Promise<void>((_, reject) => {
        const abort = () => { interrupted = true; reject(new Error("stopping")); };
        if (signal.aborted) abort();
        else signal.addEventListener("abort", abort, { once: true });
      });
    } finally { settled = true; }
  } });
  try {
    const original = openMaintenanceJournal(f.home, f.plan.runId).read().targetSha256;
    const pending = await f.methods.methods["admin.import.runtime.complete"]!(f.control, ctx) as { state: string };
    assert.equal(pending.state, "pending");
    for (let n = 0; n < 100 && !started; n++) {
      await new Promise(resolve => setTimeout(resolve, 5));
    }
    assert.equal(started, true);
    await f.methods.close();
    assert.equal(interrupted, true);
    assert.equal(settled, true);
    assert.equal(openMaintenanceJournal(f.home, f.plan.runId).read().targetSha256, original);
    await assert.rejects(f.methods.methods["admin.import.runtime.release"]!(f.control, ctx), { error: "E_DENIED" });
    assert.equal(f.releases(), 0);
  } finally { await f.methods.close(); }
});

it("completes a no-action import and releases routing only for the exact private bound job", async () => {
  const f = await fixture();
  try {
    const status = await complete(f);
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
    assert.equal((await complete(f)).state, "completed");
  } finally { await f.methods.close(); }
});

it("binds rollback to held bootstrap changes once and never absorbs a later target mutation", async () => {
  const f = await fixture();
  try {
    const before = openMaintenanceJournal(f.home, f.plan.runId).read().targetSha256;
    writeFileSync(join(f.home, "state", "new-agent-bootstrap"), "legitimate held initialization");
    const expected = await fingerprintImportTarget(f.home, f.plan.roots);
    assert.notEqual(expected, before);
    await complete(f);
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
    const ready = await complete(f);
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
    const ready = await complete(f);
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
    await complete(other);
    other.staleActivation();
    await assert.rejects(other.methods.methods["admin.import.runtime.release"]!(other.control, ctx));
    assert.equal(other.releases(), 0);
  } finally { await other.methods.close(); }
});
