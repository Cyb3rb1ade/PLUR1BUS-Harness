//! Held JSONL append tests over real files, including the existing Node journal fixture.
#![allow(clippy::unwrap_used, clippy::panic, reason = "fixture assertions")]
use super::TrustedDirectory;
use crate::{contract::StoreError, text::json::parse_json};
use std::fs;

const LIMIT: usize = 1024 * 1024;
fn temp() -> tempfile::TempDir {
    tempfile::tempdir().unwrap()
}

#[test]
fn durable_append_preserves_actual_node_bytes_and_closes_torn_tail() {
    let root = temp();
    let path = root.path().canonicalize().unwrap();
    let directory = TrustedDirectory::open(&path).unwrap();
    let source = include_str!("../../tests/fixtures/neo-v1/turn-journal.jsonl");
    for line in source.lines() {
        directory
            .append_jsonl_durable("journal.jsonl", &parse_json(line).unwrap(), LIMIT)
            .unwrap();
    }
    assert_eq!(
        fs::read_to_string(path.join("journal.jsonl")).unwrap(),
        source
    );
    fs::write(path.join("torn.jsonl"), b"{\"interrupted\":").unwrap();
    directory
        .append_jsonl_durable(
            "torn.jsonl",
            &parse_json("{\"id\":\"next\"}").unwrap(),
            LIMIT,
        )
        .unwrap();
    assert_eq!(
        fs::read(path.join("torn.jsonl")).unwrap(),
        b"{\"interrupted\":\n{\"id\":\"next\"}\n"
    );
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        assert_eq!(
            fs::metadata(path.join("journal.jsonl")).unwrap().mode() & 0o777,
            0o600
        );
    }
}
#[test]
fn bounds_and_invalid_names_do_not_create_or_modify_targets() {
    let root = temp();
    let path = root.path().canonicalize().unwrap();
    let directory = TrustedDirectory::open(&path).unwrap();
    let record = parse_json("{\"id\":\"fixture\"}").unwrap();
    for name in [
        "",
        ".",
        "..",
        "../escape",
        "nested/name",
        "back\\slash",
        "zero\0byte",
    ] {
        assert!(directory
            .append_jsonl_durable(name, &record, LIMIT)
            .is_err());
    }
    assert!(directory
        .append_jsonl_durable("oversized.jsonl", &record, 1)
        .is_err());
    assert_eq!(fs::read_dir(&path).unwrap().count(), 0);
    fs::write(path.join("existing.jsonl"), b"unchanged").unwrap();
    assert!(directory
        .append_jsonl_durable("existing.jsonl", &record, 0)
        .is_err());
    assert_eq!(fs::read(path.join("existing.jsonl")).unwrap(), b"unchanged");
}
#[test]
fn held_directory_replacement_is_refused_before_opening_a_target() {
    let root = temp();
    let path = root.path().canonicalize().unwrap();
    fs::create_dir(path.join("live")).unwrap();
    let directory = TrustedDirectory::open(&path.join("live")).unwrap();
    fs::rename(path.join("live"), path.join("old")).unwrap();
    fs::create_dir(path.join("live")).unwrap();
    assert!(directory
        .append_jsonl_durable("journal.jsonl", &parse_json("{}").unwrap(), LIMIT)
        .is_err());
    assert_eq!(fs::read_dir(path.join("live")).unwrap().count(), 0);
    assert_eq!(fs::read_dir(path.join("old")).unwrap().count(), 0);
}
#[cfg(unix)]
#[test]
fn symlinks_hardlinks_directories_and_fifos_cannot_receive_appends() {
    use std::os::unix::fs::symlink;
    let root = temp();
    let path = root.path().canonicalize().unwrap();
    let directory = TrustedDirectory::open(&path).unwrap();
    fs::write(path.join("outside"), b"unchanged").unwrap();
    symlink(path.join("outside"), path.join("link")).unwrap();
    fs::hard_link(path.join("outside"), path.join("hardlink")).unwrap();
    fs::create_dir(path.join("folder")).unwrap();
    let fifo = std::ffi::CString::new(path.join("fifo").to_str().unwrap()).unwrap();
    // SAFETY: the test owns the path and passes a live NUL-terminated name.
    assert_eq!(unsafe { libc::mkfifo(fifo.as_ptr(), 0o600) }, 0);
    for name in ["link", "hardlink", "folder", "fifo"] {
        assert!(directory
            .append_jsonl_durable(name, &parse_json("{}").unwrap(), LIMIT)
            .is_err());
    }
    assert_eq!(fs::read(path.join("outside")).unwrap(), b"unchanged");
}
#[test]
fn a_leaf_replaced_after_open_is_detected_before_the_write() {
    let root = temp();
    let path = root.path().canonicalize().unwrap();
    let directory = TrustedDirectory::open(&path).unwrap();
    let mut append = super::append::AppendFile::open(&directory, "journal.jsonl").unwrap();
    fs::rename(path.join("journal.jsonl"), path.join("old.jsonl")).unwrap();
    fs::write(path.join("journal.jsonl"), b"replacement").unwrap();
    assert!(matches!(
        append.append(b"{}"),
        Err(StoreError::UntrustedPath)
    ));
    assert_eq!(fs::read(path.join("old.jsonl")).unwrap(), b"");
    assert_eq!(
        fs::read(path.join("journal.jsonl")).unwrap(),
        b"replacement"
    );
}
