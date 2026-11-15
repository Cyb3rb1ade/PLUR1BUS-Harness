//! The `config.watch` client against a fake supervisor on a real socket (or pipe): the handshake, the snapshot, pushes
//! right behind the reply and later, `config.set`, and every way an attempt ends without a watch.
#![allow(clippy::unwrap_used, clippy::expect_used)]
use super::*;
use plur1bus_rpc::server_transport::{Accepted, Listener};
use std::io::{BufRead, BufReader, Write};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::mpsc;

const TOKEN: &str = "5f1d7c0e9a3b4d62885e0f6a1c2b3d4e5f60718293a4b5c6d7e8f9a0b1c2d3e4";

type Out = Arc<Mutex<Box<dyn Write + Send>>>;

/// What the fake does with `config.watch`.
#[derive(Clone)]
enum OnWatch {
    /// The reply, and these pushes in the same write.
    Reply(Value, Vec<Value>),
    /// The reply after this long.
    Late(Duration, Value),
}

struct Fake {
    home: tempfile::TempDir,
    /// The writer and the closer of each accepted connection, in order.
    conns: mpsc::Receiver<(Out, Arc<dyn Fn() + Send + Sync>)>,
    accepted: Arc<AtomicUsize>,
    sets: Arc<Mutex<Vec<Value>>>,
}

fn line(out: &Out, values: &[Value]) {
    let text: String = values.iter().map(|v| format!("{v}\n")).collect();
    let mut out = out.lock().unwrap();
    let _ = out.write_all(text.as_bytes());
    let _ = out.flush();
}

#[allow(clippy::needless_pass_by_value)] // callers build the configuration in place
fn changed(config: Value, revision: &str, previous: &str) -> Value {
    json!({"jsonrpc":"2.0","method":"config.changed","params":{
        "config": config, "revision": revision, "previousRevision": previous,
        "changed": [], "restart": {"live": [], "core": false, "modules": []}, "source": "set"}})
}

impl Fake {
    /// A home with `run/supervisor.token`, `run/supervisor.pid` and a listening fake.
    fn start(on_watch: OnWatch) -> Fake {
        let home = tempfile::tempdir_in(std::env::temp_dir().canonicalize().unwrap()).unwrap();
        let run = home.path().join("run");
        std::fs::create_dir(&run).unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&run, std::fs::Permissions::from_mode(0o700)).unwrap();
        }
        std::fs::write(run.join("supervisor.token"), format!("{TOKEN}\n")).unwrap();
        std::fs::write(
            run.join("supervisor.pid"),
            format!(
                "{} 00000000-0000-4000-8000-000000000001\n",
                std::process::id()
            ),
        )
        .unwrap();
        let listener = Listener::bind(&run_files::unit_address(
            home.path(),
            "supervisor",
            cfg!(windows),
        ))
        .unwrap();
        let (tx, conns) = mpsc::channel();
        let accepted = Arc::new(AtomicUsize::new(0));
        let sets = Arc::new(Mutex::new(Vec::new()));
        {
            let (accepted, sets) = (Arc::clone(&accepted), Arc::clone(&sets));
            std::thread::spawn(move || {
                while let Ok(conn) = listener.accept() {
                    accepted.fetch_add(1, Ordering::SeqCst);
                    let Accepted {
                        reader,
                        writer,
                        closer,
                        ..
                    } = conn;
                    let out: Out = Arc::new(Mutex::new(writer));
                    if tx.send((Arc::clone(&out), closer)).is_err() {
                        return;
                    }
                    let (on_watch, sets) = (on_watch.clone(), Arc::clone(&sets));
                    std::thread::spawn(move || {
                        serve(BufReader::new(reader), &out, &on_watch, &sets)
                    });
                }
            });
        }
        Fake {
            home,
            conns,
            accepted,
            sets,
        }
    }

    fn conn(&self) -> (Out, Arc<dyn Fn() + Send + Sync>) {
        self.conns.recv_timeout(Duration::from_secs(3)).unwrap()
    }
}

fn serve(reader: impl BufRead, out: &Out, on_watch: &OnWatch, sets: &Mutex<Vec<Value>>) {
    for text in reader.lines() {
        let Ok(text) = text else { return };
        let msg: Value = serde_json::from_str(&text).unwrap();
        let reply = |result: Value| json!({"jsonrpc":"2.0","id":msg["id"],"result":result});
        match msg["method"].as_str().unwrap() {
            "supervisor.auth" => {
                if msg["params"]["token"] == TOKEN {
                    // The contract fixture's hello, as this process.
                    let fixture: Value = serde_json::from_str(include_str!(
                        "../../../../packages/rpc-schema/fixtures/methods/supervisor.auth.json"
                    ))
                    .unwrap();
                    let mut hello = fixture["result"].clone();
                    hello["rpc"] = json!(plur1bus_rpc::RPC_VERSION);
                    hello["pid"] = json!(std::process::id());
                    line(out, &[reply(hello)]);
                } else {
                    line(
                        out,
                        &[
                            json!({"jsonrpc":"2.0","id":msg["id"],"error":{"code":-32000,"message":"bad token","data":{"error":"E_UNAUTHORIZED","reason":"bad-token"}}}),
                        ],
                    );
                    return;
                }
            }
            "config.watch" => match on_watch {
                OnWatch::Reply(result, pushes) => {
                    let mut all = vec![reply(result.clone())];
                    all.extend(pushes.iter().cloned());
                    line(out, &all);
                }
                OnWatch::Late(delay, result) => {
                    std::thread::sleep(*delay);
                    line(out, &[reply(result.clone())]);
                }
            },
            "config.set" => {
                sets.lock().unwrap().push(msg["params"].clone());
                if msg["params"]["changes"][0]["key"] == "refused" {
                    line(
                        out,
                        &[
                            json!({"jsonrpc":"2.0","id":msg["id"],"error":{"code":-32000,"message":"invalid configuration","data":{"error":"E_INVALID_PARAMS","reason":"config-invalid"}}}),
                        ],
                    );
                } else {
                    line(out, &[reply(json!({"revision": "r-set"}))]);
                }
            }
            other => panic!("unexpected {other}"),
        }
    }
}

fn snapshot(level: &str, revision: &str) -> Value {
    json!({"subscriptionId": "s1", "config": {"core": {"logLevel": level}}, "revision": revision})
}

fn level(config: &Value) -> &str {
    config["core"]["logLevel"].as_str().unwrap()
}

fn until(what: &str, pred: impl Fn() -> bool) {
    let deadline = Instant::now() + Duration::from_secs(3);
    while !pred() {
        assert!(Instant::now() < deadline, "not in time: {what}");
        std::thread::sleep(Duration::from_millis(5));
    }
}

fn watch(fake: &Fake) -> Arc<SupervisorWatch> {
    watch_supervisor_config(fake.home.path(), Some(1), Some(Duration::from_secs(2)))
        .unwrap_or_else(|e| panic!("no watch: {e}"))
}

#[test]
fn a_watch_holds_the_snapshot_and_the_pushes_that_came_right_behind_it() {
    let fake = Fake::start(OnWatch::Reply(
        snapshot("info", "r1"),
        vec![
            // The snapshot itself, pushed again, is not a change.
            changed(json!({"core": {"logLevel": "info"}}), "r1", "r0"),
            changed(json!({"core": {"logLevel": "warn"}}), "r2", "r1"),
            changed(json!({"core": {"logLevel": "error"}}), "r3", "r2"),
        ],
    ));
    let watch = watch(&fake);
    until("the buffered pushes", || watch.revision() == "r3");
    let (config, revision) = watch.snapshot();
    assert_eq!((level(&config), revision.as_str()), ("error", "r3"));
    assert!(!watch.ended());
    watch.close();
}

#[test]
fn the_snapshot_alone_is_the_configuration_when_nothing_follows() {
    let fake = Fake::start(OnWatch::Reply(snapshot("debug", "r7"), vec![]));
    let watch = watch(&fake);
    let (config, revision) = watch.snapshot();
    assert_eq!((level(&config), revision.as_str()), ("debug", "r7"));
    watch.close();
}

#[test]
fn a_later_push_reaches_every_listener_in_order_and_an_unsubscribed_one_no_more() {
    let fake = Fake::start(OnWatch::Reply(snapshot("info", "r1"), vec![]));
    let watch = watch(&fake);
    let (out, _closer) = fake.conn();
    let seen = Arc::new(Mutex::new(Vec::<String>::new()));
    let listen = |tag: &'static str| {
        let seen = Arc::clone(&seen);
        watch.on_change(Box::new(move |c: &ConfigChanged| {
            seen.lock().unwrap().push(format!("{tag}:{}", c.revision));
        }))
    };
    let _panics = watch.on_change(Box::new(|_| panic!("a listener that fails")));
    let off_a = listen("a");
    let _b = listen("b");
    line(
        &out,
        &[changed(json!({"core": {"logLevel": "warn"}}), "r2", "r1")],
    );
    until("r2", || seen.lock().unwrap().len() == 2);
    // The watch holds the pushed configuration before its listeners hear of it.
    assert_eq!(watch.revision(), "r2");
    off_a();
    // A push without a configuration object or a revision string is not one; another notification is not ours.
    line(
        &out,
        &[
            json!({"jsonrpc":"2.0","method":"config.changed","params":{"config":"x","revision":"bad"}}),
            json!({"jsonrpc":"2.0","method":"config.changed","params":{"config":{},"revision":7}}),
            json!({"jsonrpc":"2.0","method":"core.state","params":{"config":{},"revision":"other"}}),
            changed(json!({"core": {"logLevel": "error"}}), "r3", "r2"),
        ],
    );
    until("r3", || seen.lock().unwrap().len() == 3);
    assert_eq!(*seen.lock().unwrap(), ["a:r2", "b:r2", "b:r3"]);
    assert_eq!(level(&watch.snapshot().0), "error");
    watch.close();
}

#[test]
fn the_end_of_the_connection_calls_each_close_listener_once_and_none_registered_after_it() {
    let fake = Fake::start(OnWatch::Reply(snapshot("info", "r1"), vec![]));
    let watch = watch(&fake);
    let (_out, closer) = fake.conn();
    let calls = Arc::new(AtomicUsize::new(0));
    let count = || {
        let calls = Arc::clone(&calls);
        Box::new(move || {
            calls.fetch_add(1, Ordering::SeqCst);
        })
    };
    let _kept = watch.on_close(count());
    let off = watch.on_close(count());
    off();
    assert!(!watch.ended());
    // The supervisor drops the connection.
    closer();
    until("the end", || watch.ended());
    until("the listener", || calls.load(Ordering::SeqCst) == 1);
    // Registered after the end: not called; `ended` is what the source asks.
    let _late = watch.on_close(count());
    watch.close();
    std::thread::sleep(Duration::from_millis(50));
    assert_eq!(calls.load(Ordering::SeqCst), 1);
    // The snapshot stays readable; a write is refused with the transport's reason.
    assert_eq!(watch.revision(), "r1");
    let refused = watch
        .set(&[Change {
            key: "core.logLevel".into(),
            value: json!("warn"),
        }])
        .unwrap_err();
    assert_eq!(refused.0["error"], "E_CORE_UNAVAILABLE");
    assert_eq!(refused.0["reason"], "closed");
}

#[test]
fn set_sends_the_changes_and_returns_the_result_or_the_refusal() {
    let fake = Fake::start(OnWatch::Reply(snapshot("info", "r1"), vec![]));
    let watch = watch(&fake);
    let result = watch
        .set(&[
            Change {
                key: "core.logLevel".into(),
                value: json!("warn"),
            },
            Change {
                key: "logs.keep".into(),
                value: json!(3),
            },
        ])
        .unwrap();
    assert_eq!(result, json!({"revision": "r-set"}));
    assert_eq!(
        *fake.sets.lock().unwrap(),
        [
            json!({"changes": [{"key": "core.logLevel", "value": "warn"}, {"key": "logs.keep", "value": 3}]})
        ]
    );
    let refused = watch
        .set(&[Change {
            key: "refused".into(),
            value: Value::Null,
        }])
        .unwrap_err();
    assert_eq!(refused.0["error"], "E_INVALID_PARAMS");
    assert_eq!(refused.0["reason"], "config-invalid");
    // A refusal leaves the subscription alive; the run-bound write is not offered.
    assert!(!watch.ended());
    assert!(watch.set_during_import(&json!({}), &[]).is_none());
    watch.close();
}

#[test]
fn a_wrong_token_a_missing_token_or_no_supervisor_is_no_watch() {
    let fake = Fake::start(OnWatch::Reply(snapshot("info", "r1"), vec![]));
    let run = fake.home.path().join("run");
    let attempt_once =
        || watch_supervisor_config(fake.home.path(), Some(1), Some(Duration::from_millis(500)));
    std::fs::write(run.join("supervisor.token"), "0".repeat(64)).unwrap();
    assert_eq!(attempt_once().err().unwrap().code_name(), "E_UNAUTHORIZED");
    std::fs::remove_file(run.join("supervisor.token")).unwrap();
    let before = fake.accepted.load(Ordering::SeqCst);
    let missing = attempt_once().err().unwrap();
    assert!(
        matches!(&missing, RpcError::Unavailable { reason, .. } if reason == "supervisor-token"),
        "{missing}"
    );
    // Without a token nothing is connected.
    assert_eq!(fake.accepted.load(Ordering::SeqCst), before);
    // A home without a supervisor: every attempt takes its timeout, the series takes two of them at least.
    let empty = tempfile::tempdir_in(std::env::temp_dir().canonicalize().unwrap()).unwrap();
    std::fs::create_dir(empty.path().join("run")).unwrap();
    std::fs::write(empty.path().join("run/supervisor.token"), TOKEN).unwrap();
    let start = Instant::now();
    assert!(
        watch_supervisor_config(empty.path(), Some(3), Some(Duration::from_millis(60))).is_err()
    );
    assert!(
        start.elapsed() >= Duration::from_millis(120),
        "{:?}",
        start.elapsed()
    );
    assert!((connector(empty.path()))(Some(1), Some(Duration::from_millis(20))).is_none());
}

#[test]
fn a_reply_after_the_attempts_deadline_is_no_watch_and_its_connection_is_closed() {
    let fake = Fake::start(OnWatch::Late(
        Duration::from_millis(400),
        snapshot("info", "r1"),
    ));
    let start = Instant::now();
    let late = watch_supervisor_config(fake.home.path(), Some(1), Some(Duration::from_millis(100)))
        .err()
        .unwrap();
    assert!(
        start.elapsed() < Duration::from_millis(350),
        "{:?}",
        start.elapsed()
    );
    assert!(
        matches!(&late, RpcError::Unavailable { reason, .. } if reason == "call-timeout"),
        "{late}"
    );
    // The fake's late reply meets a closed connection: writing to it fails or goes nowhere, and a new attempt with
    // time enough gets a watch of its own.
    let watch =
        watch_supervisor_config(fake.home.path(), Some(1), Some(Duration::from_secs(2))).unwrap();
    assert_eq!(watch.revision(), "r1");
    assert_eq!(fake.accepted.load(Ordering::SeqCst), 2);
    watch.close();
}

#[test]
fn a_pid_file_that_names_another_process_is_only_checked_where_the_os_can() {
    // Unix trusts the socket's directory, owner and peer uid; the recorded pid is the Windows pipe check (ruling S11).
    let fake = Fake::start(OnWatch::Reply(snapshot("info", "r1"), vec![]));
    std::fs::write(fake.home.path().join("run/supervisor.pid"), "1 x\n").unwrap();
    let result =
        watch_supervisor_config(fake.home.path(), Some(1), Some(Duration::from_millis(500)));
    if cfg!(windows) {
        assert_eq!(result.err().unwrap().code_name(), "E_UNAUTHORIZED");
    } else {
        result.unwrap().close();
    }
    assert_eq!(
        recorded_pid(&fake.home.path().join("run/supervisor.pid")),
        Some(1)
    );
    std::fs::write(fake.home.path().join("run/supervisor.pid"), "0 x\n").unwrap();
    assert_eq!(
        recorded_pid(&fake.home.path().join("run/supervisor.pid")),
        None
    );
    assert_eq!(recorded_pid(&fake.home.path().join("run/none.pid")), None);
}

/// The source follows the real client: the supervisor's snapshot, a push, and the file once the supervisor is gone.
#[test]
fn the_configuration_source_follows_a_supervisor_through_this_client() {
    use crate::config::source::{Backoff, ConfigSource, ConfigSourceOptions, SourceKind};
    let mut on_disk = plur1bus_config::defaults();
    on_disk["core"]["logLevel"] = json!("warn");
    let mut watched = on_disk.clone();
    watched["core"]["logLevel"] = json!("debug");
    let mut pushed = on_disk.clone();
    pushed["core"]["logLevel"] = json!("error");
    let fake = Fake::start(OnWatch::Reply(
        json!({"subscriptionId": "s1", "config": watched, "revision": "r1"}),
        vec![],
    ));
    let config_path = fake.home.path().join("config.json");
    std::fs::write(&config_path, on_disk.to_string()).unwrap();
    let mut o = ConfigSourceOptions::new(&config_path, true);
    o.connect = Some(connector(fake.home.path()));
    o.attempts = Some(1);
    o.connect_timeout = Some(Duration::from_millis(500));
    o.file_poll = Some(Duration::from_millis(20));
    o.rewatch = Some(Backoff {
        initial: Duration::from_secs(30),
        max: Duration::from_secs(30),
    });
    let source = ConfigSource::open(o).unwrap();
    assert_eq!(source.source(), SourceKind::Supervisor);
    assert_eq!(source.current()["core"]["logLevel"], "debug");
    let (out, closer) = fake.conn();
    line(&out, &[changed(pushed, "r2", "r1")]);
    until("the push", || {
        source.current()["core"]["logLevel"] == "error"
    });
    assert_eq!(source.revision().as_deref(), Some("r2"));
    closer();
    until("the file", || source.source() == SourceKind::File);
    // The loss is published first, then config.json is read.
    until("the file's level", || {
        source.current()["core"]["logLevel"] == "warn"
    });
    assert_eq!(source.revision(), None);
    source.close();
}
