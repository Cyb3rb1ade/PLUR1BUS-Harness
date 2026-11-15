//! What the front door needs to serve a method itself (P4-12 flip A1): the RBAC guard in front of every native method,
//! the stores the native methods read, and the audit sink of a refusal.
//!
//! **Who is served.** Two kinds of caller; every other one's call is relayed to the legacy core, which runs its own
//! guard (`route::route_for`, `server.rs`).
//!
//! - The local owner connection (`run/core.token` on the core's own socket, no delegation). Its principal is what the
//!   TypeScript resolver gives it: `LOCAL_OWNER` with the role and agent rights stored for it in `state/admin.sqlite`
//!   (`AdminStore.resolve`), and nobody when that person is disabled. The local owner can be demoted (a demotion of the
//!   bootstrap owner survives a restart), so a native method can be refused here.
//! - A person the harness API acts for (P4-12 flip A3): a request of an API connection whose delegation names a person
//!   and is the delegation of the connection's handshake (`server.rs` checks both before this module sees the call).
//!   The principal is what `resolvePrincipal` and `apiIdentities` of the TypeScript core make of it: a disabled person
//!   is refused as such (`E_DENIED`, `person-disabled`, no audit event), a person the store does not know is nobody,
//!   and for everyone else the **stored** role and the stored agent rights replace what the delegation claims; the
//!   token scopes, the project rights and the binding are the delegation's. An API call never becomes the local owner:
//!   there is no path from an API principal to `LOCAL_OWNER` in this module.
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
//! back (`E_STORAGE`, reason `audit-failed`), as the TypeScript handlers do. As there, a commit that fails after the
//! event was recorded leaves an event for a change that did not happen; the call reports the failure.
//!
//! **What a write decides on is read again under the write lock.** A handler reads the person it changes before the
//! store's transaction, as the TypeScript handler does, and refuses in the TypeScript handler's order. With two
//! processes writing, the other one can change that person in between, so the rules that depend on the person's
//! stored role (who changes ownership, nobody is promoted to Owner, whose status an Admin changes) are checked a second
//! time inside the transaction, on the row it reads, and the audit event names the role found there
//! (`AdminStore::set_role_checked`, `set_disabled_checked`). The caller's own role is read once, by the guard.
//!
//! **One native call at a time.** The store is behind one mutex, which a write holds while it reads `identity.sqlite`
//! (busy timeout five seconds), appends the audit event (the chain's lock wait) and waits for SQLite's write lock
//! (five seconds). Another native call of an owner connection waits that long at most; relayed calls do not wait.
//!
//! **What follows a change in the legacy core** ([`LegacyCore`], `docs/phase4/bridge.md`). The TypeScript handlers tell
//! the API services that a person's rights moved (`api.account.changed`) and let the learner reconcile; both live in the
//! legacy core. After its commit a native write asks the legacy core for them over the front door's control link
//! (`legacy.account.changed`). The change stands whatever that call does (in TypeScript nothing after the commit can
//! undo it either); a call that fails is logged. A write is refused before anything is stored when the legacy core
//! cannot be reached at all (`E_NOT_AVAILABLE`, reason `stopping`): the control link only ends when the core stops.
use crate::identity::admin_store::{AdminError, AdminStore, Person};
use crate::identity::error::{IdentityError, IdentityErrorCode};
use crate::identity::principals::derive_user_principal;
use crate::identity::service_impl::{human_exists_on, resolve_principals_on, IdentityFailure};
use crate::lifecycle::now_ms;
use crate::logs::methods::{LogsDeps, LogsError, LogsMethods, LogsParams};
use crate::logs::sink::default_secure_path;
use crate::rbac::audit::{detail_redactor, redacted_detail, AuditEvent, AuditSink, JsonlAuditSink};
use crate::rbac::authorize::authorize;
use crate::rbac::guard::{self, local_owner, principal_js, ApiContext, CallFacts, Resolved};
use crate::rbac::types::{
    AgentRight, AuthorizeContext, Principal, PrincipalKind, ProjectRight, Resource, Role,
};
use crate::redaction_mirror::RedactionMirror;
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

/// The ownership rules of `user.role.set` for a caller of role `actor` who changes a person from `previous` to `role`:
/// only an Owner changes ownership, and nobody is promoted to Owner (there is exactly one, ADR-007).
fn ownership(actor: Role, previous: Role, role: Role) -> Result<(), AdminError> {
    if (previous == Role::Owner || role == Role::Owner) && actor != Role::Owner {
        return Err(AdminError::Rpc {
            code: "E_DENIED",
            message: "only an Owner may change ownership",
            reason: Some("owner-only"),
        });
    }
    if role == Role::Owner && previous != Role::Owner {
        return Err(AdminError::Rpc {
            code: "E_DENIED",
            message: "there is exactly one Owner; promotion to Owner is not possible",
            reason: Some("single-owner"),
        });
    }
    Ok(())
}

/// Whose status a caller of role `actor` changes (`togglePerson`): an Owner anyone's, an Admin a Member's or a Viewer's.
fn status_change(actor: Role, target: Role) -> Result<(), AdminError> {
    if actor == Role::Owner
        || (actor == Role::Admin && matches!(target, Role::Member | Role::Viewer))
    {
        return Ok(());
    }
    Err(AdminError::Rpc {
        code: "E_DENIED",
        message: "person status change denied",
        reason: None,
    })
}

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

/// Who a native call is for, as the TypeScript resolver would answer.
enum Identity {
    /// A principal.
    Person(Principal),
    /// Nobody (`null`).
    Nobody,
    /// The person the API acts for is disabled (`resolvePrincipal` throws `person-disabled`).
    Disabled,
    /// The resolver failed.
    Failed,
}

/// The person an API delegation names (`api.principal`, already checked by `auth::valid_api_principal`), as a typed
/// principal: user id, role, rights and token scopes as claimed. `None` for anything that is not a person in that shape.
fn delegated_person(claim: &Value) -> Option<Principal> {
    if claim.get("kind").and_then(Value::as_str) != Some("person") {
        return None;
    }
    let user = claim.get("userId").and_then(Value::as_str)?;
    let role = Role::parse(claim.get("role").and_then(Value::as_str)?)?;
    let mut person = Principal::new(user, role);
    person.kind = Some(PrincipalKind::Person);
    if let Some(rights) = claim.get("agentRights") {
        let mut list = Vec::new();
        for (agent, right) in rights.as_object()? {
            list.push((
                agent.clone(),
                match right.as_str()? {
                    "use" => AgentRight::Use,
                    "manage" => AgentRight::Manage,
                    _ => return None,
                },
            ));
        }
        person.agent_rights = Some(list);
    }
    if let Some(rights) = claim.get("projectRights") {
        let mut list = Vec::new();
        for (project, right) in rights.as_object()? {
            list.push((
                project.clone(),
                match right.as_str()? {
                    "member" => ProjectRight::Member,
                    "lead" => ProjectRight::Lead,
                    "worker" => ProjectRight::Worker,
                    "reviewer" => ProjectRight::Reviewer,
                    _ => return None,
                },
            ));
        }
        person.project_rights = Some(list);
    }
    if let Some(scopes) = claim.get("tokenScopes") {
        let mut list = Vec::new();
        for scope in scopes.as_array()? {
            list.push(scope.as_str()?.to_owned());
        }
        person.token_scopes = Some(list);
    }
    Some(person)
}

/// The state of the native methods of one front door.
pub struct Native {
    home: PathBuf,
    admin: Mutex<Option<AdminStore>>,
    legacy: OnceLock<Arc<dyn LegacyCore>>,
    /// The mirror of the legacy core's redaction registry (P4-20 flip A); `logs.query` is native only with it.
    redaction: OnceLock<Arc<RedactionMirror>>,
    /// The log methods over `<home>/logs`, made at the first `logs.query`; `None` when they cannot be made.
    logs: OnceLock<Option<LogsMethods>>,
    /// Test seam: what another process does between a write method's own reads and its write transaction.
    #[cfg(test)]
    window: Mutex<Option<Box<dyn FnMut() + Send>>>,
}

impl Native {
    /// For the home at `home`. Opens nothing: `state/admin.sqlite` is opened by the first native call, if it exists.
    pub fn new(home: &Path) -> Native {
        Native {
            home: home.to_path_buf(),
            admin: Mutex::new(None),
            legacy: OnceLock::new(),
            redaction: OnceLock::new(),
            logs: OnceLock::new(),
            #[cfg(test)]
            window: Mutex::new(None),
        }
    }

    /// The moment between a write method's own reads and its write transaction (see the module text). Nothing happens
    /// here outside the tests, which let another process write in it.
    fn before_transaction(&self) {
        #[cfg(test)]
        if let Some(other) = self
            .window
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .as_mut()
        {
            other();
        }
        #[cfg(not(test))]
        let _ = self;
    }

    /// The mirror `logs.query` masks with. A second call changes nothing.
    pub fn set_redaction(&self, mirror: Arc<RedactionMirror>) {
        let _ = self.redaction.set(mirror);
    }

    /// Whether `method`, a native method, is served here right now. `logs.query` is only while the redaction mirror
    /// is in step; otherwise it is relayed and the legacy core answers it with its own registry.
    pub fn serves_now(&self, method: &str) -> bool {
        method != "logs.query" || self.redaction.get().is_some_and(|mirror| mirror.synced())
    }

    /// `logs.query` (P4-20 flip A): `createLogsMethods(...)["logs.query"]` of `logs/methods.ts` behind the guard, over
    /// `<home>/logs`, which both processes write. The records are masked with everything the legacy core's registry
    /// holds at this moment: the mirror is brought in step first, and when that cannot be done the call is refused
    /// rather than answered with fewer masks than the legacy core would apply.
    pub fn logs_query(
        &self,
        who: &route::Principal,
        params: &plur1bus_rpc::types::LogsQueryParams,
    ) -> Result<Value, MethodError> {
        self.authorize(who, "logs.query", None)?;
        let out_of_step = || {
            refusal(
                ErrorCode::ENotAvailable,
                "log redaction is not in step with the legacy core",
                Some("redaction-sync"),
            )
        };
        let mirror = self.redaction.get().ok_or_else(out_of_step)?;
        mirror
            .catch_up(crate::redaction_mirror::CATCH_UP_WAIT)
            .map_err(|_| out_of_step())?;
        let methods = self
            .logs
            .get_or_init(|| {
                let mut deps = LogsDeps::new(self.home.join("logs"));
                deps.redactor = Some(Arc::new(mirror.set().redactor(false, false)));
                LogsMethods::new(deps).ok()
            })
            .as_ref()
            .ok_or_else(|| {
                refusal(
                    ErrorCode::EInternal,
                    "the log methods are not available",
                    None,
                )
            })?;
        let failed = |e: LogsError| {
            e.into_method_error()
                .unwrap_or_else(|| refusal(ErrorCode::EInternal, "logs.query failed", None))
        };
        let params = LogsParams::try_from(params).map_err(|e| failed(LogsError::Rpc(e)))?;
        methods
            .query(&params)
            .map(|page| page.to_value())
            .map_err(failed)
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
        let (identity, api, binding) = self.identify(who);
        let principal = match &identity {
            Identity::Person(p) => Some(principal_js(p, binding.as_deref())),
            _ => None,
        };
        let answer = match (&identity, &principal) {
            (Identity::Person(_), Some(js)) => Resolved::Principal(js),
            (Identity::Disabled, _) => Resolved::Disabled("person is disabled"),
            (Identity::Failed, _) => Resolved::Failed,
            _ => Resolved::Nobody,
        };
        let facts = CallFacts {
            client: false,
            api,
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
        match (decision.outcome, identity) {
            (Ok(()), Identity::Person(principal)) => Ok(principal),
            (Err(r), _) => Err(refusal(code_of(r.code), &r.message, Some(&r.reason))),
            // The guard allows nobody; fail closed should it ever.
            (Ok(()), _) => Err(refusal(
                ErrorCode::EUnauthorized,
                "authentication required",
                Some("no-principal"),
            )),
        }
    }

    /// `resolvePrincipal` of core.ts for the two kinds of caller a native method serves (see the module text): who the
    /// call is for, the guard's API context, and the agent an API token is bound to.
    fn identify(&self, who: &route::Principal) -> (Identity, ApiContext, Option<String>) {
        match who {
            // The local owner as stored, nobody when disabled.
            route::Principal::LocalOwner { .. } => {
                let resolved = self.with_admin(|admin| {
                    let owner = local_owner();
                    if admin.person(&owner.user_id)?.is_some_and(|p| p.disabled) {
                        return Ok(Identity::Nobody);
                    }
                    admin.resolve(&owner).map(Identity::Person)
                });
                (
                    resolved.unwrap_or(Identity::Failed),
                    ApiContext::NotApi,
                    None,
                )
            }
            // A person the API acts for: never the local owner, whatever the store says or fails with.
            route::Principal::Api {
                principal: Some(claim),
                ..
            } => {
                let binding = claim
                    .pointer("/binding/agentId")
                    .and_then(Value::as_str)
                    .map(str::to_owned);
                let Some(claimed) = delegated_person(claim) else {
                    return (Identity::Failed, ApiContext::Principal, binding);
                };
                let resolved = self.with_admin(|admin| {
                    // `resolvePrincipal`: a disabled person is refused as such before anything else.
                    if admin.person(&claimed.user_id)?.is_some_and(|p| p.disabled) {
                        return Ok(Identity::Disabled);
                    }
                    // `apiIdentities`: only a person the store knows; the stored role and agent rights win.
                    if admin.resolve_person(&claimed.user_id)?.is_none() {
                        return Ok(Identity::Nobody);
                    }
                    let mut current = admin.resolve(&claimed)?;
                    current.kind = Some(PrincipalKind::Person);
                    Ok(Identity::Person(current))
                });
                (
                    resolved.unwrap_or(Identity::Failed),
                    ApiContext::Principal,
                    binding,
                )
            }
            _ => (Identity::Failed, ApiContext::NotApi, None),
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
            // A rights change the API services did not hear of is the revocation path: an error, not a warning.
            crate::server::log(
                if rights { "error" } else { "warn" },
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
            ownership(a.role, before, role).map_err(admin_refusal)?;
            self.before_transaction();
            // Under the write lock: the rules again on the role the transaction reads, and the event names that role.
            let mut commit = |previous: Role| {
                ownership(a.role, previous, role)?;
                let detail = vec![
                    ("previous".to_owned(), json!(previous.as_str())),
                    ("role".to_owned(), json!(role.as_str())),
                ];
                self.audit(&a.user_id, "user.role.set", id, detail)
                    .map_err(AdminError::Hook)
            };
            admin
                .set_role_checked(id, role.as_str(), &mut commit)
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
            status_change(a.role, target.principal.role).map_err(admin_refusal)?;
            if reason.is_some_and(|r| js_length(r) > 200) {
                return Err(refusal(ErrorCode::EInvalidParams, "invalid reason", None));
            }
            let reason = audited_reason(reason.unwrap_or_default());
            self.before_transaction();
            // Under the write lock, and only for a change: the rule again on the person the transaction reads, and the
            // event names the role found there.
            let mut commit = |person: &Person| {
                let target_role = person.principal.role;
                status_change(a.role, target_role)?;
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
                    .map_err(AdminError::Hook)
            };
            admin
                .set_disabled_checked(id, disabled, &a.user_id, now(), &mut commit)
                .map_err(admin_refusal)
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

#[cfg(test)]
#[path = "native_api_tests.rs"]
mod api_tests;

#[cfg(test)]
#[path = "native_logs_tests.rs"]
mod logs_tests;
