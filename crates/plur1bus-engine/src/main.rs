//! The supervised engine process. Lifecycle and transport follow ADR-012 §10.
use clap::{Parser, Subcommand, ValueEnum};
use plur1bus_engine::rpc::{
    config, diagnostics,
    engine::ProcessEngine,
    host_client::RpcHost,
    layout::EngineLayout,
    lifeline::Lifeline,
    maintenance::ProcessMaintenance,
    platform, seams,
    server::{self, ServeError},
    snapshot::ProcessSnapshots,
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
    let fixture_clock =
        seams::fixture_clock(std::env::var_os("PLUR1BUS_TEST_CLOCK_MS").as_deref(), seam)
            .map_err(|e| (2, e.to_string()))?;
    let mut layout = EngineLayout::new(
        &home,
        instance.unwrap_or_else(uuid::Uuid::new_v4).to_string(),
    )
    .map_err(|_| (2, "engine home is unavailable or untrusted".into()))?;
    let (config, grace) = config::load(&layout.home).map_err(|e| (2, e.to_string()))?;
    layout.grace = grace;
    let host = Arc::new(
        RpcHost::new_at(
            layout.home.clone(),
            layout.core_address.clone(),
            layout.token().to_owned(),
            config,
        )
        .with_platform(platform::capabilities())
        .with_fixture_clock(fixture_clock),
    );
    let completions = host.clone();
    let complete: Arc<plur1bus_engine::jobs::llm::CompleteFor> =
        Arc::new(move |agent, params, cancel| completions.complete_for(agent, params, cancel));
    let engine = ProcessEngine::with_job_completion(host.clone(), seam, &complete)
        .map_err(|e| (2, e.to_string()))?;
    let engine = Arc::new(if fixture_clock.is_some() {
        engine.with_fixture_tombstone_ids()
    } else {
        engine
    });
    let weak_engine = Arc::downgrade(&engine);
    host.set_egress_invalidator(Arc::new(move || {
        if let Some(engine) = weak_engine.upgrade() {
            engine.invalidate_egress();
        }
    }));
    // RE-D170: the snapshot port reuses this engine's namespace routes and mutation gate.
    let snapshots = Arc::new(ProcessSnapshots::with_seam(
        host.clone(),
        engine.snapshot_routes(),
        seam,
    ));
    // The trusted supervisor/spawner owns process-group isolation. A hand start
    // stays in its terminal's foreground group so Ctrl-C and stdin keep working.
    server::serve_process(
        engine,
        &layout,
        if lifeline.is_some() {
            Lifeline::Stdin
        } else {
            Lifeline::None
        },
        Arc::new(ProcessMaintenance::with_seam(host.clone(), seam)),
        snapshots,
        host,
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
            // An initialized diagnostic writer may be blocked on stderr after
            // the shutdown deadline. Early startup refusals retain the human
            // fallback; runtime failures already have structured diagnostics.
            if !diagnostics::initialized() {
                let _ = writeln!(io::stderr().lock(), "plur1bus-engine: {message}");
            }
            ExitCode::from(code)
        }
    }
}
