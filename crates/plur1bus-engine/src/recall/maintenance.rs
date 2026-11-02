//! Presentation intents and the two explicitly permitted recall counter fields.

use super::acl::AclSubject;
use super::blocks::{ContextBlock, RenderEffects, RenderedRecall};
use super::render::{RenderError, RenderRequest};
use super::render_value::{concat, join, text, truthy};
use crate::contract::StoreError;
use crate::store::{RowPatch, Store};
use crate::text::js::JsString;

/// Existing caller decisions; classification remains in T1.
pub struct MinimalPolicy {
    /// Existing automatic workspace-policy decision.
    pub allowed: bool,
    /// T1 says this is an internal/background turn.
    pub internal: bool,
    /// The host resolved a workspace.
    pub has_workspace: bool,
    /// Request the existing CA5 dispatch hook, without reading Neo here.
    pub neo_enabled: bool,
    /// Request caller-owned throttled GC, without changing memory rows here.
    pub gc_enabled: bool,
}

pub(super) struct Presentation {
    pub time: JsString,
    pub temporal: JsString,
    pub reminder: JsString,
    pub effects: RenderEffects,
}

pub(super) fn presentation(request: &RenderRequest) -> Presentation {
    let mut result = Presentation {
        time: JsString::default(),
        temporal: JsString::default(),
        reminder: JsString::default(),
        effects: RenderEffects::default(),
    };
    let Ok(time) = super::time_context::format_time(
        request.previous_activity,
        request.now_ms,
        &request.language,
    ) else {
        return result;
    };
    result.time = JsString::from(time);
    if request.temporal_enabled {
        let Ok(temporal) = super::time_context::format_temporal(
            request.previous_activity,
            request.now_ms,
            &request.timezone,
        ) else {
            return result;
        };
        result.temporal = JsString::from(temporal);
    }
    result.effects.activity_at = request.has_workspace.then_some(request.now_ms);
    add_reminders(&mut result, request);
    result
}

/// Auto-recall-off value construction. IO is returned as caller-owned intents.
pub fn minimal(
    request: &RenderRequest,
    policy: &MinimalPolicy,
) -> Result<RenderedRecall, RenderError> {
    if !policy.allowed {
        return Ok(RenderedRecall::default());
    }
    let mut result = RenderedRecall::default();
    result.effects.neo_hook = policy.neo_enabled;
    result.effects.gc_requested = policy.gc_enabled;
    if policy.internal || !policy.has_workspace {
        return Ok(result);
    }
    let presentation = presentation(request);
    result.effects.activity_at = presentation.effects.activity_at;
    result.effects.reminder_ids = presentation.effects.reminder_ids;
    result.effects.pending_keys = presentation.effects.pending_keys;
    let start = request
        .start_notice
        .as_ref()
        .filter(|s| !s.is_empty())
        .map(|s| concat("<plur1bus-start-notice>\n", s, "\n</plur1bus-start-notice>"))
        .unwrap_or_default();
    let memories = join(
        &[
            request.additions.knowledge_nudge.clone(),
            request.additions.conflict_nudge.clone(),
        ],
        "",
    );
    result.blocks = [
        ("start", start, true),
        ("memories", memories, true),
        ("time", presentation.time, false),
        ("temporal", presentation.temporal, false),
        ("reminder", presentation.reminder, false),
    ]
    .into_iter()
    .filter(|(_, text, _)| !text.is_empty())
    .map(|(name, text, droppable)| ContextBlock::new(name.into(), text, droppable))
    .collect();
    Ok(result)
}

/// Optional authorized maintenance. Warm mode performs no reads or writes.
pub fn record_retrieval(
    store: &Store,
    ids: &[String],
    subject: &AclSubject,
    now_ms: i64,
    warm_only: bool,
) -> Result<(), StoreError> {
    if warm_only {
        return Ok(());
    }
    for id in ids {
        let Some(row) = store.get(id)? else {
            continue;
        };
        let value = serde_json::to_value(&row).map_err(|_| StoreError::InvalidInput)?;
        if !super::render_access::allowed(&value, subject) {
            continue;
        }
        let count = row
            .retrieval_count
            .as_f64()
            .filter(|n| n.is_finite())
            .unwrap_or(0.0);
        store.patch(
            id,
            &RowPatch {
                retrieval_count: Some(count + 1.0),
                last_retrieved_at: Some(now_ms as f64),
                ..RowPatch::default()
            },
        )?;
    }
    Ok(())
}

fn add_reminders(result: &mut Presentation, request: &RenderRequest) {
    let reminders =
        super::time_context::merge_reminders(&request.due_reminders, &request.pending_reminders);
    result.reminder = JsString::from(super::time_context::format_reminders(
        &reminders,
        &request.language,
        request.now_ms,
    ));
    result.effects.reminder_ids = request
        .due_reminders
        .iter()
        .map(|r| text(&r["id"]))
        .collect();
    if !request.pending_reminders.is_empty() {
        result.effects.pending_keys = reminders
            .iter()
            .map(|r| {
                r.get("id")
                    .filter(|v| truthy(v))
                    .map_or_else(|| text(&r["reminderKey"]), text)
            })
            .collect();
    }
}
