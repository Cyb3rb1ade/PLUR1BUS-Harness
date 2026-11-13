//! REM analysis and publication for one exact private partition.
mod patterns;

use super::{
    content_guard, dream_diary, dream_memory,
    lance_scope::LanceScope,
    light_dream::clean,
    llm::{CompleteFor, JobCompletion, Purpose},
    prompts::{self, DreamMode},
    registry::{JobBody, JobContext, JobReport},
    rem_clusters,
};
use crate::{
    capture::emotion_pool::EmotionalPool,
    contract::{Cancel, EngineError, JobName, JobOutcome, JobTrigger, LlmPort, StoreError},
    neo::{acl::Visibility, capture_journal::CaptureJournal, dream_sources},
    recall::tombstone_mask::TombstoneMask,
    text::js::JsString,
};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{
    path::PathBuf,
    sync::Arc,
    time::{Duration, Instant},
};

const MAX_PATTERNS: usize = 32;

pub(crate) struct RemDream {
    pub scope: Arc<LanceScope>,
    pub base: PathBuf,
    pub root: PathBuf,
    pub completion: Option<Arc<CompleteFor>>,
    pub memory: dream_memory::DreamMemory,
    pub mood: Arc<EmotionalPool>,
}

impl JobBody for RemDream {
    fn name(&self) -> JobName {
        JobName::RemDream
    }

    fn run(&self, context: &JobContext, cancel: &Cancel) -> Result<JobReport, EngineError> {
        let cancel = &cancel.limited_to(Instant::now() + Duration::from_secs(240));
        if !matches!(context.trigger, JobTrigger::Harness | JobTrigger::Manual) {
            return Ok(report(JobOutcome::Skipped, "unsupported_trigger"));
        }
        let authority = context.authority()?;
        let (principal, agent) = authority.caller();
        let _operation = self.scope.operations.enter(principal, agent)?;
        let host = self.scope.operations.host_handle();
        let config = serde_json::to_value(host.config()).map_err(|_| StoreError::Corrupt)?;
        if config["neo"]["enabled"] == false {
            return Ok(report(JobOutcome::Skipped, "neo_disabled"));
        }
        if config["merging"]["enabled"] == false {
            return Ok(report(JobOutcome::Skipped, "no_llm_config"));
        }
        if let Some(skip) = self.scope.check(authority, cancel)? {
            return Ok(skip);
        }
        let check = || {
            if self.scope.check(authority, cancel)?.is_some()
                || serde_json::to_value(host.config()).map_err(|_| StoreError::Corrupt)? != config
            {
                return Err(StoreError::Unavailable.into());
            }
            Ok(())
        };
        let request = authority.request();
        let Some(store) = self.scope.stores.existing_private(request)? else {
            return Ok(report(JobOutcome::Skipped, "too_few_memories"));
        };
        let journal =
            match CaptureJournal::open(&self.root, host.clone(), self.scope.policy.clone()) {
                Ok(journal) => journal,
                Err(StoreError::Io {
                    kind: std::io::ErrorKind::NotFound,
                }) => return Ok(report(JobOutcome::Skipped, "acl_sink_missing")),
                Err(error) => return Err(error.into()),
            };
        let zone = config["timezone"]
            .as_str()
            .and_then(|value| value.parse().ok())
            .unwrap_or(chrono_tz::Europe::Zurich);
        let week = rem_clusters::previous_week(context.now_ms, zone)?;
        let run_key = format!(
            "rem-{:x}",
            Sha256::digest(
                serde_json::to_vec(&[
                    request.agent_id.as_str(),
                    &request.owner_user_id,
                    &request.workspace_key,
                    &week.key
                ])
                .map_err(|_| StoreError::Corrupt)?,
            )
        );
        if context.has_completed_key(&run_key)? {
            return Ok(report(JobOutcome::Skipped, "already_processed"));
        }
        if context.is_abandoned_key(&run_key)? {
            context.note_abandoned_key(&run_key)?;
            return Ok(report(JobOutcome::Skipped, "already_abandoned"));
        }
        context.disable_diary()?;
        let visibility = Visibility {
            scope: "agent_private".into(),
            agent_id: request.agent_id.to_string(),
            workspace_identity: request.workspace_key.clone(),
            owner_user_id: request.owner_user_id.clone(),
        };
        let settings = &config["dreaming"]["narrative"];
        let publish =
            |neo: &dream_sources::RemStore<'_>, record: &Value| -> Result<Value, EngineError> {
                let rows = record["patterns"].as_array().ok_or(StoreError::Corrupt)?;
                neo.publish_patterns(rows)?;
                let mut diary = false;
                if settings["diary"] != false {
                    if let Some(narrative) = record["narrative"].as_str() {
                        let status = dream_diary::append(
                            authority,
                            host.as_ref(),
                            self.scope.policy.as_ref(),
                            &dream_diary::Entry {
                                run_key: &run_key,
                                narrative,
                                timezone: zone,
                                sources: &visibility,
                                at_ms: record["atMs"].as_i64().ok_or(StoreError::Corrupt)?,
                            },
                            cancel,
                        )?;
                        if status == dream_diary::Publication::Written {
                            host.emit(
                                "dream.completed",
                                json!({"agentId":context.agent,"mode":"rem"}),
                            );
                        }
                        diary = true;
                    }
                }
                context.note_diary(diary, (!diary).then_some("diary_not_requested"))?;
                Ok(record.clone())
            };
        let mut filter = LanceScope::filter(authority);
        filter.status = Some("active".into());
        let remote = config["embedding"]["provider"]
            .as_str()
            .is_some_and(|provider| provider != "local-transformers");
        let (limit, top_k) = if remote { (5000, 20) } else { (1000, 10) };
        let tombstones = TombstoneMask::new(&self.base);
        let candidates = || {
            rem_clusters::candidates(
                &store,
                &filter,
                request,
                &tombstones.refreshed(),
                &week,
                limit,
                cancel,
            )
        };
        let check_record_sources = |record: &Value| -> Result<(), EngineError> {
            check()?;
            if record["sourceDigest"] != source_digest(&candidates()?)? {
                return Err(StoreError::Unavailable.into());
            }
            Ok(())
        };
        let finish = |record: &Value| -> Result<JobReport, EngineError> {
            if settings["storeAsMemory"] != false && record["narrative"].is_string() {
                let stored = self.memory.publish(
                    &self.scope,
                    authority,
                    &visibility,
                    record,
                    cancel,
                    &|| check_record_sources(record),
                )?;
                context.note_count("dreamMemoriesStored", usize::from(stored))?;
            }
            for name in [
                "memoriesProcessed",
                "patternsFound",
                "new",
                "stronger",
                "weaker",
                "disappeared",
                "unchanged",
            ] {
                let value = record["counts"][name].as_u64().ok_or(StoreError::Corrupt)?;
                context.note_count(
                    name,
                    usize::try_from(value).map_err(|_| StoreError::Corrupt)?,
                )?;
            }
            context.mark_completed_key(&run_key)?;
            Ok(JobReport::completed())
        };
        let prior = {
            let _mutation = self.scope.operations.mutation()?;
            dream_sources::with_rem_store(&journal, authority, cancel, &check, |neo| {
                let Some(record) = neo.result(&run_key)? else {
                    return Ok(None);
                };
                check_record_sources(&record)?;
                publish(neo, &record).map(Some)
            })?
        };
        if let Some(result) = prior {
            return finish(&result);
        }
        let rows = candidates()?;
        let expected_source = source_digest(&rows)?;
        if rows.len() < 3 {
            context.note_count("memoriesProcessed", rows.len())?;
            return Ok(report(JobOutcome::Skipped, "too_few_memories"));
        }
        let clusters =
            rem_clusters::clusters(&store, &filter, request, &week, &rows, top_k, cancel)?;
        let empty = Value::Null;
        let Some(pattern_route) = JobCompletion::resolve(
            authority,
            self.completion.as_deref(),
            host.clone(),
            &config,
            "rem-pattern-analysis",
            &empty,
        ) else {
            return Ok(report(JobOutcome::Skipped, "no_llm_config"));
        };
        context.note_pending_key(&run_key)?;
        let created = chrono::DateTime::from_timestamp_millis(context.now_ms)
            .ok_or(StoreError::InvalidInput)?
            .to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
        let mut patterns = Vec::new();
        let mut material = Vec::new();
        for (index, cluster) in clusters.iter().take(MAX_PATTERNS).enumerate() {
            check()?;
            let samples = rem_clusters::samples(cluster, &rows);
            let evidence: Vec<_> = samples
                .iter()
                .map(|&i| JsString::from(rows[i].text.as_str()))
                .collect();
            let mut params = Purpose::RemPatternAnalysis
                .params(&prompts::guarded_rem_pattern(&evidence).text, None);
            params.max_tokens = Some(600.into());
            let answer = pattern_route.complete(params, cancel);
            cancel.check()?;
            let mut pattern = answer
                .ok()
                .and_then(|answer| patterns::parse(&answer.text))
                .unwrap_or_else(|| patterns::fallback(&evidence));
            let key = patterns::key(&pattern);
            pattern["id"] = format!("{run_key}-{index}").into();
            pattern["patternKey"] = key.into();
            pattern["memberCount"] = cluster.len().into();
            pattern["memberIds"] = json!(cluster.iter().map(|&i| &rows[i].id).collect::<Vec<_>>());
            pattern["representativeMemberIds"] =
                json!(samples.iter().map(|&i| &rows[i].id).collect::<Vec<_>>());
            patterns.push(pattern);
            let intensity = samples
                .iter()
                .map(|&i| rem_clusters::intensity(&rows[i]))
                .fold(0., f64::max);
            material.push((intensity, evidence));
        }
        let narrative = if settings["enabled"] == false {
            None
        } else {
            if material.is_empty() {
                return Ok(report(JobOutcome::Incomplete, "no_patterns"));
            }
            let Some(route) = JobCompletion::resolve(
                authority,
                self.completion.as_deref(),
                host.clone(),
                &config,
                "dream-narrative",
                &empty,
            ) else {
                return Ok(report(JobOutcome::Incomplete, "narrative_unavailable"));
            };
            material.sort_by(|a, b| b.0.total_cmp(&a.0));
            let samples: Vec<_> = material
                .into_iter()
                .take(3)
                .flat_map(|(_, list)| list.into_iter().take(5))
                .collect();
            let rendered = prompts::dream_narrative(DreamMode::Rem, None, None, &samples, None);
            let mut params = Purpose::RemNarrative.params(&rendered.text, None);
            params.max_tokens = Some(900.into());
            if let Some(temperature) = settings["temperature"].as_number() {
                params.temperature = Some(temperature.clone());
            }
            check()?;
            let result = route.complete(params, cancel);
            cancel.check()?;
            let Ok(result) = result else {
                return Ok(report(JobOutcome::Incomplete, "narrative_unavailable"));
            };
            let text = clean(&result.text);
            if content_guard::dream_text(&text, 40, 3000).is_err() {
                return Ok(report(JobOutcome::Incomplete, "dream_content_rejected"));
            }
            Some(text)
        };
        let intensity = clusters
            .iter()
            .flatten()
            .map(|&i| rem_clusters::intensity(&rows[i]))
            .fold(0., f64::max);
        let (mood, mood_intensity) = self
            .mood
            .read(principal, agent, cancel, |state, now| {
                let mood = state.describe(now)?;
                Ok((mood, state.dream_intensity()))
            })
            .ok()
            .and_then(|(mood, intensity)| {
                serde_json::from_str::<Value>(&crate::text::json::write_json(&mood))
                    .ok()
                    .map(|mood| (mood, intensity))
            })
            .unwrap_or_default();
        let (dream_intensity, dream_importance) = dream_memory::weight(
            mood_intensity,
            Some(intensity),
            settings["importanceMax"].as_f64(),
        );
        let record = {
            let _mutation = self.scope.operations.mutation()?;
            check()?;
            if source_digest(&candidates()?)? != expected_source {
                return Err(StoreError::Unavailable.into());
            }
            dream_sources::with_rem_store(&journal, authority, cancel, &check, |neo| {
                if let Some(record) = neo.result(&run_key)? {
                    check_record_sources(&record)?;
                    return publish(neo, &record);
                }
                let found = patterns.len();
                let mut trends = if patterns.is_empty() {
                    vec![]
                } else {
                    patterns::trends(patterns, neo.patterns()?)
                };
                let count = |name| trends.iter().filter(|row| row["trend"] == name).count();
                let counts = json!({"memoriesProcessed":rows.len(),"patternsFound":found,
                "new":count("neu"),"stronger":count("stärker"),"weaker":count("schwächer"),
                "disappeared":count("verschwunden"),"unchanged":count("gleich")});
                for pattern in &mut trends {
                    stamp(pattern, &visibility, &run_key, &week.key, &created);
                }
                let mut record = json!({"id":run_key,"type":"rem_dream","narrative":narrative,
                "atMs":context.now_ms,"patterns":trends,"counts":counts,
                "sourceDigest":expected_source,
                "dreamIntensity":dream_intensity,"dreamImportance":dream_importance,
                "moodDominant":mood["dominant"],"moodLabel":mood["label"]});
                stamp(&mut record, &visibility, &run_key, &week.key, &created);
                neo.publish_dream(&record)?;
                publish(neo, &record)
            })?
        };
        finish(&record)
    }
}

fn source_digest(rows: &[crate::contract::MemoryRow]) -> Result<String, StoreError> {
    struct DigestWriter(Sha256);
    impl std::io::Write for DigestWriter {
        fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
            self.0.update(bytes);
            Ok(bytes.len())
        }
        fn flush(&mut self) -> std::io::Result<()> {
            Ok(())
        }
    }
    let mut writer = DigestWriter(Sha256::new());
    serde_json::to_writer(&mut writer, rows).map_err(|_| StoreError::Corrupt)?;
    Ok(format!("{:x}", writer.0.finalize()))
}

fn stamp(value: &mut Value, visibility: &Visibility, run: &str, week: &str, created: &str) {
    value["scope"] = visibility.scope.clone().into();
    value["agentId"] = visibility.agent_id.clone().into();
    value["workspaceKey"] = visibility.workspace_identity.clone().into();
    value["ownerUserId"] = visibility.owner_user_id.clone().into();
    value["visibility"] = json!(visibility);
    value["runKey"] = run.into();
    value["publicationRun"] = run.into();
    value["weekOf"] = week.into();
    value["createdAt"] = created.into();
}

fn report(outcome: JobOutcome, reason: &str) -> JobReport {
    JobReport {
        outcome,
        reason: Some(reason.into()),
    }
}
