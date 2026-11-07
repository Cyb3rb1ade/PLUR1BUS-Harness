// The session store (M1b-2c, A7): node:sqlite + FTS5. Synchronous by design (one resident core, one writer), so a
// "transaction" here is a plain BEGIN IMMEDIATE .. COMMIT with no await inside.
import type { ChannelOrigin } from "../channels/behaviour-context.ts";
import { randomUUID } from "node:crypto";
import { chmodSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { migrate } from "./migrations.ts";
import { activePath, hiddenDigest, type RewindRange } from "./rewind-path.ts";
import { failedEditCycles } from "./rewind-cycles.ts";
import {
  SESSION_KINDS, SESSION_ORIGINS, SessionError,
  type EventRecord, type EventType, type MemoryMode, type MessageRecord, type MessageRole, type SearchHit, type SessionKind, type SessionOrigin, type SessionRecord,
  type SummaryRecord, type TurnRecord, type RewindRecord,
} from "./types.ts";

export interface StoreOptions { path: string; clock?: () => number; newId?: (prefix: string) => string }

/** Audit runs before the overlay commits; failure rolls back every store change. No transcript text crosses it. */
export type RewindAudit = (event: { action: "session.rewind" | "session.rewind.undone"; detail: Record<string, unknown> }) => void;

/** Trusted internal input. The RPC and transcript-command boundaries separately require a person. */
export interface RewindInput {
  toSeq: number | "last";
  lesson: string;
  actor: string;
  trigger: RewindRecord["trigger"];
  expectedEventSeq?: number;
  audit?: RewindAudit;
  /** Only the admitted transcript command itself may be running; never accepted from RPC params. */
  commandTurnId?: string;
  reservation?: symbol;
}

/** Harness-owned checkpoint identity. A mutable Git ref alone is never proof of its original contents. */
export interface StoredCheckpoint {
  sessionId: string; turnId: string; projectId: string; cardId: string; root: string; commonGitDir: string;
  ref: string; tree: string; commitId: string;
}

function toCheckpoint(row: Record<string, unknown>): StoredCheckpoint {
  return { sessionId: String(row.session_id), turnId: String(row.turn_id), projectId: String(row.project_id),
    cardId: String(row.card_id), root: String(row.root), commonGitDir: String(row.common_git_dir),
    ref: String(row.ref), tree: String(row.tree), commitId: String(row.commit_id) };
}

export interface CreateSessionInput {
  kind: SessionKind; agentId: string; owner: string;
  /** I1; default `user` (RULING: a placeholder until RBAC scopes land with M3). */
  scope?: string;
  title?: string; memoryMode?: MemoryMode;
  /** Required for, and only allowed on, `channel` sessions (D21). */
  chatKey?: string;
  /** D21 `/new`: archive the chat's active session and open the next in one transaction. */
  replaceActive?: boolean;
  /** I1: immutable external protocol origin; omitted or undefined for internal sessions. */
  origin?: SessionOrigin;
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
const MAX_RESTORED_SKILLS = 4096;
const MAX_RESTORED_SKILL_OUTPUT_BYTES = 512 * 1024;
const MAX_RESTORED_SKILL_TEXT_BYTES = 64 * 1024;
const MAX_SESSION_TOOL_OFFERS = 128;
// The ToolRegistry's canonical spelling, including D106's one camel-case host-tool exception.
const CANONICAL_TOOL_NAME = /^(?:[a-z][a-z0-9_.-]{0,63}|sys\.startupItems)$/;

// A partially discarded turn cannot contribute tool/skill state: its assistant-side tools belong to that attempt too.
const ACTIVE_TURN_SQL = `NOT EXISTS (
  SELECT 1 FROM messages tm JOIN path_rewinds r ON r.session_id=tm.session_id
  WHERE tm.turn_id=t.id AND tm.session_id=t.session_id AND
    ((r.undone_at IS NULL AND tm.seq BETWEEN r.hidden_from_seq AND r.hidden_to_seq)
      OR (r.undone_at IS NOT NULL AND tm.id=r.lesson_message_id)))`;

// Deduplication happens before the distinct-skill bound: repeated loads cannot evict another skill's older pair.
const SKILL_EVENTS_SQL = `
  WITH calls AS (
    SELECT e.*,json_extract(e.data,'$.id') AS call_id,json_extract(e.data,'$.args.name') AS skill_name
    FROM events e JOIN turns t ON t.id=e.turn_id AND t.session_id=e.session_id
    WHERE e.session_id=? AND t.state='completed' AND e.type='tool.call' AND ${ACTIVE_TURN_SQL}
      AND json_extract(e.data,'$.name')='skill.load' AND json_type(e.data,'$.id')='text'
      AND json_type(e.data,'$.args.name')='text'
  ), result_events AS MATERIALIZED (
    SELECT e.*,json_extract(e.data,'$.id') AS result_id
    FROM events e JOIN turns t ON t.id=e.turn_id AND t.session_id=e.session_id
    WHERE e.session_id=? AND t.state='completed' AND e.type='tool.result' AND ${ACTIVE_TURN_SQL}
      AND json_extract(e.data,'$.isError') IS NOT 1
  ), outputs AS (
    SELECT e.*,c.seq AS call_seq,c.data AS call_data,c.skill_name,
      CASE WHEN json_type(e.data,'$.output')='text'
        AND length(CAST(json_extract(e.data,'$.output') AS BLOB))<=?
        AND json_valid(json_extract(e.data,'$.output')) THEN json_extract(e.data,'$.output') ELSE '{}' END AS result
    FROM result_events e JOIN calls c ON c.turn_id=e.turn_id AND c.session_id=e.session_id AND e.seq>c.seq
      AND e.result_id=c.call_id
  ), ranked AS (
    SELECT *,row_number() OVER(PARTITION BY skill_name ORDER BY seq DESC,call_seq DESC) AS rank
    FROM outputs WHERE json_type(result,'$.isError')='false'
      AND (json_type(result,'$.truncated') IS NULL OR json_type(result,'$.truncated')='false')
      AND (json_type(result,'$.tool') IS NULL OR json_extract(result,'$.tool')='skill.load')
      AND json_type(result,'$.value.text')='text' AND json_extract(result,'$.value.name')=skill_name
      AND length(CAST(json_extract(result,'$.value.text') AS BLOB))<=?
      AND json_type(result,'$.value.files')='array' AND json_array_length(result,'$.value.files')<=1024
      AND NOT EXISTS (SELECT 1 FROM json_each(result,'$.value.files')
        WHERE type!='text' OR length(CAST(value AS BLOB))>16384)
  ), latest AS (SELECT * FROM ranked WHERE rank=1 ORDER BY seq DESC LIMIT ?), selected AS (
    SELECT e.* FROM events e JOIN turns t ON t.id=e.turn_id AND t.session_id=e.session_id
    WHERE e.session_id=? AND t.state='completed' AND e.type='skills.selected' AND ${ACTIVE_TURN_SQL}
    ORDER BY e.seq DESC LIMIT 1
  )
  SELECT session_id,turn_id,call_seq AS seq,'tool.call' AS type,call_data AS data,at FROM latest
  UNION ALL SELECT session_id,turn_id,seq,'tool.result',data,at FROM latest
  UNION ALL SELECT session_id,turn_id,seq,type,data,at FROM selected ORDER BY seq`;

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
  ...(typeof r.origin === "string" ? { origin: r.origin as SessionOrigin } : {}),
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
const toRewind = (r: Row): RewindRecord => ({
  id: String(r.id), sessionId: String(r.session_id), parentSeq: Number(r.parent_seq),
  hiddenFromSeq: Number(r.hidden_from_seq), hiddenToSeq: Number(r.hidden_to_seq),
  lessonMessageId: r.lesson_message_id as string | null, hiddenDigest: String(r.hidden_digest),
  trigger: r.trigger as RewindRecord["trigger"], actor: String(r.actor), createdAt: Number(r.created_at),
  undoneAt: r.undone_at === null ? null : Number(r.undone_at),
});

export class SessionStore {
  readonly #rewindReservations = new Map<string, symbol>();
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

  /** Remembered sessions retain the first authored catalogue across restarts; incognito uses its current bytes. */
  freezeSkillCatalogue(sessionId: string, catalogue: string): string {
    const session = this.getSession(sessionId);
    if (!session) throw new SessionError("not-found", "session not found");
    if (session.memoryMode === "incognito") return catalogue;
    this.#db.prepare("INSERT OR IGNORE INTO skill_catalogue_snapshots(session_id,catalogue) VALUES (?,?)")
      .run(sessionId, catalogue);
    return (this.#db.prepare("SELECT catalogue FROM skill_catalogue_snapshots WHERE session_id=?")
      .get(sessionId) as { catalogue: string }).catalogue;
  }

  /** Completed skill state only, with latest successful pairs deduplicated before the 4096 distinct-skill bound. */
  skillEvents(sessionId: string): EventRecord[] {
    return this.#all(SKILL_EVENTS_SQL, sessionId, sessionId, MAX_RESTORED_SKILL_OUTPUT_BYTES, MAX_RESTORED_SKILL_TEXT_BYTES,
      MAX_RESTORED_SKILLS, sessionId).map(toEvent);
  }

  /** Admission order is stable; only names are retained. Incognito services keep this table in their RAM store. */
  toolOffers(sessionId: string): string[] {
    if (!this.getSession(sessionId)) throw new SessionError("not-found", "session not found");
    return this.#all("SELECT name FROM session_tool_offers WHERE session_id=? ORDER BY ordinal", sessionId)
      .map(row => row.name as string);
  }

  /** Record a pending union for the next turn boundary, retaining the earliest 128 distinct canonical names. */
  rememberToolOffers(sessionId: string, names: readonly string[]): void {
    if (!this.getSession(sessionId)) throw new SessionError("not-found", "session not found");
    if (!Array.isArray(names) || names.some(name => typeof name !== "string" || !CANONICAL_TOOL_NAME.test(name))) {
      throw new SessionError("invalid", "tool offers require canonical registered tool names", "tool-name");
    }
    this.#tx(() => {
      const previous = this.toolOffers(sessionId);
      const known = new Set(previous);
      let ordinal = previous.length;
      const insert = this.#db.prepare("INSERT INTO session_tool_offers(session_id,name,ordinal) VALUES (?,?,?)");
      for (const name of names) {
        if (known.has(name)) continue;
        if (ordinal >= MAX_SESSION_TOOL_OFFERS) break;
        insert.run(sessionId, name, ordinal++);
        known.add(name);
      }
    });
  }

  modelProfile(sessionId: string): { profile: string | null; revision: number } {
    const row = this.#db.prepare("SELECT profile,revision FROM session_model_profiles WHERE session_id=?").get(sessionId) as { profile: string; revision: number } | undefined;
    return row ? { profile: row.profile, revision: row.revision } : { profile: null, revision: 0 };
  }
  /** The chat's reasoning choice beside its profile; null = provider default (nothing sent). */
  modelReasoning(sessionId: string): string | null {
    const row = this.#db.prepare("SELECT reasoning FROM session_model_profiles WHERE session_id=?").get(sessionId) as { reasoning: string | null } | undefined;
    return row?.reasoning ?? null;
  }
  /** Atomic compare-and-swap; an in-flight turn or stale preview cannot change model routing. `reasoning` undefined keeps
   *  the stored choice, null clears it (provider default). */
  setModelProfile(sessionId: string, profile: string, expectedRevision: number, reasoning?: string | null, person?: string, modelDetails?: {model: string; displayName?: string; effectiveReasoning?: string}): number {
    return this.#tx(() => {
      const session = this.getSession(sessionId);
      if (!session || session.kind !== "direct" || session.archivedAt !== null || this.runningTurn(sessionId)) throw new SessionError("conflict", "model switch requires an idle direct session", "session-busy");
      const current = this.modelProfile(sessionId);
      if (current.revision !== expectedRevision) throw new SessionError("conflict", "model switch preview is stale", "stale-model-preview");
      const revision = current.revision + 1;
      const nextReasoning = reasoning === undefined ? this.modelReasoning(sessionId) : reasoning;
      this.#db.prepare("INSERT INTO session_model_profiles(session_id,profile,revision,reasoning) VALUES (?,?,?,?) ON CONFLICT(session_id) DO UPDATE SET profile=excluded.profile,revision=excluded.revision,reasoning=excluded.reasoning").run(sessionId, profile, revision, nextReasoning);
      const afterMessageSeq = (this.#get("SELECT last_message_seq FROM sessions WHERE id = ?", sessionId)!.last_message_seq as number);
      this.#insertEvent(sessionId, null, "session.model.changed", { profile, model: modelDetails?.model ?? profile, ...(modelDetails?.displayName ? {displayName:modelDetails.displayName}:{}), ...(modelDetails?.effectiveReasoning ? {effectiveReasoning:modelDetails.effectiveReasoning}:{}), reasoning: nextReasoning ?? "default", person: person ?? session.owner, revision, afterMessageSeq });
      return revision;
    });
  }

  /** Session-scoped changes, independent of turn delta volume; latest 2000 notes accompany history. */
  modelChanges(sessionId: string): EventRecord[] {
    return this.#all("SELECT * FROM (SELECT * FROM events WHERE session_id = ? AND type = 'session.model.changed' ORDER BY seq DESC LIMIT 2000) ORDER BY seq", sessionId).map(toEvent);
  }

  #transactionDepth = 0;
  #tx<T>(fn: () => T): T {
    if (this.#transactionDepth) return fn();
    this.#transactionDepth++;
    try { this.#db.exec("BEGIN IMMEDIATE"); const r = fn(); this.#db.exec("COMMIT"); return r; }
    catch (e) { try { this.#db.exec("ROLLBACK"); } catch { /* already rolled back */ } throw mapSqlite(e); }
    finally { this.#transactionDepth--; }
  }
  #get(sql: string, ...args: (string | number | null)[]): Row | undefined { return this.#db.prepare(sql).get(...args) as Row | undefined; }
  #all(sql: string, ...args: (string | number | null)[]): Row[] { return this.#db.prepare(sql).all(...args) as Row[]; }
  #run(sql: string, ...args: (string | number | null)[]): void { this.#db.prepare(sql).run(...args); }

  /** Immutable CLI-1 worktree metadata, read through the session's own SQLite writer. */
  worktree(sessionId: string): import("./types.ts").WorktreeBinding | null {
    const row = this.#get("SELECT * FROM session_worktrees WHERE session_id=?", sessionId);
    return row ? { sessionId, root: row.root as string, projectId: row.project_id as string | null,
      cardId: row.card_id as string | null, createdBy: row.created_by as string, createdAt: Number(row.created_at) } : null;
  }

  /** Bind once or confirm exactly the same binding; this never grants filesystem access. */
  bindWorktree(input: Omit<import("./types.ts").WorktreeBinding, "createdAt">): void {
    this.#tx(() => {
      const session = this.getSession(input.sessionId);
      if (!session) throw new SessionError("not-found", "session not found");
      if (session.archivedAt !== null || this.runningTurn(session.id)) {
        throw new SessionError("conflict", "worktree binding requires an idle active session");
      }
      const old = this.worktree(session.id);
      if (old) {
        if (old.root !== input.root || old.projectId !== input.projectId || old.cardId !== input.cardId
          || old.createdBy !== input.createdBy) {
          throw new SessionError("immutable", "worktree binding is immutable");
        }
        return;
      }
      this.#run("INSERT INTO session_worktrees(session_id,root,project_id,card_id,created_by,created_at) VALUES (?,?,?,?,?,?)",
        session.id, input.root, input.projectId, input.cardId, input.createdBy, this.#clock());
    });
  }

  // ---- sessions -----------------------------------------------------------------------------------------------

  createSession(i: CreateSessionInput): SessionRecord {
    if (!SESSION_KINDS.includes(i.kind)) throw new SessionError("invalid", `unknown session kind ${String(i.kind)}`, "kind");
    if (i.origin !== undefined && !SESSION_ORIGINS.includes(i.origin)) throw new SessionError("invalid", `unknown session origin ${String(i.origin)}`, "origin");
    if (!i.agentId) throw new SessionError("invalid", "agentId is required", "agent");
    if (!i.owner) throw new SessionError("invalid", "owner is required", "owner");
    if (i.kind === "channel" && !i.chatKey) throw new SessionError("invalid", "a channel session needs a chatKey", "chat-key");
    if (i.kind !== "channel" && i.chatKey !== undefined) throw new SessionError("invalid", "only a channel session has a chatKey", "chat-key");
    if (i.origin != null && !(SESSION_ORIGINS as readonly string[]).includes(i.origin)) throw new SessionError("invalid", "unknown session origin", "origin");
    const title = (i.title ?? "").slice(0, MAX_TITLE);
    const now = this.#clock(); const id = this.#newId("ses");
    let archivedId: string | undefined;
    const result = this.#tx(() => {
      if (i.chatKey !== undefined) {
        const active = this.#get("SELECT id, owner FROM sessions WHERE chat_key = ? AND archived_at IS NULL", i.chatKey);
        if (active) {
          // Replacing is archiving: only the session's own owner may do it (anyone else gets the plain "already active" answer, no oracle
          // beyond the one the non-replacing path already gives), and never under a running turn (archiveSession refuses that too).
          if (!i.replaceActive || active.owner !== i.owner) throw new SessionError("conflict", `chat ${i.chatKey} already has an active session`, "active-chat-session");
          if (this.runningTurn(active.id as string)) throw new SessionError("conflict", `session ${active.id as string} has a running turn`, "turn-in-progress");
          archivedId = active.id as string;
          this.#run("UPDATE sessions SET archived_at = ?, updated_at = ? WHERE id = ?", now, now, active.id as string);
        }
      }
      this.#run(
        "INSERT INTO sessions (id, kind, agent_id, owner, scope, chat_key, origin, title, memory_mode, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)",
        id, i.kind, i.agentId, i.owner, i.scope ?? "user", i.chatKey ?? null, i.origin ?? null, title, i.memoryMode ?? "remember", now, now,
      );
      return toSession(this.#get("SELECT * FROM sessions WHERE id = ?", id)!);
    });
    if (archivedId) this.#archived(archivedId);
    return result;
  }

  /** Host-only continuation: immutable new direct chat plus quoted user-context preamble in one transaction. */
  createContinuation(i: { agentId: string; owner: string; title: string; context: string }): SessionRecord {
    if (typeof i.context !== 'string' || i.context.length > 8000) throw new SessionError('invalid', 'invalid continuation', 'context');
    return this.#tx(() => {
      const session = this.createSession({ kind: 'direct', agentId: i.agentId, owner: i.owner, title: i.title });
      this.#insertMessage(session.id, null, 'user', i.context, Math.ceil(i.context.length / 4));
      return session;
    });
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

  /** LP: bounded metadata selection, with the time/owner/project predicates before LIMIT. No transcript text. */
  learningSessions(f: { owner: string; agentId?: string; projectId?: string; from: number; to: number; limit: number; offset?: number }): SessionRecord[] {
    const where = ["s.owner=?", "s.memory_mode='remember'", "EXISTS (SELECT 1 FROM turns t WHERE t.session_id=s.id AND t.state='completed' AND t.incognito=0 AND t.ended_at>=? AND t.ended_at<?)"];
    const args: (string | number)[] = [f.owner, f.from, f.to];
    if (f.agentId) { where.push('s.agent_id=?'); args.push(f.agentId); }
    if (f.projectId) { where.push('s.scope=?'); args.push(f.projectId); }
    return this.#all(`SELECT s.* FROM sessions s WHERE ${where.join(' AND ')} ORDER BY COALESCE(s.last_turn_at,s.updated_at) DESC,s.id LIMIT ? OFFSET ?`, ...args, Math.max(1, Math.min(51, f.limit)), f.offset ?? 0).map(toSession);
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

  /** Direct-chat keyset page. Both SQLite stores (persistent and RAM) use precisely this order.
   * Visibility is filtered before LIMIT so a hidden agent cannot truncate or starve a page. */
  listChatSessions(f: ListFilter & { allowedAgents: readonly string[]; after?: { pinned: boolean; updatedAt: number; id: string } }): { sessions: SessionRecord[]; truncated: boolean } {
    const limit = Math.min(Math.max(f.limit ?? DEFAULT_LIMIT, 1), MAX_LIMIT + 1);
    if (!f.allowedAgents.length) return { sessions: [], truncated: false };
    const where = ["s.owner=?", "s.kind='direct'", `s.agent_id IN (${f.allowedAgents.map(() => "?").join(",")})`];
    const args: (string | number | null)[] = [f.owner, ...f.allowedAgents];
    if (f.agentId) { where.push("s.agent_id=?"); args.push(f.agentId); }
    const archived = f.archived ?? "exclude";
    if (archived === "exclude") where.push("s.archived_at IS NULL"); else if (archived === "only") where.push("s.archived_at IS NOT NULL");
    if (f.search !== undefined) {
      const q = ftsQuery(f.search);
      where.push("(s.rowid IN (SELECT rowid FROM sessions_fts WHERE sessions_fts MATCH ?) OR s.id IN (SELECT m.session_id FROM messages m WHERE m.rowid IN (SELECT rowid FROM messages_fts WHERE messages_fts MATCH ?)))"); args.push(q, q);
    }
    if (f.after) {
      where.push("(s.pinned < ? OR (s.pinned = ? AND s.updated_at < ?) OR (s.pinned = ? AND s.updated_at = ? AND s.id > ?))");
      const pinned = Number(f.after.pinned); args.push(pinned, pinned, f.after.updatedAt, pinned, f.after.updatedAt, f.after.id);
    }
    const rows = this.#all(`SELECT s.* FROM sessions s WHERE ${where.join(" AND ")} ORDER BY s.pinned DESC, s.updated_at DESC, s.id ASC LIMIT ?`, ...args, limit + 1);
    return { sessions: rows.slice(0, limit).map(toSession), truncated: rows.length > limit };
  }

  /** F42 metadata listing; omitting owner is allowed only by the admin RPC's role gate.
   * Own-session listing/search keeps the original query semantics. No message or event payload leaves this method. */
  listOverview(f: Omit<ListFilter, "owner"> & { owner?: string; owners?: string[] }): { sessions: (SessionRecord & { model: string | null; usage: { inputTokens: number; outputTokens: number } })[]; truncated: boolean } {
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
      // Existing turn.completed records contain provider/usage (tokens; there is no money dimension).
      const events = this.#all("SELECT data FROM events WHERE session_id=? AND type='turn.completed' ORDER BY seq", s.id);
      let model: string | null = null, inputTokens=0, outputTokens=0;
      for (const e of events) {
        const d = JSON.parse(e.data as string);
        if (typeof d.model === "string") model=d.model; else if (typeof d.provider === "string") model=d.provider;
        const count = (v: unknown) => typeof v === "number" && Number.isSafeInteger(v) && v>=0 ? v : 0;
        inputTokens += count(d.usage?.inputTokens); outputTokens += count(d.usage?.outputTokens);
      }
      return { ...s, model, usage: { inputTokens, outputTokens } };
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
      `SELECT m.session_id, m.id, m.seq, snippet(messages_fts, 0, '[', ']', '…', 12) AS snip, bm25(messages_fts) AS rank,
       EXISTS(SELECT 1 FROM path_rewinds r WHERE r.session_id=m.session_id AND
         ((r.undone_at IS NULL AND m.seq BETWEEN r.hidden_from_seq AND r.hidden_to_seq)
           OR (r.undone_at IS NOT NULL AND m.id=r.lesson_message_id))) AS rewound
       FROM messages_fts JOIN messages m ON m.rowid = messages_fts.rowid JOIN sessions s ON s.id = m.session_id
       WHERE messages_fts MATCH ? AND ${where.join(" AND ")} ORDER BY rank LIMIT ?`,
      ftsQuery(f.search), ...args, limit,
    );
    return rows.map((r) => ({ sessionId: r.session_id as string, messageId: r.id as string, seq: r.seq as number, snippet: r.snip as string, rank: r.rank as number,
      ...(r.rewound === 1 ? { rewound: true } : {}) }));
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

  restoreSession(id: string): SessionRecord {
    const session = this.getSession(id);
    if (!session) throw new SessionError("not-found", "session not found");
    if (session.kind !== "direct") throw new SessionError("invalid", "only direct chats can be restored");
    this.#run("UPDATE sessions SET archived_at=NULL,updated_at=? WHERE id=?",this.#clock(),id);
    return this.getSession(id)!;
  }

  /** Fork messages in one transaction; replayed historical messages never capture memory again. */
  forkSession(id: string, o: {title?: string; beforeSeq?: number} = {}): SessionRecord {
    return this.#tx(() => {
      const source=this.getSession(id);if(!source)throw new SessionError("not-found","session not found");
      if(source.kind!=="direct")throw new SessionError("invalid","only direct chats can be forked");
      const next=this.createSession({kind:"direct",agentId:source.agentId,owner:source.owner,title:o.title ?? source.title,memoryMode:source.memoryMode});
      const lessons = new Set(this.rewinds(id).map(rewind => rewind.lessonMessageId));
      for(const message of this.contextMessages(id).filter(m=>o.beforeSeq===undefined||m.seq<=o.beforeSeq))this.#insertMessage(next.id,null,lessons.has(message.id)?"user":message.role,message.text,message.tokens);
      return this.getSession(next.id)!;
    });
  }

  /** Explicit transcript erasure requires an archived session and leaves a content-free audit tombstone.
   *  Private checkpoint cleanup intents survive until their native refs have actually been released. */
  readonly #eraseListeners = new Set<() => void>();
  onErasure(listener: () => void): () => void { this.#eraseListeners.add(listener); return () => this.#eraseListeners.delete(listener); }
  eraseSession(id: string, o: { actor: string; reason: string }): { tombstoneId: string; messages: number } {
    if (!o.actor || !o.reason) throw new SessionError("invalid", "an erasure needs an actor and a reason", "erasure-audit");
    const result = this.#tx(() => {
      const s = this.getSession(id);
      if (!s) throw new SessionError("not-found", `session ${id} not found`, "session");
      if (s.archivedAt === null) throw new SessionError("conflict", "erasure requires the session to be archived first (archive-first)", "not-archived");
      const messages = (this.#get("SELECT COUNT(*) AS n FROM messages WHERE session_id = ?", id)!.n as number);
      const tombstoneId = this.#newId("era");
      this.#run("INSERT INTO erasures (id, session_id, agent_id, owner, kind, message_count, erased_at, actor, reason) VALUES (?,?,?,?,?,?,?,?,?)",
        tombstoneId, id, s.agentId, s.owner, s.kind, messages, this.#clock(), o.actor, o.reason);
      for (const t of ["path_rewinds", "summaries", "events", "messages", "turns"]) this.#run(`DELETE FROM ${t} WHERE session_id = ?`, id);
      this.#run("DELETE FROM sessions WHERE id = ?", id);
      return { tombstoneId, messages };
    });
    for (const listener of this.#eraseListeners) listener();
    return result;
  }

  erasures(): { id: string; sessionId: string; owner: string; messageCount: number; actor: string; reason: string }[] {
    return this.#all("SELECT * FROM erasures ORDER BY erased_at, id").map((r) => ({
      id: r.id as string, sessionId: r.session_id as string, owner: r.owner as string, messageCount: r.message_count as number, actor: r.actor as string, reason: r.reason as string,
    }));
  }

  // ---- turns, messages, events ----------------------------------------------------------------------------------

  /** Atomically records the user's message, the running turn and `turn.started`. One running turn per session. */
  beginTurn(sessionId: string, text: string, tokens: number, options: { harnessCommand?: boolean; channelOrigin?: ChannelOrigin } = {}): { turn: TurnRecord; message: MessageRecord; event: EventRecord } {
    return this.#tx(() => {
      const s = this.getSession(sessionId);
      if (!s) throw new SessionError("not-found", `session ${sessionId} not found`, "session");
      if (s.archivedAt !== null) throw new SessionError("conflict", `session ${sessionId} is archived`, "archived");
      if (this.rewindReserved(sessionId)) throw new SessionError("conflict", "file rewind is awaiting or applying approval", "rewind-in-progress");
      if (this.runningTurn(sessionId)) throw new SessionError("conflict", `session ${sessionId} already has a running turn`, "turn-in-progress");
      const now = this.#clock(); const turnId = this.#newId("trn"); const seq = s.turnCount + 1;
      this.#run("INSERT INTO turns (id, session_id, seq, state, started_at, incognito) VALUES (?,?,?,?,?,?)", turnId, sessionId, seq, "running", now, s.memoryMode === "incognito" ? 1 : 0);
      this.#run("UPDATE sessions SET turn_count = ?, last_turn_at = ?, updated_at = ? WHERE id = ?", seq, now, now, sessionId);
      const message = this.#insertMessage(sessionId, turnId, "user", text, tokens);
      const event = this.#insertEvent(sessionId, turnId, "turn.started", { turnId, turnSeq: seq, messageId: message.id,
        ...(options.harnessCommand ? { provider: "harness-command" } : {}),
        ...(options.channelOrigin ? { channelOrigin: options.channelOrigin } : {}) });
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

  /** Learning reads the completed-turn window before imposing content caps. One extra row exposes overflow. */
  /** LP7 deliberately projects only trusted metadata; never selects event data, output or messages. */
  learningToolErrors(owner: string, window: { from: number; to: number }, limit = 4001) {
    return this.#all(`SELECT e.session_id,e.turn_id,e.seq,e.at,json_extract(e.data,'$.learnTool') AS metadata
      FROM events e JOIN turns t ON t.id=e.turn_id JOIN sessions s ON s.id=e.session_id
      WHERE s.owner=? AND s.memory_mode='remember' AND t.incognito=0 AND t.state IN ('completed','failed')
      AND t.ended_at>=? AND t.ended_at<? AND e.type='tool.result' AND json_extract(e.data,'$.learnTool.version')=1
      ORDER BY t.ended_at DESC,e.session_id,e.seq LIMIT ?`, owner, window.from, window.to, Math.min(4001, limit))
      .map(r => ({ sessionId: String(r.session_id), turnId: String(r.turn_id), seq: Number(r.seq), at: Number(r.at),
        metadata: JSON.parse(String(r.metadata)) as import('../tools/learning-metadata.ts').LearningToolMetadata }));
  }

  learningTranscript(sessionId: string, window: { from: number; to: number }, caps: { messages: number; events: number }, turnIds?: readonly string[]): { messages: MessageRecord[]; events: EventRecord[] } {
    let predicate = "t.session_id=? AND t.state='completed' AND t.incognito=0 AND t.ended_at>=? AND t.ended_at<?";
    const args: (string | number)[] = [sessionId, window.from, window.to];
    if (turnIds) {
      if (!turnIds.length || turnIds.length > 100) return { messages: [], events: [] };
      predicate += ` AND t.id IN (${turnIds.map(() => '?').join(',')})`; args.push(...turnIds);
    }
    const messages = this.#all(`SELECT m.* FROM messages m JOIN turns t ON t.id=m.turn_id
      WHERE ${predicate} AND m.session_id=t.session_id AND NOT EXISTS
      (SELECT 1 FROM path_rewinds r WHERE r.session_id=m.session_id AND
       ((r.undone_at IS NULL AND m.seq BETWEEN r.hidden_from_seq AND r.hidden_to_seq)
        OR (r.undone_at IS NOT NULL AND m.id=r.lesson_message_id)))
      ORDER BY m.seq LIMIT ?`, ...args, caps.messages + 1).map(toMessage);
    const events = this.#all(`SELECT e.* FROM events e JOIN turns t ON t.id=e.turn_id
      WHERE ${predicate} AND e.session_id=t.session_id ORDER BY e.seq LIMIT ?`, ...args, caps.events + 1).map(toEvent);
    return { messages, events };
  }

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

  /** Human diff lookup: one session-scoped tool result, without loading the complete event history. */
  toolResult(sessionId: string, callId: string): string | null {
    const row = this.#get("SELECT data FROM events WHERE session_id=? AND type='tool.result' AND json_extract(data,'$.id')=? ORDER BY seq DESC LIMIT 1",
      sessionId, callId);
    if (!row) return null;
    const data = JSON.parse(row.data as string) as Record<string, unknown>;
    return typeof data.output === "string" ? data.output : null;
  }

  listMessages(sessionId: string, o: { afterSeq?: number; beforeSeq?: number; limit?: number; keep?: "newest" | "oldest" } = {}): MessageRecord[] {
    const limit = Math.min(Math.max(o.limit ?? 10_000, 1), 100_000);
    // `keep: "oldest"` is the forward-paging reading (chat.get's documented legacy order): a cut-off keeps the first `limit` messages after `afterSeq`.
    if (o.keep === "oldest") return this.#all("SELECT * FROM messages WHERE session_id=? AND seq<? AND seq>? ORDER BY seq LIMIT ?", sessionId, o.beforeSeq ?? Number.MAX_SAFE_INTEGER, o.afterSeq ?? 0, limit).map(toMessage);
    // Ascending result, but a cut-off keeps the NEWEST `limit` messages (never the oldest): the readers want the tail of a long session.
    return this.#all("SELECT * FROM messages WHERE session_id=? AND seq<? AND seq>? ORDER BY seq DESC LIMIT ?", sessionId, o.beforeSeq ?? Number.MAX_SAFE_INTEGER, o.afterSeq ?? 0, limit).map(toMessage).reverse();
  }

  /** Trusted command provenance for retained transcripts, including failed and recovered commands. */
  harnessCommandTurns(sessionId: string): ReadonlySet<string> {
    return new Set(this.#all(`SELECT DISTINCT turn_id FROM events WHERE session_id=? AND turn_id IS NOT NULL
      AND type IN ('turn.started','turn.completed','turn.failed')
      AND json_extract(data,'$.provider')='harness-command'`, sessionId).map(row => String(row.turn_id)));
  }

  /** Active history after an optional exclusive boundary; no pagination can truncate a rewind digest. */
  contextMessages(sessionId: string, options: { afterSeq?: number } = {}): MessageRecord[] {
    // M6: scan command provenance once, never once per message on every session's prompt path.
    const commands = this.harnessCommandTurns(sessionId);
    const rows = this.#all("SELECT * FROM messages WHERE session_id=? AND seq>? ORDER BY seq",
      sessionId, options.afterSeq ?? 0);
    const messages = rows.map(toMessage).filter(message => message.turnId === null || !commands.has(message.turnId));
    return activePath(messages, this.rewinds(sessionId));
  }

  /** Overlay metadata for transcript readers, ordered by the append-only lesson sequence. */
  rewinds(sessionId: string): RewindRecord[] {
    return this.#all("SELECT * FROM path_rewinds WHERE session_id=? ORDER BY rowid", sessionId)
      .map(toRewind);
  }

  /** Summary coverage must exclude discarded branches and the message of every now-obsolete lesson. */
  summaryRewinds(sessionId: string): RewindRange[] {
    return this.#all(`SELECT r.*,m.seq AS lesson_seq FROM path_rewinds r
      LEFT JOIN messages m ON m.id=r.lesson_message_id WHERE r.session_id=?`, sessionId).flatMap(row => {
      if (row.undone_at === null) return [{ hiddenFromSeq: Number(row.hidden_from_seq),
        hiddenToSeq: Number(row.hidden_to_seq), undoneAt: null }];
      return typeof row.lesson_seq === "number"
        ? [{ hiddenFromSeq: row.lesson_seq, hiddenToSeq: row.lesson_seq, undoneAt: null }] : [];
    });
  }

  /** Record immutable object/ref intent before publishing the ref, so an interrupted write remains discoverable for cleanup. */
  recordCheckpoint(checkpoint: StoredCheckpoint): void {
    this.#tx(() => {
      const turn = this.getTurn(checkpoint.turnId);
      const session = this.getSession(checkpoint.sessionId);
      if (!session || session.archivedAt !== null || !turn || turn.sessionId !== checkpoint.sessionId || turn.state !== "running") {
        throw new SessionError("conflict", "checkpoint turn is not running in the session", "rewind-checkpoint");
      }
      this.#run(`INSERT INTO session_checkpoints(session_id,turn_id,turn_seq,project_id,card_id,root,common_git_dir,ref,tree,commit_id,created_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?)`, checkpoint.sessionId, checkpoint.turnId, turn.seq, checkpoint.projectId, checkpoint.cardId,
        checkpoint.root, checkpoint.commonGitDir, checkpoint.ref,
        checkpoint.tree, checkpoint.commitId, this.#clock());
    });
  }

  /** Native restore checks these stored identities before asking a person, and again before restoring files. */
  checkpoint(sessionId: string, turnId: string): StoredCheckpoint | null {
    const row = this.#get("SELECT * FROM session_checkpoints WHERE session_id=? AND turn_id=?", sessionId, turnId);
    return row ? toCheckpoint(row) : null;
  }

  hasCheckpoints(): boolean { return this.#get("SELECT 1 FROM session_checkpoints LIMIT 1") !== undefined; }

  checkpoints(sessionId?: string): (StoredCheckpoint & { turnSeq: number })[] {
    const sql = "SELECT c.* FROM session_checkpoints c";
    const rows = sessionId === undefined ? this.#all(sql) : this.#all(`${sql} WHERE c.session_id=?`, sessionId);
    return rows.map(row => ({ ...toCheckpoint(row), turnSeq: Number(row.turn_seq) }));
  }

  latestTurnSeq(sessionId: string): number {
    return Number(this.#get("SELECT MAX(seq) AS seq FROM turns WHERE session_id=?", sessionId)?.seq ?? 0);
  }

  /** Private snapshot bookkeeping only; original messages, events and rewind overlays are never deleted here. */
  forgetCheckpoint(checkpoint: StoredCheckpoint): void {
    this.#run("DELETE FROM session_checkpoints WHERE session_id=? AND turn_id=? AND commit_id=?",
      checkpoint.sessionId, checkpoint.turnId, checkpoint.commitId);
  }

  /** The newest still-unapplied proposal; one-click confirmation remains a human rewind call. */
  rewindProposal(sessionId: string): { parentSeq: number; failedCycles: number; lastCheckSeq: number; agentId: string } | null {
    const row = this.#get(`SELECT data FROM events WHERE session_id=?
      AND type IN ('session.rewind.proposed','session.rewind','session.rewind.undone') ORDER BY seq DESC LIMIT 1`, sessionId);
    if (!row) return null;
    const data = JSON.parse(String(row.data)) as Record<string, unknown>;
    const cycles = failedEditCycles(this.contextToolEvents(sessionId));
    if (cycles.lastCheckSeq !== data.lastCheckSeq || cycles.failedCycles < 3 || cycles.pendingEdit) return null;
    return typeof data.lastCheckSeq === "number" && typeof data.parentSeq === "number"
      && typeof data.failedCycles === "number" && typeof data.agentId === "string"
      ? { parentSeq: data.parentSeq, failedCycles: data.failedCycles, lastCheckSeq: data.lastCheckSeq, agentId: data.agentId }
      : null;
  }

  /** Append at most one proposal per observed check; neither a proposal nor an agent message is human approval. */
  proposeRewind(sessionId: string, proposal: { parentSeq: number; failedCycles: number; lastCheckSeq: number; agentId: string }): EventRecord | null {
    return this.#tx(() => {
      this.#rewindIdle(sessionId);
      if (this.rewindProposal(sessionId)?.lastCheckSeq === proposal.lastCheckSeq) return null;
      return this.#insertEvent(sessionId, null, "session.rewind.proposed", proposal);
    });
  }

  /** Read/validate an idle rewind target before asynchronous distillation. Commit rechecks the event revision. */
  planRewind(sessionId: string, toSeq: number | "last", commandTurnId?: string, reservation?: symbol): {
    parentSeq: number; hiddenFromSeq: number; hiddenToSeq: number; messages: MessageRecord[]; eventSeq: number;
  } {
    this.#rewindIdle(sessionId, commandTurnId, reservation);
    const active = this.contextMessages(sessionId).filter(message => message.turnId !== commandTurnId);
    let parentSeq: number;
    if (toSeq === "last") {
      const newest = active.findLast(message => message.turnId !== null);
      const first = newest && active.find(message => message.turnId === newest.turnId);
      parentSeq = first ? active.findLast(message => message.seq < first.seq)?.seq ?? 0 : -1;
    } else parentSeq = toSeq;
    if (!Number.isSafeInteger(parentSeq) || parentSeq < 0 || (parentSeq !== 0 && !active.some(m => m.seq === parentSeq))) {
      throw new SessionError("invalid", "rewind target must be on the active path", "rewind-target");
    }
    // Cover earlier hidden attempts too: undoing an older overlay must not pierce this newer boundary.
    const from = parentSeq + 1;
    const to = active.at(-1)?.seq;
    if (to === undefined || from > to) throw new SessionError("invalid", "rewind range is empty", "rewind-empty");
    const messages = this.#all("SELECT * FROM messages WHERE session_id=? AND seq BETWEEN ? AND ? ORDER BY seq",
      sessionId, from, to).map(toMessage);
    return { parentSeq, hiddenFromSeq: from, hiddenToSeq: to, messages, eventSeq: this.lastEventSeq(sessionId)! };
  }

  /** Append an audited overlay and its harness note in one transaction. Original messages/events remain byte-identical. */
  rewindPath(sessionId: string, input: RewindInput): RewindRecord {
    if (!input.actor || !["user", "agent"].includes(input.trigger) || !input.lesson.trim() || input.lesson.length > 1600) {
      throw new SessionError("invalid", "rewind needs an actor and a lesson of at most 400 estimated tokens", "rewind-lesson");
    }
    return this.#tx(() => {
      const plan = this.planRewind(sessionId, input.toSeq, input.commandTurnId, input.reservation);
      if (input.expectedEventSeq !== undefined && plan.eventSeq !== input.expectedEventSeq) {
        throw new SessionError("conflict", "session changed during rewind; retry on the current path", "rewind-stale");
      }
      const id = this.#newId("rew"), at = this.#clock(), digest = hiddenDigest(plan.messages);
      const detail = { sessionId, rewindId: id, parentSeq: plan.parentSeq, hiddenFrom: plan.hiddenFromSeq,
        hiddenTo: plan.hiddenToSeq, trigger: input.trigger, actor: input.actor, hiddenDigest: digest };
      input.audit?.({ action: "session.rewind", detail });
      const lesson = this.#insertMessage(sessionId, null, "system", input.lesson, Math.ceil(input.lesson.length / 4));
      this.#run(`INSERT INTO path_rewinds(id,session_id,parent_seq,hidden_from_seq,hidden_to_seq,lesson_message_id,
        hidden_digest,trigger,actor,created_at) VALUES (?,?,?,?,?,?,?,?,?,?)`,
        id, sessionId, plan.parentSeq, plan.hiddenFromSeq, plan.hiddenToSeq, lesson.id, digest, input.trigger, input.actor, at);
      this.#run("UPDATE sessions SET updated_at=? WHERE id=?", at, sessionId);
      this.#insertEvent(sessionId, null, "session.rewind", { ...detail, lessonMessageId: lesson.id });
      return toRewind(this.#get("SELECT * FROM path_rewinds WHERE id=?", id)!);
    });
  }

  /** Lift an overlay and its lesson without deleting either. A second undo is idempotent. */
  undoRewind(sessionId: string, rewindId: string, actor: string, audit?: RewindAudit, commandTurnId?: string): RewindRecord {
    return this.#tx(() => {
      this.#rewindIdle(sessionId, commandTurnId);
      const row = this.#get("SELECT * FROM path_rewinds WHERE session_id=? AND id=?", sessionId, rewindId);
      if (!row) throw new SessionError("not-found", "rewind not found", "rewind");
      if (!actor) throw new SessionError("invalid", "undo needs an actor", "rewind-actor");
      const rewind = toRewind(row);
      if (rewind.undoneAt !== null) return rewind;
      const detail = { sessionId, rewindId, actor, hiddenDigest: rewind.hiddenDigest };
      audit?.({ action: "session.rewind.undone", detail });
      const at = this.#clock();
      this.#run("UPDATE path_rewinds SET undone_at=? WHERE id=?", at, rewindId);
      this.#run("UPDATE sessions SET updated_at=? WHERE id=?", at, sessionId);
      this.#insertEvent(sessionId, null, "session.rewind.undone", detail);
      return { ...rewind, undoneAt: at };
    });
  }

  /** Reserve an idle path while a destructive file restore awaits approval; no database transaction spans the await. */
  reserveRewind(sessionId: string, commandTurnId?: string): { token: symbol; release(): void } {
    this.#rewindIdle(sessionId, commandTurnId);
    const token = Symbol("rewind");
    this.#rewindReservations.set(sessionId, token);
    return { token, release: () => {
      if (this.#rewindReservations.get(sessionId) === token) this.#rewindReservations.delete(sessionId);
    } };
  }

  /** Background model work must not change the path while approved file restoration is pending. */
  rewindReserved(sessionId: string): boolean { return this.#rewindReservations.has(sessionId); }

  #rewindIdle(sessionId: string, commandTurnId?: string, reservation?: symbol): void {
    const session = this.getSession(sessionId);
    if (!session) throw new SessionError("not-found", "session not found", "session");
    if (session.archivedAt !== null) throw new SessionError("conflict", "session is archived", "archived");
    if (this.rewindReserved(sessionId) && this.#rewindReservations.get(sessionId) !== reservation) {
      throw new SessionError("conflict", "file rewind is awaiting or applying approval", "rewind-in-progress");
    }
    const running = this.runningTurn(sessionId);
    if (running && running.id !== commandTurnId) throw new SessionError("conflict", "rewind requires an idle session", "turn-running");
  }

  tokenCalibration(model: string): number | null { return (this.#get("SELECT factor FROM token_calibration WHERE model=?", model)?.factor as number | undefined) ?? null; }
  tokenFactor(model: string): number { return this.tokenCalibration(model) ?? 1; }
  setTokenFactor(model: string, factor: number): void { this.#run("INSERT INTO token_calibration(model,factor) VALUES (?,?) ON CONFLICT(model) DO UPDATE SET factor=excluded.factor", model, factor); }
  recordMessageUsage(id: string, model: string, tokens: number): void { this.#run("INSERT OR REPLACE INTO message_usage(message_id,model,tokens) VALUES (?,?,?)", id, model, tokens); }
  messageUsage(id: string, model: string, text: string): number | undefined { return this.#get("SELECT u.tokens FROM message_usage u JOIN messages m ON m.id=u.message_id WHERE message_id=? AND model=? AND m.text=?", id, model, text)?.tokens as number | undefined; }
  toolVisibility(sessionId: string): { ref: string; hidden: boolean; reason: string; mode?: 'truncate' }[] {
    return this.#all("SELECT ref,hidden,reason,mode FROM tool_visibility WHERE session_id=? ORDER BY ref", sessionId).map(r => ({ ref: r.ref as string, hidden: r.hidden === 1, reason: r.reason as string, ...(r.mode === "truncate" ? { mode: "truncate" as const } : {}) }));
  }
  setToolVisibility(sessionId: string, ref: string, hidden: boolean, reason: string, detail?: { mode: "truncate" | "drop"; confidence: number; tokensSaved: number }): void {
    this.#run("INSERT INTO tool_visibility(session_id,ref,hidden,reason) VALUES (?,?,?,?) ON CONFLICT(session_id,ref) DO UPDATE SET hidden=excluded.hidden,reason=excluded.reason", sessionId, ref, hidden ? 1 : 0, reason);
    if (detail) this.#run("UPDATE tool_visibility SET mode=?,confidence=?,tokens_saved=? WHERE session_id=? AND ref=?", detail.mode, detail.confidence, detail.tokensSaved, sessionId, ref);
  }
  /** Administrative transcript replies are not semantic references to original tool output. */
  latestAssistantContext(sessionId: string): string {
    return this.contextMessages(sessionId).findLast(message => message.role === "assistant")?.text ?? "";
  }
  pruneExplanation(sessionId: string): {ref:string;hidden:boolean;verdict:string;confidence:number|null;tokensSaved:number}[] {
    return this.#all("SELECT ref,hidden,mode,confidence,tokens_saved FROM tool_visibility WHERE session_id=? ORDER BY ref",sessionId).map(r=>({ref:String(r.ref),hidden:r.hidden===1,verdict:String(r.mode),confidence:r.confidence===null?null:Number(r.confidence),tokensSaved:Number(r.tokens_saved)}));
  }
  recordToolRefetch(sessionId: string, ref: string): void { this.#run("UPDATE tool_visibility SET refetches=refetches+1 WHERE session_id=? AND ref=?",sessionId,ref); }
  pruneMetrics(sessionId: string): { pruned: number; tokensSaved: number; refetches: number; refetchRate: number } {
    const r=this.#get("SELECT COUNT(*) AS pruned,COALESCE(SUM(tokens_saved),0) AS saved,COALESCE(SUM(refetches),0) AS refetches FROM tool_visibility WHERE session_id=?",sessionId)!;
    const pruned=Number(r.pruned),refetches=Number(r.refetches);
    return {pruned,tokensSaved:Number(r.saved),refetches,refetchRate:pruned?refetches/pruned:0};
  }
  setToolVisibilities(sessionId: string, changes: { ref: string; hidden: boolean; reason: string; turnId?: string; detail?: { mode: "truncate" | "drop"; confidence: number; tokensSaved: number } }[]): void {
    this.#tx(() => { for (const change of changes) {
      this.setToolVisibility(sessionId,change.ref,change.hidden,change.reason,change.detail);
      if(change.detail && change.turnId) {
        const turn=this.#get("SELECT session_id,state FROM turns WHERE id=?",change.turnId);
        if(!turn || turn.session_id!==sessionId || turn.state!=='completed') throw new SessionError('conflict','pruning turn is not completed','turn-not-running');
        this.#insertEvent(sessionId,change.turnId,'compaction.prune',{ref:change.ref,...change.detail});
      }
    } });
  }
  /** Internal read-only background scan; event pagination never drops older tool pairs. */
  toolEvents(sessionId: string): EventRecord[] { return this.#all("SELECT * FROM events WHERE session_id=? AND type IN ('tool.call','tool.result') ORDER BY seq", sessionId).map(toEvent); }

  /** Prompt and background model readers may only consume tool events of wholly active turns. */
  contextToolEvents(sessionId: string): EventRecord[] {
    return this.#all(`SELECT e.* FROM events e JOIN turns t ON t.id=e.turn_id AND t.session_id=e.session_id
      WHERE e.session_id=? AND e.type IN ('tool.call','tool.result') AND ${ACTIVE_TURN_SQL} ORDER BY e.seq`, sessionId)
      .map(toEvent);
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
