//! `createCoreSecretStore` of `secrets/runtime.ts`: the store of a core that owns its files (P4-20 flip B).
//!
//! What it puts together:
//! - the keyring backend for the service of this home ([`keyring_service`]), in a helper process when it is the
//!   operating system's keyring and in this process when it is a test's stand-in (as the TypeScript core does: a
//!   stand-in lives as long as the core, not as long as a helper);
//! - the encrypted file backend of `state/secrets`, always in a helper process;
//! - the audit sink over the chain and `logs/audit.log` ([`FileAuditSink`]), with the live redactor of the registry;
//! - the start-up budget, and the flag by which a helper that failed makes the store unavailable.
//!
//! **The keyring is chosen by the owner of the store.** [`keyring_choice_of_this_process`] reads the test seam
//! (`PLUR1BUS_SECRETS_KEYRING`, only with `PLUR1BUS_ALLOW_TEST_INTERNALS=1`). A seam that is refused is an error the
//! caller must not start with: a store that silently went on without a keyring, or with the system's, would be the
//! one thing the seam exists to prevent (review of PR 2b, R7).
use super::audit_sink::FileAuditSink;
use super::backend::SecretBackend;
use super::isolated::{
    helper_of, isolated_backend, BackendDescription, IsolatedHandle, IsolatedOptions,
    SECRET_IO_BUDGET_MS,
};
use super::keyring_backend::{Keyring, KeyringBackend};
use super::os_keyring::{keyring_for, SeamRefused, ALLOW_VARIABLE, SEAM_VARIABLE};
use super::store::{SecretStore, SecretStoreLogger, SecretStoreOptions, StartupOptions};
use crate::identity::codes::RandomSource;
use crate::lifecycle::now_ms;
use crate::logs::redact::SecretSet;
use sha2::{Digest, Sha256};
use std::path::PathBuf;
use std::sync::atomic::AtomicBool;
use std::sync::Arc;
use std::time::{Duration, Instant};

/// The budget of one call to a helper and of the start-up preload, as a duration.
pub const SECRET_IO_BUDGET: Duration = Duration::from_millis(SECRET_IO_BUDGET_MS);

/// How long an unavailable store waits before it tries its backends again (`retryAfterMs` of the TypeScript store).
pub const RETRY_AFTER_MS: f64 = 30_000.0;

/// The keyring of a core's store (`keyringLoaderFor`).
pub enum KeyringChoice {
    /// The operating system's, behind a helper process.
    System,
    /// A test's stand-in, in this process.
    StandIn(Box<dyn Keyring>),
}

/// [`KeyringChoice`] for an environment with `mode` in `PLUR1BUS_SECRETS_KEYRING` and `allow` in
/// `PLUR1BUS_ALLOW_TEST_INTERNALS`.
pub fn keyring_choice(
    mode: Option<&str>,
    allow: Option<&str>,
) -> Result<KeyringChoice, SeamRefused> {
    match mode {
        None => Ok(KeyringChoice::System),
        Some(_) => keyring_for(mode, allow).map(KeyringChoice::StandIn),
    }
}

/// [`keyring_choice`] with this process's environment.
pub fn keyring_choice_of_this_process() -> Result<KeyringChoice, SeamRefused> {
    let read = |name: &str| std::env::var_os(name).map(|v| v.to_string_lossy().into_owned());
    keyring_choice(
        read(SEAM_VARIABLE).as_deref(),
        read(ALLOW_VARIABLE).as_deref(),
    )
}

/// The keyring service of a home: `plur1bus:` and the first 16 hex digits of the SHA-256 of the home path as text. One
/// service per home, so two homes of one OS user never see each other's secrets. The text must be the one the
/// TypeScript core hashes (`layout.home`), or the entries of an installation are not found.
pub fn keyring_service(home: &str) -> String {
    let digest = Sha256::digest(home.as_bytes());
    let hex: String = digest.iter().take(8).map(|b| format!("{b:02x}")).collect();
    format!("plur1bus:{hex}")
}

/// What a core's store is made from.
pub struct CoreStoreOptions {
    /// The home, as the core was given it.
    pub home: PathBuf,
    /// The keyring.
    pub keyring: KeyringChoice,
    /// `secrets.fileFallback.enabled`, read per use.
    pub file_fallback: Box<dyn Fn() -> bool + Send>,
    /// The registry every sink of this process masks with.
    pub redaction: Arc<SecretSet>,
    /// The executable that is started as `secrets-helper` (the core's own).
    pub helper: PathBuf,
    /// The budget of one call to a helper and of the start-up preload ([`SECRET_IO_BUDGET_MS`] in production; a test on
    /// a loaded machine gives a helper more time to start).
    pub budget: Duration,
    /// The store's log.
    pub logger: Option<Box<dyn SecretStoreLogger>>,
}

/// The randomness of lease ids: the operating system's. A system without entropy ends the process: a lease id that
/// can be guessed must never be handed out, and there is nothing to wait for.
struct OsRandom;

impl OsRandom {
    fn fill(out: &mut [u8]) {
        if getrandom::fill(out).is_err() {
            std::process::abort();
        }
    }
}

impl RandomSource for OsRandom {
    fn random_int(&mut self, max: u32) -> u32 {
        if max <= 1 {
            return 0;
        }
        // Rejection sampling: uniform in `[0, max)`.
        let limit = u32::MAX - u32::MAX % max;
        loop {
            let mut bytes = [0u8; 4];
            OsRandom::fill(&mut bytes);
            let draw = u32::from_le_bytes(bytes);
            if draw < limit {
                return draw % max;
            }
        }
    }

    fn fill_bytes(&mut self, out: &mut [u8]) {
        OsRandom::fill(out);
    }
}

/// The store of a core: nothing is read until its first operation or `preload_redaction`.
pub fn create_core_secret_store(o: CoreStoreOptions) -> SecretStore {
    let service = keyring_service(&o.home.to_string_lossy());
    let unavailable = Arc::new(AtomicBool::new(false));
    let mut handles: Vec<IsolatedHandle> = Vec::new();
    let mut isolated = |description: BackendDescription| -> Box<dyn SecretBackend + Send> {
        let (backend, handle) = isolated_backend(
            description,
            IsolatedOptions {
                budget: o.budget,
                spawn: helper_of(o.helper.clone()),
                unavailable: unavailable.clone(),
            },
        );
        handles.push(handle);
        Box::new(backend)
    };
    let keyring: Box<dyn SecretBackend + Send> = match o.keyring {
        KeyringChoice::System => isolated(BackendDescription::Keyring { service }),
        KeyringChoice::StandIn(keyring) => Box::new(KeyringBackend::new(service, keyring)),
    };
    let file = isolated(BackendDescription::File {
        dir: o
            .home
            .join("state")
            .join("secrets")
            .to_string_lossy()
            .into_owned(),
    });
    let clock: Arc<dyn Fn() -> i64 + Send + Sync> =
        Arc::new(|| i64::try_from(now_ms()).unwrap_or(i64::MAX));
    let started = Instant::now();
    let (cancelled, closed) = (handles.clone(), handles);
    SecretStore::new(SecretStoreOptions {
        keyring,
        file,
        file_fallback: o.file_fallback,
        audit: Box::new(FileAuditSink::new(
            o.home.join("logs"),
            clock.clone(),
            Box::new(o.redaction.redactor(false, false)),
        )),
        clock,
        monotonic: Box::new(move || started.elapsed().as_secs_f64() * 1000.0),
        random: Box::new(OsRandom),
        logger: o.logger,
        redaction: o.redaction,
        startup: StartupOptions {
            budget_ms: o.budget.as_secs_f64() * 1000.0,
            retry_after_ms: RETRY_AFTER_MS,
            unavailable,
            cancel: Some(Box::new(move || {
                cancelled.iter().for_each(IsolatedHandle::cancel);
            })),
            close: Some(Box::new(move || {
                closed.iter().for_each(IsolatedHandle::close);
            })),
        },
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_service_is_the_one_the_typescript_core_derives_from_the_home() {
        // `plur1bus:${createHash("sha256").update(home).digest("hex").slice(0, 16)}`, computed with Node for these texts.
        assert_eq!(keyring_service("/h"), "plur1bus:141582aa3785bb7d");
        assert_eq!(
            keyring_service("/Users/ünï/.plur1bus"),
            "plur1bus:419ab5eae96ab27c"
        );
        assert_eq!(
            keyring_service("C:\\Users\\a\\AppData\\Local\\PLUR1BUS"),
            "plur1bus:b18cfdcd50aedbe3"
        );
        // No normalization: another spelling of the same directory is another service.
        assert_ne!(keyring_service("/h/"), keyring_service("/h"));
    }

    #[test]
    fn the_keyring_is_the_systems_unless_a_seam_that_is_allowed_names_a_stand_in() {
        assert!(matches!(
            keyring_choice(None, None),
            Ok(KeyringChoice::System)
        ));
        // The allow variable alone switches nothing.
        assert!(matches!(
            keyring_choice(None, Some("1")),
            Ok(KeyringChoice::System)
        ));
        for mode in ["off", "memory"] {
            assert!(matches!(
                keyring_choice(Some(mode), Some("1")),
                Ok(KeyringChoice::StandIn(_))
            ));
            // Without the allow variable the seam is refused, never ignored.
            for allow in [None, Some("0"), Some("true"), Some("")] {
                assert!(
                    keyring_choice(Some(mode), allow).is_err(),
                    "{mode} {allow:?}"
                );
            }
        }
        // A mode nobody knows is refused even where seams are allowed: it must not fall through to the system's.
        for mode in ["", "system", "MEMORY", "on"] {
            assert!(keyring_choice(Some(mode), Some("1")).is_err(), "{mode}");
        }
    }

    #[test]
    fn the_random_source_stays_in_its_range() {
        let mut random = OsRandom;
        for max in [1, 2, 3, 32, 1000] {
            for _ in 0..200 {
                assert!(random.random_int(max) < max);
            }
        }
        assert_eq!(random.random_int(0), 0);
        let (mut a, mut b) = ([0u8; 16], [0u8; 16]);
        random.fill_bytes(&mut a);
        random.fill_bytes(&mut b);
        assert_ne!(a, b);
    }
}
