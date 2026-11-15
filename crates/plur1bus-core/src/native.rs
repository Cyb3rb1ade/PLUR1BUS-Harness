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
//! (flip plan F1); the native methods of A1 only read them. `admin.sqlite` is opened once and kept; the identity service
//! is opened for the one call that needs it (its options are not `Send`, and the call is rare). A refusal's audit event
//! goes where the TypeScript core's goes: one line in `logs/audit.log` and one record in the hash chain beside it, which
//! the legacy core and the CLI extend under the same lock.
use crate::identity::admin_store::{AdminError, AdminStore};
use crate::identity::codes::{draw48, random_int_from_draws, RandomSource};
use crate::identity::error::{IdentityError, IdentityErrorCode};
use crate::identity::principals::derive_user_principal;
use crate::identity::service_impl::{
    AuditEvent as IdentityEvent, IdentityAudit, IdentityFailure, IdentityOptions, IdentityService,
};
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
use serde_json::{json, Value};
use std::path::{Path, PathBuf};
use std::sync::{Mutex, PoisonError};

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
        let chained = detail_redactor().and_then(|redactor| {
            let detail: Value = serde_json::from_str(&redacted_detail(&event.detail, &redactor))
                .map_err(|e| e.to_string())?;
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
            chain::append(&self.logs, &actor, &record).map_err(|e| e.to_string())
        });
        line.and(chained)
    }
}

/// An identity service that only reads: its audit sink refuses, so a path that would record (and change) something
/// fails instead.
struct NoAudit;
impl IdentityAudit for NoAudit {
    fn emit(&mut self, _: &IdentityEvent) -> Result<(), String> {
        Err("the front door's identity service only reads".to_owned())
    }
}

/// The operating system's random source, with Node's `randomInt` rejection rule. Not reached by a read.
struct OsRandom;
impl RandomSource for OsRandom {
    fn random_int(&mut self, max: u32) -> u32 {
        let drawn = random_int_from_draws(u64::from(max), || {
            let mut six = [0u8; 6];
            self.fill_bytes(&mut six);
            draw48(&six)
        });
        u32::try_from(drawn).unwrap_or(0)
    }
    fn fill_bytes(&mut self, out: &mut [u8]) {
        // Without entropy the bytes stay zero; nothing the front door serves draws a code or a salt.
        let _ = getrandom::fill(out);
    }
}

/// The state of the native methods of one front door.
pub struct Native {
    home: PathBuf,
    admin: Mutex<Option<AdminStore>>,
}

impl Native {
    /// For the home at `home`. Opens nothing: `state/admin.sqlite` is opened by the first native call.
    pub fn new(home: &Path) -> Native {
        Native {
            home: home.to_path_buf(),
            admin: Mutex::new(None),
        }
    }

    /// Runs `f` on `state/admin.sqlite`, opening it first if this is the first use (as the TypeScript core opens it:
    /// an empty installation gets the local owner as its owner).
    fn with_admin<T>(
        &self,
        f: impl FnOnce(&mut AdminStore) -> Result<T, AdminError>,
    ) -> Result<T, AdminError> {
        let mut slot = self.admin.lock().unwrap_or_else(PoisonError::into_inner);
        if slot.is_none() {
            let path = self.home.join("state").join("admin.sqlite");
            *slot = Some(AdminStore::open(&path, &local_owner().user_id, &secure)?);
        }
        match slot.as_mut() {
            Some(store) => f(store),
            None => Err(AdminError::Storage("admin store unavailable".to_owned())),
        }
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
        let principals = derive_user_principal(human)
            .map_err(IdentityFailure::Refused)
            .and_then(|v2| self.identity()?.resolve_principals(&v2))
            .map_err(surface_error)?;
        Ok(json!({ "humanId": human, "principals": principals }))
    }

    /// The identity service on `state/identity.sqlite`, for one call.
    fn identity(&self) -> Result<IdentityService, IdentityFailure> {
        IdentityService::create(IdentityOptions {
            db_path: self.home.join("state").join("identity.sqlite"),
            clock: Box::new(now),
            audit: Box::new(NoAudit),
            random: Box::new(OsRandom),
            secure_path: Box::new(secure),
            authorize: None,
            code_ttl_ms: None,
        })
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
