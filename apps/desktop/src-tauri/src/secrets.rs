//! Lazy OS credential access: listing connections never opens or probes a keychain.
use std::{collections::HashMap, fmt, sync::Mutex};
use uuid::Uuid;
use zeroize::Zeroizing;
pub struct SecretString(Zeroizing<String>);
impl SecretString {
    pub fn new(value: String) -> Self {
        Self(Zeroizing::new(value))
    }
    pub fn expose(&self) -> &str {
        &self.0
    }
}
impl fmt::Debug for SecretString {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("***")
    }
}
impl fmt::Display for SecretString {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("***")
    }
}
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum StoreKind {
    Keychain,
    MemoryOnly,
}
#[derive(Debug)]
pub enum TokenError {
    AccessDenied,
    Unavailable(String),
    Other(String),
}
#[derive(Debug)]
pub struct PairingNeeded;
pub trait TokenStore: Send + Sync {
    fn get(&self, account: &str) -> Result<Option<SecretString>, TokenError>;
    fn set(&self, account: &str, value: &SecretString) -> Result<(), TokenError>;
    fn delete(&self, account: &str) -> Result<(), TokenError>;
    fn kind(&self) -> StoreKind;
}
#[derive(Default)]
pub struct MemoryStore(Mutex<HashMap<String, SecretString>>);
impl TokenStore for MemoryStore {
    fn get(&self, a: &str) -> Result<Option<SecretString>, TokenError> {
        Ok(self
            .0
            .lock()
            .unwrap()
            .get(a)
            .map(|s| SecretString::new(s.expose().into())))
    }
    fn set(&self, a: &str, v: &SecretString) -> Result<(), TokenError> {
        self.0
            .lock()
            .unwrap()
            .insert(a.into(), SecretString::new(v.expose().into()));
        Ok(())
    }
    fn delete(&self, a: &str) -> Result<(), TokenError> {
        self.0.lock().unwrap().remove(a);
        Ok(())
    }
    fn kind(&self) -> StoreKind {
        StoreKind::MemoryOnly
    }
}
pub struct KeyringStore {
    service: String,
}
impl Default for KeyringStore {
    fn default() -> Self {
        Self {
            service: "app.plur1bus.desktop".into(),
        }
    }
}
impl KeyringStore {
    pub fn with_service(service: String) -> Self {
        Self { service }
    }
    fn entry(&self, a: &str) -> Result<keyring::Entry, TokenError> {
        keyring::Entry::new(&self.service, a).map_err(map_error)
    }
}
fn map_error(_: keyring::Error) -> TokenError {
    TokenError::AccessDenied
}
impl TokenStore for KeyringStore {
    fn get(&self, a: &str) -> Result<Option<SecretString>, TokenError> {
        match self.entry(a)?.get_password() {
            Ok(v) => Ok(Some(SecretString::new(v))),
            Err(keyring::Error::NoEntry) => Ok(None),
            Err(e) => Err(map_error(e)),
        }
    }
    fn set(&self, a: &str, v: &SecretString) -> Result<(), TokenError> {
        self.entry(a)?.set_password(v.expose()).map_err(map_error)
    }
    fn delete(&self, a: &str) -> Result<(), TokenError> {
        match self.entry(a)?.delete_credential() {
            Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
            Err(e) => Err(map_error(e)),
        }
    }
    fn kind(&self) -> StoreKind {
        StoreKind::Keychain
    }
}
/// Called only at an explicit pairing/authenticated action, never at startup.
pub fn open_default() -> Box<dyn TokenStore> {
    #[cfg(debug_assertions)]
    if std::env::var_os("PLUR1BUS_DESKTOP_CONFIG_DIR").is_some() {
        return Box::<MemoryStore>::default();
    }
    open_with_probe(Box::<KeyringStore>::default())
}
/// Deletion cannot fall back to memory: an inaccessible persisted credential
/// must keep its row. Constructing this store itself does not touch the OS.
pub fn open_for_removal() -> Box<dyn TokenStore> {
    #[cfg(debug_assertions)]
    if std::env::var_os("PLUR1BUS_DESKTOP_CONFIG_DIR").is_some() {
        return Box::<MemoryStore>::default();
    }
    Box::<KeyringStore>::default()
}
pub fn open_with_probe(store: Box<dyn TokenStore>) -> Box<dyn TokenStore> {
    let account = format!("probe-{}", Uuid::now_v7());
    let secret = SecretString::new(Uuid::now_v7().to_string());
    let result = store
        .set(&account, &secret)
        .and_then(|()| store.get(&account))
        .is_ok_and(|v| v.is_some_and(|v| v.expose() == secret.expose()));
    let removed = store.delete(&account).is_ok();
    if result && removed {
        store
    } else {
        Box::<MemoryStore>::default()
    }
}
pub fn token_account(id: Uuid) -> String {
    format!("device-{id}")
}
pub fn secret_store_account(id: &str) -> String {
    format!("secret-store-{id}")
}
pub fn token_hint(t: &SecretString) -> String {
    let chars: Vec<char> = t.expose().chars().collect();
    if chars.len() <= 4 {
        "****".into()
    } else {
        chars[chars.len() - 4..].iter().collect()
    }
}
pub fn load_token_or_pairing_needed(
    t: &dyn TokenStore,
    id: Uuid,
) -> Result<SecretString, PairingNeeded> {
    t.get(&token_account(id))
        .map_err(|_| PairingNeeded)?
        .ok_or(PairingNeeded)
}
