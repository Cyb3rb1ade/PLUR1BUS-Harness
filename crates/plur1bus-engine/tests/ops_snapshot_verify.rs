//! Actual Node verifier fixtures, including preserved evidence for the trusted-path exception.
#![allow(clippy::unwrap_used, reason = "snapshot fixtures fail immediately")]
#[path = "recall_support.rs"]
mod support;
use plur1bus_engine::ops::snapshot::{verify_snapshot, SnapshotError};
use serde_json::{json, Value};
use std::{
    collections::BTreeMap,
    fs,
    path::{Path, PathBuf},
};

fn tree(root: &Path) -> BTreeMap<PathBuf, Vec<u8>> {
    let mut files = BTreeMap::new();
    for e in fs::read_dir(root).unwrap() {
        let e = e.unwrap();
        if e.file_type().unwrap().is_dir() {
            files.extend(tree(&e.path()));
        } else {
            files.insert(e.path(), fs::read(e.path()).unwrap());
        }
    }
    files
}

#[test]
fn actual_node_snapshot_verification_matches_except_for_explicit_path_boundary() {
    let fixture: Value =
        serde_json::from_str(include_str!("fixtures/ops/golden/snapshot-verify.json")).unwrap();
    for case in fixture["cases"].as_array().unwrap() {
        let root = support::canonical_tempdir();
        let dir = root.path().join("snapshot");
        fs::create_dir(&dir).unwrap();
        if let Some(raw) = case["rawManifest"].as_str() {
            fs::write(dir.join("snapshot.json"), raw).unwrap();
        }
        // Unsafe manifests must fail before any payload is opened, including on hosts
        // where the original Node filename (such as a colon) cannot even be created.
        if case["rustReason"].is_null() {
            for (relative, content) in case["payloads"].as_object().unwrap() {
                let path = dir.join(relative);
                fs::create_dir_all(path.parent().unwrap()).unwrap();
                fs::write(path, content.as_str().unwrap()).unwrap();
            }
        }
        let before = tree(root.path());
        let result = verify_snapshot(&dir);
        if let Some(reason) = case["rustReason"].as_str() {
            assert!(
                matches!(
                    case["name"].as_str(),
                    Some("parent-traversal" | "nonportable-colon")
                ),
                "only the two documented RE-D40 vectors may diverge"
            );
            assert!(
                case["result"]["value"].is_object(),
                "preserve the original Node acceptance evidence"
            );
            assert_eq!(result.unwrap_err().reason(), reason, "{}", case["name"]);
        } else if let Some(reason) = case["result"]["error"].as_str() {
            assert_eq!(result.unwrap_err().reason(), reason, "{}", case["name"]);
        } else {
            let report = result.unwrap();
            let expected = &case["result"]["value"];
            assert_eq!(json!(report.id), expected["id"], "{}", case["name"]);
            assert_eq!(json!(report.files), expected["files"], "{}", case["name"]);
            if expected["bytes"].is_null() {
                assert!(report.bytes.is_infinite());
                assert_eq!(serde_json::to_value(report.bytes).unwrap(), Value::Null);
            } else {
                assert_eq!(
                    Some(report.bytes),
                    expected["bytes"].as_f64(),
                    "{}",
                    case["name"]
                );
            }
        }
        assert_eq!(
            tree(root.path()),
            before,
            "{} must be readonly",
            case["name"]
        );
    }
}

#[test]
fn missing_or_oversized_manifests_fail_without_creating_files_or_exposing_content() {
    let root = support::canonical_tempdir();
    let dir = root.path().join("snapshot");
    assert_eq!(verify_snapshot(&dir).unwrap_err(), SnapshotError::NotFound);
    assert!(!dir.exists());
    fs::create_dir(&dir).unwrap();
    fs::File::create(dir.join("snapshot.json"))
        .unwrap()
        .set_len(64 * 1024 * 1024 + 1)
        .unwrap();
    assert_eq!(
        verify_snapshot(&dir).unwrap_err(),
        SnapshotError::DigestMismatch
    );
    fs::write(
        dir.join("snapshot.json"),
        b"{private snapshot content is malformed",
    )
    .unwrap();
    let error = verify_snapshot(&dir).unwrap_err();
    assert_eq!(error.to_string(), "digest-mismatch");
    assert!(!format!("{error:?}").contains("private snapshot content"));
    assert_eq!(fs::read_dir(&dir).unwrap().count(), 1);
}

#[test]
fn every_nonportable_manifest_path_is_refused_before_missing_payload_lookup() {
    let root = support::canonical_tempdir();
    let dir = root.path().join("snapshot");
    fs::create_dir(&dir).unwrap();
    for path in [
        "../outside",
        "/outside",
        "a/../../outside",
        "./payload",
        "store//file",
        "C:/outside",
        "a\\b",
        "nul\0x",
        "tail.",
        "tail ",
    ] {
        let manifest = json!({"schema":"plur1bus.snapshot/1","files":[{"path":path,"bytes":0,"sha256":"unused"}]});
        fs::write(dir.join("snapshot.json"), manifest.to_string()).unwrap();
        assert_eq!(
            verify_snapshot(&dir).unwrap_err(),
            SnapshotError::UnsafePath,
            "{path:?}"
        );
        assert_eq!(fs::read_dir(&dir).unwrap().count(), 1);
    }
}

#[cfg(unix)]
#[test]
fn manifest_links_payload_links_and_special_files_never_escape_the_snapshot() {
    use sha2::{Digest, Sha256};
    use std::os::unix::fs::symlink;
    let root = support::canonical_tempdir();
    let dir = root.path().join("snapshot");
    fs::create_dir(&dir).unwrap();
    let outside = root.path().join("outside");
    let content = b"synthetic outside payload";
    fs::write(&outside, content).unwrap();
    let manifest = json!({"schema":"plur1bus.snapshot/1","bytes":content.len(),"files":[{"path":"payload","bytes":content.len(),"sha256":format!("{:x}",Sha256::digest(content))}]});
    let outside_manifest = root.path().join("outside-manifest");
    fs::write(&outside_manifest, manifest.to_string()).unwrap();
    symlink(&outside_manifest, dir.join("snapshot.json")).unwrap();
    assert_eq!(
        verify_snapshot(&dir).unwrap_err(),
        SnapshotError::UnsafePath
    );
    fs::remove_file(dir.join("snapshot.json")).unwrap();
    fs::write(dir.join("snapshot.json"), manifest.to_string()).unwrap();
    symlink(&outside, dir.join("payload")).unwrap();
    assert_eq!(
        verify_snapshot(&dir).unwrap_err(),
        SnapshotError::DigestMismatch
    );
    fs::remove_file(dir.join("payload")).unwrap();
    let fifo = std::ffi::CString::new(dir.join("payload").to_str().unwrap()).unwrap();
    // SAFETY: the NUL-terminated test-only path is valid and mode is an ordinary permission mask.
    assert_eq!(unsafe { libc::mkfifo(fifo.as_ptr(), 0o600) }, 0);
    assert_eq!(
        verify_snapshot(&dir).unwrap_err(),
        SnapshotError::DigestMismatch
    );
    assert_eq!(fs::read(outside).unwrap(), content);
}
