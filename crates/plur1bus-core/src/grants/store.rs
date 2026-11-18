//! `grants/store.ts` (D109 §4/§6): grants on the shared approvals database, resolved for `decide()` through
//! [`crate::policy::decide::GrantSource`] (implemented by [`super::open::PermissionStores`]).
//!
//! Authority: the HMAC chain, not the table. A grant's definition is chained when it is created; revocation, end,
//! consumption and use are chained when they happen. On every read the row is compared with its chain entries:
//! - a grant whose creation entry lies at or after the first broken chain position is suspended (fail closed, §6),
//! - a grant whose row no longer matches its chained definition is suspended,
//! - revoked or consumed in the chain wins over a row that says otherwise; `lastUsedAt` is taken from the chain only.
//!
//! Rows are read the way `node:sqlite` hands them to TypeScript ([`row_j`]): the definition is rebuilt from the row's raw
//! values and compared as a string with the chained one, so a row whose type was changed behind the store's back no longer
//! matches its definition. Grant ids are 24 random hex digits after `grt_` (TypeScript hashes the time, `Math.random()` and
//! the pid into the same shape); an id is opaque, nothing reads its derivation.
use crate::approvals::chain::{ApprovalChain, ChainEntry, ChainError, VerifyFailure};
use crate::approvals::js_json::{num_value, J};
use crate::approvals::{js_number, random_hex, AuditPort, Clock, Random};
use crate::policy::capabilities::{
    capability, CapabilityDef, GrantScope, PolicyClass, ONCE_UNUSED_MS,
};
use crate::policy::decide::{grant_expiry, max_scope_for, required_surface, Flags};
use crate::policy::paths::{
    check_syntax, grant_reaches_system_tree, IcuNfc, SyntaxOptions, TreeOptions,
};
use plur1bus_store::rusqlite::types::{Value as SqlValue, ValueRef};
use plur1bus_store::rusqlite::{params, Connection, OptionalExtension, ToSql};
use plur1bus_store::StoreError;
use serde_json::{json, Map, Value};
use sha2::{Digest, Sha256};
use std::cell::RefCell;
use std::collections::HashSet;
use std::fmt;
use std::sync::Arc;

/// `USE_RECORD_GRANULARITY_MS`: a use is chained at most this often per grant.
pub const USE_RECORD_GRANULARITY_MS: f64 = 60.0 * 60_000.0;
/// `AUTO_JOB_ISSUER`: the reserved issuer of the automatic owner job grant.
pub const AUTO_JOB_ISSUER: &str = "core:auto-agent-owner";
const MAX_FIELD_UNITS: usize = 256;

/// `GrantErrorCode`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum GrantErrorCode {
    /// `invalid-grant`.
    InvalidGrant,
    /// `ceiling-exceeded`.
    CeilingExceeded,
    /// `surface-too-low`.
    SurfaceTooLow,
    /// `never-capability`.
    NeverCapability,
    /// `duplicate-id`.
    DuplicateId,
}

impl GrantErrorCode {
    /// The wire name.
    pub fn as_str(self) -> &'static str {
        match self {
            GrantErrorCode::InvalidGrant => "invalid-grant",
            GrantErrorCode::CeilingExceeded => "ceiling-exceeded",
            GrantErrorCode::SurfaceTooLow => "surface-too-low",
            GrantErrorCode::NeverCapability => "never-capability",
            GrantErrorCode::DuplicateId => "duplicate-id",
        }
    }
}

/// Why a grant operation did not happen.
#[derive(Clone, Debug, PartialEq)]
pub enum GrantError {
    /// `GrantError(code, message)`: the input was refused.
    Refused {
        /// The code.
        code: GrantErrorCode,
        /// The message (names fields and limits, never a value that could be a secret).
        message: String,
    },
    /// `ApprovalChainError`: the chain does not verify, so nothing new is recorded on it.
    Integrity {
        /// The first position that does not hold.
        broken_at: f64,
        /// Why.
        reason: VerifyFailure,
    },
    /// The audit line could not be written; the change was rolled back.
    Audit(String),
    /// SQLite or an unreadable row.
    Storage(String),
}

impl GrantError {
    fn refused(code: GrantErrorCode, message: impl Into<String>) -> Self {
        GrantError::Refused {
            code,
            message: message.into(),
        }
    }

    /// The code of a refusal.
    pub fn code(&self) -> Option<GrantErrorCode> {
        match self {
            GrantError::Refused { code, .. } => Some(*code),
            _ => None,
        }
    }
}

impl fmt::Display for GrantError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            GrantError::Refused { message, .. } => f.write_str(message),
            GrantError::Integrity { broken_at, reason } => write!(
                f,
                "approval chain is broken at {} ({})",
                J::Num(*broken_at).stringify(),
                reason.as_str()
            ),
            GrantError::Audit(m) | GrantError::Storage(m) => f.write_str(m),
        }
    }
}

impl std::error::Error for GrantError {}

impl From<ChainError> for GrantError {
    fn from(e: ChainError) -> Self {
        match e {
            ChainError::Broken {
                broken_at, reason, ..
            } => GrantError::Integrity { broken_at, reason },
            other => GrantError::Storage(other.to_string()),
        }
    }
}

impl From<StoreError> for GrantError {
    fn from(e: StoreError) -> Self {
        GrantError::Storage(e.to_string())
    }
}

impl From<plur1bus_store::rusqlite::Error> for GrantError {
    fn from(e: plur1bus_store::rusqlite::Error) -> Self {
        GrantError::Storage(e.to_string())
    }
}

/// `GrantMatch` of an input.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum GrantMatch {
    /// `{ kind: "action" }`: a once grant bound to an action hash.
    Action,
    /// `{ kind: "capability" }`.
    Capability,
    /// `{ kind: "path", path, access, recursive }`.
    Path {
        /// The canonical absolute path.
        path: String,
        /// `read` or `write` (anything else is refused).
        access: String,
        /// Whether it covers the whole tree.
        recursive: bool,
    },
}

impl GrantMatch {
    fn kind(&self) -> &'static str {
        match self {
            GrantMatch::Action => "action",
            GrantMatch::Capability => "capability",
            GrantMatch::Path { .. } => "path",
        }
    }
}

/// `CreateGrantInput`.
#[derive(Clone, Debug)]
pub struct CreateGrantInput {
    /// A given id (tests, imports); generated when `None`.
    pub id: Option<String>,
    /// The capability (trimmed and lower-cased before the lookup, as TypeScript does).
    pub capability: String,
    /// Whose grant.
    pub person: String,
    /// For which agent.
    pub agent: String,
    /// `once`, `task`, `session` or `always` (anything else is refused).
    pub scope: String,
    /// What it matches.
    pub r#match: GrantMatch,
    /// Who created it.
    pub created_by: String,
    /// The surface the decision came from (`SurfaceTrust`).
    pub surface: u8,
    /// The effect it was given for.
    pub effect: Option<String>,
    /// An explicit end.
    pub expires_at: Option<f64>,
    /// The action hash of a once grant.
    pub action_hash: Option<String>,
    /// The task of a task grant.
    pub task_id: Option<String>,
    /// The session of a session grant.
    pub session_id: Option<String>,
    /// The project.
    pub project_id: Option<String>,
    /// The job of a standing job grant.
    pub job_id: Option<String>,
    /// May be handed to helpers (D104).
    pub delegable: bool,
    /// `shell.exec` without a sandbox, knowingly accepted (Q17).
    pub acknowledged_unsandboxed: bool,
    /// `attested:<method>`: set only by an approval an OS confirmation lifted to T2.
    pub attested_via: Option<String>,
}

impl CreateGrantInput {
    /// The required members; everything else empty.
    pub fn new(
        capability: &str,
        person: &str,
        agent: &str,
        scope: &str,
        m: GrantMatch,
        created_by: &str,
        surface: u8,
    ) -> Self {
        CreateGrantInput {
            id: None,
            capability: capability.to_owned(),
            person: person.to_owned(),
            agent: agent.to_owned(),
            scope: scope.to_owned(),
            r#match: m,
            created_by: created_by.to_owned(),
            surface,
            effect: None,
            expires_at: None,
            action_hash: None,
            task_id: None,
            session_id: None,
            project_id: None,
            job_id: None,
            delegable: false,
            acknowledged_unsandboxed: false,
            attested_via: None,
        }
    }
}

/// `GrantState`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum GrantState {
    /// `active`.
    Active,
    /// `revoked`.
    Revoked,
    /// `consumed`.
    Consumed,
    /// `suspended`: the chain does not vouch for it.
    Suspended,
}

impl GrantState {
    /// The wire name.
    pub fn as_str(self) -> &'static str {
        match self {
            GrantState::Active => "active",
            GrantState::Revoked => "revoked",
            GrantState::Consumed => "consumed",
            GrantState::Suspended => "suspended",
        }
    }
}

/// A grant with its state. `grant` is the `StoredGrant` object (the policy `Grant` plus `createdBy`, `effect`, `revokedAt`,
/// `endReason`, `attestedVia`, `origin`), the shape `decide()` reads.
#[derive(Clone, Debug, PartialEq)]
pub struct View {
    /// The grant.
    pub grant: Value,
    /// Its state.
    pub state: GrantState,
}

/// `GrantLifecycleChange`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Lifecycle {
    /// `used`.
    Used,
    /// `expired`.
    Expired,
    /// `suspended`.
    Suspended,
}

/// `GrantLifecycleNotify`: used, expired and suspended only (created and revoked stay with the RPC handlers).
pub type LifecycleNotify = Box<dyn Fn(Lifecycle, &Value, GrantState)>;

/// `AutoJobReason`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum AutoJobReason {
    /// `agent-created`.
    AgentCreated,
    /// `engine-switched-to-rust`.
    EngineSwitchedToRust,
    /// `rust-core-start`.
    RustCoreStart,
    /// `owner-returned`.
    OwnerReturned,
}

impl AutoJobReason {
    /// The wire name.
    pub fn as_str(self) -> &'static str {
        match self {
            AutoJobReason::AgentCreated => "agent-created",
            AutoJobReason::EngineSwitchedToRust => "engine-switched-to-rust",
            AutoJobReason::RustCoreStart => "rust-core-start",
            AutoJobReason::OwnerReturned => "owner-returned",
        }
    }
}

/// `process.platform` of this build (`darwin`, `linux`, `win32`).
pub fn node_platform() -> &'static str {
    if cfg!(windows) {
        "win32"
    } else if cfg!(target_os = "macos") {
        "darwin"
    } else {
        "linux"
    }
}

/// One `grants` row as `node:sqlite` hands it over: every column as the JavaScript value it becomes.
#[derive(Clone, Debug)]
pub struct GrantRow {
    cols: Vec<(&'static str, J)>,
}

const COLUMNS: [&str; 27] = [
    "id",
    "person",
    "agent",
    "capability",
    "effect",
    "match_kind",
    "match_path",
    "match_access",
    "match_recursive",
    "duration",
    "created_by",
    "created_at",
    "expires_at",
    "revoked_at",
    "end_reason",
    "last_used_at",
    "consumed_at",
    "action_hash",
    "task_id",
    "session_id",
    "project_id",
    "job_id",
    "delegable",
    "surface",
    "acknowledged_unsandboxed",
    "attested_via",
    "origin",
];

/// A column value as the JavaScript value `node:sqlite` returns: a blob is a `Uint8Array`, which equals no string and
/// which `JSON.stringify` writes as an object of its bytes by index (so a grant shows it, and a definition holding it no
/// longer matches its chained hash), as in TypeScript (review B, RB-3). An integer beyond 2^53 `node:sqlite` refuses to
/// hand over at all: `None`, and the read fails as TypeScript's throws.
pub fn row_j(v: ValueRef<'_>) -> Option<J> {
    const MAX_SAFE: i64 = (1 << 53) - 1;
    Some(match v {
        ValueRef::Null => J::Null,
        ValueRef::Integer(i) if !(-MAX_SAFE..=MAX_SAFE).contains(&i) => return None,
        ValueRef::Integer(i) => J::Num(i as f64),
        ValueRef::Real(r) => J::Num(r),
        ValueRef::Text(t) => J::Str(String::from_utf8_lossy(t).into_owned()),
        ValueRef::Blob(b) => crate::approvals::chain::bytes_json(b),
    })
}

impl GrantRow {
    fn col(&self, k: &str) -> &J {
        self.cols
            .iter()
            .find(|(c, _)| *c == k)
            .map_or(&J::Null, |(_, v)| v)
    }
    fn str(&self, k: &str) -> Option<&str> {
        self.col(k).as_str()
    }
    fn null(&self, k: &str) -> bool {
        *self.col(k) == J::Null
    }
    fn is(&self, k: &str, n: f64) -> bool {
        self.col(k).as_f64() == Some(n)
    }
    fn num(&self, k: &str) -> f64 {
        js_number(Some(self.col(k)))
    }

    /// `definitionOf(r)`: the immutable definition chained at creation, member order fixed (it is compared as a string).
    pub fn definition(&self) -> String {
        let opt_num = |k: &str| {
            if self.null(k) {
                J::Null
            } else {
                J::Num(self.num(k))
            }
        };
        let mut def = J::obj([
            ("id", self.col("id").clone()),
            ("person", self.col("person").clone()),
            ("agent", self.col("agent").clone()),
            ("capability", self.col("capability").clone()),
            ("effect", self.col("effect").clone()),
            ("scope", self.col("duration").clone()),
            (
                "match",
                J::obj([
                    ("kind", self.col("match_kind").clone()),
                    ("path", self.col("match_path").clone()),
                    ("access", self.col("match_access").clone()),
                    (
                        "recursive",
                        if self.null("match_recursive") {
                            J::Null
                        } else {
                            J::Bool(self.is("match_recursive", 1.0))
                        },
                    ),
                ]),
            ),
            ("createdBy", self.col("created_by").clone()),
            ("createdAt", J::Num(self.num("created_at"))),
            ("expiresAt", opt_num("expires_at")),
            ("actionHash", self.col("action_hash").clone()),
            ("taskId", self.col("task_id").clone()),
            ("sessionId", self.col("session_id").clone()),
            ("projectId", self.col("project_id").clone()),
            ("jobId", self.col("job_id").clone()),
            ("delegable", J::Bool(self.is("delegable", 1.0))),
            ("surface", J::Num(self.num("surface"))),
            (
                "acknowledgedUnsandboxed",
                J::Bool(self.is("acknowledged_unsandboxed", 1.0)),
            ),
        ]);
        // Only when present: a grant without an origin keeps the exact definition (and hash) it always had.
        if !self.null("attested_via") {
            def.set("attestedVia", self.col("attested_via").clone());
        }
        if !self.null("origin") {
            def.set("origin", self.col("origin").clone());
        }
        def.stringify()
    }

    /// `#toGrant(r)`: the `StoredGrant` the row describes (before the chain is consulted).
    pub fn to_grant(&self) -> Map<String, Value> {
        let v = |k: &str| self.col(k).to_value();
        let n = |k: &str| num_value(self.num(k));
        let m = if self.str("match_kind") == Some("path") {
            json!({ "kind": "path", "path": v("match_path"), "access": v("match_access"), "recursive": self.is("match_recursive", 1.0) })
        } else {
            json!({ "kind": v("match_kind") })
        };
        let mut g = Map::new();
        for (key, val) in [
            ("id", v("id")),
            ("capability", v("capability")),
            ("person", v("person")),
            ("agent", v("agent")),
            ("scope", v("duration")),
            ("match", m),
            ("createdAt", n("created_at")),
            ("surface", n("surface")),
            ("createdBy", v("created_by")),
        ] {
            g.insert(key.to_owned(), val);
        }
        let mut opt = |col: &str, key: &str, number: bool| {
            if !self.null(col) {
                g.insert(key.to_owned(), if number { n(col) } else { v(col) });
            }
        };
        opt("effect", "effect", false);
        opt("expires_at", "expiresAt", true);
        opt("revoked_at", "revokedAt", true);
        opt("end_reason", "endReason", false);
        opt("last_used_at", "lastUsedAt", true);
        opt("consumed_at", "consumedAt", true);
        opt("action_hash", "actionHash", false);
        opt("task_id", "taskId", false);
        opt("session_id", "sessionId", false);
        opt("project_id", "projectId", false);
        opt("job_id", "jobId", false);
        opt("attested_via", "attestedVia", false);
        if !self.null("revoked_at") {
            g.insert("revoked".to_owned(), json!(true));
        }
        if self.is("delegable", 1.0) {
            g.insert("delegable".to_owned(), json!(true));
        }
        if self.is("acknowledged_unsandboxed", 1.0) {
            g.insert("acknowledgedUnsandboxed".to_owned(), json!(true));
        }
        if self.str("origin") == Some("auto-agent-owner")
            && self.str("created_by") == Some(AUTO_JOB_ISSUER)
        {
            g.insert("origin".to_owned(), json!("auto-agent-owner"));
        }
        g
    }
}

fn select(
    conn: &Connection,
    filter: &str,
    args: &[&dyn ToSql],
) -> Result<Vec<GrantRow>, GrantError> {
    let sql = format!("SELECT {} FROM grants {filter}", COLUMNS.join(", "));
    let mut stmt = conn.prepare(&sql)?;
    let mut rows = stmt.query(args)?;
    let mut out = Vec::new();
    while let Some(r) = rows.next()? {
        let mut cols = Vec::with_capacity(COLUMNS.len());
        for (i, c) in COLUMNS.iter().enumerate() {
            let v = row_j(r.get_ref(i)?).ok_or_else(|| {
                GrantError::Storage("a grant row holds an integer beyond 2^53".to_owned())
            })?;
            cols.push((*c, v));
        }
        out.push(GrantRow { cols });
    }
    Ok(out)
}

fn g_str<'a>(g: &'a Value, k: &str) -> Option<&'a str> {
    g.get(k).and_then(Value::as_str)
}

fn g_num(g: &Value, k: &str) -> Option<f64> {
    g.get(k).and_then(Value::as_f64)
}

fn units(s: &str) -> usize {
    s.encode_utf16().count()
}

fn non_empty(s: Option<&str>) -> bool {
    s.is_some_and(|s| !s.is_empty())
}

/// `/^attested:[a-z0-9][a-z0-9-]{0,31}$/`.
fn attested_via_ok(s: &str) -> bool {
    let Some(method) = s.strip_prefix("attested:") else {
        return false;
    };
    let b = method.as_bytes();
    let first = |c: &u8| c.is_ascii_lowercase() || c.is_ascii_digit();
    !b.is_empty() && b.len() <= 32 && first(&b[0]) && b[1..].iter().all(|c| first(c) || *c == b'-')
}

/// `GrantStore`: the write and read rules; the connection and the chain are the caller's (one per file).
pub struct GrantStore {
    clock: Arc<dyn Clock>,
    random: Arc<dyn Random>,
    max_grant_days: Box<dyn Fn() -> f64>,
    home: Option<String>,
    platform: &'static str,
    notify: Option<LifecycleNotify>,
    emitted: RefCell<HashSet<String>>,
}

impl GrantStore {
    /// `new GrantStore(o)`. `max_grant_days` defaults to 90; `home` to the process's home directory.
    pub fn new(
        clock: Arc<dyn Clock>,
        random: Arc<dyn Random>,
        max_grant_days: Option<Box<dyn Fn() -> f64>>,
        home: Option<String>,
    ) -> Self {
        GrantStore {
            clock,
            random,
            max_grant_days: max_grant_days.unwrap_or_else(|| Box::new(|| 90.0)),
            home,
            platform: node_platform(),
            notify: None,
            emitted: RefCell::new(HashSet::new()),
        }
    }

    /// The platform the path rules use (tests only: the product's is this build's, and nothing outside the crate's tests
    /// can change it; review B, RB-8).
    #[cfg(test)]
    pub(crate) fn with_platform(mut self, platform: &'static str) -> Self {
        self.platform = platform;
        self
    }

    /// As [`Self::with_platform`], for a store that is already part of [`super::open::PermissionStores`].
    #[cfg(test)]
    pub(crate) fn set_platform(&mut self, platform: &'static str) {
        self.platform = platform;
    }

    /// `maxGrantDays()`.
    pub fn max_grant_days(&self) -> f64 {
        (self.max_grant_days)()
    }

    /// `setNotify`.
    pub fn set_notify(&mut self, notify: Option<LifecycleNotify>) {
        self.notify = notify;
    }

    fn emit(&self, change: Lifecycle, grant: &Value, state: GrantState) {
        if matches!(change, Lifecycle::Expired | Lifecycle::Suspended) {
            let k = format!(
                "{}:{}",
                if change == Lifecycle::Expired {
                    "expired"
                } else {
                    "suspended"
                },
                g_str(grant, "id").unwrap_or("")
            );
            if !self.emitted.borrow_mut().insert(k) {
                return;
            }
        }
        // A listener never blocks a grant operation; one that panics is the host's bug and is not caught here.
        if let Some(n) = &self.notify {
            n(change, grant, state);
        }
    }

    fn expiry(&self, g: &Value) -> f64 {
        // The rows of this store carry numbers, so the lifetime always computes; one that could not be read counts as over.
        grant_expiry(g, self.max_grant_days()).unwrap_or(f64::NEG_INFINITY)
    }

    /// `announceDue(person)`: notifies once each about expired (time-derived) and suspended grants.
    pub fn announce_due(
        &self,
        conn: &Connection,
        chain: &ApprovalChain,
        person: Option<&str>,
    ) -> Result<(), GrantError> {
        let now = self.clock.now() as f64;
        for v in self.inspect(conn, chain, person, None)? {
            if v.state == GrantState::Suspended {
                self.emit(Lifecycle::Suspended, &v.grant, v.state);
            } else if v.state == GrantState::Active && now >= self.expiry(&v.grant) {
                self.emit(Lifecycle::Expired, &v.grant, v.state);
            }
        }
        Ok(())
    }

    /// `list(q)` of `GrantSource`: the active grants of one person, agent and capability, verified on every call.
    pub fn list(
        &self,
        conn: &Connection,
        chain: &ApprovalChain,
        person: &str,
        agent: &str,
        cap: &str,
    ) -> Result<Vec<Value>, GrantError> {
        let rows = select(
            conn,
            "WHERE person = ? AND agent = ? AND capability = ? AND revoked_at IS NULL AND consumed_at IS NULL ORDER BY created_at, id",
            &[&person, &agent, &cap],
        )?;
        Ok(self
            .views(conn, chain, &rows)?
            .into_iter()
            .filter(|v| v.state == GrantState::Active)
            .map(|v| v.grant)
            .collect())
    }

    /// `get(id)`: unknown or suspended ids resolve to nothing; revoked and consumed grants are returned flagged.
    pub fn get(
        &self,
        conn: &Connection,
        chain: &ApprovalChain,
        id: &str,
    ) -> Result<Option<Value>, GrantError> {
        Ok(self
            .view_of(conn, chain, id)?
            .filter(|v| v.state != GrantState::Suspended)
            .map(|v| v.grant))
    }

    /// `chainEntries()`: the entries this store shares with approvals.
    pub fn chain_entries(
        &self,
        conn: &Connection,
        chain: &ApprovalChain,
    ) -> Result<Vec<ChainEntry>, GrantError> {
        Ok(chain.snapshot(conn)?.entries.clone())
    }

    /// `inspect(filter)`: every grant with its state, oldest first.
    pub fn inspect(
        &self,
        conn: &Connection,
        chain: &ApprovalChain,
        person: Option<&str>,
        agent: Option<&str>,
    ) -> Result<Vec<View>, GrantError> {
        let rows = select(
            conn,
            "WHERE (?1 IS NULL OR person = ?1) AND (?2 IS NULL OR agent = ?2) ORDER BY created_at, id",
            &[&person, &agent],
        )?;
        self.views(conn, chain, &rows)
    }

    fn view_of(
        &self,
        conn: &Connection,
        chain: &ApprovalChain,
        id: &str,
    ) -> Result<Option<View>, GrantError> {
        let rows = select(conn, "WHERE id = ?", &[&id])?;
        Ok(self.views(conn, chain, &rows)?.into_iter().next())
    }

    /// `#views(rows)`.
    pub fn views(
        &self,
        conn: &Connection,
        chain: &ApprovalChain,
        rows: &[GrantRow],
    ) -> Result<Vec<View>, GrantError> {
        let snap = chain.snapshot(conn)?;
        let below = snap.trusted_below;
        let trusted = move |e: &&&ChainEntry| e.seq < below;
        Ok(rows
            .iter()
            .map(|r| {
                let list = r.str("id").map(|id| snap.by_ref(id)).unwrap_or_default();
                let mut g = r.to_grant();
                let created = list.iter().find(|e| e.kind == "grant.created");
                let vouched = created.is_some_and(|c| {
                    c.seq < snap.trusted_below
                        && J::parse(&c.payload)
                            .and_then(|p| p.get("def").cloned())
                            .is_some_and(|def| def.stringify() == r.definition())
                });
                // Chain facts only count while they are themselves proven; a revocation always counts (stricter).
                let ended = list
                    .iter()
                    .find(|e| e.kind == "grant.revoked" || e.kind == "grant.ended");
                let consumed = list
                    .iter()
                    .filter(trusted)
                    .find(|e| e.kind == "grant.consumed");
                let uses: Vec<&&ChainEntry> = list
                    .iter()
                    .filter(trusted)
                    .filter(|e| e.kind == "grant.used")
                    .collect();
                g.remove("lastUsedAt");
                if let Some(max) = uses.iter().map(|e| e.ts).reduce(f64::max) {
                    g.insert("lastUsedAt".to_owned(), num_value(max));
                }
                if g.get("capability").and_then(Value::as_str) == Some("memory.jobs.run") {
                    for e in &uses {
                        let proved = J::parse(&e.payload).is_some_and(|p| {
                            p.get("kind").and_then(J::as_str) == Some("proved-owner-turn")
                        });
                        if proved {
                            let base = g
                                .get("lastJobTurnAt")
                                .or(g.get("createdAt"))
                                .and_then(Value::as_f64)
                                .unwrap_or(f64::NAN);
                            g.insert("lastJobTurnAt".to_owned(), num_value(base.max(e.ts)));
                        }
                    }
                }
                if let Some(e) = ended {
                    if !g.contains_key("revokedAt") {
                        g.insert("revokedAt".to_owned(), num_value(e.ts));
                    }
                }
                if ended.is_some() || g.contains_key("revokedAt") {
                    g.insert("revoked".to_owned(), json!(true));
                }
                if let Some(e) = consumed {
                    if !g.contains_key("consumedAt") {
                        g.insert("consumedAt".to_owned(), num_value(e.ts));
                    }
                }
                let state = if !vouched {
                    GrantState::Suspended
                } else if g.get("revoked") == Some(&json!(true)) {
                    GrantState::Revoked
                } else if g.contains_key("consumedAt") {
                    GrantState::Consumed
                } else {
                    GrantState::Active
                };
                View {
                    grant: Value::Object(g),
                    state,
                }
            })
            .collect())
    }

    fn note(
        audit: &mut dyn AuditPort,
        action: &str,
        g: &Value,
        by: Option<&str>,
        reason: Option<&str>,
        action_hash: Option<&str>,
    ) -> Result<(), GrantError> {
        let mut f = Map::new();
        let mut put = |k: &str, v: Value| {
            f.insert(k.to_owned(), v);
        };
        let get = |k: &str| g.get(k).cloned().unwrap_or(Value::Null);
        put("person", get("person"));
        put("agentId", get("agent"));
        put("capability", get("capability"));
        put("grantId", get("id"));
        put("grantScope", get("scope"));
        put("matchKind", g["match"]["kind"].clone());
        if g["match"]["kind"] == "path" {
            put("targets", json!([g["match"]["path"]]));
        }
        for k in ["jobId", "taskId", "sessionId"] {
            if let Some(v) = g.get(k) {
                put(k, v.clone());
            }
        }
        if action == "grant.created" {
            put(
                "by",
                g.get("createdBy")
                    .or(g.get("person"))
                    .cloned()
                    .unwrap_or(Value::Null),
            );
            match g.get("origin") {
                Some(o) => put("origin", o.clone()),
                None => put("decisionSurface", get("surface")),
            }
        }
        if let Some(b) = by {
            put("by", json!(b));
        }
        if let Some(r) = reason {
            put("reason", json!(r));
        }
        if let Some(h) = action_hash {
            put("actionHash", json!(h));
        }
        audit
            .record(action, &Value::Object(f))
            .map_err(GrantError::Audit)
    }

    /// `reachesSystemTree(path, recursive)`: does a path grant reach a home, a drive root, `/`, `/Users`, `C:\Users` or a
    /// system tree? The home is compared by its spelling and by its real path.
    pub fn reaches_system_tree(&self, path: &str, recursive: bool) -> bool {
        let home = self
            .home
            .clone()
            .or_else(|| std::env::home_dir().and_then(|h| h.to_str().map(str::to_owned)))
            .unwrap_or_default();
        let real = std::fs::canonicalize(&home)
            .ok()
            .and_then(|p| p.to_str().map(str::to_owned));
        let homes: Vec<String> = match real {
            Some(r) if r != home => vec![home, r],
            _ => vec![home],
        };
        grant_reaches_system_tree(
            path,
            recursive,
            TreeOptions {
                windows: self.platform == "win32",
                homes: &homes,
            },
            &IcuNfc,
        )
    }

    /// `create(input)`: checks every rule, then inserts and chains the grant and writes its audit line, in the caller's
    /// write transaction (a failing audit line rolls the grant back).
    pub fn create(
        &self,
        tx: &Connection,
        chain: &ApprovalChain,
        audit: &mut dyn AuditPort,
        i: &CreateGrantInput,
    ) -> Result<Value, GrantError> {
        use GrantErrorCode::*;
        let bad = |code, msg: String| Err(GrantError::refused(code, msg));
        let key = crate::js::to_lower_case(i.capability.trim_matches(crate::js::is_js_space));
        let Some(def) = capability(&key) else {
            return bad(InvalidGrant, format!("unknown capability {}", i.capability));
        };
        if def.inside == PolicyClass::Never {
            return bad(
                NeverCapability,
                format!(
                    "{} is a never capability; no grant can exist for it",
                    def.id
                ),
            );
        }
        let Some(ceiling) = def.ceiling else {
            return bad(
                CeilingExceeded,
                format!("{} takes no standing grant", def.id),
            );
        };
        if i.person.is_empty() || i.agent.is_empty() || i.created_by.is_empty() {
            return bad(
                InvalidGrant,
                "person, agent and createdBy are required".to_owned(),
            );
        }
        if i.created_by == AUTO_JOB_ISSUER {
            return bad(InvalidGrant, "reserved grant issuer".to_owned());
        }
        let Some(scope) = GrantScope::parse(&i.scope) else {
            return bad(InvalidGrant, format!("unknown duration {}", i.scope));
        };
        if scope > ceiling {
            return bad(
                CeilingExceeded,
                format!("{} allows at most {} grants", def.id, ceiling.as_str()),
            );
        }
        if !matches!(i.surface, 1..=3) {
            return bad(
                SurfaceTooLow,
                "a grant needs a decision from a T1..T3 surface".to_owned(),
            );
        }
        if def.min_surface.is_some_and(|m| i.surface < m) {
            return bad(
                SurfaceTooLow,
                format!(
                    "{} needs a decision from T{} or above",
                    def.id,
                    def.min_surface.unwrap_or(0)
                ),
            );
        }
        if let Some(a) = &i.attested_via {
            if !attested_via_ok(a) || i.surface < 2 {
                return bad(
                    InvalidGrant,
                    "attestedVia must be attested:<method> and needs a T2 or higher surface"
                        .to_owned(),
                );
            }
        }
        for (name, v) in [
            ("id", i.id.as_deref()),
            ("person", Some(i.person.as_str())),
            ("agent", Some(i.agent.as_str())),
            ("createdBy", Some(i.created_by.as_str())),
            ("taskId", i.task_id.as_deref()),
            ("sessionId", i.session_id.as_deref()),
            ("projectId", i.project_id.as_deref()),
            ("jobId", i.job_id.as_deref()),
            ("effect", i.effect.as_deref()),
            ("actionHash", i.action_hash.as_deref()),
        ] {
            if v.is_some_and(|v| units(v) > MAX_FIELD_UNITS) {
                return bad(
                    InvalidGrant,
                    format!("{name} is longer than {MAX_FIELD_UNITS} characters"),
                );
            }
        }
        if let Some(e) = i.expires_at {
            if !e.is_finite() {
                return bad(InvalidGrant, "expiresAt must be a finite number".to_owned());
            }
            if e <= self.clock.now() as f64 {
                return bad(InvalidGrant, "expiresAt must lie in the future".to_owned());
            }
        }
        if scope == GrantScope::Once {
            if !non_empty(i.action_hash.as_deref()) || i.r#match != GrantMatch::Action {
                return bad(
                    InvalidGrant,
                    "a once grant is bound to an action hash (match.kind = action)".to_owned(),
                );
            }
        } else if i.r#match == GrantMatch::Action {
            return bad(
                InvalidGrant,
                "only a once grant can match an action hash".to_owned(),
            );
        }
        if scope == GrantScope::Task && !non_empty(i.task_id.as_deref()) {
            return bad(InvalidGrant, "a task grant needs a taskId".to_owned());
        }
        if scope == GrantScope::Session && !non_empty(i.session_id.as_deref()) {
            return bad(InvalidGrant, "a session grant needs a sessionId".to_owned());
        }
        if i.job_id.is_some() && (scope != GrantScope::Always || !non_empty(i.job_id.as_deref())) {
            return bad(
                InvalidGrant,
                "a job grant is a standing (always) grant".to_owned(),
            );
        }
        if def.id == "memory.jobs.run"
            && (scope != GrantScope::Always
                || !non_empty(i.job_id.as_deref())
                || i.r#match != GrantMatch::Capability
                || i.task_id.is_some()
                || i.session_id.is_some()
                || i.project_id.is_some()
                || i.delegable
                || i.created_by != i.person)
        {
            return bad(
                InvalidGrant,
                "a memory job needs the person's own non-delegable standing grant for one agent and job".to_owned(),
            );
        }
        if let GrantMatch::Path {
            path,
            access,
            recursive,
        } = &i.r#match
        {
            self.check_path(def, scope, i.surface, path, access, *recursive)?;
        }
        let now = self.clock.now();
        let id =
            i.id.clone()
                .unwrap_or_else(|| format!("grt_{}", random_hex(self.random.as_ref(), 12)));
        let exists: Option<i64> = tx
            .query_row("SELECT 1 FROM grants WHERE id = ?", [&id], |r| r.get(0))
            .optional()?;
        if exists.is_some() {
            return bad(DuplicateId, format!("grant {id} exists"));
        }
        let created = self.insert(tx, chain, &id, now, i, def.id, None)?;
        Self::note(audit, "grant.created", &created, None, None, None)?;
        Ok(created)
    }

    fn check_path(
        &self,
        def: &CapabilityDef,
        scope: GrantScope,
        surface: u8,
        path: &str,
        access: &str,
        recursive: bool,
    ) -> Result<(), GrantError> {
        use GrantErrorCode::*;
        if path.is_empty() || (access != "read" && access != "write") {
            return Err(GrantError::refused(
                InvalidGrant,
                "path match needs path, access and recursive",
            ));
        }
        let syn = check_syntax(
            &json!(path),
            SyntaxOptions {
                platform: self.platform,
                windows_rules: None,
                allow_unc: false,
            },
        );
        match syn {
            Err(r) => {
                return Err(GrantError::refused(
                    InvalidGrant,
                    format!("grant path refused: {}", r.reason),
                ));
            }
            Ok(s) if !s.absolute => {
                return Err(GrantError::refused(
                    InvalidGrant,
                    "grant path must be absolute and canonical",
                ));
            }
            Ok(_) => {}
        }
        // Canonical means what `pathCovered` reads: no empty or "." segment after the root and at least one segment.
        let rest: Vec<&str> = path.split(['\\', '/']).skip(1).collect();
        if rest.is_empty() || rest.iter().any(|s| s.is_empty() || *s == ".") {
            return Err(GrantError::refused(
                InvalidGrant,
                "grant path must be canonical (no root-only path, trailing or doubled separator, or '.' segment)",
            ));
        }
        // §3: home, drive roots, `/`, `/Users`, `C:\Users` and system trees are never roots; a grant that reaches one is
        // T3 and at most `task`.
        if self.reaches_system_tree(path, recursive) {
            let flags = Flags {
                outside_roots: true,
                system_tree: true,
                ..Flags::default()
            };
            let max = max_scope_for(def, flags);
            if scope > max {
                return Err(GrantError::refused(
                    CeilingExceeded,
                    format!(
                        "a grant on a home, drive root or system tree is at most {}",
                        max.as_str()
                    ),
                ));
            }
            if surface < required_surface(def, scope, flags) {
                return Err(GrantError::refused(
                    SurfaceTooLow,
                    "a grant on a home, drive root or system tree needs a decision from T3",
                ));
            }
        }
        Ok(())
    }

    #[allow(clippy::too_many_arguments)]
    fn insert(
        &self,
        tx: &Connection,
        chain: &ApprovalChain,
        id: &str,
        now: i64,
        i: &CreateGrantInput,
        capability: &str,
        origin: Option<&str>,
    ) -> Result<Value, GrantError> {
        // The row is written first, read back through `definition`, then chained: the chained definition is exactly what
        // a later read recomputes from the row. Both happen in the caller's transaction.
        let (path, access, recursive) = match &i.r#match {
            GrantMatch::Path {
                path,
                access,
                recursive,
            } => (
                Some(path.as_str()),
                Some(access.as_str()),
                Some(i64::from(*recursive)),
            ),
            _ => (None, None, None),
        };
        tx.execute(
            "INSERT INTO grants (id, person, agent, capability, effect, match_kind, match_path, match_access, match_recursive, duration, created_by, created_at, expires_at,
        action_hash, task_id, session_id, project_id, job_id, delegable, surface, acknowledged_unsandboxed, attested_via, origin, def_hash, chain_seq)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '', 0)",
            params![
                id, i.person, i.agent, capability, i.effect, i.r#match.kind(), path, access, recursive, i.scope, i.created_by, now,
                i.expires_at, i.action_hash, i.task_id, i.session_id, i.project_id, i.job_id, i64::from(i.delegable), i.surface,
                i64::from(i.acknowledged_unsandboxed), i.attested_via, origin
            ],
        )?;
        let row = select(tx, "WHERE id = ?", &[&id])?
            .into_iter()
            .next()
            .ok_or_else(|| {
                GrantError::Storage("the grant row is missing after its insert".to_owned())
            })?;
        let def = row.definition();
        let def_hash = crate::approvals::node_codec::hex_encode(&Sha256::digest(def.as_bytes()));
        let def_j = J::parse(&def).unwrap_or(J::Null);
        let payload = J::obj([("def", def_j), ("defHash", J::s(&def_hash))]);
        let e = chain.append(tx, "grant.created", id, &payload, None)?;
        tx.execute(
            "UPDATE grants SET def_hash = ?, chain_seq = ? WHERE id = ?",
            params![def_hash, e.seq as i64, id],
        )?;
        Ok(Value::Object(row.to_grant()))
    }

    /// `issueOwnerJobs(person, agent, reason)`: the automatic owner job grant, checked and issued in the caller's write
    /// transaction. `None` when none is due.
    pub fn issue_owner_jobs(
        &self,
        tx: &Connection,
        chain: &ApprovalChain,
        audit: &mut dyn AuditPort,
        person: &str,
        agent: &str,
        reason: AutoJobReason,
    ) -> Result<Option<Value>, GrantError> {
        let now = self.clock.now();
        let history: Vec<View> = self
            .inspect(tx, chain, Some(person), Some(agent))?
            .into_iter()
            .filter(|v| {
                g_str(&v.grant, "capability") == Some("memory.jobs.run")
                    && g_str(&v.grant, "jobId") == Some("engine:*")
            })
            .collect();
        if history
            .iter()
            .any(|v| matches!(v.state, GrantState::Revoked | GrantState::Suspended))
        {
            return Ok(None);
        }
        let automatic: Vec<&View> = history
            .iter()
            .filter(|v| g_str(&v.grant, "origin") == Some("auto-agent-owner"))
            .collect();
        if automatic
            .iter()
            .any(|v| (now as f64) < self.expiry(&v.grant))
        {
            return Ok(None);
        }
        let due = if reason == AutoJobReason::OwnerReturned {
            !automatic.is_empty()
        } else {
            automatic.is_empty()
        };
        if !due {
            return Ok(None);
        }
        if !audit.present() {
            return Err(GrantError::refused(
                GrantErrorCode::InvalidGrant,
                "automatic grant requires the policy audit",
            ));
        }
        let mut input = CreateGrantInput::new(
            "memory.jobs.run",
            person,
            agent,
            "always",
            GrantMatch::Capability,
            AUTO_JOB_ISSUER,
            0,
        );
        input.job_id = Some("engine:*".to_owned());
        let id = format!("grt_{}", random_hex(self.random.as_ref(), 12));
        let created = self.insert(
            tx,
            chain,
            &id,
            now,
            &input,
            "memory.jobs.run",
            Some("auto-agent-owner"),
        )?;
        Self::note(
            audit,
            "grant.created",
            &created,
            None,
            Some(reason.as_str()),
            None,
        )?;
        Ok(Some(created))
    }

    /// `renewJobGrantsFromTurn(person, agent)`: records activity from the person's proved turn, at most once per
    /// [`USE_RECORD_GRANULARITY_MS`] per grant.
    pub fn renew_job_grants_from_turn(
        &self,
        tx: &Connection,
        chain: &ApprovalChain,
        audit: &mut dyn AuditPort,
        person: &str,
        agent: &str,
    ) -> Result<(), GrantError> {
        let now = self.clock.now() as f64;
        for v in self.inspect(tx, chain, Some(person), Some(agent))? {
            let g = &v.grant;
            let created = g_num(g, "createdAt").unwrap_or(f64::NAN);
            let recent =
                g_num(g, "lastJobTurnAt").is_some_and(|t| now - t < USE_RECORD_GRANULARITY_MS);
            if g_str(g, "capability") != Some("memory.jobs.run")
                || v.state != GrantState::Active
                || created > now
                || now >= self.expiry(g)
                || recent
            {
                continue;
            }
            let id = g_str(g, "id").unwrap_or_default();
            chain.append(
                tx,
                "grant.used",
                id,
                &J::obj([("kind", J::s("proved-owner-turn"))]),
                None,
            )?;
            Self::note(
                audit,
                "grant.used",
                g,
                None,
                Some("proved-owner-turn"),
                None,
            )?;
        }
        Ok(())
    }

    /// `revoke(id, by, reason)`: immediate; `false` when it was unknown or already ended. A broken chain does not block it
    /// (a revocation only narrows: the row alone ends the grant), nor does a failing audit line.
    pub fn revoke(
        &self,
        tx: &Connection,
        chain: &ApprovalChain,
        audit: &mut dyn AuditPort,
        id: &str,
        by: &str,
        reason: &str,
    ) -> Result<bool, GrantError> {
        self.revoke_value(tx, chain, audit, &SqlValue::Text(id.to_owned()), by, reason)
    }

    /// `revoke` with the id as TypeScript holds it: a string, or the `Uint8Array` a blob `id` column hands `endTask` and
    /// `endSession`, which then matches that row, enters the chain as a blob reference and shows in the audit line.
    fn revoke_value(
        &self,
        tx: &Connection,
        chain: &ApprovalChain,
        audit: &mut dyn AuditPort,
        id: &SqlValue,
        by: &str,
        reason: &str,
    ) -> Result<bool, GrantError> {
        let now = self.clock.now();
        let changed = tx.execute(
            "UPDATE grants SET revoked_at = ?, end_reason = ? WHERE id = ? AND revoked_at IS NULL",
            params![now, reason, id],
        )?;
        if changed != 1 {
            return Ok(false);
        }
        let kind = if reason == "revoked" {
            "grant.revoked"
        } else {
            "grant.ended"
        };
        let payload = J::obj([("by", J::s(by)), ("reason", J::s(reason))]);
        let appended = match id {
            SqlValue::Blob(b) => chain.append_blob_ref(tx, kind, b, &payload),
            SqlValue::Text(t) => chain.append(tx, kind, t, &payload, None),
            _ => {
                return Err(GrantError::Storage(
                    "a grant id that is neither text nor blob".to_owned(),
                ))
            }
        };
        match appended {
            Ok(_) | Err(ChainError::Broken { .. }) => {}
            Err(e) => return Err(e.into()),
        }
        if let Ok(Some(row)) = select(tx, "WHERE id = ?", &[&id]).map(|r| r.into_iter().next()) {
            let _ = Self::note(
                audit,
                kind,
                &Value::Object(row.to_grant()),
                Some(by),
                Some(reason),
                None,
            );
        }
        Ok(true)
    }

    /// `endTask(taskId, by)`: a task grant ends with its task. Returns how many ended.
    pub fn end_task(
        &self,
        tx: &Connection,
        chain: &ApprovalChain,
        audit: &mut dyn AuditPort,
        task_id: &str,
        by: &str,
    ) -> Result<usize, GrantError> {
        self.end_where(
            tx,
            chain,
            audit,
            "task",
            "task_id",
            task_id,
            by,
            "task-ended",
        )
    }

    /// `endSession(sessionId, by)`.
    pub fn end_session(
        &self,
        tx: &Connection,
        chain: &ApprovalChain,
        audit: &mut dyn AuditPort,
        session_id: &str,
        by: &str,
    ) -> Result<usize, GrantError> {
        self.end_where(
            tx,
            chain,
            audit,
            "session",
            "session_id",
            session_id,
            by,
            "session-ended",
        )
    }

    #[allow(clippy::too_many_arguments)]
    fn end_where(
        &self,
        tx: &Connection,
        chain: &ApprovalChain,
        audit: &mut dyn AuditPort,
        duration: &str,
        col: &str,
        value: &str,
        by: &str,
        reason: &str,
    ) -> Result<usize, GrantError> {
        let sql = format!(
            "SELECT id FROM grants WHERE duration = ? AND {col} = ? AND revoked_at IS NULL"
        );
        // The ids as TypeScript reads them: a blob id is a `Uint8Array` and is revoked as one.
        let ids: Vec<SqlValue> = {
            let mut stmt = tx.prepare(&sql)?;
            let rows = stmt.query_map(params![duration, value], |r| r.get::<_, SqlValue>(0))?;
            rows.collect::<Result<_, _>>()?
        };
        let mut n = 0;
        for id in ids {
            if self.revoke_value(tx, chain, audit, &id, by, reason)? {
                n += 1;
            }
        }
        Ok(n)
    }

    /// `markUsed(id)`: records a use of a standing grant (resets its idle clock), at most once per
    /// [`USE_RECORD_GRANULARITY_MS`]; a use never revives a grant whose lifetime already lapsed.
    pub fn mark_used(
        &self,
        tx: &Connection,
        chain: &ApprovalChain,
        audit: &mut dyn AuditPort,
        id: &str,
    ) -> Result<Option<View>, GrantError> {
        let Some(v) = self.view_of(tx, chain, id)? else {
            return Ok(None);
        };
        let g = &v.grant;
        if v.state != GrantState::Active
            || g_str(g, "scope") == Some("once")
            || g_str(g, "capability") == Some("memory.jobs.run")
        {
            return Ok(None);
        }
        let now = self.clock.now();
        let nf = now as f64;
        if g_num(g, "createdAt").unwrap_or(f64::NAN) > nf || nf >= self.expiry(g) {
            return Ok(None);
        }
        if g_num(g, "lastUsedAt").is_some_and(|t| nf - t < USE_RECORD_GRANULARITY_MS) {
            return Ok(None);
        }
        chain.append(tx, "grant.used", id, &J::Obj(Vec::new()), None)?;
        tx.execute(
            "UPDATE grants SET last_used_at = ? WHERE id = ?",
            params![now, id],
        )?;
        Self::note(audit, "grant.used", g, None, None, None)?;
        self.view_of(tx, chain, id)
    }

    /// The notification after a committed [`GrantStore::mark_used`].
    pub fn announce_used(&self, v: &View) {
        self.emit(Lifecycle::Used, &v.grant, v.state);
    }

    /// `consumeOnce(id, binding)` inside the caller's transaction: one `UPDATE ... WHERE consumed_at IS NULL` decides, and
    /// `changes` must be exactly 1. `false` for a revoked, expired (10 minutes unused), suspended or differently bound
    /// grant. A broken chain is [`GrantError::Integrity`]: the caller rolls back and answers `false` (nothing runs on a grant
    /// whose consumption cannot be recorded).
    #[allow(clippy::too_many_arguments)]
    pub fn consume_once(
        &self,
        tx: &Connection,
        chain: &ApprovalChain,
        audit: &mut dyn AuditPort,
        id: &str,
        person: &str,
        agent: &str,
        action_hash: &str,
    ) -> Result<bool, GrantError> {
        let Some(v) = self.view_of(tx, chain, id)? else {
            return Ok(false);
        };
        if v.state != GrantState::Active {
            return Ok(false); // chain-derived state first: a reset row cannot resurrect a consumed grant
        }
        let now = self.clock.now();
        let changed = tx.execute(
            "UPDATE grants SET consumed_at = ?, last_used_at = ?
         WHERE id = ? AND duration = 'once' AND consumed_at IS NULL AND revoked_at IS NULL
           AND person = ? AND agent = ? AND action_hash = ?
           AND created_at + ? > ? AND (expires_at IS NULL OR expires_at > ?)",
            params![
                now,
                now,
                id,
                person,
                agent,
                action_hash,
                ONCE_UNUSED_MS as i64,
                now,
                now
            ],
        )?;
        if changed != 1 {
            return Ok(false);
        }
        chain.append(
            tx,
            "grant.consumed",
            id,
            &J::obj([("actionHash", J::s(action_hash))]),
            None,
        )?;
        Self::note(
            audit,
            "grant.consumed",
            &v.grant,
            None,
            None,
            Some(action_hash),
        )?;
        Ok(true)
    }
}
