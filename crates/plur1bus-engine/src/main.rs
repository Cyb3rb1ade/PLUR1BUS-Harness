//! `plur1bus-engine`: the engine process entry point. RE-00 has only `--version` and the hidden placeholder `serve`,
//! which RE-08 fills (`plur1bus-engine serve --home <dir> ...`, plan §2.4). Exit codes follow docs/errors.md: clap's
//! usage errors exit 2, and so does the placeholder (`E_NOT_AVAILABLE`, like every milestone stub).
use clap::{Parser, Subcommand};
use std::process::ExitCode;

/// Exit code for `E_NOT_AVAILABLE` and `E_INVALID_PARAMS` (docs/errors.md).
const EXIT_REFUSED: u8 = 2;

#[derive(Parser)]
#[command(
    name = "plur1bus-engine",
    version = plur1bus_engine::CRATE_VERSION,
    about = "The PLUR1BUS memory engine process (started by the harness supervisor)",
    subcommand_required = true,
    arg_required_else_help = true
)]
struct Cli {
    #[command(subcommand)]
    command: Command,
}

#[derive(Subcommand)]
enum Command {
    /// Serve `engine.*` RPC for one home (RE-08; not implemented yet).
    #[command(hide = true)]
    Serve,
}

fn main() -> ExitCode {
    match Cli::parse().command {
        Command::Serve => {
            eprintln!(
                "plur1bus-engine serve: E_NOT_AVAILABLE reason=not-implemented (the engine process arrives with RE-08)"
            );
            ExitCode::from(EXIT_REFUSED)
        }
    }
}
