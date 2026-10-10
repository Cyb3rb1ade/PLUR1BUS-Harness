// The session store (M1b-2c, A7): node:sqlite + FTS5. Synchronous by design (one resident core, one writer), so a
// "transaction" here is a plain BEGIN IMMEDIATE .. COMMIT with no await inside.
import { randomUUID } from "node:crypto";
import { chmodSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { migrate } from "./migrations.ts";
import {
  SESSION_KINDS, SessionError,
  type EventRecord, type EventType, type MemoryMode, type MessageRecord, type MessageRole, type SearchHit, type SessionKind, type SessionRecord,
  type SummaryRecord, type TurnRecord,
} from "./types.ts";

export interface StoreOptions { path: string; clock?: () => number; newId?: (prefix: string) => string }

export interface CreateSessionInput {
  kind: SessionKind; agentId: string; owner: string;
  /** I1; default `user` (RULING: a placeholder until RBAC scopes land with M3). */
  scope?: string;
  title?: string; memoryMode?: MemoryMode;
  /** Required for, and only allowed on, `channel` sessions (D21). */
  chatKey?: string;
  /** D21 `/new`: archive the chat's active session and open the next in one transaction. */
  replaceActive?: boolean;
}

export type ArchivedFilter = "exclude" | "only" | "any";
export interface ListFilter {
  owner: string; kind?: SessionKind; agentId?: string; archived?: ArchivedFilter; search?: string; limit?: number;
}

/** The only fields `updateSession` may change; everything else is I1-immutable. */
export interface SessionPatch { title?: string; pinned?: boolean; memoryMode?: MemoryMode }
const MUTABLE = new Set(["title", "pinned", "memoryMode"]);

const MAX_TITLE = 200;
const MAX_LIMIT = 200;
const DEFAULT_LIMIT = 50;

type Row = Record<string, unknown>;

/** Turns free text into an FTS5 query that cannot be an FTS syntax error or operator injection: every
 *  whitespace-separated token becomes a quoted string, all of them required. */
export function ftsQuery(text: string): string {
  const tokens = text.split(/\s+/).map((t) => t.replace(/"/g, '""')).filter((t) => t.length > 0);
  if (tokens.length === 0) throw new SessionError("invalid", "search text is empty", "search-empty");
  return tokens.map((t) => `"${t}"`).join(" ");
}

const toSession = (r: Row): SessionRecord => ({
  id: r.id as string, kind: r.kind as SessionKind, agentId: r.agent_id as string, owner: r.owner as string, scope: r.scope as string,
  chatKey: (r.chat_key as string | null) ?? null, title: r.title as string, pinned: r.pinned === 1, memoryMode: r.memory_mode as MemoryMode,
  createdAt: r.created_at as number, updatedAt: r.updated_at as number, lastTurnAt: (r.last_turn_at as number | null) ?? null,
  archivedAt: (r.archived_at as number | null) ?? null, turnCount: r.turn_count as number,
});
const toTurn = (r: Row): TurnRecord => ({
  id: r.id as string, sessionId: r.session_id as string, seq: r.seq as number, state: r.state as TurnRecord["state"], startedAt: r.started_at as number,
  endedAt: (r.ended_at as number | null) ?? null, error: (r.error as string | null) ?? null, incognito: r.incognito === 1,
});
const toMessage = (r: Row): MessageRecord => ({
  id: r.id as string, sessionId: r.session_id as string, turnId: (r.turn_id as string | null) ?? null, seq: r.seq as number, role: r.role as MessageRole,
  text: r.text as string, tokens: r.tokens as number, createdAt: r.created_at as number,
});
const toEvent = (r: Row): EventRecord => ({
  sessionId: r.session_id as string, turnId: (r.turn_id as string | null) ?? null, seq: r.seq as number, type: r.type as EventType,
  data: JSON.parse(r.data as string) as Record<string, unknown>, at: r.at as number,
});
const toSummary = (r: Row): SummaryRecord => ({
  id: r.id as string, sessionId: r.session_id as string, fromSeq: r.from_seq as number, toSeq: r.to_seq as number, text: r.text as string,
  tokens: r.tokens as number, tier: r.tier as number, state: r.state as SummaryRecord["state"], createdAt: r.created_at as number,
});

export class SessionStore {
  readonly #archiveListeners = new Set<(id: string) => void>();
  /** Observe committed archive/replacement; resource observers cannot roll back or fail a stored session change. */
  onArchived(listener: (id: string) => void): () => void { this.#archiveListeners.add(listener); return () => { this.#archiveListeners.delete(listener); }; }
  #archived(id: string): void { for (const listener of this.#archiveListeners) { try { listener(id); } catch { /* Post-commit observer only; resource owners report their own errors. */ } } }
  readonly #db: DatabaseSync;
  readonly #clock: () => number;
  readonly #newId: (prefix: string) => string;

  constructor(o: StoreOptions) {
    this.#clock = o.clock ?? Date.now;
    this.#newId = o.newId ?? ((p) => `${p}_${randomUUID()}`);
    this.#db = new DatabaseSync(o.path);
    try {
      this.#db.exec("PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;");
      if (o.path !== ":memory:") this.#db.exec("PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL;");
      migrate(this.#db);
    } catch (e) { this.#db.close(); throw e; }
    if (o.path !== ":memory:" && process.platform !== "win32") { try { chmodSync(o.path, 0o600); } catch { /* best effort; the home dir is 0700 */ } }
  }

  close(): void { this.#db.close(); }

  /** Incognito turns keep no separate persisted prompt snapshot. A remembered session freezes exactly once. */
  freezePromptSnapshot(sessionId: string, memory: string): string {
    const session = this.getSession(sessionId);
    if (!session) throw new SessionError("not-found", "session not found");
    if (session.memoryMode === "incognito") return memory;
    this.#db.prepare("INSERT OR IGNORE INTO prompt_snapshots(session_id,memory) VALUES (?,?)").run(sessionId, memory);
    return (this.#db.prepare("SELECT memory FROM prompt_snapshots WHERE session_id=?").get(sessionId) as { memory: string }).memory;
  }

  #tx<T>(fn: () => T): T {
    this.#db.exec("BEGIN IMMEDIATE");
    try { const r = fn(); this.#db.exec("COMMIT"); return r; }
    catch (e) { try { this.#db.exec("ROLLBACK"); } catch { /* already rolled back */ } throw mapSqlite(e); }
  }
  #get(sql: string, ...args: (string | number | null)[]): Row | undefined { return this.#db.prepare(sql).get(...args) as Row | undefined; }
  #all(sql: string, ...args: (string | number | null)[]): Row[] { return this.#db.prepare(sql).all(...args) as Row[]; }
  #run(sql: string, ...args: (string | number | null)[]): void { this.#db.prepare(sql).run(...args); }

  // ---- sessions -----------------------------------------------------------------------------------------------

  createSession(i: CreateSessionInput): SessionRecord {
    if (!SESSION_KINDS.includes(i.kind)) throw new SessionError("invalid", `unknown session kind ${String(i.kind)}`, "kind");
    if (!i.agentId) throw new SessionError("invalid", "agentId is required", "agent");
    if (!i.owner) throw new SessionError("invalid", "owner is required", "owner");
    if (i.kind === "channel" && !i.chatKey) throw new SessionError("invalid", "a channel session needs a chatKey", "chat-key");
    if (i.kind !== "channel" && i.chatKey !== undefined) throw new SessionError("invalid", "only a channel session has a chatKey", "chat-key");
    const title = (i.title ?? "").slice(0, MAX_TITLE);
    const now = this.#clock(); const id = this.#newId("ses");
    let archivedId: string | undefined;
    const result = this.#tx(() => {
      if (i.chatKey !== undefined) {
        const active = this.#get("SELECT id FROM sessions WHERE chat_key = ? AND archived_at IS NULL", i.chatKey);
        if (active) {
          if (!i.replaceActive) throw new SessionError("conflict", `chat ${i.chatKey} already has an active session`, "active-chat-session");
          archivedId = active.id as string;
          this.#run("UPDATE sessions SET archived_at = ?, updated_at = ? WHERE id = ?", now, now, active.id as string);
        }
      }
      this.#run(
        "INSERT INTO sessions (id, kind, agent_id, owner, scope, chat_key, title, memory_mode, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)",
        id, i.kind, i.agentId, i.owner, i.scope ?? "user", i.chatKey ?? null, title, i.memoryMode ?? "remember", now, now,
      );
      return toSession(this.#get("SELECT * FROM sessions WHERE id = ?", id)!);
    });
    if (archivedId) this.#archived(archivedId);
    return result;
  }

  getSession(id: string): SessionRecord | null {
    const r = this.#get("SELECT * FROM sessions WHERE id = ?", id);
    return r ? toSession(r) : null;
  }

  /** D21: the one active session of a chat, or null. For the channel host, which knows the chat but not the owner. */
  activeForChat(chatKey: string): SessionRecord | null {
    const r = this.#get("SELECT * FROM sessions WHERE chat_key = ? AND archived_at IS NULL", chatKey);
    return r ? toSession(r) : null;
  }

  /** The store never decides who may see a session; callers use this to get "not found" for someone else's. */
  getOwned(id: string, owner: string): SessionRecord {
    const s = this.getSession(id);
    if (!s || s.owner !== owner) throw new SessionError("not-found", `session ${id} not found`, "session");
    return s;
  }

  listSessions(f: ListFilter): { sessions: SessionRecord[]; truncated: boolean } {
    const limit = Math.min(Math.max(f.limit ?? DEFAULT_LIMIT, 1), MAX_LIMIT);
    const where = ["s.owner = ?"]; const args: (string | number | null)[] = [f.owner];
    if (f.kind) { where.push("s.kind = ?"); args.push(f.kind); }
    if (f.agentId) { where.push("s.agent_id = ?"); args.push(f.agentId); }
    const archived = f.archived ?? "exclude";
    if (archived === "exclude") where.push("s.archived_at IS NULL"); else if (archived === "only") where.push("s.archived_at IS NOT NULL");
    if (f.search !== undefined) {
      const q = ftsQuery(f.search);
      where.push(`(s.rowid IN (SELECT rowid FROM sessions_fts WHERE sessions_fts MATCH ?)
        OR s.id IN (SELECT m.session_id FROM messages m WHERE m.rowid IN (SELECT rowid FROM messages_fts WHERE messages_fts MATCH ?)))`);
      args.push(q, q);
    }
    const rows = this.#all(
      `SELECT s.* FROM sessions s WHERE ${where.join(" AND ")} ORDER BY s.pinned DESC, COALESCE(s.last_turn_at, s.created_at) DESC, s.created_at DESC, s.id LIMIT ?`,
      ...args, limit + 1,
    );
    return { sessions: rows.slice(0, limit).map(toSession), truncated: rows.length > limit };
  }

  /** F42 metadata listing; omitting owner is allowed only by the admin RPC's role gate.
   * Own-session listing/search keeps the original query semantics. No message or event payload leaves this method. */
  listOverview(f: Omit<ListFilter, "owner"> & { owner?: string; owners?: string[] }): { sessions: (SessionRecord & { model: string | null; usage: { inputTokens: number; outputTokens: number; costMicros: number | null } })[]; truncated: boolean } {
    const limit = Math.min(Math.max(f.limit ?? DEFAULT_LIMIT, 1), MAX_LIMIT);
    const where = ["1=1"], args: (string | number | null)[] = [];
    if (f.owner) { where.push("s.owner=?"); args.push(f.owner); }
    else if (f.owners) { if (!f.owners.length) return { sessions: [], truncated: false }; where.push(`s.owner IN (${f.owners.map(() => "?").join(",")})`); args.push(...f.owners); }
    if (f.kind) { where.push("s.kind=?"); args.push(f.kind); }
    if (f.agentId) { where.push("s.agent_id=?"); args.push(f.agentId); }
    const archived = f.archived ?? "exclude";
    if (archived === "exclude") where.push("s.archived_at IS NULL"); else if (archived === "only") where.push("s.archived_at IS NOT NULL");
    if (f.search !== undefined) {
      const q = ftsQuery(f.search);
      where.push("(s.rowid IN (SELECT rowid FROM sessions_fts WHERE sessions_fts MATCH ?) OR s.id IN (SELECT m.session_id FROM messages m WHERE m.rowid IN (SELECT rowid FROM messages_fts WHERE messages_fts MATCH ?)))"); args.push(q,q);
    }
    const rows = this.#all(`SELECT s.* FROM sessions s WHERE ${where.join(" AND ")} ORDER BY s.pinned DESC,COALESCE(s.last_turn_at,s.created_at) DESC,s.created_at DESC,s.id LIMIT ?`, ...args, limit+1);
    return { truncated: rows.length > limit, sessions: rows.slice(0,limit).map(row => {
      const s = toSession(row);
      // Existing turn.completed records contain provider/usage. Costs not recorded per session stay null, never a false zero.
      const events = this.#all("SELECT data FROM events WHERE session_id=? AND type='turn.completed' ORDER BY seq", s.id);
      let model: string | null = null, inputTokens=0, outputTokens=0, costMicros: number | null = events.length ? 0 : null;
      for (const e of events) {
        const d = JSON.parse(e.data as string);
        if (typeof d.model === "string") model=d.model; else if (typeof d.provider === "string") model=d.provider;
        const count = (v: unknown) => typeof v === "number" && Number.isSafeInteger(v) && v>=0 ? v : 0;
        inputTokens += count(d.usage?.inputTokens); outputTokens += count(d.usage?.outputTokens);
        if (typeof d.usage?.costMicros !== "number" || !Number.isSafeInteger(d.usage.costMicros) || d.usage.costMicros<0) costMicros=null;
        else if (costMicros!==null) costMicros+=d.usage.costMicros;
      }
      return { ...s, model, usage: { inputTokens, outputTokens, costMicros } };
    }) };
  }

  /** Message hits (with a snippet) over one owner's sessions, best first. Owner scoping is part of the query, not a post-filter. */
  searchMessages(f: Omit<ListFilter, "search"> & { search: string }): SearchHit[] {
    const limit = Math.min(Math.max(f.limit ?? DEFAULT_LIMIT, 1), MAX_LIMIT);
    const where = ["s.owner = ?"]; const args: (string | number | null)[] = [f.owner];
    if (f.kind) { where.push("s.kind = ?"); args.push(f.kind); }
    if (f.agentId) { where.push("s.agent_id = ?"); args.push(f.agentId); }
    const archived = f.archived ?? "exclude";
    if (archived === "exclude") where.push("s.archived_at IS NULL"); else if (archived === "only") where.push("s.archived_at IS NOT NULL");
    const rows = this.#all(
      `SELECT m.session_id, m.id, m.seq, snippet(messages_fts, 0, '[', ']', '…', 12) AS snip, bm25(messages_fts) AS rank
       FROM messages_fts JOIN messages m ON m.rowid = messages_fts.rowid JOIN sessions s ON s.id = m.session_id
       WHERE messages_fts MATCH ? AND ${where.join(" AND ")} ORDER BY rank LIMIT ?`,
      ftsQuery(f.search), ...args, limit,
    );
    return rows.map((r) => ({ sessionId: r.session_id as string, messageId: r.id as string, seq: r.seq as number, snippet: r.snip as string, rank: r.rank as number }));
  }

  /** I1: only title, pinned and memoryMode can change; an attempt on anything else is an error, not a silent drop. */
  updateSession(id: string, patch: SessionPatch): SessionRecord {
    for (const k of Object.keys(patch)) {
      if (!MUTABLE.has(k)) throw new SessionError("immutable", `session field ${k} is immutable (I1)`, "immutable-field");
    }
    return this.#tx(() => {
      const s = this.getSession(id);
      if (!s) throw new SessionError("not-found", `session ${id} not found`, "session");
      if (s.archivedAt !== null) throw new SessionError("conflict", `session ${id} is archived`, "archived");
      const next = { title: (patch.title ?? s.title).slice(0, MAX_TITLE), pinned: patch.pinned ?? s.pinned, memoryMode: patch.memoryMode ?? s.memoryMode };
      this.#run("UPDATE sessions SET title = ?, pinned = ?, memory_mode = ?, updated_at = ? WHERE id = ?", next.title, next.pinned ? 1 : 0, next.memoryMode, this.#clock(), id);
      return toSession(this.#get("SELECT * FROM sessions WHERE id = ?", id)!);
    });
  }

  /** Archive-first deletion: archiving is the only delete a normal path has. Idempotent. A running turn blocks it. */
  archiveSession(id: string): SessionRecord {
    let changed = false;
    const result = this.#tx(() => {
      const s = this.getSession(id);
      if (!s) throw new SessionError("not-found", `session ${id} not found`, "session");
      if (s.archivedAt !== null) return s;
      if (this.runningTurn(id)) throw new SessionError("conflict", `session ${id} has a running turn`, "turn-in-progress");
      changed = true;
      const now = this.#clock();
      this.#run("UPDATE sessions SET archived_at = ?, updated_at = ? WHERE id = ?", now, now, id);
      return toSession(this.#get("SELECT * FROM sessions WHERE id = ?", id)!);
    });
    if (changed) this.#archived(id);
    return result;
  }

  /** The explicit erasure path (stub, no RPC): refuses a session that is not archived, removes everything of it and
   *  leaves one audit tombstone (ids and counts, never content). */
  eraseSession(id: string, o: { actor: string; reason: string }): { tombstoneId: string; messages: number } {
    if (!o.actor || !o.reason) throw new SessionError("invalid", "an erasure needs an actor and a reason", "erasure-audit");
    return this.#tx(() => {
      const s = this.getSession(id);
      if (!s) throw new SessionError("not-found", `session ${id} not found`, "session");
      if (s.archivedAt === null) throw new SessionError("conflict", "erasure requires the session to be archived first (archive-first)", "not-archived");
      const messages = (this.#get("SELECT COUNT(*) AS n FROM messages WHERE session_id = ?", id)!.n as number);
      const tombstoneId = this.#newId("era");
      this.#run("INSERT INTO erasures (id, session_id, agent_id, owner, kind, message_count, erased_at, actor, reason) VALUES (?,?,?,?,?,?,?,?,?)",
        tombstoneId, id, s.agentId, s.owner, s.kind, messages, this.#clock(), o.actor, o.reason);
      for (const t of ["summaries", "events", "messages", "turns"]) this.#run(`DELETE FROM ${t} WHERE session_id = ?`, id);
      this.#run("DELETE FROM sessions WHERE id = ?", id);
      return { tombstoneId, messages };
    });
  }

  erasures(): { id: string; sessionId: string; owner: string; messageCount: number; actor: string; reason: string }[] {
    return this.#all("SELECT * FROM erasures ORDER BY erased_at, id").map((r) => ({
      id: r.id as string, sessionId: r.session_id as string, owner: r.owner as string, messageCount: r.message_count as number, actor: r.actor as string, reason: r.reason as string,
    }));
  }

  // ---- turns, messages, events ----------------------------------------------------------------------------------

  /** Atomically records the user's message, the running turn and `turn.started`. One running turn per session. */
  beginTurn(sessionId: string, text: string, tokens: number): { turn: TurnRecord; message: MessageRecord; event: EventRecord } {
    return this.#tx(() => {
      const s = this.getSession(sessionId);
      if (!s) throw new SessionError("not-found", `session ${sessionId} not found`, "session");
      if (s.archivedAt !== null) throw new SessionError("conflict", `session ${sessionId} is archived`, "archived");
      if (this.runningTurn(sessionId)) throw new SessionError("conflict", `session ${sessionId} already has a running turn`, "turn-in-progress");
      const now = this.#clock(); const turnId = this.#newId("trn"); const seq = s.turnCount + 1;
      this.#run("INSERT INTO turns (id, session_id, seq, state, started_at, incognito) VALUES (?,?,?,?,?,?)", turnId, sessionId, seq, "running", now, s.memoryMode === "incognito" ? 1 : 0);
      this.#run("UPDATE sessions SET turn_count = ?, last_turn_at = ?, updated_at = ? WHERE id = ?", seq, now, now, sessionId);
      const message = this.#insertMessage(sessionId, turnId, "user", text, tokens);
      const event = this.#insertEvent(sessionId, turnId, "turn.started", { turnId, turnSeq: seq, messageId: message.id });
      return { turn: toTurn(this.#get("SELECT * FROM turns WHERE id = ?", turnId)!), message, event };
    });
  }

  completeTurn(turnId: string, o: { text: string; tokens: number; data?: Record<string, unknown> }): { message: MessageRecord; event: EventRecord } | null {
    return this.#tx(() => {
      const t = this.#get("SELECT * FROM turns WHERE id = ?", turnId);
      if (!t || t.state !== "running") return null;
      const sessionId = t.session_id as string; const now = this.#clock();
      const message = this.#insertMessage(sessionId, turnId, "assistant", o.text, o.tokens);
      this.#run("UPDATE turns SET state = 'completed', ended_at = ? WHERE id = ?", now, turnId);
      this.#run("UPDATE sessions SET updated_at = ? WHERE id = ?", now, sessionId);
      const event = this.#insertEvent(sessionId, turnId, "turn.completed", { turnId, messageId: message.id, ...(o.data ?? {}) });
      return { message, event };
    });
  }

  /** Marks a running turn failed and emits `turn.failed`; null when the turn was not running (idempotent). */
  failTurn(turnId: string, error: string, data?: Record<string, unknown>): EventRecord | null {
    return this.#tx(() => {
      const t = this.#get("SELECT * FROM turns WHERE id = ?", turnId);
      if (!t || t.state !== "running") return null;
      const now = this.#clock();
      this.#run("UPDATE turns SET state = 'failed', ended_at = ?, error = ? WHERE id = ?", now, error, turnId);
      this.#run("UPDATE sessions SET updated_at = ? WHERE id = ?", now, t.session_id as string);
      return this.#insertEvent(t.session_id as string, turnId, "turn.failed", { turnId, error, ...(data ?? {}) });
    });
  }

  /** Crash recovery (acceptance 7): every turn still `running` when the core starts was cut off; mark it failed. */
  recoverRunningTurns(): EventRecord[] {
    const ids = this.#all("SELECT id FROM turns WHERE state = 'running' ORDER BY started_at, id").map((r) => r.id as string);
    const out: EventRecord[] = [];
    for (const id of ids) { const e = this.failTurn(id, "core-restarted", { recovered: true }); if (e) out.push(e); }
    return out;
  }

  /** The newest event seq of a session (0 when it has none), null for an unknown session. */
  lastEventSeq(sessionId: string): number | null {
    const r = this.#get("SELECT last_event_seq FROM sessions WHERE id = ?", sessionId);
    return r ? (r.last_event_seq as number) : null;
  }

  runningTurn(sessionId: string): TurnRecord | null {
    const r = this.#get("SELECT * FROM turns WHERE session_id = ? AND state = 'running'", sessionId);
    return r ? toTurn(r) : null;
  }
  getTurn(id: string): TurnRecord | null { const r = this.#get("SELECT * FROM turns WHERE id = ?", id); return r ? toTurn(r) : null; }
  listTurns(sessionId: string): TurnRecord[] { return this.#all("SELECT * FROM turns WHERE session_id = ? ORDER BY seq", sessionId).map(toTurn); }

  #insertMessage(sessionId: string, turnId: string | null, role: MessageRole, text: string, tokens: number): MessageRecord {
    const seq = (this.#get("SELECT last_message_seq FROM sessions WHERE id = ?", sessionId)!.last_message_seq as number) + 1;
    const id = this.#newId("msg"); const now = this.#clock();
    this.#run("UPDATE sessions SET last_message_seq = ? WHERE id = ?", seq, sessionId);
    this.#run("INSERT INTO messages (id, session_id, turn_id, seq, role, text, tokens, created_at) VALUES (?,?,?,?,?,?,?,?)", id, sessionId, turnId, seq, role, text, tokens, now);
    return { id, sessionId, turnId, seq, role, text, tokens, createdAt: now };
  }

  #insertEvent(sessionId: string, turnId: string | null, type: EventType, data: Record<string, unknown>): EventRecord {
    const seq = (this.#get("SELECT last_event_seq FROM sessions WHERE id = ?", sessionId)!.last_event_seq as number) + 1;
    const at = this.#clock();
    this.#run("UPDATE sessions SET last_event_seq = ? WHERE id = ?", seq, sessionId);
    this.#run("INSERT INTO events (session_id, seq, turn_id, type, data, at) VALUES (?,?,?,?,?,?)", sessionId, seq, turnId, type, JSON.stringify(data), at);
    return { sessionId, turnId, seq, type, data, at };
  }

  /** Appends one in-turn event (a delta, a tool placeholder). The turn must be running. */
  appendEvent(turnId: string, type: EventType, data: Record<string, unknown>): EventRecord {
    return this.#tx(() => {
      const t = this.#get("SELECT session_id, state FROM turns WHERE id = ?", turnId);
      if (!t) throw new SessionError("not-found", `turn ${turnId} not found`, "turn");
      if (t.state !== "running") throw new SessionError("conflict", `turn ${turnId} is not running`, "turn-not-running");
      return this.#insertEvent(t.session_id as string, turnId, type, data);
    });
  }

  listEvents(sessionId: string, afterSeq = 0, limit = 500): EventRecord[] {
    return this.#all("SELECT * FROM events WHERE session_id = ? AND seq > ? ORDER BY seq LIMIT ?", sessionId, afterSeq, Math.min(Math.max(limit, 1), 2000)).map(toEvent);
  }

  listMessages(sessionId: string, o: { afterSeq?: number; limit?: number } = {}): MessageRecord[] {
    return this.#all("SELECT * FROM messages WHERE session_id = ? AND seq > ? ORDER BY seq LIMIT ?", sessionId, o.afterSeq ?? 0, Math.min(Math.max(o.limit ?? 10_000, 1), 100_000)).map(toMessage);
  }

  // ---- summaries (compaction) --------------------------------------------------------------------------------------

  addSummary(s: Omit<SummaryRecord, "id" | "createdAt">): SummaryRecord {
    const id = this.#newId("sum"); const createdAt = this.#clock();
    this.#run("INSERT INTO summaries (id, session_id, from_seq, to_seq, text, tokens, tier, state, created_at) VALUES (?,?,?,?,?,?,?,?,?)",
      id, s.sessionId, s.fromSeq, s.toSeq, s.text, s.tokens, s.tier, s.state, createdAt);
    return { ...s, id, createdAt };
  }
  listSummaries(sessionId: string, state?: SummaryRecord["state"]): SummaryRecord[] {
    const rows = state ? this.#all("SELECT * FROM summaries WHERE session_id = ? AND state = ? ORDER BY from_seq, tier", sessionId, state)
      : this.#all("SELECT * FROM summaries WHERE session_id = ? ORDER BY from_seq, tier", sessionId);
    return rows.map(toSummary);
  }
  setSummaryState(id: string, state: SummaryRecord["state"]): void { this.#run("UPDATE summaries SET state = ? WHERE id = ?", state, id); }
  /** Swaps a set of summaries for one that replaces them (tiered re-summarisation), atomically. */
  replaceSummaries(supersede: string[], next: Omit<SummaryRecord, "id" | "createdAt">): SummaryRecord {
    return this.#tx(() => { for (const id of supersede) this.setSummaryState(id, "superseded"); return this.addSummary(next); });
  }
}

function mapSqlite(e: unknown): unknown {
  if (e instanceof SessionError) return e;
  const msg = e instanceof Error ? e.message : String(e);
  if (/I1:/.test(msg)) return new SessionError("immutable", msg, "immutable-field");
  if (/UNIQUE constraint failed: sessions\.chat_key|idx_sessions_active_chat/.test(msg)) return new SessionError("conflict", "chat already has an active session", "active-chat-session");
  if (/idx_turns_one_running|turns\.session_id/.test(msg)) return new SessionError("conflict", "session already has a running turn", "turn-in-progress");
  return new SessionError("storage", msg, "sqlite");
}
