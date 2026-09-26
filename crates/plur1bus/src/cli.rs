use clap::{Args, Parser, Subcommand};
use std::path::PathBuf;

/// Leaf command paths (space-joined, e.g. `"memory add"`) exempt from the `[experimental]`
/// stability mark — the only CLI surface ADR-016 §4/G14 calls stable. Every other implemented
/// leaf command's `about` starts with `[experimental] `; a stub names its milestone instead
/// (`2a-H3`, `M2`, `M3`, `M4`, `M1b-3` or `M8`) and is exempt for that reason (see the
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
    /// Install the harness (runtime, service registration) — 2a-H3
    Setup(StubArgs),
    /// Check and repair the installation — 2a-H3
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
    /// Modules — 2a-H3
    Module(StubArgs),
    /// Supervisor control — 2a-H3
    Daemon(StubArgs),
    /// OS service registration — 2a-H3
    Service(StubArgs),
    /// Core process (internal)
    Core {
        #[command(subcommand)]
        sub: CoreCmd,
    },
    /// Update check — 2a-H3
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
    /// Check the installation for problems — 2a-H3
    Check,
    /// Repair a broken installation — 2a-H3
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
pub enum CoreCmd {
    /// [experimental] Run the core in the foreground (the supervisor's spawn target — 2a-H3)
    Run,
}

#[cfg(test)]
mod tests {
    use super::*;
    use clap::CommandFactory;

    /// Milestone tags a stub command's `about` names (gen-docs.mjs's cli.md intro; G1).
    const STUB_MILESTONES: &[&str] = &["2a-H3", "M1b-3", "M2", "M3", "M4", "M8"];

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
