//! Classify recent private cards. Provider failures leave their type eligible for retry.
use super::{
    lance_scope::LanceScope,
    llm::{has_direct_transport, CompleteFor, JobCompletion},
    registry::{JobBody, JobContext, JobReport},
};
use crate::{
    capture::critical,
    contract::{Cancel, EngineError, JobName, JobOutcome, MemoryRow, StoreError},
    recall::{acl, lifecycle::is_recall_entry_live, tombstone_mask::TombstoneMask},
    text::{js::js_to_lower_case, json::parse_json},
};
use std::{
    collections::{HashMap, HashSet},
    path::PathBuf,
    sync::Arc,
    time::{Duration, Instant},
};

const DEFAULT_WINDOW_MINUTES: f64 = 1440.;
pub(crate) struct ClassifyRecent {
    pub scope: Arc<LanceScope>,
    pub base: PathBuf,
    pub completion: Option<Arc<CompleteFor>>,
}

impl JobBody for ClassifyRecent {
    fn name(&self) -> JobName {
        JobName::ClassifyRecent
    }

    fn run(&self, context: &JobContext, cancel: &Cancel) -> Result<JobReport, EngineError> {
        let cancel = cancel.limited_to(Instant::now() + Duration::from_secs(300));
        let authority = context.authority()?;
        let host = self.scope.operations.host();
        let config = serde_json::to_value(host.config()).map_err(|_| StoreError::Corrupt)?;
        let settings = &config["criticalPush"];
        if settings["enabled"] == false {
            return Ok(skip("criticalPush_disabled"));
        }
        let Some(completion) = JobCompletion::resolve(
            authority,
            self.completion.as_deref(),
            self.scope.operations.host_handle(),
            &config,
            "criticalPush",
            settings,
        ) else {
            return Ok(skip(if has_direct_transport(settings) {
                "direct-feature-route-unavailable"
            } else {
                "no_llm_config"
            }));
        };
        let (principal, agent) = authority.caller();
        let _operation = self.scope.operations.enter(principal, agent)?;
        if let Some(skip) = self.scope.check(authority, &cancel)? {
            return Ok(skip);
        }
        let request = authority.request();
        let Some(store) = self.scope.stores.existing_private(request)? else {
            return Ok(JobReport::completed());
        };
        let mut filter = LanceScope::filter(authority);
        filter.status = Some("active".into());
        let minutes = settings["sinceMinutes"]
            .as_f64()
            .filter(|value| value.is_finite() && *value > 0.)
            .unwrap_or(DEFAULT_WINDOW_MINUTES);
        filter.since = Some((context.now_ms as f64 - minutes * 60_000.).ceil() as i64);
        let tombstones = TombstoneMask::new(&self.base);
        let mut rows = Vec::new();
        for row in store.recent_unclassified(&filter)? {
            cancel.check()?;
            if row.stored_by == context.agent.as_str()
                && row.workspace_key == request.workspace_key
                && acl::allowed(&row, request).is_ok()
                && is_recall_entry_live(&row, context.now_ms, None)
                && !tombstones.masks(&row)?
            {
                rows.push(row);
            }
        }
        let covered = covered_chunks(&rows, &cancel)?;
        let mut classified = 0;
        let mut chunks = 0;
        let mut errors = 0;
        // A covered piece may be labelled only when its whole actually made it
        // through classification, so a transport failure leaves the group retryable.
        let mut classified_wholes = HashSet::new();
        for row in rows
            .iter()
            .filter(|row| !covered.contains_key(row.id.as_str()))
        {
            if let Some(skip) = self.scope.check(authority, &cancel)? {
                return Ok(skip);
            }
            if tombstones.refreshed().masks(row)? {
                continue;
            }
            let kind =
                match critical::classify_with_limit(content(row), &completion, Some(16), &cancel) {
                    Ok(kind) => kind,
                    Err(_) => {
                        cancel.check()?;
                        log::warn!("classify-recent: completion failed");
                        errors += 1;
                        continue;
                    }
                };
            let provenance = parse_json(
                &serde_json::json!({
                    "sourceMessageRole":row.source_message_role, "origin":row.origin,
                    "neverForget":row.never_forget, "importance":row.importance,
                    "coreMemoryScore":row.core_memory_score,
                })
                .to_string(),
            )
            .map_err(|_| StoreError::Corrupt)?;
            let kind = if kind != "fakt" && !critical::eligible(&provenance) {
                "note"
            } else {
                kind
            };
            let _mutation = self.scope.operations.mutation()?;
            if let Some(skip) = self.scope.check(authority, &cancel)? {
                return Ok(skip);
            }
            if tombstones.refreshed().masks(row)? {
                continue;
            }
            let written = store.classify_critical_row(&filter, row, kind)?;
            classified += written;
            if written > 0 && row.chunk_group_id.is_empty() && !row.source_turn_id.is_empty() {
                classified_wholes.insert(row.id.as_str());
            }
        }
        for row in rows.iter().filter(|row| {
            covered
                .get(row.id.as_str())
                .is_some_and(|matching| matching.iter().any(|id| classified_wholes.contains(id)))
        }) {
            let _mutation = self.scope.operations.mutation()?;
            if let Some(skip) = self.scope.check(authority, &cancel)? {
                return Ok(skip);
            }
            if !tombstones.refreshed().masks(row)? {
                chunks += store.classify_critical_row(&filter, row, "fakt")?;
            }
        }
        context.note_count("classified", classified)?;
        context.note_count("skippedChunks", chunks)?;
        context.note_count("errors", errors)?;
        if errors > 0 {
            return Ok(JobReport {
                outcome: JobOutcome::Incomplete,
                reason: Some("classification_transport_failed".into()),
            });
        }
        Ok(JobReport::completed())
    }
}

fn skip(reason: &str) -> JobReport {
    JobReport {
        outcome: JobOutcome::Skipped,
        reason: Some(reason.into()),
    }
}

fn content(row: &MemoryRow) -> &str {
    if row.text.is_empty() {
        &row.summary
    } else {
        &row.text
    }
}

fn normalized(content: &str) -> String {
    static NON_WORD: std::sync::OnceLock<Option<regex::Regex>> = std::sync::OnceLock::new();
    let lower = js_to_lower_case(content);
    let Some(non_word) = NON_WORD.get_or_init(|| regex::Regex::new(r"[^\p{L}\p{N}]+").ok()) else {
        return String::new();
    };
    non_word.replace_all(&lower, " ").trim().to_owned()
}

fn covered_chunks<'a>(
    rows: &'a [MemoryRow],
    cancel: &Cancel,
) -> Result<HashMap<&'a str, HashSet<&'a str>>, EngineError> {
    let mut groups = HashMap::<&str, Vec<&MemoryRow>>::new();
    let mut wholes = HashMap::<&str, Vec<(&str, String)>>::new();
    for row in rows {
        cancel.check()?;
        if row.source_turn_id.is_empty() {
            continue;
        }
        if row.chunk_group_id.is_empty() {
            wholes
                .entry(&row.source_turn_id)
                .or_default()
                .push((row.id.as_str(), normalized(content(row))));
        } else {
            groups.entry(&row.chunk_group_id).or_default().push(row);
        }
    }
    let mut covered = HashMap::new();
    for parts in groups.into_values() {
        cancel.check()?;
        let Some(first) = parts.first() else { continue };
        let turn = first.source_turn_id.as_str();
        if parts.iter().any(|part| part.source_turn_id != turn) {
            continue;
        }
        let Some(wholes) = wholes.get(turn) else {
            continue;
        };
        let parts_text = parts
            .iter()
            .map(|part| normalized(content(part)))
            .filter(|value| !value.is_empty())
            .collect::<Vec<_>>();
        if parts_text.is_empty() {
            continue;
        }
        let covering: HashSet<_> = wholes
            .iter()
            .filter(|(_, whole)| {
                parts_text
                    .iter()
                    .filter(|text| whole.contains(text.as_str()))
                    .count()
                    * 2
                    >= parts_text.len()
            })
            .map(|(id, _)| *id)
            .collect();
        if !covering.is_empty() {
            covered.extend(
                parts
                    .iter()
                    .map(|part| (part.id.as_str(), covering.clone())),
            );
        }
    }
    Ok(covered)
}
