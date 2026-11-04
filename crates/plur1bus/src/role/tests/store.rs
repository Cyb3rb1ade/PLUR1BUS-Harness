//! store cases for RS0.
use super::*;

// ----
// Store
// ----

#[test]
fn store_missing_file() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("role.json");
    let loaded = load(&path);
    assert!(matches!(loaded, Loaded::Missing));
    assert_eq!(writer_decision(&loaded), WriterDecision::Allowed);
}

#[test]
fn store_save_load_round_trip() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("state").join("role.json");
    let r = primary_rec();
    save(&path, &r).unwrap();
    match load(&path) {
        Loaded::Valid(back) => assert_eq!(back, r),
        other => panic!("{other:?}"),
    }
    let bytes = std::fs::read(&path).unwrap();
    assert_eq!(bytes.last(), Some(&b'\n'));
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mode = std::fs::metadata(&path).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode, 0o600);
    }
    let leftovers: Vec<_> = std::fs::read_dir(path.parent().unwrap())
        .unwrap()
        .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
        .filter(|n| n.contains(".tmp-"))
        .collect();
    assert!(leftovers.is_empty(), "{leftovers:?}");
    // Overwriting with the same record, and with a newer epoch in the same cluster, works.
    save(&path, &r).unwrap();
    let newer = with_epoch(r, 3);
    save(&path, &newer).unwrap();
    assert!(matches!(load(&path), Loaded::Valid(b) if b == newer));
}

#[test]
fn store_corrupt_is_never_overwritten() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("role.json");
    std::fs::write(&path, b"\x00\xffgarbage").unwrap();
    let loaded = load(&path);
    assert!(matches!(loaded, Loaded::Corrupt { .. }));
    assert_eq!(
        writer_decision(&loaded),
        WriterDecision::Denied {
            reason: "role-record-corrupt"
        }
    );
    let r = primary_rec();
    assert!(matches!(
        save(&path, &r),
        Err(RoleError::RecordCorrupt { .. })
    ));
    assert_eq!(std::fs::read(&path).unwrap(), b"\x00\xffgarbage");
}

#[test]
fn store_rejects_bad_files() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("role.json");
    let r = primary_rec();
    let good = serde_json::to_value(&r).unwrap();
    let write =
        |v: &serde_json::Value| std::fs::write(&path, serde_json::to_vec(v).unwrap()).unwrap();
    let is_corrupt = |path: &std::path::Path| matches!(load(path), Loaded::Corrupt { .. });

    // unknown field
    let mut v = good.clone();
    v["bogus"] = serde_json::json!(1);
    write(&v);
    assert!(is_corrupt(&path));
    // wrong schema
    let mut v = good.clone();
    v["schema"] = serde_json::json!("plur1bus.role/9");
    write(&v);
    assert!(is_corrupt(&path));
    // fails validate()
    let mut v = good.clone();
    v["epoch"] = serde_json::json!(0);
    write(&v);
    assert!(is_corrupt(&path));
    // not JSON object at all
    std::fs::write(&path, b"[]").unwrap();
    assert!(is_corrupt(&path));
    // invalid UTF-8
    std::fs::write(&path, [0xff, 0xfe, 0xfd]).unwrap();
    assert!(is_corrupt(&path));
    // too large
    let big = vec![b' '; (MAX_RECORD_BYTES + 1) as usize];
    std::fs::write(&path, &big).unwrap();
    assert!(is_corrupt(&path));
    // a directory
    let d = dir.path().join("as-dir");
    std::fs::create_dir(&d).unwrap();
    assert!(is_corrupt(&d));
    // the untouched record still loads
    write(&good);
    assert!(matches!(load(&path), Loaded::Valid(_)));
}

#[cfg(unix)]
#[test]
fn store_rejects_symlink() {
    let dir = tempfile::tempdir().unwrap();
    let real = dir.path().join("real.json");
    let link = dir.path().join("role.json");
    save(&real, &primary_rec()).unwrap();
    std::os::unix::fs::symlink(&real, &link).unwrap();
    assert!(matches!(load(&link), Loaded::Corrupt { .. }));
    assert!(matches!(
        save(&link, &primary_rec()),
        Err(RoleError::RecordCorrupt { .. })
    ));
}

#[test]
fn store_save_checks() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("role.json");
    // invalid record
    let mut bad = primary_rec();
    bad.epoch = 0;
    assert_eq!(save(&path, &bad), Err(invalid("epoch")));
    assert!(matches!(load(&path), Loaded::Missing));

    let r = with_epoch(primary_rec(), 4);
    save(&path, &r).unwrap();
    // epoch regression in the same cluster
    let mut lower = r.clone();
    lower.epoch = 3;
    lower.highest_seen_epoch = 4;
    assert_eq!(
        save(&path, &lower),
        Err(RoleError::StaleEpoch { got: 3, highest: 4 })
    );
    // highest-seen regression
    let mut lower_h = r.clone();
    lower_h.highest_seen_epoch = 4;
    let mut higher = r.clone();
    higher.highest_seen_epoch = 6;
    save(&path, &higher).unwrap();
    assert_eq!(
        save(&path, &lower_h),
        Err(RoleError::StaleEpoch { got: 4, highest: 6 })
    );
    // changed node id
    let mut other = higher.clone();
    other.node_id = id();
    assert_eq!(save(&path, &other), Err(invalid("nodeId")));
    // A stored clustered writer must first become a non-writer before switching cluster.
    let mut stopped = higher.clone();
    stopped.role = Role::Fenced;
    save(&path, &stopped).unwrap();
    let mut moved = higher.clone();
    moved.cluster_id = Some(id());
    moved.epoch = 1;
    moved.highest_seen_epoch = 1;
    save(&path, &moved).unwrap();
    // Leaving is a legal non-writer reset; a writer cannot silently become standalone.
    let mut client = moved.clone();
    client.role = Role::Client;
    client.primary = Some(node_ref(&id(), "new-primary"));
    save(&path, &client).unwrap();
    let mut stand = rec0("x");
    stand.node_id = moved.node_id.clone();
    stand.node_key_fingerprint = moved.node_key_fingerprint.clone();
    save(&path, &stand).unwrap();
    assert!(matches!(load(&path), Loaded::Valid(b) if b == stand));
    // and a cluster record after a standalone one
    save(&path, &moved).unwrap();
}
