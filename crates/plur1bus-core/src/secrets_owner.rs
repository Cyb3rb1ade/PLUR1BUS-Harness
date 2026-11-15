//! Who owns the secret store of a run, and the front door's side of owning it (P4-20 flip B1).
//!
//! Behind the front door one process opens the store's files and the keyring: the front door, unless one of the two
//! exceptions of [`decide`] holds. The legacy core is told at its start (`--secrets front-door`) and then builds a
//! store that is a client of the bridge ([`crate::bridge`]) instead of its own.
//!
//! [`OwnedSecrets`] is everything the front door holds for it: the store (built, preloaded) and the bridge endpoint.
//! Dropping it stops the bridge and closes the store, which ends the helper processes.
use crate::auth::Secret;
use crate::bridge::{Bridge, BridgeContext};
use crate::logs::redact::SecretSet;
use crate::run_files::RunFiles;
use crate::secrets::os_keyring::{MemoryKeyring, SeamRefused, ALLOW_VARIABLE, SEAM_VARIABLE};
use crate::secrets::runtime::{
    create_core_secret_store, keyring_choice, keyring_service, CoreStoreOptions, KeyringChoice,
    SECRET_IO_BUDGET,
};
use crate::secrets::SecretStore;
use serde_json::Value;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

/// The switch that leaves the store with the legacy core (`ts`), for the third leg of the parity scenarios. Honoured
/// only with `PLUR1BUS_ALLOW_TEST_INTERNALS=1`; any other use of it stops the start.
pub const OWNER_SWITCH: &str = "PLUR1BUS_P4_SECRETS";

/// `state/secrets/keyring-owner`: written by the move of a macOS installation's keychain items to this program
/// (P4D-35). Until it is there, a front door on macOS leaves a store over the system's keychain to the legacy core.
pub const KEYRING_OWNER_MARK: &str = "keyring-owner";

/// Who owns the store.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Owner {
    /// The front door: the legacy core gets the bridge.
    FrontDoor,
    /// The legacy core, as without a front door; the reason is a short code for the log.
    Legacy(&'static str),
}

/// Decides the owner.
///
/// - `switch` (the value of [`OWNER_SWITCH`]) is `ts` and test seams are allowed: the legacy core. Any other value, or
///   the switch without the allowance, is an error: a variable alone never changes who holds the secrets of a
///   production process, and a mistyped one is not ignored.
/// - macOS, the system's keychain, and no [`KEYRING_OWNER_MARK`]: the legacy core. A keychain item belongs to the
///   program that made it (P4D-35); this program would wait for a dialog where `node` reads at once.
/// - Otherwise the front door.
pub fn decide(
    switch: Option<&str>,
    allow: Option<&str>,
    macos: bool,
    system_keyring: bool,
    marked: bool,
) -> Result<Owner, String> {
    match switch {
        None => {}
        Some("ts") if allow == Some("1") => return Ok(Owner::Legacy("switch")),
        Some("ts") => return Err(format!("{OWNER_SWITCH} requires {ALLOW_VARIABLE}=1")),
        Some(other) => return Err(format!("unknown {OWNER_SWITCH} {other}")),
    }
    if macos && system_keyring && !marked {
        return Ok(Owner::Legacy("macos-keychain"));
    }
    Ok(Owner::FrontDoor)
}

/// The keyring of a store the front door owns, for an environment with `mode` in `PLUR1BUS_SECRETS_KEYRING`, `allow` in
/// `PLUR1BUS_ALLOW_TEST_INTERNALS` and `test_internals` saying whether `PLUR1BUS_TEST_INTERNALS` is set (the front door
/// passes that on to the legacy core as `--test-internals`).
///
/// As [`keyring_choice`], with the one rule the TypeScript core has on top (`core.ts`): a core started with test
/// internals and no keyring seam gets the keyring in memory. A test run that names no seam must not reach a keyring of
/// the machine, whichever process owns the store.
pub fn keyring_choice_for(
    mode: Option<&str>,
    allow: Option<&str>,
    test_internals: bool,
) -> Result<KeyringChoice, SeamRefused> {
    if mode.is_none() && test_internals {
        return Ok(KeyringChoice::StandIn(Box::new(MemoryKeyring)));
    }
    keyring_choice(mode, allow)
}

/// [`keyring_choice_for`] with this process's environment.
pub fn keyring_choice_of_the_front_door() -> Result<KeyringChoice, SeamRefused> {
    let read = |name: &str| std::env::var_os(name).map(|v| v.to_string_lossy().into_owned());
    keyring_choice_for(
        read(SEAM_VARIABLE).as_deref(),
        read(ALLOW_VARIABLE).as_deref(),
        std::env::var_os("PLUR1BUS_TEST_INTERNALS").is_some_and(|v| !v.is_empty()),
    )
}

/// [`decide`] for this process and the home of `files`.
pub fn decide_for(files: &RunFiles, keyring: &KeyringChoice) -> Result<Owner, String> {
    let read = |name: &str| std::env::var_os(name).map(|v| v.to_string_lossy().into_owned());
    decide(
        read(OWNER_SWITCH).as_deref(),
        read(ALLOW_VARIABLE).as_deref(),
        cfg!(target_os = "macos"),
        matches!(keyring, KeyringChoice::System),
        mark_path(&files.home).exists(),
    )
}

/// Where [`KEYRING_OWNER_MARK`] is for a home.
pub fn mark_path(home: &Path) -> PathBuf {
    home.join("state").join("secrets").join(KEYRING_OWNER_MARK)
}

/// `secrets.fileFallback.enabled` of a configuration; `false` (the schema's default) for anything that is not `true`.
pub fn file_fallback_in(config: &Value) -> bool {
    config
        .pointer("/secrets/fileFallback/enabled")
        .and_then(Value::as_bool)
        .unwrap_or(false)
}

/// [`file_fallback_in`] of `config.json` as it is on disk: the value the store starts with, before the configuration
/// source is followed. A file that is missing or cannot be read is the default.
pub fn file_fallback_on_disk(config: &Path) -> bool {
    std::fs::read_to_string(config)
        .ok()
        .and_then(|text| serde_json::from_str::<Value>(&text).ok())
        .is_some_and(|config| file_fallback_in(&config))
}

/// What the front door holds while it owns the store.
pub struct OwnedSecrets {
    /// The store.
    pub store: Arc<SecretStore>,
    bridge: Option<Bridge>,
    address: String,
}

impl OwnedSecrets {
    /// Builds the store of `files.home`, preloads it and serves it on the bridge address. `redaction` is the registry
    /// the front door masks its own lines with; `file_fallback` is kept current by whoever follows the configuration.
    pub fn open(
        files: &RunFiles,
        keyring: KeyringChoice,
        redaction: Arc<SecretSet>,
        file_fallback: Arc<AtomicBool>,
        link_token: &Secret,
        instance: &str,
    ) -> Result<OwnedSecrets, String> {
        let helper = std::env::current_exe().map_err(|e| format!("this executable: {e}"))?;
        let store = Arc::new(create_core_secret_store(CoreStoreOptions {
            home: files.home.clone(),
            keyring,
            file_fallback: Box::new(move || file_fallback.load(Ordering::SeqCst)),
            redaction,
            helper,
            budget: SECRET_IO_BUDGET,
            logger: None,
        }));
        // Every value once, before the legacy core starts: this process masks them from its first line on, and the
        // legacy core's own preload is one call that finds the snapshot ready.
        store.preload_redaction();
        let address = files.bridge_address.clone();
        // A socket file a killed front door left behind (the lock is held: nobody else serves it).
        #[cfg(unix)]
        let _ = std::fs::remove_file(&address);
        let bridge = Bridge::start(
            &address,
            BridgeContext {
                link_token: Secret::new(link_token.expose().to_owned()),
                instance: instance.to_owned(),
                pid: std::process::id(),
                store: store.clone(),
                service: keyring_service(&files.home.to_string_lossy()),
            },
        );
        match bridge {
            Ok(bridge) => Ok(OwnedSecrets {
                store,
                bridge: Some(bridge),
                address,
            }),
            Err(e) => {
                store.close();
                Err(e)
            }
        }
    }
}

impl Drop for OwnedSecrets {
    fn drop(&mut self) {
        if let Some(bridge) = self.bridge.take() {
            bridge.stop();
        }
        self.store.close();
        #[cfg(unix)]
        let _ = std::fs::remove_file(&self.address);
        let _ = &self.address;
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn the_front_door_owns_the_store_but_for_two_exceptions() {
        // The default, on every system: the front door.
        for macos in [false, true] {
            for marked in [false, true] {
                assert_eq!(
                    decide(None, None, macos, false, marked),
                    Ok(Owner::FrontDoor)
                );
            }
        }
        // macOS over the system's keychain: the legacy core until the items have moved.
        assert_eq!(
            decide(None, None, true, true, false),
            Ok(Owner::Legacy("macos-keychain"))
        );
        assert_eq!(decide(None, None, true, true, true), Ok(Owner::FrontDoor));
        // Another system's keyring belongs to no program.
        assert_eq!(decide(None, None, false, true, false), Ok(Owner::FrontDoor));
        // The allowance alone switches nothing.
        assert_eq!(
            decide(None, Some("1"), false, true, false),
            Ok(Owner::FrontDoor)
        );
    }

    #[test]
    fn a_front_door_with_test_internals_and_no_seam_has_the_keyring_in_memory() {
        // As the TypeScript core: test internals without a seam is the keyring in memory, never the system's.
        assert!(matches!(
            keyring_choice_for(None, None, true),
            Ok(KeyringChoice::StandIn(_))
        ));
        assert!(matches!(
            keyring_choice_for(None, None, false),
            Ok(KeyringChoice::System)
        ));
        // A seam that is named is judged as always: test internals do not allow it.
        assert!(keyring_choice_for(Some("memory"), None, true).is_err());
        assert!(keyring_choice_for(Some("system"), Some("1"), true).is_err());
        assert!(matches!(
            keyring_choice_for(Some("off"), Some("1"), true),
            Ok(KeyringChoice::StandIn(_))
        ));
    }

    #[test]
    fn the_switch_is_for_tests_and_is_never_ignored() {
        assert_eq!(
            decide(Some("ts"), Some("1"), false, false, false),
            Ok(Owner::Legacy("switch"))
        );
        // It wins over everything else that would make the front door the owner.
        assert_eq!(
            decide(Some("ts"), Some("1"), true, true, true),
            Ok(Owner::Legacy("switch"))
        );
        for allow in [None, Some("0"), Some(""), Some("true")] {
            assert!(
                decide(Some("ts"), allow, false, false, false).is_err(),
                "{allow:?}"
            );
        }
        for other in ["", "rust", "TS", "front-door", "1"] {
            assert!(
                decide(Some(other), Some("1"), false, false, false).is_err(),
                "{other}"
            );
        }
    }

    #[test]
    fn the_file_fallback_is_true_only_where_the_configuration_says_true() {
        assert!(file_fallback_in(
            &json!({ "secrets": { "fileFallback": { "enabled": true } } })
        ));
        for config in [
            json!({}),
            json!({ "secrets": {} }),
            json!({ "secrets": { "fileFallback": { "enabled": false } } }),
            json!({ "secrets": { "fileFallback": { "enabled": "true" } } }),
            json!({ "secrets": { "fileFallback": true } }),
            json!(null),
        ] {
            assert!(!file_fallback_in(&config), "{config}");
        }
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("config.json");
        assert!(!file_fallback_on_disk(&path), "no file");
        std::fs::write(&path, "{ not json").unwrap();
        assert!(!file_fallback_on_disk(&path), "a file that does not parse");
        std::fs::write(&path, r#"{"secrets":{"fileFallback":{"enabled":true}}}"#).unwrap();
        assert!(file_fallback_on_disk(&path));
        assert_eq!(
            mark_path(Path::new("/h")),
            Path::new("/h/state/secrets/keyring-owner")
        );
    }
}
