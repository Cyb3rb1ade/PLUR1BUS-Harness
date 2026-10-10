use plur1bus_containers::*;
#[test]
fn defaults_are_private_and_persistent() {
    let s = Service::harness("local/harness:test");
    assert_eq!(s.bind.to_string(), "127.0.0.1");
    assert_eq!(s.state_volume, "plur1bus-state");
    assert!(s.validate().is_ok());
    let mut bad = s;
    bad.bind = "0.0.0.0".parse().unwrap();
    assert!(bad.validate().is_err());
}
#[test]
fn selection_respects_explicit_choice() {
    let apple = Detection::ready(RuntimeKind::Apple, "1.5.0");
    let docker = Detection::ready(RuntimeKind::Docker, "29.4.0");
    assert_eq!(
        select_runtime(None, Platform::MacArm, &[apple.clone(), docker.clone()]).unwrap(),
        RuntimeKind::Apple
    );
    assert_eq!(
        select_runtime(
            Some(RuntimeKind::Docker),
            Platform::MacArm,
            &[apple, docker]
        )
        .unwrap(),
        RuntimeKind::Docker
    );
    assert!(select_runtime(Some(RuntimeKind::Apple), Platform::Linux, &[]).is_err());
}
#[test]
fn installer_keeps_consent_before_download() {
    let p = plan_install(
        Platform::Linux,
        &[],
        ImageSource::Online("local:test".into()),
    );
    assert!(
        p.steps
            .iter()
            .position(|s| matches!(s, InstallStep::ShowDockerLicense))
            .unwrap()
            < p.steps
                .iter()
                .position(|s| matches!(s, InstallStep::DownloadDockerAfterConsent { .. }))
                .unwrap()
    );
    let p = plan_install(
        Platform::MacArm,
        &[],
        ImageSource::Offline("image.tar".into()),
    );
    assert!(p.steps.contains(&InstallStep::BundleApple));
    assert!(p
        .steps
        .iter()
        .any(|s| matches!(s, InstallStep::LoadImage(_))));
}
#[test]
fn sidecar_modes() {
    let mut c = SidecarConfig::off();
    assert_eq!(
        resolve_endpoint("searxng", &c, Some("http://searxng:8080")).unwrap(),
        None
    );
    c.mode = SidecarMode::Bundled;
    assert_eq!(
        resolve_endpoint("searxng", &c, Some("http://searxng:8080"))
            .unwrap()
            .unwrap(),
        "http://searxng:8080"
    );
    c.mode = SidecarMode::Remote;
    c.url = Some("http://100.64.0.2:8080".into());
    assert!(resolve_endpoint("searxng", &c, None).unwrap().is_some());
    c.url = Some("file:///etc/passwd".into());
    assert!(resolve_endpoint("searxng", &c, None).is_err());
}
#[test]
fn private_lan_is_explicit_and_public_wildcards_are_refused() {
    for ip in ["0.0.0.0", "::", "8.8.8.8", "2001:4860:4860::8888"] {
        let mut s = Service::harness("local:test");
        s.bind = ip.parse().unwrap();
        s.publish = Some(18700);
        assert!(s.validate().is_err(), "{ip}");
    }
    for ip in ["127.0.0.1", "::1", "192.168.1.2", "100.64.0.1"] {
        let mut s = Service::harness("local:test");
        s.bind = ip.parse().unwrap();
        s.publish = Some(18700);
        assert!(s.validate().is_ok(), "{ip}");
    }
}
#[test]
fn production_image_pins_are_exact() {
    assert!(
        validate_digest_image(&format!("ghcr.io/test/harness@sha256:{}", "a".repeat(64))).is_ok()
    );
    for image in [
        "ghcr.io/test:latest",
        "ghcr.io/test@sha256:123",
        "@sha256:aaaa",
        "--flag",
    ] {
        assert!(validate_digest_image(image).is_err());
    }
}
#[test]
fn installer_platforms_and_stopped_apple_priority() {
    let stopped = Detection::failed(RuntimeKind::Apple, RuntimeState::Stopped, "stopped");
    let docker = Detection::ready(RuntimeKind::Docker, "29.4.0");
    let plan = plan_install(
        Platform::MacArm,
        &[stopped, docker],
        ImageSource::Online("image".into()),
    );
    assert_eq!(plan.steps[0], InstallStep::ActivateApple);
    for platform in [Platform::Linux, Platform::Windows, Platform::MacIntel] {
        let plan = plan_install(platform, &[], ImageSource::Online("image".into()));
        assert!(plan.steps.contains(&InstallStep::ShowDockerLicense));
        assert!(!plan.steps.contains(&InstallStep::BundleApple));
    }
    let unsupported = Detection::failed(RuntimeKind::Apple, RuntimeState::Unsupported, "macOS25");
    assert!(plan_install(
        Platform::MacArm,
        &[unsupported],
        ImageSource::Online("image".into())
    )
    .steps
    .contains(&InstallStep::ShowDockerLicense));
}
#[test]
fn digest_references_ignore_optional_tags_after_engine_normalisation() {
    let digest = "a".repeat(64);
    assert_eq!(
        canonical_image(&format!("docker.io/valkey/valkey:8.1@sha256:{digest}")),
        canonical_image(&format!("docker.io/valkey/valkey@sha256:{digest}"))
    );
    assert_eq!(
        canonical_image("localhost:5000/harness:tag"),
        "localhost:5000/harness:tag"
    );
}
#[test]
fn numeric_non_root_users_cannot_be_bypassed_with_root_aliases() {
    for user in [
        "",
        "root",
        "root:root",
        "0",
        "0:10001",
        "000:10001",
        "10001:10001:0",
    ] {
        let mut service = Service::harness("local:test");
        service.user = user.into();
        assert!(service.validate().is_err(), "{user}");
    }
}
