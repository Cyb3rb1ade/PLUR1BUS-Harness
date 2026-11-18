//! Tool-need detection and the per-attempt tool choice (`toolcall/tool-use.ts`, N-E2 to E5). Every input comes from the
//! trusted owner of the turn. The reasons are a bounded set of labels for telemetry; no text of the message becomes one.
//!
//! The rules are the TypeScript regular expressions themselves, run by an ECMAScript engine over UTF-16, so a word
//! boundary, a white-space character and a case fold mean here what they mean there
//! (`fixtures/parity/toolcall/tool-use.json`).
use super::json::{JsStr, V};
use super::quirks::lookup_quirks;
use super::validation::Thrown;
use std::sync::OnceLock;

/// What the tool-need rule reads of a triage task (`Pick<TriageTask, "categories" | "confidence">`). The triage module
/// (K9a) owns the full type; this is the narrow view this module needs.
#[derive(Clone, Debug)]
pub struct TaskSignal {
    /// Category probabilities, in the task's own order.
    pub categories: Vec<(String, f64)>,
    /// The classifier's confidence in the task.
    pub confidence: f64,
}

/// `ToolNeedInput`: the message and the scoped capability metadata of the current turn.
#[derive(Clone, Debug, Default)]
pub struct ToolNeedInput<'a> {
    /// The message.
    pub message: JsStr,
    /// The triage tasks, when there are any.
    pub tasks: Option<&'a [TaskSignal]>,
    /// Categories for which a tool is on offer.
    pub categories_with_tools: &'a [String],
    /// The turn carries an attachment.
    pub attachments: bool,
    /// Tools a loaded skill names.
    pub allowed_tools: &'a [String],
    /// Tools currently offered.
    pub offered_tools: Option<&'a [String]>,
    /// The confidence a category match needs; absent is 0.65.
    pub min_confidence: Option<f64>,
}

/// `ToolNeed`: evidence that the turn needs a tool, and the one offered tool it names, if exactly one.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct ToolNeed {
    /// At least one reason.
    pub needed: bool,
    /// `category`, `url`, `path`, `current-data`, `attachment`, `skill-tools`, in that order.
    pub reasons: Vec<&'static str>,
    /// The one allowed tool that is on offer.
    pub named_tool: Option<String>,
}

impl ToolNeed {
    /// `{ needed, reasons, namedTool? }`.
    pub fn to_v(&self) -> V {
        let mut v = V::obj([
            ("needed", V::Bool(self.needed)),
            ("reasons", V::strs(&self.reasons)),
        ]);
        if let (V::Obj(o), Some(name)) = (&mut v, &self.named_tool) {
            o.set("namedTool", V::s(name));
        }
        v
    }
}

/// `ToolChoice` of the provider types.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum ToolChoice {
    /// The model decides.
    Auto,
    /// Some tool must be called.
    Required,
    /// This tool must be called.
    Named(String),
}

/// `ToolChoiceInput`: everything about one provider attempt, resolved before the call.
#[derive(Clone, Debug)]
pub struct ToolChoiceInput<'a> {
    /// `auto`, `prefer` or `require-first`; absent is `prefer`.
    pub mode: Option<&'a str>,
    /// The detected need.
    pub need: &'a ToolNeed,
    /// The round of the turn, from 0.
    pub round: u32,
    /// A tool call was already made in this turn.
    pub has_tool_call: bool,
    /// The tools on offer.
    pub tools: &'a [String],
    /// The wire family.
    pub family: &'a str,
    /// The model, where a model has a row of its own.
    pub model: Option<&'a str>,
    /// A local server.
    pub local: bool,
    /// The evidenced model family of a local model.
    pub model_family: Option<&'a str>,
    /// Reasoning is on.
    pub thinking: bool,
    /// The one retry after an answer without a needed tool.
    pub retry: bool,
}

/// `TurnToolChoice`: the provider-neutral choice and why a forced one was not made.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct TurnToolChoice {
    /// The choice.
    pub choice: ToolChoice,
    /// A tool call is forced.
    pub forced: bool,
    /// `anthropic-thinking`, `model-unsupported`, `local-unverified` or `no-tools`.
    pub suppressed: Option<&'static str>,
}

impl TurnToolChoice {
    /// `{ choice, forced, suppressed? }`.
    pub fn to_v(&self) -> V {
        let choice = match &self.choice {
            ToolChoice::Auto => V::s("auto"),
            ToolChoice::Required => V::s("required"),
            ToolChoice::Named(name) => V::obj([("name", V::s(name))]),
        };
        let mut v = V::obj([("choice", choice), ("forced", V::Bool(self.forced))]);
        if let (V::Obj(o), Some(why)) = (&mut v, self.suppressed) {
            o.set("suppressed", V::s(why));
        }
        v
    }
}

const TOOL_NEED_MIN_CONFIDENCE: f64 = 0.65;

/// `\b` of a pattern with the flags `iu`. With both flags ECMAScript counts as word characters also those that fold to
/// one (`WordCharacters`): U+017F, which folds to `s`, and U+212A, which folds to `k`. The engine used here keeps `\b`
/// ASCII, so "today" followed by U+017F would end at a boundary it does not have in JavaScript; the boundary is therefore
/// spelled out with the full set.
const WORD_BOUNDARY_IU: &str = r"(?:(?<=[A-Za-z0-9_\u{17f}\u{212a}])(?![A-Za-z0-9_\u{17f}\u{212a}])|(?<![A-Za-z0-9_\u{17f}\u{212a}])(?=[A-Za-z0-9_\u{17f}\u{212a}]))";

struct Rules {
    url: regress::Regex,
    paths: Vec<regress::Regex>,
    current: Vec<regress::Regex>,
}

/// The patterns of `tool-use.ts`, verbatim. The URL rule has the `i` flag only (code units, ASCII-only folding of
/// non-ASCII letters); the others have `iu`.
fn rules() -> Option<&'static Rules> {
    static RULES: OnceLock<Option<Rules>> = OnceLock::new();
    RULES.get_or_init(build_rules).as_ref()
}

fn build_rules() -> Option<Rules> {
    let compile = |pattern: &str, flags: &str| regress::Regex::with_flags(pattern, flags).ok();
    let bounded = |pattern: &str| {
        compile(
            &format!("{WORD_BOUNDARY_IU}{pattern}{WORD_BOUNDARY_IU}"),
            "iu",
        )
    };
    Some(Rules {
        url: compile(r"\bhttps?:\/\/\S+", "i")?,
        paths: vec![
            compile(r#"(?:^|[\s"'`(])(?:\.{1,2}[\\/]|~[\\/])[^\s]+"#, "iu")?,
            compile(r#"(?:^|[\s"'`(])(?:\\\\\?\\)?[a-z]:[\\/][^\s]+"#, "iu")?,
            compile(r#"(?:^|[\s"'`(])\\\\[^\s\\]+\\[^\s]+"#, "iu")?,
            compile(r#"(?:^|[\s"'`(])\/[\p{L}\p{N}_.@~-][^\s]*"#, "iu")?,
        ],
        current: vec![
            bounded(
                r"(?:aktuell(?:e[nrsm]?)?|neueste[nrsm]?|heute|heutig(?:e[nrsm]?)?|jetzt|gestern|morgen)",
            )?,
            bounded(
                r"(?:derzeit|derzeitig(?:e[nrsm]?)?|today|tonight|yesterday|tomorrow|latest|current|currently)",
            )?,
            bounded(r"(?:recent|recently|newest|up[- ]to[- ]date|real[- ]time)")?,
        ],
    })
}

/// `detectToolNeed`: the reasons, in their fixed order, why this turn needs a tool.
pub fn detect_tool_need(input: &ToolNeedInput<'_>) -> Result<ToolNeed, Thrown> {
    let threshold = input.min_confidence.unwrap_or(TOOL_NEED_MIN_CONFIDENCE);
    if !threshold.is_finite() || !(0.0..=1.0).contains(&threshold) {
        return Err(Thrown::error("invalid tool-need confidence"));
    }
    // The patterns are constants; one that did not compile would be a defect of this build, reported, never ignored.
    let Some(rules) = rules() else {
        return Err(Thrown::error("tool-need rules unavailable"));
    };
    let message = input.message.units();
    let mut reasons = Vec::new();
    let matched_category = input.tasks.is_some_and(|tasks| {
        tasks.iter().any(|task| {
            task.categories.iter().any(|(category, probability)| {
                input.categories_with_tools.contains(category)
                    && task.confidence * probability >= threshold
            })
        })
    });
    if matched_category {
        reasons.push("category");
    }
    if rules.url.find_from_ucs2(message, 0).next().is_some() {
        reasons.push("url");
    }
    if rules
        .paths
        .iter()
        .any(|p| p.find_from_utf16(message, 0).next().is_some())
    {
        reasons.push("path");
    }
    if rules
        .current
        .iter()
        .any(|p| p.find_from_utf16(message, 0).next().is_some())
    {
        reasons.push("current-data");
    }
    if input.attachments {
        reasons.push("attachment");
    }
    let mut allowed: Vec<&String> = Vec::new();
    for name in input.allowed_tools {
        if !allowed.contains(&name) && !crate::js::js_trim(name).is_empty() {
            allowed.push(name);
        }
    }
    if !allowed.is_empty() {
        reasons.push("skill-tools");
    }
    let matching: Vec<&String> = allowed
        .into_iter()
        .filter(|name| {
            input
                .offered_tools
                .is_some_and(|offered| offered.contains(name))
        })
        .collect();
    let named_tool = match matching.as_slice() {
        [one] => Some((*one).clone()),
        _ => None,
    };
    Ok(ToolNeed {
        needed: !reasons.is_empty(),
        reasons,
        named_tool,
    })
}

/// `toolChoiceForTurn`: evaluated per provider attempt, after the reasoning mode is chosen. A forced choice is made only
/// in the first round (or the one retry), only where the model is known to accept it, and never from the shape of a
/// local server's wire.
pub fn tool_choice_for_turn(input: &ToolChoiceInput<'_>) -> TurnToolChoice {
    let mode = input.mode.unwrap_or("prefer");
    let automatic = |suppressed: Option<&'static str>| TurnToolChoice {
        choice: ToolChoice::Auto,
        forced: false,
        suppressed,
    };
    let eligible_round = input.round == 0 || input.retry;
    if mode == "auto"
        || input.has_tool_call
        || !eligible_round
        || (mode == "prefer" && !input.need.needed)
    {
        return automatic(None);
    }
    if input.tools.is_empty() {
        return automatic(Some("no-tools"));
    }
    if !lookup_quirks(input.family, input.model).supports_forced_tool_choice {
        return automatic(Some("model-unsupported"));
    }
    if input.family == "anthropic" && input.thinking {
        return automatic(Some("anthropic-thinking"));
    }
    // Local compatibility is an evidenced quirk of a model family, never inferred from an OpenAI-shaped wire.
    let quirks = lookup_quirks(input.model_family.unwrap_or("local-small"), None);
    if input.local
        && (input.model_family == Some(quirks.family) || !quirks.supports_forced_tool_choice)
    {
        return automatic(Some("local-unverified"));
    }
    let named = input
        .need
        .named_tool
        .as_ref()
        .filter(|name| !name.is_empty() && input.tools.contains(name));
    TurnToolChoice {
        choice: named.map_or(ToolChoice::Required, |name| ToolChoice::Named(name.clone())),
        forced: true,
        suppressed: None,
    }
}
