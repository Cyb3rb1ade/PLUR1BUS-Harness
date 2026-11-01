//! Additive conversation reactivation: bounded selection, ACL and session triggers.

use super::acl::AclSubject;
use super::memory_sanitize::{attribute, escape, evidence};
use super::render::RenderError;
use super::render_value::{concat, join, number, text, truthy};
use super::{reactivation_acl, reactivation_index};
use crate::text::js::JsString;
use serde_json::{json, Value};
use std::collections::BTreeMap;

pub use reactivation_index::LensIndex;

/// In-memory per-agent/session state; the caller owns partitioning and retention.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct SessionState {
    /// Previous user-visible turn.
    pub last_user_turn_at: Option<f64>,
    /// Previous reactivation, even when selection was empty.
    pub last_crr_at: Option<f64>,
}

/// Caller-owned reads, supplied separately from persistent memory mutation rights.
#[derive(Clone, Debug, Default)]
pub struct ReactivationInputs {
    /// Ordered semantic-lens snapshot.
    pub index: LensIndex,
    /// Already loaded bound graph edges.
    pub graph_edges: Vec<Value>,
    /// Optional hydration snapshot, still checked against edge ownership and ACL.
    pub hydrated: BTreeMap<String, Value>,
    /// Session state before this turn.
    pub session: SessionState,
    /// Latest compaction, if known.
    pub compacted_at: Option<f64>,
}

/// Pure selector request; no file, ledger, Neo or memory writes are available.
#[derive(Clone, Debug)]
pub struct SelectionRequest {
    /// Current visible user message.
    pub prompt: String,
    /// Excluded normal-recall IDs.
    pub base_ids: Vec<String>,
    /// Ordered index snapshot.
    pub index: LensIndex,
    /// Candidate graph edges.
    pub graph_edges: Vec<Value>,
    /// Optional rows not already in the index.
    pub hydrated: BTreeMap<String, Value>,
    /// CRR configuration only.
    pub config: Value,
    /// Canonical request; None preserves the pin's narrow unbound helper mode.
    pub subject: Option<AclSubject>,
    /// Caller clock.
    pub now_ms: f64,
}

/// Additive text/rows and the updated caller-owned in-memory state.
#[derive(Clone, Debug, Default)]
pub struct ReactivationResult {
    /// Historical evidence block.
    pub context: JsString,
    /// Authorized selected additions.
    pub additions: Vec<Value>,
    /// State after this attempted hook.
    pub session: SessionState,
}

/// Run the hook without persisting session state or changing stored memories.
pub fn run(
    request: &SelectionRequest,
    state: &SessionState,
    top_score: f64,
    compacted_at: Option<f64>,
    mut trace: Option<&mut Value>,
) -> Result<ReactivationResult, RenderError> {
    let mut session = state.clone();
    let triggered = should_run(
        &request.config,
        state,
        &request.prompt,
        top_score,
        compacted_at,
        request.now_ms,
    );
    session.last_user_turn_at = Some(request.now_ms);
    if !triggered {
        return Ok(ReactivationResult {
            session,
            ..ReactivationResult::default()
        });
    }
    if let Some(trace) = trace.as_deref_mut() {
        super::memory_trace::append(
            trace,
            "guards",
            json!({"passed":true,
            "name":"reactivation-trigger","reason":"conversation reactivation triggered"}),
        );
    }
    let additions = super::reactivation_select::select_observed(request, trace);
    let context = format_context(
        &additions,
        request.config["visibleHints"] == true,
        request.subject.as_ref(),
        request.now_ms,
    )?;
    session.last_crr_at = Some(request.now_ms);
    Ok(ReactivationResult {
        context,
        additions,
        session,
    })
}

const CONTINUATION: &[&str] = &[
    "weiter",
    "wie machen wir weiter",
    "was war der stand",
    "zurück zum projekt",
    "mach da weiter",
    "was fehlt noch",
    "continue",
    "where were we",
    "back to",
    "status",
    "stand",
    "weitergehen",
    "weitermachen",
    "machen wir weiter",
    "wie geht es weiter",
    "was ist der stand",
    "zurück",
    "return to",
    "pick up",
    "resume",
];

pub(super) fn continuation(prompt: &str) -> bool {
    let prompt = prompt.to_lowercase();
    CONTINUATION.iter().any(|signal| prompt.contains(signal))
}

/// The first real message, idle gap, continuation and compaction triggers.
#[must_use]
pub fn should_run(
    config: &Value,
    state: &SessionState,
    prompt: &str,
    top_score: f64,
    compacted_at: Option<f64>,
    now: f64,
) -> bool {
    if config["enabled"] != true || crate::text::js::js_trim(prompt).is_empty() {
        return false;
    }
    let cooldown = config
        .get("cooldownMinutes")
        .filter(|v| !v.is_null())
        .map_or(30.0, number)
        * 60_000.0;
    if state
        .last_crr_at
        .is_some_and(|at| at != 0.0 && now - at < cooldown)
    {
        return false;
    }
    let continued = continuation(prompt);
    if crate::text::js::utf16_len(crate::text::js::js_trim(prompt)) < 5 && !continued {
        return false;
    }
    let idle_ms = config
        .get("idleThresholdMinutes")
        .filter(|v| !v.is_null())
        .map_or(45.0, number)
        * 60_000.0;
    let last = state.last_user_turn_at.filter(|at| *at != 0.0);
    let idle = last.is_some_and(|at| now - at > idle_ms);
    let first = last.is_none() && crate::text::js::utf16_len(crate::text::js::js_trim(prompt)) >= 5;
    let compacted = compacted_at
        .zip(state.last_crr_at)
        .is_some_and(|(at, last)| at != 0.0 && last != 0.0 && at > last);
    if top_score >= 0.85 && !idle && !continued && !compacted && !first {
        return false;
    }
    idle || continued || compacted || first
}

/// Select community representatives, bound bridges, open projects, then one faded memory.
#[must_use]
pub fn select(request: &SelectionRequest) -> Vec<Value> {
    super::reactivation_select::select_observed(request, None)
}

/// Format only still-live authorized additions, never inferred ownership.
pub fn format_context(
    memories: &[Value],
    visible_hints: bool,
    subject: Option<&AclSubject>,
    now: f64,
) -> Result<JsString, RenderError> {
    let mut rows = Vec::new();
    for memory in memories {
        if !reactivation_acl::authorized(memory, subject, None, now) {
            continue;
        }
        rows.push(render_row(memory, now));
    }
    if rows.is_empty() {
        return Ok(JsString::default());
    }
    let hint = if visible_hints {
        concat!(
            "\n[HINT: The following memories were reactivated because the ",
            "conversation appears to resume after a gap.]",
        )
    } else {
        ""
    };
    Ok(concat(
        &format!(
            concat!(
                "<memory-reactivation untrusted=\"true\" ",
                "mode=\"historical-evidence-only\">{hint}\n{}\n",
            ),
            super::memory_constants::COMPACT_SAFETY,
            hint = hint
        ),
        &join(&rows, "\n"),
        "\n</memory-reactivation>",
    ))
}

fn render_row(memory: &Value, now: f64) -> JsString {
    let provenance = super::provenance::build(memory, now);
    let prefix = format!(
        concat!(
            "  <memory-record category=\"{}\" source=\"reactivation\" id=\"{}\"{} ",
            "age=\"{}\" freshness=\"{}\"><quoted-evidence>",
        ),
        attribute(&memory["category"], "memory"),
        attribute(&memory["id"], "id"),
        if truthy(&memory["faded"]) {
            " faded=\"true\""
        } else {
            ""
        },
        escape(&provenance.age_label),
        provenance.freshness
    );
    concat(
        &prefix,
        &evidence(&JsString::from(text(&memory["display"])), 400),
        "</quoted-evidence></memory-record>",
    )
}
