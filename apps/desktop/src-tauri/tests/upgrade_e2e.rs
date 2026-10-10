//! Opt-in local engines and locally built synthetic images only; never pull a real release.
#![cfg(debug_assertions)]
use plur1bus_desktop::{
    connections::Store,
    controller::{bundle::embedded, upgrade::Outcome, Controller, Resources},
    runtime::{detect::Endpoint, docker::DockerRuntime, Runtime},
    secrets::{token_account, MemoryStore, TokenStore},
    updates::Kind,
};
use std::sync::Arc;
async fn run(engine: &str) {
    assert_eq!(
        std::env::var("PLUR1BUS_DESKTOP_E2E_RUNTIME").unwrap(),
        engine
    );
    let endpoint = Endpoint::parse(
        &std::env::var("PLUR1BUS_DESKTOP_E2E_ENDPOINT").expect("local endpoint required"),
    )
    .unwrap();
    let digests: Vec<_> = std::env::var("PLUR1BUS_DESKTOP_UPGRADE_DIGESTS")
        .expect("three local stub digests required")
        .split(',')
        .map(str::to_owned)
        .collect();
    assert_eq!(digests.len(), 3);
    let runtime = Arc::new(DockerRuntime::connect(&endpoint).await.unwrap());
    assert!(runtime.info().engine.to_lowercase().contains(engine));
    let dir = tempfile::tempdir().unwrap();
    let store = Store::open(&dir.path().join("connections"));
    let tokens = MemoryStore::default();
    let mut bundle = embedded().clone();
    bundle.version = "0.1.0".into();
    for d in bundle.images.values_mut() {
        *d = digests[0].clone();
    }
    assert!(runtime.image_present(&digests[0]).await.unwrap());
    let ctl = Controller::new(runtime.clone(), bundle.clone(), dir.path().join("bundled"))
        .with_test_namespace(&format!("wp11-{engine}-{}", uuid::Uuid::now_v7().simple()))
        .unwrap();
    ctl.install(Resources::default(), |_| {}).await.unwrap();
    let conn =
        plur1bus_desktop::pair::pair_bundled(&ctl, &tokens, &store, "synthetic-upgrade", |_| {})
            .await
            .unwrap();
    let token = tokens.get(&token_account(conn.id)).unwrap().unwrap();
    let client = plur1bus_desktop::client::HarnessClient::from_connection(&conn)
        .await
        .unwrap();
    client.whoami(&conn.installation_id, &token).await.unwrap();
    for (index, version) in [(1, "0.1.1"), (2, "0.1.2")] {
        bundle.version = version.into();
        for d in bundle.images.values_mut() {
            *d = digests[index].clone();
        }
        assert!(runtime.image_present(&digests[index]).await.unwrap());
        let result = ctl
            .upgrade(
                &bundle,
                semver::Version::parse(version).unwrap(),
                Kind::Patch,
                &tokens,
                &conn,
                |_| {},
            )
            .await
            .unwrap();
        if index == 1 {
            assert!(matches!(result, Outcome::Upgraded { .. }));
        } else {
            assert!(matches!(
                result,
                Outcome::RolledBack {
                    failed_step: plur1bus_desktop::controller::journal::Step::Gating,
                    ..
                }
            ));
        }
        client.whoami(&conn.installation_id, &token).await.unwrap();
        assert_eq!(client.meta().await.unwrap().version, "0.1.1");
    }
    assert!(ctl
        .upgrade_journal()
        .unwrap()
        .unwrap()
        .failed_snapshot
        .is_some());
    // Test namespace is unique. Remove only explicitly named test objects after assertions.
    let j = ctl.upgrade_journal().unwrap().unwrap();
    let i = ctl.installed().unwrap().unwrap();
    ctl.stop().await.unwrap();
    runtime.remove(&i.container).await.unwrap();
    for name in [format!("{}-previous", i.container)] {
        if runtime.state(&name).await.unwrap().exists {
            runtime.remove(&name).await.unwrap();
        }
    }
    let prefix = i.container.strip_suffix("-harness").unwrap();
    for volume in [
        format!("{prefix}-state"),
        format!("{prefix}-models"),
        j.snapshot.unwrap().volume,
        j.failed_snapshot.unwrap().volume,
    ] {
        runtime.volume_remove(&volume).await.unwrap();
    }
    runtime
        .network_remove(&format!("{prefix}-network"))
        .await
        .unwrap();
}
#[tokio::test]
#[ignore = "explicit local Docker endpoint and three prebuilt synthetic stub images required"]
async fn upgrade_e2e_docker() {
    run("docker").await;
}
#[tokio::test]
#[ignore = "explicit local Podman endpoint and three prebuilt synthetic stub images required"]
async fn upgrade_e2e_podman() {
    run("podman").await;
}
