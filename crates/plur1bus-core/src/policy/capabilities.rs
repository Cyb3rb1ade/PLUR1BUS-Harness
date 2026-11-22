//! D109 §2/§4: the capability taxonomy and every default number, in one data table (TypeScript: `policy/capabilities.ts`).
//! The table is copied row for row; the replay compares it with the TypeScript one as data.
use super::effects::Effect;
use serde_json::{json, Value};

/// `PolicyClass`.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub enum PolicyClass {
    /// Runs without asking.
    Allowed,
    /// Asks a person (or uses a grant).
    Approval,
    /// Never runs.
    Never,
}

impl PolicyClass {
    /// The TypeScript spelling.
    pub fn as_str(self) -> &'static str {
        match self {
            PolicyClass::Allowed => "allowed",
            PolicyClass::Approval => "approval",
            PolicyClass::Never => "never",
        }
    }
}

/// `stricterClass(a, b)`: the stricter of the two (`a` on a tie).
pub fn stricter_class(a: PolicyClass, b: PolicyClass) -> PolicyClass {
    if a >= b {
        a
    } else {
        b
    }
}

/// `GrantScope`, ordered by reach (`scopeRank`).
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub enum GrantScope {
    /// One action, bound to its hash.
    Once,
    /// One task.
    Task,
    /// One session.
    Session,
    /// Standing.
    Always,
}

/// `GRANT_SCOPES`, narrowest first.
pub const GRANT_SCOPES: [GrantScope; 4] = [
    GrantScope::Once,
    GrantScope::Task,
    GrantScope::Session,
    GrantScope::Always,
];

impl GrantScope {
    /// The TypeScript spelling.
    pub fn as_str(self) -> &'static str {
        match self {
            GrantScope::Once => "once",
            GrantScope::Task => "task",
            GrantScope::Session => "session",
            GrantScope::Always => "always",
        }
    }

    /// The scope a string names, if any.
    pub fn parse(s: &str) -> Option<GrantScope> {
        GRANT_SCOPES.into_iter().find(|g| g.as_str() == s)
    }
}

/// `Risk`, ordered (`riskRank`).
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub enum Risk {
    /// Low.
    Low,
    /// Medium.
    Medium,
    /// High.
    High,
    /// Critical.
    Critical,
}

/// `RISKS`, lowest first.
pub const RISKS: [Risk; 4] = [Risk::Low, Risk::Medium, Risk::High, Risk::Critical];

impl Risk {
    /// The TypeScript spelling.
    pub fn as_str(self) -> &'static str {
        match self {
            Risk::Low => "low",
            Risk::Medium => "medium",
            Risk::High => "high",
            Risk::Critical => "critical",
        }
    }

    /// `DEFAULTS.surfaceByRisk`.
    pub fn surface(self) -> u8 {
        match self {
            Risk::Low => 1,
            Risk::Medium | Risk::High => 2,
            Risk::Critical => 3,
        }
    }
}

const MIN: f64 = 60_000.0;
const HOUR: f64 = 60.0 * MIN;
const DAY: f64 = 24.0 * HOUR;

/// `DEFAULTS.lifetimes.onceUnusedMs`: `once` ends on use, or 10 minutes unused.
pub const ONCE_UNUSED_MS: f64 = 10.0 * MIN;
/// `DEFAULTS.lifetimes.taskMs`: `task` ends with the task, or after 24 hours.
pub const TASK_MS: f64 = 24.0 * HOUR;
/// `DEFAULTS.lifetimes.sessionIdleMs`: `session` ends with the session, or after 7 idle days.
pub const SESSION_IDLE_MS: f64 = 7.0 * DAY;
/// `DEFAULTS.lifetimes.alwaysUnusedMs` (Q13).
pub const ALWAYS_UNUSED_MS: f64 = 90.0 * DAY;
/// `DEFAULTS.reviewNudgeAgeMs` (Q13).
pub const REVIEW_NUDGE_AGE_MS: f64 = 90.0 * DAY;
/// `DEFAULTS.maxPromptsPerTaskPerHour` (Q15).
pub const MAX_PROMPTS_PER_TASK_PER_HOUR: f64 = 10.0;
/// `DEFAULTS.batchTargetsOver` (D106 dry run).
pub const BATCH_TARGETS_OVER: usize = 20;

/// `CapabilityDef`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct CapabilityDef {
    /// The capability id.
    pub id: &'static str,
    /// What the capability covers (documentation).
    pub covers: &'static str,
    /// The lowest effect this capability can have; a tool's declared effect can raise it, never lower it.
    pub intrinsic_effect: Effect,
    /// The class inside the roots.
    pub inside: PolicyClass,
    /// The class outside the roots.
    pub outside: PolicyClass,
    /// Highest grant scope; `None` = no standing grant.
    pub ceiling: Option<GrantScope>,
    /// Lowest surface that may decide; `None` = never asks.
    pub min_surface: Option<u8>,
    /// The risk before the flags.
    pub base_risk: Risk,
    /// A person may move it between allowed and approval per agent.
    pub lowerable: bool,
    /// Standing grants are suspended in a tainted turn that read private data (§8).
    pub taint_sensitive: bool,
}

impl CapabilityDef {
    /// The row as the TypeScript object.
    pub fn json(&self) -> Value {
        json!({
            "id": self.id, "covers": self.covers, "intrinsicEffect": self.intrinsic_effect.as_str(),
            "base": { "inside": self.inside.as_str(), "outside": self.outside.as_str() },
            "ceiling": self.ceiling.map(GrantScope::as_str), "minSurface": self.min_surface,
            "baseRisk": self.base_risk.as_str(), "lowerable": self.lowerable, "taintSensitive": self.taint_sensitive,
        })
    }
}

use Effect as E;
use GrantScope as G;
use PolicyClass::{Allowed as A, Approval as P, Never as N};
use Risk as R;

/// `def(...)`: `lowerable` defaults to "ceiling is not once, min surface is not 3, inside is not never".
const fn def(
    id: &'static str,
    covers: &'static str,
    intrinsic_effect: Effect,
    base: (PolicyClass, PolicyClass),
    ceiling: Option<GrantScope>,
    min_surface: Option<u8>,
    base_risk: Risk,
) -> CapabilityDef {
    let once = matches!(ceiling, Some(G::Once));
    let surface3 = matches!(min_surface, Some(3));
    let never = matches!(base.0, N);
    CapabilityDef {
        id,
        covers,
        intrinsic_effect,
        inside: base.0,
        outside: base.1,
        ceiling,
        min_surface,
        base_risk,
        lowerable: !once && !surface3 && !never,
        taint_sensitive: false,
    }
}

const fn taint(d: CapabilityDef) -> CapabilityDef {
    CapabilityDef {
        taint_sensitive: true,
        ..d
    }
}

const fn not_lowerable(d: CapabilityDef) -> CapabilityDef {
    CapabilityDef {
        lowerable: false,
        ..d
    }
}

/// The table, in the TypeScript order.
pub const CAPABILITIES: &[CapabilityDef] = &[
    def(
        "apps.launch",
        "apps.open/focus, hostctl.app.open",
        E::LocalWrite,
        (P, P),
        Some(G::Once),
        Some(2),
        R::Medium,
    ),
    def(
        "fs.read",
        "fs.list/stat/read/search",
        E::Read,
        (A, P),
        Some(G::Always),
        Some(1),
        R::Low,
    ),
    def(
        "fs.write",
        "fs.write/edit/mkdir/copy/move, fs.trash inside roots",
        E::LocalWrite,
        (A, P),
        Some(G::Always),
        Some(1),
        R::Low,
    ),
    def(
        "memory.read",
        "memory.recall within the admitted caller and agent",
        E::Read,
        (A, A),
        None,
        None,
        R::Low,
    ),
    def(
        "memory.write",
        "memory.capture within the admitted caller and session",
        E::LocalWrite,
        (A, A),
        Some(G::Always),
        Some(2),
        R::Low,
    ),
    not_lowerable(def(
        "memory.jobs.run",
        "one built-in background memory job for the grant owner and agent",
        E::LocalWrite,
        (P, P),
        Some(G::Always),
        Some(2),
        R::Medium,
    )),
    def(
        "fs.delete",
        "fs.delete, fs.trash outside roots",
        E::LocalDestructive,
        (P, P),
        Some(G::Task),
        Some(2),
        R::High,
    ),
    def(
        "shell.exec",
        "shell.*, skill scripts",
        E::LocalWrite,
        (P, P),
        Some(G::Always),
        Some(2),
        R::Medium,
    ),
    def(
        "proc.signal",
        "proc.signal/kill, apps.quit with unsaved state",
        E::LocalDestructive,
        (P, P),
        Some(G::Session),
        Some(2),
        R::Medium,
    ),
    def(
        "pkg.change",
        "pkg.install/upgrade/remove",
        E::LocalDestructive,
        (P, P),
        Some(G::Once),
        Some(2),
        R::High,
    ),
    def(
        "sys.read",
        "sys.*, proc.list",
        E::Read,
        (A, A),
        None,
        None,
        R::Low,
    ),
    def(
        "clipboard.read",
        "clipboard.read",
        E::Read,
        (P, P),
        Some(G::Session),
        Some(1),
        R::Low,
    ),
    def(
        "net.fetch",
        "web.fetch, browser.navigate/read",
        E::Read,
        (A, A),
        None,
        None,
        R::Low,
    ),
    taint(def(
        "net.submit",
        "form submission, downloads, external MCP tools, non-read-only webmcp",
        E::External,
        (P, P),
        Some(G::Session),
        Some(2),
        R::Medium,
    )),
    taint(def(
        "network.a2a",
        "outbound A2A card discovery and messages",
        E::NetworkA2a,
        (P, P),
        Some(G::Session),
        Some(2),
        R::Medium,
    )),
    def(
        "mcp.tool.read",
        "MCP tools declared read by an installed extension",
        E::Read,
        (A, A),
        None,
        None,
        R::Low,
    ),
    def(
        "mcp.tool.write",
        "MCP tools declared local write by an installed extension",
        E::LocalWrite,
        (P, P),
        Some(G::Session),
        Some(2),
        R::Medium,
    ),
    def(
        "mcp.tool.destructive",
        "MCP tools declared destructive or raised by server annotations",
        E::LocalDestructive,
        (P, P),
        Some(G::Once),
        Some(2),
        R::High,
    ),
    taint(def(
        "comm.send",
        "mail/messages/posts as the person",
        E::External,
        (P, P),
        Some(G::Session),
        Some(2),
        R::High,
    )),
    taint(def(
        "net.publish",
        "tailnet / public publishing",
        E::External,
        (P, P),
        Some(G::Always),
        Some(2),
        R::High,
    )),
    def(
        "money.spend",
        "purchases, paid top-ups, money tools",
        E::Money,
        (P, P),
        Some(G::Once),
        Some(3),
        R::Critical,
    ),
    def(
        "os.privilege",
        "sudo, doas, pkexec, polkit, UAC, runas",
        E::LocalDestructive,
        (P, P),
        Some(G::Once),
        Some(3),
        R::Critical,
    ),
    def(
        "os.grant",
        "TCC / privacy toggles / portals",
        E::LocalWrite,
        (P, P),
        Some(G::Always),
        Some(3),
        R::High,
    ),
    def(
        "os.script",
        "os.shortcuts.run, os.script.run",
        E::LocalWrite,
        (P, P),
        Some(G::Session),
        Some(2),
        R::Medium,
    ),
    def(
        "screen.capture",
        "screen.capture",
        E::Read,
        (P, P),
        Some(G::Session),
        Some(2),
        R::Medium,
    ),
    def(
        "ui.control",
        "ui.*",
        E::LocalWrite,
        (P, P),
        Some(G::Session),
        Some(2),
        R::High,
    ),
    def(
        "secrets.use",
        "leasing a secret slot into a tool or script",
        E::Read,
        (A, A),
        None,
        None,
        R::Low,
    ),
    def(
        "agent.delegate",
        "delegate/handoff, MoA",
        E::Read,
        (A, A),
        None,
        None,
        R::Low,
    ),
    def(
        "remote.control",
        "D108 session start",
        E::External,
        (P, P),
        Some(G::Always),
        Some(3),
        R::Critical,
    ),
    def(
        "hostctl.fs.trash",
        "hostctl.fs.trash inside roots, native Trash only",
        E::LocalDestructive,
        (P, P),
        Some(G::Task),
        Some(2),
        R::Medium,
    ),
    def(
        "hostctl.proc.session.read",
        "owned process-session list/output",
        E::Read,
        (A, A),
        Some(G::Session),
        Some(1),
        R::Low,
    ),
    def(
        "hostctl.proc.session.write",
        "stdin of an owned process session",
        E::LocalWrite,
        (P, P),
        Some(G::Session),
        Some(2),
        R::Medium,
    ),
    def(
        "hostctl.proc.kill_foreign",
        "signal foreign PID, separate approval",
        E::LocalDestructive,
        (P, P),
        Some(G::Once),
        Some(2),
        R::High,
    ),
    def(
        "harness.admin",
        "config writes, extension install/enable, grants and approvals themselves",
        E::LocalWrite,
        (N, N),
        None,
        None,
        R::Critical,
    ),
    def(
        "credential.entry",
        "typing passwords or OTPs into any UI",
        E::External,
        (N, N),
        None,
        None,
        R::Critical,
    ),
    def(
        "captcha.solve",
        "solving CAPTCHAs",
        E::External,
        (N, N),
        None,
        None,
        R::Critical,
    ),
    def(
        "input.monitor",
        "keystroke capture",
        E::Read,
        (N, N),
        None,
        None,
        R::Critical,
    ),
    def(
        "policy.bypass",
        "disabling the sandbox, editing the policy or the store",
        E::LocalWrite,
        (N, N),
        None,
        None,
        R::Critical,
    ),
];

/// `CAPABILITIES.get(id)`: an exact id (callers fold the case first).
pub fn capability(id: &str) -> Option<&'static CapabilityDef> {
    CAPABILITIES.iter().find(|d| d.id == id)
}

/// `NEVER_CAPABILITIES`: no agent, grant, override or surface ever reaches these.
pub fn never_capabilities() -> Vec<&'static str> {
    CAPABILITIES
        .iter()
        .filter(|d| d.inside == N)
        .map(|d| d.id)
        .collect()
}
