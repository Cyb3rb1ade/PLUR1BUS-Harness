//! `collab/store.ts`: `state/collab.sqlite`, the one file of projects, members, agents, traces, spans, tasks, artifacts,
//! repeat marks and provisioned worktrees (the board lives in [`super::board`], on the same connection).
//!
//! **One writer, one file.** Every mutation that spans rows runs in one `BEGIN IMMEDIATE` transaction; the file is opened
//! with foreign keys on, a five-second busy timeout, WAL and `synchronous = NORMAL` (not for `:memory:`), then every missing
//! migration. A file from a newer core is refused with reason `schema-too-new` and left as it was. The file is made owner-only
//! through [`crate::private_store`] before SQLite touches it and again after the open.
//!
//! **What is not ported.** `CollabStore.team` (the team shell has no specification yet): the team tables exist (migration 9)
//! and stay empty.
//!
//! **Where the clock is read.** The TypeScript methods read the clock at fixed places (a method that fails early may have read
//! it already). The replay scripts a clock that advances on every read, so a different count of reads is a difference.
use super::errors::{CollabError, CollabErrorCode as C};
use super::ids::{traceparent, CollabIds};
use super::limits::{
    legacy_collab_settings, resolve_collab_limits, CollabLimits, CollaborationLimitsConfig,
};
use super::migrations::{MIGRATIONS, SCHEMA_VERSION};
use super::types::{
    task_status, CollabSpan, CollabTrace, DelegateTask, Project, ProjectMember, RepoBinding,
    PROJECT_ROLES,
};
use crate::approvals::js_json::J;
use crate::budget::Clock;
use crate::js::utf16_len;
use crate::private_store;
use plur1bus_store::rusqlite::{
    self, params_from_iter, types::Value as Sql, Connection, OptionalExtension, Row,
};
use plur1bus_store::{Journal, OwnerSpec, Schema, Store, StoreSpec, Synchronous};
use std::path::{Path, PathBuf};
use std::sync::Arc;

/// The result of a store call.
pub type R<T> = Result<T, CollabError>;

/// `TaskGrantEnd`: ends task-scoped grants when a collab task reaches a terminal status (D109 section 9.9). The return
/// operation is idempotent. Batch cancellation refuses to publish terminal task rows until every call succeeds.
pub trait TaskGrantEnd: Send + Sync {
    /// `endTask(taskId)`.
    fn end_task(&self, task_id: &str) -> Result<(), String>;
}

/// `logWarn`: a line for the operator log.
pub type WarnFn = Box<dyn Fn(&str) + Send + Sync>;

/// `StoreOptions`.
pub struct StoreOptions {
    /// The clock (`Date.now` in production).
    pub clock: Arc<dyn Clock>,
    /// Ids.
    pub ids: Arc<dyn CollabIds>,
    /// The live configuration of the limits; absent reads as the defaults.
    pub limits: Option<Box<dyn Fn() -> CollaborationLimitsConfig + Send + Sync>>,
    /// Ends task grants.
    pub grants: Option<Arc<dyn TaskGrantEnd>>,
    /// `logWarn`.
    pub log_warn: Option<WarnFn>,
}

impl StoreOptions {
    /// Options with the two ports every store needs.
    pub fn new(clock: Arc<dyn Clock>, ids: Arc<dyn CollabIds>) -> Self {
        Self {
            clock,
            ids,
            limits: None,
            grants: None,
            log_warn: None,
        }
    }
}

/// `WorktreeRow`.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct WorktreeRow {
    /// The id.
    pub id: String,
    /// The project.
    pub project_id: String,
    /// The root project.
    pub root_id: String,
    /// The card, when bound to one.
    pub card_id: Option<String>,
    /// The immutable `.git` directory.
    pub git_dir: Option<String>,
    /// The common git directory.
    pub common_git_dir: Option<String>,
    /// The device of the checkout.
    pub dev: Option<String>,
    /// The inode of the checkout.
    pub ino: Option<String>,
    /// The branch.
    pub branch: String,
    /// The path.
    pub path: String,
    /// The base commit.
    pub base_sha: String,
    /// Creation instant.
    pub created_at: i64,
    /// Removal instant.
    pub removed_at: Option<i64>,
}

impl WorktreeRow {
    /// The JSON shape of the TypeScript record.
    pub fn to_value(&self) -> serde_json::Value {
        serde_json::json!({
            "id": self.id, "projectId": self.project_id, "rootId": self.root_id, "cardId": self.card_id,
            "gitDir": self.git_dir, "commonGitDir": self.common_git_dir, "dev": self.dev, "ino": self.ino,
            "branch": self.branch, "path": self.path, "baseSha": self.base_sha, "createdAt": self.created_at,
            "removedAt": self.removed_at,
        })
    }
}

/// The input of `insertWorktree`.
#[derive(Clone, Debug, Default)]
pub struct NewWorktree {
    /// The project.
    pub project_id: String,
    /// The root project.
    pub root_id: String,
    /// The card.
    pub card_id: Option<String>,
    /// The branch.
    pub branch: String,
    /// The path.
    pub path: String,
    /// The base commit.
    pub base_sha: String,
    /// The `.git` directory.
    pub git_dir: Option<String>,
    /// The common git directory.
    pub common_git_dir: Option<String>,
    /// The device.
    pub dev: Option<String>,
    /// The inode.
    pub ino: Option<String>,
}

/// A stored artifact (`getArtifact`).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ArtifactRow {
    /// The id.
    pub id: String,
    /// The project.
    pub project_id: String,
    /// The body.
    pub body: String,
    /// The content type.
    pub content_type: String,
    /// Creation instant.
    pub created_at: i64,
}

/// The patch of `finishSpan`.
#[derive(Clone, Debug, Default)]
pub struct SpanPatch {
    /// The new status.
    pub status: String,
    /// The output preview (default empty).
    pub output_preview: Option<String>,
    /// The error text.
    pub error: Option<String>,
    /// The guardrail reason text.
    pub guardrail: Option<String>,
    /// Input tokens (default 0).
    pub input_tokens: Option<i64>,
    /// Output tokens (default 0).
    pub output_tokens: Option<i64>,
    /// The target kind.
    pub target_kind: Option<String>,
    /// `a2a`.
    pub origin: Option<String>,
}

/// The input of `insertTask`.
#[derive(Clone, Debug, Default)]
pub struct NewTask {
    /// The id.
    pub id: String,
    /// The project.
    pub project_id: String,
    /// The trace.
    pub trace_id: String,
    /// The span.
    pub span_id: String,
    /// The parent task.
    pub parent_task_id: Option<String>,
    /// The delegating agent.
    pub from_agent: String,
    /// The receiving agent.
    pub to_agent: String,
    /// `consult` or `delegate`.
    pub kind: String,
    /// The status.
    pub status: String,
    /// The task text.
    pub task: String,
    /// The acceptance criteria.
    pub acceptance: String,
    /// The path.
    pub path: Vec<String>,
}

/// The patch of `updateTask`: a field left out is written as `NULL` (or `0`/empty), as the TypeScript `UPDATE` does.
#[derive(Clone, Debug, Default)]
pub struct TaskPatch {
    /// The new status.
    pub status: String,
    /// The capped result.
    pub result: Option<String>,
    /// Whether it was cut.
    pub truncated: bool,
    /// The artifact.
    pub artifact_id: Option<String>,
    /// The error.
    pub error: Option<String>,
    /// Input tokens.
    pub input_tokens: Option<i64>,
    /// Output tokens.
    pub output_tokens: Option<i64>,
    /// The target kind.
    pub target_kind: Option<String>,
    /// `a2a`.
    pub origin: Option<String>,
}

/// `CollabStore`.
pub struct CollabStore {
    db: Option<Store>,
    writer_slot_dir: Option<PathBuf>,
    pub(crate) clock: Arc<dyn Clock>,
    pub(crate) ids: Arc<dyn CollabIds>,
    grants: Option<Arc<dyn TaskGrantEnd>>,
    log_warn: Option<WarnFn>,
    limits: Option<Box<dyn Fn() -> CollaborationLimitsConfig + Send + Sync>>,
}

/// The legacy defaults a versionless settings object inherited (owner ruling 2026-11-01).
const LEGACY: [(&str, f64); 6] = [
    ("maxDepth", 1.0),
    ("maxFanout", 3.0),
    ("maxPairPerTurn", 2.0),
    ("maxTurns", 25.0),
    ("timeoutMs", 300_000.0),
    ("returnTokens", 2000.0),
];

/// `JSON.parse(raw)`: a text TypeScript cannot parse is a plain `Error`; `null` makes the next property read a `TypeError`.
fn parse_settings(raw: &str) -> R<J> {
    match J::parse(raw) {
        None => Err(CollabError::raw("settings do not parse")),
        Some(J::Null) => Err(CollabError::raw("settings are null")),
        Some(other) => Ok(other),
    }
}

/// `normalizedSettings(raw)`: versionless JSON inherited the old defaults; version 2 preserves every explicit value.
pub(crate) fn normalized_settings(raw: &str) -> R<J> {
    let mut settings = parse_settings(raw)?;
    if settings.get("settingsVersion") == Some(&J::Num(2.0)) {
        return Ok(settings);
    }
    if let J::Obj(m) = &mut settings {
        for (key, legacy) in LEGACY {
            if m.iter().any(|(k, v)| k == key && *v == J::Num(legacy)) {
                m.retain(|(k, _)| k != key);
            }
        }
    }
    Ok(settings)
}

/// JavaScript truthiness of a parsed value.
fn truthy(v: &J) -> bool {
    match v {
        J::Null => false,
        J::Bool(b) => *b,
        J::Num(n) => *n != 0.0 && !n.is_nan(),
        J::Str(s) => !s.is_empty(),
        J::Arr(_) | J::Obj(_) => true,
    }
}

/// `{ ...normalized, ...changes, settingsVersion: 2 }` as the stored text.
fn settings_json(raw: &str, changes: &J) -> R<String> {
    let mut merged = normalized_settings(raw)?;
    if !matches!(merged, J::Obj(_)) {
        merged = J::Obj(Vec::new());
    }
    for (k, v) in changes.members() {
        merged.set(k, v.clone());
    }
    merged.set("settingsVersion", J::Num(2.0));
    Ok(merged.stringify())
}

fn opt_int(row: &Row<'_>, name: &str) -> R<Option<i64>> {
    Ok(row.get::<_, Option<i64>>(name)?)
}

fn opt_str(row: &Row<'_>, name: &str) -> R<Option<String>> {
    Ok(row.get::<_, Option<String>>(name)?)
}

fn to_worktree(r: &Row<'_>) -> R<WorktreeRow> {
    Ok(WorktreeRow {
        id: r.get("id")?,
        project_id: r.get("project_id")?,
        root_id: r.get("root_id")?,
        card_id: opt_str(r, "card_id")?,
        git_dir: opt_str(r, "git_dir")?,
        common_git_dir: opt_str(r, "common_git_dir")?,
        dev: opt_str(r, "device")?,
        ino: opt_str(r, "inode")?,
        branch: r.get("branch")?,
        path: r.get("path")?,
        base_sha: r.get("base_sha")?,
        created_at: r.get("created_at")?,
        removed_at: opt_int(r, "removed_at")?,
    })
}

fn to_span(r: &Row<'_>) -> R<CollabSpan> {
    let origin = opt_str(r, "origin")?;
    let target_kind = opt_str(r, "target_kind")?.filter(|s| !s.is_empty());
    let session_id = opt_str(r, "session_id")?.filter(|s| !s.is_empty());
    Ok(CollabSpan {
        origin_a2a: origin.as_deref() == Some("a2a"),
        target_kind,
        session_id,
        span_id: r.get("span_id")?,
        trace_id: r.get("trace_id")?,
        parent_span_id: opt_str(r, "parent_span_id")?,
        agent_id: r.get("agent_id")?,
        kind: r.get("kind")?,
        started_at: r.get("started_at")?,
        ended_at: opt_int(r, "ended_at")?,
        status: r.get("status")?,
        input_tokens: r.get("input_tokens")?,
        output_tokens: r.get("output_tokens")?,
        input_preview: r.get("input_preview")?,
        output_preview: r.get("output_preview")?,
        error: opt_str(r, "error")?,
        guardrail: opt_str(r, "guardrail")?,
    })
}

fn to_task(r: &Row<'_>) -> R<DelegateTask> {
    let origin = opt_str(r, "origin")?;
    let artifact_id = opt_str(r, "result_artifact_id")?;
    let path_text: String = r.get("path")?;
    let path = match J::parse(&path_text) {
        Some(J::Arr(items)) => items
            .iter()
            .map(|v| v.as_str().map(str::to_owned))
            .collect::<Option<Vec<_>>>()
            .ok_or_else(|| CollabError::raw("a task path holds a value that is not a string"))?,
        _ => return Err(CollabError::raw("a task path does not parse")),
    };
    let (it, ot) = (opt_int(r, "input_tokens")?, opt_int(r, "output_tokens")?);
    Ok(DelegateTask {
        origin_a2a: origin.as_deref() == Some("a2a"),
        target_kind: opt_str(r, "target_kind")?.filter(|s| !s.is_empty()),
        id: r.get("id")?,
        project_id: r.get("project_id")?,
        trace_id: r.get("trace_id")?,
        span_id: r.get("span_id")?,
        parent_task_id: opt_str(r, "parent_task_id")?,
        from_agent: r.get("from_agent")?,
        to_agent: r.get("to_agent")?,
        status: r.get("status")?,
        task: r.get("task")?,
        acceptance_criteria: r.get("acceptance")?,
        result: opt_str(r, "result_capped")?,
        truncated: r.get::<_, i64>("truncated")? == 1,
        artifact_pointer: artifact_id
            .as_ref()
            .filter(|s| !s.is_empty())
            .map(|a| format!("artifact:{a}")),
        artifact_id,
        error: opt_str(r, "error")?,
        path,
        created_at: r.get("created_at")?,
        started_at: opt_int(r, "started_at")?,
        ended_at: opt_int(r, "ended_at")?,
        usage: if it.is_none() && ot.is_none() {
            None
        } else {
            Some(super::types::Cost {
                input_tokens: it.unwrap_or(0),
                output_tokens: ot.unwrap_or(0),
            })
        },
    })
}

/// `#project(id)` over any connection: the project with its members and agents, settings resolved.
pub(crate) fn project_in(
    c: &Connection,
    config: &CollaborationLimitsConfig,
    id: &str,
) -> R<Option<Project>> {
    let mut st = c.prepare("SELECT * FROM projects WHERE id = ?")?;
    let mut rows = st.query([id])?;
    let Some(r) = rows.next()? else {
        return Ok(None);
    };
    let mut members = Vec::new();
    {
        let mut m = c.prepare(
            "SELECT user_id, role FROM project_members WHERE project_id = ? ORDER BY user_id",
        )?;
        let mut mr = m.query([id])?;
        while let Some(x) = mr.next()? {
            members.push(ProjectMember {
                user_id: x.get("user_id")?,
                role: x.get("role")?,
            });
        }
    }
    let mut agents = Vec::new();
    {
        let mut a = c.prepare(
            "SELECT agent_id FROM project_agents WHERE project_id = ? ORDER BY agent_id",
        )?;
        let mut ar = a.query([id])?;
        while let Some(x) = ar.next()? {
            agents.push(x.get::<_, String>("agent_id")?);
        }
    }
    let raw: String = r.get("settings")?;
    let normalized = normalized_settings(&raw)?;
    let mut settings = legacy_collab_settings(&resolve_collab_limits(config, &normalized));
    if let Some(c) = normalized.get("collaboration").filter(|v| truthy(v)) {
        settings.collaboration = Some(c.clone());
    }
    let repo_path = opt_str(r, "repo_path")?;
    let base_branch = opt_str(r, "base_branch")?;
    Ok(Some(Project {
        id: r.get("id")?,
        name: r.get("name")?,
        owner: r.get("owner")?,
        members,
        agents,
        settings,
        created_at: r.get("created_at")?,
        updated_at: r.get("updated_at")?,
        archived_at: opt_int(r, "archived_at")?,
        repo: match (repo_path, base_branch) {
            (Some(p), Some(b)) if !p.is_empty() && !b.is_empty() => Some(RepoBinding {
                repo_path: p,
                base_branch: b,
            }),
            _ => None,
        },
    }))
}

/// `#live(id)` over any connection.
pub(crate) fn live_in(c: &Connection, config: &CollaborationLimitsConfig, id: &str) -> R<Project> {
    let Some(p) = project_in(c, config, id)? else {
        return Err(CollabError::with_reason(
            C::NotFound,
            format!("project {id} not found"),
            "project",
        ));
    };
    if p.archived_at.is_some() {
        return Err(CollabError::with_reason(
            C::Archived,
            format!("project {id} is archived"),
            "archived",
        ));
    }
    Ok(p)
}

fn settings_text(c: &Connection, id: &str) -> R<String> {
    c.query_row("SELECT settings FROM projects WHERE id = ?", [id], |r| {
        r.get::<_, String>(0)
    })
    .map_err(|_| CollabError::raw("project settings are missing"))
}

/// `#touch`: `updated_at` and the normalization marker.
fn touch(c: &Connection, id: &str, now: i64) -> R<()> {
    let text = settings_json(&settings_text(c, id)?, &J::Obj(Vec::new()))?;
    c.execute(
        "UPDATE projects SET updated_at = ?, settings = ? WHERE id = ?",
        rusqlite::params![now, text, id],
    )?;
    Ok(())
}

impl CollabStore {
    /// `new CollabStore({ path, ... })`. A file is made owner-only first and again after the open.
    pub fn open(path: &Path, o: StoreOptions) -> R<Self> {
        let memory = path == Path::new(":memory:");
        if !memory {
            private_store::prepare(path)
                .map_err(|e| CollabError::raw(format!("cannot prepare the collab store: {e}")))?;
        }
        let owner = OwnerSpec {
            store: StoreSpec {
                synchronous: if memory {
                    Synchronous::Default
                } else {
                    Synchronous::Normal
                },
                ..StoreSpec::new("collab", SCHEMA_VERSION)
            },
            journal: if memory {
                Journal::Unchanged
            } else {
                Journal::Wal
            },
            schema: Schema::Steps(MIGRATIONS),
            create: true,
        };
        let db = Store::open_owner(path, &owner)?;
        if !memory {
            // Best effort, as in TypeScript: the home directory is 0700 and the platform may have no mode bits.
            let _ = private_store::default_secure(path);
        }
        let writer_slot_dir = if memory {
            None
        } else {
            let mut directory = path
                .canonicalize()
                .map_err(|_| {
                    CollabError::new(
                        C::Storage,
                        "cannot resolve collaboration store for writer slots",
                    )
                })?
                .into_os_string();
            directory.push(".writer-slots");
            Some(PathBuf::from(directory))
        };
        Ok(Self {
            db: Some(db),
            writer_slot_dir,
            clock: o.clock,
            ids: o.ids,
            grants: o.grants,
            log_warn: o.log_warn,
            limits: o.limits,
        })
    }

    /// `close()`: idempotent.
    pub fn close(&mut self) {
        self.db = None;
    }

    /// Whether `close` ran.
    pub fn is_closed(&self) -> bool {
        self.db.is_none()
    }

    /// `now()`.
    pub fn now(&self) -> i64 {
        self.clock.now()
    }

    /// `id(prefix)`.
    pub fn id(&self, prefix: &str) -> String {
        self.ids.new_id(prefix)
    }

    pub(crate) fn conn(&self) -> R<&Connection> {
        self.db
            .as_ref()
            .map(Store::conn)
            .ok_or_else(|| CollabError::raw("database is not open"))
    }

    pub(crate) fn config(&self) -> CollaborationLimitsConfig {
        self.limits.as_ref().map_or_else(Default::default, |f| f())
    }

    /// `PRAGMA user_version`.
    pub fn user_version(&self) -> R<u32> {
        Ok(self.db.as_ref().map_or(Ok(0), |s| s.user_version())?)
    }

    /// `#tx`: `BEGIN IMMEDIATE`, commit on `Ok`, roll back on `Err`.
    pub(crate) fn tx<T>(&self, f: impl FnOnce(&Connection) -> R<T>) -> R<T> {
        use rusqlite::{Transaction, TransactionBehavior};
        let tx = Transaction::new_unchecked(self.conn()?, TransactionBehavior::Immediate)?;
        let result = f(&tx)?;
        tx.commit()?;
        Ok(result)
    }

    pub(crate) fn has_shared_writer_slots(&self) -> bool {
        self.writer_slot_dir.is_some()
    }

    pub(crate) fn reserve_writer_slot(
        &self,
        project: &str,
        local: bool,
        project_limit: i64,
        local_limit: Option<f64>,
    ) -> R<Option<private_store::AdvisoryLease>> {
        let directory = self.writer_slot_dir.as_deref().ok_or_else(|| {
            CollabError::new(C::Storage, "shared writer slot storage is unavailable")
        })?;
        self.tx(|_| {
            super::writer_slots::reserve(directory, project, local, project_limit, local_limit)
        })
    }

    /// A raw read for the replay (`sql` ops): every row as JSON values.
    pub fn query_rows(
        &self,
        sql: &str,
        args: &[serde_json::Value],
    ) -> R<Vec<Vec<serde_json::Value>>> {
        let c = self.conn()?;
        let mut st = c.prepare(sql)?;
        let n = st.column_count();
        let params: Vec<Sql> = args
            .iter()
            .map(|a| match a {
                serde_json::Value::Null => Sql::Null,
                serde_json::Value::String(s) => Sql::Text(s.clone()),
                serde_json::Value::Number(x) => x
                    .as_i64()
                    .map_or_else(|| Sql::Real(x.as_f64().unwrap_or(0.0)), Sql::Integer),
                other => Sql::Text(other.to_string()),
            })
            .collect();
        let mut rows = st.query(params_from_iter(params))?;
        let mut out = Vec::new();
        while let Some(r) = rows.next()? {
            let mut row = Vec::with_capacity(n);
            for i in 0..n {
                row.push(match r.get_ref(i)? {
                    rusqlite::types::ValueRef::Null => serde_json::Value::Null,
                    rusqlite::types::ValueRef::Integer(v) => serde_json::Value::from(v),
                    rusqlite::types::ValueRef::Real(v) => crate::approvals::js_json::num_value(v),
                    rusqlite::types::ValueRef::Text(t) => {
                        serde_json::Value::String(String::from_utf8_lossy(t).into_owned())
                    }
                    rusqlite::types::ValueRef::Blob(_) => serde_json::Value::Null,
                });
            }
            out.push(row);
        }
        Ok(out)
    }

    // ---- projects ------------------------------------------------------------------------------------------------

    /// `createProject`: the owner becomes lead; `settings` is the stored object a caller passes (any keys, kept in order).
    pub fn create_project(
        &self,
        name: &str,
        owner: &str,
        settings: Option<&J>,
        id: Option<&str>,
    ) -> R<Project> {
        let name = crate::js::js_trim(name);
        if name.is_empty() {
            return Err(CollabError::with_reason(
                C::Invalid,
                "project name is required",
                "name",
            ));
        }
        if utf16_len(name) > 256 {
            return Err(CollabError::with_reason(
                C::Invalid,
                "project name is too long",
                "name",
            ));
        }
        if owner.is_empty() {
            return Err(CollabError::with_reason(
                C::Invalid,
                "owner is required",
                "owner",
            ));
        }
        let now = self.clock.now();
        let id = id.map_or_else(|| self.ids.new_id("prj"), str::to_owned);
        let mut stored = match settings {
            Some(J::Obj(m)) => J::Obj(m.clone()),
            _ => J::Obj(Vec::new()),
        };
        stored.set("settingsVersion", J::Num(2.0));
        let config = self.config();
        self.tx(|c| {
            c.execute(
                "INSERT INTO projects (id, name, owner, settings, created_at, updated_at) VALUES (?,?,?,?,?,?)",
                rusqlite::params![id, name, owner, stored.stringify(), now, now],
            )?;
            c.execute(
                "INSERT INTO project_members (project_id, user_id, role, added_at) VALUES (?,?,?,?)",
                rusqlite::params![id, owner, "lead", now],
            )?;
            project_in(c, &config, &id)?.ok_or_else(|| CollabError::raw("project vanished"))
        })
    }

    /// `updateProject(id, name)`.
    pub fn update_project(&self, id: &str, name: &str) -> R<Project> {
        let trimmed = crate::js::js_trim(name);
        if trimmed.is_empty() || utf16_len(trimmed) > 256 {
            return Err(CollabError::with_reason(
                C::Invalid,
                "invalid project name",
                "name",
            ));
        }
        let config = self.config();
        self.tx(|c| {
            let Some(p) = project_in(c, &config, id)? else {
                return Err(CollabError::new(C::NotFound, "project not found"));
            };
            if p.archived_at.is_some() {
                return Err(CollabError::with_reason(
                    C::Archived,
                    format!("project {id} is archived"),
                    "archived",
                ));
            }
            let text = settings_json(&settings_text(c, id)?, &J::Obj(Vec::new()))?;
            c.execute(
                "UPDATE projects SET name = ?, updated_at = ?, settings = ? WHERE id = ?",
                rusqlite::params![trimmed, self.clock.now(), text, id],
            )?;
            project_in(c, &config, id)?.ok_or_else(|| CollabError::raw("project vanished"))
        })
    }

    /// `getProject`.
    pub fn get_project(&self, id: &str) -> R<Option<Project>> {
        project_in(self.conn()?, &self.config(), id)
    }

    /// `limits(id)`: resolved against the raw overrides, so a consult default does not cap a code-large delegation.
    pub fn limits(&self, id: &str) -> R<CollabLimits> {
        let c = self.conn()?;
        let raw: Option<String> = c
            .query_row("SELECT settings FROM projects WHERE id = ?", [id], |r| {
                r.get(0)
            })
            .ok();
        let Some(raw) = raw else {
            return Err(CollabError::new(C::NotFound, "project not found"));
        };
        Ok(resolve_collab_limits(
            &self.config(),
            &normalized_settings(&raw)?,
        ))
    }

    /// `setSettings(id, changes)`: an intentional settings change and the normalization marker, atomically.
    pub fn set_settings(&self, id: &str, changes: &J) -> R<Project> {
        let config = self.config();
        self.tx(|c| {
            live_in(c, &config, id)?;
            let text = settings_json(&settings_text(c, id)?, changes)?;
            c.execute(
                "UPDATE projects SET settings = ?, updated_at = ? WHERE id = ?",
                rusqlite::params![text, self.clock.now(), id],
            )?;
            project_in(c, &config, id)?.ok_or_else(|| CollabError::raw("project vanished"))
        })
    }

    /// `listProjects`: oldest first.
    pub fn list_projects(&self) -> R<Vec<Project>> {
        let c = self.conn()?;
        let config = self.config();
        let ids: Vec<String> = {
            let mut st = c.prepare("SELECT id FROM projects ORDER BY created_at, id")?;
            let rows = st.query_map([], |r| r.get::<_, String>(0))?;
            rows.collect::<Result<_, _>>()?
        };
        ids.iter()
            .map(|id| {
                project_in(c, &config, id)?.ok_or_else(|| CollabError::raw("project vanished"))
            })
            .collect()
    }

    /// `archiveProject`: idempotent, the second call returns the project as it is.
    pub fn archive_project(&self, id: &str) -> R<Project> {
        let now = self.clock.now();
        let config = self.config();
        self.tx(|c| {
            let Some(p) = project_in(c, &config, id)? else {
                return Err(CollabError::with_reason(
                    C::NotFound,
                    format!("project {id} not found"),
                    "project",
                ));
            };
            if p.archived_at.is_some() {
                return Ok(p);
            }
            let text = settings_json(&settings_text(c, id)?, &J::Obj(Vec::new()))?;
            c.execute(
                "UPDATE projects SET archived_at = ?, updated_at = ?, settings = ? WHERE id = ?",
                rusqlite::params![now, now, text, id],
            )?;
            project_in(c, &config, id)?.ok_or_else(|| CollabError::raw("project vanished"))
        })
    }

    /// `addMember`: the owner must stay lead.
    pub fn add_member(&self, project_id: &str, user_id: &str, role: &str) -> R<Project> {
        if user_id.is_empty() {
            return Err(CollabError::with_reason(
                C::Invalid,
                "userId is required",
                "userId",
            ));
        }
        if !PROJECT_ROLES.contains(&role) {
            return Err(CollabError::with_reason(
                C::Invalid,
                "unknown project role",
                "role",
            ));
        }
        let now = self.clock.now();
        let config = self.config();
        self.tx(|c| {
            let p = live_in(c, &config, project_id)?;
            if user_id == p.owner && role != "lead" {
                return Err(CollabError::with_reason(
                    C::Conflict,
                    "the project owner must remain lead",
                    "owner",
                ));
            }
            c.execute(
                "INSERT INTO project_members (project_id, user_id, role, added_at) VALUES (?,?,?,?) ON CONFLICT(project_id, user_id) DO UPDATE SET role = excluded.role",
                rusqlite::params![project_id, user_id, role, now],
            )?;
            touch(c, project_id, now)?;
            project_in(c, &config, &p.id)?.ok_or_else(|| CollabError::raw("project vanished"))
        })
    }

    /// `removeMember`: the owner cannot be removed; the person's board assignments end with the membership.
    pub fn remove_member(&self, project_id: &str, user_id: &str) -> R<Project> {
        let now = self.clock.now();
        let config = self.config();
        self.tx(|c| {
            let p = live_in(c, &config, project_id)?;
            if user_id == p.owner {
                return Err(CollabError::with_reason(
                    C::Conflict,
                    "the project owner cannot be removed",
                    "owner",
                ));
            }
            c.execute(
                "DELETE FROM project_members WHERE project_id = ? AND user_id = ?",
                rusqlite::params![project_id, user_id],
            )?;
            self.release_assignee_in(c, &config, project_id, "person", user_id)?;
            touch(c, project_id, now)?;
            project_in(c, &config, project_id)?.ok_or_else(|| CollabError::raw("project vanished"))
        })
    }

    /// `addAgent`: idempotent.
    pub fn add_agent(&self, project_id: &str, agent_id: &str) -> R<Project> {
        if agent_id.is_empty() {
            return Err(CollabError::with_reason(
                C::Invalid,
                "agentId is required",
                "agentId",
            ));
        }
        let now = self.clock.now();
        let config = self.config();
        self.tx(|c| {
            live_in(c, &config, project_id)?;
            c.execute(
                "INSERT OR IGNORE INTO project_agents (project_id, agent_id, added_at) VALUES (?,?,?)",
                rusqlite::params![project_id, agent_id, now],
            )?;
            touch(c, project_id, now)?;
            project_in(c, &config, project_id)?.ok_or_else(|| CollabError::raw("project vanished"))
        })
    }

    /// `removeAgent`: the agent's board assignments end with the assignment to the project.
    pub fn remove_agent(&self, project_id: &str, agent_id: &str) -> R<Project> {
        let now = self.clock.now();
        let config = self.config();
        self.tx(|c| {
            live_in(c, &config, project_id)?;
            c.execute(
                "DELETE FROM project_agents WHERE project_id = ? AND agent_id = ?",
                rusqlite::params![project_id, agent_id],
            )?;
            self.release_assignee_in(c, &config, project_id, "agent", agent_id)?;
            touch(c, project_id, now)?;
            project_in(c, &config, project_id)?.ok_or_else(|| CollabError::raw("project vanished"))
        })
    }

    /// `setRepo`: persists a binding already checked by `assertRepoBinding`.
    pub fn set_repo(&self, id: &str, repo: &RepoBinding) -> R<Project> {
        let config = self.config();
        self.tx(|c| {
            live_in(c, &config, id)?;
            if c.query_row(
                "SELECT 1 FROM project_worktrees WHERE project_id = ? AND removed_at IS NULL",
                [id],
                |_| Ok(()),
            )
            .optional()?
            .is_some()
            {
                return Err(CollabError::with_reason(
                    C::Conflict,
                    "remove live worktrees before rebinding",
                    "worktree-live",
                ));
            }
            c.execute(
                "UPDATE projects SET repo_path = ?, base_branch = ?, updated_at = ? WHERE id = ?",
                rusqlite::params![repo.repo_path, repo.base_branch, self.clock.now(), id],
            )?;
            project_in(c, &config, id)?.ok_or_else(|| CollabError::raw("project vanished"))
        })
    }

    /// `clearRepo`.
    pub fn clear_repo(&self, id: &str) -> R<Project> {
        let config = self.config();
        self.tx(|c| {
            live_in(c, &config, id)?;
            let live = live_worktree_in(c, id, None)?.is_some()
                || c.query_row(
                    "SELECT 1 AS n FROM project_worktrees WHERE project_id = ? AND removed_at IS NULL",
                    [id],
                    |_| Ok(()),
                )
                .optional()?.is_some();
            if live {
                return Err(CollabError::with_reason(
                    C::Conflict,
                    "remove the worktree before unbinding the repository",
                    "worktree-live",
                ));
            }
            c.execute(
                "UPDATE projects SET repo_path = NULL, base_branch = NULL, updated_at = ? WHERE id = ?",
                rusqlite::params![self.clock.now(), id],
            )?;
            project_in(c, &config, id)?.ok_or_else(|| CollabError::raw("project vanished"))
        })
    }

    // ---- worktrees -----------------------------------------------------------------------------------------------

    /// `insertWorktree`: `None` is what TypeScript's `liveWorktree(...)!` returns for a card id of `""` (which its query reads
    /// as "no card" while the row stores the empty string).
    pub fn insert_worktree(&self, i: &NewWorktree) -> R<Option<WorktreeRow>> {
        let id = self.ids.new_id("wt");
        let now = self.clock.now();
        let c = self.conn()?;
        c.execute(
            "INSERT INTO project_worktrees (id, project_id, root_id, card_id, branch, path, base_sha, created_at, git_dir, common_git_dir, device, inode) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)",
            rusqlite::params![id, i.project_id, i.root_id, i.card_id, i.branch, i.path, i.base_sha, now, i.git_dir, i.common_git_dir, i.dev, i.ino],
        )?;
        self.live_worktree(&i.project_id, i.card_id.as_deref())
    }

    /// `liveWorktree`: a card id that is `""` reads as none (`cardId ? ... : ...`).
    pub fn live_worktree(&self, project_id: &str, card_id: Option<&str>) -> R<Option<WorktreeRow>> {
        live_worktree_in(self.conn()?, project_id, card_id)
    }

    /// `previousWorktree`: the latest provisioner-owned record, including removed checkouts whose branch is retained.
    pub fn previous_worktree(
        &self,
        project_id: &str,
        card_id: Option<&str>,
    ) -> R<Option<WorktreeRow>> {
        let c = self.conn()?;
        let mut st = c.prepare(
            "SELECT * FROM project_worktrees WHERE project_id = ? AND card_id IS ? ORDER BY rowid DESC LIMIT 1",
        )?;
        let mut rows = st.query(rusqlite::params![project_id, card_id])?;
        rows.next()?.map(to_worktree).transpose()
    }

    /// `worktreeAt(path)`: trusted metadata lookup; never reads the checkout's `.git` pointer.
    pub fn worktree_at(&self, path: &str) -> R<Option<WorktreeRow>> {
        let c = self.conn()?;
        let mut st =
            c.prepare("SELECT * FROM project_worktrees WHERE path = ? AND removed_at IS NULL")?;
        let mut rows = st.query([path])?;
        rows.next()?.map(to_worktree).transpose()
    }

    /// `markWorktreeRemoved`: the clock is read first, as in TypeScript.
    pub fn mark_worktree_removed(&self, project_id: &str, card_id: Option<&str>) -> R<()> {
        let now = self.clock.now();
        let c = self.conn()?;
        match card_id.filter(|s| !s.is_empty()) {
            Some(card) => c.execute(
                "UPDATE project_worktrees SET removed_at = ? WHERE project_id = ? AND card_id = ? AND removed_at IS NULL",
                rusqlite::params![now, project_id, card],
            )?,
            None => c.execute(
                "UPDATE project_worktrees SET removed_at = ? WHERE project_id = ? AND card_id IS NULL AND removed_at IS NULL",
                rusqlite::params![now, project_id],
            )?,
        };
        Ok(())
    }

    // ---- artifacts, repeats --------------------------------------------------------------------------------------

    /// `putArtifact`: the body is kept in full; the pointer is `artifact:<id>`.
    pub fn put_artifact(
        &self,
        project_id: &str,
        body: &str,
        content_type: Option<&str>,
    ) -> R<(String, String)> {
        let id = self.ids.new_id("art");
        let now = self.clock.now();
        self.conn()?.execute(
            "INSERT INTO artifacts (id, project_id, body, content_type, created_at) VALUES (?,?,?,?,?)",
            rusqlite::params![id, project_id, body, content_type.unwrap_or("text/plain"), now],
        )?;
        let pointer = format!("artifact:{id}");
        Ok((id, pointer))
    }

    /// `getArtifact`.
    pub fn get_artifact(&self, id: &str) -> R<Option<ArtifactRow>> {
        let c = self.conn()?;
        let mut st = c.prepare("SELECT * FROM artifacts WHERE id = ?")?;
        let mut rows = st.query([id])?;
        let Some(r) = rows.next()? else {
            return Ok(None);
        };
        Ok(Some(ArtifactRow {
            id: r.get("id")?,
            project_id: r.get("project_id")?,
            body: r.get("body")?,
            content_type: r.get("content_type")?,
            created_at: r.get("created_at")?,
        }))
    }

    /// `lastRepeat(key)`.
    pub fn last_repeat(&self, key: &str) -> R<Option<i64>> {
        let c = self.conn()?;
        let mut st = c.prepare("SELECT at FROM repeats WHERE key = ?")?;
        let mut rows = st.query([key])?;
        rows.next()?.map(|r| Ok(r.get::<_, i64>(0)?)).transpose()
    }

    /// `rememberRepeat(key, at)`.
    pub fn remember_repeat(&self, key: &str, at: i64) -> R<()> {
        self.conn()?.execute(
            "INSERT INTO repeats (key, at) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET at = excluded.at",
            rusqlite::params![key, at],
        )?;
        Ok(())
    }

    // ---- traces, spans -------------------------------------------------------------------------------------------

    /// `insertTrace`.
    pub fn insert_trace(
        &self,
        trace_id: &str,
        project_id: &str,
        root_agent: &str,
        root_span_id: &str,
        status: Option<&str>,
    ) -> R<()> {
        let now = self.clock.now();
        self.conn()?.execute(
            "INSERT INTO traces (trace_id, project_id, root_agent, root_span_id, created_at, status) VALUES (?,?,?,?,?,?)",
            rusqlite::params![trace_id, project_id, root_agent, root_span_id, now, status.unwrap_or("running")],
        )?;
        Ok(())
    }

    /// `insertSpan`.
    #[allow(clippy::too_many_arguments)]
    pub fn insert_span(
        &self,
        span_id: &str,
        trace_id: &str,
        parent_span_id: Option<&str>,
        agent_id: &str,
        kind: &str,
        status: Option<&str>,
        input_preview: Option<&str>,
    ) -> R<()> {
        let now = self.clock.now();
        self.conn()?.execute(
            "INSERT INTO spans (span_id, trace_id, parent_span_id, agent_id, kind, started_at, status, input_preview) VALUES (?,?,?,?,?,?,?,?)",
            rusqlite::params![span_id, trace_id, parent_span_id, agent_id, kind, now, status.unwrap_or("running"), input_preview.unwrap_or("")],
        )?;
        Ok(())
    }

    /// `bindSession`.
    pub fn bind_session(&self, span_id: &str, session_id: &str) -> R<()> {
        self.conn()?.execute(
            "UPDATE spans SET session_id=? WHERE span_id=?",
            rusqlite::params![session_id, span_id],
        )?;
        Ok(())
    }

    /// `finishSpan`.
    pub fn finish_span(&self, span_id: &str, p: &SpanPatch) -> R<()> {
        let now = self.clock.now();
        self.conn()?.execute(
            "UPDATE spans SET ended_at=?, status=?, output_preview=?, error=?, guardrail=?, input_tokens=?, output_tokens=?, target_kind=?, origin=? WHERE span_id=?",
            rusqlite::params![now, p.status, p.output_preview.as_deref().unwrap_or(""), p.error, p.guardrail, p.input_tokens.unwrap_or(0), p.output_tokens.unwrap_or(0), p.target_kind, p.origin, span_id],
        )?;
        Ok(())
    }

    /// `finishTrace`.
    pub fn finish_trace(&self, trace_id: &str, status: &str) -> R<()> {
        let now = self.clock.now();
        self.conn()?.execute(
            "UPDATE traces SET ended_at=?, status=? WHERE trace_id=?",
            rusqlite::params![now, status, trace_id],
        )?;
        Ok(())
    }

    /// `getTrace`: the trace with its spans, oldest first.
    pub fn get_trace(&self, trace_id: &str) -> R<Option<CollabTrace>> {
        let c = self.conn()?;
        let mut st = c.prepare("SELECT * FROM traces WHERE trace_id = ?")?;
        let mut rows = st.query([trace_id])?;
        let Some(t) = rows.next()? else {
            return Ok(None);
        };
        let mut spans = Vec::new();
        {
            let mut sp =
                c.prepare("SELECT * FROM spans WHERE trace_id = ? ORDER BY started_at, span_id")?;
            let mut sr = sp.query([trace_id])?;
            while let Some(r) = sr.next()? {
                spans.push(to_span(r)?);
            }
        }
        let root_span_id: String = t.get("root_span_id")?;
        let tid: String = t.get("trace_id")?;
        Ok(Some(CollabTrace {
            traceparent: traceparent(&tid, &root_span_id, true),
            trace_id: tid,
            project_id: t.get("project_id")?,
            root_agent: t.get("root_agent")?,
            root_span_id,
            created_at: t.get("created_at")?,
            ended_at: opt_int(t, "ended_at")?,
            status: t.get("status")?,
            spans,
        }))
    }

    /// `listTraces(projectId)`: oldest first.
    pub fn list_traces(&self, project_id: &str) -> R<Vec<CollabTrace>> {
        let c = self.conn()?;
        let ids: Vec<String> = {
            let mut st = c.prepare(
                "SELECT trace_id FROM traces WHERE project_id = ? ORDER BY created_at, trace_id",
            )?;
            let rows = st.query_map([project_id], |r| r.get::<_, String>(0))?;
            rows.collect::<Result<_, _>>()?
        };
        let mut out = Vec::new();
        for id in ids {
            if let Some(t) = self.get_trace(&id)? {
                out.push(t);
            }
        }
        Ok(out)
    }

    // ---- tasks ---------------------------------------------------------------------------------------------------

    /// `insertTask`.
    pub fn insert_task(&self, t: &NewTask) -> R<Option<DelegateTask>> {
        let now = self.clock.now();
        let path = J::Arr(t.path.iter().map(|s| J::Str(s.clone())).collect()).stringify();
        self.conn()?.execute(
            "INSERT INTO tasks (id, project_id, trace_id, span_id, parent_task_id, from_agent, to_agent, kind, status, task, acceptance, path, created_at, started_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
            rusqlite::params![t.id, t.project_id, t.trace_id, t.span_id, t.parent_task_id, t.from_agent, t.to_agent, t.kind, t.status, t.task, t.acceptance, path, now, if t.status == task_status::RUNNING { Some(now) } else { None }],
        )?;
        self.get_task(&t.id)
    }

    /// `updateTask`: a terminal status ends the task's grants (best effort, logged on failure).
    pub fn update_task(&self, id: &str, p: &TaskPatch) -> R<Option<DelegateTask>> {
        let updated = self.patch_task(id, p)?;
        if matches!(p.status.as_str(), "succeeded" | "failed" | "cancelled") {
            self.end_task_grants(id);
        }
        Ok(updated)
    }

    pub(super) fn patch_task(&self, id: &str, p: &TaskPatch) -> R<Option<DelegateTask>> {
        let now = self.clock.now();
        let running = p.status == task_status::RUNNING;
        let c = self.conn()?;
        let mut args: Vec<Sql> = vec![
            Sql::Text(p.status.clone()),
            p.result.clone().map_or(Sql::Null, Sql::Text),
            Sql::Integer(i64::from(p.truncated)),
            p.artifact_id.clone().map_or(Sql::Null, Sql::Text),
            p.error.clone().map_or(Sql::Null, Sql::Text),
            if running {
                Sql::Null
            } else {
                Sql::Integer(now)
            },
            p.input_tokens.map_or(Sql::Null, Sql::Integer),
            p.output_tokens.map_or(Sql::Null, Sql::Integer),
            p.target_kind.clone().map_or(Sql::Null, Sql::Text),
            p.origin.clone().map_or(Sql::Null, Sql::Text),
        ];
        if running {
            args.push(Sql::Integer(now));
        }
        args.push(Sql::Text(id.to_owned()));
        c.execute(
            &format!(
                "UPDATE tasks SET status=?, result_capped=?, truncated=?, result_artifact_id=?, error=?, ended_at=?, input_tokens=?, output_tokens=?, target_kind=?, origin=?\n       {} WHERE id=?",
                if running { ", started_at=?" } else { "" }
            ),
            params_from_iter(args),
        )?;
        self.get_task(id)
    }

    /// `getTask`.
    pub fn get_task(&self, id: &str) -> R<Option<DelegateTask>> {
        let c = self.conn()?;
        let mut st = c.prepare("SELECT * FROM tasks WHERE id = ?")?;
        let mut rows = st.query([id])?;
        rows.next()?.map(to_task).transpose()
    }

    /// `listTasks(traceId)`.
    pub fn list_tasks(&self, trace_id: &str) -> R<Vec<DelegateTask>> {
        let c = self.conn()?;
        let mut st = c.prepare("SELECT * FROM tasks WHERE trace_id = ? ORDER BY created_at, id")?;
        let mut rows = st.query([trace_id])?;
        let mut out = Vec::new();
        while let Some(r) = rows.next()? {
            out.push(to_task(r)?);
        }
        Ok(out)
    }

    /// Cancel queued or running tasks together, after every task grant has ended.
    pub fn cancel_open_tasks(&self, trace_id: &str) -> R<Vec<String>> {
        self.tx(|c| {
            let open: Vec<String> = {
                let mut st = c.prepare(
                    "SELECT id FROM tasks WHERE trace_id=? AND status IN ('queued','running') ORDER BY id",
                )?;
                let rows = st.query_map([trace_id], |r| r.get::<_, String>(0))?;
                rows.collect::<Result<_, _>>()?
            };
            let now = self.clock.now();
            if let Some(grants) = &self.grants {
                for id in &open {
                    grants.end_task(id).map_err(|_| {
                        CollabError::new(C::Storage, "grant task end failed before cancellation")
                    })?;
                }
            }
            c.execute(
                "UPDATE tasks SET status='cancelled', error='aborted', ended_at=?
                 WHERE trace_id=? AND status IN ('queued','running')",
                rusqlite::params![now, trace_id],
            )?;
            Ok(open)
        })
    }

    pub(super) fn end_task_grants(&self, task_id: &str) {
        if let Some(g) = &self.grants {
            // The error itself is not logged: TypeScript passes it as structured data, which this port does not carry.
            if g.end_task(task_id).is_err() {
                if let Some(w) = &self.log_warn {
                    w("grant task end failed");
                }
            }
        }
    }
}

fn live_worktree_in(
    c: &Connection,
    project_id: &str,
    card_id: Option<&str>,
) -> R<Option<WorktreeRow>> {
    let (sql, card) = match card_id.filter(|s| !s.is_empty()) {
        Some(card) => (
            "SELECT * FROM project_worktrees WHERE project_id = ? AND card_id = ? AND removed_at IS NULL",
            Some(card),
        ),
        None => (
            "SELECT * FROM project_worktrees WHERE project_id = ? AND card_id IS NULL AND removed_at IS NULL",
            None,
        ),
    };
    let mut st = c.prepare(sql)?;
    let mut rows = match card {
        Some(card) => st.query(rusqlite::params![project_id, card])?,
        None => st.query(rusqlite::params![project_id])?,
    };
    rows.next()?.map(to_worktree).transpose()
}
