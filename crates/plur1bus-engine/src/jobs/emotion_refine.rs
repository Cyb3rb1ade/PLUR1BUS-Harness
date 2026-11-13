//! Refine only owned pending cards. The durable queue entry precedes the final verdict.
use super::{
    lance_scope::LanceScope,
    llm::{has_direct_transport, host_model, CompleteFor, JobCompletion},
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
    recall::acl,
    store::RowPatch,
    text::{
        js::JsString,
        json::{parse_json, TolerantJsonValue as Json},
    },
};
use std::{
    sync::Arc,
    time::{Duration, Instant},
};

const MAX_ROWS: usize = 100;
const DEFAULT_MAX_TOKENS: u32 = 1500;
const MAX_FAILURES: usize = 3;

pub(crate) struct EmotionRefine {
    pub scope: Arc<LanceScope>,
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
        let rows: Vec<_> = store
            .pending_job_refinement(&scope, MAX_ROWS + 1)?
            .into_iter()
            .filter(|row| {
                row.stored_by == context.agent.as_str()
                    && row.workspace_key == request.workspace_key
                    && acl::allowed(row, request).is_ok()
            })
            .collect();
        let Some(complete) = self
            .completion
            .as_deref()
            .filter(|_| !has_direct_transport(settings))
        else {
            context.note_count("pending", rows.len())?;
            return Ok(JobReport {
                outcome: JobOutcome::Skipped,
                reason: Some("no_llm_route".into()),
            });
        };
        let limit = settings["encodingMaxTokens"]
            .as_f64()
            .filter(|value| value.is_finite() && *value >= 1.)
            .map_or(DEFAULT_MAX_TOKENS, |value| value.floor() as u32);
        let port = EncodingPort {
            completion: JobCompletion {
                authority,
                complete,
                model: host_model(
                    &config,
                    &context.agent,
                    "emotion-encoding",
                    &settings["model"],
                ),
            },
            limit,
        };
        let mut refined = 0;
        let mut finalized = 0;
        let mut failed = 0;
        let mut poisoned = 0;
        let mut consecutive = 0;
        let mut deadline_hit = false;
        for row in rows.iter().take(MAX_ROWS) {
            cancel.check()?;
            if budget.is_cancelled() {
                deadline_hit = true;
                break;
            }
            if let Some(skip) = self.scope.check(authority, &budget)? {
                return Ok(skip);
            }
            let inactive = !matches!(row.status.as_str(), "" | "active");
            let patch = if inactive {
                RowPatch {
                    emotion_status: Some("final".into()),
                    importance_status: Some("final".into()),
                    ..RowPatch::default()
                }
            } else {
                let encoding =
                    encoding::classify(&JsString::from(row.text.as_str()), Some(&port), &budget)?;
                let value =
                    parse_json(&serde_json::to_string(row).map_err(|_| StoreError::Corrupt)?)
                        .map_err(|_| StoreError::Corrupt)?;
                let Some(patch) = encoding::refine_patch(
                    &value,
                    &encoding,
                    host.now_ms(),
                    config["memoryDynamics"]["flashbulbEncoding"] == true,
                ) else {
                    if get(&encoding, "callFailed") == Some(&Json::Bool(true)) {
                        failed += 1;
                        consecutive += 1;
                        if consecutive == MAX_FAILURES {
                            break;
                        }
                    } else {
                        poisoned += 1;
                    }
                    continue;
                };
                consecutive = 0;
                patch_columns(&patch)
            };
            let _mutation = self.scope.operations.mutation()?;
            if let Some(skip) = self.scope.check(authority, &budget)? {
                return Ok(skip);
            }
            if serde_json::to_value(host.config()).map_err(|_| StoreError::Corrupt)? != raw {
                return Err(StoreError::Unavailable.into());
            }
            if !inactive
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
            if inactive {
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
        Ok(JobReport::completed())
    }
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
