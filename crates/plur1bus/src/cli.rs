use clap::{Args, Parser, Subcommand, ValueEnum};
use std::path::PathBuf;

/// Leaf command paths (space-joined, e.g. `"memory add"`) exempt from the `[experimental]`
/// stability mark — the only CLI surface ADR-016 §4/G14 calls stable. Every other implemented
/// leaf command's `about` starts with `[experimental] `; a stub names its milestone instead
/// (`M2`, `M3`, `M4` or `M8`) and is exempt for that reason (see the
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
    /// [experimental] Install the harness: Node runtime, core, config, skills, OS service, start and first check
    ///
    /// Downloads the pinned Node runtime and the core payload and verifies their SHA-256 hashes, writes the config
    /// (asking only the basic-tier questions), copies the bundled skills, registers the OS service, starts the
    /// supervisor and runs `1staid check`. Safe to run again: a step whose result is already installed is skipped.
    Setup(SetupArgs),
    /// Check and repair the installation
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
    /// [experimental] Update check: what a release would change and which units would restart (`--check`)
    ///
    /// Applying an update is M8; without `--check` the command answers that milestone.
    Update(UpdateArgs),
    /// Users — M2
    User(StubArgs),
    /// [experimental] Models and provider profiles: list, scan and override
    Model {
        #[command(subcommand)]
        sub: ModelCmd,
    },
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
    /// Skills from packages, folders or archives: list, show, install, uninstall, restore, enable, disable
    Skill {
        #[command(subcommand)]
        sub: SkillCmd,
    },
    /// Plugins (modules and channels) from packages: list, show, install, uninstall, restore, enable, disable
    Plugin {
        #[command(subcommand)]
        sub: PluginCmd,
    },
    /// Extension packages (`.p1x`): inspect, pack, verify
    Ext {
        #[command(subcommand)]
        cmd: ExtCmd,
    },
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
    /// Source root (default: $OPENCLAW_STATE_DIR / $OPENCLAW_PROFILE / ~/.openclaw, or $HERMES_HOME / ~/.hermes, %LOCALAPPDATA%\hermes on Windows); a \\wsl$\<distro>\... or \\wsl.localhost\<distro>\... path reads a WSL-hosted source
    #[arg(long, value_name = "PATH")]
    pub source: Option<PathBuf>,
    /// Map paths in the source's config that start with SOURCE to LOCAL (repeatable), for paths the importer cannot map itself
    #[arg(long = "map", value_name = "SOURCE=LOCAL", conflicts_with = "rollback", value_parser = clap::value_parser!(std::ffi::OsString))]
    pub map: Vec<std::ffi::OsString>,
    /// Hermes only: import one named profile instead of the root and every profile
    #[arg(long, value_name = "NAME")]
    pub profile: Option<String>,
    /// Write (with --skills, --rollback, or full import); without it nothing is written
    #[arg(long)]
    pub apply: bool,
    /// With --skills: enable the imported skills (default: they land disabled)
    #[arg(long)]
    pub enable: bool,
    /// What to do when an id or file already exists in the harness (skip, rename, replace)
    #[arg(
        long = "on-conflict",
        alias = "conflict",
        value_enum,
        value_name = "MODE"
    )]
    pub on_conflict: Option<OnConflict>,
    /// Refused before M2 secret store is available
    #[arg(long = "migrate-secrets")]
    pub migrate_secrets: bool,
    /// With --skills: refuse skill folders larger than this (default 8 MiB)
    #[arg(long, value_name = "BYTES")]
    pub max_skill_bytes: Option<u64>,
    /// Resume an interrupted import run by run ID
    #[arg(long, value_name = "RUN_ID")]
    pub resume: Option<String>,
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

/// `plur1bus setup` (spec §6.5, HB11).
#[derive(Args, Debug)]
pub struct SetupArgs {
    /// Never prompt: answers come from the flags and the defaults (agent `main`, use class `general`)
    #[arg(long)]
    pub non_interactive: bool,
    /// Accept the non-commercial licence of the default models (asked for unless the use class is commercial)
    #[arg(long)]
    pub accept_nc_licence: bool,
    /// Do not register the OS service (the supervisor is still started for this session)
    #[arg(long)]
    pub no_service: bool,
    /// Install the core from this directory or .tar.gz instead of the release payload
    #[arg(long, value_name = "DIR|TAR.GZ")]
    pub core_from: Option<PathBuf>,
    /// Release channel recorded in the install manifest
    #[arg(long, value_name = "CHANNEL", value_parser = ["stable", "beta"], default_value = "stable")]
    pub channel: String,
    /// Embedding use class (default: general for a new home; an existing home keeps its recorded class)
    #[arg(long, value_name = "CLASS", value_parser = ["general", "research", "commercial"])]
    pub use_class: Option<String>,
    /// The first agent's id (default: main)
    #[arg(long, value_name = "ID")]
    pub agent: Option<String>,
    /// Install profile: host (supervisor and core only, for Hermes host mode) or full (default for a new home; an existing home keeps its profile)
    #[arg(long, value_name = "PROFILE", value_parser = ["host", "full"])]
    pub profile: Option<String>,
}

/// `plur1bus update` (spec §6.5, HB10).
#[derive(Args, Debug)]
pub struct UpdateArgs {
    /// Compare the installation with the release manifest and print the plan; changes nothing
    #[arg(long)]
    pub check: bool,
    /// Release manifest to compare with, a path or an https URL (default: the channel's signed release feed)
    #[arg(long, value_name = "PATH|URL")]
    pub manifest: Option<String>,
    /// Release channel (default: the installed one)
    #[arg(long, value_name = "CHANNEL", value_parser = ["stable", "beta"])]
    pub channel: Option<String>,
}

/// `plur1bus 1staid repair` (spec §6.6, HB16).
#[derive(Args, Debug)]
pub struct RepairArgs {
    /// Confirm every step of the plan without asking (required outside a terminal)
    #[arg(long)]
    pub yes: bool,
    /// Print the plan and change nothing
    #[arg(long)]
    pub dry_run: bool,
    /// Plan only this step (repeatable)
    #[arg(long = "only", value_name = "STEP_ID")]
    pub only: Vec<String>,
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
    /// [experimental] Repair what `1staid check` finds: prints the plan, then applies the confirmed steps
    Repair(RepairArgs),
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
pub enum ModelCmd {
    /// [experimental] List the model catalog (reads the file read-only when the core is down)
    List {
        #[arg(long)]
        provider: Option<String>,
        #[arg(long)]
        kind: Option<String>,
        #[arg(long)]
        status: Option<String>,
        #[arg(long)]
        new: bool,
        #[arg(long, requires = "new")]
        ack: bool,
    },
    /// [experimental] Scan configured providers for their current models (non-zero exit when a selected provider failed)
    Scan {
        #[arg(long)]
        provider: Option<String>,
    },
    /// [experimental] Set or clear a person's values on a model, create or remove a manual entry
    Override {
        provider: String,
        id: String,
        #[arg(long)]
        name: Option<String>,
        #[arg(long)]
        kind: Option<String>,
        #[arg(long, value_name = "N")]
        context_window: Option<u64>,
        #[arg(long = "capability")]
        capability: Vec<String>,
        #[arg(long = "alias")]
        alias: Vec<String>,
        #[arg(long = "clear")]
        clear: Vec<String>,
        #[arg(long)]
        clear_all: bool,
        #[arg(long, conflicts_with = "remove")]
        create: bool,
        #[arg(long)]
        remove: bool,
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

/// `--state` of `skill list` and `plugin list`.
#[derive(ValueEnum, Clone, Copy, Debug, PartialEq, Eq)]
pub enum ExtState {
    Installed,
    Enabled,
}

/// `--kind` of `plugin list`.
#[derive(ValueEnum, Clone, Copy, Debug, PartialEq, Eq)]
pub enum PluginKind {
    Module,
    Channel,
}

/// The install flags `skill install` and `plugin install` share.
#[derive(Args, Debug, Clone)]
pub struct InstallFlags {
    /// Acknowledge that the package is not signed (with --yes; a terminal asks instead)
    #[arg(long)]
    pub allow_unsigned: bool,
    /// Acknowledge that the package is signed by a key this harness does not trust (with --yes; a terminal asks)
    #[arg(long)]
    pub allow_unknown_signer: bool,
    /// Acknowledge that the package is a lower version than the installed one (with --yes; a terminal asks)
    #[arg(long)]
    pub allow_downgrade: bool,
    /// Only inspect: print the disclosure (`ext.inspect/1` with --json) and install nothing
    #[arg(long)]
    pub dry_run: bool,
    /// Do not ask (required outside a terminal); acknowledges the capabilities, but never a trust tier or a downgrade:
    /// those need their --allow-* flag
    #[arg(long)]
    pub yes: bool,
}

/// `plur1bus skill` (spec §10.1).
#[derive(Subcommand, Debug)]
pub enum SkillCmd {
    /// [experimental] List the installed skills: version, state, source, trust and the agents that have each
    List {
        /// Only the skills this agent has
        #[arg(long, value_name = "ID")]
        agent: Option<String>,
        /// Only the skills from this source (file, bundled, local, or an import source)
        #[arg(long, value_name = "SOURCE")]
        source: Option<String>,
        #[arg(long, value_enum)]
        state: Option<ExtState>,
    },
    /// [experimental] Show one skill: its package, trust, capabilities, scripts, files and trash entries
    Show { name: String },
    /// [experimental] Install a skill from a `.p1x`, a `.skill`, a `.zip`, a folder or stdin (`-`), disabled
    ///
    /// Inspects the package first and prints the disclosure: trust tier and why, signer key, id, version, publisher,
    /// licence, every capability, every script with its size and first line, the runtime, the secrets and what it
    /// replaces. A terminal asks once; with --yes the matching --allow-* flag acknowledges an unsigned, unknown-signer
    /// or downgrade package. A folder, `.zip` or `.skill` becomes an unsigned package. `--enable` enables it in the
    /// same step (for the listed agents only, with `--enable=bernd,anna`).
    Install {
        /// `.p1x`, `.skill`, `.zip`, a skill folder, or `-` for a `.p1x` on stdin
        path: String,
        /// Enable it right away, for every agent or (with `=<agent,…>`) only for those
        #[arg(long, num_args = 0..=1, require_equals = true, value_delimiter = ',', value_name = "AGENT")]
        enable: Option<Vec<String>>,
        #[command(flatten)]
        flags: InstallFlags,
    },
    /// [experimental] Uninstall a skill into the trash (a bundled skill is hidden instead)
    Uninstall {
        name: String,
        /// Also move its data (data/ext/<name>) and its configuration to the trash (asks separately)
        #[arg(long)]
        purge: bool,
        /// Disable the enabled extensions that need it first, instead of refusing
        #[arg(long)]
        cascade: bool,
        /// Do not ask (required outside a terminal)
        #[arg(long)]
        yes: bool,
    },
    /// [experimental] Restore a skill from the trash (disabled)
    Restore {
        #[arg(value_name = "TRASH_ID")]
        trash_id: String,
    },
    /// [experimental] Enable a skill, for every agent or only the listed ones (prints its capabilities first)
    Enable {
        name: String,
        /// Only for this agent (repeatable); every other configured agent has it blocked
        #[arg(long = "agent", value_name = "ID")]
        agents: Vec<String>,
        /// Acknowledge the capabilities without asking (required outside a terminal)
        #[arg(long)]
        yes: bool,
    },
    /// [experimental] Disable a skill, everywhere or only for the listed agents
    Disable {
        name: String,
        /// Only for this agent (repeatable)
        #[arg(long = "agent", value_name = "ID")]
        agents: Vec<String>,
        /// Do not ask (required outside a terminal)
        #[arg(long)]
        yes: bool,
    },
}

/// `plur1bus plugin` (spec §10.1): modules and channels from packages.
#[derive(Subcommand, Debug)]
pub enum PluginCmd {
    /// [experimental] List the installed modules and channels: version, state, source, trust and overlays
    List {
        #[arg(long, value_enum)]
        kind: Option<PluginKind>,
        #[arg(long, value_enum)]
        state: Option<ExtState>,
    },
    /// [experimental] Show one module or channel: its package, trust, capabilities, files, dependents and trash entries
    Show { name: String },
    /// [experimental] Install a module or channel from a `.p1x` or stdin (`-`), disabled
    ///
    /// Inspects the package first and prints the disclosure (see `skill install`). A module runs with the full
    /// authority of a harness process. A terminal asks once; with --yes the matching --allow-* flag acknowledges an
    /// unsigned, unknown-signer or downgrade package.
    Install {
        /// `.p1x`, or `-` for one on stdin
        path: String,
        /// Enable it right away
        #[arg(long)]
        enable: bool,
        #[command(flatten)]
        flags: InstallFlags,
    },
    /// [experimental] Stop and uninstall a module or channel into the trash
    Uninstall {
        name: String,
        /// Also move its data (data/ext/<name>) and its configuration section to the trash (asks separately)
        #[arg(long)]
        purge: bool,
        /// Disable the enabled modules that need it first, instead of refusing
        #[arg(long)]
        cascade: bool,
        /// Do not ask (required outside a terminal)
        #[arg(long)]
        yes: bool,
    },
    /// [experimental] Restore a module or channel from the trash (disabled)
    Restore {
        #[arg(value_name = "TRASH_ID")]
        trash_id: String,
    },
    /// [experimental] Enable a module or channel: prints its capabilities and the restart plan first
    Enable {
        name: String,
        /// Acknowledge the capabilities without asking (required outside a terminal)
        #[arg(long)]
        yes: bool,
    },
    /// [experimental] Disable a module or channel: prints the modules that will be held back first
    Disable {
        name: String,
        /// Do not ask (required outside a terminal)
        #[arg(long)]
        yes: bool,
    },
}

/// `plur1bus ext`.
#[derive(Subcommand, Debug)]
pub enum ExtCmd {
    /// [experimental] Inspect a package (`.p1x`, skill folder, `.zip`, `.skill`, or `-`) and print the disclosure
    Inspect {
        /// `.p1x`, `.skill`, `.zip`, a skill folder, or `-` for a `.p1x` on stdin
        path: String,
    },
    /// [experimental] Build a `.p1x` from a directory holding p1x.template.json and payload/ (or a skill folder)
    ///
    /// Fills `files`, `scripts` and `created`, and writes the package deterministically. A directory with a SKILL.md
    /// and no template is normalised into an unsigned skill package. Needs no home. Signing is a separate step.
    Pack {
        dir: PathBuf,
        /// Where to write the package (default: ./<name>-<version>.p1x)
        #[arg(short = 'o', long = "output", value_name = "FILE")]
        output: Option<PathBuf>,
    },
    /// [experimental] Verify a `.p1x` without a home: layout, hashes, signature, manifest and compatibility
    ///
    /// Trusts only the pinned keys, checks no revocations and no installed names. Exit 1 with the reason when the
    /// package is refused.
    Verify { file: PathBuf },
    /// Package worker (internal: the supervisor's child for inspect and stage, X1-R2)
    #[command(name = "__worker", hide = true)]
    Worker {
        #[command(subcommand)]
        op: crate::ext::stage::WorkerArgs,
    },
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
    const STUB_MILESTONES: &[&str] = &["M2", "M3", "M4", "M8"];

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

    fn parse(args: &[&str]) -> Cli {
        Cli::try_parse_from(std::iter::once("plur1bus").chain(args.iter().copied()))
            .unwrap_or_else(|e| panic!("{args:?}: {e}"))
    }

    #[test]
    fn setup_update_repair_parse_their_flags() {
        match parse(&["setup"]).cmd {
            Cmd::Setup(a) => {
                assert!(!a.non_interactive && !a.accept_nc_licence && !a.no_service);
                assert_eq!(a.channel, "stable");
                assert_eq!((a.core_from, a.use_class, a.agent), (None, None, None));
            }
            other => panic!("{other:?}"),
        }
        match parse(&[
            "setup",
            "--non-interactive",
            "--accept-nc-licence",
            "--no-service",
            "--core-from",
            "/tmp/p1b A/core",
            "--channel",
            "beta",
            "--use-class",
            "research",
            "--agent",
            "bernd",
        ])
        .cmd
        {
            Cmd::Setup(a) => {
                assert!(a.non_interactive && a.accept_nc_licence && a.no_service);
                assert_eq!(a.core_from, Some(PathBuf::from("/tmp/p1b A/core")));
                assert_eq!(a.channel, "beta");
                assert_eq!(a.use_class.as_deref(), Some("research"));
                assert_eq!(a.agent.as_deref(), Some("bernd"));
            }
            other => panic!("{other:?}"),
        }
        assert!(Cli::try_parse_from(["plur1bus", "setup", "--use-class", "hobby"]).is_err());
        assert!(Cli::try_parse_from(["plur1bus", "setup", "--channel", "nightly"]).is_err());
        // HM2-R9: `--profile host|full`, absent by default (an existing home keeps its profile).
        for (args, want) in [
            (&["setup"][..], None),
            (&["setup", "--profile", "host"][..], Some("host")),
            (&["setup", "--profile", "full"][..], Some("full")),
        ] {
            match parse(args).cmd {
                Cmd::Setup(a) => assert_eq!(a.profile.as_deref(), want, "{args:?}"),
                other => panic!("{other:?}"),
            }
        }
        assert!(Cli::try_parse_from(["plur1bus", "setup", "--profile", "minimal"]).is_err());

        match parse(&["update"]).cmd {
            Cmd::Update(a) => assert!(!a.check && a.manifest.is_none() && a.channel.is_none()),
            other => panic!("{other:?}"),
        }
        match parse(&[
            "update",
            "--check",
            "--manifest",
            "https://example.invalid/stable.json",
            "--channel",
            "beta",
        ])
        .cmd
        {
            Cmd::Update(a) => {
                assert!(a.check);
                assert_eq!(
                    a.manifest.as_deref(),
                    Some("https://example.invalid/stable.json")
                );
                assert_eq!(a.channel.as_deref(), Some("beta"));
            }
            other => panic!("{other:?}"),
        }
        assert!(Cli::try_parse_from(["plur1bus", "update", "check"]).is_err());

        match parse(&[
            "1staid",
            "repair",
            "--yes",
            "--dry-run",
            "--only",
            "run.permissions.fix",
            "--only",
            "config.restore",
        ])
        .cmd
        {
            Cmd::FirstAid {
                sub: FirstAidCmd::Repair(a),
            } => {
                assert!(a.yes && a.dry_run);
                assert_eq!(a.only, ["run.permissions.fix", "config.restore"]);
            }
            other => panic!("{other:?}"),
        }
        match parse(&["1staid", "repair"]).cmd {
            Cmd::FirstAid {
                sub: FirstAidCmd::Repair(a),
            } => {
                assert!(!a.yes && !a.dry_run && a.only.is_empty());
            }
            other => panic!("{other:?}"),
        }
    }
}
