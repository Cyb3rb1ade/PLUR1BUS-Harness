use assert_cmd::Command;
use predicates::prelude::*;

fn bin() -> Command {
    Command::cargo_bin("plur1bus").unwrap()
}

#[test]
fn help_lists_the_2a_commands() {
    bin()
        .arg("--help")
        .assert()
        .success()
        .stdout(predicate::str::contains("1staid"))
        .stdout(predicate::str::contains("memory"))
        .stdout(predicate::str::contains("dreams"))
        .stdout(predicate::str::contains("config"))
        .stdout(predicate::str::contains("agent"))
        .stdout(predicate::str::contains("core"));
}

#[test]
fn stubs_exit_2_and_name_their_milestone() {
    for (cmd, milestone) in [
        ("login", "M2"),
        ("model", "M2"),
        ("channel", "M4"),
        ("user", "M2"),
        ("project", "M3"),
        ("import", "M1b-3"),
        ("uninstall", "M8"),
    ] {
        bin()
            .arg(cmd)
            .assert()
            .code(2)
            .stderr(predicate::str::contains(milestone));
        let out = bin()
            .args(["--json", cmd])
            .assert()
            .code(2)
            .get_output()
            .stdout
            .clone();
        let v: serde_json::Value = serde_json::from_slice(&out).unwrap();
        assert_eq!(v["error"], "E_NOT_AVAILABLE");
        assert_eq!(v["milestone"], milestone);
    }
}

#[test]
fn stubs_name_2a_h3() {
    for cmd in ["setup", "module", "daemon", "service", "update", "1staid"] {
        bin().arg(cmd).arg("--help").assert().success();
    }
    bin()
        .args(["daemon", "status"])
        .assert()
        .code(2)
        .stderr(predicate::str::contains("2a-H3"));
    let out = bin()
        .args(["--json", "daemon", "status"])
        .assert()
        .code(2)
        .get_output()
        .stdout
        .clone();
    let v: serde_json::Value = serde_json::from_slice(&out).unwrap();
    assert_eq!(v["milestone"], "2a-H3");
}

#[test]
fn home_flag_beats_env() {
    let dir = tempfile::tempdir().unwrap();
    let out = bin()
        .env("PLUR1BUS_HOME", "/elsewhere")
        .args([
            "--json",
            "--home",
            dir.path().to_str().unwrap(),
            "config",
            "get",
            "core.logLevel",
        ])
        .assert()
        .success()
        .get_output()
        .stdout
        .clone();
    let v: serde_json::Value = serde_json::from_slice(&out).unwrap();
    assert_eq!(v["value"], "info");
    assert!(
        dir.path().join("config.json").exists(),
        "config get creates defaults under --home"
    );
}

#[test]
fn agent_create_list_remove_without_a_core() {
    let dir = tempfile::tempdir().unwrap();
    let h = dir.path().to_str().unwrap();
    bin()
        .args(["--home", h, "agent", "create", "Bernd"])
        .assert()
        .code(1)
        .stderr(predicate::str::contains("must match"));
    bin()
        .args(["--home", h, "agent", "create", "bernd"])
        .assert()
        .success()
        .stdout(predicate::str::contains("created agent bernd"));
    assert!(dir.path().join("agents/bernd/workspace").is_dir());
    let cfg: serde_json::Value =
        serde_json::from_str(&std::fs::read_to_string(dir.path().join("config.json")).unwrap())
            .unwrap();
    assert!(cfg["agents"]["bernd"]["createdAt"]
        .as_str()
        .unwrap()
        .ends_with('Z'));
    bin()
        .args(["--home", h, "agent", "create", "bernd"])
        .assert()
        .code(1);
    let out = bin()
        .args(["--json", "--home", h, "agent", "list"])
        .assert()
        .success()
        .get_output()
        .stdout
        .clone();
    let v: serde_json::Value = serde_json::from_slice(&out).unwrap();
    assert_eq!(v["agents"][0]["agentId"], "bernd");
    assert_eq!(v["core"], "unavailable");
    bin()
        .args(["--home", h, "agent", "status", "bernd"])
        .assert()
        .success()
        .stdout(predicate::str::contains("core unavailable"));
    bin()
        .args(["--home", h, "agent", "remove", "bernd"])
        .assert()
        .success();
    assert!(
        dir.path().join("agents/bernd").is_dir(),
        "data left in place"
    );
    bin()
        .args(["--home", h, "agent", "status", "bernd"])
        .assert()
        .code(1);
}

#[test]
fn config_get_set_dry_run_and_rejection() {
    let dir = tempfile::tempdir().unwrap();
    let h = dir.path().to_str().unwrap();
    bin()
        .args(["--home", h, "config", "get", "core.recall.softBudgetMs"])
        .assert()
        .success()
        .stdout(predicate::str::contains("400"));
    let before = std::fs::read(dir.path().join("config.json")).unwrap();
    // dry run: plan printed, nothing written
    bin()
        .args([
            "--home",
            h,
            "config",
            "set",
            "core.recall.softBudgetMs",
            "250",
            "--dry-run",
        ])
        .assert()
        .success()
        .stdout(predicate::str::contains("live"))
        .stdout(predicate::str::contains("core.recall.softBudgetMs"));
    assert_eq!(
        std::fs::read(dir.path().join("config.json")).unwrap(),
        before
    );
    // non-tty without --yes: exit 2, nothing written
    bin()
        .args([
            "--home",
            h,
            "config",
            "set",
            "core.recall.softBudgetMs",
            "250",
        ])
        .assert()
        .code(2)
        .stderr(predicate::str::contains("--yes"));
    assert_eq!(
        std::fs::read(dir.path().join("config.json")).unwrap(),
        before
    );
    // apply
    let out = bin()
        .args([
            "--json",
            "--home",
            h,
            "config",
            "set",
            "core.recall.softBudgetMs",
            "250",
            "--yes",
        ])
        .assert()
        .success()
        .get_output()
        .stdout
        .clone();
    let v: serde_json::Value = serde_json::from_slice(&out).unwrap();
    assert_eq!(v["applied"], true);
    assert_eq!(v["restart"]["live"][0], "core.recall.softBudgetMs");
    assert_eq!(v["restart"]["core"], false);
    bin()
        .args(["--home", h, "config", "get", "core.recall.softBudgetMs"])
        .assert()
        .success()
        .stdout(predicate::str::contains("250"));
    // a core-class key says so
    let out = bin()
        .args([
            "--json",
            "--home",
            h,
            "config",
            "set",
            "engine.recallMinScore",
            "0.5",
            "--dry-run",
        ])
        .assert()
        .success()
        .get_output()
        .stdout
        .clone();
    let v: serde_json::Value = serde_json::from_slice(&out).unwrap();
    assert_eq!(v["restart"]["core"], true);
    // string value for an enum key
    bin()
        .args([
            "--home",
            h,
            "config",
            "set",
            "core.logLevel",
            "debug",
            "--yes",
        ])
        .assert()
        .success();
}

#[test]
fn config_set_wording_does_not_overclaim_live_apply_in_h1() {
    let dir = tempfile::tempdir().unwrap();
    let h = dir.path().to_str().unwrap();
    // A plain live-class key: H1 has no supervisor, so nothing re-reads it live — the human
    // output must say so honestly, not "applies live".
    bin()
        .args([
            "--home",
            h,
            "config",
            "set",
            "core.logLevel",
            "debug",
            "--dry-run",
        ])
        .assert()
        .success()
        .stdout(predicate::str::contains(
            "live key — H1: re-read at the next core start; live apply arrives with the supervisor (H2)",
        ))
        .stdout(predicate::str::contains("applies live").not());
    // An agents.* key: the running core's agent registry does reload on change, so this one
    // really does apply immediately.
    bin()
        .args([
            "--home",
            h,
            "config",
            "set",
            "agents.bernd.displayName",
            "Bernd",
            "--dry-run",
        ])
        .assert()
        .success()
        .stdout(predicate::str::contains(
            "applied immediately (agents registry reloads on change)",
        ));
}

#[test]
fn rejects_a_wrong_typed_value_and_leaves_the_file_unchanged() {
    let dir = tempfile::tempdir().unwrap();
    let h = dir.path().to_str().unwrap();
    bin()
        .args(["--home", h, "config", "get"])
        .assert()
        .success();
    let before = std::fs::read(dir.path().join("config.json")).unwrap();
    bin()
        .args([
            "--home",
            h,
            "config",
            "set",
            "core.recall.softBudgetMs",
            "abc",
            "--yes",
        ])
        .assert()
        .code(1)
        .stderr(predicate::str::contains("softBudgetMs").or(predicate::str::contains("integer")));
    bin()
        .args(["--home", h, "config", "set", "nope.key", "1", "--yes"])
        .assert()
        .code(1);
    assert_eq!(
        std::fs::read(dir.path().join("config.json")).unwrap(),
        before,
        "byte-for-byte unchanged"
    );
}

#[test]
fn config_schema_prints_the_schema() {
    let out = bin()
        .args(["--json", "config", "schema"])
        .assert()
        .success()
        .get_output()
        .stdout
        .clone();
    let v: serde_json::Value = serde_json::from_slice(&out).unwrap();
    assert_eq!(v["schema"], "config.schema/1");
    assert_eq!(
        v["jsonSchema"]["properties"]["core"]["properties"]["logLevel"]["x-restart"],
        "live"
    );
}

#[test]
fn config_schema_tier_basic_filters() {
    let out = bin()
        .args(["--json", "config", "schema", "--tier", "basic"])
        .assert()
        .success()
        .get_output()
        .stdout
        .clone();
    let v: serde_json::Value = serde_json::from_slice(&out).unwrap();
    assert_eq!(v["schema"], "config.schema/1");
    assert_eq!(v["tier"], "basic");
    let mut keys: Vec<&str> = v["jsonSchema"]["properties"]
        .as_object()
        .unwrap()
        .keys()
        .map(String::as_str)
        .collect();
    keys.sort();
    assert_eq!(keys, ["agents", "embedding", "modelRoles", "providers"]);

    // default (no --tier) is unfiltered and tagged "all"
    let out = bin()
        .args(["--json", "config", "schema"])
        .assert()
        .success()
        .get_output()
        .stdout
        .clone();
    let v: serde_json::Value = serde_json::from_slice(&out).unwrap();
    assert_eq!(v["tier"], "all");
    assert!(v["jsonSchema"]["properties"]["core"].is_object());
}

#[test]
fn config_get_key_shows_restart_and_tier() {
    let out = bin()
        .args(["--json", "config", "get", "embedding.useClass"])
        .assert()
        .success()
        .get_output()
        .stdout
        .clone();
    let v: serde_json::Value = serde_json::from_slice(&out).unwrap();
    assert_eq!(v["schema"], "config.get/1");
    assert_eq!(v["tier"], "basic");
    assert_eq!(v["restart"], "core");
}

#[test]
fn config_get_tier_filters_without_key_and_conflicts_with_key() {
    let out = bin()
        .args(["--json", "config", "get", "--tier", "advanced"])
        .assert()
        .success()
        .get_output()
        .stdout
        .clone();
    let v: serde_json::Value = serde_json::from_slice(&out).unwrap();
    assert_eq!(v["schema"], "config.get/1");
    assert_eq!(v["tier"], "advanced");
    assert!(v["value"]["core"].is_object());
    assert!(v["value"].get("agents").is_none());

    bin()
        .args(["config", "get", "core.logLevel", "--tier", "basic"])
        .assert()
        .code(2);
}

#[test]
fn config_schema_json_wraps_the_schema() {
    let out = bin()
        .args(["--json", "config", "schema"])
        .assert()
        .success()
        .get_output()
        .stdout
        .clone();
    let v: serde_json::Value = serde_json::from_slice(&out).unwrap();
    assert_eq!(v["schema"], "config.schema/1");
    assert_eq!(
        v["jsonSchema"]["$id"],
        "https://plur1bus.dev/schema/config/1/config.schema.json"
    );
    assert!(
        v.as_object().unwrap().get("$schema").is_none(),
        "no top-level `$schema` key next to `schema` — that belongs inside jsonSchema"
    );
}

#[test]
fn memory_session_flag_help_says_it_is_capture_context_only_until_m1b_2c() {
    for sub in ["add", "recall"] {
        bin()
            .args(["memory", sub, "--help"])
            .assert()
            .success()
            .stdout(predicate::str::contains(
                "session key; used for capture context only until the session store lands (M1b-2c)",
            ));
    }
}

#[test]
fn memory_add_journals_when_the_core_is_absent_and_recall_degrades_fast() {
    let dir = tempfile::tempdir().unwrap();
    let h = dir.path().to_str().unwrap();
    bin()
        .args(["--home", h, "agent", "create", "bernd"])
        .assert()
        .success();
    let t0 = std::time::Instant::now();
    let out = bin()
        .args([
            "--json",
            "--home",
            h,
            "memory",
            "add",
            "--agent",
            "bernd",
            "--session",
            "s1",
            "the",
            "roadmap",
            "review",
            "is",
            "on",
            "Thursday",
        ])
        .assert()
        .success()
        .get_output()
        .stdout
        .clone();
    assert!(t0.elapsed() < std::time::Duration::from_secs(1));
    let v: serde_json::Value = serde_json::from_slice(&out).unwrap();
    assert_eq!(v["journaled"], true);
    assert_eq!(v["degraded"]["reason"], "core-unavailable");
    let journal = std::fs::read_to_string(dir.path().join("state/journal/bernd.jsonl")).unwrap();
    let line: serde_json::Value = serde_json::from_str(journal.trim()).unwrap();
    assert_eq!(line["v"], 1);
    assert_eq!(line["agentId"], "bernd");
    assert_eq!(line["sessionKey"], "s1");
    assert_eq!(line["caller"]["channel"], "cli");
    assert_eq!(
        line["messages"][0]["content"],
        "the roadmap review is on Thursday"
    );
    let t1 = std::time::Instant::now();
    let out = bin()
        .args([
            "--json", "--home", h, "memory", "recall", "--agent", "bernd", "when", "is", "it",
        ])
        .assert()
        .success()
        .get_output()
        .stdout
        .clone();
    assert!(t1.elapsed() < std::time::Duration::from_secs(1));
    let v: serde_json::Value = serde_json::from_slice(&out).unwrap();
    assert_eq!(v["degraded"]["reason"], "core-unavailable");
    assert_eq!(v["blocks"].as_array().unwrap().len(), 0);
    bin()
        .args(["--home", h, "memory", "recall", "--agent", "bernd", "x"])
        .assert()
        .success()
        .stderr(predicate::str::contains("core-unavailable"));
}

#[test]
fn memory_add_for_an_unregistered_agent_fails_before_journaling() {
    let dir = tempfile::tempdir().unwrap();
    let h = dir.path().to_str().unwrap();
    bin()
        .args(["--home", h, "config", "get"])
        .assert()
        .success();
    bin()
        .args(["--home", h, "memory", "add", "--agent", "ghost", "x"])
        .assert()
        .code(1)
        .stderr(predicate::str::contains("not registered"));
    assert!(!dir.path().join("state/journal/ghost.jsonl").exists());
}

#[test]
fn journal_lines_validate_against_the_rpc_schema() {
    let dir = tempfile::tempdir().unwrap();
    let h = dir.path().to_str().unwrap();
    bin()
        .args(["--home", h, "agent", "create", "bernd"])
        .assert()
        .success();
    bin()
        .args(["--home", h, "memory", "add", "--agent", "bernd", "hello"])
        .assert()
        .success();
    let schema: serde_json::Value = serde_json::from_str(
        &std::fs::read_to_string(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../../packages/rpc-schema/schema/rpc.schema.json"
        ))
        .unwrap(),
    )
    .unwrap();
    let doc = serde_json::json!({
        "$schema": "https://json-schema.org/draft/2020-12/schema",
        "$ref": "#/$defs/JournalLine",
        "$defs": schema["$defs"]
    });
    let validator = jsonschema::options()
        .with_draft(jsonschema::Draft::Draft202012)
        .build(&doc)
        .unwrap();
    let line: serde_json::Value = serde_json::from_str(
        std::fs::read_to_string(dir.path().join("state/journal/bernd.jsonl"))
            .unwrap()
            .trim(),
    )
    .unwrap();
    let errs: Vec<String> = validator
        .iter_errors(&line)
        .map(|e| e.to_string())
        .collect();
    assert!(errs.is_empty(), "{errs:?}");
}

/// Matches `^[a-z0-9]+(\.[a-z0-9-]+)*/\d+$` (no `regex` dependency for one call site): one or
/// more dot-separated lowercase-alphanumeric/hyphen segments, a `/`, then a decimal major.
fn is_schema_id(s: &str) -> bool {
    let Some((path, major)) = s.rsplit_once('/') else {
        return false;
    };
    if major.is_empty() || !major.bytes().all(|b| b.is_ascii_digit()) {
        return false;
    }
    let seg_ok = |seg: &str, allow_hyphen: bool| {
        !seg.is_empty()
            && seg.bytes().all(|b| {
                b.is_ascii_lowercase() || b.is_ascii_digit() || (allow_hyphen && b == b'-')
            })
    };
    let mut segs = path.split('.');
    match segs.next() {
        Some(first) if seg_ok(first, false) => {}
        _ => return false,
    }
    segs.all(|seg| seg_ok(seg, true))
}

#[test]
fn every_json_document_carries_a_schema_id() {
    let dir = tempfile::tempdir().unwrap();
    let h = dir.path().to_str().unwrap();
    bin()
        .args(["--home", h, "agent", "create", "bernd"])
        .assert()
        .success();

    let cases: Vec<(Vec<&str>, i32)> = vec![
        (vec!["--json", "--home", h, "agent", "list"], 0),
        (
            vec!["--json", "--home", h, "config", "get", "core.logLevel"],
            0,
        ),
        (vec!["--json", "--home", h, "config", "schema"], 0),
        (
            vec![
                "--json", "--home", h, "memory", "recall", "--agent", "bernd", "q",
            ],
            0,
        ),
        (vec!["--json", "setup"], 2),
    ];
    for (args, code) in cases {
        let assert = bin().args(&args).assert();
        let assert = if code == 0 {
            assert.success()
        } else {
            assert.code(code)
        };
        let out = assert.get_output().stdout.clone();
        let v: serde_json::Value = serde_json::from_slice(&out).unwrap();
        let schema = v["schema"]
            .as_str()
            .unwrap_or_else(|| panic!("no `schema` key in {args:?} -> {v}"));
        assert!(
            schema == "error/1" || is_schema_id(schema),
            "{args:?} -> schema {schema:?} does not match ^[a-z0-9]+(\\.[a-z0-9-]+)*/\\d+$ nor equal error/1"
        );
    }
}

#[test]
fn dreams_without_a_core_says_so_and_validates_args() {
    let dir = tempfile::tempdir().unwrap();
    let h = dir.path().to_str().unwrap();
    bin()
        .args(["--home", h, "agent", "create", "bernd"])
        .assert()
        .success();
    bin()
        .args(["--home", h, "dreams", "status"])
        .assert()
        .code(1)
        .stderr(predicate::str::contains("core unavailable"));
    bin()
        .args(["--home", h, "dreams", "run", "gc-run", "--agent", "ghost"])
        .assert()
        .code(1)
        .stderr(predicate::str::contains("not registered"));
    let out = bin()
        .args(["--json", "--home", h, "dreams", "log", "--agent", "bernd"])
        .assert()
        .code(1)
        .get_output()
        .stdout
        .clone();
    let v: serde_json::Value = serde_json::from_slice(&out).unwrap();
    assert_eq!(v["error"], "E_CORE_UNAVAILABLE");
}

/// A minimal fake core for the `plur1bus memory …` tests: writes `run/core.token` and binds
/// `run/core.sock` under `home` (mirrors `crates/plur1bus-rpc/tests/client.rs`'s
/// `fake_core_with`), answers `core.auth` with `hello`, and — if given — answers one other
/// method with a scripted response (its `result` or `error` object, `jsonrpc`/`id` filled in).
#[cfg(unix)]
mod fake_core {
    use serde_json::{json, Value};
    use std::io::{BufRead, BufReader, Write};
    use std::os::unix::net::UnixListener;
    use std::path::Path;

    pub fn spawn(home: &Path, hello: Value, scripted: Option<(&str, Value)>) {
        let run = home.join("run");
        std::fs::create_dir_all(&run).unwrap();
        let token = "d".repeat(64);
        std::fs::write(run.join("core.token"), &token).unwrap();
        let listener = UnixListener::bind(run.join("core.sock")).unwrap();
        let scripted = scripted.map(|(m, a)| (m.to_string(), a));
        std::thread::spawn(move || {
            for stream in listener.incoming() {
                let Ok(stream) = stream else { return };
                let mut w = stream.try_clone().unwrap();
                let r = BufReader::new(stream);
                let hello = hello.clone();
                let scripted = scripted.clone();
                let token = token.clone();
                std::thread::spawn(move || {
                    let mut authed = false;
                    for line in r.lines() {
                        let Ok(line) = line else { return };
                        let msg: Value = serde_json::from_str(&line).unwrap();
                        let id = msg["id"].clone();
                        let method = msg["method"].as_str().unwrap_or("").to_string();
                        let reply = if method == "core.auth" {
                            authed = msg["params"]["token"] == token;
                            if authed {
                                json!({"jsonrpc":"2.0","id":id,"result":hello})
                            } else {
                                json!({"jsonrpc":"2.0","id":id,"error":{"code":-32000,"message":"bad token","data":{"error":"E_UNAUTHORIZED","reason":"bad-token"}}})
                            }
                        } else if !authed {
                            json!({"jsonrpc":"2.0","id":id,"error":{"code":-32000,"message":"auth","data":{"error":"E_UNAUTHORIZED","reason":"auth-required"}}})
                        } else if scripted.as_ref().is_some_and(|(m, _)| *m == method) {
                            let mut r = json!({"jsonrpc":"2.0","id":id});
                            let (_, body) = scripted.as_ref().unwrap();
                            if let (Some(t), Some(b)) = (r.as_object_mut(), body.as_object()) {
                                for (k, v) in b {
                                    t.insert(k.clone(), v.clone());
                                }
                            }
                            r
                        } else {
                            json!({"jsonrpc":"2.0","id":id,"error":{"code":-32601,"message":"nope","data":{"error":"E_INTERNAL","reason":"method-not-found"}}})
                        };
                        w.write_all(format!("{}\n", reply).as_bytes()).unwrap();
                        w.flush().unwrap();
                    }
                });
            }
        });
    }

    pub fn hello_with_capabilities(missing_methods: &[&str]) -> Value {
        let mut methods = serde_json::Map::new();
        for m in [
            "memory.list",
            "memory.show",
            "memory.forget",
            "memory.correct",
            "memory.share",
            "memory.state",
            "memory.propose",
            "memory.proposals.list",
            "memory.proposals.accept",
            "memory.proposals.reject",
        ] {
            if !missing_methods.contains(&m) {
                methods.insert(
                    m.to_string(),
                    json!({"stability": "experimental", "since": "1.1.0"}),
                );
            }
        }
        json!({
            "contract": "1.6.0",
            "rpc": "1.1.0",
            "instanceId": "i",
            "pid": 1,
            "capabilities": {
                "methods": methods,
                "notifications": {},
                "extensionPoints": {},
                "features": []
            }
        })
    }
}

#[test]
fn memory_help_names_every_subcommand() {
    let out = bin()
        .args(["memory", "--help"])
        .assert()
        .success()
        .get_output()
        .stdout
        .clone();
    let s = String::from_utf8(out).unwrap();
    for sub in [
        "add",
        "recall",
        "list",
        "show",
        "forget",
        "correct",
        "share",
        "state",
        "propose",
        "proposals",
    ] {
        assert!(s.contains(sub), "memory --help does not mention {sub}\n{s}");
    }
}

#[test]
fn memory_forget_without_yes_in_a_pipe_exits_2_and_changes_nothing() {
    let dir = tempfile::tempdir().unwrap();
    let h = dir.path().to_str().unwrap();
    bin()
        .args(["--home", h, "agent", "create", "bernd"])
        .assert()
        .success();
    let out = bin()
        .args([
            "--json", "--home", h, "memory", "forget", "--agent", "bernd", "m-1",
        ])
        .assert()
        .code(2)
        .get_output()
        .stdout
        .clone();
    let v: serde_json::Value = serde_json::from_slice(&out).unwrap();
    assert_eq!(v["schema"], "error/1");
    assert_eq!(v["applied"], false);
}

#[test]
fn memory_list_rejects_topic_with_since() {
    let dir = tempfile::tempdir().unwrap();
    let h = dir.path().to_str().unwrap();
    bin()
        .args(["--home", h, "agent", "create", "bernd"])
        .assert()
        .success();
    bin()
        .args([
            "--home", h, "memory", "list", "--agent", "bernd", "--topic", "roadmap", "--since",
            "1000",
        ])
        .assert()
        .code(2);
}

#[test]
fn memory_ops_without_a_core_fail_fast_with_core_unavailable() {
    let dir = tempfile::tempdir().unwrap();
    let h = dir.path().to_str().unwrap();
    bin()
        .args(["--home", h, "agent", "create", "bernd"])
        .assert()
        .success();
    let cases: Vec<Vec<&str>> = vec![
        vec!["memory", "list", "--agent", "bernd"],
        vec!["memory", "show", "--agent", "bernd", "m-1"],
        vec!["memory", "forget", "--agent", "bernd", "m-1", "--yes"],
        vec![
            "memory", "correct", "--agent", "bernd", "m-1", "new", "text",
        ],
        vec![
            "memory",
            "share",
            "--agent",
            "bernd",
            "m-1",
            "--to",
            "workspace",
        ],
        vec!["memory", "state", "--agent", "bernd"],
        vec![
            "memory", "propose", "--agent", "bernd", "m-copy", "new", "text",
        ],
        vec!["memory", "proposals", "list", "--agent", "bernd"],
        vec!["memory", "proposals", "accept", "--agent", "bernd", "p-1"],
        vec!["memory", "proposals", "reject", "--agent", "bernd", "p-1"],
    ];
    for args in cases {
        let mut full = vec!["--json", "--home", h];
        full.extend(args.iter());
        let t0 = std::time::Instant::now();
        let out = bin()
            .args(&full)
            .assert()
            .code(1)
            .get_output()
            .stdout
            .clone();
        let elapsed = t0.elapsed();
        assert!(
            elapsed < std::time::Duration::from_secs(1),
            "{args:?} took {elapsed:?}"
        );
        let v: serde_json::Value = serde_json::from_slice(&out).unwrap();
        assert_eq!(v["error"], "E_CORE_UNAVAILABLE", "{args:?} -> {v}");
    }
}

#[test]
fn memory_ops_for_an_unregistered_agent_fail_before_connecting() {
    let dir = tempfile::tempdir().unwrap();
    let h = dir.path().to_str().unwrap();
    let cases: Vec<Vec<&str>> = vec![
        vec!["memory", "list", "--agent", "ghost"],
        vec!["memory", "show", "--agent", "ghost", "m-1"],
        vec!["memory", "forget", "--agent", "ghost", "m-1", "--yes"],
        vec![
            "memory", "correct", "--agent", "ghost", "m-1", "new", "text",
        ],
        vec![
            "memory",
            "share",
            "--agent",
            "ghost",
            "m-1",
            "--to",
            "workspace",
        ],
        vec!["memory", "state", "--agent", "ghost"],
        vec![
            "memory", "propose", "--agent", "ghost", "m-copy", "new", "text",
        ],
        vec!["memory", "proposals", "list", "--agent", "ghost"],
        vec!["memory", "proposals", "accept", "--agent", "ghost", "p-1"],
        vec!["memory", "proposals", "reject", "--agent", "ghost", "p-1"],
    ];
    for args in cases {
        let mut full = vec!["--json", "--home", h];
        full.extend(args.iter());
        let out = bin()
            .args(&full)
            .assert()
            .code(1)
            .get_output()
            .stdout
            .clone();
        let v: serde_json::Value = serde_json::from_slice(&out).unwrap();
        assert_eq!(v["error"], "E_AGENT_UNKNOWN", "{args:?} -> {v}");
    }
}

#[cfg(unix)]
#[test]
fn share_approval_required_in_a_pipe_exits_2_with_hint() {
    let dir = tempfile::tempdir().unwrap();
    let h = dir.path().to_str().unwrap();
    bin()
        .args(["--home", h, "agent", "create", "bernd"])
        .assert()
        .success();
    fake_core::spawn(
        dir.path(),
        fake_core::hello_with_capabilities(&[]),
        Some((
            "memory.share",
            serde_json::json!({"error": {"code": -32000, "message": "sensitive", "data": {"error": "E_APPROVAL_REQUIRED", "reason": "sensitive"}}}),
        )),
    );
    bin()
        .args([
            "--home",
            h,
            "memory",
            "share",
            "--agent",
            "bernd",
            "m-1",
            "--to",
            "workspace",
        ])
        .assert()
        .code(2)
        .stderr(predicate::str::contains("--allow-sensitive"));
}

#[cfg(unix)]
#[test]
fn a_core_without_the_method_in_capabilities_is_not_available() {
    let dir = tempfile::tempdir().unwrap();
    let h = dir.path().to_str().unwrap();
    bin()
        .args(["--home", h, "agent", "create", "bernd"])
        .assert()
        .success();
    fake_core::spawn(
        dir.path(),
        fake_core::hello_with_capabilities(&["memory.propose"]),
        None,
    );
    let out = bin()
        .args([
            "--json", "--home", h, "memory", "propose", "--agent", "bernd", "m-copy", "new", "text",
        ])
        .assert()
        .code(2)
        .get_output()
        .stdout
        .clone();
    let v: serde_json::Value = serde_json::from_slice(&out).unwrap();
    assert_eq!(v["error"], "E_NOT_AVAILABLE");
    assert_eq!(v["reason"], "core-lacks-method");
    assert_eq!(v["method"], "memory.propose");
}

/// Review finding (Task 9 fix round 1): the human-output closures for `forget`, `correct`,
/// `share`, `propose`, `proposals accept` and `proposals reject` used to interpolate
/// `serde_json::Value` directly (e.g. `v["id"]`), which prints ids with their JSON quotes
/// (`"m-1"`) instead of the bare id `list`/`show`/`state` already print via `.as_str()`. Pins
/// `forget`'s human line to the bare id.
#[cfg(unix)]
#[test]
fn memory_forget_human_output_prints_bare_id_without_json_quotes() {
    let dir = tempfile::tempdir().unwrap();
    let h = dir.path().to_str().unwrap();
    bin()
        .args(["--home", h, "agent", "create", "bernd"])
        .assert()
        .success();
    fake_core::spawn(
        dir.path(),
        fake_core::hello_with_capabilities(&[]),
        Some((
            "memory.forget",
            serde_json::json!({"result": {"id": "m-1", "tombstoneId": "t-1"}}),
        )),
    );
    let out = bin()
        .args([
            "--home", h, "memory", "forget", "--agent", "bernd", "m-1", "--yes",
        ])
        .assert()
        .success()
        .get_output()
        .stdout
        .clone();
    let s = String::from_utf8(out).unwrap();
    assert!(s.contains("forgot m-1"), "expected bare id, got: {s}");
    assert!(!s.contains("\"m-1\""), "id printed with JSON quotes: {s}");
}

/// Same pin for `proposals accept`'s human line (`v["proposalId"]`/`v["id"]`).
#[cfg(unix)]
#[test]
fn memory_proposals_accept_human_output_prints_bare_ids_without_json_quotes() {
    let dir = tempfile::tempdir().unwrap();
    let h = dir.path().to_str().unwrap();
    bin()
        .args(["--home", h, "agent", "create", "bernd"])
        .assert()
        .success();
    fake_core::spawn(
        dir.path(),
        fake_core::hello_with_capabilities(&[]),
        Some((
            "memory.proposals.accept",
            serde_json::json!({"result": {"proposalId": "p-1", "id": "m-2"}}),
        )),
    );
    let out = bin()
        .args([
            "--home",
            h,
            "memory",
            "proposals",
            "accept",
            "--agent",
            "bernd",
            "p-1",
        ])
        .assert()
        .success()
        .get_output()
        .stdout
        .clone();
    let s = String::from_utf8(out).unwrap();
    assert!(
        s.contains("accepted p-1 -> m-2"),
        "expected bare ids, got: {s}"
    );
    assert!(!s.contains('"'), "id printed with JSON quotes: {s}");
}

/// Final review I2: a degraded read (G8, e.g. an invalid caller identity) must be visible in
/// human output, with the same `degraded:` line `memory recall` prints.
#[cfg(unix)]
#[test]
fn memory_reads_print_a_degraded_line_in_human_output() {
    let degraded = serde_json::json!({
        "reason": "principal-invalid",
        "capability": "identity",
        "detail": "accountId too long"
    });
    let cases: [(&str, &[&str], serde_json::Value); 4] = [
        (
            "memory.list",
            &["memory", "list", "--agent", "bernd"],
            serde_json::json!({"items": [], "degraded": degraded}),
        ),
        (
            "memory.show",
            &["memory", "show", "--agent", "bernd", "m-1"],
            serde_json::json!({"card": {"id": "m-1", "summary": "synthetic"}, "degraded": degraded}),
        ),
        (
            "memory.state",
            &["memory", "state", "--agent", "bernd"],
            serde_json::json!({"degraded": degraded}),
        ),
        (
            "memory.proposals.list",
            &["memory", "proposals", "list", "--agent", "bernd"],
            serde_json::json!({"items": [], "degraded": degraded}),
        ),
    ];
    for (method, args, result) in cases {
        let dir = tempfile::tempdir().unwrap();
        let h = dir.path().to_str().unwrap();
        bin()
            .args(["--home", h, "agent", "create", "bernd"])
            .assert()
            .success();
        fake_core::spawn(
            dir.path(),
            fake_core::hello_with_capabilities(&[]),
            Some((method, serde_json::json!({ "result": result }))),
        );
        let out = bin()
            .args(["--home", h])
            .args(args)
            .assert()
            .success()
            .get_output()
            .stdout
            .clone();
        let s = String::from_utf8(out).unwrap();
        assert!(
            s.contains("degraded: principal-invalid (identity): accountId too long"),
            "{method}: expected a degraded line, got: {s}"
        );
    }
}

/// Final review M2: in human mode an RPC error's recovery ids reach stderr, not only `--json`.
#[cfg(unix)]
#[test]
fn human_errors_print_recovery_ids_to_stderr() {
    let dir = tempfile::tempdir().unwrap();
    let h = dir.path().to_str().unwrap();
    bin()
        .args(["--home", h, "agent", "create", "bernd"])
        .assert()
        .success();
    fake_core::spawn(
        dir.path(),
        fake_core::hello_with_capabilities(&[]),
        Some((
            "memory.correct",
            serde_json::json!({"error": {"code": -32000, "message": "shared copy refresh failed", "data": {
                "error": "E_STORAGE", "reason": "storage",
                "ids": {"staleSharedId": "m-old", "sourceId": "m-src", "sharedId": "m-new"}
            }}}),
        )),
    );
    let out = bin()
        .args([
            "--home", h, "memory", "correct", "--agent", "bernd", "m-src", "new text",
        ])
        .assert()
        .code(1)
        .get_output()
        .stderr
        .clone();
    let s = String::from_utf8(out).unwrap();
    assert!(
        s.contains("ids: sharedId=m-new sourceId=m-src staleSharedId=m-old"),
        "expected the ids line on stderr, got: {s}"
    );
}
