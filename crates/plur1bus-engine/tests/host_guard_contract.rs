//! Reverse RPC must authenticate the independent engine principal before host access.
#![cfg(any(unix, windows))]
// Native OS fixtures intentionally panic on a failed setup/cleanup so a test cannot pass vacuously.
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

#[allow(
    dead_code,
    reason = "This integration test uses only the shared engine process fixture."
)]
mod rpc_process_support;

use plur1bus_engine::contract::{
    AddressRules, AgentId, Cancel, Decision, EgressGate, HostError, HostServices, LlmParams,
    LlmPort, Scheme, SecretPort, Target,
};
use plur1bus_engine::rpc::host_client::RpcHost;
use plur1bus_rpc::server_transport::Listener;
use serde_json::{json, Value};
use std::io::{BufRead, BufReader, Write};
#[cfg(unix)]
use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::thread::{self, JoinHandle};
use std::time::{Duration, Instant};

const ENGINE_TOKEN: &str = "eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee";
const CORE_TOKEN: &str = "cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc";
const PRIVATE: &str = "test-only-private-secret-body";

type Handler = dyn Fn(&str, &Value) -> Result<Value, &'static str> + Send + Sync;
type Writer = Arc<Mutex<Box<dyn Write + Send>>>;
type Closer = Arc<dyn Fn() + Send + Sync>;

#[derive(Clone, Copy)]
enum Bootstrap {
    Normal,
    Hold(&'static str),
    TrickleAuth,
}

/// The shared native listener gives this fixture Unix UID and Windows PID/DACL behavior.
struct FakeCore {
    thread: Option<JoinHandle<()>>,
    stop: Arc<AtomicBool>,
    requests: Arc<Mutex<Vec<Value>>>,
    writer: Arc<Mutex<Option<Writer>>>,
    closers: Arc<Mutex<Vec<Closer>>>,
    home: PathBuf,
    accepted: Arc<AtomicUsize>,
}

impl FakeCore {
    fn start(
        home: &Path,
        token: &str,
        handler: impl Fn(&str, &Value) -> Result<Value, &'static str> + Send + Sync + 'static,
    ) -> Self {
        Self::start_bootstrap(home, token, Bootstrap::Normal, handler)
    }

    fn start_bootstrap(
        home: &Path,
        token: &str,
        bootstrap: Bootstrap,
        handler: impl Fn(&str, &Value) -> Result<Value, &'static str> + Send + Sync + 'static,
    ) -> Self {
        let run = home.join("run");
        plur1bus_engine::store::paths::secure_dir(&run).unwrap();
        let address = plur1bus_engine::rpc::layout::unit_address(home, "core");
        #[cfg(unix)]
        let _ = std::fs::remove_file(&address);
        let listener = Listener::bind(&address).unwrap();
        std::fs::write(run.join("core.token"), token).unwrap();
        std::fs::write(
            run.join("core.pid"),
            format!("{} fake-core\n", std::process::id()),
        )
        .unwrap();
        for file in [run.join("core.token"), run.join("core.pid")] {
            plur1bus_engine::store::paths::secure_file(&file).unwrap();
        }
        let requests = Arc::new(Mutex::new(Vec::new()));
        let recorded = requests.clone();
        let handler: Arc<Handler> = Arc::new(handler);
        let stop = Arc::new(AtomicBool::new(false));
        let stopped = stop.clone();
        let writer: Arc<Mutex<Option<Writer>>> = Arc::new(Mutex::new(None));
        let live_writer = writer.clone();
        let closers: Arc<Mutex<Vec<Closer>>> = Arc::new(Mutex::new(Vec::new()));
        let active_closers = closers.clone();
        let accepted = Arc::new(AtomicUsize::new(0));
        let connections = accepted.clone();
        let thread = thread::spawn(move || {
            while !stopped.load(Ordering::Acquire) {
                let connection = match listener.accept_timeout(Duration::from_millis(25)) {
                    Ok(Some(connection)) => connection,
                    Ok(None) => continue,
                    Err(_) if stopped.load(Ordering::Acquire) => break,
                    Err(_) => {
                        thread::sleep(Duration::from_millis(2));
                        continue;
                    }
                };
                connections.fetch_add(1, Ordering::AcqRel);
                connection.set_read_timeout(None).unwrap();
                let mut reader = BufReader::new(connection.reader);
                let output = Arc::new(Mutex::new(connection.writer));
                {
                    let mut closers = active_closers.lock().unwrap();
                    if stopped.load(Ordering::Acquire) {
                        (connection.closer)();
                        break;
                    }
                    closers.push(connection.closer.clone());
                }
                *live_writer.lock().unwrap() = Some(output.clone());
                let mut authed = false;
                loop {
                    let mut line = String::new();
                    match reader.read_line(&mut line) {
                        Ok(0) | Err(_) => break,
                        Ok(_) => {}
                    }
                    let request: Value = serde_json::from_str(&line).unwrap();
                    recorded.lock().unwrap().push(request.clone());
                    if matches!(bootstrap, Bootstrap::Hold(method) if request["method"] == method) {
                        continue;
                    }
                    if request["method"] == "core.auth"
                        && matches!(bootstrap, Bootstrap::TrickleAuth)
                    {
                        if output
                            .lock()
                            .unwrap()
                            .write_all(b"{\"jsonrpc\":\"2.0\",\"id\":")
                            .is_ok()
                        {
                            while !stopped.load(Ordering::Acquire) {
                                if output.lock().unwrap().write_all(b" ").is_err() {
                                    break;
                                }
                                if output.lock().unwrap().flush().is_err() {
                                    break;
                                }
                                thread::sleep(Duration::from_millis(10));
                            }
                        }
                        break;
                    }
                    let result = if request["method"] == "core.auth" {
                        let presented = request["params"]["token"].as_str();
                        let engine_file = std::fs::read_to_string(run.join("engine.token")).ok();
                        authed = presented.is_some_and(|token| {
                            (token == ENGINE_TOKEN || engine_file.as_deref().is_some_and(|file| token == file.trim()))
                                && request["params"]
                                    == json!({"token":token,"engine":{"clientId":"plur1bus-engine","token":token}})
                        });
                        if authed {
                            Ok(
                                json!({"contract":"1.17.0","rpc":"1.17.0","instanceId":"fake-core","pid":std::process::id()}),
                            )
                        } else {
                            Err("E_UNAUTHORIZED")
                        }
                    } else if !authed {
                        Err("E_DENIED")
                    } else if request["method"] == "events.subscribe" {
                        assert_eq!(request["params"], json!({"names":["egress.changed"]}));
                        Ok(json!({"subscriptionId":"fake-egress"}))
                    } else {
                        handler(request["method"].as_str().unwrap(), &request["params"])
                    };
                    if result
                        .as_ref()
                        .is_ok_and(|value| value == &json!({"fixtureHold":true}))
                    {
                        continue;
                    }
                    let response = match result {
                        Ok(value) => json!({"jsonrpc":"2.0","id":request["id"],"result":value}),
                        Err(code) => {
                            json!({"jsonrpc":"2.0","id":request["id"],"error":{"code":-32000,"message":PRIVATE,"data":{"error":code,"reason":PRIVATE,"detail":PRIVATE}}})
                        }
                    };
                    if writeln!(output.lock().unwrap(), "{response}").is_err() {
                        break;
                    }
                }
                *live_writer.lock().unwrap() = None;
                (connection.closer)();
                if stopped.load(Ordering::Acquire) {
                    break;
                }
            }
        });
        Self {
            thread: Some(thread),
            stop,
            requests,
            writer,
            closers,
            home: home.to_path_buf(),
            accepted,
        }
    }

    fn count(&self, method: &str) -> usize {
        self.requests
            .lock()
            .unwrap()
            .iter()
            .filter(|request| request["method"] == method)
            .count()
    }

    fn notify_policy_change(&self) {
        let writer = self
            .writer
            .lock()
            .unwrap()
            .clone()
            .expect("authenticated connection");
        writeln!(
            writer.lock().unwrap(),
            "{}",
            json!({"jsonrpc":"2.0","method":"egress.changed","params":{}})
        )
        .unwrap();
    }

    fn rotate_token(&self, token: &str) {
        let path = self.home.join("run/core.token");
        std::fs::write(&path, token).unwrap();
        plur1bus_engine::store::paths::secure_file(&path).unwrap();
    }
}

#[test]
fn process_job_requires_a_core_peer_and_a_live_reverse_authority() {
    let _serial = rpc_process_support::process_test();
    let home = rpc_process_support::home();
    let root = home.path().to_owned();
    let allowed = Arc::new(AtomicBool::new(false));
    let admit = allowed.clone();
    let workspace = root.clone();
    let core = FakeCore::start(&root, CORE_TOKEN, move |method, params| match method {
        "host.jobs.authority" => {
            assert_eq!(params["agentId"], "alpha");
            assert_eq!(params["job"], "embedding-drain");
            Ok(if admit.load(Ordering::Acquire) {
                json!({"agentId":"alpha","workspace":format!("workspace-dir:v1:{}",workspace.display()),
                    "user":plur1bus_engine::context::harness_user_principal("job-owner"),
                    "channel":"telegram","accountId":"fixture","chat":{"id":"","kind":"direct"},"trust":"proved"})
            } else {
                Value::Null
            })
        }
        "host.workspaceDir" => Ok(json!({"path":workspace})),
        "host.event" => Ok(json!({})),
        _ => Err("E_NOT_AVAILABLE"),
    });
    let mut engine = rpc_process_support::EngineProcess::start_with_seam(&root, "flat-embedder");
    let mut peer = rpc_process_support::RawConnection::connect(engine.address());
    assert!(peer.call(
        1,
        "engine.auth",
        json!({"token":engine.token(),"clientId":"core-fixture"})
    )["result"]
        .is_object());
    let params = json!({"agentId":"alpha","job":"embedding-drain","dryRun":true});
    // The fixture's initial PID record is intentionally not a Core incarnation.
    let unauthorized = peer.call(2, "engine.jobs.run", params.clone());
    assert_eq!(
        unauthorized["error"]["data"]["reason"],
        "core-link-required"
    );
    assert_eq!(core.count("host.jobs.authority"), 0);
    std::fs::write(
        root.join("run/core.pid"),
        format!("{} {}\n", std::process::id(), uuid::Uuid::from_u128(1)),
    )
    .unwrap();
    let refused = peer.call(3, "engine.jobs.run", params.clone());
    assert_eq!(refused["error"]["data"]["error"], "E_NOT_AVAILABLE");
    assert_eq!(core.count("host.jobs.authority"), 1);
    assert!(!root.join("state/lancedb/_jobs").exists());
    allowed.store(true, Ordering::Release);
    let dry = peer.call(4, "engine.jobs.run", params);
    assert_eq!(dry["result"]["reason"], "dry_run_unsupported", "{dry}");
    assert!(!root.join("state/lancedb/_jobs").exists());
    let run = peer.call(
        5,
        "engine.jobs.run",
        json!({"agentId":"alpha","job":"embedding-drain"}),
    );
    assert_eq!(run["result"]["outcome"], "completed", "{run}");
    assert!(root
        .join("state/lancedb/_jobs/alpha/ledger.jsonl")
        .is_file());
    drop(peer);
    engine.close_stdin();
    assert!(engine.wait_for_exit().success());
}

impl Drop for FakeCore {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::Release);
        for closer in self.closers.lock().unwrap().drain(..) {
            closer();
        }
        self.writer.lock().unwrap().take();
        if let Some(thread) = self.thread.take() {
            let result = thread.join();
            if !thread::panicking() {
                assert!(result.is_ok(), "Fake Core fixture failed");
            }
        }
    }
}

fn wait_for(mut predicate: impl FnMut() -> bool) {
    let deadline = Instant::now() + Duration::from_secs(3);
    while !predicate() {
        assert!(Instant::now() < deadline, "fixture deadline");
        thread::sleep(Duration::from_millis(2));
    }
}

fn host(home: &Path, engine_token: &str) -> RpcHost {
    RpcHost::new(
        home.to_path_buf(),
        engine_token.to_owned(),
        serde_json::from_value(json!({})).unwrap(),
    )
}

fn agent() -> AgentId {
    "alice".parse().unwrap()
}
fn completion() -> LlmParams {
    serde_json::from_value(json!({"messages":[]})).unwrap()
}
fn target() -> Target {
    Target {
        scheme: Scheme::Https,
        host: "api.example.com".into(),
        port: 443,
    }
}

#[test]
fn absent_core_is_unavailable_then_late_core_and_restart_recover() {
    let home = tempfile::tempdir_in(std::fs::canonicalize(std::env::temp_dir()).unwrap()).unwrap();
    let host = host(home.path(), ENGINE_TOKEN);
    assert_eq!(host.state_dir(), home.path().join("state"));
    assert_eq!(host.workspace_dir(&agent()), Err(HostError::Unavailable));
    assert!(matches!(
        host.get("provider-key"),
        Err(HostError::Unavailable)
    ));
    {
        let _core = FakeCore::start(home.path(), CORE_TOKEN, |method, _| {
            assert_eq!(method, "host.workspaceDir");
            Ok(json!({"path":"/workspace/first"}))
        });
        assert_eq!(
            host.workspace_dir(&agent()).unwrap(),
            Some("/workspace/first".into())
        );
    }
    let _core = FakeCore::start(home.path(), &"d".repeat(64), |method, _| {
        assert_eq!(method, "host.workspaceDir");
        Ok(json!({"path":"/workspace/restarted"}))
    });
    assert_eq!(
        host.workspace_dir(&agent()).unwrap(),
        Some("/workspace/restarted".into())
    );
}

#[test]
fn delegation_is_required_before_secret_service_and_errors_are_redacted() {
    let home = tempfile::tempdir_in(std::fs::canonicalize(std::env::temp_dir()).unwrap()).unwrap();
    let core = FakeCore::start(home.path(), CORE_TOKEN, |method, params| {
        assert_eq!(method, "host.secret.get");
        if params["name"] == "present" {
            Ok(json!({"value":PRIVATE}))
        } else {
            Err("E_DENIED")
        }
    });
    let wrong = host(home.path(), &"f".repeat(64));
    let failure = wrong.get("present").err().unwrap();
    assert!(!format!("{failure:?} {failure}").contains(PRIVATE));
    assert_eq!(
        core.requests.lock().unwrap().len(),
        1,
        "failed auth must not call the secret handler"
    );
    let host = host(home.path(), ENGINE_TOKEN);
    let secret = host.get("present").unwrap().unwrap();
    assert_eq!(secret.expose(), PRIVATE);
    let error = host.get("denied").err().unwrap();
    assert_eq!(error, HostError::Denied);
    assert!(!format!("{error:?} {error}").contains(PRIVATE));
}

#[test]
fn attributed_completion_preserves_outer_agent_and_unattributed_trait_fails_closed() {
    let home = tempfile::tempdir_in(std::fs::canonicalize(std::env::temp_dir()).unwrap()).unwrap();
    let core = FakeCore::start(home.path(), CORE_TOKEN, |method, params| {
        assert_eq!(method, "host.llm.complete");
        if params["agentId"] == "alice" {
            Ok(json!({"text":"approved"}))
        } else {
            Err("E_DENIED")
        }
    });
    let host = host(home.path(), ENGINE_TOKEN);
    assert_eq!(
        host.complete(completion(), &Cancel::never()).err(),
        Some(HostError::Denied)
    );
    assert!(core.requests.lock().unwrap().is_empty());
    assert_eq!(
        host.complete_for(&agent(), &completion(), &Cancel::never())
            .unwrap()
            .text,
        "approved"
    );
    let other = "bob".parse().unwrap();
    assert_eq!(
        host.complete_for(&other, &completion(), &Cancel::never())
            .err(),
        Some(HostError::Denied)
    );
    let cancel = Cancel::never();
    cancel.cancel();
    let before = core.requests.lock().unwrap().len();
    assert!(matches!(
        host.complete_for(&agent(), &completion(), &cancel),
        Err(HostError::Cancelled(_))
    ));
    assert_eq!(core.requests.lock().unwrap().len(), before);
}

#[test]
fn egress_caches_each_target_until_an_idle_policy_notification() {
    let home = tempfile::tempdir_in(std::fs::canonicalize(std::env::temp_dir()).unwrap()).unwrap();
    let allow = Arc::new(AtomicBool::new(true));
    let live = allow.clone();
    let core = FakeCore::start(home.path(), CORE_TOKEN, move |method, params| {
        assert_eq!(method, "host.egress.decide");
        assert_eq!(
            params,
            &json!({"scheme":"https","host":"api.example.com","port":443})
        );
        if live.load(Ordering::Acquire) {
            Ok(
                json!({"allowed":true,"host":"api.example.com","port":443,"address":"8.8.8.8","family":4}),
            )
        } else {
            Ok(json!({"allowed":false,"reason":"host-not-allowed","message":PRIVATE}))
        }
    });
    let host = host(home.path(), ENGINE_TOKEN);
    let invalidations = Arc::new(AtomicUsize::new(0));
    let changed = invalidations.clone();
    host.set_egress_invalidator(Arc::new(move || {
        changed.fetch_add(1, Ordering::AcqRel);
    }));
    assert_eq!(
        host.decide(&target()),
        Decision::Allow {
            address_rules: AddressRules::default()
        }
    );
    allow.store(false, Ordering::Release);
    assert!(matches!(host.decide(&target()), Decision::Allow { .. }));
    assert_eq!(core.count("host.egress.decide"), 1);
    assert_eq!(core.count("events.subscribe"), 1);
    let before = invalidations.load(Ordering::Acquire);
    core.notify_policy_change();
    wait_for(|| invalidations.load(Ordering::Acquire) > before);
    let denied = host.decide(&target());
    assert!(matches!(&denied, Decision::Deny { .. }));
    assert!(!format!("{denied:?}").contains(PRIVATE));
    assert_eq!(core.count("host.egress.decide"), 2);
    assert_eq!(core.count("core.auth"), 1);
}

#[test]
fn workspace_events_and_journal_use_the_authenticated_host_surface() {
    let home = tempfile::tempdir_in(std::fs::canonicalize(std::env::temp_dir()).unwrap()).unwrap();
    let core = FakeCore::start(home.path(), CORE_TOKEN, |method, params| match method {
        "host.workspaceDir" => {
            assert_eq!(params["agentId"], "alice");
            Ok(json!({"path":null}))
        }
        "host.event" => {
            assert_eq!(
                params,
                &json!({"name":"recall.completed","payload":{"count":2}})
            );
            Ok(json!({}))
        }
        "host.journalBacklog" => Ok(json!({"entries":3,"oldestAt":1200})),
        _ => panic!("unexpected method"),
    });
    let host = host(home.path(), ENGINE_TOKEN);
    assert_eq!(host.workspace_dir(&agent()).unwrap(), None);
    host.emit("recall.completed", json!({"count":2}));
    wait_for(|| core.count("host.event") == 1);
    assert_eq!(
        serde_json::to_value(host.journal_backlog().unwrap()).unwrap(),
        json!({"entries":3,"oldestAt":1200})
    );
}

#[test]
fn egress_refuses_mismatched_origins_private_pins_and_unknown_denial_text() {
    let home = tempfile::tempdir_in(std::fs::canonicalize(std::env::temp_dir()).unwrap()).unwrap();
    let next = Arc::new(Mutex::new(
        json!({"allowed":true,"host":"different.example.com","port":443,"address":"8.8.8.8","family":4}),
    ));
    let response = next.clone();
    let _core = FakeCore::start(home.path(), CORE_TOKEN, move |_, _| {
        Ok(response.lock().unwrap().clone())
    });
    let host = host(home.path(), ENGINE_TOKEN);
    assert!(matches!(host.decide(&target()), Decision::Deny { .. }));
    *next.lock().unwrap() = json!({"allowed":true,"host":"api.example.com","port":443,"address":"169.254.169.254","family":4});
    assert!(matches!(host.decide(&target()), Decision::Deny { .. }));
    *next.lock().unwrap() = json!({"allowed":false,"reason":PRIVATE,"message":PRIVATE});
    let denial = host.decide(&target());
    assert!(matches!(&denial, Decision::Deny { .. }));
    assert!(!format!("{denial:?}").contains(PRIVATE));
}

#[test]
#[cfg(unix)]
fn linked_identity_files_fail_before_connecting_or_reading_host_secrets() {
    let home = tempfile::tempdir_in(std::fs::canonicalize(std::env::temp_dir()).unwrap()).unwrap();
    let core = FakeCore::start(home.path(), CORE_TOKEN, |_, _| {
        panic!("untrusted identity must not reach host")
    });
    let token = home.path().join("run/core.token");
    std::fs::remove_file(&token).unwrap();
    let external = home.path().join("elsewhere.token");
    std::fs::write(&external, CORE_TOKEN).unwrap();
    std::os::unix::fs::symlink(&external, &token).unwrap();
    assert!(matches!(
        host(home.path(), ENGINE_TOKEN).get("present"),
        Err(HostError::Unavailable)
    ));
    assert!(core.requests.lock().unwrap().is_empty());
}

#[test]
#[cfg(unix)]
fn public_hardlinked_and_oversize_identity_files_fail_before_authentication() {
    let home = tempfile::tempdir_in(std::fs::canonicalize(std::env::temp_dir()).unwrap()).unwrap();
    let core = FakeCore::start(home.path(), CORE_TOKEN, |_, _| Ok(json!({"value":null})));
    let token = home.path().join("run/core.token");
    let host = host(home.path(), ENGINE_TOKEN);
    std::fs::set_permissions(&token, std::fs::Permissions::from_mode(0o644)).unwrap();
    assert!(matches!(host.get("present"), Err(HostError::Unavailable)));
    std::fs::set_permissions(&token, std::fs::Permissions::from_mode(0o600)).unwrap();
    let hardlink = home.path().join("other.token");
    std::fs::hard_link(&token, &hardlink).unwrap();
    assert!(matches!(host.get("present"), Err(HostError::Unavailable)));
    std::fs::remove_file(hardlink).unwrap();
    std::fs::write(&token, "a".repeat(4097)).unwrap();
    assert!(matches!(host.get("present"), Err(HostError::Unavailable)));
    assert!(core.requests.lock().unwrap().is_empty());
}

#[test]
fn repeated_host_calls_reuse_one_delegated_handshake() {
    let home = tempfile::tempdir_in(std::fs::canonicalize(std::env::temp_dir()).unwrap()).unwrap();
    let core = FakeCore::start(home.path(), CORE_TOKEN, |_, _| Ok(json!({"path":null})));
    let host = host(home.path(), ENGINE_TOKEN);
    for _ in 0..3 {
        assert_eq!(host.workspace_dir(&agent()).unwrap(), None);
    }
    assert_eq!(core.count("core.auth"), 1);
    assert_eq!(core.accepted.load(Ordering::Acquire), 1);
    let requests = core.requests.lock().unwrap();
    let auth = requests
        .iter()
        .find(|request| request["method"] == "core.auth")
        .unwrap();
    assert_eq!(auth["params"]["token"], ENGINE_TOKEN);
    assert_ne!(auth["params"]["token"], CORE_TOKEN);
}

#[test]
fn notification_during_policy_call_prevents_caching_the_old_generation() {
    let home = tempfile::tempdir_in(std::fs::canonicalize(std::env::temp_dir()).unwrap()).unwrap();
    let (started_tx, started_rx) = std::sync::mpsc::sync_channel(1);
    let (release_tx, release_rx) = std::sync::mpsc::sync_channel(1);
    let release_rx = Mutex::new(release_rx);
    let calls = Arc::new(AtomicUsize::new(0));
    let gate_calls = calls.clone();
    let core = FakeCore::start(home.path(), CORE_TOKEN, move |method, _| {
        assert_eq!(method, "host.egress.decide");
        if gate_calls.fetch_add(1, Ordering::AcqRel) == 0 {
            started_tx.send(()).unwrap();
            release_rx
                .lock()
                .unwrap()
                .recv_timeout(Duration::from_secs(3))
                .unwrap();
            Ok(
                json!({"allowed":true,"host":"api.example.com","port":443,"address":"8.8.8.8","family":4}),
            )
        } else {
            Ok(json!({"allowed":false,"reason":"host-not-allowed","message":PRIVATE}))
        }
    });
    let host = Arc::new(host(home.path(), ENGINE_TOKEN));
    let invalidations = Arc::new(AtomicUsize::new(0));
    let changed = invalidations.clone();
    host.set_egress_invalidator(Arc::new(move || {
        changed.fetch_add(1, Ordering::AcqRel);
    }));
    let request_host = host.clone();
    let request = thread::spawn(move || request_host.decide(&target()));
    started_rx.recv_timeout(Duration::from_secs(3)).unwrap();
    let before = invalidations.load(Ordering::Acquire);
    core.notify_policy_change();
    wait_for(|| invalidations.load(Ordering::Acquire) > before);
    release_tx.send(()).unwrap();
    assert!(matches!(request.join().unwrap(), Decision::Allow { .. }));
    assert!(matches!(host.decide(&target()), Decision::Deny { .. }));
    assert_eq!(calls.load(Ordering::Acquire), 2);
    assert_eq!(core.count("core.auth"), 1);
}

#[test]
fn token_rotation_reauthenticates_and_revokes_cached_decisions() {
    let home = tempfile::tempdir_in(std::fs::canonicalize(std::env::temp_dir()).unwrap()).unwrap();
    let allowed = Arc::new(AtomicBool::new(true));
    let live = allowed.clone();
    let core = FakeCore::start(home.path(), CORE_TOKEN, move |_, params| {
        if live.load(Ordering::Acquire) {
            Ok(
                json!({"allowed":true,"host":params["host"],"port":params["port"],"address":"8.8.8.8","family":4}),
            )
        } else {
            Ok(json!({"allowed":false,"reason":"host-not-allowed","message":"revoked"}))
        }
    });
    let host = host(home.path(), ENGINE_TOKEN);
    assert!(matches!(host.decide(&target()), Decision::Allow { .. }));
    assert!(matches!(host.decide(&target()), Decision::Allow { .. }));
    assert_eq!(core.count("host.egress.decide"), 1);
    allowed.store(false, Ordering::Release);
    core.rotate_token(&"d".repeat(64));
    assert!(matches!(host.decide(&target()), Decision::Deny { .. }));
    assert_eq!(core.count("core.auth"), 2);
    assert_eq!(core.count("events.subscribe"), 2);
}

#[test]
fn idle_eof_invalidates_cached_policy_and_restarted_core_recovers() {
    let home = tempfile::tempdir_in(std::fs::canonicalize(std::env::temp_dir()).unwrap()).unwrap();
    let host = host(home.path(), ENGINE_TOKEN);
    let invalidations = Arc::new(AtomicUsize::new(0));
    let changed = invalidations.clone();
    host.set_egress_invalidator(Arc::new(move || {
        changed.fetch_add(1, Ordering::AcqRel);
    }));
    let before;
    {
        let core = FakeCore::start(home.path(), CORE_TOKEN, |_, _| {
            Ok(
                json!({"allowed":true,"host":"api.example.com","port":443,"address":"8.8.8.8","family":4}),
            )
        });
        assert!(matches!(host.decide(&target()), Decision::Allow { .. }));
        assert_eq!(core.count("host.egress.decide"), 1);
        before = invalidations.load(Ordering::Acquire);
    }
    wait_for(|| invalidations.load(Ordering::Acquire) > before);
    let core = FakeCore::start(home.path(), &"d".repeat(64), |_, _| {
        Ok(json!({"allowed":false,"reason":"host-not-allowed","message":"revoked"}))
    });
    assert!(matches!(host.decide(&target()), Decision::Deny { .. }));
    assert_eq!(core.count("core.auth"), 1);
    assert_eq!(core.count("host.egress.decide"), 1);
}

#[test]
fn emit_is_prompt_bounded_and_shutdown_interrupts_a_hung_core() {
    let home = tempfile::tempdir_in(std::fs::canonicalize(std::env::temp_dir()).unwrap()).unwrap();
    let core = FakeCore::start(home.path(), CORE_TOKEN, |method, _| match method {
        "host.workspaceDir" => Ok(json!({"path":null})),
        "host.event" => Ok(json!({"fixtureHold":true})),
        _ => panic!("unexpected method"),
    });
    let host = Arc::new(host(home.path(), ENGINE_TOKEN));
    struct StopHost(Arc<RpcHost>);
    impl Drop for StopHost {
        fn drop(&mut self) {
            self.0.shutdown();
        }
    }
    let _stop_host = StopHost(host.clone());
    assert_eq!(host.workspace_dir(&agent()).unwrap(), None);
    let (done_tx, done_rx) = std::sync::mpsc::sync_channel(1);
    let emitting_host = host.clone();
    let emit_thread = thread::spawn(move || {
        for _ in 0..1024 {
            emitting_host.emit("recall.completed", json!({"count":1}));
        }
        let _ = done_tx.send(());
    });
    wait_for(|| core.count("host.event") >= 1);
    let prompt = done_rx.recv_timeout(Duration::from_secs(1)).is_ok();
    let started = Instant::now();
    host.shutdown();
    emit_thread.join().unwrap();
    assert!(prompt, "emit waited for Core");
    assert!(
        started.elapsed() < Duration::from_secs(2),
        "shutdown waited for the call timeout"
    );
    assert!(
        host.dropped_events() > 0,
        "event queue did not stay bounded"
    );
    assert_eq!(host.workspace_dir(&agent()), Err(HostError::Unavailable));
}

#[test]
fn caller_cancellation_closes_the_reverse_call_and_reconnects() {
    let home = tempfile::tempdir_in(std::fs::canonicalize(std::env::temp_dir()).unwrap()).unwrap();
    let core = FakeCore::start(home.path(), CORE_TOKEN, |method, _| match method {
        "host.workspaceDir" => Ok(json!({"path":null})),
        "host.llm.complete" => Ok(json!({"fixtureHold":true})),
        _ => panic!("unexpected method"),
    });
    let host = Arc::new(host(home.path(), ENGINE_TOKEN));
    let cancel = Cancel::never();
    let request_cancel = cancel.clone();
    let request_host = host.clone();
    let request =
        thread::spawn(move || request_host.complete_for(&agent(), &completion(), &request_cancel));
    wait_for(|| core.count("host.llm.complete") == 1);
    let started = Instant::now();
    cancel.cancel();
    assert!(matches!(
        request.join().unwrap(),
        Err(HostError::Cancelled(_))
    ));
    assert!(started.elapsed() < Duration::from_secs(1));
    assert_eq!(host.workspace_dir(&agent()).unwrap(), None);
    assert_eq!(core.count("core.auth"), 2);
}

#[test]
fn concurrent_first_calls_share_the_same_handshake() {
    let home = tempfile::tempdir_in(std::fs::canonicalize(std::env::temp_dir()).unwrap()).unwrap();
    let core = FakeCore::start(home.path(), CORE_TOKEN, |_, _| Ok(json!({"path":null})));
    let host = Arc::new(host(home.path(), ENGINE_TOKEN));
    let requests = (0..4)
        .map(|_| {
            let host = host.clone();
            thread::spawn(move || host.workspace_dir(&agent()))
        })
        .collect::<Vec<_>>();
    for request in requests {
        assert_eq!(request.join().unwrap().unwrap(), None);
    }
    assert_eq!(core.count("core.auth"), 1);
    assert_eq!(core.count("events.subscribe"), 1);
}

#[cfg(windows)]
#[test]
fn windows_pipe_pid_mismatch_is_refused_before_delegation() {
    let home = tempfile::tempdir_in(std::fs::canonicalize(std::env::temp_dir()).unwrap()).unwrap();
    let core = FakeCore::start(home.path(), CORE_TOKEN, |_, _| {
        panic!("host must not be reached")
    });
    let pid = home.path().join("run/core.pid");
    std::fs::write(
        &pid,
        format!("{} fake-core\n", std::process::id().wrapping_add(1)),
    )
    .unwrap();
    plur1bus_engine::store::paths::secure_file(&pid).unwrap();
    assert!(matches!(
        host(home.path(), ENGINE_TOKEN).get("present"),
        Err(HostError::Denied)
    ));
    assert_eq!(core.count("core.auth"), 0);
}

#[cfg(windows)]
#[test]
fn windows_public_identity_dacl_is_refused_before_connecting() {
    let home = tempfile::tempdir_in(std::fs::canonicalize(std::env::temp_dir()).unwrap()).unwrap();
    let core = FakeCore::start(home.path(), CORE_TOKEN, |_, _| {
        panic!("host must not be reached")
    });
    let user = plur1bus_rpc::win::user_sid().unwrap();
    plur1bus_rpc::win::set_path_dacl(
        &home.path().join("run/core.token"),
        &format!("D:P(A;;GA;;;{user})(A;;GR;;;WD)"),
    )
    .unwrap();
    assert!(matches!(
        host(home.path(), ENGINE_TOKEN).get("present"),
        Err(HostError::Unavailable)
    ));
    assert_eq!(core.accepted.load(Ordering::Acquire), 0);
}

/// A genuine built Core process with piped lifeline and kill+wait cleanup on every path.
struct RealCore {
    child: std::process::Child,
    _logs: tempfile::TempDir,
    engine: rpc_process_support::EngineProcess,
}

impl RealCore {
    fn start(home: &Path) -> Self {
        let root = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../..");
        let core_js = root
            .join("packages/core/dist/core.js")
            .canonicalize()
            .expect("built Core is required; run pnpm test:prep");
        let mut config = plur1bus_config::defaults();
        config["engine"]["implementation"] = json!("rust");
        config["agents"]["alice"] = json!({});
        config["supervisor"]["graceMs"] = json!(1000);
        config["core"]["shutdownBudgetMs"] = json!(1000);
        std::fs::write(
            home.join("config.json"),
            serde_json::to_vec(&config).unwrap(),
        )
        .unwrap();
        // Core authenticates the native pipe peer against the ready engine's published PID and token.
        let engine = rpc_process_support::EngineProcess::start(home, None);
        let logs =
            tempfile::tempdir_in(std::fs::canonicalize(std::env::temp_dir()).unwrap()).unwrap();
        let stdout = logs.path().join("stdout");
        let stderr = logs.path().join("stderr");
        let node = std::env::var_os("PLUR1BUS_NODE").unwrap_or_else(|| "node".into());
        let child = std::process::Command::new(node)
            .arg(core_js)
            .arg("--home")
            .arg(home)
            .args(["--lifeline", "stdin"])
            .env("PLUR1BUS_ALLOW_TEST_INTERNALS", "1")
            .env("PLUR1BUS_SECRETS_KEYRING", "off")
            .stdin(std::process::Stdio::piped())
            .stdout(std::fs::File::create(&stdout).unwrap())
            .stderr(std::fs::File::create(&stderr).unwrap())
            .spawn()
            .expect("Node24 and built Core are required; run pnpm test:prep");
        let mut core = Self {
            child,
            _logs: logs,
            engine,
        };
        let deadline = Instant::now() + Duration::from_secs(20);
        loop {
            let ready = std::fs::read_to_string(&stdout)
                .unwrap_or_default()
                .lines()
                .filter_map(|line| serde_json::from_str::<Value>(line).ok())
                .any(|line| line["ready"] == true && line["pid"] == core.child.id());
            if ready {
                return core;
            }
            assert!(
                core.child.try_wait().unwrap().is_none(),
                "Core exited before ready: {}",
                std::fs::read_to_string(&stderr).unwrap_or_default()
            );
            assert!(
                Instant::now() < deadline,
                "Core readiness deadline: {}",
                std::fs::read_to_string(&stderr).unwrap_or_default()
            );
            thread::sleep(Duration::from_millis(10));
        }
    }
}

impl Drop for RealCore {
    fn drop(&mut self) {
        self.child.stdin.take();
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

#[test]
fn genuine_core_accepts_engine_delegation_and_policy_subscription() {
    let home = tempfile::tempdir_in(std::fs::canonicalize(std::env::temp_dir()).unwrap()).unwrap();
    let core = RealCore::start(home.path());
    let host = host(home.path(), &core.engine.token());
    let expected = home.path().join("agents/alice/workspace");
    for _ in 0..3 {
        assert_eq!(
            host.workspace_dir(&agent()).unwrap(),
            Some(expected.clone())
        );
        assert_eq!(
            serde_json::to_value(
                host.journal_backlog()
                    .expect("actual host handler answered")
            )
            .unwrap(),
            json!({"entries":0,"oldestAt":null})
        );
    }
    // The successful first host call follows a validated subscriptionId response;
    // the real Core guard only admits the independent engine token in both fields.
    host.shutdown();
}

#[test]
fn shutdown_is_bounded_while_auth_or_subscription_is_unacknowledged() {
    for method in ["core.auth", "events.subscribe"] {
        let home =
            tempfile::tempdir_in(std::fs::canonicalize(std::env::temp_dir()).unwrap()).unwrap();
        let core =
            FakeCore::start_bootstrap(home.path(), CORE_TOKEN, Bootstrap::Hold(method), |_, _| {
                panic!("host work must wait for subscription acknowledgement")
            });
        let host = Arc::new(host(home.path(), ENGINE_TOKEN));
        let call_host = host.clone();
        let (done_tx, done_rx) = std::sync::mpsc::sync_channel(1);
        let request = thread::spawn(move || {
            let result = call_host.workspace_dir(&agent());
            let _ = done_tx.send(result);
        });
        wait_for(|| core.count(method) == 1);
        assert_eq!(core.count("host.workspaceDir"), 0);
        host.shutdown();
        let completed = done_rx.recv_timeout(Duration::from_secs(2));
        // Releasing the fixture first also bounds cleanup if the client regresses.
        drop(core);
        request.join().unwrap();
        assert!(matches!(completed, Ok(Err(HostError::Unavailable))));
    }
}

#[test]
fn shutdown_is_bounded_while_core_trickles_an_unfinished_auth_frame() {
    let home = tempfile::tempdir_in(std::fs::canonicalize(std::env::temp_dir()).unwrap()).unwrap();
    let core =
        FakeCore::start_bootstrap(home.path(), CORE_TOKEN, Bootstrap::TrickleAuth, |_, _| {
            panic!("auth never completed")
        });
    let host = Arc::new(host(home.path(), ENGINE_TOKEN));
    host.emit("recall.completed", json!({}));
    wait_for(|| core.count("core.auth") == 1);
    let stopping_host = host.clone();
    let (done_tx, done_rx) = std::sync::mpsc::sync_channel(1);
    let stopping = thread::spawn(move || {
        stopping_host.shutdown();
        let _ = done_tx.send(());
    });
    let prompt = done_rx.recv_timeout(Duration::from_secs(1)).is_ok();
    // A broken absolute timeout still cannot leave this test or its thread behind.
    drop(core);
    stopping.join().unwrap();
    assert!(prompt, "partial auth bytes extended the shutdown deadline");
}

#[test]
fn policy_cache_distinguishes_targets_and_emit_rejects_oversized_payloads() {
    let home = tempfile::tempdir_in(std::fs::canonicalize(std::env::temp_dir()).unwrap()).unwrap();
    let core = FakeCore::start(home.path(), CORE_TOKEN, |method, params| {
        assert_eq!(method, "host.egress.decide");
        Ok(
            json!({"allowed":true,"host":params["host"],"port":params["port"],"address":"8.8.8.8","family":4}),
        )
    });
    let host = host(home.path(), ENGINE_TOKEN);
    let mut second = target();
    second.port = 8443;
    for destination in [&target(), &second, &target(), &second] {
        assert!(matches!(host.decide(destination), Decision::Allow { .. }));
    }
    assert_eq!(core.count("host.egress.decide"), 2);
    assert_eq!(core.count("core.auth"), 1);
    host.emit("recall.completed", json!("x".repeat(65 * 1024)));
    host.emit(&"x".repeat(257), json!({}));
    assert_eq!(host.dropped_events(), 2);
    assert_eq!(core.count("host.event"), 0);
}
