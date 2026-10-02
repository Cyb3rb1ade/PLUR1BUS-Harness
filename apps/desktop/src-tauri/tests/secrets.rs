use plur1bus_desktop::secrets::*;
struct Denied;
impl TokenStore for Denied {
    fn get(&self, _: &str) -> Result<Option<SecretString>, TokenError> {
        Err(TokenError::AccessDenied)
    }
    fn set(&self, _: &str, _: &SecretString) -> Result<(), TokenError> {
        Err(TokenError::AccessDenied)
    }
    fn delete(&self, _: &str) -> Result<(), TokenError> {
        Err(TokenError::AccessDenied)
    }
    fn kind(&self) -> StoreKind {
        StoreKind::Keychain
    }
}
#[test]
fn secret_string_debug_and_display_are_redacted() {
    let value = SecretString::new(uuid::Uuid::now_v7().to_string());
    assert_eq!(format!("{value:?}"), "***");
    assert_eq!(format!("{value}"), "***");
    assert_eq!(token_hint(&SecretString::new("x".into())), "****");
}
#[test]
fn memory_store_round_trip_and_delete_missing_is_ok() {
    let store = MemoryStore::default();
    let secret = SecretString::new(uuid::Uuid::now_v7().to_string());
    store.set("test", &secret).unwrap();
    assert!(store.get("test").unwrap().unwrap().expose() == secret.expose());
    store.delete("test").unwrap();
    store.delete("test").unwrap();
    assert!(store.get("test").unwrap().is_none());
}
#[test]
fn access_denied_is_pairing_needed_not_a_crash() {
    assert!(load_token_or_pairing_needed(&Denied, uuid::Uuid::now_v7()).is_err());
}
#[test]
fn open_default_falls_back_to_memory_when_the_probe_fails() {
    assert_eq!(
        open_with_probe(Box::new(Denied)).kind(),
        StoreKind::MemoryOnly
    );
}
#[test]
#[ignore = "Explicit PLUR1BUS_DESKTOP_REAL_KEYCHAIN=1 opt-in required; user forbids running it in this task"]
fn real_keychain_round_trip() {
    assert_eq!(
        std::env::var("PLUR1BUS_DESKTOP_REAL_KEYCHAIN").as_deref(),
        Ok("1")
    );
    let store = KeyringStore::with_service(format!("app.plur1bus.test.{}", uuid::Uuid::now_v7()));
    let value = SecretString::new(uuid::Uuid::now_v7().to_string());
    store.set("roundtrip", &value).unwrap();
    let got = store.get("roundtrip");
    let removed = store.delete("roundtrip");
    assert!(removed.is_ok());
    assert!(got.unwrap().unwrap().expose() == value.expose());
}
#[test]
fn removing_with_unavailable_persistent_store_keeps_row_but_current_memory_credential_can_be_removed(
) {
    use plur1bus_desktop::{
        connections::{Connection, Kind, Origin, Store},
        pair::remove_connection,
    };
    let dir = tempfile::tempdir().unwrap();
    let store = Store::open(dir.path());
    let c = Connection::new(
        "Desk".into(),
        Kind::Remote,
        Origin::parse("https://harness.test").unwrap(),
        "installation".into(),
        "device".into(),
        "hint".into(),
    );
    store.upsert(c.clone()).unwrap();
    let memory = MemoryStore::default();
    assert!(remove_connection(&store, c.id, None, &Denied).is_err());
    assert!(remove_connection(&store, c.id, Some(&memory), &Denied).is_err());
    assert_eq!(store.load().unwrap().len(), 1);
    memory
        .set(
            &token_account(c.id),
            &SecretString::new(uuid::Uuid::now_v7().to_string()),
        )
        .unwrap();
    remove_connection(&store, c.id, Some(&memory), &Denied).unwrap();
    assert!(store.load().unwrap().is_empty());
    assert!(memory.get(&token_account(c.id)).unwrap().is_none());
}
