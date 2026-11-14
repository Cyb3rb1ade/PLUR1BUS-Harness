//! RE-D170 create facade: root binding, the pin's base rules, staging sweep, cancellation
//! and retention, against real files (the copier's own vectors live in its tests).
#![allow(clippy::unwrap_used, reason = "fixture errors are fatal")]
use super::*;
use std::cell::Cell;

fn temp() -> tempfile::TempDir {
    tempfile::tempdir_in(fs::canonicalize(std::env::temp_dir()).unwrap()).unwrap()
}

// Construct the spelling verbatim. On Windows, pushing onto a verbatim drive path
// normalizes parent components before the snapshot validator would receive them.
fn with_parent_component(root: &Path, suffix: &str) -> PathBuf {
    let mut raw = root.as_os_str().to_os_string();
    raw.push(std::path::MAIN_SEPARATOR.to_string());
    if cfg!(windows) {
        raw.push(suffix.replace('/', "\\"));
    } else {
        raw.push(suffix);
    }
    let path = PathBuf::from(raw);
    assert!(path.components().any(|part| part == Component::ParentDir));
    path
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
        label: None,
        now_ms: 1_767_268_800_123,
        free_bytes: None,
        progress: None,
        stopped: None,
    }
}

#[test]
fn label_uses_the_pins_ascii_snapshot_slug() {
    assert_eq!(slug_label(Some("..Ärger / 2026 --. ")), "Arger-2026");
    assert_eq!(slug_label(Some("🌱")), "snapshot");
    assert_eq!(slug_label(Some(&"a".repeat(50))).len(), 40);
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
        with_parent_component(&state, "memory/../backup-staging"),
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
        with_parent_component(&staging, &format!("../backup-staging/{name}")),
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
    // A close before the sweep removes nothing.
    let closed = || -> Result<(), SnapshotError> { Err(SnapshotError::Cancelled) };
    assert_eq!(
        sweep_stale_staging(&root, &closed),
        Err(SnapshotError::Cancelled)
    );
    assert!(root_path.join(format!("plur1bus-a.tmp-{gone}")).exists());
    let open = || -> Result<(), SnapshotError> { Ok(()) };
    sweep_stale_staging(&root, &open).unwrap();
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
    // A close during the prune stops it before the next removal: c went, b stays.
    let closes_after_c = || -> Result<(), SnapshotError> {
        if root_path.join("plur1bus-c").exists() {
            Ok(())
        } else {
            Err(SnapshotError::Cancelled)
        }
    };
    assert_eq!(
        prune(&root, 2, Some("plur1bus-a"), &closes_after_c),
        Err(SnapshotError::Cancelled)
    );
    assert!(root_path.join("plur1bus-b").exists());
    finished(&root_path, "plur1bus-c", "2026-01-03T00:00:00.000Z");
    let open = || -> Result<(), SnapshotError> { Ok(()) };
    assert_eq!(
        prune(&root, 2, Some("plur1bus-a"), &open).unwrap(),
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
    assert!(prune(&root, 0, None, &open).is_err());
    let cancelled = Cancel::never();
    cancelled.cancel();
    assert_eq!(
        prune(&root, 1, None, &|| check(&cancelled)),
        Err(SnapshotError::Cancelled)
    );
}

/// M1: a direct engine close (no connection cancel) after the copy starts neither the
/// manifest, the rename nor the prune; the staging directory is removed.
#[test]
fn an_engine_close_during_the_create_starts_no_further_step() {
    let temp = temp();
    let (state, base) = state(temp.path());
    let roots = SnapshotRoots::new(&state);
    let out = state.join("memory/.snapshots");
    // An older snapshot that a prune would otherwise have to consider.
    prepare(&roots, make_request(&state, &base, &out))
        .unwrap()
        .execute(&Cancel::never())
        .unwrap();
    let closed = Cell::new(false);
    let progress = |_: &str| {
        closed.set(true);
        Ok(())
    };
    let stopped = || closed.get();
    let mut request = make_request(&state, &base, &out);
    request.now_ms += 1_000;
    request.progress = Some(&progress);
    request.stopped = Some(&stopped);
    let plan = prepare(&roots, request).unwrap();
    assert_eq!(
        plan.execute(&Cancel::never()).unwrap_err(),
        SnapshotError::Cancelled
    );
    let left: Vec<_> = fs::read_dir(&out)
        .unwrap()
        .map(|e| e.unwrap().file_name().into_string().unwrap())
        .collect();
    assert_eq!(left, ["plur1bus-20260101T120000Z-snapshot"]);
    // Closed before the create began: nothing is created at all.
    let always = || true;
    let mut request = make_request(&state, &base, &out);
    request.now_ms += 2_000;
    request.stopped = Some(&always);
    assert_eq!(
        prepare(&roots, request)
            .unwrap()
            .execute(&Cancel::never())
            .unwrap_err(),
        SnapshotError::Cancelled
    );
    assert_eq!(fs::read_dir(&out).unwrap().count(), 1);
}

/// M5: the engine does not resolve the configured base (the pin does, with `resolve()`): the
/// manifest records the configured value, and a relative or `..` value is refused.
#[test]
fn a_relative_or_dotted_base_is_refused_and_the_manifest_records_the_configured_base() {
    let temp = temp();
    let (state, base) = state(temp.path());
    let roots = SnapshotRoots::new(&state);
    let out = state.join("backup-staging");
    for bad in [
        PathBuf::from("state/lancedb"),
        with_parent_component(&state, "memory/../lancedb"),
    ] {
        assert!(
            matches!(
                prepare(&roots, make_request(&state, &bad, &out)),
                Err(SnapshotError::UnsafePath)
            ),
            "{bad:?}"
        );
    }
    let report = prepare(&roots, make_request(&state, &base, &out))
        .unwrap()
        .execute(&Cancel::never())
        .unwrap();
    let manifest: serde_json::Value =
        serde_json::from_slice(&fs::read(report.dir.join(MANIFEST)).unwrap()).unwrap();
    assert_eq!(manifest["baseDbPath"], serde_json::json!(base));
}

/// U1: on a case-insensitive file system a base spelled into a root with other letter case is
/// the same directory and is refused through the physical comparison. On a case-sensitive
/// file system the differently spelled directory is a different one and stays allowed.
#[test]
fn a_base_inside_a_root_spelled_with_other_case_is_refused_where_the_names_alias() {
    let temp = temp();
    let state = temp.path().join("state");
    private(&state.join("backup-staging"));
    let base = state.join("Backup-Staging/store");
    let insensitive = fs::canonicalize(state.join("BACKUP-STAGING")).is_ok();
    private(&base);
    let roots = SnapshotRoots::new(&state);
    let result = roots.assert_safe_base(&state, &base);
    if insensitive {
        assert_eq!(result, Err(SnapshotError::UnsafePath));
    } else {
        assert_eq!(result, Ok(()));
    }
}

fn copy_tree(from: &Path, to: &Path) {
    private(to);
    for entry in fs::read_dir(from).unwrap() {
        let entry = entry.unwrap();
        let target = to.join(entry.file_name());
        if entry.file_type().unwrap().is_dir() {
            copy_tree(&entry.path(), &target);
        } else {
            fs::copy(entry.path(), &target).unwrap();
        }
    }
}

/// N2: an engine close right after the rename leaves the published snapshot valid and skips
/// the root fsync and the prune: six snapshots before the run, seven after, with the warning.
#[test]
fn an_engine_close_after_the_rename_keeps_the_snapshot_and_skips_fsync_and_prune() {
    let temp = temp();
    let (state, base) = state(temp.path());
    let roots = SnapshotRoots::new(&state);
    let out = state.join("memory/.snapshots");
    let mut first = None;
    for second in 0..5 {
        let mut request = make_request(&state, &base, &out);
        request.now_ms += second * 1_000;
        let report = prepare(&roots, request)
            .unwrap()
            .execute(&Cancel::never())
            .unwrap();
        assert!(report.pruned.is_empty());
        first.get_or_insert(report.dir);
    }
    // A sixth, older snapshot (a copy, so no prune ran to keep it).
    copy_tree(
        &first.unwrap(),
        &out.join("plur1bus-20260101T115959Z-snapshot"),
    );
    let count = || fs::read_dir(&out).unwrap().count();
    assert_eq!(count(), 6);

    let name = "plur1bus-20260101T120010Z-snapshot";
    let published = || out.join(name).exists();
    let mut request = make_request(&state, &base, &out);
    request.now_ms += 10_000;
    request.stopped = Some(&published);
    let plan = prepare(&roots, request).unwrap();
    assert_eq!(plan.id(), name);
    let report = plan.execute(&Cancel::never()).unwrap();
    assert_eq!(report.dir, out.join(name));
    assert!(report.pruned.is_empty());
    assert_eq!(
        report.warnings,
        ["fsync and pruning skipped after cancellation"]
    );
    assert_eq!(count(), 7, "no older snapshot was pruned");
    assert_eq!(
        crate::ops::snapshot::verify_snapshot(&report.dir)
            .unwrap()
            .files,
        3
    );
}
