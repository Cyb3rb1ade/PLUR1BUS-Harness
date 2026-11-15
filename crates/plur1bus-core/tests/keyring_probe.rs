//! The keyring probe (P4-20 PR 2b): the adapters of `secrets::os_keyring` against a real keyring, together with the
//! TypeScript side's `@napi-rs/keyring`.
//!
//! **It does nothing unless it is asked to.** An ordinary `cargo test` runs this target and it returns at once: no test
//! run on a developer's machine may reach a keyring. `scripts/ci/keyring-probe.mjs` asks, in CI, with a service name of
//! its own:
//!
//! - `PLUR1BUS_KEYRING_PROBE=first`: Node has written the account `node-wrote`. This reads it, replaces it, writes
//!   `rust-wrote`, and runs a round trip of its own and the keyring backend (index entry and credentials) over the
//!   same keyring.
//! - `PLUR1BUS_KEYRING_PROBE=second`: Node has read both and deleted `node-wrote`. This finds it gone and deletes
//!   `rust-wrote`.
//!
//! The service is `PLUR1BUS_KEYRING_PROBE_SERVICE` and must begin with [`SERVICE_PREFIX`]: the probe cannot be pointed
//! at the service of an installation. The values are plain words (with letters beyond ASCII, which the Windows store
//! writes as UTF-16); nothing here is a credential.
//!
//! `harness = false`.
#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::print_stdout
)]

use plur1bus_core::secrets::keyring_backend::{Keyring, KeyringBackend, INDEX_ACCOUNT};
use plur1bus_core::secrets::os_keyring::{os_keyring, SEAM_VARIABLE};
use plur1bus_core::secrets::SecretBackend;

/// What every probe service begins with.
const SERVICE_PREFIX: &str = "plur1bus-keyring-probe:";
/// The values, the same in `scripts/ci/keyring-probe.mjs`.
const NODE_VALUE: &str = "written by node: plain words, äöü, 鍵, 🔑";
const RUST_VALUE: &str = "written by rust: plain words, ÄÖÜ, 錠, 🗝";
const RUST_REPLACED: &str = "replaced by rust";

fn main() {
    let phase = std::env::var("PLUR1BUS_KEYRING_PROBE").unwrap_or_default();
    if phase.is_empty() {
        println!("keyring probe: not asked for (PLUR1BUS_KEYRING_PROBE is not set); no keyring was touched");
        return;
    }
    assert!(
        std::env::var_os(SEAM_VARIABLE).is_none(),
        "the probe is for the system's keyring; {SEAM_VARIABLE} is set"
    );
    let service = std::env::var("PLUR1BUS_KEYRING_PROBE_SERVICE").unwrap_or_default();
    assert!(
        service.len() > SERVICE_PREFIX.len() && service.starts_with(SERVICE_PREFIX),
        "PLUR1BUS_KEYRING_PROBE_SERVICE must begin with {SERVICE_PREFIX}"
    );
    diagnose(&service);
    let keyring = os_keyring();
    match phase.as_str() {
        "first" => first(keyring.as_ref(), &service),
        "second" => second(keyring.as_ref(), &service),
        other => panic!("unknown PLUR1BUS_KEYRING_PROBE {other}"),
    }
    println!("keyring probe: {phase} ok");
}

/// What the platform itself says, for the log of the run. The adapter passes none of it on (an error of the platform
/// can hold what was read); here every value is the probe's own, so it may be printed, and a run that fails in CI can
/// be understood from its log.
fn diagnose(service: &str) {
    #[cfg(any(target_os = "macos", target_os = "windows", target_os = "linux"))]
    {
        use keyring_core::api::CredentialStoreApi;
        #[cfg(target_os = "macos")]
        let store = apple_native_keyring_store::keychain::Store::new();
        #[cfg(target_os = "windows")]
        let store = windows_native_keyring_store::Store::new();
        #[cfg(target_os = "linux")]
        let store = zbus_secret_service_keyring_store::Store::new();
        let read = store.and_then(|store| {
            println!("keyring probe: store {} ({})", store.vendor(), store.id());
            store.build(service, "rust-self", None)?.get_password()
        });
        match read {
            Ok(_) | Err(keyring_core::Error::NoEntry) => {
                println!("keyring probe: the platform answers")
            }
            Err(other) => println!("keyring probe: the platform refuses: {other}"),
        }
    }
    #[cfg(not(any(target_os = "macos", target_os = "windows", target_os = "linux")))]
    println!("keyring probe: no keyring adapter for this system ({service})");
}

fn first(keyring: &dyn Keyring, service: &str) {
    // A round trip of its own.
    let mut own = keyring
        .entry(service, "rust-self")
        .expect("an entry can be made");
    assert_eq!(own.get_password(), Ok(None), "nothing there yet");
    assert_eq!(own.delete_password(), Ok(false), "nothing to delete yet");
    own.set_password(RUST_VALUE).expect("set");
    assert_eq!(own.get_password(), Ok(Some(RUST_VALUE.to_owned())));
    // A second entry for the same service and account is the same item.
    let mut again = keyring.entry(service, "rust-self").unwrap();
    assert_eq!(again.get_password(), Ok(Some(RUST_VALUE.to_owned())));
    again.set_password(RUST_REPLACED).expect("replace");
    assert_eq!(own.get_password(), Ok(Some(RUST_REPLACED.to_owned())));
    // A value as long as an index of some forty names.
    let long: String = "0123456789abcdef".repeat(64);
    own.set_password(&long).expect("a value of 1024 characters");
    assert_eq!(own.get_password(), Ok(Some(long)));
    assert_eq!(own.delete_password(), Ok(true));
    assert_eq!(own.get_password(), Ok(None));
    assert_eq!(again.delete_password(), Ok(false));

    // What Node wrote is read here, as written.
    let mut theirs = keyring.entry(service, "node-wrote").unwrap();
    assert_eq!(
        theirs.get_password(),
        Ok(Some(NODE_VALUE.to_owned())),
        "the item @napi-rs/keyring wrote for this service and account"
    );
    // And replaced, and one of our own beside it, for Node to read.
    theirs
        .set_password(RUST_REPLACED)
        .expect("replace what node wrote");
    keyring
        .entry(service, "rust-wrote")
        .unwrap()
        .set_password(RUST_VALUE)
        .expect("write for node");

    // The keyring backend over the same keyring: the index entry and one credential per name.
    let backend_service = format!("{service}:backend");
    let mut backend = KeyringBackend::new(backend_service.clone(), os_keyring());
    let probe = backend.probe().expect("probe");
    assert!(probe.available, "{:?}", probe.reason);
    assert_eq!(backend.get("api").unwrap(), None);
    backend
        .put(
            "api",
            RUST_VALUE,
            1_767_323_045_678,
            Some("owner:local"),
            Some("what it is for"),
            None,
        )
        .expect("put");
    backend
        .put(
            "second.name",
            RUST_REPLACED,
            1_767_323_045_679,
            None,
            None,
            None,
        )
        .expect("put");
    // Another backend object (as after a restart of the helper) reads what the first one wrote.
    let mut restarted = KeyringBackend::new(backend_service, os_keyring());
    assert_eq!(restarted.get("api").unwrap().as_deref(), Some(RUST_VALUE));
    let names: Vec<String> = restarted
        .list()
        .unwrap()
        .iter()
        .map(|meta| meta.to_json()["name"].as_str().unwrap().to_owned())
        .collect();
    assert_eq!(names, ["api", "second.name"]);
    assert!(restarted.delete("api", None).unwrap());
    assert!(restarted.delete("second.name", None).unwrap());
    assert_eq!(backend.get("api").unwrap(), None);
    assert!(backend.list().unwrap().is_empty());
    // The index entry stays when the last name goes; the probe leaves nothing behind.
    let mut index = keyring
        .entry(&format!("{service}:backend"), INDEX_ACCOUNT)
        .unwrap();
    assert_eq!(
        index.delete_password(),
        Ok(true),
        "the index entry was there"
    );
}

fn second(keyring: &dyn Keyring, service: &str) {
    // Node deleted what it wrote (and Rust replaced): gone here too.
    let mut theirs = keyring.entry(service, "node-wrote").unwrap();
    assert_eq!(theirs.get_password(), Ok(None), "node deleted it");
    assert_eq!(theirs.delete_password(), Ok(false));
    let mut ours = keyring.entry(service, "rust-wrote").unwrap();
    assert_eq!(
        ours.get_password(),
        Ok(Some(RUST_VALUE.to_owned())),
        "node only read it"
    );
    assert_eq!(ours.delete_password(), Ok(true));
    assert_eq!(ours.delete_password(), Ok(false));
}
