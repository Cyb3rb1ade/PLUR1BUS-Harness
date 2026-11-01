//! Six-block context assembly after the T3/T4 selected-row boundary.

use super::acl::AclSubject;
use super::blocks::{ContextBlock, Deferral, RenderEffects, RenderedRecall};
use super::memory_context::{FormatOptions, PromptItem};
use super::neo_prelude::{NeoPrelude, NeoRequest};
use super::reactivation::ReactivationInputs;
use super::render_value::{concat, join, text};
use crate::text::js::JsString;
use serde::Deserialize;
use serde_json::{json, Value};

/// Bounded renderer errors, without stored memory contents.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum RenderError {
    /// A timestamp is outside ECMAScript's representable range.
    InvalidTimestamp,
    /// A caller-supplied timezone is unavailable.
    InvalidTimezone,
    /// A malformed index cannot be read.
    InvalidIndex,
    /// Projected record metadata is not an object.
    InvalidMemory,
    /// Collaborator failure; callers provide an already safe detail.
    Unavailable(String),
    /// Caller cancellation, propagated rather than swallowed by warming.
    Aborted,
}

impl std::fmt::Display for RenderError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(match self {
            Self::InvalidTimestamp => "invalid memory timestamp",
            Self::InvalidTimezone => "invalid timezone",
            Self::InvalidIndex => "invalid lens index",
            Self::InvalidMemory => "invalid memory metadata",
            Self::Unavailable(_) => "recall collaborator unavailable",
            Self::Aborted => "recall aborted",
        })
    }
}
impl std::error::Error for RenderError {}

/// A selected, already-authorized wrapper. The entry must be the vector-free projection.
#[derive(Clone, Debug, Deserialize)]
pub struct RenderHit {
    /// Scalar row metadata.
    pub entry: Value,
    /// Final pipeline score.
    pub score: f64,
    /// `vector`, `graph` or `both`.
    pub source: String,
    /// Graph depth, when present.
    #[serde(default)]
    pub depth: Option<f64>,
}

/// A selected canonical section.
#[derive(Clone, Debug, Deserialize)]
pub struct CanonicalHit {
    /// Original heading.
    pub heading: String,
    /// Section text, including its heading.
    pub text: String,
    /// Final canonical score.
    pub score: f64,
    /// Authoritative document observation time.
    #[serde(rename = "mtimeMs")]
    pub mtime_ms: Option<f64>,
}

/// Pipeline selection, independent of T4's unmerged namespace types.
#[derive(Clone, Debug, Default)]
pub struct SelectedRecall {
    /// Canonical rows first.
    pub canonical: Vec<CanonicalHit>,
    /// Selected ordinary rows, in pipeline order.
    pub memories: Vec<RenderHit>,
}

/// T5-owned controls forwarded to the existing T3/T4 selected pipeline.
pub struct SelectionParameters<'a> {
    /// Visible query.
    pub query: &'a str,
    /// Canonical request for the selected pipeline's ACL.
    pub context: &'a AclSubject,
    /// Normalized recall.maxPromptMemories.
    pub top_n: usize,
    /// Existing summary word limit.
    pub summary_max_words: f64,
}

/// The selected-row boundary keeps G2 independent of unmerged T4 types.
pub trait SelectedRecallPipeline {
    /// Return authorized, ordered rows using the supplied controls.
    fn select(&self, parameters: &SelectionParameters<'_>) -> Result<SelectedRecall, RenderError>;
}

const DEFAULT_PROMPT_MEMORIES: usize = 12;
const MAX_PROMPT_MEMORIES: usize = 100;
const DEFAULT_SUMMARY_WORDS: f64 = 150.0;

fn summary_words(request: &RenderRequest) -> f64 {
    request.config["summaryMaxWords"]
        .as_f64()
        .unwrap_or(DEFAULT_SUMMARY_WORDS)
}

/// Forward configured limits once, then render the selected pipeline's result.
pub fn assemble_context(
    request: &RenderRequest,
    pipeline: &dyn SelectedRecallPipeline,
    neo: &dyn NeoPrelude,
) -> Result<RenderedRecall, RenderError> {
    let parameters = SelectionParameters {
        query: &request.prompt,
        context: &request.context,
        top_n: super::render_value::bounded(
            &request.config["recall"]["maxPromptMemories"],
            DEFAULT_PROMPT_MEMORIES,
            1,
            MAX_PROMPT_MEMORIES,
        ),
        summary_max_words: summary_words(request),
    };
    let mut selected_request = request.clone();
    selected_request.selected = pipeline.select(&parameters)?;
    render_context(&selected_request, neo)
}

/// Text produced by caller-owned persona, reaction, dream, open-thread and maintenance services.
#[derive(Clone, Debug, Default)]
pub struct ContextAdditions {
    /// Persona text.
    pub persona: JsString,
    /// Reaction capability text.
    pub reaction: JsString,
    /// Authorized dream echo.
    pub dream_echo: JsString,
    /// Authorized open threads.
    pub open_threads: JsString,
    /// Knowledge update nudge, including its own separator.
    pub knowledge_nudge: JsString,
    /// Conflict nudge, including its own separator.
    pub conflict_nudge: JsString,
    /// Skill proposal nudge, including its own separator.
    pub skill_nudge: JsString,
}

/// One pure T5 request, after authorization and caller-owned reads.
#[derive(Clone, Debug)]
pub struct RenderRequest {
    /// Selected rows, already capped by the T3/T4 pipeline.
    pub selected: SelectedRecall,
    /// Existing engine configuration; no new key is introduced.
    pub config: Value,
    /// Canonical T1 ACL context for every additive candidate.
    pub context: AclSubject,
    /// Visible user prompt.
    pub prompt: String,
    /// Caller clock.
    pub now_ms: f64,
    /// Activity timestamp captured before any current-turn update.
    pub previous_activity: Option<f64>,
    /// Resolved de/en language.
    pub language: String,
    /// Host-local timezone used by temporal continuity.
    pub timezone: String,
    /// Whether activity/reminder presentation has a caller-owned workspace.
    pub has_workspace: bool,
    /// Enable the temporal block.
    pub temporal_enabled: bool,
    /// Enable trace attachments/observations.
    pub trace_enabled: bool,
    /// Expose those trace values in prompt text.
    pub trace_in_prompt: bool,
    /// Existing trace supplied by the selected pipeline.
    pub trace: Option<Value>,
    /// Consumed one-shot notice, supplied by the caller.
    pub start_notice: Option<JsString>,
    /// Whether this turn may inject a Neo prelude.
    pub neo_enabled: bool,
    /// Existing mood, without running emotion inference here.
    pub mood: Value,
    /// Caller-owned additive source snapshot and session state.
    pub reactivation: ReactivationInputs,
    /// Overlay records already made visible by their owning store.
    pub overlays: Vec<Value>,
    /// Read-only pattern snapshot.
    pub patterns: Vec<Value>,
    /// Raw semantic-lens source; every hydration receives the canonical request ACL.
    pub lens: super::lens::LensInputs,
    /// Detected contradictory IDs; detection/persistence remains caller-owned.
    pub contradictions: Vec<(String, String)>,
    /// Due reminder rows from authorized reads.
    pub due_reminders: Vec<Value>,
    /// Pending reminder rows from the same caller partition.
    pub pending_reminders: Vec<Value>,
    /// Other already-authorized text services.
    pub additions: ContextAdditions,
}

impl RenderRequest {
    /// Build the pin's default rendering request around a canonical context and clock.
    #[must_use]
    pub fn new(context: AclSubject, now_ms: f64) -> Self {
        Self {
            selected: SelectedRecall::default(),
            config: json!({}),
            context,
            prompt: String::new(),
            now_ms,
            previous_activity: None,
            language: "en".into(),
            timezone: "UTC".into(),
            has_workspace: true,
            temporal_enabled: false,
            trace_enabled: false,
            trace_in_prompt: false,
            trace: None,
            start_notice: None,
            neo_enabled: false,
            mood: Value::Null,
            reactivation: ReactivationInputs::default(),
            overlays: Vec::new(),
            patterns: Vec::new(),
            lens: super::lens::LensInputs::default(),
            contradictions: Vec::new(),
            due_reminders: Vec::new(),
            pending_reminders: Vec::new(),
            additions: ContextAdditions::default(),
        }
    }
}

/// Assemble the original six blocks; only the host's plan clips/drops aggregate text.
pub fn render_context(
    request: &RenderRequest,
    neo: &dyn NeoPrelude,
) -> Result<RenderedRecall, RenderError> {
    let mut trace = request
        .trace
        .clone()
        .unwrap_or_else(|| json!({"candidates":[],"decisions":[],"guards":[]}));
    let mut items = projected_items(request);
    items = super::render_boosters::continuity(items, request, &mut trace);
    let mut effects = RenderEffects::default();
    let (disclosure, reactivation) =
        super::render_boosters::boost(&mut items, request, &mut trace, &mut effects)?;
    let memory = memory_text(items, request, trace)?;
    let full = prepend_text(request, &disclosure, &memory.0, &reactivation);
    let presentation = super::maintenance::presentation(request);
    effects.activity_at = presentation.effects.activity_at;
    effects.reminder_ids = presentation.effects.reminder_ids.clone();
    effects.pending_keys = presentation.effects.pending_keys.clone();
    let mut blocks = context_blocks(request, neo, full, presentation)?;
    let cap_chars = request.config["recall"]["globalInjectMaxChars"]
        .as_f64()
        .unwrap_or(17_000.0);
    let mut deferrals = memory.1;
    deferrals.extend(super::inject_budget::plan(&blocks, cap_chars).deferrals);
    for block in &mut blocks {
        block.chars = block.text.utf16_len();
    }
    Ok(RenderedRecall {
        blocks,
        cap_chars,
        degraded: None,
        deferrals,
        effects,
    })
}

fn memory_text(
    mut items: Vec<PromptItem>,
    request: &RenderRequest,
    trace: Value,
) -> Result<(JsString, Vec<Deferral>), RenderError> {
    let config = &request.config;
    if config["recallHedging"]["enabled"] != false {
        let framed = super::boosters::frame_confidence(
            &items.iter().map(|m| m.fields.clone()).collect::<Vec<_>>(),
            &config["recallHedging"],
        );
        for (item, fields) in items.iter_mut().zip(framed.items) {
            if framed.hedged_ids.contains(&fields["id"]) {
                item.trace = None;
            }
            item.fields = fields;
        }
    }
    super::render_compression::full_text(&mut items, &config["recall"]);
    let lens = lens_items(request);
    let (items, lens) = if config["semanticCompression"]["enabled"] == false {
        (items, lens)
    } else {
        items.extend(lens);
        (
            super::render_compression::compress(items, &config["semanticCompression"]),
            Vec::new(),
        )
    };
    let options = format_options(request, lens, trace);
    let result = super::memory_context::format(&items, &options)?;
    let deferrals = result
        .truncation
        .map(|(from, to)| Deferral {
            block: "memories".into(),
            kind: "clipped".into(),
            from,
            to,
            reason: "memories-cap".into(),
        })
        .into_iter()
        .collect();
    Ok((result.text, deferrals))
}

fn mood_style(request: &RenderRequest) -> Option<JsString> {
    let style = &request.config["styleDirective"];
    let zone = style["timezone"]
        .as_str()
        .or_else(|| request.config["timezone"].as_str())
        .unwrap_or(&request.timezone);
    let hour = if style["timeOfDay"] == false {
        None
    } else {
        super::time_context::local_hour(request.now_ms, zone).ok()
    };
    let temperament =
        &request.config["emotion"]["temperaments"][&request.context.agent_id]["preset"];
    super::style::build(
        &request.mood,
        &json!({"hour":hour,"opinion":style["opinion"] != false,
        "askBack":style["askBack"] != false,
        "temperamentName":temperament}),
    )
}

fn context_blocks(
    request: &RenderRequest,
    neo: &dyn NeoPrelude,
    memories: JsString,
    presentation: super::maintenance::Presentation,
) -> Result<Vec<ContextBlock>, RenderError> {
    let neo = neo_text(request, neo);
    let start = request
        .start_notice
        .as_ref()
        .filter(|notice| !notice.is_empty())
        .map(|notice| {
            concat(
                "<plur1bus-start-notice>\n",
                notice,
                "\n</plur1bus-start-notice>",
            )
        })
        .unwrap_or_default();
    Ok([
        ("neo", neo, true),
        ("start", start, true),
        ("memories", memories, true),
        ("time", presentation.time, false),
        ("temporal", presentation.temporal, false),
        ("reminder", presentation.reminder, false),
    ]
    .into_iter()
    .map(|(name, text, droppable)| ContextBlock::new(name.into(), text, droppable))
    .collect())
}

fn projected_items(request: &RenderRequest) -> Vec<PromptItem> {
    request
        .selected
        .canonical
        .iter()
        .map(|hit| super::render_projection::canonical(hit, request.trace_enabled))
        .chain(request.selected.memories.iter().map(|hit| {
            super::render_projection::selected(hit, summary_words(request), request.trace_enabled)
        }))
        .collect()
}

fn prepend_text(
    request: &RenderRequest,
    disclosure: &JsString,
    memory: &JsString,
    reactivation: &JsString,
) -> JsString {
    let style = mood_style(request).unwrap_or_default();
    let prefixes = [
        &request.additions.persona,
        &style,
        &request.additions.reaction,
        &request.additions.dream_echo,
        &request.additions.open_threads,
        disclosure,
        memory,
        reactivation,
    ]
    .into_iter()
    .filter(|text| !text.is_empty())
    .cloned()
    .collect::<Vec<_>>();
    join(
        &[
            join(&prefixes, "\n\n"),
            request.additions.knowledge_nudge.clone(),
            request.additions.conflict_nudge.clone(),
            request.additions.skill_nudge.clone(),
        ],
        "",
    )
}

fn lens_items(request: &RenderRequest) -> Vec<PromptItem> {
    let lens_config = request
        .config
        .get("semanticLens")
        .filter(|v| super::render_value::truthy(v))
        .unwrap_or(&request.config["recall"]["semanticLens"]);
    let hydrated = super::lens::select(
        &super::lens::LensRequest {
            base: request.selected.memories.clone(),
            index: request.lens.index.clone(),
            config: lens_config.clone(),
            subject: request.context.clone(),
        },
        &request.lens,
    )
    .unwrap_or_default();
    hydrated
        .iter()
        .map(|hit| super::render_projection::lens(hit, summary_words(request)))
        .collect()
}

fn format_options(request: &RenderRequest, lens: Vec<PromptItem>, trace: Value) -> FormatOptions {
    let config = &request.config;
    let mut options = FormatOptions::from_value(&json!({}), request.now_ms);
    options.faded_threshold = super::memory_context::faded_threshold(&config["recall"]);
    options.max_total_chars = config["recall"]["memoriesMaxChars"]
        .as_f64()
        .unwrap_or(12_000.0);
    if request.has_workspace
        && config["continuityEngine"]["enabled"] != false
        && config["continuityEngine"]["overlays"]["enabled"] != false
    {
        options.overlays = request.overlays.clone();
    }
    options.matched_pattern = super::render_boosters::pattern(request);
    options.semantic_lens = lens;
    options.trace = request.trace_enabled.then_some(trace);
    options.include_trace = request.trace_in_prompt;
    options
}

fn neo_text(request: &RenderRequest, neo: &dyn NeoPrelude) -> JsString {
    let excluded = request
        .selected
        .memories
        .iter()
        .map(|hit| JsString::from(text(&hit.entry["text"])))
        .collect::<Vec<_>>();
    if request.neo_enabled {
        neo.read(&NeoRequest {
            prompt: &request.prompt,
            exclude_texts: &excluded,
            warm_only: false,
        })
        .unwrap_or_default()
    } else {
        JsString::default()
    }
}
