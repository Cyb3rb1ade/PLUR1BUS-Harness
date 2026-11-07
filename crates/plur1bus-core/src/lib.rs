//! `plur1bus-core`: the PLUR1BUS core in Rust (Phase 4, ADR-019, owner decisions D129/D131).
//!
//! Today this is the skeleton of P4-03: argument parsing, path resolution and the module layout the front door (P4-10)
//! fills. `plur1bus-core serve` resolves its run files and then refuses with [`ServeError::FrontDoorPending`]; nothing
//! is bound, written or locked. The TypeScript core stays the default until P4-10's flip PR.
//!
//! Where things go (plan §2.1, §2.4):
//! - [`server`]: the listener on `run/core.sock` or the per-home pipe, framing, and the generated
//!   `plur1bus_rpc::server::CoreMethods` dispatch;
//! - [`relay`]: forwarding unserved methods to `core-legacy` with the caller context;
//! - [`auth`]: `run/core.token` and `core.auth`;
//! - [`lock`]: the single-instance core lock (`state/core.lock`);
//! - [`run_files`]: the paths of the run files (implemented here);
//! - [`events`]: `events.subscribe`/`unsubscribe` and the fan-out by audience;
//! - [`lifecycle`]: the lifeline, drain order and shutdown.
//!
//! Shared crates: `plur1bus-canon` (canonical JSON, action hash), `plur1bus-store` (SQLite conventions),
//! `plur1bus-tokens` (token counter), `plur1bus-audit` (audit chain), `plur1bus-rpc` (types, client, server half).
#![forbid(unsafe_code)]
#![warn(missing_docs)]
#![warn(clippy::print_stdout, clippy::print_stderr)]

pub mod auth;
pub mod cli;
pub mod events;
pub mod lifecycle;
pub mod lock;
pub mod relay;
pub mod run_files;
pub mod server;

pub use cli::{Cli, Command, ServeArgs};
pub use run_files::RunFiles;

use std::fmt;

/// What `serve` was asked to do, resolved from the arguments.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ServePlan {
    /// The run files under the resolved (absolute) home.
    pub run_files: RunFiles,
    /// Supervised mode: stdin is the lifeline the supervisor holds (`--lifeline stdin`).
    pub lifeline: bool,
    /// The instance id the supervisor assigned, lower-cased (`--instance`).
    pub instance: Option<String>,
}

/// Why `serve` could not start.
#[derive(Debug)]
pub enum ServeError {
    /// The home could not be made absolute.
    Home(std::io::Error),
    /// The front door is not implemented yet: it lands in P4-10.
    FrontDoorPending {
        /// The address P4-10 will listen on.
        address: String,
    },
}

impl fmt::Display for ServeError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Home(e) => write!(f, "cannot resolve --home: {e}"),
            Self::FrontDoorPending { address } => write!(
                f,
                "the Rust front door lands in P4-10; nothing listens on {address} yet (the TypeScript core stays the default)"
            ),
        }
    }
}

impl std::error::Error for ServeError {}

/// Resolves `serve`'s arguments: the home made absolute (against the working directory) and its run files.
pub fn plan(args: &ServeArgs) -> Result<ServePlan, ServeError> {
    let home = std::path::absolute(&args.home).map_err(ServeError::Home)?;
    Ok(ServePlan {
        run_files: RunFiles::new(&home),
        lifeline: args.lifeline.is_some(),
        instance: args.instance.clone(),
    })
}

/// Serves the core. Until P4-10 this always returns [`ServeError::FrontDoorPending`] and touches nothing.
pub fn serve(plan: &ServePlan) -> Result<(), ServeError> {
    Err(ServeError::FrontDoorPending {
        address: plan.run_files.address.clone(),
    })
}
