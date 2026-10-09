//! The state machine against a fake [`Host`] (no processes, no service manager): the plan's task-3 acceptance rows.
use super::*;
use crate::install::manifest::{CoreUnit, InstallManifest, NodeUnit, Unit};
use std::cell::RefCell;
use std::collections::BTreeMap;
use std::fs;

#[derive(Default)]
struct Fake {
    calls: RefCell<Vec<String>>,
    running: bool,
    gate_err: Option<String>,
    start_err_once: RefCell<Option<String>>,
    alive: bool,
    disable_err: Option<String>,
}

impl Host for Fake {
    fn stop(&self, _: &Layout) -> Result<bool, String> {
        self.calls.borrow_mut().push("stop".into());
        Ok(self.running)
    }
    fn start(&self, _: &Layout, bin: &Path) -> Result<(), String> {
        self.calls.borrow_mut().push(format!(
            "start:{}",
            fs::read_to_string(bin).unwrap_or_default()
        ));
        match self.start_err_once.borrow_mut().take() {
            Some(m) => Err(m),
            None => Ok(()),
        }
    }
    fn gate(&self, _: &Layout, _: &Path, _: &str) -> Result<(), String> {
        self.calls.borrow_mut().push("gate".into());
        self.gate_err.clone().map_or(Ok(()), Err)
    }
    fn alive(&self, _: u32) -> bool {
        self.alive
    }
    fn disable_addons(
        &self,
        _: &Layout,
        plan: &addons::AddonPlan,
        _: &str,
        _: &str,
    ) -> Result<(), String> {
        self.calls
            .borrow_mut()
            .push(format!("disable:{}", plan.disable.join(",")));
        self.disable_err.clone().map_or(Ok(()), Err)
    }
    fn restore_addons(&self, _: &Layout, names: &[String]) -> Vec<String> {
        self.calls
            .borrow_mut()
            .push(format!("restore:{}", names.join(",")));
        Vec::new()
    }
    fn reenable_addons(&self, _: &Layout, names: &[String]) -> Vec<(String, String)> {
        self.calls
            .borrow_mut()
            .push(format!("reenable:{}", names.join(",")));
        Vec::new()
    }
}

struct Env {
    _d: tempfile::TempDir,
    layout: Layout,
    bin: PathBuf,
    plan: Plan,
}

fn sha(p: &Path) -> String {
    crate::install::archive::sha256_file(p).unwrap()
}

fn env() -> Env {
    let d = tempfile::tempdir().unwrap();
    let layout = Layout::new(d.path().join("h"));
    fs::create_dir_all(layout.runtime().join("core")).unwrap();
    fs::write(layout.runtime().join("core/core.js"), "old core").unwrap();
    fs::write(layout.config_path(), "{\"engine\":{}}").unwrap();
    let bin = d.path().join("plur1bus");
    fs::write(&bin, "old-binary").unwrap();
    let h = "a".repeat(64);
    let m = InstallManifest {
        schema_version: 1,
        installed_at: 1,
        updated_at: 1,
        channel: "stable".into(),
        target: "linux-x64".into(),
        binary: Unit {
            version: "0.1.0".into(),
            sha256: Some(sha(&bin)),
        },
        node: NodeUnit {
            version: "24.21.0".into(),
            archive_sha256: h.clone(),
            binary_sha256: h.clone(),
            path: "/n".into(),
        },
        core: CoreUnit {
            version: "0.1.0".into(),
            contract: "1.9.0".into(),
            rpc: "1.3.0".into(),
            sha256: None,
            source: "local".into(),
        },
        modules: vec![],
        skills: vec![],
        profile: None,
    };
    manifest::write(&layout, &m).unwrap();
    let new_bin = d.path().join("new-binary");
    fs::write(&new_bin, "new-binary").unwrap();
    let plan = Plan {
        from: "0.1.0".into(),
        to: "0.2.0".into(),
        channel: "stable".into(),
        binary: Asset {
            url: new_bin.to_string_lossy().into(),
            sha256: sha(&new_bin),
            size: None,
        },
        core: None,
        addons: Default::default(),
        record_seen: false,
    };
    Env {
        _d: d,
        layout,
        bin,
        plan,
    }
}

fn with_core(e: &mut Env) {
    let tar = e._d.path().join("core.tar.gz");
    let src = e._d.path().join("core-src");
    fs::create_dir_all(&src).unwrap();
    fs::write(src.join("core.js"), "new core").unwrap();
    let f = fs::File::create(&tar).unwrap();
    let mut b = tar::Builder::new(flate2::write::GzEncoder::new(
        f,
        flate2::Compression::fast(),
    ));
    b.append_dir_all(".", &src).unwrap();
    b.into_inner().unwrap().finish().unwrap();
    e.plan.core = Some((
        Asset {
            url: tar.to_string_lossy().into(),
            sha256: sha(&tar),
            size: None,
        },
        manifest::ReleaseCore {
            version: "0.2.0".into(),
            contract: "1.10.0".into(),
            rpc: "1.3.0".into(),
            payload: BTreeMap::new(),
        },
    ));
}

fn originals(e: &Env) -> (Vec<u8>, Vec<u8>, Vec<u8>) {
    (
        fs::read(&e.bin).unwrap(),
        fs::read(e.layout.config_path()).unwrap(),
        fs::read(e.layout.install_manifest()).unwrap(),
    )
}

#[test]
fn the_happy_path_swaps_gates_and_commits_the_manifest() {
    let mut e = env();
    with_core(&mut e);
    let host = Fake {
        running: true,
        ..Default::default()
    };
    let st = apply(&e.layout, &host, &e.plan, &e.bin).unwrap();
    assert_eq!(st.phase, Phase::Committed);
    assert_eq!(fs::read(&e.bin).unwrap(), b"new-binary");
    assert_eq!(
        fs::read(e.layout.runtime().join("core/core.js")).unwrap(),
        b"new core"
    );
    let m = manifest::read(&e.layout).unwrap().unwrap();
    assert_eq!(
        (m.binary.version.as_str(), m.core.version.as_str()),
        ("0.2.0", "0.2.0")
    );
    assert_eq!(m.binary.sha256.as_deref(), Some(sha(&e.bin).as_str()));
    // stop, then start of the NEW binary, then the gate
    assert_eq!(*host.calls.borrow(), ["stop", "start:new-binary", "gate"]);
    // the snapshot is kept for --rollback, the staging area is gone
    assert!(state::snapshot_dir(&e.layout)
        .join("snapshot.json")
        .is_file());
    assert!(!state::staging_dir(&e.layout).exists());
    assert_eq!(
        state::load(&e.layout).unwrap().unwrap().phase,
        Phase::Committed
    );
}

#[test]
fn a_failed_health_gate_rolls_back_byte_identically_and_restarts_the_old_version() {
    let mut e = env();
    with_core(&mut e);
    let before = originals(&e);
    let host = Fake {
        running: true,
        gate_err: Some("1staid check failed: core".into()),
        ..Default::default()
    };
    let st = apply(&e.layout, &host, &e.plan, &e.bin).unwrap();
    assert_eq!(st.phase, Phase::RolledBack);
    assert_eq!(st.reason.as_deref(), Some("health-gate-failed"));
    assert!(st.message.unwrap().contains("1staid check failed"));
    assert_eq!(originals(&e), before);
    assert_eq!(
        fs::read(e.layout.runtime().join("core/core.js")).unwrap(),
        b"old core"
    );
    assert_eq!(
        *host.calls.borrow(),
        [
            "stop",
            "start:new-binary",
            "gate",
            "stop",
            "start:old-binary"
        ]
    );
}

#[test]
fn a_start_failure_rolls_back_and_a_daemon_that_was_off_stays_off() {
    let e = env();
    let before = originals(&e);
    let host = Fake {
        running: false,
        start_err_once: RefCell::new(Some("boom".into())),
        ..Default::default()
    };
    let st = apply(&e.layout, &host, &e.plan, &e.bin).unwrap();
    assert_eq!(
        (st.phase, st.reason.as_deref()),
        (Phase::RolledBack, Some("start-failed"))
    );
    assert_eq!(originals(&e), before);
    assert_eq!(*host.calls.borrow(), ["stop", "start:new-binary", "stop"]);
}

#[test]
fn a_tampered_download_is_refused_before_anything_changes() {
    let mut e = env();
    e.plan.binary.sha256 = "0".repeat(64);
    let before = originals(&e);
    let host = Fake::default();
    let err = apply(&e.layout, &host, &e.plan, &e.bin).unwrap_err();
    assert_eq!(err.reason, "digest-mismatch");
    assert_eq!(originals(&e), before);
    assert!(host.calls.borrow().is_empty());
    assert!(state::load(&e.layout).unwrap().is_none());
    assert!(!state::staging_dir(&e.layout).exists());
}

#[test]
fn a_tampered_core_payload_is_refused_too() {
    let mut e = env();
    with_core(&mut e);
    e.plan.core.as_mut().unwrap().0.sha256 = "1".repeat(64);
    assert_eq!(
        apply(&e.layout, &Fake::default(), &e.plan, &e.bin)
            .unwrap_err()
            .reason,
        "digest-mismatch"
    );
    assert_eq!(fs::read(&e.bin).unwrap(), b"old-binary");
}

fn crash_at(e: &Env, phase: Phase) {
    // Leave the files as an updater killed right after writing `phase` would: run the flow by hand up to it.
    let mut st = fresh_state(&e.plan, &e.bin, "update");
    st.owner = 4_000_000_000;
    st.was_running = true;
    download(&e.layout, &e.plan).unwrap();
    snapshot::create(&e.layout, &e.bin).unwrap();
    if phase >= Phase::Swapping {
        swap(&e.layout, &e.plan, &e.bin, &mut st).unwrap();
        fs::write(e.layout.config_path(), "{\"engine\":{\"migrated\":true}}").unwrap();
    }
    st.phase = phase;
    state::save(&e.layout, &mut st).unwrap();
}

#[test]
fn a_crash_after_the_swap_is_rolled_back_at_the_next_start() {
    for phase in [
        Phase::Swapping,
        Phase::Swapped,
        Phase::Started,
        Phase::RollingBack,
    ] {
        let mut e = env();
        with_core(&mut e);
        let before = originals(&e);
        crash_at(&e, phase);
        assert_ne!(
            originals(&e),
            before,
            "{phase:?}: the crash must have changed something"
        );
        let host = Fake::default();
        let st = recover(&e.layout, &host).unwrap().unwrap();
        assert_eq!(st.phase, Phase::RolledBack, "{phase:?}");
        assert_eq!(originals(&e), before, "{phase:?}");
        assert_eq!(
            fs::read(e.layout.runtime().join("core/core.js")).unwrap(),
            b"old core"
        );
        // settled: a second pass is a no-op
        assert!(recover(&e.layout, &host).unwrap().is_none());
    }
}

#[test]
fn a_crash_before_the_swap_changes_nothing_and_a_crash_after_the_gate_rolls_forward() {
    let e = env();
    let before = originals(&e);
    crash_at(&e, Phase::Snapshotted);
    let st = recover(&e.layout, &Fake::default()).unwrap().unwrap();
    assert_eq!(
        (st.phase, st.reason.as_deref()),
        (Phase::RolledBack, Some("interrupted"))
    );
    assert_eq!(originals(&e), before);

    let e = env();
    crash_at(&e, Phase::Gated);
    let st = recover(&e.layout, &Fake::default()).unwrap().unwrap();
    assert_eq!(st.phase, Phase::Committed);
    assert_eq!(fs::read(&e.bin).unwrap(), b"new-binary");
    assert_eq!(
        manifest::read(&e.layout).unwrap().unwrap().binary.version,
        "0.2.0"
    );
}

#[test]
fn recovery_leaves_a_live_owner_alone_and_a_second_update_is_refused() {
    let e = env();
    crash_at(&e, Phase::Swapped);
    let host = Fake {
        alive: true,
        ..Default::default()
    };
    assert!(recover(&e.layout, &host).unwrap().is_none());
    assert_eq!(
        apply(&e.layout, &host, &e.plan, &e.bin).unwrap_err().reason,
        "update-in-progress"
    );
    assert_eq!(
        state::load(&e.layout).unwrap().unwrap().phase,
        Phase::Swapped
    );
}

#[test]
fn a_tampered_snapshot_is_never_restored() {
    let e = env();
    crash_at(&e, Phase::Swapped);
    fs::write(state::snapshot_dir(&e.layout).join("plur1bus"), "evil").unwrap();
    let st = recover(&e.layout, &Fake::default()).unwrap().unwrap();
    assert_eq!(st.phase, Phase::Failed);
    assert_eq!(
        fs::read(&e.bin).unwrap(),
        b"new-binary",
        "nothing is restored from a bad snapshot"
    );
    assert!(st.message.unwrap().contains("rollback refused"));
}

#[test]
fn manual_rollback_restores_the_last_committed_update_once() {
    let mut e = env();
    with_core(&mut e);
    let before = originals(&e);
    let host = Fake {
        running: true,
        ..Default::default()
    };
    apply(&e.layout, &host, &e.plan, &e.bin).unwrap();
    let st = rollback_manual(&e.layout, &host).unwrap();
    assert_eq!(
        (st.phase, st.trigger.as_str()),
        (Phase::RolledBack, "manual-rollback")
    );
    assert_eq!((st.from.as_str(), st.to.as_str()), ("0.2.0", "0.1.0"));
    assert_eq!(originals(&e), before);
    assert_eq!(
        fs::read(e.layout.runtime().join("core/core.js")).unwrap(),
        b"old core"
    );
    assert_eq!(
        rollback_manual(&e.layout, &host).unwrap_err().reason,
        "nothing-to-roll-back"
    );
}

#[test]
fn manual_rollback_without_an_update_says_so() {
    let e = env();
    assert_eq!(
        rollback_manual(&e.layout, &Fake::default())
            .unwrap_err()
            .reason,
        "nothing-to-roll-back"
    );
}

fn with_addons(e: &mut Env, disable: &[&str], reenable: &[&str]) {
    e.plan.addons = addons::AddonPlan {
        disable: disable.iter().map(|s| s.to_string()).collect(),
        reenable: reenable.iter().map(|s| s.to_string()).collect(),
        ..Default::default()
    };
}

#[test]
fn incompatible_addons_are_disabled_after_the_swap_and_before_the_start() {
    let mut e = env();
    with_addons(&mut e, &["fancy", "other"], &["back"]);
    let host = Fake {
        running: true,
        ..Default::default()
    };
    let st = apply(&e.layout, &host, &e.plan, &e.bin).unwrap();
    assert_eq!(st.phase, Phase::Committed);
    assert_eq!(
        *host.calls.borrow(),
        [
            "stop",
            "disable:fancy,other",
            "start:new-binary",
            "gate",
            "reenable:back"
        ],
        "re-enabled only once the new version is healthy"
    );
    assert_eq!(st.addons_disabled, ["fancy", "other"]);
}

#[test]
fn a_rollback_puts_the_addons_back_and_a_failed_disable_is_a_rollback() {
    let mut e = env();
    with_addons(&mut e, &["fancy"], &["back"]);
    let before = originals(&e);
    let host = Fake {
        running: true,
        gate_err: Some("nope".into()),
        ..Default::default()
    };
    let st = apply(&e.layout, &host, &e.plan, &e.bin).unwrap();
    assert_eq!(st.phase, Phase::RolledBack);
    assert_eq!(originals(&e), before);
    let calls = host.calls.borrow();
    assert!(calls.contains(&"restore:fancy".to_string()), "{calls:?}");
    assert!(
        !calls.iter().any(|c| c.starts_with("reenable")),
        "{calls:?}"
    );
    drop(calls);

    let mut e = env();
    with_addons(&mut e, &["fancy"], &[]);
    let host = Fake {
        running: true,
        disable_err: Some("fancy: config.json is invalid".into()),
        ..Default::default()
    };
    let st = apply(&e.layout, &host, &e.plan, &e.bin).unwrap();
    assert_eq!(
        (st.phase, st.reason.as_deref()),
        (Phase::RolledBack, Some("addon-disable-failed"))
    );
    assert!(st.message.unwrap().contains("config.json is invalid"));
    assert_eq!(fs::read(&e.bin).unwrap(), b"old-binary");
    assert!(
        !host
            .calls
            .borrow()
            .iter()
            .any(|c| c.starts_with("start:new")),
        "the new version never started"
    );
}

#[test]
fn a_manual_rollback_re_enables_what_the_update_disabled() {
    let mut e = env();
    with_addons(&mut e, &["fancy"], &[]);
    let host = Fake {
        running: true,
        ..Default::default()
    };
    apply(&e.layout, &host, &e.plan, &e.bin).unwrap();
    host.calls.borrow_mut().clear();
    rollback_manual(&e.layout, &host).unwrap();
    assert!(host.calls.borrow().contains(&"restore:fancy".to_string()));
}

#[test]
fn the_highest_seen_version_is_recorded_once_the_artefacts_verified_and_not_before() {
    let mut e = env();
    e.plan.record_seen = true;
    let host = Fake::default();
    // A download that fails the digest records nothing.
    let good = e.plan.binary.sha256.clone();
    e.plan.binary.sha256 = "0".repeat(64);
    assert!(apply(&e.layout, &host, &e.plan, &e.bin).is_err());
    assert!(guard::load(&e.layout).unwrap().highest_seen.is_empty());
    e.plan.binary.sha256 = good;
    apply(&e.layout, &host, &e.plan, &e.bin).unwrap();
    assert_eq!(
        guard::load(&e.layout).unwrap().highest_seen["stable"],
        "0.2.0"
    );
}

#[test]
fn a_declared_size_must_match_exactly() {
    let mut e = env();
    let real = fs::metadata(&e.plan.binary.url).unwrap().len();
    e.plan.binary.size = Some(real + 1);
    let err = apply(&e.layout, &Fake::default(), &e.plan, &e.bin).unwrap_err();
    assert!(
        matches!(err.reason, "size-mismatch" | "digest-mismatch"),
        "{err:?}"
    );
    e.plan.binary.size = Some(real - 1);
    let err = apply(&e.layout, &Fake::default(), &e.plan, &e.bin).unwrap_err();
    assert_eq!(err.reason, "download-too-large");
    e.plan.binary.size = Some(real);
    assert!(apply(&e.layout, &Fake::default(), &e.plan, &e.bin).is_ok());
}
