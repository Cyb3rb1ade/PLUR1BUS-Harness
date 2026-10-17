use plur1bus_desktop::{
    controller::bundle::embedded,
    install::{
        apple_pkg::{self, AppleInstaller},
        cli_shim, podman_socket,
        vendor_installer::{self, VendorInstaller},
        verified,
    },
};
use std::{io::Write, path::Path, sync::Mutex};
struct Apple {
    events: Mutex<Vec<&'static str>>,
    bad: bool,
}
#[async_trait::async_trait]
impl AppleInstaller for Apple {
    async fn verify_signature(&self, _: &Path, _: &str) -> verified::Result<()> {
        self.events.lock().unwrap().push("signature");
        if self.bad {
            Err("installer-signature")
        } else {
            Ok(())
        }
    }
    async fn open(&self, _: &Path) -> verified::Result<()> {
        self.events.lock().unwrap().push("open -W");
        Ok(())
    }
    async fn start(&self) -> verified::Result<()> {
        self.events
            .lock()
            .unwrap()
            .push("container system start --enable-kernel-install");
        Ok(())
    }
}
fn apple_fixture() -> (
    tempfile::TempDir,
    plur1bus_desktop::controller::bundle::AppleReq,
) {
    let d = tempfile::tempdir().unwrap();
    std::fs::create_dir(d.path().join("apple")).unwrap();
    std::fs::write(
        d.path().join("apple/container.pkg"),
        b"synthetic signed pkg",
    )
    .unwrap();
    let mut a = embedded().apple.clone();
    a.pkg_sha256 = verified::sha256(&d.path().join("apple/container.pkg")).unwrap();
    (d, a)
}
#[tokio::test]
async fn apple_pkg_is_bundled_not_downloaded() {
    let (d, a) = apple_fixture();
    let fake = Apple {
        events: Mutex::new(vec![]),
        bad: false,
    };
    apple_pkg::install(d.path(), &a, true, &fake).await.unwrap();
    assert_eq!(
        fake.events.into_inner().unwrap(),
        [
            "signature",
            "open -W",
            "container system start --enable-kernel-install"
        ]
    );
}
#[tokio::test]
async fn apple_pkg_refuses_wrong_sha_or_signature() {
    let (d, mut a) = apple_fixture();
    let fake = Apple {
        events: Mutex::new(vec![]),
        bad: true,
    };
    assert!(apple_pkg::install(d.path(), &a, true, &fake).await.is_err());
    assert_eq!(*fake.events.lock().unwrap(), ["signature"]);
    fake.events.lock().unwrap().clear();
    a.pkg_sha256 = "f".repeat(64);
    assert!(apple_pkg::install(d.path(), &a, true, &fake).await.is_err());
    assert!(fake.events.lock().unwrap().is_empty());
}
#[tokio::test]
async fn apple_pkg_never_uses_sudo() {
    assert_eq!(
        apple_pkg::open_argv(Path::new("/owned/container.pkg")),
        [
            std::ffi::OsString::from("-W"),
            std::ffi::OsString::from("/owned/container.pkg")
        ]
    );
    assert_eq!(
        apple_pkg::start_argv(),
        ["system", "start", "--enable-kernel-install"]
    );
}
struct Vendor {
    events: Mutex<Vec<String>>,
    path: Mutex<Option<std::path::PathBuf>>,
}
#[async_trait::async_trait]
impl VendorInstaller for Vendor {
    async fn download(&self, _: &url::Url, file: &mut std::fs::File) -> verified::Result<()> {
        self.events.lock().unwrap().push("download".into());
        file.write_all(b"fixture").unwrap();
        Ok(())
    }
    async fn launch(&self, path: &Path) -> verified::Result<()> {
        *self.path.lock().unwrap() = Some(path.into());
        self.events.lock().unwrap().push("launch".into());
        assert!(path.exists());
        Ok(())
    }
}
fn vendor() -> Vendor {
    Vendor {
        events: Mutex::new(vec![]),
        path: Mutex::new(None),
    }
}
fn manifest() -> plur1bus_desktop::controller::bundle::VendorArtifact {
    plur1bus_desktop::controller::bundle::VendorArtifact {
        installer_url: "https://vendor.test/setup.exe".into(),
        sha256: "f".repeat(64),
        licence: "Review vendor licence".into(),
        signer_thumbprint: None,
    }
}
#[tokio::test]
async fn vendor_installer_refuses_wrong_checksum() {
    let f = vendor();
    assert_eq!(
        vendor_installer::install(&manifest(), true, &f).await,
        Err("installer-checksum")
    );
    assert_eq!(*f.events.lock().unwrap(), ["download"]);
}
#[tokio::test]
async fn vendor_installer_shows_the_vendor_licence_before_download() {
    let f = vendor();
    assert_eq!(
        vendor_installer::install(&manifest(), false, &f).await,
        Err("licences-required")
    );
    assert!(f.events.lock().unwrap().is_empty());
}
#[tokio::test]
async fn vendor_installer_never_passes_silent_flags() {
    let f = vendor();
    let mut m = manifest();
    use sha2::{Digest, Sha256};
    m.sha256 = format!("{:x}", Sha256::digest(b"fixture"));
    vendor_installer::install(&m, true, &f).await.unwrap();
    assert_eq!(*f.events.lock().unwrap(), ["download", "launch"]);
    assert!(!f.path.lock().unwrap().as_ref().unwrap().exists());
}
#[test]
fn podman_socket_uses_fixed_argv() {
    assert_eq!(
        podman_socket::argv(false),
        (
            "/usr/bin/systemctl",
            vec!["--user", "enable", "--now", "podman.socket"]
        )
    );
    assert_eq!(
        podman_socket::argv(true),
        (
            "/usr/bin/flatpak-spawn",
            vec![
                "--host",
                "systemctl",
                "--user",
                "enable",
                "--now",
                "podman.socket"
            ]
        )
    );
}
#[test]
fn cli_shim_never_overwrites_a_foreign_file() {
    let d = tempfile::tempdir().unwrap();
    let h = tempfile::tempdir().unwrap();
    std::fs::write(d.path().join("plur1bus"), b"release").unwrap();
    let a = plur1bus_desktop::controller::bundle::CliArtifact {
        path: "plur1bus".into(),
        sha256: verified::sha256(&d.path().join("plur1bus")).unwrap(),
    };
    let bin = cli_shim::bin_dir(h.path());
    std::fs::create_dir_all(&bin).unwrap();
    let target = bin.join(if cfg!(windows) {
        "plur1bus.exe"
    } else {
        "plur1bus"
    });
    std::fs::write(&target, b"native plur1bus foreign").unwrap();
    assert_eq!(
        cli_shim::install(d.path(), &a, h.path()).unwrap_err(),
        "shim-collision"
    );
    assert_eq!(std::fs::read(&target).unwrap(), b"native plur1bus foreign");
    cli_shim::remove(h.path()).unwrap();
    assert!(target.exists());
}
#[test]
fn path_line_is_added_once_with_marker_and_removed_on_uninstall() {
    let d = tempfile::tempdir().unwrap();
    let p = d.path().join("profile");
    let bin = d.path().join("bin");
    std::fs::write(&p, "# foreign\n").unwrap();
    cli_shim::update_profile(&p, &bin, true).unwrap();
    let once = std::fs::read(&p).unwrap();
    cli_shim::update_profile(&p, &bin, true).unwrap();
    assert_eq!(std::fs::read(&p).unwrap(), once);
    cli_shim::update_profile(&p, &bin, false).unwrap();
    assert_eq!(std::fs::read(&p).unwrap(), b"# foreign\n");
}
#[test]
fn everything_requires_typed_plur1bus_state() {
    use plur1bus_desktop::controller::UninstallLevel;
    use plur1bus_desktop::install_commands::{validate_uninstall, UninstallRequest};
    assert!(validate_uninstall(&UninstallRequest {
        level: UninstallLevel::Everything,
        confirmation: None
    })
    .is_err());
    assert!(validate_uninstall(&UninstallRequest {
        level: UninstallLevel::Everything,
        confirmation: Some("plur1bus-state".into())
    })
    .is_ok());
}
#[test]
fn uninstall_default_is_app_only_and_keeps_data() {
    let request: plur1bus_desktop::install_commands::UninstallRequest =
        serde_json::from_str("{}").unwrap();
    assert_eq!(
        request.level,
        plur1bus_desktop::controller::UninstallLevel::AppOnly
    );
}

#[path = "support/controller.rs"]
mod support_controller;
#[tokio::test]
async fn uninstall_removes_owned_previous_container_and_snapshot_only_for_everything() {
    use plur1bus_desktop::{
        connections::Store,
        controller::{
            journal::{Journal, RestorePhase, Snapshot, Step},
            Controller, Resources, UninstallLevel,
        },
        runtime::RuntimeKind,
        secrets::MemoryStore,
    };
    use std::sync::Arc;
    for level in [UninstallLevel::AppOnly, UninstallLevel::Everything] {
        let d = tempfile::tempdir().unwrap();
        let dir = d.path().join("bundled");
        let r = Arc::new(support_controller::FakeRuntime::new(RuntimeKind::Docker));
        let c = Controller::with_health(
            r.clone(),
            embedded().clone(),
            dir.clone(),
            Arc::new(support_controller::Healthy),
        )
        .with_test_namespace("uninstall-backup")
        .unwrap();
        let old = c.install(Resources::default(), |_| {}).await.unwrap();
        let snapshot = Snapshot {
            volume: format!(
                "{}-pre-{}",
                "p1t-uninstall-backup-state", old.installed_version
            ),
            manifest_sha256: "a".repeat(64),
            created_at: "2026-10-15T00:00:00Z".into(),
            bytes: 4096,
            file_count: 1,
        };
        let mut previous = r
            .state
            .lock()
            .unwrap()
            .containers
            .get(&old.container)
            .unwrap()
            .clone();
        previous.name = format!("{}-previous", old.container);
        {
            let mut s = r.state.lock().unwrap();
            s.containers.insert(previous.name.clone(), previous);
            s.volumes.insert(snapshot.volume.clone());
        }
        let j = Journal {
            from: old.installed_version.parse().unwrap(),
            to: "0.2.0".parse().unwrap(),
            from_digest: old.image_digest.clone(),
            to_digest: format!("sha256:{}", "a".repeat(64)),
            step: Step::Done,
            snapshot: Some(snapshot.clone()),
            failed_step: None,
            diagnostic: None,
            previous: old,
            skipped: false,
            restore_phase: RestorePhase::Complete,
            failed_snapshot: None,
            cleanup: None,
            cleanup_failed: None,
        };
        j.save(&dir).unwrap();
        let mut failed = j.clone();
        failed.step = Step::RecoveryFailed;
        failed.save(&dir).unwrap();
        let before = r.state.lock().unwrap().calls.len();
        assert!(c
            .uninstall(
                UninstallLevel::Everything,
                Some("plur1bus-state"),
                &MemoryStore::default(),
                &Store::open(&d.path().join("connections")),
                |_| {}
            )
            .await
            .is_err());
        assert_eq!(r.state.lock().unwrap().calls.len(), before);
        assert!(r.state.lock().unwrap().volumes.contains(&snapshot.volume));
        j.save(&dir).unwrap();

        if level == UninstallLevel::Everything {
            c.uninstall(
                UninstallLevel::AppOnly,
                None,
                &MemoryStore::default(),
                &Store::open(&d.path().join("connections")),
                |_| {},
            )
            .await
            .unwrap();
            assert!(c.installed().unwrap().is_none());
            assert!(c.retained_installed().unwrap().is_some());
            assert!(r.state.lock().unwrap().volumes.contains(&snapshot.volume));
        }
        c.uninstall(
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
        assert_eq!(
            s.volumes.contains(&snapshot.volume),
            level == UninstallLevel::AppOnly
        );
        assert_eq!(
            dir.join("upgrades.json").exists(),
            level == UninstallLevel::AppOnly
        );
    }
}
#[tokio::test]
async fn vendor_signer_pin_refuses_unsupported_or_invalid_signature_before_execution() {
    let f = vendor();
    let mut m = manifest();
    use sha2::{Digest, Sha256};
    m.sha256 = format!("{:x}", Sha256::digest(b"fixture"));
    m.signer_thumbprint = Some("a".repeat(40));
    assert_eq!(
        vendor_installer::install(&m, true, &f).await,
        Err("installer-signature")
    );
    assert_eq!(*f.events.lock().unwrap(), ["download"]);
}
#[test]
fn shim_removes_only_digest_owned_copy_and_preserves_modified_binary() {
    let d = tempfile::tempdir().unwrap();
    let h = tempfile::tempdir().unwrap();
    std::fs::write(d.path().join("host"), b"release").unwrap();
    let artifact = plur1bus_desktop::controller::bundle::CliArtifact {
        path: "host".into(),
        sha256: verified::sha256(&d.path().join("host")).unwrap(),
    };
    let path = cli_shim::install(d.path(), &artifact, h.path()).unwrap();
    cli_shim::install(d.path(), &artifact, h.path()).unwrap();
    std::fs::write(&path, b"replacement native CLI").unwrap();
    assert_eq!(cli_shim::remove(h.path()), Err("shim-collision"));
    assert!(path.exists());
    std::fs::write(&path, b"release").unwrap();
    cli_shim::remove(h.path()).unwrap();
    assert!(!path.exists());
}
#[cfg(unix)]
#[test]
fn installer_and_shim_refuse_symlink_substitution() {
    use std::os::unix::fs::symlink;
    let d = tempfile::tempdir().unwrap();
    let h = tempfile::tempdir().unwrap();
    std::fs::write(d.path().join("host"), b"release").unwrap();
    symlink(d.path().join("host"), d.path().join("linked")).unwrap();
    assert!(verified::resource(d.path(), "linked").is_err());
    assert!(verified::resource(d.path(), "../host").is_err());
    std::fs::create_dir(h.path().join(".local")).unwrap();
    symlink(d.path(), h.path().join(".local/bin")).unwrap();
    let a = plur1bus_desktop::controller::bundle::CliArtifact {
        path: "host".into(),
        sha256: verified::sha256(&d.path().join("host")).unwrap(),
    };
    assert!(cli_shim::install(d.path(), &a, h.path()).is_err());
    assert!(cli_shim::remove(h.path()).is_err());
}

#[test]
fn apple_signature_requires_trusted_status_exact_team_and_developer_identity() {
    let output="Package container.pkg:\n   Status: signed by a certificate trusted by macOS\n  1. Developer ID Installer: Apple Inc. (UPBK2H6LZM)\n";
    assert!(apple_pkg::trusted_signature(true, output, "UPBK2H6LZM"));
    assert!(!apple_pkg::trusted_signature(false, output, "UPBK2H6LZM"));
    assert!(!apple_pkg::trusted_signature(true, output, "EVILTEAM12"));
    assert!(!apple_pkg::trusted_signature(
        true,
        &output.replace(
            "Status: signed by a certificate trusted by macOS",
            "Status: no signature"
        ),
        "UPBK2H6LZM"
    ));
}

#[tokio::test]
async fn vendor_rejects_non_https_credentials_and_placeholders_before_download() {
    for url in [
        "http://vendor.test/setup.exe",
        "https://user:secret@vendor.test/setup.exe",
        "https://vendor.test/setup.exe#fragment",
    ] {
        let f = vendor();
        let mut m = manifest();
        m.installer_url = url.into();
        assert_eq!(
            vendor_installer::install(&m, true, &f).await,
            Err("installer-url")
        );
        assert!(f.events.lock().unwrap().is_empty());
    }
    let f = vendor();
    let mut m = manifest();
    m.sha256 = "0".repeat(64);
    assert_eq!(
        vendor_installer::install(&m, true, &f).await,
        Err("installer-unconfigured")
    );
    assert!(f.events.lock().unwrap().is_empty());
}
#[test]
fn installer_ipc_requests_reject_renderer_paths_urls_and_unknown_fields() {
    use plur1bus_desktop::install_commands::{
        LicenceRequest, ShimRequest, UninstallRequest, VendorRequest,
    };
    assert!(serde_json::from_str::<LicenceRequest>(
        r#"{"licenceAccepted":true,"path":"/tmp/evil.pkg"}"#
    )
    .is_err());
    assert!(serde_json::from_str::<VendorRequest>(
        r#"{"vendor":"docker","licenceAccepted":true,"url":"https://evil.test"}"#
    )
    .is_err());
    assert!(serde_json::from_str::<VendorRequest>(
        r#"{"vendor":"unknown","licenceAccepted":true}"#
    )
    .is_err());
    assert!(serde_json::from_str::<ShimRequest>(
        r#"{"addToPath":true,"destination":"/usr/bin/plur1bus"}"#
    )
    .is_err());
    assert!(serde_json::from_str::<UninstallRequest>(
        r#"{"level":"everything","confirmation":"plur1bus-state","volume":"foreign"}"#
    )
    .is_err());
}
