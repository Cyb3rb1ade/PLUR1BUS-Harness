//! Refine only owned pending cards. The durable queue entry precedes the final verdict.
use super::{
    lance_scope::LanceScope,
    llm::{CompleteFor, JobCompletion},
    metadata::get,
    registry::{JobBody, JobContext, JobReport},
};
use crate::{
    capture::encoding,
    context::RequestContext,
    contract::{
        Cancel, EngineError, HostError, JobName, JobOutcome, LlmParams, LlmPort, LlmResult,
        StoreError,
    },
    recall::{acl, tombstone_mask::TombstoneMask},
    store::RowPatch,
    text::{
        js::JsString,
        json::{parse_json, TolerantJsonValue as Json},
    },
};
use std::{
    collections::BTreeMap,
    path::PathBuf,
    sync::Arc,
    time::{Duration, Instant},
};

const MAX_ROWS: usize = 100;
const DEFAULT_MAX_TOKENS: u32 = 1500;
const MAX_FAILURES: usize = 3;
const MAX_REJECTED_VERDICTS: u8 = 3;
const MAX_TRACKED_REFINEMENTS: usize = 4_096;
const RETRIES_FILE: &str = "rejected-verdicts.json";
const RETRIES_BYTES: usize = 1024 * 1024;

#[derive(Clone, serde::Deserialize, serde::Serialize)]
#[serde(deny_unknown_fields)]
struct Rejection {
    version: serde_json::Number,
    count: u8,
    last_at: i64,
}

type RejectHistory = BTreeMap<String, Rejection>;

pub(crate) struct EmotionRefine {
    pub scope: Arc<LanceScope>,
    pub base: PathBuf,
    pub completion: Option<Arc<CompleteFor>>,
}
struct EncodingPort<'a> {
    completion: JobCompletion<'a>,
    limit: u32,
}
impl LlmPort for EncodingPort<'_> {
    fn complete(&self, mut params: LlmParams, cancel: &Cancel) -> Result<LlmResult, HostError> {
        params.max_tokens = Some(self.limit.into());
        self.completion.complete(params, cancel)
    }
}
impl JobBody for EmotionRefine {
    fn name(&self) -> JobName {
        JobName::EmotionRefine
    }

    fn run(&self, context: &JobContext, cancel: &Cancel) -> Result<JobReport, EngineError> {
        let budget = cancel.limited_to(Instant::now() + Duration::from_secs(240));
        let authority = context.authority()?;
        let host = self.scope.operations.host();
        let raw = serde_json::to_value(host.config()).map_err(|_| StoreError::Corrupt)?;
        let config = crate::config::effective_config(&raw).map_err(|_| StoreError::InvalidInput)?;
        let settings = &config["emotion"]["t3"];
        let (principal, agent) = authority.caller();
        let _operation = self.scope.operations.enter(principal, agent)?;
        if let Some(skip) = self.scope.check(authority, &budget)? {
            return Ok(skip);
        }
        let request = authority.request();
        let Some(store) = self.scope.stores.existing_private(request)? else {
            return Ok(JobReport::completed());
        };
        let scope = LanceScope::filter(authority);
        let tombstones = TombstoneMask::new(&self.base);
        let key = crate::recall::knowledge::private_key(request).ok_or(StoreError::InvalidInput)?;
        let dir = crate::store::directory::TrustedDirectory::open(&self.base)?
            .create_child("_emotion_refine")?
            .create_child(&key)?;
        dir.restrict_private()?;
        let lease =
            crate::store::kernel_lease::acquire(&dir, "emotion-refine", &budget, &mut || {})?;
        let mut previous = super::ledger::io::read(&dir, RETRIES_FILE, RETRIES_BYTES, &budget)?;
        let mut rejected: RejectHistory = previous
            .as_deref()
            .map(serde_json::from_slice)
            .transpose()
            .map_err(|_| StoreError::Corrupt)?
            .unwrap_or_default();
        if rejected.len() > MAX_TRACKED_REFINEMENTS
            || rejected
                .values()
                .any(|item| !(1..=MAX_REJECTED_VERDICTS).contains(&item.count))
        {
            return Err(StoreError::Corrupt.into());
        }
        let mut rows = Vec::new();
        let mut offset = 0;
        while rows.len() <= MAX_ROWS {
            budget.check()?;
            let page = store.pending_job_refinement(&scope, offset, MAX_ROWS)?;
            let read = page.len();
            for row in page {
                if row.stored_by == context.agent.as_str()
                    && row.workspace_key == request.workspace_key
                    && acl::allowed(&row, request).is_ok()
                    && !tombstones.masks(&row)?
                {
                    rows.push(row);
                }
            }
            if read < MAX_ROWS {
                break;
            }
            offset = offset.checked_add(read).ok_or(StoreError::Unavailable)?;
        }
        let completion = JobCompletion::resolve(
            authority,
            self.completion.as_deref(),
            self.scope.operations.host_handle(),
            &config,
            "emotion-encoding",
            settings,
        );
        let limit = settings["encodingMaxTokens"]
            .as_f64()
            .filter(|value| value.is_finite() && *value >= 1.)
            .map_or(DEFAULT_MAX_TOKENS, |value| value.floor() as u32);
        let port = completion.map(|completion| EncodingPort { completion, limit });
        let mut refined = 0;
        let mut finalized = 0;
        let mut failed = 0;
        let mut poisoned = 0;
        let mut consecutive = 0;
        let mut deadline_hit = false;
        let mut record_rejection = |rejected: &mut RejectHistory,
                                    row: &crate::contract::MemoryRow,
                                    now| {
            let _mutation = self.scope.operations.mutation()?;
            let count = note_rejection(rejected, row, now);
            let bytes = serde_json::to_vec(&rejected).map_err(|_| StoreError::Corrupt)?;
            super::ledger::io::replace(
                &dir,
                RETRIES_FILE,
                previous.as_deref(),
                &bytes,
                RETRIES_BYTES,
                &budget,
                &|| {
                    lease.check(&dir)?;
                    if self.scope.check(authority, &budget)?.is_some()
                        || serde_json::to_value(host.config()).map_err(|_| StoreError::Corrupt)?
                            != raw
                        || tombstones.refreshed().masks(row)?
                    {
                        return Err(StoreError::Unavailable.into());
                    }
                    Ok(())
                },
            )?;
            previous = Some(bytes);
            Ok::<_, EngineError>(count)
        };
        for row in rows.iter().take(MAX_ROWS) {
            cancel.check()?;
            if budget.is_cancelled() {
                deadline_hit = true;
                break;
            }
            if let Some(skip) = self.scope.check(authority, &budget)? {
                return Ok(skip);
            }
            if tombstones.refreshed().masks(row)? {
                continue;
            }
            let inactive = !matches!(row.status.as_str(), "" | "active");
            let final_verdict = || RowPatch {
                emotion_status: Some("final".into()),
                importance_status: Some("final".into()),
                ..RowPatch::default()
            };
            let mut exhausted = rejected.get(&row.id).is_some_and(|item| {
                item.version == row.version_number && item.count == MAX_REJECTED_VERDICTS
            });
            let patch = if inactive || exhausted {
                final_verdict()
            } else {
                let Some(port) = &port else {
                    continue;
                };
                let encoding =
                    encoding::classify(&JsString::from(row.text.as_str()), Some(port), &budget)?;
                let value =
                    parse_json(&serde_json::to_string(row).map_err(|_| StoreError::Corrupt)?)
                        .map_err(|_| StoreError::Corrupt)?;
                let patch = encoding::refine_patch(
                    &value,
                    &encoding,
                    host.now_ms(),
                    config["memoryDynamics"]["flashbulbEncoding"] == true,
                );
                if let Some(patch) = patch {
                    consecutive = 0;
                    patch_columns(&patch)
                } else {
                    if get(&encoding, "callFailed") == Some(&Json::Bool(true)) {
                        failed += 1;
                        consecutive += 1;
                        if consecutive == MAX_FAILURES {
                            break;
                        }
                        continue;
                    }
                    consecutive = 0;
                    poisoned += 1;
                    if record_rejection(&mut rejected, row, context.now_ms)? < MAX_REJECTED_VERDICTS
                    {
                        continue;
                    }
                    exhausted = true;
                    final_verdict()
                }
            };
            let _mutation = self.scope.operations.mutation()?;
            if let Some(skip) = self.scope.check(authority, &budget)? {
                return Ok(skip);
            }
            if serde_json::to_value(host.config()).map_err(|_| StoreError::Corrupt)? != raw {
                return Err(StoreError::Unavailable.into());
            }
            if tombstones.refreshed().masks(row)? {
                continue;
            }
            if !inactive
                && !exhausted
                && row.importance_status == "pending"
                && config["schicht15"]["enabled"] == true
                && matches!(row.category.as_str(), "fact" | "decision")
            {
                let check = || -> Result<(), EngineError> {
                    budget.check()?;
                    if self.scope.check(authority, &budget)?.is_some()
                        || !same_refinement_source(&store, row, request)?
                    {
                        return Err(StoreError::Unavailable.into());
                    }
                    Ok(())
                };
                crate::ops::refinement_queue::stage(host, request, row, &budget, &check)?;
            }
            let written = store.refine_pending_row(&scope, row, &patch)?;
            if inactive || exhausted {
                finalized += written;
            } else {
                refined += written;
            }
        }
        for (name, count) in [
            ("refined", refined),
            ("finalized", finalized),
            ("failed", failed),
            ("poisoned", poisoned),
            ("pending", rows.len().saturating_sub(refined + finalized)),
            ("scanned", rows.len().min(MAX_ROWS)),
            ("deadlineHit", usize::from(deadline_hit)),
        ] {
            context.note_count(name, count)?;
        }
        if port.is_none() && rows.len() > finalized {
            return Ok(JobReport {
                outcome: JobOutcome::Skipped,
                reason: Some("no_llm_route".into()),
            });
        }
        Ok(JobReport::completed())
    }
}

fn note_rejection(history: &mut RejectHistory, row: &crate::contract::MemoryRow, now: i64) -> u8 {
    let saved = history.entry(row.id.clone()).or_insert_with(|| Rejection {
        version: row.version_number.clone(),
        count: 0,
        last_at: now,
    });
    if saved.version != row.version_number {
        saved.version = row.version_number.clone();
        saved.count = 0;
    }
    saved.count = saved.count.saturating_add(1).min(MAX_REJECTED_VERDICTS);
    saved.last_at = now;
    let count = saved.count;
    if history.len() > MAX_TRACKED_REFINEMENTS {
        let oldest = history
            .iter()
            .min_by_key(|(_, entry)| entry.last_at)
            .map(|(id, _)| id.clone());
        if let Some(id) = oldest {
            history.remove(&id);
        }
    }
    count
}

fn same_refinement_source(
    store: &crate::store::Store,
    row: &crate::contract::MemoryRow,
    request: &RequestContext,
) -> Result<bool, EngineError> {
    let Some(current) = store.get(&row.id)? else {
        return Ok(false);
    };
    Ok(acl::allowed(&current, request).is_ok()
        && current.agent_id == row.agent_id
        && current.stored_by == row.stored_by
        && current.owner_user_id == row.owner_user_id
        && current.workspace_key == row.workspace_key
        && current.workspace_id == row.workspace_id
        && current.scope == row.scope
        && current.text == row.text
        && current.status == row.status
        && current.category == row.category
        && current.emotion_status == row.emotion_status
        && current.version_number == row.version_number
        && current.importance_status == "pending"
        && current.importance == row.importance
        && current.updated_at == row.updated_at)
}

fn patch_columns(value: &Json) -> RowPatch {
    let number = |name| match get(value, name) {
        Some(Json::Number(raw)) => raw.parse().ok(),
        _ => None,
    };
    let string = |name| match get(value, name) {
        Some(Json::String(raw)) => Some(raw.to_utf8_lossy()),
        _ => None,
    };
    RowPatch {
        emotional_valence: string("emotionalValence"),
        emotional_intensity: number("emotionalIntensity"),
        emotional_dominant: string("emotionalDominant"),
        emotion_status: string("emotionStatus"),
        importance: number("importance"),
        importance_status: string("importanceStatus"),
        half_life_days: number("halfLifeDays"),
        core_memory_reason: string("coreMemoryReason"),
        memory_strength: number("memoryStrength"),
        last_strengthened_at: number("lastStrengthenedAt"),
        last_dynamics_at: number("lastDynamicsAt"),
        memory_class: string("memoryClass"),
        ..RowPatch::default()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn bad_verdicts_exhaust_once_per_row_revision() {
        let mut row = crate::capture::row_defaults::schema_defaults(vec![]);
        row.id = "one-row".into();
        let mut history = RejectHistory::new();
        for count in 1..=MAX_REJECTED_VERDICTS {
            assert_eq!(note_rejection(&mut history, &row, 100), count);
        }
        assert_eq!(
            note_rejection(&mut history, &row, 101),
            MAX_REJECTED_VERDICTS
        );
        row.version_number = 2.into();
        assert_eq!(note_rejection(&mut history, &row, 102), 1);
    }
}
