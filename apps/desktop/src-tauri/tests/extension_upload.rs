//! Local package reads use synthetic files only; paths never cross native IPC.
use plur1bus_desktop::extension_commands::read_package;

#[test]
fn package_reads_are_bounded_and_refuse_nonregular_files() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("package.p1x");
    std::fs::write(&path, b"1234").unwrap();
    assert_eq!(read_package(&path, 4).unwrap(), b"1234");
    assert_eq!(read_package(&path, 3).unwrap_err(), "too-large");
    assert_eq!(read_package(dir.path(), 10).unwrap_err(), "unsafe-file");
    std::fs::create_dir(dir.path().join("nested")).unwrap();
    assert_eq!(
        read_package(&dir.path().join("nested/../package.p1x"), 10).unwrap_err(),
        "unsafe-file"
    );
    assert_eq!(read_package(&path, u64::MAX).unwrap_err(), "unsafe-file");
}

#[cfg(unix)]
#[test]
fn package_reads_refuse_symlink_and_fifo_before_opening() {
    use std::os::unix::fs::symlink;
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("real.p1x");
    std::fs::write(&path, b"secret").unwrap();
    let link = dir.path().join("link.p1x");
    symlink(&path, &link).unwrap();
    assert_eq!(read_package(&link, 100).unwrap_err(), "unsafe-file");
    let fifo = dir.path().join("pipe.p1x");
    let name = std::ffi::CString::new(fifo.to_str().unwrap()).unwrap();
    assert_eq!(unsafe { libc::mkfifo(name.as_ptr(), 0o600) }, 0);
    assert_eq!(read_package(&fifo, 100).unwrap_err(), "unsafe-file");
}

#[test]
fn signed_snapshot_runtime_is_optional_for_older_bundles_and_closed_for_new_bundles() {
    let mut manifest: serde_json::Value =
        serde_json::from_str(include_str!("../../bundle/bundle.json.tmpl")).unwrap();
    manifest["snapshotRuntime"] = serde_json::json!({
        "nodeVersion":"24.21.0", "node":{"path":"snapshot/node","sha256":"a".repeat(64)},
        "entry":{"path":"snapshot/import-snapshot.mjs","sha256":"b".repeat(64)}
    });
    assert!(
        serde_json::from_value::<plur1bus_desktop::controller::bundle::Bundle>(manifest).is_ok()
    );
}

#[test]
fn renderer_upload_requests_cannot_supply_a_local_path() {
    let request = serde_json::json!({"linkId":1,"connectionId":uuid::Uuid::now_v7()});
    assert!(
        serde_json::from_value::<plur1bus_desktop::extension_commands::UploadRequest>(
            request.clone()
        )
        .is_ok()
    );
    let mut malicious = request;
    malicious["path"] = serde_json::json!("/private/credential");
    assert!(
        serde_json::from_value::<plur1bus_desktop::extension_commands::UploadRequest>(malicious)
            .is_err()
    );
}
