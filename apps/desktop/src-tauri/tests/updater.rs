use plur1bus_desktop::updates::*;
use sha2::{Digest, Sha256};
use std::io::Cursor;
fn signed(bytes: &[u8]) -> (String, String) {
    let k = minisign::KeyPair::generate_unencrypted_keypair().unwrap();
    let s = minisign::sign(Some(&k.pk), &k.sk, Cursor::new(bytes), None, None).unwrap();
    (k.pk.to_base64(), s.to_string())
}
#[test]
fn a_correctly_signed_update_is_accepted() {
    let bytes = b"synthetic app archive";
    let (k, s) = signed(bytes);
    assert!(verify_payload(bytes, &s, &k).is_ok());
}
#[test]
fn a_tampered_payload_is_refused() {
    let (k, s) = signed(b"synthetic app archive");
    assert!(verify_payload(b"changed archive", &s, &k).is_err());
}
#[test]
fn a_manifest_digest_mismatch_is_refused() {
    let r:Release=serde_json::from_value(serde_json::json!({"version":"0.1.1","channel":"stable","kind":"patch","security":false,"date":"2026-10-10","notes":{"de":"Behoben","en":"Fixed"},"minFromVersion":"0.1.0","bundle":"0".repeat(64),"tauri":"1".repeat(64)})).unwrap();
    assert_eq!(verify_manifest(b"{}", &r), Err(UpdateError::Digest));
}
#[test]
fn manifest_uses_the_pinned_plugins_actual_static_shape() {
    let bytes=br#"{"version":"0.1.1","notes":"Fixed","platforms":{"darwin-aarch64":{"url":"https://harness.test/app.tar.gz","signature":"generated-at-release"}}}"#;
    let mut r:Release=serde_json::from_value(serde_json::json!({"version":"0.1.1","channel":"stable","kind":"patch","security":false,"date":"2026-10-10","notes":{"de":"Behoben","en":"Fixed"},"minFromVersion":"0.1.0","bundle":"0".repeat(64),"tauri":"1".repeat(64)})).unwrap();
    r.tauri_manifest_digest = format!("{:x}", Sha256::digest(bytes));
    assert!(verify_manifest(bytes, &r).is_ok());
}
#[test]
fn pending_is_written_before_restart() {
    let dir = tempfile::tempdir().unwrap();
    let version = semver::Version::parse("0.1.1").unwrap();
    let mut restarted = false;
    plur1bus_desktop::update_commands::pending_before_install(dir.path(), &version, || {
        let v: serde_json::Value =
            serde_json::from_slice(&std::fs::read(dir.path().join("upgrades.json")).unwrap())
                .unwrap();
        assert_eq!(v["pending"], "0.1.1");
        restarted = true;
        Ok(())
    })
    .unwrap();
    assert!(restarted);
}
#[path = "../build_keys.rs"]
mod build_keys;
#[test]
fn release_build_refuses_the_placeholder_key() {
    assert!(build_keys::check(true, false, ["PLACEHOLDER beta feed"]).is_err());
    assert!(build_keys::check(false, false, ["PLACEHOLDER beta feed"]).is_ok());
    assert!(build_keys::check(true, true, ["PLACEHOLDER beta feed"]).is_ok());
}
#[test]
fn store_build_has_no_updater_plugin() {
    let source = include_str!("../src/lib.rs");
    assert!(source.contains("#[cfg(all(feature = \"direct-updater\", not(feature = \"store\")))]"));
}
#[test]
fn updater_key_uses_the_plugins_base64_wrapped_public_file_format() {
    use base64::Engine;
    let (key, _) = signed(b"archive");
    let encoded = tauri_public_key(&key).unwrap();
    let decoded = base64::engine::general_purpose::STANDARD
        .decode(&encoded)
        .unwrap();
    assert!(minisign_verify::PublicKey::decode(std::str::from_utf8(&decoded).unwrap()).is_ok());
    assert_eq!(tauri_public_key(&encoded).unwrap(), encoded);
}

#[cfg(all(feature = "direct-updater", not(feature = "store")))]
#[test]
fn native_plugin_configuration_deserializes_before_setup() {
    let config: serde_json::Value =
        serde_json::from_str(include_str!("../tauri.conf.json")).unwrap();
    let _: tauri_plugin_updater::Config =
        serde_json::from_value(config["plugins"]["updater"].clone()).unwrap();
}

#[test]
fn app_only_updates_are_blocked_for_the_actual_bundled_controller_location() {
    let root = tempfile::tempdir().unwrap();
    assert!(!plur1bus_desktop::update_commands::bundled_install_present(
        root.path()
    ));
    std::fs::create_dir(root.path().join("bundled")).unwrap();
    std::fs::write(root.path().join("bundled/installed.json"), b"{}").unwrap();
    assert!(plur1bus_desktop::update_commands::bundled_install_present(
        root.path()
    ));
}
#[test]
fn all_update_commands_are_refused_to_spa_approvals_and_panel_callers() {
    for command in [
        "update_check",
        "update_settings",
        "update_install",
        "update_later",
        "update_skip",
        "update_store_open",
    ] {
        assert!(plur1bus_desktop::commands::allowed_command(
            "shell", command
        ));
        for label in ["spa", "approvals", "panel-1"] {
            assert!(!plur1bus_desktop::commands::allowed_command(label, command));
        }
    }
}

#[test]
fn approved_bundle_hash_and_product_version_bind_the_resumed_upgrade() {
    use plur1bus_desktop::{
        controller::bundle::embedded,
        updates::Kind,
        upgrade_commands::{validate_pending, Pending},
    };
    let bytes = include_bytes!("../../bundle/bundle.json.tmpl");
    let bundle = embedded();
    let mut p = Pending {
        pending: semver::Version::parse(&bundle.version).unwrap(),
        automatic: false,
        kind: Some(Kind::Patch),
        bundle_digest: Some(format!("{:x}", Sha256::digest(bytes))),
    };
    assert_eq!(validate_pending(&p, bundle, bytes).unwrap(), Kind::Patch);
    assert!(validate_pending(&p, bundle, b"changed").is_err());
    p.pending = semver::Version::parse("9.0.0").unwrap();
    assert!(validate_pending(&p, bundle, bytes).is_err());
}
#[test]
fn wp11_commands_are_shell_only() {
    for command in ["harness_upgrade_status", "harness_rollback"] {
        for view in ["spa", "approvals", "panel-1"] {
            assert!(!plur1bus_desktop::commands::allowed_command(view, command));
        }
    }
}
#[test]
fn automatic_pending_waits_for_idle_quiet_hours_and_retains_opt_out() {
    use plur1bus_desktop::{
        updates::{Kind, UpdateSettings},
        upgrade_commands::{automatic_resume_allowed, Pending},
    };
    let p = Pending {
        pending: semver::Version::parse("0.1.1").unwrap(),
        automatic: true,
        kind: Some(Kind::Patch),
        bundle_digest: Some("a".repeat(64)),
    };
    let mut s = UpdateSettings::default();
    assert!(automatic_resume_allowed(&p, &s, 4, true));
    assert!(!automatic_resume_allowed(&p, &s, 4, false));
    assert!(!automatic_resume_allowed(&p, &s, 6, true));
    s.auto_patch = false;
    assert!(!automatic_resume_allowed(&p, &s, 4, true));
    s.auto_patch = true;
    s.held = true;
    assert!(!automatic_resume_allowed(&p, &s, 4, true));
}
#[test]
fn late_native_ready_cannot_hide_upgrade_progress_or_recovery_failure() {
    use plur1bus_desktop::{native::NativeState, tray::HarnessState};
    let state = NativeState::default();
    *state.upgrade_overlay.lock().unwrap() = Some(HarnessState::Updating);
    assert_eq!(
        state.effective_harness(HarnessState::Ready),
        HarnessState::Updating
    );
    *state.upgrade_overlay.lock().unwrap() = Some(HarnessState::Degraded);
    assert_eq!(
        state.effective_harness(HarnessState::Ready),
        HarnessState::Degraded
    );
    *state.upgrade_overlay.lock().unwrap() = None;
    assert_eq!(
        state.effective_harness(HarnessState::Ready),
        HarnessState::Ready
    );
}
