//! `identity/admin-store.ts`: `state/admin.sqlite`, the durable role presets, agent rights, invitations and break-glass
//! notices (P4-12 task 5). A library: nothing in the front door calls it yet.
//!
//! One synchronous writer. The last-owner rules are checked inside the `BEGIN IMMEDIATE` transaction that makes the change,
//! and `before_commit` (the audit write of the caller) runs inside it too: when it fails, nothing of the change is stored
//! ("audit before effect", ruling R7). The recorded sequences (`fixtures/parity/identity-admin/admin.json`,
//! `scripts/parity/export-identity-admin.ts`) are replayed by `admin_vectors.rs`.
//!
//! The file is opened as TypeScript opens it (ruling R4): private directory and file, `busy_timeout` and `foreign_keys`, the
//! journal mode left alone (a rollback journal on a fresh file), `user_version` never read, `CREATE TABLE IF NOT EXISTS`
//! with the TypeScript texts byte for byte, and the status columns of `admin_roles` added to a file from before them.
use super::ratelimit::{self as limiter, LimitSpec};
use super::store::{create_private, SqlAttempts};
use crate::rbac::types::{AgentRight, Principal, PrincipalKind, Role};
use plur1bus_store::rusqlite::{self, Connection, OptionalExtension, Row};
use plur1bus_store::{Journal, OwnerSpec, Schema, Store, StoreError, StoreSpec};
use serde_json::{json, Value};
use std::path::Path;

/// The tables, as the TypeScript constructor creates them on every open.
const TABLES: &str = r#"      CREATE TABLE IF NOT EXISTS admin_roles (user_id TEXT PRIMARY KEY, role TEXT NOT NULL CHECK(role IN ('owner','admin','operator','member','viewer'))) STRICT;
      CREATE TABLE IF NOT EXISTS admin_rights (agent_id TEXT NOT NULL,user_id TEXT NOT NULL,right TEXT NOT NULL CHECK(right IN ('use','manage')),PRIMARY KEY(agent_id,user_id)) STRICT;
      CREATE TABLE IF NOT EXISTS admin_notices (id TEXT PRIMARY KEY,user_id TEXT NOT NULL,payload TEXT NOT NULL) STRICT;
      CREATE TABLE IF NOT EXISTS admin_invites (id TEXT PRIMARY KEY,user_id TEXT NOT NULL,role TEXT NOT NULL,channel TEXT NOT NULL,expires_at INTEGER NOT NULL,revoked INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL DEFAULT 0,created_by TEXT NOT NULL DEFAULT '',token_hash TEXT UNIQUE,redeemed_at INTEGER) STRICT;
      CREATE TABLE IF NOT EXISTS attempts (key TEXT PRIMARY KEY,failures INTEGER NOT NULL,window_start INTEGER NOT NULL,locked_until INTEGER NOT NULL) STRICT;"#;

/// The columns a file from before the person status lacks, in the order they are added.
const ROLE_COLUMNS: [(&str, &str); 4] = [
    ("disabled", "INTEGER NOT NULL DEFAULT 0"),
    ("disabled_at", "INTEGER"),
    ("disabled_by", "TEXT"),
    ("version", "INTEGER NOT NULL DEFAULT 1"),
];

/// Failed redeems per source: five in 15 minutes lock that source for 15 minutes.
const REDEEM_SOURCE_LIMIT: LimitSpec = LimitSpec {
    limit: 5,
    window_ms: 15 * 60_000,
    lock_ms: 15 * 60_000,
};
/// Failed redeems over every source together: a hundred in 15 minutes lock all redeems for five. A token carries 256
/// bits, so the limits only cap noise; tight values would let anyone who can send failures lock every legitimate redeem out.
const REDEEM_GLOBAL_LIMIT: LimitSpec = LimitSpec {
    limit: 100,
    window_ms: 15 * 60_000,
    lock_ms: 5 * 60_000,
};
const REDEEM_GLOBAL_KEY: &str = "invite-redeem:global";

/// What a method of the admin store fails with.
#[derive(Debug)]
pub enum AdminError {
    /// A refusal the RPC layer passes on (`RpcError`): the code, the message and, for a conflict, its reason.
    Rpc {
        /// The harness error code.
        code: &'static str,
        /// The message.
        message: &'static str,
        /// `data.reason`.
        reason: Option<&'static str>,
    },
    /// `before_commit` failed: the transaction was rolled back and nothing of the change is stored.
    Hook(String),
    /// SQLite failed and the TypeScript store does not catch it either (a constraint of the invitation or notice table).
    Sqlite(rusqlite::Error),
    /// The file could not be opened, or a stored notice is not JSON.
    Storage(String),
}

impl From<rusqlite::Error> for AdminError {
    fn from(e: rusqlite::Error) -> Self {
        AdminError::Sqlite(e)
    }
}
impl From<StoreError> for AdminError {
    fn from(e: StoreError) -> Self {
        match e {
            StoreError::Sqlite(e) => AdminError::Sqlite(e),
            other => AdminError::Storage(other.to_string()),
        }
    }
}
impl std::fmt::Display for AdminError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            AdminError::Rpc { message, .. } => write!(f, "{message}"),
            AdminError::Hook(e) => write!(f, "the change could not be audited: {e}"),
            AdminError::Sqlite(e) => write!(f, "sqlite: {e}"),
            AdminError::Storage(e) => write!(f, "{e}"),
        }
    }
}
impl std::error::Error for AdminError {}

type Outcome<T> = Result<T, AdminError>;

fn rpc(code: &'static str, message: &'static str, reason: Option<&'static str>) -> AdminError {
    AdminError::Rpc {
        code,
        message,
        reason,
    }
}

/// One row of `users()`.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct UserRow {
    /// The harness user id.
    pub id: String,
    /// The role preset, as stored.
    pub role: String,
    /// Whether the person is disabled.
    pub disabled: bool,
    /// When.
    pub disabled_at: Option<i64>,
    /// By whom.
    pub disabled_by: Option<String>,
    /// Moves with every change of role, status or rights: codes and credentials issued under an older one are void.
    pub version: i64,
}

impl UserRow {
    /// `{ id, role, disabled, disabledAt, disabledBy, version }`.
    pub fn to_json(&self) -> Value {
        json!({ "id": self.id, "role": self.role, "disabled": self.disabled, "disabledAt": self.disabled_at,
            "disabledBy": self.disabled_by, "version": self.version })
    }
}

/// `person(id)`: the resolved principal of a stored person with its status.
#[derive(Clone, Debug, PartialEq)]
pub struct Person {
    /// Kind `person`, the stored role, the stored agent rights.
    pub principal: Principal,
    /// Whether the person is disabled.
    pub disabled: bool,
    /// The person's version.
    pub version: i64,
}

/// `InviteRow`.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct InviteRow {
    /// The invitation id.
    pub id: String,
    /// The harness user the invitation is for.
    pub user_id: String,
    /// The role it grants, as stored.
    pub role: String,
    /// The channel it is for.
    pub channel: String,
    /// When it lapses.
    pub expires_at: i64,
    /// 1 when revoked.
    pub revoked: i64,
    /// When it was made.
    pub created_at: i64,
    /// 1 for a shareable link (a token hash is stored), 0 for a plain pairing-code invitation.
    pub shareable: i64,
    /// When its token was redeemed.
    pub redeemed_at: Option<i64>,
}

impl InviteRow {
    /// `{ id, userId, role, channel, expiresAt, revoked, createdAt, shareable, redeemedAt }`.
    pub fn to_json(&self) -> Value {
        json!({ "id": self.id, "userId": self.user_id, "role": self.role, "channel": self.channel, "expiresAt": self.expires_at,
            "revoked": self.revoked, "createdAt": self.created_at, "shareable": self.shareable, "redeemedAt": self.redeemed_at })
    }
}

/// What `invite` stores.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct NewInvite {
    /// The invitation id.
    pub id: String,
    /// The harness user it is for.
    pub user_id: String,
    /// The role it grants.
    pub role: String,
    /// The channel.
    pub channel: String,
    /// When it lapses.
    pub expires_at: i64,
    /// When it was made.
    pub created_at: i64,
    /// Who made it.
    pub created_by: String,
    /// The hash of a shareable link's token; never the token itself. `None` for a plain pairing-code invitation.
    pub token_hash: Option<String>,
}

/// Why a redeem was refused. For the privileged audit trail only: every refusal looks the same to the caller.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum RedeemRefusal {
    /// No invitation has this token.
    Unknown,
    /// It lapsed.
    Expired,
    /// It was revoked (reported before `Redeemed` when both hold).
    Revoked,
    /// Its token was used.
    Redeemed,
    /// The token did not have the shape of one (the caller passes no hash).
    Malformed,
    /// The source or every source is locked; a valid token is refused too and not consumed.
    RateLimited,
}

impl RedeemRefusal {
    /// The audit name.
    pub fn as_str(self) -> &'static str {
        match self {
            RedeemRefusal::Unknown => "unknown",
            RedeemRefusal::Expired => "expired",
            RedeemRefusal::Revoked => "revoked",
            RedeemRefusal::Redeemed => "redeemed",
            RedeemRefusal::Malformed => "malformed",
            RedeemRefusal::RateLimited => "rate-limited",
        }
    }
}

/// `RedeemOutcome`.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum RedeemOutcome {
    /// The token was consumed.
    Taken(InviteRow),
    /// Refused.
    Refused {
        /// Why.
        reason: RedeemRefusal,
        /// The invitation the token belongs to, when there is one.
        invite_id: Option<String>,
    },
}

impl RedeemOutcome {
    /// `{ ok: true, invite }` or `{ ok: false, reason, inviteId? }`.
    pub fn to_json(&self) -> Value {
        match self {
            RedeemOutcome::Taken(invite) => json!({ "ok": true, "invite": invite.to_json() }),
            RedeemOutcome::Refused { reason, invite_id } => {
                let mut out = json!({ "ok": false, "reason": reason.as_str() });
                if let Some(id) = invite_id {
                    out["inviteId"] = json!(id);
                }
                out
            }
        }
    }
}

/// A break-glass notice as `admin_notices` holds it.
pub type StoredNotice = crate::rbac::break_glass::BreakGlassNotice;

fn invite_of(row: &Row<'_>) -> rusqlite::Result<InviteRow> {
    Ok(InviteRow {
        id: row.get("id")?,
        user_id: row.get("userId")?,
        role: row.get("role")?,
        channel: row.get("channel")?,
        expires_at: row.get("expiresAt")?,
        revoked: row.get("revoked")?,
        created_at: row.get("createdAt")?,
        shareable: row.get("shareable")?,
        redeemed_at: row.get("redeemedAt")?,
    })
}

fn stored_role(conn: &Connection, id: &str) -> rusqlite::Result<Option<String>> {
    conn.prepare_cached("SELECT role FROM admin_roles WHERE user_id=?")?
        .query_row([id], |row| row.get(0))
        .optional()
}

/// `role(id, fallback)`: the stored preset, the fallback for a user without one (and for a stored word that is no role,
/// which the table's CHECK rules out).
fn role_of(conn: &Connection, id: &str, fallback: Role) -> rusqlite::Result<Role> {
    Ok(stored_role(conn, id)?
        .and_then(|r| Role::parse(&r))
        .unwrap_or(fallback))
}

/// `resolve(p)`: never turns an agent into a person or widens its role; for a person the stored role and the stored
/// rights are authoritative.
fn resolve_in(conn: &Connection, p: &Principal) -> rusqlite::Result<Principal> {
    if p.kind != Some(PrincipalKind::Person) {
        return Ok(p.clone());
    }
    let role = role_of(conn, &p.user_id, p.role)?;
    let rights = conn
        .prepare_cached("SELECT agent_id,right FROM admin_rights WHERE user_id=?")?
        .query_map([&p.user_id], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    let rights = rights
        .into_iter()
        .filter_map(|(agent, right)| match right.as_str() {
            "use" => Some((agent, AgentRight::Use)),
            "manage" => Some((agent, AgentRight::Manage)),
            _ => None,
        })
        .collect();
    Ok(Principal {
        role,
        agent_rights: Some(rights),
        ..p.clone()
    })
}

fn person_in(conn: &Connection, id: &str) -> rusqlite::Result<Option<Person>> {
    let row: Option<(String, i64, i64)> = conn
        .prepare_cached("SELECT role,disabled,version FROM admin_roles WHERE user_id=?")?
        .query_row([id], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)))
        .optional()?;
    let Some((role, disabled, version)) = row else {
        return Ok(None);
    };
    let mut principal = Principal::new(id, Role::parse(&role).unwrap_or(Role::Member));
    principal.kind = Some(PrincipalKind::Person);
    Ok(Some(Person {
        principal: resolve_in(conn, &principal)?,
        disabled: disabled != 0,
        version,
    }))
}

fn active_owners(conn: &Connection) -> rusqlite::Result<i64> {
    conn.prepare_cached("SELECT COUNT(*) AS n FROM admin_roles WHERE role='owner' AND disabled=0")?
        .query_row([], |row| row.get(0))
}

/// `AdminStore`.
pub struct AdminStore {
    store: Store,
}

impl AdminStore {
    /// Opens (creating) `admin.sqlite` and seeds an empty installation with `owner_id` as its owner. Only an empty one:
    /// demoting the bootstrap owner must survive a restart. `secure_path` is the host's `securePath` for the file.
    /// There is no in-memory form: TypeScript's `:memory:` path (tests only) is a file name here.
    pub fn open(path: &Path, owner_id: &str, secure_path: &dyn Fn(&Path)) -> Outcome<AdminStore> {
        create_private(path)
            .map_err(|e| AdminError::Storage(format!("admin store unavailable: {e}")))?;
        secure_path(path);
        let spec = OwnerSpec {
            store: StoreSpec {
                foreign_keys: true,
                ..StoreSpec::new("admin", 0)
            },
            journal: Journal::Unchanged,
            schema: Schema::Unversioned,
            create: false,
        };
        let store = Store::open_owner(path, &spec)?;
        let conn = store.conn();
        conn.execute_batch(TABLES)?;
        let columns: Vec<String> = conn
            .prepare("PRAGMA table_info(admin_roles)")?
            .query_map([], |row| row.get(1))?
            .collect::<rusqlite::Result<_>>()?;
        for (name, kind) in ROLE_COLUMNS {
            if !columns.iter().any(|c| c == name) {
                conn.execute_batch(&format!("ALTER TABLE admin_roles ADD COLUMN {name} {kind}"))?;
            }
        }
        let people: i64 = conn.query_row("SELECT COUNT(*) AS n FROM admin_roles", [], |row| {
            row.get(0)
        })?;
        if people == 0 {
            conn.execute(
                "INSERT INTO admin_roles(user_id,role) VALUES (?, 'owner')",
                [owner_id],
            )?;
        }
        Ok(AdminStore { store })
    }

    /// The connection (the limiter of the redeem and the replay's dumps read it).
    pub fn conn(&self) -> &Connection {
        self.store.conn()
    }

    /// `role(id, fallback)`.
    pub fn role(&self, id: &str, fallback: Role) -> Outcome<Role> {
        Ok(role_of(self.conn(), id, fallback)?)
    }

    /// `users()`: every person with a role row, by id.
    pub fn users(&self) -> Outcome<Vec<UserRow>> {
        Ok(self
            .conn()
            .prepare_cached("SELECT user_id AS id, role, disabled, disabled_at AS disabledAt, disabled_by AS disabledBy, version FROM admin_roles ORDER BY user_id")?
            .query_map([], |row| {
                Ok(UserRow {
                    id: row.get(0)?,
                    role: row.get(1)?,
                    disabled: row.get::<_, i64>(2)? == 1,
                    disabled_at: row.get(3)?,
                    disabled_by: row.get(4)?,
                    version: row.get(5)?,
                })
            })?
            .collect::<rusqlite::Result<_>>()?)
    }

    /// `person(id)`.
    pub fn person(&self, id: &str) -> Outcome<Option<Person>> {
        Ok(person_in(self.conn(), id)?)
    }

    /// `resolvePerson(id)`: the principal of a stored, enabled person.
    pub fn resolve_person(&self, id: &str) -> Outcome<Option<Principal>> {
        Ok(person_in(self.conn(), id)?
            .filter(|p| !p.disabled)
            .map(|p| p.principal))
    }

    /// `setDisabled`: refuses to disable the last active Owner; a change runs `before_commit` first and moves the version.
    pub fn set_disabled(
        &mut self,
        id: &str,
        disabled: bool,
        by: &str,
        now: i64,
        before_commit: &mut dyn FnMut() -> Result<(), String>,
    ) -> Outcome<()> {
        self.store.write_with(|tx| -> Outcome<()> {
            let row = person_in(tx, id)?.ok_or_else(|| rpc("E_NOT_FOUND", "person not found", None))?;
            if disabled && !row.disabled && row.principal.role == Role::Owner && active_owners(tx)? <= 1 {
                return Err(rpc("E_CONFLICT", "the last active Owner cannot be disabled", Some("last-owner")));
            }
            if row.disabled != disabled {
                before_commit().map_err(AdminError::Hook)?;
                tx.prepare_cached("UPDATE admin_roles SET disabled=?,disabled_at=?,disabled_by=?,version=version+1 WHERE user_id=?")?
                    .execute(rusqlite::params![i64::from(disabled), disabled.then_some(now), disabled.then_some(by), id])?;
            }
            Ok(())
        })
    }

    /// `validateInvite(hash, now)`: the unrevoked, unredeemed, unexpired invitation of a token hash. No hash, no invitation.
    pub fn validate_invite(&self, hash: Option<&str>, now: i64) -> Outcome<Option<InviteRow>> {
        let Some(hash) = hash.filter(|h| !h.is_empty()) else {
            return Ok(None);
        };
        Ok(self
            .conn()
            .prepare_cached("SELECT id,user_id AS userId,role,channel,expires_at AS expiresAt,revoked,created_at AS createdAt,1 AS shareable,redeemed_at AS redeemedAt FROM admin_invites WHERE token_hash=? AND revoked=0 AND redeemed_at IS NULL AND expires_at>?")?
            .query_row(rusqlite::params![hash, now], invite_of)
            .optional()?)
    }

    /// `setRole`: refuses to demote the last active Owner; `before_commit` runs before the write. A word that is not one
    /// of the five presets is refused before anything else.
    pub fn set_role(
        &mut self,
        id: &str,
        role: &str,
        before_commit: &mut dyn FnMut() -> Result<(), String>,
    ) -> Outcome<()> {
        let role = Role::parse(role)
            .ok_or_else(|| rpc("E_INVALID_PARAMS", "unknown role preset", None))?;
        self.store.write_with(|tx| -> Outcome<()> {
            let disabled = person_in(tx, id)?.is_some_and(|p| p.disabled);
            if role_of(tx, id, Role::Member)? == Role::Owner && !disabled && role != Role::Owner && active_owners(tx)? <= 1 {
                return Err(rpc("E_CONFLICT", "the last Owner cannot be demoted", Some("last-owner")));
            }
            before_commit().map_err(AdminError::Hook)?;
            tx.prepare_cached("INSERT INTO admin_roles(user_id,role) VALUES (?,?) ON CONFLICT(user_id) DO UPDATE SET role=excluded.role,version=version+1")?
                .execute([id, role.as_str()])?;
            Ok(())
        })
    }

    /// `rights(agentId)`: who holds which right on an agent, by user id.
    pub fn rights(&self, agent_id: &str) -> Outcome<Vec<(String, String)>> {
        Ok(self
            .conn()
            .prepare_cached("SELECT user_id AS userId,right FROM admin_rights WHERE agent_id=? ORDER BY user_id")?
            .query_map([agent_id], |row| Ok((row.get(0)?, row.get(1)?)))?
            .collect::<rusqlite::Result<_>>()?)
    }

    /// `setRight`: `None` removes the right. The user's version moves in every case that is not refused, also when nothing
    /// was removed; a user without a role row keeps the right and has no version to move.
    pub fn set_right(&mut self, agent_id: &str, user_id: &str, right: Option<&str>) -> Outcome<()> {
        let conn = self.conn();
        match right {
            None => {
                conn.prepare_cached("DELETE FROM admin_rights WHERE agent_id=? AND user_id=?")?
                    .execute([agent_id, user_id])?;
            }
            Some(right) => {
                if right != "use" && right != "manage" {
                    return Err(rpc("E_INVALID_PARAMS", "invalid agent right", None));
                }
                conn.prepare_cached("INSERT INTO admin_rights VALUES (?,?,?) ON CONFLICT(agent_id,user_id) DO UPDATE SET right=excluded.right")?
                    .execute([agent_id, user_id, right])?;
            }
        }
        conn.prepare_cached("UPDATE admin_roles SET version=version+1 WHERE user_id=?")?
            .execute([user_id])?;
        Ok(())
    }

    /// `resolve(p)`.
    pub fn resolve(&self, p: &Principal) -> Outcome<Principal> {
        Ok(resolve_in(self.conn(), p)?)
    }

    /// `invite(i)`.
    pub fn invite(&mut self, i: &NewInvite) -> Outcome<()> {
        self.conn()
            .prepare_cached("INSERT INTO admin_invites(id,user_id,role,channel,expires_at,created_at,created_by,token_hash) VALUES (?,?,?,?,?,?,?,?)")?
            .execute(rusqlite::params![i.id, i.user_id, i.role, i.channel, i.expires_at, i.created_at, i.created_by, i.token_hash])?;
        Ok(())
    }

    /// `notice(n)`: one notice per grant.
    pub fn notice(&mut self, n: &StoredNotice) -> Outcome<()> {
        self.conn()
            .prepare_cached("INSERT INTO admin_notices VALUES (?,?,?)")?
            .execute([&n.grant_id, &n.user_id, &n.payload()])?;
        Ok(())
    }

    fn payloads(&self, sql: &str, params: &[&str]) -> Outcome<Vec<Value>> {
        let texts: Vec<String> = self
            .conn()
            .prepare_cached(sql)?
            .query_map(rusqlite::params_from_iter(params), |row| row.get(0))?
            .collect::<rusqlite::Result<_>>()?;
        texts
            .iter()
            .map(|t| {
                serde_json::from_str(t)
                    .map_err(|e| AdminError::Storage(format!("stored notice is not JSON: {e}")))
            })
            .collect()
    }

    /// `notices(userId)`: the 200 newest notices of a user, newest first.
    pub fn notices(&self, user_id: &str) -> Outcome<Vec<Value>> {
        self.payloads(
            "SELECT payload FROM admin_notices WHERE user_id=? ORDER BY rowid DESC LIMIT 200",
            &[user_id],
        )
    }

    /// `allNotices()`: every notice, oldest first.
    pub fn all_notices(&self) -> Outcome<Vec<Value>> {
        self.payloads("SELECT payload FROM admin_notices ORDER BY rowid", &[])
    }

    /// `invites()`: every invitation, by deadline.
    pub fn invites(&self) -> Outcome<Vec<InviteRow>> {
        Ok(self
            .conn()
            .prepare_cached("SELECT id,user_id AS userId,role,channel,expires_at AS expiresAt,revoked,created_at AS createdAt,token_hash IS NOT NULL AS shareable,redeemed_at AS redeemedAt FROM admin_invites ORDER BY expires_at,id")?
            .query_map([], invite_of)?
            .collect::<rusqlite::Result<_>>()?)
    }

    /// `revoke(id)`.
    pub fn revoke(&mut self, id: &str) -> Outcome<()> {
        self.conn()
            .prepare_cached("UPDATE admin_invites SET revoked=1 WHERE id=?")?
            .execute([id])?;
        Ok(())
    }

    /// `redeem`: consumes a shareable invitation's one-time token. The whole decision is one transaction: a single guarded
    /// UPDATE (unredeemed, unrevoked, unexpired) either takes the row or not, so two concurrent redeems cannot both win, and
    /// a failing `before_commit` (the audit write) rolls the consumption back. A failure is counted for its source and
    /// overall; a locked source is refused without looking at the token.
    pub fn redeem(
        &mut self,
        token_hash: Option<&str>,
        now: i64,
        source: &str,
        before_commit: &mut dyn FnMut(&InviteRow) -> Result<(), String>,
    ) -> Outcome<RedeemOutcome> {
        let src_key = format!("invite-redeem:src:{source}");
        self.store.write_with(|tx| -> Outcome<RedeemOutcome> {
            if limiter::locked_for(&SqlAttempts(tx), &[&src_key, REDEEM_GLOBAL_KEY], now)? > 0 {
                return Ok(RedeemOutcome::Refused { reason: RedeemRefusal::RateLimited, invite_id: None });
            }
            let row = match token_hash {
                None => None,
                Some(hash) => tx
                    .prepare_cached("SELECT id,user_id AS userId,role,channel,expires_at AS expiresAt,revoked,created_at AS createdAt,1 AS shareable,redeemed_at AS redeemedAt FROM admin_invites WHERE token_hash=?")?
                    .query_row([hash], invite_of)
                    .optional()?,
            };
            if let Some(row) = &row {
                let taken = tx
                    .prepare_cached("UPDATE admin_invites SET redeemed_at=? WHERE id=? AND redeemed_at IS NULL AND revoked=0 AND expires_at>?")?
                    .execute(rusqlite::params![now, row.id, now])?;
                if taken == 1 {
                    let invite = InviteRow { redeemed_at: Some(now), ..row.clone() };
                    before_commit(&invite).map_err(AdminError::Hook)?;
                    limiter::success(&mut SqlAttempts(tx), &src_key)?;
                    return Ok(RedeemOutcome::Taken(invite));
                }
            }
            limiter::failure(&mut SqlAttempts(tx), &src_key, &REDEEM_SOURCE_LIMIT, now)?;
            limiter::failure(&mut SqlAttempts(tx), REDEEM_GLOBAL_KEY, &REDEEM_GLOBAL_LIMIT, now)?;
            let reason = match (token_hash, &row) {
                (None, _) => RedeemRefusal::Malformed,
                (_, None) => RedeemRefusal::Unknown,
                (_, Some(r)) if r.revoked != 0 => RedeemRefusal::Revoked,
                (_, Some(r)) if r.redeemed_at.is_some() => RedeemRefusal::Redeemed,
                _ => RedeemRefusal::Expired,
            };
            Ok(RedeemOutcome::Refused { reason, invite_id: row.map(|r| r.id) })
        })
    }
}
