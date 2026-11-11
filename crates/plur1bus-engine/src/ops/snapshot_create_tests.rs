//! RE-D170 create facade: root binding, the pin's base rules, staging sweep, cancellation
//! and retention, against real files (the copier's own vectors live in its tests).
#![allow(clippy::unwrap_used, reason = "fixture errors are fatal")]
use super::*;
use std::cell::Cell;

fn temp() -> tempfile::TempDir {
    tempfile::tempdir_in(fs::canonicalize(std::env::temp_dir()).unwrap()).unwrap()
}

fn private(path: &Path) {
    crate::store::paths::secure_dir(path).unwrap();
}

/// A state directory with a plain (non-table) store and the pin's memory side files.
fn state(temp: &Path) -> (PathBuf, PathBuf) {
    let state = temp.join("state");
    let base = state.join("lancedb");
    private(&base.join("agent"));
    fs::write(base.join("agent/payload.bin"), vec![7_u8; 4096]).unwrap();
    private(&base.join("llm-result-cache-v1"));
    fs::write(
        base.join("llm-result-cache-v1/cache.db"),
        vec![1_u8; 1 << 20],
    )
    .unwrap();
    private(&state.join("memory/_archive"));
    fs::write(state.join("memory/_archive/a.jsonl"), b"{}\n").unwrap();
    fs::write(state.join("memory/merge-proposals.jsonl"), b"{}\n").unwrap();
    (state, base)
}

fn make_request<'a>(state: &'a Path, base: &'a Path, out: &'a Path) -> CreateRequest<'a> {
    CreateRequest {
        state_dir: state,
        base,
        out,
        now_ms: 1_767_268_800_123,
        free_bytes: None,
        progress: None,
    }
}

#[test]
fn staging_names_follow_the_pin_pattern() {
    assert_eq!(staging_pid("plur1bus-x.tmp-42"), Some(42));
    assert_eq!(
        staging_pid("plur1bus-20260101T000000Z-snapshot.tmp-7"),
        Some(7)
    );
    assert_eq!(staging_pid("plur1bus-x.tmp-99999999999"), Some(u32::MAX));
    for name in [
        "plur1bus-.tmp-1",
        "plur1bus-x.tmp-",
        "plur1bus-x.tmp-1a",
        "other-x.tmp-1",
        "plur1bus-x",
    ] {
        assert_eq!(staging_pid(name), None, "{name}");
    }
}

#[test]
fn roots_and_snapshot_dirs_are_bound_lexically_and_physically() {
    let temp = temp();
    let state = temp.path().join("state");
    private(&state);
    let roots = SnapshotRoots::new(&state);
    let [staging, engine] = roots.roots().clone();
    assert_eq!(roots.bind_root(&staging).unwrap(), staging);
    assert_eq!(roots.bind_root(&engine).unwrap(), engine);
    for out in [
        state.clone(),
        state.join("backup-staging/x"),
        state.join("memory/../backup-staging"),
        PathBuf::from("state/backup-staging"),
        temp.path().join("elsewhere"),
    ] {
        assert_eq!(
            roots.bind_root(&out),
            Err(SnapshotError::UnsafePath),
            "{out:?}"
        );
    }
    let name = "plur1bus-20260101T000000Z-snapshot";
    assert_eq!(
        roots.bind_snapshot(&staging.join(name)).unwrap(),
        staging.join(name)
    );
    for dir in [
        staging.clone(),
        staging.join(format!("{name}.tmp-12")),
        staging.join("snapshot"),
        staging.join(name).join("store"),
        temp.path().join(name),
        staging.join("..").join("backup-staging").join(name),
    ] {
        assert_eq!(
            roots.bind_snapshot(&dir),
            Err(SnapshotError::UnsafePath),
            "{dir:?}"
        );
    }
    #[cfg(unix)]
    {
        let elsewhere = temp.path().join("elsewhere");
        private(&elsewhere);
        std::os::unix::fs::symlink(&elsewhere, &staging).unwrap();
        assert_eq!(roots.bind_root(&staging), Err(SnapshotError::UnsafePath));
        assert_eq!(
            roots.bind_snapshot(&staging.join(name)),
            Err(SnapshotError::UnsafePath)
        );
    }
}

#[test]
fn the_pins_base_rules_apply_against_both_roots() {
    let temp = temp();
    let (state, base) = state(temp.path());
    let roots = SnapshotRoots::new(&state);
    assert!(roots.assert_safe_base(&state, &base).is_ok());
    for bad in [
        state.clone(),
        temp.path().to_owned(),
        state.join("backup-staging/store"),
        state.join("memory/.snapshots/store"),
        state.join("memory"),
    ] {
        assert_eq!(
            roots.assert_safe_base(&state, &bad),
            Err(SnapshotError::UnsafePath),
            "{bad:?}"
        );
    }
    // A missing store is not-found; nothing is created by preparing.
    let out = state.join("backup-staging");
    let missing = state.join("missing");
    assert!(matches!(
        prepare(&roots, make_request(&state, &missing, &out)),
        Err(SnapshotError::NotFound)
    ));
    assert!(!out.exists());
}

#[test]
fn create_publishes_once_and_names_collisions_as_the_pin() {
    let temp = temp();
    let (state, base) = state(temp.path());
    let roots = SnapshotRoots::new(&state);
    let out = state.join("memory/.snapshots");
    let first = prepare(&roots, make_request(&state, &base, &out)).unwrap();
    assert_eq!(first.id(), "plur1bus-20260101T120000Z-snapshot");
    assert!(!out.exists(), "prepare writes nothing");
    let cancel = Cancel::never();
    let report = first.execute(&cancel).unwrap();
    assert_eq!(report.dir, out.join("plur1bus-20260101T120000Z-snapshot"));
    let second = prepare(&roots, make_request(&state, &base, &out)).unwrap();
    assert_eq!(second.id(), "plur1bus-20260101T120000Z-snapshot-2");
    second.execute(&cancel).unwrap();
    let manifest: serde_json::Value =
        serde_json::from_slice(&fs::read(report.dir.join(MANIFEST)).unwrap()).unwrap();
    assert_eq!(manifest["createdAt"], "2026-01-01T12:00:00.123Z");
    assert_eq!(
        manifest["contents"],
        serde_json::json!(["store", "memory/_archive", "memory/merge-proposals.jsonl"])
    );
    // The cache is neither copied nor counted (RE-D41).
    assert_eq!(report.bytes, 4096 + 3 + 3);
    assert_eq!(report.files, 3);
    assert_eq!(
        crate::ops::snapshot::verify_snapshot(&report.dir)
            .unwrap()
            .files,
        3
    );
}

#[test]
fn a_cancellation_during_the_copy_leaves_no_staging_and_no_snapshot() {
    let temp = temp();
    let (state, base) = state(temp.path());
    let roots = SnapshotRoots::new(&state);
    let out = state.join("backup-staging");
    let cancel = Cancel::never();
    let seen = Cell::new(0);
    let progress = |_: &str| {
        seen.set(seen.get() + 1);
        cancel.cancel();
        Ok(())
    };
    let mut request = make_request(&state, &base, &out);
    request.progress = Some(&progress);
    let plan = prepare(&roots, request).unwrap();
    assert_eq!(plan.execute(&cancel).unwrap_err(), SnapshotError::Cancelled);
    assert_eq!(seen.get(), 1);
    assert_eq!(fs::read_dir(&out).unwrap().count(), 0);

    // A hook failure is the same: the staging directory goes with it.
    let failing = |_: &str| Err(SnapshotError::Storage);
    let mut request = make_request(&state, &base, &out);
    request.progress = Some(&failing);
    let plan = prepare(&roots, request).unwrap();
    assert_eq!(
        plan.execute(&Cancel::never()).unwrap_err(),
        SnapshotError::Storage
    );
    assert_eq!(fs::read_dir(&out).unwrap().count(), 0);
}

#[test]
fn insufficient_disk_refuses_before_any_staging() {
    let temp = temp();
    let (state, base) = state(temp.path());
    let roots = SnapshotRoots::new(&state);
    let out = state.join("backup-staging");
    let mut request = make_request(&state, &base, &out);
    // 1.1 × 4102 payload bytes does not fit in 4102; the 1 MiB cache does not count.
    request.free_bytes = Some(4102);
    let plan = prepare(&roots, request).unwrap();
    assert_eq!(
        plan.execute(&Cancel::never()).unwrap_err(),
        SnapshotError::InsufficientDisk
    );
    assert_eq!(fs::read_dir(&out).unwrap().count(), 0);
    let mut request = make_request(&state, &base, &out);
    request.free_bytes = Some(4513);
    prepare(&roots, request)
        .unwrap()
        .execute(&Cancel::never())
        .unwrap();
    assert!(free_bytes(&out).unwrap() > 0);
}

#[test]
fn only_staging_of_a_gone_process_is_swept() {
    let temp = temp();
    let root_path = temp.path().join("root");
    private(&root_path);
    let root = TrustedDirectory::open(&root_path).unwrap();
    let mut child = std::process::Command::new(std::env::current_exe().unwrap())
        .arg("--list")
        .stdout(std::process::Stdio::null())
        .spawn()
        .unwrap();
    let gone = child.id();
    child.wait().unwrap();
    let own = std::process::id();
    let names = [
        format!("plur1bus-a.tmp-{gone}"),
        format!("plur1bus-b.tmp-{own}"),
        "plur1bus-c".to_owned(),
        "unrelated.tmp-1".to_owned(),
    ];
    for name in &names {
        private(&root_path.join(name));
    }
    // A file with a staging name is never removed.
    fs::write(root_path.join(format!("plur1bus-d.tmp-{gone}")), b"").unwrap();
    sweep_stale_staging(&root, &Cancel::never()).unwrap();
    let mut left: Vec<_> = fs::read_dir(&root_path)
        .unwrap()
        .map(|e| e.unwrap().file_name().into_string().unwrap())
        .collect();
    left.sort();
    let mut expected = vec![
        format!("plur1bus-b.tmp-{own}"),
        "plur1bus-c".to_owned(),
        format!("plur1bus-d.tmp-{gone}"),
        "unrelated.tmp-1".to_owned(),
    ];
    expected.sort();
    assert_eq!(left, expected);
}

fn finished(root: &Path, name: &str, created_at: &str) {
    private(&root.join(name));
    fs::write(
        root.join(name).join(MANIFEST),
        serde_json::json!({"schema":SNAPSHOT_SCHEMA,"createdAt":created_at}).to_string(),
    )
    .unwrap();
}

#[test]
fn prune_keeps_the_newest_and_the_protected_snapshot_only() {
    let temp = temp();
    let root_path = temp.path().join("root");
    private(&root_path);
    for (index, name) in ["plur1bus-a", "plur1bus-b", "plur1bus-c", "plur1bus-d"]
        .iter()
        .enumerate()
    {
        finished(
            &root_path,
            name,
            &format!("2026-01-0{}T00:00:00.000Z", index + 1),
        );
    }
    // Same time: the larger id is newer (pin order).
    finished(&root_path, "plur1bus-e2", "2026-01-04T00:00:00.000Z");
    // Never candidates: another schema, no manifest, a staging name, a file.
    private(&root_path.join("plur1bus-other"));
    fs::write(
        root_path.join("plur1bus-other").join(MANIFEST),
        b"{\"schema\":\"x\"}",
    )
    .unwrap();
    private(&root_path.join("plur1bus-empty"));
    finished(&root_path, "plur1bus-z.tmp-1", "1999-01-01T00:00:00.000Z");
    fs::write(root_path.join("plur1bus-file"), b"").unwrap();
    let root = TrustedDirectory::open(&root_path).unwrap();
    let cancel = Cancel::never();
    assert_eq!(
        prune(&root, 2, Some("plur1bus-a"), &cancel).unwrap(),
        vec!["plur1bus-c".to_owned(), "plur1bus-b".to_owned()]
    );
    let mut left: Vec<_> = fs::read_dir(&root_path)
        .unwrap()
        .map(|e| e.unwrap().file_name().into_string().unwrap())
        .collect();
    left.sort();
    assert_eq!(
        left,
        [
            "plur1bus-a",
            "plur1bus-d",
            "plur1bus-e2",
            "plur1bus-empty",
            "plur1bus-file",
            "plur1bus-other",
            "plur1bus-z.tmp-1"
        ]
    );
    assert!(prune(&root, 0, None, &cancel).is_err());
    let cancelled = Cancel::never();
    cancelled.cancel();
    assert_eq!(
        prune(&root, 1, None, &cancelled),
        Err(SnapshotError::Cancelled)
    );
}
