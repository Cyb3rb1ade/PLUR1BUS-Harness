#[path = "support/controller.rs"]
mod support_controller;
use plur1bus_desktop::{
    controller::{Controller, HarnessStatus, InstallStep, Resources},
    runtime::RuntimeKind,
};
use std::sync::Arc;
use support_controller::{FakeRuntime, Healthy};
#[tokio::test]
async fn install_happy_path_emits_steps_in_order() {
    for kind in [RuntimeKind::Apple, RuntimeKind::Docker] {
        let dir = tempfile::tempdir().unwrap();
        let runtime = Arc::new(FakeRuntime::new(kind));
        let ctl = Controller::with_health(
            runtime.clone(),
            plur1bus_desktop::controller::bundle::embedded().clone(),
            dir.path().join("bundled"),
            Arc::new(Healthy),
        )
        .with_test_namespace("controller")
        .unwrap();
        let steps = std::sync::Mutex::new(vec![]);
        let installed = ctl
            .install(Resources::default(), |s| steps.lock().unwrap().push(s))
            .await
            .unwrap();
        assert_eq!(
            *steps.lock().unwrap(),
            vec![
                InstallStep::Image,
                InstallStep::Volumes,
                InstallStep::Network,
                InstallStep::Container,
                InstallStep::Start,
                InstallStep::Done
            ]
        );
        assert!(matches!(ctl.status().await,HarnessStatus::Ready{port} if port==installed.port));
        let s = runtime.state.lock().unwrap();
        let spec = s.containers.get(&installed.container).unwrap();
        assert_eq!(spec.memory_mib, 3072);
        assert_eq!(spec.host_port, Some(installed.port));
        assert!(spec
            .volumes
            .iter()
            .any(|(_, p, _)| p == "/var/lib/plur1bus"));
    }
}
#[tokio::test]
async fn install_is_idempotent_after_a_partial_failure() {
    for fail in [
        "pull",
        "volume:plur1bus-state",
        "volume:plur1bus-models",
        "network",
        "create",
        "start",
    ] {
        let dir = tempfile::tempdir().unwrap();
        let runtime = Arc::new(FakeRuntime::new(RuntimeKind::Docker));
        runtime.state.lock().unwrap().fail_once = Some(fail.into());
        let ctl = Controller::with_health(
            runtime.clone(),
            plur1bus_desktop::controller::bundle::embedded().clone(),
            dir.path().join("bundled"),
            Arc::new(Healthy),
        )
        .with_test_namespace("controller")
        .unwrap();
        assert!(ctl.install(Resources::default(), |_| {}).await.is_err());
        let before = runtime.state.lock().unwrap().volumes.clone();
        ctl.install(Resources::default(), |_| {}).await.unwrap();
        assert!(before
            .iter()
            .all(|v| runtime.state.lock().unwrap().volumes.contains(v)));
    }
}
#[tokio::test]
async fn port_in_use_picks_the_next_and_keeps_the_connection() {
    let first = std::net::TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, 18700)).unwrap();
    let dir = tempfile::tempdir().unwrap();
    let runtime = Arc::new(FakeRuntime::new(RuntimeKind::Docker));
    let ctl = Controller::with_health(
        runtime,
        plur1bus_desktop::controller::bundle::embedded().clone(),
        dir.path().join("bundled"),
        Arc::new(Healthy),
    )
    .with_test_namespace("controller")
    .unwrap();
    let installed = ctl.install(Resources::default(), |_| {}).await.unwrap();
    assert!(installed.port > 18700);
    assert_eq!(ctl.installed().unwrap().unwrap().port, installed.port);
    drop(first);
}
#[tokio::test]
async fn all_runtime_published_ports_are_refused() {
    let dir = tempfile::tempdir().unwrap();
    let runtime = Arc::new(FakeRuntime::new(RuntimeKind::Docker));
    runtime
        .state
        .lock()
        .unwrap()
        .published
        .extend(18700..=18799);
    let ctl = Controller::with_health(
        runtime,
        plur1bus_desktop::controller::bundle::embedded().clone(),
        dir.path().join("bundled"),
        Arc::new(Healthy),
    )
    .with_test_namespace("published")
    .unwrap();
    assert!(matches!(
        ctl.install(Resources::default(), |_| {}).await,
        Err(plur1bus_desktop::controller::CtlError::PortBusy)
    ));
}
#[test]
fn daemon_readiness_requires_the_core_not_just_a_running_supervisor() {
    use plur1bus_desktop::controller::daemon_is_ready;
    assert!(!daemon_is_ready(
        &serde_json::json!({"schema":"daemon.status/1","supervisor":{"process":{"state":"running"}},"children":[{"kind":"core","process":{"state":"starting"}}]})
    ));
    assert!(daemon_is_ready(
        &serde_json::json!({"schema":"daemon.status/1","supervisor":{"process":{"state":"running"}},"children":[{"kind":"core","process":{"state":"ready"}}]})
    ));
}
#[tokio::test]
async fn uninstall_levels_are_cumulative_and_only_everything_removes_volumes_and_keychain() {
    use plur1bus_desktop::{connections::Store, controller::UninstallLevel, secrets::MemoryStore};
    for level in [
        UninstallLevel::AppOnly,
        UninstallLevel::AppAndImages,
        UninstallLevel::Everything,
    ] {
        let d = tempfile::tempdir().unwrap();
        let r = Arc::new(FakeRuntime::new(RuntimeKind::Docker));
        let ctl = Controller::with_health(
            r.clone(),
            plur1bus_desktop::controller::bundle::embedded().clone(),
            d.path().join("bundled"),
            Arc::new(Healthy),
        )
        .with_test_namespace("uninstall")
        .unwrap();
        ctl.install(Resources::default(), |_| {}).await.unwrap();
        ctl.uninstall(
            level,
            Some("plur1bus-state"),
            &MemoryStore::default(),
            &Store::open(&d.path().join("connections")),
            |_| {},
        )
        .await
        .unwrap();
        let s = r.state.lock().unwrap();
        assert!(s.containers.is_empty());
        assert_eq!(s.image, level == UninstallLevel::AppOnly);
        assert_eq!(s.volumes.is_empty(), level == UninstallLevel::Everything);
    }
}
#[tokio::test]
async fn everything_requires_the_typed_confirmation_before_any_mutation() {
    use plur1bus_desktop::{connections::Store, controller::UninstallLevel, secrets::MemoryStore};
    let d = tempfile::tempdir().unwrap();
    let r = Arc::new(FakeRuntime::new(RuntimeKind::Docker));
    let ctl = Controller::with_health(
        r.clone(),
        plur1bus_desktop::controller::bundle::embedded().clone(),
        d.path().join("bundled"),
        Arc::new(Healthy),
    )
    .with_test_namespace("uninstall")
    .unwrap();
    ctl.install(Resources::default(), |_| {}).await.unwrap();
    let before = r.state.lock().unwrap().calls.len();
    assert!(ctl
        .uninstall(
            UninstallLevel::Everything,
            None,
            &MemoryStore::default(),
            &Store::open(&d.path().join("connections")),
            |_| {}
        )
        .await
        .is_err());
    assert_eq!(before, r.state.lock().unwrap().calls.len());
}
#[tokio::test]
async fn install_prefers_the_tarball_and_checks_its_digest() {
    let d = tempfile::tempdir().unwrap();
    let r = Arc::new(FakeRuntime::new(RuntimeKind::Apple));
    let mut b = plur1bus_desktop::controller::bundle::embedded().clone();
    b.tarball.insert(
        plur1bus_desktop::controller::bundle::Arch::host(),
        Some("synthetic.tar".into()),
    );
    let ctl = Controller::with_health(r.clone(), b, d.path().join("bundled"), Arc::new(Healthy))
        .with_test_namespace("tarball")
        .unwrap();
    ctl.install(Resources::default(), |_| {}).await.unwrap();
    let s = r.state.lock().unwrap();
    assert!(s.calls.iter().any(|c| c == "load"));
    assert!(!s.calls.iter().any(|c| c == "pull"));
}
#[tokio::test]
async fn a_tarball_with_the_wrong_digest_is_refused_before_anything_is_created() {
    let d = tempfile::tempdir().unwrap();
    let r = Arc::new(FakeRuntime::new(RuntimeKind::Apple));
    r.state.lock().unwrap().wrong_digest = true;
    let mut b = plur1bus_desktop::controller::bundle::embedded().clone();
    b.tarball.insert(
        plur1bus_desktop::controller::bundle::Arch::host(),
        Some("synthetic.tar".into()),
    );
    let ctl = Controller::with_health(r.clone(), b, d.path().join("bundled"), Arc::new(Healthy))
        .with_test_namespace("wrong-digest")
        .unwrap();
    assert!(matches!(
        ctl.install(Resources::default(), |_| {}).await,
        Err(plur1bus_desktop::controller::CtlError::ImageDigest)
    ));
    let s = r.state.lock().unwrap();
    assert!(s.volumes.is_empty() && s.containers.is_empty());
}
#[tokio::test]
async fn stop_uses_150_seconds() {
    let d = tempfile::tempdir().unwrap();
    let r = Arc::new(FakeRuntime::new(RuntimeKind::Docker));
    let ctl = Controller::with_health(
        r.clone(),
        plur1bus_desktop::controller::bundle::embedded().clone(),
        d.path().join("bundled"),
        Arc::new(Healthy),
    )
    .with_test_namespace("stop")
    .unwrap();
    ctl.install(Resources::default(), |_| {}).await.unwrap();
    ctl.stop().await.unwrap();
    assert!(r
        .state
        .lock()
        .unwrap()
        .calls
        .iter()
        .any(|c| c == "stop:150"));
}
#[tokio::test]
async fn changed_runtime_is_reported_not_switched() {
    let d = tempfile::tempdir().unwrap();
    let b = plur1bus_desktop::controller::bundle::embedded().clone();
    let a = Controller::with_health(
        Arc::new(FakeRuntime::new(RuntimeKind::Apple)),
        b.clone(),
        d.path().join("bundled"),
        Arc::new(Healthy),
    )
    .with_test_namespace("chosen")
    .unwrap();
    a.install(Resources::default(), |_| {}).await.unwrap();
    let docker = Controller::with_health(
        Arc::new(FakeRuntime::new(RuntimeKind::Docker)),
        b,
        d.path().join("bundled"),
        Arc::new(Healthy),
    )
    .with_test_namespace("chosen")
    .unwrap();
    assert!(matches!(
        docker.installed(),
        Err(plur1bus_desktop::controller::CtlError::RuntimeChanged)
    ));
}
#[tokio::test]
async fn cancel_then_restart_mid_install_keeps_the_volumes() {
    let d = tempfile::tempdir().unwrap();
    let r = Arc::new(FakeRuntime::new(RuntimeKind::Apple));
    r.state.lock().unwrap().pause_start = true;
    let b = plur1bus_desktop::controller::bundle::embedded().clone();
    let ctl = Controller::with_health(
        r.clone(),
        b.clone(),
        d.path().join("bundled"),
        Arc::new(Healthy),
    )
    .with_test_namespace("resume")
    .unwrap();
    assert!(tokio::time::timeout(
        std::time::Duration::from_millis(20),
        ctl.install(Resources::default(), |_| {})
    )
    .await
    .is_err());
    assert_eq!(ctl.installed().unwrap().unwrap().step, InstallStep::Start);
    let before = r.state.lock().unwrap().volumes.clone();
    r.state.lock().unwrap().pause_start = false;
    let after = Controller::with_health(r.clone(), b, d.path().join("bundled"), Arc::new(Healthy))
        .with_test_namespace("resume")
        .unwrap();
    after.install(Resources::default(), |_| {}).await.unwrap();
    assert_eq!(before, r.state.lock().unwrap().volumes);
}
#[tokio::test]
async fn explicit_memory_restart_clears_a_crash_latch_and_preserves_volumes() {
    use plur1bus_desktop::controller::watch::{Action, Observation, Watch};
    let dir = tempfile::tempdir().unwrap();
    let runtime = Arc::new(FakeRuntime::new(RuntimeKind::Apple));
    let mut watch = Watch::new(RuntimeKind::Apple);
    for n in 0..5 {
        watch.failed(n);
    }
    assert_eq!(watch.observe(100, Observation::Dead), Action::Crashed);
    let ctl = Controller::with_health(
        runtime.clone(),
        plur1bus_desktop::controller::bundle::embedded().clone(),
        dir.path().join("bundled"),
        Arc::new(Healthy),
    )
    .with_test_namespace("memory-crash")
    .unwrap()
    .with_watch(watch);
    ctl.install(Resources::default(), |_| {}).await.unwrap();
    assert!(matches!(ctl.status().await, HarnessStatus::Crashed { .. }));
    let volumes = runtime.state.lock().unwrap().volumes.clone();
    ctl.set_memory(8).await.unwrap();
    assert!(matches!(ctl.status().await, HarnessStatus::Ready { .. }));
    assert_eq!(ctl.installed().unwrap().unwrap().resources.memory_mib, 8192);
    assert_eq!(runtime.state.lock().unwrap().volumes, volumes);
    ctl.stop().await.unwrap();
    assert!(!ctl.desired_running().unwrap());
}
#[tokio::test]
async fn port_migration_retires_the_old_origin_before_writing_and_preserves_identity() {
    use plur1bus_desktop::connections::{
        BundledRef, Connection, Kind, Origin, RuntimeKind as ConnRuntime, Store,
    };
    let dir = tempfile::tempdir().unwrap();
    let runtime = Arc::new(FakeRuntime::new(RuntimeKind::Docker));
    let ctl = Controller::with_health(
        runtime,
        plur1bus_desktop::controller::bundle::embedded().clone(),
        dir.path().join("bundled"),
        Arc::new(Healthy),
    )
    .with_test_namespace("port-row")
    .unwrap();
    let i = ctl.install(Resources::default(), |_| {}).await.unwrap();
    let store = Store::open(&dir.path().join("connections"));
    let mut row = Connection::new(
        "p1t port".into(),
        Kind::Bundled,
        Origin::parse("http://127.0.0.1:1").unwrap(),
        "installation-p1t".into(),
        "device-p1t".into(),
        "hint".into(),
    );
    row.bundled = Some(BundledRef {
        runtime: ConnRuntime::Docker,
        endpoint: i.endpoint.clone(),
        container: i.container.clone(),
        image_digest: i.image_digest,
    });
    store.upsert(row.clone()).unwrap();
    let retired = std::sync::Mutex::new(vec![]);
    ctl.reconcile_connection_origins(&store, |id| {
        assert_eq!(store.load().unwrap()[0].origin, row.origin);
        retired.lock().unwrap().push(id);
    })
    .unwrap();
    let new = store.load().unwrap().remove(0);
    assert_eq!(new.origin.as_str(), format!("http://127.0.0.1:{}", i.port));
    assert_eq!(new.installation_id, row.installation_id);
    assert_eq!(new.device_id, row.device_id);
    assert_eq!(*retired.lock().unwrap(), vec![row.id]);
}
#[tokio::test]
async fn only_everything_removes_the_affected_bundled_token_account() {
    use plur1bus_desktop::{
        connections::{
            BundledRef, Connection, CredentialProvenance, Kind, Origin, RuntimeKind as ConnRuntime,
            Store,
        },
        controller::UninstallLevel,
        secrets::{token_account, MemoryStore, SecretString, TokenStore},
    };
    for level in [
        UninstallLevel::AppOnly,
        UninstallLevel::AppAndImages,
        UninstallLevel::Everything,
    ] {
        let dir = tempfile::tempdir().unwrap();
        let runtime = Arc::new(FakeRuntime::new(RuntimeKind::Docker));
        let ctl = Controller::with_health(
            runtime,
            plur1bus_desktop::controller::bundle::embedded().clone(),
            dir.path().join("bundled"),
            Arc::new(Healthy),
        )
        .with_test_namespace("keys")
        .unwrap();
        let i = ctl.install(Resources::default(), |_| {}).await.unwrap();
        let store = Store::open(&dir.path().join("connections"));
        let mut row = Connection::new(
            "p1t bundled".into(),
            Kind::Bundled,
            Origin::parse(&format!("http://127.0.0.1:{}", i.port)).unwrap(),
            "installation-p1t".into(),
            "device-p1t".into(),
            "hint".into(),
        );
        row.credential_provenance = CredentialProvenance::MemoryOnly;
        row.bundled = Some(BundledRef {
            runtime: ConnRuntime::Docker,
            endpoint: i.endpoint,
            container: i.container,
            image_digest: i.image_digest,
        });
        store.upsert(row.clone()).unwrap();
        let tokens = MemoryStore::default();
        tokens
            .set(
                &token_account(row.id),
                &SecretString::new("synthetic-private-device-token-p1t".into()),
            )
            .unwrap();
        let other = uuid::Uuid::new_v4();
        tokens
            .set(
                &token_account(other),
                &SecretString::new("synthetic-unrelated-token-p1t".into()),
            )
            .unwrap();
        ctl.uninstall(level, Some("plur1bus-state"), &tokens, &store, |_| {})
            .await
            .unwrap();
        assert_eq!(
            tokens.get(&token_account(row.id)).unwrap().is_none(),
            level == UninstallLevel::Everything
        );
        assert!(tokens.get(&token_account(other)).unwrap().is_some());
    }
}
#[test]
fn create_spec_is_exact_for_both_native_adapters() {
    use plur1bus_desktop::{
        controller::bundle::embedded,
        runtime::{apple::create_argv, docker::create_body, spec::harness_spec},
    };
    let s = harness_spec(
        embedded(),
        18742,
        &Resources {
            memory_mib: 3072,
            cpus: 4,
        },
        &[],
    );
    let a = create_argv(&s).unwrap();
    let v = serde_json::to_value(create_body(&s).unwrap()).unwrap();
    assert_eq!(
        s.volumes,
        vec![
            ("plur1bus-state".into(), "/var/lib/plur1bus".into(), false),
            (
                "plur1bus-models".into(),
                "/var/lib/plur1bus-models".into(),
                false
            )
        ]
    );
    assert!(a.windows(2).any(|p| p == ["-p", "127.0.0.1:18742:18700"]));
    assert!(a
        .windows(2)
        .any(|p| p == ["-v", "plur1bus-state:/var/lib/plur1bus"]));
    assert!(a
        .windows(2)
        .any(|p| p == ["-v", "plur1bus-models:/var/lib/plur1bus-models"]));
    assert!(!a
        .iter()
        .any(|p| p.contains("restart") || p == "--privileged"));
    assert_eq!(v["User"], "10001:10001");
    assert_eq!(
        v["HostConfig"]["PortBindings"],
        serde_json::json!({"18700/tcp":[{"HostIp":"127.0.0.1","HostPort":"18742"}]})
    );
    assert_eq!(v["HostConfig"]["ReadonlyRootfs"], true);
    assert_eq!(v["HostConfig"]["CapDrop"], serde_json::json!(["ALL"]));
    assert_eq!(
        v["HostConfig"]["SecurityOpt"],
        serde_json::json!(["no-new-privileges"])
    );
    assert_eq!(v["HostConfig"]["PidsLimit"], 1024);
    assert_eq!(v["HostConfig"]["Memory"], 3u64 * 1024 * 1024 * 1024);
    assert_eq!(v["HostConfig"]["NanoCpus"], 4_000_000_000u64);
    assert_eq!(v["HostConfig"]["RestartPolicy"]["Name"], "unless-stopped");
    assert_eq!(v["HostConfig"]["NetworkMode"], "plur1bus");
    assert_eq!(v["Labels"]["app.plur1bus.role"], "harness");
    assert_eq!(v["StopTimeout"], 150);
}
