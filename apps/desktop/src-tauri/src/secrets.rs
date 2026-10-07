//! Lazy OS credential access: listing connections never opens or probes a keychain.
use std::{collections::HashMap, fmt, sync::Mutex};
use uuid::Uuid;
use zeroize::Zeroizing;
pub struct SecretString(Zeroizing<String>);
impl SecretString {
    pub fn new(value: String) -> Self {
        crate::logging::SecretRegistry::process().register_sensitive(&value);
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
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum TokenError {
    NotFound,
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
pub fn map_error(error: keyring::Error) -> TokenError {
    match error {
        keyring::Error::NoEntry => TokenError::NotFound,
        keyring::Error::NoStorageAccess(ref cause) | keyring::Error::PlatformFailure(ref cause)
            if permission_denied(cause.as_ref()) =>
        {
            TokenError::AccessDenied
        }
        keyring::Error::NoStorageAccess(_) | keyring::Error::NoDefaultStore => {
            TokenError::Unavailable("Credential storage is unavailable or locked".into())
        }
        keyring::Error::PlatformFailure(_) => {
            TokenError::Unavailable("The operating system credential service failed".into())
        }
        _ => TokenError::Other("Credential storage returned an unsupported response".into()),
    }
}
fn permission_denied(error: &(dyn std::error::Error + Send + Sync + 'static)) -> bool {
    if error
        .downcast_ref::<std::io::Error>()
        .is_some_and(|e| e.kind() == std::io::ErrorKind::PermissionDenied)
    {
        return true;
    }
    #[cfg(target_os = "macos")]
    if let Some(error) = error.downcast_ref::<security_framework::base::Error>() {
        // errSecUserCanceled, errSecAuthFailed, errSecInteractionNotAllowed,
        // permission denied, errSecInvalidOwnerEdit. Never parse OS error text.
        return matches!(error.code(), -128 | -25293 | -25308 | -61 | -25244);
    }
    false
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
    if let Some(store) = debug_store() {
        return store;
    }
    open_for_platform(Box::<KeyringStore>::default(), cfg!(target_os = "linux"))
}
/// Deletion never falls back to memory for an inaccessible persisted credential.
pub fn open_for_removal() -> Box<dyn TokenStore> {
    #[cfg(debug_assertions)]
    if let Some(store) = debug_store() {
        return store;
    }
    Box::<KeyringStore>::default()
}
#[cfg(debug_assertions)]
fn debug_store() -> Option<Box<dyn TokenStore>> {
    let real = std::env::var("PLUR1BUS_DESKTOP_REAL_KEYCHAIN").as_deref() == Ok("1");
    let dir = std::env::var_os("PLUR1BUS_DESKTOP_CONFIG_DIR").map(std::path::PathBuf::from);
    if select_debug_backend(real, dir.is_some()) == DebugBackend::TestKeychain {
        return Some(match dir.as_deref().map(DebugKeychainProfile::open) {
            Some(Ok(profile)) => Box::new(profile.wrap(Box::new(KeyringStore::with_service(
                profile.service.clone(),
            )))),
            _ => Box::new(UnavailableStore),
        });
    }
    if select_debug_backend(real, dir.is_some()) == DebugBackend::Refused {
        return Some(Box::new(UnavailableStore));
    }
    dir.map(|_| Box::<MemoryStore>::default() as Box<dyn TokenStore>)
}
#[cfg(debug_assertions)]
#[derive(Debug, PartialEq, Eq)]
pub enum DebugBackend {
    Production,
    Memory,
    TestKeychain,
    Refused,
}
#[cfg(debug_assertions)]
pub fn select_debug_backend(real: bool, scratch: bool) -> DebugBackend {
    match (real, scratch) {
        (true, true) => DebugBackend::TestKeychain,
        (true, false) => DebugBackend::Refused,
        (false, true) => DebugBackend::Memory,
        (false, false) => DebugBackend::Production,
    }
}
#[cfg(debug_assertions)]
struct UnavailableStore;
#[cfg(debug_assertions)]
impl TokenStore for UnavailableStore {
    fn get(&self, _: &str) -> Result<Option<SecretString>, TokenError> {
        Err(TokenError::Unavailable(
            "Real keychain testing requires a writable scratch profile".into(),
        ))
    }
    fn set(&self, _: &str, _: &SecretString) -> Result<(), TokenError> {
        Err(TokenError::Unavailable(
            "Real keychain testing requires a writable scratch profile".into(),
        ))
    }
    fn delete(&self, _: &str) -> Result<(), TokenError> {
        Err(TokenError::Unavailable(
            "Real keychain testing requires a writable scratch profile".into(),
        ))
    }
    fn kind(&self) -> StoreKind {
        StoreKind::Keychain
    }
}
/// Public metadata only; no credential bytes. Explicit cleanup, not Drop, permits
/// pair -> restart -> open checks using the same random isolated service.
#[cfg(debug_assertions)]
#[derive(Clone)]
pub struct DebugKeychainProfile {
    pub service: String,
    ledger: std::path::PathBuf,
}
#[cfg(debug_assertions)]
impl DebugKeychainProfile {
    pub fn open(dir: &std::path::Path) -> Result<Self, TokenError> {
        use std::io::Write;
        std::fs::create_dir_all(dir)
            .map_err(|_| TokenError::Unavailable("Scratch profile unavailable".into()))?;
        let path = dir.join("test-keychain-service");
        let service = match std::fs::read_to_string(&path) {
            Ok(value) => value,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
                let value = format!("app.plur1bus.test.{}", Uuid::now_v7());
                let mut file = std::fs::OpenOptions::new()
                    .write(true)
                    .create_new(true)
                    .open(&path)
                    .map_err(|_| TokenError::Unavailable("Scratch service unavailable".into()))?;
                file.write_all(value.as_bytes())
                    .map_err(|_| TokenError::Unavailable("Scratch service unavailable".into()))?;
                value
            }
            Err(_) => {
                return Err(TokenError::Unavailable(
                    "Scratch service unavailable".into(),
                ))
            }
        };
        let valid = service
            .strip_prefix("app.plur1bus.test.")
            .and_then(|id| Uuid::parse_str(id).ok())
            .is_some();
        if !valid {
            return Err(TokenError::Other("Invalid scratch service".into()));
        }
        Ok(Self {
            service,
            ledger: dir.join("test-keychain-accounts.json"),
        })
    }
    pub fn wrap(&self, backend: Box<dyn TokenStore>) -> DebugTokenStore {
        DebugTokenStore {
            profile: self.clone(),
            backend,
            lock: Mutex::new(()),
        }
    }
    fn accounts(&self) -> Result<Vec<String>, TokenError> {
        match std::fs::read(&self.ledger) {
            Ok(bytes) => serde_json::from_slice(&bytes)
                .map_err(|_| TokenError::Other("Invalid scratch account ledger".into())),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(vec![]),
            Err(_) => Err(TokenError::Unavailable(
                "Scratch account ledger unavailable".into(),
            )),
        }
    }
    fn save(&self, accounts: &[String]) -> Result<(), TokenError> {
        std::fs::write(&self.ledger, serde_json::to_vec(accounts).unwrap())
            .map_err(|_| TokenError::Unavailable("Scratch account ledger unavailable".into()))
    }
    pub fn cleanup(&self, backend: &dyn TokenStore) -> Result<(), TokenError> {
        for account in self.accounts()? {
            backend.delete(&account)?;
        }
        self.save(&[])
    }
}
#[cfg(debug_assertions)]
pub struct DebugTokenStore {
    profile: DebugKeychainProfile,
    backend: Box<dyn TokenStore>,
    lock: Mutex<()>,
}
#[cfg(debug_assertions)]
impl TokenStore for DebugTokenStore {
    fn get(&self, a: &str) -> Result<Option<SecretString>, TokenError> {
        self.backend.get(a)
    }
    fn set(&self, a: &str, v: &SecretString) -> Result<(), TokenError> {
        let _guard = self.lock.lock().unwrap();
        let mut accounts = self.profile.accounts()?;
        if !accounts.iter().any(|account| account == a) {
            accounts.push(a.into());
            self.profile.save(&accounts)?;
        }
        self.backend.set(a, v)
    }
    fn delete(&self, a: &str) -> Result<(), TokenError> {
        let _guard = self.lock.lock().unwrap();
        self.backend.delete(a)?;
        let mut accounts = self.profile.accounts()?;
        accounts.retain(|account| account != a);
        self.profile.save(&accounts)
    }
    fn kind(&self) -> StoreKind {
        self.backend.kind()
    }
}
/// Explicit manual cleanup hook; never used by default tests or CI.
#[cfg(debug_assertions)]
pub fn cleanup_debug_keychain(dir: &std::path::Path) -> Result<(), TokenError> {
    if std::env::var("PLUR1BUS_DESKTOP_REAL_KEYCHAIN").as_deref() != Ok("1") {
        return Err(TokenError::AccessDenied);
    }
    let profile = DebugKeychainProfile::open(dir)?;
    profile.cleanup(&KeyringStore::with_service(profile.service.clone()))
}
pub fn open_for_platform(store: Box<dyn TokenStore>, linux: bool) -> Box<dyn TokenStore> {
    if linux {
        open_with_probe(store)
    } else {
        store
    }
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
