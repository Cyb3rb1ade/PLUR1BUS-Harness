/** D120 H4: overlay transactions preserve transcript bytes, survive restart and never leak into model history. */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { DatabaseSync } from "node:sqlite";
import { SessionStore } from "../../src/session/store.ts";
import { SessionError } from "../../src/session/types.ts";
import { Compactor, defaultCompaction } from "../../src/session/compaction.ts";
import { ToolPruner } from "../../src/session/pruning.ts";
import { MIGRATIONS, migrate } from "../../src/session/migrations.ts";
import { skillHistoryMessages } from "../../src/composition/skill-history.ts";
import { turnRequest } from "../composition/helpers.ts";
import { buildAnthropicBody } from "../../../providers/src/anthropic/request.ts";

function turn(store: SessionStore, sessionId: string, text: string, tool = false) {
  const start = store.beginTurn(sessionId, text, 2);
  if (tool) {
    store.appendEvent(start.turn.id, "tool.call", { id: start.turn.id, name: "file.read", args: { path: "discarded.ts" } });
    store.appendEvent(start.turn.id, "tool.result", { id: start.turn.id, output: "DISCARDED_TOOL_BODY" });
  }
  store.completeTurn(start.turn.id, { text: `answer: ${text}`, tokens: 4 });
  return start;
}

function rig(path = ":memory:") {
  let tick = 100;
  const store = new SessionStore({ path, clock: () => tick++ });
  const session = store.createSession({ kind: "direct", agentId: "a", owner: "person" });
  turn(store, session.id, "kept task");
  turn(store, session.id, "discarded attempt", true);
  return { store, session };
}

const options = { toSeq: 2, lesson: "Lesson from a discarded attempt: inspect the type first.", actor: "owner", trigger: "user" as const };

describe("D120 stored rewind", () => {
  it("undoing an older rewind cannot resurrect history covered by a newer rewind to the same parent", () => {
    const { store, session } = rig();
    try {
      const before = store.listMessages(session.id), events = store.listEvents(session.id);
      const first = store.rewindPath(session.id, { ...options, lesson: "lesson A" });
      const beforeSecond = store.listMessages(session.id);
      const second = store.rewindPath(session.id, { ...options, lesson: "lesson B" });
      store.undoRewind(session.id, first.id, "owner");
      assert.deepEqual(store.contextMessages(session.id).map(m => m.text), ["kept task", "answer: kept task", "lesson B"]);
      assert.equal(second.hiddenFromSeq, options.toSeq + 1);
      assert.equal(second.hiddenDigest, createHash("sha256")
        .update(JSON.stringify(beforeSecond.filter(m => m.seq > options.toSeq).map(m => [m.id, m.text]))).digest("hex"));
      assert.deepEqual(store.listMessages(session.id).slice(0, before.length), before);
      assert.deepEqual(store.listEvents(session.id).slice(0, events.length), events);
      store.undoRewind(session.id, second.id, "owner");
      assert.deepEqual(store.contextMessages(session.id), before);
    } finally { store.close(); }
  });

  it("forked corrective lessons keep conversation rank without relying on the source overlay's ids", () => {
    const { store, session } = rig();
    try {
      store.rewindPath(session.id, options);
      const fork = store.forkSession(session.id);
      const view = new Compactor(store, defaultCompaction()).view(fork.id);
      assert.equal(view.messages.at(-1)?.text, options.lesson);
      assert.equal(view.messages.at(-1)?.role, "user", "a model-derived lesson must not become a system instruction in a fork");
      assert.deepEqual(store.rewinds(fork.id), []);
    } finally { store.close(); }
  });
  it("restores the newest active skill pair rather than reviving a newer discarded load", () => {
    const { store, session } = rig();
    try {
      const load = (text: string) => {
        const turn = store.beginTurn(session.id, "load a skill", 3);
        store.appendEvent(turn.turn.id, "tool.call", { id: "load", name: "skill.load", args: { name: "example" } });
        store.appendEvent(turn.turn.id, "tool.result", { id: "load", output: JSON.stringify({ isError: false,
          value: { name: "example", text, files: [] } }) });
        store.completeTurn(turn.turn.id, { text: "loaded", tokens: 2 });
      };
      load("KEPT_SKILL_INSTRUCTIONS");
      load("DISCARDED_SKILL_INSTRUCTIONS");
      const rewind = store.rewindPath(session.id, { ...options, toSeq: 6 });
      const active = JSON.stringify(store.skillEvents(session.id));
      assert.match(active, /KEPT_SKILL_INSTRUCTIONS/);
      assert.doesNotMatch(active, /DISCARDED_SKILL_INSTRUCTIONS/);
      store.undoRewind(session.id, rewind.id, "owner");
      assert.match(JSON.stringify(store.skillEvents(session.id)), /DISCARDED_SKILL_INSTRUCTIONS/);
    } finally { store.close(); }
  });

  it("appends the overlay, note and digest without rewriting a message or event", () => {
    const { store, session } = rig();
    try {
      const before = store.listMessages(session.id);
      const events = store.listEvents(session.id);
      const rewind = store.rewindPath(session.id, options);
      assert.deepEqual(store.listMessages(session.id).slice(0, before.length), before);
      assert.deepEqual(store.listEvents(session.id).slice(0, events.length), events);
      assert.deepEqual([rewind.parentSeq, rewind.hiddenFromSeq, rewind.hiddenToSeq], [2, 3, 4]);
      const expected = createHash("sha256").update(JSON.stringify(before.slice(2).map(m => [m.id, m.text]))).digest("hex");
      assert.equal(rewind.hiddenDigest, expected);
      assert.deepEqual(store.contextMessages(session.id).map(m => m.seq), [1, 2, 5]);
      assert.equal(store.contextMessages(session.id).at(-1)?.role, "system");
      assert.equal(store.contextMessages(session.id).at(-1)?.text, options.lesson);
      assert.equal(store.listEvents(session.id).at(-1)?.type, "session.rewind");
    } finally { store.close(); }
  });

  it("undo restores the original active messages and tools and hides the obsolete lesson", () => {
    const { store, session } = rig();
    try {
      const before = store.contextMessages(session.id);
      const tools = store.contextToolEvents(session.id);
      const rewind = store.rewindPath(session.id, options);
      assert.deepEqual(store.contextToolEvents(session.id), []);
      store.undoRewind(session.id, rewind.id, "owner");
      assert.deepEqual(store.contextMessages(session.id), before);
      assert.deepEqual(store.contextToolEvents(session.id), tools);
      assert.equal(store.listMessages(session.id).length, 5);
      assert.equal(store.listEvents(session.id).at(-1)?.type, "session.rewind.undone");
    } finally { store.close(); }
  });

  it("marks hidden FTS hits while keeping their original indexed text searchable", () => {
    const { store, session } = rig();
    try {
      const rewind = store.rewindPath(session.id, options);
      const hits = store.searchMessages({ owner: "person", search: "discarded" });
      assert.equal(hits.length, 3);
      assert.equal(hits.filter(hit => hit.rewound).length, 2);
      store.undoRewind(session.id, rewind.id, "owner");
      assert.equal(store.searchMessages({ owner: "person", search: "attempt" }).filter(hit => hit.rewound).length, 1);
    } finally { store.close(); }
  });

  it("refuses busy sessions, hidden parents, empty ranges and stale asynchronous plans before writing", () => {
    const { store, session } = rig();
    try {
      const running = store.beginTurn(session.id, "in flight", 2);
      assert.throws(() => store.rewindPath(session.id, options), (error: unknown) =>
        error instanceof SessionError && error.reason === "turn-running");
      store.failTurn(running.turn.id, "cancelled");
      const revision = store.lastEventSeq(session.id)!;
      const before = JSON.stringify(store.listMessages(session.id));
      assert.throws(() => store.rewindPath(session.id, { ...options, expectedEventSeq: revision - 1 }),
        (error: unknown) => error instanceof SessionError && error.reason === "rewind-stale");
      assert.equal(JSON.stringify(store.listMessages(session.id)), before);
      const rewind = store.rewindPath(session.id, options);
      assert.throws(() => store.rewindPath(session.id, { ...options, toSeq: 3 }), /active path/);
      assert.throws(() => store.rewindPath(session.id, { ...options, toSeq: store.contextMessages(session.id).at(-1)!.seq }), /empty/);
      assert.throws(() => store.undoRewind("unknown", rewind.id, "owner"), /not found/);
    } finally { store.close(); }
  });

  it("last rewinds the newest whole turn and fork copies only the active path", () => {
    const { store, session } = rig();
    try {
      const rewind = store.rewindPath(session.id, { ...options, toSeq: "last" });
      assert.equal(rewind.parentSeq, 2);
      const fork = store.forkSession(session.id);
      assert.deepEqual(store.listMessages(fork.id).map(m => m.text),
        ["kept task", "answer: kept task", options.lesson]);
      assert.deepEqual(store.rewinds(fork.id), []);
    } finally { store.close(); }
  });

  it("commits no overlay or note when the required audit append fails", () => {
    const { store, session } = rig();
    try {
      const before = JSON.stringify(store.listMessages(session.id));
      assert.throws(() => store.rewindPath(session.id, { ...options, audit: () => { throw Error("audit unavailable"); } }),
        /audit unavailable/);
      assert.equal(JSON.stringify(store.listMessages(session.id)), before);
      assert.deepEqual(store.rewinds(session.id), []);
    } finally { store.close(); }
  });

  it("migrates a v9 file additively and persists the overlay and undo across restarts", () => {
    const dir = mkdtempSync(join(tmpdir(), "cx-rewind-"));
    const path = join(dir, "sessions.sqlite");
    try {
      const db = new DatabaseSync(path);
      migrate(db, MIGRATIONS.slice(0, 9));
      const oldText = "A v9 message with exact CRLF bytes\r\nand a Unicode character: ä";
      const oldEvent = '{ "text": "v9 event", "unknown": [1, 2] }';
      db.prepare(`INSERT INTO sessions (id,kind,agent_id,owner,scope,created_at,updated_at,last_message_seq,last_event_seq)
        VALUES ('ses_v9','direct','a','person','own',1,1,1,1)`).run();
      db.prepare(`INSERT INTO messages (id,session_id,seq,role,text,tokens,created_at)
        VALUES ('msg_v9','ses_v9',1,'user',?,20,1)`).run(oldText);
      db.prepare(`INSERT INTO events (session_id,seq,type,data,at) VALUES ('ses_v9',1,'turn.completed',?,1)`).run(oldEvent);
      db.close();
      let { store, session } = rig(path);
      const before = store.listMessages(session.id);
      const rewind = store.rewindPath(session.id, options);
      store.close();
      store = new SessionStore({ path });
      assert.deepEqual(store.listMessages(session.id).slice(0, 4), before);
      assert.deepEqual(store.contextMessages(session.id).map(m => m.seq), [1, 2, 5]);
      store.undoRewind(session.id, rewind.id, "owner");
      store.close();
      store = new SessionStore({ path });
      assert.deepEqual(store.contextMessages(session.id), before);
      store.close();
      const persisted = new DatabaseSync(path, { readOnly: true });
      try {
        assert.equal(persisted.prepare("SELECT text FROM messages WHERE id='msg_v9'").get()!.text, oldText);
        assert.equal(persisted.prepare("SELECT data FROM events WHERE session_id='ses_v9'").get()!.data, oldEvent);
        assert.equal(persisted.prepare("PRAGMA user_version").get()!.user_version, MIGRATIONS.length);
      } finally { persisted.close(); }
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});

describe("D120 compaction rewind isolation", () => {
  it("appends the lesson to the real provider conversation without changing its system or kept message prefix", () => {
    const { store, session } = rig();
    try {
      const compactor = new Compactor(store, defaultCompaction());
      const wire = () => buildAnthropicBody({ model: "claude-fixture", messages: [
        { role: "system", content: "STATIC_OPERATING_RULES" },
        ...skillHistoryMessages(turnRequest({ messages: compactor.view(session.id).messages.map(message => ({
          role: message.role, text: message.text, ...(message.turnId ? { turnId: message.turnId } : {}),
        })) }), []),
      ] }, { stream: false, defaultMaxTokens: 512 });
      const before = wire();
      store.rewindPath(session.id, options);
      const after = wire();
      assert.deepEqual(after.system, before.system, "providers hoist system messages, so the lesson must stay at conversation rank");
      const messages = after.messages as unknown[];
      assert.deepEqual(messages.slice(0, 2), (before.messages as unknown[]).slice(0, 2));
      assert.match(JSON.stringify(messages.at(-1)), /Lesson from a discarded attempt/);
      assert.doesNotMatch(JSON.stringify(after), /answer: discarded attempt|DISCARDED_TOOL_BODY/);
    } finally { store.close(); }
  });

  it("undo invalidates summaries of the obsolete lesson and restores an original summary without duplicate prefixes", async () => {
    const { store, session } = rig();
    try {
      store.addSummary({ sessionId: session.id, fromSeq: 1, toSeq: 4, text: "ORIGINAL_SUMMARY", tokens: 4,
        tier: 1, state: "applied" });
      const rewind = store.rewindPath(session.id, { ...options, lesson: "OBSOLETE_LESSON_MUST_LEAVE_CONTEXT" });
      for (let index = 0; index < 12; index++) turn(store, session.id, `new ${index} ` + "x".repeat(500));
      const compactor = new Compactor(store, { ...defaultCompaction(1000), summarizer: "digest" });
      for (let index = 0; index < 3; index++) {
        await compactor.afterTurn(session.id);
        await compactor.prepare(session.id);
      }
      store.undoRewind(session.id, rewind.id, "owner");
      const view = compactor.view(session.id);
      assert.doesNotMatch(JSON.stringify(view), /OBSOLETE_LESSON_MUST_LEAVE_CONTEXT/);
      assert.equal(view.summaries.some(summary => summary.fromSeq <= 5 && summary.toSeq >= 5), false);
      assert.equal(view.summaries.filter(summary => summary.text === "ORIGINAL_SUMMARY").length, 1);
      assert.equal(view.summaries.some(summary => summary.fromSeq === 1 && summary.toSeq === 2), false);
    } finally { store.close(); }
  });

  it("discards a background summary if a rewind commits while its summarize role is awaiting", async () => {
    const { store, session } = rig();
    try {
      for (let index = 0; index < 8; index++) turn(store, session.id, "large task ".repeat(80));
      let release!: () => void;
      let began!: () => void;
      const started = new Promise<void>(resolve => { began = resolve; });
      const pending = new Promise<void>(resolve => { release = resolve; });
      const compactor = new Compactor(store, defaultCompaction(1000), {
        summarizer: async () => { began(); await pending; return "STALE_DISCARDED_SUMMARY"; } });
      const worker = compactor.afterTurn(session.id);
      await started;
      store.rewindPath(session.id, options);
      release();
      assert.equal((await worker).prepared, false);
      assert.equal(store.listSummaries(session.id).length, 0);
      assert.doesNotMatch(JSON.stringify(compactor.view(session.id)), /STALE_DISCARDED_SUMMARY/);
    } finally { store.close(); }
  });

  it("can compact the new continuation without creating a summary across the discarded hole", async () => {
    const { store, session } = rig();
    try {
      store.rewindPath(session.id, options);
      for (let index = 0; index < 12; index++) turn(store, session.id, `new task ${index} ` + "x".repeat(500));
      const inputs: string[] = [];
      const compactor = new Compactor(store, defaultCompaction(1000), { summarizer: async messages => {
        inputs.push(...messages.map(message => message.text));
        return "kept task and new work";
      } });
      for (let index = 0; index < 3; index++) {
        await compactor.afterTurn(session.id);
        await compactor.prepare(session.id);
      }
      assert.ok(store.listSummaries(session.id, "applied").some(summary => summary.fromSeq >= 5));
      assert.equal(store.listSummaries(session.id).some(summary => summary.fromSeq <= 4 && summary.toSeq >= 3), false);
      assert.doesNotMatch(JSON.stringify(inputs), /answer: discarded attempt|DISCARDED_TOOL_BODY/);
    } finally { store.close(); }
  });

  it("never renders discarded tools or an overlapping applied or prepared summary", async () => {
    const { store, session } = rig();
    try {
      store.addSummary({ sessionId: session.id, fromSeq: 1, toSeq: 4, text: "DISCARDED_SUMMARY_BODY", tokens: 4, tier: 1, state: "applied" });
      store.addSummary({ sessionId: session.id, fromSeq: 1, toSeq: 4, text: "DISCARDED_PREPARED_BODY", tokens: 4, tier: 1, state: "prepared" });
      const rewind = store.rewindPath(session.id, options);
      const compactor = new Compactor(store, defaultCompaction(), { pruner: new ToolPruner(store) });
      const view = await compactor.prepare(session.id);
      assert.equal(view.summaries.length, 0);
      assert.deepEqual(view.messages.map(m => m.seq), [1, 2, 5]);
      assert.doesNotMatch(JSON.stringify(view), /DISCARDED_|answer: discarded attempt/);
      store.undoRewind(session.id, rewind.id, "owner");
      assert.equal(compactor.view(session.id).summaries[0]?.text, "DISCARDED_SUMMARY_BODY");
    } finally { store.close(); }
  });

  it("hides tool events when only the assistant side of their turn was discarded", () => {
    const { store, session } = rig();
    try {
      store.rewindPath(session.id, { ...options, toSeq: 3 });
      const view = new Compactor(store, defaultCompaction(), { pruner: new ToolPruner(store) }).view(session.id);
      assert.doesNotMatch(JSON.stringify(view), /DISCARDED_TOOL_BODY/);
      assert.equal(view.messages.some(m => m.seq === 3), true);
    } finally { store.close(); }
  });
});
