//! The commit half of extensions from file (X1 Task 7; spec §6.1, §6.2, §8.3, §9.2; X1-R12, R14, R15, R16, R18, R19,
//! R29, R32; Review Focus 1, 3, 5; acceptance 1, 2, 6): install with per-step rollback through the offline
//! `ModuleHost`, acknowledgments, list and show, and `ext::recover`.
//!
//! The binary crate has no library target, so the modules the ext layer depends on are included by path (as in
//! `ext_stage.rs`).
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

use ext::commit::{install_commit, Agents, InstallOpts, ModuleHost, OfflineHost, COMMIT_STEPS};
use ext::inspect::{self, InspectionRecord, Source};
use ext::list::{list_items, show_item, ListFilter};
use ext::stage::{self, StagedItem};
use ext::{index, state, worker, ExtError};
use paths::Layout;
use plur1bus_ext::pack::PayloadFile;
use plur1bus_ext::testkit::{build_package_from, test_key, TestKey};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, MutexGuard};

// ---- helpers ------------------------------------------------------------------------------------------------------

/// Every test holds this: the seams are process environment variables and the ext mutex is process-wide (X1-R15).
static ENV: Mutex<()> = Mutex::new(());

const SEAMS: &[&str] = &[
    "PLUR1BUS_ALLOW_TEST_INTERNALS",
    "PLUR1BUS_TEST_EXT_PUBKEYS",
    "PLUR1BUS_TEST_EXT_REVOCATIONS",
    "PLUR1BUS_TEST_EXT_INSPECT_TTL_MS",
    "PLUR1BUS_TEST_EXT_FAIL_AT",
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

fn template(name: &str, kind: &str, version: &str) -> Value {
    let mut t = json!({
        "$schema": "https://plur1bus.app/schema/p1x/1/p1x.schema.json",
        "format": 1,
        "id": format!("demo/{name}"),
        "name": name,
        "version": version,
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

fn skill_pkg_v(name: &str, version: &str, key: Option<&TestKey>) -> Vec<u8> {
    build_package_from(
        &template(name, "skill", version),
        vec![
            f("SKILL.md", &skill_md(name), false),
            f(
                "references/a.md",
                format!("a reference for {version}").as_bytes(),
                false,
            ),
            f("scripts/run.sh", RUN_SH, true),
        ],
        key,
    )
}

fn skill_pkg(name: &str, key: Option<&TestKey>) -> Vec<u8> {
    skill_pkg_v(name, "1.0.0", key)
}

fn module_json(name: &str, version: &str) -> Vec<u8> {
    serde_json::to_vec_pretty(&json!({
        "name": name, "version": version, "apiVersion": "1", "entry": "index.js",
        "scope": "installation", "priority": 500
    }))
    .unwrap()
}

fn module_pkg_v(name: &str, version: &str, key: Option<&TestKey>) -> Vec<u8> {
    build_package_from(
        &template(name, "module", version),
        vec![
            f("module.json", &module_json(name, version), false),
            f(
                "index.js",
                format!("// fixture {version}\n").as_bytes(),
                false,
            ),
        ],
        key,
    )
}

fn module_pkg(name: &str, key: Option<&TestKey>) -> Vec<u8> {
    module_pkg_v(name, "1.0.0", key)
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
            format!("dir\n{}", out.join("\n"))
        }
    }
}

/// `skills/`, `modules/`, `extensions/`, `config.json` (acceptance 2's byte-identity set) and `data/`.
fn guarded(l: &Layout) -> Vec<String> {
    ["skills", "modules", "extensions", "config.json", "data"]
        .iter()
        .map(|n| format!("{n}: {}", tree_hash(&l.home.join(n))))
        .collect()
}

/// Writes config.json the way the config service does (defaults filled, serialised by `plur1bus_config`), with
/// `edit` applied first, so a rewrite of an unchanged configuration is byte-identical.
fn write_config(l: &Layout, edit: impl FnOnce(&mut Value)) {
    let mut c = plur1bus_config::defaults();
    edit(&mut c);
    plur1bus_config::validate(&c).unwrap();
    plur1bus_config::write_atomic(&l.config_path(), &c).unwrap();
}

fn config(l: &Layout) -> Value {
    serde_json::from_str(&fs::read_to_string(l.config_path()).unwrap()).unwrap()
}

/// A home with an unrelated skill, module and config, so byte-identity has something to compare.
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
        module_json("other-mod", "0.1.0"),
    )
    .unwrap();
    fs::write(l.home.join("modules/other-mod/index.js"), "//\n").unwrap();
    write_config(l, |_| {});
}

fn reason(e: &ExtError) -> (&'static str, &'static str) {
    (e.code, e.reason.unwrap_or(""))
}

/// Inspects and stages `bytes` (written next to the home as `file`).
fn prepare(d: &Path, l: &Layout, file: &str, bytes: &[u8]) -> (InspectionRecord, StagedItem) {
    let p = d.join(file);
    fs::write(&p, bytes).unwrap();
    let id = worker::new_inspection_id();
    let rec = inspect::inspect(l, Source::Path(p), &id).unwrap();
    let staged = stage::stage(l, &id).unwrap();
    (rec, staged)
}

fn opts(ack: &[&str], enable: Option<Agents>) -> InstallOpts {
    InstallOpts {
        acknowledge: ack.iter().map(|s| s.to_string()).collect(),
        enable,
    }
}

fn install(
    d: &Path,
    l: &Layout,
    file: &str,
    bytes: &[u8],
    o: &InstallOpts,
) -> Result<Value, ExtError> {
    let (rec, staged) = prepare(d, l, file, bytes);
    let mut host = OfflineHost::new(l);
    install_commit(l, &mut host, &rec, staged, o)
}

fn staging_empty(l: &Layout) -> bool {
    let s = l.extensions().join("staging");
    !s.exists() || fs::read_dir(&s).unwrap().next().is_none()
}

fn audit_lines(l: &Layout) -> Vec<Value> {
    fs::read_to_string(l.audit_log())
        .unwrap_or_default()
        .lines()
        .map(|x| serde_json::from_str(x).unwrap())
        .collect()
}

fn item<'a>(list: &'a Value, name: &str) -> &'a Value {
    list["items"]
        .as_array()
        .unwrap()
        .iter()
        .find(|i| i["name"] == name)
        .unwrap_or_else(|| panic!("{name} not listed: {list}"))
}

/// A validator for one `$defs` entry of the RPC schema (Task 10's `ExtItem`, `ExtDetail`).
fn rpc_def(def: &str) -> jsonschema::Validator {
    let text = fs::read_to_string(
        Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../../packages/rpc-schema/schema/rpc.schema.json"),
    )
    .unwrap();
    let full: Value = serde_json::from_str(&text).unwrap();
    let schema = json!({ "$defs": full["$defs"], "$ref": format!("#/$defs/{def}") });
    jsonschema::options()
        .with_draft(jsonschema::Draft::Draft202012)
        .build(&schema)
        .unwrap()
}

fn assert_valid(v: &jsonschema::Validator, x: &Value) {
    let errs: Vec<String> = v.iter_errors(x).map(|e| e.to_string()).collect();
    assert!(errs.is_empty(), "{errs:?} in {x}");
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

// ---- install --------------------------------------------------------------------------------------------------------

#[test]
fn a_signed_skill_installs_disabled_with_index_state_and_cache() {
    let key = test_key("test");
    let _g = env_with(&key);
    let (d, l) = home();
    populate(&l);
    let pkg = skill_pkg("demo-skill", Some(&key));
    let (rec, staged) = prepare(d.path(), &l, "s.p1x", &pkg);
    let files = staged.record.files.clone();
    let mut host = OfflineHost::new(&l);
    let v = install_commit(&l, &mut host, &rec, staged, &opts(&[], None)).unwrap();
    assert_eq!(
        v,
        json!({"name": "demo-skill", "version": "1.0.0", "kind": "skill", "replaced": false, "state": "installed"})
    );

    // Code in place, staging and the consumed inspection gone.
    let dir = l.skills().join("demo-skill");
    assert!(dir.join("SKILL.md").is_file() && dir.join("scripts/run.sh").is_file());
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mode = fs::metadata(dir.join("scripts/run.sh"))
            .unwrap()
            .permissions()
            .mode();
        assert_eq!(mode & 0o777, 0o755);
    }
    assert!(staging_empty(&l));
    assert!(!l
        .run()
        .join("inspect")
        .join(format!("{}.json", rec.inspection_id))
        .exists());

    // The index entry passes the importer's reader rules (the same refusals, the same key order), disabled.
    let idx = index::read_index(&l).unwrap();
    let e = idx.entry("demo-skill").unwrap();
    assert_eq!(e["source"], "file");
    assert_eq!(e["enabled"], false);
    assert_eq!(
        e["sourcePath"],
        d.path().join("s.p1x").to_string_lossy().as_ref()
    );
    let pairs: Vec<(String, String)> = files
        .iter()
        .map(|(k, v)| (k.clone(), v.sha256.clone()))
        .collect();
    assert_eq!(
        e["sha256"],
        plur1bus_ext::folder_hash::skill_folder_hash(&pairs)
    );
    assert_eq!(
        e["package"],
        json!({"id": "demo/demo-skill", "version": "1.0.0", "trust": "first-party"})
    );
    let at = e["importedAt"].as_str().unwrap();
    assert!(at.len() == 24 && at.ends_with('Z'), "{at}");
    let text = fs::read_to_string(l.skills().join("index.json")).unwrap();
    assert!(
        text.contains("\"id\": \"demo-skill\",\n      \"source\": \"file\",\n      \"sourcePath\""),
        "{text}"
    );
    assert!(text.ends_with("}\n"));

    // The state record, the cache and the data directory.
    let st = state::read(&ext::paths::ExtPaths::of(&l)).unwrap();
    let r = &st.items["demo-skill"];
    assert_eq!(
        (r.trust.as_str(), r.kind.as_str(), r.source.as_str()),
        ("first-party", "skill", "file")
    );
    assert!(r.key_id.is_some());
    assert_eq!(r.package_sha256, sha_hex(&pkg));
    assert_eq!(
        fs::read(
            l.extensions()
                .join("cache")
                .join(format!("{}.p1x", sha_hex(&pkg)))
        )
        .unwrap(),
        pkg
    );
    assert!(l.ext_data("demo-skill").is_dir());
    assert_eq!(host.notified.len(), 1);
    assert_eq!(host.notified[0]["name"], "demo-skill");

    // Listed installed, not enabled, for no agent.
    let list = list_items(&l, &config(&l), &ListFilter::default());
    let it = item(&list, "demo-skill");
    assert_eq!(it["state"], "installed");
    assert_eq!(it["enabled"], false);
    assert_eq!(it["agents"], json!([]));
    assert_eq!(it["trust"], "first-party");
    assert_eq!(it["source"], "file");
    let v = rpc_def("ExtItem");
    for i in list["items"].as_array().unwrap() {
        assert_valid(&v, i);
    }
}

#[test]
fn a_module_package_installs_disabled_and_config_says_so() {
    let key = test_key("test");
    let _g = env_with(&key);
    let (d, l) = home();
    populate(&l);
    let v = install(
        d.path(),
        &l,
        "m.p1x",
        &module_pkg("fixture", Some(&key)),
        &opts(&[], None),
    )
    .unwrap();
    assert_eq!(v["kind"], "module");
    assert_eq!(v["state"], "installed");
    assert_eq!(v["replaced"], false);
    assert!(l.modules_dir().join("fixture/module.json").is_file());
    assert!(l.modules_dir().join("fixture/index.js").is_file());
    assert_eq!(config(&l)["modules"]["fixture"]["enabled"], false);
    assert!(
        !l.skills().join("index.json").exists(),
        "no index for a module"
    );
    let st = state::read(&ext::paths::ExtPaths::of(&l)).unwrap();
    assert_eq!(st.items["fixture"].kind, "module");
    assert!(staging_empty(&l));
    let left: Vec<String> = fs::read_dir(l.modules_dir())
        .unwrap()
        .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
        .collect();
    assert!(left.iter().all(|n| !n.contains(".tmp-")), "{left:?}");

    let list = list_items(&l, &config(&l), &ListFilter::default());
    let it = item(&list, "fixture");
    assert_eq!(
        (&it["kind"], &it["state"], &it["enabled"], &it["agents"]),
        (
            &json!("module"),
            &json!("installed"),
            &json!(false),
            &json!("all")
        )
    );
    // The unrelated local module lists as a dev module, enabled.
    let other = item(&list, "other-mod");
    assert_eq!(
        (&other["trust"], &other["enabled"]),
        (&json!("dev"), &json!(true))
    );
}

#[test]
fn unsigned_needs_acknowledge_unsigned_and_unknown_signer_needs_its_own() {
    let key = test_key("test");
    let other = test_key("other");
    let _g = env_with(&key);
    let (d, l) = home();
    populate(&l);
    let before = guarded(&l);

    let unsigned = skill_pkg("demo-skill", None);
    let (rec, staged) = prepare(d.path(), &l, "u.p1x", &unsigned);
    let e = install_commit(
        &l,
        &mut OfflineHost::new(&l),
        &rec,
        staged,
        &opts(&[], None),
    )
    .unwrap_err();
    assert_eq!(reason(&e), ("E_APPROVAL_REQUIRED", "acknowledge-unsigned"));
    assert_eq!(e.data["inspectionId"], rec.inspection_id.as_str());
    assert_eq!(guarded(&l), before, "a refusal writes nothing");
    // The same inspection stages again and installs with the acknowledgment.
    let staged = stage::stage(&l, &rec.inspection_id).unwrap();
    install_commit(
        &l,
        &mut OfflineHost::new(&l),
        &rec,
        staged,
        &opts(&["unsigned"], None),
    )
    .unwrap();

    let foreign = skill_pkg("demo-other", Some(&other));
    let before = guarded(&l);
    let (rec, staged) = prepare(d.path(), &l, "o.p1x", &foreign);
    assert_eq!(rec.trust["tier"], "unknown-signer");
    let e = install_commit(
        &l,
        &mut OfflineHost::new(&l),
        &rec,
        staged,
        &opts(&["unsigned"], None),
    )
    .unwrap_err();
    assert_eq!(
        reason(&e),
        ("E_APPROVAL_REQUIRED", "acknowledge-unknown-signer")
    );
    assert_eq!(guarded(&l), before);
    let staged = stage::stage(&l, &rec.inspection_id).unwrap();
    install_commit(
        &l,
        &mut OfflineHost::new(&l),
        &rec,
        staged,
        &opts(&["unknown-signer"], None),
    )
    .unwrap();
    let st = state::read(&ext::paths::ExtPaths::of(&l)).unwrap();
    assert_eq!(st.items["demo-skill"].trust, "unsigned");
    assert_eq!(st.items["demo-other"].trust, "unknown-signer");
}

#[test]
fn install_and_enable_needs_acknowledge_capabilities() {
    let key = test_key("test");
    let _g = env_with(&key);
    let (d, l) = home();
    populate(&l);
    let before = guarded(&l);
    let pkg = skill_pkg("demo-skill", Some(&key));
    let (rec, staged) = prepare(d.path(), &l, "s.p1x", &pkg);
    let e = install_commit(
        &l,
        &mut OfflineHost::new(&l),
        &rec,
        staged,
        &opts(&[], Some(Agents::All)),
    )
    .unwrap_err();
    assert_eq!(
        reason(&e),
        ("E_APPROVAL_REQUIRED", "acknowledge-capabilities")
    );
    assert!(e.data["capabilities"].is_object());
    assert_eq!(guarded(&l), before);

    let staged = stage::stage(&l, &rec.inspection_id).unwrap();
    let v = install_commit(
        &l,
        &mut OfflineHost::new(&l),
        &rec,
        staged,
        &opts(&["capabilities"], Some(Agents::All)),
    )
    .unwrap();
    assert_eq!(v["state"], "enabled");
    assert_eq!(
        index::read_index(&l).unwrap().entry("demo-skill").unwrap()["enabled"],
        true
    );
    let st = state::read(&ext::paths::ExtPaths::of(&l)).unwrap();
    assert!(st.items["demo-skill"].capabilities_ack.is_some());

    // A module: `modules.<name>.enabled` ends true.
    let v = install(
        d.path(),
        &l,
        "m.p1x",
        &module_pkg("fixture", Some(&key)),
        &opts(&["capabilities"], Some(Agents::All)),
    )
    .unwrap();
    assert_eq!(v["state"], "enabled");
    assert_eq!(config(&l)["modules"]["fixture"]["enabled"], true);
    // Agents on a module are refused before anything is written.
    let before = guarded(&l);
    let e = install(
        d.path(),
        &l,
        "m2.p1x",
        &module_pkg("fixture-b", Some(&key)),
        &opts(&["capabilities"], Some(Agents::Some(vec!["bernd".into()]))),
    )
    .unwrap_err();
    assert_eq!(reason(&e), ("E_INVALID_PARAMS", "agents-not-supported"));
    assert_eq!(guarded(&l), before);
}

#[test]
fn a_lower_version_needs_acknowledge_downgrade_and_replaces_into_the_trash() {
    let key = test_key("test");
    let _g = env_with(&key);
    let (d, l) = home();
    populate(&l);
    let v2 = skill_pkg_v("demo-skill", "2.0.0", Some(&key));
    install(d.path(), &l, "v2.p1x", &v2, &opts(&[], None)).unwrap();
    let before = guarded(&l);

    let v1 = skill_pkg_v("demo-skill", "1.0.0", Some(&key));
    let (rec, staged) = prepare(d.path(), &l, "v1.p1x", &v1);
    assert_eq!(rec.replaces.as_ref().unwrap()["version"], "2.0.0");
    let e = install_commit(
        &l,
        &mut OfflineHost::new(&l),
        &rec,
        staged,
        &opts(&[], None),
    )
    .unwrap_err();
    assert_eq!(reason(&e), ("E_APPROVAL_REQUIRED", "acknowledge-downgrade"));
    assert_eq!(guarded(&l), before);

    let staged = stage::stage(&l, &rec.inspection_id).unwrap();
    let v = install_commit(
        &l,
        &mut OfflineHost::new(&l),
        &rec,
        staged,
        &opts(&["downgrade"], None),
    )
    .unwrap();
    assert_eq!(v["replaced"], true);
    assert_eq!(v["version"], "1.0.0");
    assert_eq!(
        fs::read_to_string(l.skills().join("demo-skill/references/a.md")).unwrap(),
        "a reference for 1.0.0"
    );
    let trash: Vec<PathBuf> = fs::read_dir(l.extensions().join("trash"))
        .unwrap()
        .map(|e| e.unwrap().path())
        .collect();
    assert_eq!(trash.len(), 1, "{trash:?}");
    let t = &trash[0];
    let tid = t.file_name().unwrap().to_string_lossy().into_owned();
    assert!(
        tid.starts_with("demo-skill-2.0.0-") && tid.ends_with('Z'),
        "{tid}"
    );
    assert_eq!(
        fs::read_to_string(t.join("code/references/a.md")).unwrap(),
        "a reference for 2.0.0"
    );
    assert_eq!(fs::read(t.join("package.p1x")).unwrap(), v2);
    let rj: Value =
        serde_json::from_str(&fs::read_to_string(t.join("record.json")).unwrap()).unwrap();
    assert_eq!(rj["record"]["version"], "2.0.0");
    assert_eq!(rj["index"]["id"], "demo-skill");
    let st = state::read(&ext::paths::ExtPaths::of(&l)).unwrap();
    assert_eq!(
        st.items["demo-skill"].previous_version.as_deref(),
        Some("2.0.0")
    );

    let detail = show_item(&l, &config(&l), "demo-skill").unwrap();
    assert_eq!(detail["trash"][0]["trashId"], tid.as_str());
    assert_eq!(detail["trash"][0]["version"], "2.0.0");
    assert!(detail["trash"][0]["removedAt"].is_string());

    // A module replaces the same way: the old code goes into the trash.
    install(
        d.path(),
        &l,
        "m2.p1x",
        &module_pkg_v("fixture", "2.0.0", Some(&key)),
        &opts(&[], None),
    )
    .unwrap();
    install(
        d.path(),
        &l,
        "m1.p1x",
        &module_pkg_v("fixture", "1.0.0", Some(&key)),
        &opts(&["downgrade"], None),
    )
    .unwrap();
    assert_eq!(
        fs::read_to_string(l.modules_dir().join("fixture/index.js")).unwrap(),
        "// fixture 1.0.0\n"
    );
    let old: Vec<PathBuf> = fs::read_dir(l.extensions().join("trash"))
        .unwrap()
        .map(|e| e.unwrap().path())
        .filter(|p| {
            p.file_name()
                .unwrap()
                .to_string_lossy()
                .starts_with("fixture-2.0.0-")
        })
        .collect();
    assert_eq!(old.len(), 1);
    assert_eq!(
        fs::read_to_string(old[0].join("code/index.js")).unwrap(),
        "// fixture 2.0.0\n"
    );
}

#[test]
fn installing_the_identical_package_twice_is_a_no_op() {
    let key = test_key("test");
    let _g = env_with(&key);
    let (d, l) = home();
    populate(&l);
    let pkg = skill_pkg("demo-skill", Some(&key));
    install(d.path(), &l, "s.p1x", &pkg, &opts(&[], None)).unwrap();
    let before = guarded(&l);
    let audit = audit_lines(&l).len();
    assert_eq!(audit, 1);

    let (rec, staged) = prepare(d.path(), &l, "s.p1x", &pkg);
    let mut host = OfflineHost::new(&l);
    let v = install_commit(&l, &mut host, &rec, staged, &opts(&[], None)).unwrap();
    assert_eq!(
        v,
        json!({"name": "demo-skill", "version": "1.0.0", "kind": "skill", "replaced": false, "state": "installed"})
    );
    assert_eq!(guarded(&l), before, "writes nothing");
    assert_eq!(audit_lines(&l).len(), audit, "no audit line");
    assert!(host.notified.is_empty());
}

/// Review Focus 3: a failure at every step, for a fresh install and a replacement, of a skill and a module, leaves
/// `skills/`, `modules/`, `extensions/`, `config.json` and `data/` byte-identical; `modules.<name>` is restored
/// exactly, absent included.
#[test]
fn an_install_failing_at_each_step_rolls_back_to_a_byte_identical_tree() {
    let key = test_key("test");
    let _g = env_with(&key);
    let mut failed = Vec::new();
    for step in COMMIT_STEPS {
        for kind in ["skill", "module"] {
            // (replace?, the module's config before)
            for (replace, section) in [
                (false, None),
                (false, Some(json!({"enabled": true, "x": 1}))),
                (true, None),
            ] {
                if kind == "skill" && section.is_some() {
                    continue;
                }
                let applies = match step {
                    "config" => kind != "skill",
                    "index" => kind == "skill",
                    _ => true,
                };
                if !applies {
                    continue;
                }
                let (d, l) = home();
                populate(&l);
                if let Some(s) = &section {
                    write_config(&l, |c| c["modules"]["fixture"] = s.clone());
                }
                let (name, old, new) = if kind == "skill" {
                    (
                        "demo-skill",
                        skill_pkg_v("demo-skill", "1.0.0", Some(&key)),
                        skill_pkg_v("demo-skill", "1.1.0", Some(&key)),
                    )
                } else {
                    (
                        "fixture",
                        module_pkg_v("fixture", "1.0.0", Some(&key)),
                        module_pkg_v("fixture", "1.1.0", Some(&key)),
                    )
                };
                if replace {
                    install(d.path(), &l, "old.p1x", &old, &opts(&[], None)).unwrap();
                }
                let before = guarded(&l);
                let cfg_before = fs::read(l.config_path()).unwrap();
                let (rec, staged) = prepare(d.path(), &l, "new.p1x", &new);
                std::env::set_var("PLUR1BUS_TEST_EXT_FAIL_AT", step);
                let r = install_commit(
                    &l,
                    &mut OfflineHost::new(&l),
                    &rec,
                    staged,
                    &opts(&["capabilities"], Some(Agents::All)),
                );
                std::env::remove_var("PLUR1BUS_TEST_EXT_FAIL_AT");
                let label = format!("{step}/{kind}/replace={replace}/section={section:?}");
                match r {
                    Ok(v) => failed.push(format!("{label}: succeeded: {v}")),
                    Err(e) => {
                        if !e.message.contains(step) {
                            failed.push(format!("{label}: unexpected error {e}"));
                        }
                    }
                }
                if guarded(&l) != before {
                    failed.push(format!(
                        "{label}: tree differs:\n--- before\n{}\n--- after\n{}",
                        before.join("\n"),
                        guarded(&l).join("\n")
                    ));
                }
                if fs::read(l.config_path()).unwrap() != cfg_before {
                    failed.push(format!("{label}: config.json differs"));
                }
                let _ = name;
            }
        }
    }
    assert!(failed.is_empty(), "{}", failed.join("\n\n"));
}

#[test]
fn a_skill_install_while_an_import_holds_the_lock_is_locked_and_writes_nothing() {
    let key = test_key("test");
    let _g = env_with(&key);
    let (d, l) = home();
    populate(&l);
    let (rec, staged) = prepare(d.path(), &l, "s.p1x", &skill_pkg("demo-skill", Some(&key)));
    let mut child = long_lived_child();
    fs::create_dir_all(l.imports()).unwrap();
    let held = json!({"pid": child.id(), "at": "2026-09-28T10:00:00.000Z"}).to_string();
    fs::write(l.imports().join(".lock"), &held).unwrap();
    // Snapshot after staging: the refusal also removes the staging directory it was handed.
    let snapshot = |l: &Layout| {
        let mut g = guarded(l);
        g.retain(|x| !x.starts_with("extensions"));
        g
    };
    let before = snapshot(&l);
    let e = install_commit(
        &l,
        &mut OfflineHost::new(&l),
        &rec,
        staged,
        &opts(&[], None),
    )
    .unwrap_err();
    let _ = child.kill();
    let _ = child.wait();
    assert_eq!(reason(&e), ("E_LOCKED", "skills-locked"));
    assert_eq!(snapshot(&l), before);
    assert!(
        !l.extensions().exists(),
        "extensions/ left as it was (absent)"
    );
    assert_eq!(fs::read_to_string(l.imports().join(".lock")).unwrap(), held);
}

#[test]
fn recover_removes_staging_leftovers() {
    let key = test_key("test");
    let _g = env_with(&key);
    let (d, l) = home();
    // A stage that was killed after extracting, and one killed while extracting.
    let (rec, _staged) = prepare(d.path(), &l, "s.p1x", &skill_pkg("demo-skill", Some(&key)));
    let half = l.extensions().join("staging/fixture-0000");
    fs::create_dir_all(half.join("payload")).unwrap();
    fs::write(half.join("payload/x"), "x").unwrap();
    // A temp file of a dead writer.
    fs::write(l.extensions().join("state.json.tmp-999999999"), "{").unwrap();
    // An expired inspection next to the live one.
    let dead = l.run().join("inspect/dead-inspection.json");
    let mut old = rec.clone();
    old.inspection_id = "dead-inspection".into();
    old.expires_at = "2020-01-01T00:00:00.000Z".into();
    fs::write(&dead, serde_json::to_string(&old).unwrap()).unwrap();
    fs::write(l.run().join("inspect/dead-inspection.p1x"), "x").unwrap();

    let done = ext::recover(&l);
    assert!(done.len() >= 3, "{done:?}");
    assert!(!l.extensions().join("staging").exists(), "{done:?}");
    assert!(!l.extensions().join("state.json.tmp-999999999").exists());
    assert!(!dead.exists() && !l.run().join("inspect/dead-inspection.p1x").exists());
    assert!(
        inspect::load(&l, &rec.inspection_id).is_ok(),
        "a live inspection stays"
    );
    // Nothing else is left under extensions/.
    assert!(!l.extensions().exists() || fs::read_dir(l.extensions()).unwrap().next().is_none());
}

#[test]
fn a_second_mutation_while_one_runs_is_busy() {
    let key = test_key("test");
    let _g = env_with(&key);
    let (d, l) = home();
    populate(&l);
    let before = guarded(&l);
    let (rec, staged) = prepare(d.path(), &l, "s.p1x", &skill_pkg("demo-skill", Some(&key)));
    let running = ext::try_mutation().unwrap();
    let e = install_commit(
        &l,
        &mut OfflineHost::new(&l),
        &rec,
        staged,
        &opts(&[], None),
    )
    .unwrap_err();
    drop(running);
    assert_eq!(reason(&e), ("E_CONFLICT", "busy"));
    assert_eq!(guarded(&l), before);
}

// ---- list and show ------------------------------------------------------------------------------------------------

#[test]
fn list_shows_unindexed_bundled_and_local_skills_as_enabled() {
    let key = test_key("test");
    let _g = env_with(&key);
    let (_d, l) = home();
    write_config(&l, |_| {});
    for name in ["plur1bus-ops", "my-local"] {
        fs::create_dir_all(l.skills().join(name)).unwrap();
        fs::write(l.skills().join(name).join("SKILL.md"), skill_md(name)).unwrap();
    }
    fs::write(
        l.install_manifest(),
        json!({"skills": [{"name": "plur1bus-ops", "version": "1", "source": "bundled"}]})
            .to_string(),
    )
    .unwrap();
    let list = list_items(&l, &config(&l), &ListFilter::default());
    let ops = item(&list, "plur1bus-ops");
    assert_eq!(
        (
            &ops["source"],
            &ops["trust"],
            &ops["state"],
            &ops["enabled"],
            &ops["agents"],
            &ops["id"]
        ),
        (
            &json!("bundled"),
            &json!("release"),
            &json!("enabled"),
            &json!(true),
            &json!("all"),
            &Value::Null
        )
    );
    assert_eq!(ops["version"], "1");
    let local = item(&list, "my-local");
    assert_eq!(
        (&local["source"], &local["trust"], &local["enabled"]),
        (&json!("local"), &json!("dev"), &json!(true))
    );
    let v = rpc_def("ExtItem");
    for i in list["items"].as_array().unwrap() {
        assert_valid(&v, i);
    }
    // The filter by state keeps them; by kind module drops them.
    let only_modules = list_items(
        &l,
        &config(&l),
        &ListFilter {
            kind: Some(vec!["module".into()]),
            ..Default::default()
        },
    );
    assert_eq!(only_modules["items"], json!([]));
}

#[test]
fn list_reports_per_agent_effective_sets() {
    let key = test_key("test");
    let _g = env_with(&key);
    let (d, l) = home();
    let agents = json!({
        "bernd": {"createdAt": "2026-09-28T10:00:00.000Z"},
        "anna": {"createdAt": "2026-09-28T10:00:00.000Z"}
    });
    write_config(&l, |c| c["agents"] = agents.clone());
    install(
        d.path(),
        &l,
        "s.p1x",
        &skill_pkg("demo-skill", Some(&key)),
        &opts(&["capabilities"], Some(Agents::All)),
    )
    .unwrap();
    install(
        d.path(),
        &l,
        "o.p1x",
        &skill_pkg("demo-off", Some(&key)),
        &opts(&[], None),
    )
    .unwrap();
    let list = list_items(&l, &config(&l), &ListFilter::default());
    assert_eq!(item(&list, "demo-skill")["agents"], "all");
    assert_eq!(item(&list, "demo-off")["agents"], json!([]));

    write_config(&l, |c| {
        c["agents"] = agents.clone();
        c["agents"]["anna"]["skills"] = json!({"blocked": ["demo-skill"]});
    });
    let cfg = config(&l);
    let list = list_items(&l, &cfg, &ListFilter::default());
    assert_eq!(item(&list, "demo-skill")["agents"], json!(["bernd"]));
    let names = |f: &ListFilter| -> Vec<String> {
        list_items(&l, &cfg, f)["items"]
            .as_array()
            .unwrap()
            .iter()
            .map(|i| i["name"].as_str().unwrap().to_string())
            .collect()
    };
    let for_anna = names(&ListFilter {
        agent: Some("anna".into()),
        ..Default::default()
    });
    assert!(
        !for_anna.contains(&"demo-skill".to_string()),
        "{for_anna:?}"
    );
    let for_bernd = names(&ListFilter {
        agent: Some("bernd".into()),
        ..Default::default()
    });
    assert!(
        for_bernd.contains(&"demo-skill".to_string()),
        "{for_bernd:?}"
    );
    assert!(!for_bernd.contains(&"demo-off".to_string()));
    let installed = names(&ListFilter {
        state: Some(vec!["installed".into()]),
        ..Default::default()
    });
    assert_eq!(installed, ["demo-off"]);
}

#[test]
fn show_reports_tampered_after_a_file_edit() {
    let key = test_key("test");
    let _g = env_with(&key);
    let (d, l) = home();
    populate(&l);
    let pkg = skill_pkg("demo-skill", Some(&key));
    install(d.path(), &l, "s.p1x", &pkg, &opts(&[], None)).unwrap();
    let detail = show_item(&l, &config(&l), "demo-skill").unwrap();
    assert_valid(&rpc_def("ExtDetail"), &detail);
    assert_eq!(detail["item"]["integrity"], "ok");
    assert_eq!(detail["item"]["overlays"], json!([]));
    assert_eq!(detail["manifest"]["id"], "demo/demo-skill");
    assert_eq!(detail["trust"]["tier"], "first-party");
    assert_eq!(detail["trust"]["label"], "test");
    assert!(detail["trust"]["keyId"].is_string());
    assert_eq!(detail["files"]["count"], 3);
    let bytes = skill_md("demo-skill").len() + "a reference for 1.0.0".len() + RUN_SH.len();
    assert_eq!(detail["files"]["bytes"], bytes);
    assert_eq!(
        detail["scripts"],
        json!([{"path": "scripts/run.sh", "size": RUN_SH.len(), "firstLine": "#!/bin/sh"}])
    );
    assert_eq!(detail["dependents"], json!([]));
    assert_eq!(detail["trash"], json!([]));

    fs::write(l.skills().join("demo-skill/references/a.md"), "edited").unwrap();
    let detail = show_item(&l, &config(&l), "demo-skill").unwrap();
    assert_valid(&rpc_def("ExtDetail"), &detail);
    assert_eq!(detail["item"]["overlays"], json!(["tampered"]));
    assert_eq!(detail["item"]["integrity"], "tampered");
    let st = state::read(&ext::paths::ExtPaths::of(&l)).unwrap();
    let integ = st.items["demo-skill"].integrity.clone().unwrap();
    assert!(!integ.ok);
    assert_eq!(integ.paths, ["references/a.md"]);
    let list = list_items(&l, &config(&l), &ListFilter::default());
    assert_eq!(item(&list, "demo-skill")["overlays"], json!(["tampered"]));

    let e = show_item(&l, &config(&l), "nope").unwrap_err();
    assert_eq!(reason(&e), ("E_NOT_FOUND", "extension-unknown"));
    // A folder without a record shows too.
    let other = show_item(&l, &config(&l), "other-skill").unwrap();
    assert_valid(&rpc_def("ExtDetail"), &other);
    assert_eq!(other["manifest"], Value::Null);
}

#[test]
fn install_writes_one_audit_line_with_trust_and_acknowledgments() {
    let key = test_key("test");
    let _g = env_with(&key);
    let (d, l) = home();
    populate(&l);
    let pkg = skill_pkg("demo-skill", None);
    install(d.path(), &l, "u.p1x", &pkg, &opts(&["unsigned"], None)).unwrap();
    let lines = audit_lines(&l);
    assert_eq!(lines.len(), 1);
    let a = &lines[0];
    assert_eq!(a["action"], "ext.install");
    assert_eq!(a["target"], "demo-skill");
    assert_eq!(
        a["detail"],
        json!({
            "id": "demo/demo-skill", "version": "1.0.0", "kind": "skill", "sha256": sha_hex(&pkg),
            "trust": "unsigned", "keyId": null, "acknowledged": ["unsigned"], "replaced": false, "via": "offline"
        })
    );
}

/// `ModuleHost` is object-safe and the offline host says where it runs.
#[test]
fn the_offline_host_is_offline() {
    let (_d, l) = home();
    let h = OfflineHost::new(&l);
    let dynh: &dyn ModuleHost = &h;
    assert_eq!(dynh.via(), "offline");
}
