//! The supervisor owns config.json (2a-H3b rulings B3–B5, B18): `config.get|set|watch`, `config.changed`, revisions
//! and conflicts, and the polling watcher (hand edits, rejections, non-atomic saves). `supervise --no-core` in a temp
//! home; the watcher ticks every 200 ms (time scale 0.2). The restart tests (2a-H3b B7, B8) run `supervise` with the
//! fake core instead.
mod common;

use common::{assert_valid, client, start, wait_until, Watch, TICK, WAIT};
use plur1bus_rpc::types::ErrorCode;
use plur1bus_rpc::{Client, RpcError};
use serde_json::{json, Value};
use std::path::Path;
use std::time::Duration;

fn config_path(home: &Path) -> std::path::PathBuf {
    home.join("config.json")
}

fn write_config(home: &Path, v: &Value) {
    std::fs::write(config_path(home), serde_json::to_string_pretty(v).unwrap()).unwrap();
}

/// config.json as the supervisor would load it (defaults filled in).
fn file_config(home: &Path) -> Value {
    plur1bus_config::parse(&std::fs::read_to_string(config_path(home)).unwrap()).unwrap()
}

fn running(c: &mut Client) -> (Value, String) {
    let v = c.call("config.get", json!({})).unwrap();
    (
        v["value"].clone(),
        v["revision"].as_str().unwrap().to_string(),
    )
}

fn status_config(c: &mut Client) -> Value {
    let s = c.call("daemon.status", json!({})).unwrap();
    assert_valid("methods/daemon.status/result", &s);
    s["config"].clone()
}

fn set(c: &mut Client, params: Value) -> Result<Value, RpcError> {
    c.call("config.set", params)
}

fn change(key: &str, value: Value) -> Value {
    json!({ "changes": [{ "key": key, "value": value }] })
}

/// (error, reason, detail, ids) of a failed call.
fn call_error(r: Result<Value, RpcError>) -> (ErrorCode, Option<String>, Option<String>, Value) {
    match r {
        Err(RpcError::Call {
            error,
            reason,
            detail,
            ids,
            ..
        }) => (error, reason, detail, json!(ids)),
        other => panic!("expected a call error, got {other:?}"),
    }
}

fn level(config: &Value) -> &str {
    config["core"]["logLevel"].as_str().unwrap()
}

#[test]
fn config_get_returns_the_running_config_and_its_revision() {
    let dir = tempfile::tempdir().unwrap();
    let home = dir.path();
    write_config(
        home,
        &json!({ "schemaVersion": 1, "core": { "logLevel": "warn" } }),
    );
    let _sup = start(home);
    let mut c = client(home);

    let whole = c.call("config.get", json!({})).unwrap();
    assert_valid("methods/config.get/result", &whole);
    assert_eq!(whole["value"], file_config(home));
    assert_eq!(level(&whole["value"]), "warn");
    assert_eq!(
        whole["revision"],
        plur1bus_config::revision(&file_config(home))
    );
    assert!(whole["key"].is_null() && whole["restartClass"].is_null());

    let one = c
        .call("config.get", json!({ "key": "core.logLevel" }))
        .unwrap();
    assert_valid("methods/config.get/result", &one);
    assert_eq!(one["value"], "warn");
    assert_eq!(one["restartClass"], "live");
    assert_eq!(one["restart"], "live");
    assert_eq!(one["revision"], whole["revision"]);
    let core = c
        .call("config.get", json!({ "key": "embedding.useClass" }))
        .unwrap();
    assert_eq!(core["restartClass"], "core");

    let basic = c.call("config.get", json!({ "tier": "basic" })).unwrap();
    assert_valid("methods/config.get/result", &basic);
    assert_eq!(basic["tier"], "basic");
    assert!(basic["value"].get("core").is_none());

    let (e, reason, _, _) = call_error(c.call("config.get", json!({ "key": "no.such.key" })));
    assert_eq!(
        (e, reason.as_deref()),
        (ErrorCode::EInvalidParams, Some("unknown-key"))
    );
    let (e, ..) = call_error(c.call(
        "config.get",
        json!({ "key": "core.logLevel", "tier": "basic" }),
    ));
    assert_eq!(e, ErrorCode::EInvalidParams);
    let (e, ..) = call_error(c.call("config.get", json!({ "extra": true })));
    assert_eq!(e, ErrorCode::EInvalidParams);
}

#[test]
fn config_set_writes_atomically_emits_config_changed_and_reports_the_plan() {
    let dir = tempfile::tempdir().unwrap();
    let home = dir.path();
    let _sup = start(home);
    let mut c = client(home);
    let watch = Watch::open(home);
    assert_valid("methods/config.watch/result", &watch.result);
    let (before, rev0) = running(&mut c);
    assert_eq!(watch.result["revision"], rev0);
    assert_eq!(watch.result["config"], before);

    let r = set(&mut c, change("core.logLevel", json!("debug"))).unwrap();
    assert_valid("methods/config.set/result", &r);
    assert_eq!(r["applied"], true);
    assert_eq!(r["dryRun"], false);
    assert_eq!(r["changed"], json!(["core.logLevel"]));
    assert_eq!(
        r["restart"],
        json!({ "live": ["core.logLevel"], "core": false, "modules": [] })
    );
    assert_eq!(r["restarted"], json!([]));
    let rev1 = r["revision"].as_str().unwrap().to_string();
    assert_ne!(rev1, rev0);

    let n = watch.next_change(WAIT).expect("no config.changed");
    assert_valid("notifications/config.changed", &n);
    assert_eq!(n["source"], "set");
    assert_eq!(n["revision"], rev1);
    assert_eq!(n["previousRevision"], rev0);
    assert_eq!(n["changed"], json!(["core.logLevel"]));
    assert_eq!(n["restart"]["live"], json!(["core.logLevel"]));
    assert_eq!(level(&n["config"]), "debug");

    // The file holds exactly the running configuration; no temp file is left; the watcher does not re-apply it.
    let (after, rev) = running(&mut c);
    assert_eq!(rev, rev1);
    assert_eq!(file_config(home), after);
    let leftovers: Vec<_> = std::fs::read_dir(home)
        .unwrap()
        .filter_map(|e| e.ok())
        .map(|e| e.file_name().to_string_lossy().into_owned())
        .filter(|n| n.starts_with("config.json."))
        .collect();
    assert!(leftovers.is_empty(), "{leftovers:?}");
    assert!(watch.changes_within(TICK * 4).is_empty());

    // Two changes, one set: all applied, one notification.
    let r = set(
        &mut c,
        json!({ "changes": [
            { "key": "core.logLevel", "value": "warn" },
            { "key": "supervisor.healthIntervalMs", "value": 7000 }
        ] }),
    )
    .unwrap();
    assert_eq!(
        r["changed"],
        json!(["core.logLevel", "supervisor.healthIntervalMs"])
    );
    let n = watch.next_change(WAIT).unwrap();
    assert_eq!(n["previousRevision"], rev1);
    assert_eq!(n["config"]["supervisor"]["healthIntervalMs"], 7000);
}

#[test]
fn dry_run_changes_nothing() {
    let dir = tempfile::tempdir().unwrap();
    let home = dir.path();
    write_config(home, &json!({ "schemaVersion": 1 }));
    let _sup = start(home);
    let mut c = client(home);
    let watch = Watch::open(home);
    let bytes = std::fs::read(config_path(home)).unwrap();
    let mtime = std::fs::metadata(config_path(home))
        .unwrap()
        .modified()
        .unwrap();
    let (_, rev) = running(&mut c);

    let mut p = change("engine.recallMinScore", json!(0.5));
    p["dryRun"] = json!(true);
    let r = set(&mut c, p).unwrap();
    assert_valid("methods/config.set/result", &r);
    assert_eq!(r["applied"], false);
    assert_eq!(r["dryRun"], true);
    assert_eq!(r["changed"], json!(["engine.recallMinScore"]));
    assert_eq!(r["restart"]["core"], true);
    assert_eq!(r["revision"], rev);

    assert_eq!(std::fs::read(config_path(home)).unwrap(), bytes);
    assert_eq!(
        std::fs::metadata(config_path(home))
            .unwrap()
            .modified()
            .unwrap(),
        mtime
    );
    assert_eq!(running(&mut c).1, rev);
    assert!(watch.changes_within(TICK * 4).is_empty());
}

#[test]
fn an_invalid_value_is_e_config_invalid_and_nothing_changes() {
    let dir = tempfile::tempdir().unwrap();
    let home = dir.path();
    write_config(home, &json!({ "schemaVersion": 1 }));
    let _sup = start(home);
    let mut c = client(home);
    let watch = Watch::open(home);
    let bytes = std::fs::read(config_path(home)).unwrap();
    let (_, rev) = running(&mut c);

    let (e, _, detail, _) = call_error(set(&mut c, change("core.logLevel", json!("loud"))));
    assert_eq!(e, ErrorCode::EConfigInvalid);
    assert!(
        detail.as_deref().unwrap_or_default().contains("logLevel"),
        "{detail:?}"
    );
    // One bad change refuses the whole batch.
    let (e, ..) = call_error(set(
        &mut c,
        json!({ "changes": [
            { "key": "core.logLevel", "value": "debug" },
            { "key": "core.recall.softBudgetMs", "value": "abc" }
        ] }),
    ));
    assert_eq!(e, ErrorCode::EConfigInvalid);
    // Params outside the schema are E_INVALID_PARAMS.
    for bad in [
        json!({ "changes": [] }),
        json!({ "changes": [{ "key": "core.logLevel" }] }),
        json!({ "changes": [{ "key": "core.logLevel", "value": "debug", "op": "set" }] }),
        json!({ "changes": [{ "key": "core.logLevel", "value": "debug" }], "force": true }),
    ] {
        let (e, ..) = call_error(set(&mut c, bad.clone()));
        assert_eq!(e, ErrorCode::EInvalidParams, "{bad}");
    }
    assert_eq!(std::fs::read(config_path(home)).unwrap(), bytes);
    assert_eq!(running(&mut c).1, rev);
    assert!(watch.changes_within(TICK * 3).is_empty());
}

#[test]
fn set_with_a_stale_revision_is_a_conflict_and_writes_nothing() {
    // Review Focus 2: the CLI previews against one revision and applies against another.
    let dir = tempfile::tempdir().unwrap();
    let home = dir.path();
    write_config(home, &json!({ "schemaVersion": 1 }));
    let _sup = start(home);
    let mut c = client(home);
    let mut preview = change("core.logLevel", json!("debug"));
    preview["dryRun"] = json!(true);
    let previewed = set(&mut c, preview).unwrap()["revision"].clone();

    // A second writer gets in between (a hand edit the watcher applies).
    write_config(
        home,
        &json!({ "schemaVersion": 1, "core": { "logLevel": "error" } }),
    );
    wait_until("the hand edit to apply", WAIT, || {
        level(&running(&mut c).0) == "error"
    });
    let bytes = std::fs::read(config_path(home)).unwrap();
    let (_, current) = running(&mut c);

    let mut apply = change("core.logLevel", json!("debug"));
    apply["ifRevision"] = previewed;
    let (e, reason, _, ids) = call_error(set(&mut c, apply));
    assert_eq!(e, ErrorCode::EConflict);
    assert_eq!(reason.as_deref(), Some("config-changed"));
    assert_eq!(ids["currentRevision"], current);
    assert_eq!(std::fs::read(config_path(home)).unwrap(), bytes);
    assert_eq!(running(&mut c).1, current);

    // A dry run checks the revision too; the current one applies.
    let mut p = change("core.logLevel", json!("debug"));
    p["ifRevision"] = json!("0000000000000000");
    p["dryRun"] = json!(true);
    assert_eq!(call_error(set(&mut c, p)).0, ErrorCode::EConflict);
    let mut p = change("core.logLevel", json!("debug"));
    p["ifRevision"] = json!(current);
    assert_eq!(set(&mut c, p).unwrap()["applied"], true);
}

#[test]
fn a_valid_hand_edit_is_applied_like_a_set() {
    let dir = tempfile::tempdir().unwrap();
    let home = dir.path();
    write_config(home, &json!({ "schemaVersion": 1 }));
    let _sup = start(home);
    let mut c = client(home);
    let watch = Watch::open(home);
    let (_, rev0) = running(&mut c);

    write_config(
        home,
        &json!({ "schemaVersion": 1, "core": { "logLevel": "error" } }),
    );
    let n = watch
        .next_change(WAIT)
        .expect("no config.changed for the hand edit");
    assert_valid("notifications/config.changed", &n);
    assert_eq!(n["source"], "file");
    assert_eq!(n["previousRevision"], rev0);
    assert_eq!(n["changed"], json!(["core.logLevel"]));
    assert_eq!(level(&n["config"]), "error");
    let (now, rev) = running(&mut c);
    assert_eq!(rev, n["revision"]);
    assert_eq!(now, file_config(home));
    // Applied once; the file is not rewritten by the supervisor.
    assert!(watch.changes_within(TICK * 4).is_empty());
    assert_eq!(
        std::fs::read_to_string(config_path(home)).unwrap(),
        serde_json::to_string_pretty(
            &json!({ "schemaVersion": 1, "core": { "logLevel": "error" } })
        )
        .unwrap()
    );
    // A reformatted file with the same content changes nothing.
    std::fs::write(
        config_path(home),
        json!({ "core": { "logLevel": "error" }, "schemaVersion": 1 }).to_string(),
    )
    .unwrap();
    assert!(watch.changes_within(TICK * 4).is_empty());
    assert_eq!(running(&mut c).1, rev);
}

#[test]
fn an_invalid_hand_edit_is_rejected_the_running_config_stays_and_daemon_status_shows_it() {
    let dir = tempfile::tempdir().unwrap();
    let home = dir.path();
    write_config(home, &json!({ "schemaVersion": 1 }));
    let _sup = start(home);
    let mut c = client(home);
    let watch = Watch::open(home);
    let (before, rev) = running(&mut c);
    let st = status_config(&mut c);
    assert_eq!(st, json!({ "revision": rev, "rejected": null }));

    let broken = r#"{"schemaVersion":1,"core":{"logLevel":"loud"}}"#;
    std::fs::write(config_path(home), broken).unwrap();
    // `fs::write` truncates, then writes: a tick in between rejects the empty file first ("not JSON").
    wait_until("daemon.status.config.rejected", WAIT, || {
        status_config(&mut c)["rejected"]["errors"]
            .to_string()
            .contains("logLevel")
    });
    let st = status_config(&mut c);
    assert_eq!(st["revision"], rev);
    let errors = st["rejected"]["errors"].as_array().unwrap();
    assert!(
        errors
            .iter()
            .any(|e| e.as_str().unwrap().contains("logLevel")),
        "{st}"
    );
    assert!(st["rejected"]["at"].as_u64().unwrap() > 0);
    assert_eq!(running(&mut c), (before, rev.clone()));
    assert!(watch.changes_within(TICK * 3).is_empty());
    // The watcher never rewrites the file.
    assert_eq!(std::fs::read_to_string(config_path(home)).unwrap(), broken);

    // Reverting to what runs clears the rejection without a change.
    write_config(home, &json!({ "schemaVersion": 1 }));
    wait_until("the rejection to clear", WAIT, || {
        status_config(&mut c)["rejected"].is_null()
    });
    assert!(watch.changes_within(TICK * 2).is_empty());
    assert_eq!(running(&mut c).1, rev);
}

#[test]
fn a_truncated_then_completed_edit_applies_once() {
    // Review Focus 1: an editor that truncates, then writes.
    let dir = tempfile::tempdir().unwrap();
    let home = dir.path();
    write_config(home, &json!({ "schemaVersion": 1 }));
    let _sup = start(home);
    let mut c = client(home);
    let watch = Watch::open(home);
    let (before, _) = running(&mut c);

    std::fs::write(config_path(home), "{").unwrap();
    // The watcher saw the truncated file and rejected it; the running configuration did not change.
    wait_until("the truncated file to be rejected", WAIT, || {
        status_config(&mut c)["rejected"].is_object()
    });
    assert_eq!(running(&mut c).0, before);
    write_config(
        home,
        &json!({ "schemaVersion": 1, "core": { "logLevel": "debug" } }),
    );

    let changes = watch.changes_within(TICK * 6);
    assert_eq!(changes.len(), 1, "{changes:?}");
    assert_eq!(changes[0]["source"], "file");
    assert_eq!(level(&changes[0]["config"]), "debug");
    assert!(status_config(&mut c)["rejected"].is_null());
    assert_eq!(level(&running(&mut c).0), "debug");
}

#[test]
fn a_set_over_a_rejected_file_backs_it_up() {
    let dir = tempfile::tempdir().unwrap();
    let home = dir.path();
    write_config(home, &json!({ "schemaVersion": 1 }));
    let _sup = start(home);
    let mut c = client(home);
    let broken = "{ \"schemaVersion\": 1, \"core\": ";
    std::fs::write(config_path(home), broken).unwrap();
    wait_until("the rejection", WAIT, || {
        status_config(&mut c)["rejected"].is_object()
    });

    let r = set(&mut c, change("core.logLevel", json!("debug"))).unwrap();
    assert_eq!(r["applied"], true);
    let backups: Vec<_> = std::fs::read_dir(home)
        .unwrap()
        .filter_map(|e| e.ok())
        .filter(|e| {
            e.file_name()
                .to_string_lossy()
                .starts_with("config.json.rejected-")
        })
        .collect();
    assert_eq!(backups.len(), 1);
    assert_eq!(std::fs::read_to_string(backups[0].path()).unwrap(), broken);
    assert_eq!(level(&file_config(home)), "debug");
    assert!(status_config(&mut c)["rejected"].is_null());
    assert_eq!(file_config(home), running(&mut c).0);
}

#[test]
fn an_invalid_file_at_start_answers_config_unavailable() {
    // B18: nothing runs until a valid file appears.
    let dir = tempfile::tempdir().unwrap();
    let home = dir.path();
    std::fs::write(config_path(home), "{ not json").unwrap();
    let _sup = start(home);
    let mut c = client(home);

    for (method, params) in [
        ("config.get", json!({})),
        ("config.set", change("core.logLevel", json!("debug"))),
    ] {
        let (e, reason, ..) = call_error(c.call(method, params));
        assert_eq!(e, ErrorCode::ENotAvailable, "{method}");
        assert_eq!(reason.as_deref(), Some("config-unavailable"), "{method}");
    }
    let (_rx, reply) = Watch::raw_watch(home);
    assert_eq!(
        reply["error"]["data"]["error"], "E_NOT_AVAILABLE",
        "{reply}"
    );
    assert_eq!(
        reply["error"]["data"]["reason"], "config-unavailable",
        "{reply}"
    );
    let st = status_config(&mut c);
    assert!(st["revision"].is_null(), "{st}");
    assert!(
        st["rejected"]["errors"]
            .as_array()
            .is_some_and(|e| !e.is_empty()),
        "{st}"
    );
    assert_eq!(
        std::fs::read_to_string(config_path(home)).unwrap(),
        "{ not json"
    );

    // The first valid file runs.
    write_config(
        home,
        &json!({ "schemaVersion": 1, "core": { "logLevel": "warn" } }),
    );
    wait_until("a running configuration", WAIT, || {
        c.call("config.get", json!({})).is_ok()
    });
    assert_eq!(level(&running(&mut c).0), "warn");
    let st = status_config(&mut c);
    assert!(
        st["revision"].is_string() && st["rejected"].is_null(),
        "{st}"
    );
    let w = Watch::open(home);
    assert_eq!(level(&w.result["config"]), "warn");
}

#[cfg(unix)]
// H3B-R18: supervisor writes on Windows have no deadline, so a never-reading client is not tested there.
#[test]
fn a_subscriber_that_never_reads_is_dropped_and_set_stays_fast() {
    use std::io::Read;
    let dir = tempfile::tempdir().unwrap();
    let home = dir.path();
    let _sup = start(home);
    let mut c = client(home);
    // Large notifications (every config.changed carries the whole configuration), so the socket buffer fills.
    let agents: serde_json::Map<String, Value> = (0..200)
        .map(|i| {
            (
                format!("agent-{i:03}"),
                json!({ "displayName": "x".repeat(128) }),
            )
        })
        .collect();
    set(&mut c, change("agents", Value::Object(agents))).unwrap();

    let mut stuck = common::raw(home);
    common::send_watch(stuck.as_mut(), home); // …and never reads
    std::thread::sleep(TICK);
    for i in 0..100 {
        let lvl = if i % 2 == 0 { "debug" } else { "info" };
        let t = std::time::Instant::now();
        set(&mut c, change("core.logLevel", json!(lvl))).unwrap();
        assert!(
            t.elapsed() < Duration::from_secs(1),
            "set {i} took {:?}",
            t.elapsed()
        );
    }
    let log = || std::fs::read_to_string(home.join("logs/supervisor.log")).unwrap_or_default();
    wait_until("the drop to be logged", WAIT, || {
        log()
            .lines()
            .any(|l| l.contains("config.watch subscriber dropped") && l.contains("not-reading"))
    });
    // Its connection was closed: after what was buffered, the reader sees the end.
    let mut sink = Vec::new();
    let _ = stuck.read_to_end(&mut sink);
    // A reading subscriber still works.
    let w = Watch::open(home);
    set(&mut c, change("core.logLevel", json!("warn"))).unwrap();
    assert_eq!(level(&w.next_change(WAIT).unwrap()["config"]), "warn");
}

/// The core's `process.state` in a `daemon.status` child.
fn child_state(child: &Value) -> &str {
    child["process"]["state"].as_str().unwrap_or("")
}

fn ready_pid(c: &mut Client) -> u64 {
    let child = common::wait_child(c, "a ready core", WAIT, |ch| child_state(ch) == "ready");
    child["pid"].as_u64().unwrap()
}

#[test]
fn a_core_key_change_restarts_the_core_once_and_reports_it() {
    let dir = tempfile::tempdir().unwrap();
    let home = dir.path().join("home");
    std::fs::create_dir_all(&home).unwrap();
    let events = dir.path().join("events.jsonl");
    // H3B-R6: every fake core calls config.watch before it listens, so the respawned core can only become ready if
    // the set released the config mutex before it waited for the restart.
    let _sup = common::start_with_core(&home, &events, "0.2", &[("FAKE_CORE_WATCH_CONFIG", "1")]);
    let mut c = client(&home);
    let before = ready_pid(&mut c);
    let r = set(&mut c, change("engine.duplicateThreshold", json!(1.01))).unwrap();
    assert_valid("methods/config.set/result", &r);
    assert_eq!(r["restart"]["core"], true);
    assert_eq!(r["restarted"], json!(["core"]));
    assert!(r["estimates"]["core"].is_u64(), "{r}");
    assert!(r["durationMs"].is_u64(), "{r}");
    let child = common::core_child(&mut c);
    assert_eq!(child_state(&child), "ready", "{child}");
    let after = child["pid"].as_u64().unwrap();
    assert_ne!(after, before, "a new core process");
    assert_eq!(child["lastExit"]["reason"], "none", "{child}");
    assert_eq!(child["restarts"], 1, "{child}");
    // The new core watched the configuration it now runs.
    let watched = common::fake_core_events(&events, "config-watched");
    assert!(
        watched
            .iter()
            .any(|e| e["pid"].as_u64() == Some(after) && e["revision"] == r["revision"]),
        "{watched:?}"
    );
    // M3: a dry run carries the estimate too.
    let dry = set(
        &mut c,
        json!({ "changes": [{ "key": "engine.duplicateThreshold", "value": 1.02 }], "dryRun": true }),
    )
    .unwrap();
    assert_valid("methods/config.set/result", &dry);
    assert!(dry["estimates"]["core"].is_u64(), "{dry}");
    assert_eq!(dry["restarted"], json!([]));
    // Once: no second restart follows.
    std::thread::sleep(TICK * 10);
    let child = common::core_child(&mut c);
    assert_eq!(child["pid"].as_u64(), Some(after), "{child}");
    assert_eq!(common::fake_core_events(&events, "started").len(), 2);
}

#[test]
fn requested_restarts_never_count_toward_give_up() {
    let dir = tempfile::tempdir().unwrap();
    let home = dir.path().join("home");
    std::fs::create_dir_all(&home).unwrap();
    let events = dir.path().join("events.jsonl");
    let _sup = common::start_with_core(&home, &events, common::SCALE, &[]);
    let mut c = client(&home);
    let mut pid = ready_pid(&mut c);
    // Six requested restarts well inside the 10 min × 0.2 window, where five crashes would give up.
    for i in 1..=6u64 {
        let r = set(
            &mut c,
            change("engine.duplicateThreshold", json!(1.0 + i as f64 / 100.0)),
        )
        .unwrap();
        assert_eq!(r["restarted"], json!(["core"]), "set {i}: {r}");
        let child = common::core_child(&mut c);
        assert_ne!(child_state(&child), "crashed", "set {i}: {child}");
        let now = child["pid"].as_u64().expect("a running core");
        assert_ne!(now, pid, "set {i} restarted the core");
        pid = now;
    }
    let child = common::wait_child(&mut c, "ready", WAIT, |ch| child_state(ch) == "ready");
    assert_eq!(child["restarts"], 6, "{child}");
    assert!(child["nextRestartAt"].is_null(), "{child}");
}

#[test]
fn a_core_reporting_restart_pending_is_restarted_once() {
    let dir = tempfile::tempdir().unwrap();
    let home = dir.path().join("home");
    std::fs::create_dir_all(&home).unwrap();
    let events = dir.path().join("events.jsonl");
    let _sup =
        common::start_with_core(&home, &events, "0.2", &[("FAKE_CORE_RESTART_PENDING", "1")]);
    let mut c = client(&home);
    wait_until("the first core", WAIT, || {
        !common::fake_core_events(&events, "started").is_empty()
    });
    let child = common::wait_child(&mut c, "one requested restart", WAIT, |ch| {
        ch["restarts"] == 1 && child_state(ch) == "ready"
    });
    assert_eq!(child["lastExit"]["reason"], "none", "{child}");
    let pid = child["pid"].as_u64().unwrap();
    // The new generation reports nothing pending: it stays (health polls every 1 s here).
    std::thread::sleep(Duration::from_secs(3));
    let child = common::core_child(&mut c);
    assert_eq!(child["pid"].as_u64(), Some(pid), "{child}");
    assert_eq!(child["restarts"], 1, "{child}");
    let log = std::fs::read_to_string(home.join("logs/supervisor.log")).unwrap();
    assert_eq!(
        log.lines()
            .filter(|l| l.contains("core reports a pending core-class config change"))
            .count(),
        1,
        "{log}"
    );
}

// ---- fix round 1 ---------------------------------------------------------------------------------------------------

/// The names of `config.json.rejected-*` backups in `home`.
fn backups(home: &Path) -> Vec<std::path::PathBuf> {
    std::fs::read_dir(home)
        .unwrap()
        .filter_map(|e| e.ok())
        .filter(|e| {
            e.file_name()
                .to_string_lossy()
                .starts_with("config.json.rejected-")
        })
        .map(|e| e.path())
        .collect()
}

#[test]
fn a_set_right_after_an_unpolled_hand_edit_builds_on_it() {
    // I1: the watcher ticks every 5 s here, so the edit is unseen when the set arrives.
    let dir = tempfile::tempdir().unwrap();
    let home = dir.path();
    write_config(home, &json!({ "schemaVersion": 1 }));
    let _sup = common::start_scaled(home, "5");
    let mut c = client(home);
    let watch = Watch::open(home);
    let (_, rev0) = running(&mut c);

    // A stale ifRevision is a conflict against the edit, and nothing is written.
    write_config(
        home,
        &json!({ "schemaVersion": 1, "core": { "logLevel": "debug" } }),
    );
    let edited = std::fs::read(config_path(home)).unwrap();
    let mut p = change("supervisor.graceMs", json!(30000));
    p["ifRevision"] = json!(rev0);
    let (e, reason, _, ids) = call_error(set(&mut c, p));
    assert_eq!(
        (e, reason.as_deref()),
        (ErrorCode::EConflict, Some("config-changed"))
    );
    let n = watch
        .next_change(WAIT)
        .expect("the edit was not applied first");
    assert_eq!(n["source"], "file");
    assert_eq!(ids["currentRevision"], n["revision"]);
    assert_eq!(std::fs::read(config_path(home)).unwrap(), edited);

    // A revision-less set right after another edit keeps both changes.
    write_config(
        home,
        &json!({ "schemaVersion": 1, "core": { "logLevel": "warn" } }),
    );
    let r = set(&mut c, change("supervisor.graceMs", json!(30000))).unwrap();
    assert_eq!(r["applied"], true);
    let file = file_config(home);
    assert_eq!(level(&file), "warn");
    assert_eq!(file["supervisor"]["graceMs"], 30000);
    let sources: Vec<Value> = watch
        .changes_within(TICK * 2)
        .into_iter()
        .map(|n| n["source"].clone())
        .collect();
    assert_eq!(sources, [json!("file"), json!("set")]);
    assert!(backups(home).is_empty());
}

#[test]
fn a_set_right_after_an_unpolled_invalid_edit_backs_up_those_bytes() {
    let dir = tempfile::tempdir().unwrap();
    let home = dir.path();
    write_config(home, &json!({ "schemaVersion": 1 }));
    let _sup = common::start_scaled(home, "5");
    let mut c = client(home);
    let broken = r#"{"schemaVersion":1,"core":{"logLevel":"loud"}}"#;
    std::fs::write(config_path(home), broken).unwrap();
    let r = set(&mut c, change("core.logLevel", json!("debug"))).unwrap();
    assert_eq!(r["applied"], true);
    let b = backups(home);
    assert_eq!(b.len(), 1);
    assert_eq!(std::fs::read_to_string(&b[0]).unwrap(), broken);
    assert_eq!(level(&file_config(home)), "debug");
    assert!(status_config(&mut c)["rejected"].is_null());
}

#[test]
fn a_fix_with_the_same_length_and_mtime_as_the_rejected_file_is_still_seen() {
    // M3: coarse mtimes (1 s, 2 s) can give the fix the rejected file's stamp.
    let dir = tempfile::tempdir().unwrap();
    let home = dir.path();
    write_config(home, &json!({ "schemaVersion": 1 }));
    let _sup = start(home);
    let mut c = client(home);
    let watch = Watch::open(home);
    std::fs::write(
        config_path(home),
        r#"{"schemaVersion":1,"core":{"logLevel":"loud"}}"#,
    )
    .unwrap();
    wait_until("the rejection", WAIT, || {
        status_config(&mut c)["rejected"].is_object()
    });
    let mtime = std::fs::metadata(config_path(home))
        .unwrap()
        .modified()
        .unwrap();
    std::fs::write(
        config_path(home),
        r#"{"schemaVersion":1,"core":{"logLevel":"warn"}}"#,
    )
    .unwrap();
    std::fs::File::options()
        .write(true)
        .open(config_path(home))
        .unwrap()
        .set_modified(mtime)
        .unwrap();
    let n = watch.next_change(WAIT).expect("the fix was not seen");
    assert_eq!(level(&n["config"]), "warn");
    assert!(status_config(&mut c)["rejected"].is_null());
}

#[test]
fn a_second_config_watch_on_a_connection_reuses_its_subscription() {
    // M5
    use std::io::{BufRead, BufReader, Write};
    let dir = tempfile::tempdir().unwrap();
    let home = dir.path();
    let _sup = start(home);
    let mut c = client(home);
    let mut conn = common::raw(home);
    common::send_watch(conn.as_mut(), home);
    conn.write_all(
        format!(
            "{}\n",
            json!({ "jsonrpc": "2.0", "id": 3, "method": "config.watch", "params": {} })
        )
        .as_bytes(),
    )
    .unwrap();
    let (tx, rx) = std::sync::mpsc::channel::<Value>();
    std::thread::spawn(move || {
        for line in BufReader::new(conn).lines() {
            let Ok(line) = line else { return };
            if tx.send(serde_json::from_str(&line).unwrap()).is_err() {
                return;
            }
        }
    });
    let next = || rx.recv_timeout(WAIT).expect("no line");
    assert_eq!(next()["id"], 1);
    let first = next();
    let second = next();
    assert_eq!(first["id"], 2);
    assert_eq!(second["id"], 3);
    assert_eq!(
        first["result"]["subscriptionId"],
        second["result"]["subscriptionId"]
    );
    set(&mut c, change("core.logLevel", json!("debug"))).unwrap();
    assert_eq!(next()["method"], "config.changed");
    assert!(
        rx.recv_timeout(TICK * 3).is_err(),
        "config.changed was delivered twice"
    );
}

#[cfg(unix)] // H3B-R18: no write deadline on Windows.
#[test]
fn a_watch_connection_that_pipelines_without_reading_is_closed() {
    // M1: its own replies fill its queue; the supervisor closes the connection instead of leaking its writer.
    use std::io::Write;
    let dir = tempfile::tempdir().unwrap();
    let home = dir.path();
    let _sup = start(home);
    let mut c = client(home);
    let agents: serde_json::Map<String, Value> = (0..200)
        .map(|i| {
            (
                format!("agent-{i:03}"),
                json!({ "displayName": "x".repeat(128) }),
            )
        })
        .collect();
    set(&mut c, change("agents", Value::Object(agents))).unwrap();

    let s = std::os::unix::net::UnixStream::connect(common::address(home)).unwrap();
    // Set while the connection is surely open: macOS refuses SO_SNDTIMEO (EINVAL) on a socket whose peer has already
    // closed it, which is what the writes below expect to happen.
    s.set_write_timeout(Some(Duration::from_secs(1))).unwrap();
    let mut w = s.try_clone().unwrap();
    common::send_watch(&mut w, home);
    let line = json!({ "jsonrpc": "2.0", "id": 9, "method": "config.get", "params": {} })
        .to_string()
        + "\n";
    for _ in 0..300 {
        if w.write_all(line.as_bytes()).is_err() {
            break; // already closed
        }
    }
    // Without reading anything: the supervisor must have closed the socket, so writing fails (a leaked writer
    // would keep it open, and the writes would only fill its buffer until they time out).
    let mut closed = None;
    wait_until("the pipelined watch connection to close", WAIT, || {
        if let Err(e) = w.write_all(line.as_bytes()) {
            closed = Some(e.kind());
        }
        matches!(
            closed,
            Some(std::io::ErrorKind::BrokenPipe | std::io::ErrorKind::ConnectionReset)
        )
    });
    assert!(
        matches!(
            closed,
            Some(std::io::ErrorKind::BrokenPipe | std::io::ErrorKind::ConnectionReset)
        ),
        "the connection stayed open: {closed:?}"
    );
    drop(s);
    // The supervisor still serves everyone else.
    assert!(running(&mut c).1.len() == 16);
}

#[test]
fn a_restarted_core_that_dies_is_not_reported_restarted() {
    let dir = tempfile::tempdir().unwrap();
    let home = dir.path().join("home");
    std::fs::create_dir_all(&home).unwrap();
    let events = dir.path().join("events.jsonl");
    // Every core after the first exits 2 at once (fatal config-invalid).
    let _sup =
        common::start_with_core(&home, &events, "0.2", &[("FAKE_CORE_LATER_MODE", "exit:2")]);
    let mut c = client(&home);
    ready_pid(&mut c);
    let r = set(&mut c, change("engine.duplicateThreshold", json!(1.01))).unwrap();
    assert_valid("methods/config.set/result", &r);
    assert_eq!(r["applied"], true, "{r}");
    assert_eq!(
        r["restarted"],
        json!([]),
        "a dead new core is not a restart: {r}"
    );
    let child = common::core_child(&mut c);
    assert_eq!(child_state(&child), "crashed", "{child}");
    assert_eq!(child["process"]["reason"], "config-invalid", "{child}");
}
