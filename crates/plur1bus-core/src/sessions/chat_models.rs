//! `session/chat-models.ts` and the part of `providers/src/reasoning.ts` it needs: the per-chat model and reasoning choice.
//! Which configured model profiles a chat may pick, what reasoning levels the profile's primary model offers, and how a chosen
//! level becomes the one parameter each attempt sends. Pure over its ports ([`ChatModelSources`]): no clock, no I/O.
//!
//! Not ported: `defaultProfile()` of the sources (the options never read it) and `checkReasoningDirective` (an adapter guard,
//! it belongs with the provider wires).
use super::context_fit::{APPLE_FM_CONTEXT_WINDOW, MIN_CONTEXT_AGENT_ROLE};
use crate::config::policy::{
    is_local_chat_model, is_local_endpoint as shared_local_endpoint, local_endpoints,
    local_only_for,
};
use serde_json::Value;
use std::collections::BTreeMap;

/// The harness scale, cheapest first.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord)]
pub enum ReasoningLevel {
    /// `off`.
    Off,
    /// `minimal`.
    Minimal,
    /// `low`.
    Low,
    /// `medium`.
    Medium,
    /// `high`.
    High,
    /// `xhigh`.
    Xhigh,
}

/// `REASONING_LEVELS`.
pub const REASONING_LEVELS: [ReasoningLevel; 6] = [
    ReasoningLevel::Off,
    ReasoningLevel::Minimal,
    ReasoningLevel::Low,
    ReasoningLevel::Medium,
    ReasoningLevel::High,
    ReasoningLevel::Xhigh,
];

impl ReasoningLevel {
    /// The wire spelling.
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Off => "off",
            Self::Minimal => "minimal",
            Self::Low => "low",
            Self::Medium => "medium",
            Self::High => "high",
            Self::Xhigh => "xhigh",
        }
    }
    /// `isReasoningLevel`.
    pub fn parse(s: &str) -> Option<Self> {
        REASONING_LEVELS.iter().copied().find(|l| l.as_str() == s)
    }
    fn index(self) -> i64 {
        self as i64
    }
}

/// What a chat stores: a level of the harness scale, or `default` (send nothing, the provider decides).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ReasoningChoice {
    /// `default`.
    Default,
    /// A level.
    Level(ReasoningLevel),
}

/// `REASONING_CHOICES` as spelled.
pub const REASONING_CHOICES: [&str; 7] = [
    "default", "off", "minimal", "low", "medium", "high", "xhigh",
];

impl ReasoningChoice {
    /// `isReasoningChoice`, over the spelling.
    pub fn parse(s: &str) -> Option<Self> {
        if s == "default" {
            Some(Self::Default)
        } else {
            ReasoningLevel::parse(s).map(Self::Level)
        }
    }
}

/// `ReasoningKind`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ReasoningKind {
    /// No control.
    None,
    /// An effort string.
    Effort,
    /// A token budget.
    Budget,
    /// On/off.
    Toggle,
}

impl ReasoningKind {
    /// The wire spelling.
    pub fn as_str(self) -> &'static str {
        match self {
            Self::None => "none",
            Self::Effort => "effort",
            Self::Budget => "budget",
            Self::Toggle => "toggle",
        }
    }
}

/// `ReasoningBudget`.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct ReasoningBudget {
    /// Lower bound.
    pub min: f64,
    /// Upper bound.
    pub max: f64,
    /// Default.
    pub default: f64,
}

/// A wire value of a level: a string or a boolean.
#[derive(Clone, Debug, PartialEq)]
pub enum ReasoningValue {
    /// A string.
    Str(String),
    /// A boolean.
    Bool(bool),
}

/// Where a descriptor came from.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum DescriptorSource {
    /// The provider's own model list.
    Api,
    /// The curated table.
    Table,
    /// Nothing known.
    Unknown,
}

impl DescriptorSource {
    /// The wire spelling.
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Api => "api",
            Self::Table => "table",
            Self::Unknown => "unknown",
        }
    }
}

/// `ReasoningDescriptor`.
#[derive(Clone, Debug, PartialEq)]
pub struct ReasoningDescriptor {
    /// Kind.
    pub kind: ReasoningKind,
    /// The supported levels.
    pub levels: Vec<ReasoningLevel>,
    /// The level the provider uses when nothing is sent.
    pub default: Option<ReasoningLevel>,
    /// The wire parameter, spelled as on the wire.
    pub vendor_param: Option<String>,
    /// Curated Anthropic models that need explicit adaptive thinking with effort.
    pub adaptive_thinking: bool,
    /// The wire value per level.
    pub values: BTreeMap<ReasoningLevel, ReasoningValue>,
    /// Token bounds of a budget.
    pub budget: Option<ReasoningBudget>,
    /// Source.
    pub source: DescriptorSource,
    /// A stable hint code.
    pub note: Option<String>,
}

impl ReasoningDescriptor {
    /// `NO_REASONING`.
    pub fn none() -> Self {
        Self {
            kind: ReasoningKind::None,
            levels: vec![],
            default: None,
            vendor_param: None,
            adaptive_thinking: false,
            values: BTreeMap::new(),
            budget: None,
            source: DescriptorSource::Unknown,
            note: Some("reasoning-unknown".to_owned()),
        }
    }
}

/// `nearestLevel`: the supported level nearest to `requested` on the scale; on a tie the cheaper one. The flag is true whenever
/// the result differs from the request. `None` when the model supports no level at all.
pub fn nearest_level(
    requested: ReasoningLevel,
    levels: &[ReasoningLevel],
) -> Option<(ReasoningLevel, bool)> {
    let mut best = *levels.first()?;
    if levels.contains(&requested) {
        return Some((requested, false));
    }
    let at = requested.index();
    for &l in levels {
        let d = (l.index() - at).abs();
        let bd = (best.index() - at).abs();
        if d < bd || (d == bd && l.index() < best.index()) {
            best = l;
        }
    }
    Some((best, true))
}

/// `budgetFor`: off 0, minimal = min, low 1/8, medium 1/4, high 1/2, xhigh = max of the range (never below min).
pub fn budget_for(level: ReasoningLevel, b: &ReasoningBudget) -> f64 {
    let share = match level {
        ReasoningLevel::Off => return 0.0,
        ReasoningLevel::Minimal => return b.min,
        ReasoningLevel::Low => 0.125,
        ReasoningLevel::Medium => 0.25,
        ReasoningLevel::High => 0.5,
        ReasoningLevel::Xhigh => 1.0,
    };
    b.min
        .max(b.max.min(((b.max * share) / 256.0).floor() * 256.0))
}

/// The value of a directive.
#[derive(Clone, Debug, PartialEq)]
pub enum DirectiveValue {
    /// A string.
    Str(String),
    /// A number.
    Num(f64),
    /// A boolean.
    Bool(bool),
}

/// `ReasoningDirective`: what one request asks the adapter to write.
#[derive(Clone, Debug, PartialEq)]
pub struct ReasoningDirective {
    /// The wire parameter.
    pub vendor_param: String,
    /// The value.
    pub value: DirectiveValue,
    /// `adaptiveThinking: true`.
    pub adaptive_thinking: bool,
}

fn from_value(v: &ReasoningValue) -> DirectiveValue {
    match v {
        ReasoningValue::Str(s) => DirectiveValue::Str(s.clone()),
        ReasoningValue::Bool(b) => DirectiveValue::Bool(*b),
    }
}

/// `reasoningDirective`: the directive for `level` on a model described by `d`; `None` for a model without reasoning control.
/// A level the model does not support is a caller bug and an error, as TypeScript throws.
pub fn reasoning_directive(
    level: ReasoningLevel,
    d: &ReasoningDescriptor,
) -> Result<Option<ReasoningDirective>, String> {
    let Some(param) = d
        .vendor_param
        .as_ref()
        .filter(|_| d.kind != ReasoningKind::None)
    else {
        return Ok(None);
    };
    if !d.levels.contains(&level) {
        return Err(format!(
            "reasoning level {} is not supported by this model",
            level.as_str()
        ));
    }
    let value = match d.kind {
        ReasoningKind::Budget => {
            let b = d
                .budget
                .as_ref()
                .ok_or_else(|| "budget reasoning needs bounds".to_owned())?;
            return Ok(Some(ReasoningDirective {
                vendor_param: param.clone(),
                value: DirectiveValue::Num(budget_for(level, b)),
                adaptive_thinking: false,
            }));
        }
        ReasoningKind::Toggle => d
            .values
            .get(&level)
            .map(from_value)
            .unwrap_or(DirectiveValue::Bool(level != ReasoningLevel::Off)),
        _ => d
            .values
            .get(&level)
            .map(from_value)
            .unwrap_or_else(|| DirectiveValue::Str(level.as_str().to_owned())),
    };
    Ok(Some(ReasoningDirective {
        vendor_param: param.clone(),
        value,
        adaptive_thinking: d.kind != ReasoningKind::Toggle && d.adaptive_thinking,
    }))
}

/// One candidate of a profile.
#[derive(Clone, Debug, PartialEq)]
pub struct ChatModelCandidate {
    /// The provider.
    pub provider: String,
    /// The model.
    pub model: String,
}

/// Catalog facts, when the model was discovered.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct CatalogFacts {
    /// `displayName`.
    pub display_name: Option<String>,
    /// `status`.
    pub status: Option<String>,
    /// `contextWindow`.
    pub context_window: Option<f64>,
}

/// `ChatModelSources` (a port).
pub trait ChatModelSources {
    /// Configured model profiles and their ordered candidates (the first is the primary, the rest fallbacks).
    fn profiles(&self) -> Vec<(String, Vec<ChatModelCandidate>)>;
    /// The reasoning descriptor of one candidate, already fitted to the wire its provider speaks.
    fn reasoning(&self, provider: &str, model: &str) -> ReasoningDescriptor;
    /// Catalog facts, when the model was discovered.
    fn catalog(&self, _provider: &str, _model: &str) -> Option<CatalogFacts> {
        None
    }
    /// The provider's endpoint (base URL), for the local test.
    fn endpoint(&self, _provider: &str) -> Option<String> {
        None
    }
    /// The current configuration, for "Nur lokal".
    fn config(&self) -> Option<Value> {
        None
    }
}

/// `WireReasoning`.
#[derive(Clone, Debug, PartialEq)]
pub struct WireReasoning {
    /// `kind`.
    pub kind: ReasoningKind,
    /// `levels`.
    pub levels: Vec<ReasoningLevel>,
    /// `default`.
    pub default: Option<ReasoningLevel>,
    /// `source`.
    pub source: DescriptorSource,
    /// `note`.
    pub note: Option<String>,
    /// `budgetTokens`: the tokens per level.
    pub budget_tokens: Option<Vec<(ReasoningLevel, f64)>>,
}

/// Why a profile cannot be picked.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum DisabledReason {
    /// Local-only is on and a candidate is not local.
    LocalOnly,
    /// The model is marked unavailable.
    Unavailable,
    /// The context window is below the minimum.
    ContextTooSmall,
}

impl DisabledReason {
    /// The wire spelling.
    pub fn as_str(self) -> &'static str {
        match self {
            Self::LocalOnly => "local-only",
            Self::Unavailable => "unavailable",
            Self::ContextTooSmall => "context-too-small",
        }
    }
}

/// `ChatModelOption`.
#[derive(Clone, Debug, PartialEq)]
pub struct ChatModelOption {
    /// The profile name.
    pub name: String,
    /// The display name.
    pub display_name: String,
    /// The primary's provider.
    pub provider: String,
    /// The primary's model.
    pub model: String,
    /// Whether every candidate is local.
    pub local: bool,
    /// Whether it can be picked.
    pub selectable: bool,
    /// Why not.
    pub disabled_reason: Option<DisabledReason>,
    /// The smallest window of the candidates.
    pub context_window: Option<f64>,
    /// The primary's reasoning.
    pub reasoning: WireReasoning,
}

/// `isLocalEndpoint(raw, cfg)`: endpoint classification and override inheritance have one owner.
pub fn is_local_endpoint(raw: Option<&str>, cfg: &Value) -> bool {
    raw.is_some_and(|r| shared_local_endpoint(r, &local_endpoints(cfg)))
}

fn to_wire(d: &ReasoningDescriptor) -> WireReasoning {
    WireReasoning {
        kind: d.kind,
        levels: d.levels.clone(),
        default: d.default,
        source: d.source,
        note: d.note.clone().filter(|n| !n.is_empty()),
        budget_tokens: match (&d.budget, d.kind) {
            (Some(b), ReasoningKind::Budget) => {
                Some(d.levels.iter().map(|l| (*l, budget_for(*l, b))).collect())
            }
            _ => None,
        },
    }
}

/// `Number.isSafeInteger(value) && value > 0`.
fn safe_positive(v: f64) -> bool {
    v.is_finite() && v.fract() == 0.0 && v.abs() <= 9_007_199_254_740_991.0 && v > 0.0
}

/// `chatModelOptions`: every configured profile with candidates, sorted by name; locked ones stay listed (disabled, with the
/// reason).
pub fn chat_model_options(s: &dyn ChatModelSources, agent_id: &str) -> Vec<ChatModelOption> {
    let cfg = s.config();
    let cfg_ref = cfg.clone().unwrap_or(Value::Null);
    let local_only = local_only_for(&cfg_ref, Some(agent_id));
    let mut profiles: Vec<_> = s
        .profiles()
        .into_iter()
        .filter(|(_, c)| {
            !c.is_empty()
                && c.iter()
                    .all(|m| m.provider != "apple-fm" || m.model == "system")
        })
        .collect();
    profiles.sort_by(|(a, _), (b, _)| crate::js::compare_utf16(a, b));
    profiles
        .into_iter()
        .map(|(name, candidates)| {
            let primary = &candidates[0];
            let facts = s.catalog(&primary.provider, &primary.model);
            let local = candidates.iter().all(|c| {
                is_local_chat_model(
                    &c.provider,
                    &c.model,
                    s.endpoint(&c.provider).as_deref(),
                    &cfg_ref,
                )
            });
            let windows: Vec<f64> = candidates
                .iter()
                .map(|c| {
                    if c.provider == "apple-fm" && c.model == "system" {
                        Some(APPLE_FM_CONTEXT_WINDOW as f64)
                    } else {
                        s.catalog(&c.provider, &c.model)
                            .and_then(|f| f.context_window)
                    }
                })
                .filter_map(|w| w.filter(|v| safe_positive(*v)))
                .collect();
            let context_window = windows.iter().copied().reduce(f64::min);
            let small = context_window.is_some_and(|w| w < MIN_CONTEXT_AGENT_ROLE as f64);
            let disabled_reason = if local_only && !local {
                Some(DisabledReason::LocalOnly)
            } else if small {
                Some(DisabledReason::ContextTooSmall)
            } else if facts.as_ref().and_then(|f| f.status.as_deref()) == Some("unavailable") {
                Some(DisabledReason::Unavailable)
            } else {
                None
            };
            ChatModelOption {
                display_name: facts
                    .as_ref()
                    .and_then(|f| f.display_name.clone())
                    .unwrap_or_else(|| primary.model.clone()),
                provider: primary.provider.clone(),
                model: primary.model.clone(),
                name,
                local,
                selectable: disabled_reason.is_none(),
                disabled_reason,
                context_window,
                reasoning: to_wire(&s.reasoning(&primary.provider, &primary.model)),
            }
        })
        .collect()
}

/// `effectiveReasoning`: the level one attempt actually uses: the choice, or the nearest the model supports (adjusted, never
/// silent).
pub fn effective_reasoning(
    choice: ReasoningChoice,
    levels: &[ReasoningLevel],
) -> (Option<ReasoningLevel>, bool) {
    match choice {
        ReasoningChoice::Default => (None, false),
        ReasoningChoice::Level(l) => match nearest_level(l, levels) {
            Some((level, adjusted)) => (Some(level), adjusted),
            None => (None, true),
        },
    }
}

/// `directiveFor`: the directive one attempt sends, or `None` (provider default, or a model without reasoning control).
pub fn directive_for(
    choice: Option<ReasoningChoice>,
    d: &ReasoningDescriptor,
) -> Result<Option<ReasoningDirective>, String> {
    let Some(choice) = choice else {
        return Ok(None);
    };
    if choice == ReasoningChoice::Default {
        return Ok(None);
    }
    match effective_reasoning(choice, &d.levels).0 {
        None => Ok(None),
        Some(level) => reasoning_directive(level, d),
    }
}
