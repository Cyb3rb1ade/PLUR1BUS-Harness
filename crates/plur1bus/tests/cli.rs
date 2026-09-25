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
fn h2_commands_are_stubs_in_h1() {
    for cmd in ["setup", "module", "daemon", "service", "update", "1staid"] {
        bin().arg(cmd).arg("--help").assert().success();
    }
    bin()
        .args(["daemon", "status"])
        .assert()
        .code(2)
        .stderr(predicate::str::contains("H2"));
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
    assert_eq!(
        v["properties"]["core"]["properties"]["logLevel"]["x-restart"],
        "live"
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
