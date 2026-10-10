#[path = "support/engine.rs"]
mod engine;
use plur1bus_desktop::runtime::{
    docker::{create_body, DockerRuntime},
    spec::oneshot_spec,
    Runtime, RuntimeError,
};
#[tokio::test]
async fn every_docker_compatible_runtime_uses_the_same_api() {
    for name in [
        "Docker Engine",
        "Docker Desktop",
        "Podman Engine",
        "OrbStack",
        "Colima",
        "Rancher Desktop",
        "Docker Desktop WSL2",
    ] {
        let e = engine::Engine::start(name, "linux").await;
        let r = DockerRuntime::connect(&e.endpoint).await.unwrap();
        assert_eq!(r.info().engine, name);
        r.ping().await.unwrap();
    }
}
#[tokio::test]
async fn a_windows_containers_engine_is_wrong_mode() {
    let e = engine::Engine::start("Docker", "windows").await;
    assert!(matches!(
        DockerRuntime::connect(&e.endpoint).await,
        Err(RuntimeError::WrongMode)
    ))
}
#[tokio::test]
async fn runtime_contract() {
    let e = engine::Engine::start("Podman", "linux").await;
    let r = DockerRuntime::connect(&e.endpoint).await.unwrap();
    let mut s = oneshot_spec(
        &format!("sha256:{}", "a".repeat(64)),
        vec!["true".into()],
        vec![],
    );
    s.name = "p1t-contract".into();
    s.labels
        .insert("app.plur1bus.test".into(), "contract".into());
    assert!(!r.state(&s.name).await.unwrap().exists);
    r.create(&s).await.unwrap();
    assert!(matches!(r.create(&s).await, Err(RuntimeError::Conflict(_))));
    r.start(&s.name).await.unwrap();
    assert!(r.state(&s.name).await.unwrap().running);
    let output = r
        .exec(&s.name, &["true"], None, std::time::Duration::from_secs(2))
        .await
        .unwrap();
    assert_eq!(output.code, 7);
    assert_eq!(output.stdout, b"synthetic-exec");
    assert_eq!(
        r.list_labeled("app.plur1bus.test=contract").await.unwrap(),
        vec![s.name.clone()]
    );
    r.stop(&s.name, std::time::Duration::from_secs(150))
        .await
        .unwrap();
    assert!(!r.state(&s.name).await.unwrap().running);
    r.rename(&s.name, "p1t-renamed").await.unwrap();
    r.remove("p1t-renamed").await.unwrap();
    assert!(!r.state("p1t-renamed").await.unwrap().exists);
    assert!(e
        .state
        .lock()
        .unwrap()
        .requests
        .iter()
        .any(|(p, _)| p.contains("t=150")));
}
#[test]
fn create_body_is_exactly_the_spec() {
    let mut s = oneshot_spec(
        &format!("sha256:{}", "a".repeat(64)),
        vec![],
        vec![(
            "plur1bus-state".into(),
            plur1bus_desktop::runtime::spec::STATE_MOUNT.into(),
            false,
        )],
    );
    s.host_port = Some(18700);
    s.restart = true;
    s.network = Some("plur1bus".into());
    let v = serde_json::to_value(create_body(&s).unwrap()).unwrap();
    let h = &v["HostConfig"];
    assert_eq!(v["User"], "10001:10001");
    assert_eq!(v["StopTimeout"], 150);
    assert_eq!(h["PortBindings"]["18700/tcp"][0]["HostIp"], "127.0.0.1");
    assert_eq!(h["ReadonlyRootfs"], true);
    assert_eq!(h["CapDrop"], serde_json::json!(["ALL"]));
    assert_eq!(h["SecurityOpt"], serde_json::json!(["no-new-privileges"]));
    assert_eq!(h["PidsLimit"], 1024);
    assert_eq!(h["Memory"], 3072_u64 * 1024 * 1024);
    assert_eq!(h["NanoCpus"], 1_000_000_000_u64);
    assert_eq!(h["RestartPolicy"]["Name"], "unless-stopped");
    assert!(h.get("Binds").is_none());
    assert!(h.get("Privileged").is_none());
}

#[tokio::test]
async fn oneshot_preserves_nonzero_exit_code_and_output() {
    let e = engine::Engine::start("Docker", "linux").await;
    e.state.lock().unwrap().wait_code = 7;
    let r = DockerRuntime::connect(&e.endpoint).await.unwrap();
    let s = oneshot_spec(
        &format!("sha256:{}", "a".repeat(64)),
        vec!["false".into()],
        vec![],
    );
    let o = r
        .run_oneshot(&s, std::time::Duration::from_secs(2))
        .await
        .unwrap();
    assert_eq!(o.code, 7);
    assert!(String::from_utf8_lossy(&o.stdout).contains("synthetic-log"));
    assert_eq!(o.stderr, b"synthetic-stderr");
    assert!(!r.state(&s.name).await.unwrap().exists);
}
#[tokio::test(flavor = "multi_thread")]
async fn cancelled_oneshot_removes_its_owned_container() {
    let e = engine::Engine::start("Docker", "linux").await;
    e.state.lock().unwrap().wait_delay_ms = 1000;
    let r = DockerRuntime::connect(&e.endpoint).await.unwrap();
    let s = oneshot_spec(
        &format!("sha256:{}", "a".repeat(64)),
        vec!["sleep".into(), "1".into()],
        vec![],
    );
    assert!(tokio::time::timeout(
        std::time::Duration::from_millis(50),
        r.run_oneshot(&s, std::time::Duration::from_secs(10))
    )
    .await
    .is_err());
    tokio::time::sleep(std::time::Duration::from_millis(100)).await;
    assert!(!r.state(&s.name).await.unwrap().exists);
}
#[tokio::test]
async fn image_load_refuses_a_config_id_without_manifest_digest() {
    let e = engine::Engine::start("Docker", "linux").await;
    let r = DockerRuntime::connect(&e.endpoint).await.unwrap();
    let tar = tempfile::NamedTempFile::new().unwrap();
    assert_eq!(
        r.image_load(tar.path()).await,
        Err(RuntimeError::Failed("image-load-digest".into()))
    );
}

#[tokio::test]
async fn image_load_returns_the_manifest_digest() {
    let e = engine::Engine::start("Docker", "linux").await;
    let digest = format!("sha256:{}", "a".repeat(64));
    e.state.lock().unwrap().manifest_digest = Some(digest.clone());
    let r = DockerRuntime::connect(&e.endpoint).await.unwrap();
    let tar = tempfile::NamedTempFile::new().unwrap();
    assert_eq!(r.image_load(tar.path()).await.unwrap(), digest);
}
#[tokio::test]
async fn pull_verifies_the_digest() {
    let e = engine::Engine::start("Docker", "linux").await;
    let digest = format!("sha256:{}", "a".repeat(64));
    let r = DockerRuntime::connect(&e.endpoint).await.unwrap();
    assert!(matches!(
        r.image_pull("fixture.invalid/harness", &digest).await,
        Err(RuntimeError::Failed(_))
    ));
    e.state.lock().unwrap().manifest_digest = Some(digest.clone());
    r.image_pull("fixture.invalid/harness", &digest)
        .await
        .unwrap();
}
#[tokio::test]
async fn config_id_is_not_a_manifest_digest() {
    let e = engine::Engine::start("Docker", "linux").await;
    let r = DockerRuntime::connect(&e.endpoint).await.unwrap();
    assert!(!r
        .image_present(&format!("sha256:{}", "a".repeat(64)))
        .await
        .unwrap());
}
