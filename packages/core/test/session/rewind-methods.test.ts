/** D120 CX1: the human RPC/command gates share one rewind service and never submit discarded text again. */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { guardMethods } from "../../src/rbac/guard.ts";
import { memoryAuditSink } from "../../src/rbac/audit.ts";
import { deriveUserPrincipal } from "../../src/identity/principals.ts";
import { userPrincipalHash } from "../../src/principal.ts";
import { buildChatSurface } from "../../src/rpc/chat-surface.ts";
import { openSessionService } from "../../src/session/service.ts";
import { FakeChatProvider, type ChatRequest } from "../../src/session/provider.ts";
import type { Principal } from "../../src/rbac/types.ts";
import type { Handler } from "../../src/rpc/server.ts";

const caller = { channel: "cli" as const, accountId: "local", userId: "owner" };
const person: Principal = { userId: "owner", role: "owner", kind: "person" };
const agents = { has: () => true, list: () => ["a"], workspaceOf: () => "/workspace" } as never;

function rig() {
  const requests: ChatRequest[] = [];
  const audit = memoryAuditSink();
  const captured: unknown[] = [];
  const sessions = openSessionService({ dbPath: ":memory:", clock: () => 42, agents, audit,
    isStopping: () => false, logger: { info() {}, warn() {} } as never,
    provider: () => new FakeChatProvider({ onRequest: req => { requests.push(req); } }),
    notify() {}, signal: new AbortController().signal,
    memory: { recall: async () => ({ text: "", degraded: null }), capture: async value => { captured.push(value); },
      checkpoint: async () => {} }, approver: async () => ({ person: "owner", surface: 2 }) });
  const chat = buildChatSurface({ sessions: () => sessions, agents, audit, now: () => 42,
    approver: async () => ({ person: "owner", surface: 2 }) });
  const methods = { ...sessions.methods, ...chat };
  const invoke = (name: string, params: object, who: Principal = person) => {
    const guarded = guardMethods(methods, { resolve: () => who, now: () => 42 });
    return guarded[name]!(params, { requestId: "r", connectionId: "c", signal: new AbortController().signal });
  };
  return { sessions, requests, captured, audit, invoke };
}

describe("D120 rewind human surfaces", () => {
  it("chat.submit refuses an agent's rewind before admission even if an approver port would supply a person", async () => {
    const r = rig();
    try {
      const session = r.sessions.store.createSession({ kind: "direct", agentId: "a", owner: deriveUserPrincipal(person.userId) });
      const start = r.sessions.store.beginTurn(session.id, "original task", 3);
      r.sessions.store.completeTurn(start.turn.id, { text: "original reply", tokens: 3 });
      const messages = r.sessions.store.listMessages(session.id), events = r.sessions.store.listEvents(session.id);
      const agent: Principal = { ...person, kind: "agent", tokenScopes: ["chat:write"] };
      for (const text of ["/rewind 0", "/rewind 0 --files", "/rewind --undo fake-id"]) {
        await assert.rejects(r.invoke("chat.submit", { sessionId: session.id, text, wait: true }, agent),
          { error: "E_DENIED", reason: "rewind-person-required" });
      }
      assert.deepEqual(r.sessions.store.listMessages(session.id), messages);
      assert.deepEqual(r.sessions.store.listEvents(session.id), events);
      assert.deepEqual(r.sessions.store.rewinds(session.id), []);
      assert.equal(r.requests.length, 0);
    } finally { await r.sessions.close(); }
  });

  it("session rewind accepts the authenticated person's canonical card owner and refuses another person", async () => {
    const r = rig();
    try {
      const session = r.sessions.store.createSession({ kind: "card", agentId: "a", owner: deriveUserPrincipal(person.userId) });
      const start = r.sessions.store.beginTurn(session.id, "discarded card attempt", 3);
      r.sessions.store.completeTurn(start.turn.id, { text: "failed", tokens: 1 });
      await assert.rejects(r.invoke("session.rewind", { caller, sessionId: session.id, toSeq: 0 },
        { ...person, userId: "other" }));
      await r.invoke("session.rewind", { caller, sessionId: session.id, toSeq: 0, lesson: "Inspect first." });
      assert.equal(r.sessions.store.rewinds(session.id).length, 1);
    } finally { await r.sessions.close(); }
  });

  it("runs session rewind/undo and a local command without forwarding the command or discarded turn to the model", async () => {
    const r = rig();
    try {
      const session = r.sessions.store.createSession({ kind: "direct", agentId: "a", owner: userPrincipalHash(caller) });
      for (const text of ["keep this", "discard this"]) await r.invoke("session.submit", { caller, sessionId: session.id, text, wait: true });
      const outcome = await r.invoke("session.rewind", { caller, sessionId: session.id, toSeq: 2, lesson: "Use the known interface." }) as {
        rewind: { id: string; hiddenDigest: string };
      };
      assert.equal(outcome.rewind.hiddenDigest.length, 64);
      const transcript = await r.invoke("session.resume", { caller, sessionId: session.id }) as {
        messages: { text: string; rewound?: boolean }[]; rewinds: unknown[];
      };
      assert.equal(transcript.messages.filter(message => message.rewound).length, 2);
      assert.equal(transcript.rewinds.length, 1);
      await r.invoke("session.submit", { caller, sessionId: session.id, text: "continue", wait: true });
      assert.doesNotMatch(JSON.stringify(r.requests.at(-1)!.messages), /discard this/);
      await r.invoke("session.rewind", { caller, sessionId: session.id, undo: outcome.rewind.id });
      await r.invoke("session.submit", { caller, sessionId: session.id, text: "continue again", wait: true });
      assert.match(JSON.stringify(r.requests.at(-1)!.messages), /discard this/);
      const count = r.requests.length, captures = r.captured.length;
      await r.invoke("session.submit", { caller, sessionId: session.id, text: "/rewind 2 --lesson 'Try the interface'", wait: true });
      assert.equal(r.requests.length, count);
      assert.equal(r.captured.length, captures);
      await r.invoke("session.submit", { caller, sessionId: session.id, text: "try again", wait: true });
      assert.doesNotMatch(JSON.stringify(r.requests.at(-1)!.messages), /\/rewind/);
    } finally { await r.sessions.close(); }
  });

  it("allows own direct chat rewind, splits discarded export content and denies another owner or any agent", async () => {
    const r = rig();
    try {
      const session = r.sessions.store.createSession({ kind: "direct", agentId: "a", owner: deriveUserPrincipal(person.userId) });
      const start = r.sessions.store.beginTurn(session.id, "discarded content", 4);
      r.sessions.store.completeTurn(start.turn.id, { text: "discarded answer", tokens: 4 });
      const params = { sessionId: session.id, toSeq: 0, lesson: "Keep it short." };
      for (const who of [{ ...person, kind: "agent" as const }, { ...person, userId: "other" }]) {
        await assert.rejects(r.invoke("chat.rewind", params, who), (error: unknown) =>
          ["E_DENIED", "E_NOT_FOUND"].includes((error as { error: string }).error));
      }
      await r.invoke("chat.rewind", params);
      const exported = await r.invoke("chat.export", { sessionId: session.id }) as {
        messages: { text: string }[]; discarded: { text: string }[];
      };
      assert.doesNotMatch(JSON.stringify(exported.messages), /discarded content|discarded answer/);
      assert.equal(exported.discarded.length, 2);
      assert.match(JSON.stringify(exported.discarded), /discarded content/);
      assert.equal(r.audit.events.filter(event => event.action === "session.rewind").length, 1);
    } finally { await r.sessions.close(); }
  });

  it("refuses a transcript rewind from a non-person approver before starting a turn", async () => {
    const r = rig();
    try {
      const session = r.sessions.store.createSession({ kind: "direct", agentId: "a", owner: "owner" });
      assert.throws(() => r.sessions.runner.submit({ session, caller, text: "/rewind", approver: { person: null, surface: 0 } }),
        /person/);
      assert.equal(r.sessions.store.listMessages(session.id).length, 0);
    } finally { await r.sessions.close(); }
  });
});
