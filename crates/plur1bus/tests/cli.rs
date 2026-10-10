mod common;

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
fn channel_is_a_real_command_and_no_milestone_stub() {
    // No stub is left (`channel` was the last one): a bare `channel` is a usage error, not a milestone message.
    bin()
        .arg("channel")
        .assert()
        .code(2)
        .stderr(predicate::str::contains("M4").not());
    for sub in [
        "list",
        "show",
        "enable",
        "disable",
        "set",
        "test",
        "status",
        "link-help",
    ] {
        bin()
            .args(["channel", sub, "--help"])
            .assert()
            .success()
            .stdout(predicate::str::contains("experimental").or(predicate::str::contains("Usage")));
    }
    // Without a core it fails as every core-backed command does, naming no milestone.
    let dir = tempfile::tempdir().unwrap();
    let home = dir.path().to_str().unwrap();
    let out = bin()
        .env_remove("PLUR1BUS_CONTAINER")
        .args(["--home", home, "--json", "channel", "list"])
        .assert()
        .code(1)
        .get_output()
        .stdout
        .clone();
    let v: serde_json::Value = serde_json::from_slice(&out).unwrap();
    assert_eq!(v["error"], "E_CORE_UNAVAILABLE");
    assert!(v.get("milestone").is_none());
}

fn json_code(args: &[&str], env: &[(&str, &str)], code: i32) -> serde_json::Value {
    let mut cmd = bin();
    cmd.env_remove("PLUR1BUS_CONTAINER");
    for (k, v) in env {
        cmd.env(k, v);
    }
    let out = cmd
        .args(args)
        .assert()
        .code(code)
        .get_output()
        .stdout
        .clone();
    serde_json::from_slice(&out).unwrap()
}

#[test]
fn setup_update_and_repair_are_no_longer_stubs() {
    // `daemon`, `service` and `module` are implemented (2a-H3a Tasks 8, 9; 2a-H3b Task 10).
    for cmd in ["setup", "module", "daemon", "service", "update", "1staid"] {
        bin().arg(cmd).arg("--help").assert().success();
    }
    // `module status` is no longer a stub: clap refuses the unknown subcommand.
    bin()
        .args(["module", "status"])
        .assert()
        .code(2)
        .stderr(predicate::str::contains("2a-H3b").not());
    // `update --check` is implemented (2a-H3b-b Task 5); it is covered by `tests/update.rs` and by
    // `update_check_reports_not_installed_and_writes_nothing` below. `setup` is implemented (2a-H3b-b Task 4,
    // tests/setup.rs), and so is `1staid repair` (2a-H3b-b Task 7, tests/repair.rs): its dry run writes nothing.
    let dir = tempfile::tempdir().unwrap();
    let home = dir.path().join("h");
    std::fs::create_dir_all(&home).unwrap();
    let fake = dir.path().join("fake");
    std::fs::create_dir_all(&fake).unwrap();
    let h = home.to_str().unwrap();
    let args = ["--json", "--home", h, "1staid", "repair", "--dry-run"];
    let env = [
        ("PLUR1BUS_ALLOW_TEST_INTERNALS", "1"),
        ("PLUR1BUS_SERVICE_FAKE", fake.to_str().unwrap()),
    ];
    let v = json_code(&args, &env, 0);
    assert_eq!(v["schema"], "1staid.repair/1", "{v}");
    assert_eq!(v["dryRun"], true, "{v}");
    assert!(
        std::fs::read_dir(&home).unwrap().next().is_none(),
        "a dry run writes nothing"
    );
}

/// `update --check` with no install manifest (2a-H3b-b Task 5, HB9): `E_NOT_AVAILABLE reason=not-installed`,
/// the `plur1bus setup` hint, exit 1, and nothing written under `home` (full coverage: `tests/update.rs`).
#[test]
fn update_check_reports_not_installed_and_writes_nothing() {
    let dir = tempfile::tempdir().unwrap();
    let h = dir.path().to_str().unwrap();
    let v = json_code(&["--json", "--home", h, "update", "--check"], &[], 1);
    assert_eq!(v["error"], "E_NOT_AVAILABLE");
    assert_eq!(v["reason"], "not-installed");
    assert!(v["message"].as_str().unwrap().contains("plur1bus setup"));
    assert!(std::fs::read_dir(dir.path()).unwrap().next().is_none());
}

#[test]
fn update_applies_only_on_an_install_and_never_in_container_mode() {
    // M8: `update` is real. In a home `setup` never ran it says so (exit 1) instead of answering a milestone.
    let dir = tempfile::tempdir().unwrap();
    let h = dir.path().to_str().unwrap();
    let v = json_code(&["--json", "--home", h, "update", "--yes"], &[], 1);
    assert_eq!(v["error"], "E_NOT_AVAILABLE");
    assert_eq!(v["reason"], "not-installed");
    // The image owns the installation in container mode: apply and rollback are refused there, like `--check`.
    for args in [
        vec!["--json", "--home", h, "update", "--yes"],
        vec!["--json", "--home", h, "update", "--rollback"],
    ] {
        let v = json_code(&args, &[("PLUR1BUS_CONTAINER", "1")], 1);
        assert_eq!(v["reason"], "container-managed", "{args:?}");
    }
    // Nothing to roll back and no update yet: `status` reads, never writes.
    let v = json_code(&["--json", "--home", h, "update", "status"], &[], 0);
    assert_eq!(
        (v["schema"].as_str(), v["phase"].as_str()),
        (Some("update.status/1"), Some("idle"))
    );
    let v = json_code(&["--json", "--home", h, "update", "--rollback"], &[], 1);
    assert_eq!(v["reason"], "nothing-to-roll-back");
}

#[test]
fn setup_and_update_check_are_container_managed_in_container_mode() {
    let dir = tempfile::tempdir().unwrap();
    let h = dir.path().to_str().unwrap();
    // `setup` refuses in container mode; outside it, it would install for real (tests/setup.rs covers it).
    let setup_args = vec!["--json", "--home", h, "setup", "--non-interactive"];
    let v = json_code(&setup_args, &[("PLUR1BUS_CONTAINER", "1")], 1);
    assert_eq!(v["error"], "E_NOT_AVAILABLE");
    assert_eq!(v["reason"], "container-managed");

    let update_args = vec!["--json", "--home", h, "update", "--check"];
    let v = json_code(&update_args, &[("PLUR1BUS_CONTAINER", "1")], 1);
    assert_eq!(v["error"], "E_NOT_AVAILABLE");
    assert_eq!(v["reason"], "container-managed");
    // Only exactly "1" is container mode: otherwise `update --check` runs for real (Task 5) and reports
    // `not-installed` since this home has no install manifest.
    let v = json_code(&update_args, &[("PLUR1BUS_CONTAINER", "true")], 1);
    assert_eq!(v["error"], "E_NOT_AVAILABLE");
    assert_eq!(v["reason"], "not-installed");

    assert!(std::fs::read_dir(dir.path()).unwrap().next().is_none());
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
    // The Hermes provider's `bind` keys on this reason (hosts/hermes/plur1bus/cli.py).
    let out = bin()
        .args(["--json", "--home", h, "agent", "create", "bernd"])
        .assert()
        .code(1)
        .get_output()
        .stdout
        .clone();
    let v: serde_json::Value = serde_json::from_slice(&out).unwrap();
    assert_eq!(v["error"], "E_INVALID_PARAMS");
    assert_eq!(v["reason"], "agent-exists");
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
        .stdout(predicate::str::contains("restarts core: yes"))
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
    assert_eq!(v["restart"]["live"].as_array().unwrap().len(), 0);
    assert_eq!(v["restart"]["core"], true);
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

/// Asserts a "fails/degrades fast" bound of 1 s. The bound is on the command's own latency (a short probe budget), but
/// the wall clock also holds process spawn and scheduling, which a saturated machine occasionally stretches past 1 s.
/// A genuinely slow path (a hang, a retry loop) is slow on every attempt, so the best of three, with `retry` repeating
/// the measurement without side effects on the test's state, is as strict as a single measurement while ignoring one
/// descheduled spawn.
fn assert_fast(
    what: &str,
    first: std::time::Duration,
    mut retry: impl FnMut() -> std::time::Duration,
) {
    let limit = std::time::Duration::from_secs(1);
    let mut took = vec![first];
    while *took.last().unwrap() >= limit && took.len() < 3 {
        took.push(retry());
    }
    assert!(*took.last().unwrap() < limit, "{what} took {took:?}");
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
    assert_fast("memory add", t0.elapsed(), || {
        // The same call in a throwaway home: the journal under test is not appended to twice.
        let scratch = tempfile::tempdir().unwrap();
        let sh = scratch.path().to_str().unwrap();
        bin()
            .args(["--home", sh, "agent", "create", "bernd"])
            .assert()
            .success();
        let t = std::time::Instant::now();
        bin()
            .args([
                "--json", "--home", sh, "memory", "add", "--agent", "bernd", "x",
            ])
            .assert()
            .success();
        t.elapsed()
    });
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
    assert_fast("memory recall", t1.elapsed(), || {
        let t = std::time::Instant::now();
        bin()
            .args([
                "--json", "--home", h, "memory", "recall", "--agent", "bernd", "when", "is", "it",
            ])
            .assert()
            .success();
        t.elapsed()
    });
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
        (vec!["--json", "--home", h, "update", "status"], 0),
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

#[test]
fn dreams_phase_commands_validate_their_arguments_before_any_core_call() {
    let dir = tempfile::tempdir().unwrap();
    let h = dir.path().to_str().unwrap();
    bin()
        .args(["--home", h, "agent", "create", "bernd"])
        .assert()
        .success();
    // a phase run for an unregistered agent
    bin()
        .args(["--home", h, "dreams", "run", "deep", "--agent", "ghost"])
        .assert()
        .code(1)
        .stderr(predicate::str::contains("not registered"));
    // --dry-run is for phases only
    bin()
        .args([
            "--home",
            h,
            "dreams",
            "run",
            "gc-run",
            "--agent",
            "bernd",
            "--dry-run",
        ])
        .assert()
        .code(2)
        .stderr(predicate::str::contains("light, rem and deep"));
    // a schedule edit that changes nothing
    bin()
        .args([
            "--home", h, "dreams", "schedule", "set", "deep", "--agent", "bernd",
        ])
        .assert()
        .code(2)
        .stderr(predicate::str::contains("nothing to change"));
    // an unknown phase is a usage error, and log needs an agent unless it names a run
    bin()
        .args(["--home", h, "dreams", "enable", "dawn", "--agent", "bernd"])
        .assert()
        .code(2);
    bin().args(["--home", h, "dreams", "log"]).assert().code(2);
    bin()
        .args([
            "--home", h, "dreams", "log", "--phase", "deep", "--job", "gc-run", "--agent", "bernd",
        ])
        .assert()
        .code(2);
}

#[cfg(unix)]
#[test]
fn dreams_phase_commands_call_the_scheduler_methods_and_print_their_documents() {
    let run = serde_json::json!({
        "runId": "run-1", "agentId": "bernd", "phase": "deep", "jobId": "consolidate-daily", "partition": "agent-private",
        "idempotencyKey": "k", "claimed": false, "trigger": "manual", "scheduledFor": null, "startedAt": 1000, "finishedAt": 1500, "durationMs": 500,
        "outcome": "skipped", "reason": "min_corpus", "counts": {}, "tokensIn": null, "tokensOut": null, "costMicros": null, "logPath": null, "error": null
    });
    let schedule = serde_json::json!({
        "agentId": "bernd", "phase": "deep", "cron": "0 4 * * *", "timezone": "UTC", "enabled": false, "staggerOffsetS": 7, "nextRunAt": null
    });
    let cases: Vec<(&str, Vec<&str>, serde_json::Value, &str, &str)> = vec![
        (
            "dreams.run",
            vec!["dreams", "run", "deep", "--agent", "bernd"],
            run.clone(),
            "dreams.run/1",
            "deep: skipped (min_corpus)",
        ),
        (
            "dreams.run",
            vec!["dreams", "run", "deep", "--agent", "bernd", "--dry-run"],
            serde_json::json!({"dryRun": true, "wouldRun": false, "reason": "idempotent", "jobs": ["consolidate-daily"], "idempotencyKey": "k", "counts": {}}),
            "dreams.run/1",
            "would skip (idempotent)",
        ),
        (
            "dreams.log",
            vec!["dreams", "log", "--run", "run-1"],
            serde_json::json!({"runs": [run.clone()], "log": "start deep trigger=manual\nfinish outcome=skipped"}),
            "dreams.log/1",
            "finish outcome=skipped",
        ),
        (
            "dreams.schedule.get",
            vec!["dreams", "schedule", "get", "--agent", "bernd"],
            serde_json::json!({"schedules": [schedule.clone()]}),
            "dreams.schedule.get/1",
            "off",
        ),
        (
            "dreams.schedule.set",
            vec![
                "dreams",
                "schedule",
                "set",
                "deep",
                "--agent",
                "bernd",
                "--cron",
                "0 4 * * *",
            ],
            serde_json::json!({"schedule": schedule.clone()}),
            "dreams.schedule.set/1",
            "0 4 * * *",
        ),
        (
            "dreams.disable",
            vec!["dreams", "disable", "deep", "--agent", "bernd"],
            serde_json::json!({"schedule": schedule.clone()}),
            "dreams.disable/1",
            "deep",
        ),
    ];
    for (method, args, result, schema, human) in cases {
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
        let mut full = vec!["--home", h];
        full.extend(&args);
        bin()
            .args(&full)
            .assert()
            .success()
            .stdout(predicate::str::contains(human));
        let mut json_args = vec!["--json", "--home", h];
        json_args.extend(&args);
        let out = bin()
            .args(&json_args)
            .assert()
            .success()
            .get_output()
            .stdout
            .clone();
        let v: serde_json::Value = serde_json::from_slice(&out).unwrap();
        assert_eq!(v["schema"], schema, "{args:?}");
    }
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
        // The bound is on the command's own latency (a 250 ms probe budget), but the wall clock also holds process
        // spawn and scheduling, which a saturated machine stretches past 1 s once in a while. A genuinely slow path
        // (a hang, a retry loop) is slow on every attempt, so the best of three keeps the assertion as strict as it
        // was while ignoring one descheduled spawn. Every attempt must still answer E_CORE_UNAVAILABLE.
        let mut took = Vec::new();
        for _ in 0..3 {
            let t0 = std::time::Instant::now();
            let out = bin()
                .args(&full)
                .assert()
                .code(1)
                .get_output()
                .stdout
                .clone();
            took.push(t0.elapsed());
            let v: serde_json::Value = serde_json::from_slice(&out).unwrap();
            assert_eq!(v["error"], "E_CORE_UNAVAILABLE", "{args:?} -> {v}");
            if took.last().unwrap() < &std::time::Duration::from_secs(1) {
                break;
            }
        }
        assert!(
            took.last().unwrap() < &std::time::Duration::from_secs(1),
            "{args:?} took {took:?}"
        );
    }
}

#[test]
fn read_paths_report_a_schema_invalid_config_as_config_invalid() {
    for (doc, args) in [
        (
            r#"{"schemaVersion":"not-a-number","agents":{"bernd":{}}}"#,
            vec!["memory", "list", "--agent", "bernd"],
        ),
        (
            r#"{"schemaVersion":1,"nope":true,"agents":{"bernd":{}}}"#,
            vec!["memory", "list", "--agent", "bernd"],
        ),
        (
            r#"{"schemaVersion":1,"agents":{"bernd":{}},"core":{"recall":{"softBudgetMs":5}}}"#,
            vec!["memory", "recall", "--agent", "bernd", "q"],
        ),
        (
            r#"{"schemaVersion":1,"agents":{"bernd":{}}}"#,
            vec!["config", "get"],
        ),
    ] {
        let dir = tempfile::tempdir().unwrap();
        let h = dir.path().to_str().unwrap();
        let valid = doc.contains(r#""schemaVersion":1,"agents":{"bernd":{}}}"#);
        std::fs::write(dir.path().join("config.json"), doc).unwrap();
        let mut full = vec!["--json", "--home", h];
        full.extend(args.iter());
        let out = bin().args(&full).output().unwrap().stdout;
        let v: serde_json::Value = serde_json::from_slice(&out).unwrap();
        if valid {
            // control: a valid file is not reported as invalid by any path
            assert_ne!(v["error"], "E_CONFIG_INVALID", "{args:?} {v}");
        } else {
            assert_eq!(v["error"], "E_CONFIG_INVALID", "{args:?} {v}");
        }
    }
    // A valid file on a read path still reaches the core lookup.
    let dir = tempfile::tempdir().unwrap();
    let h = dir.path().to_str().unwrap();
    std::fs::write(
        dir.path().join("config.json"),
        r#"{"schemaVersion":1,"agents":{"bernd":{}}}"#,
    )
    .unwrap();
    let out = bin()
        .args(["--json", "--home", h, "memory", "list", "--agent", "bernd"])
        .assert()
        .code(1)
        .get_output()
        .stdout
        .clone();
    let v: serde_json::Value = serde_json::from_slice(&out).unwrap();
    assert_eq!(v["error"], "E_CORE_UNAVAILABLE", "{v}");
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

// ---- config routing through the supervisor (2a-H3b B6) -------------------------------------------------------------

fn json_out(args: &[&str]) -> serde_json::Value {
    let out = bin()
        .args(args)
        .assert()
        .success()
        .get_output()
        .stdout
        .clone();
    serde_json::from_slice(&out).unwrap()
}

#[test]
fn config_set_routes_through_a_running_supervisor() {
    let dir = tempfile::tempdir().unwrap();
    let h = dir.path().to_str().unwrap();
    let _sup = common::start(dir.path());
    let watch = common::Watch::open(dir.path());
    let rev0 = watch.result["revision"].clone();

    let v = json_out(&[
        "--json",
        "--home",
        h,
        "config",
        "set",
        "core.logLevel",
        "debug",
        "--yes",
    ]);
    assert_eq!(v["schema"], "config.set/1");
    assert_eq!(v["applied"], true);
    assert_eq!(v["changed"], serde_json::json!(["core.logLevel"]));
    let n = watch
        .next_change(common::WAIT)
        .expect("the supervisor did not apply it");
    assert_eq!(n["source"], "set");
    assert_eq!(n["previousRevision"], rev0);
    assert_eq!(n["revision"], v["revision"]);
    // The file is the supervisor's write, holding the new value.
    let file: serde_json::Value =
        serde_json::from_str(&std::fs::read_to_string(dir.path().join("config.json")).unwrap())
            .unwrap();
    assert_eq!(file["core"]["logLevel"], "debug");

    // `config get` answers from the running configuration: the CLI's `restart` plus `restartClass` and `revision`.
    let g = json_out(&["--json", "--home", h, "config", "get", "core.logLevel"]);
    assert_eq!(g["schema"], "config.get/1");
    assert_eq!(g["value"], "debug");
    assert_eq!(g["restart"], "live");
    assert_eq!(g["restartClass"], "live");
    assert_eq!(g["revision"], v["revision"]);

    // The human text does not carry the no-supervisor wording.
    bin()
        .args([
            "--home",
            h,
            "config",
            "set",
            "core.logLevel",
            "warn",
            "--yes",
        ])
        .assert()
        .success()
        .stdout(predicate::str::contains("sent to the running core"))
        .stdout(predicate::str::contains("H1").not())
        .stdout(predicate::str::contains("next core start").not());
    // A dry run changes nothing.
    bin()
        .args([
            "--home",
            h,
            "config",
            "set",
            "core.logLevel",
            "error",
            "--dry-run",
        ])
        .assert()
        .success();
    assert_eq!(watch.changes_within(common::TICK * 3).len(), 1); // only the `warn` set
                                                                 // An invalid value is refused by the supervisor.
    bin()
        .args([
            "--home",
            h,
            "config",
            "set",
            "core.logLevel",
            "loud",
            "--yes",
        ])
        .assert()
        .code(1)
        .stderr(predicate::str::contains("logLevel"));
}

#[test]
fn config_set_without_a_supervisor_writes_the_file() {
    let dir = tempfile::tempdir().unwrap();
    let h = dir.path().to_str().unwrap();
    // A supervisor that died without cleaning up: its token remains, its recorded pid is dead.
    let mut gone = std::process::Command::new(assert_cmd::cargo::cargo_bin("plur1bus"))
        .arg("--version")
        .stdout(std::process::Stdio::null())
        .spawn()
        .unwrap();
    let dead = gone.id();
    gone.wait().unwrap();
    std::fs::create_dir_all(dir.path().join("run")).unwrap();
    std::fs::write(dir.path().join("run/supervisor.token"), "a".repeat(64)).unwrap();
    std::fs::write(dir.path().join("run/supervisor.pid"), format!("{dead} x\n")).unwrap();

    let v = json_out(&[
        "--json",
        "--home",
        h,
        "config",
        "set",
        "core.logLevel",
        "debug",
        "--yes",
    ]);
    assert_eq!(v["applied"], true);
    let file =
        plur1bus_config::parse(&std::fs::read_to_string(dir.path().join("config.json")).unwrap())
            .unwrap();
    assert_eq!(file["core"]["logLevel"], "debug");
    assert_eq!(v["revision"], plur1bus_config::revision(&file));
    let g = json_out(&["--json", "--home", h, "config", "get", "core.logLevel"]);
    assert_eq!(g["value"], "debug");
    assert_eq!(g["revision"], v["revision"]);
    // No token at all: the same direct path.
    std::fs::remove_dir_all(dir.path().join("run")).unwrap();
    let v = json_out(&[
        "--json",
        "--home",
        h,
        "config",
        "set",
        "core.logLevel",
        "warn",
        "--yes",
    ]);
    assert_eq!(v["applied"], true);
}

#[cfg(unix)]
#[test]
fn config_set_with_an_unresponsive_supervisor_fails_and_writes_nothing() {
    let dir = tempfile::tempdir().unwrap();
    let h = dir.path().to_str().unwrap();
    std::fs::write(dir.path().join("config.json"), "{\"schemaVersion\":1}\n").unwrap();
    let sup = common::start(dir.path());
    let before = std::fs::read(dir.path().join("config.json")).unwrap();
    // SAFETY: signals to our own child; Supervisor's Drop sends SIGCONT before killing it.
    unsafe { libc::kill(sup.child.id() as i32, libc::SIGSTOP) };
    let out = bin()
        .args([
            "--json",
            "--home",
            h,
            "config",
            "set",
            "core.logLevel",
            "debug",
            "--yes",
        ])
        .timeout(std::time::Duration::from_secs(60))
        .assert()
        .code(1)
        .get_output()
        .stdout
        .clone();
    let v: serde_json::Value = serde_json::from_slice(&out).unwrap();
    assert_eq!(v["error"], "E_NOT_AVAILABLE", "{v}");
    assert_eq!(v["reason"], "supervisor-unresponsive", "{v}");
    assert_eq!(
        std::fs::read(dir.path().join("config.json")).unwrap(),
        before
    );
    drop(sup);
}

#[test]
fn agent_create_routes_through_the_supervisor() {
    let dir = tempfile::tempdir().unwrap();
    let h = dir.path().to_str().unwrap();
    let _sup = common::start(dir.path());
    let watch = common::Watch::open(dir.path());

    bin()
        .args(["--home", h, "agent", "create", "bernd"])
        .assert()
        .success()
        .stdout(predicate::str::contains("created agent bernd"));
    let n = watch
        .next_change(common::WAIT)
        .expect("agent create did not go through the supervisor");
    assert_eq!(n["source"], "set");
    assert_eq!(n["changed"], serde_json::json!(["agents.bernd"]));
    assert!(n["config"]["agents"]["bernd"]["createdAt"]
        .as_str()
        .unwrap()
        .ends_with('Z'));
    let v = json_out(&["--json", "--home", h, "agent", "list"]);
    assert_eq!(v["agents"][0]["agentId"], "bernd");

    // remove sends the agents map minus the agent.
    bin()
        .args(["--home", h, "agent", "create", "anna"])
        .assert()
        .success();
    watch.next_change(common::WAIT).unwrap();
    bin()
        .args(["--home", h, "agent", "remove", "bernd"])
        .assert()
        .success();
    let n = watch.next_change(common::WAIT).unwrap();
    assert_eq!(n["changed"], serde_json::json!(["agents.bernd"]));
    let agents: Vec<&String> = n["config"]["agents"].as_object().unwrap().keys().collect();
    assert_eq!(agents, ["anna"]);
}

// ---- fix round 1: route edge cases and the conflict message ---------------------------------------------------------

/// A stand-in supervisor on `run/supervisor.sock` (unix): writes the token and a pid file naming this (alive) test
/// process, answers `supervisor.auth` with `hello`, and every other request with `answer(method, params)` (a
/// `result` or an `error` object). Every request line is sent to the returned receiver.
#[cfg(unix)]
fn fake_supervisor(
    home: &std::path::Path,
    hello: serde_json::Value,
    answer: impl Fn(&str, &serde_json::Value) -> serde_json::Value + Send + Sync + 'static,
) -> std::sync::mpsc::Receiver<serde_json::Value> {
    use std::io::{BufRead, BufReader, Write};
    let run = home.join("run");
    std::fs::create_dir_all(&run).unwrap();
    let token = "b".repeat(64);
    std::fs::write(run.join("supervisor.token"), &token).unwrap();
    std::fs::write(
        run.join("supervisor.pid"),
        format!("{} fake\n", std::process::id()),
    )
    .unwrap();
    let listener = std::os::unix::net::UnixListener::bind(run.join("supervisor.sock")).unwrap();
    let (tx, rx) = std::sync::mpsc::channel();
    let answer = std::sync::Arc::new(answer);
    std::thread::spawn(move || {
        for s in listener.incoming() {
            let Ok(s) = s else { return };
            let (hello, answer, tx) = (hello.clone(), answer.clone(), tx.clone());
            std::thread::spawn(move || {
                let mut w = s.try_clone().unwrap();
                for line in BufReader::new(s).lines() {
                    let Ok(line) = line else { return };
                    let req: serde_json::Value = serde_json::from_str(&line).unwrap();
                    let _ = tx.send(req.clone());
                    let method = req["method"].as_str().unwrap_or_default();
                    let body = if method == "supervisor.auth" {
                        serde_json::json!({ "result": hello })
                    } else {
                        answer(method, &req["params"])
                    };
                    let mut reply = serde_json::json!({ "jsonrpc": "2.0", "id": req["id"] });
                    for (k, v) in body.as_object().unwrap() {
                        reply[k] = v.clone();
                    }
                    let _ = writeln!(w, "{reply}");
                }
            });
        }
    });
    rx
}

#[cfg(unix)]
fn fake_hello(methods: &[&str]) -> serde_json::Value {
    let m: serde_json::Map<String, serde_json::Value> = methods
        .iter()
        .map(|m| {
            (
                m.to_string(),
                serde_json::json!({ "stability": "experimental", "since": "1.2.0" }),
            )
        })
        .collect();
    serde_json::json!({ "rpc": "1.2.0", "instanceId": "fake", "pid": std::process::id(),
        "capabilities": { "methods": m, "notifications": {}, "extensionPoints": {}, "features": [] } })
}

#[cfg(unix)]
#[test]
fn a_supervisor_without_config_methods_leaves_config_json_to_the_cli() {
    // I2: an H3a supervisor (RPC 1.2.0) never writes config.json; the CLI reads and writes it directly.
    let dir = tempfile::tempdir().unwrap();
    let h = dir.path().to_str().unwrap();
    let seen = fake_supervisor(
        dir.path(),
        fake_hello(&[
            "supervisor.auth",
            "daemon.status",
            "daemon.start",
            "daemon.stop",
        ]),
        |m, _| serde_json::json!({ "error": { "code": -32601, "message": format!("method not found: {m}") } }),
    );
    let v = json_out(&[
        "--json",
        "--home",
        h,
        "config",
        "set",
        "core.logLevel",
        "debug",
        "--yes",
    ]);
    assert_eq!(v["applied"], true);
    let file =
        plur1bus_config::parse(&std::fs::read_to_string(dir.path().join("config.json")).unwrap())
            .unwrap();
    assert_eq!(file["core"]["logLevel"], "debug");
    assert_eq!(
        json_out(&["--json", "--home", h, "config", "get", "core.logLevel"])["value"],
        "debug"
    );
    bin()
        .args(["--home", h, "agent", "create", "bernd"])
        .assert()
        .success();
    assert_eq!(
        json_out(&["--json", "--home", h, "agent", "list"])["agents"][0]["agentId"],
        "bernd"
    );
    let methods: Vec<String> = seen
        .try_iter()
        .map(|r| r["method"].as_str().unwrap().to_string())
        .collect();
    assert!(
        methods.iter().all(|m| m == "supervisor.auth"),
        "{methods:?}"
    );
}

#[cfg(unix)]
#[test]
fn a_live_pid_with_a_refused_socket_counts_as_no_supervisor() {
    // B6: a token and a recorded pid that is alive (this test), but nothing listens on the socket.
    let dir = tempfile::tempdir().unwrap();
    let h = dir.path().to_str().unwrap();
    let run = dir.path().join("run");
    std::fs::create_dir_all(&run).unwrap();
    std::fs::write(run.join("supervisor.token"), "c".repeat(64)).unwrap();
    std::fs::write(
        run.join("supervisor.pid"),
        format!("{} x\n", std::process::id()),
    )
    .unwrap();
    common::dead_socket(&run.join("supervisor.sock"));
    let v = json_out(&[
        "--json",
        "--home",
        h,
        "config",
        "set",
        "core.logLevel",
        "warn",
        "--yes",
    ]);
    assert_eq!(v["applied"], true);
    let file =
        plur1bus_config::parse(&std::fs::read_to_string(dir.path().join("config.json")).unwrap())
            .unwrap();
    assert_eq!(file["core"]["logLevel"], "warn");
}

#[cfg(unix)]
#[test]
fn a_conflict_between_preview_and_apply_says_changed_meanwhile() {
    // Review Focus 2 at the CLI: the supervisor refuses the apply's ifRevision.
    let dir = tempfile::tempdir().unwrap();
    let h = dir.path().to_str().unwrap();
    let seen = fake_supervisor(
        dir.path(),
        fake_hello(&[
            "supervisor.auth",
            "config.get",
            "config.set",
            "config.watch",
        ]),
        |_, p| {
            if p["dryRun"] == true {
                serde_json::json!({ "result": { "applied": false, "dryRun": true, "changed": ["core.logLevel"],
                    "restart": { "live": ["core.logLevel"], "core": false, "modules": [] },
                    "revision": "1111111111111111", "restarted": [], "durationMs": 0 } })
            } else {
                serde_json::json!({ "error": { "code": -32000, "message": "config.json changed since the given revision",
                    "data": { "error": "E_CONFLICT", "reason": "config-changed", "ids": { "currentRevision": "2222222222222222" } } } })
            }
        },
    );
    std::fs::write(dir.path().join("config.json"), "{\"schemaVersion\":1}\n").unwrap();
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
        .code(1)
        .stderr(predicate::str::contains(
            "config.json changed meanwhile; re-run",
        ));
    let out = bin()
        .args([
            "--json",
            "--home",
            h,
            "config",
            "set",
            "core.logLevel",
            "debug",
            "--yes",
        ])
        .assert()
        .code(1)
        .get_output()
        .stdout
        .clone();
    let v: serde_json::Value = serde_json::from_slice(&out).unwrap();
    assert_eq!(v["error"], "E_CONFLICT", "{v}");
    assert_eq!(v["reason"], "config-changed");
    assert_eq!(v["ids"]["currentRevision"], "2222222222222222");
    // The apply carried the previewed revision; nothing was written by the CLI.
    let applies: Vec<serde_json::Value> = seen
        .try_iter()
        .filter(|r| r["method"] == "config.set" && r["params"]["dryRun"].is_null())
        .collect();
    assert!(!applies.is_empty());
    assert!(applies
        .iter()
        .all(|r| r["params"]["ifRevision"] == "1111111111111111"));
    assert_eq!(
        std::fs::read_to_string(dir.path().join("config.json")).unwrap(),
        "{\"schemaVersion\":1}\n"
    );
}

/// Final review M4: only the supervisor (or a command that writes the configuration) creates config.json. Offline
/// `module list` and `admin obsidian` read it, and on a fresh home they run against the defaults without creating it.
#[test]
fn offline_module_list_and_admin_obsidian_do_not_create_config_json() {
    let dir = tempfile::tempdir().unwrap();
    let home = dir.path().to_str().unwrap();
    let out = bin()
        .args(["--json", "--home", home, "module", "list"])
        .env("PLUR1BUS_ALLOW_TEST_INTERNALS", "1")
        .assert()
        .success()
        .get_output()
        .stdout
        .clone();
    let v: serde_json::Value = serde_json::from_slice(&out).unwrap();
    assert_eq!(v["schema"], "module.list/1", "{v}");
    assert!(!dir.path().join("config.json").exists(), "module list");

    // The defaults register no agent: refused before any RPC, and still nothing written.
    let out = bin()
        .args([
            "--json", "--home", home, "admin", "obsidian", "detect", "--agent", "bernd",
        ])
        .assert()
        .failure()
        .get_output()
        .stdout
        .clone();
    let v: serde_json::Value = serde_json::from_slice(&out).unwrap();
    assert_eq!(v["error"], "E_AGENT_UNKNOWN", "{v}");
    assert!(!dir.path().join("config.json").exists(), "admin obsidian");
}

/// K4: `println!` panics when stdout is a closed pipe (`plur1bus … | head -1`). The output helper must not panic and
/// must not decide the exit code: a successful read command still exits 0, a failing one keeps its code.
#[cfg(unix)]
fn closed_stdout(home: &std::path::Path, args: &[&str]) -> (Option<i32>, String) {
    let mut c = std::process::Command::new(env!("CARGO_BIN_EXE_plur1bus"));
    c.arg("--home")
        .arg(home)
        .args(args)
        .env("PLUR1BUS_ALLOW_TEST_INTERNALS", "1")
        .stdin(std::process::Stdio::null());
    let (code, stderr) = common::run_closed_stdout(&mut c);
    assert!(!stderr.contains("panicked"), "stderr: {stderr}");
    assert_ne!(code, Some(101), "stderr: {stderr}");
    (code, stderr)
}

#[cfg(unix)]
#[test]
fn a_closed_stdout_pipe_is_not_a_panic() {
    let home = tempfile::tempdir().unwrap();
    let (code, stderr) = closed_stdout(home.path(), &["__markdown"]);
    assert_eq!(code, Some(0), "a successful command stays 0: {stderr}");
}

/// A closed stdout must not turn a failing command into a success: `config get` of an unknown key is exit 1 with the
/// pipe open, and exit 1 with it closed (the `fail` document is dropped, the exit code is not).
#[cfg(unix)]
#[test]
fn a_closed_stdout_pipe_keeps_the_failing_exit_code() {
    let home = tempfile::tempdir().unwrap();
    let open = bin()
        .args(["--json", "--home"])
        .arg(home.path())
        .args(["config", "get", "no.such.key"])
        .assert()
        .failure()
        .get_output()
        .status
        .code();
    assert_eq!(open, Some(1));
    let (code, stderr) = closed_stdout(home.path(), &["--json", "config", "get", "no.such.key"]);
    assert_eq!(code, Some(1), "stderr: {stderr}");
}

/// A successful read command with a closed stdout (human and `--json`) exits 0.
#[cfg(unix)]
#[test]
fn a_closed_stdout_pipe_on_a_successful_read_exits_0() {
    let home = tempfile::tempdir().unwrap();
    for args in [
        &["config", "get", "core.logLevel"][..],
        &["--json", "config", "get", "core.logLevel"][..],
    ] {
        let (code, stderr) = closed_stdout(home.path(), args);
        assert_eq!(code, Some(0), "{args:?}: {stderr}");
    }
}

/// Runs the binary with stdout AND stderr pipes whose readers are gone, so every write to either fails from byte 0.
#[cfg(unix)]
fn closed_stdout_and_stderr(home: &std::path::Path, args: &[&str]) -> Option<i32> {
    let (r1, w1) = std::io::pipe().unwrap();
    let (r2, w2) = std::io::pipe().unwrap();
    drop((r1, r2));
    let mut child = std::process::Command::new(env!("CARGO_BIN_EXE_plur1bus"))
        .arg("--home")
        .arg(home)
        .args(args)
        .env("PLUR1BUS_ALLOW_TEST_INTERNALS", "1")
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::from(w1))
        .stderr(std::process::Stdio::from(w2))
        .spawn()
        .unwrap();
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(60);
    loop {
        if let Some(st) = child.try_wait().unwrap() {
            return st.code();
        }
        if std::time::Instant::now() > deadline {
            let _ = child.kill();
            let _ = child.wait();
            return None;
        }
        std::thread::sleep(std::time::Duration::from_millis(20));
    }
}

/// `write_stdout` and `fail` must not panic (exit 101) when stderr is closed as well as stdout: the exit code is kept.
#[cfg(unix)]
#[test]
fn closed_stdout_and_stderr_keep_the_exit_code_without_a_panic() {
    let home = tempfile::tempdir().unwrap();
    assert_eq!(
        closed_stdout_and_stderr(home.path(), &["__markdown"]),
        Some(0)
    );
    assert_eq!(
        closed_stdout_and_stderr(home.path(), &["config", "get", "core.logLevel"]),
        Some(0)
    );
    // Failing command, human and --json: `fail` writes to stderr / stdout, both gone.
    assert_eq!(
        closed_stdout_and_stderr(home.path(), &["config", "get", "no.such.key"]),
        Some(1)
    );
    assert_eq!(
        closed_stdout_and_stderr(home.path(), &["--json", "config", "get", "no.such.key"]),
        Some(1)
    );
}

/// A real write error (`EFBIG`, see `common::run_stdout_write_error`) exits 1 for a command that returns to `main`,
/// and is reported once on stderr.
#[cfg(unix)]
#[test]
fn a_real_stdout_write_error_exits_1() {
    let home = tempfile::tempdir().unwrap();
    let mut c = std::process::Command::new(env!("CARGO_BIN_EXE_plur1bus"));
    c.arg("--home")
        .arg(home.path())
        .args(["config", "get", "core.logLevel"])
        .env("PLUR1BUS_ALLOW_TEST_INTERNALS", "1");
    let (code, stderr) = common::run_stdout_write_error(&mut c);
    assert!(stderr.contains("cannot write to stdout"), "{stderr}");
    assert_eq!(code, Some(1), "{stderr}");
}
