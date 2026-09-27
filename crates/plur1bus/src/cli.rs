use clap::{Args, Parser, Subcommand, ValueEnum};
use std::path::PathBuf;

/// Leaf command paths (space-joined, e.g. `"memory add"`) exempt from the `[experimental]`
/// stability mark — the only CLI surface ADR-016 §4/G14 calls stable. Every other implemented
/// leaf command's `about` starts with `[experimental] `; a stub names its milestone instead
/// (`2a-H3b`, `M2`, `M3`, `M4` or `M8`) and is exempt for that reason (see the
/// `leaf_commands_are_stable_or_marked_experimental` test below).
/// Read by the `leaf_commands_are_stable_or_marked_experimental` test below and by anything else
/// (docs, a future `plur1bus <cmd> --help` footer) that needs the stable subset; the binary
/// itself has no other reason to reference it, hence the allow.
#[allow(dead_code)]
pub const STABLE_COMMANDS: &[&str] = &["memory add", "memory recall", "config get", "config set"];

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
    /// Install the harness (runtime, service registration) — 2a-H3b
    Setup(StubArgs),
    /// Check and repair the installation (repair — 2a-H3b)
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
    /// Modules: list, graph, install, uninstall, start, stop, restart
    Module {
        #[command(subcommand)]
        sub: ModuleCmd,
    },
    /// [experimental] Admin ops through the core: Obsidian vault setup, store migration, embedding probe and serve
    Admin {
        #[command(subcommand)]
        sub: AdminCmd,
    },
    /// Supervisor control: start, stop, restart, status
    Daemon {
        #[command(subcommand)]
        sub: DaemonCmd,
    },
    /// OS service registration of the supervisor (user context, no admin rights)
    Service {
        #[command(subcommand)]
        sub: ServiceCmd,
    },
    /// Core process (internal)
    Core {
        #[command(subcommand)]
        sub: CoreCmd,
    },
    /// Update check — 2a-H3b
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
    /// [experimental] Import from OpenClaw/Hermes: read-only --detect and the --skills import now; the full import is M7
    Import(ImportArgs),
    /// Uninstall — M8
    Uninstall(StubArgs),
    /// Print the CLI reference as Markdown (used by scripts/gen-docs.mjs)
    #[command(hide = true, name = "__markdown")]
    Markdown,
    /// Run the supervisor in the foreground (internal: started by the OS service or `daemon start`)
    #[command(hide = true)]
    Supervise {
        /// Test seam: never spawn or adopt a core (needs PLUR1BUS_ALLOW_TEST_INTERNALS=1)
        #[arg(long, hide = true)]
        no_core: bool,
    },
}

/// `plur1bus import` (docs/import.md §8, §9). Without --detect, --skills or --rollback it answers the M7 stub.
#[derive(Args, Debug)]
pub struct ImportArgs {
    /// Source system to read (never modified)
    #[arg(value_enum)]
    pub source_type: ImportSource,
    /// Read-only report: version, agents, PLUR1BUS stores and embedding identity, reranker, skills, secret presence
    #[arg(long, conflicts_with_all = ["skills", "rollback"])]
    pub detect: bool,
    /// Import the source's skills into <home>/skills (dry-run unless --apply; imported skills land disabled)
    #[arg(long, conflicts_with = "rollback")]
    pub skills: bool,
    /// Undo one --skills --apply run from its report.json (dry-run unless --apply)
    #[arg(long, value_name = "REPORT")]
    pub rollback: Option<PathBuf>,
    /// Source root (default: $OPENCLAW_STATE_DIR / $OPENCLAW_PROFILE / ~/.openclaw, or $HERMES_HOME / ~/.hermes)
    #[arg(long, value_name = "PATH")]
    pub source: Option<PathBuf>,
    /// Hermes only: import one named profile instead of the root and every profile
    #[arg(long, value_name = "NAME")]
    pub profile: Option<String>,
    /// Write (with --skills or --rollback); without it nothing is written
    #[arg(long)]
    pub apply: bool,
    /// With --skills: enable the imported skills (default: they land disabled)
    #[arg(long)]
    pub enable: bool,
    /// With --skills: what to do when a skill id already exists in the harness
    #[arg(long, value_enum, value_name = "MODE")]
    pub on_conflict: Option<OnConflict>,
    /// With --skills: refuse skill folders larger than this (default 8 MiB)
    #[arg(long, value_name = "BYTES")]
    pub max_skill_bytes: Option<u64>,
}

#[derive(ValueEnum, Clone, Copy, Debug, PartialEq, Eq)]
pub enum ImportSource {
    Openclaw,
    Hermes,
}

#[derive(ValueEnum, Clone, Copy, Debug, PartialEq, Eq)]
pub enum OnConflict {
    /// Keep the harness's skill (default)
    Skip,
    /// Import as <id>-<source>
    Rename,
    /// Replace it; the old folder is kept under <home>/imports/<run>/replaced
    Replace,
}

#[derive(Args, Debug)]
pub struct StubArgs {
    #[arg(trailing_var_arg = true, allow_hyphen_values = true, hide = true)]
    pub rest: Vec<String>,
}

#[derive(Subcommand, Debug)]
pub enum FirstAidCmd {
    /// [experimental] Read-only diagnostics over the installation (spec §6.6)
    Check,
    /// Repair a broken installation — 2a-H3b
    Repair {
        #[arg(long)]
        yes: bool,
        #[arg(long)]
        dry_run: bool,
    },
}
#[derive(Subcommand, Debug)]
pub enum AgentCmd {
    /// [experimental] List registered agents
    List,
    /// [experimental] Register a new agent
    Create { id: String },
    /// [experimental] Remove an agent from the registry (data is kept)
    Remove { id: String },
    /// [experimental] Show an agent's activity and workspace
    Status { id: String },
}
#[derive(Subcommand, Debug)]
pub enum MemoryCmd {
    /// Capture a memory through the core (stable, ADR-016 §4)
    Add {
        #[arg(long)]
        agent: String,
        /// session key; used for capture context only until the session store lands (M1b-2c)
        #[arg(long)]
        session: Option<String>,
        text: Vec<String>,
    },
    /// Recall relevant memory blocks through the core (stable, ADR-016 §4)
    Recall {
        #[arg(long)]
        agent: String,
        /// session key; used for capture context only until the session store lands (M1b-2c)
        #[arg(long)]
        session: Option<String>,
        #[arg(long)]
        joined: bool,
        query: Vec<String>,
    },
    /// [experimental] List captured memory entries
    List {
        #[arg(long)]
        agent: String,
        /// filter by topic (mutually exclusive with --since/--until)
        #[arg(long, conflicts_with_all = ["since", "until"])]
        topic: Option<String>,
        /// epoch milliseconds, or a relative `<n>m|h|d` (e.g. `7d`); defaults to all history
        #[arg(long)]
        since: Option<String>,
        /// epoch milliseconds, or a relative `<n>m|h|d`
        #[arg(long, requires = "since")]
        until: Option<String>,
        #[arg(long)]
        limit: Option<u32>,
    },
    /// [experimental] Show one memory entry
    Show {
        #[arg(long)]
        agent: String,
        id: String,
    },
    /// [experimental] Forget (redact) a memory entry
    Forget {
        #[arg(long)]
        agent: String,
        id: String,
        /// skip the confirmation prompt (required outside a terminal)
        #[arg(long)]
        yes: bool,
    },
    /// [experimental] Correct a memory entry
    Correct {
        #[arg(long)]
        agent: String,
        id: String,
        #[arg(required = true)]
        text: Vec<String>,
    },
    /// [experimental] Share a memory entry with another agent
    Share {
        #[arg(long)]
        agent: String,
        id: String,
        #[arg(long, value_enum)]
        to: ShareTarget,
        /// share even if the memory is marked sensitive (otherwise a TTY prompts for it)
        #[arg(long)]
        allow_sensitive: bool,
    },
    /// [experimental] Memory subsystem state
    State {
        #[arg(long)]
        agent: String,
    },
    /// [experimental] Propose a correction to a shared memory
    Propose {
        #[arg(long)]
        agent: String,
        shared_id: String,
        #[arg(long)]
        note: Option<String>,
        #[arg(required = true)]
        text: Vec<String>,
    },
    /// [experimental] List, accept or reject shared-memory correction proposals
    Proposals {
        #[command(subcommand)]
        sub: ProposalsCmd,
    },
}

#[derive(clap::ValueEnum, Clone, Debug)]
pub enum ShareTarget {
    Workspace,
    User,
}

#[derive(clap::ValueEnum, Clone, Debug)]
pub enum ProposalStatus {
    Pending,
    Accepted,
    Rejected,
    Stale,
}

#[derive(Subcommand, Debug)]
pub enum ProposalsCmd {
    /// [experimental] List shared-memory correction proposals
    List {
        #[arg(long)]
        agent: String,
        #[arg(long, value_enum)]
        status: Option<ProposalStatus>,
        #[arg(long)]
        limit: Option<u32>,
    },
    /// [experimental] Accept a proposal
    Accept {
        #[arg(long)]
        agent: String,
        proposal_id: String,
    },
    /// [experimental] Reject a proposal
    Reject {
        #[arg(long)]
        agent: String,
        proposal_id: String,
        #[arg(long)]
        note: Option<String>,
    },
}
#[derive(Subcommand, Debug)]
pub enum DreamsCmd {
    /// [experimental] Dreaming job status and breaker state
    Status {
        #[arg(long)]
        agent: Option<String>,
    },
    /// [experimental] Run a dreaming job now
    Run {
        job: String,
        #[arg(long)]
        agent: String,
    },
    /// [experimental] Dreaming job run history
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
    /// Get a config value (stable, ADR-016 §4)
    Get {
        #[arg(conflicts_with = "tier")]
        key: Option<String>,
        /// print only the keys in this tier (D29); mutually exclusive with KEY
        #[arg(long, value_enum, conflicts_with = "key")]
        tier: Option<TierArg>,
    },
    /// Set a config value (stable, ADR-016 §4)
    Set {
        key: String,
        value: String,
        #[arg(long)]
        yes: bool,
        #[arg(long)]
        dry_run: bool,
    },
    /// [experimental] Print the config JSON Schema
    Schema {
        /// filter the schema to one tier (D29)
        #[arg(long, value_enum, default_value = "all")]
        tier: TierFilter,
    },
}

#[derive(clap::ValueEnum, Clone, Copy, Debug)]
pub enum TierArg {
    Basic,
    Advanced,
}

impl From<TierArg> for plur1bus_config::Tier {
    fn from(t: TierArg) -> Self {
        match t {
            TierArg::Basic => plur1bus_config::Tier::Basic,
            TierArg::Advanced => plur1bus_config::Tier::Advanced,
        }
    }
}

#[derive(clap::ValueEnum, Clone, Copy, Debug)]
pub enum TierFilter {
    All,
    Basic,
    Advanced,
}
#[derive(Subcommand, Debug)]
pub enum ServiceCmd {
    /// [experimental] Register the supervisor with the OS service manager and start it
    Install {
        /// register only; the service starts at the next login
        #[arg(long)]
        no_start: bool,
        /// Extra environment for the service, KEY=VALUE (internal; not supported on Windows)
        #[arg(long = "env", hide = true, value_name = "KEY=VALUE")]
        env: Vec<String>,
    },
    /// [experimental] Stop and unregister the supervisor's OS service
    Uninstall,
    /// [experimental] Show whether the OS service is registered and running
    Status,
}

#[derive(Subcommand, Debug)]
pub enum ModuleCmd {
    /// [experimental] List the installed modules and their state
    ///
    /// One line per module under `modules/`: name, version, priority and band, scope, whether
    /// `modules.<name>.enabled` lets it run, its supervised state (while a supervisor runs) and why it cannot start.
    List,
    /// [experimental] Show the module dependency graph
    ///
    /// The modules as a tree by priority band (needs and consumes edges under each), then the needs-cycles and what
    /// does not resolve.
    Graph,
    /// [experimental] Install a module from a directory (copied into modules/<name>)
    ///
    /// Refused, with nothing copied, when the directory holds a symlink, the manifest is invalid, names a reserved
    /// module (core, supervisor) or has an entry outside the directory. A running module of that name is restarted.
    Install { path: PathBuf },
    /// [experimental] Stop and remove an installed module (its config section stays)
    Uninstall {
        name: String,
        /// skip the confirmation prompt (required outside a terminal)
        #[arg(long)]
        yes: bool,
    },
    /// [experimental] Start a module (needs a running supervisor)
    Start { name: String },
    /// [experimental] Stop a module until `module start` or a supervisor restart (needs a running supervisor)
    ///
    /// A runtime stop only: `config set modules.<name>.enabled false` is the persistent switch.
    Stop { name: String },
    /// [experimental] Restart a module (needs a running supervisor)
    Restart { name: String },
}

#[derive(Subcommand, Debug)]
pub enum AdminCmd {
    /// [experimental] Obsidian vault setup for an agent: detect, prepare, confirm
    Obsidian {
        #[command(subcommand)]
        sub: ObsidianCmd,
    },
    /// [experimental] Migrate the memory store's schema (needs a running core)
    ///
    /// Asks first on a terminal; a script (or `--json`) needs `--yes`. Refused unless FROM is the store's current
    /// version; applying FROM = TO changes nothing. The engine offers no dry run.
    Migrate {
        /// the store's current schema version (decimal, at most 9 digits)
        #[arg(long, value_parser = clap::value_parser!(u32).range(0..=999_999_999))]
        from: u32,
        /// the schema version to migrate to (decimal, at most 9 digits)
        #[arg(long, value_parser = clap::value_parser!(u32).range(0..=999_999_999))]
        to: u32,
        /// skip the confirmation prompt (required outside a terminal)
        #[arg(long)]
        yes: bool,
    },
    /// [experimental] Embedding provider: probe, serve
    Embedding {
        #[command(subcommand)]
        sub: EmbeddingCmd,
    },
}

#[derive(Subcommand, Debug)]
pub enum ObsidianCmd {
    /// [experimental] List the Obsidian vaults the agent may use and whether each is confirmed
    ///
    /// The configured vaults, the agent's workspace and every `--candidate` (at most 20). Read-only.
    Detect {
        #[arg(long)]
        agent: String,
        /// a directory to check as a vault (repeatable)
        #[arg(long = "candidate", value_name = "PATH")]
        candidates: Vec<PathBuf>,
    },
    /// [experimental] Start the one-time confirmation of a vault: prints a nonce valid for 10 minutes
    ///
    /// Writes nothing; `admin obsidian confirm` with the nonce records the confirmation.
    Prepare {
        #[arg(long)]
        agent: String,
        vault: PathBuf,
    },
    /// [experimental] Confirm a vault with the nonce `admin obsidian prepare` printed
    Confirm {
        #[arg(long)]
        agent: String,
        nonce: String,
    },
}

#[derive(Subcommand, Debug)]
pub enum EmbeddingCmd {
    /// [experimental] Check that the embedding provider answers (exit 1 when it does not)
    Probe {
        /// call the provider again instead of answering the last successful probe
        #[arg(long)]
        refresh: bool,
    },
    /// [experimental] Serve the core's embeddings over the scoped IPC endpoint (platform default address)
    ///
    /// Serving lasts only as long as this core process: it ends when the core stops or is restarted (by the
    /// supervisor after a crash or a core-class configuration change); run it again after a restart.
    Serve {
        /// stop serving instead
        #[arg(long)]
        stop: bool,
    },
}

#[derive(Subcommand, Debug)]
pub enum DaemonCmd {
    /// [experimental] Start the supervisor (and its core) if it is not already running
    Start {
        /// return as soon as the supervisor's endpoint answers, without waiting for the core to become ready
        #[arg(long)]
        no_wait: bool,
    },
    /// [experimental] Stop the supervisor (and its core)
    Stop {
        /// milliseconds the core gets to shut down before the supervisor kills it (default: 10000)
        #[arg(long)]
        budget_ms: Option<u64>,
    },
    /// [experimental] Stop then start the supervisor
    Restart,
    /// [experimental] Supervisor and core status
    ///
    /// Prints `supervisor: <state>`, `core: <state>[: reason][; restart in N ms]` and the OS service registration.
    /// With `--json` (`daemon.status/1`), `supervisor` is always the supervisor's own entry (`process.state`, plus
    /// `instanceId`, `pid` and `uptimeMs` while it answers; `stopped` when nothing runs, `degraded` with reason
    /// `unresponsive` when it does not answer), `children` the supervised children beside it (empty unless it
    /// answers), `service` the registration, and `sharedMemory` the core's shared-memory support when the core
    /// answers.
    Status,
}

#[derive(Subcommand, Debug)]
pub enum CoreCmd {
    /// [experimental] Run the core in the foreground (the supervisor's spawn target)
    Run,
}

#[cfg(test)]
mod tests {
    use super::*;
    use clap::CommandFactory;

    /// Milestone tags a stub command's `about` names (gen-docs.mjs's cli.md intro; G1).
    const STUB_MILESTONES: &[&str] = &["2a-H3b", "M2", "M3", "M4", "M8"];

    fn collect_leaves(cmd: &clap::Command, prefix: &str, out: &mut Vec<(String, Option<String>)>) {
        let path = if prefix.is_empty() {
            cmd.get_name().to_string()
        } else {
            format!("{prefix} {}", cmd.get_name())
        };
        let children: Vec<&clap::Command> =
            cmd.get_subcommands().filter(|s| !s.is_hide_set()).collect();
        if children.is_empty() {
            out.push((path, cmd.get_about().map(|s| s.to_string())));
        } else {
            for c in children {
                collect_leaves(c, &path, out);
            }
        }
    }

    /// Every visible leaf command is either in `STABLE_COMMANDS`, a milestone stub (its `about`
    /// names the milestone that delivers it), or explicitly marked `[experimental]` (ADR-016 §4).
    #[test]
    fn leaf_commands_are_stable_or_marked_experimental() {
        let root = Cli::command();
        let mut leaves = Vec::new();
        for top in root.get_subcommands().filter(|s| !s.is_hide_set()) {
            collect_leaves(top, "", &mut leaves);
        }
        assert!(leaves.len() > 10, "sanity: expected many leaf commands");
        for (path, about) in leaves {
            let about = about.unwrap_or_default();
            let stable = STABLE_COMMANDS.contains(&path.as_str());
            let experimental = about.starts_with("[experimental]");
            let stub = STUB_MILESTONES.iter().any(|m| about.contains(m));
            assert!(
                stable || experimental || stub,
                "leaf `{path}` is neither stable, marked [experimental], nor a milestone stub (about: {about:?})"
            );
        }
    }
}
