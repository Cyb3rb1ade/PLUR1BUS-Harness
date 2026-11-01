/** D120 H4: lesson distillation uses the existing summarize budget and only bounded tool envelopes. */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { memoryAuditSink } from "../../src/rbac/audit.ts";
import { SessionStore } from "../../src/session/store.ts";
import { RewindService, parseRewindCommand } from "../../src/session/rewind.ts";
import { openSessionService } from "../../src/session/service.ts";
import type { ChatRequest } from "../../src/session/provider.ts";

function rig(artifactId: unknown = "artifact-a") {
  const store = new SessionStore({ path: ":memory:" });
  const session = store.createSession({ kind: "direct", agentId: "a", owner: "owner" });
  const first = store.beginTurn(session.id, "inspect the types", 4);
  store.completeTurn(first.turn.id, { text: "types inspected", tokens: 4 });
  const failed = store.beginTurn(session.id, "try the edit", 4);
  store.appendEvent(failed.turn.id, "tool.call", { id: "edit", name: "file.write", args: { path: "src/example.ts" } });
  store.appendEvent(failed.turn.id, "tool.result", { id: "edit", output: JSON.stringify({ isError: false, value: { written: true } }) });
  store.appendEvent(failed.turn.id, "tool.call", { id: "check", name: "exec.run", args: { argv: ["node", "--test"] } });
  store.appendEvent(failed.turn.id, "tool.result", { id: "check", output: JSON.stringify({ isError: false, value: {
    exitCode: 1, stdout: "FAIL type contract\nARTIFACT_BODY_MUST_NOT_REACH_SUMMARIZE", stderr: "",
    artifact: { id: artifactId, bytes: 1000000 }, essence: "FAIL type contract",
  } }) });
  store.completeTurn(failed.turn.id, { text: "the test failed", tokens: 4 });
  const audit = memoryAuditSink();
  return { store, session, audit };
}

describe("D120 lesson service", () => {
  it("does not accept an artifact body disguised as an identifier in untrusted metadata", async () => {
    for (const id of [{ body: "MISLABELED_ARTIFACT_BODY" }, "x".repeat(10000)]) {
      const { store, session, audit } = rig(id);
      try {
        let input = "";
        await new RewindService({ store, audit, now: () => 42, summarize: async messages => {
          input = JSON.stringify(messages); return "Validate the types first.";
        } }).rewind({ sessionId: session.id, toSeq: 2, actor: "owner" });
        assert.doesNotMatch(input, /MISLABELED_ARTIFACT_BODY|x{257}/);
      } finally { store.close(); }
    }
  });

  it("keeps an already discarded partial turn and its metadata out of a later lesson", async () => {
    const { store, session, audit } = rig();
    try {
      await new RewindService({ store, audit, now: () => 42 })
        .rewind({ sessionId: session.id, toSeq: 3, lesson: "Inspect the interface.", actor: "owner" });
      assert.deepEqual(store.contextToolEvents(session.id), []);
      let input = "";
      await new RewindService({ store, audit, now: () => 42, summarize: async messages => {
        input = JSON.stringify(messages); return "Try another approach.";
      } }).rewind({ sessionId: session.id, toSeq: 2, actor: "owner" });
      assert.doesNotMatch(input, /artifact-a|FAIL type contract/);
      const supplied = JSON.parse(input) as { role: string; seq: number }[];
      assert.equal(supplied.some(message => message.role === "assistant" && message.seq === 4), false);
    } finally { store.close(); }
  });

  it("the production summarize route asks for a corrective lesson and offers no tools or recalled memory", async () => {
    const requests: ChatRequest[] = [];
    const sessions = openSessionService({ dbPath: ":memory:", clock: () => 42, audit: memoryAuditSink(),
      logger: { info() {}, warn() {} } as never, agents: { workspaceOf: () => "/workspace" } as never,
      isStopping: () => false, notify() {}, signal: new AbortController().signal,
      memory: { recall: async () => ({ text: "", degraded: null }), capture: async () => {}, checkpoint: async () => {} },
      provider: () => ({ id: "lesson-provider", async *stream(request) {
        requests.push(request); yield { type: "delta", text: "Validate the interface before writing." };
      } }) });
    try {
      const session = sessions.store.createSession({ kind: "direct", agentId: "a", owner: "owner" });
      const turn = sessions.store.beginTurn(session.id, "try the edit", 3);
      sessions.store.completeTurn(turn.turn.id, { text: "the check failed", tokens: 4 });
      await sessions.rewind.rewind({ sessionId: session.id, toSeq: 0, actor: "owner" });
      assert.equal(requests.length, 1);
      assert.equal(requests[0]!.role, "summarize");
      assert.match(requests[0]!.messages[0]!.text, /corrective lesson/i);
      assert.deepEqual(requests[0]!.toolView, []);
      assert.equal(requests[0]!.memory, "");
      assert.ok(requests[0]!.maxOutputTokens! <= 400);
    } finally { await sessions.close(); }
  });

  it("uses a person's bounded note directly and writes a content-free audit with the hidden digest", async () => {
    const { store, session, audit } = rig();
    try {
      const service = new RewindService({ store, audit, now: () => 42,
        summarize: async () => { throw Error("explicit note must not invoke a model"); } });
      const rewind = await service.rewind({ sessionId: session.id, toSeq: 2, lesson: "Check the interface first.", actor: "owner" });
      assert.equal(store.contextMessages(session.id).at(-1)?.text,
        "Lesson from a discarded attempt: Files changed: src/example.ts. Check the interface first.");
      assert.equal(audit.events.length, 1);
      assert.equal(audit.events[0]?.action, "session.rewind");
      assert.equal(audit.events[0]?.detail.hiddenDigest, rewind.hiddenDigest);
      assert.doesNotMatch(JSON.stringify(audit.events), /Check the interface|try the edit|ARTIFACT_BODY/);
      service.undo(session.id, rewind.id, "owner");
      assert.equal(audit.events.at(-1)?.action, "session.rewind.undone");
    } finally { store.close(); }
  });

  it("distills through the summarize port with a 400-token cap and tool envelopes rather than artifact bodies", async () => {
    const { store, session, audit } = rig();
    try {
      let input = "", cap = 0;
      const service = new RewindService({ store, audit, now: () => 42, summarize: async (messages, maxTokens) => {
        input = JSON.stringify(messages);
        cap = maxTokens;
        return "Inspect types before writing.";
      } });
      await service.rewind({ sessionId: session.id, toSeq: 2, actor: "owner" });
      assert.ok(cap <= 400);
      assert.match(input, /src\/example.ts/);
      assert.match(input, /FAIL type contract/);
      assert.doesNotMatch(input, /ARTIFACT_BODY_MUST_NOT_REACH_SUMMARIZE/);
      assert.match(store.contextMessages(session.id).at(-1)!.text, /Inspect types before writing/);
    } finally { store.close(); }
  });

  it("uses a deterministic file and failing-check digest when the role is missing or the budget refuses it", async () => {
    for (const unavailable of [true, false]) {
      const { store, session, audit } = rig();
      try {
        const service = new RewindService({ store, audit, now: () => 42,
          ...(unavailable ? {} : { summarize: async () => { throw Error("budget_exceeded"); } }) });
        await service.rewind({ sessionId: session.id, toSeq: 2, actor: "owner" });
        const note = store.contextMessages(session.id).at(-1)!.text;
        assert.match(note, /Files changed: src\/example.ts/);
        assert.match(note, /FAIL type contract/);
        assert.ok(note.length <= 1600);
        assert.doesNotMatch(note, /ARTIFACT_BODY/);
      } finally { store.close(); }
    }
  });

  it("refuses an asynchronously stale lesson rather than hiding a newer turn", async () => {
    const { store, session, audit } = rig();
    try {
      let release!: () => void;
      const gate = new Promise<void>(resolve => { release = resolve; });
      const service = new RewindService({ store, audit, now: () => 42, summarize: async () => { await gate; return "old lesson"; } });
      const rewind = service.rewind({ sessionId: session.id, toSeq: 2, actor: "owner" });
      const next = store.beginTurn(session.id, "newer instruction", 4);
      store.completeTurn(next.turn.id, { text: "newer answer", tokens: 4 });
      release();
      await assert.rejects(rewind, (error: unknown) => (error as { reason?: string }).reason === "rewind-stale");
      assert.deepEqual(store.rewinds(session.id), []);
      assert.deepEqual(audit.events, []);
    } finally { store.close(); }
  });

  it("bounds the complete harness note, including the prefix, even for oversized model output", async () => {
    const { store, session, audit } = rig();
    try {
      await new RewindService({ store, audit, now: () => 42, summarize: async () => "x".repeat(20000) })
        .rewind({ sessionId: session.id, toSeq: 2, actor: "owner" });
      assert.ok(store.contextMessages(session.id).at(-1)!.text.length <= 1600);
    } finally { store.close(); }
  });
});

describe("D120 transcript rewind parsing", () => {
  it("parses last, a kept sequence, a quoted lesson, files and undo without running a shell", () => {
    assert.deepEqual(parseRewindCommand("/rewind"), { toSeq: "last" });
    assert.deepEqual(parseRewindCommand("/rewind 12 --lesson \"Keep the API stable\" --files"),
      { toSeq: 12, lesson: "Keep the API stable", files: true });
    assert.deepEqual(parseRewindCommand("/rewind --undo rew_123"), { undo: "rew_123" });
    assert.equal(parseRewindCommand("please /rewind 12"), null);
    assert.equal(parseRewindCommand("/rewinding"), null);
  });

  it("rejects ambiguous flags, negative or unsafe seqs and incomplete quotes", () => {
    for (const command of ["/rewind -1", "/rewind 9007199254740992", "/rewind 1 2", "/rewind --lesson",
      "/rewind --lesson 'unterminated", "/rewind --undo rew_1 --files", "/rewind --unknown", "/rewind --files --files"]) {
      assert.throws(() => parseRewindCommand(command), /rewind/);
    }
  });
});
