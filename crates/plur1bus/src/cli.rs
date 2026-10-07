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
    /// Chat sessions: list, show, archive
    Session {
        #[command(subcommand)]
        sub: SessionCmd,
    },
    /// [experimental] Chat with an agent (one message, or a line-by-line conversation on stdin)
    Chat(ChatArgs),
    /// Agent Client Protocol (ACP): serve a harness agent to an editor over stdio
    Acp {
        #[command(subcommand)]
        sub: AcpCmd,
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
    /// [experimental] Backup and restore: create, verify, restore
    Backup {
        #[command(subcommand)]
        sub: BackupCmd,
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
    /// [experimental] Apply a signed release with snapshot, health gate and automatic rollback; `--check` shows the plan, `--rollback` undoes the last update
    ///
    /// Needs a verified release feed. Stops the daemon, snapshots the binary, `config.json`, the install manifest and the core payload (never the memory store), swaps, starts, and gates on `--version`, a ready core and `1staid check`; any failure restores the snapshot. A crashed update is settled by the next `update` or `daemon start`. A release that changes the Node runtime or the module set is refused: run `plur1bus setup`.
    Update(UpdateArgs),
    /// [experimental] Humans and their linked channel identities: list, add, pair, link, unlink
    ///
    /// One human across channels only by proof (D24, ADR-007): a one-time pairing code the owner confirms, or a link the
    /// owner makes by hand. Nothing is ever linked by a matching name.
    User {
        #[command(subcommand)]
        sub: UserCmd,
    },
    /// [experimental] Models and provider profiles: list, scan and override
    Model {
        #[command(subcommand)]
        sub: ModelCmd,
    },
    /// [experimental] Budgets: usage per agent and model, soft and hard limits (L8)
    Budget {
        #[command(subcommand)]
        sub: BudgetCmd,
    },
    /// [experimental] Secret store: status, set, get, rm, ls (OS keyring first, encrypted-file fallback)
    ///
    /// Values are read from stdin, never from arguments, and are printed only by `get --reveal`.
    Secret {
        #[command(subcommand)]
        sub: SecretCmd,
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
    /// Force rollback: delete user-modified files created by the import instead of keeping them
    #[arg(long)]
    pub force: bool,
    /// Take over an existing PLUR1BUS store at path using stores.adopt (default: off)
    #[arg(long = "adopt-store", value_name = "PATH")]
    pub adopt_store: Option<PathBuf>,
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

/// `plur1bus update` (spec §6.5, D78, HB10): apply a signed release (snapshot, swap, health gate, automatic
/// rollback), roll back to the last snapshot, or check what a release would change.
#[derive(Args, Debug)]
#[command(args_conflicts_with_subcommands = true)]
pub struct UpdateArgs {
    #[command(subcommand)]
    pub sub: Option<UpdateCmd>,
    /// Compare the installation with the release manifest and print the plan; changes nothing
    #[arg(long, conflicts_with = "rollback")]
    pub check: bool,
    /// Go back to the snapshot of the last applied update (binary, config, install manifest, core)
    #[arg(long)]
    pub rollback: bool,
    /// Apply without asking (required outside a terminal)
    #[arg(long)]
    pub yes: bool,
    /// Release manifest to compare with, a path or an https URL (default: the channel's signed release feed)
    #[arg(long, value_name = "PATH|URL")]
    pub manifest: Option<String>,
    /// Release channel (default: the installed one)
    #[arg(long, value_name = "CHANNEL", value_parser = ["stable", "beta"])]
    pub channel: Option<String>,
}

#[derive(Subcommand, Debug)]
pub enum UpdateCmd {
    /// [experimental] Where the last update stands: phase, outcome, whether a rollback is possible; changes nothing
    Status,
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

/// `plur1bus 1staid bundle` (M8, logging and diagnostics spec §2.9).
#[derive(Args, Debug)]
pub struct BundleArgs {
    /// Where to write the zip: a new file, or an existing directory (default: `<home>/bundles/`)
    #[arg(long, value_name = "PATH")]
    pub out: Option<std::path::PathBuf>,
    /// Keep the last N lines of each log
    #[arg(long, value_name = "N", default_value_t = crate::firstaid_bundle::DEFAULT_LINES)]
    pub lines: usize,
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
    /// [experimental] Write a redacted diagnostic zip (versions, check results, service status, config and the last
    /// log lines; never the audit log, payload capture, stores or secrets) and print its path
    Bundle(BundleArgs),
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
    /// [experimental] Re-embed the store into a new embedding model: plan, run, status, abort (M2)
    Reembed(ReembedArgs),
}

/// `memory reembed`: exactly one of `--plan`, `--run`, `--status`, `--abort`. The migration covers the whole installation
/// (the engine copies every agent's tables into one new generation) and keeps the old generation.
#[derive(clap::Args, Debug)]
#[command(group(clap::ArgGroup::new("action").required(true).multiple(false).args(["plan", "run", "status", "abort"])))]
pub struct ReembedArgs {
    /// Compare the store with --model and show what a migration would do; copies nothing
    #[arg(long)]
    pub plan: bool,
    /// Copy the planned migration into a new generation in throttled batches, validate it and switch
    #[arg(long)]
    pub run: bool,
    /// Show the migration's phase and progress
    #[arg(long)]
    pub status: bool,
    /// Stop at the next batch boundary; --run continues the same migration
    #[arg(long)]
    pub abort: bool,
    /// Target model: a pinned local embedding model id such as intfloat/multilingual-e5-small (required with --plan)
    #[arg(long, conflicts_with_all = ["run", "status", "abort"], required_if_eq("plan", "true"))]
    pub model: Option<String>,
    /// Target vector dimensions, when the model supports more than one
    #[arg(long, conflicts_with_all = ["run", "status", "abort"])]
    pub dimensions: Option<u32>,
    /// Query prefix of the target model
    #[arg(long, conflicts_with_all = ["run", "status", "abort"])]
    pub query_prefix: Option<String>,
    /// Passage prefix of the target model
    #[arg(long, conflicts_with_all = ["run", "status", "abort"])]
    pub passage_prefix: Option<String>,
    /// Milliseconds to pause between batches (default 250)
    #[arg(long, conflicts_with_all = ["run", "status", "abort"])]
    pub throttle_ms: Option<u32>,
    /// With --run: copy and validate, but do not switch to the new generation
    #[arg(long, conflicts_with_all = ["plan", "status", "abort"])]
    pub no_switch: bool,
    /// With --run: return as soon as the run has started instead of following it
    #[arg(long, conflicts_with_all = ["plan", "status", "abort"])]
    pub no_wait: bool,
    /// With --run: do not ask for confirmation (required outside a terminal)
    #[arg(long, conflicts_with_all = ["plan", "status", "abort"])]
    pub yes: bool,
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
pub enum BackupCmd {
    /// [experimental] Create a consistent, checksummed archive of this installation (needs a running core)
    ///
    /// The core stages the memory store through the engine's snapshot and every SQLite database through the SQLite
    /// backup API; config, agents, skills, modules, extensions, catalog, the capture journal and the system-job ledger are
    /// copied. The archive is private to the user. It never contains secrets: API keys stay in the OS keyring and
    /// `run/` (tokens) is never archived. Checksums detect corruption; the archive is not signed or encrypted.
    Create {
        /// where to write the archive (default: `<home>/backups/plur1bus-backup-<UTC>.tar.gz`); an existing file is never overwritten
        #[arg(long)]
        out: Option<PathBuf>,
        /// list what would be archived and where, without touching the core or writing anything
        #[arg(long)]
        dry_run: bool,
    },
    /// [experimental] Check an archive: manifest, every entry against its SHA-256, nothing extra, nothing missing
    ///
    /// Exits 1 with a `reason` (archive-corrupt, truncated, manifest-invalid, unsupported-format, unexpected-entry,
    /// checksum-mismatch, missing-entry) for an archive a restore would refuse.
    Verify {
        /// the archive
        file: PathBuf,
    },
    /// [experimental] Restore an archive into this home (the core must be stopped)
    ///
    /// Verifies first, extracts into a staging directory, then swaps each unit in by rename. Whatever is replaced is kept in
    /// `<home>/backups/pre-restore-<id>/`; a failure puts the old state back. Asks first on a terminal; a script (or
    /// `--json`) needs `--yes`. `--dry-run` prints the plan and changes nothing.
    Restore {
        /// the archive
        file: PathBuf,
        /// print what would be replaced, created and removed, without changing anything
        #[arg(long)]
        dry_run: bool,
        /// apply without asking
        #[arg(long)]
        yes: bool,
    },
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
pub enum AcpCmd {
    /// [experimental] Serve ACP (schema v1) on stdin/stdout for an editor such as Zed
    ///
    /// stdout carries only ACP JSON-RPC lines; diagnostics go to stderr and never contain prompts, model output or
    /// credentials. Each ACP session becomes one harness session of kind `acp`. Needs a running core
    /// (`plur1bus daemon start`). Not affected by `--json`.
    Serve {
        /// The agent the editor talks to (default: the only registered agent)
        #[arg(long)]
        agent: Option<String>,
    },
}

#[derive(Subcommand, Debug)]
pub enum SessionCmd {
    /// [experimental] List your chat sessions (pinned first, then by last turn)
    List {
        #[arg(long)]
        agent: Option<String>,
        /// direct, card, project, channel or acp
        #[arg(long, value_parser = ["direct", "card", "project", "channel", "acp"])]
        kind: Option<String>,
        /// Show archived sessions: `only` or `any` (default: none)
        #[arg(long, value_parser = ["only", "any"])]
        archived: Option<String>,
        /// Full-text search over titles and messages
        #[arg(long)]
        search: Option<String>,
        #[arg(long)]
        limit: Option<u32>,
    },
    /// [experimental] Show one session and its last messages
    Show {
        id: String,
        /// How many of the last messages to show
        #[arg(long, default_value_t = 20)]
        messages: u32,
    },
    /// [experimental] Archive a session (nothing is deleted)
    Archive { id: String },
}

#[derive(clap::Args, Debug)]
pub struct ChatArgs {
    /// The agent to talk to (default: the only registered agent)
    #[arg(long)]
    pub agent: Option<String>,
    /// Continue this session instead of starting a new one
    #[arg(long)]
    pub session: Option<String>,
    /// Start the chat incognito: nothing of it is remembered
    #[arg(long)]
    pub no_memory: bool,
    /// One message to send; without it, lines are read from stdin until EOF
    pub message: Option<String>,
}

#[derive(Subcommand, Debug)]
pub enum BudgetCmd {
    /// [experimental] Show usage for the current day and month and every limit with its state
    Status {
        /// only this agent's usage (and the global limits plus its own)
        #[arg(long, value_name = "ID")]
        agent: Option<String>,
    },
    /// [experimental] Set or clear a limit, or the time zone budget periods follow
    ///
    /// A limit needs `--global` or `--agent`, `--period` and `--metric`, and at least one of
    /// `--soft`, `--hard`, `--clear-soft`, `--clear-hard`. Cost values are USD (up to 6 decimals),
    /// token values are input + output tokens. A bound left out stays as it is.
    Set {
        /// the limit covers all agents together
        #[arg(long, conflicts_with = "agent")]
        global: bool,
        /// the limit covers this agent
        #[arg(long, value_name = "ID")]
        agent: Option<String>,
        /// the period the limit resets on (local calendar day or month)
        #[arg(long, value_parser = ["day", "month"])]
        period: Option<String>,
        /// what is counted: cost in USD or input + output tokens
        #[arg(long, value_parser = ["cost", "tokens"])]
        metric: Option<String>,
        /// warn (once per period) above this value
        #[arg(long, value_name = "VALUE", allow_hyphen_values = true)]
        soft: Option<String>,
        /// refuse calls that would exceed this value
        #[arg(long, value_name = "VALUE", allow_hyphen_values = true)]
        hard: Option<String>,
        /// remove the soft bound
        #[arg(long, conflicts_with = "soft")]
        clear_soft: bool,
        /// remove the hard bound
        #[arg(long, conflicts_with = "hard")]
        clear_hard: bool,
        /// an IANA time zone name the periods follow (default UTC)
        #[arg(long, value_name = "ZONE")]
        timezone: Option<String>,
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
pub enum SecretCmd {
    /// [experimental] Which backend holds the secrets (keyring or encrypted file), why, and how many
    Status,
    /// [experimental] Store a secret; the value is read from stdin (pipe it), never from an argument
    ///
    /// One trailing newline is removed. Replacing a secret revokes the leases on the old value.
    Set {
        /// the secret's name: letters, digits and . _ : / @ - (at most 128, first a letter or digit)
        name: String,
        /// refused: a value never goes in an argument (kept only so the refusal does not echo it)
        #[arg(hide = true, num_args = 0.., allow_hyphen_values = true)]
        rest: Vec<String>,
    },
    /// [experimental] Show a secret's metadata; `--reveal` prints its value (audited, owner only)
    Get {
        name: String,
        /// print the value itself (it is the only command that does)
        #[arg(long)]
        reveal: bool,
    },
    /// [experimental] Delete a secret from every available backend
    Rm {
        name: String,
        /// skip the confirmation prompt (required outside a terminal)
        #[arg(long)]
        yes: bool,
    },
    /// [experimental] List secret names (never values)
    Ls,
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
    fn session_and_chat_parse_their_flags() {
        match parse(&[
            "session",
            "list",
            "--kind",
            "card",
            "--archived",
            "any",
            "--search",
            "boiler",
            "--limit",
            "5",
        ])
        .cmd
        {
            Cmd::Session {
                sub:
                    SessionCmd::List {
                        kind,
                        archived,
                        search,
                        limit,
                        agent,
                    },
            } => {
                assert_eq!(
                    (kind.as_deref(), archived.as_deref(), search.as_deref()),
                    (Some("card"), Some("any"), Some("boiler"))
                );
                assert_eq!((limit, agent), (Some(5), None));
            }
            other => panic!("{other:?}"),
        }
        match parse(&["acp", "serve", "--agent", "bernd"]).cmd {
            Cmd::Acp {
                sub: AcpCmd::Serve { agent },
            } => assert_eq!(agent.as_deref(), Some("bernd")),
            other => panic!("{other:?}"),
        }
        match parse(&["session", "show", "ses_1"]).cmd {
            Cmd::Session {
                sub: SessionCmd::Show { id, messages },
            } => assert_eq!((id.as_str(), messages), ("ses_1", 20)),
            other => panic!("{other:?}"),
        }
        match parse(&["chat", "--agent", "bernd", "--no-memory", "hello"]).cmd {
            Cmd::Chat(a) => {
                assert_eq!(
                    (
                        a.agent.as_deref(),
                        a.session,
                        a.no_memory,
                        a.message.as_deref()
                    ),
                    (Some("bernd"), None, true, Some("hello"))
                );
            }
            other => panic!("{other:?}"),
        }
        assert!(Cli::try_parse_from(["plur1bus", "session", "list", "--kind", "bogus"]).is_err());
        assert!(
            Cli::try_parse_from(["plur1bus", "session", "list", "--archived", "exclude"]).is_err()
        );
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

#[derive(Subcommand, Debug)]
pub enum UserCmd {
    /// [experimental] List humans with their linked identities and the pairings still waiting
    Ls {
        /// Include revoked links
        #[arg(long)]
        all: bool,
    },
    /// [experimental] Create a human (an opaque id; prints it)
    Add { name: String },
    /// [experimental] One-time pairing codes: start, claim (what a channel adapter relays) and confirm
    Pair {
        #[command(subcommand)]
        sub: PairCmd,
    },
    /// [experimental] Link a channel identity to a human by hand, with no code (audited; never inferred)
    Link {
        /// The human's id (see `user ls`)
        human: String,
        #[arg(long)]
        channel: String,
        #[arg(long)]
        account: String,
        #[arg(long = "user-id")]
        user_id: String,
        /// A label for people to read; never matched on
        #[arg(long)]
        display_name: Option<String>,
    },
    /// [experimental] Revoke a link at once (the record stays for the audit trail)
    Unlink {
        /// The link's id (see `user ls`)
        link: String,
    },
}

#[derive(Subcommand, Debug)]
pub enum PairCmd {
    /// [experimental] Mint a one-time code for a human on a channel (shown once, valid 10 minutes, single use)
    Start {
        /// The human's id (see `user ls`)
        human: String,
        #[arg(long)]
        channel: String,
    },
    /// [experimental] Present a code from a channel identity, as the channel adapter does; links nothing until confirmed
    Claim {
        code: String,
        #[arg(long)]
        channel: String,
        #[arg(long)]
        account: String,
        #[arg(long = "user-id")]
        user_id: String,
        #[arg(long)]
        display_name: Option<String>,
    },
    /// [experimental] Approve (or with --reject, decline) a claimed pairing: approving links the identity
    Confirm {
        pairing: String,
        #[arg(long)]
        reject: bool,
    },
}
