//! The operating system's keyring behind [`Keyring`] (P4-20 PR 2b).
//!
//! **The same items as the TypeScript core.** `@napi-rs/keyring` 2.1.0, which `secrets/keyring-backend.ts` uses, is
//! `keyring-core` with one store crate per operating system. This module uses the same crates in the same way (a store
//! in its default configuration, an entry for a service and an account, no modifiers), so both implementations read and
//! write one set of items:
//!
//! | System | Store | An item |
//! |---|---|---|
//! | macOS | `apple-native-keyring-store`, `keychain` | a generic password of the login keychain, with service and account |
//! | Windows | `windows-native-keyring-store` | a generic credential named `<account>.<service>`, the value as UTF-16 |
//! | Linux | `zbus-secret-service-keyring-store` | an item of the Secret Service's default collection with the attributes `service` and `username` |
//! | elsewhere | none | every entry is refused |
//!
//! **Linux has the Secret Service and nothing else.** Left to itself `@napi-rs/keyring` falls back to the kernel
//! keyring when no Secret Service answers: values in memory that are gone after a reboot, behind a keyring that reports
//! itself as available (P4D-34; the TypeScript side pins its entries to the Secret Service since D136). There is no
//! store for the kernel keyring among this crate's dependencies, so the same cannot happen here; without a Secret
//! Service the entry is refused and the backend answers `backend-unavailable`.
//!
//! **A store per entry.** Nothing is kept between two entries: a Secret Service that was not there for the first one is
//! found by the next. On Linux that is a connection to the session bus and a key exchange per entry.
//!
//! **A keyring that does not answer.** The Secret Service client has no timeout of its own, and a locked collection
//! waits for its prompt. The adapters run in the helper process only, whose caller gives every operation a budget and
//! kills the helper when it runs out (`isolated`); nothing in the core's own process ever waits for a keyring.
//!
//! **What a failure carries.** [`FAILURE_CODE`] and nothing else. The platform's error has text of the platform in it,
//! and for a value that could not be decoded the bytes that were read; it is dropped here, unread and unformatted.
//!
//! **Tests never reach a keyring.** [`keyring_for`] is the TypeScript core's test seam (`keyringLoaderFor` of
//! `secrets/runtime.ts`): `PLUR1BUS_SECRETS_KEYRING=off` is a keyring that is not there, `=memory` one that lives in
//! the process, both only with `PLUR1BUS_ALLOW_TEST_INTERNALS=1`. The adapters themselves are exercised by the keyring
//! probe (`tests/keyring_probe.rs`), which does nothing unless it is asked to and is asked to in CI only.
use super::keyring_backend::{Keyring, KeyringEntry, KeyringFailure};
use std::collections::HashMap;
use std::sync::{Mutex, PoisonError};

/// The variable of the test seam.
pub const SEAM_VARIABLE: &str = "PLUR1BUS_SECRETS_KEYRING";
/// The variable that allows test seams.
pub const ALLOW_VARIABLE: &str = "PLUR1BUS_ALLOW_TEST_INTERNALS";

/// The code of every failure of the platform layer: what `@napi-rs/keyring` throws carries this `code` whatever went
/// wrong, and the keyring backend puts the code into its message.
pub const FAILURE_CODE: &str = "GenericFailure";

/// A keyring that is not there.
pub struct NoKeyring;

impl Keyring for NoKeyring {
    fn entry(
        &self,
        _service: &str,
        _account: &str,
    ) -> Result<Box<dyn KeyringEntry>, KeyringFailure> {
        Err(KeyringFailure::default())
    }
}

/// The values of the keyring that lives in the process (`memoryKeyringModule`): `(service, account)` to password.
static MEMORY: Mutex<Option<HashMap<(String, String), String>>> = Mutex::new(None);

/// A keyring in the memory of this process, for tests: gone with the process, shared by every entry made in it.
pub struct MemoryKeyring;

struct MemoryEntry(String, String);

impl MemoryEntry {
    fn with<T>(
        &self,
        f: impl FnOnce(&mut HashMap<(String, String), String>, &(String, String)) -> T,
    ) -> T {
        let mut values = MEMORY.lock().unwrap_or_else(PoisonError::into_inner);
        f(
            values.get_or_insert_with(HashMap::new),
            &(self.0.clone(), self.1.clone()),
        )
    }
}

impl KeyringEntry for MemoryEntry {
    fn get_password(&mut self) -> Result<Option<String>, KeyringFailure> {
        Ok(self.with(|values, key| values.get(key).cloned()))
    }

    fn set_password(&mut self, password: &str) -> Result<(), KeyringFailure> {
        self.with(|values, key| values.insert(key.clone(), password.to_owned()));
        Ok(())
    }

    fn delete_password(&mut self) -> Result<bool, KeyringFailure> {
        Ok(self.with(|values, key| values.remove(key).is_some()))
    }
}

impl Keyring for MemoryKeyring {
    fn entry(&self, service: &str, account: &str) -> Result<Box<dyn KeyringEntry>, KeyringFailure> {
        Ok(Box::new(MemoryEntry(
            service.to_owned(),
            account.to_owned(),
        )))
    }
}

/// Why the seam was refused: the message of the TypeScript core's `keyringLoaderFor`.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SeamRefused(pub String);

/// The keyring for a process whose environment has `mode` in [`SEAM_VARIABLE`] and `allow` in [`ALLOW_VARIABLE`]
/// (`keyringLoaderFor(env)`). Without the seam variable: the operating system's. With it: only when test seams are
/// allowed, and only one of the two stand-ins; everything else is refused, so that a variable alone never switches a
/// production process and a mistyped one never falls through to a real keyring.
pub fn keyring_for(
    mode: Option<&str>,
    allow: Option<&str>,
) -> Result<Box<dyn Keyring>, SeamRefused> {
    let Some(mode) = mode else {
        return Ok(os_keyring());
    };
    if allow != Some("1") {
        return Err(SeamRefused(format!(
            "{SEAM_VARIABLE} requires {ALLOW_VARIABLE}=1"
        )));
    }
    match mode {
        "off" => Ok(Box::new(NoKeyring)),
        "memory" => Ok(Box::new(MemoryKeyring)),
        _ => Err(SeamRefused(format!("unknown {SEAM_VARIABLE} {mode}"))),
    }
}

/// [`keyring_for`] with this process's environment. A variable that is no Unicode text is a value like any other
/// unknown one.
pub fn keyring_of_this_process() -> Result<Box<dyn Keyring>, SeamRefused> {
    let read = |name: &str| std::env::var_os(name).map(|v| v.to_string_lossy().into_owned());
    keyring_for(
        read(SEAM_VARIABLE).as_deref(),
        read(ALLOW_VARIABLE).as_deref(),
    )
}

/// The keyring of this operating system. In the unit tests of this crate it is a keyring that is not there: whatever a
/// test builds, it cannot reach a keyring of the machine it runs on. (The helper and the probe are separate binaries
/// and link the crate as it ships.)
pub fn os_keyring() -> Box<dyn Keyring> {
    #[cfg(all(
        not(test),
        any(target_os = "macos", target_os = "windows", target_os = "linux")
    ))]
    {
        Box::new(platform::OsKeyring)
    }
    #[cfg(any(
        test,
        not(any(target_os = "macos", target_os = "windows", target_os = "linux"))
    ))]
    {
        Box::new(NoKeyring)
    }
}

#[cfg(any(target_os = "macos", target_os = "windows", target_os = "linux"))]
#[cfg_attr(test, allow(dead_code))]
mod platform {
    use super::{Keyring, KeyringEntry, KeyringFailure, FAILURE_CODE};
    use keyring_core::api::CredentialStoreApi;
    use keyring_core::{Entry, Error};

    /// The failure for an error of the platform layer. The error is taken and dropped: nothing of it is read.
    fn failure(_: Error) -> KeyringFailure {
        KeyringFailure {
            code: Some(FAILURE_CODE.to_owned()),
        }
    }

    /// `new Entry(service, account)` of `@napi-rs/keyring`: the system's store as it comes, no modifiers.
    fn build(service: &str, account: &str) -> Result<Entry, Error> {
        #[cfg(target_os = "macos")]
        let store = apple_native_keyring_store::keychain::Store::new()?;
        #[cfg(target_os = "windows")]
        let store = windows_native_keyring_store::Store::new()?;
        #[cfg(target_os = "linux")]
        let store = zbus_secret_service_keyring_store::Store::new()?;
        store.build(service, account, None)
    }

    /// The keyring of the operating system.
    pub struct OsKeyring;

    impl Keyring for OsKeyring {
        fn entry(
            &self,
            service: &str,
            account: &str,
        ) -> Result<Box<dyn KeyringEntry>, KeyringFailure> {
            Ok(Box::new(OsEntry(build(service, account).map_err(failure)?)))
        }
    }

    struct OsEntry(Entry);

    impl KeyringEntry for OsEntry {
        fn get_password(&mut self) -> Result<Option<String>, KeyringFailure> {
            match self.0.get_password() {
                Ok(password) => Ok(Some(password)),
                Err(Error::NoEntry) => Ok(None),
                Err(other) => Err(failure(other)),
            }
        }

        fn set_password(&mut self, password: &str) -> Result<(), KeyringFailure> {
            self.0.set_password(password).map_err(failure)
        }

        fn delete_password(&mut self) -> Result<bool, KeyringFailure> {
            match self.0.delete_credential() {
                Ok(()) => Ok(true),
                Err(Error::NoEntry) => Ok(false),
                Err(other) => Err(failure(other)),
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_seam_needs_its_permission_and_knows_two_stand_ins() {
        let refused =
            |mode: &str, allow: Option<&str>| keyring_for(Some(mode), allow).err().map(|r| r.0);
        let needs =
            Some("PLUR1BUS_SECRETS_KEYRING requires PLUR1BUS_ALLOW_TEST_INTERNALS=1".to_owned());
        for allow in [None, Some(""), Some("0"), Some("true"), Some("1 ")] {
            for mode in ["off", "memory", "anything"] {
                assert_eq!(refused(mode, allow), needs, "{mode} {allow:?}");
            }
        }
        for mode in ["", "OFF", "Memory", "real", "os", "off "] {
            assert_eq!(
                refused(mode, Some("1")),
                Some(format!("unknown PLUR1BUS_SECRETS_KEYRING {mode}")),
                "a mode nobody knows is refused, not read as the system's keyring"
            );
        }
        // Switched off: no entry can be made.
        let off = keyring_for(Some("off"), Some("1")).unwrap();
        assert_eq!(
            off.entry("service", "account").err(),
            Some(KeyringFailure::default())
        );
        // Without the variable the system's keyring is chosen, whatever the permission says.
        assert!(keyring_for(None, None).is_ok() && keyring_for(None, Some("1")).is_ok());
    }

    /// In these unit tests the system's keyring is not there, however it is reached: no test of the crate can read or
    /// write a keyring of the machine.
    #[test]
    fn the_unit_tests_have_no_keyring() {
        let refused = Some(KeyringFailure::default());
        assert_eq!(os_keyring().entry("service", "account").err(), refused);
        assert_eq!(
            keyring_for(None, None)
                .unwrap()
                .entry("service", "account")
                .err(),
            refused
        );
        let mut backend = crate::secrets::isolated::backend_of(
            &crate::secrets::isolated::BackendDescription::Keyring {
                service: "plur1bus:unit-test".into(),
            },
        );
        let probe = crate::secrets::SecretBackend::probe(backend.as_mut()).unwrap();
        assert_eq!(
            (probe.available, probe.reason.as_deref()),
            (false, Some("keyring-unavailable"))
        );
    }

    #[test]
    fn the_keyring_in_memory_is_one_per_process() {
        let keyring = keyring_for(Some("memory"), Some("1")).unwrap();
        let service = "plur1bus:os-keyring-test";
        let mut one = keyring.entry(service, "one").unwrap();
        assert_eq!(one.get_password(), Ok(None));
        assert_eq!(one.delete_password(), Ok(false));
        one.set_password("a value of the test").unwrap();
        // Another entry for the same service and account, from another keyring object: the same value.
        let mut again = MemoryKeyring.entry(service, "one").unwrap();
        assert_eq!(
            again.get_password(),
            Ok(Some("a value of the test".to_owned()))
        );
        // Another account or service is another item.
        assert_eq!(
            keyring.entry(service, "two").unwrap().get_password(),
            Ok(None)
        );
        assert_eq!(
            keyring
                .entry("another service", "one")
                .unwrap()
                .get_password(),
            Ok(None)
        );
        again.set_password("replaced").unwrap();
        assert_eq!(one.get_password(), Ok(Some("replaced".to_owned())));
        assert_eq!(one.delete_password(), Ok(true));
        assert_eq!(again.get_password(), Ok(None));
    }

    /// The kernel keyring is not among the dependencies, in any spelling the keyring crates use for it.
    #[test]
    fn no_store_for_the_kernel_keyring_is_locked() {
        let lock = include_str!("../../../../Cargo.lock");
        let names: Vec<&str> = lock
            .lines()
            .filter_map(|line| line.strip_prefix("name = \""))
            .filter_map(|rest| rest.strip_suffix('"'))
            .collect();
        assert!(names.contains(&"keyring-core"), "the lock file was read");
        let kernel: Vec<&&str> = names
            .iter()
            .filter(|name| name.contains("keyutils"))
            .collect();
        assert!(kernel.is_empty(), "{kernel:?}");
        // The one Secret Service client is the pure Rust one: no libdbus to link.
        assert!(names.contains(&"zbus-secret-service-keyring-store"));
        assert!(!names
            .iter()
            .any(|name| name.starts_with("libdbus") || *name == "dbus"));
    }
}
