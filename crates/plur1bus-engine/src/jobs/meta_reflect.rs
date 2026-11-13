//! Owner-bound coverage and reply metrics without inferring missing Recall evidence.
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
    text::json::{write_json, TolerantJsonValue as Json},
};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{
    collections::{BTreeMap, BTreeSet},
    path::PathBuf,
    sync::Arc,
    time::{Duration, Instant},
};

const FILE: &str = "meta-cognition-metrics.json";
const MAX_BYTES: usize = 512 * 1024;

pub(crate) struct MetaReflect {
    pub scope: Arc<LanceScope>,
    pub base: PathBuf,
    pub root: PathBuf,
}

impl JobBody for MetaReflect {
    fn name(&self) -> JobName {
        JobName::MetaReflect
    }

    fn run(&self, context: &JobContext, cancel: &Cancel) -> Result<JobReport, EngineError> {
        let cancel = &cancel.limited_to(Instant::now() + Duration::from_secs(60));
        let authority = context.authority()?;
        let (principal, agent) = authority.caller();
        let _operation = self.scope.operations.enter(principal, agent)?;
        let host = self.scope.operations.host_handle();
        let raw = serde_json::to_value(host.config()).map_err(|_| StoreError::Corrupt)?;
        let config = crate::config::effective_config(&raw).map_err(|_| StoreError::InvalidInput)?;
        if config["metaCognition"]["enabled"] == false {
            return Ok(skip("meta_cognition_disabled"));
        }
        if let Some(skip) = self.scope.check(authority, cancel)? {
            return Ok(skip);
        }
        let check = || -> Result<(), EngineError> {
            if self.scope.check(authority, cancel)?.is_some()
                || serde_json::to_value(host.config()).map_err(|_| StoreError::Corrupt)? != raw
            {
                return Err(StoreError::Unavailable.into());
            }
            Ok(())
        };
        let journal =
            match CaptureJournal::open(&self.root, host.clone(), self.scope.policy.clone()) {
                Ok(journal) => journal,
                Err(StoreError::Io {
                    kind: std::io::ErrorKind::NotFound,
                }) => return Ok(skip("no_turns")),
                Err(error) => return Err(error.into()),
            };
        let binding = private_key(authority.request()).ok_or(StoreError::InvalidInput)?;
        let now = context.now_ms;
        job_turns::with_conversation_turns(
            &journal,
            authority,
            now,
            cancel,
            &check,
            |turns, source_dir, check| {
                let Some(last) = turns.first() else {
                    return Ok(skip("no_turns"));
                };
                let mut hash = Sha256::new();
                hash.update(binding.as_bytes());
                hash.update([0]);
                hash.update(last.session.to_json().as_bytes());
                let key = format!("reflection:{:x}", hash.finalize());
                if context.has_completed_key(&key)? {
                    return Ok(skip("already_reflected"));
                }
                let replies = reply_feedback::collect(&turns, cancel)?;
                let mut counts = [0usize; 3];
                for entry in replies
                    .iter()
                    .filter(|entry| entry.response.session == last.session)
                {
                    let index = match entry.feedback {
                        "positive" => 0,
                        "negative" => 1,
                        _ => 2,
                    };
                    counts[index] += 1;
                }
                let candidates =
                    job_turns::private_candidates(source_dir, authority.request(), cancel)?;
                let gaps = coverage(&candidates, cancel)?;
                let report = json!({
                    "generatedAt":chrono::DateTime::from_timestamp_millis(now).ok_or(StoreError::InvalidInput)?
                        .to_rfc3339_opts(chrono::SecondsFormat::Millis, true),
                    "sessionId":last.session.to_utf8_lossy(),"classification":"recall_evidence_unavailable",
                    "metrics":null,"gapCount":gaps.len(),"gaps":gaps.iter().take(20).collect::<Vec<_>>(),
                    "replyFeedback":{"positive":counts[0],"negative":counts[1],"neutral":counts[2]},
                });
                let bytes = serde_json::to_vec(&report).map_err(|_| StoreError::Corrupt)?;
                let dir = TrustedDirectory::open(&self.base)?
                    .create_child("_reflection")?
                    .create_child(&binding)?;
                let lease = kernel_lease::acquire(&dir, "meta-reflect", cancel, &mut || {})?;
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
                context.note_count("gaps", gaps.len())?;
                context.note_count("replyFeedback", counts.iter().sum())?;
                context.mark_completed_key(&key)?;
                Ok(JobReport::completed())
            },
        )
    }
}

fn coverage(rows: &[Json], cancel: &Cancel) -> Result<Vec<Value>, EngineError> {
    let mut topics = BTreeMap::<String, (Vec<String>, f64)>::new();
    for row in rows {
        cancel.check()?;
        let row: Value = serde_json::from_str(&write_json(row)).map_err(|_| StoreError::Corrupt)?;
        if row["deleted"] == true
            || matches!(
                row["status"].as_str(),
                Some("deleted" | "tombstoned" | "pruned" | "superseded")
            )
        {
            continue;
        }
        let Some(id) = row["id"].as_str() else {
            continue;
        };
        let Some(labels) = row["topics"].as_array() else {
            continue;
        };
        let strength = row["memoryStrength"].as_f64().unwrap_or(1.);
        let mut seen = BTreeSet::new();
        for topic in labels.iter().filter_map(Value::as_str).take(32) {
            if topic.is_empty() || topic.len() > 256 || !seen.insert(topic) {
                continue;
            }
            let (ids, total) = topics.entry(topic.to_owned()).or_default();
            ids.push(id.to_owned());
            *total += strength;
        }
    }
    let mut gaps = Vec::new();
    for (topic, (ids, total)) in topics {
        let average = total / ids.len() as f64;
        if ids.len() < 3 || average < 0.5 {
            gaps.push(((average * 100.).round() / 100., topic, ids));
        }
    }
    gaps.sort_by(|a, b| a.0.total_cmp(&b.0).then(a.1.cmp(&b.1)));
    Ok(gaps
        .into_iter()
        .map(|(average, topic, ids)| {
            json!({
                "topic":topic,"memoryCount":ids.len(),"avgStrength":average,"memoryIds":ids,
            })
        })
        .collect())
}

fn skip(reason: &str) -> JobReport {
    JobReport {
        outcome: JobOutcome::Skipped,
        reason: Some(reason.into()),
    }
}
