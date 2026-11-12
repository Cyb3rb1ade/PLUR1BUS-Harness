#![allow(clippy::unwrap_used, reason = "deterministic Node state fixtures")]
use super::*;
fn fixture() -> Json {
    parse_json(include_str!(
        "../../../tests/fixtures/ops/golden/reembedding-state.json"
    ))
    .unwrap()
}
fn array(v: &Json) -> &[Json] {
    let Json::Array(a) = v else {
        unreachable!("expected fixture array")
    };
    a
}
fn f<'a>(v: &'a Json, key: &str) -> &'a Json {
    field(v, key).unwrap()
}
fn s(v: &Json, key: &str) -> String {
    get_text(v, key).unwrap()
}
fn root() -> tempfile::TempDir {
    tempfile::tempdir_in(fs::canonicalize(std::env::temp_dir()).unwrap()).unwrap()
}
fn initial(root: &Path, case: &Json) {
    fs::create_dir_all(root.join("control")).unwrap();
    if let Some(v) = field(case, "raw") {
        fs::write(root.join("control").join(FILE), text(v).unwrap()).unwrap();
    } else if let Some(v) = field(case, "initial") {
        fs::write(
            root.join("control").join(FILE),
            write_json(&normalize(v, 0).unwrap()),
        )
        .unwrap();
    }
}
fn apply(store: &MigrationStateStore, op: &Json) -> Result<Json, StateError> {
    let now = field(op, "now").and_then(integer).unwrap_or(2000) as f64;
    let cancel = Cancel::never();
    match s(op, "op").as_str() {
        "create" => store.create(f(op, "input"), now, &cancel),
        "get" => Ok(store.get(&s(op, "id"))?.unwrap_or(Json::Null)),
        "list" => Ok(Json::Array(store.list()?)),
        "update" => store.update(&s(op, "id"), f(op, "options"), now, &cancel),
        "transition" => store.transition(
            &s(op, "id"),
            &s(op, "from"),
            &s(op, "to"),
            f(op, "options"),
            now,
            &cancel,
        ),
        _ => unreachable!("unknown fixture action"),
    }
}
#[test]
fn actual_node_state_cases_and_all_121_transition_pairs_match() {
    let fixture = fixture();
    let cases = array(f(&fixture, "cases"));
    assert_eq!(cases.len(), 164);
    for case in cases {
        let name = s(case, "name");
        let root = root();
        initial(root.path(), case);
        let store = MigrationStateStore::new(root.path()).unwrap();
        for (op, expected) in array(f(case, "ops")).iter().zip(array(f(case, "results"))) {
            let before = fs::read(&store.path).ok();
            let actual = apply(&store, op);
            if field(case, "rustException").is_some() {
                assert!(
                    matches!(actual, Err(StateError::RevisionOverflow)),
                    "{name}: {actual:?}"
                );
                assert_eq!(
                    fs::read(&store.path).ok(),
                    before,
                    "{name}: no poisoned state"
                );
                continue;
            }
            match actual {
                Ok(v) => assert_eq!(v, *f(expected, "value"), "{name}: value"),
                Err(e) => {
                    assert!(
                        field(expected, "error").is_some(),
                        "{name}: unexpected {e:?}"
                    );
                    let code = get_text(expected, "code").unwrap_or_else(|| "invalid".into());
                    assert_eq!(e.code(), code, "{name}");
                    if let StateError::Invalid(category) = e {
                        let msg = s(expected, "error");
                        assert!(
                            msg.starts_with(category)
                                || (category == "invalid migration confirmation"
                                    && msg == "invalid migration confirmation fields"),
                            "{name}: {msg} vs {category}"
                        );
                    }
                }
            }
            assert_eq!(
                fs::read_to_string(&store.path).ok(),
                get_text(expected, "file"),
                "{name}: exact durable bytes"
            );
        }
    }
}
fn candidate() -> Json {
    let fixture = fixture();
    let c = &array(f(&fixture, "cases"))[1];
    f(&array(f(c, "ops"))[0], "input").clone()
}
#[test]
fn cancellation_lease_and_readonly_absence_preserve_state() {
    let root = root();
    let absent = root.path().join("missing");
    let store = MigrationStateStore::new(&absent).unwrap();
    assert!(store.get("missing").unwrap().is_none());
    assert!(store.list().unwrap().is_empty());
    assert!(!absent.exists());
    let cancel = Cancel::never();
    cancel.cancel();
    assert!(matches!(
        store.create(&candidate(), 2000., &cancel),
        Err(StateError::Cancelled)
    ));
    assert!(!absent.exists());
    let lease = JobLock::acquire(
        &absent.join("control"),
        "reembedding-state",
        Duration::from_secs(30),
    )
    .unwrap();
    assert!(matches!(
        store.create(&candidate(), 2000., &Cancel::never()),
        Err(StateError::Busy)
    ));
    assert!(!store.path.exists());
    drop(lease);
    store.create(&candidate(), 2000., &Cancel::never()).unwrap();
    let bytes = fs::read(&store.path).unwrap();
    let reopened = MigrationStateStore::new(&absent).unwrap();
    assert_eq!(
        reopened.get("migration-a").unwrap(),
        store.get("migration-a").unwrap()
    );
    assert_eq!(fs::read(&store.path).unwrap(), bytes);
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        assert_eq!(
            fs::metadata(&store.path).unwrap().permissions().mode() & 0o777,
            0o600
        );
        assert_eq!(
            fs::metadata(absent.join("control"))
                .unwrap()
                .permissions()
                .mode()
                & 0o777,
            0o700
        );
    }
}
#[test]
fn concurrent_cas_commits_once_and_never_formats_current_record() {
    let root = root();
    let store = MigrationStateStore::new(root.path()).unwrap();
    store.create(&candidate(), 2000., &Cancel::never()).unwrap();
    let options =
        parse_json(r#"{"expectedRevision":1,"patch":{"cursor":{"private":"opaque-progress"}}}"#)
            .unwrap();
    std::thread::scope(|scope| {
        let handles = (0..8)
            .map(|_| scope.spawn(|| store.update("migration-a", &options, 3000., &Cancel::never())))
            .collect::<Vec<_>>();
        let mut success = 0;
        for h in handles {
            match h.join().unwrap() {
                Ok(_) => success += 1,
                Err(e) => {
                    assert!(matches!(e, StateError::Conflict { .. }));
                    assert!(!format!("{e:?} {e}").contains("opaque-progress"));
                }
            }
        }
        assert_eq!(success, 1);
    });
    assert_eq!(
        revision(&store.get("migration-a").unwrap().unwrap()).unwrap(),
        2
    );
}
#[test]
fn exact_numbers_duplicate_keys_and_numeric_property_order_survive_rewrite() {
    let v = parse_json(r#"{"b":-0,"10":10,"2":2,"b":1.0,"a":"\ud800"}"#).unwrap();
    assert_eq!(
        write_json(&normalize(&v, 0).unwrap()),
        r#"{"2":2,"10":10,"b":1,"a":"\ud800"}"#
    );
    for ms in [-8.64e15, 8.64e15, 0., -1.] {
        let mut input = candidate();
        put(&mut input, "confirmation", Json::Object(vec![])).unwrap();
        // Omit confirmation for clocks beyond its test TTL.
        let Json::Object(ref mut entries) = input else {
            unreachable!()
        };
        entries.retain(|(k, _)| *k != crate::text::js::JsString::from("confirmation"));
        let root = root();
        let store = MigrationStateStore::new(root.path()).unwrap();
        store.create(&input, ms, &Cancel::never()).unwrap();
        assert!(store.get("migration-a").unwrap().is_some());
    }
}
#[cfg(unix)]
#[test]
fn symlinks_special_files_and_oversized_state_fail_without_reading_targets() {
    use std::os::unix::{ffi::OsStrExt, fs::symlink};
    let root = root();
    let store = MigrationStateStore::new(root.path()).unwrap();
    fs::create_dir(root.path().join("control")).unwrap();
    let outside = root.path().join("outside");
    fs::write(&outside, b"untouched").unwrap();
    symlink(&outside, &store.path).unwrap();
    assert!(store.list().is_err());
    assert!(store.create(&candidate(), 2000., &Cancel::never()).is_err());
    assert_eq!(fs::read(&outside).unwrap(), b"untouched");
    fs::remove_file(&store.path).unwrap();
    let name = std::ffi::CString::new(store.path.as_os_str().as_bytes()).unwrap();
    // SAFETY: name is a live NUL-terminated path in the private test directory.
    assert_eq!(unsafe { libc::mkfifo(name.as_ptr(), 0o600) }, 0);
    assert!(store.list().is_err());
    fs::remove_file(&store.path).unwrap();
    fs::File::create(&store.path)
        .unwrap()
        .set_len(MAX_BYTES + 1)
        .unwrap();
    assert!(matches!(store.list(), Err(StateError::InvalidState)));
}
