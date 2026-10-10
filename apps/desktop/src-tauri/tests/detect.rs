use plur1bus_desktop::runtime::detect::{
    candidates, choose_default, DetectState, Detected, Env, Host,
};
use plur1bus_desktop::runtime::RuntimeKind;

#[test]
fn tcp_docker_host_is_ignored_with_a_note() {
    let env = Env {
        host: Host::Linux,
        docker_host: Some("tcp://untrusted.example:2375".into()),
        xdg_runtime_dir: None,
        macos_major: None,
    };
    let dir = tempfile::tempdir().unwrap();
    let found = candidates(&env, dir.path());
    assert!(found.notes.contains(&"runtime.remote-endpoint-ignored"));
    assert!(found
        .candidates
        .iter()
        .all(|c| !c.endpoint.to_string().contains("untrusted")));
}
#[test]
fn a_new_runtime_is_listed_not_adopted() {
    let old = Detected {
        kind: RuntimeKind::Docker,
        endpoint: "unix:///old.sock".into(),
        source: "context:old".into(),
        version: "1".into(),
        engine: "Docker".into(),
        state: DetectState::Stopped,
    };
    let new = Detected {
        endpoint: "unix:///new.sock".into(),
        state: DetectState::Ready,
        ..old.clone()
    };
    assert_eq!(
        choose_default(&[old.clone(), new], Some(&old), Some(26)),
        Some(0)
    );
    assert_eq!(choose_default(&[], Some(&old), Some(26)), None);
}
#[test]
fn choose_default_table() {
    let docker = Detected {
        kind: RuntimeKind::Docker,
        endpoint: "unix:///docker.sock".into(),
        source: "default".into(),
        version: "1".into(),
        engine: "Docker".into(),
        state: DetectState::Ready,
    };
    let apple = Detected {
        kind: RuntimeKind::Apple,
        endpoint: "/usr/local/bin/container".into(),
        ..docker.clone()
    };
    assert_eq!(
        choose_default(&[docker.clone(), apple.clone()], None, Some(26)),
        Some(1)
    );
    assert_eq!(choose_default(&[docker, apple], None, Some(15)), Some(0));
}
#[test]
fn detection_candidate_table() {
    for (host, expect) in [
        (
            Host::Mac,
            vec![
                "default",
                "rootless",
                "podman",
                "docker-desktop",
                "orbstack",
                "colima",
            ],
        ),
        (Host::Linux, vec!["default", "rootless", "podman"]),
        (
            Host::Windows,
            vec!["docker_engine", "podman-machine-default"],
        ),
    ] {
        let home = tempfile::tempdir().unwrap();
        let e = Env {
            host,
            docker_host: None,
            xdg_runtime_dir: Some(home.path().join("run")),
            macos_major: Some(26),
        };
        assert_eq!(
            candidates(&e, home.path())
                .candidates
                .iter()
                .map(|c| c.source.as_str())
                .collect::<Vec<_>>(),
            expect
        );
    }
}
#[test]
fn the_same_socket_via_two_sources_is_listed_once() {
    let home = tempfile::tempdir().unwrap();
    let socket = home.path().join("run/docker.sock");
    std::fs::create_dir_all(socket.parent().unwrap()).unwrap();
    std::fs::write(&socket, []).unwrap();
    let e = Env {
        host: Host::Linux,
        docker_host: Some(format!("unix://{}", socket.display())),
        xdg_runtime_dir: Some(socket.parent().unwrap().into()),
        macos_major: None,
    };
    let found = candidates(&e, home.path());
    assert_eq!(
        found
            .candidates
            .iter()
            .filter(|c| c.endpoint.to_string() == format!("unix://{}", socket.display()))
            .count(),
        1
    );
}
#[test]
fn contexts_cover_orbstack_colima_rancher_and_podman() {
    for name in [
        "orbstack",
        "colima",
        "rancher-desktop",
        "podman",
        "rootless",
    ] {
        let h = tempfile::tempdir().unwrap();
        let meta = h.path().join(".docker/contexts/meta/synthetic");
        std::fs::create_dir_all(&meta).unwrap();
        std::fs::write(
            h.path().join(".docker/config.json"),
            serde_json::to_vec(&serde_json::json!({"currentContext":name})).unwrap(),
        )
        .unwrap();
        let endpoint = format!("unix://{}/fixture.sock", h.path().display());
        std::fs::write(
            meta.join("meta.json"),
            serde_json::to_vec(
                &serde_json::json!({"Name":name,"Endpoints":{"docker":{"Host":endpoint}}}),
            )
            .unwrap(),
        )
        .unwrap();
        let e = Env {
            host: Host::Mac,
            docker_host: None,
            xdg_runtime_dir: None,
            macos_major: Some(26),
        };
        assert_eq!(
            candidates(&e, h.path()).candidates[0].source,
            format!("context:{name}")
        );
    }
}
#[test]
fn permission_denied_is_no_access_with_the_rootless_hint() {
    use plur1bus_desktop::runtime::{docker::map_error, RuntimeError};
    assert_eq!(
        map_error(bollard::errors::Error::IOError {
            err: std::io::Error::from(std::io::ErrorKind::PermissionDenied)
        }),
        RuntimeError::NoAccess("docker-group-root-equivalent".into())
    );
}
