#![allow(clippy::unwrap_used, reason = "isolated durable-cap assertions")]
use super::*;
use crate::{
    contract::{Cancel, StoreError},
    store::directory::TrustedDirectory,
};
use std::{cell::Cell, io::Read};

#[cfg(unix)]
#[path = "neo_append_cap_crash.rs"]
mod crash;

fn compact(
    dir: &TrustedDirectory,
    name: &str,
    max: usize,
    cancel: &Cancel,
    check: &dyn Fn() -> Result<(), EngineError>,
) -> Result<usize, EngineError> {
    let Some((source, _)) = crate::neo::append_source::SourceProof::read(dir, name, cancel)? else {
        return Ok(0);
    };
    super::compact(dir, name, &source, max, cancel, check)
}

fn journal(dir: &TrustedDirectory, count: usize) -> Vec<u8> {
    let bytes = (0..count)
        .map(|i| format!("{{\"id\":\"turn-{i}\",\"timestamp\":0}}\n"))
        .collect::<String>()
        .into_bytes();
    std::fs::write(dir.path().join("turn-journal.jsonl"), &bytes).unwrap();
    bytes
}

#[test]
fn archives_exact_prefix_before_strict_cap_and_never_runs_age_retention() {
    let temp = tempfile::tempdir_in(std::env::temp_dir().canonicalize().unwrap()).unwrap();
    let dir = TrustedDirectory::open(temp.path()).unwrap();
    let original = journal(&dir, 700);
    assert_eq!(
        compact(
            &dir,
            "turn-journal.jsonl",
            500,
            &Cancel::never(),
            &|| Ok(())
        )
        .unwrap(),
        200
    );
    let live = std::fs::read(temp.path().join("turn-journal.jsonl")).unwrap();
    let archives: Vec<_> = std::fs::read_dir(temp.path().join("archives"))
        .unwrap()
        .map(Result::unwrap)
        .collect();
    assert_eq!(archives.len(), 1);
    let bytes = std::fs::read(archives[0].path()).unwrap();
    let mut prefix = Vec::new();
    flate2::read::MultiGzDecoder::new(bytes.as_slice())
        .read_to_end(&mut prefix)
        .unwrap();
    prefix.extend(&live);
    assert_eq!(prefix, original);
    let golden = include_str!("../fixtures/capture/golden/neo-n1-release.json");
    let marker: serde_json::Value = serde_json::from_str(include_str!(
        "../fixtures/capture/neo-n1-native-exceptions.json"
    ))
    .unwrap();
    assert_eq!(
        marker["nodeGoldenSha256"],
        format!("{:x}", Sha256::digest(golden.as_bytes()))
    );
    let source: serde_json::Value = serde_json::from_str(golden).unwrap();
    let cap = &source["caps"][0];
    let node_ids: Vec<_> = cap["archives"]
        .as_array()
        .unwrap()
        .iter()
        .flat_map(|a| a["ids"].as_array().unwrap())
        .chain(cap["live"].as_array().unwrap())
        .cloned()
        .collect();
    let native_ids: Vec<_> = std::str::from_utf8(&prefix)
        .unwrap()
        .lines()
        .map(|line| serde_json::from_str::<serde_json::Value>(line).unwrap()["id"].clone())
        .collect();
    assert_eq!(native_ids, node_ids);
    assert_eq!(
        cap["live"].as_array().unwrap().len(),
        502,
        "Node hysteresis stays in the untouched reference"
    );
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        assert_eq!(
            archives[0].metadata().unwrap().permissions().mode() & 0o777,
            0o600
        );
    }
    assert_eq!(
        compact(
            &dir,
            "turn-journal.jsonl",
            500,
            &Cancel::never(),
            &|| Ok(())
        )
        .unwrap(),
        0
    );
    assert_eq!(
        std::fs::read(temp.path().join("turn-journal.jsonl")).unwrap(),
        live
    );
}

#[test]
fn archive_failure_preserves_every_live_byte() {
    let temp = tempfile::tempdir_in(std::env::temp_dir().canonicalize().unwrap()).unwrap();
    let dir = TrustedDirectory::open(temp.path()).unwrap();
    let original = journal(&dir, 700);
    std::fs::write(temp.path().join("archives"), b"blocked").unwrap();
    assert!(compact(
        &dir,
        "turn-journal.jsonl",
        500,
        &Cancel::never(),
        &|| Ok(())
    )
    .is_err());
    assert_eq!(
        std::fs::read(temp.path().join("turn-journal.jsonl")).unwrap(),
        original
    );
}

#[test]
fn interrupted_publication_reuses_archive_without_duplicating_records() {
    let temp = tempfile::tempdir_in(std::env::temp_dir().canonicalize().unwrap()).unwrap();
    let dir = TrustedDirectory::open(temp.path()).unwrap();
    let original = journal(&dir, 700);
    let stopped = Cell::new(false);
    let check = || {
        if temp.path().join("archives").is_dir()
            && std::fs::read_dir(temp.path().join("archives"))
                .unwrap()
                .any(|entry| {
                    entry
                        .unwrap()
                        .file_name()
                        .to_string_lossy()
                        .ends_with(".gz")
                })
        {
            stopped.set(true);
            return Err(StoreError::Unavailable.into());
        }
        Ok(())
    };
    assert!(compact(&dir, "turn-journal.jsonl", 500, &Cancel::never(), &check).is_err());
    assert!(stopped.get());
    assert_eq!(
        std::fs::read(temp.path().join("turn-journal.jsonl")).unwrap(),
        original
    );
    compact(
        &dir,
        "turn-journal.jsonl",
        500,
        &Cancel::never(),
        &|| Ok(()),
    )
    .unwrap();
    assert_eq!(
        std::fs::read_dir(temp.path().join("archives"))
            .unwrap()
            .count(),
        1
    );
}

#[test]
fn identical_byte_source_replacement_and_archive_corruption_refuse_truncation() {
    for replace_source in [true, false] {
        let temp = tempfile::tempdir_in(std::env::temp_dir().canonicalize().unwrap()).unwrap();
        let dir = TrustedDirectory::open(temp.path()).unwrap();
        let original = journal(&dir, 700);
        let changed = Cell::new(false);
        let check = || {
            if !changed.get() {
                if let Ok(entries) = std::fs::read_dir(temp.path().join("archives")) {
                    for entry in entries {
                        let entry = entry.unwrap();
                        if !entry.file_name().to_string_lossy().ends_with(".gz") {
                            continue;
                        }
                        changed.set(true);
                        if replace_source {
                            std::fs::rename(
                                temp.path().join("turn-journal.jsonl"),
                                temp.path().join("original-held.jsonl"),
                            )
                            .unwrap();
                            std::fs::write(temp.path().join("turn-journal.jsonl"), &original)
                                .unwrap();
                        } else {
                            std::fs::write(entry.path(), b"corrupt archive").unwrap();
                        }
                    }
                }
            }
            Ok(())
        };
        assert!(compact(&dir, "turn-journal.jsonl", 500, &Cancel::never(), &check).is_err());
        assert!(changed.get());
        assert_eq!(
            std::fs::read(temp.path().join("turn-journal.jsonl")).unwrap(),
            original
        );
    }
}

#[test]
fn identical_prefix_in_a_new_live_generation_is_a_distinct_archive_occurrence() {
    let temp = tempfile::tempdir_in(std::env::temp_dir().canonicalize().unwrap()).unwrap();
    let dir = TrustedDirectory::open(temp.path()).unwrap();
    for _ in 0..2 {
        journal(&dir, 700);
        compact(
            &dir,
            "turn-journal.jsonl",
            500,
            &Cancel::never(),
            &|| Ok(()),
        )
        .unwrap();
    }
    assert_eq!(
        std::fs::read_dir(temp.path().join("archives"))
            .unwrap()
            .count(),
        2
    );
}

#[test]
fn source_changed_after_admission_is_not_adopted_as_an_authorized_archive() {
    let temp = tempfile::tempdir_in(std::env::temp_dir().canonicalize().unwrap()).unwrap();
    let dir = TrustedDirectory::open(temp.path()).unwrap();
    let original = journal(&dir, 700);
    let changed = Cell::new(false);
    let replacement = std::str::from_utf8(&original)
        .unwrap()
        .replace("turn-0", "foreign-0");
    let check = || {
        if !changed.replace(true) {
            std::fs::write(temp.path().join("turn-journal.jsonl"), &replacement).unwrap();
        }
        Ok(())
    };
    assert!(compact(&dir, "turn-journal.jsonl", 500, &Cancel::never(), &check).is_err());
    assert_eq!(
        std::fs::read_to_string(temp.path().join("turn-journal.jsonl")).unwrap(),
        replacement
    );
    assert!(!temp.path().join("archives").exists());
}
