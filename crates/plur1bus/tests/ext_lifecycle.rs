//! Hot enable and disable of installed extensions (X1 Task 8; spec §6.3; X1-R11, X1-R13, X1-R32; X1-C12;
//! acceptance 1 second half, acceptance 6 enable half): skills per agent, modules through `modules.<name>.enabled`,
//! the capability acknowledgment, overlays that refuse an enable, dry-run plans with dependents, and audit lines.
//!
//! The binary crate has no library target, so the modules the ext layer depends on are included by path (as in
//! `ext_commit.rs`). No test touches a real service manager, another harness's install or a real home: every test has its own temp
//! home and the offline `ModuleHost` (or a fake one).
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

use ext::commit::{
    capabilities_hash, install_commit, Agents, InstallOpts, ModuleHost, OfflineHost,
};
use ext::inspect::{self, Source};
use ext::lifecycle::{dependents, disable, enable, ToggleOpts};
use ext::list::{list_items, ListFilter};
use ext::paths::ExtPaths;
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
    let list = list_items(l, &config(l), &ListFilter::default()).unwrap();
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

// ---- skills per agent (X1-R11) ------------------------------------------------------------------------------------

/// Acceptance 1, second half: enabled for `bernd` only, the skill is blocked for `anna`; disable reverts it to
/// installed.
#[test]
fn enable_for_one_agent_only_blocks_it_for_the_others_and_disable_reverts() {
    let key = test_key("test");
    let _g = env_with(&key);
    let (d, l) = home();
    two_agents(&l);
    install(
        d.path(),
        &l,
        "s.p1x",
        &skill_pkg("demo-skill", &key),
        &plain(),
    )
    .unwrap();

    let v = on(&l, "demo-skill", &toggle(some(&["bernd"]), true, false)).unwrap();
    assert_eq!(
        v,
        json!({"name": "demo-skill", "state": "enabled", "restart": {"modules": []}, "heldBack": []})
    );
    assert_eq!(index_enabled(&l, "demo-skill"), Some(true));
    assert_eq!(blocked(&l, "anna"), json!(["demo-skill"]));
    assert!(blocked(&l, "bernd").as_array().is_none_or(|b| b.is_empty()));
    assert_eq!(item(&l, "demo-skill")["agents"], json!(["bernd"]));

    let v = off(&l, "demo-skill", &toggle(None, false, false)).unwrap();
    assert_eq!(v["state"], "installed");
    assert_eq!(index_enabled(&l, "demo-skill"), Some(false));
    let it = item(&l, "demo-skill");
    assert_eq!(
        (&it["state"], &it["agents"]),
        (&json!("installed"), &json!([]))
    );
}

#[test]
fn enable_all_clears_every_blocked_entry() {
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
    write_config(&l, |c| {
        c["agents"] = json!({
            "bernd": {"createdAt": "2026-09-28T10:00:00.000Z", "skills": {"blocked": ["demo-skill"]}},
            "anna": {"createdAt": "2026-09-28T10:00:00.000Z", "skills": {"blocked": ["other", "demo-skill"]}}
        })
    });
    for agents in [None, Some(Agents::All)] {
        on(&l, "demo-skill", &toggle(agents, true, false)).unwrap();
        assert_eq!(blocked(&l, "bernd"), json!([]));
        assert_eq!(blocked(&l, "anna"), json!(["other"]));
        assert_eq!(item(&l, "demo-skill")["agents"], "all");
    }
}

#[test]
fn disable_without_agents_keeps_the_lists() {
    let key = test_key("test");
    let _g = env_with(&key);
    let (d, l) = home();
    two_agents(&l);
    install(
        d.path(),
        &l,
        "s.p1x",
        &skill_pkg("demo-skill", &key),
        &plain(),
    )
    .unwrap();
    on(&l, "demo-skill", &toggle(some(&["bernd"]), true, false)).unwrap();
    off(&l, "demo-skill", &toggle(None, false, false)).unwrap();
    assert_eq!(blocked(&l, "anna"), json!(["demo-skill"]));
    assert_eq!(index_enabled(&l, "demo-skill"), Some(false));

    // With agents: only their lists grow, the index stays enabled.
    on(&l, "demo-skill", &toggle(None, false, false)).unwrap();
    let v = off(&l, "demo-skill", &toggle(some(&["anna"]), false, false)).unwrap();
    assert_eq!(v["state"], "enabled");
    assert_eq!(index_enabled(&l, "demo-skill"), Some(true));
    assert_eq!(blocked(&l, "anna"), json!(["demo-skill"]));
    assert!(blocked(&l, "bernd").as_array().is_none_or(|b| b.is_empty()));
    assert_eq!(item(&l, "demo-skill")["agents"], json!(["bernd"]));
}

#[test]
fn an_unknown_agent_is_e_agent_unknown() {
    let key = test_key("test");
    let _g = env_with(&key);
    let (d, l) = home();
    two_agents(&l);
    install(
        d.path(),
        &l,
        "s.p1x",
        &skill_pkg("demo-skill", &key),
        &plain(),
    )
    .unwrap();
    let before = guarded(&l);
    let e = on(&l, "demo-skill", &toggle(some(&["nobody"]), true, false)).unwrap_err();
    assert_eq!(e.code, "E_AGENT_UNKNOWN");
    assert_eq!(e.data["agentId"], "nobody");
    let e = off(
        &l,
        "demo-skill",
        &toggle(some(&["bernd", "nobody"]), false, false),
    )
    .unwrap_err();
    assert_eq!(e.code, "E_AGENT_UNKNOWN");
    assert_eq!(guarded(&l), before);
}

#[test]
fn an_unknown_name_is_extension_unknown() {
    let key = test_key("test");
    let _g = env_with(&key);
    let (_d, l) = home();
    write_config(&l, |_| {});
    for r in [
        on(&l, "nothing", &toggle(None, true, false)),
        off(&l, "nothing", &toggle(None, false, false)),
        on(&l, "nothing", &toggle(None, true, true)),
    ] {
        assert_eq!(
            reason(&r.unwrap_err()),
            ("E_NOT_FOUND", "extension-unknown")
        );
    }
}

#[test]
fn agents_on_a_module_is_agents_not_supported() {
    let key = test_key("test");
    let _g = env_with(&key);
    let (d, l) = home();
    two_agents(&l);
    install(
        d.path(),
        &l,
        "m.p1x",
        &module_pkg("fixture", &key),
        &plain(),
    )
    .unwrap();
    let before = guarded(&l);
    let e = on(&l, "fixture", &toggle(some(&["bernd"]), true, false)).unwrap_err();
    assert_eq!(reason(&e), ("E_INVALID_PARAMS", "agents-not-supported"));
    let e = off(&l, "fixture", &toggle(some(&["bernd"]), false, false)).unwrap_err();
    assert_eq!(reason(&e), ("E_INVALID_PARAMS", "agents-not-supported"));
    assert_eq!(guarded(&l), before);
}

/// A skill folder without an index entry lists as enabled (X1-R12); its first toggle writes its entry with its
/// source, and it needs no acknowledgment (no package record).
#[test]
fn an_unindexed_local_skill_gets_its_entry_at_the_first_toggle() {
    let key = test_key("test");
    let _g = env_with(&key);
    let (_d, l) = home();
    write_config(&l, |_| {});
    let dir = l.skills().join("hand-made");
    fs::create_dir_all(&dir).unwrap();
    fs::write(dir.join("SKILL.md"), skill_md("hand-made")).unwrap();
    assert_eq!(item(&l, "hand-made")["state"], "enabled");

    let v = off(&l, "hand-made", &toggle(None, false, false)).unwrap();
    assert_eq!(v["state"], "installed");
    let idx = index::read_index(&l).unwrap();
    let e = idx.entry("hand-made").unwrap();
    assert_eq!(
        (&e["source"], &e["enabled"], &e["package"]),
        (&json!("local"), &json!(false), &Value::Null)
    );
    let pairs = vec![("SKILL.md".to_string(), sha_hex(&skill_md("hand-made")))];
    assert_eq!(
        e["sha256"],
        plur1bus_ext::folder_hash::skill_folder_hash(&pairs)
    );
    assert_eq!(item(&l, "hand-made")["state"], "installed");

    // No package record: no acknowledgment.
    let v = on(&l, "hand-made", &toggle(None, false, false)).unwrap();
    assert_eq!(v["state"], "enabled");
    assert_eq!(index_enabled(&l, "hand-made"), Some(true));
}

// ---- capability acknowledgment (X1-R13) ---------------------------------------------------------------------------

#[test]
fn first_enable_needs_acknowledge_capabilities_with_the_disclosure_in_data() {
    let key = test_key("test");
    let _g = env_with(&key);
    let (d, l) = home();
    write_config(&l, |_| {});
    install(
        d.path(),
        &l,
        "m.p1x",
        &module_pkg("fixture", &key),
        &plain(),
    )
    .unwrap();
    install(
        d.path(),
        &l,
        "s.p1x",
        &skill_pkg("demo-scripts", &key),
        &plain(),
    )
    .unwrap();
    let before = guarded(&l);

    let e = on(&l, "fixture", &toggle(None, false, false)).unwrap_err();
    assert_eq!(
        reason(&e),
        ("E_APPROVAL_REQUIRED", "acknowledge-capabilities")
    );
    assert_eq!(e.data["authority"], "full");
    assert_eq!(e.data["capabilities"], base_caps());
    assert_eq!(e.data["scripts"], json!([]));

    let e = on(&l, "demo-scripts", &toggle(None, false, false)).unwrap_err();
    assert_eq!(
        reason(&e),
        ("E_APPROVAL_REQUIRED", "acknowledge-capabilities")
    );
    assert_eq!(e.data["authority"], "none");
    let scripts: Vec<&str> = e.data["scripts"]
        .as_array()
        .unwrap()
        .iter()
        .map(|s| s["path"].as_str().unwrap())
        .collect();
    // X1-C27: the path inside the package, as `ext.inspect` shows it.
    assert_eq!(scripts, ["payload/scripts/run.sh"]);
    // A dry run asks the same.
    let e = on(&l, "demo-scripts", &toggle(None, false, true)).unwrap_err();
    assert_eq!(
        reason(&e),
        ("E_APPROVAL_REQUIRED", "acknowledge-capabilities")
    );
    assert_eq!(guarded(&l), before);

    let v = on(&l, "fixture", &toggle(None, true, false)).unwrap();
    assert_eq!(v["state"], "enabled");
    assert_eq!(config(&l)["modules"]["fixture"]["enabled"], true);
    assert_eq!(v["restart"]["modules"], json!(["fixture"]));
    assert_eq!(
        record(&l, "fixture").capabilities_ack.as_deref(),
        Some(capabilities_hash(&base_caps()).as_str())
    );
    on(&l, "demo-scripts", &toggle(None, true, false)).unwrap();
    assert!(record(&l, "demo-scripts").capabilities_ack.is_some());
    assert_eq!(
        record(&l, "demo-scripts").integrity.as_ref().map(|i| i.ok),
        Some(true)
    );
}

#[test]
fn re_enable_after_disable_needs_no_new_acknowledgment_unless_capabilities_changed() {
    let key = test_key("test");
    let _g = env_with(&key);
    let (d, l) = home();
    write_config(&l, |_| {});
    install(
        d.path(),
        &l,
        "s1.p1x",
        &skill_pkg("demo-skill", &key),
        &plain(),
    )
    .unwrap();
    on(&l, "demo-skill", &toggle(None, true, false)).unwrap();
    off(&l, "demo-skill", &toggle(None, false, false)).unwrap();
    on(&l, "demo-skill", &toggle(None, false, false)).unwrap();
    off(&l, "demo-skill", &toggle(None, false, false)).unwrap();

    // A disabled replacement with wider capabilities keeps the old acknowledgment, so the next enable asks.
    install(
        d.path(),
        &l,
        "s2.p1x",
        &skill_pkg_caps("demo-skill", "1.1.0", wide_caps(), &key),
        &plain(),
    )
    .unwrap();
    let before = guarded(&l);
    let e = on(&l, "demo-skill", &toggle(None, false, false)).unwrap_err();
    assert_eq!(
        reason(&e),
        ("E_APPROVAL_REQUIRED", "acknowledge-capabilities")
    );
    assert_eq!(e.data["capabilities"]["network"]["mode"], "any");
    assert_eq!(guarded(&l), before);
    on(&l, "demo-skill", &toggle(None, true, false)).unwrap();
    assert_eq!(
        record(&l, "demo-skill").capabilities_ack.as_deref(),
        Some(capabilities_hash(&wide_caps()).as_str())
    );
}

/// X1-C12 on the module path: replacing an ENABLED module with other capabilities needs `capabilities` at install
/// (authority `full` in the disclosure) and succeeds with it, still enabled.
#[test]
fn replacing_an_enabled_module_with_other_capabilities_needs_acknowledge_capabilities() {
    let key = test_key("test");
    let _g = env_with(&key);
    let (d, l) = home();
    write_config(&l, |_| {});
    install(
        d.path(),
        &l,
        "m1.p1x",
        &module_pkg("fixture", &key),
        &plain(),
    )
    .unwrap();
    on(&l, "fixture", &toggle(None, true, false)).unwrap();
    let before = guarded(&l);
    let wide = module_pkg_caps("fixture", "1.1.0", wide_caps(), &key);
    let e = install(d.path(), &l, "m2.p1x", &wide, &plain()).unwrap_err();
    assert_eq!(
        reason(&e),
        ("E_APPROVAL_REQUIRED", "acknowledge-capabilities")
    );
    assert_eq!(e.data["authority"], "full");
    assert_eq!(e.data["previousCapabilities"], base_caps());
    assert_eq!(guarded(&l), before);

    let v = install(d.path(), &l, "m2.p1x", &wide, &acked()).unwrap();
    assert_eq!(
        (&v["replaced"], &v["state"]),
        (&json!(true), &json!("enabled"))
    );
    assert_eq!(config(&l)["modules"]["fixture"]["enabled"], true);
    assert_eq!(
        record(&l, "fixture").capabilities_ack.as_deref(),
        Some(capabilities_hash(&wide_caps()).as_str())
    );
    // The same capabilities again (a patch release): no acknowledgment.
    let same = module_pkg_caps("fixture", "1.1.1", wide_caps(), &key);
    install(d.path(), &l, "m3.p1x", &same, &plain()).unwrap();
}

// ---- overlays (acceptance 6, enable half) -------------------------------------------------------------------------

#[test]
fn enable_refuses_revoked_needs_setup_incompatible_and_tampered() {
    let key = test_key("test");
    let _g = env_with(&key);

    // revoked
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
    revoke(d.path(), "demo/demo-skill");
    let before = guarded(&l);
    let e = on(&l, "demo-skill", &toggle(None, true, false)).unwrap_err();
    assert_eq!(reason(&e), ("E_DENIED", "revoked"));
    assert!(e.message.contains("bad"), "{}", e.message);
    assert_eq!(guarded(&l), before);
    std::env::remove_var("PLUR1BUS_TEST_EXT_REVOCATIONS");

    // needs-setup
    let (d, l) = home();
    write_config(&l, |_| {});
    let mut caps = base_caps();
    caps["secrets"] =
        json!([{ "slot": "API_KEY", "label": { "en": "API key" }, "required": true }]);
    install(
        d.path(),
        &l,
        "s.p1x",
        &skill_pkg_caps("demo-skill", "1.0.0", caps, &key),
        &plain(),
    )
    .unwrap();
    let before = guarded(&l);
    let e = on(&l, "demo-skill", &toggle(None, true, false)).unwrap_err();
    assert_eq!(reason(&e), ("E_NOT_AVAILABLE", "needs-setup"));
    assert_eq!(guarded(&l), before);

    // incompatible: the harness moved past the package's range after the install.
    let (d, l) = home();
    write_config(&l, |_| {});
    let mut t = template("demo-skill", "skill", "1.0.0", base_caps());
    t["compat"]["harness"] = json!(">=0.0.0 <9.0.0");
    install(d.path(), &l, "s.p1x", &skill_from(&t, Some(&key)), &plain()).unwrap();
    std::env::set_var("PLUR1BUS_TEST_HARNESS_VERSION", "9.1.0");
    let before = guarded(&l);
    let e = on(&l, "demo-skill", &toggle(None, true, false)).unwrap_err();
    assert_eq!(reason(&e), ("E_NOT_AVAILABLE", "incompatible"));
    assert_eq!(guarded(&l), before);
    std::env::remove_var("PLUR1BUS_TEST_HARNESS_VERSION");

    // tampered: a fresh re-hash finds an edited file.
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
    fs::write(l.skills().join("demo-skill/references/a.md"), "edited").unwrap();
    let before = guarded(&l);
    let e = on(&l, "demo-skill", &toggle(None, true, false)).unwrap_err();
    assert_eq!(reason(&e), ("E_NOT_AVAILABLE", "tampered"));
    assert_eq!(e.data["paths"], json!(["references/a.md"]));
    assert_eq!(guarded(&l), before);
}

#[test]
fn disable_is_always_allowed_even_when_revoked() {
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
    on(&l, "demo-skill", &toggle(None, true, false)).unwrap();
    on(&l, "fixture", &toggle(None, true, false)).unwrap();
    let revs = d.path().join("revocations.json");
    fs::write(
        &revs,
        json!({"revocations": [
            {"id": "demo/demo-skill", "versions": "*", "action": "disable", "reason": "bad"},
            {"id": "demo/fixture", "versions": "*", "action": "disable", "reason": "bad"}
        ]})
        .to_string(),
    )
    .unwrap();
    std::env::set_var("PLUR1BUS_TEST_EXT_REVOCATIONS", &revs);
    fs::write(l.skills().join("demo-skill/references/a.md"), "edited").unwrap();
    assert_eq!(
        off(&l, "demo-skill", &toggle(None, false, false)).unwrap()["state"],
        "installed"
    );
    assert_eq!(
        off(&l, "fixture", &toggle(None, false, false)).unwrap()["state"],
        "installed"
    );
    assert_eq!(index_enabled(&l, "demo-skill"), Some(false));
    assert_eq!(config(&l)["modules"]["fixture"]["enabled"], false);
}

// ---- plans --------------------------------------------------------------------------------------------------------

#[test]
fn dry_run_writes_nothing_and_returns_the_plan_with_dependents() {
    let key = test_key("test");
    let _g = env_with(&key);
    let (d, l) = home();
    two_agents(&l);
    install(
        d.path(),
        &l,
        "m.p1x",
        &module_pkg("fixture", &key),
        &plain(),
    )
    .unwrap();
    install(
        d.path(),
        &l,
        "s.p1x",
        &skill_pkg("demo-skill", &key),
        &plain(),
    )
    .unwrap();
    on(&l, "fixture", &toggle(None, true, false)).unwrap();
    // fixture-b needs fixture directly, fixture-c through fixture-b; fixture-d needs it but is disabled.
    local_module(&l, "fixture-b", &["fixture"]);
    local_module(&l, "fixture-c", &["fixture-b"]);
    local_module(&l, "fixture-d", &["fixture"]);
    let mut cfg = config(&l);
    cfg["modules"]["fixture-d"] = json!({ "enabled": false });
    plur1bus_config::write_atomic(&l.config_path(), &cfg).unwrap();
    assert_eq!(
        dependents(&l, &config(&l), "fixture"),
        ["fixture-b", "fixture-c"]
    );
    assert_eq!(
        dependents(&l, &config(&l), "fixture-c"),
        Vec::<String>::new()
    );

    let before = guarded(&l);
    let mut host = OfflineHost::new(&l);
    let v = disable(&l, &mut host, "fixture", &toggle(None, false, true)).unwrap();
    assert_eq!(v["name"], "fixture");
    assert_eq!(v["state"], "installed");
    assert_eq!(v["restart"]["modules"], json!(["fixture"]));
    assert_eq!(v["heldBack"], json!(["fixture-b", "fixture-c"]));
    assert!(host.notified.is_empty());

    let v = on(&l, "demo-skill", &toggle(some(&["bernd"]), true, true)).unwrap();
    assert_eq!(v["state"], "enabled");
    let v = off(&l, "demo-skill", &toggle(None, false, true)).unwrap();
    assert_eq!(v["state"], "installed");
    assert_eq!(guarded(&l), before);
    assert_eq!(record(&l, "demo-skill").capabilities_ack, None);
}

/// A host whose `set_config` answers a fixed plan (the supervisor's apply sequence is Task 11).
struct PlanHost<'a> {
    inner: OfflineHost<'a>,
    plan: Value,
    dry_runs: Vec<bool>,
}

impl ModuleHost for PlanHost<'_> {
    fn config(&self) -> Value {
        self.inner.config()
    }
    fn set_config(&mut self, c: Vec<(String, Value)>, dry: bool) -> Result<Value, ExtError> {
        self.dry_runs.push(dry);
        self.inner.set_config(c, dry)?;
        Ok(self.plan.clone())
    }
    fn install_module(&mut self, s: modules_install::Staged) -> Result<bool, ExtError> {
        self.inner.install_module(s)
    }
    fn remove_module(&mut self, n: &str, into: &Path) -> Result<(), ExtError> {
        self.inner.remove_module(n, into)
    }
    fn notify(&mut self, c: Value) {
        self.inner.notify(c)
    }
    fn via(&self) -> &'static str {
        "supervisor"
    }
}

#[test]
fn module_disable_holds_back_a_dependent_in_the_plan() {
    let key = test_key("test");
    let _g = env_with(&key);
    let (d, l) = home();
    write_config(&l, |_| {});
    install(
        d.path(),
        &l,
        "m.p1x",
        &module_pkg("fixture", &key),
        &plain(),
    )
    .unwrap();
    on(&l, "fixture", &toggle(None, true, false)).unwrap();
    let mut host = PlanHost {
        inner: OfflineHost::new(&l),
        plan: json!({ "restart": { "modules": ["fixture"] }, "heldBack": ["fixture-b"] }),
        dry_runs: vec![],
    };
    let v = disable(&l, &mut host, "fixture", &toggle(None, false, true)).unwrap();
    assert_eq!(
        v,
        json!({"name": "fixture", "state": "installed", "restart": {"modules": ["fixture"]}, "heldBack": ["fixture-b"]})
    );
    assert_eq!(config(&l)["modules"]["fixture"]["enabled"], true);
    let v = disable(&l, &mut host, "fixture", &toggle(None, false, false)).unwrap();
    assert_eq!(v["heldBack"], json!(["fixture-b"]));
    assert_eq!(host.dry_runs, [true, false]);
    assert_eq!(config(&l)["modules"]["fixture"]["enabled"], false);
    let n = host.inner.notified.last().unwrap();
    assert_eq!(
        (&n["name"], &n["kind"], &n["state"], &n["version"]),
        (
            &json!("fixture"),
            &json!("module"),
            &json!("installed"),
            &json!("1.0.0")
        )
    );
    let a = audit_lines(&l);
    assert_eq!(a.last().unwrap()["detail"]["via"], "supervisor");
}

#[test]
fn enable_and_disable_write_one_audit_line_each() {
    let key = test_key("test");
    let _g = env_with(&key);
    let (d, l) = home();
    two_agents(&l);
    install(
        d.path(),
        &l,
        "s.p1x",
        &skill_pkg("demo-skill", &key),
        &plain(),
    )
    .unwrap();
    assert_eq!(audit_lines(&l).len(), 1);

    let mut host = OfflineHost::new(&l);
    enable(
        &l,
        &mut host,
        "demo-skill",
        &toggle(some(&["bernd"]), true, false),
    )
    .unwrap();
    let a = audit_lines(&l);
    assert_eq!(a.len(), 2);
    assert_eq!(
        (&a[1]["action"], &a[1]["target"]),
        (&json!("ext.enable"), &json!("demo-skill"))
    );
    assert_eq!(a[1]["detail"]["agents"], json!(["bernd"]));
    assert_eq!(a[1]["detail"]["via"], "offline");
    assert_eq!(host.notified.len(), 1);
    assert_eq!(host.notified[0]["state"], "enabled");
    assert_eq!(host.notified[0]["overlays"], json!([]));

    disable(&l, &mut host, "demo-skill", &toggle(None, false, false)).unwrap();
    let a = audit_lines(&l);
    assert_eq!(a.len(), 3);
    assert_eq!(a[2]["action"], "ext.disable");
    assert_eq!(a[2]["detail"]["agents"], Value::Null);
    assert_eq!(host.notified.len(), 2);

    // Nothing to change: no line, no notification.
    let before = guarded(&l);
    disable(&l, &mut host, "demo-skill", &toggle(None, false, false)).unwrap();
    assert_eq!(guarded(&l), before);
    assert_eq!(host.notified.len(), 2);
}

#[test]
fn a_toggle_while_another_mutation_runs_is_busy() {
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
    let guard = ext::try_mutation().unwrap();
    let e = on(&l, "demo-skill", &toggle(None, true, false)).unwrap_err();
    assert_eq!(reason(&e), ("E_CONFLICT", "busy"));
    drop(guard);
    on(&l, "demo-skill", &toggle(None, true, false)).unwrap();
}

/// A host whose writing `set_config` fails (a plan still works).
struct FailingHost<'a> {
    inner: OfflineHost<'a>,
}

impl ModuleHost for FailingHost<'_> {
    fn config(&self) -> Value {
        self.inner.config()
    }
    fn set_config(&mut self, c: Vec<(String, Value)>, dry: bool) -> Result<Value, ExtError> {
        if !dry {
            return Err(ExtError::new(
                "E_INTERNAL",
                "io",
                "failing host: config.set failed",
            ));
        }
        self.inner.set_config(c, dry)
    }
    fn install_module(&mut self, s: modules_install::Staged) -> Result<bool, ExtError> {
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

/// A failed config write rolls back the record written before it (the acknowledgment), so a failed enable leaves the
/// tree as it was and writes no audit line.
#[test]
fn a_failed_enable_rolls_back_what_it_wrote() {
    let key = test_key("test");
    let _g = env_with(&key);
    let (d, l) = home();
    two_agents(&l);
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
    let before = guarded(&l);
    let mut host = FailingHost {
        inner: OfflineHost::new(&l),
    };
    let e = enable(
        &l,
        &mut host,
        "demo-skill",
        &toggle(some(&["bernd"]), true, false),
    )
    .unwrap_err();
    assert_eq!(reason(&e), ("E_INTERNAL", "io"));
    let e = enable(&l, &mut host, "fixture", &toggle(None, true, false)).unwrap_err();
    assert_eq!(reason(&e), ("E_INTERNAL", "io"));
    assert_eq!(guarded(&l), before);
    assert!(host.inner.notified.is_empty());
}

// ---- review round 1 -------------------------------------------------------------------------------------------------

/// X1-R12: an unindexed skill the install manifest names as bundled gets `source: "bundled"` at its first toggle; a
/// per-agent disable of an unindexed skill also writes its first entry (enabled).
#[test]
fn an_unindexed_bundled_skill_gets_source_bundled() {
    let key = test_key("test");
    let _g = env_with(&key);
    let (_d, l) = home();
    two_agents(&l);
    fs::write(
        l.install_manifest(),
        json!({"skills": [{"name": "ops", "source": "bundled", "version": "1.2.0"}]}).to_string(),
    )
    .unwrap();
    for n in ["ops", "hand-made"] {
        let dir = l.skills().join(n);
        fs::create_dir_all(&dir).unwrap();
        fs::write(dir.join("SKILL.md"), skill_md(n)).unwrap();
    }
    let v = off(&l, "ops", &toggle(None, false, false)).unwrap();
    assert_eq!(v["state"], "installed");
    let e = index::read_index(&l)
        .unwrap()
        .entry("ops")
        .cloned()
        .unwrap();
    assert_eq!(
        (&e["source"], &e["enabled"]),
        (&json!("bundled"), &json!(false))
    );
    assert_eq!(item(&l, "ops")["version"], "1.2.0");

    let v = off(&l, "hand-made", &toggle(some(&["anna"]), false, false)).unwrap();
    assert_eq!(v["state"], "enabled");
    let e = index::read_index(&l)
        .unwrap()
        .entry("hand-made")
        .cloned()
        .unwrap();
    assert_eq!(
        (&e["source"], &e["enabled"]),
        (&json!("local"), &json!(true))
    );
    assert_eq!(blocked(&l, "anna"), json!(["hand-made"]));
    assert_eq!(item(&l, "hand-made")["agents"], json!(["bernd"]));
}

/// A packaged skill whose index entry is missing gets its package entry back at a toggle, not a local one.
#[test]
fn a_packaged_skill_without_an_entry_gets_its_package_entry_back() {
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
    let mut idx = index::read_index(&l).unwrap();
    idx.remove("demo-skill");
    index::write_index(&l, &idx).unwrap();
    on(&l, "demo-skill", &toggle(None, true, false)).unwrap();
    let e = index::read_index(&l)
        .unwrap()
        .entry("demo-skill")
        .cloned()
        .unwrap();
    assert_eq!(
        (&e["source"], &e["enabled"]),
        (&json!("file"), &json!(true))
    );
    assert_eq!(
        e["package"],
        json!({"id": "demo/demo-skill", "version": "1.0.0", "trust": "first-party"})
    );
}

/// `agents: "all"` on a module means everywhere and is accepted (only a list is `agents-not-supported`).
#[test]
fn agents_all_on_a_module_is_accepted() {
    let key = test_key("test");
    let _g = env_with(&key);
    let (d, l) = home();
    write_config(&l, |_| {});
    install(
        d.path(),
        &l,
        "m.p1x",
        &module_pkg("fixture", &key),
        &plain(),
    )
    .unwrap();
    let v = on(&l, "fixture", &toggle(Some(Agents::All), true, false)).unwrap();
    assert_eq!(v["state"], "enabled");
    let v = off(&l, "fixture", &toggle(Some(Agents::All), false, false)).unwrap();
    assert_eq!(v["state"], "installed");
    assert_eq!(config(&l)["modules"]["fixture"]["enabled"], false);
}

/// A plan writes nothing, so it neither waits for nor is refused by a running mutation.
#[test]
fn a_dry_run_succeeds_while_another_mutation_holds_the_lock() {
    let key = test_key("test");
    let _g = env_with(&key);
    let (d, l) = home();
    write_config(&l, |_| {});
    install(
        d.path(),
        &l,
        "m.p1x",
        &module_pkg("fixture", &key),
        &plain(),
    )
    .unwrap();
    let guard = ext::try_mutation().unwrap();
    let before = guarded(&l);
    let v = on(&l, "fixture", &toggle(None, true, true)).unwrap();
    assert_eq!(v["state"], "enabled");
    assert_eq!(v["restart"]["modules"], json!(["fixture"]));
    let e = on(&l, "fixture", &toggle(None, true, false)).unwrap_err();
    assert_eq!(reason(&e), ("E_CONFLICT", "busy"));
    assert_eq!(guarded(&l), before);
    drop(guard);
}

/// X1-C15 guard: an item whose code folder is missing (a kill between steps that `ext::recover` has not seen yet) is
/// refused at enable with `E_NOT_AVAILABLE tampered`, and nothing is written.
#[test]
fn enable_refuses_an_item_whose_code_folder_is_missing() {
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
    fs::remove_dir_all(l.skills().join("demo-skill")).unwrap();
    let before = guarded(&l);
    let e = on(&l, "demo-skill", &toggle(None, true, false)).unwrap_err();
    assert_eq!(reason(&e), ("E_NOT_AVAILABLE", "tampered"));
    assert!(e.message.contains("missing"), "{}", e.message);
    assert_eq!(guarded(&l), before);

    // An index entry without a folder or record (an imported skill whose folder was deleted) is refused the same way.
    let mut idx = index::read_index(&l).unwrap();
    let mut entry = idx.entry("demo-skill").cloned().unwrap();
    entry["id"] = json!("imported-one");
    entry["package"] = Value::Null;
    entry["source"] = json!("imported");
    idx.upsert(entry);
    index::write_index(&l, &idx).unwrap();
    let e = on(&l, "imported-one", &toggle(None, false, false)).unwrap_err();
    assert_eq!(reason(&e), ("E_NOT_AVAILABLE", "tampered"));
    // Disable stays allowed.
    off(&l, "demo-skill", &toggle(None, false, false)).unwrap();
}
