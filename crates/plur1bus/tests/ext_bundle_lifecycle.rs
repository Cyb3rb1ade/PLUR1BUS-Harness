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
#[path = "../src/supervisor/spawn_secrets.rs"]
mod spawn_secrets;

use ext::commit::{capabilities_hash, ModuleHost, OfflineHost};
use ext::lifecycle::{disable, enable, ToggleOpts};
use ext::paths::ExtPaths;
use ext::{index, list, remove, state};
use paths::Layout;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::fs;
static MUTATION: std::sync::Mutex<()> = std::sync::Mutex::new(());

fn digest(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}
fn record(name: &str, kind: &str, sha: &str) -> Value {
    let caps = json!({"network":{"mode":"none"},"filesystem":[],"processes":{"spawn":false},"harness":{"authority":"none"}});
    json!({"id":format!("test/{name}"),"name":name,"kind":kind,"version":"1.0.0","source":"file","trust":"release",
        "packageSha256":sha,"installedAt":"2026-10-29T00:00:00.000Z","files":{},"capabilities":caps,
        "capabilitiesAck":capabilities_hash(&caps),"scripts":[],"requiredSecrets":[],"removedByUser":false})
}
fn fixture() -> (tempfile::TempDir, Layout) {
    let temp = tempfile::tempdir().unwrap();
    let layout = Layout::new(temp.path().join("home"));
    let p = ExtPaths::of(&layout);
    fs::create_dir_all(&p.cache).unwrap();
    let mut parent = record("collection", "bundle", &digest(b"parent"));
    let mut items = serde_json::Map::new();
    let mut summaries = vec![];
    let mut disclosures = vec![];
    for (name, optional) in [("alpha", false), ("beta", false), ("extra", true)] {
        let sha = digest(name.as_bytes());
        let mut child = record(name, "skill", &sha);
        let bytes = format!("# {name}\n");
        fs::create_dir_all(layout.skills().join(name)).unwrap();
        fs::write(layout.skills().join(name).join("SKILL.md"), &bytes).unwrap();
        child["files"] =
            json!({"SKILL.md":{"sha256":digest(bytes.as_bytes()),"size":bytes.len(),"exec":false}});
        let manifest = json!({"id":child["id"],"name":name,"kind":"skill","version":"1.0.0","requires":{},"capabilities":child["capabilities"]});
        let disclosure = json!({"name":name,"kind":"skill","version":"1.0.0","sha256":sha,"optional":optional,
            "manifest":manifest,"trust":{"tier":"release"},"checks":[],"scripts":[],"requires":{},"capabilities":child["capabilities"]});
        fs::write(
            p.cached_meta(&sha),
            serde_json::to_vec(&json!({"manifest":manifest,"scripts":[]})).unwrap(),
        )
        .unwrap();
        fs::write(p.cached(&sha), b"opaque child bytes").unwrap();
        summaries.push(
            json!({"name":name,"kind":"skill","version":"1.0.0","sha256":sha,"optional":optional}),
        );
        disclosures.push(disclosure);
        items.insert(name.into(), child);
    }
    parent["members"] = json!(summaries);
    parent["capabilitiesAck"] = json!(ext::bundle_lifecycle::consent_sha256(
        &serde_json::from_value(parent.clone()).unwrap(),
        &disclosures
    ));
    fs::create_dir_all(layout.extensions().join("bundles/collection")).unwrap();
    fs::write(p.cached_meta(parent["packageSha256"].as_str().unwrap()),serde_json::to_vec(&json!({"manifest":{"name":"collection","kind":"bundle"},"scripts":[],"members":disclosures})).unwrap()).unwrap();
    fs::write(
        p.cached(parent["packageSha256"].as_str().unwrap()),
        b"opaque wrapper bytes",
    )
    .unwrap();
    items.insert("collection".into(), parent);
    fs::write(
        &p.state,
        serde_json::to_vec(&json!({"schemaVersion":1,"items":items})).unwrap(),
    )
    .unwrap();
    fs::create_dir_all(layout.skills()).unwrap();
    index::write_index(&layout,&index::SkillIndex(json!({"version":1,"skills":[
        {"id":"alpha","enabled":false},{"id":"beta","enabled":false},{"id":"extra","enabled":false}
    ]}))).unwrap();
    (temp, layout)
}

#[test]
fn bundle_selected_records_roundtrip_and_group_toggles_are_joint() {
    let _guard = MUTATION.lock().unwrap_or_else(|e| e.into_inner());
    let (_temp, layout) = fixture();
    let paths = ExtPaths::of(&layout);
    let state = state::read(&paths).expect("bundle state must accept selected member summaries");
    assert_eq!(
        serde_json::to_value(&state).unwrap()["items"]["collection"]["members"]
            .as_array()
            .unwrap()
            .len(),
        3
    );
    let mut host = OfflineHost::new(&layout);
    enable(&layout, &mut host, "collection", &ToggleOpts::default()).unwrap();
    let idx = index::read_index(&layout).unwrap();
    for name in ["alpha", "beta", "extra"] {
        assert_eq!(idx.entry(name).unwrap()["enabled"], true);
    }
    disable(&layout, &mut host, "alpha", &ToggleOpts::default()).unwrap_err();
    disable(&layout, &mut host, "extra", &ToggleOpts::default()).unwrap();
    let shown = list::show_item(&layout, &host.config(), "collection").unwrap();
    assert_eq!(shown["item"]["partial"], true);
    assert_eq!(shown["memberInspections"].as_array().unwrap().len(), 3);
    disable(&layout, &mut host, "collection", &ToggleOpts::default()).unwrap();
    let idx = index::read_index(&layout).unwrap();
    for name in ["alpha", "beta", "extra"] {
        assert_eq!(idx.entry(name).unwrap()["enabled"], false);
    }
}

#[test]
fn changed_or_missing_child_blocks_group_enable_without_any_write() {
    let _guard = MUTATION.lock().unwrap_or_else(|e| e.into_inner());
    let (_temp, layout) = fixture();
    let paths = ExtPaths::of(&layout);
    let before = fs::read(&paths.state).unwrap();
    fs::write(layout.skills().join("beta/SKILL.md"), b"changed").unwrap();
    let mut host = OfflineHost::new(&layout);
    let error = enable(&layout, &mut host, "collection", &ToggleOpts::default()).unwrap_err();
    assert_eq!(error.reason, Some("tampered"));
    assert_eq!(fs::read(&paths.state).unwrap(), before);
    assert_eq!(
        index::read_index(&layout).unwrap().entry("alpha").unwrap()["enabled"],
        false
    );
    let shown = list::show_item(&layout, &host.config(), "collection").unwrap();
    assert!(shown["item"]["overlays"]
        .as_array()
        .unwrap()
        .iter()
        .any(|x| x == "tampered"));
}

#[test]
fn bundle_uninstall_cascades_all_selected_children_and_preserves_namespaced_data() {
    let _guard = MUTATION.lock().unwrap_or_else(|e| e.into_inner());
    let (_temp, layout) = fixture();
    let mut host = OfflineHost::new(&layout);
    assert_eq!(
        remove::uninstall(&layout, &mut host, "beta", &remove::RemoveOpts::default())
            .unwrap_err()
            .reason,
        Some("bundle-member")
    );
    for name in ["collection", "alpha", "beta", "extra"] {
        fs::create_dir_all(layout.ext_data(name)).unwrap();
        fs::write(layout.ext_data(name).join("kept"), b"data").unwrap();
    }
    remove::uninstall(
        &layout,
        &mut host,
        "collection",
        &remove::RemoveOpts::default(),
    )
    .unwrap();
    assert!(state::read(&ExtPaths::of(&layout))
        .unwrap()
        .items
        .is_empty());
    for name in ["collection", "alpha", "beta", "extra"] {
        assert_eq!(
            fs::read(layout.ext_data(name).join("kept")).unwrap(),
            b"data"
        );
    }
    for name in ["alpha", "beta", "extra"] {
        assert!(!layout.skills().join(name).exists());
    }
    assert!(!layout.extensions().join("bundles/collection").exists());
}

struct SpyHost<'a> {
    inner: OfflineHost<'a>,
    fail_config: bool,
    presence: usize,
    holds: usize,
}
impl ModuleHost for SpyHost<'_> {
    fn config(&self) -> Value {
        self.inner.config()
    }
    fn set_config(
        &mut self,
        changes: Vec<(String, Value)>,
        dry: bool,
    ) -> Result<Value, ext::ExtError> {
        if self.fail_config && !dry {
            return Err(ext::ExtError::new(
                "E_STORAGE",
                "io",
                "injected config failure",
            ));
        }
        self.inner.set_config(changes, dry)
    }
    fn install_module(&mut self, _: modules::install::Staged) -> Result<bool, ext::ExtError> {
        panic!("no module install in a group toggle")
    }
    fn remove_module(&mut self, _: &str, _: &std::path::Path) -> Result<(), ext::ExtError> {
        panic!("skill-only fixture")
    }
    fn notify(&mut self, value: Value) {
        self.inner.notify(value)
    }
    fn via(&self) -> &'static str {
        "offline"
    }
    fn missing_secrets(&mut self, name: &str, required: &[String]) -> Vec<String> {
        self.presence += 1;
        if name == "new-required" {
            required.to_vec()
        } else {
            vec![]
        }
    }
    fn hold_runtime(&mut self, _: &str) -> Result<bool, ext::ExtError> {
        self.holds += 1;
        Ok(false)
    }
}

#[test]
fn stale_optional_subset_consent_is_refused_before_any_secret_presence_or_runtime_hold() {
    let _guard = MUTATION.lock().unwrap_or_else(|e| e.into_inner());
    let (_temp, layout) = fixture();
    let paths = ExtPaths::of(&layout);
    let mut state = state::read(&paths).unwrap();
    let parent = state.items.get_mut("collection").unwrap();
    let old = parent.capabilities_ack.clone().unwrap();
    parent.members.retain(|member| member.name != "extra");
    state::write(&paths, &state).unwrap();
    let before = fs::read(&paths.state).unwrap();
    let mut host = SpyHost {
        inner: OfflineHost::new(&layout),
        fail_config: false,
        presence: 0,
        holds: 0,
    };
    let error = enable(
        &layout,
        &mut host,
        "collection",
        &ToggleOpts {
            expected_consent_sha256: Some(old),
            ..Default::default()
        },
    )
    .unwrap_err();
    assert_eq!(error.code, "E_CONFLICT");
    assert_eq!(error.reason, Some("inspection-changed"));
    assert_eq!((host.presence, host.holds), (0, 0));
    assert_eq!(fs::read(&paths.state).unwrap(), before);
    assert_eq!(list::show_item(&layout,&host.config(),"collection").unwrap()["memberInspections"].as_array().unwrap().len(),2,
        "the cache may retain all disclosures, but public consent contains only the selected composition");
}

#[test]
fn optional_toggle_does_not_change_the_approved_consent_subject_and_dry_run_writes_nothing() {
    let _guard = MUTATION.lock().unwrap_or_else(|e| e.into_inner());
    let (_temp, layout) = fixture();
    let paths = ExtPaths::of(&layout);
    let mut host = OfflineHost::new(&layout);
    let before =
        list::show_item(&layout, &host.config(), "collection").unwrap()["consentSha256"].clone();
    let state_before = fs::read(&paths.state).unwrap();
    let index_before = fs::read(index::index_path(&layout)).unwrap();
    enable(
        &layout,
        &mut host,
        "collection",
        &ToggleOpts {
            dry_run: true,
            ..Default::default()
        },
    )
    .unwrap();
    assert_eq!(fs::read(&paths.state).unwrap(), state_before);
    assert_eq!(fs::read(index::index_path(&layout)).unwrap(), index_before);
    enable(&layout, &mut host, "collection", &ToggleOpts::default()).unwrap();
    disable(&layout, &mut host, "extra", &ToggleOpts::default()).unwrap();
    assert_eq!(
        list::show_item(&layout, &host.config(), "collection").unwrap()["consentSha256"],
        before
    );
}

#[test]
fn a_group_config_failure_rolls_back_all_acknowledgments_and_skill_changes() {
    let _guard = MUTATION.lock().unwrap_or_else(|e| e.into_inner());
    let (_temp, layout) = fixture();
    let paths = ExtPaths::of(&layout);
    let mut cfg = OfflineHost::new(&layout).config();
    cfg["agents"] = json!({"a":{},"b":{}});
    plur1bus_config::write_atomic(&layout.config_path(), &cfg).unwrap();
    let before = fs::read(&paths.state).unwrap();
    let before_index = fs::read(index::index_path(&layout)).unwrap();
    let before_config = fs::read(layout.config_path()).unwrap();
    let mut host = SpyHost {
        inner: OfflineHost::new(&layout),
        fail_config: true,
        presence: 0,
        holds: 0,
    };
    assert!(enable(
        &layout,
        &mut host,
        "collection",
        &ToggleOpts {
            agents: Some(ext::commit::Agents::Some(vec!["a".into()])),
            ..Default::default()
        }
    )
    .is_err());
    assert_eq!(fs::read(&paths.state).unwrap(), before);
    assert_eq!(fs::read(index::index_path(&layout)).unwrap(), before_index);
    assert_eq!(fs::read(layout.config_path()).unwrap(), before_config);
    assert!(!ext::bundle_transaction::pending(&layout));
    host.fail_config = false;
    enable(
        &layout,
        &mut host,
        "collection",
        &ToggleOpts {
            agents: Some(ext::commit::Agents::Some(vec!["a".into()])),
            ..Default::default()
        },
    )
    .unwrap();
    assert_eq!(
        host.config()["agents"]["b"]["skills"]["blocked"],
        json!(["alpha", "beta", "extra"]),
        "batched per-agent changes must preserve every selected child's restriction"
    );
}

#[test]
fn group_purge_without_declared_slots_removes_each_data_namespace_without_requiring_core_secrets() {
    let _guard = MUTATION.lock().unwrap_or_else(|e| e.into_inner());
    let (_temp, layout) = fixture();
    let mut host = OfflineHost::new(&layout);
    for name in ["collection", "alpha", "beta", "extra"] {
        fs::create_dir_all(layout.ext_data(name)).unwrap();
        fs::write(layout.ext_data(name).join("data"), b"payload").unwrap();
    }
    remove::uninstall(
        &layout,
        &mut host,
        "collection",
        &remove::RemoveOpts {
            purge: true,
            cascade: false,
        },
    )
    .unwrap();
    for name in ["collection", "alpha", "beta", "extra"] {
        assert!(!layout.ext_data(name).exists());
    }
}

#[test]
fn restoring_a_bundle_restores_every_selected_child_disabled_as_one_composition() {
    let _guard = MUTATION.lock().unwrap_or_else(|e| e.into_inner());
    let (_temp, layout) = fixture();
    let mut host = OfflineHost::new(&layout);
    enable(&layout, &mut host, "collection", &ToggleOpts::default()).unwrap();
    let removed = remove::uninstall(
        &layout,
        &mut host,
        "collection",
        &remove::RemoveOpts::default(),
    )
    .unwrap();
    remove::restore(&layout, &mut host, removed["trashId"].as_str().unwrap()).unwrap();
    let state = state::read(&ExtPaths::of(&layout)).unwrap();
    assert_eq!(state.items.len(), 4);
    for name in ["alpha", "beta", "extra"] {
        assert_eq!(
            index::read_index(&layout).unwrap().entry(name).unwrap()["enabled"],
            false
        );
        assert!(layout.skills().join(name).join("SKILL.md").is_file());
    }
    assert_eq!(
        list::show_item(&layout, &host.config(), "collection").unwrap()["item"]["enabled"],
        false
    );
    assert!(!ext::bundle_transaction::pending(&layout));
}

#[test]
fn optional_per_agent_coverage_difference_is_reported_as_partial() {
    let _guard = MUTATION.lock().unwrap_or_else(|e| e.into_inner());
    let (_temp, layout) = fixture();
    let mut host = OfflineHost::new(&layout);
    let mut cfg = host.config();
    cfg["agents"] = json!({"a":{},"b":{}});
    plur1bus_config::write_atomic(&layout.config_path(), &cfg).unwrap();
    enable(&layout, &mut host, "collection", &ToggleOpts::default()).unwrap();
    enable(
        &layout,
        &mut host,
        "extra",
        &ToggleOpts {
            agents: Some(ext::commit::Agents::Some(vec!["a".into()])),
            ..Default::default()
        },
    )
    .unwrap();
    assert_eq!(
        list::show_item(&layout, &host.config(), "collection").unwrap()["item"]["partial"],
        true
    );
}

struct Seam;
impl Seam {
    fn at(point: &str) -> Self {
        std::env::set_var("PLUR1BUS_ALLOW_TEST_INTERNALS", "1");
        std::env::set_var("PLUR1BUS_TEST_EXT_FAIL_AT", point);
        Self
    }
}
impl Drop for Seam {
    fn drop(&mut self) {
        std::env::remove_var("PLUR1BUS_TEST_EXT_FAIL_AT");
        std::env::remove_var("PLUR1BUS_ALLOW_TEST_INTERNALS");
    }
}

#[test]
fn interrupted_group_uninstall_recovers_every_member_and_blocks_intervening_mutations() {
    let _guard = MUTATION.lock().unwrap_or_else(|e| e.into_inner());
    for point in ["uninstall.code", "uninstall.state", "uninstall.cache"] {
        let (_temp, layout) = fixture();
        let paths = ExtPaths::of(&layout);
        let mut host = OfflineHost::new(&layout);
        enable(&layout, &mut host, "collection", &ToggleOpts::default()).unwrap();
        let before = fs::read(&paths.state).unwrap();
        let index_before = fs::read(index::index_path(&layout)).unwrap();
        let seam = Seam::at(&format!("kill:{point}"));
        remove::uninstall(
            &layout,
            &mut host,
            "collection",
            &remove::RemoveOpts::default(),
        )
        .unwrap_err();
        drop(seam);
        assert!(ext::bundle_transaction::pending(&layout));
        assert_eq!(
            enable(&layout, &mut host, "collection", &ToggleOpts::default())
                .unwrap_err()
                .reason,
            Some("state-invalid")
        );
        ext::recover(&layout);
        assert_eq!(fs::read(&paths.state).unwrap(), before, "{point}");
        assert_eq!(
            fs::read(index::index_path(&layout)).unwrap(),
            index_before,
            "{point}"
        );
        assert!(!ext::bundle_transaction::pending(&layout));
        for name in ["alpha", "beta", "extra"] {
            assert!(
                layout.skills().join(name).join("SKILL.md").is_file(),
                "{point}/{name}"
            );
        }
    }
}

#[test]
fn failed_or_interrupted_group_restore_preserves_all_source_trash_and_retries_safely() {
    let _guard = MUTATION.lock().unwrap_or_else(|e| e.into_inner());
    for point in [
        "bundle.restore.beta",
        "kill:restore.code",
        "kill:bundle.restore.beta",
    ] {
        let (_temp, layout) = fixture();
        let paths = ExtPaths::of(&layout);
        let mut host = OfflineHost::new(&layout);
        let removed = remove::uninstall(
            &layout,
            &mut host,
            "collection",
            &remove::RemoveOpts::default(),
        )
        .unwrap();
        let id = removed["trashId"].as_str().unwrap();
        let body: Value =
            serde_json::from_slice(&fs::read(paths.trash.join(id).join("record.json")).unwrap())
                .unwrap();
        let before = fs::read(&paths.state).unwrap();
        let index_before = fs::read(index::index_path(&layout)).unwrap();
        let seam = Seam::at(point);
        remove::restore(&layout, &mut host, id).unwrap_err();
        drop(seam);
        if point.starts_with("kill:") {
            assert!(ext::bundle_transaction::pending(&layout));
            ext::recover(&layout);
        }
        assert_eq!(fs::read(&paths.state).unwrap(), before, "{point}");
        assert_eq!(
            fs::read(index::index_path(&layout)).unwrap(),
            index_before,
            "{point}"
        );
        assert!(!ext::bundle_transaction::pending(&layout));
        for child_id in body["memberTrashIds"].as_object().unwrap().values() {
            assert!(
                paths
                    .trash
                    .join(child_id.as_str().unwrap())
                    .join("code/SKILL.md")
                    .is_file(),
                "{point}"
            );
        }
        remove::restore(&layout, &mut host, id).unwrap();
        assert_eq!(state::read(&paths).unwrap().items.len(), 4);
        for name in ["alpha", "beta", "extra"] {
            assert_eq!(
                index::read_index(&layout).unwrap().entry(name).unwrap()["enabled"],
                false
            );
        }
    }
}

#[test]
fn any_child_capability_approval_discloses_the_full_selected_group() {
    let _guard = MUTATION.lock().unwrap_or_else(|e| e.into_inner());
    let (_temp, layout) = fixture();
    let paths = ExtPaths::of(&layout);
    let mut state = state::read(&paths).unwrap();
    state.items.get_mut("alpha").unwrap().capabilities_ack = None;
    state::write(&paths, &state).unwrap();
    let before = fs::read(&paths.state).unwrap();
    let mut host = OfflineHost::new(&layout);
    let error = enable(&layout, &mut host, "collection", &ToggleOpts::default()).unwrap_err();
    assert_eq!(error.code, "E_APPROVAL_REQUIRED");
    assert_eq!(error.data["name"], "collection");
    assert_eq!(error.data["kind"], "bundle");
    assert_eq!(error.data["members"].as_array().unwrap().len(), 3);
    assert!(error.data["consentSha256"]
        .as_str()
        .is_some_and(|sha| sha.len() == 64));
    assert_eq!(fs::read(&paths.state).unwrap(), before);
}

#[test]
fn new_required_update_members_are_checked_before_any_write_or_hold() {
    let _guard = MUTATION.lock().unwrap_or_else(|e| e.into_inner());
    let (_temp, layout) = fixture();
    let paths = ExtPaths::of(&layout);
    let mut host = OfflineHost::new(&layout);
    let mut cfg = host.config();
    cfg["agents"] = json!({"a":{},"b":{}});
    plur1bus_config::write_atomic(&layout.config_path(), &cfg).unwrap();
    enable(
        &layout,
        &mut host,
        "collection",
        &ToggleOpts {
            agents: Some(ext::commit::Agents::Some(vec!["a".into()])),
            ..Default::default()
        },
    )
    .unwrap();
    let previous = state::read(&paths).unwrap();
    let cfg = host.config();
    let idx = index::read_index(&layout).unwrap();
    let mut parent = previous.items["collection"].clone();
    let mut children: Vec<_> = parent
        .members
        .iter()
        .map(|m| previous.items[&m.name].clone())
        .collect();
    let mut new = previous.items["alpha"].clone();
    new.name = "new-required".into();
    new.id = "test/new-required".into();
    new.kind = "module".into();
    new.required_secrets = vec!["TOKEN".into()];
    parent.members.push(state::BundleMemberRecord {
        name: new.name.clone(),
        kind: new.kind.clone(),
        version: new.version.clone(),
        sha256: new.package_sha256.clone(),
        optional: false,
    });
    children.push(new);
    let before = fs::read(&paths.state).unwrap();
    let before_cfg = fs::read(layout.config_path()).unwrap();
    let before_idx = fs::read(index::index_path(&layout)).unwrap();
    let mut spy = SpyHost {
        inner: OfflineHost::new(&layout),
        fail_config: false,
        presence: 0,
        holds: 0,
    };
    let p = ext::bundle_update::Preservation {
        previous_state: &previous,
        previous_config: &cfg,
        previous_index: &idx,
        new_parent: &parent,
        new_children: &children,
        approved: true,
    };
    assert_eq!(
        ext::bundle_update::precheck_preservation(&layout, &mut spy, &p)
            .unwrap_err()
            .reason,
        Some("agents-not-supported")
    );
    assert_eq!((spy.presence, spy.holds), (0, 0));
    parent.members.last_mut().unwrap().kind = "skill".into();
    children.last_mut().unwrap().kind = "skill".into();
    let p = ext::bundle_update::Preservation {
        previous_state: &previous,
        previous_config: &cfg,
        previous_index: &idx,
        new_parent: &parent,
        new_children: &children,
        approved: true,
    };
    assert_eq!(
        ext::bundle_update::precheck_preservation(&layout, &mut spy, &p)
            .unwrap_err()
            .reason,
        Some("needs-setup")
    );
    assert_eq!(spy.holds, 0);
    assert_eq!(fs::read(&paths.state).unwrap(), before);
    assert_eq!(fs::read(layout.config_path()).unwrap(), before_cfg);
    assert_eq!(fs::read(index::index_path(&layout)).unwrap(), before_idx);
}

#[test]
fn scoped_group_disable_and_empty_group_results_match_actual_activation() {
    let _guard = MUTATION.lock().unwrap_or_else(|e| e.into_inner());
    let (_temp, layout) = fixture();
    let mut cfg = plur1bus_config::defaults();
    cfg["agents"] = json!({"anna":{"createdAt":"2026-09-28T10:00:00.000Z"},"bernd":{"createdAt":"2026-09-28T10:00:00.000Z"}});
    plur1bus_config::write_atomic(&layout.config_path(), &cfg).unwrap();
    let mut host = OfflineHost::new(&layout);
    enable(&layout, &mut host, "collection", &ToggleOpts::default()).unwrap();
    let scoped = ToggleOpts {
        agents: Some(ext::commit::Agents::Some(vec!["anna".into()])),
        dry_run: true,
        ..Default::default()
    };
    let result = disable(&layout, &mut host, "collection", &scoped).unwrap();
    assert_eq!(
        result["state"], "enabled",
        "the remaining agent is still active in a scoped dryrun"
    );
    let result = disable(
        &layout,
        &mut host,
        "collection",
        &ToggleOpts {
            dry_run: false,
            ..scoped
        },
    )
    .unwrap();
    assert_eq!(result["state"], "enabled");
    let shown = list::show_item(&layout, &host.config(), "alpha").unwrap();
    assert_eq!(shown["item"]["agents"], json!(["bernd"]));
    let paths = ExtPaths::of(&layout);
    let mut state = state::read(&paths).unwrap();
    state.items.get_mut("collection").unwrap().members.clear();
    state::write(&paths, &state).unwrap();
    let result = enable(
        &layout,
        &mut host,
        "collection",
        &ToggleOpts {
            acknowledge: vec!["capabilities".into()],
            ..Default::default()
        },
    )
    .unwrap();
    assert_eq!(
        result["state"], "installed",
        "an empty optional selection starts no child"
    );
}
