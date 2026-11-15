//! Secret backends in a helper process (`secrets/isolated-*.ts`, `secrets-isolated-bin.ts`).
//!
//! Persistent secret I/O does not run in the core: a keychain can block on a prompt and a file system can hang. The core
//! talks to a helper (`plur1bus-core secrets-helper`, its own executable) over the helper's standard input and output and
//! gives every call a budget. [`client`] is the core's side, [`server`] the helper's, [`protocol`] what travels between.
pub mod client;
pub mod protocol;
pub mod server;
#[cfg(test)]
mod tests;

pub use client::{
    helper_of, isolated_backend, spawn_process, HelperControl, HelperProcess, IsolatedBackend,
    IsolatedHandle, IsolatedOptions, SpawnHelper, HELPER_COMMAND, SECRET_IO_BUDGET_MS,
};
pub use protocol::BackendDescription;
pub use server::serve;

use super::backend::SecretBackend;
use super::file_backend::FileBackend;
use super::keyring_backend::KeyringBackend;
use super::os_keyring::os_keyring;

/// The backend a helper serves for a description (`secrets-isolated-bin.ts`): the OS keyring or the encrypted file
/// backend. No test stand-in can be chosen here.
pub fn backend_of(description: &BackendDescription) -> Box<dyn SecretBackend> {
    match description {
        BackendDescription::Keyring { service } => {
            Box::new(KeyringBackend::new(service.clone(), os_keyring()))
        }
        BackendDescription::File { dir } => Box::new(FileBackend::new(dir.as_str())),
    }
}

/// What `plur1bus-core secrets-helper` runs: serves one backend on standard input and output until the input ends. The
/// exit code is 0 after a clean end and 1 when a pipe broke or something that is no frame arrived.
pub fn helper_main() -> i32 {
    let served = serve(
        std::io::stdin().lock(),
        std::io::stdout().lock(),
        backend_of,
    );
    i32::from(served.is_err())
}
