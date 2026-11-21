//! `session/store.ts`: the session store (M1b-2c, A7), SQLite with FTS5. This file holds the open path, the shared row
//! helpers and the session half (create, read, list, search, update, archive, fork, erase); turns, messages and events are
//! in `store_turns.rs`, overlays, snapshots, offers, calibration, visibility, summaries and checkpoints in `store_misc.rs`,
//! all as `impl SessionStore`.
//!
//! The TypeScript store is synchronous with one connection ("one resident core, one writer") and wraps a unit of work in
//! `#tx`, a re-entrant `BEGIN IMMEDIATE .. COMMIT`. A method that calls another inside its transaction is written here as
//! a free function over a [`Connection`] (`*_in`), so the outer transaction is the only one; the public method is the thin
//! wrapper that opens it ([`SessionStore::tx`]) or just reads. No message or event text is ever written to a log or an
//! error.
use super::migrations::{MIGRATIONS, SCHEMA_VERSION};
use super::overlay::RewindRange;
use super::types::*;
use super::{fts::fts_query, Clock, IdSource, SessionError};
use crate::approvals::js_json::J;
use crate::js::{utf16, utf16_len};
use crate::private_store::AdvisoryLease;
use plur1bus_store::rusqlite::types::Value;
use plur1bus_store::rusqlite::{Connection, Params, Row};
use plur1bus_store::{Journal, OwnerSpec, Schema, Store, StoreSpec, Synchronous};
use std::collections::{HashMap, HashSet};
use std::fs::{File, TryLockError};
use std::path::{Path, PathBuf};
use std::sync::Arc;

pub(crate) const MAX_TITLE: usize = 200;
const MAX_LIMIT: i64 = 200;
const DEFAULT_LIMIT: i64 = 50;
/// `Number.MAX_SAFE_INTEGER`, the default `beforeSeq` of `listMessages`.
const MAX_SAFE: i64 = 9_007_199_254_740_991;

/// A listener for a committed archive or replacement (`onArchived`). It cannot roll back or fail a stored change: an `Err`
/// is dropped, as the TypeScript store drops an exception.
pub type ArchiveListener = Arc<dyn Fn(&str) -> Result<(), String> + Send + Sync>;
/// A listener for a committed erasure (`onErasure`).
pub type ErasureListener = Arc<dyn Fn() + Send + Sync>;

/// The token of a rewind reservation (`reserveRewind`'s symbol).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct RewindToken(pub(crate) u64);

/// What a transaction body needs besides the connection: the ports and the reservation table.
pub(crate) struct Env {
    pub(crate) clock: Arc<dyn Clock>,
    pub(crate) ids: Arc<dyn IdSource>,
    pub(crate) reservations: HashMap<String, (RewindToken, Option<AdvisoryLease>)>,
    rewind_lock_dir: Option<PathBuf>,
}

impl Env {
    pub(crate) fn now(&self) -> i64 {
        self.clock.now()
    }
    /// `#newId(prefix)`: `prefix_` and the id source's next id.
    pub(crate) fn new_id(&self, prefix: &str) -> String {
        format!("{prefix}_{}", self.ids.next_id())
    }

    pub(crate) fn rewind_blocked(&self, session_id: &str, token: Option<RewindToken>) -> bool {
        match self.reservations.get(session_id) {
            Some((held, _)) => Some(*held) != token,
            None => self.lock_rewind(session_id, false).is_err(),
        }
    }

    // The file descriptor holds the reservation across SQLite connections and releases it
    // on drop or process exit. A sidecar keeps the shared TypeScript schema unchanged.
    pub(crate) fn lock_rewind(
        &self,
        session_id: &str,
        create: bool,
    ) -> Result<Option<AdvisoryLease>, SessionError> {
        use sha2::{Digest, Sha256};
        let Some(dir) = &self.rewind_lock_dir else {
            return Ok(None);
        };
        let storage = || {
            SessionError::new(
                super::ErrorCode::Storage,
                "rewind lock unavailable",
                Some("rewind-lock"),
            )
        };
        if create {
            let mut builder = std::fs::DirBuilder::new();
            builder.recursive(true);
            #[cfg(unix)]
            {
                use std::os::unix::fs::DirBuilderExt;
                builder.mode(0o700);
            }
            builder.create(dir).map_err(|_| storage())?;
        }
        match std::fs::symlink_metadata(dir) {
            Ok(metadata) if metadata.is_dir() && !rewind_reparse_point(&metadata) => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound && !create => {
                return Ok(None)
            }
            _ => return Err(storage()),
        }
        let path = dir.join(format!("{:x}", Sha256::digest(session_id.as_bytes())));
        let mut options = File::options();
        options
            .read(true)
            .write(true)
            .create(create)
            .truncate(false);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options
                .mode(0o600)
                .custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK);
        }
        #[cfg(windows)]
        {
            use std::os::windows::fs::OpenOptionsExt;
            // Read and write sharing let other connections check the lock. Refuse reparse points.
            options.share_mode(3).custom_flags(0x0020_0000);
        }
        let file = match options.open(path) {
            Ok(file) => file,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound && !create => {
                return Ok(None)
            }
            Err(_) => return Err(storage()),
        };
        let metadata = file.metadata().map_err(|_| storage())?;
        if !metadata.is_file() || rewind_reparse_point(&metadata) {
            return Err(storage());
        }
        match file.try_lock() {
            Ok(()) => Ok(Some(AdvisoryLease(file))),
            Err(TryLockError::WouldBlock) => Err(SessionError::conflict(
                "file rewind is awaiting or applying approval",
                "rewind-in-progress",
            )),
            Err(TryLockError::Error(_)) => Err(storage()),
        }
    }
}

fn rewind_reparse_point(metadata: &std::fs::Metadata) -> bool {
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        metadata.file_attributes() & 0x400 != 0
    }
    #[cfg(not(windows))]
    metadata.file_type().is_symlink()
}

/// The session store on one open file (or an in-memory database).
pub struct SessionStore {
    pub(crate) db: Store,
    pub(crate) env: Env,
    archive_listeners: Vec<(u64, ArchiveListener)>,
    erase_listeners: Vec<(u64, ErasureListener)>,
    next_listener: u64,
    next_token: u64,
}

// ---- row helpers -------------------------------------------------------------------------------------------------------

pub(crate) fn q_all<T, P: Params>(
    c: &Connection,
    sql: &str,
    params: P,
    f: impl FnMut(&Row<'_>) -> plur1bus_store::rusqlite::Result<T>,
) -> Result<Vec<T>, SessionError> {
    let mut stmt = c.prepare_cached(sql)?;
    let rows = stmt.query_map(params, f)?;
    let mut out = Vec::new();
    for row in rows {
        out.push(row?);
    }
    Ok(out)
}

pub(crate) fn q_one<T, P: Params>(
    c: &Connection,
    sql: &str,
    params: P,
    f: impl FnMut(&Row<'_>) -> plur1bus_store::rusqlite::Result<T>,
) -> Result<Option<T>, SessionError> {
    Ok(q_all(c, sql, params, f)?.into_iter().next())
}

pub(crate) fn run<P: Params>(c: &Connection, sql: &str, params: P) -> Result<(), SessionError> {
    c.prepare_cached(sql)?.execute(params)?;
    Ok(())
}

pub(crate) fn s(r: &Row<'_>, name: &str) -> plur1bus_store::rusqlite::Result<String> {
    r.get::<_, String>(name)
}
pub(crate) fn n(r: &Row<'_>, name: &str) -> plur1bus_store::rusqlite::Result<i64> {
    r.get::<_, i64>(name)
}

pub(crate) fn to_session(r: &Row<'_>) -> plur1bus_store::rusqlite::Result<SessionRecord> {
    Ok(SessionRecord {
        id: s(r, "id")?,
        kind: SessionKind::parse(&s(r, "kind")?).unwrap_or(SessionKind::Direct),
        agent_id: s(r, "agent_id")?,
        owner: s(r, "owner")?,
        scope: s(r, "scope")?,
        chat_key: r.get("chat_key")?,
        title: s(r, "title")?,
        pinned: n(r, "pinned")? == 1,
        memory_mode: MemoryMode::parse(&s(r, "memory_mode")?).unwrap_or(MemoryMode::Remember),
        created_at: n(r, "created_at")?,
        updated_at: n(r, "updated_at")?,
        last_turn_at: r.get("last_turn_at")?,
        archived_at: r.get("archived_at")?,
        turn_count: n(r, "turn_count")?,
        origin: r
            .get::<_, Option<String>>("origin")?
            .and_then(|o| SessionOrigin::parse(&o)),
    })
}

pub(crate) fn to_turn(r: &Row<'_>) -> plur1bus_store::rusqlite::Result<TurnRecord> {
    Ok(TurnRecord {
        id: s(r, "id")?,
        session_id: s(r, "session_id")?,
        seq: n(r, "seq")?,
        state: TurnState::parse(&s(r, "state")?).unwrap_or(TurnState::Failed),
        started_at: n(r, "started_at")?,
        ended_at: r.get("ended_at")?,
        error: r.get("error")?,
        incognito: n(r, "incognito")? == 1,
    })
}

pub(crate) fn to_message(r: &Row<'_>) -> plur1bus_store::rusqlite::Result<MessageRecord> {
    Ok(MessageRecord {
        id: s(r, "id")?,
        session_id: s(r, "session_id")?,
        turn_id: r.get("turn_id")?,
        seq: n(r, "seq")?,
        role: MessageRole::parse(&s(r, "role")?).unwrap_or(MessageRole::System),
        text: s(r, "text")?,
        tokens: n(r, "tokens")?,
        created_at: n(r, "created_at")?,
    })
}

/// `toEvent`: the payload is parsed with member order kept. A payload the parser cannot hold (a lone surrogate escape, a
/// number outside the double range) is an error here where JavaScript would read it: such a row was not written by this
/// store.
pub(crate) fn to_event(r: &Row<'_>) -> Result<EventRecord, SessionError> {
    let text = s(r, "data")?;
    let data = J::parse(&text).ok_or_else(|| {
        SessionError::new(
            super::ErrorCode::Storage,
            "event payload is unreadable",
            Some("event-data"),
        )
    })?;
    Ok(EventRecord {
        session_id: s(r, "session_id")?,
        turn_id: r.get("turn_id")?,
        seq: n(r, "seq")?,
        kind: s(r, "type")?,
        data,
        at: n(r, "at")?,
    })
}

pub(crate) fn events_of<P: Params>(
    c: &Connection,
    sql: &str,
    params: P,
) -> Result<Vec<EventRecord>, SessionError> {
    let rows = q_all(c, sql, params, |r| Ok(to_event(r)))?;
    rows.into_iter().collect()
}

/// `str.slice(0, max)` over UTF-16 units. A cut through a surrogate pair leaves a lone surrogate in JavaScript, which
/// SQLite receives as U+FFFD; the lossy conversion gives the same text.
pub(crate) fn slice_units(text: &str, max: usize) -> String {
    if utf16_len(text) <= max {
        return text.to_owned();
    }
    String::from_utf16_lossy(&utf16(text)[..max])
}

fn is_canonical_tool_name(name: &str) -> bool {
    if name == "sys.startupItems" {
        return true;
    }
    let b = name.as_bytes();
    !b.is_empty()
        && b.len() <= 64
        && b[0].is_ascii_lowercase()
        && b[1..].iter().all(|c| {
            c.is_ascii_lowercase() || c.is_ascii_digit() || matches!(c, b'_' | b'.' | b'-')
        })
}

pub(crate) const MAX_SESSION_TOOL_OFFERS: usize = 128;

pub(crate) fn get_session_in(
    c: &Connection,
    id: &str,
) -> Result<Option<SessionRecord>, SessionError> {
    q_one(c, "SELECT * FROM sessions WHERE id = ?", [id], to_session)
}

pub(crate) fn running_turn_in(
    c: &Connection,
    session_id: &str,
) -> Result<Option<TurnRecord>, SessionError> {
    q_one(
        c,
        "SELECT * FROM turns WHERE session_id = ? AND state = 'running'",
        [session_id],
        to_turn,
    )
}

fn archived_clause(archived: Option<ArchivedFilter>, where_: &mut Vec<String>) {
    match archived.unwrap_or(ArchivedFilter::Exclude) {
        ArchivedFilter::Exclude => where_.push("s.archived_at IS NULL".into()),
        ArchivedFilter::Only => where_.push("s.archived_at IS NOT NULL".into()),
        ArchivedFilter::Any => {}
    }
}

const SEARCH_CLAUSE: &str = "(s.rowid IN (SELECT rowid FROM sessions_fts WHERE sessions_fts MATCH ?) OR s.id IN (SELECT m.session_id FROM messages m WHERE m.rowid IN (SELECT rowid FROM messages_fts WHERE messages_fts MATCH ?)))";

fn clamp_limit(limit: Option<i64>, upper: i64) -> i64 {
    limit.unwrap_or(DEFAULT_LIMIT).max(1).min(upper)
}

fn text_of(v: &str) -> Value {
    Value::Text(v.to_owned())
}

impl SessionStore {
    /// `new SessionStore({ path, clock, newId })` for a file: made like the TypeScript constructor makes it (foreign keys
    /// on, busy timeout 5 s, WAL, `synchronous = NORMAL`, every missing migration in its own `BEGIN IMMEDIATE`). A file
    /// from a newer core is refused with reason `schema-too-new` and left as it was. The file's mode is set to 0600 where
    /// the platform has modes (best effort, as in TypeScript: the home directory is 0700).
    pub fn open(
        path: &Path,
        clock: Arc<dyn Clock>,
        ids: Arc<dyn IdSource>,
    ) -> Result<Self, SessionError> {
        if path == Path::new(":memory:") {
            return Self::open_memory(clock, ids);
        }
        let owner = OwnerSpec {
            store: StoreSpec {
                synchronous: Synchronous::Normal,
                ..StoreSpec::new("session", SCHEMA_VERSION)
            },
            journal: Journal::Wal,
            schema: Schema::Steps(MIGRATIONS),
            create: true,
        };
        let db = Store::open_owner(path, &owner)?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let _ = std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600));
        }
        let mut lock_dir = path
            .canonicalize()
            .map_err(|_| {
                SessionError::new(
                    super::ErrorCode::Storage,
                    "cannot resolve session store for rewind locking",
                    Some("rewind-lock"),
                )
            })?
            .into_os_string();
        lock_dir.push(".rewind-locks");
        Ok(Self::with(db, clock, ids, Some(PathBuf::from(lock_dir))))
    }

    /// `path: ":memory:"`: no WAL, no `synchronous`, no file mode.
    pub fn open_memory(
        clock: Arc<dyn Clock>,
        ids: Arc<dyn IdSource>,
    ) -> Result<Self, SessionError> {
        let owner = OwnerSpec {
            store: StoreSpec::new("session", SCHEMA_VERSION),
            journal: Journal::Unchanged,
            schema: Schema::Steps(MIGRATIONS),
            create: true,
        };
        let db = Store::open_owner(Path::new(":memory:"), &owner)?;
        Ok(Self::with(db, clock, ids, None))
    }

    fn with(
        db: Store,
        clock: Arc<dyn Clock>,
        ids: Arc<dyn IdSource>,
        rewind_lock_dir: Option<PathBuf>,
    ) -> Self {
        Self {
            db,
            env: Env {
                clock,
                ids,
                reservations: HashMap::new(),
                rewind_lock_dir,
            },
            archive_listeners: Vec::new(),
            erase_listeners: Vec::new(),
            next_listener: 0,
            next_token: 0,
        }
    }

    /// The connection, for reads. Writes go through the methods.
    pub fn conn(&self) -> &Connection {
        self.db.conn()
    }

    /// `PRAGMA user_version`.
    pub fn user_version(&self) -> Result<u32, SessionError> {
        Ok(self.db.user_version()?)
    }

    /// `#tx`: `BEGIN IMMEDIATE`, the body, `COMMIT`; any error rolls back and is mapped like `mapSqlite`.
    pub(crate) fn tx<T>(
        &mut self,
        f: impl FnOnce(&Env, &Connection) -> Result<T, SessionError>,
    ) -> Result<T, SessionError> {
        let env = &self.env;
        self.db.write_with(|tx| f(env, tx))
    }

    /// `onArchived`: observes a committed archive or replacement. Returns the id to pass to
    /// [`SessionStore::remove_archive_listener`].
    pub fn on_archived(&mut self, listener: ArchiveListener) -> u64 {
        self.next_listener += 1;
        self.archive_listeners.push((self.next_listener, listener));
        self.next_listener
    }

    /// Removes a listener added with [`SessionStore::on_archived`].
    pub fn remove_archive_listener(&mut self, id: u64) {
        self.archive_listeners.retain(|(i, _)| *i != id);
    }

    /// `onErasure`.
    pub fn on_erasure(&mut self, listener: ErasureListener) -> u64 {
        self.next_listener += 1;
        self.erase_listeners.push((self.next_listener, listener));
        self.next_listener
    }

    /// Removes a listener added with [`SessionStore::on_erasure`].
    pub fn remove_erasure_listener(&mut self, id: u64) {
        self.erase_listeners.retain(|(i, _)| *i != id);
    }

    fn archived(&self, id: &str) {
        for (_, listener) in &self.archive_listeners {
            // Post-commit observer only; resource owners report their own errors.
            let _ = listener(id);
        }
    }

    pub(crate) fn next_token(&mut self) -> RewindToken {
        self.next_token += 1;
        RewindToken(self.next_token)
    }

    // ---- sessions -----------------------------------------------------------------------------------------------

    /// `createSession`. The id and the instant are drawn before the transaction (so a refused call still uses an id from
    /// a scripted source, as in TypeScript).
    pub fn create_session(
        &mut self,
        i: &CreateSessionInput,
    ) -> Result<SessionRecord, SessionError> {
        let title = validate_create(i)?;
        let now = self.env.now();
        let id = self.env.new_id("ses");
        let (record, archived) = self.tx(|_, c| create_session_in(c, i, &title, now, &id))?;
        if let Some(a) = archived {
            self.archived(&a);
        }
        Ok(record)
    }

    /// `createContinuation`: an immutable new direct chat plus a quoted user-context preamble in one transaction.
    pub fn create_continuation(
        &mut self,
        agent_id: &str,
        owner: &str,
        title: &str,
        context: &str,
    ) -> Result<SessionRecord, SessionError> {
        if utf16_len(context) > 8000 {
            return Err(SessionError::invalid("invalid continuation", "context"));
        }
        let input = CreateSessionInput {
            title: Some(title.to_owned()),
            ..CreateSessionInput::new(SessionKind::Direct, agent_id, owner)
        };
        let clean_title = validate_create(&input)?;
        let now = self.env.now();
        let id = self.env.new_id("ses");
        self.tx(|env, c| {
            let (session, _) = create_session_in(c, &input, &clean_title, now, &id)?;
            super::store_turns::insert_message_in(
                env,
                c,
                &session.id,
                None,
                MessageRole::User,
                context,
                (utf16_len(context) as i64 + 3) / 4,
            )?;
            Ok(session)
        })
    }

    /// `getSession`.
    pub fn get_session(&self, id: &str) -> Result<Option<SessionRecord>, SessionError> {
        get_session_in(self.conn(), id)
    }

    /// `activeForChat` (D21): the one active session of a chat, or `None`.
    pub fn active_for_chat(&self, chat_key: &str) -> Result<Option<SessionRecord>, SessionError> {
        q_one(
            self.conn(),
            "SELECT * FROM sessions WHERE chat_key = ? AND archived_at IS NULL",
            [chat_key],
            to_session,
        )
    }

    /// `getOwned`: someone else's session is `not-found`, never "forbidden".
    pub fn get_owned(&self, id: &str, owner: &str) -> Result<SessionRecord, SessionError> {
        match self.get_session(id)? {
            Some(s) if s.owner == owner => Ok(s),
            _ => Err(SessionError::not_found(
                &format!("session {id} not found"),
                Some("session"),
            )),
        }
    }

    /// `learningSessions`: bounded metadata selection, the time, owner and project predicates before `LIMIT`. No text.
    pub fn learning_sessions(
        &self,
        f: &LearningFilter,
    ) -> Result<Vec<SessionRecord>, SessionError> {
        let mut where_ = vec![
            "s.owner=?".to_owned(),
            "s.memory_mode='remember'".to_owned(),
            "EXISTS (SELECT 1 FROM turns t WHERE t.session_id=s.id AND t.state='completed' AND t.incognito=0 AND t.ended_at>=? AND t.ended_at<?)".to_owned(),
        ];
        let mut args: Vec<Value> = vec![
            text_of(&f.owner),
            Value::Integer(f.from),
            Value::Integer(f.to),
        ];
        if let Some(a) = f.agent_id.as_deref().filter(|a| !a.is_empty()) {
            where_.push("s.agent_id=?".into());
            args.push(text_of(a));
        }
        if let Some(p) = f.project_id.as_deref().filter(|p| !p.is_empty()) {
            where_.push("s.scope=?".into());
            args.push(text_of(p));
        }
        args.push(Value::Integer(f.limit.clamp(1, 51)));
        args.push(Value::Integer(f.offset.unwrap_or(0)));
        let sql = format!(
            "SELECT s.* FROM sessions s WHERE {} ORDER BY COALESCE(s.last_turn_at,s.updated_at) DESC,s.id LIMIT ? OFFSET ?",
            where_.join(" AND ")
        );
        q_all(
            self.conn(),
            &sql,
            plur1bus_store::rusqlite::params_from_iter(args.iter()),
            to_session,
        )
    }

    /// `listSessions`: pinned first, then the newest turn; `truncated` says a row beyond the limit exists.
    pub fn list_sessions(&self, f: &ListFilter) -> Result<SessionPage, SessionError> {
        let limit = clamp_limit(f.limit, MAX_LIMIT);
        let mut where_ = vec!["s.owner = ?".to_owned()];
        let mut args: Vec<Value> = vec![text_of(&f.owner)];
        if let Some(k) = f.kind {
            where_.push("s.kind = ?".into());
            args.push(text_of(k.as_str()));
        }
        if let Some(a) = f.agent_id.as_deref().filter(|a| !a.is_empty()) {
            where_.push("s.agent_id = ?".into());
            args.push(text_of(a));
        }
        archived_clause(f.archived, &mut where_);
        if let Some(search) = &f.search {
            let q = fts_query(search)?;
            where_.push(SEARCH_CLAUSE.replace("\n", " "));
            args.push(text_of(&q));
            args.push(text_of(&q));
        }
        args.push(Value::Integer(limit + 1));
        let sql = format!(
            "SELECT s.* FROM sessions s WHERE {} ORDER BY s.pinned DESC, COALESCE(s.last_turn_at, s.created_at) DESC, s.created_at DESC, s.id LIMIT ?",
            where_.join(" AND ")
        );
        page(
            q_all(
                self.conn(),
                &sql,
                plur1bus_store::rusqlite::params_from_iter(args.iter()),
                to_session,
            )?,
            limit,
        )
    }

    /// `listChatSessions`: a direct-chat keyset page, in the order both SQLite stores use. Visibility is filtered before
    /// `LIMIT`, so a hidden agent cannot truncate or starve a page.
    pub fn list_chat_sessions(&self, f: &ChatListFilter) -> Result<SessionPage, SessionError> {
        let limit = clamp_limit(f.filter.limit, MAX_LIMIT + 1);
        if f.allowed_agents.is_empty() {
            return Ok(SessionPage {
                sessions: Vec::new(),
                truncated: false,
            });
        }
        let marks = vec!["?"; f.allowed_agents.len()].join(",");
        let mut where_ = vec![
            "s.owner=?".to_owned(),
            "s.kind='direct'".to_owned(),
            format!("s.agent_id IN ({marks})"),
        ];
        let mut args: Vec<Value> = vec![text_of(&f.filter.owner)];
        args.extend(f.allowed_agents.iter().map(|a| text_of(a)));
        if let Some(a) = f.filter.agent_id.as_deref().filter(|a| !a.is_empty()) {
            where_.push("s.agent_id=?".into());
            args.push(text_of(a));
        }
        archived_clause(f.filter.archived, &mut where_);
        if let Some(search) = &f.filter.search {
            let q = fts_query(search)?;
            where_.push(SEARCH_CLAUSE.to_owned());
            args.push(text_of(&q));
            args.push(text_of(&q));
        }
        if let Some(after) = &f.after {
            where_.push("(s.pinned < ? OR (s.pinned = ? AND s.updated_at < ?) OR (s.pinned = ? AND s.updated_at = ? AND s.id > ?))".into());
            let pinned = i64::from(after.pinned);
            args.extend([
                Value::Integer(pinned),
                Value::Integer(pinned),
                Value::Integer(after.updated_at),
                Value::Integer(pinned),
                Value::Integer(after.updated_at),
                text_of(&after.id),
            ]);
        }
        args.push(Value::Integer(limit + 1));
        let sql = format!(
            "SELECT s.* FROM sessions s WHERE {} ORDER BY s.pinned DESC, s.updated_at DESC, s.id ASC LIMIT ?",
            where_.join(" AND ")
        );
        page(
            q_all(
                self.conn(),
                &sql,
                plur1bus_store::rusqlite::params_from_iter(args.iter()),
                to_session,
            )?,
            limit,
        )
    }

    /// `listOverview` (F42): metadata only; omitting the owner is allowed only by the admin RPC's role gate. No message
    /// or event payload leaves except the sums of `turn.completed` usage.
    pub fn list_overview(
        &self,
        f: &OverviewFilter,
    ) -> Result<(Vec<OverviewRow>, bool), SessionError> {
        let limit = clamp_limit(f.filter.limit, MAX_LIMIT);
        let mut where_ = vec!["1=1".to_owned()];
        let mut args: Vec<Value> = Vec::new();
        if let Some(o) = f.owner.as_deref().filter(|o| !o.is_empty()) {
            where_.push("s.owner=?".into());
            args.push(text_of(o));
        } else if let Some(owners) = &f.owners {
            if owners.is_empty() {
                return Ok((Vec::new(), false));
            }
            where_.push(format!(
                "s.owner IN ({})",
                vec!["?"; owners.len()].join(",")
            ));
            args.extend(owners.iter().map(|o| text_of(o)));
        }
        if let Some(k) = f.filter.kind {
            where_.push("s.kind=?".into());
            args.push(text_of(k.as_str()));
        }
        if let Some(a) = f.filter.agent_id.as_deref().filter(|a| !a.is_empty()) {
            where_.push("s.agent_id=?".into());
            args.push(text_of(a));
        }
        archived_clause(f.filter.archived, &mut where_);
        if let Some(search) = &f.filter.search {
            let q = fts_query(search)?;
            where_.push(SEARCH_CLAUSE.to_owned());
            args.push(text_of(&q));
            args.push(text_of(&q));
        }
        args.push(Value::Integer(limit + 1));
        let sql = format!(
            "SELECT s.* FROM sessions s WHERE {} ORDER BY s.pinned DESC,COALESCE(s.last_turn_at,s.created_at) DESC,s.created_at DESC,s.id LIMIT ?",
            where_.join(" AND ")
        );
        let rows = q_all(
            self.conn(),
            &sql,
            plur1bus_store::rusqlite::params_from_iter(args.iter()),
            to_session,
        )?;
        let truncated = rows.len() as i64 > limit;
        let mut out = Vec::new();
        for session in rows.into_iter().take(limit as usize) {
            // Existing turn.completed records contain provider/usage (tokens; there is no money dimension).
            let events = q_all(
                self.conn(),
                "SELECT data FROM events WHERE session_id=? AND type='turn.completed' ORDER BY seq",
                [session.id.as_str()],
                |r| r.get::<_, String>(0),
            )?;
            let (mut model, mut input, mut output): (Option<String>, i64, i64) = (None, 0, 0);
            for text in events {
                let d = J::parse(&text).ok_or_else(|| {
                    SessionError::new(
                        super::ErrorCode::Storage,
                        "event payload is unreadable",
                        Some("event-data"),
                    )
                })?;
                if let Some(m) = d.get("model").and_then(J::as_str) {
                    model = Some(m.to_owned());
                } else if let Some(p) = d.get("provider").and_then(J::as_str) {
                    model = Some(p.to_owned());
                }
                let count = |key: &str| -> i64 {
                    match d.get("usage").and_then(|u| u.get(key)) {
                        Some(J::Num(v))
                            if v.fract() == 0.0 && *v >= 0.0 && *v <= MAX_SAFE as f64 =>
                        {
                            *v as i64
                        }
                        _ => 0,
                    }
                };
                input = input.saturating_add(count("inputTokens"));
                output = output.saturating_add(count("outputTokens"));
            }
            out.push(OverviewRow {
                session,
                model,
                input_tokens: input,
                output_tokens: output,
            });
        }
        Ok((out, truncated))
    }

    /// `searchMessages`: message hits with a snippet over one owner's sessions, best first. Owner scoping is part of the
    /// query, not a post-filter.
    pub fn search_messages(
        &self,
        f: &ListFilter,
        search: &str,
    ) -> Result<Vec<SearchHit>, SessionError> {
        let limit = clamp_limit(f.limit, MAX_LIMIT);
        let mut where_ = vec!["s.owner = ?".to_owned()];
        let mut args: Vec<Value> = vec![text_of(&fts_query(search)?), text_of(&f.owner)];
        if let Some(k) = f.kind {
            where_.push("s.kind = ?".into());
            args.push(text_of(k.as_str()));
        }
        if let Some(a) = f.agent_id.as_deref().filter(|a| !a.is_empty()) {
            where_.push("s.agent_id = ?".into());
            args.push(text_of(a));
        }
        archived_clause(f.archived, &mut where_);
        args.push(Value::Integer(limit));
        let sql = format!(
            "SELECT m.session_id, m.id, m.seq, snippet(messages_fts, 0, '[', ']', '\u{2026}', 12) AS snip, bm25(messages_fts) AS rank,
       EXISTS(SELECT 1 FROM path_rewinds r WHERE r.session_id=m.session_id AND
         ((r.undone_at IS NULL AND m.seq BETWEEN r.hidden_from_seq AND r.hidden_to_seq)
           OR (r.undone_at IS NOT NULL AND m.id=r.lesson_message_id))) AS rewound
       FROM messages_fts JOIN messages m ON m.rowid = messages_fts.rowid JOIN sessions s ON s.id = m.session_id
       WHERE messages_fts MATCH ? AND {} ORDER BY rank LIMIT ?",
            where_.join(" AND ")
        );
        q_all(
            self.conn(),
            &sql,
            plur1bus_store::rusqlite::params_from_iter(args.iter()),
            |r| {
                Ok(SearchHit {
                    session_id: s(r, "session_id")?,
                    message_id: Some(s(r, "id")?),
                    seq: Some(n(r, "seq")?),
                    snippet: s(r, "snip")?,
                    rank: r.get("rank")?,
                    rewound: n(r, "rewound")? == 1,
                })
            },
        )
    }

    /// `updateSession`: only title, pinned and memory mode change (I1).
    pub fn update_session(
        &mut self,
        id: &str,
        patch: &SessionPatch,
    ) -> Result<SessionRecord, SessionError> {
        self.tx(|env, c| {
            let sess = get_session_in(c, id)?
                .ok_or_else(|| SessionError::not_found(&format!("session {id} not found"), Some("session")))?;
            if sess.archived_at.is_some() {
                return Err(SessionError::conflict(&format!("session {id} is archived"), "archived"));
            }
            let title = slice_units(patch.title.as_deref().unwrap_or(&sess.title), MAX_TITLE);
            let pinned = patch.pinned.unwrap_or(sess.pinned);
            let mode = patch.memory_mode.unwrap_or(sess.memory_mode);
            run(
                c,
                "UPDATE sessions SET title = ?, pinned = ?, memory_mode = ?, updated_at = ? WHERE id = ?",
                plur1bus_store::rusqlite::params![title, i64::from(pinned), mode.as_str(), env.now(), id],
            )?;
            Ok(get_session_in(c, id)?.unwrap_or(sess))
        })
    }

    /// `archiveSession`: archiving is the only delete a normal path has. Idempotent; a running turn blocks it.
    pub fn archive_session(&mut self, id: &str) -> Result<SessionRecord, SessionError> {
        let (record, changed) = self.tx(|env, c| {
            let sess = get_session_in(c, id)?.ok_or_else(|| {
                SessionError::not_found(&format!("session {id} not found"), Some("session"))
            })?;
            if sess.archived_at.is_some() {
                return Ok((sess, false));
            }
            if running_turn_in(c, id)?.is_some() {
                return Err(SessionError::conflict(
                    &format!("session {id} has a running turn"),
                    "turn-in-progress",
                ));
            }
            let now = env.now();
            run(
                c,
                "UPDATE sessions SET archived_at = ?, updated_at = ? WHERE id = ?",
                plur1bus_store::rusqlite::params![now, now, id],
            )?;
            Ok((get_session_in(c, id)?.unwrap_or(sess), true))
        })?;
        if changed {
            self.archived(id);
        }
        Ok(record)
    }

    /// `restoreSession`: only direct chats. The three statements are separate, as in TypeScript.
    pub fn restore_session(&mut self, id: &str) -> Result<SessionRecord, SessionError> {
        let session = self
            .get_session(id)?
            .ok_or_else(|| SessionError::not_found("session not found", None))?;
        if session.kind != SessionKind::Direct {
            return Err(SessionError::new(
                super::ErrorCode::Invalid,
                "only direct chats can be restored",
                None,
            ));
        }
        let now = self.env.now();
        self.tx(|_, c| {
            run(
                c,
                "UPDATE sessions SET archived_at=NULL,updated_at=? WHERE id=?",
                plur1bus_store::rusqlite::params![now, id],
            )
        })?;
        Ok(self.get_session(id)?.unwrap_or(session))
    }

    /// `forkSession`: copies the active path in one transaction; replayed historical messages never capture memory again.
    pub fn fork_session(
        &mut self,
        id: &str,
        title: Option<&str>,
        before_seq: Option<i64>,
    ) -> Result<SessionRecord, SessionError> {
        self.tx(|env, c| {
            let source = get_session_in(c, id)?
                .ok_or_else(|| SessionError::not_found("session not found", None))?;
            if source.kind != SessionKind::Direct {
                return Err(SessionError::new(
                    super::ErrorCode::Invalid,
                    "only direct chats can be forked",
                    None,
                ));
            }
            let input = CreateSessionInput {
                title: Some(title.unwrap_or(&source.title).to_owned()),
                memory_mode: Some(source.memory_mode),
                ..CreateSessionInput::new(SessionKind::Direct, &source.agent_id, &source.owner)
            };
            let clean = validate_create(&input)?;
            let now = env.now();
            let new_id = env.new_id("ses");
            let (next, _) = create_session_in(c, &input, &clean, now, &new_id)?;
            let lessons: HashSet<String> = super::store_misc::rewinds_in(c, id)?
                .into_iter()
                .filter_map(|r| r.lesson_message_id)
                .collect();
            for message in super::store_turns::context_messages_in(c, id, None)? {
                if before_seq.is_some_and(|b| message.seq > b) {
                    continue;
                }
                let role = if lessons.contains(&message.id) {
                    MessageRole::User
                } else {
                    message.role
                };
                super::store_turns::insert_message_in(
                    env,
                    c,
                    &next.id,
                    None,
                    role,
                    &message.text,
                    message.tokens,
                )?;
            }
            Ok(get_session_in(c, &next.id)?.unwrap_or(next))
        })
    }

    /// `eraseSession`: an explicit transcript erasure requires an archived session and leaves a content-free audit
    /// tombstone (ids and counts only). Private checkpoint rows survive until their native refs have been released.
    pub fn erase_session(
        &mut self,
        id: &str,
        actor: &str,
        reason: &str,
    ) -> Result<Erased, SessionError> {
        if actor.is_empty() || reason.is_empty() {
            return Err(SessionError::invalid(
                "an erasure needs an actor and a reason",
                "erasure-audit",
            ));
        }
        let result = self.tx(|env, c| {
            let sess = get_session_in(c, id)?
                .ok_or_else(|| SessionError::not_found(&format!("session {id} not found"), Some("session")))?;
            if sess.archived_at.is_none() {
                return Err(SessionError::conflict(
                    "erasure requires the session to be archived first (archive-first)",
                    "not-archived",
                ));
            }
            let messages = q_one(c, "SELECT COUNT(*) AS n FROM messages WHERE session_id = ?", [id], |r| {
                r.get::<_, i64>(0)
            })?
            .unwrap_or(0);
            let tombstone = env.new_id("era");
            run(
                c,
                "INSERT INTO erasures (id, session_id, agent_id, owner, kind, message_count, erased_at, actor, reason) VALUES (?,?,?,?,?,?,?,?,?)",
                plur1bus_store::rusqlite::params![
                    tombstone,
                    id,
                    sess.agent_id,
                    sess.owner,
                    sess.kind.as_str(),
                    messages,
                    env.now(),
                    actor,
                    reason
                ],
            )?;
            for t in ["path_rewinds", "summaries", "events", "messages", "turns"] {
                run(c, &format!("DELETE FROM {t} WHERE session_id = ?"), [id])?;
            }
            run(c, "DELETE FROM sessions WHERE id = ?", [id])?;
            Ok(Erased {
                tombstone_id: tombstone,
                messages,
            })
        })?;
        for (_, listener) in &self.erase_listeners {
            listener();
        }
        Ok(result)
    }

    /// `erasures`: the tombstones, oldest first.
    pub fn erasures(&self) -> Result<Vec<Erasure>, SessionError> {
        q_all(
            self.conn(),
            "SELECT * FROM erasures ORDER BY erased_at, id",
            [],
            |r| {
                Ok(Erasure {
                    id: s(r, "id")?,
                    session_id: s(r, "session_id")?,
                    owner: s(r, "owner")?,
                    message_count: n(r, "message_count")?,
                    actor: s(r, "actor")?,
                    reason: s(r, "reason")?,
                })
            },
        )
    }
}

fn page(mut rows: Vec<SessionRecord>, limit: i64) -> Result<SessionPage, SessionError> {
    let truncated = rows.len() as i64 > limit;
    rows.truncate(limit as usize);
    Ok(SessionPage {
        sessions: rows,
        truncated,
    })
}

/// The checks `createSession` makes before it opens a transaction; returns the title cut to 200 UTF-16 units.
fn validate_create(i: &CreateSessionInput) -> Result<String, SessionError> {
    if i.agent_id.is_empty() {
        return Err(SessionError::invalid("agentId is required", "agent"));
    }
    if i.owner.is_empty() {
        return Err(SessionError::invalid("owner is required", "owner"));
    }
    if i.kind == SessionKind::Channel && i.chat_key.as_deref().is_none_or(str::is_empty) {
        return Err(SessionError::invalid(
            "a channel session needs a chatKey",
            "chat-key",
        ));
    }
    if i.kind != SessionKind::Channel && i.chat_key.is_some() {
        return Err(SessionError::invalid(
            "only a channel session has a chatKey",
            "chat-key",
        ));
    }
    Ok(slice_units(i.title.as_deref().unwrap_or(""), MAX_TITLE))
}

/// The body of `createSession` inside its transaction. Returns the new session and the id of the session it archived.
pub(crate) fn create_session_in(
    c: &Connection,
    i: &CreateSessionInput,
    title: &str,
    now: i64,
    id: &str,
) -> Result<(SessionRecord, Option<String>), SessionError> {
    let mut archived_id = None;
    if let Some(chat_key) = &i.chat_key {
        let active = q_one(
            c,
            "SELECT id, owner FROM sessions WHERE chat_key = ? AND archived_at IS NULL",
            [chat_key.as_str()],
            |r| Ok((s(r, "id")?, s(r, "owner")?)),
        )?;
        if let Some((active_id, active_owner)) = active {
            // Replacing is archiving: only the session's own owner may do it (anyone else gets the plain "already active"
            // answer, no oracle beyond the one the non-replacing path already gives), and never under a running turn.
            if !i.replace_active || active_owner != i.owner {
                return Err(SessionError::conflict(
                    &format!("chat {chat_key} already has an active session"),
                    "active-chat-session",
                ));
            }
            if running_turn_in(c, &active_id)?.is_some() {
                return Err(SessionError::conflict(
                    &format!("session {active_id} has a running turn"),
                    "turn-in-progress",
                ));
            }
            run(
                c,
                "UPDATE sessions SET archived_at = ?, updated_at = ? WHERE id = ?",
                plur1bus_store::rusqlite::params![now, now, active_id],
            )?;
            archived_id = Some(active_id);
        }
    }
    run(
        c,
        "INSERT INTO sessions (id, kind, agent_id, owner, scope, chat_key, origin, title, memory_mode, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)",
        plur1bus_store::rusqlite::params![
            id,
            i.kind.as_str(),
            i.agent_id,
            i.owner,
            i.scope.as_deref().unwrap_or("user"),
            i.chat_key,
            i.origin.map(SessionOrigin::as_str),
            title,
            i.memory_mode.unwrap_or(MemoryMode::Remember).as_str(),
            now,
            now
        ],
    )?;
    let record =
        get_session_in(c, id)?.ok_or_else(|| SessionError::not_found("session not found", None))?;
    Ok((record, archived_id))
}

/// `MUTABLE` of `updateSession` at the JSON boundary: a patch naming any field but `title`, `pinned` and `memoryMode` is
/// `immutable` / `immutable-field`, never a silent drop.
pub fn patch_from_json(j: &J) -> Result<SessionPatch, SessionError> {
    let mut patch = SessionPatch::default();
    for (key, value) in j.members() {
        match key {
            "title" => patch.title = value.as_str().map(str::to_owned),
            "pinned" => {
                patch.pinned = match value {
                    J::Bool(b) => Some(*b),
                    _ => None,
                }
            }
            "memoryMode" => patch.memory_mode = value.as_str().and_then(MemoryMode::parse),
            other => {
                return Err(SessionError::new(
                    super::ErrorCode::Immutable,
                    format!("session field {other} is immutable (I1)"),
                    Some("immutable-field"),
                ))
            }
        }
    }
    Ok(patch)
}

/// The rewind ranges of a list of stored rewinds.
pub(crate) fn ranges(rewinds: &[RewindRecord]) -> Vec<RewindRange> {
    rewinds.iter().map(RewindRange::from).collect()
}

pub(crate) fn canonical_tool_names_ok(names: &[&str]) -> bool {
    names.iter().all(|n| is_canonical_tool_name(n))
}

pub(crate) fn default_message_before() -> i64 {
    MAX_SAFE
}
