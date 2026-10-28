//! Trusted store paths and Node schema-marker placement.
#![allow(clippy::unwrap_used, clippy::expect_used)]
use plur1bus_engine::contract::StoreError;
use plur1bus_engine::store::paths::{assert_trusted_path, namespace_path, secure_dir, secure_file};
use plur1bus_engine::store::schema_version::{
    initialize_base, read, read_base, StoreSchemaVersion,
};
use std::path::PathBuf;
struct Scratch {
    _guard: tempfile::TempDir,
    path: PathBuf,
}
fn scratch() -> Scratch {
    let guard = tempfile::tempdir().unwrap();
    let path = guard.path().canonicalize().unwrap();
    Scratch {
        _guard: guard,
        path,
    }
}
#[test]
fn inspecting_a_missing_store_path_does_not_create_it() {
    let root = scratch();
    let path = root.path.join("base/agent");
    assert_trusted_path(&path).unwrap();
    assert!(!path.exists());
}
#[cfg(windows)]
#[test]
fn canonical_windows_paths_are_checked_from_the_filesystem_root() {
    use std::path::{Component, Prefix};

    let root = scratch();
    assert!(matches!(
        root.path.components().next(),
        Some(Component::Prefix(prefix))
            if matches!(prefix.kind(), Prefix::VerbatimDisk(_) | Prefix::VerbatimUNC(_, _))
    ));
    let file = root.path.join("state.json");
    std::fs::write(&file, b"{}").unwrap();
    let missing = root.path.join("missing/agent");
    for path in [
        root.path.ancestors().last().unwrap(),
        root.path.as_path(),
        file.as_path(),
        missing.as_path(),
    ] {
        assert_trusted_path(path).unwrap();
    }
    assert!(!missing.exists());
    assert!(matches!(
        assert_trusted_path(&file.join("child")),
        Err(StoreError::UntrustedPath)
    ));
}
#[cfg(windows)]
#[test]
fn drive_relative_windows_paths_and_bare_volumes_are_refused() {
    for path in [r"C:", r"C:relative", r"\\?\C:"] {
        assert!(
            matches!(
                assert_trusted_path(std::path::Path::new(path)),
                Err(StoreError::InvalidInput)
            ),
            "accepted drive-relative path {path:?}"
        );
    }
}
#[test]
fn new_private_directories_and_files_use_the_shared_protection_rule() {
    let root = scratch();
    let path = root.path.join("base/agent");
    secure_dir(&path).unwrap();
    let file = path.join("state.json");
    std::fs::write(&file, b"{}").unwrap();
    secure_file(&file).unwrap();
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        assert_eq!(
            std::fs::metadata(&path).unwrap().permissions().mode() & 0o777,
            0o700
        );
        assert_eq!(
            std::fs::metadata(&file).unwrap().permissions().mode() & 0o777,
            0o600
        );
    }
}
#[cfg(unix)]
#[test]
fn a_symlinked_store_directory_and_a_symlinked_ancestor_are_refused() {
    use std::os::unix::fs::symlink;
    let root = scratch();
    let target = root.path.join("real");
    secure_dir(&target).unwrap();
    let link = root.path.join("link");
    symlink(&target, &link).unwrap();
    for path in [link.clone(), link.join("child")] {
        assert!(matches!(
            assert_trusted_path(&path),
            Err(StoreError::UntrustedPath)
        ));
        assert!(matches!(secure_dir(&path), Err(StoreError::UntrustedPath)));
    }
    assert!(!target.join("child").exists());
    let file = target.join("state.json");
    std::fs::write(&file, b"{}").unwrap();
    let alias = root.path.join("state.json");
    symlink(&file, &alias).unwrap();
    assert!(matches!(
        secure_file(&alias),
        Err(StoreError::UntrustedPath)
    ));
}
#[cfg(windows)]
#[test]
fn a_windows_junction_counts_as_an_unsafe_link() {
    let root = scratch();
    let target = root.path.join("real");
    secure_dir(&target).unwrap();
    let junction = root.path.join("junction");
    let output = std::process::Command::new("cmd.exe")
        .args(["/d", "/c", "mklink", "/J"])
        .arg(&junction)
        .arg(&target)
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    assert!(std::fs::symlink_metadata(&junction)
        .unwrap()
        .file_type()
        .is_symlink());
    assert!(matches!(
        assert_trusted_path(&junction.join("child")),
        Err(StoreError::UntrustedPath)
    ));
    std::fs::remove_dir(junction).unwrap();
}
#[cfg(unix)]
#[test]
fn a_group_writable_existing_store_directory_is_not_silently_repaired() {
    use std::os::unix::fs::PermissionsExt;
    let root = scratch();
    let path = root.path.join("store");
    secure_dir(&path).unwrap();
    std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o770)).unwrap();
    assert!(matches!(secure_dir(&path), Err(StoreError::UntrustedPath)));
    assert_eq!(
        std::fs::metadata(&path).unwrap().permissions().mode() & 0o777,
        0o770
    );
}
#[test]
fn schema_versions_read_the_node_base_marker_and_the_composite_fixture_marker() {
    let root = scratch();
    let base = root.path.join("base");
    secure_dir(&base.join("agent")).unwrap();
    std::fs::write(
        base.join("_schema.json"),
        br#"{"schemaVersion":"1","extra":"\ud83d"}"#,
    )
    .unwrap();
    assert_eq!(read(&base.join("agent")).unwrap(), StoreSchemaVersion::V1);
    std::fs::write(base.join("agent/_schema.json"), br#"{"schemaVersion":"0"}"#).unwrap();
    assert_eq!(
        read(&base.join("agent")).unwrap(),
        StoreSchemaVersion::Legacy0
    );
}
#[test]
fn missing_markers_are_legacy_and_bad_or_unknown_markers_are_errors() {
    let root = scratch();
    assert_eq!(read_base(&root.path).unwrap(), StoreSchemaVersion::Legacy0);
    for json in [
        r#"{"schemaVersion":1}"#,
        r#"{"schemaVersion":"2"}"#,
        r#"{"schemaVersion":"01"}"#,
        "[",
        r#"{"schemaVersion":"1","nested":[]}"#,
    ] {
        std::fs::write(root.path.join("_schema.json"), json).unwrap();
        let result = read_base(&root.path);
        if json.contains("nested") {
            assert_eq!(result.unwrap(), StoreSchemaVersion::V1);
        } else {
            assert!(matches!(result, Err(StoreError::Corrupt)));
        }
    }
}
#[test]
fn initializing_a_fresh_base_matches_node_and_preserves_nonempty_legacy_bases() {
    let root = scratch();
    let base = root.path.join("fresh");
    assert_eq!(
        initialize_base(&base, "2026-01-13T12:00:00.000Z", "fixture").unwrap(),
        StoreSchemaVersion::V1
    );
    assert_eq!(std::fs::read_to_string(base.join("_schema.json")).unwrap(),"{\n  \"schemaVersion\": \"1\",\n  \"writtenAt\": \"2026-01-13T12:00:00.000Z\",\n  \"engineVersion\": \"fixture\"\n}\n");
    let legacy = root.path.join("legacy");
    secure_dir(&legacy).unwrap();
    std::fs::write(legacy.join("existing"), b"data").unwrap();
    assert_eq!(
        initialize_base(&legacy, "later", "fixture").unwrap(),
        StoreSchemaVersion::Legacy0
    );
    assert!(!legacy.join("_schema.json").exists());
    let bytes = std::fs::read(base.join("_schema.json")).unwrap();
    initialize_base(&base, "later", "different").unwrap();
    assert_eq!(std::fs::read(base.join("_schema.json")).unwrap(), bytes);
}
#[test]
fn a_unique_orphan_marker_temp_file_does_not_turn_a_fresh_base_into_legacy() {
    let root = scratch();
    let base = root.path.join("base");
    secure_dir(&base).unwrap();
    std::fs::write(base.join("._schema.json.123.abcdef012345.tmp"), b"partial").unwrap();
    assert_eq!(
        initialize_base(&base, "time", "fixture").unwrap(),
        StoreSchemaVersion::V1
    );
}
#[test]
fn namespace_identifiers_use_the_node_ascii_pattern() {
    let root = scratch();
    for good in ["n", "namespace_2-x", "0", &"a".repeat(64)] {
        assert_eq!(
            namespace_path(&root.path, good).unwrap(),
            root.path.join(good)
        );
    }
    for bad in [
        "",
        ".",
        "..",
        "a/b",
        "a\\b",
        "-a",
        "_a",
        "ä",
        &"a".repeat(65),
    ] {
        assert!(matches!(
            namespace_path(&root.path, bad),
            Err(StoreError::InvalidInput)
        ));
    }
}
