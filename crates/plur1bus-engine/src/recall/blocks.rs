//! Unicode-safe prompt blocks; JSON field order follows the pinned value helpers.

use crate::text::js::JsString;
use serde::Serialize;

/// A T5 block with well-formed presentation text (RE-D17/F3).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ContextBlock {
    /// Stable block name.
    pub name: String,
    /// Text before the host's aggregate cap.
    pub text: JsString,
    /// Whether the host may clip/drop this block.
    pub droppable: bool,
    /// UTF-16 code-unit count, never a token estimate.
    pub chars: usize,
}

impl ContextBlock {
    /// Construct a block and compute its UTF-16 length.
    #[must_use]
    pub fn new(name: String, text: JsString, droppable: bool) -> Self {
        let text = super::output_unicode::well_formed(text);
        Self {
            name,
            chars: text.utf16_len(),
            text,
            droppable,
        }
    }

    /// Serialize the presentation text without adding `tokensEstimate`.
    #[must_use]
    pub fn to_json_line(&self) -> String {
        format!(
            "{{\"name\":{},\"text\":{},\"droppable\":{},\"chars\":{}}}",
            JsString::from(self.name.as_str()).to_json(),
            self.text.to_json(),
            self.droppable,
            self.chars
        )
    }
}

/// One actual clip/drop, in the order the pin applies caps.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct Deferral {
    /// Block affected.
    pub block: String,
    /// `clipped` or `dropped`.
    pub kind: String,
    /// Previous UTF-16 length.
    pub from: usize,
    /// Resulting UTF-16 length.
    pub to: usize,
    /// `memories-cap` or `global-cap`.
    pub reason: String,
}

/// T5's result; T6 adds timing at the outer scheduling boundary.
#[derive(Clone, Debug, PartialEq)]
pub struct RenderedRecall {
    /// Original blocks, retained even when the aggregate plan drops them.
    pub blocks: Vec<ContextBlock>,
    /// Infinity means uncapped and serializes as Node's `null`.
    pub cap_chars: f64,
    /// Optional bounded degraded value, with Node's field order.
    pub degraded: Option<RenderDegraded>,
    /// Inner-cap events followed by aggregate-cap events.
    pub deferrals: Vec<Deferral>,
    /// Caller-owned presentation/session intents; never serialized into RecallResult.
    pub effects: RenderEffects,
}

/// Persistent actions belong to their existing owners, outside the pure renderer.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct RenderEffects {
    /// Dispatch-hook intent for the caller-owned Neo service.
    pub neo_hook: bool,
    /// Throttled maintenance intent for the existing job owner.
    pub gc_requested: bool,
    /// CRR's updated in-memory agent/session state.
    pub reactivation_session: Option<super::reactivation::SessionState>,
    /// Activity stamp after successful time-context construction.
    pub activity_at: Option<f64>,
    /// Reminders presented in the prompt; RE-07 owns any status transition.
    pub reminder_ids: Vec<String>,
    /// Pending-file keys to remove through the caller-owned reminder service.
    pub pending_keys: Vec<String>,
}

/// A bounded failure already classified by the recall collaborator.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct RenderDegraded {
    /// For example `warm-failed`.
    pub reason: String,
    /// Always `recall` for these paths.
    pub capability: String,
    /// Already bounded detail, without memory contents.
    pub detail: JsString,
}

impl RenderDegraded {
    fn to_json_line(&self) -> String {
        format!(
            "{{\"reason\":{},\"capability\":{},\"detail\":{}}}",
            JsString::from(self.reason.as_str()).to_json(),
            JsString::from(self.capability.as_str()).to_json(),
            self.detail.to_json()
        )
    }
}

impl Default for RenderedRecall {
    fn default() -> Self {
        Self {
            blocks: Vec::new(),
            cap_chars: f64::INFINITY,
            degraded: None,
            deferrals: Vec::new(),
            effects: RenderEffects::default(),
        }
    }
}

impl RenderedRecall {
    /// Node-order JSON excluding the T6 timing envelope.
    #[must_use]
    pub fn to_json_line(&self) -> String {
        let blocks = self
            .blocks
            .iter()
            .map(ContextBlock::to_json_line)
            .collect::<Vec<_>>()
            .join(",");
        let cap = serde_json::Number::from_f64(self.cap_chars).map_or_else(
            || "null".to_owned(),
            |number| super::render_value::number_text(&number),
        );
        let degraded = self
            .degraded
            .as_ref()
            .map_or_else(|| "null".into(), RenderDegraded::to_json_line);
        let deferrals = serde_json::to_string(&self.deferrals).unwrap_or_else(|_| "[]".into());
        format!(
            concat!(
                "{{\"blocks\":[{blocks}],\"capChars\":{cap},\"degraded\":{degraded},\"de",
                "ferrals\":{deferrals}}}",
            ),
            blocks = blocks,
            cap = cap,
            degraded = degraded,
            deferrals = deferrals
        )
    }
}
