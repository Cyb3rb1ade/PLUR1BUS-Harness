//! Native A13 receipts survive the worker publication gap and never own an existing package.
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

#[path = "../src/supervisor/import_extensions.rs"]
mod bridge;
use ext::commit::ModuleHost;
use paths::Layout;
use serde_json::{json, Value};
use std::path::Path;
static MUTATION_TEST: std::sync::Mutex<()> = std::sync::Mutex::new(());

fn candidate(name: &str, fingerprint: char) -> Value {
    json!({"schema":"import.mcp-candidate/1","source":"hermes","profile":null,"name":name,
  "fingerprint":fingerprint.to_string().repeat(64),"transport":{"type":"http","url":"https://source.example/mcp","auth":"none"},
  "requiredSecrets":[],"reasons":[]})
}
struct Host {
    layout: Layout,
    cfg: Value,
}
impl Host {
    fn new(home: &Path) -> Self {
        std::fs::create_dir_all(home).unwrap();
        let cfg = serde_json::to_value(plur1bus_config::defaults()).unwrap();
        std::fs::write(home.join("config.json"), serde_json::to_vec(&cfg).unwrap()).unwrap();
        Self {
            layout: Layout::new(home.to_path_buf()),
            cfg,
        }
    }
}
impl ModuleHost for Host {
    fn config(&self) -> Value {
        self.cfg.clone()
    }
    fn set_config(
        &mut self,
        changes: Vec<(String, Value)>,
        dry_run: bool,
    ) -> Result<Value, ext::ExtError> {
        let next = ext::commit::apply_changes(&self.cfg, &changes)?;
        if !dry_run {
            std::fs::write(
                self.layout.config_path(),
                serde_json::to_vec(&next).unwrap(),
            )
            .unwrap();
            self.cfg = next;
        }
        Ok(json!({"restart":{"modules":[]},"heldBack":[]}))
    }
    fn install_module(&mut self, _: modules_install::Staged) -> Result<bool, ext::ExtError> {
        panic!("pure MCP import must not enqueue ModuleOps")
    }
    fn remove_module(&mut self, _: &str, _: &Path) -> Result<(), ext::ExtError> {
        panic!("pure MCP rollback must not enqueue ModuleOps")
    }
    fn notify(&mut self, _: Value) {}
    fn via(&self) -> &'static str {
        "supervisor"
    }
}
fn install(host: &mut Host, candidate: &Value, run: &str) -> Result<Value, ext::ExtError> {
    let layout = host.layout.clone();
    bridge::install_with_worker(
        &assert_cmd::cargo::cargo_bin("plur1bus"),
        &layout,
        host,
        candidate,
        run,
    )
}

#[test]
fn import_is_disabled_idempotent_run_owned_and_data_preserving() {
    let _mutation = MUTATION_TEST
        .lock()
        .unwrap_or_else(|error| error.into_inner());
    let dir = tempfile::tempdir().unwrap();
    let mut host = Host::new(&dir.path().join("home"));
    let layout = host.layout.clone();
    let name = "hermes-default-example-0123456789ab";
    let candidate = candidate(name, 'a');
    let run = uuid::Uuid::new_v4().to_string();
    assert_eq!(
        bridge::plan(&layout, &candidate).unwrap(),
        json!({"action":"install"})
    );
    let receipt = install(&mut host, &candidate, &run).unwrap();
    assert_eq!(receipt["schema"], "import.extension-receipt/1");
    assert_eq!(receipt["name"], name);
    assert_eq!(host.cfg["mcp"]["servers"][name]["enabled"], false);
    let state = ext::state::read(&ext::paths::ExtPaths::of(&layout)).unwrap();
    let record = &state.items[name];
    assert_eq!(record.trust, "imported");
    assert_eq!(record.kind, "mcp-server");
    assert_eq!(record.capabilities_ack, None);
    assert_eq!(
        bridge::plan(&layout, &candidate).unwrap(),
        json!({"action":"existing"})
    );
    assert_eq!(
        bridge::plan_for_run(&layout, &candidate, &run).unwrap(),
        json!({"action":"install"}),
        "resume must recover its receipt before the TS sidecar has recorded it"
    );
    assert_eq!(install(&mut host, &candidate, &run).unwrap(), receipt);
    let other_run = uuid::Uuid::new_v4().to_string();
    assert!(install(&mut host, &candidate, &other_run).is_err());
    let data = layout.ext_data(name);
    std::fs::create_dir_all(&data).unwrap();
    std::fs::write(data.join("keep.txt"), b"owned data").unwrap();
    bridge::rollback(&layout, &mut host, &receipt).unwrap();
    bridge::rollback(&layout, &mut host, &receipt).unwrap();
    assert!(!ext::state::read(&ext::paths::ExtPaths::of(&layout))
        .unwrap()
        .items
        .contains_key(name));
    assert!(host.cfg["mcp"]["servers"].get(name).is_none());
    assert_eq!(std::fs::read(data.join("keep.txt")).unwrap(), b"owned data");
}

#[test]
fn rejected_candidates_and_changed_packages_never_overwrite_an_existing_installation() {
    let _mutation = MUTATION_TEST
        .lock()
        .unwrap_or_else(|error| error.into_inner());
    let dir = tempfile::tempdir().unwrap();
    let mut host = Host::new(&dir.path().join("home"));
    let layout = host.layout.clone();
    let name = "hermes-default-example-0123456789ab";
    let original = candidate(name, 'a');
    let run = uuid::Uuid::new_v4().to_string();
    let receipt = install(&mut host, &original, &run).unwrap();
    let before = std::fs::read(layout.extensions().join("state.json")).unwrap();
    assert_eq!(
        bridge::plan(&layout, &candidate(name, 'b')).unwrap(),
        json!({"action":"conflict"})
    );
    assert!(install(
        &mut host,
        &candidate(name, 'b'),
        &uuid::Uuid::new_v4().to_string()
    )
    .is_err());
    let mut bad = original.clone();
    bad["env"] = json!({"TOKEN":"synthetic-private-value"});
    let error = bridge::plan(&layout, &bad).unwrap_err();
    assert!(!error.message.contains("synthetic-private-value"));
    let mut forged = receipt.clone();
    forged["fingerprint"] = json!("b".repeat(64));
    assert!(bridge::rollback(&layout, &mut host, &forged).is_err());
    assert_eq!(
        std::fs::read(layout.extensions().join("state.json")).unwrap(),
        before
    );
}

#[test]
fn native_receipt_recovers_the_gap_after_commit_before_worker_publication() {
    let _mutation = MUTATION_TEST
        .lock()
        .unwrap_or_else(|error| error.into_inner());
    let dir = tempfile::tempdir().unwrap();
    let mut host = Host::new(&dir.path().join("home"));
    let layout = host.layout.clone();
    let name = "hermes-default-resume-0123456789ab";
    let candidate = candidate(name, 'a');
    let run = uuid::Uuid::new_v4().to_string();
    std::env::set_var("PLUR1BUS_ALLOW_TEST_INTERNALS", "1");
    std::env::set_var("PLUR1BUS_TEST_EXT_FAIL_AT", "kill:import.committed");
    let result = install(&mut host, &candidate, &run);
    std::env::remove_var("PLUR1BUS_TEST_EXT_FAIL_AT");
    std::env::remove_var("PLUR1BUS_ALLOW_TEST_INTERNALS");
    assert!(result.is_err());
    assert!(
        !layout
            .home
            .join("imports")
            .join(&run)
            .join("extensions.json")
            .exists(),
        "the TS sidecar has not recorded a receipt"
    );
    assert!(ext::state::read(&ext::paths::ExtPaths::of(&layout))
        .unwrap()
        .items
        .contains_key(name));
    assert_eq!(
        bridge::plan_for_run(&layout, &candidate, &run).unwrap(),
        json!({"action":"install"})
    );
    let receipt = install(&mut host, &candidate, &run).unwrap();
    assert_eq!(install(&mut host, &candidate, &run).unwrap(), receipt);
    bridge::rollback_run(&layout, &mut host, &run).unwrap();
    assert!(!ext::state::read(&ext::paths::ExtPaths::of(&layout))
        .unwrap()
        .items
        .contains_key(name));
}

#[test]
fn automatic_rollback_finds_committed_receipts_lost_by_the_worker_and_tolerates_cold_restore_absence(
) {
    let _mutation = MUTATION_TEST
        .lock()
        .unwrap_or_else(|error| error.into_inner());
    let dir = tempfile::tempdir().unwrap();
    let mut host = Host::new(&dir.path().join("home"));
    let layout = host.layout.clone();
    let name = "hermes-default-gap-0123456789ab";
    let candidate = candidate(name, 'b');
    let run = uuid::Uuid::new_v4().to_string();
    std::env::set_var("PLUR1BUS_ALLOW_TEST_INTERNALS", "1");
    std::env::set_var("PLUR1BUS_TEST_EXT_FAIL_AT", "kill:import.committed");
    let result = install(&mut host, &candidate, &run);
    std::env::remove_var("PLUR1BUS_TEST_EXT_FAIL_AT");
    std::env::remove_var("PLUR1BUS_ALLOW_TEST_INTERNALS");
    assert!(result.is_err());
    bridge::rollback_run(&layout, &mut host, &run).unwrap();
    assert!(!ext::state::read(&ext::paths::ExtPaths::of(&layout))
        .unwrap()
        .items
        .contains_key(name));
    let next_run = uuid::Uuid::new_v4().to_string();
    let receipt = install(&mut host, &candidate, &next_run).unwrap();
    // The maintenance parent restores these trees first; the native receipt directory intentionally survives.
    std::fs::remove_dir_all(layout.home.join("mcp")).unwrap();
    std::fs::remove_dir_all(layout.extensions()).unwrap();
    host.set_config(vec![(format!("mcp.servers.{name}"), Value::Null)], false)
        .unwrap();
    bridge::rollback_run(&layout, &mut host, &next_run).unwrap();
    bridge::rollback(&layout, &mut host, &receipt).unwrap();
    assert!(!layout.home.join("mcp").exists());
}

#[test]
fn an_old_receipt_cannot_delete_a_subsequent_install_even_when_the_candidate_is_identical() {
    let _mutation = MUTATION_TEST
        .lock()
        .unwrap_or_else(|error| error.into_inner());
    let dir = tempfile::tempdir().unwrap();
    let mut host = Host::new(&dir.path().join("home"));
    let layout = host.layout.clone();
    let name = "hermes-default-replaced-0123456789ab";
    let candidate = candidate(name, 'c');
    let first = install(&mut host, &candidate, &uuid::Uuid::new_v4().to_string()).unwrap();
    // An explicit later uninstall/install is a new installation, outside this receipt's ownership.
    ext::remove::uninstall(
        &layout,
        &mut host,
        name,
        &ext::remove::RemoveOpts::default(),
    )
    .unwrap();
    host.set_config(vec![(format!("mcp.servers.{name}"), Value::Null)], false)
        .unwrap();
    let second = install(&mut host, &candidate, &uuid::Uuid::new_v4().to_string()).unwrap();
    assert_ne!(first, second);
    let before = std::fs::read(layout.extensions().join("state.json")).unwrap();
    assert!(bridge::rollback(&layout, &mut host, &first).is_err());
    assert_eq!(
        std::fs::read(layout.extensions().join("state.json")).unwrap(),
        before
    );
}

#[test]
fn an_unrecorded_module_name_and_unsafe_receipt_directory_are_refused_before_installation() {
    let _mutation = MUTATION_TEST
        .lock()
        .unwrap_or_else(|error| error.into_inner());
    let dir = tempfile::tempdir().unwrap();
    let mut host = Host::new(&dir.path().join("home"));
    let layout = host.layout.clone();
    let name = "hermes-default-conflict-0123456789ab";
    let candidate = candidate(name, 'd');
    std::fs::create_dir_all(layout.modules_dir().join(name)).unwrap();
    assert_eq!(
        bridge::plan(&layout, &candidate).unwrap(),
        json!({"action":"conflict"})
    );
    assert!(install(&mut host, &candidate, &uuid::Uuid::new_v4().to_string()).is_err());
    assert!(!layout.home.join("mcp").exists());
    #[cfg(unix)]
    {
        let foreign = dir.path().join("foreign");
        std::fs::create_dir(&foreign).unwrap();
        std::fs::create_dir_all(layout.home.join("imports")).unwrap();
        std::os::unix::fs::symlink(&foreign, layout.home.join("imports/native-extensions"))
            .unwrap();
        assert!(install(&mut host, &candidate, &uuid::Uuid::new_v4().to_string()).is_err());
        assert_eq!(std::fs::read_dir(&foreign).unwrap().count(), 0);
    }
}

#[test]
fn unsigned_package_policy_is_reported_as_a_conflict_without_preparing_a_receipt() {
    let _mutation = MUTATION_TEST
        .lock()
        .unwrap_or_else(|error| error.into_inner());
    let dir = tempfile::tempdir().unwrap();
    let mut host = Host::new(&dir.path().join("home"));
    let layout = host.layout.clone();
    host.set_config(
        vec![("extensions.allowUnsigned".into(), json!(false))],
        false,
    )
    .unwrap();
    let candidate = candidate("hermes-default-policy-0123456789ab", 'e');
    assert_eq!(
        bridge::plan(&layout, &candidate).unwrap(),
        json!({"action":"conflict"})
    );
    assert!(install(&mut host, &candidate, &uuid::Uuid::new_v4().to_string()).is_err());
    assert!(!layout.home.join("imports/native-extensions").exists());
    assert!(!layout.home.join("mcp").exists());
}

#[test]
fn a_receipt_does_not_remove_an_installation_whose_payload_was_changed_after_import() {
    let _mutation = MUTATION_TEST
        .lock()
        .unwrap_or_else(|error| error.into_inner());
    let dir = tempfile::tempdir().unwrap();
    let mut host = Host::new(&dir.path().join("home"));
    let layout = host.layout.clone();
    let name = "hermes-default-edited-0123456789ab";
    let candidate = candidate(name, 'f');
    let receipt = install(&mut host, &candidate, &uuid::Uuid::new_v4().to_string()).unwrap();
    let state = ext::state::read(&ext::paths::ExtPaths::of(&layout)).unwrap();
    let payload = layout
        .home
        .join("mcp")
        .join(name)
        .join(&state.items[name].version)
        .join("payload/README.md");
    std::fs::write(&payload, b"Later user modification").unwrap();
    assert!(bridge::rollback(&layout, &mut host, &receipt).is_err());
    assert_eq!(std::fs::read(&payload).unwrap(), b"Later user modification");
    assert!(ext::state::read(&ext::paths::ExtPaths::of(&layout))
        .unwrap()
        .items
        .contains_key(name));
}
