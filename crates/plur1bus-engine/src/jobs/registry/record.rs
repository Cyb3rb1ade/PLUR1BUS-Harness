//! Frozen run fields and explicit versioned-ledger metadata projection.
use super::{
    notes::{Notes, State},
    JobContext, JobReport,
};
use crate::{
    contract::*,
    jobs::{authority::JobAuthority, metadata},
    text::json::{parse_exact, parse_json, write_json, TolerantJsonValue as Json},
};
use serde_json::{json, Value};
use std::sync::Arc;

pub(super) struct Draft {
    job: JobName,
    agent: AgentId,
    trigger: JobTrigger,
    started: i64,
    id: String,
}
impl Draft {
    pub(super) fn new(
        job: JobName,
        agent: AgentId,
        trigger: JobTrigger,
        started: i64,
        id: String,
    ) -> Result<Self, EngineError> {
        validate_time(started)?;
        for (value, max) in [(agent.to_string(), 64), (id.clone(), 128)] {
            if value.is_empty()
                || value.len() > max
                || !value
                    .bytes()
                    .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
            {
                return Err(StoreError::InvalidInput.into());
            }
        }
        Ok(Self {
            job,
            agent,
            trigger,
            started,
            id,
        })
    }
    pub(super) fn context(
        &self,
        snapshot: Arc<Vec<Json>>,
        cancel: Cancel,
        authority: Option<JobAuthority>,
    ) -> JobContext {
        JobContext {
            agent: self.agent.clone(),
            trigger: self.trigger,
            now_ms: self.started,
            authority: authority.map(Arc::new),
            notes: Arc::new(State::new(snapshot, cancel)),
        }
    }
    pub(super) fn sweep(&self) -> Result<String, EngineError> {
        metadata::sweep(self.started as f64)
    }
    fn phase(&self) -> Option<JobRunPhase> {
        match self.job {
            JobName::RemDream => Some(JobRunPhase::Rem),
            JobName::ConsolidateDaily => Some(JobRunPhase::Deep),
            JobName::LightDream => Some(JobRunPhase::Light),
            _ => None,
        }
    }
    pub(super) fn marker(&self) -> Result<Json, EngineError> {
        // JobLedger projects these into the fixed Node marker field order.
        to_json(
            &json!({"runId":self.id,"job":self.job,"phase":self.phase(),"trigger":self.trigger,"startedAt":self.started}),
        )
    }
    pub(super) fn finish(
        self,
        mut report: JobReport,
        snapshot: &[Json],
        finished: i64,
        notes: Notes,
    ) -> Result<JobRun, EngineError> {
        validate_time(finished)?;
        if report.reason.as_ref().is_some_and(|s| s.len() > 4096) {
            return Err(StoreError::InvalidInput.into());
        }
        let mut attempt = 1;
        if report.outcome != JobOutcome::Skipped {
            for row in snapshot.iter().rev() {
                if property(row, "job") != Some(&Json::String(self.job.to_string().as_str().into()))
                    || property(row, "outcome") == Some(&Json::String("skipped".into()))
                {
                    continue;
                }
                if property(row, "outcome") != Some(&Json::String("incomplete".into())) {
                    break;
                }
                if let Some(Json::Array(keys)) = property(row, "pendingKeys") {
                    if !notes.pending.is_empty()
                        && !keys.is_empty()
                        && !notes
                            .pending
                            .iter()
                            .any(|key| keys.contains(&Json::String(key.as_str().into())))
                    {
                        break;
                    }
                }
                attempt += 1;
            }
        }
        let diary = if report.outcome == JobOutcome::Incomplete && attempt >= 3 {
            report.outcome = JobOutcome::Abandoned;
            report.reason = Some(format!(
                "abandoned_after_retries:{}",
                report
                    .reason
                    .as_deref()
                    .filter(|s| !s.is_empty())
                    .unwrap_or("incomplete")
            ));
            Some(JobRunDiary {
                written: false,
                reason: Some(
                    if notes.diary_disabled {
                        "diary_disabled"
                    } else {
                        "no_workspace"
                    }
                    .into(),
                ),
            })
        } else {
            notes.diary
        };
        if report.outcome == JobOutcome::Skipped
            && report.reason.as_deref() == Some("already_processed")
            && !notes.abandoned.is_empty()
        {
            report.reason = Some("abandoned".into());
        }
        let idempotency_key = notes
            .pending
            .first()
            .or_else(|| notes.keys.first())
            .cloned();
        let duration = finished.saturating_sub(self.started).max(0);
        Ok(JobRun {
            run_id: self.id.clone(),
            job: self.job,
            phase: self.phase(),
            agent_id: self.agent,
            trigger: self.trigger,
            started_at: self.started.into(),
            finished_at: finished.into(),
            duration_ms: duration.into(),
            outcome: report.outcome,
            reason: report.reason.filter(|s| !s.is_empty()),
            attempt: attempt.into(),
            cost: JobCost {
                ms: duration.into(),
                input_tokens: None,
                output_tokens: None,
                model: None,
                provider: None,
            },
            counts: notes.counts,
            keys: (!notes.keys.is_empty()).then_some(notes.keys),
            pending_keys: (!notes.pending.is_empty()).then_some(notes.pending),
            idempotency_key,
            migrated: None,
            diary,
        })
    }
}
fn validate_time(ms: i64) -> Result<(), EngineError> {
    metadata::sweep(ms as f64)?;
    Ok(())
}
fn to_json(value: &Value) -> Result<Json, EngineError> {
    parse_json(&value.to_string()).map_err(|_| StoreError::Corrupt.into())
}
pub(super) fn persisted(run: &JobRun) -> Result<Json, EngineError> {
    let mut value = serde_json::to_value(run).map_err(|_| StoreError::Corrupt)?;
    let fields = value.as_object_mut().ok_or(StoreError::Corrupt)?;
    let mut ordered = Vec::new();
    for name in [
        "runId",
        "job",
        "phase",
        "agentId",
        "trigger",
        "startedAt",
        "finishedAt",
        "durationMs",
        "outcome",
        "reason",
        "attempt",
        "cost",
        "counts",
        "keys",
        "pendingKeys",
        "idempotencyKey",
        "diary",
        "migrated",
    ] {
        // Optional null phase is mandatory on the frozen JobRun wire and in Node rows.
        let value = fields
            .remove(name)
            .or_else(|| (name == "phase").then_some(Value::Null));
        if let Some(value) = value {
            let value = if name == "diary" {
                let diary = run.diary.as_ref().ok_or(StoreError::Corrupt)?;
                let mut fields = vec![("written".into(), Json::Bool(diary.written))];
                if let Some(reason) = &diary.reason {
                    fields.push(("reason".into(), Json::String(reason.as_str().into())));
                }
                Json::Object(fields)
            } else {
                to_json(&value)?
            };
            ordered.push((name.into(), value));
        }
    }
    ordered.push((
        "sweep".into(),
        to_json(&json!(metadata::sweep(
            run.started_at.as_f64().ok_or(StoreError::Corrupt)?
        )?))?,
    ));
    ordered.push((
        "llmSession".into(),
        Json::Bool(
            matches!(run.phase, Some(JobRunPhase::Rem | JobRunPhase::Deep))
                && run.outcome != JobOutcome::Skipped,
        ),
    ));
    Ok(Json::Object(ordered))
}
pub(super) fn with_partition(
    mut value: Json,
    partition: Option<&super::partition::Partition>,
) -> Json {
    if let (Json::Object(fields), Some(partition)) = (&mut value, partition) {
        fields.push((
            "partition".into(),
            Json::String(partition.token.as_str().into()),
        ));
        if let Some(due) = &partition.due {
            fields.push(("due".into(), Json::String(due.as_str().into())));
        }
        if let Some(idempotency) = &partition.idempotency {
            if fields
                .iter()
                .all(|(k, _)| k.to_utf8_lossy() != "idempotencyKey")
            {
                fields.push((
                    "idempotencyKey".into(),
                    Json::String(idempotency.as_str().into()),
                ));
            }
        }
    }
    value
}

pub(super) fn decode(row: &Json, agent: &AgentId) -> Result<JobRun, EngineError> {
    let mut value = parse_exact(&write_json(row)).map_err(|_| StoreError::Corrupt)?;
    let fields = value.as_object_mut().ok_or(StoreError::Corrupt)?;
    if fields.remove("v") != Some(json!(1)) {
        return Err(StoreError::Corrupt.into());
    }
    fields.remove("partition");
    fields.remove("due");
    let sweep = fields.remove("sweep").ok_or(StoreError::Corrupt)?;
    let session = fields.remove("llmSession").ok_or(StoreError::Corrupt)?;
    let run: JobRun = serde_json::from_value(value).map_err(|_| StoreError::Corrupt)?;
    if &run.agent_id != agent
        || sweep
            != json!(metadata::sweep(
                run.started_at.as_f64().ok_or(StoreError::Corrupt)?
            )?)
        || session
            != json!(
                run.migrated != Some(true)
                    && matches!(run.phase, Some(JobRunPhase::Rem | JobRunPhase::Deep))
                    && run.outcome != JobOutcome::Skipped
            )
    {
        return Err(StoreError::Corrupt.into());
    }
    Ok(run)
}

fn property<'a>(value: &'a Json, name: &str) -> Option<&'a Json> {
    let Json::Object(fields) = value else {
        return None;
    };
    fields
        .iter()
        .rev()
        .find(|(k, _)| k.to_utf8_lossy() == name)
        .map(|(_, v)| v)
}

pub(super) fn uses_breaker(job: JobName) -> bool {
    matches!(job, JobName::RemDream | JobName::ConsolidateDaily)
}
pub(super) fn sessions(rows: &[Json], sweep: &str) -> usize {
    let day = Json::String(sweep.into());
    rows.iter().filter(|row| property(row, "sweep") == Some(&day)
        && property(row, "llmSession") == Some(&Json::Bool(true))
        && matches!(property(row, "phase"), Some(Json::String(phase)) if matches!(phase.to_utf8_lossy().as_str(), "rem" | "deep"))).count()
}
