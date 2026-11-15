//! The bridge endpoint (P4-20 flip B1): where the legacy core reaches what the front door owns.
//!
//! While the front door owns the secret store, the TypeScript core behind it has a store that is a client: every
//! operation is a `bridge.secret.*` call (`docs/phase4/bridge.md`). The legacy core needs its store before it listens
//! (the start-up preload, the listeners for changes), and the front door binds its public socket only after the legacy
//! core is ready. So the bridge has an address of its own (`run/core-bridge.sock`, or the per-home `-core-bridge`
//! pipe), bound before the legacy core is started.
//!
//! **Who is served.** One kind of peer: a connection whose first request is `core.auth` with the link credential
//! (`run/core-legacy.token`), which only the front door and the legacy core it started hold. Anything else is answered
//! once and closed. After the handshake the connection has `bridge.hello` and `bridge.secret.*`; every other method is
//! refused with `bridge-principal`, as on the public socket.
//!
//! **The principal is data.** A `bridge.secret.*` call names who asks ([`principal_of`]). The front door takes it as
//! the legacy core gives it: the legacy core derives it from its own connections, never from a client's parameters,
//! and its in-process callers have no connection at all. The gates and the audit records are the store's, here.
//!
//! **Effects.** Every answer carries what the legacy core has not been told yet about the things it holds
//! ([`crate::secrets::store::Effects`]): the leases it was handed and its copy of the start-up snapshot. An error
//! carries none; they stay collected, and the legacy core asks for them with `bridge.secret.preload`, which always
//! answers with the whole snapshot.
//!
//! **A connection opens with the preload.** `bridge.secret.preload` names the keyring service the legacy core derived
//! from its home. Until a preload named the front door's, the connection has no other `bridge.secret.*` method: two
//! processes that spell the home differently would otherwise work on one store while the legacy core believes it is
//! another (its child processes derive the name the same way and open the keyring themselves).
//!
//! **One connection has the store.** The effects are the store's, not a connection's, so they must reach the one
//! connection the legacy core uses. A connection's first preload makes it that connection; every older one is
//! refused from then on, before its call reaches the store. A call, its effects and the check that the connection is
//! still the one are a single turn ([`Shared::turn`]): a request that was still queued on a connection the legacy core
//! gave up cannot take the effects of a call on the connection that replaced it (security review S2).
//!
//! **Bounds.** At most [`MAX_CONNECTIONS`] at once; a connection has [`AUTH_WAIT`] to send its handshake, and before
//! the handshake anything else ends it (a notification and a line without a method too). The public socket has had
//! such bounds since P4-10; this endpoint is reachable by every process of the installation's user, which could also
//! stop the front door, so the bounds are against accidents, not against that user (security review S1).
//!
//! **Nothing of a call is logged.** Not its parameters, not its result, not a finding of the schema about either (a
//! finding can quote the value it is about). The lines of this module name a method and a short code.
use crate::auth::Secret;
use crate::frame::{self, Line, RpcErr};
use crate::rbac::surface::SurfaceTrustLevel;
use crate::secrets::error::{SecretError, SecretErrorCode};
use crate::secrets::leases::IssueOptions;
use crate::secrets::store::{Effects, SecretStore};
use crate::secrets::types::SecretPrincipal;
use plur1bus_rpc::server::{DispatchError, Validators};
use plur1bus_rpc::server_transport::{Accepted, Listener};
use serde_json::{json, Map, Value};
use std::io::{self, BufReader, Write};
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex, PoisonError};
use std::thread::JoinHandle;
use std::time::Duration;

/// The role of the bridge's address (`unitAddress(home, "core-bridge")`).
pub const BRIDGE_ROLE: &str = "core-bridge";

/// Connections at once. The legacy core needs one, and a second while it replaces one it lost.
pub const MAX_CONNECTIONS: usize = 8;

/// How long a connection may take to send its handshake.
pub const AUTH_WAIT: Duration = Duration::from_secs(5);

/// What the bridge serves with.
pub struct BridgeContext {
    /// The link credential (`run/core-legacy.token`).
    pub link_token: Secret,
    /// The front door's instance id.
    pub instance: String,
    /// The front door's process id.
    pub pid: u32,
    /// The store the front door owns.
    pub store: Arc<SecretStore>,
    /// The keyring service of this home, as the front door derived it.
    pub service: String,
}

/// The bridge while it listens.
pub struct Bridge {
    stop: Arc<AtomicBool>,
    accept: Option<JoinHandle<()>>,
}

impl Bridge {
    /// Binds `address` and serves `context` on it until [`stop`](Self::stop).
    pub fn start(address: &str, context: BridgeContext) -> Result<Bridge, String> {
        let validators = Validators::for_server("bridge")?;
        let listener = Listener::bind(address).map_err(|e| format!("listen on {address}: {e}"))?;
        let shared = Arc::new(Shared {
            context,
            validators,
            open: AtomicUsize::new(0),
            turn: Mutex::new(0),
        });
        let stop = Arc::new(AtomicBool::new(false));
        let stopped = stop.clone();
        let accept = std::thread::Builder::new()
            .name("core-bridge".into())
            .spawn(move || accept_loop(&listener, &shared, &stopped))
            .map_err(|e| format!("the bridge thread: {e}"))?;
        Ok(Bridge {
            stop,
            accept: Some(accept),
        })
    }

    /// Stops accepting. A connection that is open ends with its peer; the store it would call is closed by then.
    pub fn stop(mut self) {
        self.stop.store(true, Ordering::SeqCst);
        if let Some(accept) = self.accept.take() {
            let _ = accept.join();
        }
    }
}

struct Shared {
    context: BridgeContext,
    validators: Validators,
    /// Connections being served.
    open: AtomicUsize,
    /// The turn of a call: held from the check that a connection is the one that has the store, through the store's
    /// operation, to the taking of its effects. The number is that of the connection that has the store (0: none).
    turn: Mutex<u64>,
}

/// One place among the [`MAX_CONNECTIONS`], given back when the connection ends.
struct Place(Arc<Shared>);

impl Place {
    fn take(shared: &Arc<Shared>) -> Option<Place> {
        if shared.open.fetch_add(1, Ordering::SeqCst) >= MAX_CONNECTIONS {
            shared.open.fetch_sub(1, Ordering::SeqCst);
            return None;
        }
        Some(Place(shared.clone()))
    }
}

impl Drop for Place {
    fn drop(&mut self) {
        self.0.open.fetch_sub(1, Ordering::SeqCst);
    }
}

/// What a connection is to the store.
#[derive(Default)]
struct Connection {
    /// The number its first preload gave it; it has the store while that is the number of [`Shared::turn`].
    number: Option<u64>,
    /// Whether it was sent the start-up snapshot. A later preload carries the snapshot only when it was read anew.
    has_snapshot: bool,
    /// An answer of this connection could not be given as it was: the connection ends after the refusal.
    broken: bool,
}

fn accept_loop(listener: &Listener, shared: &Arc<Shared>, stop: &AtomicBool) {
    while !stop.load(Ordering::SeqCst) {
        match listener.accept_timeout(Duration::from_millis(25)) {
            Ok(Some(accepted)) => {
                // Beyond the bound a connection is closed at once: dropped here.
                let Some(place) = Place::take(shared) else {
                    continue;
                };
                let spawned = std::thread::Builder::new()
                    .name("core-bridge-conn".into())
                    .spawn(move || serve(accepted, &place));
                if spawned.is_err() {
                    crate::server::log(
                        "warn",
                        "the bridge could not serve a connection",
                        json!({}),
                    );
                }
            }
            Ok(None) => {}
            Err(_) => std::thread::sleep(Duration::from_millis(50)),
        }
    }
}

fn send(stream: &mut BufReader<Accepted>, frame: &Value) -> io::Result<()> {
    let out = stream.get_mut();
    out.write_all(&frame::encode(frame))?;
    out.flush()
}

/// Sends an answer, or a refusal in its place when the answer is longer than a line may be.
///
/// Only an answer with the start-up snapshot can be: every value of the store in one frame ([`frame::MAX_LINE`], 4 MiB;
/// a value is at most 64 KiB). The legacy core's reader would end the connection on such a line and learn nothing. It
/// gets the store's `storage` instead, asks for the effects, gets it again (the snapshot is owed to the connection
/// until it was sent) and treats its store as gone: every lease it holds is void, which is what a snapshot it cannot
/// have means, and which also covers the effects that were in the answer it did not get. The line of the front door
/// says why.
fn send_within_a_line(
    stream: &mut BufReader<Accepted>,
    connection: &mut Connection,
    id: &Value,
    method: &str,
    answer: &Value,
) -> io::Result<()> {
    let mut bytes = frame::encode(answer);
    if bytes.len() > frame::MAX_LINE + 1 {
        connection.has_snapshot = false;
        crate::server::log(
            "error",
            "a bridge answer exceeds a frame: the legacy core cannot be given the secret store",
            json!({ "method": method, "bytes": bytes.len() - 1, "limit": frame::MAX_LINE }),
        );
        let refused = RpcErr::new(
            "E_STORAGE",
            "the secret store's answer exceeds a bridge frame",
            Some("storage"),
        );
        bytes = frame::encode(&refused.frame(id));
    }
    let out = stream.get_mut();
    out.write_all(&bytes)?;
    out.flush()
}

fn result_frame(id: &Value, result: &Value) -> Value {
    json!({ "jsonrpc": "2.0", "id": id, "result": result })
}

fn bridge_principal() -> RpcErr {
    RpcErr::new(
        "E_DENIED",
        "this connection is the legacy core's bridge: bridge.* only",
        Some("bridge-principal"),
    )
}

/// One connection: the handshake, then one request after the other. The store is behind one lock, so requests of one
/// connection are answered in the order they came; the legacy core does not depend on more.
fn serve(accepted: Accepted, place: &Place) {
    let shared = place.0.as_ref();
    let context = &shared.context;
    // Until the handshake a peer is anyone who can reach the socket: it gets a deadline, and one request.
    let _ = accepted.set_read_timeout(Some(AUTH_WAIT));
    let mut stream = BufReader::with_capacity(64 * 1024, accepted);
    let mut authed = false;
    let mut connection = Connection::default();
    loop {
        let bytes = match frame::read_line(&mut stream) {
            Ok(Line::Data(bytes)) => bytes,
            _ => return,
        };
        let Ok(msg) = serde_json::from_slice::<Value>(&bytes) else {
            let _ = send(&mut stream, &frame::parse_error().frame(&Value::Null));
            return;
        };
        let id = msg.get("id").cloned().unwrap_or(Value::Null);
        let method = msg.get("method").and_then(Value::as_str);
        let params = msg.get("params").cloned().unwrap_or_else(|| json!({}));
        if !authed {
            // The first line is the handshake or the connection ends: a notification, an answer and another method
            // are no way to stay connected without the credential.
            let token = params.get("token").and_then(Value::as_str).unwrap_or("");
            if method != Some("core.auth") || id.is_null() || !context.link_token.matches(token) {
                if !id.is_null() {
                    let refused = RpcErr::new("E_UNAUTHORIZED", "bad token", Some("bad-token"));
                    let _ = send(&mut stream, &refused.frame(&id));
                }
                return;
            }
            authed = true;
            let _ = stream.get_ref().set_read_timeout(None);
            let hello = json!({ "rpc": plur1bus_rpc::RPC_VERSION, "instanceId": context.instance, "pid": context.pid,
                "capabilities": plur1bus_rpc::capabilities("bridge", &[]) });
            if send(&mut stream, &result_frame(&id, &hello)).is_err() {
                return;
            }
            continue;
        }
        let Some(method) = method else {
            continue;
        };
        if id.is_null() {
            // A notification: the bridge has methods only.
            continue;
        }
        let answer = match answer(shared, &mut connection, method, params) {
            Ok(result) => result_frame(&id, &result),
            Err(refused) => refused.frame(&id),
        };
        if send_within_a_line(&mut stream, &mut connection, &id, method, &answer).is_err()
            || connection.broken
        {
            return;
        }
    }
}

fn invalid_params() -> RpcErr {
    // Without the findings: one of them can quote the value it is about.
    RpcErr::new("E_INVALID_PARAMS", "invalid params", None)
}

/// `toRpcError` of `secrets/rpc.ts`: the store's code as the reason, its fixed text as the message.
pub fn store_error(e: &SecretError) -> RpcErr {
    let code = match e.code {
        SecretErrorCode::Denied => "E_DENIED",
        SecretErrorCode::NotFound => "E_NOT_FOUND",
        SecretErrorCode::InvalidName
        | SecretErrorCode::InvalidValue
        | SecretErrorCode::InvalidDescription
        | SecretErrorCode::InvalidTtl
        | SecretErrorCode::LeaseInvalid => "E_INVALID_PARAMS",
        SecretErrorCode::NoBackend | SecretErrorCode::BackendUnavailable => "E_NOT_AVAILABLE",
        SecretErrorCode::Corrupt | SecretErrorCode::Storage | SecretErrorCode::AuditUnavailable => {
            "E_STORAGE"
        }
    };
    RpcErr::new(code, e.message.clone(), Some(e.code.as_str()))
}

/// The principal of a `bridge.secret.*` call (`BridgeSecretPrincipal`, already checked against the schema).
pub fn principal_of(principal: &Value) -> Option<SecretPrincipal> {
    let text = |key: &str| {
        principal
            .get(key)
            .and_then(Value::as_str)
            .map(str::to_owned)
    };
    match principal.get("kind").and_then(Value::as_str)? {
        "core" => Some(SecretPrincipal::Core),
        "agent" => Some(SecretPrincipal::Agent {
            agent_id: text("agentId"),
        }),
        "owner" => {
            let surface = match principal.get("surface") {
                None => None,
                Some(level) => Some(match level.as_u64()? {
                    0 => SurfaceTrustLevel::T0,
                    1 => SurfaceTrustLevel::T1,
                    2 => SurfaceTrustLevel::T2,
                    3 => SurfaceTrustLevel::T3,
                    _ => return None,
                }),
            };
            Some(SecretPrincipal::Owner {
                id: text("id"),
                surface,
            })
        }
        _ => None,
    }
}

/// What the legacy core has not been told yet, taken from the store (`BridgeSecretEffects`). With `snapshot` the
/// start-up snapshot is in it whether or not it was read anew.
fn effects_of(store: &SecretStore, snapshot: bool) -> Value {
    let Effects {
        all,
        names,
        preloaded,
    } = store.drain_effects();
    let mut effects = Map::new();
    effects.insert("startup".into(), store.startup_status().to_json());
    effects.insert("revoked".into(), json!({ "all": all, "names": names }));
    let preloaded = if snapshot {
        Some(store.startup_values())
    } else {
        preloaded
    };
    if let Some(values) = preloaded {
        effects.insert("preloaded".into(), json!(values));
    }
    Value::Object(effects)
}

fn superseded() -> RpcErr {
    RpcErr::new(
        "E_STORAGE",
        "the secret store is not open on this connection: preload first",
        Some("storage"),
    )
}

fn answer(
    shared: &Shared,
    connection: &mut Connection,
    method: &str,
    params: Value,
) -> Result<Value, RpcErr> {
    let (context, validators) = (&shared.context, &shared.validators);
    if method == "bridge.hello" {
        return Ok(
            json!({ "rpc": plur1bus_rpc::RPC_VERSION, "instanceId": context.instance, "pid": context.pid }),
        );
    }
    let Some(operation) = method.strip_prefix("bridge.secret.") else {
        return Err(bridge_principal());
    };
    let params = validators
        .check_params(method, params)
        .map_err(|e| match e {
            DispatchError::UnknownMethod => RpcErr::new(
                "E_INTERNAL",
                format!("method not found: {method}"),
                Some("method-not-found"),
            )
            .jsonrpc(-32601),
            _ => invalid_params(),
        })?;
    let store = context.store.as_ref();
    let text = |key: &str| params.get(key).and_then(Value::as_str).unwrap_or("");
    let principal = || {
        params
            .get("principal")
            .and_then(principal_of)
            .ok_or_else(invalid_params)
    };
    let failed = |e: SecretError| store_error(&e);
    let mut result = Map::new();
    let mut snapshot = false;
    // One turn: whether this connection has the store, the operation, and the taking of its effects.
    let mut turn = shared.turn.lock().unwrap_or_else(PoisonError::into_inner);
    if operation == "preload" && text("service") != context.service {
        // The legacy core derived another keyring service from its home than the front door did: the two would look
        // at different entries. Nothing is read, and the connection is closed to the store (again, if it was open).
        connection.number = None;
        connection.has_snapshot = false;
        return Err(RpcErr::new(
            "E_STORAGE",
            "the legacy core and the front door do not name the same secret store",
            Some("storage"),
        ));
    }
    match (operation, connection.number) {
        ("preload", None) => {
            // This connection has the store now; whichever had it does not.
            *turn += 1;
            connection.number = Some(*turn);
        }
        (_, Some(number)) if number == *turn => {}
        // Not opened, or replaced by a later connection: nothing reaches the store, and no effect is taken.
        _ => return Err(superseded()),
    }
    match operation {
        "preload" => {
            store.preload_redaction();
            // The whole snapshot once per connection; after that only when the store read it anew, so that asking
            // for the effects after a refusal does not carry every value again (security review S4).
            snapshot = !connection.has_snapshot;
            connection.has_snapshot = true;
        }
        "status" => {
            let status = store.status(&principal()?).map_err(failed)?;
            result.insert("status".into(), status.to_json());
        }
        "list" => {
            let secrets = store.list(&principal()?).map_err(failed)?;
            result.insert(
                "secrets".into(),
                Value::Array(secrets.iter().map(|meta| meta.to_json()).collect()),
            );
        }
        "set" => {
            let description = params.get("description").and_then(Value::as_str);
            let meta = store
                .set(&principal()?, text("name"), text("value"), description)
                .map_err(failed)?;
            result.insert("secret".into(), meta.to_json());
        }
        "describe" => {
            let meta = store
                .describe(&principal()?, text("name"), text("description"))
                .map_err(failed)?;
            result.insert("secret".into(), meta.to_json());
        }
        "meta" => {
            let meta = store.meta(&principal()?, text("name")).map_err(failed)?;
            result.insert("secret".into(), meta.to_json());
        }
        "reveal" => {
            let (meta, value) = store.reveal(&principal()?, text("name")).map_err(failed)?;
            result.insert("secret".into(), meta.to_json());
            result.insert("value".into(), Value::from(value));
        }
        "delete" => {
            store.delete(&principal()?, text("name")).map_err(failed)?;
            result.insert("removed".into(), Value::Bool(true));
        }
        "lease" => {
            let options = IssueOptions {
                purpose: text("purpose"),
                profile_id: text("profileId"),
                ttl_ms: params.get("ttlMs").and_then(Value::as_f64),
            };
            let lease = store
                .lease_out(&principal()?, text("name"), options)
                .map_err(failed)?;
            result.insert(
                "lease".into(),
                json!({ "leaseId": lease.lease_id, "name": lease.name, "value": lease.value,
                    "expiresAt": lease.expires_at, "purpose": lease.purpose, "profileId": lease.profile_id }),
            );
        }
        _ => return Err(bridge_principal()),
    }
    result.insert("effects".into(), effects_of(store, snapshot));
    drop(turn);
    let result = Value::Object(result);
    if validators.check_result(method, &result).is_err() {
        // The effects were in that answer. The connection ends after the refusal, and the legacy core, which loses
        // its bridge, voids every lease it holds: the one way to be sure none of them outlives what it was not told.
        connection.broken = true;
        crate::server::log(
            "error",
            "a bridge answer violates its schema",
            json!({ "method": method }),
        );
        return Err(RpcErr::new(
            "E_INTERNAL",
            "result violates schema",
            Some("result-schema"),
        ));
    }
    Ok(result)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::identity::codes::RandomSource;
    use crate::logs::redact::SecretSet;
    use crate::run_files::unit_address;
    use crate::secrets::memory_backend::MemoryBackend;
    use crate::secrets::store::{AuditEvent, AuditSink, SecretStoreOptions, StartupOptions};
    use plur1bus_rpc::transport::{self, Stream};
    use std::io::BufRead;
    use std::sync::Mutex;

    const TOKEN: &str = "the link credential of this test, in plain words";
    const VALUE: &str = "a value in plain words for the bridge";

    struct Counter(u8);
    impl RandomSource for Counter {
        fn random_int(&mut self, _max: u32) -> u32 {
            0
        }
        fn fill_bytes(&mut self, out: &mut [u8]) {
            self.0 += 1;
            out.fill(self.0);
        }
    }

    type Recorded = Arc<Mutex<Vec<(String, Option<String>, SecretPrincipal)>>>;
    struct Records(Recorded);
    impl AuditSink for Records {
        fn record(&mut self, event: &AuditEvent) -> Result<(), SecretError> {
            self.0.lock().unwrap().push((
                event.action.as_str().to_owned(),
                event.target.clone(),
                event.principal.clone(),
            ));
            Ok(())
        }
    }

    struct Fixture {
        _home: tempfile::TempDir,
        bridge: Option<Bridge>,
        address: String,
        store: Arc<SecretStore>,
        recorded: Recorded,
    }

    impl Drop for Fixture {
        fn drop(&mut self) {
            if let Some(bridge) = self.bridge.take() {
                bridge.stop();
            }
        }
    }

    fn fixture() -> Fixture {
        let home = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(home.path().join("run")).unwrap();
        let recorded: Recorded = Arc::default();
        let store = Arc::new(SecretStore::new(SecretStoreOptions {
            keyring: Box::new(MemoryBackend::new(true)),
            file: Box::new(MemoryBackend::new(false)),
            file_fallback: Box::new(|| false),
            audit: Box::new(Records(recorded.clone())),
            clock: Arc::new(|| 1_767_323_045_678),
            monotonic: Box::new(|| 0.0),
            random: Box::new(Counter(0)),
            logger: None,
            redaction: Arc::new(SecretSet::new()),
            startup: StartupOptions::default(),
        }));
        let address = unit_address(home.path(), BRIDGE_ROLE, cfg!(windows));
        let bridge = Bridge::start(
            &address,
            BridgeContext {
                link_token: Secret::new(TOKEN.to_owned()),
                instance: "instance-1".to_owned(),
                pid: 4242,
                store: store.clone(),
                service: "plur1bus:test".to_owned(),
            },
        )
        .unwrap();
        Fixture {
            _home: home,
            bridge: Some(bridge),
            address,
            store,
            recorded,
        }
    }

    struct Peer {
        reader: BufReader<Box<dyn Stream>>,
        next: u64,
    }

    impl Peer {
        fn connect(address: &str) -> Peer {
            let stream = transport::connect(address, Duration::from_secs(5)).unwrap();
            stream
                .set_read_timeout(Some(Duration::from_secs(20)))
                .unwrap();
            Peer {
                reader: BufReader::new(stream),
                next: 0,
            }
        }

        /// The answer to one request, or `None` when the bridge closed the connection instead.
        #[allow(clippy::needless_pass_by_value)]
        fn ask(&mut self, method: &str, params: Value) -> Option<Value> {
            self.next += 1;
            let request =
                json!({ "jsonrpc": "2.0", "id": self.next, "method": method, "params": params });
            self.reader
                .get_mut()
                .write_all(&frame::encode(&request))
                .ok()?;
            let mut line = String::new();
            match self.reader.read_line(&mut line) {
                Ok(n) if n > 0 => {
                    let answer: Value = serde_json::from_str(&line).unwrap();
                    assert_eq!(answer["id"], json!(self.next), "{answer}");
                    Some(answer)
                }
                _ => None,
            }
        }

        fn authed(address: &str) -> Peer {
            let mut peer = Peer::connect(address);
            let hello = peer.ask("core.auth", json!({ "token": TOKEN })).unwrap();
            assert_eq!(hello["result"]["pid"], 4242, "{hello}");
            peer
        }

        /// A peer after the handshake and the preload that opens the store on its connection.
        fn opened(address: &str) -> Peer {
            let mut peer = Peer::authed(address);
            let preload = peer
                .ask(
                    "bridge.secret.preload",
                    json!({ "service": "plur1bus:test" }),
                )
                .unwrap();
            assert!(preload["result"]["effects"].is_object(), "{preload}");
            peer
        }

        fn closed(&mut self) -> bool {
            let mut line = String::new();
            matches!(self.reader.read_line(&mut line), Ok(0) | Err(_))
        }
    }

    fn owner() -> Value {
        json!({ "kind": "owner", "id": "user-1", "surface": 1 })
    }

    fn error_of(answer: &Value) -> (String, String) {
        (
            answer["error"]["data"]["error"]
                .as_str()
                .unwrap_or_default()
                .to_owned(),
            answer["error"]["data"]["reason"]
                .as_str()
                .unwrap_or_default()
                .to_owned(),
        )
    }

    #[test]
    fn the_bridge_is_for_the_holder_of_the_link_credential() {
        let f = fixture();
        // Another token, no token, and a first request that is no handshake: answered once, then closed.
        for (method, params) in [
            ("core.auth", json!({ "token": "another token" })),
            ("core.auth", json!({})),
            ("bridge.hello", json!({})),
            (
                "bridge.secret.list",
                json!({ "principal": { "kind": "core" } }),
            ),
        ] {
            let mut peer = Peer::connect(&f.address);
            let refused = peer.ask(method, params).unwrap();
            assert_eq!(
                error_of(&refused),
                ("E_UNAUTHORIZED".to_owned(), "bad-token".to_owned()),
                "{method}"
            );
            assert!(peer.closed(), "{method}");
        }
        assert!(
            f.recorded.lock().unwrap().is_empty(),
            "nothing reached the store"
        );
        // The link credential: the front door's identity and what the bridge role serves.
        let mut peer = Peer::connect(&f.address);
        let hello = peer.ask("core.auth", json!({ "token": TOKEN })).unwrap();
        assert_eq!(hello["result"]["instanceId"], "instance-1");
        assert_eq!(hello["result"]["rpc"], plur1bus_rpc::RPC_VERSION);
        let methods = &hello["result"]["capabilities"]["methods"];
        assert!(methods["bridge.secret.lease"].is_object() && methods["bridge.hello"].is_object());
        assert_eq!(
            peer.ask("bridge.hello", json!({})).unwrap()["result"]["pid"],
            4242
        );
        // After the handshake: bridge.* and nothing else, whatever the schema knows the method as.
        for method in [
            "secret.list",
            "core.status",
            "legacy.redaction.changes",
            "core.auth",
        ] {
            let refused = peer.ask(method, json!({ "token": TOKEN })).unwrap();
            assert_eq!(
                error_of(&refused),
                ("E_DENIED".to_owned(), "bridge-principal".to_owned()),
                "{method}"
            );
        }
        let unknown = peer.ask("bridge.secret.dump", json!({})).unwrap();
        assert_eq!(unknown["error"]["code"], -32601, "{unknown}");
        // The connection is still served.
        assert!(peer.ask("bridge.hello", json!({})).unwrap()["result"].is_object());
    }

    #[test]
    fn the_stores_calls_travel_with_their_principal_and_come_back_with_the_effects() {
        let f = fixture();
        let mut peer = Peer::authed(&f.address);
        // The preload names the keyring service; another one is another store, and a connection that has not named
        // the right one has no store: no call reaches it, whoever it says is asking.
        let closed = |peer: &mut Peer| {
            for (method, params) in [
                ("bridge.secret.list", json!({ "principal": owner() })),
                (
                    "bridge.secret.status",
                    json!({ "principal": { "kind": "core" } }),
                ),
                (
                    "bridge.secret.set",
                    json!({ "principal": owner(), "name": "api.key", "value": VALUE }),
                ),
                (
                    "bridge.secret.lease",
                    json!({ "principal": { "kind": "core" }, "name": "api.key", "purpose": "p", "profileId": "q" }),
                ),
            ] {
                let refused = peer.ask(method, params).unwrap();
                assert_eq!(
                    error_of(&refused),
                    ("E_STORAGE".to_owned(), "storage".to_owned()),
                    "{method}"
                );
                assert!(refused["error"]["message"]
                    .as_str()
                    .unwrap()
                    .contains("preload first"));
            }
        };
        closed(&mut peer);
        let other = peer
            .ask(
                "bridge.secret.preload",
                json!({ "service": "plur1bus:other" }),
            )
            .unwrap();
        assert_eq!(
            error_of(&other),
            ("E_STORAGE".to_owned(), "storage".to_owned())
        );
        closed(&mut peer);
        assert!(
            f.recorded.lock().unwrap().is_empty(),
            "nothing reached the store"
        );
        let preload = peer
            .ask(
                "bridge.secret.preload",
                json!({ "service": "plur1bus:test" }),
            )
            .unwrap();
        let effects = &preload["result"]["effects"];
        assert_eq!(
            effects["startup"],
            json!({ "state": "ready", "safeToFlush": true })
        );
        assert_eq!(effects["preloaded"], json!([]));
        assert_eq!(effects["revoked"], json!({ "all": false, "names": [] }));
        // A set: the metadata, and the name whose leases are void.
        let set = peer
            .ask(
                "bridge.secret.set",
                json!({ "principal": owner(), "name": "api.key", "value": VALUE, "description": "what it is for" }),
            )
            .unwrap();
        assert_eq!(set["result"]["secret"]["name"], "api.key", "{set}");
        assert_eq!(set["result"]["secret"]["updatedBy"], "user-1");
        assert_eq!(
            set["result"]["effects"]["revoked"]["names"],
            json!(["api.key"])
        );
        assert!(set["result"]["effects"].get("preloaded").is_none());
        // A lease is handed out: the front door does not count it, and a read tells nothing new.
        let lease = peer
            .ask(
                "bridge.secret.lease",
                json!({ "principal": { "kind": "core" }, "name": "api.key", "purpose": "web-search", "profileId": "web-search", "ttlMs": 5000 }),
            )
            .unwrap();
        let handed = &lease["result"]["lease"];
        assert_eq!(handed["value"], VALUE, "{lease}");
        assert_eq!(handed["expiresAt"], json!(1_767_323_045_678_i64 + 5000));
        assert!(handed["leaseId"].as_str().unwrap().starts_with("lse_"));
        assert_eq!(lease["result"]["effects"]["revoked"]["names"], json!([]));
        let status = peer
            .ask(
                "bridge.secret.status",
                json!({ "principal": { "kind": "core" } }),
            )
            .unwrap();
        assert_eq!(status["result"]["status"]["activeLeases"], 0, "{status}");
        assert!(f
            .store
            .active_leases(&SecretPrincipal::Core)
            .unwrap()
            .is_empty());
        // The other calls of the store.
        let reveal = peer
            .ask(
                "bridge.secret.reveal",
                json!({ "principal": owner(), "name": "api.key" }),
            )
            .unwrap();
        assert_eq!(reveal["result"]["value"], VALUE);
        let meta = peer
            .ask(
                "bridge.secret.meta",
                json!({ "principal": { "kind": "owner" }, "name": "api.key" }),
            )
            .unwrap();
        assert_eq!(meta["result"]["secret"]["description"], "what it is for");
        let described = peer
            .ask(
                "bridge.secret.describe",
                json!({ "principal": owner(), "name": "api.key", "description": "another line" }),
            )
            .unwrap();
        assert_eq!(described["result"]["secret"]["description"], "another line");
        let list = peer
            .ask("bridge.secret.list", json!({ "principal": owner() }))
            .unwrap();
        assert_eq!(list["result"]["secrets"].as_array().unwrap().len(), 1);
        let deleted = peer
            .ask(
                "bridge.secret.delete",
                json!({ "principal": owner(), "name": "api.key" }),
            )
            .unwrap();
        assert_eq!(deleted["result"]["removed"], true);
        assert_eq!(
            deleted["result"]["effects"]["revoked"]["names"],
            json!(["api.key"])
        );
        // The records are the store's, with the principal each call named.
        let recorded = f.recorded.lock().unwrap();
        let actions: Vec<&str> = recorded.iter().map(|(a, _, _)| a.as_str()).collect();
        assert_eq!(
            actions,
            [
                "secret.set",
                "secret.lease",
                "secret.reveal",
                "secret.get",
                "secret.describe",
                "secret.list",
                "secret.delete"
            ]
        );
        assert!(
            matches!(&recorded[0].2, SecretPrincipal::Owner { id: Some(id), surface: Some(SurfaceTrustLevel::T1) } if id == "user-1")
        );
        assert_eq!(recorded[1].2, SecretPrincipal::Core);
        assert!(matches!(
            &recorded[3].2,
            SecretPrincipal::Owner {
                id: None,
                surface: None
            }
        ));
    }

    #[test]
    fn a_refusal_of_the_store_keeps_its_code_and_text_and_the_effects_wait() {
        let f = fixture();
        let mut peer = Peer::opened(&f.address);
        peer.ask(
            "bridge.secret.set",
            json!({ "principal": owner(), "name": "api.key", "value": VALUE }),
        )
        .unwrap();
        // The store's gate, its rules and its lookups answer as they answer a caller in the legacy core.
        let agent = json!({ "kind": "agent", "agentId": "scout" });
        for (method, params, code, reason) in [
            (
                "bridge.secret.reveal",
                json!({ "principal": agent, "name": "api.key" }),
                "E_DENIED",
                "denied",
            ),
            (
                "bridge.secret.set",
                json!({ "principal": { "kind": "core" }, "name": "x", "value": VALUE }),
                "E_DENIED",
                "denied",
            ),
            (
                "bridge.secret.meta",
                json!({ "principal": owner(), "name": "never.there" }),
                "E_NOT_FOUND",
                "not-found",
            ),
            (
                "bridge.secret.set",
                json!({ "principal": owner(), "name": "not a name", "value": VALUE }),
                "E_INVALID_PARAMS",
                "invalid-name",
            ),
            (
                "bridge.secret.set",
                json!({ "principal": owner(), "name": "x", "value": "" }),
                "E_INVALID_PARAMS",
                "invalid-value",
            ),
            (
                "bridge.secret.lease",
                json!({ "principal": { "kind": "core" }, "name": "api.key", "purpose": "web-search", "profileId": "web-search", "ttlMs": 0.5 }),
                "E_INVALID_PARAMS",
                "invalid-ttl",
            ),
            (
                "bridge.secret.delete",
                json!({ "principal": owner(), "name": "never.there" }),
                "E_NOT_FOUND",
                "not-found",
            ),
            // A surface below the floor is refused where the store asks for one.
            (
                "bridge.secret.reveal",
                json!({ "principal": { "kind": "owner", "id": "user-1", "surface": 0 }, "name": "api.key" }),
                "E_DENIED",
                "denied",
            ),
        ] {
            let refused = peer.ask(method, params).unwrap();
            assert_eq!(
                error_of(&refused),
                (code.to_owned(), reason.to_owned()),
                "{method} {refused}"
            );
            assert!(refused["error"]["data"].get("effects").is_none());
            assert!(!refused.to_string().contains(VALUE), "{method}");
        }
        // The text is the store's own, the one a caller inside the legacy core gets.
        let direct = f
            .store
            .meta(
                &SecretPrincipal::Owner {
                    id: None,
                    surface: None,
                },
                "never.there",
            )
            .unwrap_err();
        let over_the_bridge = peer
            .ask(
                "bridge.secret.meta",
                json!({ "principal": owner(), "name": "never.there" }),
            )
            .unwrap();
        assert_eq!(over_the_bridge["error"]["message"], json!(direct.message));
        // What the failed calls did is told with the next answer.
        let told = peer
            .ask(
                "bridge.secret.preload",
                json!({ "service": "plur1bus:test" }),
            )
            .unwrap();
        let names = told["result"]["effects"]["revoked"]["names"]
            .as_array()
            .unwrap()
            .clone();
        assert!(names.contains(&json!("never.there")), "{told}");
        // The snapshot went out when the connection opened and was not read anew: asking for the effects does not
        // carry every value again.
        assert!(
            told["result"]["effects"].get("preloaded").is_none(),
            "{told}"
        );
        // A store that goes away voids everything, and says so.
        f.store.backend_unavailable();
        let gone = peer
            .ask("bridge.secret.list", json!({ "principal": owner() }))
            .unwrap();
        assert_eq!(error_of(&gone).0, "E_NOT_AVAILABLE", "{gone}");
        let told = peer
            .ask(
                "bridge.secret.preload",
                json!({ "service": "plur1bus:test" }),
            )
            .unwrap();
        assert_eq!(told["result"]["effects"]["revoked"]["all"], true, "{told}");
    }

    #[test]
    fn only_the_connection_that_opened_last_has_the_store_and_its_effects() {
        let f = fixture();
        let user = SecretPrincipal::Owner {
            id: Some("user-1".to_owned()),
            surface: Some(SurfaceTrustLevel::T1),
        };
        f.store.set(&user, "api.key", VALUE, None).unwrap();
        let preload = json!({ "service": "plur1bus:test" });
        // The legacy core's connection, and the one it opened after it gave the first up.
        let mut given_up = Peer::opened(&f.address);
        let mut current = Peer::opened(&f.address);
        // Something the legacy core has not been told yet: a name whose leases are void.
        f.store.delete(&user, "api.key").unwrap();
        // What was still queued on the connection it gave up reaches nothing: not the store, not the effects. A
        // preload there does not take the store back either.
        let recorded = f.recorded.lock().unwrap().len();
        for (method, params) in [
            ("bridge.secret.list", json!({ "principal": owner() })),
            (
                "bridge.secret.set",
                json!({ "principal": owner(), "name": "other.key", "value": VALUE }),
            ),
            ("bridge.secret.preload", preload.clone()),
            (
                "bridge.secret.status",
                json!({ "principal": { "kind": "core" } }),
            ),
        ] {
            let refused = given_up.ask(method, params).unwrap();
            assert_eq!(
                error_of(&refused),
                ("E_STORAGE".to_owned(), "storage".to_owned()),
                "{method}"
            );
        }
        assert_eq!(f.recorded.lock().unwrap().len(), recorded);
        // The effects are still there for the connection that has the store.
        let listed = current
            .ask("bridge.secret.list", json!({ "principal": owner() }))
            .unwrap();
        assert_eq!(
            listed["result"]["effects"]["revoked"]["names"],
            json!(["api.key"]),
            "{listed}"
        );
        assert_eq!(listed["result"]["secrets"], json!([]));
        // A third connection takes the store from the second in the same way.
        let mut third = Peer::opened(&f.address);
        let refused = current
            .ask("bridge.secret.list", json!({ "principal": owner() }))
            .unwrap();
        assert_eq!(error_of(&refused).1, "storage");
        assert!(third
            .ask("bridge.secret.list", json!({ "principal": owner() }))
            .unwrap()["result"]
            .is_object());
        // A preload that names another store closes the connection to the store, and it can open it again.
        let other = third
            .ask(
                "bridge.secret.preload",
                json!({ "service": "plur1bus:other" }),
            )
            .unwrap();
        assert_eq!(error_of(&other).1, "storage");
        let refused = third
            .ask("bridge.secret.list", json!({ "principal": owner() }))
            .unwrap();
        assert!(refused["error"]["message"]
            .as_str()
            .unwrap()
            .contains("preload first"));
        let again = third.ask("bridge.secret.preload", preload).unwrap();
        // It is a connection that opens the store: the snapshot is owed to it again.
        assert!(
            again["result"]["effects"]["preloaded"].is_array(),
            "{again}"
        );
    }

    #[test]
    fn before_the_handshake_a_connection_has_one_request_and_little_time() {
        let f = fixture();
        // A notification, an answer, a line without a method, another method: none keeps a connection open without
        // the credential, and what has no id gets no answer either.
        for line in [
            json!({ "jsonrpc": "2.0", "method": "core.auth", "params": { "token": TOKEN } }),
            json!({ "jsonrpc": "2.0", "method": "anything" }),
            json!({ "jsonrpc": "2.0", "result": {} }),
        ] {
            let mut peer = Peer::connect(&f.address);
            peer.reader
                .get_mut()
                .write_all(&frame::encode(&line))
                .unwrap();
            assert!(peer.closed(), "{line}");
        }
        let mut peer = Peer::connect(&f.address);
        peer.reader
            .get_mut()
            .write_all(&frame::encode(
                &json!({ "jsonrpc": "2.0", "id": 1, "params": { "token": TOKEN } }),
            ))
            .unwrap();
        let mut answer = String::new();
        peer.reader.read_line(&mut answer).unwrap();
        assert!(answer.contains("bad-token"), "{answer}");
        assert!(peer.closed());
        // A connection that says nothing is ended when its time is up.
        let started = std::time::Instant::now();
        let mut silent = Peer::connect(&f.address);
        assert!(silent.closed());
        let waited = started.elapsed();
        assert!(
            waited >= AUTH_WAIT - Duration::from_millis(500)
                && waited < AUTH_WAIT + Duration::from_secs(5),
            "{waited:?}"
        );
        // After the handshake there is no deadline, and a notification is passed over as before.
        let mut peer = Peer::opened(&f.address);
        peer.reader
            .get_mut()
            .write_all(&frame::encode(
                &json!({ "jsonrpc": "2.0", "method": "anything" }),
            ))
            .unwrap();
        assert!(peer
            .ask("bridge.secret.list", json!({ "principal": owner() }))
            .unwrap()["result"]
            .is_object());
    }

    #[test]
    fn the_bridge_serves_a_bounded_number_of_connections() {
        let f = fixture();
        let mut held: Vec<Peer> = (0..MAX_CONNECTIONS)
            .map(|_| Peer::authed(&f.address))
            .collect();
        // One more is closed without a word, whatever it sends.
        let mut over = Peer::connect(&f.address);
        assert!(over.ask("core.auth", json!({ "token": TOKEN })).is_none());
        // A place that is given back is there for the next connection.
        held.pop();
        let deadline = std::time::Instant::now() + Duration::from_secs(10);
        loop {
            let mut next = Peer::connect(&f.address);
            if let Some(hello) = next.ask("core.auth", json!({ "token": TOKEN })) {
                assert_eq!(hello["result"]["pid"], 4242);
                break;
            }
            assert!(
                std::time::Instant::now() < deadline,
                "no place was given back"
            );
            std::thread::sleep(Duration::from_millis(20));
        }
    }

    #[test]
    fn a_snapshot_that_exceeds_a_frame_is_refused_and_the_connection_stays() {
        let f = fixture();
        let user = SecretPrincipal::Owner {
            id: Some("user-1".to_owned()),
            surface: Some(SurfaceTrustLevel::T1),
        };
        // 70 values of the largest size a value may have: more than one line holds.
        for n in 0..70 {
            let value = format!(
                "{n:02}{}",
                "v".repeat(crate::secrets::types::MAX_VALUE_BYTES - 2)
            );
            f.store
                .set(&user, &format!("big.{n:02}"), &value, None)
                .unwrap();
        }
        let mut peer = Peer::authed(&f.address);
        for _ in 0..2 {
            let refused = peer
                .ask(
                    "bridge.secret.preload",
                    json!({ "service": "plur1bus:test" }),
                )
                .unwrap();
            assert_eq!(
                error_of(&refused),
                ("E_STORAGE".to_owned(), "storage".to_owned()),
                "{}",
                &refused.to_string()[..200.min(refused.to_string().len())]
            );
            assert!(!refused.to_string().contains("vvvv"));
        }
        // An answer without the snapshot still fits, on the same connection.
        let listed = peer
            .ask("bridge.secret.list", json!({ "principal": owner() }))
            .unwrap();
        assert_eq!(listed["result"]["secrets"].as_array().unwrap().len(), 70);
    }

    #[test]
    fn params_the_schema_does_not_know_are_refused_without_a_word_about_them() {
        let f = fixture();
        let mut peer = Peer::opened(&f.address);
        for (method, params) in [
            (
                "bridge.secret.set",
                json!({ "name": "api.key", "value": VALUE }),
            ),
            (
                "bridge.secret.set",
                json!({ "principal": owner(), "name": "api.key", "value": VALUE, "note": VALUE }),
            ),
            (
                "bridge.secret.set",
                json!({ "principal": { "kind": "admin" }, "name": "api.key", "value": VALUE }),
            ),
            (
                "bridge.secret.set",
                json!({ "principal": { "kind": "owner", "surface": 4 }, "name": "api.key", "value": VALUE }),
            ),
            (
                "bridge.secret.set",
                json!({ "principal": owner(), "name": "api.key", "value": 7 }),
            ),
            ("bridge.secret.preload", json!({})),
        ] {
            let refused = peer.ask(method, params).unwrap();
            assert_eq!(error_of(&refused).0, "E_INVALID_PARAMS", "{refused}");
            assert!(
                refused["error"]["data"].get("detail").is_none(),
                "{refused}"
            );
            assert!(!refused.to_string().contains(VALUE));
        }
        assert!(
            f.recorded.lock().unwrap().is_empty(),
            "nothing reached the store"
        );
        // A line that is no JSON ends the connection.
        peer.reader.get_mut().write_all(b"{not json\n").unwrap();
        let mut line = String::new();
        peer.reader.read_line(&mut line).unwrap();
        assert!(line.contains("parse-error"), "{line}");
        assert!(peer.closed());
    }

    #[test]
    fn a_principal_is_one_of_the_stores_three() {
        assert_eq!(
            principal_of(&json!({ "kind": "core" })),
            Some(SecretPrincipal::Core)
        );
        assert_eq!(
            principal_of(&json!({ "kind": "agent" })),
            Some(SecretPrincipal::Agent { agent_id: None })
        );
        assert_eq!(
            principal_of(&json!({ "kind": "owner", "surface": 3 })),
            Some(SecretPrincipal::Owner {
                id: None,
                surface: Some(SurfaceTrustLevel::T3)
            })
        );
        // An owner's id is no agent's, and the other way round.
        assert_eq!(
            principal_of(&json!({ "kind": "agent", "id": "user-1", "agentId": "scout" })),
            Some(SecretPrincipal::Agent {
                agent_id: Some("scout".to_owned())
            })
        );
        for odd in [
            json!({}),
            json!({ "kind": "admin" }),
            json!({ "kind": "owner", "surface": 4 }),
            json!({ "kind": "owner", "surface": "1" }),
            json!("core"),
        ] {
            assert_eq!(principal_of(&odd), None, "{odd}");
        }
    }
}
