//! `plur1bus-core serve --home <dir> [--lifeline stdin --instance <uuid>]`. Exit codes as `packages/core/src/bin.ts`:
//! 2 for a usage error (clap), 1 when the core cannot start, which until P4-10 is always the case.
#![forbid(unsafe_code)]
use clap::Parser;
use plur1bus_core::{Cli, Command};

fn main() {
    let Command::Serve(args) = Cli::parse().command;
    let outcome = plur1bus_core::plan(&args).and_then(|plan| plur1bus_core::serve(&plan));
    if let Err(error) = outcome {
        eprintln!("core: {error}");
        std::process::exit(1);
    }
}
