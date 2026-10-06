//! `plur1bus memory reembed` against a scripted fake core: flags, output, exit codes, the follow loop and what it asks
//! the core. Unix only (the fake core listens on `run/core.sock`); the Windows named-pipe path is the same client.
#![cfg(unix)]
use assert_cmd::Command;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::io::{BufRead, BufReader, Write};
use std::os::unix::net::UnixListener;
use std::path::Path;
use std::sync::{Arc, Mutex};

type Script = HashMap<String, Vec<Value>>;
struct Stub {
    script: Script,
    log: Vec<(String, Value)>,
}

/// A fake core: `core.auth`, then each scripted method answers its queued results in order (the last one repeats). A
/// result with an `"error"` key is sent as the JSON-RPC error object.
fn spawn(home: &Path, script: Vec<(&str, Vec<Value>)>) -> Arc<Mutex<Stub>> {
    let run = home.join("run");
    std::fs::create_dir_all(&run).unwrap();
    let token = "e".repeat(64);
    std::fs::write(run.join("core.token"), &token).unwrap();
    let listener = UnixListener::bind(run.join("core.sock")).unwrap();
    let stub = Arc::new(Mutex::new(Stub {
        script: script
            .into_iter()
            .map(|(m, v)| (m.to_string(), v))
            .collect(),
        log: vec![],
    }));
    let st = stub.clone();
    std::thread::spawn(move || {
        for stream in listener.incoming() {
            let Ok(stream) = stream else { return };
            let mut w = stream.try_clone().unwrap();
            let r = BufReader::new(stream);
            let (st, token) = (st.clone(), token.clone());
            std::thread::spawn(move || {
                let mut authed = false;
                for line in r.lines() {
                    let Ok(line) = line else { return };
                    let msg: Value = serde_json::from_str(&line).unwrap();
                    let (id, method) = (
                        msg["id"].clone(),
                        msg["method"].as_str().unwrap_or("").to_string(),
                    );
                    let reply = if method == "core.auth" {
                        authed = msg["params"]["token"] == token;
                        let methods: serde_json::Map<String, Value> = [
                            "admin.reembed.plan",
                            "admin.reembed.run",
                            "admin.reembed.status",
                            "admin.reembed.abort",
                        ]
                        .iter()
                        .map(|m| {
                            (
                                m.to_string(),
                                json!({"stability":"experimental","since":"1.5.0"}),
                            )
                        })
                        .collect();
                        json!({"jsonrpc":"2.0","id":id,"result":{"contract":"1.12.0","rpc":"1.5.0","instanceId":"i","pid":1,
                            "capabilities":{"methods":methods,"notifications":{},"extensionPoints":{},"features":[]}}})
                    } else if !authed {
                        json!({"jsonrpc":"2.0","id":id,"error":{"code":-32000,"message":"auth","data":{"error":"E_UNAUTHORIZED","reason":"auth-required"}}})
                    } else {
                        let mut s = st.lock().unwrap();
                        s.log.push((method.clone(), msg["params"].clone()));
                        match s.script.get_mut(&method) {
                            Some(q) => {
                                let v = if q.len() > 1 {
                                    q.remove(0)
                                } else {
                                    q[0].clone()
                                };
                                if v.get("error").is_some() {
                                    json!({"jsonrpc":"2.0","id":id,"error":v["error"]})
                                } else {
                                    json!({"jsonrpc":"2.0","id":id,"result":v})
                                }
                            }
                            None => {
                                json!({"jsonrpc":"2.0","id":id,"error":{"code":-32601,"message":"nope","data":{"error":"E_INTERNAL","reason":"method-not-found"}}})
                            }
                        }
                    };
                    w.write_all(format!("{reply}\n").as_bytes()).unwrap();
                    w.flush().unwrap();
                }
            });
        }
    });
    stub
}

fn cp(phase: &str, rows_done: u64, error: Value) -> Value {
    json!({"v":1,"id":"m1","planDigest":"sha256:x","createdAt":1,"updatedAt":2,"phase":phase,"sourceGeneration":"g0","targetGeneration":"generation-m1",
        "target":{"provider":"local-transformers","model":"jinaai/jina-embeddings-v3","dimensions":1024},
        "counts":{"rows":10,"tables":2,"batches":4,"rowsDone":rows_done,"batchesDone":rows_done/3},"throttleMs":0,"abortRequested":false,"error":error})
}
fn status(phase: &str, rows_done: u64, running: bool, error: Value) -> Value {
    json!({"checkpoint":cp(phase, rows_done, error),"engineState":"running","running":running,
        "progress":{"rows":10,"rowsDone":rows_done,"batches":4,"batchesDone":rows_done/3,"percent":rows_done*10}})
}
fn plan_ok() -> Value {
    json!({"probe":{"verdict":"migration-needed","reasons":["model-changed","dimension-changed"],"changed":["model","dimensions"],"storedId":"a","targetId":"b",
        "message":"the store was embedded with a different identity (model, dimensions); its vectors must be re-embedded before this provider can be used"},
      "plan":{"id":"m1","sourceGeneration":"g0","targetGeneration":"generation-m1","rows":10,"tables":2,"batches":4,"batchSize":3,"providerCalls":10,
        "sourceBytes":2048,"targetBytes":50000,"requiredFreeBytes":62500,"freeBytes":5368709120u64,"throttleMs":250,"minDurationMs":1000,"probeStatus":"passed"}})
}

fn cli(home: &Path) -> Command {
    let mut c = Command::cargo_bin("plur1bus").unwrap();
    c.args(["--home", home.to_str().unwrap()])
        .env("PLUR1BUS_ALLOW_TEST_INTERNALS", "1")
        .env("PLUR1BUS_REEMBED_POLL_MS", "10");
    c
}
fn calls(stub: &Arc<Mutex<Stub>>, method: &str) -> Vec<Value> {
    stub.lock()
        .unwrap()
        .log
        .iter()
        .filter(|(m, _)| m == method)
        .map(|(_, p)| p.clone())
        .collect()
}
fn out_of(a: assert_cmd::assert::Assert) -> (String, String, i32) {
    let o = a.get_output().clone();
    (
        String::from_utf8_lossy(&o.stdout).into_owned(),
        String::from_utf8_lossy(&o.stderr).into_owned(),
        o.status.code().unwrap_or(-1),
    )
}

#[test]
fn plan_prints_the_counts_and_sends_the_flags() {
    let d = tempfile::tempdir().unwrap();
    let stub = spawn(d.path(), vec![("admin.reembed.plan", vec![plan_ok()])]);
    let (stdout, _e, code) = out_of(
        cli(d.path())
            .args([
                "memory",
                "reembed",
                "--plan",
                "--model",
                "jinaai/jina-embeddings-v3",
                "--throttle-ms",
                "250",
                "--dimensions",
                "1024",
            ])
            .assert(),
    );
    assert_eq!(code, 0, "{stdout}");
    for want in [
        "migration-needed",
        "model-changed, dimension-changed",
        "10 rows in 2 tables",
        "4 batches of up to 3",
        "10 provider calls",
        "2.0 KiB",
        "250 ms",
        "g0 (kept) -> generation-m1",
        "memory reembed --run",
    ] {
        assert!(stdout.contains(want), "{want} missing in:\n{stdout}");
    }
    assert_eq!(
        calls(&stub, "admin.reembed.plan"),
        vec![json!({"model":"jinaai/jina-embeddings-v3","dimensions":1024,"throttleMs":250})]
    );
}

#[test]
fn plan_json_is_the_raw_value_with_a_schema_id() {
    let d = tempfile::tempdir().unwrap();
    spawn(d.path(), vec![("admin.reembed.plan", vec![plan_ok()])]);
    let (stdout, _e, code) = out_of(
        cli(d.path())
            .args(["--json", "memory", "reembed", "--plan", "--model", "m"])
            .assert(),
    );
    assert_eq!(code, 0);
    let v: Value = serde_json::from_str(&stdout).unwrap();
    assert_eq!(v["schema"], "memory.reembed.plan/1");
    assert_eq!(v["plan"]["rows"], 10);
    assert_eq!(v["probe"]["verdict"], "migration-needed");
}

#[test]
fn an_incompatible_model_is_refused_with_its_reasons_and_exit_1() {
    let d = tempfile::tempdir().unwrap();
    spawn(
        d.path(),
        vec![(
            "admin.reembed.plan",
            vec![
                json!({"probe":{"verdict":"incompatible","reasons":["target-model-unpinned"],"changed":[],"storedId":null,"targetId":null,
        "message":"the target model is not a pinned local embedding model the harness can run"},"plan":null}),
            ],
        )],
    );
    let (stdout, _e, code) = out_of(
        cli(d.path())
            .args(["memory", "reembed", "--plan", "--model", "x/unpinned"])
            .assert(),
    );
    assert_eq!(code, 1);
    assert!(
        stdout.contains("incompatible")
            && stdout.contains("target-model-unpinned")
            && stdout.contains("not a pinned local embedding model"),
        "{stdout}"
    );
}

#[test]
fn a_compatible_store_says_there_is_nothing_to_migrate() {
    let d = tempfile::tempdir().unwrap();
    spawn(
        d.path(),
        vec![(
            "admin.reembed.plan",
            vec![
                json!({"probe":{"verdict":"compatible","reasons":[],"changed":[],"storedId":"a","targetId":"a","message":"the store's embedding identity matches the configured provider"},"plan":null}),
            ],
        )],
    );
    let (stdout, _e, code) = out_of(
        cli(d.path())
            .args(["memory", "reembed", "--plan", "--model", "m"])
            .assert(),
    );
    assert_eq!(code, 0);
    assert!(stdout.contains("nothing to migrate"), "{stdout}");
}

#[test]
fn status_without_and_with_a_migration() {
    let d = tempfile::tempdir().unwrap();
    spawn(
        d.path(),
        vec![(
            "admin.reembed.status",
            vec![
                json!({"checkpoint":null,"engineState":null,"running":false,"progress":{"rows":0,"rowsDone":0,"batches":0,"batchesDone":0,"percent":0}}),
            ],
        )],
    );
    let (stdout, _e, code) = out_of(
        cli(d.path())
            .args(["memory", "reembed", "--status"])
            .assert(),
    );
    assert_eq!(code, 0);
    assert!(stdout.contains("no re-embedding migration"), "{stdout}");

    let d2 = tempfile::tempdir().unwrap();
    spawn(
        d2.path(),
        vec![(
            "admin.reembed.status",
            vec![status("aborted", 6, false, Value::Null)],
        )],
    );
    let (stdout, _e, code) = out_of(
        cli(d2.path())
            .args(["memory", "reembed", "--status"])
            .assert(),
    );
    assert_eq!(code, 0);
    assert!(
        stdout.contains("aborted")
            && stdout.contains("6/10 rows")
            && stdout.contains("resume: plur1bus memory reembed --run"),
        "{stdout}"
    );
}

#[test]
fn run_without_a_plan_is_refused_and_starts_nothing() {
    let d = tempfile::tempdir().unwrap();
    let stub = spawn(
        d.path(),
        vec![(
            "admin.reembed.status",
            vec![
                json!({"checkpoint":null,"engineState":null,"running":false,"progress":{"rows":0,"rowsDone":0,"batches":0,"batchesDone":0,"percent":0}}),
            ],
        )],
    );
    let (stdout, _e, code) = out_of(
        cli(d.path())
            .args(["--json", "memory", "reembed", "--run", "--yes"])
            .assert(),
    );
    assert_eq!(code, 1);
    let v: Value = serde_json::from_str(&stdout).unwrap();
    assert_eq!(v["error"], "E_NOT_FOUND");
    assert_eq!(v["reason"], "no-migration");
    assert!(calls(&stub, "admin.reembed.run").is_empty());
}

#[test]
fn run_needs_a_confirmation_outside_a_terminal_and_asks_before_starting() {
    let d = tempfile::tempdir().unwrap();
    let stub = spawn(
        d.path(),
        vec![
            (
                "admin.reembed.status",
                vec![status("planned", 0, false, Value::Null)],
            ),
            (
                "admin.reembed.run",
                vec![json!({"checkpoint":cp("running",0,Value::Null)})],
            ),
        ],
    );
    let (_o, stderr, code) = out_of(cli(d.path()).args(["memory", "reembed", "--run"]).assert());
    assert_eq!(code, 2);
    assert!(
        stderr.contains("re-embed 10 rows into jinaai/jina-embeddings-v3")
            && stderr.contains("--yes"),
        "{stderr}"
    );
    assert!(
        calls(&stub, "admin.reembed.run").is_empty(),
        "nothing started without the yes"
    );
}

#[test]
fn run_follows_to_the_switch_and_exits_0() {
    let d = tempfile::tempdir().unwrap();
    let stub = spawn(
        d.path(),
        vec![
            (
                "admin.reembed.status",
                vec![
                    status("planned", 0, false, Value::Null), // the look before asking
                    status("running", 3, true, Value::Null),
                    status("running", 9, true, Value::Null),
                    status("ready-to-switch", 10, false, Value::Null), // the loop is over, the switch not yet made
                    status("switched", 10, false, Value::Null),
                ],
            ),
            (
                "admin.reembed.run",
                vec![json!({"checkpoint":cp("running",0,Value::Null)})],
            ),
        ],
    );
    let (stdout, stderr, code) = out_of(
        cli(d.path())
            .args(["memory", "reembed", "--run", "--yes"])
            .assert(),
    );
    assert_eq!(code, 0, "{stdout}\n{stderr}");
    assert_eq!(
        calls(&stub, "admin.reembed.run"),
        vec![json!({"switch":true})]
    );
    assert!(
        stdout.contains("switched") && stdout.contains("old generation is kept"),
        "{stdout}"
    );
    assert!(
        stderr.contains("running: 3/10 rows") && stderr.contains("running: 9/10 rows"),
        "progress on stderr:\n{stderr}"
    );
}

#[test]
fn run_json_prints_one_final_document() {
    let d = tempfile::tempdir().unwrap();
    spawn(
        d.path(),
        vec![
            (
                "admin.reembed.status",
                vec![
                    status("planned", 0, false, Value::Null),
                    status("running", 5, true, Value::Null),
                    status("switched", 10, false, Value::Null),
                ],
            ),
            (
                "admin.reembed.run",
                vec![json!({"checkpoint":cp("running",0,Value::Null)})],
            ),
        ],
    );
    let (stdout, stderr, code) = out_of(
        cli(d.path())
            .args(["--json", "memory", "reembed", "--run", "--yes"])
            .assert(),
    );
    assert_eq!(code, 0);
    assert!(stderr.is_empty(), "no progress noise with --json: {stderr}");
    let v: Value = serde_json::from_str(&stdout).unwrap();
    assert_eq!(v["schema"], "memory.reembed.run/1");
    assert_eq!(v["checkpoint"]["phase"], "switched");
}

#[test]
fn no_switch_stops_at_ready_to_switch_with_exit_0() {
    let d = tempfile::tempdir().unwrap();
    let stub = spawn(
        d.path(),
        vec![
            (
                "admin.reembed.status",
                vec![
                    status("planned", 0, false, Value::Null),
                    status("running", 5, true, Value::Null),
                    status("ready-to-switch", 10, false, Value::Null),
                ],
            ),
            (
                "admin.reembed.run",
                vec![json!({"checkpoint":cp("running",0,Value::Null)})],
            ),
        ],
    );
    let (stdout, _e, code) = out_of(
        cli(d.path())
            .args(["memory", "reembed", "--run", "--yes", "--no-switch"])
            .assert(),
    );
    assert_eq!(code, 0, "{stdout}");
    assert_eq!(
        calls(&stub, "admin.reembed.run"),
        vec![json!({"switch":false})]
    );
    assert!(stdout.contains("ready-to-switch"), "{stdout}");
}

#[test]
fn no_wait_returns_after_starting() {
    let d = tempfile::tempdir().unwrap();
    let stub = spawn(
        d.path(),
        vec![
            (
                "admin.reembed.status",
                vec![status("planned", 0, false, Value::Null)],
            ),
            (
                "admin.reembed.run",
                vec![json!({"checkpoint":cp("running",0,Value::Null)})],
            ),
        ],
    );
    let (stdout, _e, code) = out_of(
        cli(d.path())
            .args(["memory", "reembed", "--run", "--yes", "--no-wait"])
            .assert(),
    );
    assert_eq!(code, 0);
    assert!(
        stdout.contains("started migration m1") && stdout.contains("--status"),
        "{stdout}"
    );
    assert_eq!(
        calls(&stub, "admin.reembed.status").len(),
        1,
        "no following"
    );
}

#[test]
fn a_halted_run_exits_1_and_prints_why() {
    let d = tempfile::tempdir().unwrap();
    spawn(
        d.path(),
        vec![
            (
                "admin.reembed.status",
                vec![
                    status("planned", 0, false, Value::Null),
                    status(
                        "aborted",
                        6,
                        false,
                        json!({"code":"engine-error","message":"provider exploded"}),
                    ),
                ],
            ),
            (
                "admin.reembed.run",
                vec![json!({"checkpoint":cp("running",0,Value::Null)})],
            ),
        ],
    );
    let (stdout, _e, code) = out_of(
        cli(d.path())
            .args(["memory", "reembed", "--run", "--yes"])
            .assert(),
    );
    assert_eq!(code, 1);
    assert!(
        stdout.contains("aborted")
            && stdout.contains("engine-error: provider exploded")
            && stdout.contains("resume:"),
        "{stdout}"
    );
}

#[test]
fn validating_without_an_engine_validate_exits_1() {
    let d = tempfile::tempdir().unwrap();
    spawn(
        d.path(),
        vec![
            (
                "admin.reembed.status",
                vec![
                    status("planned", 0, false, Value::Null),
                    status(
                        "validating",
                        10,
                        false,
                        json!({"code":"engine-validate-unavailable","message":"the engine does not expose generation validation"}),
                    ),
                ],
            ),
            (
                "admin.reembed.run",
                vec![json!({"checkpoint":cp("running",0,Value::Null)})],
            ),
        ],
    );
    let (stdout, _e, code) = out_of(
        cli(d.path())
            .args(["memory", "reembed", "--run", "--yes"])
            .assert(),
    );
    assert_eq!(code, 1);
    assert!(stdout.contains("engine-validate-unavailable"), "{stdout}");
}

#[test]
fn abort_reports_where_it_stopped() {
    let d = tempfile::tempdir().unwrap();
    spawn(
        d.path(),
        vec![(
            "admin.reembed.abort",
            vec![json!({"checkpoint":cp("aborted",6,Value::Null)})],
        )],
    );
    let (stdout, _e, code) = out_of(
        cli(d.path())
            .args(["memory", "reembed", "--abort"])
            .assert(),
    );
    assert_eq!(code, 0);
    assert!(
        stdout.contains("aborted") && stdout.contains("6/10 rows") && stdout.contains("resume:"),
        "{stdout}"
    );
    let (j, _e, _c) = out_of(
        cli(d.path())
            .args(["--json", "memory", "reembed", "--abort"])
            .assert(),
    );
    assert_eq!(
        serde_json::from_str::<Value>(&j).unwrap()["schema"],
        "memory.reembed.abort/1"
    );
}

#[test]
fn a_core_that_refuses_is_reported_with_its_code() {
    let d = tempfile::tempdir().unwrap();
    spawn(
        d.path(),
        vec![(
            "admin.reembed.abort",
            vec![
                json!({"error":{"code":-32000,"message":"migration is already switched","data":{"error":"E_CONFLICT","reason":"not-abortable"}}}),
            ],
        )],
    );
    let (stdout, _e, code) = out_of(
        cli(d.path())
            .args(["--json", "memory", "reembed", "--abort"])
            .assert(),
    );
    assert_ne!(code, 0);
    let v: Value = serde_json::from_str(&stdout).unwrap();
    assert_eq!(v["error"], "E_CONFLICT");
    assert_eq!(v["reason"], "not-abortable");
}

#[test]
fn no_core_is_core_unavailable() {
    let d = tempfile::tempdir().unwrap();
    let (stdout, _e, code) = out_of(
        cli(d.path())
            .args(["--json", "memory", "reembed", "--status"])
            .assert(),
    );
    assert_eq!(code, 1);
    assert_eq!(
        serde_json::from_str::<Value>(&stdout).unwrap()["error"],
        "E_CORE_UNAVAILABLE"
    );
}

#[test]
fn flags_are_exclusive_and_scoped() {
    let d = tempfile::tempdir().unwrap();
    for args in [
        vec!["memory", "reembed"],
        vec!["memory", "reembed", "--plan"], // --model required
        vec!["memory", "reembed", "--run", "--plan", "--model", "m"], // one action
        vec!["memory", "reembed", "--status", "--yes"], // --yes belongs to --run
        vec!["memory", "reembed", "--run", "--model", "m"], // --model belongs to --plan
    ] {
        let (_o, _e, code) = out_of(cli(d.path()).args(&args).assert());
        assert_eq!(code, 2, "{args:?}");
    }
}
