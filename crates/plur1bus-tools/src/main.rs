//! Native tools process entry point; the supervisor or Core owns its stdin lifeline.
#![forbid(unsafe_code)]
use clap::{Parser, Subcommand};
use std::path::PathBuf;

#[derive(Parser)]
#[command(
    name = "plur1bus-tools",
    version,
    about = "Private native tools service (D120)"
)]
struct Cli {
    #[command(subcommand)]
    command: Command,
}

#[derive(Subcommand)]
enum Command {
    Serve {
        #[arg(long)]
        home: PathBuf,
        #[arg(long, value_parser = ["stdin"])]
        lifeline: Option<String>,
        #[arg(long, default_value_t = 10_000)]
        grace_ms: u64,
        #[arg(long)]
        instance: Option<uuid::Uuid>,
    },
}

fn main() {
    let Command::Serve {
        home,
        lifeline,
        grace_ms,
        instance,
    } = Cli::parse().command;
    let instance = instance.unwrap_or_else(uuid::Uuid::new_v4).to_string();
    let service = plur1bus_tools::Service::bind(
        &home,
        &instance,
        vec![std::sync::Arc::new(plur1bus_tools::team::TeamModule)],
    );
    match service {
        Ok(service) => {
            println!(
                "{}",
                serde_json::json!({"ready":true,"address":plur1bus_tools::address(&home),
                "pid":std::process::id(),"instanceId":instance})
            );
            if service
                .serve(
                    lifeline.is_some(),
                    std::time::Duration::from_millis(grace_ms),
                )
                .is_err()
            {
                eprintln!("tools service failed; inspect private run directory permissions");
                std::process::exit(1);
            }
        }
        Err(error) => {
            eprintln!("tools service could not bind: {error}");
            std::process::exit(if error.kind() == std::io::ErrorKind::WouldBlock {
                3
            } else {
                1
            });
        }
    }
}
