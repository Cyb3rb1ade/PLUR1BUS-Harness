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
fn legacy_row_keeps_persistent_cleanup_obligation_even_with_memory_token() {
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
    assert!(remove_connection(&store, c.id, Some(&memory), &Denied).is_err());
    assert_eq!(store.load().unwrap().len(), 1);
}

#[derive(Default)]
struct Persistent {
    values: MemoryStore,
    denied: std::sync::atomic::AtomicBool,
    reads: std::sync::atomic::AtomicUsize,
}
impl TokenStore for Persistent {
    fn get(&self, account: &str) -> Result<Option<SecretString>, TokenError> {
        self.reads.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        if self.denied.load(std::sync::atomic::Ordering::SeqCst) {
            return Err(TokenError::AccessDenied);
        }
        self.values.get(account)
    }
    fn set(&self, account: &str, value: &SecretString) -> Result<(), TokenError> {
        if self.denied.load(std::sync::atomic::Ordering::SeqCst) {
            return Err(TokenError::AccessDenied);
        }
        self.values.set(account, value)
    }
    fn delete(&self, account: &str) -> Result<(), TokenError> {
        if self.denied.load(std::sync::atomic::Ordering::SeqCst) {
            return Err(TokenError::AccessDenied);
        }
        self.values.delete(account)
    }
    fn kind(&self) -> StoreKind {
        StoreKind::Keychain
    }
}
#[tokio::test]
async fn persistent_to_memory_repair_survives_restart_without_stale_token_and_honors_cleanup() {
    use plur1bus_desktop::{
        connections::{CredentialProvenance, Store},
        pair,
    };
    use plur1bus_mock_harness::{MockHarness, MockOptions};
    use std::sync::atomic::Ordering::SeqCst;
    let m = MockHarness::start(MockOptions::default()).await.unwrap();
    let dir = tempfile::tempdir().unwrap();
    let store = Store::open(dir.path());
    let persistent = Persistent::default();
    let code = m.control.create_pair_code();
    let old = pair::pair_code(&m.origin, &code, "Desk", &persistent, &store, None)
        .await
        .unwrap();
    let account = token_account(old.id);
    let old_token = persistent.get(&account).unwrap().unwrap();
    persistent.denied.store(true, SeqCst);
    let memory = MemoryStore::default();
    let code = m.control.create_pair_code();
    let row = pair::pair_code(&m.origin, &code, "Desk", &memory, &store, Some(old.id))
        .await
        .unwrap();
    assert_eq!(row.credential_provenance, CredentialProvenance::MemoryOnly);
    assert!(row.pending_keychain_cleanup);
    assert_ne!(row.device_id, old.device_id);
    assert!(pair::remove_connection(&store, row.id, Some(&memory), &persistent).is_err());
    assert!(store.load().unwrap()[0].pending_keychain_cleanup);
    assert!(memory.get(&account).unwrap().is_some());
    persistent.denied.store(false, SeqCst);
    let mut restarted = Store::open(dir.path()).load().unwrap().remove(0);
    let reads = persistent.reads.load(SeqCst);
    assert_eq!(
        pair::validate_connection(&mut restarted, &persistent, &store)
            .await
            .unwrap_err()
            .code(),
        "pairing-needed"
    );
    assert_eq!(persistent.reads.load(SeqCst), reads);
    assert!(persistent.get(&account).unwrap().unwrap().expose() == old_token.expose());
    let bytes = std::fs::read_to_string(dir.path().join("connections.json")).unwrap();
    assert!(!bytes.contains(old_token.expose()));
    assert!(!bytes.contains(memory.get(&account).unwrap().unwrap().expose()));
    // A new keychain pairing safely overwrites the old account and clears cleanup.
    let code = m.control.create_pair_code();
    let repaired = pair::pair_code(&m.origin, &code, "Desk", &persistent, &store, Some(row.id))
        .await
        .unwrap();
    assert_eq!(
        repaired.credential_provenance,
        CredentialProvenance::Keychain
    );
    assert!(!repaired.pending_keychain_cleanup);
    assert!(persistent.get(&account).unwrap().unwrap().expose() != old_token.expose());
    // Another fallback repair then removal must delete both backends.
    let code = m.control.create_pair_code();
    pair::pair_code(&m.origin, &code, "Desk", &memory, &store, Some(row.id))
        .await
        .unwrap();
    pair::remove_connection(&store, row.id, Some(&memory), &persistent).unwrap();
    assert!(persistent.get(&account).unwrap().is_none());
    assert!(memory.get(&account).unwrap().is_none());
    assert!(store.load().unwrap().is_empty());
}
#[tokio::test]
async fn new_memory_only_row_can_be_removed_after_restart_without_keychain() {
    use plur1bus_desktop::{connections::Store, pair};
    use plur1bus_mock_harness::{MockHarness, MockOptions};
    let m = MockHarness::start(MockOptions::default()).await.unwrap();
    let dir = tempfile::tempdir().unwrap();
    let store = Store::open(dir.path());
    let memory = MemoryStore::default();
    let code = m.control.create_pair_code();
    let row = pair::pair_code(&m.origin, &code, "Desk", &memory, &store, None)
        .await
        .unwrap();
    assert!(!row.pending_keychain_cleanup);
    drop(memory);
    pair::remove_connection(&store, row.id, None, &Denied).unwrap();
    assert!(store.load().unwrap().is_empty());
}
#[tokio::test]
async fn old_version_one_json_migrates_to_repair_without_loading_any_credential() {
    use plur1bus_desktop::{
        connections::{Connection, CredentialProvenance, Kind, Origin, Store},
        pair,
    };
    use std::sync::atomic::Ordering::SeqCst;
    let dir = tempfile::tempdir().unwrap();
    let c = Connection::new(
        "Legacy".into(),
        Kind::Remote,
        Origin::parse("https://harness.test").unwrap(),
        "installation".into(),
        "device".into(),
        "hint".into(),
    );
    let mut raw = serde_json::to_value(&c).unwrap();
    raw.as_object_mut().unwrap().remove("credentialProvenance");
    raw.as_object_mut()
        .unwrap()
        .remove("pendingKeychainCleanup");
    raw["pairingNeeded"] = false.into();
    std::fs::write(
        dir.path().join("connections.json"),
        serde_json::to_vec(
            &serde_json::json!({"version":1,"active":null,"uiLocale":"system","connections":[raw]}),
        )
        .unwrap(),
    )
    .unwrap();
    let store = Store::open(dir.path());
    let mut row = store.load().unwrap().remove(0);
    assert_eq!(row.credential_provenance, CredentialProvenance::Legacy);
    assert!(row.pairing_needed && row.pending_keychain_cleanup);
    let persistent = Persistent::default();
    persistent
        .set(
            &token_account(row.id),
            &SecretString::new(uuid::Uuid::now_v7().to_string()),
        )
        .unwrap();
    assert!(pair::validate_connection(&mut row, &persistent, &store)
        .await
        .is_err());
    assert_eq!(persistent.reads.load(SeqCst), 0);
    assert!(pair::remove_connection(&store, row.id, None, &Denied).is_err());
}
#[tokio::test]
async fn revoked_with_denied_delete_persists_repair_and_blocks_future_token_loading() {
    use plur1bus_desktop::{client::ClientError, connections::Store, pair};
    use plur1bus_mock_harness::{MockHarness, MockOptions};
    use std::sync::atomic::Ordering::SeqCst;
    let m = MockHarness::start(MockOptions::default()).await.unwrap();
    let dir = tempfile::tempdir().unwrap();
    let store = Store::open(dir.path());
    let persistent = Persistent::default();
    let code = m.control.create_pair_code();
    let mut row = pair::pair_code(&m.origin, &code, "Desk", &persistent, &store, None)
        .await
        .unwrap();
    persistent.denied.store(true, SeqCst);
    assert!(pair::mark_failure(&mut row, &ClientError::Revoked, &persistent, &store).is_err());
    let mut row = store.load().unwrap().remove(0);
    assert!(row.pairing_needed);
    persistent.denied.store(false, SeqCst);
    let reads = persistent.reads.load(SeqCst);
    assert!(pair::validate_connection(&mut row, &persistent, &store)
        .await
        .is_err());
    assert_eq!(persistent.reads.load(SeqCst), reads);
    pair::remove_connection(&store, row.id, None, &persistent).unwrap();
}

#[test]
fn scratch_memory_cleanup_backend_cannot_claim_persistent_deletion() {
    use plur1bus_desktop::{
        connections::{Connection, Kind, Origin, Store},
        pair,
    };
    let dir = tempfile::tempdir().unwrap();
    let store = Store::open(dir.path());
    let row = Connection::new(
        "Legacy".into(),
        Kind::Remote,
        Origin::parse("https://harness.test").unwrap(),
        "installation".into(),
        "device".into(),
        "hint".into(),
    );
    store.upsert(row.clone()).unwrap();
    // The debug scratch factory supplies this backend without constructing a keyring.
    assert!(pair::remove_connection(&store, row.id, None, &MemoryStore::default()).is_err());
    assert!(store.load().unwrap()[0].pending_keychain_cleanup);
}
