//! The front door's method table (P4-03 review §7, plan §2.4 step 2): where a request goes after the handshake, decided
//! from its method before anything is dispatched.
//!
//! | Route | Methods | What happens |
//! |---|---|---|
//! | [`Route::Native`] | [`NATIVE`] | served here: [`serve`] runs the generated `dispatch_core` with [`Methods`] |
//! | [`Route::Complete`] | [`COMPLETED`] | relayed with the front door's own id, so the legacy core still runs its admission and RBAC, then completed here ([`Kind`]) |
//! | [`Route::Bridge`] | the `bridge.*` namespace | served here, for the legacy core's bridge connection only |
//! | [`Route::Relay`] | every other method, known or unknown | relayed byte for byte on the client's link |
//!
//! Porting a method (P4-11 and later) changes exactly two things: its name goes into [`NATIVE`], and [`Methods`] overrides
//! its generated trait method. Nothing else routes it: a method leaves the relay set by entering [`NATIVE`]. The drift
//! test over every method fixture (`packages/rpc-schema/fixtures/methods`) holds the two together: a native method must
//! never answer `NotServed`, every other core method must. Should a native method answer `NotServed` anyway, the call is
//! refused with `E_INTERNAL` reason `route-table-drift` (logged) instead of being relayed after its params were consumed.
//!
//! **Who a native method serves** (fix round 1b F3, controller ruling): until P4-12 moves the identity store, a native
//! method serves the local owner only ([`Principal::served_natively`]); a call from any other principal (an API
//! delegation, a scoped client, the engine) is relayed to the legacy core like any other call, which runs module-api's
//! `authorizeClient`, its RBAC and the API's per-request binding ([`route_for`]). The method receives its caller as an
//! explicit [`Principal`] with its [`Transport`]; there is no "absent" principal a port could read as the owner.
//!
//! [`serve`] runs only the generated dispatcher (params against the schema with `_meta` removed, the method, the result
//! against the schema). The admission module-api runs before it for an owner's call (a delegation it carries, the request
//! shape) is the front door's (`server.rs`); RBAC is the overriding method's, as in a TypeScript handler.
use crate::auth::{Caller, Secret};
use crate::frame::RpcErr;
use crate::server::log;
use plur1bus_rpc::server::{
    dispatch_core, CoreMethods, DispatchError, RpcFailure, Validators, BRIDGE_METHODS, CORE_METHODS,
};
use serde_json::{json, Map, Value};
use std::collections::HashMap;
use std::future::Future;
use std::sync::{Arc, OnceLock};
use std::task::{Context, Poll, Wake, Waker};

/// The core methods the front door serves itself. Empty until the first port (P4-11).
pub const NATIVE: &[&str] = &[];

/// The relayed methods whose answer the front door completes, and how.
pub const COMPLETED: &[(&str, Kind)] = &[
    ("core.auth", Kind::Auth),
    ("core.status", Kind::Status),
    ("core.adopt", Kind::Adopt),
    ("core.shutdown", Kind::Shutdown),
    ("events.subscribe", Kind::Subscribe),
    ("events.unsubscribe", Kind::Unsubscribe),
];

/// How the front door completes a relayed answer.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Kind {
    /// A re-authentication: the front door's own credential checks, a new link identity, its pid and capabilities.
    Auth,
    /// The status names the front door's process.
    Status,
    /// An accepted adoption makes the connection the front door's lifeline.
    Adopt,
    /// An accepted shutdown stops the front door.
    Shutdown,
    /// An owner's subscriptions are kept for the front door's own `core.state`.
    Subscribe,
    /// The matching unsubscription.
    Unsubscribe,
}

/// Where a request goes after the handshake.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Route {
    /// Served here ([`NATIVE`]).
    Native,
    /// Relayed with the front door's own id and completed here.
    Complete(Kind),
    /// The `bridge.*` namespace: the legacy core's bridge connection only.
    Bridge,
    /// Relayed byte for byte.
    Relay,
}

/// The route of `method`, whoever calls.
pub fn route(method: &str) -> Route {
    lookup(table(), method)
}

/// The route of `method` for a connection authenticated as `caller`: a native method only for a principal served
/// natively (the local owner, until P4-12), relayed for every other one.
pub fn route_for(method: &str, caller: Caller) -> Route {
    route_in(table(), method, caller)
}

fn route_in(table: &HashMap<&'static str, Route>, method: &str, caller: Caller) -> Route {
    match (caller, lookup(table, method)) {
        (Caller::LegacyCore, _) => Route::Bridge,
        (Caller::Owner, route) => route,
        (_, Route::Native) => Route::Relay,
        (_, route) => route,
    }
}

fn lookup(table: &HashMap<&'static str, Route>, method: &str) -> Route {
    if method.starts_with("bridge.") {
        return Route::Bridge;
    }
    table.get(method).copied().unwrap_or(Route::Relay)
}

/// The table, built once from the generated method lists.
fn table() -> &'static HashMap<&'static str, Route> {
    static TABLE: OnceLock<HashMap<&'static str, Route>> = OnceLock::new();
    TABLE.get_or_init(|| table_with(NATIVE))
}

fn table_with(native: &[&str]) -> HashMap<&'static str, Route> {
    let core = CORE_METHODS.iter().map(|&method| {
        let route = if native.contains(&method) {
            Route::Native
        } else if let Some((_, kind)) = COMPLETED.iter().find(|(m, _)| *m == method) {
            Route::Complete(*kind)
        } else {
            Route::Relay
        };
        (method, route)
    });
    core.chain(BRIDGE_METHODS.iter().map(|&m| (m, Route::Bridge)))
        .collect()
}

/// How a call reached the core.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Transport {
    /// The core's own socket or pipe (`run/core.sock`, the per-home pipe), no delegation.
    Ipc,
    /// Through the harness API, which states how the request reached it (`api.transport`; `None` when it does not).
    Api(Option<ApiTransport>),
}

/// `api.transport`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ApiTransport {
    /// `loopback`.
    Loopback,
    /// `remote`.
    Remote,
}

/// Who calls, as the front door authenticated the connection (fix round 1b F3). Every principal is explicit: TypeScript's
/// "no API principal" means local owner IPC, and a port must never meet an absent principal it could read that way.
#[derive(Clone, Debug, PartialEq)]
pub enum Principal {
    /// `run/core.token` on the core's own socket or pipe, without a delegation.
    LocalOwner {
        /// Always [`Transport::Ipc`].
        transport: Transport,
    },
    /// The harness API with the person or agent it delegates for (`api.principal`; `None` for the API itself).
    Api {
        /// `api.principal`.
        principal: Option<Value>,
        /// [`Transport::Api`].
        transport: Transport,
    },
    /// A scoped client token; only the legacy core's identity store can authorize its calls (until P4-12).
    ScopedClient {
        /// The token the client authenticated with, for that per-call authorization.
        token: Arc<Secret>,
        /// The connection's transport.
        transport: Transport,
    },
    /// A module (controller ruling D/F3). No connection of the front door authenticates as a module today.
    Module {
        /// The connection's transport.
        transport: Transport,
    },
    /// The memory engine (`run/engine.token`): `host.*` and its egress subscription.
    Engine {
        /// The connection's transport.
        transport: Transport,
    },
}

impl Principal {
    /// Whether a native method serves this principal. Until P4-12 only the local owner: every other principal's call is
    /// relayed to the legacy core ([`route_for`]).
    pub fn served_natively(&self) -> bool {
        matches!(self, Principal::LocalOwner { .. })
    }
}

/// The principal a native call is served for, derived from the connection's authenticated `caller` (re-review 1b N2):
/// the local owner, the only principal served natively until P4-12. [`route_for`] relays every other caller's native
/// call, so one that arrives here is a routing change gone wrong: refused `E_INTERNAL` reason `route-table-drift` (logged),
/// never served as the owner.
pub fn native_principal(method: &str, caller: Option<Caller>) -> Result<Principal, Value> {
    match caller {
        Some(Caller::Owner) => Ok(Principal::LocalOwner {
            transport: Transport::Ipc,
        }),
        other => {
            log(
                "error",
                "route table drift: a native method reached a principal not served natively",
                json!({"method": method, "caller": other.map(Caller::as_str)}),
            );
            Err(RpcErr::new("E_INTERNAL", "route table drift", Some("route-table-drift")).to_json())
        }
    }
}

/// What a native method receives besides its params.
#[derive(Clone, Debug, PartialEq)]
pub struct CallContext {
    /// Who calls. A native method meets only principals that are [`Principal::served_natively`].
    pub principal: Principal,
}

/// The front door's `CoreMethods`: every method keeps its generated default (`NotServed`) until it is ported. A method
/// overridden here must be in [`NATIVE`], and a method in [`NATIVE`] must be overridden here (the drift test).
pub struct Methods;

impl CoreMethods for Methods {
    type Context = CallContext;
}

/// The validators of every `x-server: "core"` method, compiled once: at start when there are native methods
/// ([`prepare`]), else never.
fn validators() -> &'static Result<Validators, String> {
    static VALIDATORS: OnceLock<Result<Validators, String>> = OnceLock::new();
    VALIDATORS.get_or_init(|| Validators::for_server("core"))
}

/// Compiles the validators at start when the front door serves any method itself, so that no connection thread pays for
/// the compile of every core validator on the first native call (task review I4). Nothing while [`NATIVE`] is empty.
pub fn prepare() -> Result<(), String> {
    prepare_for(NATIVE)
}

fn prepare_for(native: &[&str]) -> Result<(), String> {
    if native.is_empty() {
        return Ok(());
    }
    validators().as_ref().map(|_| ()).map_err(Clone::clone)
}

/// Serves a native call through `dispatch_core`: the result, or the `error` member of the reply (module-api's
/// `RpcError.toJSON()` shape).
pub fn serve(cx: &CallContext, method: &str, params: Value) -> Result<Value, Value> {
    match validators() {
        Ok(validators) => block_on(dispatch_core(&Methods, cx, validators, method, params))
            .map_err(|e| refusal(method, e)),
        Err(e) => {
            log(
                "error",
                "the core method validators do not compile",
                json!({"err": e}),
            );
            Err(internal())
        }
    }
}

fn internal() -> Value {
    RpcErr::new("E_INTERNAL", "internal error", Some("handler-threw")).to_json()
}

/// The reply's `error` member for a native call that produced no result, as module-api answers the same case. A
/// `NotServed` here is a drift between [`NATIVE`] and [`Methods`]: `E_INTERNAL` reason `route-table-drift`, logged.
pub fn refusal(method: &str, error: DispatchError) -> Value {
    match error {
        DispatchError::UnknownMethod => RpcErr::new(
            "E_INTERNAL",
            format!("method not found: {method}"),
            Some("method-not-found"),
        )
        .jsonrpc(-32601)
        .to_json(),
        DispatchError::NotServed => {
            log(
                "error",
                "route table drift: a native method is not served",
                json!({"method": method}),
            );
            RpcErr::new("E_INTERNAL", "route table drift", Some("route-table-drift")).to_json()
        }
        DispatchError::InvalidParams(found) => {
            RpcErr::new("E_INVALID_PARAMS", "invalid params", None)
                .detail(found.join("; "))
                .to_json()
        }
        DispatchError::ParamsDecode(e) | DispatchError::ResultEncode(e) => {
            log(
                "error",
                "a native method failed",
                json!({"method": method, "err": e}),
            );
            internal()
        }
        DispatchError::Method(failure) => failure_json(&failure),
        DispatchError::ResultSchema(found) => {
            log(
                "error",
                "result violates schema",
                json!({"method": method, "findings": found.len()}),
            );
            RpcErr::new(
                "E_INTERNAL",
                "result violates schema",
                Some("result-schema"),
            )
            .to_json()
        }
    }
}

/// A method's refusal as `RpcError.toJSON()` writes it (`ext` as `ErrorObject.data.ext`).
fn failure_json(f: &RpcFailure) -> Value {
    let code = f.error.to_string();
    let mut data = Map::new();
    data.insert("error".into(), Value::from(code.clone()));
    if let Some(reason) = f.reason.as_deref().filter(|r| !r.is_empty()) {
        data.insert("reason".into(), Value::from(reason));
    }
    if let Some(detail) = f.detail.as_deref().filter(|d| !d.is_empty()) {
        data.insert("detail".into(), Value::from(detail));
    }
    if let Some(ids) = f.ids.as_ref().filter(|ids| !ids.is_empty()) {
        data.insert(
            "ids".into(),
            Value::Object(
                ids.iter()
                    .map(|(k, v)| (k.clone(), Value::from(v.clone())))
                    .collect(),
            ),
        );
    }
    if let Some(ext) = &f.ext {
        data.insert("ext".into(), ext.clone());
    }
    let jsonrpc = if code == "E_INVALID_PARAMS" {
        -32602
    } else {
        -32000
    };
    json!({"code": jsonrpc, "message": f.message, "data": data})
}

/// Runs a future to completion on this thread (the front door's connections are threads, not tasks). The generated
/// dispatcher and a method that does not await anything complete on the first poll; a method that does is woken here.
/// There is no async runtime on these threads: a ported method that awaits tokio I/O or timers needs a runtime handle
/// first (P4-11, task review I4).
pub fn block_on<F: Future>(future: F) -> F::Output {
    struct Unpark(std::thread::Thread);
    impl Wake for Unpark {
        fn wake(self: Arc<Self>) {
            self.0.unpark();
        }
        fn wake_by_ref(self: &Arc<Self>) {
            self.0.unpark();
        }
    }
    let waker = Waker::from(Arc::new(Unpark(std::thread::current())));
    let mut cx = Context::from_waker(&waker);
    let mut future = std::pin::pin!(future);
    loop {
        if let Poll::Ready(out) = future.as_mut().poll(&mut cx) {
            return out;
        }
        std::thread::park();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use plur1bus_rpc::server::MethodError;
    use plur1bus_rpc::types;
    use std::path::PathBuf;

    /// `packages/rpc-schema/fixtures/methods/<m>.json` as (method, params); `jobs.run.system`/`.user` are `jobs.run`.
    fn fixtures() -> Vec<(String, Value)> {
        let dir = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../../packages/rpc-schema/fixtures/methods");
        let mut all = Vec::new();
        for entry in std::fs::read_dir(&dir).unwrap() {
            let path = entry.unwrap().path();
            let stem = path.file_stem().unwrap().to_str().unwrap().to_owned();
            let method = match stem.as_str() {
                "jobs.run.system" | "jobs.run.user" => "jobs.run".to_owned(),
                _ => stem,
            };
            let fixture: Value =
                serde_json::from_str(&std::fs::read_to_string(&path).unwrap()).unwrap();
            all.push((method, fixture["params"].clone()));
        }
        all.sort_by(|a, b| a.0.cmp(&b.0));
        all
    }

    /// Every mismatch between a native set and a `CoreMethods` implementation over the core method fixtures: a native
    /// method that answers `NotServed`, or another core method that does not.
    fn drift<S: CoreMethods>(server: &S, cx: &S::Context, native: &[&str]) -> Vec<String> {
        let validators = Validators::for_server("core").unwrap();
        let mut found = Vec::new();
        let mut checked = 0;
        for (method, params) in fixtures() {
            if !CORE_METHODS.contains(&method.as_str()) {
                continue;
            }
            checked += 1;
            let outcome = block_on(dispatch_core(server, cx, &validators, &method, params));
            let not_served = matches!(outcome, Err(DispatchError::NotServed));
            match (native.contains(&method.as_str()), not_served) {
                (true, true) => found.push(format!("{method}: native but not served")),
                (false, false) => {
                    found.push(format!("{method}: served but not native ({outcome:?})"))
                }
                _ => {}
            }
        }
        assert!(
            checked > 300,
            "the core method fixtures were read ({checked})"
        );
        found
    }

    fn owner() -> CallContext {
        CallContext {
            principal: Principal::LocalOwner {
                transport: Transport::Ipc,
            },
        }
    }

    #[test]
    fn every_core_method_routes_to_the_relay_a_completion_or_the_native_set() {
        for &method in CORE_METHODS {
            let expected = if NATIVE.contains(&method) {
                Route::Native
            } else if let Some((_, kind)) = COMPLETED.iter().find(|(m, _)| *m == method) {
                Route::Complete(*kind)
            } else {
                Route::Relay
            };
            assert_eq!(route(method), expected, "{method}");
        }
        for (method, kind) in COMPLETED {
            assert!(CORE_METHODS.contains(method), "{method} is a core method");
            assert!(
                !NATIVE.contains(method),
                "{method}: completed or native, not both"
            );
            assert_eq!(route(method), Route::Complete(*kind));
        }
        for method in NATIVE {
            assert!(
                CORE_METHODS.contains(method),
                "NATIVE ⊆ core methods: {method}"
            );
        }
        for method in BRIDGE_METHODS {
            assert!(method.starts_with("bridge."), "{method}");
            assert_eq!(route(method), Route::Bridge);
        }
        assert_eq!(
            route("bridge.unknown"),
            Route::Bridge,
            "the namespace is the front door's"
        );
        assert_eq!(
            route("no.such.method"),
            Route::Relay,
            "the legacy core answers an unknown method"
        );
        assert_eq!(
            route("engine.health"),
            Route::Relay,
            "another server's method is not the core's to serve"
        );
    }

    /// Fix round 1b F3 (ruling D/F3): until P4-12 a native method serves the local owner only; every other principal's
    /// call goes to the legacy core, which runs `authorizeClient`, RBAC and the API's per-request binding. Checked with a
    /// test-only native set (`logs.query`) and a `CoreMethods` that fails the test if it is ever called for one of them.
    #[test]
    fn a_native_method_serves_the_local_owner_and_every_other_principal_is_relayed() {
        let table = table_with(&["logs.query"]);
        assert_eq!(route_in(&table, "logs.query", Caller::Owner), Route::Native);
        for caller in [Caller::Client, Caller::Api, Caller::Engine] {
            assert_eq!(
                route_in(&table, "logs.query", caller),
                Route::Relay,
                "{caller:?}: relayed until P4-12"
            );
        }
        assert_eq!(
            route_in(&table, "logs.query", Caller::LegacyCore),
            Route::Bridge,
            "the bridge connection serves bridge.* only"
        );
        assert_eq!(
            route_in(&table, "core.status", Caller::Client),
            Route::Complete(Kind::Status)
        );
        assert_eq!(route_in(&table, "memory.list", Caller::Owner), Route::Relay);

        /// Fails the test if a method is dispatched for anyone but the local owner.
        struct OwnerOnly;
        impl CoreMethods for OwnerOnly {
            type Context = CallContext;
            #[allow(clippy::manual_async_fn)] // the generated trait's own signature
            fn logs_query(
                &self,
                cx: &CallContext,
                _params: types::LogsQueryParams,
            ) -> impl Future<Output = Result<types::LogsQueryResult, MethodError>> + Send
            {
                assert!(
                    cx.principal.served_natively(),
                    "dispatched for {:?}",
                    cx.principal
                );
                async { Err(MethodError::rpc(types::ErrorCode::EDenied, "test")) }
            }
        }
        let validators = Validators::for_server("core").unwrap();
        let owner = owner();
        assert_eq!(
            owner.principal,
            Principal::LocalOwner {
                transport: Transport::Ipc
            }
        );
        let out = block_on(dispatch_core(
            &OwnerOnly,
            &owner,
            &validators,
            "logs.query",
            json!({}),
        ));
        assert!(
            matches!(out, Err(DispatchError::Method(_))),
            "served natively for the owner: {out:?}"
        );
        for principal in [
            Principal::Api {
                principal: Some(json!({"userId": "alice", "kind": "person", "role": "member"})),
                transport: Transport::Api(Some(ApiTransport::Remote)),
            },
            Principal::ScopedClient {
                token: Arc::new(Secret::fresh().unwrap()),
                transport: Transport::Ipc,
            },
            Principal::Module {
                transport: Transport::Ipc,
            },
            Principal::Engine {
                transport: Transport::Ipc,
            },
        ] {
            assert!(!principal.served_natively(), "{principal:?}");
        }
    }

    /// Re-review 1b N2: the second line behind [`route_in`]. The principal a native call is served for comes from the
    /// connection's caller; any caller but the local owner that reaches a native method (a routing change gone wrong) is
    /// refused as a route-table drift and never served as the owner, so the test-only native method is never dispatched
    /// for it.
    #[test]
    fn a_native_call_is_served_for_the_owner_only_whatever_the_routing_says() {
        let validators = Validators::for_server("core").unwrap();
        let principal = native_principal("logs.query", Some(Caller::Owner)).unwrap();
        assert_eq!(
            principal,
            Principal::LocalOwner {
                transport: Transport::Ipc
            }
        );
        let served = block_on(dispatch_core(
            &ServesLogsQuery,
            &CallContext { principal },
            &validators,
            "logs.query",
            json!({}),
        ));
        assert!(
            matches!(served, Err(DispatchError::Method(_))),
            "{served:?}"
        );
        for caller in [
            Some(Caller::Client),
            Some(Caller::Api),
            Some(Caller::Engine),
            Some(Caller::LegacyCore),
            None,
        ] {
            let refused = native_principal("logs.query", caller).unwrap_err();
            assert_eq!(
                (
                    refused["data"]["error"].as_str(),
                    refused["data"]["reason"].as_str()
                ),
                (Some("E_INTERNAL"), Some("route-table-drift")),
                "{caller:?}"
            );
        }
    }

    #[test]
    fn the_native_set_and_the_front_doors_methods_agree_on_every_fixture() {
        assert_eq!(drift(&Methods, &owner(), NATIVE), Vec::<String>::new());
    }

    /// A `CoreMethods` that serves one method natively, for the drift check's own test.
    struct ServesLogsQuery;
    impl CoreMethods for ServesLogsQuery {
        type Context = CallContext;
        #[allow(clippy::manual_async_fn)] // the generated trait's own signature
        fn logs_query(
            &self,
            _cx: &CallContext,
            _params: types::LogsQueryParams,
        ) -> impl Future<Output = Result<types::LogsQueryResult, MethodError>> + Send {
            async { Err(MethodError::rpc(types::ErrorCode::EDenied, "test")) }
        }
    }

    #[test]
    fn the_drift_check_catches_both_directions() {
        assert_eq!(
            drift(&Methods, &owner(), &["logs.query"]),
            ["logs.query: native but not served"],
            "listed native but not overridden: the call would be consumed and answered NotServed"
        );
        let served = drift(&ServesLogsQuery, &owner(), &[]);
        assert_eq!(served.len(), 1, "{served:?}");
        assert!(
            served[0].starts_with("logs.query: served but not native"),
            "overridden but not listed: the port would be dead code behind the relay ({served:?})"
        );
        assert!(drift(&ServesLogsQuery, &owner(), &["logs.query"]).is_empty());
    }

    #[test]
    fn a_native_call_maps_every_dispatch_outcome_like_module_api() {
        let reason = |v: &Value| v["data"]["reason"].as_str().unwrap_or("").to_owned();
        let drifted = refusal("logs.query", DispatchError::NotServed);
        assert_eq!(
            (
                drifted["data"]["error"].as_str(),
                reason(&drifted).as_str(),
                drifted["code"].as_i64()
            ),
            (Some("E_INTERNAL"), "route-table-drift", Some(-32000))
        );
        let unknown = refusal("x.y", DispatchError::UnknownMethod);
        assert_eq!(
            (reason(&unknown).as_str(), unknown["code"].as_i64()),
            ("method-not-found", Some(-32601))
        );
        assert_eq!(unknown["message"], "method not found: x.y");
        let invalid = refusal(
            "x.y",
            DispatchError::InvalidParams(vec!["/a is bad".into(), "/b too".into()]),
        );
        assert_eq!(
            (
                invalid["data"]["error"].as_str(),
                invalid["code"].as_i64(),
                invalid["data"]["detail"].as_str()
            ),
            (
                Some("E_INVALID_PARAMS"),
                Some(-32602),
                Some("/a is bad; /b too")
            )
        );
        assert_eq!(
            reason(&refusal("x.y", DispatchError::ResultSchema(vec![]))),
            "result-schema"
        );
        let MethodError::Rpc(failure) =
            MethodError::rpc(types::ErrorCode::EDenied, "no").with_reason("object-right-required")
        else {
            panic!("a refusal")
        };
        let denied = refusal("x.y", DispatchError::Method(failure));
        assert_eq!(
            denied,
            json!({"code": -32000, "message": "no", "data": {"error": "E_DENIED", "reason": "object-right-required"}})
        );
        // Through the real dispatcher: a core method the front door does not serve is a drift when it is called natively.
        let out = serve(&owner(), "logs.query", json!({}));
        assert_eq!(reason(&out.unwrap_err()), "route-table-drift");
        assert_eq!(
            reason(&serve(&owner(), "no.such", json!({})).unwrap_err()),
            "method-not-found"
        );
    }

    #[test]
    fn the_validators_are_compiled_at_start_once_a_method_is_native() {
        assert_eq!(prepare_for(&[]), Ok(()));
        assert_eq!(prepare_for(&["core.status"]), Ok(()));
        assert!(validators().is_ok(), "compiled by prepare");
        assert_eq!(prepare(), Ok(()));
    }

    #[test]
    fn block_on_finishes_a_future_that_is_woken_from_another_thread() {
        struct Later(bool);
        impl Future for Later {
            type Output = u8;
            fn poll(mut self: std::pin::Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<u8> {
                if self.0 {
                    return Poll::Ready(7);
                }
                self.0 = true;
                let waker = cx.waker().clone();
                std::thread::spawn(move || {
                    std::thread::sleep(std::time::Duration::from_millis(20));
                    waker.wake();
                });
                Poll::Pending
            }
        }
        assert_eq!(block_on(Later(false)), 7);
    }
}
