//! `plur1bus setup --profile host|full` (HM2 Task 4, D88, spec A.6, HM2-R9; preflight F3, F21, F35). The same seams
//! as `setup.rs` (`setup_env`): a temp home and user home, the fake service manager, a `file://` Node mirror and the
//! fixture core from `tests/fixtures/setup` (`--core-from`). Nothing touches a real service manager or a real home.
mod setup_env;

use serde_json::{json, Value};
use setup_env::*;
use sha2::{Digest, Sha256};
use std::collections::BTreeMap;
use std::path::Path;
use std::time::{Duration, Instant};

const HOST: [&str; 4] = ["--non-interactive", "--no-service", "--profile", "host"];

fn read_json(p: &Path) -> Value {
    serde_json::from_str(&std::fs::read_to_string(p).unwrap()).unwrap()
}

/// `config.json`, or `null` when setup had nothing to write (the defaults run: no agent, use class `general`).
fn config_file(e: &Env) -> Value {
    let p = e.home.join("config.json");
    if p.exists() {
        read_json(&p)
    } else {
        Value::Null
    }
}

/// The agent ids `config.json` registers (none when it has no `agents` entry or does not exist).
fn agents(e: &Env) -> Vec<String> {
    config_file(e)
        .get("agents")
        .and_then(Value::as_object)
        .map(|a| a.keys().cloned().collect())
        .unwrap_or_default()
}

fn dir_names(p: &Path) -> Vec<String> {
    let mut names: Vec<String> = std::fs::read_dir(p)
        .map(|rd| {
            rd.flatten()
                .map(|e| e.file_name().to_string_lossy().into_owned())
                .collect()
        })
        .unwrap_or_default();
    names.sort();
    names
}

/// Every path under `dir` with a digest of its content (files) or a marker (directories, other entries).
fn tree(dir: &Path) -> BTreeMap<String, String> {
    fn walk(root: &Path, dir: &Path, out: &mut BTreeMap<String, String>) {
        for e in std::fs::read_dir(dir).unwrap().flatten() {
            let p = e.path();
            let rel = p.strip_prefix(root).unwrap().to_string_lossy().into_owned();
            let ty = e.file_type().unwrap();
            if ty.is_dir() {
                out.insert(rel, "dir".into());
                walk(root, &p, out);
            } else if ty.is_file() {
                let digest = format!("{:x}", Sha256::digest(std::fs::read(&p).unwrap()));
                out.insert(rel, digest);
            } else {
                out.insert(rel, "other".into());
            }
        }
    }
    let mut out = BTreeMap::new();
    walk(dir, dir, &mut out);
    out
}

fn assert_refused_as_profile_change(code: i32, v: &Value, hint: &str) {
    assert_eq!(code, 1, "{v:#}");
    assert_eq!(v["schema"], "setup/1", "{v}");
    assert_eq!(ids(v), STEP_IDS, "{v}");
    let first = step(v, "state-root");
    assert_eq!(first["status"], "failed", "{v:#}");
    assert_eq!(first["reason"], "profile-change-unsupported", "{v:#}");
    assert_eq!(first["detail"]["hint"], hint, "{v:#}");
    for s in &v["steps"].as_array().unwrap()[1..] {
        assert_eq!(s["status"], "skipped", "{s}");
        assert_eq!(s["reason"], "after-failure", "{s}");
    }
    assert!(v["manifest"].is_null() && v["check"].is_null(), "{v}");
}

#[test]
fn host_profile_installs_supervisor_and_core_only() {
    let e = Env::new();
    let (code, v) = e.setup(&HOST);
    assert_success(code, &v);
    for id in ["modules.bundled", "skills"] {
        assert_eq!(status_of(&v, id), "skipped", "{id}: {v:#}");
        assert_eq!(step(&v, id)["reason"], "profile-host", "{id}: {v:#}");
    }
    for id in [
        "state-root",
        "runtime.node",
        "runtime.core",
        "config",
        "start",
        "check",
    ] {
        assert_eq!(status_of(&v, id), "done", "{id}: {v:#}");
    }
    assert_eq!(step(&v, "service")["reason"], "no-service");
    assert_eq!(step(&v, "state-root")["detail"]["profile"], "host");
    let m = &v["manifest"];
    assert_eq!(m["profile"], "host", "{m:#}");
    assert_eq!(m["modules"], json!([]));
    assert_eq!(m["skills"], json!([]));
    assert_eq!(read_json(&e.home.join("manifest.json")), *m);

    let cfg = config_file(&e);
    assert!(cfg.get("agents").is_none(), "no first agent: {cfg:#}");
    assert_eq!(e.json(&["config", "get", "agents"])["value"], json!({}));
    assert_eq!(
        e.json(&["config", "get", "embedding.useClass"])["value"],
        "general"
    );
    assert!(step(&v, "config")["detail"]["agent"].is_null(), "{v:#}");
    assert!(dir_names(&e.home.join("agents")).is_empty());
    assert!(dir_names(&e.home.join("skills")).is_empty());
    assert!(dir_names(&e.home.join("modules")).is_empty());
    assert!(e.home.join("runtime/core/core.js").is_file());
    assert_core_ready(&e);
}

#[test]
fn host_profile_with_agent_creates_that_agent() {
    let e = Env::new();
    let mut args = HOST.to_vec();
    args.extend(["--agent", "hermes-default"]);
    let (code, v) = e.setup(&args);
    assert_success(code, &v);
    assert_eq!(agents(&e), ["hermes-default"]);
    assert_eq!(step(&v, "config")["detail"]["agent"], "hermes-default");
    assert!(e.home.join("agents/hermes-default/workspace").is_dir());
    assert_eq!(v["manifest"]["profile"], "host");
}

#[test]
fn rerun_without_profile_keeps_the_recorded_profile() {
    let e = Env::new();
    let (code, v) = e.setup(&HOST);
    assert_success(code, &v);
    let (code, v) = e.setup(&["--non-interactive", "--no-service"]);
    assert_success(code, &v);
    assert_eq!(v["manifest"]["profile"], "host", "{v:#}");
    assert_eq!(step(&v, "modules.bundled")["reason"], "profile-host");
    assert_eq!(step(&v, "skills")["reason"], "profile-host");
    assert!(agents(&e).is_empty(), "a re-run creates no agent either");
    assert!(dir_names(&e.home.join("skills")).is_empty());

    // The same explicit profile is no change.
    let (code, v) = e.setup(&HOST);
    assert_success(code, &v);
    assert_eq!(v["manifest"]["profile"], "host");
}

/// HM2 F3: a re-run without `--use-class` keeps the recorded class instead of falling back to `general`.
#[test]
fn rerun_without_use_class_keeps_the_recorded_class() {
    let e = Env::new();
    let mut args = HOST.to_vec();
    args.extend(["--use-class", "commercial"]);
    let (code, v) = e.setup(&args);
    assert_success(code, &v);
    let (code, v) = e.setup(&["--non-interactive", "--no-service"]);
    assert_success(code, &v);
    assert_eq!(step(&v, "config")["detail"]["useClass"], "commercial");
    assert_eq!(step(&v, "config")["detail"]["changed"], json!([]), "{v:#}");
    assert_eq!(
        e.json(&["config", "get", "embedding.useClass"])["value"],
        "commercial"
    );
    // An explicit different class is applied (the licence rules are unchanged: no silent NC acceptance).
    let (code, v) = e.setup(&[
        "--non-interactive",
        "--no-service",
        "--use-class",
        "research",
    ]);
    assert_success(code, &v);
    assert_eq!(
        e.json(&["config", "get", "embedding.useClass"])["value"],
        "research"
    );
    assert_eq!(
        e.json(&["config", "get", "embedding.acceptedNcLicence"])["value"],
        false
    );
}

#[test]
fn a_profile_change_is_refused_and_changes_nothing() {
    for (first, second, hint) in [
        ("host", "full", "host \u{2192} full arrives with HM4"),
        (
            "full",
            "host",
            "Hermes on an existing full installation arrives with HM4",
        ),
    ] {
        let e = Env::new();
        let (code, v) = e.setup(&["--non-interactive", "--no-service", "--profile", first]);
        assert_success(code, &v);
        assert_eq!(v["manifest"]["profile"], first);
        // A running supervisor keeps writing its logs; stop it so the tree holds still.
        let stop = e.cmd(&["daemon", "stop"]).output().unwrap();
        assert!(stop.status.success(), "{stop:?}");
        let before = tree(&e.home);
        let (code, v) = e.setup(&["--non-interactive", "--no-service", "--profile", second]);
        assert_refused_as_profile_change(code, &v, hint);
        assert_eq!(
            tree(&e.home),
            before,
            "{first} -> {second} changed the home"
        );
    }
}

#[test]
fn manifest_without_profile_reads_as_full() {
    let e = Env::new();
    let (code, v) = e.setup(&["--non-interactive", "--no-service"]);
    assert_success(code, &v);
    assert_eq!(
        v["manifest"]["profile"], "full",
        "a new home defaults to full"
    );
    // A manifest written before HM2 has no `profile`.
    let path = e.home.join("manifest.json");
    let mut m = read_json(&path);
    m.as_object_mut().unwrap().remove("profile");
    std::fs::write(&path, serde_json::to_string_pretty(&m).unwrap()).unwrap();

    let (code, v) = e.setup(&HOST);
    assert_refused_as_profile_change(
        code,
        &v,
        "Hermes on an existing full installation arrives with HM4",
    );
    let (code, v) = e.setup(&["--non-interactive", "--no-service"]);
    assert_success(code, &v);
    assert_eq!(v["manifest"]["profile"], "full", "{v:#}");
    assert_eq!(status_of(&v, "skills"), "done");
}

#[test]
fn firstaid_check_passes_on_a_host_profile() {
    let e = Env::new();
    let (code, v) = e.setup(&HOST);
    assert_eq!(code, 0, "{v:#}");
    assert_eq!(v["check"]["fail"], 0, "{v:#}");
    // Every row that is not `ok` is one a full `--no-service` install shows as well: a module or skill row reporting
    // drift as a warning would not pass.
    const EXPECTED: [(&str, &str); 4] = [
        ("service.registration", "warn"),
        ("models.cache", "warn"),
        ("memory.shared", "skip"),
        ("windows.pipe-acl", "skip"),
    ];
    // A row the pass never reached before its 3 s budget reads `warn` "time budget exhausted". That is no finding
    // (repair plans nothing for it), and the loaded windows-2025 runner hit it on the last three rows while the
    // other setup tests ran in parallel (CI round 1: node.exe's re-hash alone is slow there). So the pass is repeated
    // until it reaches every row, bounded at 90 s; the assertion below still covers every row of a complete pass.
    let started = Instant::now();
    let check = loop {
        let check = e.json(&["1staid", "check"]);
        let unreached = check["checks"]
            .as_array()
            .unwrap()
            .iter()
            .any(|c| c["summary"] == "time budget exhausted");
        if !unreached {
            break check;
        }
        assert!(
            started.elapsed() < Duration::from_secs(90),
            "no complete 1staid pass within 90 s: {check:#}"
        );
        std::thread::sleep(Duration::from_secs(2));
    };
    let unexpected: Vec<&Value> = check["checks"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|c| c["status"] != "ok")
        .filter(|c| {
            !EXPECTED
                .iter()
                .any(|(id, status)| c["id"] == *id && c["status"] == *status)
        })
        .collect();
    assert!(unexpected.is_empty(), "{unexpected:#?}");
}

/// HM2-R27: an unreadable install manifest hides the recorded profile, so setup refuses before any write instead of
/// installing `full` over a host home, with and without `--profile`.
#[test]
fn an_invalid_manifest_is_refused_and_changes_nothing() {
    let e = Env::new();
    let (code, v) = e.setup(&HOST);
    assert_success(code, &v);
    let stop = e.cmd(&["daemon", "stop"]).output().unwrap();
    assert!(stop.status.success(), "{stop:?}");
    std::fs::write(e.home.join("manifest.json"), "garbage").unwrap();
    let before = tree(&e.home);
    for extra in [
        &[][..],
        &["--profile", "host"][..],
        &["--profile", "full"][..],
    ] {
        let mut args = vec!["--non-interactive", "--no-service"];
        args.extend_from_slice(extra);
        let (code, v) = e.setup(&args);
        assert_eq!(code, 1, "{extra:?}: {v:#}");
        let first = step(&v, "state-root");
        assert_eq!(first["status"], "failed", "{v:#}");
        assert_eq!(first["reason"], "manifest-invalid", "{v:#}");
        assert!(
            first["detail"]["hint"]
                .as_str()
                .is_some_and(|h| h.contains("manifest.json")),
            "{v:#}"
        );
        for s in &v["steps"].as_array().unwrap()[1..] {
            assert_eq!(s["reason"], "after-failure", "{s}");
        }
        assert_eq!(tree(&e.home), before, "{extra:?} changed the home");
    }
}

/// F35: a fresh host install is not drift for `update --check`: the release's bundled modules are not planned, and
/// a release equal unit for unit plans nothing.
#[test]
fn update_check_on_a_host_profile_is_clean() {
    let e = Env::new();
    let (code, v) = e.setup(&HOST);
    assert_success(code, &v);
    let m = &v["manifest"];
    let target = target_id();
    let release = |version: &str| {
        json!({
            "version": version,
            "channel": "stable",
            "minFromVersion": "0.0.0",
            "native": {
                "binary": { target: {
                    "url": "https://example.invalid/plur1bus",
                    "sha256": m["binary"]["sha256"].as_str().map_or("0".repeat(64), str::to_string),
                } },
                "core": {
                    "version": m["core"]["version"],
                    "contract": m["core"]["contract"],
                    "rpc": m["core"]["rpc"],
                    "payload": { target: { "url": "https://example.invalid/core.tar.gz", "sha256": "a".repeat(64) } },
                },
                "node": { "version": m["node"]["version"] },
                "modules": [{ "name": "fixture", "version": "0.1.0", "apiVersion": "1" }],
                "configSchemaVersion": 1,
            },
        })
    };
    for (version, available) in [(env!("CARGO_PKG_VERSION"), false), ("99.0.0", true)] {
        let path = e.root.join(format!("release-{version}.json"));
        std::fs::write(&path, release(version).to_string()).unwrap();
        let out = e
            .cmd(&[
                "--json",
                "update",
                "--check",
                "--manifest",
                path.to_str().unwrap(),
            ])
            .env_remove("PLUR1BUS_TEST_RELEASE_PUBKEY")
            .output()
            .unwrap();
        let doc = doc(&out);
        assert_eq!(out.status.code(), Some(0), "{doc:#}");
        assert_eq!(doc["schema"], "update.check/1");
        assert_eq!(doc["available"].is_object(), available, "{doc:#}");
        assert_eq!(doc["changes"], json!([]), "{version}: {doc:#}");
        assert_eq!(doc["restart"]["modules"], json!([]), "{doc:#}");
        assert_eq!(doc["installed"]["modules"], json!([]), "{doc:#}");
    }
}

/// F35: `1staid repair --dry-run` plans nothing for a fresh host install and changes nothing. The service is
/// registered and started with the fake manager (as `repair.rs`'s healthy installation is), so
/// `service.registration` has nothing to renew.
#[test]
fn repair_dry_run_on_a_host_profile_plans_nothing() {
    let e = Env::new();
    let (code, v) = e.setup(&HOST);
    assert_success(code, &v);
    let installed = e.cmd(&["--json", "service", "install"]).output().unwrap();
    assert!(installed.status.success(), "{installed:?}");
    let before = std::fs::read(e.home.join("manifest.json")).unwrap();
    let out = e
        .cmd(&["--json", "1staid", "repair", "--dry-run"])
        .output()
        .unwrap();
    let doc = doc(&out);
    assert_eq!(out.status.code(), Some(0), "{doc:#}");
    assert_eq!(doc["schema"], "1staid.repair/1");
    assert_eq!(doc["dryRun"], true);
    assert_eq!(doc["steps"], json!([]), "{doc:#}");
    assert_eq!(std::fs::read(e.home.join("manifest.json")).unwrap(), before);
}

/// F21: CI runs `setup --profile host --no-service` with the flat-embedder test internals; the supervisor passes
/// them on to the core.
#[test]
fn host_profile_no_service_works_under_the_ci_seams() {
    let e = Env::new();
    let events = e.root.join("events.jsonl");
    let core = payload();
    let mut args = vec!["--json", "setup", "--core-from", core.to_str().unwrap()];
    args.extend(HOST);
    let out = e
        .cmd(&args)
        .env("PLUR1BUS_TEST_INTERNALS", "flat-embedder")
        .env("FAKE_CORE_EVENTS", &events)
        .output()
        .unwrap();
    let v = doc(&out);
    assert_success(out.status.code().unwrap_or(-1), &v);
    assert_eq!(step(&v, "service")["reason"], "no-service");
    assert_eq!(v["manifest"]["profile"], "host");
    let started: Vec<Value> = std::fs::read_to_string(&events)
        .unwrap()
        .lines()
        .filter_map(|l| serde_json::from_str::<Value>(l).ok())
        .filter(|ev| ev["event"] == "started")
        .collect();
    assert!(!started.is_empty(), "the core never started");
    assert!(
        started
            .iter()
            .all(|ev| ev["testInternals"] == "flat-embedder"),
        "{started:?}"
    );
}

#[test]
fn an_unknown_profile_is_a_usage_error_and_creates_nothing() {
    let e = Env::new();
    let out = e
        .cmd(&["setup", "--non-interactive", "--profile", "minimal"])
        .output()
        .unwrap();
    assert_eq!(out.status.code(), Some(2), "{out:?}");
    assert!(
        String::from_utf8_lossy(&out.stderr).contains("host"),
        "{out:?}"
    );
    assert!(!e.home.exists());
}
