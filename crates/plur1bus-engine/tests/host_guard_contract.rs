//! Reverse RPC must authenticate the independent engine principal before host access.
#![cfg(unix)]
// Native OS fixtures intentionally panic on a failed setup/cleanup so a test cannot pass vacuously.
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use plur1bus_engine::contract::{
    AddressRules, AgentId, Cancel, Decision, EgressGate, HostError, HostServices, LlmParams,
    LlmPort, Scheme, SecretPort, Target,
};
use plur1bus_engine::rpc::host_client::RpcHost;
use serde_json::{json, Value};
use std::io::{BufRead, BufReader, Write};
use std::os::unix::fs::PermissionsExt;
use std::os::unix::net::UnixListener;
use std::path::Path;
use std::sync::{Arc, Mutex};
use std::thread::{self, JoinHandle};

const ENGINE_TOKEN: &str = "eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee";
const CORE_TOKEN: &str = "cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc";
const PRIVATE: &str = "test-only-private-secret-body";

type Handler = dyn Fn(&str, &Value) -> Result<Value, &'static str> + Send + Sync;

/// Each accepted connection must pass the same exact delegation shape as the Core guard.
struct FakeCore {
    thread: Option<JoinHandle<()>>,
    listener: UnixListener,
    requests: Arc<Mutex<Vec<Value>>>,
}

impl FakeCore {
    fn start(
        home: &Path,
        token: &str,
        handler: impl Fn(&str, &Value) -> Result<Value, &'static str> + Send + Sync + 'static,
    ) -> Self {
        let run = home.join("run");
        std::fs::create_dir_all(&run).unwrap();
        std::fs::set_permissions(&run, std::fs::Permissions::from_mode(0o700)).unwrap();
        let path = run.join("core.sock");
        let _ = std::fs::remove_file(&path);
        let listener = UnixListener::bind(&path).unwrap();
        std::fs::write(run.join("core.token"), token).unwrap();
        std::fs::write(
            run.join("core.pid"),
            format!("{} fake-core\n", std::process::id()),
        )
        .unwrap();
        for file in [run.join("core.token"), run.join("core.pid")] {
            std::fs::set_permissions(file, std::fs::Permissions::from_mode(0o600)).unwrap();
        }
        let worker_listener = listener.try_clone().unwrap();
        let requests = Arc::new(Mutex::new(Vec::new()));
        let recorded = requests.clone();
        let token = token.to_owned();
        let handler: Arc<Handler> = Arc::new(handler);
        let thread = thread::spawn(move || {
            for accepted in worker_listener.incoming() {
                let stream = accepted.unwrap();
                let mut reader = BufReader::new(stream);
                let mut authed = false;
                loop {
                    let mut line = String::new();
                    if reader.read_line(&mut line).unwrap() == 0 {
                        break;
                    }
                    let request: Value = serde_json::from_str(&line).unwrap();
                    if request["method"] == "test.stop" {
                        return;
                    }
                    recorded.lock().unwrap().push(request.clone());
                    let result = if request["method"] == "core.auth" {
                        authed = request["params"]
                            == json!({"token":token,"engine":{"clientId":"plur1bus-engine","token":ENGINE_TOKEN}});
                        if authed {
                            Ok(
                                json!({"contract":"1.17.0","rpc":"1.7.0","instanceId":"fake-core","pid":std::process::id()}),
                            )
                        } else {
                            Err("E_UNAUTHORIZED")
                        }
                    } else if !authed {
                        Err("E_DENIED")
                    } else {
                        handler(request["method"].as_str().unwrap(), &request["params"])
                    };
                    let response = match result {
                        Ok(value) => json!({"jsonrpc":"2.0","id":request["id"],"result":value}),
                        Err(code) => {
                            json!({"jsonrpc":"2.0","id":request["id"],"error":{"code":-32000,"message":PRIVATE,"data":{"error":code,"reason":PRIVATE,"detail":PRIVATE}}})
                        }
                    };
                    writeln!(reader.get_mut(), "{response}").unwrap();
                }
            }
        });
        Self {
            thread: Some(thread),
            listener,
            requests,
        }
    }
}

impl Drop for FakeCore {
    fn drop(&mut self) {
        let mut stream = std::os::unix::net::UnixStream::connect(
            self.listener.local_addr().unwrap().as_pathname().unwrap(),
        )
        .unwrap();
        writeln!(stream, "{}", json!({"method":"test.stop"})).unwrap();
        if let Some(thread) = self.thread.take() {
            let _ = thread.join();
        }
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
fn egress_asks_live_policy_for_every_hop_and_never_echoes_arbitrary_denials() {
    let home = tempfile::tempdir_in(std::fs::canonicalize(std::env::temp_dir()).unwrap()).unwrap();
    let allow = Arc::new(std::sync::atomic::AtomicBool::new(true));
    let live = allow.clone();
    let _core = FakeCore::start(home.path(), CORE_TOKEN, move |method, params| {
        assert_eq!(method, "host.egress.decide");
        assert_eq!(
            params,
            &json!({"scheme":"https","host":"api.example.com","port":443})
        );
        if live.load(std::sync::atomic::Ordering::Acquire) {
            Ok(
                json!({"allowed":true,"host":"api.example.com","port":443,"address":"8.8.8.8","family":4}),
            )
        } else {
            Ok(json!({"allowed":false,"reason":"host-not-allowed","message":PRIVATE}))
        }
    });
    let host = host(home.path(), ENGINE_TOKEN);
    assert!(!host.cache_decisions());
    assert_eq!(
        host.decide(&target()),
        Decision::Allow {
            address_rules: AddressRules::default()
        }
    );
    allow.store(false, std::sync::atomic::Ordering::Release);
    let denied = host.decide(&target());
    assert!(matches!(&denied, Decision::Deny { .. }));
    assert!(!format!("{denied:?}").contains(PRIVATE));
}

#[test]
fn workspace_events_and_journal_use_the_authenticated_host_surface() {
    let home = tempfile::tempdir_in(std::fs::canonicalize(std::env::temp_dir()).unwrap()).unwrap();
    let _core = FakeCore::start(home.path(), CORE_TOKEN, |method, params| match method {
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
