//! Uninstall into the trash, purge, restore, trash pruning and required-by refusals (X1 Task 9; spec §6.4; X1-R18,
//! X1-R19, X1-R31, X1-R32; X1-C15; acceptance 5).
//!
//! The binary crate has no library target, so the modules the ext layer depends on are included by path (as in
//! `ext_lifecycle.rs`). No test touches a real service manager, another harness's install or a real home: every test
//! has its own temp home and the offline `ModuleHost` (or a fake one). Trash entries are aged by rewriting their
//! recorded `removedAt`, never by sleeping.
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

use ext::commit::{install_commit, Agents, InstallOpts, OfflineHost};
use ext::inspect::{self, Source};
use ext::lifecycle::{disable, enable, ToggleOpts};
use ext::list::{list_items, show_item, ListFilter};
use ext::paths::ExtPaths;
use ext::remove::{prune_trash, restore, uninstall, RemoveOpts};
use ext::{index, stage, state, worker, ExtError};
use paths::Layout;
use plur1bus_ext::pack::PayloadFile;
use plur1bus_ext::testkit::{build_package_from, test_key, TestKey};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::fs;
use std::path::Path;
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

fn base_caps() -> Value {
    json!({
        "network": { "mode": "none" },
        "filesystem": [],
        "processes": { "spawn": false },
        "harness": { "authority": "none" }
    })
}

fn wide_caps() -> Value {
    let mut c = base_caps();
    c["network"] = json!({ "mode": "any" });
    c
}

fn template(name: &str, kind: &str, version: &str, caps: Value) -> Value {
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
        "capabilities": caps
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

/// A skill with `scripts/run.sh`, built from `t` (a [`template`]).
fn skill_from(t: &Value, key: Option<&TestKey>) -> Vec<u8> {
    let name = t["name"].as_str().unwrap();
    let version = t["version"].as_str().unwrap();
    build_package_from(
        t,
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

fn skill_pkg_caps(name: &str, version: &str, caps: Value, key: &TestKey) -> Vec<u8> {
    skill_from(&template(name, "skill", version, caps), Some(key))
}

fn skill_pkg(name: &str, key: &TestKey) -> Vec<u8> {
    skill_pkg_caps(name, "1.0.0", base_caps(), key)
}

fn module_json(name: &str, version: &str, needs: &[&str]) -> Vec<u8> {
    serde_json::to_vec_pretty(&json!({
        "name": name, "version": version, "apiVersion": "1", "entry": "index.js",
        "scope": "installation", "priority": 500, "needs": needs
    }))
    .unwrap()
}

fn module_pkg_caps(name: &str, version: &str, caps: Value, key: &TestKey) -> Vec<u8> {
    build_package_from(
        &template(name, "module", version, caps),
        vec![
            f("module.json", &module_json(name, version, &[]), false),
            f(
                "index.js",
                format!("// fixture {version}\n").as_bytes(),
                false,
            ),
        ],
        Some(key),
    )
}

fn module_pkg(name: &str, key: &TestKey) -> Vec<u8> {
    module_pkg_caps(name, "1.0.0", base_caps(), key)
}

/// A local module directory (no package record) that `needs` the given modules.
fn local_module(l: &Layout, name: &str, needs: &[&str]) {
    let dir = l.modules_dir().join(name);
    fs::create_dir_all(&dir).unwrap();
    fs::write(dir.join("module.json"), module_json(name, "0.1.0", needs)).unwrap();
    fs::write(dir.join("index.js"), "//\n").unwrap();
}

fn sha_hex(b: &[u8]) -> String {
    Sha256::digest(b)
        .iter()
        .map(|x| format!("{x:02x}"))
        .collect()
}

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

/// `skills/`, `modules/`, `extensions/`, `config.json`, `data/` and the audit log.
fn guarded(l: &Layout) -> Vec<String> {
    let mut v: Vec<String> = ["skills", "modules", "extensions", "config.json", "data"]
        .iter()
        .map(|n| format!("{n}: {}", tree_hash(&l.home.join(n))))
        .collect();
    v.push(format!("audit: {}", tree_hash(&l.audit_log())));
    v
}

fn write_config(l: &Layout, edit: impl FnOnce(&mut Value)) {
    let mut c = plur1bus_config::defaults();
    edit(&mut c);
    plur1bus_config::validate(&c).unwrap();
    plur1bus_config::write_atomic(&l.config_path(), &c).unwrap();
}

fn config(l: &Layout) -> Value {
    serde_json::from_str(&fs::read_to_string(l.config_path()).unwrap()).unwrap()
}

/// Config with the agents `bernd` and `anna`.
fn two_agents(l: &Layout) {
    write_config(l, |c| {
        c["agents"] = json!({
            "bernd": {"createdAt": "2026-09-28T10:00:00.000Z"},
            "anna": {"createdAt": "2026-09-28T10:00:00.000Z"}
        })
    });
}

fn blocked(l: &Layout, agent: &str) -> Value {
    config(l)["agents"][agent]["skills"]["blocked"].clone()
}

fn reason(e: &ExtError) -> (&'static str, &'static str) {
    (e.code, e.reason.unwrap_or(""))
}

/// Inspects, stages and installs `bytes` through the offline host.
fn install(
    d: &Path,
    l: &Layout,
    file: &str,
    bytes: &[u8],
    o: &InstallOpts,
) -> Result<Value, ExtError> {
    let p = d.join(file);
    fs::write(&p, bytes).unwrap();
    let id = worker::new_inspection_id();
    let rec = inspect::inspect(l, Source::Path(p), &id).unwrap();
    let staged = stage::stage(l, &id).unwrap();
    install_commit(l, &mut OfflineHost::new(l), &rec, staged, o)
}

fn plain() -> InstallOpts {
    InstallOpts::default()
}

fn acked() -> InstallOpts {
    InstallOpts {
        acknowledge: vec!["capabilities".into()],
        enable: None,
    }
}

fn toggle(agents: Option<Agents>, ack: bool, dry_run: bool) -> ToggleOpts {
    ToggleOpts {
        agents,
        acknowledge: if ack {
            vec!["capabilities".into()]
        } else {
            vec![]
        },
        dry_run,
    }
}

fn on(l: &Layout, name: &str, o: &ToggleOpts) -> Result<Value, ExtError> {
    enable(l, &mut OfflineHost::new(l), name, o)
}

fn off(l: &Layout, name: &str, o: &ToggleOpts) -> Result<Value, ExtError> {
    disable(l, &mut OfflineHost::new(l), name, o)
}

fn some(ids: &[&str]) -> Option<Agents> {
    Some(Agents::Some(ids.iter().map(|s| s.to_string()).collect()))
}

fn item(l: &Layout, name: &str) -> Value {
    let list = list_items(l, &config(l), &ListFilter::default());
    list["items"]
        .as_array()
        .unwrap()
        .iter()
        .find(|i| i["name"] == name)
        .cloned()
        .unwrap_or_else(|| panic!("{name} not listed: {list}"))
}

fn index_enabled(l: &Layout, name: &str) -> Option<bool> {
    index::read_index(l)
        .unwrap()
        .entry(name)
        .map(|e| e["enabled"] == true)
}

fn record(l: &Layout, name: &str) -> state::ItemRecord {
    state::read(&ExtPaths::of(l)).unwrap().items[name].clone()
}

fn audit_lines(l: &Layout) -> Vec<Value> {
    fs::read_to_string(l.audit_log())
        .unwrap_or_default()
        .lines()
        .map(|x| serde_json::from_str(x).unwrap())
        .collect()
}

fn revoke(d: &Path, id: &str) {
    let revs = d.join("revocations.json");
    fs::write(
        &revs,
        json!({"revocations": [{"id": id, "versions": "*", "action": "disable", "reason": "bad"}]})
            .to_string(),
    )
    .unwrap();
    std::env::set_var("PLUR1BUS_TEST_EXT_REVOCATIONS", &revs);
}

fn rm(l: &Layout, name: &str, purge: bool, cascade: bool) -> Result<Value, ExtError> {
    uninstall(
        l,
        &mut OfflineHost::new(l),
        name,
        &RemoveOpts { purge, cascade },
    )
}

fn back(l: &Layout, trash_id: &str) -> Result<Value, ExtError> {
    restore(l, &mut OfflineHost::new(l), trash_id)
}

fn trash(l: &Layout) -> std::path::PathBuf {
    l.extensions().join("trash")
}

fn trash_ids(l: &Layout) -> Vec<String> {
    let mut v: Vec<String> = fs::read_dir(trash(l))
        .map(|r| {
            r.flatten()
                .map(|e| e.file_name().to_string_lossy().into_owned())
                .collect()
        })
        .unwrap_or_default();
    v.sort();
    v
}

fn trash_record(l: &Layout, tid: &str) -> Value {
    serde_json::from_str(&fs::read_to_string(trash(l).join(tid).join("record.json")).unwrap())
        .unwrap()
}

/// Rewrites a trash entry's recorded `removedAt` to `days` days ago.
fn backdate(l: &Layout, tid: &str, days: u64) {
    let p = trash(l).join(tid).join("record.json");
    let mut v: Value = serde_json::from_str(&fs::read_to_string(&p).unwrap()).unwrap();
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_millis() as u64;
    v["removedAt"] = json!(iso(now - days * 86_400_000));
    fs::write(&p, serde_json::to_string_pretty(&v).unwrap()).unwrap();
}

fn iso(ms: u64) -> String {
    ext::iso8601(ms)
}

fn listed(l: &Layout, name: &str) -> Option<Value> {
    list_items(l, &config(l), &ListFilter::default())["items"]
        .as_array()
        .unwrap()
        .iter()
        .find(|i| i["name"] == name)
        .cloned()
}

fn has_record(l: &Layout, name: &str) -> bool {
    state::read(&ExtPaths::of(l))
        .unwrap()
        .items
        .contains_key(name)
}

fn trash_id_ok(tid: &str, name: &str, version: &str) -> bool {
    let Some(stamp) = tid.strip_prefix(&format!("{name}-{version}-")) else {
        return false;
    };
    let b = stamp.as_bytes();
    b.len() == 16
        && b[8] == b'T'
        && b[15] == b'Z'
        && b[..8].iter().chain(&b[9..15]).all(u8::is_ascii_digit)
}

/// A module `fixture` installed and enabled, with a file in `data/ext/fixture/`.
fn enabled_module(d: &Path, l: &Layout, key: &TestKey) {
    install(d, l, "m.p1x", &module_pkg("fixture", key), &plain()).unwrap();
    on(l, "fixture", &toggle(None, true, false)).unwrap();
    fs::write(l.ext_data("fixture").join("notes.txt"), "kept\n").unwrap();
}

/// A skill `demo-skill` installed, enabled for `bernd` only, with a file in `data/ext/demo-skill/`.
fn enabled_skill(d: &Path, l: &Layout, key: &TestKey) {
    install(d, l, "s.p1x", &skill_pkg("demo-skill", key), &plain()).unwrap();
    on(l, "demo-skill", &toggle(some(&["bernd"]), true, false)).unwrap();
    fs::write(l.ext_data("demo-skill").join("notes.txt"), "kept\n").unwrap();
}

// ---- uninstall and purge (acceptance 5, part 1; X1-R19, X1-R31) -----------------------------------------------------

#[test]
fn uninstall_keeps_data_and_config_and_moves_code_to_the_trash() {
    let key = test_key("test");
    let _g = env_with(&key);
    let (d, l) = home();
    two_agents(&l);
    enabled_module(d.path(), &l, &key);
    enabled_skill(d.path(), &l, &key);
    let module_code = tree_hash(&l.modules_dir().join("fixture"));
    let skill_code = tree_hash(&l.skills().join("demo-skill"));
    let module_sha = record(&l, "fixture").package_sha256;
    let section = config(&l)["modules"]["fixture"].clone();
    assert_eq!(section["enabled"], true);

    for (name, kind, code, sha) in [
        ("fixture", "module", &module_code, &module_sha),
        (
            "demo-skill",
            "skill",
            &skill_code,
            &record(&l, "demo-skill").package_sha256,
        ),
    ] {
        let mut host = OfflineHost::new(&l);
        let v = uninstall(
            &l,
            &mut host,
            name,
            &RemoveOpts {
                purge: false,
                cascade: false,
            },
        )
        .unwrap();
        let tid = v["trashId"].as_str().unwrap().to_string();
        assert_eq!(
            v,
            json!({"name": name, "removed": true, "trashId": tid, "purged": false})
        );
        assert!(trash_id_ok(&tid, name, "1.0.0"), "{tid}");
        let entry = trash(&l).join(&tid);
        assert_eq!(&tree_hash(&entry.join("code")), code, "{name}");
        assert!(entry.join("package.p1x").is_file(), "{name}");
        assert_eq!(sha_hex(&fs::read(entry.join("package.p1x")).unwrap()), *sha);
        assert!(!entry.join("data").exists() && !entry.join("config.json").exists());
        let rj = trash_record(&l, &tid);
        assert_eq!(
            (&rj["name"], &rj["kind"], &rj["version"], &rj["reason"]),
            (
                &json!(name),
                &json!(kind),
                &json!("1.0.0"),
                &json!("uninstalled")
            )
        );
        assert_eq!(rj["record"]["name"], name);
        // Code, record and index entry are gone; data stays.
        assert!(!has_record(&l, name));
        assert!(listed(&l, name).is_none(), "{name}");
        assert_eq!(
            fs::read_to_string(l.ext_data(name).join("notes.txt")).unwrap(),
            "kept\n"
        );
        let n = host.notified.last().unwrap();
        assert_eq!(
            (&n["name"], &n["state"], &n["version"], &n["overlays"]),
            (&json!(name), &json!("removed"), &json!("1.0.0"), &json!([]))
        );
        let a = audit_lines(&l);
        let last = a.last().unwrap();
        assert_eq!(
            (&last["action"], &last["target"]),
            (&json!("ext.uninstall"), &json!(name))
        );
        assert_eq!(last["detail"]["trashId"], tid);
        assert_eq!(last["detail"]["via"], "offline");
        // ext.show of the uninstalled name is unknown.
        let e = show_item(&l, &config(&l), name).unwrap_err();
        assert_eq!(reason(&e), ("E_NOT_FOUND", "extension-unknown"));
    }
    assert!(!l.modules_dir().join("fixture").exists());
    assert!(!l.skills().join("demo-skill").exists());
    assert!(index_enabled(&l, "demo-skill").is_none());
    // The module's config section stays (D14), and so do the agent lists of the skill.
    assert_eq!(config(&l)["modules"]["fixture"], section);
    assert_eq!(blocked(&l, "anna"), json!(["demo-skill"]));
    // The cached package moved to the trash.
    assert!(!ExtPaths::of(&l).cached(&module_sha).exists());
}

#[test]
fn purge_moves_data_and_removes_the_config_section_and_says_no_secrets_exist() {
    let key = test_key("test");
    let _g = env_with(&key);
    let (d, l) = home();
    write_config(&l, |c| {
        c["agents"] = json!({
            "bernd": {"createdAt": "2026-09-28T10:00:00.000Z", "skills": {"blocked": ["other"], "pinned": ["demo-skill", "x"]}},
            "anna": {"createdAt": "2026-09-28T10:00:00.000Z"}
        })
    });
    enabled_module(d.path(), &l, &key);
    enabled_skill(d.path(), &l, &key);
    assert_eq!(blocked(&l, "anna"), json!(["demo-skill"]));
    let section = config(&l)["modules"]["fixture"].clone();

    let v = rm(&l, "fixture", true, false).unwrap();
    assert_eq!(v["purged"], true);
    let tid = v["trashId"].as_str().unwrap().to_string();
    let entry = trash(&l).join(&tid);
    assert_eq!(
        fs::read_to_string(entry.join("data/notes.txt")).unwrap(),
        "kept\n"
    );
    assert!(!l.ext_data("fixture").exists());
    let saved: Value =
        serde_json::from_str(&fs::read_to_string(entry.join("config.json")).unwrap()).unwrap();
    assert_eq!(saved, json!({ "modules.fixture": section }));
    assert!(config(&l)["modules"].get("fixture").is_none());
    assert_eq!(trash_record(&l, &tid)["reason"], "purged");
    let a = audit_lines(&l);
    let last = a.last().unwrap();
    assert_eq!(
        (&last["action"], &last["target"]),
        (&json!("ext.purge"), &json!("fixture"))
    );
    // X1-R31: no secret store exists yet, so nothing secret was deleted, and the line says so.
    assert_eq!(last["detail"]["secrets"], json!([]));
    assert_eq!(
        last["detail"]["moved"],
        json!(["data/ext/fixture", "modules.fixture"])
    );

    // A skill: its data moves, and its name leaves every agent's blocked and pinned lists.
    let v = rm(&l, "demo-skill", true, false).unwrap();
    let entry = trash(&l).join(v["trashId"].as_str().unwrap());
    assert!(entry.join("data/notes.txt").is_file());
    assert!(!l.ext_data("demo-skill").exists());
    let c = config(&l);
    assert_eq!(c["agents"]["anna"]["skills"]["blocked"], json!([]));
    assert_eq!(c["agents"]["bernd"]["skills"]["blocked"], json!(["other"]));
    assert_eq!(c["agents"]["bernd"]["skills"]["pinned"], json!(["x"]));
    let last = audit_lines(&l).pop().unwrap();
    assert_eq!(last["action"], "ext.purge");
    assert_eq!(last["detail"]["secrets"], json!([]));
}

// ---- restore (acceptance 5, part 2) --------------------------------------------------------------------------------

#[test]
fn restore_within_the_window_brings_the_item_back_disabled_with_data_and_config() {
    let key = test_key("test");
    let _g = env_with(&key);
    let (d, l) = home();
    two_agents(&l);
    enabled_module(d.path(), &l, &key);
    enabled_skill(d.path(), &l, &key);
    let module_code = tree_hash(&l.modules_dir().join("fixture"));
    let skill_code = tree_hash(&l.skills().join("demo-skill"));
    let module_rec = record(&l, "fixture");
    let skill_rec = record(&l, "demo-skill");

    let mt = rm(&l, "fixture", true, false).unwrap()["trashId"]
        .as_str()
        .unwrap()
        .to_string();
    let st = rm(&l, "demo-skill", true, false).unwrap()["trashId"]
        .as_str()
        .unwrap()
        .to_string();
    // ext.show lists nothing for a removed name, but the trash keeps both entries.
    assert_eq!(trash_ids(&l), {
        let mut v = vec![mt.clone(), st.clone()];
        v.sort();
        v
    });

    let mut host = OfflineHost::new(&l);
    let v = restore(&l, &mut host, &mt).unwrap();
    assert_eq!(
        v,
        json!({"name": "fixture", "version": "1.0.0", "state": "installed"})
    );
    assert_eq!(tree_hash(&l.modules_dir().join("fixture")), module_code);
    assert_eq!(
        fs::read_to_string(l.ext_data("fixture").join("notes.txt")).unwrap(),
        "kept\n"
    );
    // The config section is back, disabled.
    assert_eq!(config(&l)["modules"]["fixture"]["enabled"], false);
    let r = record(&l, "fixture");
    assert_eq!(
        (&r.id, &r.version, &r.package_sha256, &r.files),
        (
            &module_rec.id,
            &module_rec.version,
            &module_rec.package_sha256,
            &module_rec.files
        )
    );
    assert!(!r.removed_by_user);
    assert!(ExtPaths::of(&l).cached(&r.package_sha256).is_file());
    let it = listed(&l, "fixture").unwrap();
    assert_eq!(
        (&it["state"], &it["enabled"]),
        (&json!("installed"), &json!(false))
    );
    assert!(!trash(&l).join(&mt).exists());
    let n = host.notified.last().unwrap();
    assert_eq!(
        (&n["name"], &n["state"]),
        (&json!("fixture"), &json!("installed"))
    );
    let last = audit_lines(&l).pop().unwrap();
    assert_eq!(
        (&last["action"], &last["target"], &last["detail"]["trashId"]),
        (&json!("ext.restore"), &json!("fixture"), &json!(mt))
    );

    let v = back(&l, &st).unwrap();
    assert_eq!(
        v,
        json!({"name": "demo-skill", "version": "1.0.0", "state": "installed"})
    );
    assert_eq!(tree_hash(&l.skills().join("demo-skill")), skill_code);
    assert!(l.ext_data("demo-skill").join("notes.txt").is_file());
    assert_eq!(index_enabled(&l, "demo-skill"), Some(false));
    let e = index::read_index(&l)
        .unwrap()
        .entry("demo-skill")
        .cloned()
        .unwrap();
    assert_eq!(e["package"]["id"], "demo/demo-skill");
    assert_eq!(record(&l, "demo-skill").files, skill_rec.files);
    assert_eq!(listed(&l, "demo-skill").unwrap()["state"], "installed");
    assert!(trash_ids(&l).is_empty());

    // Both enable again, without a new acknowledgment (the capabilities did not change).
    on(&l, "fixture", &toggle(None, false, false)).unwrap();
    on(&l, "demo-skill", &toggle(None, false, false)).unwrap();
}

#[test]
fn restore_after_the_window_is_trash_expired() {
    let key = test_key("test");
    let _g = env_with(&key);
    let (d, l) = home();
    write_config(&l, |c| c["extensions"]["trashDays"] = json!(1));
    install(
        d.path(),
        &l,
        "s.p1x",
        &skill_pkg("demo-skill", &key),
        &plain(),
    )
    .unwrap();
    let tid = rm(&l, "demo-skill", false, false).unwrap()["trashId"]
        .as_str()
        .unwrap()
        .to_string();
    backdate(&l, &tid, 2);
    let e = back(&l, &tid).unwrap_err();
    assert_eq!(reason(&e), ("E_NOT_FOUND", "trash-expired"));
    assert!(!l.skills().join("demo-skill").exists());
    assert!(!has_record(&l, "demo-skill"));
    // A refusal writes nothing, not even the pruning (X1-C16): the expired entry stays until a writing mutation.
    assert!(trash(&l).join(&tid).is_dir());

    for missing in [
        "no-such-entry-1.0.0-20260101T000000Z",
        "../escape",
        "",
        "a/b",
    ] {
        let e = back(&l, missing).unwrap_err();
        assert_eq!(reason(&e), ("E_NOT_FOUND", "trash-expired"), "{missing:?}");
    }
}

#[test]
fn restore_onto_a_taken_name_is_name_taken() {
    let key = test_key("test");
    let _g = env_with(&key);
    let (d, l) = home();
    install(
        d.path(),
        &l,
        "s.p1x",
        &skill_pkg("demo-skill", &key),
        &plain(),
    )
    .unwrap();
    let tid = rm(&l, "demo-skill", false, false).unwrap()["trashId"]
        .as_str()
        .unwrap()
        .to_string();
    // The same name installed again from the package.
    install(
        d.path(),
        &l,
        "s2.p1x",
        &skill_pkg("demo-skill", &key),
        &plain(),
    )
    .unwrap();
    let before = guarded(&l);
    let e = back(&l, &tid).unwrap_err();
    assert_eq!(reason(&e), ("E_CONFLICT", "name-taken"));
    assert_eq!(guarded(&l), before);

    // A hand-made folder of that name takes it too.
    rm(&l, "demo-skill", false, false).unwrap();
    let dir = l.skills().join("demo-skill");
    fs::create_dir_all(&dir).unwrap();
    fs::write(dir.join("SKILL.md"), skill_md("demo-skill")).unwrap();
    let e = back(&l, &tid).unwrap_err();
    assert_eq!(reason(&e), ("E_CONFLICT", "name-taken"));
    assert!(trash(&l).join(&tid).join("code").is_dir());
}

// ---- refusals ------------------------------------------------------------------------------------------------------

#[test]
fn uninstall_of_a_required_module_is_required_by_and_cascade_disables_dependents_first() {
    let key = test_key("test");
    let _g = env_with(&key);
    let (d, l) = home();
    write_config(&l, |_| {});
    enabled_module(d.path(), &l, &key);
    local_module(&l, "fixture-b", &["fixture"]);
    local_module(&l, "fixture-c", &["fixture-b"]);
    local_module(&l, "fixture-d", &["fixture"]);
    // A disabled module does not require anything.
    write_config(
        &l,
        |c| c["modules"] = json!({ "fixture": {"enabled": true}, "fixture-d": {"enabled": false} }),
    );

    let before = guarded(&l);
    let e = rm(&l, "fixture", false, false).unwrap_err();
    assert_eq!(reason(&e), ("E_CONFLICT", "required-by"));
    assert_eq!(e.data["dependents"], json!(["fixture-b", "fixture-c"]));
    assert_eq!(guarded(&l), before);
    // ext.show names the same dependents uninstall refuses for.
    let detail = show_item(&l, &config(&l), "fixture").unwrap();
    assert_eq!(detail["dependents"], e.data["dependents"]);

    let v = rm(&l, "fixture", false, true).unwrap();
    assert_eq!(v["removed"], true);
    let c = config(&l);
    assert_eq!(c["modules"]["fixture-b"]["enabled"], false);
    assert_eq!(c["modules"]["fixture-c"]["enabled"], false);
    assert!(!l.modules_dir().join("fixture").exists());
    let actions: Vec<(Value, Value)> = audit_lines(&l)
        .iter()
        .rev()
        .take(3)
        .map(|a| (a["action"].clone(), a["target"].clone()))
        .collect();
    assert_eq!(actions[0], (json!("ext.uninstall"), json!("fixture")));
    assert!(actions[1..].iter().all(|(a, _)| a == &json!("ext.disable")));
    let mut disabled: Vec<Value> = actions[1..].iter().map(|(_, t)| t.clone()).collect();
    disabled.sort_by_key(|t| t.to_string());
    assert_eq!(disabled, [json!("fixture-b"), json!("fixture-c")]);
}

#[test]
fn uninstall_of_a_bundled_skill_hides_it_and_purge_is_denied() {
    let key = test_key("test");
    let _g = env_with(&key);
    let (_d, l) = home();
    write_config(&l, |_| {});
    fs::write(
        l.install_manifest(),
        json!({"skills": [{"name": "ops", "source": "bundled", "version": "1.2.0"}]}).to_string(),
    )
    .unwrap();
    let dir = l.skills().join("ops");
    fs::create_dir_all(&dir).unwrap();
    fs::write(dir.join("SKILL.md"), skill_md("ops")).unwrap();
    let code = tree_hash(&dir);
    assert_eq!(listed(&l, "ops").unwrap()["source"], "bundled");

    let before = guarded(&l);
    let e = rm(&l, "ops", true, false).unwrap_err();
    assert_eq!(reason(&e), ("E_DENIED", "bundled"));
    assert_eq!(guarded(&l), before);

    let v = rm(&l, "ops", false, false).unwrap();
    assert_eq!(
        v,
        json!({"name": "ops", "removed": true, "trashId": null, "purged": false})
    );
    // Hidden, not moved: the folder stays for `setup` to find, the index entry is disabled, the record a tombstone.
    assert_eq!(tree_hash(&dir), code);
    assert!(trash_ids(&l).is_empty());
    assert_eq!(index_enabled(&l, "ops"), Some(false));
    let r = state::read(&ExtPaths::of(&l)).unwrap().items["ops"].clone();
    assert!(r.removed_by_user);
    assert_eq!(
        (r.source.as_str(), r.version.as_str()),
        ("bundled", "1.2.0")
    );
    assert!(listed(&l, "ops").is_none());
    assert_eq!(audit_lines(&l).pop().unwrap()["action"], "ext.uninstall");
    // A hidden item is unknown to every later mutation.
    let e = on(&l, "ops", &toggle(None, false, false)).unwrap_err();
    assert_eq!(reason(&e), ("E_NOT_FOUND", "extension-unknown"));
    let e = rm(&l, "ops", false, false).unwrap_err();
    assert_eq!(reason(&e), ("E_NOT_FOUND", "extension-unknown"));
}

#[test]
fn uninstall_of_an_unknown_name_is_extension_unknown() {
    let key = test_key("test");
    let _g = env_with(&key);
    let (_d, l) = home();
    let e = rm(&l, "demo-skill", false, false).unwrap_err();
    assert_eq!(reason(&e), ("E_NOT_FOUND", "extension-unknown"));
}

// ---- the trash (X1-R19) --------------------------------------------------------------------------------------------

#[test]
fn prune_removes_only_expired_entries() {
    let key = test_key("test");
    let _g = env_with(&key);
    let (d, l) = home();
    let mut ids = Vec::new();
    for n in ["demo-a", "demo-b", "demo-c"] {
        install(
            d.path(),
            &l,
            &format!("{n}.p1x"),
            &skill_pkg(n, &key),
            &plain(),
        )
        .unwrap();
        ids.push(
            rm(&l, n, false, false).unwrap()["trashId"]
                .as_str()
                .unwrap()
                .to_string(),
        );
    }
    backdate(&l, &ids[0], 15);
    backdate(&l, &ids[1], 13);
    // An entry a live commit is still building is not the pruner's.
    let building = trash(&l).join(format!(
        "demo-z-1.0.0-20200101T000000Z.tmp-{}",
        std::process::id()
    ));
    fs::create_dir_all(&building).unwrap();

    assert_eq!(prune_trash(&l, 14), vec![ids[0].clone()]);
    assert!(!trash(&l).join(&ids[0]).exists());
    assert!(trash(&l).join(&ids[1]).is_dir() && trash(&l).join(&ids[2]).is_dir());
    assert!(building.is_dir());
    assert_eq!(prune_trash(&l, 14), Vec::<String>::new());
    assert_eq!(prune_trash(&l, 12), vec![ids[1].clone()]);
}

type Mutation = Box<dyn Fn(&Layout)>;

/// `prune_trash` runs first in every mutation: install, enable, disable, uninstall, restore.
#[test]
fn every_mutation_prunes_the_expired_trash_first() {
    let key = test_key("test");
    let _g = env_with(&key);
    let (d, l) = home();
    write_config(&l, |_| {});
    install(
        d.path(),
        &l,
        "k.p1x",
        &skill_pkg("demo-keep", &key),
        &plain(),
    )
    .unwrap();
    let mutations: Vec<(&str, Mutation)> = vec![
        (
            "enable",
            Box::new(|l| {
                on(l, "demo-keep", &toggle(None, true, false)).unwrap();
            }),
        ),
        (
            "disable",
            Box::new(|l| {
                enable(
                    l,
                    &mut OfflineHost::new(l),
                    "demo-keep",
                    &toggle(None, false, false),
                )
                .unwrap();
                ext::lifecycle::disable(
                    l,
                    &mut OfflineHost::new(l),
                    "demo-keep",
                    &toggle(None, false, false),
                )
                .unwrap();
            }),
        ),
        (
            "uninstall",
            Box::new(|l| {
                rm(l, "demo-keep", false, false).unwrap();
            }),
        ),
    ];
    for (what, run) in mutations {
        install(
            d.path(),
            &l,
            "g.p1x",
            &skill_pkg("demo-gone", &key),
            &plain(),
        )
        .unwrap();
        let tid = rm(&l, "demo-gone", false, false).unwrap()["trashId"]
            .as_str()
            .unwrap()
            .to_string();
        backdate(&l, &tid, 30);
        run(&l);
        assert!(!trash(&l).join(&tid).exists(), "{what} did not prune");
    }
    // install and restore
    let keep = trash_ids(&l)
        .into_iter()
        .find(|t| t.starts_with("demo-keep-"))
        .unwrap();
    install(
        d.path(),
        &l,
        "g.p1x",
        &skill_pkg("demo-gone", &key),
        &plain(),
    )
    .unwrap();
    let tid = rm(&l, "demo-gone", false, false).unwrap()["trashId"]
        .as_str()
        .unwrap()
        .to_string();
    backdate(&l, &tid, 30);
    back(&l, &keep).unwrap();
    assert!(!trash(&l).join(&tid).exists(), "restore did not prune");
    install(
        d.path(),
        &l,
        "g.p1x",
        &skill_pkg("demo-gone", &key),
        &plain(),
    )
    .unwrap();
    let tid = rm(&l, "demo-gone", false, false).unwrap()["trashId"]
        .as_str()
        .unwrap()
        .to_string();
    backdate(&l, &tid, 30);
    install(
        d.path(),
        &l,
        "o.p1x",
        &skill_pkg("demo-other", &key),
        &plain(),
    )
    .unwrap();
    assert!(!trash(&l).join(&tid).exists(), "install did not prune");
}

#[test]
fn uninstall_restore_uninstall_round_trips_byte_identical_code() {
    let key = test_key("test");
    let _g = env_with(&key);
    let (d, l) = home();
    write_config(&l, |_| {});
    install(
        d.path(),
        &l,
        "s.p1x",
        &skill_pkg("demo-skill", &key),
        &plain(),
    )
    .unwrap();
    install(
        d.path(),
        &l,
        "m.p1x",
        &module_pkg("fixture", &key),
        &plain(),
    )
    .unwrap();
    for (name, dir) in [
        ("demo-skill", l.skills().join("demo-skill")),
        ("fixture", l.modules_dir().join("fixture")),
    ] {
        let code = tree_hash(&dir);
        let rec = record(&l, name);
        let t1 = rm(&l, name, false, false).unwrap()["trashId"]
            .as_str()
            .unwrap()
            .to_string();
        assert_eq!(tree_hash(&trash(&l).join(&t1).join("code")), code, "{name}");
        back(&l, &t1).unwrap();
        assert_eq!(tree_hash(&dir), code, "{name}");
        assert_eq!(record(&l, name).files, rec.files);
        let t2 = rm(&l, name, false, false).unwrap()["trashId"]
            .as_str()
            .unwrap()
            .to_string();
        assert_eq!(tree_hash(&trash(&l).join(&t2).join("code")), code, "{name}");
        assert!(!dir.exists());
    }
}

// ---- failures and kills ---------------------------------------------------------------------------------------------

/// A failure at any step of an uninstall or a restore undoes the steps done so far: the tree ends byte-identical and
/// no audit line is written.
#[test]
fn a_failed_uninstall_or_restore_rolls_back_to_a_byte_identical_tree() {
    let key = test_key("test");
    let _g = env_with(&key);
    let mut failed = Vec::new();
    for kind in ["skill", "module"] {
        let name = if kind == "skill" {
            "demo-skill"
        } else {
            "fixture"
        };
        for step in [
            "uninstall.trash",
            "uninstall.code",
            "uninstall.state",
            "uninstall.index",
            "uninstall.data",
            "uninstall.config",
        ] {
            let (d, l) = home();
            two_agents(&l);
            if kind == "skill" {
                enabled_skill(d.path(), &l, &key);
            } else {
                enabled_module(d.path(), &l, &key);
            }
            let before = guarded(&l);
            std::env::set_var("PLUR1BUS_TEST_EXT_FAIL_AT", step);
            let r = rm(&l, name, true, false);
            std::env::remove_var("PLUR1BUS_TEST_EXT_FAIL_AT");
            if kind == "module" && step == "uninstall.index" {
                // A module has no index step.
                if r.is_err() {
                    failed.push(format!("{kind}/{step}: {r:?}"));
                }
                continue;
            }
            if r.is_ok() {
                failed.push(format!("{kind}/{step}: the seam did not fire"));
            } else if guarded(&l) != before {
                failed.push(format!("{kind}/{step}: the tree changed"));
            }
        }
        for step in [
            "restore.config",
            "restore.index",
            "restore.code",
            "restore.state",
            "restore.data",
        ] {
            let (d, l) = home();
            two_agents(&l);
            if kind == "skill" {
                enabled_skill(d.path(), &l, &key);
            } else {
                enabled_module(d.path(), &l, &key);
            }
            let tid = rm(&l, name, true, false).unwrap()["trashId"]
                .as_str()
                .unwrap()
                .to_string();
            let before = guarded(&l);
            std::env::set_var("PLUR1BUS_TEST_EXT_FAIL_AT", step);
            let r = back(&l, &tid);
            std::env::remove_var("PLUR1BUS_TEST_EXT_FAIL_AT");
            let skipped = (kind == "skill" && step == "restore.config")
                || (kind == "module" && step == "restore.index");
            if skipped {
                if r.is_err() {
                    failed.push(format!("{kind}/{step}: {r:?}"));
                }
                continue;
            }
            if r.is_ok() {
                failed.push(format!("{kind}/{step}: the seam did not fire"));
            } else if guarded(&l) != before {
                failed.push(format!("{kind}/{step}: the tree changed"));
            }
        }
    }
    assert!(failed.is_empty(), "{}", failed.join("\n"));
}

/// An uninstall killed after the code moved (record and entry still there) is undone by `ext::recover`; one killed
/// after the record went is complete as an uninstall, and the entry restores.
#[test]
fn a_killed_uninstall_recovers_to_installed_or_uninstalled() {
    let key = test_key("test");
    let _g = env_with(&key);
    let (d, l) = home();
    write_config(&l, |_| {});
    install(
        d.path(),
        &l,
        "s.p1x",
        &skill_pkg("demo-skill", &key),
        &plain(),
    )
    .unwrap();
    let code = tree_hash(&l.skills().join("demo-skill"));
    std::env::set_var("PLUR1BUS_TEST_EXT_FAIL_AT", "kill:uninstall.code");
    assert!(rm(&l, "demo-skill", false, false).is_err());
    std::env::remove_var("PLUR1BUS_TEST_EXT_FAIL_AT");
    assert!(!l.skills().join("demo-skill").exists());
    ext::recover(&l);
    assert_eq!(tree_hash(&l.skills().join("demo-skill")), code);
    assert_eq!(listed(&l, "demo-skill").unwrap()["state"], "installed");
    assert!(trash_ids(&l).is_empty(), "{:?}", trash_ids(&l));

    std::env::set_var("PLUR1BUS_TEST_EXT_FAIL_AT", "kill:uninstall.state");
    assert!(rm(&l, "demo-skill", false, false).is_err());
    std::env::remove_var("PLUR1BUS_TEST_EXT_FAIL_AT");
    ext::recover(&l);
    assert!(listed(&l, "demo-skill").is_none());
    assert!(index_enabled(&l, "demo-skill").is_none());
    let tid = trash_ids(&l).pop().unwrap();
    back(&l, &tid).unwrap();
    assert_eq!(tree_hash(&l.skills().join("demo-skill")), code);
}

/// X1-C15: a skill replace killed between the old folder's move into the trash and the new folder's move into place
/// leaves the record, a disabled entry and no folder; `ext::recover` puts the old code back from the trash.
#[test]
fn recover_puts_back_the_code_of_a_replace_killed_between_trash_and_place() {
    let key = test_key("test");
    let _g = env_with(&key);
    let (d, l) = home();
    write_config(&l, |_| {});
    install(
        d.path(),
        &l,
        "s.p1x",
        &skill_pkg("demo-skill", &key),
        &acked(),
    )
    .unwrap();
    on(&l, "demo-skill", &toggle(None, true, false)).unwrap();
    let code = tree_hash(&l.skills().join("demo-skill"));
    let old = record(&l, "demo-skill");
    let p = d.path().join("v2.p1x");
    fs::write(&p, skill_pkg_caps("demo-skill", "1.1.0", base_caps(), &key)).unwrap();
    let id = worker::new_inspection_id();
    let rec = inspect::inspect(&l, Source::Path(p), &id).unwrap();
    let staged = stage::stage(&l, &id).unwrap();
    std::env::set_var("PLUR1BUS_TEST_EXT_FAIL_AT", "kill:code.trash");
    let r = install_commit(&l, &mut OfflineHost::new(&l), &rec, staged, &acked());
    std::env::remove_var("PLUR1BUS_TEST_EXT_FAIL_AT");
    assert!(r.is_err());
    assert!(!l.skills().join("demo-skill").exists());
    assert!(has_record(&l, "demo-skill"));

    let done = ext::recover(&l);
    assert!(
        done.iter()
            .any(|x| x.contains("demo-skill") && x.contains("trash")),
        "{done:?}"
    );
    assert_eq!(tree_hash(&l.skills().join("demo-skill")), code);
    assert_eq!(record(&l, "demo-skill").version, old.version);
    let e = index::read_index(&l)
        .unwrap()
        .entry("demo-skill")
        .cloned()
        .unwrap();
    // Fails safe: the entry names the restored version, disabled.
    assert_eq!(
        (&e["package"]["version"], &e["enabled"]),
        (&json!("1.0.0"), &json!(false))
    );
    assert!(trash_ids(&l).is_empty(), "{:?}", trash_ids(&l));
    let it = listed(&l, "demo-skill").unwrap();
    assert_eq!(it["state"], "installed");
    on(&l, "demo-skill", &toggle(None, false, false)).unwrap();
}

// ---- review round 1 -------------------------------------------------------------------------------------------------

fn tid_of(v: &Value) -> String {
    v["trashId"].as_str().unwrap().to_string()
}

/// X1-C16: a refusal or a no-op writes nothing, not even the trash pruning, so an expired entry survives it.
#[test]
fn refusals_and_no_ops_leave_an_expired_trash_entry() {
    let key = test_key("test");
    let _g = env_with(&key);
    let (d, l) = home();
    write_config(&l, |_| {});
    // One build of the package, so a second install of it is the identical package (Review Focus 5).
    let taken_pkg = skill_pkg("demo-taken", &key);
    let taken = {
        install(d.path(), &l, "t.p1x", &taken_pkg, &plain()).unwrap();
        let t = tid_of(&rm(&l, "demo-taken", false, false).unwrap());
        install(d.path(), &l, "t.p1x", &taken_pkg, &plain()).unwrap();
        t
    };
    install(
        d.path(),
        &l,
        "m.p1x",
        &module_pkg("fixture", &key),
        &plain(),
    )
    .unwrap();
    on(&l, "fixture", &toggle(None, true, false)).unwrap();
    // An expired entry, made last so no writing mutation above pruned it.
    let t = "demo-old-1.0.0-20200101T000000Z".to_string();
    fs::create_dir_all(trash(&l).join(&t).join("code")).unwrap();
    fs::write(
        trash(&l).join(&t).join("record.json"),
        json!({"removedAt": "2020-01-01T00:00:00.000Z", "name": "demo-old", "kind": "skill", "version": "1.0.0"})
            .to_string(),
    )
    .unwrap();
    local_module(&l, "fixture-b", &["fixture"]);
    fs::write(
        l.install_manifest(),
        json!({"skills": [{"name": "ops", "source": "bundled", "version": "1.2.0"}]}).to_string(),
    )
    .unwrap();
    fs::create_dir_all(l.skills().join("ops")).unwrap();
    fs::write(l.skills().join("ops/SKILL.md"), skill_md("ops")).unwrap();

    let alive = |what: &str| assert!(trash(&l).join(&t).is_dir(), "{what} pruned");
    let before = guarded(&l);
    assert!(rm(&l, "no-such", false, false).is_err());
    alive("an unknown uninstall");
    assert_eq!(
        reason(&rm(&l, "fixture", false, false).unwrap_err()),
        ("E_CONFLICT", "required-by")
    );
    alive("a required-by refusal");
    assert_eq!(
        reason(&rm(&l, "ops", true, false).unwrap_err()),
        ("E_DENIED", "bundled")
    );
    alive("a bundled purge");
    assert_eq!(
        reason(&back(&l, &taken).unwrap_err()),
        ("E_CONFLICT", "name-taken")
    );
    alive("a name-taken restore");
    assert!(back(&l, "no-such-1.0.0-20260101T000000Z").is_err());
    alive("a trash-expired restore");
    // The identical package again: a no-op.
    let v = install(d.path(), &l, "t.p1x", &taken_pkg, &plain()).unwrap();
    assert_eq!(v["replaced"], false);
    alive("an identical-package install");
    // A lower version without the acknowledgment: refused.
    let e = install(
        d.path(),
        &l,
        "old.p1x",
        &skill_pkg_caps("demo-taken", "0.9.0", base_caps(), &key),
        &plain(),
    )
    .unwrap_err();
    assert_eq!(reason(&e), ("E_APPROVAL_REQUIRED", "acknowledge-downgrade"));
    alive("a refused install");
    // An enable without the acknowledgment: refused; a disable of a disabled item: a no-op.
    let e = on(&l, "demo-taken", &toggle(None, false, false)).unwrap_err();
    assert_eq!(
        reason(&e),
        ("E_APPROVAL_REQUIRED", "acknowledge-capabilities")
    );
    alive("a refused enable");
    disable(
        &l,
        &mut OfflineHost::new(&l),
        "demo-taken",
        &toggle(None, false, false),
    )
    .unwrap();
    alive("a no-op disable");
    assert_eq!(guarded(&l), before);
}

/// X1-C17: an uninstall that fails after its cascade names the dependents it disabled, which stay disabled.
#[test]
fn a_cascade_uninstall_that_fails_names_the_dependents_it_disabled() {
    let key = test_key("test");
    let _g = env_with(&key);
    let (d, l) = home();
    write_config(&l, |_| {});
    enabled_module(d.path(), &l, &key);
    local_module(&l, "fixture-b", &["fixture"]);
    local_module(&l, "fixture-c", &["fixture-b"]);
    std::env::set_var("PLUR1BUS_TEST_EXT_FAIL_AT", "uninstall.code");
    let e = rm(&l, "fixture", false, true).unwrap_err();
    std::env::remove_var("PLUR1BUS_TEST_EXT_FAIL_AT");
    assert_eq!(
        e.data["disabledDependents"],
        json!(["fixture-b", "fixture-c"])
    );
    assert!(e.message.contains("fixture-b"), "{}", e.message);
    let c = config(&l);
    assert_eq!(c["modules"]["fixture-b"]["enabled"], false);
    assert_eq!(c["modules"]["fixture-c"]["enabled"], false);
    assert!(l.modules_dir().join("fixture").is_dir());
    assert!(has_record(&l, "fixture"));
}

/// The cached package leaves the cache only after the record: a kill before that keeps it, a kill after it leaves the
/// item uninstalled with the package in its trash entry, and recover puts a lost cache file back before it drops an
/// entry.
#[test]
fn a_killed_uninstall_never_loses_the_cached_package() {
    let key = test_key("test");
    let _g = env_with(&key);
    let (d, l) = home();
    write_config(&l, |_| {});
    install(
        d.path(),
        &l,
        "s.p1x",
        &skill_pkg("demo-skill", &key),
        &plain(),
    )
    .unwrap();
    let sha = record(&l, "demo-skill").package_sha256;
    let cached = ExtPaths::of(&l).cached(&sha);

    std::env::set_var("PLUR1BUS_TEST_EXT_FAIL_AT", "kill:uninstall.code");
    assert!(rm(&l, "demo-skill", false, false).is_err());
    std::env::remove_var("PLUR1BUS_TEST_EXT_FAIL_AT");
    assert!(cached.is_file(), "the cache went before the record");
    // Even if the cache file is lost meanwhile, recover keeps the entry's copy.
    fs::remove_file(&cached).unwrap();
    ext::recover(&l);
    assert!(cached.is_file());
    assert!(trash_ids(&l).is_empty());
    assert_eq!(listed(&l, "demo-skill").unwrap()["state"], "installed");

    std::env::set_var("PLUR1BUS_TEST_EXT_FAIL_AT", "kill:uninstall.cache");
    assert!(rm(&l, "demo-skill", false, false).is_err());
    std::env::remove_var("PLUR1BUS_TEST_EXT_FAIL_AT");
    ext::recover(&l);
    assert!(!has_record(&l, "demo-skill"));
    assert!(!cached.exists());
    let tid = trash_ids(&l).pop().unwrap();
    assert!(trash(&l).join(&tid).join("package.p1x").is_file());
    back(&l, &tid).unwrap();
    assert!(cached.is_file());
}

/// Every trash id is one safe path segment the restore accepts, whatever version an index entry or the install
/// manifest names.
#[test]
fn a_trash_id_is_safe_whatever_the_version_says() {
    let key = test_key("test");
    let _g = env_with(&key);
    let (_d, l) = home();
    write_config(&l, |_| {});
    for (n, version) in [
        ("odd-one", "1.0 beta"),
        ("odd-two", "../x"),
        ("odd-three", "a\\b/..c"),
    ] {
        let dir = l.skills().join(n);
        fs::create_dir_all(&dir).unwrap();
        fs::write(dir.join("SKILL.md"), skill_md(n)).unwrap();
        let _lock = index::lock_skills(&l).unwrap();
        let mut idx = index::read_index(&l).unwrap();
        idx.upsert(json!({
            "id": n, "source": "imported", "sourcePath": "-", "sha256": "sha256:00", "enabled": true,
            "importedAt": "2026-09-28T10:00:00.000Z", "package": {"id": format!("x/{n}"), "version": version, "trust": "unsigned"}
        }));
        index::write_index(&l, &idx).unwrap();
        drop(_lock);
        let tid = tid_of(&rm(&l, n, false, false).unwrap());
        for bad in ["/", "\\", "..", " "] {
            assert!(!tid.contains(bad), "{tid:?} contains {bad:?}");
        }
        assert!(trash(&l).join(&tid).join("code").is_dir(), "{tid}");
        assert_eq!(trash(&l).join(&tid).parent().unwrap(), trash(&l));
        let v = back(&l, &tid).unwrap();
        assert_eq!(v["version"], version);
        assert!(dir.is_dir());
    }
}

/// A restore killed after its code moved in is finished by `ext::recover` (record, data, index entry); one killed
/// before is undone, and the entry keeps its code.
#[test]
fn a_killed_restore_is_finished_or_undone_by_recover() {
    let key = test_key("test");
    let _g = env_with(&key);
    for kind in ["skill", "module"] {
        let (d, l) = home();
        two_agents(&l);
        let name = if kind == "skill" {
            enabled_skill(d.path(), &l, &key);
            "demo-skill"
        } else {
            enabled_module(d.path(), &l, &key);
            "fixture"
        };
        let rec = record(&l, name);
        let tid = tid_of(&rm(&l, name, true, false).unwrap());
        std::env::set_var("PLUR1BUS_TEST_EXT_FAIL_AT", "kill:restore.code");
        assert!(back(&l, &tid).is_err());
        std::env::remove_var("PLUR1BUS_TEST_EXT_FAIL_AT");
        let done = ext::recover(&l);
        assert!(
            done.iter()
                .any(|x| x.contains("finished the interrupted restore")),
            "{kind}: {done:?}"
        );
        assert_eq!(record(&l, name).files, rec.files, "{kind}");
        assert!(ExtPaths::of(&l).cached(&rec.package_sha256).is_file());
        assert!(l.ext_data(name).join("notes.txt").is_file(), "{kind}");
        assert!(trash_ids(&l).is_empty(), "{kind}: {:?}", trash_ids(&l));
        let it = listed(&l, name).unwrap();
        assert_eq!(
            (&it["state"], &it["enabled"]),
            (&json!("installed"), &json!(false))
        );
        if kind == "module" {
            assert_eq!(config(&l)["modules"]["fixture"]["enabled"], false);
        }
    }

    // Killed before the code moved: undone.
    let (d, l) = home();
    two_agents(&l);
    enabled_skill(d.path(), &l, &key);
    let tid = tid_of(&rm(&l, "demo-skill", false, false).unwrap());
    std::env::set_var("PLUR1BUS_TEST_EXT_FAIL_AT", "kill:restore.index");
    assert!(back(&l, &tid).is_err());
    std::env::remove_var("PLUR1BUS_TEST_EXT_FAIL_AT");
    let done = ext::recover(&l);
    assert!(done.iter().any(|x| x.contains("undid")), "{done:?}");
    assert!(index_enabled(&l, "demo-skill").is_none());
    assert!(trash(&l).join(&tid).join("code").is_dir());
    assert!(!trash(&l).join(&tid).join("restoring").exists());
    back(&l, &tid).unwrap();
    assert_eq!(listed(&l, "demo-skill").unwrap()["state"], "installed");
}

/// `ext.show` lists only trash entries that still hold code (a restore of one without would be `trash-expired`).
#[test]
fn show_lists_only_trash_entries_with_code() {
    let key = test_key("test");
    let _g = env_with(&key);
    let (d, l) = home();
    write_config(&l, |_| {});
    install(
        d.path(),
        &l,
        "s.p1x",
        &skill_pkg("demo-skill", &key),
        &plain(),
    )
    .unwrap();
    std::env::set_var("PLUR1BUS_TEST_EXT_FAIL_AT", "kill:uninstall.trash");
    assert!(rm(&l, "demo-skill", false, false).is_err());
    std::env::remove_var("PLUR1BUS_TEST_EXT_FAIL_AT");
    ext::recover(&l);
    assert_eq!(trash_ids(&l).len(), 1);
    let detail = show_item(&l, &config(&l), "demo-skill").unwrap();
    assert_eq!(detail["trash"], json!([]));
}

// ---- re-review ----------------------------------------------------------------------------------------------------

/// A killed restore's marked entry is never pruned, and recover finishes it even when an empty `data/ext/<name>` is in
/// the way of the purged data (it replaces it, as the restore does).
#[test]
fn a_marked_entry_is_not_pruned_and_recover_replaces_an_empty_data_dir() {
    let key = test_key("test");
    let _g = env_with(&key);
    let (d, l) = home();
    two_agents(&l);
    enabled_skill(d.path(), &l, &key);
    let tid = tid_of(&rm(&l, "demo-skill", true, false).unwrap());
    std::env::set_var("PLUR1BUS_TEST_EXT_FAIL_AT", "kill:restore.code");
    assert!(back(&l, &tid).is_err());
    std::env::remove_var("PLUR1BUS_TEST_EXT_FAIL_AT");
    backdate(&l, &tid, 30);
    assert_eq!(prune_trash(&l, 14), Vec::<String>::new());
    assert!(trash(&l).join(&tid).is_dir());

    fs::create_dir_all(l.ext_data("demo-skill")).unwrap();
    let done = ext::recover(&l);
    assert!(
        done.iter()
            .any(|x| x.contains("finished the interrupted restore")),
        "{done:?}"
    );
    assert_eq!(
        fs::read_to_string(l.ext_data("demo-skill").join("notes.txt")).unwrap(),
        "kept\n"
    );
    assert!(has_record(&l, "demo-skill"));
    assert!(trash_ids(&l).is_empty());
}

/// A module restore killed after its config write is undone by recover with the config section as it was before the
/// restore: kept (uninstall) or absent again (purge).
#[test]
fn recover_undoes_a_module_restore_killed_after_the_config_step() {
    let key = test_key("test");
    let _g = env_with(&key);
    for purge in [false, true] {
        let (d, l) = home();
        write_config(&l, |_| {});
        enabled_module(d.path(), &l, &key);
        let tid = tid_of(&rm(&l, "fixture", purge, false).unwrap());
        let before = config(&l)["modules"].get("fixture").cloned();
        assert_eq!(before.is_none(), purge);
        let config_bytes = fs::read(l.config_path()).unwrap();
        std::env::set_var("PLUR1BUS_TEST_EXT_FAIL_AT", "kill:restore.config");
        assert!(back(&l, &tid).is_err());
        std::env::remove_var("PLUR1BUS_TEST_EXT_FAIL_AT");
        assert_ne!(config(&l)["modules"].get("fixture").cloned(), before);

        let done = ext::recover(&l);
        assert!(done.iter().any(|x| x.contains("undid")), "{done:?}");
        assert_eq!(
            config(&l)["modules"].get("fixture").cloned(),
            before,
            "purge={purge}"
        );
        if !purge {
            assert_eq!(fs::read(l.config_path()).unwrap(), config_bytes);
        }
        assert!(!trash(&l).join(&tid).join("restoring").exists());
        assert!(trash(&l).join(&tid).join("code").is_dir());
        back(&l, &tid).unwrap();
        assert_eq!(config(&l)["modules"]["fixture"]["enabled"], false);
        assert!(l.modules_dir().join("fixture").is_dir());
    }
}
