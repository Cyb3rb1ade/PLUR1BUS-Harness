//! D109 §2: the one effect vocabulary (TypeScript: `policy/effects.ts`). D103 `sideEffects`, the extension manifest's
//! `tools[].effect` and MCP annotations all map onto it. Pure data and functions.
use serde_json::Value;

/// `Effect`: what a call can do, in rising order of reach.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum Effect {
    /// Reads only.
    Read,
    /// Writes local state that can be undone.
    LocalWrite,
    /// Destroys local state.
    LocalDestructive,
    /// Reaches outside this machine.
    External,
    /// An outbound agent-to-agent message.
    NetworkA2a,
    /// Spends money.
    Money,
}

/// `EFFECTS`, in the TypeScript order.
pub const EFFECTS: [Effect; 6] = [
    Effect::Read,
    Effect::LocalWrite,
    Effect::LocalDestructive,
    Effect::External,
    Effect::NetworkA2a,
    Effect::Money,
];

impl Effect {
    /// The TypeScript spelling.
    pub fn as_str(self) -> &'static str {
        match self {
            Effect::Read => "read",
            Effect::LocalWrite => "local-write",
            Effect::LocalDestructive => "local-destructive",
            Effect::External => "external",
            Effect::NetworkA2a => "network.a2a",
            Effect::Money => "money",
        }
    }

    /// `isEffect` and the parse in one: the effect a string names, if any.
    pub fn parse(s: &str) -> Option<Effect> {
        EFFECTS.into_iter().find(|e| e.as_str() == s)
    }

    /// `effectRank`: `external` and `network.a2a` share a rank.
    pub fn rank(self) -> u8 {
        match self {
            Effect::Read => 0,
            Effect::LocalWrite => 1,
            Effect::LocalDestructive => 2,
            Effect::External | Effect::NetworkA2a => 3,
            Effect::Money => 4,
        }
    }
}

/// `isEffect(v)` for a JSON value.
pub fn is_effect(v: &Value) -> bool {
    v.as_str().and_then(Effect::parse).is_some()
}

/// `maxEffect(a, b)`: the higher rank; on a tie, `a`.
pub fn max_effect(a: Effect, b: Effect) -> Effect {
    if a.rank() >= b.rank() {
        a
    } else {
        b
    }
}

/// `fromSideEffects`: D103 `sideEffects` (`none`, `local`, `external`, `money`); `local` is destructive when irreversible.
/// RULING (TypeScript): an unknown value is the most open non-money effect.
pub fn from_side_effects(side: &str, irreversible: bool) -> Effect {
    match side {
        "none" => Effect::Read,
        "local" if irreversible => Effect::LocalDestructive,
        "local" => Effect::LocalWrite,
        "money" => Effect::Money,
        _ => Effect::External,
    }
}

/// `fromExtensionEffect`: a write with network, or with the network unknown, is external. RULING (TypeScript): an effect it
/// cannot read is never a local write.
pub fn from_extension_effect(effect: &str, network: Option<&str>) -> Effect {
    let offline = network == Some("none");
    match effect {
        "read" => Effect::Read,
        "destructive" if offline => Effect::LocalDestructive,
        "write" if offline => Effect::LocalWrite,
        _ => Effect::External,
    }
}

/// `fromMcp`: a third-party MCP tool. No declared effect is `external`; annotations may only raise it (`readOnlyHint` is
/// ignored on purpose: a server cannot lower its own tool's class). Only a boolean `true` hint counts.
pub fn from_mcp(declared: Option<&Value>, annotations: &Value) -> Effect {
    let mut e = declared
        .and_then(Value::as_str)
        .and_then(Effect::parse)
        .unwrap_or(Effect::External);
    if annotations.get("destructiveHint") == Some(&Value::Bool(true)) {
        e = max_effect(e, Effect::LocalDestructive);
    }
    if annotations.get("openWorldHint") == Some(&Value::Bool(true)) {
        e = max_effect(e, Effect::External);
    }
    e
}
