#![allow(
    clippy::unwrap_used,
    reason = "snapshot test fixtures fail immediately"
)]
use super::*;
use serde_json::{json, Value};
use std::{
    cell::Cell,
    path::{Path, PathBuf},
    rc::Rc,
};
fn tempdir() -> tempfile::TempDir {
    let base = fs::canonicalize(std::env::temp_dir()).unwrap();
    tempfile::tempdir_in(base).unwrap()
}
fn hex_decode(s: &str) -> Vec<u8> {
    s.as_bytes()
        .chunks_exact(2)
        .map(|p| u8::from_str_radix(std::str::from_utf8(p).unwrap(), 16).unwrap())
        .collect()
}
fn hex_encode(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}
fn write(root: &Path, path: &str, bytes: &[u8]) {
    let file = root.join(path);
    fs::create_dir_all(file.parent().unwrap()).unwrap();
    fs::write(file, bytes).unwrap();
}
fn tree(root: &Path) -> BTreeMap<PathBuf, Vec<u8>> {
    let mut out = BTreeMap::new();
    for entry in fs::read_dir(root).unwrap() {
        let entry = entry.unwrap();
        let kind = entry.file_type().unwrap();
        if kind.is_dir() {
            out.extend(tree(&entry.path()));
        } else if kind.is_file() {
            out.insert(entry.path(), fs::read(entry.path()).unwrap());
        }
    }
    out
}
#[test]
fn real_node_copier_vectors_include_moving_tables_and_cleanup() {
    let fixture: Value = serde_json::from_str(include_str!(
        "../../tests/fixtures/ops/golden/snapshot-copy.json"
    ))
    .unwrap();
    for case in fixture["cases"].as_array().unwrap() {
        let tmp = tempdir();
        let source = tmp.path().join("source");
        let stage = tmp.path().join("stage");
        fs::create_dir(&source).unwrap();
        fs::create_dir(&stage).unwrap();
        for (p, hex) in case["payloads"].as_object().unwrap() {
            write(&source, p, &hex_decode(hex.as_str().unwrap()));
        }
        let mutation = case["mutation"].as_str().unwrap_or("").to_owned();
        let source_pin = TrustedDirectory::open(&source).unwrap();
        let stage_pin = TrustedDirectory::open(&stage).unwrap();
        let cancel = Cancel::never();
        let mut copier = Copier::new(&stage_pin, &cancel).unwrap();
        let copies = Rc::new(Cell::new(0));
        let mutations = Rc::new(Cell::new(0));
        let (count, changes, base) = (copies.clone(), mutations.clone(), source.clone());
        copier.after_copy = Some(Box::new(move |relative| {
            count.set(count.get() + 1);
            if relative != "store/data/x.lance" {
                return;
            }
            if mutation == "always" || (mutation == "once" && changes.get() == 0) {
                changes.set(changes.get() + 1);
                write(
                    &base,
                    &format!("_versions/{}.manifest", changes.get() + 1),
                    b"\x12\x07x.lance",
                );
            }
            if mutation == "bytes" && changes.get() == 0 {
                changes.set(1);
                write(&base, "_versions/1.manifest", b"\x12\x07x.lance\0");
            }
            if mutation == "vanish" && changes.get() == 0 {
                changes.set(1);
                fs::remove_file(base.join("data/y.lance")).unwrap();
            }
        }));
        let result = copier.copy_directory(&source_pin, "store");
        if let Some(reason) = case["result"]["error"].as_str() {
            assert_eq!(result.unwrap_err().reason(), reason, "{}", case["name"]);
            assert!(copier.files().is_empty());
            assert!(!stage.join("store").exists(), "discard failed table");
        } else {
            result.unwrap();
            let mut expected = case["result"]["files"].as_array().unwrap().clone();
            if !case["rustException"].is_null() {
                assert_eq!(case["rustException"], "cache-excluded");
                assert_eq!(case["name"], "derived-cache");
                assert!(expected
                    .iter()
                    .any(|f| derived_cache(f["path"].as_str().unwrap())));
                expected.retain(|f| !derived_cache(f["path"].as_str().unwrap()));
            }
            let files = copier.files();
            assert_eq!(
                serde_json::to_value(&files).unwrap(),
                json!(expected),
                "{}",
                case["name"]
            );
            for f in &files {
                assert_eq!(
                    hex_encode(&fs::read(stage.join(&f.path)).unwrap()),
                    case["result"]["payloads"][&f.path]
                );
            }
            assert_eq!(tree(&stage).len(), files.len());
            // Feed the emitted payload index to the independent production verifier.
            let bytes: u64 = files.iter().map(|f| f.bytes).sum();
            fs::write(
                stage.join("snapshot.json"),
                serde_json::to_vec(
                    &json!({"schema":super::super::SNAPSHOT_SCHEMA,"files":files,"bytes":bytes}),
                )
                .unwrap(),
            )
            .unwrap();
            let report = super::super::verify_snapshot(&stage).unwrap();
            assert_eq!(report.files, files.len());
            assert_eq!(report.bytes, bytes as f64);
        }
        if case["rustException"].is_null() {
            assert_eq!(
                copies.get() as u64,
                case["copies"].as_u64().unwrap(),
                "{} copy attempts",
                case["name"]
            );
        }
        assert_eq!(
            mutations.get() as u64,
            case["mutations"].as_u64().unwrap(),
            "{} mutations",
            case["name"]
        );
    }
}
#[test]
fn cancellation_does_not_retry_and_staging_must_be_empty() {
    let tmp = tempdir();
    let source = tmp.path().join("source");
    let stage = tmp.path().join("stage");
    fs::create_dir(&source).unwrap();
    fs::create_dir(&stage).unwrap();
    write(&source, "data/x.lance", b"payload");
    write(&source, "_versions/1.manifest", b"\x12\x07x.lance");
    let source_pin = TrustedDirectory::open(&source).unwrap();
    let stage_pin = TrustedDirectory::open(&stage).unwrap();
    let cancel = Cancel::never();
    cancel.cancel();
    assert!(matches!(
        Copier::new(&stage_pin, &cancel),
        Err(SnapshotError::Cancelled)
    ));
    assert!(tree(&stage).is_empty());
    let cancel = Cancel::never();
    let signal = cancel.clone();
    let count = Rc::new(Cell::new(0));
    let called = count.clone();
    let before = tree(&source);
    let mut copier = Copier::new(&stage_pin, &cancel).unwrap();
    copier.after_copy = Some(Box::new(move |_| {
        called.set(called.get() + 1);
        signal.cancel();
    }));
    assert_eq!(
        copier.copy_directory(&source_pin, "store"),
        Err(SnapshotError::Cancelled)
    );
    assert_eq!(count.get(), 1);
    assert_eq!(tree(&source), before);
    assert!(matches!(
        Copier::new(&stage_pin, &Cancel::never()),
        Err(SnapshotError::UnsafePath)
    ));
}
#[test]
fn cache_filter_is_exact_and_paths_are_checked_before_creation() {
    assert!(derived_cache("store/LLM-RESULT-CACHE-V1/result.db"));
    assert!(!derived_cache("workspace/llm-result-cache-v1/file"));
    assert!(!derived_cache("store/llm-result-cache-v10/file"));
    let tmp = tempdir();
    let source = tmp.path().join("source");
    let stage = tmp.path().join("stage");
    fs::create_dir(&source).unwrap();
    fs::create_dir(&stage).unwrap();
    write(&source, "file", b"source");
    let source_pin = TrustedDirectory::open(&source).unwrap();
    let stage_pin = TrustedDirectory::open(&stage).unwrap();
    let cancel = Cancel::never();
    let mut copier = Copier::new(&stage_pin, &cancel).unwrap();
    for path in [
        "../outside",
        "/absolute",
        "store/a:b",
        "store/../outside",
        "store/ends.",
        "store/back\\slash",
    ] {
        assert_eq!(
            copier.copy_directory(&source_pin, path),
            Err(SnapshotError::UnsafePath)
        );
    }
    assert!(tree(&stage).is_empty());
}
#[cfg(unix)]
#[test]
fn links_are_skipped_and_private_destination_never_overwrites_existing_files() {
    use std::os::unix::{
        ffi::OsStrExt,
        fs::{symlink, PermissionsExt},
    };
    let tmp = tempdir();
    let source = tmp.path().join("source");
    let stage = tmp.path().join("stage");
    fs::create_dir(&source).unwrap();
    fs::create_dir(&stage).unwrap();
    write(&source, "file", b"source");
    symlink(tmp.path(), source.join("link-directory")).unwrap();
    symlink(source.join("file"), source.join("link-file")).unwrap();
    let fifo = std::ffi::CString::new(source.join("fifo").as_os_str().as_bytes()).unwrap();
    // SAFETY: temporary test path is a valid NUL-terminated pathname.
    assert_eq!(unsafe { libc::mkfifo(fifo.as_ptr(), 0o600) }, 0);
    let source_pin = TrustedDirectory::open(&source).unwrap();
    let stage_pin = TrustedDirectory::open(&stage).unwrap();
    let cancel = Cancel::never();
    let mut copier = Copier::new(&stage_pin, &cancel).unwrap();
    copier.copy_directory(&source_pin, "store").unwrap();
    assert_eq!(copier.files().len(), 1);
    assert_eq!(
        fs::metadata(stage.join("store"))
            .unwrap()
            .permissions()
            .mode()
            & 0o777,
        0o700
    );
    assert_eq!(
        fs::metadata(stage.join("store/file"))
            .unwrap()
            .permissions()
            .mode()
            & 0o777,
        0o600
    );
    assert!(stage_pin.create_file("store").is_err());
    let store = stage_pin.open_child("store").unwrap();
    assert!(store.create_file("file").is_err());
    symlink(source.join("file"), stage.join("link")).unwrap();
    assert!(stage_pin.create_file("link").is_err());
    assert!(stage_pin.create_child("link").is_err());
    assert_eq!(fs::read(source.join("file")).unwrap(), b"source");
    assert_eq!(fs::read(stage.join("store/file")).unwrap(), b"source");
}

#[test]
fn overlapping_source_and_staging_are_rejected_before_writes() {
    let tmp = tempdir();
    let stage = tmp.path().join("stage");
    fs::create_dir(&stage).unwrap();
    let source = TrustedDirectory::open(tmp.path()).unwrap();
    let destination = TrustedDirectory::open(&stage).unwrap();
    let cancel = Cancel::never();
    let mut copier = Copier::new(&destination, &cancel).unwrap();
    assert_eq!(
        copier.copy_directory(&source, "store"),
        Err(SnapshotError::UnsafePath)
    );
    assert!(tree(tmp.path()).is_empty());
    let child = stage.join("source");
    fs::create_dir(&child).unwrap();
    let nested = TrustedDirectory::open(&child).unwrap();
    assert_eq!(
        copier.copy_directory(&nested, "store"),
        Err(SnapshotError::UnsafePath)
    );
    assert_eq!(
        copier.copy_directory(&destination, "store"),
        Err(SnapshotError::UnsafePath)
    );
    assert!(tree(tmp.path()).is_empty());
}
