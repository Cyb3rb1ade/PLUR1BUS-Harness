#[allow(dead_code)]
#[path = "../src/coexistence.rs"]
mod coexistence;
#[path = "common/mod.rs"]
mod common;
#[path = "setup_env/mod.rs"]
mod setup_env;

use serde_json::{json, Value};
use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;

use coexistence::HostEnvironment;

fn env(home: &Path, platform: &str) -> HostEnvironment {
    HostEnvironment::injected(
        [("HOME".to_string(), home.to_string_lossy().into_owned())]
            .into_iter()
            .collect(),
        home.to_path_buf(),
        platform,
    )
}

fn config(path: &Path) -> Value {
    json!({ "engine": { "baseDbPathOverride": path } })
}

fn state_root(home: &Path) -> PathBuf {
    let root = home.join(".openclaw");
    fs::create_dir_all(&root).unwrap();
    fs::write(root.join("openclaw.json"), "{}").unwrap();
    root
}

#[test]
fn refuses_state_root_children_and_symlink_targets() {
    let home = tempfile::tempdir().unwrap();
    let root = state_root(home.path());
    for path in [
        root.clone(),
        root.join("memory/lancedb"),
        root.join("state/lancedb"),
    ] {
        assert!(coexistence::store_violation(&config(&path), &env(home.path(), "linux")).is_some());
    }

    #[cfg(unix)]
    {
        let link = home.path().join("alias");
        std::os::unix::fs::symlink(&root, &link).unwrap();
        assert!(coexistence::store_violation(
            &config(&link.join("memory/lancedb")),
            &env(home.path(), "linux")
        )
        .is_some());
    }
}

#[test]
fn allows_siblings_and_matches_case_insensitively_on_selected_platforms() {
    let home = tempfile::tempdir().unwrap();
    let root = state_root(home.path());
    for name in [".openclaw-other", ".openclawx"] {
        assert!(coexistence::store_violation(
            &config(&home.path().join(name).join("lancedb")),
            &env(home.path(), "linux")
        )
        .is_none());
    }

    let differently_cased =
        PathBuf::from(root.to_string_lossy().to_uppercase()).join("memory/lancedb");
    for platform in ["win32", "darwin"] {
        assert!(coexistence::store_violation(
            &config(&differently_cased),
            &env(home.path(), platform)
        )
        .is_some());
    }
}

#[test]
fn recognizes_legacy_explicit_profile_and_default_store_roots() {
    let home = tempfile::tempdir().unwrap();
    let legacy = home.path().join(".clawdbot");
    fs::create_dir_all(&legacy).unwrap();
    fs::write(legacy.join("clawdbot.json"), "{}").unwrap();
    assert!(coexistence::store_violation(
        &config(&legacy.join("memory/lancedb")),
        &env(home.path(), "linux")
    )
    .is_some());

    let explicit = home.path().join("custom-state");
    fs::create_dir_all(&explicit).unwrap();
    let mut vars = HashMap::new();
    vars.insert(
        "OPENCLAW_STATE_DIR".into(),
        explicit.to_string_lossy().into_owned(),
    );
    let injected = HostEnvironment::injected(vars, home.path().to_path_buf(), "linux");
    assert!(
        coexistence::store_violation(&config(&explicit.join("memory/lancedb")), &injected)
            .is_some()
    );

    let profile = home.path().join(".openclaw-work");
    fs::create_dir_all(&profile).unwrap();
    let mut vars = HashMap::new();
    vars.insert("HOME".into(), home.path().to_string_lossy().into_owned());
    vars.insert("OPENCLAW_PROFILE".into(), "work".into());
    let injected = HostEnvironment::injected(vars, home.path().to_path_buf(), "linux");
    assert!(
        coexistence::store_violation(&config(&profile.join("memory/lancedb")), &injected).is_some()
    );

    let custom_home = home.path().join("custom-host-home");
    let custom_root = custom_home.join(".openclaw");
    fs::create_dir_all(&custom_root).unwrap();
    fs::write(custom_root.join("openclaw.json"), "{}").unwrap();
    let mut vars = HashMap::new();
    vars.insert("HOME".into(), home.path().to_string_lossy().into_owned());
    vars.insert(
        "OPENCLAW_HOME".into(),
        custom_home.to_string_lossy().into_owned(),
    );
    let injected = HostEnvironment::injected(vars, home.path().to_path_buf(), "linux");
    assert!(
        coexistence::store_violation(&config(&custom_root.join("memory/lancedb")), &injected)
            .is_some()
    );

    let windows_home = home.path().join("windows-home");
    let windows_root = windows_home.join(".openclaw");
    fs::create_dir_all(&windows_root).unwrap();
    fs::write(windows_root.join("openclaw.json"), "{}").unwrap();
    let mut vars = HashMap::new();
    vars.insert(
        "USERPROFILE".into(),
        windows_home.to_string_lossy().into_owned(),
    );
    let injected = HostEnvironment::injected(vars, home.path().to_path_buf(), "win32");
    assert!(
        coexistence::store_violation(&config(&windows_root.join("memory/lancedb")), &injected)
            .is_some()
    );

    let store_root = home.path().join("custom-store-root");
    let default_store = store_root.join("memory/lancedb-namespaced");
    fs::create_dir_all(&default_store).unwrap();
    assert!(coexistence::store_violation(
        &config(&default_store.join("agent")),
        &env(home.path(), "linux")
    )
    .is_some());
}

#[test]
fn host_mode_notice_requires_a_plugin_entry() {
    let home = tempfile::tempdir().unwrap();
    let root = state_root(home.path());
    let env = env(home.path(), "linux");
    assert_eq!(coexistence::host_mode_notice(&env), None);
    fs::write(
        root.join("openclaw.json"),
        json!({ "plugins": { "entries": { "memory-lancedb-namespaced": {} } } }).to_string(),
    )
    .unwrap();
    assert_eq!(
        coexistence::host_mode_notice(&env),
        Some("OpenClaw host mode found: separate memory until you migrate (`plur1bus import`) or switch the plugin to thin client")
    );
}

#[test]
fn config_set_refuses_a_foreign_store_path_without_writing_config() {
    let dir = tempfile::tempdir().unwrap();
    let harness = dir.path().join("harness");
    let host = dir.path().join(".openclaw");
    fs::create_dir_all(&harness).unwrap();
    fs::create_dir_all(&host).unwrap();
    fs::write(host.join("openclaw.json"), "{}").unwrap();
    let output = Command::new(assert_cmd::cargo::cargo_bin("plur1bus"))
        .args([
            "--json",
            "--home",
            harness.to_str().unwrap(),
            "config",
            "set",
            "engine.baseDbPathOverride",
            host.join("memory/lancedb").to_str().unwrap(),
            "--yes",
        ])
        .env("HOME", dir.path())
        .env("OPENCLAW_STATE_DIR", &host)
        .output()
        .unwrap();
    let value: Value = serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(output.status.code(), Some(1));
    assert_eq!(value["error"], "E_CONFIG_INVALID");
    assert_eq!(value["reason"], "foreign-host-store-path");
    assert!(value["message"]
        .as_str()
        .unwrap()
        .contains("choose a path under the harness home"));
    let written: Value =
        serde_json::from_slice(&fs::read(harness.join("config.json")).unwrap()).unwrap();
    assert!(written["engine"]["baseDbPathOverride"].is_null());
}

#[test]
fn supervisor_config_set_refuses_a_foreign_store_path() {
    use common::{client, wait_until, Supervisor, SCALE, WAIT};
    use plur1bus_rpc::RpcError;
    use std::process::Stdio;

    let dir = tempfile::tempdir().unwrap();
    let host = dir.path().join("custom-state");
    let home = dir.path().join("harness");
    fs::create_dir_all(&host).unwrap();
    fs::create_dir_all(&home).unwrap();
    fs::write(host.join("openclaw.json"), "{}").unwrap();
    let child = Command::new(assert_cmd::cargo::cargo_bin("plur1bus"))
        .arg("--home")
        .arg(&home)
        .args(["supervise", "--no-core"])
        .env("HOME", dir.path())
        .env("USERPROFILE", dir.path())
        .env("OPENCLAW_STATE_DIR", &host)
        .env_remove("OPENCLAW_HOME")
        .env_remove("OPENCLAW_PROFILE")
        .env("PLUR1BUS_ALLOW_TEST_INTERNALS", "1")
        .env("PLUR1BUS_SUPERVISOR_TIME_SCALE", SCALE)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .unwrap();
    let _supervisor = Supervisor {
        child,
        home: home.clone(),
    };
    wait_until("run/supervisor.token", WAIT, || {
        home.join("run/supervisor.token").exists()
    });
    let mut client = client(&home);
    let result = client.call(
        "config.set",
        json!({
            "changes": [{
                "key": "engine.baseDbPathOverride",
                "value": host.join("memory/lancedb"),
            }],
            "dryRun": true,
        }),
    );
    match result {
        Err(RpcError::Call { error, reason, .. }) => {
            assert_eq!(error, plur1bus_rpc::types::ErrorCode::EConfigInvalid);
            assert_eq!(reason.as_deref(), Some("foreign-host-store-path"));
        }
        other => panic!("expected typed config error, got {other:?}"),
    }
    assert!(!home.join("config.json").exists());
}

#[test]
fn supervisor_hand_edit_with_a_foreign_store_path_is_rejected_like_a_set() {
    // ADR-013 §5: a hand edit is applied like a set, so `engine.baseDbPathOverride` inside another host's state
    // directory is rejected (the running config stays, the file is reported), and a legitimate edit still applies.
    use common::{client, wait_until, Supervisor, Watch, SCALE, TICK, WAIT};
    use std::process::Stdio;

    let dir = tempfile::tempdir().unwrap();
    let host = dir.path().join("custom-state");
    let home = dir.path().join("harness");
    fs::create_dir_all(&host).unwrap();
    fs::create_dir_all(&home).unwrap();
    fs::write(host.join("openclaw.json"), "{}").unwrap();
    fs::write(home.join("config.json"), r#"{"schemaVersion":1}"#).unwrap();
    let child = Command::new(assert_cmd::cargo::cargo_bin("plur1bus"))
        .arg("--home")
        .arg(&home)
        .args(["supervise", "--no-core"])
        .env("HOME", dir.path())
        .env("USERPROFILE", dir.path())
        .env("OPENCLAW_STATE_DIR", &host)
        .env_remove("OPENCLAW_HOME")
        .env_remove("OPENCLAW_PROFILE")
        .env("PLUR1BUS_ALLOW_TEST_INTERNALS", "1")
        .env("PLUR1BUS_SUPERVISOR_TIME_SCALE", SCALE)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .unwrap();
    let _supervisor = Supervisor {
        child,
        home: home.clone(),
    };
    wait_until("run/supervisor.token", WAIT, || {
        home.join("run/supervisor.token").exists()
    });
    let mut client = client(&home);
    let watch = Watch::open(&home);
    let status = |c: &mut plur1bus_rpc::Client| {
        c.call("daemon.status", json!({})).unwrap()["config"].clone()
    };
    let before = status(&mut client);
    let revision = before["revision"].clone();

    let foreign = host.join("memory/lancedb");
    let edited = json!({
        "schemaVersion": 1,
        "engine": { "baseDbPathOverride": foreign.to_string_lossy() },
    });
    fs::write(
        home.join("config.json"),
        serde_json::to_vec_pretty(&edited).unwrap(),
    )
    .unwrap();
    wait_until("the foreign store path to be rejected", WAIT, || {
        status(&mut client)["rejected"]["errors"]
            .to_string()
            .contains("foreign-host-store-path")
    });
    let rejected = status(&mut client);
    assert_eq!(rejected["revision"], revision, "{rejected}");
    assert!(
        rejected["rejected"]["errors"]
            .to_string()
            .contains("choose a path under the harness home"),
        "{rejected}"
    );
    let running = client.call("config.get", json!({})).unwrap();
    assert_eq!(running["revision"], revision, "{running}");
    assert!(running["value"]["engine"]["baseDbPathOverride"].is_null());
    assert!(watch.changes_within(TICK * 3).is_empty());

    // The legitimate behaviour is unchanged: a store path under the harness home applies like a set.
    let own = home.join("store");
    let fixed = json!({
        "schemaVersion": 1,
        "engine": { "baseDbPathOverride": own.to_string_lossy() },
    });
    fs::write(
        home.join("config.json"),
        serde_json::to_vec_pretty(&fixed).unwrap(),
    )
    .unwrap();
    let change = watch
        .next_change(WAIT)
        .expect("no config.changed for the legitimate hand edit");
    assert_eq!(change["source"], "file", "{change}");
    assert!(status(&mut client)["rejected"].is_null());
    let running = client.call("config.get", json!({})).unwrap();
    assert_eq!(
        running["value"]["engine"]["baseDbPathOverride"],
        own.to_string_lossy().to_string()
    );
}

#[test]
fn setup_refuses_a_foreign_store_path_before_installing() {
    let e = setup_env::Env::new();
    fs::create_dir_all(&e.home).unwrap();
    let host = e.root.join(".openclaw");
    fs::create_dir_all(&host).unwrap();
    fs::write(host.join("openclaw.json"), "{}").unwrap();
    let mut config = plur1bus_config::defaults();
    config["engine"]["baseDbPathOverride"] =
        json!(host.join("memory/lancedb").to_string_lossy().to_string());
    fs::write(
        e.home.join("config.json"),
        serde_json::to_vec(&config).unwrap(),
    )
    .unwrap();
    let output = e
        .cmd(&["--json", "setup", "--non-interactive", "--no-service"])
        .env("OPENCLAW_STATE_DIR", &host)
        .output()
        .unwrap();
    let value = setup_env::doc(&output);
    assert_eq!(output.status.code(), Some(1), "{value:#}");
    assert_eq!(value["error"], "E_CONFIG_INVALID", "{value:#}");
    assert_eq!(value["reason"], "foreign-host-store-path", "{value:#}");
    assert!(value["message"]
        .as_str()
        .unwrap()
        .contains("choose a path under the harness home"));
    assert!(!e.home.join("manifest.json").exists());
    assert!(!e.home.join("runtime").exists());
}

#[test]
fn doctor_reports_notice_and_fails_for_an_unsafe_existing_store() {
    let dir = tempfile::tempdir().unwrap();
    let harness = dir.path().join("harness");
    let host = dir.path().join(".openclaw");
    let fake_service = dir.path().join("fake-service");
    fs::create_dir_all(&harness).unwrap();
    fs::create_dir_all(&host).unwrap();
    fs::create_dir_all(&fake_service).unwrap();
    let store = host.join("memory/lancedb-namespaced");
    fs::create_dir_all(&store).unwrap();
    fs::write(
        store.join("synthetic-marker.txt"),
        "synthetic-store-content",
    )
    .unwrap();
    fs::write(
        host.join("openclaw.json"),
        json!({ "plugins": { "entries": { "memory-lancedb-namespaced": {} } } }).to_string(),
    )
    .unwrap();

    let run_check = |json: bool| {
        let mut command = Command::new(assert_cmd::cargo::cargo_bin("plur1bus"));
        command
            .arg("--home")
            .arg(&harness)
            .env("HOME", dir.path())
            .env("USERPROFILE", dir.path())
            .env("OPENCLAW_STATE_DIR", &host)
            .env("PLUR1BUS_ALLOW_TEST_INTERNALS", "1")
            .env("PLUR1BUS_SERVICE_FAKE", &fake_service)
            .env_remove("OPENCLAW_HOME")
            .env_remove("OPENCLAW_PROFILE");
        if json {
            command.arg("--json");
        }
        command.args(["1staid", "check"]).output().unwrap()
    };

    let human = run_check(false);
    let human_text = String::from_utf8_lossy(&human.stdout);
    let notice =
        "OpenClaw host mode found: separate memory until you migrate (`plur1bus import`) or switch the plugin to thin client";
    assert_eq!(human.status.code(), Some(0), "{human_text}");
    assert_eq!(human_text.matches(notice).count(), 1, "{human_text}");
    assert!(
        human_text.contains(&format!("info  {notice}")),
        "{human_text}"
    );
    assert!(!human_text.contains("synthetic-store-content"));

    fs::write(host.join("openclaw.json"), "{}").unwrap();
    let without_plugin = run_check(true);
    assert_eq!(without_plugin.status.code(), Some(0));
    let document: Value = serde_json::from_slice(&without_plugin.stdout).unwrap();
    assert_eq!(
        document["checks"]
            .as_array()
            .unwrap()
            .iter()
            .find(|check| check["id"] == "host_mode_coexistence")
            .unwrap()["status"],
        "ok"
    );

    let mut config = plur1bus_config::defaults();
    config["engine"]["baseDbPathOverride"] =
        json!(host.join("memory/shared").to_string_lossy().to_string());
    fs::write(
        harness.join("config.json"),
        serde_json::to_vec(&config).unwrap(),
    )
    .unwrap();
    let unsafe_config = run_check(true);
    assert_eq!(unsafe_config.status.code(), Some(1));
    let document: Value = serde_json::from_slice(&unsafe_config.stdout).unwrap();
    let store_check = document["checks"]
        .as_array()
        .unwrap()
        .iter()
        .find(|check| check["id"] == "config.store-path")
        .unwrap();
    assert_eq!(store_check["status"], "fail");
    assert!(store_check["summary"]
        .as_str()
        .unwrap()
        .contains("choose a path under the harness home"));
}

// ---------------------------------------------------------------------------------------------------------------------
// Step 13 hardening: spellings of the store path, the state directory's resolution, and the host-mode notice.

fn violation(
    home: &Path,
    platform: &str,
    cfg: &Value,
    vars: &[(&str, &str)],
) -> Option<coexistence::StoreViolation> {
    let mut all: HashMap<String, String> = vars
        .iter()
        .map(|(k, v)| (k.to_string(), v.to_string()))
        .collect();
    all.entry("HOME".into())
        .or_insert_with(|| home.to_string_lossy().into_owned());
    coexistence::store_violation(
        cfg,
        &HostEnvironment::injected(all, home.to_path_buf(), platform),
    )
}

#[test]
fn every_spelling_of_a_path_inside_the_openclaw_state_directory_is_refused() {
    let home = tempfile::tempdir().unwrap();
    let root = state_root(home.path());
    let h = home.path().to_string_lossy().into_owned();
    let spellings = [
        format!("{}/", root.display()),
        format!("{}//memory///lancedb//", root.display()),
        format!("{}/./memory/./lancedb", root.display()),
        format!("{}/memory/../memory/lancedb", root.display()),
        format!("{h}/elsewhere/../.openclaw/memory/lancedb"),
        format!("{h}/a/b/../../.openclaw/x"),
        "~/.openclaw/memory/lancedb".to_string(),
        "~/.openclaw".to_string(),
        format!("  {}/memory/lancedb  ", root.display()), // surrounding blanks are trimmed
    ];
    for s in spellings {
        let cfg = json!({ "engine": { "baseDbPathOverride": s } });
        assert!(
            violation(home.path(), "linux", &cfg, &[]).is_some(),
            "{s:?} was not refused"
        );
    }
    // The state directory of a home with spaces and umlauts.
    let odd = tempfile::tempdir().unwrap();
    let odd_home = odd.path().join("Jürgen Müller ✓");
    fs::create_dir_all(odd_home.join(".openclaw")).unwrap();
    fs::write(odd_home.join(".openclaw/openclaw.json"), "{}").unwrap();
    let cfg =
        json!({ "engine": { "baseDbPathOverride": odd_home.join(".openclaw/memory/lancedb") } });
    assert!(violation(&odd_home, "linux", &cfg, &[]).is_some());
    let cfg =
        json!({ "engine": { "baseDbPathOverride": odd_home.join(".plur1bus/state/lancedb") } });
    assert!(
        violation(&odd_home, "linux", &cfg, &[]).is_none(),
        "the harness's own home next to it is fine"
    );
}

#[test]
fn paths_next_to_the_state_directory_and_under_another_harness_home_are_allowed() {
    let home = tempfile::tempdir().unwrap();
    let root = state_root(home.path());
    let h = home.path().to_string_lossy().into_owned();
    for s in [
        format!("{h}/.openclaw-backup/memory/lancedb"),
        format!("{h}/.openclawx"),
        format!("{h}/openclaw/memory/lancedb"),
        format!("{h}/.plur1bus/state/lancedb"),
        format!("{h}/second-install/state/lancedb"),
        format!("{}-copy/memory", root.display()),
        "/definitely/not/there/lancedb".to_string(),
        "~/.plur1bus/state/lancedb".to_string(),
    ] {
        let cfg = json!({ "engine": { "baseDbPathOverride": s } });
        assert!(
            violation(home.path(), "linux", &cfg, &[]).is_none(),
            "{s:?} was refused"
        );
    }
}

#[test]
fn a_store_path_that_is_not_a_usable_string_is_no_violation_and_never_a_panic() {
    let home = tempfile::tempdir().unwrap();
    state_root(home.path());
    for v in [
        json!(null),
        json!(1),
        json!(true),
        json!([]),
        json!({}),
        json!(["/x"]),
        json!(""),
        json!("   "),
    ] {
        let cfg = json!({ "engine": { "baseDbPathOverride": v } });
        assert!(violation(home.path(), "linux", &cfg, &[]).is_none(), "{v}");
    }
    for cfg in [
        json!({}),
        json!({ "engine": null }),
        json!({ "engine": [] }),
        json!({ "engine": {} }),
        json!(null),
        json!([]),
    ] {
        assert!(
            violation(home.path(), "linux", &cfg, &[]).is_none(),
            "{cfg}"
        );
    }
    // Hostile text: NUL, a very long path, only separators, only dots.
    for s in [
        "a\0b".to_string(),
        "x".repeat(10_000),
        "/".repeat(500),
        "../".repeat(300),
        "\u{202e}/.openclaw".to_string(),
    ] {
        let cfg = json!({ "engine": { "baseDbPathOverride": s } });
        let _ = violation(home.path(), "linux", &cfg, &[]);
    }
}

#[test]
fn a_relative_store_path_is_resolved_against_the_working_directory() {
    let home = tempfile::tempdir().unwrap();
    let root = state_root(home.path());
    let cwd = std::env::current_dir().unwrap();
    // Relative to the current directory it points at the state directory only when the current directory is inside it; a
    // relative `.openclaw/...` from the temp dir above does not.
    let cfg = json!({ "engine": { "baseDbPathOverride": ".openclaw/memory/lancedb" } });
    let expected = cwd.join(".openclaw/memory/lancedb").starts_with(&root);
    assert_eq!(
        violation(home.path(), "linux", &cfg, &[]).is_some(),
        expected
    );
}

#[test]
fn openclaw_home_state_dir_and_profile_decide_the_state_directory_in_that_order() {
    let home = tempfile::tempdir().unwrap();
    let h = home.path();
    let make = |dir: &str| {
        let p = h.join(dir);
        fs::create_dir_all(&p).unwrap();
        fs::write(p.join("openclaw.json"), "{}").unwrap();
        p
    };
    let default_root = make(".openclaw");
    let profile_root = make(".openclaw-work");
    let state_dir = make("custom-state");
    let moved_home = h.join("moved-home");
    let moved_root = moved_home.join(".openclaw");
    fs::create_dir_all(&moved_root).unwrap();
    let inside =
        |root: &Path| json!({ "engine": { "baseDbPathOverride": root.join("memory/lancedb") } });
    // OPENCLAW_STATE_DIR beats the profile, which beats the default.
    let vars = [
        ("OPENCLAW_STATE_DIR", state_dir.to_str().unwrap()),
        ("OPENCLAW_PROFILE", "work"),
    ];
    assert!(violation(h, "linux", &inside(&state_dir), &vars).is_some());
    assert!(
        violation(h, "linux", &inside(&profile_root), &vars).is_some(),
        "a marker file makes any ancestor a state root"
    );
    let vars = [("OPENCLAW_PROFILE", "work")];
    assert!(violation(h, "linux", &inside(&profile_root), &vars).is_some());
    // The default root is still found by its marker file even when a profile is selected.
    assert!(violation(h, "linux", &inside(&default_root), &vars).is_some());
    // OPENCLAW_HOME moves the home the default directory is looked up in.
    fs::write(moved_root.join("openclaw.json"), "{}").unwrap();
    let vars = [("OPENCLAW_HOME", moved_home.to_str().unwrap())];
    assert!(violation(h, "linux", &inside(&moved_root), &vars).is_some());
    // `~` in OPENCLAW_STATE_DIR is the OpenClaw home.
    let vars = [("OPENCLAW_STATE_DIR", "~/custom-state")];
    assert!(violation(h, "linux", &inside(&state_dir), &vars).is_some());
}

#[test]
fn an_invalid_profile_name_is_ignored_and_a_blank_variable_counts_as_unset() {
    let home = tempfile::tempdir().unwrap();
    let h = home.path();
    let default_root = state_root(h);
    let too_long = "a".repeat(65);
    // A profile directory exists for each name, but only a valid name may select it.
    for bad in [
        "",
        " ",
        "default",
        "DEFAULT",
        "-x",
        "_x",
        "a b",
        "a/b",
        "../x",
        "ä",
        too_long.as_str(),
    ] {
        let dir = h.join(format!(".openclaw-{bad}"));
        let candidate = if bad.contains('/') || bad.is_empty() {
            None
        } else {
            Some(dir)
        };
        if let Some(d) = &candidate {
            let _ = fs::create_dir_all(d.join("memory/lancedb"));
        }
        let cfg = json!({ "engine": { "baseDbPathOverride": h.join(".plur1bus/state/lancedb") } });
        assert!(
            violation(h, "linux", &cfg, &[("OPENCLAW_PROFILE", bad)]).is_none(),
            "{bad:?}"
        );
        // The default state directory is what applies.
        let cfg =
            json!({ "engine": { "baseDbPathOverride": default_root.join("memory/lancedb") } });
        assert!(
            violation(h, "linux", &cfg, &[("OPENCLAW_PROFILE", bad)]).is_some(),
            "{bad:?}"
        );
    }
    // A blank OPENCLAW_STATE_DIR / OPENCLAW_HOME is as good as none.
    let cfg = json!({ "engine": { "baseDbPathOverride": default_root.join("memory/lancedb") } });
    assert!(violation(
        h,
        "linux",
        &cfg,
        &[("OPENCLAW_STATE_DIR", "   "), ("OPENCLAW_HOME", "")]
    )
    .is_some());
}

#[test]
fn the_legacy_directory_is_used_only_when_the_current_one_does_not_exist() {
    let home = tempfile::tempdir().unwrap();
    let h = home.path();
    let legacy = h.join(".clawdbot");
    fs::create_dir_all(legacy.join("memory/lancedb-namespaced")).unwrap();
    let cfg =
        json!({ "engine": { "baseDbPathOverride": legacy.join("memory/lancedb-namespaced") } });
    assert!(
        violation(h, "linux", &cfg, &[]).is_some(),
        "only the legacy directory exists"
    );
    // Once the current directory exists (with or without a marker) it is the state root; the legacy one is still a state
    // root through its own plugin store layout, which is checked by the layout of the path itself.
    fs::create_dir_all(h.join(".openclaw")).unwrap();
    let cfg = json!({ "engine": { "baseDbPathOverride": h.join(".plur1bus/state/lancedb") } });
    assert!(violation(h, "linux", &cfg, &[]).is_none());
}

#[test]
fn the_host_mode_notice_needs_a_readable_openclaw_json_with_the_plugin_entry() {
    let home = tempfile::tempdir().unwrap();
    let h = home.path();
    let root = h.join(".openclaw");
    fs::create_dir_all(&root).unwrap();
    let e = env(h, "linux");
    let write = |text: &str| fs::write(root.join("openclaw.json"), text).unwrap();
    assert!(
        coexistence::host_mode_notice(&e).is_none(),
        "no openclaw.json at all"
    );
    let present = r#"{"plugins":{"entries":{"memory-lancedb-namespaced":{"enabled":true}}}}"#;
    write(present);
    assert!(coexistence::host_mode_notice(&e).is_some());
    for text in [
        "",
        "not json",
        "{",
        "[]",
        "null",
        r#"{"plugins":null}"#,
        r#"{"plugins":[]}"#,
        r#"{"plugins":{"entries":null}}"#,
        r#"{"plugins":{"entries":[]}}"#,
        r#"{"plugins":{"entries":{}}}"#,
        r#"{"plugins":{"entries":{"Memory-Lancedb-Namespaced":{}}}}"#, // the id is exact
        r#"{"plugins":{"entries":{"memory-lancedb-namespaced-x":{}}}}"#,
        &format!("\u{feff}{present}"), // a BOM: not JSON for serde, so no notice
        &format!("{}{}", " ".repeat(5_000_000), "{}"),
    ] {
        write(text);
        assert!(
            coexistence::host_mode_notice(&e).is_none(),
            "{:?}",
            &text[..text.len().min(60)]
        );
    }
    // A directory in place of the file, and a file of binary noise.
    fs::remove_file(root.join("openclaw.json")).unwrap();
    fs::create_dir(root.join("openclaw.json")).unwrap();
    assert!(coexistence::host_mode_notice(&e).is_none());
    fs::remove_dir(root.join("openclaw.json")).unwrap();
    fs::write(
        root.join("openclaw.json"),
        (0..4096u32)
            .map(|i| (i * 7 % 256) as u8)
            .collect::<Vec<u8>>(),
    )
    .unwrap();
    assert!(coexistence::host_mode_notice(&e).is_none());
}
