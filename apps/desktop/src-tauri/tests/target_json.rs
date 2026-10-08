use plur1bus_desktop::{
    controller::{InstallStep, Installed, Resources},
    install::target_json::{self, Target},
    runtime::RuntimeKind,
};
fn installed() -> Installed {
    Installed {
        runtime: RuntimeKind::Docker,
        endpoint: "unix:///p1t/engine.sock".into(),
        container: "p1t-harness".into(),
        port: 18700,
        image_digest: format!("sha256:{}", "a".repeat(64)),
        resources: Resources::default(),
        installed_version: "0.1.0".into(),
        step: InstallStep::Done,
    }
}
#[test]
fn target_has_only_the_forwarder_contract_and_private_permissions() {
    let d = tempfile::tempdir().unwrap();
    let dir = d.path().join("forwarder");
    let i = installed();
    target_json::write(&dir, &i).unwrap();
    let bytes = std::fs::read(dir.join("target.json")).unwrap();
    let value: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
    assert_eq!(
        value,
        serde_json::json!({"version":1,"mode":"container","runtime":"docker","endpoint":"/p1t/engine.sock","container":"p1t-harness"})
    );
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        assert_eq!(
            std::fs::metadata(dir.join("target.json"))
                .unwrap()
                .permissions()
                .mode()
                & 0o777,
            0o600
        );
        assert_eq!(
            std::fs::metadata(&dir).unwrap().permissions().mode() & 0o777,
            0o700
        );
    }
    assert!(target_json::remove_owned(&dir, &i).unwrap());
    assert!(!target_json::remove_owned(&dir, &i).unwrap());
}
#[test]
fn remote_or_option_endpoints_never_reach_the_forwarder() {
    for endpoint in ["tcp://host:2375", "https://host", "relative/path"] {
        let mut i = installed();
        i.endpoint = endpoint.into();
        assert!(Target::for_installed(&i).is_err());
    }
    let mut i = installed();
    i.container = "--privileged".into();
    assert!(Target::for_installed(&i).is_err());
}
#[test]
fn a_different_target_is_preserved() {
    let d = tempfile::tempdir().unwrap();
    let dir = d.path().join("forwarder");
    let i = installed();
    target_json::write(&dir, &i).unwrap();
    let mut other = i.clone();
    other.container = "p1t-other".into();
    assert!(!target_json::remove_owned(&dir, &other).unwrap());
    assert!(dir.join("target.json").exists());
}
#[cfg(unix)]
#[test]
fn symlink_state_is_refused_without_touching_the_target() {
    use std::os::unix::fs::symlink;
    let d = tempfile::tempdir().unwrap();
    let outside = d.path().join("outside");
    std::fs::write(&outside, "unchanged").unwrap();
    let dir = d.path().join("forwarder");
    std::fs::create_dir(&dir).unwrap();
    symlink(&outside, dir.join("target.json")).unwrap();
    assert!(target_json::write(&dir, &installed()).is_err());
    assert_eq!(std::fs::read_to_string(outside).unwrap(), "unchanged");
}
#[test]
fn runtime_requests_reject_any_generic_command_or_image_input() {
    use plur1bus_desktop::runtime_commands::{InstallRequest, RuntimeRequest, StartRequest};
    for key in [
        "argv", "image", "mounts", "endpoint", "env", "port", "token",
    ] {
        let mut v = serde_json::json!({"runtimeId":"opaque","agreed":true});
        v[key] = serde_json::json!("injected");
        assert!(
            serde_json::from_value::<InstallRequest>(v).is_err(),
            "{key}"
        );
    }
    assert!(serde_json::from_value::<StartRequest>(
        serde_json::json!({"memoryGib":3,"command":"anything"})
    )
    .is_err());
    assert!(serde_json::from_value::<RuntimeRequest>(
        serde_json::json!({"runtimeId":"opaque","endpoint":"tcp://host"})
    )
    .is_err());
}
