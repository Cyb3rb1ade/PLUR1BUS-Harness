//! The native `secret.*` methods (P4-20 flip B2): `buildSecretMethods` of `packages/core/src/secrets/rpc.ts` over the
//! store the front door owns.
//!
//! **Served here only while the front door holds the store** ([`Native::serves_now`]). When the legacy core keeps it
//! (macOS before the move of the keychain items, the owner switch of the tests), these methods are relayed and the
//! legacy core answers them from its own store, as before.
//!
//! **Who is asking.** Five of the six methods have no rule in either RBAC table: the TypeScript handler resolves the
//! principal and hands the store one of two things, and the store's own gate decides and records (`secret.denied`).
//! [`Native::secret_principal`] is that mapping (`principalOf` in `core.ts`): a person whose stored role is Owner is
//! the store's `owner`, with the person's id and the surface of the connection; everyone else is an `agent` without
//! an id. `secret.describe` has a rule, and goes through the guard first, as `guardMethods` wraps it.
//!
//! The surface is the unattested one (T1). An attestation, which lives in the legacy core, can only raise a person
//! above it, and the store asks for T1: the decision is the same, and no record carries the level.
//!
//! **After a change** the legacy core is told before the caller is answered (`legacy.secret.changed`,
//! `docs/phase4/bridge.md`): it holds leases of the name, masks its own lines with the value, and has listeners for
//! changes. The call carries the name and, for a `set`, the value. Whatever else the store has to tell a holder
//! outside (a reconcile voided a name's leases, the store went away) stays collected for the bridge connection, which
//! owns the effects; the legacy core is asked to fetch them. A legacy core that was not reached changes nothing about
//! the change itself.
//!
//! The request to fetch goes out once for each stand of what waits ([`SecretStore::effects_stand`]), not once for
//! each call: a legacy core that has answered it and not fetched yet (its bridge is in its pause, it is busy) is not
//! asked again by every read and every `host.secret.get` until something new waits. A notice that failed is sent
//! again with the next call, but not sooner than [`NOTICE_RETRY`] after the failure, so a legacy core that does not
//! answer costs one wait in that time and not one for every call. The notice with a name is not held back by any of
//! this: every change is told.
//!
//! **`host.secret.get`** (R-20-32) is the engine's: `createHostMethods` of `engine/host-methods.ts` over
//! `createEngineSecrets` of `engine-host-ports.ts`. Only the engine's principal is served
//! ([`Native::host_secret_get`]); the connection and its token are `server.rs`'s to check, for every request. The
//! store is asked as the core: a lease of five seconds for `memory-engine`, the value, and the lease given back at
//! once, whatever happened in between. Every failure, an unknown name and a store that is away included, is the
//! server's answer to a handler that threw (`E_INTERNAL`, `handler-threw`): the TypeScript port turns each into a
//! plain error, and the engine is told nothing about why (P4D-37).
//!
//! **Which names (P4D-29, R-20-35, R-20-37, R-20-38).** The front door answers the engine for the names its
//! configuration refers to ([`crate::engine_scope::EngineScope`]: the set of the last valid `config.json`). A name
//! outside that set is not refused here: the request goes on to the legacy core ([`Native::engine_serves`], asked by
//! `server.rs` before the method is; a request that names no secret is refused here for its parameters, as before),
//! which knows what the front door does not, the planned target of an embedding
//! migration that is under way, and which decides and records. Should the method be called with such a name all the
//! same, it refuses: the store is asked as an agent named for the engine, which its own gate refuses and records
//! (`secret.denied`, the name as the target), no lease is taken, the answer is the one of a name nobody set, and a line
//! says that the routing let it through.
//!
//! **Nothing of a call is logged**: not a name's value, not a parameter. The lines name the method and a short code.
use super::{refusal, Identity, Native};
use crate::rbac::surface::{connection_surface, ConnectionFacts};
use crate::rbac::types::{Principal, PrincipalKind, Role};
use crate::route;
use crate::secrets::error::{SecretError, SecretErrorCode};
use crate::secrets::leases::IssueOptions;
use crate::secrets::types::{short_value_warning, SecretPrincipal};
use crate::secrets::SecretStore;
use plur1bus_rpc::server::{MethodError, RpcFailure};
use plur1bus_rpc::types::ErrorCode;
use serde_json::{json, Map, Value};
use std::sync::{Arc, PoisonError};
use std::time::{Duration, Instant};

/// The methods of this module: native while the front door owns the secret store, relayed otherwise.
pub const SECRET_METHODS: &[&str] = &[
    "secret.delete",
    "secret.describe",
    "secret.get",
    "secret.list",
    "secret.set",
    "secret.status",
];

/// The engine's method on the store: native for the engine's connection while the front door owns the secret store,
/// relayed otherwise (`route::ENGINE_NATIVE`).
pub const HOST_SECRET_GET: &str = "host.secret.get";
/// The agent the store is asked as for a name the engine may not resolve (`ENGINE_OUTSIDE_SCOPE` of
/// `engine-host-ports.ts`): the record of the refusal then says who asked (`agent:memory-engine`).
pub const ENGINE_OUTSIDE_SCOPE: &str = "memory-engine";

/// What `createEngineSecrets` leases with: the purpose `host-methods.ts` passes, the profile and the five seconds of
/// `engine-host-ports.ts`.
const ENGINE_LEASE: IssueOptions<'static> = IssueOptions {
    purpose: "memory-engine",
    profile_id: "memory-engine",
    ttl_ms: Some(5000.0),
};

/// How long after a notice failed the legacy core is not asked to fetch again: the wait of one call on the control
/// link, so a legacy core that does not answer holds up one native call in that time.
pub const NOTICE_RETRY: Duration = crate::control::CALL_WAIT;

/// What [`Native`] remembers of its notices to the legacy core.
#[derive(Default)]
pub struct Notices {
    /// The stand of the store's effects the legacy core last answered a notice for.
    answered: Option<u64>,
    /// When a notice last failed; `None` after one that was answered.
    failed: Option<Instant>,
}

/// `toRpcError` of `secrets/rpc.ts`: the store's code as the reason, its fixed text as the message, and for the three
/// refusals of a field the field's name as the detail.
fn secret_refusal(e: &SecretError) -> MethodError {
    let (error, detail) = match e.code {
        SecretErrorCode::Denied => (ErrorCode::EDenied, None),
        SecretErrorCode::NotFound => (ErrorCode::ENotFound, None),
        SecretErrorCode::InvalidName => (ErrorCode::EInvalidParams, Some("name")),
        SecretErrorCode::InvalidValue => (ErrorCode::EInvalidParams, Some("value")),
        SecretErrorCode::InvalidDescription => (ErrorCode::EInvalidParams, Some("description")),
        SecretErrorCode::InvalidTtl | SecretErrorCode::LeaseInvalid => {
            (ErrorCode::EInvalidParams, None)
        }
        SecretErrorCode::NoBackend | SecretErrorCode::BackendUnavailable => {
            (ErrorCode::ENotAvailable, None)
        }
        SecretErrorCode::Corrupt | SecretErrorCode::Storage | SecretErrorCode::AuditUnavailable => {
            (ErrorCode::EStorage, None)
        }
    };
    MethodError::Rpc(Box::new(RpcFailure {
        error,
        message: e.message.clone(),
        reason: Some(e.code.as_str().to_owned()),
        detail: detail.map(str::to_owned),
        ids: None,
        ext: None,
    }))
}

/// `principalOf` of `core.ts` for a resolved principal: the owner, as a person, is the store's `owner`; anyone else
/// is an agent the store refuses.
fn store_principal(resolved: Option<&Principal>) -> SecretPrincipal {
    match resolved {
        Some(p) if p.kind == Some(PrincipalKind::Person) && p.role == Role::Owner => {
            SecretPrincipal::Owner {
                id: Some(p.user_id.clone()),
                surface: Some(connection_surface(&ConnectionFacts {
                    is_person: true,
                    now: super::now() as f64,
                    attestation: None,
                })),
            }
        }
        _ => SecretPrincipal::Agent { agent_id: None },
    }
}

impl Native {
    /// The store the front door owns, once it is built. Set once; without it the `secret.*` methods are relayed.
    pub fn set_secrets(&self, store: Arc<SecretStore>) {
        let _ = self.secrets.set(store);
    }

    fn secret_store(&self) -> Result<&SecretStore, MethodError> {
        // `serves_now` relays these methods while there is no store; one that arrives here all the same is refused.
        self.secrets.get().map(Arc::as_ref).ok_or_else(|| {
            refusal(
                ErrorCode::EInternal,
                "route table drift",
                Some("route-table-drift"),
            )
        })
    }

    /// Who a `secret.*` call without a rule is for, to the store (`resolvePrincipal`, then `principalOf`).
    fn secret_principal(&self, who: &route::Principal) -> Result<SecretPrincipal, MethodError> {
        if !who.served_natively() {
            return Err(refusal(
                ErrorCode::EInternal,
                "route table drift",
                Some("route-table-drift"),
            ));
        }
        match self.identify(who).0 {
            Identity::Person(p) => Ok(store_principal(Some(&p))),
            Identity::Nobody => Ok(store_principal(None)),
            // `resolvePrincipal` throws this before anything else; the handler passes it on as it is.
            Identity::Disabled => Err(refusal(
                ErrorCode::EDenied,
                "person is disabled",
                Some("person-disabled"),
            )),
            // The resolver threw: the server's answer for a handler that failed.
            Identity::Failed => Err(refusal(
                ErrorCode::EInternal,
                "internal error",
                Some("handler-threw"),
            )),
        }
    }

    /// Tells the legacy core what a native call left for it: the change of `name` (with the value of a `set`), and
    /// that the store has effects to fetch. Called after every native call on the store, whatever its outcome. A
    /// change is always told. Without one, the legacy core is asked to fetch only when something waits that it has
    /// not answered a notice for, and after a failure not before [`NOTICE_RETRY`] has passed.
    fn tell_legacy_of_secrets(&self, store: &SecretStore, changed: Option<(&str, Option<&str>)>) {
        // Read before the call: what is added while the legacy core answers is a later stand, told by the next call.
        let stand = store.effects_stand();
        if changed.is_none() {
            let Some(stand) = stand else {
                return;
            };
            let notices = self
                .secret_notices
                .lock()
                .unwrap_or_else(PoisonError::into_inner);
            let answered = notices.answered == Some(stand);
            let resting = notices.failed.is_some_and(|at| at.elapsed() < NOTICE_RETRY);
            if answered || resting {
                return;
            }
        }
        let told = match self.legacy.get() {
            Some(legacy) => legacy.secret_changed(
                changed.map(|(name, _)| name),
                changed.and_then(|(_, value)| value),
            ),
            None => Err("unavailable".to_owned()),
        };
        let mut notices = self
            .secret_notices
            .lock()
            .unwrap_or_else(PoisonError::into_inner);
        match told {
            // Every notice makes the legacy core fetch what waits, a named one too.
            Ok(()) => {
                notices.failed = None;
                if stand.is_some() {
                    notices.answered = stand;
                }
            }
            Err(reason) => {
                notices.failed = Some(Instant::now());
                drop(notices);
                // The legacy core may go on reading a lease of the old value until it expires, and does not mask the
                // new one in its own lines: an error, not a warning.
                crate::server::log(
                    "error",
                    "the legacy core was not told of a change in the secret store",
                    json!({ "reason": reason, "named": changed.is_some() }),
                );
            }
        }
    }

    /// Test seam: the last failed notice happened `ago` earlier than it did.
    #[cfg(test)]
    pub(super) fn age_failed_notice(&self, ago: Duration) {
        let mut notices = self
            .secret_notices
            .lock()
            .unwrap_or_else(PoisonError::into_inner);
        notices.failed = notices.failed.and_then(|at| at.checked_sub(ago));
    }

    /// Runs one call on the store for `who`, and tells the legacy core what it left.
    fn on_secrets<T>(
        &self,
        who: &route::Principal,
        call: impl FnOnce(&SecretStore, &SecretPrincipal) -> Result<T, SecretError>,
    ) -> Result<T, MethodError> {
        let store = self.secret_store()?;
        let principal = self.secret_principal(who)?;
        let outcome = call(store, &principal);
        self.tell_legacy_of_secrets(store, None);
        outcome.map_err(|e| secret_refusal(&e))
    }

    /// `host.secret.get` for the engine: a fresh lease as the core, its value, and the lease revoked whatever happened
    /// (`createEngineSecrets(...).resolve(name, "memory-engine")`). The store records the lease and the revocation.
    ///
    /// Any other principal is refused as a routing change gone wrong (logged) and the store is not asked: the legacy
    /// core answers everyone else (`engine-principal-required`), and `route::route_for` sends them there.
    ///
    /// Whether the configuration that holds now lets the engine resolve `name` (P4D-29, R-20-35, R-20-36): the set of
    /// the last valid `config.json` (R-20-37), brought up to date for this request.
    fn engine_may_resolve(&self, name: &str) -> bool {
        self.engine_scope.allows(name)
    }

    /// Whether a request of the engine for one of its native methods is answered here (R-20-38): `host.secret.get`,
    /// unless it names a secret outside the front door's own set. Such a request goes on to the legacy core, which
    /// decides it and records a refusal, and so does every named one while the set cannot be built. A request that
    /// names no secret at all stays here, as before: its parameters are refused before the method is reached.
    pub fn engine_serves(&self, method: &str, msg: &Value) -> bool {
        method == HOST_SECRET_GET
            && match msg.pointer("/params/name") {
                Some(Value::String(name)) => self.engine_may_resolve(name),
                _ => true,
            }
    }

    /// Every failure is the answer to a handler that threw. The TypeScript port catches whatever the lease or the
    /// revocation raised and throws a plain error, which the server answers without a reason of its own. The line
    /// here is the server's (`handler failed`); it names the method and nothing of the call.
    pub fn host_secret_get(
        &self,
        who: &route::Principal,
        name: &str,
    ) -> Result<Value, MethodError> {
        if !matches!(who, route::Principal::Engine { .. }) {
            // As `route::native_principal` does for a person's method: a routing mistake must not pass unseen.
            crate::server::log(
                "error",
                "route table drift: the engine's method reached a principal that is not the engine",
                json!({ "method": HOST_SECRET_GET, "principal": who.kind() }),
            );
            return Err(refusal(
                ErrorCode::EInternal,
                "route table drift",
                Some("route-table-drift"),
            ));
        }
        let store = self.secret_store()?;
        let core = SecretPrincipal::Core;
        // P4D-29: `server.rs` sends a name outside the front door's set on to the legacy core (`engine_serves`). The
        // set is asked again here, for the request that is served: a name outside it is asked of the store as an agent
        // named for the engine, which the store's own gate refuses and records (`secret.denied`, the name as the target
        // when it is a valid one). No lease is taken, and the failure below is the one of every other.
        let in_scope = self.engine_may_resolve(name);
        let asker = if in_scope {
            core.clone()
        } else {
            // The configuration can have changed between the two questions; anything else is a routing mistake.
            crate::server::log(
                "error",
                "route table drift: the engine's method was reached with a name outside the engine's scope",
                json!({ "method": HOST_SECRET_GET }),
            );
            SecretPrincipal::Agent {
                agent_id: Some(ENGINE_OUTSIDE_SCOPE.to_owned()),
            }
        };
        let resolved = store.lease(&asker, name, ENGINE_LEASE).and_then(|lease| {
            // `finally`: the lease goes back before the value is used; a revocation that fails is a failure.
            let revoked = store.revoke_lease(&core, &lease.lease_id);
            if in_scope {
                revoked.map(|_| lease.value)
            } else {
                Err(SecretError::new(
                    SecretErrorCode::Denied,
                    "the store gave a lease to a caller outside the engine's scope",
                ))
            }
        });
        self.tell_legacy_of_secrets(store, None);
        match resolved {
            Ok(value) => Ok(json!({ "value": value })),
            Err(_) => {
                crate::server::log(
                    "error",
                    "handler failed",
                    json!({ "method": HOST_SECRET_GET, "reason": "handler-threw" }),
                );
                Err(refusal(
                    ErrorCode::EInternal,
                    "internal error",
                    Some("handler-threw"),
                ))
            }
        }
    }

    /// `secret.status`.
    pub fn secret_status(&self, who: &route::Principal) -> Result<Value, MethodError> {
        self.on_secrets(who, |store, p| store.status(p))
            .map(|status| status.to_json())
    }

    /// `secret.list`: names and metadata, never values.
    pub fn secret_list(&self, who: &route::Principal) -> Result<Value, MethodError> {
        self.on_secrets(who, |store, p| store.list(p)).map(|secrets| {
            json!({ "secrets": secrets.iter().map(|meta| meta.to_json()).collect::<Vec<_>>() })
        })
    }

    /// `secret.get`: the metadata, and with `reveal` the value.
    pub fn secret_get(
        &self,
        who: &route::Principal,
        name: &str,
        reveal: bool,
    ) -> Result<Value, MethodError> {
        if reveal {
            return self
                .on_secrets(who, |store, p| store.reveal(p, name))
                .map(|(meta, value)| json!({ "secret": meta.to_json(), "value": value }));
        }
        self.on_secrets(who, |store, p| store.meta(p, name))
            .map(|meta| json!({ "secret": meta.to_json() }))
    }

    /// `secret.describe`: the one method of the six with a rule (`settings.write`, human only), so the guard comes
    /// first and its refusal is recorded as the guard records it.
    pub fn secret_describe(
        &self,
        who: &route::Principal,
        name: &str,
        description: &str,
    ) -> Result<Value, MethodError> {
        let store = self.secret_store()?;
        let params = json!({ "name": name, "description": description });
        let resolved = self.authorize(who, "secret.describe", Some(&params))?;
        let principal = store_principal(Some(&resolved));
        let outcome = store.describe(&principal, name, description);
        self.tell_legacy_of_secrets(store, None);
        outcome
            .map(|meta| meta.to_json())
            .map_err(|e| secret_refusal(&e))
    }

    /// `secret.set`: stores the value; a value too short to be masked in logs is stored with a warning.
    pub fn secret_set(
        &self,
        who: &route::Principal,
        name: &str,
        value: &str,
        description: Option<&str>,
    ) -> Result<Value, MethodError> {
        let store = self.secret_store()?;
        let principal = self.secret_principal(who)?;
        let outcome = store.set(&principal, name, value, description);
        // Before the caller is answered: the legacy core voids its leases of the name, masks the value, and tells
        // its listeners. A set that failed changed nothing it has to learn by name.
        self.tell_legacy_of_secrets(store, outcome.as_ref().ok().map(|_| (name, Some(value))));
        let meta = outcome.map_err(|e| secret_refusal(&e))?;
        let mut result = match meta.to_json() {
            Value::Object(members) => members,
            _ => Map::new(),
        };
        if let Some(warning) = short_value_warning(value) {
            result.insert("warning".into(), warning.to_json());
        }
        Ok(Value::Object(result))
    }

    /// `secret.delete`.
    pub fn secret_delete(&self, who: &route::Principal, name: &str) -> Result<Value, MethodError> {
        let store = self.secret_store()?;
        let principal = self.secret_principal(who)?;
        let outcome = store.delete(&principal, name);
        self.tell_legacy_of_secrets(store, outcome.as_ref().ok().map(|()| (name, None)));
        outcome
            .map(|()| json!({ "removed": true }))
            .map_err(|e| secret_refusal(&e))
    }
}
