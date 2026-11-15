//! What the front door needs to serve a method itself (P4-12 flip A1): the RBAC guard in front of every native method,
//! the stores the native methods read, and the audit sink of a refusal.
//!
//! **Who is served.** The local owner connection only (`run/core.token` on the core's own socket, no delegation);
//! `route::route_for` relays every other caller's call to the legacy core, which runs its own guard. The principal of
//! that connection is what the TypeScript resolver gives it: `LOCAL_OWNER` with the role and agent rights stored for it
//! in `state/admin.sqlite` (`AdminStore.resolve`), and nobody when that person is disabled. The local owner can be
//! demoted (a demotion of the bootstrap owner survives a restart), so a native method can be refused here.
//!
//! **Order of a native call**, as for a TypeScript handler: the request's admission (`server.rs`), the parameters
//! against the schema (the generated dispatcher), then [`Native::authorize`] (the guard of `rbac/guard.ts`, with its
//! audit of a denial), then the method with its own checks.
//!
//! **State shared with the legacy core.** `state/admin.sqlite` and `state/identity.sqlite` are opened by both processes
//! (flip plan F1), and the front door never creates either file: the legacy core does at its start, before the front
//! door is ready. Since flip A2 the front door also writes `admin.sqlite` (`user.role.set`, `user.disable`,
//! `user.enable`): each change is one `BEGIN IMMEDIATE` transaction of the store, so the rule that there is always an
//! active Owner is checked and kept under SQLite's write lock, whichever process writes; `identity.sqlite` stays
//! read-only here. Without `admin.sqlite`, or with one that has no role table
//! or no person in it, a native call is refused: a store created or completed here would be seeded with the local
//! owner as Owner, whatever the installation had stored. `admin.sqlite` is opened once and kept, without any of the
//! statements that create, alter or seed (`AdminStore::open_existing`); `identity.sqlite` is opened read-only for the
//! one call that needs it. A refusal's audit
//! event goes where the TypeScript core's goes: one line in `logs/audit.log` and one record in the hash chain beside it,
//! which the legacy core and the CLI extend under the same lock; a write that fails is logged, without content.
//!
//! **A change is audited before it is stored** (flip plan F7): the audit event of a write method is appended inside the
//! store's transaction, before the row changes, and an event that cannot be recorded in both places rolls the change
//! back (`E_STORAGE`, reason `audit-failed`), as the TypeScript handlers do.
//!
//! **What follows a change in the legacy core** ([`LegacyCore`], `docs/phase4/bridge.md`). The TypeScript handlers tell
//! the API services that a person's rights moved (`api.account.changed`) and let the learner reconcile; both live in the
//! legacy core. After its commit a native write asks the legacy core for them over the front door's control link
//! (`legacy.account.changed`). The change stands whatever that call does (in TypeScript nothing after the commit can
//! undo it either); a call that fails is logged. A write is refused before anything is stored when the legacy core
//! cannot be reached at all (`E_NOT_AVAILABLE`, reason `stopping`): the control link only ends when the core stops.
use crate::identity::admin_store::{AdminError, AdminStore};
use crate::identity::error::{IdentityError, IdentityErrorCode};
use crate::identity::principals::derive_user_principal;
use crate::identity::service_impl::{human_exists_on, resolve_principals_on, IdentityFailure};
use crate::lifecycle::now_ms;
use crate::logs::sink::default_secure_path;
use crate::rbac::audit::{detail_redactor, redacted_detail, AuditEvent, AuditSink, JsonlAuditSink};
use crate::rbac::authorize::authorize;
use crate::rbac::guard::{self, local_owner, principal_js, ApiContext, CallFacts, Resolved};
use crate::rbac::types::{AuthorizeContext, Principal, PrincipalKind, Resource, Role};
use crate::route;
use plur1bus_audit::chain;
use plur1bus_rpc::server::{MethodError, RpcFailure};
use plur1bus_rpc::types::ErrorCode;
use plur1bus_store::rusqlite::{Connection, OpenFlags};
use serde_json::{json, Value};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, OnceLock, PoisonError};
use std::time::Duration;

/// How long a read of `identity.sqlite` waits for a writer in the other process (the stores' own value).
const BUSY: Duration = Duration::from_secs(5);

/// `actor.host` of the guard's audit events (`GuardOptions.host`, which the core leaves at its default).
const GUARD_HOST: &str = "local";

fn secure(path: &Path) {
    let _ = default_secure_path(path, 0o600);
}

fn now() -> i64 {
    i64::try_from(now_ms()).unwrap_or(i64::MAX)
}

fn refusal(code: ErrorCode, message: &str, reason: Option<&str>) -> MethodError {
    let refused = MethodError::rpc(code, message);
    match reason {
        Some(reason) => refused.with_reason(reason),
        None => refused,
    }
}

fn code_of(name: &str) -> ErrorCode {
    match name {
        "E_UNAUTHORIZED" => ErrorCode::EUnauthorized,
        "E_DENIED" => ErrorCode::EDenied,
        // The guard refuses with these two only; anything else would be a change of the guard this did not follow.
        _ => ErrorCode::EInternal,
    }
}

/// The sink of the guard's audit events: `logs/audit.log` and the hash chain, both tried, the first failure reported
/// (`teeAuditSinks(createJsonlAuditSink(...), chain)` of `core.ts`). The chain record carries the redacted detail, as
/// the line does.
struct AuditTee {
    logs: PathBuf,
}

impl AuditSink for AuditTee {
    fn append(&mut self, event: &AuditEvent) -> Result<(), String> {
        let line = JsonlAuditSink::new(self.logs.join("audit.log"), Some(Box::new(secure)))
            .and_then(|mut sink| sink.append(event));
        if line.is_err() {
            lost("audit.log", "io");
        }
        let redacted = detail_redactor().and_then(|redactor| {
            serde_json::from_str::<Value>(&redacted_detail(&event.detail, &redactor))
                .map_err(|e| e.to_string())
        });
        if redacted.is_err() {
            lost("audit-chain", "redact");
        }
        let chained = redacted.and_then(|detail| {
            let record = json!({ "at": event.at, "actor": { "user": event.user, "host": event.host },
                "action": event.action, "target": event.target, "detail": detail });
            // Who writes, for the events the chain adds on its own behalf (`actorOfThisProcess` of `audit/chain.ts`).
            let user = Some(whoami::username())
                .filter(|u| !u.is_empty())
                .unwrap_or_else(|| "unknown".to_owned());
            let host = plur1bus_rpc::process::hostname()
                .ok()
                .filter(|h| !h.is_empty())
                .unwrap_or_else(|| "localhost".to_owned());
            let actor = chain::Actor {
                user: &user,
                host: &host,
                writer: "core",
            };
            chain::append(&self.logs, &actor, &record).map_err(|e| {
                // The chain's own short code (`anchor-missing`, `lock-timeout`, ...), never content.
                lost("audit-chain", chain::refusal_reason(&e).unwrap_or("io"));
                e.to_string()
            })
        });
        line.and(chained)
    }
}

/// An audit event that one of its two places did not take: the refusal it belongs to stands (as in TypeScript), and
/// this line is what an operator finds. The TypeScript core raises an owner notice for a chain refusal; its own audit
/// health check, which reads the same files, still does.
fn lost(sink: &str, reason: &str) {
    crate::server::log(
        "warn",
        "audit event not recorded",
        json!({"sink": sink, "reason": reason}),
    );
}

/// What a native write asks of the legacy core after its commit (the `legacy.*` methods of `docs/phase4/bridge.md`).
/// The front door's control link implements it.
pub trait LegacyCore: Send + Sync {
    /// Whether the legacy core can still be reached: false once the control link has ended.
    fn reachable(&self) -> bool;
    /// `legacy.account.changed`: `rights` for the `api.account.changed` notification to the API services, `learning`
    /// for the learner's reconcile. The error is a short code for the log, never content.
    fn account_changed(&self, user_id: &str, rights: bool, learning: bool) -> Result<(), String>;
}

/// `actor.host` of an administrative audit event (`audit()` of `rpc/admin-surface.ts`).
const ADMIN_HOST: &str = "rpc";

/// The catch-all of `bind()` in `rpc/admin-surface.ts`.
fn storage() -> MethodError {
    refusal(
        ErrorCode::EStorage,
        "administrative storage unavailable",
        None,
    )
}

/// What the admin store refuses with, as `bind()` passes it on: its own refusals as they are, an audit event that could
/// not be recorded as `audit-failed`, everything else as the catch-all.
#[allow(clippy::needless_pass_by_value)] // the argument of `map_err`
fn admin_refusal(e: AdminError) -> MethodError {
    match e {
        AdminError::Rpc {
            code,
            message,
            reason,
        } => {
            let code = match code {
                "E_NOT_FOUND" => ErrorCode::ENotFound,
                "E_CONFLICT" => ErrorCode::EConflict,
                "E_INVALID_PARAMS" => ErrorCode::EInvalidParams,
                "E_DENIED" => ErrorCode::EDenied,
                _ => return storage(),
            };
            refusal(code, message, reason)
        }
        AdminError::Hook(_) => refusal(
            ErrorCode::EStorage,
            "administrative action cannot be audited",
            Some("audit-failed"),
        ),
        AdminError::Sqlite(_) | AdminError::Storage(_) => storage(),
    }
}

/// `String.prototype.length`: UTF-16 code units, which is what the TypeScript handlers bound.
fn js_length(text: &str) -> usize {
    text.encode_utf16().count()
}

/// `text(p, key)` of `rpc/admin-surface.ts` for a value the schema has already made a string: not empty, at most 128
/// UTF-16 code units, no C0 control character and no DEL.
fn admin_text<'a>(value: &'a str, key: &str) -> Result<&'a str, MethodError> {
    let control = value.chars().any(|c| c <= '\u{1f}' || c == '\u{7f}');
    if value.is_empty() || js_length(value) > 128 || control {
        return Err(refusal(
            ErrorCode::EInvalidParams,
            &format!("invalid {key}"),
            None,
        ));
    }
    Ok(value)
}

/// The reason of a status change as it is audited: control characters and the characters that reorder displayed text
/// (bidi marks, embeddings, overrides and isolates) removed, as `togglePerson` removes them.
fn audited_reason(reason: &str) -> String {
    reason
        .chars()
        .filter(|c| {
            !matches!(c, '\u{0}'..='\u{1f}' | '\u{7f}'..='\u{9f}' | '\u{61c}' | '\u{200e}' | '\u{200f}'
                | '\u{202a}'..='\u{202e}' | '\u{2066}'..='\u{2069}')
        })
        .collect()
}

/// `createHash("sha256").update(v).digest("hex")`.
fn hashed(value: &str) -> String {
    crate::identity::sha256_hex(&[value.as_bytes()])
}

/// The state of the native methods of one front door.
pub struct Native {
    home: PathBuf,
    admin: Mutex<Option<AdminStore>>,
    legacy: OnceLock<Arc<dyn LegacyCore>>,
}

impl Native {
    /// For the home at `home`. Opens nothing: `state/admin.sqlite` is opened by the first native call, if it exists.
    pub fn new(home: &Path) -> Native {
        Native {
            home: home.to_path_buf(),
            admin: Mutex::new(None),
            legacy: OnceLock::new(),
        }
    }

    /// The legacy core behind this front door, once its control link stands. Set once; a write method is refused
    /// without it.
    pub fn set_legacy(&self, legacy: Arc<dyn LegacyCore>) {
        let _ = self.legacy.set(legacy);
    }

    /// Runs `f` on `state/admin.sqlite`, opening it first if this is the first use and the legacy core has created it.
    fn with_admin<T>(
        &self,
        f: impl FnOnce(&mut AdminStore) -> Result<T, AdminError>,
    ) -> Result<T, AdminError> {
        let mut slot = self.admin.lock().unwrap_or_else(PoisonError::into_inner);
        f(self.opened(&mut slot)?)
    }

    /// The store in `slot`, opened first if this is its first use and the legacy core has created the file.
    fn opened<'a>(
        &self,
        slot: &'a mut Option<AdminStore>,
    ) -> Result<&'a mut AdminStore, AdminError> {
        if slot.is_none() {
            let path = self.home.join("state").join("admin.sqlite");
            // Never created or seeded here (see the module text): the open refuses a missing file, a file without
            // the role table and a table without a person. A link in the store's place is not opened.
            if !path.symlink_metadata().is_ok_and(|m| m.is_file()) {
                return Err(AdminError::Storage("admin store unavailable".to_owned()));
            }
            *slot = Some(AdminStore::open_existing(&path)?);
        }
        slot.as_mut()
            .ok_or_else(|| AdminError::Storage("admin store unavailable".to_owned()))
    }

    /// Runs the body of a write method on `state/admin.sqlite`: the method's own refusals pass, and a store that cannot
    /// be opened is the catch-all of `bind()`.
    fn administer<T>(
        &self,
        f: impl FnOnce(&mut AdminStore) -> Result<T, MethodError>,
    ) -> Result<T, MethodError> {
        let mut slot = self.admin.lock().unwrap_or_else(PoisonError::into_inner);
        f(self.opened(&mut slot).map_err(|_| storage())?)
    }

    /// The guard of `method` for a call of `who`: the principal the method runs for, or the refusal, whose audit event
    /// has been handed to the sink (a sink that fails changes nothing: the refusal stands). `params` are the call's
    /// parameters, for a rule that builds its resource from them.
    ///
    /// A method without a rule is refused: every native method is guarded, and one that reaches this without a rule is
    /// a port that forgot it.
    pub fn authorize(
        &self,
        who: &route::Principal,
        method: &str,
        params: Option<&Value>,
    ) -> Result<Principal, MethodError> {
        if !who.served_natively() {
            // `route::native_principal` has refused this already; never serve it as the owner.
            return Err(refusal(
                ErrorCode::EInternal,
                "route table drift",
                Some("route-table-drift"),
            ));
        }
        // `resolvePrincipal` of core.ts for an owner connection: the local owner as stored, nobody when disabled.
        let resolved = self.with_admin(|admin| {
            let owner = local_owner();
            if admin.person(&owner.user_id)?.is_some_and(|p| p.disabled) {
                return Ok(None);
            }
            admin.resolve(&owner).map(Some)
        });
        let principal = match &resolved {
            Ok(Some(p)) => Some(principal_js(p, None)),
            _ => None,
        };
        let answer = match (&resolved, &principal) {
            (Ok(Some(_)), Some(js)) => Resolved::Principal(js),
            (Ok(_), _) => Resolved::Nobody,
            (Err(_), _) => Resolved::Failed,
        };
        let facts = CallFacts {
            client: false,
            api: ApiContext::NotApi,
            // Read only for `dreams.diary` and `grant.*`; the package that serves those natively sets it.
            job_grants: false,
        };
        let Some(decision) = guard::guard(method, &answer, params, &facts, now(), GUARD_HOST)
        else {
            route::log_unguarded(method);
            return Err(refusal(
                ErrorCode::EInternal,
                "internal error",
                Some("handler-threw"),
            ));
        };
        guard::record(
            &decision,
            &mut AuditTee {
                logs: self.home.join("logs"),
            },
        );
        match (decision.outcome, resolved) {
            (Ok(()), Ok(Some(principal))) => Ok(principal),
            (Err(r), _) => Err(refusal(code_of(r.code), &r.message, Some(&r.reason))),
            // The guard allows nobody; fail closed should it ever.
            (Ok(()), _) => Err(refusal(
                ErrorCode::EUnauthorized,
                "authentication required",
                Some("no-principal"),
            )),
        }
    }

    /// `bind(action, ...)` of `rpc/admin-surface.ts` for an action on the installation: a person, and allowed again.
    fn administration(a: &Principal, action: &str) -> Result<(), MethodError> {
        if a.kind != Some(PrincipalKind::Person) {
            return Err(refusal(
                ErrorCode::EDenied,
                "administration is human-only",
                Some("agent-principal"),
            ));
        }
        let ctx = AuthorizeContext {
            now: Some(now() as f64),
        };
        if !authorize(Some(a), action, &Resource::System, &ctx).is_allow() {
            return Err(refusal(
                ErrorCode::EDenied,
                "administrative operation denied",
                None,
            ));
        }
        Ok(())
    }

    /// `breakglass.notices`: the 200 newest break-glass notices about the caller, newest first.
    pub fn breakglass_notices(&self, who: &route::Principal) -> Result<Value, MethodError> {
        let a = self.authorize(who, "breakglass.notices", None)?;
        Native::administration(&a, "admin.notices.read")?;
        let notices = self
            .with_admin(|admin| admin.notices(&a.user_id))
            .map_err(|_| {
                refusal(
                    ErrorCode::EStorage,
                    "administrative storage unavailable",
                    None,
                )
            })?;
        Ok(json!({ "notices": notices }))
    }

    /// `identity.principals`: the engine principals of a person (the caller, or anyone for an Owner or Admin).
    pub fn identity_principals(
        &self,
        who: &route::Principal,
        human_id: Option<&str>,
    ) -> Result<Value, MethodError> {
        let a = self.authorize(who, "identity.principals", None)?;
        // `target(p, a)` of `rpc/identity-surface.ts`.
        let human = human_id.unwrap_or(&a.user_id);
        if human != a.user_id && !matches!(a.role, Role::Owner | Role::Admin) {
            return Err(refusal(ErrorCode::EDenied, "self identities only", None));
        }
        let v2 =
            derive_user_principal(human).map_err(|e| surface_error(IdentityFailure::Refused(e)))?;
        // `service()` without a service in `rpc/identity-surface.ts`: the store is the legacy core's to create.
        let identity = self
            .identity()
            .map_err(|()| refusal(ErrorCode::ENotAvailable, "identity unavailable", None))?;
        let principals = resolve_principals_on(&identity, &v2).map_err(surface_error)?;
        Ok(json!({ "humanId": human, "principals": principals }))
    }

    /// The guard and `bind("admin.users.write", ...)` of a write method, and the legacy core it will need afterwards:
    /// nothing is stored when the legacy core cannot be reached any more (see the module text).
    fn writer(&self, who: &route::Principal, method: &str) -> Result<Principal, MethodError> {
        let a = self.authorize(who, method, None)?;
        Native::administration(&a, "admin.users.write")?;
        if !self.legacy.get().is_some_and(|legacy| legacy.reachable()) {
            return Err(refusal(
                ErrorCode::ENotAvailable,
                "core is stopping",
                Some("stopping"),
            ));
        }
        Ok(a)
    }

    /// `user(id)` of `rpc/admin-surface.ts`: a person with a stored role, or a human of the identity store.
    fn known_user(&self, admin: &AdminStore, id: &str) -> Result<(), MethodError> {
        if admin
            .users()
            .map_err(admin_refusal)?
            .iter()
            .any(|u| u.id == id)
        {
            return Ok(());
        }
        let identity = self.identity().map_err(|()| storage())?;
        if human_exists_on(&identity, id).map_err(|_| storage())? {
            return Ok(());
        }
        Err(refusal(ErrorCode::ENotFound, "user not found", None))
    }

    /// `audit(who, action, target, detail)` of `rpc/admin-surface.ts`, as the `before_commit` of a change: the event in
    /// `logs/audit.log` and in the hash chain, or the change does not happen.
    fn audit(
        &self,
        user: &str,
        action: &str,
        target: &str,
        detail: Vec<(String, Value)>,
    ) -> Result<(), String> {
        AuditTee {
            logs: self.home.join("logs"),
        }
        .append(&AuditEvent {
            at: now(),
            user: user.to_owned(),
            host: ADMIN_HOST.to_owned(),
            action: action.to_owned(),
            target: target.to_owned(),
            detail,
        })
    }

    /// After a commit: what the TypeScript handler and its wrappers do next lives in the legacy core. The change stands
    /// whatever happens here.
    fn after_change(&self, user_id: &str, rights: bool, learning: bool) {
        if !rights && !learning {
            return;
        }
        let told = match self.legacy.get() {
            Some(legacy) => legacy.account_changed(user_id, rights, learning),
            None => Err("unavailable".to_owned()),
        };
        if let Err(reason) = told {
            crate::server::log(
                "warn",
                "the legacy core was not told of an account change",
                json!({"reason": reason, "rights": rights, "learning": learning}),
            );
        }
    }

    /// `user.role.set`: assigns a role preset. Only an Owner changes ownership, nobody is promoted to Owner (there is
    /// exactly one, ADR-007), and the store refuses to demote the last active one.
    pub fn user_role_set(
        &self,
        who: &route::Principal,
        user_id: &str,
        role: &str,
    ) -> Result<Value, MethodError> {
        let a = self.writer(who, "user.role.set")?;
        self.administer(|admin| {
            let id = admin_text(user_id, "userId")?;
            self.known_user(admin, id)?;
            let role = Role::parse(role)
                .ok_or_else(|| refusal(ErrorCode::EInvalidParams, "unknown role preset", None))?;
            let before = admin.role(id, Role::Member).map_err(admin_refusal)?;
            if (before == Role::Owner || role == Role::Owner) && a.role != Role::Owner {
                return Err(refusal(
                    ErrorCode::EDenied,
                    "only an Owner may change ownership",
                    Some("owner-only"),
                ));
            }
            if role == Role::Owner && before != Role::Owner {
                return Err(refusal(
                    ErrorCode::EDenied,
                    "there is exactly one Owner; promotion to Owner is not possible",
                    Some("single-owner"),
                ));
            }
            let mut audit = || {
                let detail = vec![
                    ("previous".to_owned(), json!(before.as_str())),
                    ("role".to_owned(), json!(role.as_str())),
                ];
                self.audit(&a.user_id, "user.role.set", id, detail)
            };
            admin
                .set_role(id, role.as_str(), &mut audit)
                .map_err(admin_refusal)?;
            Ok(json!({ "userId": id, "role": role.as_str() }))
        })
        .inspect(|_| self.after_change(user_id, true, true))
    }

    /// `user.disable` and `user.enable` (`togglePerson`): changes a person's status and keeps their rights. An Owner
    /// changes anyone's, an Admin a Member's or a Viewer's; the store refuses to disable the last active Owner. The
    /// audit event names the actor and the person by the SHA-256 of their ids.
    pub fn user_status(
        &self,
        who: &route::Principal,
        disabled: bool,
        user_id: &str,
        reason: Option<&str>,
    ) -> Result<Value, MethodError> {
        let method = if disabled {
            "user.disable"
        } else {
            "user.enable"
        };
        let a = self.writer(who, method)?;
        let changed = self.administer(|admin| {
            let id = admin_text(user_id, "userId")?;
            self.known_user(admin, id)?;
            // A human without a stored preset (older installations, CLI-created): the Member default is stored first.
            if admin.person(id).map_err(admin_refusal)?.is_none() {
                let role = admin.role(id, Role::Member).map_err(admin_refusal)?;
                admin
                    .set_role(id, role.as_str(), &mut || Ok(()))
                    .map_err(admin_refusal)?;
            }
            let target = admin
                .person(id)
                .map_err(admin_refusal)?
                .ok_or_else(|| refusal(ErrorCode::ENotFound, "person not found", None))?;
            let target_role = target.principal.role;
            let may = a.role == Role::Owner
                || (a.role == Role::Admin && matches!(target_role, Role::Member | Role::Viewer));
            if !may {
                return Err(refusal(
                    ErrorCode::EDenied,
                    "person status change denied",
                    None,
                ));
            }
            if reason.is_some_and(|r| js_length(r) > 200) {
                return Err(refusal(ErrorCode::EInvalidParams, "invalid reason", None));
            }
            let reason = audited_reason(reason.unwrap_or_default());
            let mut audit = || {
                let mut detail = vec![("role".to_owned(), json!(target_role.as_str()))];
                if !reason.is_empty() {
                    detail.push(("reason".to_owned(), json!(reason)));
                }
                let action = if disabled {
                    "user.disabled"
                } else {
                    "user.enabled"
                };
                self.audit(&hashed(&a.user_id), action, &hashed(id), detail)
            };
            admin
                .set_disabled(id, disabled, &a.user_id, now(), &mut audit)
                .map_err(admin_refusal)?;
            Ok(target.disabled != disabled)
        })?;
        // `rightsChanged` only for a change; the learner's reconcile follows every `user.disable` (`learningLifecycle`).
        self.after_change(user_id, changed, disabled);
        Ok(json!({ "userId": user_id, "disabled": disabled }))
    }

    /// `state/identity.sqlite` for one call, read-only: nothing is created, migrated or pruned from here.
    fn identity(&self) -> Result<Connection, ()> {
        let path = self.home.join("state").join("identity.sqlite");
        if !path.symlink_metadata().is_ok_and(|m| m.is_file()) {
            return Err(());
        }
        let flags = OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX;
        let conn = Connection::open_with_flags(&path, flags).map_err(|_| ())?;
        conn.busy_timeout(BUSY).map_err(|_| ())?;
        Ok(conn)
    }
}

/// `surfaceError` of `rpc/surface-errors.ts` for what the identity service fails with: `mapIdentityError` for its own
/// refusals, `E_STORAGE` for everything else.
fn surface_error(e: IdentityFailure) -> MethodError {
    match e {
        IdentityFailure::Refused(e) => identity_error(&e),
        IdentityFailure::Sqlite(_) => {
            refusal(ErrorCode::EStorage, "surface storage unavailable", None)
        }
    }
}

/// `mapIdentityError` of `identity/rpc.ts`.
fn identity_error(e: &IdentityError) -> MethodError {
    let plain = |code, reason: Option<&str>| refusal(code, &e.message, reason);
    let detailed = |code, reason: Option<&str>, detail: Option<String>| {
        MethodError::Rpc(Box::new(RpcFailure {
            error: code,
            message: e.message.clone(),
            reason: reason.map(str::to_owned),
            detail,
            ids: None,
            ext: None,
        }))
    };
    match e.code {
        IdentityErrorCode::InvalidParams => {
            detailed(ErrorCode::EInvalidParams, None, e.field.clone())
        }
        IdentityErrorCode::NotFound => plain(ErrorCode::ENotFound, None),
        IdentityErrorCode::Conflict => plain(ErrorCode::EConflict, None),
        IdentityErrorCode::Limit => plain(ErrorCode::EConflict, Some("limit")),
        IdentityErrorCode::InvalidCode => plain(ErrorCode::EDenied, Some("invalid-code")),
        IdentityErrorCode::Expired => plain(ErrorCode::EDenied, Some("expired")),
        IdentityErrorCode::RateLimited => detailed(
            ErrorCode::EDenied,
            Some("rate-limited"),
            Some(format!("retryAfterMs={}", e.retry_after_ms.unwrap_or(0))),
        ),
        IdentityErrorCode::Denied => plain(ErrorCode::EDenied, Some("identity-denied")),
        IdentityErrorCode::Storage => plain(ErrorCode::EStorage, Some("identity-store")),
    }
}

#[cfg(test)]
#[path = "native_tests.rs"]
mod tests;

#[cfg(test)]
#[path = "native_write_tests.rs"]
mod write_tests;
