//! The command line, as the supervisor spawns the core: `plur1bus-core serve --home <dir> [--lifeline stdin --instance
//! <uuid>]`. The checks are `packages/core/src/bin.ts`'s: an empty value is a mistake (`--home=` must not quietly start on
//! another home), `--lifeline` accepts only `stdin`, `--instance` must be a hyphenated UUID and is lower-cased. A usage
//! error exits 2, as in `bin.ts`.
use clap::{Args, Parser, Subcommand};
use std::path::PathBuf;

/// `plur1bus-core`.
#[derive(Debug, Parser)]
#[command(
    name = "plur1bus-core",
    version,
    about = "The PLUR1BUS core in Rust (Phase 4). The front door lands in P4-10; until then `serve` only resolves its paths."
)]
pub struct Cli {
    /// What to run.
    #[command(subcommand)]
    pub command: Command,
}

/// The subcommands.
#[derive(Debug, Subcommand)]
pub enum Command {
    /// Serve the core RPC on `<home>/run/core.sock` (or the per-home pipe on Windows).
    Serve(ServeArgs),
}

/// `serve`'s arguments.
#[derive(Clone, Debug, Args)]
pub struct ServeArgs {
    /// The harness home; made absolute against the working directory.
    #[arg(long, value_parser = non_empty_path)]
    pub home: PathBuf,
    /// Supervised mode: the supervisor holds stdin's write end as the lifeline (ADR-012). Only `stdin`.
    #[arg(long, value_parser = ["stdin"])]
    pub lifeline: Option<String>,
    /// The instance id the supervisor assigned: a UUID, stored lower-cased.
    #[arg(long, value_parser = instance_id)]
    pub instance: Option<String>,
}

fn non_empty_path(value: &str) -> Result<PathBuf, String> {
    if value.is_empty() {
        Err("needs a value".into())
    } else {
        Ok(PathBuf::from(value))
    }
}

/// `/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i`, lower-cased (`bin.ts`).
pub fn instance_id(value: &str) -> Result<String, String> {
    let groups: Vec<&str> = value.split('-').collect();
    let well_formed = groups.len() == 5
        && groups
            .iter()
            .zip([8, 4, 4, 4, 12])
            .all(|(group, len)| group.len() == len && group.bytes().all(|b| b.is_ascii_hexdigit()));
    if well_formed {
        Ok(value.to_ascii_lowercase())
    } else {
        Err(format!("must be a UUID, got {value}"))
    }
}

#[cfg(test)]
mod tests {
    use super::instance_id;

    #[test]
    fn an_instance_is_a_hyphenated_uuid_in_lower_case() {
        assert_eq!(
            instance_id("123E4567-E89B-12D3-A456-426614174000").as_deref(),
            Ok("123e4567-e89b-12d3-a456-426614174000")
        );
        for bad in [
            "",
            "123e4567e89b12d3a456426614174000",
            "{123e4567-e89b-12d3-a456-426614174000}",
            "urn:uuid:123e4567-e89b-12d3-a456-426614174000",
            "123e4567-e89b-12d3-a456-42661417400g",
        ] {
            assert!(instance_id(bad).is_err(), "{bad}");
        }
    }
}
