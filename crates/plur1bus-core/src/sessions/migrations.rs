//! `session/migrations.ts`: the versioned migrations of the session store. The texts are the TypeScript texts byte for byte
//! (generated from `MIGRATIONS` by the K5a exporter's check, see `scripts/parity/export-sessions.ts`), since SQLite keeps a
//! `CREATE` statement as written and the `sqlite_master` of a file made here must equal one made there.
//!
//! A file written by a newer core is refused and left as it was; [`plur1bus_store::Store::open_owner`] with
//! [`plur1bus_store::Schema::Steps`] does the TypeScript `migrate()`: one `BEGIN IMMEDIATE` transaction per missing step,
//! `PRAGMA user_version = n` inside it, a failed step rolled back and reported as `migration-failed`.

/// `SCHEMA_VERSION = MIGRATIONS.length`. The plan calls this schema v9; the source has two more steps (v10 rewind overlay and
/// checkpoints, v11 coding worktree bindings), so this is 11.
pub const SCHEMA_VERSION: u32 = 11;

/// `MIGRATIONS`: entry `v - 1` takes the schema to version `v`; append only.
pub const MIGRATIONS: &[&str] = &[
    r##"
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
  "##,
    r##"CREATE TABLE prompt_snapshots (session_id TEXT PRIMARY KEY REFERENCES sessions(id) ON DELETE CASCADE, memory TEXT NOT NULL);"##,
    r##"CREATE TABLE token_calibration (model TEXT PRIMARY KEY, factor REAL NOT NULL);
   CREATE TABLE message_usage (message_id TEXT PRIMARY KEY REFERENCES messages(id) ON DELETE CASCADE, model TEXT NOT NULL, tokens INTEGER NOT NULL);
   CREATE TABLE tool_visibility (session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE, ref TEXT NOT NULL, hidden INTEGER NOT NULL, reason TEXT NOT NULL, PRIMARY KEY(session_id,ref));"##,
    r##"CREATE TABLE session_model_profiles (session_id TEXT PRIMARY KEY REFERENCES sessions(id) ON DELETE CASCADE, profile TEXT NOT NULL, revision INTEGER NOT NULL);"##,
    r##"ALTER TABLE session_model_profiles ADD COLUMN reasoning TEXT;"##,
    r##"ALTER TABLE tool_visibility ADD COLUMN mode TEXT NOT NULL DEFAULT 'drop' CHECK(mode IN ('drop','truncate'));
   ALTER TABLE tool_visibility ADD COLUMN confidence REAL;
   ALTER TABLE tool_visibility ADD COLUMN tokens_saved INTEGER NOT NULL DEFAULT 0;
   ALTER TABLE tool_visibility ADD COLUMN refetches INTEGER NOT NULL DEFAULT 0;"##,
    r##"CREATE TABLE skill_catalogue_snapshots (
    session_id TEXT PRIMARY KEY REFERENCES sessions(id) ON DELETE CASCADE,
    catalogue TEXT NOT NULL
  );
  CREATE INDEX idx_skill_load_calls ON events(session_id,turn_id,json_extract(data,'$.id'),seq)
    WHERE type='tool.call' AND json_extract(data,'$.name')='skill.load';"##,
    r##"CREATE TABLE session_tool_offers (
    session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    name TEXT NOT NULL CHECK(name='sys.startupItems' OR
      (length(name) BETWEEN 1 AND 64 AND name GLOB '[a-z]*' AND name NOT GLOB '*[^a-z0-9_.-]*')),
    ordinal INTEGER NOT NULL CHECK(ordinal>=0 AND ordinal<128),
    PRIMARY KEY(session_id,name),
    UNIQUE(session_id,ordinal)
  );"##,
    r##"ALTER TABLE sessions ADD COLUMN origin TEXT CHECK (origin IS NULL OR origin IN ('mcp','a2a','acp-agent'));
   DROP TRIGGER sessions_immutable;
   CREATE TRIGGER sessions_immutable BEFORE UPDATE OF kind, agent_id, owner, scope, chat_key, origin ON sessions
   WHEN NEW.kind IS NOT OLD.kind OR NEW.agent_id IS NOT OLD.agent_id OR NEW.owner IS NOT OLD.owner
     OR NEW.scope IS NOT OLD.scope OR NEW.chat_key IS NOT OLD.chat_key OR NEW.origin IS NOT OLD.origin
   BEGIN SELECT RAISE(ABORT, 'I1: session kind, agent, owner, scope and origin are immutable'); END;"##,
    r##"CREATE TABLE path_rewinds (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    parent_seq INTEGER NOT NULL CHECK(parent_seq>=0),
    hidden_from_seq INTEGER NOT NULL CHECK(hidden_from_seq>parent_seq),
    hidden_to_seq INTEGER NOT NULL CHECK(hidden_to_seq>=hidden_from_seq),
    lesson_message_id TEXT REFERENCES messages(id),
    hidden_digest TEXT NOT NULL CHECK(length(hidden_digest)=64),
    trigger TEXT NOT NULL CHECK(trigger IN ('user','agent')),
    actor TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    undone_at INTEGER
  );
  CREATE INDEX idx_path_rewinds_session ON path_rewinds(session_id,created_at);
  CREATE TABLE session_checkpoints (
    session_id TEXT NOT NULL,
    turn_id TEXT NOT NULL,
    turn_seq INTEGER NOT NULL,
    project_id TEXT NOT NULL,
    card_id TEXT NOT NULL,
    root TEXT NOT NULL,
    common_git_dir TEXT NOT NULL,
    ref TEXT NOT NULL,
    tree TEXT NOT NULL,
    commit_id TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    PRIMARY KEY(session_id,turn_id)
  );
  CREATE TRIGGER session_checkpoints_immutable BEFORE UPDATE ON session_checkpoints
    BEGIN SELECT RAISE(ABORT, 'turn checkpoint is immutable'); END;"##,
    r##"CREATE TABLE session_worktrees (
     session_id TEXT PRIMARY KEY REFERENCES sessions(id) ON DELETE CASCADE,
     root TEXT NOT NULL,
     project_id TEXT,
     card_id TEXT,
     created_by TEXT NOT NULL,
     created_at INTEGER NOT NULL,
     CHECK ((project_id IS NULL) = (card_id IS NULL))
   );
   CREATE TRIGGER session_worktrees_immutable BEFORE UPDATE ON session_worktrees
   BEGIN SELECT RAISE(ABORT, 'coding worktree bindings are immutable'); END;"##,
];
