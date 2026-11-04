/** D120 Q13: only completed edit/failing-test cycles qualify; interactive sessions can only propose rewind. */
import assert from "node:assert/strict";
import { test } from "node:test";
import { failedEditCycles } from "../../src/session/rewind-cycles.ts";
import { SessionStore } from "../../src/session/store.ts";
import { RewindService } from "../../src/session/rewind.ts";
import { memoryAuditSink } from "../../src/rbac/audit.ts";
import type { EventRecord } from "../../src/session/types.ts";
import { openSessionService } from "../../src/session/service.ts";

function cycles(count: number): EventRecord[] {
  const events: EventRecord[] = [];
  const emit = (turnId: string, type: "tool.call" | "tool.result", data: Record<string, unknown>) => {
    events.push({ sessionId: "s", turnId, seq: events.length + 1, at: 0, type, data });
  };
  for (let index = 0; index < count; index++) {
    const turnId = `turn-${index}`;
    emit(turnId, "tool.call", { id: "edit", name: "file.edit", args: { path: "file.ts" } });
    emit(turnId, "tool.result", { id: "edit", output: JSON.stringify({ isError: false, value: {} }) });
    emit(turnId, "tool.call", { id: "check", name: "exec.run", args: { argv: ["node", "--test"] } });
    emit(turnId, "tool.result", { id: "check", output: JSON.stringify({ isError: false, value: { exitCode: 1 } }) });
  }
  return events;
}

test("three edit/test failures qualify and the first edit anchors the proposal", () => {
  assert.deepEqual(failedEditCycles(cycles(3)), { failedCycles: 3, fromTurnId: "turn-0", lastCheckSeq: 12, pendingEdit: false });
  const duplicateChecks = [...cycles(1), ...cycles(1).slice(2).map((event, index) => ({ ...event, seq: index + 5 }))];
  assert.equal(failedEditCycles(duplicateChecks).failedCycles, 1);
});

test("successful checks reset the streak and ordinary failed commands or refused writes are not cycles", () => {
  const events = cycles(3);
  events[11]!.data.output = JSON.stringify({ isError: false, value: { exitCode: 0 } });
  assert.equal(failedEditCycles(events).failedCycles, 0);
  const ordinary = cycles(3);
  for (const event of ordinary) if (event.type === "tool.call" && event.data.name === "exec.run") {
    event.data.args = { argv: ["cat", "missing.txt"] };
  }
  assert.equal(failedEditCycles(ordinary).failedCycles, 0);
  const refused = cycles(3);
  for (const event of refused) if (event.type === "tool.result" && event.data.id === "edit") {
    event.data.output = JSON.stringify({ isError: true, error: { code: "tool-denied" } });
  }
  assert.equal(failedEditCycles(refused).failedCycles, 0);
});

test("automatic rewind is off by default, requires an unattended opted-in D115 card, and otherwise only proposes", async () => {
  for (const mode of ["disabled", "interactive", "unattended", "direct"] as const) {
    const store = new SessionStore({ path: ":memory:" });
    try {
      const session = store.createSession({ kind: mode === "direct" ? "direct" : "card", agentId: "a", owner: "owner" });
      for (let index = 0; index < 3; index++) {
        const turn = store.beginTurn(session.id, `attempt ${index}`, 3);
        for (const event of cycles(1)) store.appendEvent(turn.turn.id, event.type, event.data);
        store.completeTurn(turn.turn.id, { text: "failed", tokens: 2 });
      }
      const audit = memoryAuditSink();
      const service = new RewindService({ store, audit, now: () => 42,
        project: () => ({ projectId: "project-a", cardId: "card-a", root: "/bound/root" }),
        autoProjects: () => mode === "disabled" ? [] : ["project-a"] });
      await service.afterTurn({ sessionId: session.id, personId: "owner", unattended: mode === "unattended" });
      assert.equal(store.rewinds(session.id).length, mode === "unattended" ? 1 : 0, mode);
      if (mode === "unattended") {
        assert.equal(store.rewinds(session.id)[0]?.trigger, "agent");
        assert.equal(audit.events[0]?.action, "session.rewind");
      } else {
        assert.equal(store.listEvents(session.id).at(-1)?.type, "session.rewind.proposed");
        assert.equal(store.rewindProposal(session.id)?.parentSeq, 0);
      }
    } finally { store.close(); }
  }
});

test("the turn boundary uses trusted T0 card origins, including one-shot work, and keeps live native turns interactive", async () => {
  const audit = memoryAuditSink();
  const sessions = openSessionService({ dbPath: ":memory:", clock: () => 42, audit,
    logger: { info() {}, warn() {} } as never, agents: { workspaceOf: () => "/workspace" } as never,
    isStopping: () => false, notify() {}, signal: new AbortController().signal,
    memory: { recall: async () => ({ text: "", degraded: null }), capture: async () => {}, checkpoint: async () => {} },
    autoRewindProjects: () => ["p"], rewindProject: () => ({ projectId: "p", cardId: "c", root: "/root" }),
    provider: () => ({ id: "cycle-provider", async *stream(request) {
      if (request.role === "summarize") { yield { type: "delta", text: "Inspect the interface before editing." }; return; }
      for (const event of cycles(3)) {
        const id = `${String(event.data.id)}-${Math.floor((event.seq - 1) / 4)}`;
        if (event.type === "tool.call") yield { type: "tool.call", id, name: String(event.data.name), args: event.data.args };
        else yield { type: "tool.result", id, output: String(event.data.output) };
      }
      yield { type: "delta", text: "Three checks failed." };
    } }) });
  try {
    for (const mode of ["recurring", "one-shot", "interactive"] as const) {
      const session = sessions.store.createSession({ kind: "card", agentId: "a", owner: "owner" });
      await sessions.runner.submit({ session, caller: { channel: "cli", accountId: "runtime", userId: "owner" },
        text: "coding work", approver: { person: "owner", surface: mode === "interactive" ? 3 : 0 },
        ...(mode === "recurring" ? {
          recurring: { jobId: "job", jobName: "coding", runAs: "owner", trigger: "recurring" as const },
        } : {}) }).done;
      assert.equal(sessions.store.rewinds(session.id).length, mode === "interactive" ? 0 : 1, mode);
      if (mode === "interactive") assert.ok(sessions.store.rewindProposal(session.id));
      else assert.equal(sessions.store.rewinds(session.id)[0]?.trigger, "agent");
    }
  } finally { await sessions.close(); }
});
