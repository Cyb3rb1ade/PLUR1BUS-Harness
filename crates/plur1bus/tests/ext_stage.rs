//! The worker half of extensions from file (X1 Task 6; spec §8.4 steps 8–10; X1-R2, X1-R3, X1-R16, X1-R22, X1-R29;
//! Review Focus 2 and 4): inspection records under `run/inspect/`, staging through the one extractor with the re-hash
//! and the kind checks, and the `plur1bus ext __worker` process.
//!
//! The binary crate has no library target, so the modules the worker depends on are included by path (as in
//! `ext_state.rs`). The worker process itself is the real binary (`CARGO_BIN_EXE_plur1bus`).
#![allow(dead_code)]
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

use ext::inspect::{self, Source};
use ext::record;
use ext::stage;
use ext::worker;
use ext::ExtError;
use paths::Layout;
use plur1bus_ext::manifest::Kind;
use plur1bus_ext::pack::PayloadFile;
use plur1bus_ext::testkit::{build_package_from, tamper, test_key, Tamper, TestKey};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, MutexGuard};
use std::time::{Duration, Instant};

// ---- helpers ------------------------------------------------------------------------------------------------------

/// Every test that reads or sets a process environment variable holds this.
static ENV: Mutex<()> = Mutex::new(());

const SEAMS: &[&str] = &[
    "PLUR1BUS_ALLOW_TEST_INTERNALS",
    "PLUR1BUS_TEST_EXT_PUBKEYS",
    "PLUR1BUS_TEST_EXT_REVOCATIONS",
    "PLUR1BUS_TEST_EXT_INSPECT_TTL_MS",
    "PLUR1BUS_TEST_HARNESS_VERSION",
    "PLUR1BUS_CONTAINER",
];

/// Holds the env lock with test internals on and `key` trusted.
fn env_with(key: &TestKey) -> MutexGuard<'static, ()> {
    let g = ENV.lock().unwrap_or_else(|e| e.into_inner());
    for k in SEAMS {
        std::env::remove_var(k);
    }
    std::env::set_var("PLUR1BUS_ALLOW_TEST_INTERNALS", "1");
    std::env::set_var(
        "PLUR1BUS_TEST_EXT_PUBKEYS",
        format!("{}={}", key.label, key.public_b64),
    );
    g
}

fn home() -> (tempfile::TempDir, Layout) {
    let d = tempfile::tempdir().unwrap();
    let l = Layout::new(d.path().join("home"));
    fs::create_dir_all(&l.home).unwrap();
    (d, l)
}

fn f(rel: &str, bytes: &[u8], exec: bool) -> PayloadFile {
    PayloadFile {
        rel: rel.to_string(),
        bytes: bytes.to_vec(),
        exec,
    }
}

fn template(name: &str, kind: &str) -> Value {
    let mut t = json!({
        "$schema": "https://plur1bus.app/schema/p1x/1/p1x.schema.json",
        "format": 1,
        "id": format!("demo/{name}"),
        "name": name,
        "version": "1.0.0",
        "kind": kind,
        "title": { "en": "Demo" },
        "summary": { "en": "A demo." },
        "publisher": { "id": "demo", "name": "Demo" },
        "licence": "MIT",
        "compat": { "harness": ">=0.0.0" },
        "requires": { "runtime": { "type": "none" } },
        "capabilities": {
            "network": { "mode": "none" },
            "filesystem": [],
            "processes": { "spawn": false },
            "harness": { "authority": "none" }
        }
    });
    if kind != "skill" {
        t["compat"]["moduleApi"] = json!(["1"]);
        t["requires"]["runtime"] = json!({ "type": "node", "range": ">=24" });
    }
    t
}

const RUN_SH: &[u8] = b"#!/bin/sh\necho hi\n";

fn skill_md(name: &str) -> Vec<u8> {
    format!("---\nname: {name}\ndescription: A demo.\n---\nbody\n").into_bytes()
}

fn skill_pkg(name: &str, front_name: &str, key: Option<&TestKey>) -> Vec<u8> {
    build_package_from(
        &template(name, "skill"),
        vec![
            f("SKILL.md", &skill_md(front_name), false),
            f("references/a.md", b"a reference", false),
            f("scripts/run.sh", RUN_SH, true),
        ],
        key,
    )
}

fn module_json(name: &str, version: &str, kind: Option<&str>) -> Vec<u8> {
    let mut v = json!({
        "name": name, "version": version, "apiVersion": "1", "entry": "index.js",
        "scope": "installation", "priority": 500
    });
    if let Some(k) = kind {
        v["kind"] = json!(k);
    }
    serde_json::to_vec_pretty(&v).unwrap()
}

fn module_pkg(name: &str, kind: &str, module_json: Vec<u8>, key: Option<&TestKey>) -> Vec<u8> {
    build_package_from(
        &template(name, kind),
        vec![
            f("module.json", &module_json, false),
            f("index.js", b"// fixture\n", false),
        ],
        key,
    )
}

fn write_pkg(dir: &Path, name: &str, bytes: &[u8]) -> PathBuf {
    let p = dir.join(name);
    fs::write(&p, bytes).unwrap();
    p
}

fn id() -> String {
    worker::new_inspection_id()
}

fn sha_hex(b: &[u8]) -> String {
    Sha256::digest(b)
        .iter()
        .map(|x| format!("{x:02x}"))
        .collect()
}

/// A digest of everything under `p`: each entry's relative path, its kind and a regular file's bytes; `absent` when
/// `p` does not exist.
fn tree_hash(p: &Path) -> String {
    fn walk(root: &Path, dir: &Path, out: &mut Vec<String>) {
        let mut entries: Vec<_> = fs::read_dir(dir).unwrap().map(|e| e.unwrap()).collect();
        entries.sort_by_key(|e| e.file_name());
        for e in entries {
            let path = e.path();
            let rel = path
                .strip_prefix(root)
                .unwrap()
                .to_string_lossy()
                .into_owned();
            let t = fs::symlink_metadata(&path).unwrap().file_type();
            if t.is_dir() {
                out.push(format!("d {rel}"));
                walk(root, &path, out);
            } else if t.is_file() {
                out.push(format!("f {rel} {}", sha_hex(&fs::read(&path).unwrap())));
            } else {
                out.push(format!("o {rel}"));
            }
        }
    }
    match fs::symlink_metadata(p) {
        Err(_) => "absent".into(),
        Ok(m) if m.is_file() => format!("file {}", sha_hex(&fs::read(p).unwrap())),
        Ok(_) => {
            let mut out = Vec::new();
            walk(p, p, &mut out);
            out.join("\n")
        }
    }
}

/// `skills/`, `modules/`, `extensions/` and `config.json` (acceptance 2's byte-identity set).
fn guarded(l: &Layout) -> Vec<String> {
    ["skills", "modules", "extensions", "config.json"]
        .iter()
        .map(|n| tree_hash(&l.home.join(n)))
        .collect()
}

/// A home with an installed skill, an installed module and a config, so byte-identity has something to compare.
fn populate(l: &Layout) {
    fs::create_dir_all(l.home.join("skills/other-skill")).unwrap();
    fs::write(
        l.home.join("skills/other-skill/SKILL.md"),
        skill_md("other-skill"),
    )
    .unwrap();
    fs::create_dir_all(l.home.join("modules/other-mod")).unwrap();
    fs::write(
        l.home.join("modules/other-mod/module.json"),
        module_json("other-mod", "0.1.0", None),
    )
    .unwrap();
    fs::write(l.home.join("config.json"), "{\"schemaVersion\":1}\n").unwrap();
}

fn reason(e: &ExtError) -> (&'static str, &'static str) {
    (e.code, e.reason.unwrap_or(""))
}

fn inspect_dir(l: &Layout) -> PathBuf {
    l.run().join("inspect")
}

// ---- inspect ------------------------------------------------------------------------------------------------------

#[test]
fn inspect_writes_only_under_run_inspect() {
    let key = test_key("test");
    let _g = env_with(&key);
    let (d, l) = home();
    populate(&l);
    let before = guarded(&l);
    let pkg = skill_pkg("demo-skill", "demo-skill", Some(&key));
    let path = write_pkg(d.path(), "demo-skill.p1x", &pkg);
    let id = id();
    let rec = inspect::inspect(&l, Source::Path(path.clone()), &id).unwrap();
    assert_eq!(
        guarded(&l),
        before,
        "skills/, modules/, extensions/, config.json unchanged"
    );

    assert_eq!(rec.inspection_id, id);
    assert_eq!(rec.sha256, sha_hex(&pkg));
    assert_eq!(
        rec.source_path.as_deref(),
        Some(path.to_string_lossy().as_ref())
    );
    assert!(!rec.normalised);
    assert_eq!(rec.manifest["id"], "demo/demo-skill");
    assert_eq!(rec.trust["tier"], "first-party");
    assert_eq!(rec.trust["label"], "test");
    assert!(rec.trust["keyId"].is_string());
    assert!(rec
        .checks
        .as_array()
        .unwrap()
        .iter()
        .any(|c| c["id"] == "revocation"));
    assert_eq!(rec.scripts[0]["path"], "payload/scripts/run.sh");
    assert_eq!(rec.scripts[0]["firstLine"], "#!/bin/sh");
    assert_eq!(rec.requires["runtime"]["type"], "none");
    assert!(rec.replaces.is_none() && rec.name_taken_by.is_none());
    assert!(rec.expires_at.ends_with('Z'), "{}", rec.expires_at);

    // What was written: the spooled package (the same bytes) and the record, both private.
    let dir = inspect_dir(&l);
    let mut names: Vec<String> = fs::read_dir(&dir)
        .unwrap()
        .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
        .collect();
    names.sort();
    assert_eq!(names, [format!("{id}.json"), format!("{id}.p1x")]);
    assert_eq!(fs::read(dir.join(format!("{id}.p1x"))).unwrap(), pkg);
    let on_disk: Value =
        serde_json::from_str(&fs::read_to_string(dir.join(format!("{id}.json"))).unwrap()).unwrap();
    assert_eq!(on_disk["inspectionId"], id.as_str());
    assert_eq!(on_disk["sha256"], rec.sha256.as_str());
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        for n in &names {
            let mode = fs::metadata(dir.join(n)).unwrap().permissions().mode() & 0o777;
            assert_eq!(mode, 0o600, "{n}");
        }
    }
    // load() reads it back.
    let back = record::load(&l, &id).unwrap();
    assert_eq!(back.sha256, rec.sha256);
}

#[test]
fn inspect_of_each_tampered_variant_refuses_and_leaves_the_tree_byte_identical() {
    let key = test_key("test");
    let _g = env_with(&key);
    let (d, l) = home();
    populate(&l);
    let before = guarded(&l);
    let good = skill_pkg("demo-skill", "demo-skill", Some(&key));
    let expected = [
        (Tamper::PayloadByte, "digest-mismatch"),
        (Tamper::ExtraEntry, "package-invalid"),
        (Tamper::DotDot, "archive-unsafe-entry"),
        (Tamper::Symlink, "archive-unsafe-entry"),
        (Tamper::CaseCollision, "archive-unsafe-entry"),
        (Tamper::Bomb101, "download-too-large"),
        (Tamper::ForeignId, "signature-invalid"),
        (Tamper::AppendAfterEocd, "archive-unsupported"),
    ];
    for (how, want) in expected {
        let path = write_pkg(
            d.path(),
            &format!("{}.p1x", how.slug()),
            &tamper(&good, how),
        );
        let id = id();
        let e = inspect::inspect(&l, Source::Path(path), &id).unwrap_err();
        assert_eq!(reason(&e), ("E_INVALID_PARAMS", want), "{how:?}: {e}");
        assert_eq!(guarded(&l), before, "{how:?}: the tree changed");
        assert!(
            !inspect_dir(&l).join(format!("{id}.p1x")).exists()
                && !inspect_dir(&l).join(format!("{id}.json")).exists(),
            "{how:?}: a refused inspection leaves no spool or record"
        );
        assert!(record::load(&l, &id).is_err());
    }
}

#[test]
fn a_skill_named_like_an_installed_module_is_name_taken_at_inspect() {
    let key = test_key("test");
    let _g = env_with(&key);
    let (d, l) = home();
    fs::create_dir_all(l.home.join("modules/fixture")).unwrap();
    fs::write(
        l.home.join("modules/fixture/module.json"),
        module_json("fixture", "0.1.0", None),
    )
    .unwrap();
    fs::write(l.home.join("modules/fixture/index.js"), "").unwrap();
    let before = guarded(&l);
    let path = write_pkg(
        d.path(),
        "fixture.p1x",
        &skill_pkg("fixture", "fixture", Some(&key)),
    );
    let id = id();
    let e = inspect::inspect(&l, Source::Path(path), &id).unwrap_err();
    assert_eq!(reason(&e), ("E_CONFLICT", "name-taken"), "{e}");
    assert!(
        e.message.contains("module"),
        "names the installed kind: {e}"
    );
    assert_eq!(e.data["installedKind"], "module");
    assert_eq!(guarded(&l), before);
    assert!(!inspect_dir(&l).join(format!("{id}.p1x")).exists());

    // The other way round: a module named like an installed skill.
    let (d2, l2) = home();
    fs::create_dir_all(l2.home.join("skills/fixture")).unwrap();
    fs::write(l2.home.join("skills/fixture/SKILL.md"), skill_md("fixture")).unwrap();
    let pkg = module_pkg(
        "fixture",
        "module",
        module_json("fixture", "1.0.0", None),
        Some(&key),
    );
    let path = write_pkg(d2.path(), "fixture-mod.p1x", &pkg);
    let before = guarded(&l2);
    let e = inspect::inspect(&l2, Source::Path(path), &self::id()).unwrap_err();
    assert_eq!(reason(&e), ("E_CONFLICT", "name-taken"), "{e}");
    assert!(e.message.contains("skill"), "{e}");
    assert_eq!(guarded(&l2), before);

    // Through a state record: the same id installed as another kind.
    let (d3, l3) = home();
    let mut st = ext::state::ExtState::default();
    st.items.insert(
        "fixture".into(),
        installed_record("demo/fixture", "fixture", "module"),
    );
    ext::state::write(&ext::paths::ExtPaths::of(&l3), &st).unwrap();
    let before = guarded(&l3);
    let path = write_pkg(
        d3.path(),
        "fixture-skill.p1x",
        &skill_pkg("fixture", "fixture", Some(&key)),
    );
    let id = self::id();
    let e = inspect::inspect(&l3, Source::Path(path), &id).unwrap_err();
    assert_eq!(reason(&e), ("E_CONFLICT", "name-taken"), "{e}");
    assert_eq!(e.data["installedKind"], "module");
    assert_eq!(e.data["installedId"], "demo/fixture");
    assert_eq!(guarded(&l3), before);
    assert!(!inspect_dir(&l3).join(format!("{id}.p1x")).exists());
}

fn installed_record(id: &str, name: &str, kind: &str) -> ext::state::ItemRecord {
    ext::state::ItemRecord {
        id: id.into(),
        name: name.into(),
        kind: kind.into(),
        version: "0.9.0".into(),
        source: "file".into(),
        trust: "first-party".into(),
        key_id: None,
        key_label: None,
        package_sha256: "ab".repeat(32),
        installed_at: "2026-09-28T10:00:00.000Z".into(),
        previous_version: None,
        files: Default::default(),
        capabilities: json!({}),
        capabilities_ack: None,
        scripts: vec![],
        required_secrets: vec![],
        removed_by_user: false,
        integrity: None,
    }
}

#[cfg(unix)]
#[test]
fn a_module_whose_socket_path_does_not_fit_is_refused_at_inspect() {
    let key = test_key("test");
    let _g = env_with(&key);
    let d = tempfile::tempdir().unwrap();
    // A home with a space and a non-ASCII letter (Review Focus 4), padded so that `run/module-fixture.sock` is exactly
    // one byte too long for `sun_path`.
    let limit = if cfg!(target_os = "macos") { 104 } else { 108 };
    let base = d.path().join("p1x A").join("Jürgen");
    let suffix = "/run/module-fixture.sock".len();
    let used = base.to_string_lossy().len() + 1; // the '/' before the padding
    assert!(used + suffix < limit, "the temp dir is already too long");
    let pad = "x".repeat(limit - used - suffix);
    let l = Layout::new(base.join(pad));
    fs::create_dir_all(&l.home).unwrap();
    assert_eq!(
        format!("{}/run/module-fixture.sock", l.home.to_string_lossy()).len(),
        limit
    );
    let pkg = module_pkg(
        "fixture",
        "module",
        module_json("fixture", "1.0.0", None),
        Some(&key),
    );
    let path = write_pkg(d.path(), "fixture.p1x", &pkg);
    populate(&l);
    let before = guarded(&l);
    let id = id();
    let e = inspect::inspect(&l, Source::Path(path), &id).unwrap_err();
    assert_eq!(
        reason(&e),
        ("E_INVALID_PARAMS", "socket-path-too-long"),
        "{e}"
    );
    assert_eq!(guarded(&l), before);
    assert!(!inspect_dir(&l).join(format!("{id}.p1x")).exists());

    // A skill has no socket: the same home inspects it.
    let path = write_pkg(
        d.path(),
        "skill.p1x",
        &skill_pkg("fixture", "fixture", Some(&key)),
    );
    inspect::inspect(&l, Source::Path(path), &self::id()).unwrap();
    // One byte shorter fits.
    let short = Layout::new(base.join("x".repeat(limit - used - suffix - 1)));
    fs::create_dir_all(&short.home).unwrap();
    let path = write_pkg(d.path(), "fixture2.p1x", &pkg);
    inspect::inspect(&short, Source::Path(path), &self::id()).unwrap();
}

#[test]
fn unsigned_is_denied_when_allow_unsigned_is_false() {
    let key = test_key("test");
    let _g = env_with(&key);
    let (d, l) = home();
    let unsigned = write_pkg(
        d.path(),
        "u.p1x",
        &skill_pkg("demo-skill", "demo-skill", None),
    );
    let stranger = test_key("stranger");
    let unknown = write_pkg(
        d.path(),
        "k.p1x",
        &skill_pkg("demo-skill", "demo-skill", Some(&stranger)),
    );
    let first = write_pkg(
        d.path(),
        "f.p1x",
        &skill_pkg("demo-skill", "demo-skill", Some(&key)),
    );

    // Default (allowUnsigned: true, and no config at all): unsigned and unknown-signer inspect.
    let r = inspect::inspect(&l, Source::Path(unsigned.clone()), &id()).unwrap();
    assert_eq!(r.trust["tier"], "unsigned");
    let r = inspect::inspect(&l, Source::Path(unknown.clone()), &id()).unwrap();
    assert_eq!(r.trust["tier"], "unknown-signer");

    fs::write(
        l.home.join("config.json"),
        r#"{"schemaVersion":1,"extensions":{"allowUnsigned":false}}"#,
    )
    .unwrap();
    for p in [&unsigned, &unknown] {
        let id = id();
        let e = inspect::inspect(&l, Source::Path(p.clone()), &id).unwrap_err();
        assert_eq!(
            reason(&e),
            ("E_DENIED", "policy-unsigned-disallowed"),
            "{e}"
        );
        assert!(!inspect_dir(&l).join(format!("{id}.p1x")).exists());
    }
    let r = inspect::inspect(&l, Source::Path(first), &id()).unwrap();
    assert_eq!(r.trust["tier"], "first-party");
}

#[test]
fn inspect_honours_the_package_cap_from_config() {
    let key = test_key("test");
    let _g = env_with(&key);
    let (d, l) = home();
    fs::write(
        l.home.join("config.json"),
        r#"{"extensions":{"limits":{"packageBytes":1048576}}}"#,
    )
    .unwrap();
    // Incompressible: SHA-256 blocks of a counter.
    let big: Vec<u8> = (0..35_000u32)
        .flat_map(|i| Sha256::digest(i.to_le_bytes()))
        .collect();
    let pkg = build_package_from(
        &template("demo-skill", "skill"),
        vec![
            f("SKILL.md", &skill_md("demo-skill"), false),
            f("big.bin", &big, false),
        ],
        Some(&key),
    );
    assert!(pkg.len() > 1_048_576);
    let path = write_pkg(d.path(), "big.p1x", &pkg);
    let id = id();
    let e = inspect::inspect(&l, Source::Path(path), &id).unwrap_err();
    assert_eq!(
        reason(&e),
        ("E_INVALID_PARAMS", "download-too-large"),
        "{e}"
    );
    assert!(!inspect_dir(&l).join(format!("{id}.p1x")).exists());
}

#[test]
fn a_skill_folder_is_normalised_into_the_spool() {
    let key = test_key("test");
    let _g = env_with(&key);
    let (d, l) = home();
    let dir = d.path().join("demo-skill");
    fs::create_dir_all(&dir).unwrap();
    fs::write(dir.join("SKILL.md"), skill_md("demo-skill")).unwrap();
    let rec = inspect::inspect(&l, Source::Path(dir), &id()).unwrap();
    assert!(rec.normalised);
    assert_eq!(rec.manifest["id"], "local/demo-skill");
    assert_eq!(rec.trust["tier"], "unsigned");
}

#[test]
fn inspect_fills_replaces_for_an_installed_id() {
    let key = test_key("test");
    let _g = env_with(&key);
    let (d, l) = home();
    let paths = ext::paths::ExtPaths::of(&l);
    let mut st = ext::state::ExtState::default();
    st.items.insert(
        "demo-skill".into(),
        ext::state::ItemRecord {
            id: "demo/demo-skill".into(),
            name: "demo-skill".into(),
            kind: "skill".into(),
            version: "0.9.0".into(),
            source: "file".into(),
            trust: "first-party".into(),
            key_id: None,
            key_label: None,
            package_sha256: "ab".repeat(32),
            installed_at: "2026-09-28T10:00:00.000Z".into(),
            previous_version: None,
            files: Default::default(),
            capabilities: json!({
                "network": { "mode": "any" },
                "filesystem": [],
                "processes": { "spawn": false },
                "harness": { "authority": "none" }
            }),
            capabilities_ack: None,
            scripts: vec![],
            required_secrets: vec![],
            removed_by_user: false,
            integrity: None,
        },
    );
    ext::state::write(&paths, &st).unwrap();
    fs::create_dir_all(l.home.join("skills/demo-skill")).unwrap();
    fs::write(
        l.home.join("skills/demo-skill/SKILL.md"),
        skill_md("demo-skill"),
    )
    .unwrap();
    let path = write_pkg(
        d.path(),
        "s.p1x",
        &skill_pkg("demo-skill", "demo-skill", Some(&key)),
    );
    let rec = inspect::inspect(&l, Source::Path(path), &id()).unwrap();
    let r = rec.replaces.expect("replaces");
    assert_eq!(r["version"], "0.9.0");
    assert_eq!(r["capabilityDiff"]["changed"], json!(["network"]));

    // The same name with another id is taken.
    st.items.get_mut("demo-skill").unwrap().id = "other/demo-skill".into();
    ext::state::write(&paths, &st).unwrap();
    let path = write_pkg(
        d.path(),
        "s2.p1x",
        &skill_pkg("demo-skill", "demo-skill", Some(&key)),
    );
    let e = inspect::inspect(&l, Source::Path(path), &id()).unwrap_err();
    assert_eq!(reason(&e), ("E_CONFLICT", "name-taken"), "{e}");
}

#[test]
fn an_expired_inspection_is_inspection_expired() {
    let key = test_key("test");
    let _g = env_with(&key);
    std::env::set_var("PLUR1BUS_TEST_EXT_INSPECT_TTL_MS", "1");
    let (d, l) = home();
    let path = write_pkg(
        d.path(),
        "s.p1x",
        &skill_pkg("demo-skill", "demo-skill", Some(&key)),
    );
    let id = id();
    inspect::inspect(&l, Source::Path(path.clone()), &id).unwrap();
    std::thread::sleep(Duration::from_millis(20));
    let e = record::load(&l, &id).unwrap_err();
    assert_eq!(reason(&e), ("E_NOT_FOUND", "inspection-expired"), "{e}");
    let e = stage::stage(&l, &id).unwrap_err();
    assert_eq!(reason(&e), ("E_NOT_FOUND", "inspection-expired"), "{e}");
    // A missing or malformed id is the same answer.
    let e = record::load(&l, "no-such-id").unwrap_err();
    assert_eq!(reason(&e), ("E_NOT_FOUND", "inspection-expired"), "{e}");
    let e = record::load(&l, "../../etc/passwd").unwrap_err();
    assert_eq!(reason(&e), ("E_NOT_FOUND", "inspection-expired"), "{e}");
    // prune removes the expired pair.
    record::prune(&l);
    assert!(fs::read_dir(inspect_dir(&l)).unwrap().next().is_none());
    // A fresh inspection prunes the old ones first.
    std::env::remove_var("PLUR1BUS_TEST_EXT_INSPECT_TTL_MS");
    let _ = inspect::inspect(&l, Source::Path(path), &self::id()).unwrap();
}

// ---- stage --------------------------------------------------------------------------------------------------------

#[test]
fn stage_rehashes_the_spooled_package() {
    let key = test_key("test");
    let _g = env_with(&key);
    let (d, l) = home();
    populate(&l);
    let path = write_pkg(
        d.path(),
        "s.p1x",
        &skill_pkg("demo-skill", "demo-skill", Some(&key)),
    );
    let id = id();
    inspect::inspect(&l, Source::Path(path), &id).unwrap();
    let before = guarded(&l);
    let spool = inspect_dir(&l).join(format!("{id}.p1x"));
    let mut bytes = fs::read(&spool).unwrap();
    let n = bytes.len() / 2;
    bytes[n] ^= 0x01;
    fs::write(&spool, bytes).unwrap();
    let e = stage::stage(&l, &id).unwrap_err();
    assert_eq!(reason(&e), ("E_INVALID_PARAMS", "digest-mismatch"), "{e}");
    assert_eq!(guarded(&l), before, "nothing extracted");
}

#[test]
fn stage_extracts_a_skill_and_builds_its_record() {
    let key = test_key("test");
    let _g = env_with(&key);
    let (d, l) = home();
    let pkg = skill_pkg("demo-skill", "demo-skill", Some(&key));
    let path = write_pkg(d.path(), "s.p1x", &pkg);
    let id = id();
    inspect::inspect(&l, Source::Path(path), &id).unwrap();
    let s = stage::stage(&l, &id).unwrap();
    assert_eq!(s.name, "demo-skill");
    assert_eq!(s.kind, Kind::Skill);
    assert_eq!(
        s.dir,
        l.extensions()
            .join("staging")
            .join(format!("demo-skill-{id}"))
            .join("payload")
    );
    assert!(s.dir.join("SKILL.md").is_file() && s.dir.join("scripts/run.sh").is_file());
    assert_eq!(s.package, inspect_dir(&l).join(format!("{id}.p1x")));
    let r = &s.record;
    assert_eq!(
        (
            r.id.as_str(),
            r.name.as_str(),
            r.kind.as_str(),
            r.version.as_str()
        ),
        ("demo/demo-skill", "demo-skill", "skill", "1.0.0")
    );
    assert_eq!(
        (r.source.as_str(), r.trust.as_str()),
        ("file", "first-party")
    );
    assert!(r.key_id.is_some());
    assert_eq!(r.package_sha256, sha_hex(&pkg));
    assert_eq!(r.scripts, ["scripts/run.sh"]);
    let keys: Vec<&str> = r.files.keys().map(String::as_str).collect();
    assert_eq!(
        keys,
        ["SKILL.md", "references/a.md", "scripts/run.sh"],
        "payload-relative"
    );
    assert!(r.files["scripts/run.sh"].exec);
    assert!(r.required_secrets.is_empty() && !r.removed_by_user && r.previous_version.is_none());
    // The staged item round-trips through JSON (the worker prints it, the supervisor reads it).
    let v = serde_json::to_value(&s).unwrap();
    let back: stage::StagedItem = serde_json::from_value(v).unwrap();
    assert_eq!(back.record, s.record);
}

#[test]
fn stage_refuses_a_module_json_whose_kind_or_version_disagrees() {
    let key = test_key("test");
    let _g = env_with(&key);
    let (d, l) = home();
    let cases: [(&str, Vec<u8>, bool); 6] = [
        ("module", module_json("fixture", "1.0.0", None), true),
        (
            "module",
            module_json("fixture", "1.0.0", Some("module")),
            true,
        ),
        (
            "channel",
            module_json("fixture", "1.0.0", Some("channel")),
            true,
        ),
        ("module", module_json("fixture", "0.9.0", None), false),
        (
            "module",
            module_json("fixture", "1.0.0", Some("channel")),
            false,
        ),
        ("channel", module_json("fixture", "1.0.0", None), false),
    ];
    for (i, (kind, mj, ok)) in cases.into_iter().enumerate() {
        let path = write_pkg(
            d.path(),
            &format!("m{i}.p1x"),
            &module_pkg("fixture", kind, mj, Some(&key)),
        );
        let id = id();
        inspect::inspect(&l, Source::Path(path), &id).unwrap();
        match stage::stage(&l, &id) {
            Ok(s) if ok => {
                assert!(s.dir.join("module.json").is_file());
                assert_eq!(s.record.kind, kind);
                fs::remove_dir_all(s.dir.parent().unwrap()).unwrap();
            }
            Ok(_) => panic!("case {i}: staged"),
            Err(e) if !ok => {
                assert_eq!(
                    reason(&e),
                    ("E_INVALID_PARAMS", "package-invalid"),
                    "case {i}: {e}"
                )
            }
            Err(e) => panic!("case {i}: {e}"),
        }
    }
    // Another name in module.json, and a missing entry file.
    let path = write_pkg(
        d.path(),
        "n.p1x",
        &module_pkg(
            "fixture",
            "module",
            module_json("fixture-b", "1.0.0", None),
            Some(&key),
        ),
    );
    let id = id();
    inspect::inspect(&l, Source::Path(path), &id).unwrap();
    let e = stage::stage(&l, &id).unwrap_err();
    assert_eq!(reason(&e), ("E_INVALID_PARAMS", "package-invalid"), "{e}");
    let pkg = build_package_from(
        &template("fixture", "module"),
        vec![f(
            "module.json",
            &module_json("fixture", "1.0.0", None),
            false,
        )],
        Some(&key),
    );
    let path = write_pkg(d.path(), "e.p1x", &pkg);
    let id = self::id();
    inspect::inspect(&l, Source::Path(path), &id).unwrap();
    let e = stage::stage(&l, &id).unwrap_err();
    assert_eq!(reason(&e), ("E_INVALID_PARAMS", "package-invalid"), "{e}");
    assert!(e.message.contains("entry"), "{e}");
}

#[test]
fn stage_refuses_a_skill_whose_frontmatter_name_differs() {
    let key = test_key("test");
    let _g = env_with(&key);
    let (d, l) = home();
    let path = write_pkg(
        d.path(),
        "s.p1x",
        &skill_pkg("demo-skill", "demo-scripts", Some(&key)),
    );
    let id = id();
    inspect::inspect(&l, Source::Path(path), &id).unwrap();
    let e = stage::stage(&l, &id).unwrap_err();
    assert_eq!(reason(&e), ("E_INVALID_PARAMS", "package-invalid"), "{e}");
    assert!(e.message.contains("demo-scripts"), "{e}");
}

#[cfg(unix)]
#[test]
fn stage_sets_exec_modes_from_files() {
    use std::os::unix::fs::PermissionsExt;
    let key = test_key("test");
    let _g = env_with(&key);
    let (d, l) = home();
    let path = write_pkg(
        d.path(),
        "s.p1x",
        &skill_pkg("demo-skill", "demo-skill", Some(&key)),
    );
    let id = id();
    inspect::inspect(&l, Source::Path(path), &id).unwrap();
    let s = stage::stage(&l, &id).unwrap();
    let mode = |rel: &str| fs::metadata(s.dir.join(rel)).unwrap().permissions().mode() & 0o7777;
    assert_eq!(mode("scripts/run.sh"), 0o755);
    assert_eq!(mode("SKILL.md"), 0o644);
    assert_eq!(mode("references/a.md"), 0o644);
}

#[test]
fn a_refused_stage_removes_its_staging_directory() {
    let key = test_key("test");
    let _g = env_with(&key);
    let (d, l) = home();
    populate(&l);
    let before = guarded(&l);
    assert_eq!(tree_hash(&l.extensions()), "absent");
    let path = write_pkg(
        d.path(),
        "s.p1x",
        &skill_pkg("demo-skill", "demo-scripts", Some(&key)),
    );
    let id = id();
    inspect::inspect(&l, Source::Path(path), &id).unwrap();
    stage::stage(&l, &id).unwrap_err();
    assert_eq!(guarded(&l), before, "extensions/ is absent again");

    // Another staging directory already there stays; only this stage's own is removed.
    let other = l.extensions().join("staging").join("other-x");
    fs::create_dir_all(&other).unwrap();
    let before = guarded(&l);
    let path = write_pkg(
        d.path(),
        "s2.p1x",
        &skill_pkg("demo-skill", "demo-scripts", Some(&key)),
    );
    let id = self::id();
    inspect::inspect(&l, Source::Path(path), &id).unwrap();
    stage::stage(&l, &id).unwrap_err();
    assert_eq!(guarded(&l), before);
    assert!(other.is_dir());
}

#[test]
fn a_restage_replaces_a_leftover_of_the_same_inspection() {
    let key = test_key("test");
    let _g = env_with(&key);
    let (d, l) = home();
    let path = write_pkg(
        d.path(),
        "s.p1x",
        &skill_pkg("demo-skill", "demo-skill", Some(&key)),
    );
    let id = id();
    inspect::inspect(&l, Source::Path(path), &id).unwrap();
    let dest = l
        .extensions()
        .join("staging")
        .join(format!("demo-skill-{id}"));
    // A killed earlier stage left a partial tree.
    fs::create_dir_all(dest.join("payload")).unwrap();
    fs::write(dest.join("payload/junk.txt"), "left over").unwrap();
    let s = stage::stage(&l, &id).unwrap();
    assert!(s.dir.join("SKILL.md").is_file());
    assert!(!s.dir.join("junk.txt").exists(), "never merged into");
    // Staging again (a retried call) replaces the previous result, and a leftover file is replaced too.
    let s = stage::stage(&l, &id).unwrap();
    assert!(s.dir.join("SKILL.md").is_file());
    fs::remove_dir_all(&dest).unwrap();
    fs::write(&dest, "not a directory").unwrap();
    let s = stage::stage(&l, &id).unwrap();
    assert!(s.dir.join("SKILL.md").is_file());
}

// ---- the worker process -------------------------------------------------------------------------------------------

fn bin() -> &'static str {
    env!("CARGO_BIN_EXE_plur1bus")
}

fn run_worker(l: &Layout, args: &[&str]) -> (i32, String) {
    let out = std::process::Command::new(bin())
        .args(["ext", "__worker"])
        .args(args)
        .arg("--home")
        .arg(&l.home)
        .stdin(std::process::Stdio::null())
        .output()
        .unwrap();
    (
        out.status.code().unwrap_or(-1),
        String::from_utf8(out.stdout).unwrap(),
    )
}

fn one_line(stdout: &str) -> Value {
    let lines: Vec<&str> = stdout.lines().collect();
    assert_eq!(lines.len(), 1, "exactly one line: {stdout:?}");
    serde_json::from_str(lines[0]).unwrap()
}

#[test]
fn worker_prints_one_json_line_and_exits_nonzero_on_refusal() {
    let key = test_key("test");
    let _g = env_with(&key);
    let (d, l) = home();
    let good = skill_pkg("demo-skill", "demo-skill", Some(&key));
    let bad = write_pkg(d.path(), "bad.p1x", &tamper(&good, Tamper::PayloadByte));
    let id = id();
    let (code, out) = run_worker(
        &l,
        &["inspect", "--id", &id, "--path", bad.to_str().unwrap()],
    );
    assert_ne!(code, 0);
    let v = one_line(&out);
    assert_eq!(v["ok"], false);
    assert_eq!(v["error"]["code"], "E_INVALID_PARAMS");
    assert_eq!(v["error"]["reason"], "digest-mismatch");
    assert!(v["error"]["message"].is_string());
    assert!(v["error"].get("data").is_some());

    let path = write_pkg(d.path(), "good.p1x", &good);
    let (code, out) = run_worker(
        &l,
        &["inspect", "--id", &id, "--path", path.to_str().unwrap()],
    );
    assert_eq!(code, 0, "{out}");
    let v = one_line(&out);
    assert_eq!(v["ok"], true);
    assert_eq!(v["result"]["inspectionId"], id.as_str());

    let (code, out) = run_worker(&l, &["stage", "--id", &id]);
    assert_eq!(code, 0, "{out}");
    let v = one_line(&out);
    assert_eq!(v["result"]["name"], "demo-skill");
    assert_eq!(v["result"]["kind"], "skill");

    // Stdin is spooled like a file.
    let id2 = self::id();
    let mut child = std::process::Command::new(bin())
        .args([
            "ext", "__worker", "inspect", "--id", &id2, "--stdin", "--home",
        ])
        .arg(&l.home)
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .spawn()
        .unwrap();
    use std::io::Write;
    child.stdin.take().unwrap().write_all(&good).unwrap();
    let out = child.wait_with_output().unwrap();
    assert!(out.status.success());
    let v = one_line(&String::from_utf8(out.stdout).unwrap());
    assert_eq!(v["result"]["sha256"], sha_hex(&good));
    assert_eq!(v["result"]["sourcePath"], Value::Null);

    // spawn_worker reads the same line.
    let v = worker::spawn_worker_with(
        Path::new(bin()),
        &l,
        &["stage", "--id", &id2],
        Duration::from_secs(60),
    )
    .unwrap();
    assert_eq!(v["name"], "demo-skill");
    let e = worker::spawn_worker_with(
        Path::new(bin()),
        &l,
        &[
            "inspect",
            "--id",
            &self::id(),
            "--path",
            bad.to_str().unwrap(),
        ],
        Duration::from_secs(60),
    )
    .unwrap_err();
    assert_eq!(reason(&e), ("E_INVALID_PARAMS", "digest-mismatch"), "{e}");
}

#[test]
fn worker_is_killed_after_its_deadline() {
    let key = test_key("test");
    let _g = env_with(&key);
    let (d, l) = home();
    let path = write_pkg(
        d.path(),
        "s.p1x",
        &skill_pkg("demo-skill", "demo-skill", Some(&key)),
    );
    let id = id();
    let t = Instant::now();
    let e = worker::spawn_worker_with(
        Path::new(bin()),
        &l,
        &[
            "inspect",
            "--id",
            &id,
            "--path",
            path.to_str().unwrap(),
            "--sleep-ms",
            "20000",
        ],
        Duration::from_millis(500),
    )
    .unwrap_err();
    assert_eq!(reason(&e), ("E_INTERNAL", "worker-failed"), "{e}");
    assert!(t.elapsed() < Duration::from_secs(10), "{:?}", t.elapsed());
    assert!(!inspect_dir(&l).join(format!("{id}.json")).exists());

    // Without test internals the sleep is ignored and the worker answers.
    std::env::remove_var("PLUR1BUS_ALLOW_TEST_INTERNALS");
    std::env::remove_var("PLUR1BUS_TEST_EXT_PUBKEYS");
    let v = worker::spawn_worker_with(
        Path::new(bin()),
        &l,
        &[
            "inspect",
            "--id",
            &self::id(),
            "--path",
            path.to_str().unwrap(),
            "--sleep-ms",
            "20000",
        ],
        Duration::from_secs(10),
    )
    .unwrap();
    assert_eq!(v["trust"]["tier"], "unknown-signer");
}

#[test]
fn the_worker_runs_under_a_home_with_a_space_and_non_ascii() {
    let key = test_key("test");
    let _g = env_with(&key);
    let d = tempfile::tempdir().unwrap();
    let l = Layout::new(d.path().join("p1x A").join("Jürgen"));
    fs::create_dir_all(&l.home).unwrap();
    let pkg = module_pkg(
        "fixture",
        "module",
        module_json("fixture", "1.0.0", None),
        Some(&key),
    );
    let path = write_pkg(d.path(), "fixture.p1x", &pkg);
    let id = id();
    let v = worker::spawn_worker_with(
        Path::new(bin()),
        &l,
        &["inspect", "--id", &id, "--path", path.to_str().unwrap()],
        Duration::from_secs(60),
    )
    .unwrap();
    assert_eq!(v["inspectionId"], id.as_str());
    let v = worker::spawn_worker_with(
        Path::new(bin()),
        &l,
        &["stage", "--id", &id],
        Duration::from_secs(60),
    )
    .unwrap();
    assert_eq!(v["name"], "fixture");
    let dir = PathBuf::from(v["dir"].as_str().unwrap());
    assert!(dir.starts_with(&l.home) && dir.join("module.json").is_file());
}
