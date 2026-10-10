#![cfg(debug_assertions)]
#[path = "support/controller.rs"]
mod support;
use plur1bus_desktop::{
    connections::{Connection, Kind, Origin},
    controller::{
        bundle::{embedded, Bundle},
        journal::Step,
        upgrade::{Outcome, UpgradeProbe},
        Controller, Resources,
    },
    runtime::{ExecOutput, RuntimeKind},
    secrets::{token_account, MemoryStore, SecretString, TokenStore},
};
use serde_json::{json, Value};
use std::{
    sync::{Arc, Mutex},
    time::Duration,
};
use support::{FakeRuntime, Healthy};
fn output(v: Value) -> ExecOutput {
    ExecOutput {
        code: 0,
        stdout: serde_json::to_vec(&v).unwrap(),
        stderr: vec![],
    }
}
fn aid() -> Value {
    json!({"schema":"1staid.check/1","checks":[{"id":"storage","status":"ok","detail":{"stateUsedBytes":100,"freeBytes":10000,"imageBytes":100}},{"id":"engine.storeSchema","status":"ok","detail":{"current":1,"required":1}}]})
}
fn snapshot() -> Value {
    json!({"schema":"state.snapshot/1","manifestSha256":"a".repeat(64),"fileCount":1,"bytes":100,"createdAt":"2026-10-10T00:00:00Z"})
}
struct Probe(Mutex<Option<&'static str>>);
#[async_trait::async_trait]
impl UpgradeProbe for Probe {
    async fn check(
        &self,
        _: &Connection,
        token: &SecretString,
        _: &semver::Version,
    ) -> Result<(), &'static str> {
        assert_eq!(token.expose(), "synthetic-device-credential");
        let mut fail = self.0.lock().unwrap();
        if let Some(reason) = fail.take() {
            Err(reason)
        } else {
            Ok(())
        }
    }
}
static SERIAL: std::sync::LazyLock<Arc<tokio::sync::Mutex<()>>> =
    std::sync::LazyLock::new(|| Arc::new(tokio::sync::Mutex::new(())));
struct Fixture {
    _serial: tokio::sync::OwnedMutexGuard<()>,
    dir: tempfile::TempDir,
    ctl: Controller,
    runtime: Arc<FakeRuntime>,
    tokens: MemoryStore,
    conn: Connection,
    target: Bundle,
    probe: Arc<Probe>,
}
async fn fixture(kind: RuntimeKind) -> Fixture {
    let serial = SERIAL.clone().lock_owned().await;
    let dir = tempfile::tempdir().unwrap();
    let runtime = Arc::new(FakeRuntime::new(kind));
    let probe = Arc::new(Probe(Mutex::new(None)));
    let ctl = Controller::with_health(
        runtime.clone(),
        {
            let mut b = embedded().clone();
            b.version = "0.1.0".into();
            b
        },
        dir.path().join("bundled"),
        Arc::new(Healthy),
    )
    .with_upgrade_probe(probe.clone(), Duration::from_millis(20));
    ctl.install(Resources::default(), |_| {}).await.unwrap();
    *runtime.exec_hook.lock().unwrap() = Some(Arc::new(|argv| {
        if argv.contains(&"check") {
            output(aid())
        } else if argv.contains(&"smoke") || argv.contains(&"migrate") {
            output(
                json!({"schema":if argv.contains(&"smoke"){"admin.smoke/1"}else{"admin.migrate/1"},"ok":true}),
            )
        } else {
            output(
                json!({"schema":"daemon.status/1","supervisor":{"process":{"state":"running"}},"children":[{"kind":"core","process":{"state":"ready"}}]}),
            )
        }
    }));
    *runtime.oneshot_hook.lock().unwrap() = Some(Arc::new(|argv| {
        if argv.contains(&"snapshot") {
            output(snapshot())
        } else {
            output(
                json!({"schema":if argv.contains(&"verify"){"state.verify/1"}else{"state.restore/1"},"ok":true,"manifestSha256":"a".repeat(64)}),
            )
        }
    }));
    let conn = Connection::new(
        "fixture".into(),
        Kind::Bundled,
        Origin::parse("http://127.0.0.1:18700").unwrap(),
        "fixture-install".into(),
        "device".into(),
        "hint".into(),
    );
    let tokens = MemoryStore::default();
    tokens
        .set(
            &token_account(conn.id),
            &SecretString::new("synthetic-device-credential".into()),
        )
        .unwrap();
    let mut target = embedded().clone();
    target.version = "0.1.1".into();
    for digest in target.images.values_mut() {
        *digest = format!("sha256:{}", "b".repeat(64));
    }
    runtime.state.lock().unwrap().calls.clear();
    Fixture {
        _serial: serial,
        dir,
        ctl,
        runtime,
        tokens,
        conn,
        target,
        probe,
    }
}
#[tokio::test]
async fn happy_path_runs_every_step_in_order_and_keeps_previous_and_snapshot() {
    for kind in [RuntimeKind::Apple, RuntimeKind::Docker] {
        let f = fixture(kind).await;
        let steps = Mutex::new(vec![]);
        assert!(matches!(
            f.ctl
                .upgrade(
                    &f.target,
                    semver::Version::parse("0.1.1").unwrap(),
                    plur1bus_desktop::updates::Kind::Patch,
                    &f.tokens,
                    &f.conn,
                    |s| steps.lock().unwrap().push(s)
                )
                .await
                .unwrap(),
            Outcome::Upgraded { .. }
        ));
        assert_eq!(
            *steps.lock().unwrap(),
            [
                Step::Preflight,
                Step::Stopping,
                Step::Snapshotting,
                Step::Swapping,
                Step::Migrating,
                Step::Gating,
                Step::Done
            ]
        );
        let s = f.runtime.state.lock().unwrap();
        assert!(s.containers.contains_key("plur1bus-harness-previous"));
        assert!(s.volumes.contains("plur1bus-state-pre-0.1.0"));
        assert_eq!(
            f.ctl.installed().unwrap().unwrap().installed_version,
            "0.1.1"
        );
    }
}
#[tokio::test]
async fn preflight_fail_changes_nothing() {
    for kind in [RuntimeKind::Apple, RuntimeKind::Docker] {
        let f = fixture(kind).await;
        *f.runtime.exec_hook.lock().unwrap() = Some(Arc::new(|_| {
            output(json!({"schema":"1staid.check/1","checks":[{"id":"storage","status":"fail"}]}))
        }));
        assert!(run(&f).await.is_err());
        assert!(!f
            .runtime
            .state
            .lock()
            .unwrap()
            .calls
            .iter()
            .any(|c| c.starts_with("stop:")));
    }
}
async fn run(f: &Fixture) -> Result<Outcome, plur1bus_desktop::controller::CtlError> {
    f.ctl
        .upgrade(
            &f.target,
            semver::Version::parse("0.1.1").unwrap(),
            plur1bus_desktop::updates::Kind::Patch,
            &f.tokens,
            &f.conn,
            |_| {},
        )
        .await
}
#[tokio::test]
async fn token_rejected_after_upgrade() {
    for kind in [RuntimeKind::Apple, RuntimeKind::Docker] {
        let f = fixture(kind).await;
        *f.probe.0.lock().unwrap() = Some("token");
        assert!(matches!(
            run(&f).await.unwrap(),
            Outcome::RolledBack {
                failed_step: Step::Gating,
                ..
            }
        ));
        assert_eq!(
            f.ctl.installed().unwrap().unwrap().installed_version,
            "0.1.0"
        );
        assert!(f.ctl.upgrade_journal().unwrap().unwrap().skipped);
    }
}
#[tokio::test]
async fn snapshot_disk_full_restarts_the_old_version_unchanged() {
    for kind in [RuntimeKind::Apple, RuntimeKind::Docker] {
        let f = fixture(kind).await;
        f.runtime.state.lock().unwrap().fail_once = Some("oneshot".into());
        assert!(matches!(
            run(&f).await.unwrap(),
            Outcome::RolledBack {
                failed_step: Step::Snapshotting,
                ..
            }
        ));
        let s = f.runtime.state.lock().unwrap();
        assert!(s.running.contains("plur1bus-harness"));
        assert!(!s.volumes.contains("plur1bus-state-pre-0.1.0"));
        assert!(!s.calls.iter().any(|c| c == "rename"));
    }
}
#[tokio::test]
async fn corrupted_snapshot_before_restore_is_recovery_failed_and_deletes_nothing() {
    for kind in [RuntimeKind::Apple, RuntimeKind::Docker] {
        let f = fixture(kind).await;
        assert!(matches!(run(&f).await.unwrap(), Outcome::Upgraded { .. }));
        f.runtime.state.lock().unwrap().calls.clear();
        *f.runtime.oneshot_hook.lock().unwrap() = Some(Arc::new(|_| {
            output(json!({"schema":"state.verify/1","ok":false}))
        }));
        assert!(matches!(
            f.ctl
                .rollback_manual(true, &f.tokens, &f.conn, |_| {})
                .await
                .unwrap(),
            Outcome::RecoveryFailed { .. }
        ));
        assert!(!f
            .runtime
            .state
            .lock()
            .unwrap()
            .calls
            .iter()
            .any(|c| c == "remove" || c.starts_with("remove-volume:")));
    }
}
#[tokio::test]
async fn manual_rollback_restores_the_snapshot_and_warns_first() {
    for kind in [RuntimeKind::Apple, RuntimeKind::Docker] {
        let f = fixture(kind).await;
        run(&f).await.unwrap();
        assert!(f
            .ctl
            .rollback_manual(false, &f.tokens, &f.conn, |_| {})
            .await
            .is_err());
        assert!(matches!(
            f.ctl
                .rollback_manual(true, &f.tokens, &f.conn, |_| {})
                .await
                .unwrap(),
            Outcome::RolledBack { .. }
        ));
    }
}
#[tokio::test]
async fn the_device_token_survives_an_upgrade_and_a_rollback() {
    for kind in [RuntimeKind::Apple, RuntimeKind::Docker] {
        let f = fixture(kind).await;
        run(&f).await.unwrap();
        f.ctl
            .rollback_manual(true, &f.tokens, &f.conn, |_| {})
            .await
            .unwrap();
        assert_eq!(
            f.tokens
                .get(&token_account(f.conn.id))
                .unwrap()
                .unwrap()
                .expose(),
            "synthetic-device-credential"
        );
        assert!(
            !std::fs::read_to_string(f.dir.path().join("bundled/upgrades.json"))
                .unwrap()
                .contains("synthetic-device-credential")
        );
    }
}
#[tokio::test]
async fn patch_upgrade_with_a_schema_change_is_refused() {
    for kind in [RuntimeKind::Apple, RuntimeKind::Docker] {
        let f = fixture(kind).await;
        let n = Arc::new(Mutex::new(0));
        *f.runtime.exec_hook.lock().unwrap() = Some(Arc::new(move |a| {
            if a.contains(&"check") {
                let mut calls = n.lock().unwrap();
                *calls += 1;
                let mut v = aid();
                if *calls == 2 {
                    v["checks"][1]["detail"]["required"] = json!(2);
                }
                output(v)
            } else if a.contains(&"smoke") {
                output(json!({"schema":"admin.smoke/1","ok":true}))
            } else {
                output(
                    json!({"schema":"daemon.status/1","supervisor":{"process":{"state":"running"}},"children":[{"kind":"core","process":{"state":"ready"}}]}),
                )
            }
        }));
        assert!(matches!(
            run(&f).await.unwrap(),
            Outcome::RolledBack {
                failed_step: Step::Migrating,
                ..
            }
        ));
        assert!(!f
            .runtime
            .state
            .lock()
            .unwrap()
            .calls
            .iter()
            .any(|c| c.contains("admin migrate")));
    }
}

#[tokio::test]
async fn diagnostic_is_redacted() {
    for kind in [RuntimeKind::Apple, RuntimeKind::Docker] {
        let f = fixture(kind).await;
        *f.runtime.log_sample.lock().unwrap() =
            "synthetic-device-credential Authorization: Bearer synthetic-device-credential".into();
        *f.probe.0.lock().unwrap() = Some("token");
        run(&f).await.unwrap();
        let j = f.ctl.upgrade_journal().unwrap().unwrap();
        assert!(!j
            .diagnostic
            .unwrap()
            .contains("synthetic-device-credential"));
    }
}
#[tokio::test]
async fn injected_failures_roll_back_and_name_the_step() {
    for kind in [RuntimeKind::Apple, RuntimeKind::Docker] {
        for fail in ["create", "start"] {
            let f = fixture(kind).await;
            f.runtime.state.lock().unwrap().fail_once = Some(fail.into());
            let out = run(&f).await.unwrap();
            assert!(matches!(
                out,
                Outcome::RolledBack {
                    failed_step: Step::Swapping,
                    ..
                }
            ));
            assert!(f.ctl.upgrade_journal().unwrap().unwrap().skipped);
        }
    }
}
#[tokio::test]
async fn firstaid_fails_after_upgrade() {
    for kind in [RuntimeKind::Apple, RuntimeKind::Docker] {
        let f = fixture(kind).await;
        let original = f.runtime.exec_hook.lock().unwrap().clone().unwrap();
        let count = Mutex::new(0);
        *f.runtime.exec_hook.lock().unwrap() = Some(Arc::new(move |argv| {
            if argv.contains(&"check") {
                let mut n = count.lock().unwrap();
                *n += 1;
                if *n == 2 {
                    return output(
                        json!({"schema":"1staid.check/1","checks":[{"id":"test","status":"fail"}]}),
                    );
                }
            }
            original(argv)
        }));
        assert!(matches!(
            run(&f).await.unwrap(),
            Outcome::RolledBack {
                failed_step: Step::Migrating,
                ..
            }
        ));
    }
}
#[tokio::test]
async fn smoke_fails() {
    for kind in [RuntimeKind::Apple, RuntimeKind::Docker] {
        let f = fixture(kind).await;
        let original = f.runtime.exec_hook.lock().unwrap().clone().unwrap();
        let count = Mutex::new(0);
        *f.runtime.exec_hook.lock().unwrap() = Some(Arc::new(move |argv| {
            if argv.contains(&"smoke") {
                let mut n = count.lock().unwrap();
                *n += 1;
                if *n == 1 {
                    return output(json!({"schema":"admin.smoke/1","ok":false}));
                }
            }
            original(argv)
        }));
        assert!(matches!(
            run(&f).await.unwrap(),
            Outcome::RolledBack {
                failed_step: Step::Gating,
                ..
            }
        ));
    }
}
#[tokio::test]
async fn new_image_never_ready() {
    for kind in [RuntimeKind::Apple, RuntimeKind::Docker] {
        let f = fixture(kind).await;
        let original = f.runtime.exec_hook.lock().unwrap().clone().unwrap();
        let once = Mutex::new(false);
        *f.runtime.exec_hook.lock().unwrap() = Some(Arc::new(move |argv| {
            if argv.contains(&"status") {
                let mut used = once.lock().unwrap();
                if !*used {
                    *used = true;
                    return output(
                        json!({"schema":"daemon.status/1","supervisor":{"process":{"state":"starting"}},"children":[]}),
                    );
                }
            }
            original(argv)
        }));
        assert!(matches!(
            run(&f).await.unwrap(),
            Outcome::RolledBack {
                failed_step: Step::Migrating,
                ..
            }
        ));
    }
}
#[tokio::test]
async fn migration_fails() {
    for kind in [RuntimeKind::Apple, RuntimeKind::Docker] {
        let f = fixture(kind).await;
        let original = f.runtime.exec_hook.lock().unwrap().clone().unwrap();
        let count = Mutex::new(0);
        *f.runtime.exec_hook.lock().unwrap() = Some(Arc::new(move |argv| {
            if argv.contains(&"check") {
                let mut n = count.lock().unwrap();
                *n += 1;
                if *n == 2 {
                    let mut v = aid();
                    v["checks"][1]["detail"]["required"] = json!(2);
                    return output(v);
                }
            }
            if argv.contains(&"migrate") {
                return ExecOutput {
                    code: 2,
                    stdout: vec![],
                    stderr: b"synthetic-device-credential".to_vec(),
                };
            }
            original(argv)
        }));
        assert!(matches!(
            f.ctl
                .upgrade(
                    &f.target,
                    semver::Version::parse("0.1.1").unwrap(),
                    plur1bus_desktop::updates::Kind::Minor,
                    &f.tokens,
                    &f.conn,
                    |_| {}
                )
                .await
                .unwrap(),
            Outcome::RolledBack {
                failed_step: Step::Migrating,
                ..
            }
        ));
    }
}
#[tokio::test]
async fn gate_times_out() {
    struct OnceSlow(Mutex<bool>);
    #[async_trait::async_trait]
    impl UpgradeProbe for OnceSlow {
        async fn check(
            &self,
            _: &Connection,
            _: &SecretString,
            _: &semver::Version,
        ) -> Result<(), &'static str> {
            let first = {
                let mut v = self.0.lock().unwrap();
                let was = *v;
                *v = false;
                was
            };
            if first {
                std::future::pending::<()>().await;
            }
            Ok(())
        }
    }
    for kind in [RuntimeKind::Apple, RuntimeKind::Docker] {
        let mut f = fixture(kind).await;
        f.ctl = f.ctl.with_upgrade_probe(
            Arc::new(OnceSlow(Mutex::new(true))),
            Duration::from_millis(20),
        );
        assert!(matches!(
            run(&f).await.unwrap(),
            Outcome::RolledBack {
                failed_step: Step::Gating,
                ..
            }
        ));
    }
}
#[tokio::test]
async fn interrupted_upgrade_resumes_at_every_step() {
    for kind in [RuntimeKind::Apple, RuntimeKind::Docker] {
        for step in [
            Step::Preflight,
            Step::Stopping,
            Step::Snapshotting,
            Step::Swapping,
            Step::Migrating,
            Step::Gating,
            Step::RollingBack,
            Step::RestoringSnapshot,
            Step::StartingPrevious,
            Step::GatingPrevious,
        ] {
            let f = fixture(kind).await;
            run(&f).await.unwrap();
            let mut j = f.ctl.upgrade_journal().unwrap().unwrap();
            j.step = step;
            j.failed_step = Some(step);
            j.save(&f.dir.path().join("bundled")).unwrap();
            if matches!(step, Step::Preflight | Step::Stopping | Step::Snapshotting) {
                let mut s = f.runtime.state.lock().unwrap();
                let mut old = s.containers.remove("plur1bus-harness-previous").unwrap();
                old.name = "plur1bus-harness".into();
                s.containers.insert(old.name.clone(), old);
            }
            assert!(matches!(
                f.ctl
                    .resume(&f.tokens, &f.conn, |_| {})
                    .await
                    .unwrap()
                    .unwrap(),
                Outcome::RolledBack { .. }
            ));
            assert_eq!(
                f.ctl.installed().unwrap().unwrap().installed_version,
                "0.1.0"
            );
        }
    }
}

#[tokio::test]
async fn crash_at_write_ahead_boundaries_recovers_from_actual_partial_operations() {
    use futures_util::FutureExt;
    for kind in [RuntimeKind::Apple, RuntimeKind::Docker] {
        for boundary in [
            Step::Preflight,
            Step::Stopping,
            Step::Snapshotting,
            Step::Swapping,
            Step::Migrating,
            Step::Gating,
        ] {
            let f = fixture(kind).await;
            let interrupted = std::panic::AssertUnwindSafe(f.ctl.upgrade(
                &f.target,
                semver::Version::parse("0.1.1").unwrap(),
                plur1bus_desktop::updates::Kind::Patch,
                &f.tokens,
                &f.conn,
                |step| {
                    if step == boundary {
                        panic!("synthetic power loss");
                    }
                },
            ))
            .catch_unwind()
            .await;
            assert!(interrupted.is_err());
            let restarted = Controller::with_health(
                f.runtime.clone(),
                embedded().clone(),
                f.dir.path().join("bundled"),
                Arc::new(Healthy),
            )
            .with_upgrade_probe(f.probe.clone(), Duration::from_millis(20));
            assert!(matches!(
                restarted.resume(&f.tokens, &f.conn, |_| {}).await.unwrap(),
                Some(Outcome::RolledBack { .. })
            ));
            assert_eq!(
                restarted.installed().unwrap().unwrap().installed_version,
                "0.1.0"
            );
        }
    }
}
#[tokio::test]
async fn crash_at_each_restore_phase_never_recopies_the_failed_state_after_replacement() {
    for kind in [RuntimeKind::Apple, RuntimeKind::Docker] {
        use futures_util::FutureExt;
        use plur1bus_desktop::controller::journal::{Journal, RestorePhase};
        for phase in [
            RestorePhase::VerifySnapshot,
            RestorePhase::PreserveFailed,
            RestorePhase::VerifyFailed,
            RestorePhase::RemoveNew,
            RestorePhase::ReplaceState,
            RestorePhase::RestoreState,
            RestorePhase::RenamePrevious,
            RestorePhase::Start,
            RestorePhase::Gate,
        ] {
            let f = fixture(kind).await;
            run(&f).await.unwrap();
            let root = f.dir.path().join("bundled");
            let interrupted = std::panic::AssertUnwindSafe(f.ctl.rollback_manual(
                true,
                &f.tokens,
                &f.conn,
                |_| {
                    if Journal::load(&root).unwrap().unwrap().restore_phase == phase {
                        panic!("synthetic restore interruption");
                    }
                },
            ))
            .catch_unwind()
            .await;
            assert!(interrupted.is_err());
            f.runtime.state.lock().unwrap().calls.clear();
            assert!(matches!(
                f.ctl.resume(&f.tokens, &f.conn, |_| {}).await.unwrap(),
                Some(Outcome::RolledBack { .. })
            ));
            if matches!(
                phase,
                RestorePhase::ReplaceState
                    | RestorePhase::RestoreState
                    | RestorePhase::RenamePrevious
                    | RestorePhase::Start
                    | RestorePhase::Gate
            ) {
                assert!(!f
                    .runtime
                    .state
                    .lock()
                    .unwrap()
                    .calls
                    .iter()
                    .any(|c| c.starts_with("volume:plur1bus-state-failed")));
            }
        }
    }
}
#[tokio::test]
async fn journal_is_private_and_repeated_preflight_failure_keeps_the_last_backup() {
    let f = fixture(RuntimeKind::Docker).await;
    run(&f).await.unwrap();
    let old = std::fs::read(f.dir.path().join("bundled/upgrades.json")).unwrap();
    let mut next = f.target.clone();
    next.version = "0.1.2".into();
    *f.runtime.exec_hook.lock().unwrap() = Some(Arc::new(|_| {
        output(json!({"schema":"1staid.check/1","checks":[{"id":"test","status":"fail"}]}))
    }));
    assert!(f
        .ctl
        .upgrade(
            &next,
            semver::Version::parse("0.1.2").unwrap(),
            plur1bus_desktop::updates::Kind::Patch,
            &f.tokens,
            &f.conn,
            |_| {}
        )
        .await
        .is_err());
    assert_eq!(
        std::fs::read(f.dir.path().join("bundled/upgrades.json")).unwrap(),
        old
    );
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        assert_eq!(
            std::fs::metadata(f.dir.path().join("bundled/upgrades.json"))
                .unwrap()
                .permissions()
                .mode()
                & 0o777,
            0o600
        );
    }
}
#[tokio::test]
async fn manual_rollback_is_unavailable_when_the_snapshot_volume_is_missing() {
    for kind in [RuntimeKind::Apple, RuntimeKind::Docker] {
        let f = fixture(kind).await;
        run(&f).await.unwrap();
        let j = f.ctl.upgrade_journal().unwrap().unwrap();
        f.runtime
            .state
            .lock()
            .unwrap()
            .volumes
            .remove(&j.snapshot.unwrap().volume);
        f.runtime.state.lock().unwrap().calls.clear();
        assert!(f
            .ctl
            .rollback_manual(true, &f.tokens, &f.conn, |_| {})
            .await
            .is_err());
        assert!(f.runtime.state.lock().unwrap().calls.is_empty());
    }
}
