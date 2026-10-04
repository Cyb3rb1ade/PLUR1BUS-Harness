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
        "skip"
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
