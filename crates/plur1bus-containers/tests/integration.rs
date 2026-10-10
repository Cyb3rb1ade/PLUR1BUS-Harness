//! Real runtimes are contacted only when explicitly opted in. Output belongs in a local log.
use plur1bus_containers::*;
use std::{path::PathBuf, process::Command};
fn integration(runtime: &dyn ContainerRuntime) {
    runtime.ensure_running().unwrap();
    let image =
        std::env::var("PLUR1BUS_IT_IMAGE").unwrap_or_else(|_| "plur1bus-harness:local".into());
    let mut s = Service::harness(&image);
    s.name = format!("plur1bus-it-{}", std::process::id());
    s.network = format!("plur1bus-it-{}", std::process::id());
    s.state_volume = format!("plur1bus-it-{}", std::process::id());
    s.mounts[0].source = s.state_volume.clone();
    let stack = StackManager::new(runtime, vec![s]);
    let result = stack.up();
    if result.is_ok() {
        stack.up().unwrap(); // Engine inspect may canonicalise the reference; idempotence must survive.
        assert!(stack.status().unwrap()[0].1.as_ref().unwrap().healthy);
        let s = &stack.services[0];
        let output = runtime
            .exec(&s.name, &["plur1bus".into(), "--version".into()])
            .unwrap();
        eprintln!("runtime {:?}, image {image}, {output}", runtime.detect());
    }
    let teardown = stack.down();
    result.unwrap();
    teardown.unwrap();
    // Volumes intentionally survive down() in production. Remove ONLY this test's private volume.
    eprintln!(
        "retained test state volume {} (remove explicitly after inspection)",
        stack.services[0].state_volume
    );
}
#[test]
fn docker_real() {
    if std::env::var("PLUR1BUS_IT_CONTAINERS").as_deref() != Ok("1") {
        return;
    }
    integration(&DockerRuntime::discover());
}
#[test]
fn apple_real() {
    if std::env::var("PLUR1BUS_IT_CONTAINERS").as_deref() != Ok("1")
        || !cfg!(all(target_os = "macos", target_arch = "aarch64"))
    {
        return;
    }
    let image =
        std::env::var("PLUR1BUS_IT_IMAGE").unwrap_or_else(|_| "plur1bus-harness:local".into());
    let runtime = AppleContainerRuntime::local();
    let tar = std::env::var_os("PLUR1BUS_IT_OCI_TARBALL").map(PathBuf::from);
    if let Some(tar) = tar {
        runtime.load(&tar).unwrap();
    } else if !runtime.image_available(&image).unwrap() {
        runtime.pull(&image).unwrap();
    }
    integration(&runtime);
}
fn build(runtime: &str) {
    if std::env::var("PLUR1BUS_IT_CONTAINERS").as_deref() != Ok("1")
        || std::env::var("PLUR1BUS_IT_BUILD").as_deref() != Ok("1")
    {
        return;
    }
    let root = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../..");
    let status = Command::new(root.join("containers/build.sh"))
        .arg(runtime)
        .current_dir(root)
        .status()
        .unwrap();
    assert!(status.success());
}
#[test]
fn docker_build_opt_in() {
    build("docker");
}
#[test]
fn apple_build_opt_in() {
    if cfg!(all(target_os = "macos", target_arch = "aarch64")) {
        build("apple");
    }
}
/// Optional endpoint belonging to the opt-in test operator (e.g. its own scratch Valkey).
#[test]
fn remote_valkey_real() {
    if std::env::var("PLUR1BUS_IT_CONTAINERS").as_deref() != Ok("1") {
        return;
    }
    let Ok(url) = std::env::var("PLUR1BUS_IT_REMOTE_VALKEY") else {
        return;
    };
    let mut config = SidecarConfig::off();
    config.mode = SidecarMode::Remote;
    config.url = Some(url.clone());
    HttpHealthProbe.check(&url, &config).unwrap();
}
