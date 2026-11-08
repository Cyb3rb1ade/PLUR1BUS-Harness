//! Legacy-cache compatibility is exercised through the same archive reader and swap as the CLI.
use super::archive::{hash_file, verify, write_archive};
use super::create;
use super::manifest::FileEntry;
use super::restore::{restore, RestoreOpts};
use crate::paths::Layout;
use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};

fn legacy_archive(root: &Path) -> PathBuf {
    let layout = Layout::new(root.join("source"));
    let snap = create::testkit::staged(&layout, b"database", false);
    let original = root.join("original.tar.gz");
    create::create(&layout, &original, &snap).unwrap();
    let mut manifest = verify(&original).unwrap();
    let mut sources = HashMap::new();
    super::archive::visit(&original, &mut |f, r| {
        let path = root.join("payload").join(&f.path);
        fs::create_dir_all(path.parent().unwrap())?;
        let mut out = fs::File::create(&path)?;
        std::io::copy(r, &mut out)?;
        sources.insert(f.path.clone(), path);
        Ok(())
    })
    .unwrap();
    manifest.dirs.push("store/llm-result-cache-v1".into());
    manifest.dirs.push("store/llm-result-cache-v1/empty".into());
    for name in ["bernd.db", "bernd.db-wal", "bernd.db-shm"] {
        let relative = format!("store/llm-result-cache-v1/{name}");
        let path = root.join("payload").join(&relative);
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(&path, b"old derived response").unwrap();
        let (sha256, bytes) = hash_file(&path).unwrap();
        manifest.files.push(FileEntry {
            path: relative.clone(),
            bytes,
            sha256,
            mode: Some(0o666),
        });
        sources.insert(relative, path);
    }
    let archive = root.join("legacy.tar.gz");
    write_archive(&archive, &manifest, &sources).unwrap();
    verify(&archive).unwrap();
    archive
}

fn destination(root: &Path) -> Layout {
    let layout = Layout::new(root.join("destination"));
    let cache = layout.home.join("state/lancedb/llm-result-cache-v1");
    fs::create_dir_all(&cache).unwrap();
    fs::write(cache.join("current.db"), b"current derived response").unwrap();
    fs::write(layout.home.join("state/lancedb/t.lance"), b"live store").unwrap();
    layout
}

#[test]
fn legacy_archive_is_verified_but_restored_store_has_no_derived_cache() {
    let root = tempfile::tempdir().unwrap();
    let archive = legacy_archive(root.path());
    let layout = destination(root.path());
    let report = restore(
        &layout,
        &archive,
        &RestoreOpts {
            dry_run: false,
            fail_at: None,
        },
    )
    .unwrap();
    assert!(report.applied);
    assert!(!layout
        .home
        .join("state/lancedb/llm-result-cache-v1")
        .exists());
    assert_eq!(
        fs::read(layout.home.join("state/lancedb/t.lance")).unwrap(),
        b"store"
    );
    let pre = PathBuf::from(report.pre_restore.unwrap());
    assert_eq!(
        fs::read(pre.join("state/lancedb/llm-result-cache-v1/current.db")).unwrap(),
        b"current derived response"
    );
    assert!(layout.home.join(super::restore::REAPPLY_MARKER).exists());
}

#[test]
fn dry_run_and_failed_restore_preserve_current_cache() {
    let root = tempfile::tempdir().unwrap();
    let archive = legacy_archive(root.path());
    let layout = destination(root.path());
    for (dry_run, fail_at) in [
        (true, None),
        (false, Some("extract")),
        (false, Some("swap-after:0")),
    ] {
        let result = restore(
            &layout,
            &archive,
            &RestoreOpts {
                dry_run,
                fail_at: fail_at.map(str::to_owned),
            },
        );
        if dry_run {
            assert!(!result.unwrap().applied);
        } else {
            assert_eq!(result.unwrap_err().reason, "restore-failed");
        }
        assert_eq!(
            fs::read(
                layout
                    .home
                    .join("state/lancedb/llm-result-cache-v1/current.db")
            )
            .unwrap(),
            b"current derived response"
        );
        assert_eq!(
            fs::read(layout.home.join("state/lancedb/t.lance")).unwrap(),
            b"live store"
        );
    }
}

#[test]
fn discarded_legacy_cache_payload_still_must_pass_its_digest() {
    let root = tempfile::tempdir().unwrap();
    let archive = legacy_archive(root.path());
    // Change the plaintext tar entry while preserving a valid gzip and its original manifest.
    let decoder = flate2::read::GzDecoder::new(fs::File::open(&archive).unwrap());
    let mut input = tar::Archive::new(decoder);
    let tampered = root.path().join("tampered.tar.gz");
    let mut output = tar::Builder::new(flate2::write::GzEncoder::new(
        fs::File::create(&tampered).unwrap(),
        flate2::Compression::default(),
    ));
    for entry in input.entries().unwrap() {
        let mut entry = entry.unwrap();
        let mut header = entry.header().clone();
        if entry.path().unwrap() == Path::new("data/store/llm-result-cache-v1/bernd.db") {
            let bytes = vec![b'X'; header.size().unwrap() as usize];
            output.append(&header, bytes.as_slice()).unwrap();
        } else {
            header.set_cksum();
            output.append(&header, &mut entry).unwrap();
        }
    }
    output.into_inner().unwrap().finish().unwrap();
    assert_eq!(verify(&tampered).unwrap_err().reason, "checksum-mismatch");
    let layout = destination(root.path());
    assert_eq!(
        restore(
            &layout,
            &tampered,
            &RestoreOpts {
                dry_run: false,
                fail_at: None
            }
        )
        .unwrap_err()
        .reason,
        "checksum-mismatch"
    );
    assert_eq!(
        fs::read(
            layout
                .home
                .join("state/lancedb/llm-result-cache-v1/current.db")
        )
        .unwrap(),
        b"current derived response"
    );
    assert!(!layout.home.join("backups").exists());
}
