//! The small fixed tables of the runtime: the stable tool offer with its fixed core (`stable-tools.ts`, N-F1 to F3), the
//! two-level category taxonomy (`categories.ts`) and the discovery metadata of the shipped tools
//! (`first-party-metadata.ts`, N-C6). Each table is held next to the TypeScript one by
//! `fixtures/parity/toolcall/{tables,stable-tools}.json`: the replay compares every row.
use super::first_party_table::SHIPPED;
use super::json::V;
use std::collections::BTreeSet;

/// The fixed discovery and read core; it has priority over what a session accumulated.
pub const CORE_TOOL_NAMES: &[&str] = &[
    "capabilities.search",
    "skill.load",
    "skill.read",
    "file.read",
    "file.list",
    "file.stat",
    "web.search",
    "web.fetch",
];

/// `StableToolOffer`: the names offered, the names left out (both sorted by code unit), and whether the fixed core
/// alone is larger than the model's limit.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct StableToolOffer {
    /// Offered.
    pub names: Vec<String>,
    /// Available but not offered.
    pub dropped: Vec<String>,
    /// The core does not fit.
    pub core_overflow: bool,
}

impl StableToolOffer {
    /// `{ names, dropped, coreOverflow }`.
    pub fn to_v(&self) -> V {
        V::obj([
            ("names", V::strs(&self.names)),
            ("dropped", V::strs(&self.dropped)),
            ("coreOverflow", V::Bool(self.core_overflow)),
        ])
    }
}

/// The taxonomy: group and children. Labels form a cacheable classifier prefix; an installation only changes index rows.
const TREE: &[(&str, &[&str])] = &[
    (
        "web",
        &[
            "browse", "research", "search", "fetch", "monitor", "extract",
        ],
    ),
    (
        "docs",
        &["create", "convert", "read", "edit", "summarise", "publish"],
    ),
    (
        "code",
        &["edit", "review", "debug", "test", "build", "navigate"],
    ),
    (
        "data",
        &[
            "analyse",
            "query",
            "visualise",
            "transform",
            "validate",
            "export",
        ],
    ),
    (
        "comm",
        &["email", "chat", "calendar", "contacts", "post", "notify"],
    ),
    (
        "files",
        &["manage", "read", "search", "archive", "sync", "share"],
    ),
    (
        "ops",
        &[
            "system", "process", "package", "network", "service", "diagnose",
        ],
    ),
    (
        "memory",
        &["manage", "recall", "capture", "correct", "share", "dream"],
    ),
    (
        "media",
        &["image", "audio", "video", "design", "transcribe", "convert"],
    ),
    (
        "life",
        &[
            "cooking", "travel", "shopping", "planning", "learning", "fitness",
        ],
    ),
    (
        "finance",
        &["research", "budget", "accounting", "purchase", "invoice"],
    ),
    (
        "project",
        &["plan", "track", "delegate", "review", "document"],
    ),
    (
        "os",
        &["apps", "shortcuts", "script", "permissions", "screen"],
    ),
    (
        "browser",
        &["navigate", "read", "interact", "download", "session"],
    ),
    (
        "plur1bus",
        &["admin", "configure", "diagnose", "import", "extensions"],
    ),
    (
        "general",
        &["chat", "explain", "translate", "rewrite", "calculate"],
    ),
];

/// Trusted discovery metadata of one shipped tool (`ToolDef["discovery"]`); the kind is always `tool`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Discovery {
    /// The category (`group.child`).
    pub category: &'static str,
    /// What the tool does.
    pub summary: &'static str,
    /// When to use it.
    pub use_when: &'static str,
    /// What it is not for.
    pub not_for: &'static str,
}

/// `stableToolOffer`, called at turn boundaries only: the fixed core first (then `memory.*`, sorted), then what the
/// session was offered before (sorted), then what is newly relevant (in its order), until the model's limit is reached.
/// `available` is already filtered by registration, agent scope and policy, so a revoked tool is never kept.
pub fn stable_tool_offer(
    available: &[String],
    previous: &[String],
    relevant: &[String],
    max_tools: usize,
) -> StableToolOffer {
    let order = |a: &&str, b: &&str| crate::js::compare_utf16(a, b);
    let mut unique: Vec<&str> = Vec::new();
    let known: BTreeSet<&str> = available.iter().map(String::as_str).collect();
    for name in available {
        if !unique.contains(&name.as_str()) {
            unique.push(name);
        }
    }
    let mut memory: Vec<&str> = unique
        .iter()
        .copied()
        .filter(|name| name.starts_with("memory."))
        .collect();
    memory.sort_by(order);
    let core: Vec<&str> = CORE_TOOL_NAMES
        .iter()
        .copied()
        .filter(|name| known.contains(name))
        .chain(memory)
        .collect();
    let mut before: Vec<&str> = previous
        .iter()
        .map(String::as_str)
        .collect::<BTreeSet<&str>>()
        .into_iter()
        .collect();
    before.sort_by(order);
    let mut admitted: Vec<&str> = Vec::new();
    for name in core
        .iter()
        .copied()
        .chain(before)
        .chain(relevant.iter().map(String::as_str))
    {
        if admitted.len() >= max_tools {
            break;
        }
        if known.contains(name) && !admitted.contains(&name) {
            admitted.push(name);
        }
    }
    let mut dropped: Vec<&str> = unique
        .iter()
        .copied()
        .filter(|name| !admitted.contains(name))
        .collect();
    dropped.sort_by(order);
    let core_overflow = core.len() > max_tools;
    admitted.sort_by(order);
    StableToolOffer {
        names: admitted.into_iter().map(str::to_owned).collect(),
        dropped: dropped.into_iter().map(str::to_owned).collect(),
        core_overflow,
    }
}

/// `CATEGORIES`: `(id, description)` of every leaf, `group.child` and `group: child`.
pub fn categories() -> Vec<(String, String)> {
    TREE.iter()
        .flat_map(|(group, children)| {
            children
                .iter()
                .map(move |child| (format!("{group}.{child}"), format!("{group}: {child}")))
        })
        .collect()
}

/// `CATEGORY_PREFIX`: `JSON.stringify(CATEGORIES)`, the stable start of a classifier prompt.
pub fn category_prefix() -> String {
    let list = categories()
        .into_iter()
        .map(|(id, description)| V::obj([("id", V::s(&id)), ("description", V::s(&description))]))
        .collect();
    V::Arr(list).stringify()
}

/// `firstPartyDiscovery`: the authored metadata of a shipped tool. An unknown or third-party name has none and stays
/// unclassified.
pub fn first_party_discovery(name: &str) -> Option<Discovery> {
    SHIPPED
        .iter()
        .find(|row| row.0 == name)
        .map(|row| Discovery {
            category: row.1,
            summary: row.2,
            use_when: row.3,
            not_for: row.4,
        })
}

/// `firstPartyToolNames`: candidate names only; a hand-off's scope, the live registry and the dispatcher's policy still
/// restrict their use.
pub fn first_party_tool_names() -> Vec<&'static str> {
    SHIPPED.iter().map(|row| row.0).collect()
}
