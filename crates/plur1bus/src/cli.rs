use clap::{Args, Parser, Subcommand};
use std::path::PathBuf;

#[derive(Parser, Debug)]
#[command(
    name = "plur1bus",
    version,
    about = "PLUR1BUS harness — self-hosted multi-agent memory harness",
    propagate_version = true
)]
pub struct Cli {
    /// State root (default: ~/.plur1bus, %LOCALAPPDATA%\PLUR1BUS, or $PLUR1BUS_HOME)
    #[arg(long, global = true, value_name = "PATH")]
    pub home: Option<PathBuf>,
    /// Machine-readable output (stable shape, see docs/cli.md)
    #[arg(long, global = true)]
    pub json: bool,
    #[command(subcommand)]
    pub cmd: Cmd,
}

#[derive(Subcommand, Debug)]
pub enum Cmd {
    /// Install the harness (runtime, service registration) — H2
    Setup(StubArgs),
    /// Check and repair the installation — H2
    #[command(name = "1staid")]
    FirstAid {
        #[command(subcommand)]
        sub: FirstAidCmd,
    },
    /// Agents (personas): list, create, remove, status
    Agent {
        #[command(subcommand)]
        sub: AgentCmd,
    },
    /// Memory: add and recall through the core
    Memory {
        #[command(subcommand)]
        sub: MemoryCmd,
    },
    /// Dreaming jobs: status, run, log
    Dreams {
        #[command(subcommand)]
        sub: DreamsCmd,
    },
    /// Configuration: get, set, schema
    Config {
        #[command(subcommand)]
        sub: ConfigCmd,
    },
    /// Modules — H2
    Module(StubArgs),
    /// Supervisor control — H2
    Daemon(StubArgs),
    /// OS service registration — H2
    Service(StubArgs),
    /// Core process (internal)
    Core {
        #[command(subcommand)]
        sub: CoreCmd,
    },
    /// Update check — H2
    Update(StubArgs),
    /// Users — M2
    User(StubArgs),
    /// Models and provider profiles — M2
    Model(StubArgs),
    /// Provider login (API keys, OAuth) — M2
    Login(StubArgs),
    /// Channels — M4
    Channel(StubArgs),
    /// Projects — M3
    Project(StubArgs),
    /// Import from OpenClaw/Hermes — M1b-3
    Import(StubArgs),
    /// Uninstall — M8
    Uninstall(StubArgs),
    /// Print the CLI reference as Markdown (used by scripts/gen-docs.mjs)
    #[command(hide = true, name = "__markdown")]
    Markdown,
}

#[derive(Args, Debug)]
pub struct StubArgs {
    #[arg(trailing_var_arg = true, allow_hyphen_values = true, hide = true)]
    pub rest: Vec<String>,
}

#[derive(Subcommand, Debug)]
pub enum FirstAidCmd {
    Check,
    Repair {
        #[arg(long)]
        yes: bool,
        #[arg(long)]
        dry_run: bool,
    },
}
#[derive(Subcommand, Debug)]
pub enum AgentCmd {
    List,
    Create { id: String },
    Remove { id: String },
    Status { id: String },
}
#[derive(Subcommand, Debug)]
pub enum MemoryCmd {
    Add {
        #[arg(long)]
        agent: String,
        #[arg(long)]
        session: Option<String>,
        text: Vec<String>,
    },
    Recall {
        #[arg(long)]
        agent: String,
        #[arg(long)]
        session: Option<String>,
        #[arg(long)]
        joined: bool,
        query: Vec<String>,
    },
    List(StubArgs),
    Show(StubArgs),
    Forget(StubArgs),
    Correct(StubArgs),
    Share(StubArgs),
    State(StubArgs),
}
#[derive(Subcommand, Debug)]
pub enum DreamsCmd {
    Status {
        #[arg(long)]
        agent: Option<String>,
    },
    Run {
        job: String,
        #[arg(long)]
        agent: String,
    },
    Log {
        #[arg(long)]
        agent: String,
        #[arg(long)]
        job: Option<String>,
        #[arg(long, default_value_t = 20)]
        limit: u32,
    },
}
#[derive(Subcommand, Debug)]
pub enum ConfigCmd {
    Get {
        key: Option<String>,
    },
    Set {
        key: String,
        value: String,
        #[arg(long)]
        yes: bool,
        #[arg(long)]
        dry_run: bool,
    },
    Schema,
}
#[derive(Subcommand, Debug)]
pub enum CoreCmd {
    /// Run the core in the foreground (the supervisor's spawn target in H2)
    Run,
}
