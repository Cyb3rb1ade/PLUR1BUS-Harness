//! `plur1bus setup` (2a-H3b-b Task 4, spec §6.5, HB11). No network and no real service manager: the Node runtime
//! comes from `PLUR1BUS_NODE_MIRROR=file://<tmp>` holding a fake archive whose hash replaces the pin
//! (`PLUR1BUS_TEST_NODE_SHA256`, honoured only with `PLUR1BUS_ALLOW_TEST_INTERNALS=1`); the core payload is
//! `tests/fixtures/setup` (`core.js` is a copy of `fake-core.mjs`); the service manager is the recording fake
//! (`PLUR1BUS_SERVICE_FAKE`), with `HOME`/`USERPROFILE`/`LOCALAPPDATA` in the temp dir so a unit file never lands in the
//! real user's directories. On unix the fake archive's `bin/node` is a `#!/bin/sh` shim `exec "$REAL_NODE" "$@"`
//! (`exec` keeps the pid, so the supervisor's identity checks hold); on Windows it is a stored zip holding the real
//! `node.exe`, as `node-v24.21.0-win-x64.zip` has it at its root.
mod common;

mod setup_env;

#[cfg(unix)]
use serde_json::Value;
use setup_env::*;
use std::path::{Path, PathBuf};
#[cfg(unix)]
use std::process::Stdio;
use std::time::Duration;

#[cfg(unix)]
#[test]
fn setup_non_interactive_installs_everything_but_the_service() {
    let e = Env::new();
    let (code, v) = e.setup(&["--non-interactive", "--no-service"]);
    assert_success(code, &v);
    for id in STEP_IDS {
        let want = if matches!(id, "modules.bundled" | "service") {
            "skipped"
        } else {
            "done"
        };
        assert_eq!(status_of(&v, id), want, "{id}: {v:#}");
    }
    assert_eq!(step(&v, "modules.bundled")["reason"], "none");
    assert!(node_binary(&e.home).is_file());
    assert_eq!(v["home"].as_str().map(PathBuf::from), Some(e.home.clone()));
    assert_eq!(v["target"], target_id());

    // manifest.json validates (the CLI re-reads it with the schema) and names what was installed.
    let raw = std::fs::read_to_string(e.home.join("manifest.json")).unwrap();
    let m: Value = serde_json::from_str(&raw).unwrap();
    assert_eq!(m, v["manifest"]);
    assert_eq!(m["schemaVersion"], 1);
    assert_eq!(m["target"], target_id());
    assert_eq!(m["channel"], "stable");
    assert_eq!(m["node"]["version"], NODE_VERSION);
    assert_eq!(m["node"]["archiveSha256"], e.node_sha);
    assert_eq!(
        PathBuf::from(m["node"]["path"].as_str().unwrap()),
        std::path::absolute(node_binary(&e.home)).unwrap()
    );
    assert_eq!(m["core"]["source"], "local");
    assert_eq!(m["core"]["version"], "0.1.0");
    assert_eq!(m["core"]["contract"], "1.10.0");
    assert_eq!(m["core"]["rpc"], "1.5.0");
    let skills: Vec<&str> = m["skills"]
        .as_array()
        .unwrap()
        .iter()
        .map(|s| s["name"].as_str().unwrap())
        .collect();
    assert_eq!(skills, ["plur1bus-ops", "third-party"]);

    assert_eq!(
        e.json(&["config", "get", "embedding.useClass"])["value"],
        "general"
    );
    assert_eq!(
        e.json(&["config", "get", "embedding.acceptedNcLicence"])["value"],
        false
    );
    assert!(e.json(&["config", "get", "agents"])["value"]
        .get("main")
        .is_some());
    assert!(e.home.join("skills/plur1bus-ops/SKILL.md").is_file());
    assert!(e.home.join("skills/third-party/example/SKILL.md").is_file());
    assert_core_ready(&e);
    assert!(!e.home.join("runtime/core.prev").exists());
    assert_eq!(e.audit_actions(), ["setup.complete"]);
    assert!(
        stray_temps(&e.home).is_empty(),
        "{:?}",
        stray_temps(&e.home)
    );
}

#[test]
fn a_wrong_runtime_digest_fails_the_step_and_leaves_no_runtime_dir() {
    let e = Env::new();
    let (code, v) = {
        let core = payload();
        let out = e
            .cmd(&[
                "--json",
                "setup",
                "--non-interactive",
                "--no-service",
                "--core-from",
                core.to_str().unwrap(),
            ])
            .env("PLUR1BUS_TEST_NODE_SHA256", "0".repeat(64))
            .output()
            .unwrap();
        (out.status.code().unwrap_or(-1), doc(&out))
    };
    assert_eq!(code, 1, "{v:#}");
    assert_eq!(v["schema"], "setup/1", "{v}");
    assert_eq!(ids(&v), STEP_IDS);
    assert_eq!(status_of(&v, "state-root"), "done");
    assert_eq!(v["steps"][1]["status"], "failed");
    assert_eq!(v["steps"][1]["reason"], "digest-mismatch", "{v:#}");
    for s in &v["steps"].as_array().unwrap()[2..] {
        assert_eq!(s["status"], "skipped", "{s}");
        assert_eq!(s["reason"], "after-failure", "{s}");
    }
    assert!(v["manifest"].is_null());
    assert!(v["check"].is_null());
    assert!(
        runtime_node_dirs(&e.home).is_empty(),
        "{:?}",
        runtime_node_dirs(&e.home)
    );
    assert!(
        stray_temps(&e.home).is_empty(),
        "{:?}",
        stray_temps(&e.home)
    );
    assert!(!e.home.join("manifest.json").exists());
    assert!(!e.home.join("runtime/core").exists());
}

#[cfg(unix)]
#[test]
fn rerun_is_idempotent_and_downloads_nothing() {
    let e = Env::new();
    let (code, v) = e.setup(&["--non-interactive", "--no-service"]);
    assert_success(code, &v);
    let first = v["manifest"].clone();
    std::fs::remove_dir_all(&e.mirror).unwrap();

    let (code, v) = e.setup(&["--non-interactive", "--no-service"]);
    assert_success(code, &v);
    assert_eq!(status_of(&v, "runtime.node"), "skipped", "{v:#}");
    assert_eq!(step(&v, "runtime.node")["reason"], "already-installed");
    assert_eq!(v["manifest"]["installedAt"], first["installedAt"]);
    assert_eq!(v["manifest"]["node"], first["node"]);
    assert_eq!(e.audit_actions(), ["setup.complete", "setup.complete"]);
}

#[cfg(unix)]
#[test]
fn a_killed_setup_leaves_no_half_installed_runtime_and_a_rerun_completes() {
    let e = Env::new();
    let core = payload();
    let mut child = e
        .cmd(&[
            "--json",
            "setup",
            "--non-interactive",
            "--no-service",
            "--core-from",
            core.to_str().unwrap(),
        ])
        .env("PLUR1BUS_TEST_SETUP_PAUSE_AT", "runtime.core")
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .unwrap();
    // The pause seam marks itself with a temp file (removed with the other stray temps by the next run).
    let marker = e
        .home
        .join(format!("runtime/setup-paused.tmp-{}", child.id()));
    let deadline = std::time::Instant::now() + Duration::from_secs(30);
    while !marker.exists() {
        assert!(
            child.try_wait().unwrap().is_none(),
            "setup exited before its pause"
        );
        assert!(
            std::time::Instant::now() < deadline,
            "setup never reached its pause"
        );
        std::thread::sleep(Duration::from_millis(20));
    }
    child.kill().unwrap(); // SIGKILL
    child.wait().unwrap();
    assert!(!e.home.join("runtime/core").exists());
    assert!(!e.home.join("manifest.json").exists());

    // What a kill in the middle of the copy or of an extraction leaves behind.
    let stray_core = e.home.join("runtime/core.tmp-999999");
    std::fs::create_dir_all(&stray_core).unwrap();
    std::fs::write(stray_core.join("core.js"), "half").unwrap();
    std::fs::write(
        e.home
            .join(format!("runtime/{}.tmp-999999", archive_name())),
        "half",
    )
    .unwrap();

    let (code, v) = e.setup(&["--non-interactive", "--no-service"]);
    assert_success(code, &v);
    assert!(
        stray_temps(&e.home).is_empty(),
        "{:?}",
        stray_temps(&e.home)
    );
    assert!(!marker.exists());
    assert!(e.home.join("runtime/core/core.js").is_file());
}

/// Review Focus 2. Also runs setup's `service` step (a second run, against the fake manager) and asserts on the unit
/// text `service::render` produced for this OS's manager.
#[test]
fn setup_under_a_home_with_spaces_and_non_ascii_works() {
    let e = Env::with_home("p1b A/J\u{fc}rgen");
    let (code, v) = e.setup(&["--non-interactive", "--no-service"]);
    assert_success(code, &v);
    assert_core_ready(&e);

    let (code, v) = e.setup(&["--non-interactive"]);
    assert_success(code, &v);
    assert_eq!(status_of(&v, "service"), "done", "{v:#}");
    let unit = PathBuf::from(step(&v, "service")["detail"]["path"].as_str().unwrap());
    // The home as setup resolved it (Windows may name the temp dir differently from the test's spelling).
    let home = v["home"].as_str().unwrap();
    if cfg!(target_os = "macos") {
        let text = std::fs::read_to_string(&unit).unwrap();
        assert!(text.contains(&format!("<string>{home}</string>")), "{text}");
    } else if cfg!(windows) {
        let raw = std::fs::read(&unit).unwrap();
        let units: Vec<u16> = raw[2..]
            .chunks_exact(2)
            .map(|c| u16::from_le_bytes([c[0], c[1]]))
            .collect();
        // The task XML escapes the quotes of `--home "<home>"` (`&quot;`).
        let text = String::from_utf16(&units).unwrap().replace("&quot;", "\"");
        assert!(
            text.contains(&format!("--home \"{home}\" supervise")),
            "{text}"
        );
    } else {
        let text = std::fs::read_to_string(&unit).unwrap();
        assert!(
            text.contains(&format!("--home \"{home}\" supervise")),
            "{text}"
        );
    }
    assert!(
        unit.starts_with(&e.user) || unit.starts_with(&e.home),
        "{unit:?}"
    );
}

#[cfg(unix)]
#[test]
fn accept_nc_licence_sets_both_fields_and_writes_one_audit_line() {
    let e = Env::new();
    let (code, v) = e.setup(&[
        "--non-interactive",
        "--no-service",
        "--use-class",
        "research",
        "--accept-nc-licence",
    ]);
    assert_success(code, &v);
    assert_eq!(
        e.json(&["config", "get", "embedding.useClass"])["value"],
        "research"
    );
    assert_eq!(
        e.json(&["config", "get", "embedding.acceptedNcLicence"])["value"],
        true
    );
    let at = e.json(&["config", "get", "embedding.acceptedNcLicenceAt"])["value"].clone();
    assert!(at.as_str().is_some_and(|s| s.ends_with('Z')), "{at}");
    let actions = e.audit_actions();
    assert_eq!(
        actions.iter().filter(|a| *a == "licence.accept-nc").count(),
        1,
        "{actions:?}"
    );
}

#[cfg(unix)]
#[test]
fn non_interactive_never_accepts_the_nc_licence_silently() {
    let e = Env::new();
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
    assert!(!e.audit_actions().iter().any(|a| a == "licence.accept-nc"));
}

#[test]
fn a_tampered_third_party_skill_fails_the_skills_step_and_copies_nothing() {
    let e = Env::new();
    let tampered = e.root.join("payload");
    copy_tree(&payload(), &tampered);
    std::fs::write(
        tampered.join("skills/third-party/example/SKILL.md"),
        "TEST ONLY: changed after pinning",
    )
    .unwrap();
    let out = e
        .cmd(&[
            "--json",
            "setup",
            "--non-interactive",
            "--no-service",
            "--core-from",
            tampered.to_str().unwrap(),
        ])
        .output()
        .unwrap();
    let v = doc(&out);
    assert_eq!(out.status.code(), Some(1), "{v:#}");
    assert_eq!(status_of(&v, "skills"), "failed", "{v:#}");
    assert_eq!(step(&v, "skills")["reason"], "digest-mismatch");
    for id in ["service", "start", "check"] {
        assert_eq!(step(&v, id)["reason"], "after-failure", "{id}");
    }
    let copied: Vec<_> = std::fs::read_dir(e.home.join("skills"))
        .map(|rd| rd.flatten().map(|e| e.file_name()).collect())
        .unwrap_or_default();
    assert!(copied.is_empty(), "{copied:?}");
    assert!(!e.home.join("run/supervisor.pid").exists());
}

#[test]
fn setup_routes_config_through_a_running_supervisor() {
    let e = Env::new();
    std::fs::create_dir_all(&e.home).unwrap();
    let events = e.root.join("events.jsonl");
    let _sup = common::start_with_core(&e.home, &events, "1", &[]);
    let watch = common::Watch::open(&e.home);
    let (code, v) = e.setup(&["--non-interactive", "--no-service"]);
    assert_success(code, &v);
    assert_eq!(step(&v, "config")["detail"]["supervised"], true, "{v:#}");
    let changes = watch.changes_within(Duration::from_secs(2));
    assert_eq!(changes.len(), 1, "{changes:?}");
    assert_eq!(changes[0]["source"], "set", "{changes:?}");
}

#[test]
fn setup_in_container_mode_is_container_managed() {
    let e = Env::new();
    let out = e
        .cmd(&["--json", "setup", "--non-interactive"])
        .env("PLUR1BUS_CONTAINER", "1")
        .output()
        .unwrap();
    let v = doc(&out);
    assert_eq!(out.status.code(), Some(1), "{v}");
    assert_eq!(v["error"], "E_NOT_AVAILABLE");
    assert_eq!(v["reason"], "container-managed");
    assert!(!e.home.exists(), "nothing is created");
}

fn copy_tree(from: &Path, to: &Path) {
    std::fs::create_dir_all(to).unwrap();
    for entry in std::fs::read_dir(from).unwrap().flatten() {
        let dest = to.join(entry.file_name());
        if entry.file_type().unwrap().is_dir() {
            copy_tree(&entry.path(), &dest);
        } else {
            std::fs::copy(entry.path(), dest).unwrap();
        }
    }
}

/// The payload's `core.js` is a copy of `fake-core.mjs` (Task 4's fixture layout); a change to one must reach both.
#[test]
fn the_setup_fixture_core_is_a_copy_of_fake_core() {
    let norm = |p: PathBuf| std::fs::read_to_string(p).unwrap().replace("\r\n", "\n");
    let fixtures = Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures");
    assert_eq!(
        norm(fixtures.join("setup/core.js")),
        norm(fixtures.join("fake-core.mjs"))
    );
}
