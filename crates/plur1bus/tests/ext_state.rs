//! The extension state layer (X1 Task 5, spec §6.2; X1-R12, X1-R14, X1-R17): `extensions/state.json`, the skills index
//! writer that shares the importer's lock, revocations, integrity and overlays, and the host facts.
//!
//! The binary crate has no library target, so the modules the ext layer depends on are included by path.
#![allow(dead_code)]
// Inline modules cannot carry `#[path]` into a directory that does not exist, so each file is included at the root and
// re-exported under the name the crate uses.
#[path = "../src/supervisor/state.rs"]
pub(crate) mod supervisor_state;
mod supervisor {
    pub(crate) use super::supervisor_state as state;
}
#[path = "../src/audit.rs"]
mod audit;
#[path = "../src/container.rs"]
mod container;
#[path = "../src/identity.rs"]
mod identity;
#[path = "../src/modules/install.rs"]
pub(crate) mod modules_install;
#[path = "../src/modules/manifest.rs"]
pub(crate) mod modules_manifest;
#[path = "../src/paths.rs"]
mod paths;
#[path = "../src/proc.rs"]
mod proc;
mod modules {
    pub(crate) use super::modules_install as install;
    pub(crate) use super::modules_manifest as manifest;
}
#[path = "../src/install/archive.rs"]
pub(crate) mod install_archive;
#[path = "../src/install/targets.rs"]
pub(crate) mod install_targets;
mod install {
    pub(crate) use super::install_archive as archive;
    pub(crate) use super::install_targets as targets;
}
#[path = "../src/ext/mod.rs"]
mod ext;

use ext::index;
use ext::overlays::{self, Overlay, Revocation};
use ext::paths::ExtPaths;
use ext::state::{self, ExtState, Integrity, ItemRecord};
use paths::Layout;
use plur1bus_ext::compat::HostFacts;
use serde_json::{json, Value};
use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, MutexGuard};
use std::time::Duration;

/// Every test that reads or sets a process environment variable holds this.
static ENV: Mutex<()> = Mutex::new(());
fn env_guard() -> MutexGuard<'static, ()> {
    let g = ENV.lock().unwrap_or_else(|e| e.into_inner());
    for k in [
        "PLUR1BUS_ALLOW_TEST_INTERNALS",
        "PLUR1BUS_TEST_EXT_PUBKEYS",
        "PLUR1BUS_TEST_EXT_REVOCATIONS",
        "PLUR1BUS_TEST_EXT_INSPECT_TTL_MS",
        "PLUR1BUS_TEST_HARNESS_VERSION",
        "PLUR1BUS_CONTAINER",
    ] {
        std::env::remove_var(k);
    }
    g
}

fn home() -> (tempfile::TempDir, Layout) {
    let d = tempfile::tempdir().unwrap();
    let l = Layout::new(d.path().to_path_buf());
    (d, l)
}

fn sha_hex(b: &[u8]) -> String {
    use sha2::{Digest, Sha256};
    Sha256::digest(b)
        .iter()
        .map(|x| format!("{x:02x}"))
        .collect()
}

fn record(name: &str, kind: &str) -> ItemRecord {
    ItemRecord {
        id: format!("local/{name}"),
        name: name.into(),
        kind: kind.into(),
        version: "1.0.0".into(),
        source: "file".into(),
        trust: "unsigned".into(),
        key_id: None,
        key_label: None,
        package_sha256: "ab".repeat(32),
        installed_at: "2026-09-28T10:00:00.000Z".into(),
        previous_version: None,
        files: BTreeMap::new(),
        capabilities: json!({"network": {"mode": "none"}}),
        capabilities_ack: None,
        scripts: vec![],
        required_secrets: vec![],
        removed_by_user: false,
        integrity: None,
    }
}

fn host() -> HostFacts {
    HostFacts {
        harness_version: "0.3.0".into(),
        module_api_current: 1,
        rpc_version: "1.4.0".into(),
        platform: Some("linux-x64".into()),
        container: false,
    }
}

fn fixture() -> Value {
    let p = Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../packages/core/test/fixtures/skills-index-ext.json");
    serde_json::from_str(&fs::read_to_string(p).unwrap()).unwrap()
}

#[test]
fn state_round_trips_validates_and_refuses_a_newer_version() {
    let (_d, l) = home();
    let p = ExtPaths::of(&l);
    // Missing file: empty state.
    let empty = state::read(&p).unwrap();
    assert_eq!(empty.schema_version, state::STATE_VERSION);
    assert!(empty.items.is_empty());

    let mut rec = record("demo-skill", "skill");
    rec.files.insert(
        "SKILL.md".into(),
        plur1bus_ext::manifest::FileEntry {
            sha256: sha_hex(b"x"),
            size: 1,
            exec: false,
        },
    );
    rec.integrity = Some(Integrity {
        checked_at: "2026-09-28T11:00:00.000Z".into(),
        ok: true,
        paths: vec![],
    });
    let mut s = ExtState {
        schema_version: state::STATE_VERSION,
        items: BTreeMap::new(),
    };
    s.items.insert("demo-skill".into(), rec.clone());
    state::write(&p, &s).unwrap();
    let back = state::read(&p).unwrap();
    assert_eq!(back.items["demo-skill"], rec);
    let raw = fs::read_to_string(&p.state).unwrap();
    assert!(raw.ends_with('\n'));
    let v: Value = serde_json::from_str(&raw).unwrap();
    assert_eq!(v["items"]["demo-skill"]["packageSha256"], "ab".repeat(32));
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        assert_eq!(
            fs::metadata(&p.state).unwrap().permissions().mode() & 0o777,
            0o600
        );
    }
    // No temp file is left behind.
    let left: Vec<_> = fs::read_dir(&p.root)
        .unwrap()
        .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
        .collect();
    assert_eq!(left, vec!["state.json".to_string()], "{left:?}");

    // A newer schema version is refused before anything else is looked at.
    let mut newer = v.clone();
    newer["schemaVersion"] = json!(2);
    newer["items"]["demo-skill"]["somethingNew"] = json!(true);
    fs::write(&p.state, serde_json::to_string(&newer).unwrap()).unwrap();
    let e = state::read(&p).unwrap_err();
    assert!(e.contains("newer"), "{e}");

    // Schema violations: wrong type, unknown field, not JSON.
    let mut bad = v.clone();
    bad["items"]["demo-skill"]["removedByUser"] = json!("yes");
    fs::write(&p.state, serde_json::to_string(&bad).unwrap()).unwrap();
    assert!(state::read(&p).is_err());
    let mut bad = v.clone();
    bad["items"]["demo-skill"]["surprise"] = json!(1);
    fs::write(&p.state, serde_json::to_string(&bad).unwrap()).unwrap();
    assert!(state::read(&p).is_err());
    fs::write(&p.state, "{not json").unwrap();
    assert!(state::read(&p).is_err());
    assert!(state::STATE_SCHEMA_JSON.contains("ext-state.schema.json"));
}

#[test]
fn index_writer_keeps_unknown_fields_sorts_and_matches_the_ts_format() {
    let (_d, l) = home();
    let fx = fixture();
    let idx_path = l.skills().join("index.json");
    fs::create_dir_all(l.skills()).unwrap();
    fs::write(&idx_path, serde_json::to_string(&fx["input"]).unwrap()).unwrap();

    let idx = index::read_index(&l).unwrap();
    assert!(idx.entry("zeta").is_some());
    assert_eq!(idx.entry("alpha").unwrap()["note"], "kept");
    index::write_index(&l, &idx).unwrap();
    let got = fs::read_to_string(&idx_path).unwrap();
    assert_eq!(got, fx["outputText"].as_str().unwrap());
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        assert_eq!(
            fs::metadata(&idx_path).unwrap().permissions().mode() & 0o777,
            0o600
        );
    }

    // upsert / set_enabled / remove keep everything else, and the sort holds.
    let mut idx = index::read_index(&l).unwrap();
    idx.upsert(json!({
        "id": "middle", "source": "file", "sourcePath": "/m", "sha256": "sha256:cc", "enabled": false,
        "importedAt": "2026-09-28T12:00:00.000Z",
        "package": {"id": "local/middle", "version": "1.0.0", "trust": "unsigned"}
    }));
    assert!(idx.set_enabled("middle", true));
    assert!(!idx.set_enabled("absent", true));
    assert_eq!(idx.entry("middle").unwrap()["enabled"], true);
    index::write_index(&l, &idx).unwrap();
    let again = index::read_index(&l).unwrap();
    let ids: Vec<&str> = again.0["skills"]
        .as_array()
        .unwrap()
        .iter()
        .map(|e| e["id"].as_str().unwrap())
        .collect();
    assert_eq!(ids, ["alpha", "demo-skill", "middle", "zeta"]);
    assert_eq!(again.0["extra"], fx["input"]["extra"]);
    let mut again = again;
    assert!(again.remove("middle").is_some());
    assert!(again.remove("middle").is_none());
    // An empty store: no file yet reads as version 1 with no skills.
    let (_d2, l2) = home();
    let fresh = index::read_index(&l2).unwrap();
    assert_eq!(fresh.0, json!({"version": 1, "skills": []}));
    index::write_index(&l2, &fresh).unwrap();
    assert_eq!(
        fs::read_to_string(l2.skills().join("index.json")).unwrap(),
        "{\n  \"version\": 1,\n  \"skills\": []\n}\n"
    );
}

#[test]
fn index_reader_refuses_invalid_ids_like_the_importer() {
    let (_d, l) = home();
    fs::create_dir_all(l.skills()).unwrap();
    let p = l.skills().join("index.json");
    let cases: &[(&str, &str)] = &[
        (
            r#"{"version":1,"skills":[{"id":"Bad Id"}]}"#,
            "index-invalid",
        ),
        (
            r#"{"version":1,"skills":[{"id":"-lead"}]}"#,
            "index-invalid",
        ),
        (r#"{"version":1,"skills":[{}]}"#, "index-invalid"),
        (r#"{"version":1,"skills":"x"}"#, "index-invalid"),
        (r#"[1]"#, "index-invalid"),
        ("{oops", "index-invalid"),
        (r#"{"version":2,"skills":[]}"#, "index-newer"),
    ];
    for (text, reason) in cases {
        fs::write(&p, text).unwrap();
        let e = index::read_index(&l).unwrap_err();
        assert_eq!(e.reason, Some(*reason), "{text}: {e:?}");
        assert!(e.message.contains("index.json"), "{}", e.message);
    }
    // A valid id at the pattern's limits is accepted.
    let long = format!("a{}", "b".repeat(63));
    fs::write(
        &p,
        format!(r#"{{"version":1,"skills":[{{"id":"{long}"}},{{"id":"a.b_c-d"}}]}}"#),
    )
    .unwrap();
    assert!(index::read_index(&l).is_ok());
    let too_long = format!("a{}", "b".repeat(64));
    fs::write(
        &p,
        format!(r#"{{"version":1,"skills":[{{"id":"{too_long}"}}]}}"#),
    )
    .unwrap();
    assert!(index::read_index(&l).is_err());
}

#[cfg(unix)]
fn long_lived_child() -> std::process::Child {
    std::process::Command::new("sleep")
        .arg("60")
        .spawn()
        .unwrap()
}
#[cfg(windows)]
fn long_lived_child() -> std::process::Child {
    std::process::Command::new("powershell")
        .args(["-NoProfile", "-Command", "Start-Sleep 60"])
        .spawn()
        .unwrap()
}

#[test]
fn lock_skills_refuses_a_live_holder_and_takes_over_a_dead_one() {
    let (_d, l) = home();
    let lock = l.imports().join(".lock");

    // Free: taken, holding our pid, released on drop.
    {
        let g = index::lock_skills(&l).unwrap();
        let v: Value = serde_json::from_str(&fs::read_to_string(&lock).unwrap()).unwrap();
        assert_eq!(v["pid"], std::process::id());
        assert!(v["at"].is_string());
        drop(g);
    }
    assert!(!lock.exists());

    // A live holder (another process): E_LOCKED skills-locked, and the file is untouched.
    let mut child = long_lived_child();
    fs::create_dir_all(l.imports()).unwrap();
    let held = json!({"pid": child.id(), "at": "2026-09-28T10:00:00.000Z"}).to_string();
    fs::write(&lock, &held).unwrap();
    let e = index::lock_skills(&l).unwrap_err();
    assert_eq!(e.code, "E_LOCKED");
    assert_eq!(e.reason, Some("skills-locked"));
    assert!(e.message.contains(&child.id().to_string()), "{}", e.message);
    assert_eq!(fs::read_to_string(&lock).unwrap(), held);
    child.kill().unwrap();
    let _ = child.wait();

    // A dead holder (pid 999999) and an unreadable lock are taken over.
    for text in [r#"{"pid":999999,"at":"x"}"#, "garbage"] {
        fs::write(&lock, text).unwrap();
        let g = index::lock_skills(&l).unwrap();
        let v: Value = serde_json::from_str(&fs::read_to_string(&lock).unwrap()).unwrap();
        assert_eq!(v["pid"], std::process::id());
        drop(g);
        assert!(!lock.exists());
    }

    // Drop releases only a lock that is still ours.
    let g = index::lock_skills(&l).unwrap();
    fs::write(&lock, r#"{"pid":999999,"at":"x"}"#).unwrap();
    drop(g);
    assert!(lock.exists());
}

#[test]
fn revocations_match_by_id_and_semver_range_and_ignore_warn() {
    let _g = env_guard();
    let (_d, l) = home();
    let p = ExtPaths::of(&l);
    // Absent file: empty, no complaint.
    assert!(overlays::load_revocations(&p).is_empty());

    fs::create_dir_all(p.revocations.parent().unwrap()).unwrap();
    fs::write(
        &p.revocations,
        json!({"revocations": [
            {"id": "io.github.jdoe/foo", "versions": "<=1.1.3", "action": "disable",
             "reason": {"en": "leaks a token", "de": "leckt ein Token"}, "advisory": "https://example.invalid/a"},
            {"id": "io.github.jdoe/bar", "versions": ">=2.0.0 <3.0.0", "action": "warn", "reason": {"en": "old"}},
            {"id": "io.github.jdoe/baz", "versions": "1.0.0", "action": "disable", "reason": {"en": "exact"}}
        ]})
        .to_string(),
    )
    .unwrap();
    let revs = overlays::load_revocations(&p);
    assert_eq!(revs.len(), 3);
    assert_eq!(
        overlays::revoked(&revs, "io.github.jdoe/foo", "1.1.3").as_deref(),
        Some("leaks a token")
    );
    assert_eq!(
        overlays::revoked(&revs, "io.github.jdoe/foo", "0.9.0").as_deref(),
        Some("leaks a token")
    );
    assert_eq!(
        overlays::revoked(&revs, "io.github.jdoe/foo", "1.2.0"),
        None
    );
    assert_eq!(
        overlays::revoked(&revs, "io.github.jdoe/other", "1.0.0"),
        None
    );
    // `warn` never revokes.
    assert_eq!(
        overlays::revoked(&revs, "io.github.jdoe/bar", "2.5.0"),
        None
    );
    // A bare version is exact (npm), not a caret range.
    assert!(overlays::revoked(&revs, "io.github.jdoe/baz", "1.0.0").is_some());
    assert!(overlays::revoked(&revs, "io.github.jdoe/baz", "1.0.1").is_none());
    // A pre-release build of a revoked release is revoked too.
    assert!(overlays::revoked(&revs, "io.github.jdoe/foo", "1.1.3-rc.1").is_some());
    // `*` matches every version.
    let star = json!([{"id": "s/t", "versions": "*", "action": "disable", "reason": "all"}]);
    fs::write(&p.revocations, star.to_string()).unwrap();
    let revs = overlays::load_revocations(&p);
    assert_eq!(revs.len(), 1);
    assert_eq!(
        overlays::revoked(&revs, "s/t", "0.0.1").as_deref(),
        Some("all")
    );
    assert_eq!(
        overlays::revoked(&revs, "s/t", "12.3.4").as_deref(),
        Some("all")
    );
    // A version that is not semver is never revoked (and never panics).
    assert_eq!(
        overlays::revoked(&revs, "io.github.jdoe/foo", "not-a-version"),
        None
    );

    // Unreadable file: empty.
    fs::write(&p.revocations, "{nope").unwrap();
    assert!(overlays::load_revocations(&p).is_empty());

    // The test seam: honoured only with test internals, and added to the file's entries.
    let seam = l.home.join("seam.json");
    fs::write(&seam, json!({"revocations": [{"id": "x/y", "versions": "*", "action": "disable", "reason": {"en": "seam"}}]}).to_string()).unwrap();
    std::env::set_var("PLUR1BUS_TEST_EXT_REVOCATIONS", &seam);
    assert!(
        overlays::load_revocations(&p).is_empty(),
        "the seam needs test internals"
    );
    std::env::set_var("PLUR1BUS_ALLOW_TEST_INTERNALS", "1");
    let revs = overlays::load_revocations(&p);
    assert_eq!(
        overlays::revoked(&revs, "x/y", "9.9.9").as_deref(),
        Some("seam")
    );
}

fn skill_with_files(l: &Layout, name: &str, files: &[(&str, &[u8])]) -> ItemRecord {
    let dir = l.skills().join(name);
    let mut rec = record(name, "skill");
    for (rel, bytes) in files {
        let f = dir.join(rel);
        fs::create_dir_all(f.parent().unwrap()).unwrap();
        fs::write(&f, bytes).unwrap();
        rec.files.insert(
            (*rel).into(),
            plur1bus_ext::manifest::FileEntry {
                sha256: sha_hex(bytes),
                size: bytes.len() as u64,
                exec: false,
            },
        );
    }
    rec
}

#[test]
fn rehash_reports_a_changed_file_and_a_missing_file() {
    let (_d, l) = home();
    let rec = skill_with_files(
        &l,
        "demo-skill",
        &[
            ("SKILL.md", b"---\nname: demo-skill\n---\n"),
            ("scripts/run.sh", b"echo hi\n"),
            ("notes.txt", b"n"),
        ],
    );
    let ok = overlays::rehash(&l, &rec);
    assert!(ok.ok, "{ok:?}");
    assert!(ok.paths.is_empty());
    assert!(!ok.checked_at.is_empty());

    let dir = l.skills().join("demo-skill");
    fs::write(dir.join("SKILL.md"), b"changed").unwrap();
    fs::remove_file(dir.join("scripts/run.sh")).unwrap();
    // A same-size change is caught by the hash, not the size.
    fs::write(dir.join("notes.txt"), b"m").unwrap();
    let bad = overlays::rehash(&l, &rec);
    assert!(!bad.ok);
    assert_eq!(bad.paths, ["SKILL.md", "notes.txt", "scripts/run.sh"]);

    // A module is checked under modules/<name>/; a missing directory reports every file.
    let mut m = record("fixture", "module");
    m.files.insert(
        "dist/index.js".into(),
        plur1bus_ext::manifest::FileEntry {
            sha256: sha_hex(b"1"),
            size: 1,
            exec: false,
        },
    );
    let r = overlays::rehash(&l, &m);
    assert!(!r.ok);
    assert_eq!(r.paths, ["dist/index.js"]);
    let mdir = l.modules_dir().join("fixture/dist");
    fs::create_dir_all(&mdir).unwrap();
    fs::write(mdir.join("index.js"), b"1").unwrap();
    assert!(overlays::rehash(&l, &m).ok);
}

#[test]
fn overlays_needs_setup_for_a_required_secret_incompatible_revoked_tampered() {
    let mut rec = record("demo-skill", "skill");
    let none: Vec<Revocation> = vec![];
    assert_eq!(
        overlays::overlays_of(&rec, &host(), &none, None),
        Vec::<Overlay>::new()
    );

    rec.required_secrets = vec!["api-key".into()];
    assert_eq!(
        overlays::overlays_of(&rec, &host(), &none, None),
        [Overlay::NeedsSetup]
    );
    rec.required_secrets.clear();

    let compat = json!({"harness": ">=9.0.0"});
    assert_eq!(
        overlays::overlays_of(&rec, &host(), &none, Some(&compat)),
        [Overlay::Incompatible]
    );
    let fine = json!({"harness": ">=0.2.0 <1.0.0", "rpc": "^1.3", "platforms": ["linux-x64"]});
    assert!(overlays::overlays_of(&rec, &host(), &none, Some(&fine)).is_empty());
    // moduleApi only matters for modules and channels.
    let api = json!({"moduleApi": ["7"]});
    assert!(overlays::overlays_of(&rec, &host(), &none, Some(&api)).is_empty());
    let mut module = record("fixture", "module");
    assert_eq!(
        overlays::overlays_of(&module, &host(), &none, Some(&api)),
        [Overlay::Incompatible]
    );
    module.kind = "channel".into();
    assert_eq!(
        overlays::overlays_of(&module, &host(), &none, Some(&api)),
        [Overlay::Incompatible]
    );

    let revs = vec![Revocation {
        id: "local/demo-skill".into(),
        versions: semver::VersionReq::parse("<=1.0.0").unwrap(),
        action: "disable".into(),
        reason: json!({"en": "bad"}),
    }];
    assert_eq!(
        overlays::overlays_of(&rec, &host(), &revs, None),
        [Overlay::Revoked]
    );

    rec.integrity = Some(Integrity {
        checked_at: "t".into(),
        ok: false,
        paths: vec!["SKILL.md".into()],
    });
    assert_eq!(
        overlays::overlays_of(&rec, &host(), &revs, None),
        [Overlay::Revoked, Overlay::Tampered]
    );
    rec.integrity = Some(Integrity {
        checked_at: "t".into(),
        ok: true,
        paths: vec![],
    });
    assert_eq!(
        overlays::overlays_of(&rec, &host(), &revs, None),
        [Overlay::Revoked]
    );

    // Everything at once comes back in the enum's order.
    rec.required_secrets = vec!["k".into()];
    rec.integrity = Some(Integrity {
        checked_at: "t".into(),
        ok: false,
        paths: vec![],
    });
    assert_eq!(
        overlays::overlays_of(&rec, &host(), &revs, Some(&compat)),
        [
            Overlay::NeedsSetup,
            Overlay::Incompatible,
            Overlay::Revoked,
            Overlay::Tampered
        ]
    );

    // A kind the host cannot evaluate is the `error` overlay.
    let mut odd = record("odd", "hologram");
    odd.integrity = None;
    assert_eq!(
        overlays::overlays_of(&odd, &host(), &none, None),
        [Overlay::Error]
    );
    assert_eq!(
        serde_json::to_value(Overlay::NeedsSetup).unwrap(),
        "needs-setup"
    );
    assert_eq!(serde_json::to_value(Overlay::Error).unwrap(), "error");
}

#[test]
fn trust_store_ignores_the_seam_without_test_internals() {
    let _g = env_guard();
    let key = plur1bus_ext::testkit::test_key("x1-state");
    let spec = format!("{}={}", key.label, key.public_b64);
    std::env::set_var("PLUR1BUS_TEST_EXT_PUBKEYS", &spec);
    // The pinned set ships empty, and the seam alone adds nothing.
    assert!(ext::host::trust_store().is_empty());
    std::env::set_var("PLUR1BUS_ALLOW_TEST_INTERNALS", "1");
    assert!(!ext::host::trust_store().is_empty());
    // Only the exact value "1" counts.
    std::env::set_var("PLUR1BUS_ALLOW_TEST_INTERNALS", "true");
    assert!(ext::host::trust_store().is_empty());
    // A malformed seam never widens trust (and never panics).
    std::env::set_var("PLUR1BUS_ALLOW_TEST_INTERNALS", "1");
    std::env::set_var("PLUR1BUS_TEST_EXT_PUBKEYS", "broken");
    assert!(ext::host::trust_store().is_empty());
}

#[test]
fn host_facts_maps_win_to_win32() {
    let _g = env_guard();
    // The platform is an install::targets id; check_compat maps win-* to the manifest's win32-*.
    let win = HostFacts {
        platform: Some("win-x64".into()),
        ..host()
    };
    let compat = json!({"platforms": ["win32-x64"]});
    let rec = record("demo-skill", "skill");
    assert!(overlays::overlays_of(&rec, &win, &[], Some(&compat)).is_empty());
    let arm = HostFacts {
        platform: Some("win-arm64".into()),
        ..host()
    };
    assert_eq!(
        overlays::overlays_of(&rec, &arm, &[], Some(&compat)),
        [Overlay::Incompatible]
    );
    let arm_ok = json!({"platforms": ["win32-arm64"]});
    assert!(overlays::overlays_of(&rec, &arm, &[], Some(&arm_ok)).is_empty());

    // The real host: this binary's target, the generated RPC version, the module API, the crate version.
    let h = ext::host::host_facts();
    assert_eq!(
        h.platform.as_deref(),
        install::targets::Target::current().map(|t| t.id())
    );
    assert_eq!(h.rpc_version, plur1bus_rpc::RPC_VERSION);
    assert_eq!(h.module_api_current, 1);
    assert_eq!(h.harness_version, env!("CARGO_PKG_VERSION"));
    assert!(!h.container);

    // Seams: the harness version needs test internals; container mode reads PLUR1BUS_CONTAINER.
    std::env::set_var("PLUR1BUS_TEST_HARNESS_VERSION", "9.9.9");
    assert_eq!(
        ext::host::host_facts().harness_version,
        env!("CARGO_PKG_VERSION")
    );
    std::env::set_var("PLUR1BUS_ALLOW_TEST_INTERNALS", "1");
    assert_eq!(ext::host::host_facts().harness_version, "9.9.9");
    std::env::set_var("PLUR1BUS_TEST_HARNESS_VERSION", "not semver");
    assert_eq!(
        ext::host::host_facts().harness_version,
        env!("CARGO_PKG_VERSION")
    );
    std::env::set_var("PLUR1BUS_CONTAINER", "1");
    assert!(ext::host::host_facts().container);
}

#[test]
fn paths_ttl_reserved_names_and_error_conversion() {
    let _g = env_guard();
    let (_d, l) = home();
    let p = ExtPaths::of(&l);
    let root: PathBuf = l.home.join("extensions");
    assert_eq!(p.root, root);
    assert_eq!(p.state, root.join("state.json"));
    assert_eq!(p.cache, root.join("cache"));
    assert_eq!(p.staging, root.join("staging"));
    assert_eq!(p.trash, root.join("trash"));
    assert_eq!(p.revocations, root.join("catalog").join("revocations.json"));
    assert_eq!(p.inspect, l.run().join("inspect"));
    let sha = "ab".repeat(32);
    assert_eq!(
        p.cached(&sha),
        root.join("cache").join(format!("{sha}.p1x"))
    );
    assert_eq!(
        l.ext_data("demo"),
        l.home.join("data").join("ext").join("demo")
    );
    assert_eq!(l.imports(), l.home.join("imports"));

    assert!(ext::host::reserved_names().contains(&"core"));
    assert!(ext::host::reserved_names().contains(&"supervisor"));

    assert_eq!(ext::host::inspect_ttl(), Duration::from_secs(600));
    std::env::set_var("PLUR1BUS_TEST_EXT_INSPECT_TTL_MS", "250");
    assert_eq!(
        ext::host::inspect_ttl(),
        Duration::from_secs(600),
        "the seam needs test internals"
    );
    std::env::set_var("PLUR1BUS_ALLOW_TEST_INTERNALS", "1");
    assert_eq!(ext::host::inspect_ttl(), Duration::from_millis(250));

    let r = plur1bus_ext::refusal::Refusal::invalid("package-invalid", "bad manifest");
    let e: ext::ExtError = r.into();
    assert_eq!(e.code, "E_INVALID_PARAMS");
    assert_eq!(e.reason, Some("package-invalid"));
    assert!(e.message.contains("bad manifest"));
    assert!(e.data.is_null() || e.data.is_object());
}

#[test]
fn index_writer_orders_known_fields_first_and_the_rest_alphabetically() {
    let (_d, l) = home();
    fs::create_dir_all(l.skills()).unwrap();
    // An unknown field before every known one, and a `package` whose keys are not in the documented order.
    let text = r#"{"zextra":1,"skills":[{"zzz":true,"aaa":{"y":1,"x":2},"package":{"trust":"unsigned","version":"1.0.0","id":"local/a","extra":[]},"enabled":true,"id":"a"}],"version":1,"aextra":{"b":1,"a":{"d":1,"c":2}}}"#;
    fs::write(l.skills().join("index.json"), text).unwrap();
    let idx = index::read_index(&l).unwrap();
    index::write_index(&l, &idx).unwrap();
    let got = fs::read_to_string(l.skills().join("index.json")).unwrap();
    let want = r#"{
  "version": 1,
  "skills": [
    {
      "id": "a",
      "enabled": true,
      "package": {
        "id": "local/a",
        "version": "1.0.0",
        "trust": "unsigned",
        "extra": []
      },
      "aaa": {
        "x": 2,
        "y": 1
      },
      "zzz": true
    }
  ],
  "aextra": {
    "a": {
      "c": 2,
      "d": 1
    },
    "b": 1
  },
  "zextra": 1
}
"#;
    assert_eq!(got, want);
}
