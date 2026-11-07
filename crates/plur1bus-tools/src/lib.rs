//! D120's isolated native tools service; credentials and handlers never enter the memory engine.
#![forbid(unsafe_code)]
#![warn(missing_docs, clippy::print_stdout, clippy::print_stderr)]

mod files;
mod server;
pub mod team;
pub use server::{CoreContext, Service, ToolError, ToolsModule};

use sha2::{Digest, Sha256};
use std::path::Path;

/// D120 endpoint: `run/tools.sock`, or the harness's per-home Windows pipe name.
pub fn address(home: &Path) -> String {
    if cfg!(windows) {
        let hash = format!(
            "{:x}",
            Sha256::digest(home.to_string_lossy().to_lowercase())
        );
        format!(r"\\.\pipe\plur1bus-{}-tools", &hash[..16])
    } else {
        home.join("run/tools.sock").to_string_lossy().into_owned()
    }
}
