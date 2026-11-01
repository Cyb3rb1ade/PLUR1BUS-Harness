/** Failed harness commands remain in human history, but never become model or cached-prefix input. */
import assert from "node:assert/strict";
import { test } from "node:test";
import { memoryAuditSink } from "../../src/rbac/audit.ts";
import { deriveUserPrincipal } from "../../src/identity/principals.ts";
import { SessionStore } from "../../src/session/store.ts";
import { Compactor, defaultCompaction } from "../../src/session/compaction.ts";
import { FakeChatProvider, type ChatRequest } from "../../src/session/provider.ts";
import { TurnRunner } from "../../src/session/turn-loop.ts";
import { RewindService, type RewindFilesPort } from "../../src/session/rewind.ts";
import { SessionError } from "../../src/session/types.ts";
import type { Summarizer, SummaryMessage } from "../../src/session/summarizer.ts";

function rig(restore?: RewindFilesPort["restore"], summarize?: Summarizer) {
  const store = new SessionStore({ path: ":memory:" });
  const requests: ChatRequest[] = [];
  const session = store.createSession({ kind: "card", agentId: "agent", owner: deriveUserPrincipal("person") });
  let fileRequests = 0;
  const rewind = new RewindService({ store, audit: memoryAuditSink(), now: () => 42, ...(summarize ? { summarize } : {}), files: {
    async restore(input) {
      fileRequests++;
      if (restore) return restore(input);
      throw new SessionError("immutable", "file restore was not approved", "rewind-files-not-approved");
    },
  } });
  const runner = new TurnRunner({ store, compactor: new Compactor(store, defaultCompaction(8192), { beforeSwap: async () => {} }),
    memory: { recall: async () => ({ text: "", degraded: null }), capture: async () => {}, checkpoint: async () => {} },
    provider: () => new FakeChatProvider({ onRequest: request => { requests.push(request); } }), rewind });
  const caller = { channel: "cli" as const, accountId: "local", userId: "person" };
  const submit = (text: string) => runner.submit({ session, caller, text, authenticatedPerson: "person", approver: { person: "person", surface: 2 } }).done;
  return { store, session, requests, submit, fileRequests: () => fileRequests, close: async () => { await runner.idle(); store.close(); } };
}

for (const scenario of ["invalid-target", "declined-files"] as const) {
  test(`failed rewind (${scenario}) never forwards its command or private lesson on the next turn`, { timeout: 10_000 }, async () => {
    const r = rig();
    try {
      assert.equal((await r.submit("first task")).state, "completed");
      const original = r.store.listMessages(r.session.id).map(message => JSON.stringify(message));
      const note = `PRIVATE_LESSON_${scenario}`;
      const command = scenario === "invalid-target" ? `/rewind 99 --lesson "${note}"` : `/rewind 0 --files --lesson "${note}"`;
      assert.equal((await r.submit(command)).state, "failed");
      assert.equal(r.fileRequests(), scenario === "declined-files" ? 1 : 0);
      assert.deepEqual(r.store.listMessages(r.session.id).slice(0, original.length).map(message => JSON.stringify(message)), original);
      assert.ok(r.store.listMessages(r.session.id).some(message => message.text === command), "human history retains the command verbatim");
      assert.equal((await r.submit("next task")).state, "completed");
      const prompt = JSON.stringify(r.requests.at(-1)!.messages);
      assert.doesNotMatch(prompt, /\/rewind|PRIVATE_LESSON_/);
      assert.match(prompt, /first task|next task/);
      assert.equal(r.requests.length, 2, "the command itself never calls a model");
    } finally { await r.close(); }
  });
}

test("recovery of an interrupted file-approval command keeps its private lesson out of later context", { timeout: 10_000 }, async t => {
  let release!: () => void, entered!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const ready = new Promise<void>(resolve => { entered = resolve; });
  const r = rig(async () => { entered(); await gate; throw new SessionError("immutable", "file restore was not approved", "rewind-files-not-approved"); });
  t.after(async () => { release(); await r.close(); });
  await r.submit("first task");
  const pending = r.submit('/rewind 0 --files --lesson "PRIVATE_LESSON_RECOVERY"');
  await ready;
  const recovered = r.store.recoverRunningTurns();
  assert.equal(recovered.length, 1);
  assert.equal(recovered[0]!.data.error, "core-restarted");
  release(); await pending;
  await r.submit("next task");
  assert.doesNotMatch(JSON.stringify(r.requests.at(-1)!.messages), /\/rewind|PRIVATE_LESSON_RECOVERY/);
});

test("a later rewind never sends a failed command or its private note to the lesson summarizer", { timeout: 10_000 }, async () => {
  const inputs: SummaryMessage[][] = [];
  const r = rig(undefined, async messages => { inputs.push([...messages]); return "Try a different approach."; });
  try {
    await r.submit("first task");
    const command = '/rewind 99 --lesson "PRIVATE_LESSON_SUMMARY"';
    assert.equal((await r.submit(command)).state, "failed");
    await r.submit("next task");
    assert.equal((await r.submit("/rewind 0")).state, "completed");
    assert.equal(inputs.length, 1);
    assert.doesNotMatch(JSON.stringify(inputs), /\/rewind|PRIVATE_LESSON_SUMMARY/);
    assert.match(JSON.stringify(inputs), /first task|next task/);
    assert.ok(r.store.listMessages(r.session.id).some(message => message.text === command));
  } finally { await r.close(); }
});
