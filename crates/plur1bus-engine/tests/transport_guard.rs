#![allow(clippy::unwrap_used, clippy::expect_used)]

use plur1bus_engine::contract::{AddressRules, Decision, EgressGate, Target};
use plur1bus_engine::transport::{GuardedClient, HttpRequest, Resolver, TransportError};
use std::net::{IpAddr, Ipv4Addr};
use std::sync::{
    atomic::{AtomicBool, AtomicUsize, Ordering},
    Arc,
};
use std::time::{Duration, Instant};

#[path = "support/http_stub.rs"]
mod http_stub;
use http_stub::Stub;

struct Gate {
    allowed: AtomicBool,
    denied_port: u16,
    calls: AtomicUsize,
    rules: AddressRules,
}
impl Gate {
    fn local() -> Self {
        Self {
            allowed: AtomicBool::new(true),
            denied_port: 0,
            calls: AtomicUsize::new(0),
            rules: AddressRules {
                allow_loopback: true,
                ..AddressRules::default()
            },
        }
    }
}
impl EgressGate for Gate {
    fn decide(&self, target: &Target) -> Decision {
        self.calls.fetch_add(1, Ordering::SeqCst);
        if !self.allowed.load(Ordering::SeqCst) || target.port == self.denied_port {
            Decision::Deny {
                reason: "test-policy".into(),
            }
        } else {
            Decision::Allow {
                address_rules: self.rules,
            }
        }
    }
}

struct Lookup {
    calls: Arc<AtomicUsize>,
    answers: Vec<IpAddr>,
}
impl Resolver for Lookup {
    fn resolve(&self, _: &str, _: u16, _: Instant) -> Result<Vec<IpAddr>, TransportError> {
        self.calls.fetch_add(1, Ordering::SeqCst);
        Ok(self.answers.clone())
    }
}
fn local_lookup() -> Box<dyn Resolver> {
    Box::new(Lookup {
        calls: Arc::new(AtomicUsize::new(0)),
        answers: vec![IpAddr::V4(Ipv4Addr::LOCALHOST)],
    })
}
fn deadline() -> Instant {
    Instant::now() + Duration::from_secs(2)
}

#[test]
fn a_denied_target_is_never_connected() {
    let stub = Stub::new(200, "", "ok", Duration::ZERO);
    let gate = Gate::local();
    gate.allowed.store(false, Ordering::SeqCst);
    let calls = Arc::new(AtomicUsize::new(0));
    let client = GuardedClient::new(
        &gate,
        Box::new(Lookup {
            calls: calls.clone(),
            answers: vec![],
        }),
    );
    assert_eq!(
        client.request(HttpRequest::get(stub.url("/")), deadline()),
        Err(TransportError::Denied)
    );
    assert_eq!(calls.load(Ordering::SeqCst), 0);
    assert!(stub.requests.lock().unwrap().is_empty());
}

#[test]
fn a_redirect_to_the_same_host_on_a_port_the_gate_denies_is_refused() {
    let destination = Stub::new(200, "", "no", Duration::ZERO);
    let redirect = Stub::new(
        307,
        &format!("Location: {}\r\n", destination.url("/secret")),
        "",
        Duration::ZERO,
    );
    let mut gate = Gate::local();
    gate.denied_port = destination.port;
    let client = GuardedClient::new(&gate, local_lookup());
    assert_eq!(
        client.request(HttpRequest::get(redirect.url("/")), deadline()),
        Err(TransportError::Denied)
    );
    assert_eq!(gate.calls.load(Ordering::SeqCst), 2);
    assert!(destination.requests.lock().unwrap().is_empty());
}

#[test]
fn dns_rebinding_is_refused() {
    struct Rebinding(AtomicUsize);
    impl Resolver for Rebinding {
        fn resolve(
            &self,
            _: &str,
            _: u16,
            deadline: Instant,
        ) -> Result<Vec<IpAddr>, TransportError> {
            if self.0.fetch_add(1, Ordering::SeqCst) == 0 {
                // Expire before dialing: even the public answer must never touch external networking.
                std::thread::sleep(deadline.saturating_duration_since(Instant::now()));
                Ok(vec!["8.8.8.8".parse().unwrap()])
            } else {
                Ok(vec!["127.0.0.1".parse().unwrap()])
            }
        }
    }
    let stub = Stub::new(200, "", "no", Duration::ZERO);
    let mut gate = Gate::local();
    gate.rules.allow_loopback = false;
    let client = GuardedClient::new(&gate, Box::new(Rebinding(AtomicUsize::new(0))));
    assert_eq!(
        client.request(
            HttpRequest::get(stub.url("/")),
            Instant::now() + Duration::from_millis(30)
        ),
        Err(TransportError::Timeout)
    );
    assert_eq!(
        client.request(HttpRequest::get(stub.url("/")), deadline()),
        Err(TransportError::AddressDenied)
    );
    assert!(stub.requests.lock().unwrap().is_empty());
}

#[test]
fn every_resolved_address_is_checked_before_connecting() {
    let stub = Stub::new(200, "", "no", Duration::ZERO);
    let gate = Gate::local();
    let client = GuardedClient::new(
        &gate,
        Box::new(Lookup {
            calls: Arc::new(AtomicUsize::new(0)),
            answers: vec![
                "127.0.0.1".parse().unwrap(),
                "169.254.169.254".parse().unwrap(),
            ],
        }),
    );
    assert_eq!(
        client.request(HttpRequest::get(stub.url("/")), deadline()),
        Err(TransportError::AddressDenied)
    );
    assert!(stub.requests.lock().unwrap().is_empty());
}

#[test]
fn the_decision_cache_is_dropped_on_invalidate() {
    let stub = Stub::new(200, "", "ok", Duration::ZERO);
    let gate = Gate::local();
    let client = GuardedClient::new(&gate, local_lookup());
    assert_eq!(
        client
            .request(HttpRequest::get(stub.url("/")), deadline())
            .unwrap()
            .body,
        b"ok"
    );
    gate.allowed.store(false, Ordering::SeqCst);
    assert!(client
        .request(HttpRequest::get(stub.url("/")), deadline())
        .is_ok());
    assert_eq!(gate.calls.load(Ordering::SeqCst), 1);
    client.invalidate();
    assert_eq!(
        client.request(HttpRequest::get(stub.url("/")), deadline()),
        Err(TransportError::Denied)
    );
    assert_eq!(gate.calls.load(Ordering::SeqCst), 2);
}

#[test]
fn one_deadline_covers_the_whole_call_including_redirects() {
    let destination = Stub::new(200, "", "late", Duration::from_millis(80));
    let redirect = Stub::new(
        307,
        &format!("Location: {}\r\n", destination.url("/")),
        "",
        Duration::from_millis(70),
    );
    let gate = Gate::local();
    let client = GuardedClient::new(&gate, local_lookup());
    assert_eq!(
        client.request(
            HttpRequest::get(redirect.url("/")),
            Instant::now() + Duration::from_millis(110)
        ),
        Err(TransportError::Timeout)
    );
}

#[test]
fn pinned_dns_keeps_the_original_http_host() {
    let stub = Stub::new(200, "", "ok", Duration::ZERO);
    let gate = Gate::local();
    let calls = Arc::new(AtomicUsize::new(0));
    let client = GuardedClient::new(
        &gate,
        Box::new(Lookup {
            calls: calls.clone(),
            answers: vec!["127.0.0.1".parse().unwrap()],
        }),
    );
    assert!(client
        .request(HttpRequest::get(stub.url("/")), deadline())
        .is_ok());
    assert_eq!(calls.load(Ordering::SeqCst), 1);
    assert!(stub.requests.lock().unwrap()[0]
        .to_ascii_lowercase()
        .contains(&format!("host: provider.test:{}\r\n", stub.port)));
}

#[test]
fn a_redirect_to_another_origin_drops_credentials() {
    let destination = Stub::new(200, "", "ok", Duration::ZERO);
    let redirect = Stub::new(
        307,
        &format!("Location: {}\r\n", destination.url("/")),
        "",
        Duration::ZERO,
    );
    let gate = Gate::local();
    let client = GuardedClient::new(&gate, local_lookup());
    let mut req = HttpRequest::get(redirect.url("/"));
    req.headers
        .push(("Authorization".into(), "Bearer private-value".into()));
    assert!(client.request(req, deadline()).is_ok());
    assert!(!destination.requests.lock().unwrap()[0].contains("private-value"));
}

#[test]
fn tls_sni_keeps_the_original_name_for_the_pinned_address() {
    use std::io::Read;
    let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    let port = listener.local_addr().unwrap().port();
    listener.set_nonblocking(true).unwrap();
    let captured = std::thread::spawn(move || {
        let limit = Instant::now() + Duration::from_secs(2);
        let (mut socket, _) = loop {
            if let Ok(connection) = listener.accept() {
                break connection;
            }
            assert!(
                Instant::now() < limit,
                "the TLS stub received no connection"
            );
            std::thread::sleep(Duration::from_millis(2));
        };
        // Windows and macOS hand the listener's nonblocking mode to an accepted socket; read_exact below blocks.
        socket.set_nonblocking(false).unwrap();
        socket
            .set_read_timeout(Some(Duration::from_secs(2)))
            .unwrap();
        let mut header = [0; 5];
        socket.read_exact(&mut header).unwrap();
        assert_eq!(header[0], 22, "the first TLS record carries a handshake");
        let mut hello = vec![0; u16::from_be_bytes([header[3], header[4]]) as usize];
        socket.read_exact(&mut hello).unwrap();
        hello
    });
    let gate = Arc::new(Gate::local());
    let client = GuardedClient::new_owned(gate, local_lookup());
    assert!(client
        .request(
            HttpRequest::get(format!("https://provider.test:{port}/")),
            deadline()
        )
        .is_err());
    let hello = captured.join().unwrap();
    // RFC 6066: server_name extension 0, list length, host_name type 0, hostname length.
    let mut sni = vec![0, 0, 0, 18, 0, 16, 0, 0, 13];
    sni.extend_from_slice(b"provider.test");
    assert!(hello.windows(sni.len()).any(|window| window == sni));
}

#[test]
fn time_spent_in_the_gate_counts_against_the_deadline() {
    struct SlowGate;
    impl EgressGate for SlowGate {
        fn decide(&self, _: &Target) -> Decision {
            std::thread::sleep(Duration::from_millis(20));
            Decision::Allow {
                address_rules: AddressRules {
                    allow_loopback: true,
                    ..AddressRules::default()
                },
            }
        }
    }
    let stub = Stub::new(200, "", "no", Duration::ZERO);
    let client = GuardedClient::new(&SlowGate, local_lookup());
    assert_eq!(
        client.request(
            HttpRequest::get(stub.url("/")),
            Instant::now() + Duration::from_millis(10)
        ),
        Err(TransportError::Timeout)
    );
    assert!(stub.requests.lock().unwrap().is_empty());
}

#[test]
fn private_grants_do_not_admit_metadata_or_embedded_loopback() {
    use plur1bus_engine::transport::target::address_allowed;
    let private = AddressRules {
        allow_private: true,
        ..AddressRules::default()
    };
    for address in [
        "169.254.169.254",
        "100.100.100.200",
        "168.63.129.16",
        "fd00:ec2::254",
        "::ffff:127.0.0.1",
        "64:ff9b::7f00:1",
        "2002:7f00:1::",
    ] {
        assert!(
            !address_allowed(address.parse().unwrap(), private),
            "{address}"
        );
    }
    for address in ["10.0.0.1", "169.254.1.1", "fc00::1", "fe80::1"] {
        assert!(
            address_allowed(address.parse().unwrap(), private),
            "{address}"
        );
    }
    for address in [
        "0.0.0.0",
        "192.0.2.1",
        "224.0.0.1",
        "::",
        "2001:db8::1",
        "3fff::1",
    ] {
        assert!(
            !address_allowed(
                address.parse().unwrap(),
                AddressRules {
                    allow_private: true,
                    allow_loopback: true,
                    allow_metadata: true
                }
            ),
            "{address}"
        );
    }
}

#[test]
fn public_address_classification_matches_the_shared_node_vectors() {
    let fixture: serde_json::Value = serde_json::from_str(include_str!(
        "../../../packages/core/test/fixtures/net/ip-classification-vectors.json"
    ))
    .unwrap();
    let mut checked = 0;
    for row in fixture["addresses"].as_array().unwrap() {
        let Some(canonical) = row["canonical"].as_str() else {
            continue;
        };
        let address: IpAddr = canonical.parse().unwrap();
        assert_eq!(
            plur1bus_engine::transport::target::address_allowed(address, AddressRules::default()),
            row["public"].as_bool().unwrap(),
            "{canonical}"
        );
        checked += 1;
    }
    assert!(checked >= 50);
}

#[test]
fn the_owned_gate_cannot_hold_the_caller_past_the_deadline() {
    use std::sync::{mpsc, Mutex};
    struct BlockingGate {
        started: mpsc::Sender<()>,
        release: Mutex<mpsc::Receiver<()>>,
    }
    impl EgressGate for BlockingGate {
        fn decide(&self, _: &Target) -> Decision {
            self.started.send(()).unwrap();
            self.release.lock().unwrap().recv().unwrap();
            Decision::Allow {
                address_rules: AddressRules::default(),
            }
        }
    }
    let (started, observe) = mpsc::channel();
    let (release, wait) = mpsc::channel();
    let client = GuardedClient::new_owned(
        Arc::new(BlockingGate {
            started,
            release: Mutex::new(wait),
        }),
        local_lookup(),
    );
    let (returned, receive) = mpsc::channel();
    let worker = std::thread::spawn(move || {
        returned
            .send(client.request(
                HttpRequest::get("http://provider.test:1/"),
                Instant::now() + Duration::from_millis(30),
            ))
            .unwrap()
    });
    observe.recv_timeout(Duration::from_secs(1)).unwrap();
    let result = receive.recv_timeout(Duration::from_millis(200));
    release.send(()).unwrap();
    worker.join().unwrap();
    assert_eq!(result.unwrap(), Err(TransportError::Timeout));
}

#[test]
fn a_resolver_cannot_hold_the_caller_past_the_deadline() {
    use std::sync::{mpsc, Mutex};
    struct BlockingLookup {
        started: mpsc::Sender<()>,
        release: Mutex<mpsc::Receiver<()>>,
    }
    impl Resolver for BlockingLookup {
        fn resolve(&self, _: &str, _: u16, _: Instant) -> Result<Vec<IpAddr>, TransportError> {
            self.started.send(()).unwrap();
            self.release.lock().unwrap().recv().unwrap();
            Ok(vec!["127.0.0.1".parse().unwrap()])
        }
    }
    let (started, observe) = mpsc::channel();
    let (release, wait) = mpsc::channel();
    let client = GuardedClient::new_owned(
        Arc::new(Gate::local()),
        Box::new(BlockingLookup {
            started,
            release: Mutex::new(wait),
        }),
    );
    let (returned, receive) = mpsc::channel();
    let worker = std::thread::spawn(move || {
        returned
            .send(client.request(
                HttpRequest::get("http://provider.test:1/"),
                Instant::now() + Duration::from_millis(30),
            ))
            .unwrap()
    });
    observe.recv_timeout(Duration::from_secs(1)).unwrap();
    let result = receive.recv_timeout(Duration::from_millis(200));
    release.send(()).unwrap();
    worker.join().unwrap();
    assert_eq!(result.unwrap(), Err(TransportError::Timeout));
}

#[test]
fn enabling_runtime_trace_never_logs_a_transmitted_credential() {
    struct Capture(std::sync::Mutex<Vec<String>>);
    impl log::Log for Capture {
        fn enabled(&self, _: &log::Metadata<'_>) -> bool {
            true
        }
        fn log(&self, record: &log::Record<'_>) {
            self.0.lock().unwrap().push(record.args().to_string());
        }
        fn flush(&self) {}
    }
    static LOG: Capture = Capture(std::sync::Mutex::new(Vec::new()));
    log::set_logger(&LOG).unwrap();
    log::set_max_level(log::LevelFilter::Trace);
    let stub = Stub::new(200, "", "ok", Duration::ZERO);
    let gate = Gate::local();
    let client = GuardedClient::new(&gate, local_lookup());
    let sentinel = "K9X7".repeat(32);
    let mut request = HttpRequest::get(stub.url("/"));
    request
        .headers
        .push(("Authorization".into(), format!("Bearer {sentinel}")));
    assert!(client.request(request, deadline()).is_ok());
    assert!(stub.requests.lock().unwrap()[0].contains(&sentinel));
    let logs = LOG.0.lock().unwrap().join("\n");
    let compact: String = logs
        .chars()
        .filter(|character| !character.is_whitespace())
        .collect();
    assert!(
        !logs.contains("K9X7"),
        "credential plaintext reached a log sink"
    );
    assert!(
        !compact.to_ascii_lowercase().contains("4b395837"),
        "credential bytes reached a hexadecimal log sink"
    );
    log::set_max_level(log::LevelFilter::Off);
}

#[test]
fn rejected_credentials_are_invalidated_when_headers_arrive_before_the_body() {
    let stub =
        Stub::dynamic_body(|_| (401, String::new(), "{}".into(), Duration::from_millis(200)));
    let rejected = Arc::new(std::sync::atomic::AtomicU64::new(0));
    let mut request = HttpRequest::get(stub.url("/"));
    request.auth_rejection_counter = Some(rejected.clone());
    let client = GuardedClient::new_owned(Arc::new(Gate::local()), local_lookup());
    let worker = std::thread::spawn(move || client.request(request, deadline()));
    let until = Instant::now() + Duration::from_millis(100);
    while rejected.load(Ordering::Acquire) == 0 && Instant::now() < until {
        std::thread::sleep(Duration::from_millis(1));
    }
    let generation = rejected.load(Ordering::Acquire);
    let completed = worker.is_finished();
    assert_eq!(worker.join().unwrap().unwrap().status, 401);
    assert_eq!(generation, 1);
    assert!(
        !completed,
        "the diagnostic body must still be pending when credentials invalidate"
    );
}

fn assert_pending_socket_is_closed(send_headers: bool, explicit_cancel: bool) {
    use plur1bus_engine::contract::{Cancel, CancelReason, Cancelled};
    use std::sync::mpsc;
    let peer = http_stub::StalledPeer::new(send_headers);
    let client = GuardedClient::new_owned(Arc::new(Gate::local()), local_lookup());
    let mut request = HttpRequest::get(peer.stub.url("/cancel"));
    request.method = "POST".into();
    request.body = b"request-body-is-complete-before-cancel".to_vec();
    let cancel = Cancel::never();
    let caller = cancel.clone();
    let expires = Instant::now()
        + if explicit_cancel {
            Duration::from_secs(2)
        } else {
            Duration::from_millis(150)
        };
    let (returned, receive) = mpsc::channel();
    let worker = std::thread::spawn(move || {
        returned
            .send(client.request_cancelled(request, expires, &cancel))
            .unwrap();
    });
    peer.ready.recv_timeout(Duration::from_secs(1)).unwrap();
    assert!(
        peer.stub.requests.lock().unwrap()[0].ends_with("request-body-is-complete-before-cancel")
    );
    let response_by = if explicit_cancel {
        caller.cancel();
        Instant::now() + Duration::from_millis(250)
    } else {
        expires + Duration::from_millis(250)
    };
    let result = receive.recv_timeout(response_by.saturating_duration_since(Instant::now()));
    let disconnected = peer
        .closed
        .recv_timeout(response_by.saturating_duration_since(Instant::now()));
    // Dropping the peer stops its polling reads even when this regression fails.
    drop(peer);
    worker.join().unwrap();
    assert_eq!(
        result.unwrap(),
        Err(if explicit_cancel {
            TransportError::Cancelled(Cancelled {
                reason: CancelReason::Caller,
            })
        } else {
            TransportError::Timeout
        })
    );
    assert_eq!(
        disconnected.unwrap(),
        Ok(()),
        "the real peer must observe EOF/reset before the same response bound"
    );
}

#[test]
fn caller_cancel_closes_a_socket_waiting_for_response_headers() {
    assert_pending_socket_is_closed(false, true);
}

#[test]
fn caller_cancel_closes_a_socket_waiting_for_the_response_body() {
    assert_pending_socket_is_closed(true, true);
}

#[test]
fn an_absolute_deadline_closes_a_socket_waiting_for_response_headers() {
    assert_pending_socket_is_closed(false, false);
}

#[test]
fn an_absolute_deadline_closes_a_socket_waiting_for_the_response_body() {
    assert_pending_socket_is_closed(true, false);
}

#[test]
fn caller_cancel_stops_an_owned_gate_wait_and_discards_its_late_decision() {
    use plur1bus_engine::contract::{Cancel, CancelReason, Cancelled};
    use std::sync::{mpsc, Mutex};
    struct BlockingGate {
        started: mpsc::Sender<()>,
        release: Mutex<mpsc::Receiver<()>>,
        completed: mpsc::Sender<()>,
        calls: AtomicUsize,
    }
    impl EgressGate for BlockingGate {
        fn decide(&self, _: &Target) -> Decision {
            if self.calls.fetch_add(1, Ordering::SeqCst) == 0 {
                self.started.send(()).unwrap();
                self.release.lock().unwrap().recv().unwrap();
                self.completed.send(()).unwrap();
                Decision::Allow {
                    address_rules: AddressRules {
                        allow_loopback: true,
                        ..AddressRules::default()
                    },
                }
            } else {
                Decision::Deny {
                    reason: "updated".into(),
                }
            }
        }
    }
    let stub = Stub::new(200, "", "ok", Duration::ZERO);
    let (started, observe) = mpsc::channel();
    let (release, wait) = mpsc::channel();
    let (completed, finished) = mpsc::channel();
    let gate = Arc::new(BlockingGate {
        started,
        release: Mutex::new(wait),
        completed,
        calls: AtomicUsize::new(0),
    });
    let client = Arc::new(GuardedClient::new_owned(gate.clone(), local_lookup()));
    let cancel = Cancel::never();
    let caller = cancel.clone();
    let request = HttpRequest::get(stub.url("/"));
    let request_client = client.clone();
    let (returned, receive) = mpsc::channel();
    let worker = std::thread::spawn(move || {
        returned
            .send(request_client.request_cancelled(request, deadline(), &cancel))
            .unwrap();
    });
    observe.recv_timeout(Duration::from_secs(1)).unwrap();
    caller.cancel();
    let result = receive.recv_timeout(Duration::from_millis(250));
    release.send(()).unwrap();
    worker.join().unwrap();
    finished.recv_timeout(Duration::from_secs(1)).unwrap();
    assert_eq!(
        result.unwrap(),
        Err(TransportError::Cancelled(Cancelled {
            reason: CancelReason::Caller
        }))
    );
    assert_eq!(
        client.request(HttpRequest::get(stub.url("/")), deadline()),
        Err(TransportError::Denied)
    );
    assert_eq!(gate.calls.load(Ordering::SeqCst), 2);
    assert!(stub.requests.lock().unwrap().is_empty());
}

#[test]
fn caller_cancel_stops_a_dns_wait_and_never_dials_its_late_result() {
    use plur1bus_engine::contract::{Cancel, CancelReason, Cancelled};
    use std::sync::{mpsc, Mutex};
    struct BlockingLookup {
        started: mpsc::Sender<()>,
        release: Mutex<mpsc::Receiver<()>>,
        completed: mpsc::Sender<()>,
    }
    impl Resolver for BlockingLookup {
        fn resolve(&self, _: &str, _: u16, _: Instant) -> Result<Vec<IpAddr>, TransportError> {
            self.started.send(()).unwrap();
            self.release.lock().unwrap().recv().unwrap();
            self.completed.send(()).unwrap();
            Ok(vec![IpAddr::V4(Ipv4Addr::LOCALHOST)])
        }
    }
    let stub = Stub::new(200, "", "ok", Duration::ZERO);
    let (started, observe) = mpsc::channel();
    let (release, wait) = mpsc::channel();
    let (completed, finished) = mpsc::channel();
    let client = GuardedClient::new_owned(
        Arc::new(Gate::local()),
        Box::new(BlockingLookup {
            started,
            release: Mutex::new(wait),
            completed,
        }),
    );
    let cancel = Cancel::never();
    let caller = cancel.clone();
    let request = HttpRequest::get(stub.url("/"));
    let (returned, receive) = mpsc::channel();
    let worker = std::thread::spawn(move || {
        returned
            .send(client.request_cancelled(request, deadline(), &cancel))
            .unwrap();
    });
    observe.recv_timeout(Duration::from_secs(1)).unwrap();
    caller.cancel();
    let result = receive.recv_timeout(Duration::from_millis(250));
    release.send(()).unwrap();
    worker.join().unwrap();
    finished.recv_timeout(Duration::from_secs(1)).unwrap();
    assert_eq!(
        result.unwrap(),
        Err(TransportError::Cancelled(Cancelled {
            reason: CancelReason::Caller
        }))
    );
    assert!(stub.requests.lock().unwrap().is_empty());
}

#[test]
fn cancellation_and_deadline_close_a_socket_during_the_rustls_handshake() {
    use plur1bus_engine::contract::{Cancel, CancelReason, Cancelled};
    use std::io::Read;
    use std::net::TcpListener;
    use std::sync::mpsc;
    for explicit_cancel in [true, false] {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        let (ready, observe) = mpsc::channel();
        let peer = std::thread::spawn(move || {
            let (mut socket, _) = listener.accept().unwrap();
            socket
                .set_read_timeout(Some(Duration::from_secs(1)))
                .unwrap();
            // Consume the actual TLS ClientHello, then leave the handshake pending.
            let mut header = [0; 5];
            socket.read_exact(&mut header).unwrap();
            assert_eq!(header[0], 22);
            let mut hello = vec![0; u16::from_be_bytes([header[3], header[4]]) as usize];
            socket.read_exact(&mut hello).unwrap();
            ready.send(()).unwrap();
            let mut byte = [0];
            match socket.read(&mut byte) {
                Ok(0) => true,
                Err(error) => matches!(
                    error.kind(),
                    std::io::ErrorKind::ConnectionReset | std::io::ErrorKind::ConnectionAborted
                ),
                Ok(_) => false,
            }
        });
        let client = GuardedClient::new_owned(Arc::new(Gate::local()), local_lookup());
        let cancel = Cancel::never();
        let caller = cancel.clone();
        let expires = Instant::now()
            + if explicit_cancel {
                Duration::from_secs(2)
            } else {
                Duration::from_millis(150)
            };
        let (returned, receive) = mpsc::channel();
        let worker = std::thread::spawn(move || {
            returned
                .send(client.request_cancelled(
                    HttpRequest::get(format!("https://provider.test:{port}/")),
                    expires,
                    &cancel,
                ))
                .unwrap();
        });
        observe.recv_timeout(Duration::from_secs(1)).unwrap();
        let response_by = if explicit_cancel {
            caller.cancel();
            Instant::now() + Duration::from_millis(250)
        } else {
            expires + Duration::from_millis(250)
        };
        let result = receive.recv_timeout(response_by.saturating_duration_since(Instant::now()));
        let closed = peer.join().unwrap();
        worker.join().unwrap();
        assert_eq!(
            result.unwrap(),
            Err(if explicit_cancel {
                TransportError::Cancelled(Cancelled {
                    reason: CancelReason::Caller,
                })
            } else {
                TransportError::Timeout
            })
        );
        assert!(
            closed,
            "the rustls handshake's actual TCP socket must close"
        );
    }
}
