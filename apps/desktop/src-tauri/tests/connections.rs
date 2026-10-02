use plur1bus_desktop::connections::{Connection, Kind, Origin, Store};
use plur1bus_desktop::secrets::{token_account, MemoryStore, SecretString, TokenStore};
use uuid::Uuid;
#[test]
fn origin_uses_shared_case_table() {
    let cases: serde_json::Value =
        serde_json::from_str(include_str!("fixtures/origin-cases.json")).unwrap();
    for case in cases.as_array().unwrap() {
        let got = Origin::parse(case["input"].as_str().unwrap())
            .ok()
            .map(|v| v.as_str().to_owned());
        assert_eq!(
            got.as_deref(),
            case["normalized"].as_str(),
            "{}",
            case["input"]
        );
    }
}
fn connection() -> Connection {
    Connection::new(
        "Desk".into(),
        Kind::Remote,
        Origin::parse("https://harness.test").unwrap(),
        "installation".into(),
        "device".into(),
        "hint".into(),
    )
}
#[test]
fn store_round_trips_and_writes_0600() {
    let dir = tempfile::tempdir().unwrap();
    let store = Store::open(dir.path());
    let c = connection();
    store.upsert(c.clone()).unwrap();
    store.set_active(c.id).unwrap();
    assert_eq!(store.load().unwrap(), vec![c.clone()]);
    assert_eq!(store.active().unwrap(), Some(c.id));
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        assert_eq!(
            std::fs::metadata(dir.path().join("connections.json"))
                .unwrap()
                .permissions()
                .mode()
                & 0o777,
            0o600
        );
    }
    let tokens = MemoryStore::default();
    tokens
        .set(
            &token_account(c.id),
            &SecretString::new(Uuid::now_v7().to_string()),
        )
        .unwrap();
    store.remove(c.id, &tokens).unwrap();
    assert!(store.load().unwrap().is_empty());
    assert!(tokens.get(&token_account(c.id)).unwrap().is_none());
}
#[test]
fn corrupt_and_unknown_files_are_kept_aside() {
    for data in ["broken","{\"version\":1,\"active\":null,\"uiLocale\":\"system\",\"connections\":[],\"token\":\"unexpected\"}"] {
 let dir=tempfile::tempdir().unwrap(); std::fs::write(dir.path().join("connections.json"),data).unwrap();
 assert!(Store::open(dir.path()).load().is_err());
 assert!(std::fs::read_dir(dir.path()).unwrap().any(|p|p.unwrap().file_name().to_string_lossy().contains(".corrupt-")));
 }
}
#[test]
fn cert_pin_round_trips_refuses_malformed_and_only_remote_https() {
    use plur1bus_desktop::connections::CertPin;
    let mut c = connection();
    c.cert_pin = Some(CertPin::of(&[1, 2, 3]));
    let dir = tempfile::tempdir().unwrap();
    let store = Store::open(dir.path());
    store.upsert(c.clone()).unwrap();
    assert_eq!(store.load().unwrap()[0].cert_pin, c.cert_pin);
    assert!(CertPin::parse("sha256:invalid").is_err());
    c.kind = Kind::Local;
    assert!(store.upsert(c).is_err());
}
#[test]
fn remove_keeps_the_row_when_token_delete_fails() {
    use plur1bus_desktop::secrets::{StoreKind, TokenError};
    struct Denied;
    impl TokenStore for Denied {
        fn get(&self, _: &str) -> Result<Option<SecretString>, TokenError> {
            Ok(None)
        }
        fn set(&self, _: &str, _: &SecretString) -> Result<(), TokenError> {
            Ok(())
        }
        fn delete(&self, _: &str) -> Result<(), TokenError> {
            Err(TokenError::AccessDenied)
        }
        fn kind(&self) -> StoreKind {
            StoreKind::Keychain
        }
    }
    let dir = tempfile::tempdir().unwrap();
    let store = Store::open(dir.path());
    let c = connection();
    store.upsert(c.clone()).unwrap();
    assert!(store.remove(c.id, &Denied).is_err());
    assert_eq!(store.load().unwrap(), vec![c]);
}
#[test]
fn store_round_trips_all_three_connection_kinds() {
    use plur1bus_desktop::connections::{BundledRef, RuntimeKind};
    let dir = tempfile::tempdir().unwrap();
    let store = Store::open(dir.path());
    for kind in [Kind::Bundled, Kind::Local, Kind::Remote] {
        let mut c = connection();
        c.kind = kind.clone();
        if kind == Kind::Bundled {
            c.bundled = Some(BundledRef {
                runtime: RuntimeKind::Docker,
                endpoint: "unix:///synthetic/docker.sock".into(),
                container: "p1t-synthetic-harness".into(),
                image_digest: "sha256:synthetic".into(),
            });
        }
        store.upsert(c).unwrap();
    }
    let rows = store.load().unwrap();
    assert_eq!(rows.len(), 3);
    assert_eq!(
        rows.iter().map(|c| c.kind.clone()).collect::<Vec<_>>(),
        vec![Kind::Bundled, Kind::Local, Kind::Remote]
    );
}
