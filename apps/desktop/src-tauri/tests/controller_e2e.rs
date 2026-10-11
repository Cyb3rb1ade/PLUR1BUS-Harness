//! Explicit real-engine acceptance only. No service is installed or runtime started by this fixture.
#![cfg(debug_assertions)]
use plur1bus_desktop::{
    connections::Store,
    controller::{Controller, HarnessStatus, Resources, UninstallLevel},
    runtime::{detect::Endpoint, docker::DockerRuntime, Runtime, RuntimeKind},
    secrets::MemoryStore,
};
use std::{sync::Arc, time::Duration};
// Podman's compat API answers kill/inspect only once the container has actually changed state, which can take
// longer than a couple of seconds on slow runners; the runtime under test itself uses 300 s.
const CLIENT_TIMEOUT_SECS: u64 = 120;
static SERIAL: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());
async fn run(engine: &str) {
    let _serial = SERIAL.lock().await;
    let endpoint = Endpoint::parse(
        &std::env::var("PLUR1BUS_DESKTOP_E2E_ENDPOINT")
            .expect("explicit local Engine endpoint required"),
    )
    .expect("unix/npipe endpoint required");
    let digest = std::env::var("PLUR1BUS_DESKTOP_E2E_STUB_DIGEST")
        .expect("verified p1t-stub-harness manifest digest required");
    assert!(plur1bus_desktop::runtime::spec::valid_digest(&digest));
    assert_ne!(digest, format!("sha256:{}", "0".repeat(64)));
    let runtime = Arc::new(DockerRuntime::connect(&endpoint).await.unwrap());
    assert!(runtime.info().engine.to_ascii_lowercase().contains(engine));
    assert_eq!(runtime.info().kind, RuntimeKind::Docker);
    let dir = tempfile::tempdir().unwrap();
    let mut bundle = plur1bus_desktop::controller::bundle::embedded().clone();
    for d in bundle.images.values_mut() {
        *d = digest.clone();
    }
    let ctl = Arc::new(
        Controller::new(runtime.clone(), bundle, dir.path().join("bundled"))
            .with_test_namespace(&format!("wp14-{engine}-{}", uuid::Uuid::now_v7().simple()))
            .unwrap(),
    );
    let i = ctl.install(Resources::default(), |_| {}).await.unwrap();
    assert!(matches!(ctl.status().await, HarnessStatus::Ready { .. }));
    let addresses = std::env::var("PLUR1BUS_DESKTOP_E2E_NON_LOOPBACK")
        .expect("explicit host non-loopback IP list required");
    for ip in addresses.split(',') {
        let ip = ip.parse::<std::net::IpAddr>().unwrap();
        assert!(!ip.is_loopback() && !ip.is_unspecified());
        let address = std::net::SocketAddr::new(ip, i.port);
        assert!(
            tokio::time::timeout(
                Duration::from_secs(1),
                tokio::net::TcpStream::connect(address)
            )
            .await
            .map_or(true, |r| r.is_err()),
            "harness must not answer on {address}"
        );
    }
    let client = match &endpoint {
        #[cfg(unix)]
        Endpoint::Unix(path) => bollard::Docker::connect_with_unix(
            path.to_str().unwrap(),
            CLIENT_TIMEOUT_SECS,
            bollard::API_DEFAULT_VERSION,
        )
        .unwrap(),
        #[cfg(not(unix))]
        Endpoint::Unix(path) => {
            let _ = path;
            panic!("unix socket requires Unix")
        }
        Endpoint::Pipe(path) => {
            #[cfg(windows)]
            {
                bollard::Docker::connect_with_named_pipe(
                    path,
                    CLIENT_TIMEOUT_SECS,
                    bollard::API_DEFAULT_VERSION,
                )
                .unwrap()
            }
            #[cfg(not(windows))]
            {
                let _ = path;
                panic!("named pipe requires Windows")
            }
        }
    };
    let before = client
        .inspect_container(&i.container, None)
        .await
        .unwrap()
        .state
        .unwrap()
        .started_at
        .expect("initial start timestamp");
    let watch = ctl.clone().spawn_watch();
    let killed_at = std::time::Instant::now();
    client
        .kill_container(
            &i.container,
            Some(
                bollard::query_parameters::KillContainerOptionsBuilder::default()
                    .signal("KILL")
                    .build(),
            ),
        )
        .await
        .unwrap_or_else(|e| {
            panic!(
                "kill_container failed after {:?}: {e:?}",
                killed_at.elapsed()
            )
        });
    eprintln!("kill_container returned after {:?}", killed_at.elapsed());
    tokio::time::timeout(Duration::from_secs(120), async {
        loop {
            let restarted = client
                .inspect_container(&i.container, None)
                .await
                .unwrap()
                .state
                .unwrap()
                .started_at
                .is_some_and(|time| time != before);
            if restarted
                && runtime.state(&i.container).await.unwrap().running
                && matches!(ctl.status().await, HarnessStatus::Ready { .. })
            {
                break;
            }
            tokio::time::sleep(Duration::from_secs(2)).await;
        }
    })
    .await
    .unwrap();
    watch.abort();
    ctl.stop().await.unwrap();
    assert!(matches!(ctl.status().await, HarnessStatus::Stopped));
    // The runtime installs by repo@digest only. Drop the harness's own registry alias tags (never the image) so
    // the strict, non-forced image removal is not blocked by tags the runtime did not create.
    for tag in std::env::var("PLUR1BUS_DESKTOP_E2E_EXTRA_TAGS")
        .unwrap_or_default()
        .split(',')
        .filter(|t| !t.is_empty())
    {
        let _ = std::process::Command::new(engine)
            .args(["rmi", tag])
            .status();
    }
    ctl.uninstall(
        UninstallLevel::Everything,
        Some("plur1bus-state"),
        &MemoryStore::default(),
        &Store::open(&dir.path().join("connections")),
        |_| {},
    )
    .await
    .unwrap();
    assert!(!runtime.state(&i.container).await.unwrap().exists);
}
#[tokio::test]
#[ignore = "Owner: explicit Docker endpoint, verified stub manifest and non-loopback IPs required"]
async fn controller_e2e_docker_stub_install_restart_stop_uninstall() {
    run("docker").await;
}
#[tokio::test]
#[ignore = "Owner: explicit Podman endpoint, verified stub manifest and non-loopback IPs required"]
async fn controller_e2e_podman_stub_install_restart_stop_uninstall() {
    run("podman").await;
}

#[tokio::test]
#[ignore = "explicit preloaded loopback registry and local Engine required"]
async fn controller_e2e_local_registry_pull_by_digest() {
    let endpoint =
        Endpoint::parse(&std::env::var("PLUR1BUS_DESKTOP_E2E_ENDPOINT").unwrap()).unwrap();
    let reference = std::env::var("PLUR1BUS_DESKTOP_E2E_REGISTRY").unwrap();
    assert!(reference.starts_with("127.0.0.1:"));
    let digest = std::env::var("PLUR1BUS_DESKTOP_E2E_REGISTRY_DIGEST").unwrap();
    let runtime = DockerRuntime::connect(&endpoint).await.unwrap();
    let pinned = format!("{reference}@{digest}");
    assert!(
        !runtime.image_present(&pinned).await.unwrap(),
        "must retrieve a missing reference"
    );
    runtime.image_pull(&reference, &digest).await.unwrap();
    assert!(runtime.image_present(&pinned).await.unwrap());
    let wrong = format!("sha256:{}", "0".repeat(64));
    assert!(runtime.image_pull(&reference, &wrong).await.is_err());
}
