//! Observational report for authenticated foreground reply evidence.
use super::{
    lance_scope::LanceScope,
    ledger::io,
    registry::{JobBody, JobContext, JobReport},
    reply_feedback,
};
use crate::{
    contract::{Cancel, EngineError, JobName, JobOutcome, StoreError},
    neo::{capture_journal::CaptureJournal, job_turns},
    recall::knowledge::private_key,
    store::{directory::TrustedDirectory, kernel_lease},
};
use serde_json::json;
use std::{
    path::PathBuf,
    sync::Arc,
    time::{Duration, Instant},
};

const FILE: &str = "feedback-report.json";
const MAX_BYTES: usize = 512 * 1024;

pub(crate) struct FeedbackReport {
    pub scope: Arc<LanceScope>,
    pub base: PathBuf,
    pub root: PathBuf,
}

impl JobBody for FeedbackReport {
    fn name(&self) -> JobName {
        JobName::FeedbackReport
    }

    fn run(&self, context: &JobContext, cancel: &Cancel) -> Result<JobReport, EngineError> {
        let cancel = &cancel.limited_to(Instant::now() + Duration::from_secs(60));
        let authority = context.authority()?;
        let (principal, agent) = authority.caller();
        let _operation = self.scope.operations.enter(principal, agent)?;
        if let Some(skip) = self.scope.check(authority, cancel)? {
            return Ok(skip);
        }
        let host = self.scope.operations.host_handle();
        let journal = match CaptureJournal::open(&self.root, host, self.scope.policy.clone()) {
            Ok(journal) => journal,
            Err(StoreError::Io {
                kind: std::io::ErrorKind::NotFound,
            }) => return Ok(no_feedback()),
            Err(error) => return Err(error.into()),
        };
        let check = || -> Result<(), EngineError> {
            if self.scope.check(authority, cancel)?.is_some() {
                return Err(StoreError::Unavailable.into());
            }
            Ok(())
        };
        let binding = private_key(authority.request()).ok_or(StoreError::InvalidInput)?;
        job_turns::with_conversation_turns(
            &journal,
            authority,
            context.now_ms,
            cancel,
            &check,
            |turns, _, check| {
                let replies = reply_feedback::collect(&turns, cancel)?;
                if replies.is_empty() {
                    return Ok(no_feedback());
                }
                let mut counts = [0usize; 3];
                let mut confidence = [0.; 3];
                let mut by_outcome = std::collections::BTreeMap::new();
                for reply in &replies {
                    let index = match reply.feedback {
                        "positive" => 0,
                        "negative" => 1,
                        _ => 2,
                    };
                    counts[index] += 1;
                    confidence[index] += reply.confidence;
                    *by_outcome.entry(reply.classification).or_insert(0usize) += 1;
                }
                let [positive, negative, neutral] = counts;
                let averages = counts.map(|count| count as f64);
                let mean = |i: usize| {
                    if counts[i] > 0 {
                        json!({"confidence": confidence[i] / averages[i]})
                    } else {
                        json!({})
                    }
                };
                let from = replies.first().map_or(0, |entry| entry.response.timestamp);
                let to = replies.last().map_or(0, |entry| entry.response.timestamp);
                let report = json!({
                    "generatedAt":context.now_ms, "totalEntries":replies.len(),
                    "positiveCount":positive, "negativeCount":negative, "neutralCount":neutral,
                    "topPositive":[], "topNegative":[], "queriesWithBadRecall":[],
                    "averageScoreComponents":{"positive":mean(0),"negative":mean(1),"neutral":mean(2)},
                    "timeRange":{"from":from,"to":to}, "replyOutcomes":by_outcome,
                });
                let bytes = serde_json::to_vec(&report).map_err(|_| StoreError::Corrupt)?;
                let dir = TrustedDirectory::open(&self.base)?
                    .create_child("_reflection")?
                    .create_child(&binding)?;
                let lease = kernel_lease::acquire(&dir, "feedback-report", cancel, &mut || {})?;
                let before = io::read(&dir, FILE, MAX_BYTES, cancel)?;
                let check_output = || {
                    check()?;
                    lease.check(&dir)?;
                    Ok(())
                };
                if before.as_deref() != Some(bytes.as_slice()) {
                    io::replace(
                        &dir,
                        FILE,
                        before.as_deref(),
                        &bytes,
                        MAX_BYTES,
                        cancel,
                        &check_output,
                    )?;
                }
                for (name, count) in [
                    ("totalEntries", replies.len()),
                    ("positiveCount", positive),
                    ("negativeCount", negative),
                    ("neutralCount", neutral),
                ] {
                    context.note_count(name, count)?;
                }
                Ok(JobReport::completed())
            },
        )
    }
}

fn no_feedback() -> JobReport {
    JobReport {
        outcome: JobOutcome::Skipped,
        reason: Some("no_feedback".into()),
    }
}
