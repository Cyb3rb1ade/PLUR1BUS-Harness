//! `plur1bus-core serve --home <dir> [--lifeline stdin --instance <uuid>]`. Exit codes as `packages/core/src/bin.ts`:
//! 2 for a usage error (clap) or an invalid configuration (the legacy core's 2), 3 when another core holds the lock, 4 for
//! an unsupported engine contract, 1 when the core cannot start or a stop step failed, 0 after a clean stop (130 after
//! SIGINT).
#![forbid(unsafe_code)]
use clap::Parser;
use plur1bus_core::{Cli, Command, ServeError};

fn main() {
    let Command::Serve(args) = Cli::parse().command;
    let code = match plur1bus_core::plan(&args).and_then(|plan| plur1bus_core::serve(&plan)) {
        Ok(code) => code,
        Err(error) => {
            if !matches!(error, ServeError::Stopped(_)) {
                eprintln!("core: {error}");
            }
            error.exit_code()
        }
    };
    std::process::exit(code);
}
