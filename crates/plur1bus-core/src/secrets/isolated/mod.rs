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
use super::os_keyring::{keyring_of_this_process, NoKeyring};

/// The backend a helper serves for a description (`secrets-isolated-bin.ts`): the OS keyring or the encrypted file
/// backend. The keyring is the one of this process's environment (`os_keyring::keyring_for`): the operating system's,
/// or a test's stand-in where test seams are allowed. A seam that is refused leaves a keyring that is not there, never
/// the system's.
pub fn backend_of(description: &BackendDescription) -> Box<dyn SecretBackend> {
    match description {
        BackendDescription::Keyring { service } => {
            let keyring = keyring_of_this_process().unwrap_or_else(|_| Box::new(NoKeyring));
            Box::new(KeyringBackend::new(service.clone(), keyring))
        }
        BackendDescription::File { dir } => Box::new(FileBackend::new(dir.as_str())),
    }
}

/// What `plur1bus-core secrets-helper` runs: serves one backend on standard input and output until the input ends. The
/// exit code is 0 after a clean end and 1 when a pipe broke or something that is no frame arrived. A helper whose
/// environment asks for a keyring stand-in it may not have (`os_keyring::keyring_for`) serves nothing and ends with 2.
/// To its caller that is a helper that failed, so a backend that is not available. The TypeScript core refuses to build
/// its store in that case; the process that owns the store has to do the same (`keyring_of_this_process` before it
/// starts a helper), which comes with the flip. The exit here is the second line of defence.
pub fn helper_main() -> i32 {
    if keyring_of_this_process().is_err() {
        return 2;
    }
    // A panic is answered as a failed operation (`serve`); its message is nobody's to read, wherever the error output
    // of a helper started by hand may lead.
    std::panic::set_hook(Box::new(|_| {}));
    let served = serve(
        std::io::stdin().lock(),
        std::io::stdout().lock(),
        backend_of,
    );
    i32::from(served.is_err())
}
