//! `identity/service.ts`, the stateful part: humans, linked channel identities, pairing by one-time code, back-fill
//! records (ADR-007, P4-12 task 4). A library: nothing in the front door calls it yet.
//!
//! Every method does what its TypeScript namesake does, in the same order: which check comes first decides which refusal a
//! caller sees, and what is written before a refusal stays written. The sequences under `fixtures/parity/identity-store/`
//! (`scripts/parity/export-identity-store.ts`) are replayed by `service_vectors.rs`: results, errors, audit events, random
//! draws and every table after every step.
//!
//! - The clock and the random source are parameters ([`IdentityOptions`], ruling R6).
//! - A write runs in one `BEGIN IMMEDIATE` transaction; a refusal that must leave a state change behind (an expired claim,
//!   a counted wrong code) is returned from the transaction and raised after it.
//! - An audit event carries hashes, never an id in the clear, except the members named in [`CLEAR_DETAIL`]; a failing sink
//!   never decides an outcome.
//! - An error of SQLite that the TypeScript service lets through (a constraint of the back-fill table) is
//!   [`IdentityFailure::Sqlite`]; everything the service itself refuses is an [`IdentityError`].
use super::authorization::{
    require_authorization, AuthorizePort, IdentityAction, RbacAuthorizePort,
};
use super::codes::{
    generate_code, hash_code, hashes_equal, new_salt, normalize_code, uuidv7, RandomSource,
    CODE_LENGTH,
};
use super::error::{IdentityError, IdentityErrorCode};
use super::principals::{derive_user_principal, is_user_principal};
use super::ratelimit::{self as limiter, LimitSpec, GLOBAL_KEY, GLOBAL_LIMIT, SOURCE_LIMIT};
use super::recall::PrincipalResolver;
use super::service::{
    channel_of, identity_of, text, v1_principal_of, Actor, ChannelIdentity, DEFAULT_CODE_TTL_MS,
    MAX_CODE_TTL_MS, MAX_PENDING_PER_HUMAN_CHANNEL,
};
use super::sha256_hex;
use super::store::{open_store, SqlAttempts};
use crate::js::utf16;
use plur1bus_store::rusqlite::{self, Connection, OptionalExtension, Row};
use plur1bus_store::{Store, StoreError};
use serde_json::{json, Map, Value};
use std::path::{Path, PathBuf};

/// Finished proofs and lapsed codes older than this are dropped when the service starts (30 days).
const PRUNE_AFTER_MS: i64 = 30 * 24 * 3_600_000;
/// Issuance per human: ten codes in 15 minutes, then locked for 15 minutes.
const ISSUE_USER_LIMIT: LimitSpec = LimitSpec {
    limit: 10,
    window_ms: 15 * 60_000,
    lock_ms: 15 * 60_000,
};
/// Issuance over every human together: a hundred codes in 15 minutes.
const ISSUE_GLOBAL_LIMIT: LimitSpec = LimitSpec {
    limit: 100,
    window_ms: 15 * 60_000,
    lock_ms: 15 * 60_000,
};
const ISSUE_GLOBAL_KEY: &str = "issue:global";
/// The detail members an audit event keeps in the clear; every other string member is replaced by its SHA-256.
pub const CLEAR_DETAIL: [&str; 4] = ["channel", "proof", "result", "reason"];

/// What a method of the service fails with.
#[derive(Debug)]
pub enum IdentityFailure {
    /// The service refused: the closed vocabulary the RPC layer maps.
    Refused(IdentityError),
    /// SQLite failed and the TypeScript service does not catch it either.
    Sqlite(rusqlite::Error),
}

impl From<IdentityError> for IdentityFailure {
    fn from(e: IdentityError) -> Self {
        IdentityFailure::Refused(e)
    }
}
impl From<super::codes::RangeError> for IdentityFailure {
    fn from(e: super::codes::RangeError) -> Self {
        IdentityFailure::Refused(e.into())
    }
}
impl From<rusqlite::Error> for IdentityFailure {
    fn from(e: rusqlite::Error) -> Self {
        IdentityFailure::Sqlite(e)
    }
}
impl From<StoreError> for IdentityFailure {
    fn from(e: StoreError) -> Self {
        match e {
            StoreError::Sqlite(e) => IdentityFailure::Sqlite(e),
            other => IdentityFailure::Refused(IdentityError::new(
                IdentityErrorCode::Storage,
                other.to_string(),
            )),
        }
    }
}
impl std::fmt::Display for IdentityFailure {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            IdentityFailure::Refused(e) => write!(f, "{e}"),
            IdentityFailure::Sqlite(e) => write!(f, "sqlite: {e}"),
        }
    }
}
impl std::error::Error for IdentityFailure {}

type Outcome<T> = Result<T, IdentityFailure>;

fn refuse(code: IdentityErrorCode, message: impl Into<String>) -> IdentityFailure {
    IdentityFailure::Refused(IdentityError::new(code, message))
}

/// `Human`.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Human {
    /// The harness user id (a UUIDv7).
    pub id: String,
    /// The label.
    pub display_name: String,
    /// When the human was created.
    pub created_at: i64,
}

/// `Link`: one channel handle of a human. Revoking detaches; the record stays for the audit trail.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Link {
    /// The link id (a UUIDv7).
    pub id: String,
    /// The human it belongs to.
    pub human_id: String,
    /// The channel kind.
    pub channel: String,
    /// The account on that channel.
    pub account_id: String,
    /// The external user id.
    pub user_id: String,
    /// A label; never matched on.
    pub display_name: Option<String>,
    /// The engine's v1 principal of this handle, kept so recall can read the union.
    pub v1_principal: String,
    /// `pairing_code`, `owner_manual` or `signed_challenge`, as stored.
    pub proof_method: String,
    /// When it was linked.
    pub linked_at: i64,
    /// Who linked it.
    pub linked_by: String,
    /// When it was revoked.
    pub revoked_at: Option<i64>,
    /// Who revoked it.
    pub revoked_by: Option<String>,
}

/// `Pairing`: a pending or resolved proof.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Pairing {
    /// The pairing id.
    pub id: String,
    /// The human the code was minted for.
    pub human_id: String,
    /// The channel the code is valid on.
    pub channel: String,
    /// `pending`, `claimed`, `confirmed`, `declined` or `expired`.
    pub state: String,
    /// When the code was minted.
    pub created_at: i64,
    /// When the code lapses.
    pub expires_at: i64,
    /// The handle that presented the code.
    pub claimed_by: Option<ChannelIdentity>,
    /// Until when the owner may confirm the claim.
    pub confirm_by: Option<i64>,
}

/// One row of `backfills`, as the store holds it.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct BackfillRecord {
    /// The link the back-fill belongs to.
    pub link_id: String,
    /// The operation id; used once.
    pub operation_id: String,
    /// `running`, `applied`, `reversing` or `reversed`.
    pub state: String,
    /// SHA-256 of the actor's user id.
    pub actor_hash: String,
    /// When it was reserved.
    pub at: i64,
    /// The row count of the last finished step.
    pub count: Option<i64>,
    /// Its receipt.
    pub receipt: Option<String>,
}

/// The state `finish_backfill` moves a record to.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum BackfillState {
    /// From `running` (or `applied` again).
    Applied,
    /// From `applied` (or `reversing` again).
    Reversing,
    /// From `reversing` (or `reversed` again).
    Reversed,
}

impl BackfillState {
    /// The stored name.
    pub fn as_str(self) -> &'static str {
        match self {
            BackfillState::Applied => "applied",
            BackfillState::Reversing => "reversing",
            BackfillState::Reversed => "reversed",
        }
    }
    /// The state named exactly `s`.
    pub fn parse(s: &str) -> Option<BackfillState> {
        [
            BackfillState::Applied,
            BackfillState::Reversing,
            BackfillState::Reversed,
        ]
        .into_iter()
        .find(|v| v.as_str() == s)
    }
    fn allowed(self) -> [&'static str; 2] {
        match self {
            BackfillState::Applied => ["running", "applied"],
            BackfillState::Reversing => ["applied", "reversing"],
            BackfillState::Reversed => ["reversing", "reversed"],
        }
    }
}

/// The `actor` of an audit event: hashes of the acting user and host.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct AuditActor {
    /// SHA-256 of the user id.
    pub user: String,
    /// SHA-256 of the host.
    pub host: String,
}

/// `AuditEvent`. `detail` keeps the order its producer wrote the members in (the audit line is written in that order).
#[derive(Clone, Debug, PartialEq)]
pub struct AuditEvent {
    /// The action name.
    pub action: String,
    /// What it was done to.
    pub target: String,
    /// Further members.
    pub detail: Vec<(String, Value)>,
    /// Who did it; `None` for a claim relayed by a channel adapter (the audit writer attributes it to the core).
    pub actor: Option<AuditActor>,
}

impl AuditEvent {
    /// `{ action, target, detail, actor? }`.
    pub fn to_json(&self) -> Value {
        let mut out = Map::new();
        out.insert("action".into(), json!(self.action));
        out.insert("target".into(), json!(self.target));
        out.insert(
            "detail".into(),
            Value::Object(self.detail.iter().cloned().collect()),
        );
        if let Some(actor) = &self.actor {
            out.insert(
                "actor".into(),
                json!({ "user": actor.user, "host": actor.host }),
            );
        }
        Value::Object(out)
    }
}

/// Where audit events go. An `Err` is not looked at: the durable store remains authoritative.
pub trait IdentityAudit {
    /// Records one event.
    fn emit(&mut self, event: &AuditEvent) -> Result<(), String>;
}

impl<F: FnMut(&AuditEvent) -> Result<(), String>> IdentityAudit for F {
    fn emit(&mut self, event: &AuditEvent) -> Result<(), String> {
        self(event)
    }
}

/// `IdentityOptions`.
pub struct IdentityOptions {
    /// `state/identity.sqlite`.
    pub db_path: PathBuf,
    /// Epoch milliseconds.
    pub clock: Box<dyn Fn() -> i64>,
    /// The audit sink.
    pub audit: Box<dyn IdentityAudit>,
    /// Codes, salts and ids are drawn from here.
    pub random: Box<dyn RandomSource>,
    /// The host's `securePath`, applied to the database file.
    pub secure_path: Box<dyn Fn(&Path)>,
    /// The policy asked for every owner-side action; `None` is [`RbacAuthorizePort`].
    pub authorize: Option<Box<dyn AuthorizePort>>,
    /// Lifetime of a code and of a claim waiting for the owner. `None` is ten minutes; at most one hour. Set, it is also
    /// the ceiling of a per-code lifetime.
    pub code_ttl_ms: Option<i64>,
}

/// What `start_pairing` returns: the code is handed out here once and exists nowhere else but as a salted hash.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct StartedPairing {
    /// The pairing id.
    pub pairing_id: String,
    /// The code, in the clear.
    pub code: String,
    /// The channel it is valid on.
    pub channel: String,
    /// When it lapses.
    pub expires_at: i64,
}

/// What `claim` returns: the claim waits for the owner.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Claimed {
    /// The pairing id.
    pub pairing_id: String,
    /// Until when the owner may confirm.
    pub confirm_by: i64,
}

/// What `confirm` returns.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Confirmed {
    /// The pairing id.
    pub pairing_id: String,
    /// `confirmed` or `declined`.
    pub state: String,
    /// The new link of a confirmed claim.
    pub link: Option<Link>,
}

/// What `list` returns.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Listing {
    /// Every human with its links, by creation time.
    pub humans: Vec<(Human, Vec<Link>)>,
    /// The pairings asked for.
    pub pairings: Vec<Pairing>,
}

/// What `resolve` returns for a linked handle.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Resolved {
    /// The human the handle belongs to.
    pub human_id: String,
    /// The link that says so.
    pub link_id: String,
}

fn opt(map: &mut Map<String, Value>, key: &str, value: Option<Value>) {
    if let Some(v) = value {
        map.insert(key.into(), v);
    }
}

impl Human {
    /// `{ id, displayName, createdAt }`.
    pub fn to_json(&self) -> Value {
        json!({ "id": self.id, "displayName": self.display_name, "createdAt": self.created_at })
    }
}

impl Link {
    /// The `Link` object of the TypeScript service (`displayName` only when there is one).
    pub fn to_json(&self) -> Value {
        let mut out = Map::new();
        out.insert("id".into(), json!(self.id));
        out.insert("humanId".into(), json!(self.human_id));
        out.insert("channel".into(), json!(self.channel));
        out.insert("accountId".into(), json!(self.account_id));
        out.insert("userId".into(), json!(self.user_id));
        opt(
            &mut out,
            "displayName",
            self.display_name.as_ref().map(|v| json!(v)),
        );
        out.insert("v1Principal".into(), json!(self.v1_principal));
        out.insert("proofMethod".into(), json!(self.proof_method));
        out.insert("linkedAt".into(), json!(self.linked_at));
        out.insert("linkedBy".into(), json!(self.linked_by));
        out.insert("revokedAt".into(), json!(self.revoked_at));
        out.insert("revokedBy".into(), json!(self.revoked_by));
        Value::Object(out)
    }
}

fn identity_json(i: &ChannelIdentity) -> Value {
    let mut out = Map::new();
    out.insert("channel".into(), json!(i.channel));
    out.insert("accountId".into(), json!(i.account_id));
    out.insert("userId".into(), json!(i.user_id));
    opt(
        &mut out,
        "displayName",
        i.display_name.as_ref().map(|v| json!(v)),
    );
    Value::Object(out)
}

impl Pairing {
    /// The `Pairing` object of the TypeScript service.
    pub fn to_json(&self) -> Value {
        let mut out = Map::new();
        out.insert("id".into(), json!(self.id));
        out.insert("humanId".into(), json!(self.human_id));
        out.insert("channel".into(), json!(self.channel));
        out.insert("state".into(), json!(self.state));
        out.insert("createdAt".into(), json!(self.created_at));
        out.insert("expiresAt".into(), json!(self.expires_at));
        opt(
            &mut out,
            "claimedBy",
            self.claimed_by.as_ref().map(identity_json),
        );
        opt(&mut out, "confirmBy", self.confirm_by.map(|v| json!(v)));
        Value::Object(out)
    }
}

impl BackfillRecord {
    /// The row as the TypeScript service returns it (column names).
    pub fn to_json(&self) -> Value {
        json!({ "link_id": self.link_id, "operation_id": self.operation_id, "state": self.state,
            "actor_hash": self.actor_hash, "at": self.at, "count": self.count, "receipt": self.receipt })
    }
}

impl StartedPairing {
    /// `{ pairingId, code, channel, expiresAt }`.
    pub fn to_json(&self) -> Value {
        json!({ "pairingId": self.pairing_id, "code": self.code, "channel": self.channel, "expiresAt": self.expires_at })
    }
}

impl Claimed {
    /// `{ pairingId, state: "awaiting-confirmation", confirmBy }`.
    pub fn to_json(&self) -> Value {
        json!({ "pairingId": self.pairing_id, "state": "awaiting-confirmation", "confirmBy": self.confirm_by })
    }
}

impl Confirmed {
    /// `{ pairingId, state, link? }`.
    pub fn to_json(&self) -> Value {
        let mut out = Map::new();
        out.insert("pairingId".into(), json!(self.pairing_id));
        out.insert("state".into(), json!(self.state));
        opt(&mut out, "link", self.link.as_ref().map(Link::to_json));
        Value::Object(out)
    }
}

impl Listing {
    /// `{ humans: [{ id, displayName, createdAt, identities }], pairings }`.
    pub fn to_json(&self) -> Value {
        let humans: Vec<Value> = self
            .humans
            .iter()
            .map(|(h, links)| {
                let mut v = h.to_json();
                v["identities"] = Value::Array(links.iter().map(Link::to_json).collect());
                v
            })
            .collect();
        json!({ "humans": humans, "pairings": self.pairings.iter().map(Pairing::to_json).collect::<Vec<_>>() })
    }
}

impl Resolved {
    /// `{ humanId, linkId }`.
    pub fn to_json(&self) -> Value {
        json!({ "humanId": self.human_id, "linkId": self.link_id })
    }
}

/// SHA-256 of a string's UTF-8, as lower-case hex (`digest` of `service.ts`).
fn digest(value: &str) -> String {
    sha256_hex(&[value.as_bytes()])
}

fn link_of(row: &Row<'_>) -> rusqlite::Result<Link> {
    Ok(Link {
        id: row.get("id")?,
        human_id: row.get("human_id")?,
        channel: row.get("channel")?,
        account_id: row.get("account_id")?,
        user_id: row.get("channel_user_id")?,
        display_name: row.get("display_name")?,
        v1_principal: row.get("v1_principal")?,
        proof_method: row.get("proof_method")?,
        linked_at: row.get("linked_at")?,
        linked_by: row.get("linked_by")?,
        revoked_at: row.get("revoked_at")?,
        revoked_by: row.get("revoked_by")?,
    })
}

/// A row of the connection's `pairings` table.
struct PairingRow {
    id: String,
    human_id: String,
    channel: String,
    salt: String,
    code_hash: String,
    state: String,
    created_at: i64,
    expires_at: i64,
    claim_account_id: Option<String>,
    claim_user_id: Option<String>,
    claim_display_name: Option<String>,
    claimed_at: Option<i64>,
    confirm_by: Option<i64>,
}

fn pairing_row(row: &Row<'_>) -> rusqlite::Result<PairingRow> {
    Ok(PairingRow {
        id: row.get("id")?,
        human_id: row.get("human_id")?,
        channel: row.get("channel")?,
        salt: row.get("salt")?,
        code_hash: row.get("code_hash")?,
        state: row.get("state")?,
        created_at: row.get("created_at")?,
        expires_at: row.get("expires_at")?,
        claim_account_id: row.get("claim_account_id")?,
        claim_user_id: row.get("claim_user_id")?,
        claim_display_name: row.get("claim_display_name")?,
        claimed_at: row.get("claimed_at")?,
        confirm_by: row.get("confirm_by")?,
    })
}

impl PairingRow {
    /// The handle that claimed the code, when one did (`claim_user_id` is set).
    fn claimant(&self) -> Option<ChannelIdentity> {
        self.claim_user_id.as_ref().map(|user_id| ChannelIdentity {
            channel: self.channel.clone(),
            account_id: self.claim_account_id.clone().unwrap_or_default(),
            user_id: user_id.clone(),
            display_name: self.claim_display_name.clone(),
        })
    }
    /// `pairingOf`.
    fn pairing(&self) -> Pairing {
        Pairing {
            id: self.id.clone(),
            human_id: self.human_id.clone(),
            channel: self.channel.clone(),
            state: self.state.clone(),
            created_at: self.created_at,
            expires_at: self.expires_at,
            claimed_by: self.claimant(),
            confirm_by: self.confirm_by,
        }
    }
}

fn one_pairing(conn: &Connection, id: &str) -> rusqlite::Result<Option<PairingRow>> {
    conn.prepare_cached("SELECT * FROM pairings WHERE id = ?")?
        .query_row([id], pairing_row)
        .optional()
}

fn one_link(conn: &Connection, id: &str) -> rusqlite::Result<Option<Link>> {
    conn.prepare_cached("SELECT * FROM identities WHERE id = ?")?
        .query_row([id], link_of)
        .optional()
}

/// `requireHuman`: the id is checked as text first; an unknown one is `not-found`.
fn require_human(conn: &Connection, id: &str) -> Outcome<()> {
    text(id, "humanId", 64)?;
    let found: Option<String> = conn
        .prepare_cached("SELECT id FROM humans WHERE id = ?")?
        .query_row([id], |row| row.get(0))
        .optional()?;
    match found {
        Some(_) => Ok(()),
        None => Err(refuse(
            IdentityErrorCode::NotFound,
            format!("no such human: {id}"),
        )),
    }
}

/// `activeLink`: the unrevoked link of a handle, by the exact triple.
fn active_link(
    conn: &Connection,
    channel: &str,
    account_id: &str,
    user_id: &str,
) -> rusqlite::Result<Option<Link>> {
    conn.prepare_cached("SELECT * FROM identities WHERE channel = ? AND account_id = ? AND channel_user_id = ? AND revoked_at IS NULL")?
        .query_row([channel, account_id, user_id], link_of)
        .optional()
}

fn conflict(i: &ChannelIdentity) -> IdentityError {
    IdentityError::new(
        IdentityErrorCode::Conflict,
        format!(
            "{} identity is already linked to a human; unlink it first",
            i.channel
        ),
    )
}

fn stored_principals(conn: &Connection, human_id: &str) -> Outcome<Vec<String>> {
    let principals: Vec<String> = conn
        .prepare_cached("SELECT v1_principal FROM identities WHERE human_id = ? AND revoked_at IS NULL ORDER BY linked_at, id")?
        .query_map([human_id], |row| row.get(0))?
        .collect::<rusqlite::Result<_>>()?;
    if principals
        .iter()
        .any(|p| !is_user_principal(p) || !p.starts_with("user:v1:"))
    {
        return Err(refuse(
            IdentityErrorCode::Storage,
            "invalid stored principal",
        ));
    }
    Ok(principals)
}

/// The parts of the service a transaction body needs besides the connection.
struct Parts<'a> {
    clock: &'a dyn Fn() -> i64,
    random: &'a mut dyn RandomSource,
    audit: &'a mut dyn IdentityAudit,
    authorize: &'a dyn AuthorizePort,
}

/// What a producer hands to the audit: ids in the clear; [`emit_audit`] hashes them.
struct Audited<'a> {
    action: &'a str,
    target: &'a str,
    detail: Vec<(&'a str, Value)>,
    actor: Option<&'a Actor>,
}

/// The second name some events are also recorded under.
fn second_name(action: &str, result: Option<&str>) -> Option<&'static str> {
    match action {
        "identity.link" => Some("link.approved"),
        "identity.pair.start" => Some("link.requested"),
        "identity.pair.confirm" => Some(if result == Some("confirmed") {
            "link.approved"
        } else {
            "link.declined"
        }),
        "identity.unlink" => Some("link.removed"),
        "identity.pair.rate-limited" => Some("pairing.locked"),
        "identity.pair.claim" if result == Some("refused") => Some("pairing.failed"),
        _ => None,
    }
}

/// `audit(e)`: the target, the actor and every string member of the detail outside [`CLEAR_DETAIL`] are replaced by their
/// SHA-256; the event goes to the sink, and for some actions a second time under another name. A failing sink is ignored.
fn emit_audit(sink: &mut dyn IdentityAudit, e: Audited<'_>) {
    let result = e
        .detail
        .iter()
        .find(|(k, _)| *k == "result")
        .and_then(|(_, v)| v.as_str().map(str::to_owned));
    let detail = e
        .detail
        .into_iter()
        .map(|(k, v)| {
            let v = match &v {
                Value::String(s) if !CLEAR_DETAIL.contains(&k) => Value::String(digest(s)),
                _ => v,
            };
            (k.to_owned(), v)
        })
        .collect();
    let mut safe = AuditEvent {
        action: e.action.to_owned(),
        target: digest(e.target),
        detail,
        actor: e.actor.map(|a| AuditActor {
            user: digest(&a.user),
            host: digest(&a.host),
        }),
    };
    let _ = sink.emit(&safe);
    if let Some(name) = second_name(e.action, result.as_deref()) {
        safe.action = name.to_owned();
        let _ = sink.emit(&safe);
    }
}

fn handle_detail(i: &ChannelIdentity) -> Vec<(&'static str, Value)> {
    vec![
        ("channel", json!(i.channel)),
        ("accountId", json!(i.account_id)),
        ("userId", json!(i.user_id)),
    ]
}

/// `insertLink`.
fn insert_link(
    conn: &Connection,
    parts: &mut Parts<'_>,
    human_id: &str,
    i: &ChannelIdentity,
    proof: &str,
    by: &str,
) -> Outcome<Link> {
    let id = uuidv7((parts.clock)() as f64, parts.random)?;
    conn.prepare_cached("INSERT INTO identities(id, human_id, channel, account_id, channel_user_id, display_name, v1_principal, proof_method, linked_at, linked_by) VALUES (?,?,?,?,?,?,?,?,?,?)")?
        .execute(rusqlite::params![id, human_id, i.channel, i.account_id, i.user_id, i.display_name,
            v1_principal_of(&i.channel, &i.account_id, &i.user_id), proof, (parts.clock)(), by])?;
    one_link(conn, &id)?
        .ok_or_else(|| IdentityFailure::Sqlite(rusqlite::Error::QueryReturnedNoRows))
}

/// The identity service (`createIdentityService`).
pub struct IdentityService {
    store: Store,
    ttl: i64,
    ttl_cap: i64,
    clock: Box<dyn Fn() -> i64>,
    audit: Box<dyn IdentityAudit>,
    random: Box<dyn RandomSource>,
    authorize: Box<dyn AuthorizePort>,
}

enum ClaimOutcome {
    Ok(Box<Pairing>),
    Fail(&'static str),
    Locked(i64),
    Taken,
}

struct ConfirmOutcome {
    state: &'static str,
    link: Option<Link>,
    refuse: Option<IdentityError>,
}

impl IdentityService {
    /// Opens (creating and migrating) the store and drops what has lapsed: finished proofs and old limiter rows.
    pub fn create(o: IdentityOptions) -> Outcome<IdentityService> {
        let store = open_store(&o.db_path, o.secure_path.as_ref())?;
        let ttl = o.code_ttl_ms.unwrap_or(DEFAULT_CODE_TTL_MS);
        let ttl_cap = o.code_ttl_ms.unwrap_or(MAX_CODE_TTL_MS);
        if ttl <= 0 || ttl > MAX_CODE_TTL_MS {
            drop(store);
            return Err(IdentityError::bad(
                "codeTtlMs",
                "TTL must be positive and at most one hour",
            )
            .into());
        }
        let mut service = IdentityService {
            store,
            ttl,
            ttl_cap,
            clock: o.clock,
            audit: o.audit,
            random: o.random,
            authorize: o.authorize.unwrap_or_else(|| Box::new(RbacAuthorizePort)),
        };
        let clock = &service.clock;
        service.store.write_with(|tx| -> Outcome<()> {
            // Finished proofs are retained only inside this process, with bounded lifetime.
            tx.execute(
                "DELETE FROM pairings WHERE state != 'pending' AND created_at < ?",
                [clock() - PRUNE_AFTER_MS],
            )?;
            tx.execute(
                "DELETE FROM pairings WHERE state = 'pending' AND expires_at < ?",
                [clock() - PRUNE_AFTER_MS],
            )?;
            limiter::prune(&mut SqlAttempts(tx), clock())?;
            Ok(())
        })?;
        Ok(service)
    }

    /// The connection, for the replay's table dumps and its raw statements.
    #[cfg(test)]
    pub(crate) fn conn(&self) -> &Connection {
        self.store.conn()
    }

    fn split(&mut self) -> (&mut Store, Parts<'_>, i64, i64) {
        let parts = Parts {
            clock: self.clock.as_ref(),
            random: self.random.as_mut(),
            audit: self.audit.as_mut(),
            authorize: self.authorize.as_ref(),
        };
        (&mut self.store, parts, self.ttl, self.ttl_cap)
    }

    /// `authorizeAction`: `denied` unless the policy lets this person do it.
    pub fn authorize_action(
        &self,
        action: IdentityAction,
        user: &str,
        actor: &Actor,
    ) -> Result<(), IdentityError> {
        require_authorization(self.authorize.as_ref(), actor, action, user)
    }

    /// `createHuman`.
    pub fn create_human(&mut self, display_name: &str, actor: &Actor) -> Outcome<Human> {
        self.authorize_action(IdentityAction::Create, "", actor)?;
        text(display_name, "displayName", super::service::MAX_FIELD)?;
        let (store, parts, _, _) = self.split();
        let id = uuidv7((parts.clock)() as f64, parts.random)?;
        let t = (parts.clock)();
        store
            .conn()
            .prepare_cached(
                "INSERT INTO humans(id, display_name, created_at, created_by) VALUES (?,?,?,?)",
            )?
            .execute(rusqlite::params![id, display_name, t, actor.user])?;
        emit_audit(
            parts.audit,
            Audited {
                action: "identity.human.create",
                target: &id,
                detail: vec![("displayName", json!(display_name))],
                actor: Some(actor),
            },
        );
        Ok(Human {
            id,
            display_name: display_name.to_owned(),
            created_at: t,
        })
    }

    /// `link`: the owner's manual, deliberate link. No code, immediate, audited (requested, then made).
    pub fn link(
        &mut self,
        human_id: &str,
        identity: &ChannelIdentity,
        actor: &Actor,
    ) -> Outcome<Link> {
        self.authorize_action(IdentityAction::Link, human_id, actor)?;
        let i = identity_of(identity)?;
        let (store, mut parts, _, _) = self.split();
        emit_audit(
            parts.audit,
            Audited {
                action: "link.requested",
                target: human_id,
                detail: handle_detail(&i),
                actor: Some(actor),
            },
        );
        let l = store.write_with(|tx| -> Outcome<Link> {
            require_human(tx, human_id)?;
            if active_link(tx, &i.channel, &i.account_id, &i.user_id)?.is_some() {
                return Err(conflict(&i).into());
            }
            insert_link(tx, &mut parts, human_id, &i, "owner_manual", &actor.user)
        })?;
        let mut detail = vec![("humanId", json!(l.human_id))];
        detail.extend(handle_detail(&i));
        detail.push(("proof", json!(l.proof_method)));
        emit_audit(
            parts.audit,
            Audited {
                action: "identity.link",
                target: &l.id,
                detail,
                actor: Some(actor),
            },
        );
        Ok(l)
    }

    /// `revokePairing`: revoking an invitation invalidates an unclaimed and a claimed proof before confirmation.
    pub fn revoke_pairing(&mut self, id: &str, actor: &Actor) -> Outcome<()> {
        let (store, parts, _, _) = self.split();
        store.write_with(|tx| -> Outcome<()> {
            text(id, "pairingId", 64)?;
            let row = one_pairing(tx, id)?
                .ok_or_else(|| refuse(IdentityErrorCode::NotFound, "pairing not found"))?;
            require_authorization(
                parts.authorize,
                actor,
                IdentityAction::Confirm,
                &row.human_id,
            )?;
            if row.state == "confirmed" {
                return Err(refuse(
                    IdentityErrorCode::Conflict,
                    "a confirmed pairing cannot be revoked as an invitation",
                ));
            }
            tx.prepare_cached("UPDATE pairings SET state='declined',resolved_at=? WHERE id=?")?
                .execute(rusqlite::params![(parts.clock)(), id])?;
            Ok(())
        })?;
        emit_audit(
            parts.audit,
            Audited {
                action: "identity.pair.revoke",
                target: id,
                detail: vec![("result", json!("revoked"))],
                actor: Some(actor),
            },
        );
        Ok(())
    }

    /// `startPairing`: mints a code for `human_id` on `channel`. `ttl_ms` is a JavaScript number: an integer of at least a
    /// minute and at most the ceiling, or `invalid-params`.
    pub fn start_pairing(
        &mut self,
        human_id: &str,
        channel: &str,
        ttl_ms: Option<f64>,
        actor: &Actor,
    ) -> Outcome<StartedPairing> {
        let (store, parts, ttl, ttl_cap) = self.split();
        let lifetime = match ttl_ms {
            None => ttl,
            Some(v) => {
                if !v.is_finite() || v.fract() != 0.0 || v < 60_000.0 || v > ttl_cap as f64 {
                    return Err(
                        IdentityError::bad("ttlMs", "pairing TTL must be 1-60 minutes").into(),
                    );
                }
                v as i64
            }
        };
        require_authorization(parts.authorize, actor, IdentityAction::Pair, human_id)?;
        channel_of(channel, "channel")?;
        let out = store.write_with(|tx| -> Outcome<StartedPairing> {
            require_human(tx, human_id)?;
            let t = (parts.clock)();
            let user_key = format!("issue:{}", digest(human_id));
            let locked = limiter::locked_for(&SqlAttempts(tx), &[&user_key, ISSUE_GLOBAL_KEY], (parts.clock)())?;
            if locked != 0 {
                emit_audit(parts.audit, Audited { action: "identity.pair.rate-limited", target: &user_key,
                    detail: vec![("retryAfterMs", json!(locked)), ("reason", json!("issuance"))], actor: Some(actor) });
                return Err(IdentityError { retry_after_ms: Some(locked), ..IdentityError::new(IdentityErrorCode::RateLimited, "pairing issuance locked") }.into());
            }
            let pending: i64 = tx
                .prepare_cached("SELECT COUNT(*) AS n FROM pairings WHERE human_id = ? AND channel = ? AND ((state = 'pending' AND expires_at > ?) OR (state = 'claimed' AND confirm_by > ?))")?
                .query_row(rusqlite::params![human_id, channel, t, t], |row| row.get(0))?;
            if pending >= MAX_PENDING_PER_HUMAN_CHANNEL as i64 {
                return Err(refuse(IdentityErrorCode::Limit, format!("at most {MAX_PENDING_PER_HUMAN_CHANNEL} pending codes per human and channel")));
            }
            limiter::failure(&mut SqlAttempts(tx), &user_key, &ISSUE_USER_LIMIT, (parts.clock)())?;
            limiter::failure(&mut SqlAttempts(tx), ISSUE_GLOBAL_KEY, &ISSUE_GLOBAL_LIMIT, (parts.clock)())?;
            let code = generate_code(parts.random);
            let salt = new_salt(parts.random);
            let id = uuidv7(t as f64, parts.random)?;
            tx.prepare_cached("INSERT INTO pairings(id, human_id, channel, salt, code_hash, state, created_at, created_by, expires_at) VALUES (?,?,?,?,?,'pending',?,?,?)")?
                .execute(rusqlite::params![id, human_id, channel, salt, hash_code(&salt, &code), t, actor.user, t + lifetime])?;
            Ok(StartedPairing { pairing_id: id, code, channel: channel.to_owned(), expires_at: t + lifetime })
        })?;
        emit_audit(
            parts.audit,
            Audited {
                action: "identity.pair.start",
                target: &out.pairing_id,
                detail: vec![
                    ("humanId", json!(human_id)),
                    ("channel", json!(channel)),
                    ("expiresAt", json!(out.expires_at)),
                ],
                actor: Some(actor),
            },
        );
        Ok(out)
    }

    /// `claim`: the claimant presents a code from their handle. A match consumes the code and parks the claim until the
    /// owner confirms; it links nothing by itself. Wrong, expired, reused and wrong-channel codes all answer the same
    /// `invalid-code`, and failures are counted per handle and overall.
    pub fn claim(&mut self, code: &str, identity: &ChannelIdentity) -> Outcome<Claimed> {
        let i = identity_of(identity)?;
        // `src:` plus the SHA-256 of JSON.stringify([channel, accountId, userId]): the hash the v1 principal is made of.
        let v1 = v1_principal_of(&i.channel, &i.account_id, &i.user_id);
        let src_key = format!("src:{}", v1.trim_start_matches("user:v1:"));
        let (store, parts, ttl, _) = self.split();
        let outcome = store.write_with(|tx| -> Outcome<ClaimOutcome> {
            let wait = limiter::locked_for(&SqlAttempts(tx), &[&src_key, GLOBAL_KEY], (parts.clock)())?;
            if wait > 0 {
                return Ok(ClaimOutcome::Locked(wait));
            }
            let t = (parts.clock)();
            let code = if utf16(code).len() <= 128 { normalize_code(code) } else { String::new() };
            let shaped = utf16(&code).len() == CODE_LENGTH;
            let mut hit: Option<PairingRow> = None;
            let mut why = "wrong";
            // Every row, so the work does not depend on where a match sits.
            let rows: Vec<PairingRow> = tx
                .prepare_cached("SELECT * FROM pairings WHERE channel = ?")?
                .query_map([&i.channel], pairing_row)?
                .collect::<rusqlite::Result<_>>()?;
            for r in rows {
                let eq = hashes_equal(&hash_code(&r.salt, &code), &r.code_hash) && shaped;
                if !eq {
                    continue;
                }
                if r.state == "pending" && r.expires_at > t {
                    hit = Some(r);
                } else {
                    why = if r.state == "pending" { "expired" } else { "reused" };
                }
            }
            let Some(hit) = hit else {
                limiter::failure(&mut SqlAttempts(tx), &src_key, &SOURCE_LIMIT, (parts.clock)())?;
                limiter::failure(&mut SqlAttempts(tx), GLOBAL_KEY, &GLOBAL_LIMIT, (parts.clock)())?;
                return Ok(ClaimOutcome::Fail(why));
            };
            // Not the claimant's guess failing: nothing counted, the code stays usable.
            if active_link(tx, &i.channel, &i.account_id, &i.user_id)?.is_some() {
                return Ok(ClaimOutcome::Taken);
            }
            let user_key = format!("claim:{}", digest(&hit.human_id));
            let user_wait = limiter::locked_for(&SqlAttempts(tx), &[&user_key], (parts.clock)())?;
            if user_wait != 0 {
                return Ok(ClaimOutcome::Locked(user_wait));
            }
            limiter::failure(&mut SqlAttempts(tx), &user_key, &SOURCE_LIMIT, (parts.clock)())?;
            let confirm_by = if hit.expires_at - hit.created_at < ttl { (t + ttl).min(hit.expires_at) } else { t + ttl };
            tx.prepare_cached("UPDATE pairings SET state = 'claimed', claim_account_id = ?, claim_user_id = ?, claim_display_name = ?, claimed_at = ?, confirm_by = ? WHERE id = ?")?
                .execute(rusqlite::params![i.account_id, i.user_id, i.display_name, t, confirm_by, hit.id])?;
            limiter::success(&mut SqlAttempts(tx), &src_key)?;
            let row = one_pairing(tx, &hit.id)?.ok_or(rusqlite::Error::QueryReturnedNoRows)?;
            Ok(ClaimOutcome::Ok(Box::new(row.pairing())))
        })?;
        match outcome {
            ClaimOutcome::Locked(wait) => {
                let mut detail = handle_detail(&i);
                detail.push(("retryAfterMs", json!(wait)));
                emit_audit(
                    parts.audit,
                    Audited {
                        action: "identity.pair.rate-limited",
                        target: &src_key,
                        detail,
                        actor: None,
                    },
                );
                Err(IdentityError {
                    retry_after_ms: Some(wait),
                    ..IdentityError::new(
                        IdentityErrorCode::RateLimited,
                        "too many failed attempts; try again later",
                    )
                }
                .into())
            }
            ClaimOutcome::Fail(why) => {
                let mut detail = handle_detail(&i);
                detail.push(("result", json!("refused")));
                detail.push(("reason", json!(why)));
                emit_audit(
                    parts.audit,
                    Audited {
                        action: "identity.pair.claim",
                        target: &src_key,
                        detail,
                        actor: None,
                    },
                );
                Err(refuse(
                    IdentityErrorCode::InvalidCode,
                    "invalid or expired code",
                ))
            }
            ClaimOutcome::Taken => Err(conflict(&i).into()),
            ClaimOutcome::Ok(pairing) => {
                let mut detail = handle_detail(&i);
                detail.push(("result", json!("awaiting-confirmation")));
                detail.push(("humanId", json!(pairing.human_id)));
                emit_audit(
                    parts.audit,
                    Audited {
                        action: "identity.pair.claim",
                        target: &pairing.id,
                        detail,
                        actor: None,
                    },
                );
                let confirm_by = pairing
                    .confirm_by
                    .ok_or(rusqlite::Error::QueryReturnedNoRows)?;
                Ok(Claimed {
                    pairing_id: pairing.id,
                    confirm_by,
                })
            }
        }
    }

    /// `confirm`: the owner's side. Approve links the claimed handle (proof `pairing_code`); decline discards the claim. A
    /// claim confirmed too late is marked expired, and one whose handle was linked meanwhile declined: both changes are
    /// committed and then refused.
    pub fn confirm(
        &mut self,
        pairing_id: &str,
        approve: bool,
        actor: &Actor,
    ) -> Outcome<Confirmed> {
        text(pairing_id, "pairingId", 64)?;
        let id = pairing_id;
        let (store, mut parts, _, _) = self.split();
        let out = store.write_with(|tx| -> Outcome<ConfirmOutcome> {
            let r = one_pairing(tx, id)?.ok_or_else(|| refuse(IdentityErrorCode::NotFound, format!("no such pairing: {id}")))?;
            require_authorization(parts.authorize, actor, IdentityAction::Confirm, &r.human_id)?;
            if r.state != "claimed" {
                return Err(refuse(IdentityErrorCode::Conflict, format!("pairing is {}, not waiting for confirmation", r.state)));
            }
            let t = (parts.clock)();
            let resolve = |state: &str| -> rusqlite::Result<()> {
                tx.execute(&format!("UPDATE pairings SET state = '{state}', resolved_at = ? WHERE id = ?"), rusqlite::params![t, id]).map(drop)
            };
            if t >= r.confirm_by.unwrap_or(i64::MIN) {
                resolve("expired")?;
                return Ok(ConfirmOutcome { state: "expired", link: None,
                    refuse: Some(IdentityError::new(IdentityErrorCode::Expired, "the claim was not confirmed in time")) });
            }
            let i = r.claimant().ok_or(rusqlite::Error::QueryReturnedNoRows)?;
            if !approve {
                resolve("declined")?;
                return Ok(ConfirmOutcome { state: "declined", link: None, refuse: None });
            }
            if active_link(tx, &i.channel, &i.account_id, &i.user_id)?.is_some() {
                resolve("declined")?;
                return Ok(ConfirmOutcome { state: "declined", link: None, refuse: Some(conflict(&i)) });
            }
            require_human(tx, &r.human_id)?;
            let link = insert_link(tx, &mut parts, &r.human_id, &i, "pairing_code", &actor.user)?;
            // A confirmed claim was a legitimate pairing, not an attempt: it frees its place in the person's claim limit.
            limiter::release(&mut SqlAttempts(tx), &format!("claim:{}", digest(&r.human_id)), &SOURCE_LIMIT, r.claimed_at.unwrap_or(0), (parts.clock)())?;
            tx.prepare_cached("UPDATE pairings SET state = 'confirmed', resolved_at = ?, link_id = ? WHERE id = ?")?
                .execute(rusqlite::params![t, link.id, id])?;
            Ok(ConfirmOutcome { state: "confirmed", link: Some(link), refuse: None })
        })?;
        let mut detail = vec![("result", json!(out.state))];
        if let Some(l) = &out.link {
            detail.extend([
                ("linkId", json!(l.id)),
                ("humanId", json!(l.human_id)),
                ("channel", json!(l.channel)),
                ("accountId", json!(l.account_id)),
                ("userId", json!(l.user_id)),
            ]);
        }
        emit_audit(
            parts.audit,
            Audited {
                action: "identity.pair.confirm",
                target: id,
                detail,
                actor: Some(actor),
            },
        );
        if let Some(refusal) = out.refuse {
            return Err(refusal.into());
        }
        Ok(Confirmed {
            pairing_id: id.to_owned(),
            state: out.state.to_owned(),
            link: out.link,
        })
    }

    /// `unlink`: revokes at once (detaches, never deletes). Refused while a back-fill of the link is running or reversing.
    pub fn unlink(&mut self, link_id: &str, actor: &Actor) -> Outcome<Link> {
        text(link_id, "linkId", 64)?;
        let id = link_id;
        let (store, parts, _, _) = self.split();
        let l = store.write_with(|tx| -> Outcome<Link> {
            let r = one_link(tx, id)?.ok_or_else(|| {
                refuse(IdentityErrorCode::NotFound, format!("no such link: {id}"))
            })?;
            require_authorization(parts.authorize, actor, IdentityAction::Unlink, &r.human_id)?;
            let backfill: Option<String> = tx
                .prepare_cached("SELECT state FROM backfills WHERE link_id = ?")?
                .query_row([id], |row| row.get(0))
                .optional()?;
            if matches!(backfill.as_deref(), Some("running" | "reversing")) {
                return Err(refuse(
                    IdentityErrorCode::Conflict,
                    "finish or recover backfill before unlinking",
                ));
            }
            if r.revoked_at.is_some() {
                return Err(refuse(
                    IdentityErrorCode::Conflict,
                    "link is already revoked",
                ));
            }
            tx.prepare_cached("UPDATE identities SET revoked_at = ?, revoked_by = ? WHERE id = ?")?
                .execute(rusqlite::params![(parts.clock)(), actor.user, id])?;
            one_link(tx, id)?
                .ok_or_else(|| IdentityFailure::Sqlite(rusqlite::Error::QueryReturnedNoRows))
        })?;
        emit_audit(
            parts.audit,
            Audited {
                action: "identity.unlink",
                target: id,
                detail: vec![
                    ("humanId", json!(l.human_id)),
                    ("channel", json!(l.channel)),
                    ("accountId", json!(l.account_id)),
                    ("userId", json!(l.user_id)),
                ],
                actor: Some(actor),
            },
        );
        Ok(l)
    }

    /// `list`: every human with its links (revoked ones on request) and the pairings that are still open, or all of them
    /// with a lapsed one shown as `expired`.
    pub fn list(&self, include_revoked: bool, include_resolved_pairings: bool) -> Outcome<Listing> {
        let conn = self.store.conn();
        let links: Vec<Link> = conn
            .prepare_cached(if include_revoked {
                "SELECT * FROM identities ORDER BY linked_at, id"
            } else {
                "SELECT * FROM identities WHERE revoked_at IS NULL ORDER BY linked_at, id"
            })?
            .query_map([], link_of)?
            .collect::<rusqlite::Result<_>>()?;
        let humans: Vec<Human> = conn
            .prepare_cached("SELECT * FROM humans ORDER BY created_at, id")?
            .query_map([], |row| {
                Ok(Human {
                    id: row.get("id")?,
                    display_name: row.get("display_name")?,
                    created_at: row.get("created_at")?,
                })
            })?
            .collect::<rusqlite::Result<_>>()?;
        let humans = humans
            .into_iter()
            .map(|h| {
                let own = links
                    .iter()
                    .filter(|l| l.human_id == h.id)
                    .cloned()
                    .collect();
                (h, own)
            })
            .collect();
        let t = (self.clock)();
        let rows: Vec<PairingRow> = if include_resolved_pairings {
            conn.prepare_cached("SELECT * FROM pairings ORDER BY created_at, id")?
                .query_map([], pairing_row)?
                .collect::<rusqlite::Result<_>>()?
        } else {
            conn.prepare_cached("SELECT * FROM pairings WHERE (state = 'pending' AND expires_at > ?) OR (state = 'claimed' AND confirm_by > ?) ORDER BY created_at, id")?
                .query_map([t, t], pairing_row)?
                .collect::<rusqlite::Result<_>>()?
        };
        let pairings = rows
            .iter()
            .map(|r| {
                let mut p = r.pairing();
                if (p.state == "pending" && p.expires_at <= t)
                    || (p.state == "claimed" && p.confirm_by.is_some_and(|c| c <= t))
                {
                    p.state = "expired".to_owned();
                }
                p
            })
            .collect();
        Ok(Listing { humans, pairings })
    }

    /// `resolve`: the harness user a channel handle belongs to, by an active link only; never by name or any similarity.
    pub fn resolve(
        &self,
        channel: &str,
        account_id: &str,
        user_id: &str,
    ) -> Outcome<Option<Resolved>> {
        Ok(
            active_link(self.store.conn(), channel, account_id, user_id)?.map(|l| Resolved {
                human_id: l.human_id,
                link_id: l.id,
            }),
        )
    }

    /// `linkedV1Principals`: the v1 principals of every currently linked handle of `human_id` (the read side of the union).
    pub fn linked_v1_principals(&self, human_id: &str) -> Outcome<Vec<String>> {
        require_human(self.store.conn(), human_id)?;
        stored_principals(self.store.conn(), human_id)
    }

    /// `jobLink`: one live link on a channel the native engine's seeded vocabulary accepts, the oldest first.
    pub fn job_link(&self, human_id: &str) -> Outcome<Option<Link>> {
        Ok(self
            .store
            .conn()
            .prepare_cached("SELECT * FROM identities WHERE human_id = ? AND revoked_at IS NULL AND channel IN ('telegram','discord','slack','mattermost') ORDER BY linked_at, id LIMIT 1")?
            .query_row([human_id], link_of)
            .optional()?)
    }

    /// `resolvePrincipals`: the v2 principal of a known harness user, then the v1 principals of its linked handles, each once.
    pub fn resolve_principals(&self, user_v2: &str) -> Outcome<Vec<String>> {
        if !is_user_principal(user_v2) || !user_v2.starts_with("user:v2:") {
            return Err(IdentityError::bad("userV2", "expected v2 principal").into());
        }
        let conn = self.store.conn();
        let ids: Vec<String> = conn
            .prepare_cached("SELECT id FROM humans")?
            .query_map([], |row| row.get(0))?
            .collect::<rusqlite::Result<_>>()?;
        let mut human = None;
        for id in ids {
            if derive_user_principal(&id)? == user_v2 {
                human = Some(id);
                break;
            }
        }
        let human = human
            .ok_or_else(|| refuse(IdentityErrorCode::NotFound, "unknown harness principal"))?;
        let mut out = vec![user_v2.to_owned()];
        for p in stored_principals(conn, &human)? {
            if !out[1..].contains(&p) {
                out.push(p);
            }
        }
        Ok(out)
    }

    /// `getLink`.
    pub fn get_link(&self, link_id: &str) -> Outcome<Link> {
        text(link_id, "linkId", 64)?;
        one_link(self.store.conn(), link_id)?
            .ok_or_else(|| refuse(IdentityErrorCode::NotFound, "unknown link"))
    }

    /// `backfillRecord`.
    pub fn backfill_record(&self, link_id: &str) -> Outcome<Option<BackfillRecord>> {
        Ok(self
            .store
            .conn()
            .prepare_cached("SELECT * FROM backfills WHERE link_id = ?")?
            .query_row([link_id], |row| {
                Ok(BackfillRecord {
                    link_id: row.get("link_id")?,
                    operation_id: row.get("operation_id")?,
                    state: row.get("state")?,
                    actor_hash: row.get("actor_hash")?,
                    at: row.get("at")?,
                    count: row.get("count")?,
                    receipt: row.get("receipt")?,
                })
            })
            .optional()?)
    }

    /// `reserveBackfill`: the first reservation of a link stands; a second one changes nothing.
    pub fn reserve_backfill(
        &mut self,
        link_id: &str,
        operation_id: &str,
        actor: &Actor,
    ) -> Outcome<()> {
        self.store
            .conn()
            .prepare_cached("INSERT INTO backfills(link_id,operation_id,state,actor_hash,at) VALUES (?,?,'running',?,?) ON CONFLICT(link_id) DO NOTHING")?
            .execute(rusqlite::params![link_id, operation_id, digest(&actor.user), (self.clock)()])?;
        Ok(())
    }

    /// `finishBackfill`: moves the record forward one state (or leaves it where it is); anything else is a `conflict`.
    pub fn finish_backfill(
        &mut self,
        link_id: &str,
        state: BackfillState,
        count: i64,
        receipt: &str,
    ) -> Outcome<()> {
        let [a, b] = state.allowed();
        let changed = self
            .store
            .conn()
            .prepare_cached("UPDATE backfills SET state = ?, count = ?, receipt = ? WHERE link_id = ? AND state IN (?, ?)")?
            .execute(rusqlite::params![state.as_str(), count, receipt, link_id, a, b])?;
        if changed != 1 {
            return Err(refuse(
                IdentityErrorCode::Conflict,
                "backfill state changed concurrently",
            ));
        }
        Ok(())
    }

    /// `emit`: an event of another producer through this service's audit (hashing, second name, sink).
    pub fn emit(
        &mut self,
        action: &str,
        target: &str,
        detail: Vec<(&str, Value)>,
        actor: Option<&Actor>,
    ) {
        emit_audit(
            self.audit.as_mut(),
            Audited {
                action,
                target,
                detail,
                actor,
            },
        );
    }
}

impl PrincipalResolver for IdentityService {
    fn resolve_principals(&self, user_v2: &str) -> Result<Vec<String>, IdentityError> {
        IdentityService::resolve_principals(self, user_v2).map_err(|e| match e {
            IdentityFailure::Refused(e) => e,
            IdentityFailure::Sqlite(e) => {
                IdentityError::new(IdentityErrorCode::Storage, e.to_string())
            }
        })
    }
}
