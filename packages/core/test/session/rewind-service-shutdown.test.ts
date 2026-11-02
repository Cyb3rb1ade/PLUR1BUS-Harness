/** Checkpoint cancellation starts before waiting for a turn that may itself be held by checkpoint work. */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { memoryAuditSink } from "../../src/rbac/audit.ts";
import { openSessionService } from "../../src/session/service.ts";

test("session shutdown starts checkpoint cancellation before waiting for the runner", { timeout: 10_000 }, async () => {
  const root = mkdtempSync(join(tmpdir(), "cx-rewind-close-"));
  let enter!: () => void, release!: () => void, filesClosed = false;
  const entered = new Promise<void>(resolve => { enter = resolve; }), gate = new Promise<void>(resolve => { release = resolve; });
  const service = openSessionService({ dbPath: join(root, "sessions.sqlite"), audit: memoryAuditSink(), clock: Date.now,
    agents: { has: () => true, list: () => ["a"], workspaceOf: () => root } as never,
    logger: { info() {}, warn() {} } as never, isStopping: () => false, signal: new AbortController().signal, notify() {},
    provider: () => ({ id: "held-provider", async *stream() { enter(); await gate; yield { type: "delta" as const, text: "done" }; } }),
    memory: { recall: async () => ({ text: "", degraded: null }), capture: async () => {}, checkpoint: async () => {} },
    rewindFiles: { restore: async () => { throw Error("unexpected restore"); }, close: async () => { filesClosed = true; release(); } } });
  let closing: Promise<void> | undefined;
  try {
    const session = service.store.createSession({ kind: "card", agentId: "a", owner: "owner" });
    service.runner.submit({ session, caller: { channel: "cli", accountId: "local", userId: "owner" }, text: "task" });
    await entered;
    closing = service.close(10_000);
    assert.equal(filesClosed, true, "owned cancellation must start before the runner's budget wait");
    await closing;
  } finally {
    release();
    try { await (closing ?? service.close()); } finally { rmSync(root, { recursive: true, force: true }); }
  }
});
