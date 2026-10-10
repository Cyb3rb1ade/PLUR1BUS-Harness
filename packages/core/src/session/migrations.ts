// Versioned migrations for the session store (A7: node:sqlite + FTS5). The schema version lives in
// `PRAGMA user_version`; a file written by a newer core is refused (fail closed), never downgraded in place.
import type { DatabaseSync } from "node:sqlite";
import { SessionError } from "./types.ts";

export const MIGRATIONS: readonly string[] = [
  // v1
  `
  CREATE TABLE sessions (
    id TEXT PRIMARY KEY,
    kind TEXT NOT NULL CHECK (kind IN ('direct','card','project','channel','acp')),
    agent_id TEXT NOT NULL,
    owner TEXT NOT NULL,
    scope TEXT NOT NULL,
    chat_key TEXT,
    title TEXT NOT NULL DEFAULT '',
    pinned INTEGER NOT NULL DEFAULT 0,
    memory_mode TEXT NOT NULL DEFAULT 'remember' CHECK (memory_mode IN ('remember','incognito')),
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    last_turn_at INTEGER,
    archived_at INTEGER,
    turn_count INTEGER NOT NULL DEFAULT 0,
    last_message_seq INTEGER NOT NULL DEFAULT 0,
    last_event_seq INTEGER NOT NULL DEFAULT 0,
    CHECK ((kind = 'channel') = (chat_key IS NOT NULL))
  );
  CREATE INDEX idx_sessions_owner ON sessions(owner, archived_at, last_turn_at);
  -- D21: one active session per chat.
  CREATE UNIQUE INDEX idx_sessions_active_chat ON sessions(chat_key) WHERE chat_key IS NOT NULL AND archived_at IS NULL;
  -- I1: kind, agentId, owner, scope and chatKey never change, whatever code runs the UPDATE.
  CREATE TRIGGER sessions_immutable BEFORE UPDATE OF kind, agent_id, owner, scope, chat_key ON sessions
  WHEN NEW.kind IS NOT OLD.kind OR NEW.agent_id IS NOT OLD.agent_id OR NEW.owner IS NOT OLD.owner
    OR NEW.scope IS NOT OLD.scope OR NEW.chat_key IS NOT OLD.chat_key
  BEGIN SELECT RAISE(ABORT, 'I1: session kind, agent, owner and scope are immutable'); END;

  CREATE TABLE turns (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL REFERENCES sessions(id),
    seq INTEGER NOT NULL,
    state TEXT NOT NULL CHECK (state IN ('running','completed','failed')),
    started_at INTEGER NOT NULL,
    ended_at INTEGER,
    error TEXT,
    incognito INTEGER NOT NULL DEFAULT 0,
    UNIQUE (session_id, seq)
  );
  CREATE UNIQUE INDEX idx_turns_one_running ON turns(session_id) WHERE state = 'running';

  CREATE TABLE messages (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL REFERENCES sessions(id),
    turn_id TEXT REFERENCES turns(id),
    seq INTEGER NOT NULL,
    role TEXT NOT NULL CHECK (role IN ('system','user','assistant','tool')),
    text TEXT NOT NULL,
    tokens INTEGER NOT NULL,
    created_at INTEGER NOT NULL,
    UNIQUE (session_id, seq)
  );

  CREATE TABLE events (
    session_id TEXT NOT NULL REFERENCES sessions(id),
    seq INTEGER NOT NULL,
    turn_id TEXT,
    type TEXT NOT NULL,
    data TEXT NOT NULL,
    at INTEGER NOT NULL,
    PRIMARY KEY (session_id, seq)
  );

  CREATE TABLE summaries (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL REFERENCES sessions(id),
    from_seq INTEGER NOT NULL,
    to_seq INTEGER NOT NULL,
    text TEXT NOT NULL,
    tokens INTEGER NOT NULL,
    tier INTEGER NOT NULL,
    state TEXT NOT NULL CHECK (state IN ('prepared','applied','superseded')),
    created_at INTEGER NOT NULL
  );
  CREATE INDEX idx_summaries_session ON summaries(session_id, state);

  -- Audit tombstone of an explicit erasure: ids and counts only, never content.
  CREATE TABLE erasures (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL,
    agent_id TEXT NOT NULL,
    owner TEXT NOT NULL,
    kind TEXT NOT NULL,
    message_count INTEGER NOT NULL,
    erased_at INTEGER NOT NULL,
    actor TEXT NOT NULL,
    reason TEXT NOT NULL
  );

  CREATE VIRTUAL TABLE messages_fts USING fts5(text, content='messages', content_rowid='rowid');
  CREATE TRIGGER messages_ai AFTER INSERT ON messages BEGIN
    INSERT INTO messages_fts(rowid, text) VALUES (NEW.rowid, NEW.text);
  END;
  CREATE TRIGGER messages_ad AFTER DELETE ON messages BEGIN
    INSERT INTO messages_fts(messages_fts, rowid, text) VALUES ('delete', OLD.rowid, OLD.text);
  END;
  CREATE VIRTUAL TABLE sessions_fts USING fts5(title, content='sessions', content_rowid='rowid');
  CREATE TRIGGER sessions_ai AFTER INSERT ON sessions BEGIN
    INSERT INTO sessions_fts(rowid, title) VALUES (NEW.rowid, NEW.title);
  END;
  CREATE TRIGGER sessions_au AFTER UPDATE OF title ON sessions BEGIN
    INSERT INTO sessions_fts(sessions_fts, rowid, title) VALUES ('delete', OLD.rowid, OLD.title);
    INSERT INTO sessions_fts(rowid, title) VALUES (NEW.rowid, NEW.title);
  END;
  CREATE TRIGGER sessions_ad AFTER DELETE ON sessions BEGIN
    INSERT INTO sessions_fts(sessions_fts, rowid, title) VALUES ('delete', OLD.rowid, OLD.title);
  END;
  `,
  // v2: the first recall snapshot remains frozen across Core restarts for a remembered session.
  `CREATE TABLE prompt_snapshots (session_id TEXT PRIMARY KEY REFERENCES sessions(id) ON DELETE CASCADE, memory TEXT NOT NULL);`,
  // v3: view overlays and calibration only; never rewrite transcript messages/events.
  `CREATE TABLE token_calibration (model TEXT PRIMARY KEY, factor REAL NOT NULL);
   CREATE TABLE message_usage (message_id TEXT PRIMARY KEY REFERENCES messages(id) ON DELETE CASCADE, model TEXT NOT NULL, tokens INTEGER NOT NULL);
   CREATE TABLE tool_visibility (session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE, ref TEXT NOT NULL, hidden INTEGER NOT NULL, reason TEXT NOT NULL, PRIMARY KEY(session_id,ref));`,
];

export const SCHEMA_VERSION = MIGRATIONS.length;

export function migrate(db: DatabaseSync, migrations: readonly string[] = MIGRATIONS): number {
  const row = db.prepare("PRAGMA user_version").get() as { user_version: number };
  const current = row.user_version;
  if (current > migrations.length) {
    throw new SessionError("storage", `session store schema v${current} is newer than this core supports (v${migrations.length})`, "schema-too-new");
  }
  for (let v = current; v < migrations.length; v++) {
    db.exec("BEGIN IMMEDIATE");
    try {
      db.exec(migrations[v]!);
      db.exec(`PRAGMA user_version = ${v + 1}`);
      db.exec("COMMIT");
    } catch (e) {
      db.exec("ROLLBACK");
      throw new SessionError("storage", `session store migration to v${v + 1} failed: ${e instanceof Error ? e.message : String(e)}`, "migration-failed");
    }
  }
  return migrations.length;
}
