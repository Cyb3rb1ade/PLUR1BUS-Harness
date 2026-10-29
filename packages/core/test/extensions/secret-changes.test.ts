/** A7: generic secret writes publish names only, then asynchronously reconcile affected packaged children. */
import { it } from "node:test";
import assert from "node:assert/strict";
import { createSecretStore } from "../../src/secrets/store.ts";
import { createMemoryBackend } from "../../src/secrets/memory-backend.ts";
import { createMemoryAuditSink } from "../../src/secrets/audit.ts";

function store() {
  const audit = createMemoryAuditSink();
  return { audit, store: createSecretStore({ keyring: createMemoryBackend(), file: createMemoryBackend(),
    fileFallback: () => false, audit }) };
}

it("only successful value changes notify metadata-only listeners, without letting observers alter a completed write", async () => {
  const rig = store();
  const subject = rig.store as typeof rig.store & { onChange?: (listener: (name: string) => void) => () => void };
  assert.equal(typeof subject.onChange, "function", "the real Secret Store must expose committed-name notifications");
  const seen: unknown[][] = [];
  const stop = subject.onChange!((...args) => { seen.push(args); });
  subject.onChange!(() => { throw Error("observer unavailable"); });
  const owner = { kind: "owner" as const };
  await subject.set(owner, "ext:example:TOKEN", "synthetic-private-value");
  assert.deepEqual(seen, [["ext:example:TOKEN"]]);
  await subject.describe(owner, "ext:example:TOKEN", "Description only");
  assert.equal(seen.length, 1);
  rig.audit.failNext = true;
  await assert.rejects(subject.set(owner, "ext:example:TOKEN", "synthetic-replacement"));
  assert.equal(seen.length, 1, "a refused mutation must never restart a child");
  await subject.delete(owner, "ext:example:TOKEN");
  assert.deepEqual(seen, [["ext:example:TOKEN"], ["ext:example:TOKEN"]]);
  stop();
  await subject.set(owner, "ext:example:TOKEN", "synthetic-replacement");
  assert.equal(seen.length, 2);
});

it("extension reconciliation is coalesced, does not await native maintenance locks and retries only bounded busy failures", async () => {
  const module = await import("../../src/extensions/secret-changes.ts").catch(() => null);
  assert.equal(typeof module?.watchExtensionSecretChanges, "function", "generic secret mutations must reach native extension setup");
  const rig = store(), mcp: string[] = [], native: string[] = [];
  const tasks: { run: () => void; cancelled: boolean }[] = [];
  const watch = module!.watchExtensionSecretChanges({ store: rig.store,
    mcp: async name => { mcp.push(name); },
    native: async name => { native.push(name); if (native.length < 3) throw { error: "E_CONFLICT", reason: "busy" }; },
    schedule: run => { const task = { run, cancelled: false }; tasks.push(task); return () => { task.cancelled = true; }; },
  });
  const owner = { kind: "owner" as const };
  try {
    await rig.store.set(owner, "unrelated", "synthetic-unrelated");
    await rig.store.set(owner, "ext:example:ONE", "synthetic-one");
    await rig.store.set(owner, "ext:example:TWO", "synthetic-two");
    assert.deepEqual(native, [], "the store response must not await an occupied native mutation lock");
    assert.deepEqual(mcp, ["example", "example"], "local MCP authority is revoked when the store changes");
    for (let i = 0; i < 3; i++) {
      tasks.shift()!.run();
      await new Promise<void>(resolve => setImmediate(resolve));
    }
    assert.deepEqual(native, ["example", "example", "example"]);
    assert.equal(tasks.length, 0);
    await rig.store.delete(owner, "ext:example:ONE");
    assert.equal(tasks.length, 1);
    watch.close();
    assert.equal(tasks[0]!.cancelled, true);
    await rig.store.delete(owner, "ext:example:TWO");
    assert.equal(tasks.length, 1, "a closed Core must not schedule new child work");
  } finally { watch.close(); }
});

it("bounds prolonged busy retries and makes the deferred extension eligible at the next metadata refresh", async () => {
  const { watchExtensionSecretChanges } = await import("../../src/extensions/secret-changes.ts");
  const rig = store(), tasks: (() => void)[] = [], deferred: string[] = [];
  let calls = 0, busy = true;
  const watch = watchExtensionSecretChanges({ store: rig.store, mcp: async () => {},
    native: async () => { calls++; if (busy) throw { error: "E_CONFLICT", reason: "busy" }; },
    deferred: name => { deferred.push(name); }, schedule: run => { tasks.push(run); return () => {}; } });
  try {
    await rig.store.set({ kind: "owner" }, "ext:example:TOKEN", "synthetic-value");
    for (let i = 0; i < 8; i++) { tasks.shift()!(); await new Promise<void>(resolve => setImmediate(resolve)); }
    assert.equal(tasks.length, 0); assert.equal(calls, 8); assert.deepEqual(deferred, ["example"]);
    busy = false; watch.retryPending();
    tasks.shift()!(); await new Promise<void>(resolve => setImmediate(resolve));
    assert.equal(calls, 9); assert.equal(tasks.length, 0);
    watch.retryPending(); assert.equal(tasks.length, 0, "a successful fresh attempt clears deferred metadata");
  } finally { watch.close(); }
});
