//! The supervised engine process. Lifecycle and transport follow ADR-012 §10.
use clap::{Parser, Subcommand, ValueEnum};
use plur1bus_engine::rpc::{
    config,
    engine::ProcessEngine,
    host_client::RpcHost,
    layout::EngineLayout,
    lifeline::Lifeline,
    platform, seams,
    server::{self, ServeError},
};
use std::{
    io::{self, Write},
    path::PathBuf,
    process::ExitCode,
    sync::Arc,
};

#[derive(Parser)]
#[command(name="plur1bus-engine",version=plur1bus_engine::CRATE_VERSION,about="The PLUR1BUS memory engine process (started by the harness supervisor)",subcommand_required=true,arg_required_else_help=true)]
struct Cli {
    #[command(subcommand)]
    command: Command,
}
#[derive(Clone, Copy, ValueEnum)]
enum LifelineArg {
    Stdin,
}
#[derive(Subcommand)]
enum Command {
    /// Serve the authenticated engine RPC endpoint for one Harness home.
    #[command(hide = true)]
    Serve {
        #[arg(long)]
        home: PathBuf,
        #[arg(long)]
        lifeline: Option<LifelineArg>,
        #[arg(long)]
        instance: Option<uuid::Uuid>,
        #[arg(long, hide = true)]
        test_internals: Option<String>,
    },
}

fn run(command: Command) -> Result<(), (u8, String)> {
    let Command::Serve {
        home,
        lifeline,
        instance,
        test_internals,
    } = command;
    let allow = std::env::var_os("PLUR1BUS_ALLOW_TEST_INTERNALS").as_deref()
        == Some(std::ffi::OsStr::new("1"));
    let seam = if let Some(variant) = test_internals {
        seams::parse(&variant, allow).map(Some)
    } else {
        seams::from_env()
    }
    .map_err(|e| (2, e.to_string()))?;
    let mut layout = EngineLayout::new(
        &home,
        instance.unwrap_or_else(uuid::Uuid::new_v4).to_string(),
    )
    .map_err(|_| (2, "engine home is unavailable or untrusted".into()))?;
    let (config, grace) = config::load(&layout.home).map_err(|e| (2, e.to_string()))?;
    layout.grace = grace;
    let host = Arc::new(
        RpcHost::new(layout.home.clone(), layout.token().to_owned(), config)
            .with_platform(platform::capabilities()),
    );
    let engine = Arc::new(ProcessEngine::new(host, seam).map_err(|e| (2, e.to_string()))?);
    #[cfg(unix)]
    {
        // SAFETY: the CLI process has no children yet. A separate group keeps terminal signals out of future children.
        let result = unsafe { libc::setpgid(0, 0) };
        if result != 0 {
            // A session/group leader is already isolated; any other refusal is a startup failure.
            // SAFETY: getpgrp and getpid have no preconditions and cannot fail.
            if unsafe { libc::getpgrp() != libc::getpid() } {
                return Err((2, "engine process group unavailable".into()));
            }
        }
    }
    server::serve(
        engine,
        &layout,
        if lifeline.is_some() {
            Lifeline::Stdin
        } else {
            Lifeline::None
        },
    )
    .map_err(|e| {
        let code = if matches!(e, ServeError::Locked) {
            3
        } else {
            2
        };
        (code, e.to_string())
    })
}

fn main() -> ExitCode {
    match run(Cli::parse().command) {
        Ok(()) => ExitCode::SUCCESS,
        Err((code, message)) => {
            // Only fixed, bounded diagnostic categories reach stderr; request data and tokens never do.
            let _ = writeln!(io::stderr().lock(), "plur1bus-engine: {message}");
            ExitCode::from(code)
        }
    }
}
