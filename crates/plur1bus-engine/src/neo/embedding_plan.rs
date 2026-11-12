//! Bounded live queue selection. Only authorized current target text reaches the provider.
use super::{
    derived_fields::{field, object, set, text},
    embedding_drain::{DrainOptions, DrainResult},
    embedding_publication::Session,
    embedding_vectors::{self, Snapshot},
    journal_io,
    merged_order::{field as optional, string, truthy},
};
use crate::{
    context::RequestContext,
    contract::{Cancel, EmbedError, EmbedKind, EngineError, StoreError},
    embedding::EmbeddingProvider,
    text::{js::JsString, json::TolerantJsonValue as Json},
};
use std::collections::{HashMap, HashSet};
pub(super) const TARGETS: [&str; 3] = [
    "memory-candidates.jsonl",
    "behavior-cards.jsonl",
    "turn-journal.jsonl",
];
pub(super) const QUEUE: &str = "embedding-queue.jsonl";

pub(super) fn latest_queue(rows: Vec<Json>) -> Result<Vec<Json>, StoreError> {
    let mut latest = HashMap::new();
    for (position, row) in rows.into_iter().enumerate() {
        latest.insert(journal_io::id(&row)?, (position, row));
    }
    let mut rows: Vec<_> = latest.into_values().collect();
    rows.sort_by_key(|(position, _)| *position);
    Ok(rows.into_iter().map(|(_, row)| row).collect())
}
pub(super) fn private(row: &Json, ctx: &RequestContext) -> bool {
    journal_io::owned(row, ctx) && optional(row, "scope") == Some(&text("agent_private"))
}
pub(super) fn live(row: &Json, ctx: &RequestContext) -> bool {
    private(row, ctx)
        && !["tombstoned", "pruned", "deleted"]
            .iter()
            .any(|s| optional(row, "status") == Some(&text(s)))
        && optional(row, "deleted") != Some(&Json::Bool(true))
        && !optional(row, "quality")
            .is_some_and(|q| optional(q, "pruned") == Some(&Json::Bool(true)))
}
fn impact(row: &Json) -> String {
    let value = ["impact", "risk", "priority"]
        .iter()
        .filter_map(|k| optional(row, k))
        .find(|v| truthy(v))
        .map(string)
        .unwrap_or_else(|| JsString::from("low"))
        .to_utf8_lossy()
        .to_lowercase();
    if ["low", "medium", "high", "critical"].contains(&value.as_str()) {
        value
    } else {
        "low".into()
    }
}
fn target_index(row: &Json) -> Option<usize> {
    let Json::String(kind) = optional(row, "targetType")? else {
        return None;
    };
    match kind.to_utf8_lossy().as_str() {
        "memory" => Some(0),
        "behavior" => Some(1),
        "turn" => Some(2),
        _ => None,
    }
}
fn changed(file: &str, before: Json, after: Json) -> Json {
    object(vec![
        ("file", text(file)),
        ("before", before),
        ("after", after),
    ])
}
fn fresh(source: &Json, dimensions: usize, impact: &str, now: &str) -> Result<Json, StoreError> {
    let Json::Object(mut fields) = source.clone() else {
        return Err(StoreError::Corrupt);
    };
    fields.retain(|(k, _)| k != &JsString::from("embedding"));
    let mut row = Json::Object(fields);
    for (key, value) in [
        ("embeddingStatus", text("fresh")),
        ("embeddingDims", embedding_vectors::number(dimensions)),
        ("embeddingStore", text("sidecar")),
        ("embeddingImpact", text(impact)),
        ("embeddingUpdatedAt", text(now)),
    ] {
        set(&mut row, key, value)?;
    }
    Ok(row)
}
pub(super) fn build(
    session: &Session<'_>,
    provider: Option<&dyn EmbeddingProvider>,
    space: Option<&str>,
    options: &DrainOptions,
    cancel: &Cancel,
) -> Result<(Option<Json>, DrainResult), EngineError> {
    (session.check)()?;
    let mut queue = latest_queue(journal_io::rows(session.dir, QUEUE, cancel)?)?;
    let mut targets = Vec::new();
    for file in TARGETS {
        targets.push(
            journal_io::latest(journal_io::rows(session.dir, file, cancel)?)?
                .into_iter()
                .map(|row| Ok((journal_io::id(&row)?, row)))
                .collect::<Result<HashMap<_, _>, StoreError>>()?,
        );
    }
    let mut vectors = match (provider, space) {
        (Some(p), Some(space)) => Some(Snapshot::open(
            session.dir,
            session.proof,
            space,
            usize::try_from(
                p.identity()
                    .dimension
                    .as_u64()
                    .ok_or(StoreError::InvalidInput)?,
            )
            .map_err(|_| StoreError::InvalidInput)?,
            cancel,
        )?),
        (None, None) => None,
        _ => return Err(StoreError::InvalidInput.into()),
    };
    let limit = if options.max_items == 0 {
        100
    } else {
        options.max_items
    };
    let mut attempts = 0;
    let mut result = DrainResult::default();
    let mut updates: [Vec<Json>; 3] = std::array::from_fn(|_| vec![]);
    let mut vector_groups: [Vec<(JsString, Vec<f32>)>; 3] = std::array::from_fn(|_| vec![]);
    let mut queue_updates = Vec::new();
    let mut seen_targets = HashSet::new();
    for item in &mut queue {
        cancel.check()?;
        if !private(item, session.ctx) {
            continue;
        }
        let impact = impact(item);
        let status = optional(item, "status").map(string).unwrap_or_default();
        if attempts >= limit
            || !options.impact.accepts(&impact)
            || (!status.is_empty()
                && status != JsString::from("pending")
                && !(status == JsString::from("deferred") && provider.is_some()))
        {
            continue;
        }
        attempts += 1;
        let kind = target_index(item);
        let id = optional(item, "targetId").and_then(|v| {
            if let Json::String(v) = v {
                Some(v.clone())
            } else {
                None
            }
        });
        let target = kind
            .zip(id.as_ref())
            .and_then(|(k, id)| targets[k].get(id))
            .cloned();
        let mut output = None;
        let (next, reason) = if kind.is_none() || id.as_ref().is_none_or(JsString::is_empty) {
            ("skipped", "unsupported_target")
        } else if target.as_ref().is_none_or(|t| !live(t, session.ctx)) {
            ("skipped", "missing_target")
        } else if let (Some(p), Some(target)) = (provider, target.as_ref()) {
            (session.check)()?;
            // Re-read the exact queued source immediately before disclosure. A custom provider
            // or external editor may have changed a later target since this batch was selected.
            let k = kind.ok_or(StoreError::Corrupt)?;
            let target_id = id.as_ref().ok_or(StoreError::Corrupt)?;
            let baseline = updates[k]
                .iter()
                .find(|v| {
                    field(v, "before").and_then(journal_io::id).ok().as_ref() == Some(target_id)
                })
                .map(|v| field(v, "before"))
                .transpose()?
                .unwrap_or(target);
            let current = journal_io::latest(journal_io::rows(session.dir, TARGETS[k], cancel)?)?;
            if !current.iter().any(|v| {
                journal_io::id(v).ok().as_ref() == Some(target_id)
                    && v == baseline
                    && live(v, session.ctx)
            }) {
                return Err(StoreError::Corrupt.into());
            }
            let current_queue = latest_queue(journal_io::rows(session.dir, QUEUE, cancel)?)?;
            if !current_queue
                .iter()
                .any(|v| v == item && private(v, session.ctx))
            {
                return Err(StoreError::Corrupt.into());
            }
            let content = ["statement", "content"]
                .iter()
                .filter_map(|k| optional(target, k))
                .find(|v| truthy(v))
                .map(string)
                .unwrap_or_default()
                .to_utf8_lossy();
            // The embedding trait accepts UTF-8; native captured text is UTF-8. Refuse a lossy
            // source conversion rather than embedding different text than the stored target.
            let original = ["statement", "content"]
                .iter()
                .filter_map(|k| optional(target, k))
                .find(|v| truthy(v))
                .map(string)
                .unwrap_or_default();
            if JsString::from(content.as_str()) != original {
                return Err(StoreError::InvalidInput.into());
            }
            let response = p.embed(&[content], EmbedKind::Passage, cancel);
            cancel.check()?;
            (session.check)()?;
            match response {
                Err(EmbedError::Cancelled(error)) => return Err(error.into()),
                Err(EmbedError::InvalidVector) => ("deferred", "invalid_embedding"),
                Err(_) => ("deferred", "embedder_failed"),
                Ok(mut response)
                    if response.len() == 1
                        && !response[0].is_empty()
                        && Some(response[0].len() as u64) == p.identity().dimension.as_u64()
                        && response[0].iter().all(|v| v.is_finite()) =>
                {
                    output = response.pop();
                    ("done", "low_impact_auto_processed")
                }
                Ok(_) => ("deferred", "invalid_embedding"),
            }
        } else {
            ("deferred", "embedder_unavailable")
        };
        if let (Some(vector), Some(source), Some(kind), Some(id)) = (output, target, kind, id) {
            let after = fresh(&source, vector.len(), &impact, session.now)?;
            // Multiple impact entries for the same target preserve all vector appends, but one
            // final metadata revision suffices. Its before-state remains the original source.
            if seen_targets.insert((kind, id.clone())) {
                updates[kind].push(changed(TARGETS[kind], source, after.clone()));
            } else {
                let update = updates[kind]
                    .iter_mut()
                    .find(|v| field(v, "after").and_then(journal_io::id).ok() == Some(id.clone()))
                    .ok_or(StoreError::Corrupt)?;
                set(update, "after", after.clone())?;
            }
            targets[kind].insert(id.clone(), after);
            vector_groups[kind].push((id, vector));
        }
        let before = item.clone();
        for (key, value) in [
            ("impact", text(&impact)),
            ("status", text(next)),
            ("processedAt", text(session.now)),
            ("reason", text(reason)),
        ] {
            set(item, key, value)?;
        }
        queue_updates.push(changed(QUEUE, before, item.clone()));
        match next {
            "done" => result.processed += 1,
            "deferred" => result.deferred += 1,
            _ => result.skipped += 1,
        }
    }
    result.pending = queue
        .iter()
        .filter(|row| {
            private(row, session.ctx) && optional(row, "status") == Some(&text("pending"))
        })
        .count();
    if queue_updates.is_empty() {
        return Ok((None, result));
    }
    if let Some(vectors) = vectors.as_mut() {
        for group in vector_groups {
            for (id, vector) in group {
                vectors.push(&id, &vector)?;
            }
        }
    }
    let vector_plan = vectors
        .map(Snapshot::freeze)
        .transpose()?
        .unwrap_or(Json::Null);
    let changes = updates.into_iter().flatten().chain(queue_updates).collect();
    let plan = object(vec![
        ("version", embedding_vectors::number(1)),
        ("caller", session.caller.clone()),
        ("changes", Json::Array(changes)),
        ("vectors", vector_plan),
    ]);
    super::embedding_publication::preflight(session, &plan, cancel)?;
    Ok((Some(plan), result))
}
