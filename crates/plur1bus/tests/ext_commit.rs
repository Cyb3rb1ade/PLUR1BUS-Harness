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
#[path = "../src/modules/graph.rs"]
pub(crate) mod modules_graph;
#[path = "../src/modules/install.rs"]
pub(crate) mod modules_install;
#[path = "../src/modules/manifest.rs"]
pub(crate) mod modules_manifest;
// `graph.rs` names its sibling as `super::manifest`.
pub(crate) use modules_manifest as manifest;
#[path = "../src/paths.rs"]
mod paths;
#[path = "../src/proc.rs"]
mod proc;
mod modules {
    pub(crate) use super::modules_graph as graph;
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
use ext::inspect::{self, Source};
use ext::list::{list_items, show_item, ListFilter};
use ext::record::{self, InspectionRecord};
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

/// `(relative path, sha256 hex)` of every regular file under `dir`, `/`-separated.
fn disk_files(dir: &Path) -> Vec<(String, String)> {
    let mut out = Vec::new();
    let mut stack = vec![dir.to_path_buf()];
    while let Some(d) = stack.pop() {
        for e in fs::read_dir(&d).unwrap() {
            let p = e.unwrap().path();
            if p.is_dir() {
                stack.push(p);
            } else {
                let rel = p
                    .strip_prefix(dir)
                    .unwrap()
                    .components()
                    .map(|c| c.as_os_str().to_string_lossy().into_owned())
                    .collect::<Vec<_>>()
                    .join("/");
                out.push((rel, sha_hex(&fs::read(&p).unwrap())));
            }
        }
    }
    out
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
    // The folder hash over what is on disk (the importer's `folderHash` rule), not over the record.
    assert_eq!(
        e["sha256"],
        plur1bus_ext::folder_hash::skill_folder_hash(&disk_files(&dir))
    );
    assert_eq!(files.len(), 3);
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
    let list = list_items(&l, &config(&l), &ListFilter::default()).unwrap();
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

    let list = list_items(&l, &config(&l), &ListFilter::default()).unwrap();
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
            // (replace?, config.json before): as the config service writes it; with a `modules.fixture` section; a
            // minimal hand-written file; no file at all (X1-C14).
            for (replace, section) in [
                (false, "normal"),
                (false, "section"),
                (false, "minimal"),
                (false, "absent"),
                (true, "normal"),
            ] {
                if kind == "skill" && section != "normal" {
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
                match section {
                    "section" => write_config(&l, |c| {
                        c["modules"]["fixture"] = json!({"enabled": true, "x": 1})
                    }),
                    "minimal" => fs::write(l.config_path(), "{\"schemaVersion\":1}\n").unwrap(),
                    "absent" => fs::remove_file(l.config_path()).unwrap(),
                    _ => {}
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
                let cfg_before = fs::read(l.config_path()).ok();
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
                let label = format!("{step}/{kind}/replace={replace}/config={section}");
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
                if fs::read(l.config_path()).ok() != cfg_before {
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
    // A temp file of a dead writer, and a trash entry a killed commit was still building.
    fs::write(l.extensions().join("state.json.tmp-999999999"), "{").unwrap();
    let half_trash = l
        .extensions()
        .join("trash/demo-skill-1.0.0-20260101T000000Z.tmp-999999999");
    fs::create_dir_all(&half_trash).unwrap();
    fs::write(half_trash.join("record.json"), "{}").unwrap();
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
    assert!(!half_trash.exists());
    assert!(!dead.exists() && !l.run().join("inspect/dead-inspection.p1x").exists());
    assert!(
        record::load(&l, &rec.inspection_id).is_ok(),
        "a live inspection stays"
    );
    // Nothing else is left under extensions/ but the emptied trash directory.
    let left: Vec<String> = fs::read_dir(l.extensions())
        .map(|r| {
            r.map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
                .collect()
        })
        .unwrap_or_default();
    assert!(left.iter().all(|n| n == "trash"), "{left:?}");
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
    let list = list_items(&l, &config(&l), &ListFilter::default()).unwrap();
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
    )
    .unwrap();
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
    let list = list_items(&l, &config(&l), &ListFilter::default()).unwrap();
    assert_eq!(item(&list, "demo-skill")["agents"], "all");
    assert_eq!(item(&list, "demo-off")["agents"], json!([]));

    write_config(&l, |c| {
        c["agents"] = agents.clone();
        c["agents"]["anna"]["skills"] = json!({"blocked": ["demo-skill"]});
    });
    let cfg = config(&l);
    let list = list_items(&l, &cfg, &ListFilter::default()).unwrap();
    assert_eq!(item(&list, "demo-skill")["agents"], json!(["bernd"]));
    let names = |f: &ListFilter| -> Vec<String> {
        list_items(&l, &cfg, f).unwrap()["items"]
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
    // X1-C27: the path inside the package, as `ext.inspect` shows it (and so does the record fallback).
    assert_eq!(
        detail["scripts"],
        json!([{"path": "payload/scripts/run.sh", "size": RUN_SH.len(), "firstLine": "#!/bin/sh"}])
    );
    let insp = inspect::inspect(
        &l,
        Source::Path(d.path().join("s.p1x")),
        &worker::new_inspection_id(),
    )
    .unwrap();
    assert_eq!(insp.scripts, detail["scripts"]);
    let paths = ext::paths::ExtPaths::of(&l);
    let meta = paths.cached_meta(&sha_hex(&pkg));
    let kept = fs::read(&meta).unwrap();
    fs::remove_file(&meta).unwrap();
    let bare = show_item(&l, &config(&l), "demo-skill").unwrap();
    assert_eq!(
        bare["scripts"],
        json!([{"path": "payload/scripts/run.sh", "size": RUN_SH.len()}])
    );
    fs::write(&meta, kept).unwrap();
    assert_eq!(detail["dependents"], json!([]));
    assert_eq!(detail["trash"], json!([]));

    fs::write(l.skills().join("demo-skill/references/a.md"), "edited").unwrap();
    let before = guarded(&l);
    let detail = show_item(&l, &config(&l), "demo-skill").unwrap();
    assert_valid(&rpc_def("ExtDetail"), &detail);
    assert_eq!(detail["item"]["overlays"], json!(["tampered"]));
    assert_eq!(detail["item"]["integrity"], "tampered");
    // X1-C13: show never writes (the result is for the answer only) and takes no lock.
    assert_eq!(guarded(&l), before);
    let st = state::read(&ext::paths::ExtPaths::of(&l)).unwrap();
    assert!(st.items["demo-skill"].integrity.is_none());
    let running = ext::try_mutation().unwrap();
    assert!(show_item(&l, &config(&l), "demo-skill").is_ok());
    drop(running);
    // `ext.list` shows the last stored result: none yet.
    let list = list_items(&l, &config(&l), &ListFilter::default()).unwrap();
    assert_eq!(item(&list, "demo-skill")["integrity"], "unchecked");

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

// ---- fix round 1 ------------------------------------------------------------------------------------------------------

/// A skill package with its own capability block (and the same files as [`skill_pkg_v`]).
fn skill_pkg_caps(name: &str, version: &str, caps: Value, key: Option<&TestKey>) -> Vec<u8> {
    let mut t = template(name, "skill", version);
    t["capabilities"] = caps;
    build_package_from(
        &t,
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

fn base_caps() -> Value {
    template("x", "skill", "1.0.0")["capabilities"].clone()
}

fn index_enabled(l: &Layout, name: &str) -> Option<bool> {
    index::read_index(l)
        .unwrap()
        .entry(name)
        .map(|e| e["enabled"] == true)
}

/// X1-C9: a replaced item keeps its enable state (and a disabled one stays disabled).
#[test]
fn replacing_an_enabled_item_keeps_it_enabled() {
    let key = test_key("test");
    let _g = env_with(&key);
    let (d, l) = home();
    populate(&l);
    let on = opts(&["capabilities"], Some(Agents::All));
    install(
        d.path(),
        &l,
        "s1.p1x",
        &skill_pkg_v("demo-skill", "1.0.0", Some(&key)),
        &on,
    )
    .unwrap();
    let v = install(
        d.path(),
        &l,
        "s2.p1x",
        &skill_pkg_v("demo-skill", "1.1.0", Some(&key)),
        &opts(&[], None),
    )
    .unwrap();
    assert_eq!(
        (&v["replaced"], &v["state"]),
        (&json!(true), &json!("enabled"))
    );
    assert_eq!(index_enabled(&l, "demo-skill"), Some(true));

    install(
        d.path(),
        &l,
        "m1.p1x",
        &module_pkg_v("fixture", "1.0.0", Some(&key)),
        &on,
    )
    .unwrap();
    assert_eq!(config(&l)["modules"]["fixture"]["enabled"], true);
    let v = install(
        d.path(),
        &l,
        "m2.p1x",
        &module_pkg_v("fixture", "1.1.0", Some(&key)),
        &opts(&[], None),
    )
    .unwrap();
    assert_eq!(
        (&v["replaced"], &v["state"]),
        (&json!(true), &json!("enabled"))
    );
    assert_eq!(config(&l)["modules"]["fixture"]["enabled"], true);

    // A disabled module stays disabled across a replacement.
    install(
        d.path(),
        &l,
        "b1.p1x",
        &module_pkg_v("fixture-b", "1.0.0", Some(&key)),
        &opts(&[], None),
    )
    .unwrap();
    let v = install(
        d.path(),
        &l,
        "b2.p1x",
        &module_pkg_v("fixture-b", "1.1.0", Some(&key)),
        &opts(&[], None),
    )
    .unwrap();
    assert_eq!(v["state"], "installed");
    assert_eq!(config(&l)["modules"]["fixture-b"]["enabled"], false);
}

/// X1-C12: replacing an enabled item with one whose capabilities differ needs `capabilities`; a disabled one does not
/// (its next enable asks).
#[test]
fn replacing_an_enabled_item_with_other_capabilities_needs_acknowledge_capabilities() {
    let key = test_key("test");
    let _g = env_with(&key);
    let (d, l) = home();
    populate(&l);
    let on = opts(&["capabilities"], Some(Agents::All));
    install(
        d.path(),
        &l,
        "s1.p1x",
        &skill_pkg_caps("demo-skill", "1.0.0", base_caps(), Some(&key)),
        &on,
    )
    .unwrap();
    let mut wide = base_caps();
    wide["network"] = json!({ "mode": "any" });
    let before = guarded(&l);
    let (rec, staged) = prepare(
        d.path(),
        &l,
        "s2.p1x",
        &skill_pkg_caps("demo-skill", "1.1.0", wide.clone(), Some(&key)),
    );
    let e = install_commit(
        &l,
        &mut OfflineHost::new(&l),
        &rec,
        staged,
        &opts(&[], None),
    )
    .unwrap_err();
    assert_eq!(
        reason(&e),
        ("E_APPROVAL_REQUIRED", "acknowledge-capabilities")
    );
    assert_eq!(e.data["capabilities"]["network"]["mode"], "any");
    assert_eq!(guarded(&l), before);

    let staged = stage::stage(&l, &rec.inspection_id).unwrap();
    let v = install_commit(
        &l,
        &mut OfflineHost::new(&l),
        &rec,
        staged,
        &opts(&["capabilities"], None),
    )
    .unwrap();
    assert_eq!(v["state"], "enabled");
    let st = state::read(&ext::paths::ExtPaths::of(&l)).unwrap();
    assert_eq!(
        st.items["demo-skill"].capabilities_ack.as_deref(),
        Some(ext::commit::capabilities_hash(&wide).as_str())
    );

    // Disabled: no acknowledgment at install.
    install(
        d.path(),
        &l,
        "o1.p1x",
        &skill_pkg_caps("demo-off", "1.0.0", base_caps(), Some(&key)),
        &opts(&[], None),
    )
    .unwrap();
    install(
        d.path(),
        &l,
        "o2.p1x",
        &skill_pkg_caps("demo-off", "1.1.0", wide, Some(&key)),
        &opts(&[], None),
    )
    .unwrap();
}

/// X1-C10: a commit killed at any point (no rollback, no clean-up) never leaves the skill folder listed as enabled
/// without a record, before or after `ext::recover`; recover drops an entry that has neither folder nor record.
#[test]
fn a_kill_between_steps_never_lists_a_skill_folder_enabled_without_a_record() {
    let key = test_key("test");
    let _g = env_with(&key);
    let mut failed = Vec::new();
    for replace in [false, true] {
        for point in ["code.index", "code", "state", "cache", "index", "enable"] {
            let (d, l) = home();
            populate(&l);
            let on = opts(&["capabilities"], Some(Agents::All));
            if replace {
                install(
                    d.path(),
                    &l,
                    "old.p1x",
                    &skill_pkg_v("demo-skill", "1.0.0", Some(&key)),
                    &on,
                )
                .unwrap();
            }
            let (rec, staged) = prepare(
                d.path(),
                &l,
                "new.p1x",
                &skill_pkg_v("demo-skill", "1.1.0", Some(&key)),
            );
            std::env::set_var("PLUR1BUS_TEST_EXT_FAIL_AT", format!("kill:{point}"));
            let r = install_commit(&l, &mut OfflineHost::new(&l), &rec, staged, &on);
            std::env::remove_var("PLUR1BUS_TEST_EXT_FAIL_AT");
            let label = format!("replace={replace}/kill:{point}");
            if r.is_ok() {
                failed.push(format!("{label}: the seam did not fire"));
                continue;
            }
            let check = |when: &str, failed: &mut Vec<String>| {
                let st = state::read(&ext::paths::ExtPaths::of(&l)).unwrap();
                let list = list_items(&l, &config(&l), &ListFilter::default()).unwrap();
                let listed = list["items"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .find(|i| i["name"] == "demo-skill")
                    .cloned();
                if let Some(i) = &listed {
                    if i["enabled"] == true && !st.items.contains_key("demo-skill") {
                        failed.push(format!(
                            "{label} ({when}): listed enabled without a record: {i}"
                        ));
                    }
                }
                if l.skills().join("demo-skill").is_dir()
                    && index_enabled(&l, "demo-skill").is_none()
                {
                    failed.push(format!("{label} ({when}): a folder without an index entry"));
                }
            };
            check("after the kill", &mut failed);
            ext::recover(&l);
            check("after recover", &mut failed);
            let st = state::read(&ext::paths::ExtPaths::of(&l)).unwrap();
            if index_enabled(&l, "demo-skill").is_some()
                && !l.skills().join("demo-skill").exists()
                && !st.items.contains_key("demo-skill")
            {
                failed.push(format!(
                    "{label}: recover left an entry without folder and record"
                ));
            }
            if !staging_empty(&l) {
                failed.push(format!("{label}: recover left staging"));
            }
        }
    }
    assert!(failed.is_empty(), "{}", failed.join("\n"));
}

#[test]
fn recover_restores_a_missing_index_entry_disabled() {
    let key = test_key("test");
    let _g = env_with(&key);
    let (d, l) = home();
    populate(&l);
    install(
        d.path(),
        &l,
        "s.p1x",
        &skill_pkg("demo-skill", Some(&key)),
        &opts(&["capabilities"], Some(Agents::All)),
    )
    .unwrap();
    let mut idx = index::read_index(&l).unwrap();
    idx.remove("demo-skill");
    index::write_index(&l, &idx).unwrap();
    let done = ext::recover(&l);
    assert!(done.iter().any(|x| x.contains("demo-skill")), "{done:?}");
    assert_eq!(index_enabled(&l, "demo-skill"), Some(false));
    let e = index::read_index(&l)
        .unwrap()
        .entry("demo-skill")
        .cloned()
        .unwrap();
    assert_eq!(e["package"]["id"], "demo/demo-skill");
    let list = list_items(&l, &config(&l), &ListFilter::default()).unwrap();
    assert_eq!(item(&list, "demo-skill")["enabled"], false);
}

/// An offline host whose `install_module` fails from the `fail_from`-th call on.
struct FlakyHost<'a> {
    inner: OfflineHost<'a>,
    calls: usize,
    fail_from: usize,
}

impl ModuleHost for FlakyHost<'_> {
    fn config(&self) -> Value {
        self.inner.config()
    }
    fn set_config(&mut self, c: Vec<(String, Value)>, dry: bool) -> Result<Value, ExtError> {
        self.inner.set_config(c, dry)
    }
    fn install_module(&mut self, s: modules_install::Staged) -> Result<bool, ExtError> {
        self.calls += 1;
        if self.calls >= self.fail_from {
            return Err(ExtError::new(
                "E_INTERNAL",
                "io",
                "flaky host: install_module failed",
            ));
        }
        self.inner.install_module(s)
    }
    fn remove_module(&mut self, n: &str, into: &Path) -> Result<(), ExtError> {
        self.inner.remove_module(n, into)
    }
    fn notify(&mut self, c: Value) {
        self.inner.notify(c)
    }
    fn via(&self) -> &'static str {
        "offline"
    }
}

/// A rollback whose restore fails keeps the trash entry and its code: the entry is removed only after a restore.
#[test]
fn a_failing_restore_keeps_the_trash_copy() {
    let key = test_key("test");
    let _g = env_with(&key);
    let (d, l) = home();
    populate(&l);
    install(
        d.path(),
        &l,
        "m1.p1x",
        &module_pkg_v("fixture", "1.0.0", Some(&key)),
        &opts(&[], None),
    )
    .unwrap();
    let (rec, staged) = prepare(
        d.path(),
        &l,
        "m2.p1x",
        &module_pkg_v("fixture", "1.1.0", Some(&key)),
    );
    std::env::set_var("PLUR1BUS_TEST_EXT_FAIL_AT", "code");
    let mut host = FlakyHost {
        inner: OfflineHost::new(&l),
        calls: 0,
        fail_from: 2,
    };
    let e = install_commit(&l, &mut host, &rec, staged, &opts(&[], None)).unwrap_err();
    std::env::remove_var("PLUR1BUS_TEST_EXT_FAIL_AT");
    assert!(e.message.contains("rollback also failed"), "{e}");
    assert!(e.message.contains("stays in the trash"), "{e}");
    let trash: Vec<PathBuf> = fs::read_dir(l.extensions().join("trash"))
        .unwrap()
        .map(|x| x.unwrap().path())
        .collect();
    assert_eq!(trash.len(), 1, "{trash:?}");
    assert_eq!(
        fs::read_to_string(trash[0].join("code/index.js")).unwrap(),
        "// fixture 1.0.0\n"
    );
}

/// The re-checks at commit time: the inspection is up to ten minutes old, the state may have moved on.
#[test]
fn commit_time_rechecks_refuse_and_write_nothing() {
    let key = test_key("test");
    let _g = env_with(&key);
    let written = |l: &Layout| {
        l.skills().join("demo-skill").exists()
            || l.extensions().join("state.json").exists()
            || l.modules_dir().join("fixture").join("index.js").exists()
    };

    // name-taken: a module directory of that name appeared meanwhile.
    let (d, l) = home();
    populate(&l);
    let (rec, staged) = prepare(d.path(), &l, "s.p1x", &skill_pkg("demo-skill", Some(&key)));
    fs::create_dir_all(l.modules_dir().join("demo-skill")).unwrap();
    let e = install_commit(
        &l,
        &mut OfflineHost::new(&l),
        &rec,
        staged,
        &opts(&[], None),
    )
    .unwrap_err();
    assert_eq!(reason(&e), ("E_CONFLICT", "name-taken"));
    assert!(!written(&l) && staging_empty(&l));

    // revoked meanwhile.
    let (d, l) = home();
    populate(&l);
    let (rec, staged) = prepare(d.path(), &l, "s.p1x", &skill_pkg("demo-skill", Some(&key)));
    let revs = d.path().join("revocations.json");
    fs::write(
        &revs,
        json!({"revocations": [{"id": "demo/demo-skill", "versions": "*", "action": "disable", "reason": "bad"}]})
            .to_string(),
    )
    .unwrap();
    std::env::set_var("PLUR1BUS_TEST_EXT_REVOCATIONS", &revs);
    let e = install_commit(
        &l,
        &mut OfflineHost::new(&l),
        &rec,
        staged,
        &opts(&[], None),
    )
    .unwrap_err();
    std::env::remove_var("PLUR1BUS_TEST_EXT_REVOCATIONS");
    assert_eq!(reason(&e), ("E_DENIED", "revoked"));
    assert!(!written(&l));

    // extensions.allowUnsigned turned off meanwhile.
    let (d, l) = home();
    populate(&l);
    let (rec, staged) = prepare(d.path(), &l, "u.p1x", &skill_pkg("demo-skill", None));
    write_config(&l, |c| c["extensions"]["allowUnsigned"] = json!(false));
    let e = install_commit(
        &l,
        &mut OfflineHost::new(&l),
        &rec,
        staged,
        &opts(&["unsigned"], None),
    )
    .unwrap_err();
    assert_eq!(reason(&e), ("E_DENIED", "policy-unsigned-disallowed"));
    assert!(!written(&l));

    // A required secret slot: installs, but `enable` refuses before any write.
    let (d, l) = home();
    populate(&l);
    let mut caps = base_caps();
    caps["secrets"] =
        json!([{ "slot": "API_KEY", "label": { "en": "API key" }, "required": true }]);
    let pkg = skill_pkg_caps("demo-skill", "1.0.0", caps, Some(&key));
    let (rec, staged) = prepare(d.path(), &l, "s.p1x", &pkg);
    let e = install_commit(
        &l,
        &mut OfflineHost::new(&l),
        &rec,
        staged,
        &opts(&["capabilities"], Some(Agents::All)),
    )
    .unwrap_err();
    assert_eq!(reason(&e), ("E_NOT_AVAILABLE", "needs-setup"));
    assert!(!written(&l));
    install(d.path(), &l, "s.p1x", &pkg, &opts(&[], None)).unwrap();
    let list = list_items(&l, &config(&l), &ListFilter::default()).unwrap();
    assert_eq!(
        item(&list, "demo-skill")["overlays"],
        json!(["needs-setup"])
    );

    // An unknown agent.
    let (d, l) = home();
    populate(&l);
    let (rec, staged) = prepare(d.path(), &l, "s.p1x", &skill_pkg("demo-skill", Some(&key)));
    let e = install_commit(
        &l,
        &mut OfflineHost::new(&l),
        &rec,
        staged,
        &opts(&["capabilities"], Some(Agents::Some(vec!["nobody".into()]))),
    )
    .unwrap_err();
    assert_eq!(e.code, "E_AGENT_UNKNOWN");
    assert!(!written(&l));
}

/// socket-path-too-long at commit: the same staged module committed into a home whose socket address does not fit.
#[cfg(unix)]
#[test]
fn a_module_whose_socket_no_longer_fits_is_refused_at_commit() {
    let key = test_key("test");
    let _g = env_with(&key);
    let (d, l) = home();
    let (rec, staged) = prepare(d.path(), &l, "m.p1x", &module_pkg("fixture", Some(&key)));
    let long = Layout::new(d.path().join("h".repeat(120)));
    fs::create_dir_all(&long.home).unwrap();
    // The inspection and the staging move with it (the commit derives both paths from the home it commits into).
    let id = &rec.inspection_id;
    let (from, to) = (
        ext::paths::ExtPaths::of(&l),
        ext::paths::ExtPaths::of(&long),
    );
    fs::create_dir_all(&to.inspect).unwrap();
    fs::create_dir_all(&to.staging).unwrap();
    for ext_name in ["p1x", "json"] {
        let f = format!("{id}.{ext_name}");
        fs::rename(from.inspect.join(&f), to.inspect.join(&f)).unwrap();
    }
    let dir = format!("fixture-{id}");
    fs::rename(from.staging.join(&dir), to.staging.join(&dir)).unwrap();
    let staged = StagedItem {
        dir: to.staging.join(&dir).join("payload"),
        package: to.inspect.join(format!("{id}.p1x")),
        ..staged
    };
    let e = install_commit(
        &long,
        &mut OfflineHost::new(&long),
        &rec,
        staged,
        &opts(&[], None),
    )
    .unwrap_err();
    assert_eq!(reason(&e), ("E_INVALID_PARAMS", "socket-path-too-long"));
    assert!(!long.modules_dir().join("fixture").exists());
    assert!(!long.config_path().exists());
}

#[test]
fn show_of_a_module_names_its_dependents_and_matches_the_schema() {
    let key = test_key("test");
    let _g = env_with(&key);
    let (d, l) = home();
    populate(&l);
    install(
        d.path(),
        &l,
        "m.p1x",
        &module_pkg("fixture", Some(&key)),
        &opts(&[], None),
    )
    .unwrap();
    let b = l.modules_dir().join("fixture-b");
    fs::create_dir_all(&b).unwrap();
    fs::write(
        b.join("module.json"),
        serde_json::to_vec(&json!({
            "name": "fixture-b", "version": "0.1.0", "apiVersion": "1", "entry": "index.js",
            "scope": "installation", "priority": 500, "needs": ["fixture"]
        }))
        .unwrap(),
    )
    .unwrap();
    fs::write(b.join("index.js"), "//\n").unwrap();
    let detail = show_item(&l, &config(&l), "fixture").unwrap();
    assert_valid(&rpc_def("ExtDetail"), &detail);
    assert_eq!(detail["dependents"], json!(["fixture-b"]));
    assert_eq!(detail["item"]["kind"], "module");
    assert_eq!(detail["trust"]["label"], "test");
}

/// Review finding 4 (Task 11): the staged item's paths come from the worker's answer; the commit derives the staging
/// directory and the spool from the inspection and refuses an item that names others (`worker-failed`), writing
/// nothing.
#[test]
fn a_staged_item_naming_other_paths_is_worker_failed() {
    let key = test_key("test");
    let _g = env_with(&key);
    let (d, l) = home();
    let before = guarded(&l);
    let (rec, staged) = prepare(d.path(), &l, "m.p1x", &module_pkg("fixture", Some(&key)));
    let elsewhere = d.path().join("elsewhere");
    fs::create_dir_all(&elsewhere).unwrap();
    for (i, bad) in [
        StagedItem {
            dir: elsewhere.clone(),
            ..staged.clone()
        },
        StagedItem {
            package: d.path().join("m.p1x"),
            ..staged.clone()
        },
    ]
    .into_iter()
    .enumerate()
    {
        let e =
            install_commit(&l, &mut OfflineHost::new(&l), &rec, bad, &opts(&[], None)).unwrap_err();
        assert_eq!(reason(&e), ("E_INTERNAL", "worker-failed"));
        assert!(elsewhere.is_dir() && d.path().join("m.p1x").is_file());
        // Nothing written; the (derived) staging directory is spent.
        assert_eq!(guarded(&l), before, "a refusal writes nothing");
        if i == 0 {
            let _ = stage::stage(&l, &rec.inspection_id).unwrap();
        }
    }
}

/// X1-C22: a replace moves the old version's cached package into its trash entry by rename (no second copy stays in
/// the cache), and a replace that fails afterwards moves it back.
#[test]
fn a_replace_moves_the_old_package_into_the_trash_and_a_failure_moves_it_back() {
    let key = test_key("test");
    let _g = env_with(&key);
    let (d, l) = home();
    let p = ext::paths::ExtPaths::of(&l);
    let sha = |bytes: &[u8]| -> String {
        Sha256::digest(bytes)
            .iter()
            .map(|b| format!("{b:02x}"))
            .collect()
    };
    let v1 = module_pkg_v("fixture", "1.0.0", Some(&key));
    install(d.path(), &l, "v1.p1x", &v1, &opts(&[], None)).unwrap();
    let old = p.cached(&sha(&v1));
    assert!(old.is_file());
    let entries = |dir: &Path| -> Vec<PathBuf> {
        fs::read_dir(dir)
            .map(|r| r.flatten().map(|e| e.path()).collect())
            .unwrap_or_default()
    };

    let v2 = module_pkg_v("fixture", "2.0.0", Some(&key));
    std::env::set_var("PLUR1BUS_TEST_EXT_FAIL_AT", "state");
    assert!(install(d.path(), &l, "v2.p1x", &v2, &opts(&[], None)).is_err());
    std::env::remove_var("PLUR1BUS_TEST_EXT_FAIL_AT");
    assert!(old.is_file(), "the old package is back in the cache");
    assert!(entries(&p.trash).is_empty(), "{:?}", entries(&p.trash));

    install(d.path(), &l, "v2.p1x", &v2, &opts(&[], None)).unwrap();
    assert!(!old.exists(), "the old package left the cache");
    let trashed = entries(&p.trash);
    assert_eq!(trashed.len(), 1, "{trashed:?}");
    assert_eq!(fs::read(trashed[0].join("package.p1x")).unwrap(), v1);
}

/// A commit killed between moving the new code into place and writing its record (`kill:code`), or between the record
/// and the cache (`kill:state`), for a skill and a module, fresh and replacing: `ext::recover` either finishes the
/// install (the record is there: the cache gets the package and its meta) or removes the new code (it is not: a
/// replaced item's code comes back from the trash). Never code without a record, and a fresh name stays installable.
#[test]
fn recover_finishes_or_rolls_back_a_commit_killed_between_code_and_state() {
    let key = test_key("test");
    let _g = env_with(&key);
    let mut failed = Vec::new();
    for kind in ["skill", "module"] {
        for replace in [false, true] {
            for point in ["code", "state"] {
                let label = format!("{kind}/replace={replace}/kill:{point}");
                let (d, l) = home();
                populate(&l);
                let name = if kind == "skill" {
                    "demo-skill"
                } else {
                    "fixture"
                };
                let pkg = |v: &str| {
                    if kind == "skill" {
                        skill_pkg_v(name, v, Some(&key))
                    } else {
                        module_pkg_v(name, v, Some(&key))
                    }
                };
                if replace {
                    install(d.path(), &l, "old.p1x", &pkg("1.0.0"), &opts(&[], None)).unwrap();
                }
                let new = pkg("1.1.0");
                let (rec, staged) = prepare(d.path(), &l, "new.p1x", &new);
                std::env::set_var("PLUR1BUS_TEST_EXT_FAIL_AT", format!("kill:{point}"));
                let r = install_commit(
                    &l,
                    &mut OfflineHost::new(&l),
                    &rec,
                    staged,
                    &opts(&[], None),
                );
                std::env::remove_var("PLUR1BUS_TEST_EXT_FAIL_AT");
                if r.is_ok() {
                    failed.push(format!("{label}: the seam did not fire"));
                    continue;
                }
                let dir = if kind == "skill" {
                    l.skills().join(name)
                } else {
                    l.modules_dir().join(name)
                };
                ext::recover(&l);
                let paths = ext::paths::ExtPaths::of(&l);
                let st = state::read(&paths).unwrap();
                let recorded = st.items.get(name);
                if dir.exists() != recorded.is_some() {
                    failed.push(format!(
                        "{label}: code {} but record {}",
                        dir.exists(),
                        recorded.is_some()
                    ));
                }
                if !staging_empty(&l) {
                    failed.push(format!("{label}: recover left staging"));
                }
                match (point, replace) {
                    ("state", _) => {
                        let ok = recorded.is_some_and(|r| r.version == "1.1.0")
                            && paths.cached(&sha_hex(&new)).is_file()
                            && paths.cached_meta(&sha_hex(&new)).is_file();
                        if !ok {
                            failed.push(format!("{label}: the install was not finished"));
                        }
                    }
                    ("code", true) => {
                        let Some(r) = recorded else {
                            failed.push(format!("{label}: the replaced item lost its record"));
                            continue;
                        };
                        if r.version != "1.0.0" || !ext::overlays::rehash(&l, r).ok {
                            failed.push(format!(
                                "{label}: the old code did not come back ({})",
                                r.version
                            ));
                        }
                        if kind == "skill" && index_enabled(&l, name) != Some(false) {
                            failed.push(format!(
                                "{label}: the index entry is not the disabled old one"
                            ));
                        }
                    }
                    _ => {
                        if kind == "skill" && index_enabled(&l, name).is_some() {
                            failed.push(format!("{label}: an index entry stayed"));
                        }
                        // The name is free again.
                        if let Err(e) = install(d.path(), &l, "again.p1x", &new, &opts(&[], None)) {
                            failed.push(format!("{label}: a reinstall was refused: {e}"));
                        }
                    }
                }
            }
        }
    }
    assert!(failed.is_empty(), "{}", failed.join("\n"));
}

/// X1-C29: an unreadable `extensions/state.json` is `E_STORAGE state-invalid` for list, show and uninstall (never
/// `extension-unknown`, never a packaged item listed as local); an unreadable `skills/index.json` lists no skill as
/// enabled.
#[test]
fn an_unreadable_state_is_state_invalid_and_an_unreadable_index_enables_nothing() {
    let key = test_key("test");
    let _g = env_with(&key);
    let (d, l) = home();
    populate(&l);
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
        "m.p1x",
        &module_pkg("fixture", Some(&key)),
        &opts(&[], None),
    )
    .unwrap();
    let paths = ext::paths::ExtPaths::of(&l);
    let good = fs::read(&paths.state).unwrap();
    fs::write(&paths.state, b"{ not json").unwrap();
    let is_state_invalid = |e: ExtError| e.code == "E_STORAGE" && e.reason == Some("state-invalid");
    let e = list_items(&l, &config(&l), &ListFilter::default()).unwrap_err();
    assert!(is_state_invalid(e.clone()), "{e}");
    for name in ["demo-skill", "fixture", "other-skill"] {
        let e = show_item(&l, &config(&l), name).unwrap_err();
        assert!(is_state_invalid(e.clone()), "{name}: {e}");
    }
    let e = ext::remove::uninstall(
        &l,
        &mut OfflineHost::new(&l),
        "fixture",
        &ext::remove::RemoveOpts::default(),
    )
    .unwrap_err();
    assert!(is_state_invalid(e.clone()), "{e}");

    fs::write(&paths.state, good).unwrap();
    fs::write(index::index_path(&l), b"[broken").unwrap();
    let list = list_items(&l, &config(&l), &ListFilter::default()).unwrap();
    for i in list["items"].as_array().unwrap() {
        if i["kind"] == "skill" {
            assert_eq!(i["enabled"], false, "{i}");
        }
    }
    let names: Vec<&str> = list["items"]
        .as_array()
        .unwrap()
        .iter()
        .map(|i| i["name"].as_str().unwrap())
        .collect();
    assert!(
        names.contains(&"demo-skill") && names.contains(&"other-skill"),
        "{names:?}"
    );
    let detail = show_item(&l, &config(&l), "demo-skill").unwrap();
    assert_eq!(detail["item"]["enabled"], false);
}

/// `install --enable` writes the acknowledgment into the record before it enables (the order of `ext.enable`): a kill
/// in between leaves the module acknowledged and disabled, never enabled without its acknowledgment.
#[test]
fn install_and_enable_acknowledges_before_it_enables() {
    let key = test_key("test");
    let _g = env_with(&key);
    let (d, l) = home();
    populate(&l);
    let (rec, staged) = prepare(d.path(), &l, "m.p1x", &module_pkg("fixture", Some(&key)));
    std::env::set_var("PLUR1BUS_TEST_EXT_FAIL_AT", "kill:enable.state");
    let r = install_commit(
        &l,
        &mut OfflineHost::new(&l),
        &rec,
        staged,
        &opts(&["capabilities"], Some(Agents::All)),
    );
    std::env::remove_var("PLUR1BUS_TEST_EXT_FAIL_AT");
    assert!(r.is_err());
    ext::recover(&l);
    let st = state::read(&ext::paths::ExtPaths::of(&l)).unwrap();
    assert!(st.items["fixture"].capabilities_ack.is_some());
    assert_eq!(config(&l)["modules"]["fixture"]["enabled"], false);
}
