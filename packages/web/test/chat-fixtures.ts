// A small in-memory chat backend for the chat page tests, built on the mock /rpc and /events of test/mock-rpc.ts: the
// session.* methods of docs/rpc.md, with streaming that the TEST drives (delta(), complete(), cancel by the page) so that
// every state is deterministic. Not shipped, not part of the product code.
import type { Page } from "playwright";
import type { SessionEvent, SessionEventType, SessionMessage, SessionRecord } from "../src/pages/chat/rpc-types.ts";
import { signIn, withApp, type App, type AppOptions } from "./harness.ts";
import { rpcError } from "./mock-rpc.ts";
import type { MockHarnessServer } from "./mock-server.ts";

export type SeedSession = { id?: string; agentId?: string; title?: string; memoryMode?: "remember" | "incognito"; messages?: [role: "user" | "assistant", text: string][]; lastTurnAt?: number };

export class FakeChat {
  readonly sessions: SessionRecord[] = [];
  readonly messages = new Map<string, SessionMessage[]>();
  readonly log = new Map<string, SessionEvent[]>();
  readonly running = new Map<string, string>();
  readonly partial = new Map<string, string>();
  /** Thrown by the next session.submit when set (one shot). */
  submitFailure: { code: "E_NOT_AVAILABLE" | "E_CONFLICT" | "E_NOT_FOUND"; message: string; reason?: string } | null = null;
  readonly server: MockHarnessServer;
  /** false: events are only logged (a push would switch the mock /events on). */
  live = true;
  #n = 0;

  constructor(server: MockHarnessServer) { this.server = server; }

  seed(s: SeedSession = {}): SessionRecord {
    const id = s.id ?? `auto_${++this.#n}`;
    const now = s.lastTurnAt ?? 1_700_000_000_000 + this.sessions.length * 60_000;
    const rec: SessionRecord = {
      id, kind: "direct", agentId: s.agentId ?? "bernd", scope: "user:test", chatKey: null, title: s.title ?? "", pinned: false,
      memoryMode: s.memoryMode ?? "remember", createdAt: now, updatedAt: now, lastTurnAt: now, archivedAt: null, turnCount: 0,
    };
    this.sessions.push(rec);
    this.messages.set(id, []);
    this.log.set(id, []);
    let turn = 0;
    for (const [role, text] of s.messages ?? []) {
      if (role === "user") turn += 1;
      this.#addMessage(id, role, text, `t_seed${turn}`);
    }
    // Seeded history is old news: the event log of its turns is empty but the seq counter stays consistent.
    return rec;
  }

  #addMessage(sessionId: string, role: "user" | "assistant", text: string, turnId: string): SessionMessage {
    const list = this.messages.get(sessionId) ?? [];
    const m: SessionMessage = { id: `m_${sessionId}_${list.length + 1}`, seq: list.length + 1, role, text, turnId, createdAt: Date.now() };
    list.push(m);
    this.messages.set(sessionId, list);
    return m;
  }

  /** Appends one event to the session's log; with `push` (default) it also goes out on /events like the real server would. */
  emit(sessionId: string, type: SessionEventType, data: Record<string, unknown>, o: { turnId?: string | null; push?: boolean } = {}): SessionEvent {
    const log = this.log.get(sessionId);
    const rec = this.sessions.find((s) => s.id === sessionId);
    if (!log || !rec) throw new Error(`unknown session ${sessionId}`);
    const turnId = o.turnId === undefined ? (this.running.get(sessionId) ?? null) : o.turnId;
    const ev: SessionEvent = { sessionId, seq: (log[log.length - 1]?.seq ?? 0) + 1, turnId, type, data, at: Date.now() };
    log.push(ev);
    if (o.push !== false && this.live) this.server.events.push({ event: "session.event", data: { agentId: rec.agentId, event: ev } });
    return ev;
  }

  delta(sessionId: string, text: string, o: { push?: boolean } = {}): SessionEvent {
    this.partial.set(sessionId, (this.partial.get(sessionId) ?? "") + text);
    return this.emit(sessionId, "delta", { index: 0, text }, o);
  }

  complete(sessionId: string, o: { push?: boolean } = {}): void {
    const turnId = this.running.get(sessionId);
    if (!turnId) throw new Error("no running turn");
    const m = this.#addMessage(sessionId, "assistant", this.partial.get(sessionId) ?? "", turnId);
    this.running.delete(sessionId);
    this.partial.delete(sessionId);
    const rec = this.sessions.find((s) => s.id === sessionId);
    if (rec) { rec.turnCount += 1; rec.lastTurnAt = Date.now(); if (rec.title === "") rec.title = "Auto title"; }
    this.emit(sessionId, "turn.completed", { turnId, messageId: m.id }, { turnId, push: o.push ?? true });
  }

  install(): void {
    const { rpc } = this.server;
    this.server.events.enable();
    rpc.handle("session.list", () => ({
      sessions: this.sessions.filter((s) => s.archivedAt === null).sort((a, b) => (b.lastTurnAt ?? 0) - (a.lastTurnAt ?? 0)),
      truncated: false,
    }), { write: false });
    rpc.handle("session.create", (p) => {
      const q = p as { agentId: string; kind?: string; memoryMode?: "remember" | "incognito" };
      if (q.agentId === "nobody") throw rpcError("E_AGENT_UNKNOWN", "unknown agent");
      return { session: this.seed({ agentId: q.agentId, memoryMode: q.memoryMode ?? "remember", lastTurnAt: Date.now() }) };
    });
    rpc.handle("session.resume", (p) => {
      const id = (p as { sessionId: string }).sessionId;
      const session = this.sessions.find((s) => s.id === id);
      if (!session) throw rpcError("E_NOT_FOUND", "no such session");
      return { session, runningTurnId: this.running.get(id) ?? null, messages: this.messages.get(id) ?? [], lastEventSeq: this.log.get(id)?.at(-1)?.seq ?? 0 };
    }, { write: false });
    rpc.handle("session.submit", (p) => {
      const q = p as { sessionId: string; text: string };
      if (this.submitFailure) { const f = this.submitFailure; this.submitFailure = null; throw rpcError(f.code, f.message, f.reason); }
      if (!this.sessions.some((s) => s.id === q.sessionId)) throw rpcError("E_NOT_FOUND", "no such session");
      if (this.running.has(q.sessionId)) throw rpcError("E_CONFLICT", "a turn is running", "turn-in-progress");
      const turnId = `t_${++this.#n}`;
      const m = this.#addMessage(q.sessionId, "user", q.text, turnId);
      this.running.set(q.sessionId, turnId);
      this.emit(q.sessionId, "turn.started", { turnId, turnSeq: 1, messageId: m.id }, { turnId });
      return { sessionId: q.sessionId, turnId, messageId: m.id, state: "running" };
    });
    rpc.handle("session.events", (p) => {
      const q = p as { sessionId: string; afterSeq?: number; limit?: number };
      const all = (this.log.get(q.sessionId) ?? []).filter((e) => e.seq > (q.afterSeq ?? 0));
      const events = all.slice(0, q.limit ?? 2000);
      return { sessionId: q.sessionId, events, lastSeq: this.log.get(q.sessionId)?.at(-1)?.seq ?? 0, running: this.running.has(q.sessionId) };
    }, { write: false });
    rpc.handle("session.cancel", (p) => {
      const id = (p as { sessionId: string }).sessionId;
      const turnId = this.running.get(id) ?? null;
      if (turnId) { this.running.delete(id); this.partial.delete(id); this.emit(id, "turn.failed", { turnId, error: "cancelled" }, { turnId }); }
      return { sessionId: id, turnId, cancelled: turnId !== null };
    });
  }
}

export const AGENTS = [{ agentId: "bernd", open: true, activity: { state: "idle" } }, { agentId: "mara", open: false, activity: { state: "idle" } }];

export async function stubAgents(page: Page, agents: unknown = AGENTS, status = 200): Promise<void> {
  await page.route("**/api/v1/agents", (r) => r.fulfill({ status, contentType: "application/json", body: JSON.stringify(status === 200 ? { schema: "agents.list/1", agents } : { schema: "error/1", error: "E_CORE_UNAVAILABLE", message: "down", reason: "down" }) }));
}

export type ChatAppOptions = AppOptions & {
  /** Hash route to open after sign-in (default the landing route `#/chat`). */
  route?: string;
  seed?: (chat: FakeChat) => void;
  /** Leave /rpc off (404), like the backend today. */
  noRpc?: boolean;
  /** Leave /events off (404). */
  noEvents?: boolean;
  agents?: unknown;
};

export async function withChat(opts: ChatAppOptions, run: (ctx: App & { chat: FakeChat }) => Promise<void>): Promise<void> {
  const { route, seed, noRpc, noEvents, agents, ...appOpts } = opts;
  await withApp({ ...appOpts, ...(route ? { hash: route } : {}) }, async (app) => {
    const chat = new FakeChat(app.server);
    if (!noRpc) chat.install();
    if (noEvents) { app.server.events.enable(false); chat.live = false; }
    seed?.(chat);
    await stubAgents(app.page, agents ?? AGENTS);
    await signIn(app.page, undefined, appOpts.locale?.startsWith("de") ? "de" : "en");
    await app.page.locator(".sidebar").waitFor();
    await run({ ...app, chat });
  });
}
