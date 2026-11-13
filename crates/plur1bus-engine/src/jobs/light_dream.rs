//! Owner-bound Light Dream analysis, narrative, and idempotent diary publication.
use super::{
    content_guard, dream_diary,
    lance_scope::LanceScope,
    llm::{CompleteFor, JobCompletion, Purpose},
    prompts::{self, DreamMode, DreamMood},
    registry::{JobBody, JobContext, JobReport},
};
use crate::{
    capture::emotion_pool::EmotionalPool,
    contract::{Cancel, EngineError, JobName, JobOutcome, JobTrigger, LlmPort, StoreError},
    neo::{capture_journal::CaptureJournal, dream_sources},
    text::{
        js::{js_trim, JsString},
        json::write_json,
    },
};
use serde_json::{json, Value};
use std::{
    path::PathBuf,
    sync::{Arc, OnceLock},
    time::{Duration, Instant},
};

pub(crate) struct LightDream {
    pub scope: Arc<LanceScope>,
    pub root: PathBuf,
    pub mood: Arc<EmotionalPool>,
    pub completion: Option<Arc<CompleteFor>>,
}

impl JobBody for LightDream {
    fn name(&self) -> JobName {
        JobName::LightDream
    }

    fn run(&self, context: &JobContext, cancel: &Cancel) -> Result<JobReport, EngineError> {
        let cancel = &cancel.limited_to(Instant::now() + Duration::from_secs(120));
        if !matches!(context.trigger, JobTrigger::Harness | JobTrigger::Manual) {
            return Ok(report(JobOutcome::Skipped, "unsupported_trigger"));
        }
        let authority = context.authority()?;
        let (principal, agent) = authority.caller();
        let _operation = self.scope.operations.enter(principal, agent)?;
        let host = self.scope.operations.host_handle();
        let raw = serde_json::to_value(host.config()).map_err(|_| StoreError::Corrupt)?;
        if raw["neo"]["enabled"] == false {
            return Ok(report(JobOutcome::Skipped, "neo_disabled"));
        }
        if raw["merging"]["enabled"] == false {
            return Ok(report(JobOutcome::Skipped, "no_llm_config"));
        }
        if let Some(skip) = self.scope.check(authority, cancel)? {
            return Ok(skip);
        }
        let check = || {
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
                }) => return Ok(report(JobOutcome::Skipped, "no_turns")),
                Err(error) => return Err(error.into()),
            };
        let Some(source) =
            dream_sources::light(&journal, authority, context.now_ms, cancel, &check)?
        else {
            return Ok(report(JobOutcome::Skipped, "no_turns"));
        };
        if context.has_completed_key(&source.key)? {
            return Ok(report(JobOutcome::Skipped, "already_completed"));
        }
        if context.is_abandoned_key(&source.key)? {
            context.note_abandoned_key(&source.key)?;
            return Ok(report(JobOutcome::Skipped, "already_abandoned"));
        }
        context.disable_diary()?;
        let settings = &raw["dreaming"]["narrative"];
        if settings["enabled"] == false {
            return Ok(report(JobOutcome::Skipped, "narrative_disabled"));
        }
        let timezone = raw["timezone"]
            .as_str()
            .and_then(|name| name.parse().ok())
            .or_else(|| crate::rpc::engine::host_timezone().parse().ok())
            .unwrap_or(chrono_tz::UTC);
        let publish = |durable: &Value| -> Result<usize, EngineError> {
            let diary_enabled = settings["diary"] != false;
            if diary_enabled {
                let result = dream_diary::append(
                    authority,
                    host.as_ref(),
                    self.scope.policy.as_ref(),
                    &dream_diary::Entry {
                        run_key: &source.key,
                        narrative: durable["narrative"].as_str().ok_or(StoreError::Corrupt)?,
                        at_ms: durable["atMs"].as_i64().ok_or(StoreError::Corrupt)?,
                        timezone,
                        sources: &source.visibility,
                    },
                    cancel,
                )?;
                if result == dream_diary::Publication::Written {
                    host.emit(
                        "dream.completed",
                        json!({"agentId":context.agent,"mode":"light"}),
                    );
                }
            }
            context.note_diary(diary_enabled, (!diary_enabled).then_some("diary_disabled"))?;
            Ok(durable["insights"]
                .as_array()
                .ok_or(StoreError::Corrupt)?
                .len())
        };
        if let Some(count) = dream_sources::with_light_result(
            &journal, authority, &source, cancel, &check, None, publish,
        )? {
            return finish(context, &source, count);
        }
        let no_feature_settings = Value::Null;
        let Some(insights_route) = JobCompletion::resolve(
            authority,
            self.completion.as_deref(),
            host.clone(),
            &raw,
            "conversation-insights",
            &no_feature_settings,
        ) else {
            return Ok(report(JobOutcome::Skipped, "no_llm_config"));
        };
        context.note_pending_key(&source.key)?;
        check()?;
        let prompt = prompts::conversation_insights(&source.turns);
        let mut params = Purpose::ConversationInsights.params(&prompt.text, None);
        params.max_tokens = Some(400.into());
        let answer = insights_route.complete(params, cancel);
        cancel.check()?;
        let Ok(answer) = answer else {
            return Ok(report(JobOutcome::Incomplete, "insights_unavailable"));
        };
        let insights = insights(&answer.text);
        let mood = self
            .mood
            .read(principal, agent, cancel, |state, now| state.describe(now))
            .ok()
            .and_then(|mood| serde_json::from_str::<Value>(&write_json(&mood)).ok())
            .unwrap_or_default();
        let nuances: Vec<_> = mood["nuances"]
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(Value::as_str)
            .take(5)
            .collect();
        let mood_fields = mood.is_object().then(|| DreamMood {
            label: mood["label"].as_str().unwrap_or("ausgeglichen"),
            dominant: mood["dominant"].as_str().unwrap_or("neutral"),
            intensity: mood["intensity"].as_str().unwrap_or("niedrig"),
            trend: mood["trend"].as_str().unwrap_or("stabil"),
            nuances: &nuances,
        });
        let Some(route) = JobCompletion::resolve(
            authority,
            self.completion.as_deref(),
            host.clone(),
            &raw,
            "dream-narrative",
            &no_feature_settings,
        ) else {
            return Ok(report(JobOutcome::Incomplete, "narrative_unavailable"));
        };
        let mut material: Vec<_> = insights
            .iter()
            .map(|value| JsString::from(value.as_str()))
            .collect();
        material.extend(
            source
                .turns
                .iter()
                .skip(source.turns.len().saturating_sub(4))
                .map(|(_, text)| text.utf16_slice(0, 200)),
        );
        let prompt = prompts::dream_narrative(
            DreamMode::Light,
            mood_fields.as_ref(),
            raw["emotion"]["temperaments"][context.agent.as_str()]["preset"].as_str(),
            &material,
            None,
        );
        let mut params = Purpose::LightNarrative.params(&prompt.text, None);
        params.max_tokens = Some(400.into());
        if let Some(temperature) = settings["temperature"].as_number() {
            params.temperature = Some(temperature.clone());
        }
        check()?;
        let result = route.complete(params, cancel);
        cancel.check()?;
        let Ok(result) = result else {
            return Ok(report(JobOutcome::Incomplete, "narrative_unavailable"));
        };
        let narrative = clean(&result.text);
        if content_guard::dream_text(&narrative, 40, 1200).is_err() {
            return Ok(report(JobOutcome::Incomplete, "dream_content_rejected"));
        }
        let request = authority.request();
        let created = chrono::DateTime::from_timestamp_millis(context.now_ms)
            .ok_or(StoreError::InvalidInput)?
            .to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
        let record = json!({
            "id":source.key, "type":"light_dream", "scope":source.visibility.scope,
            "agentId":request.agent_id,"workspaceKey":request.workspace_key,
            "ownerUserId":request.owner_user_id,"visibility":source.visibility,
            "createdAt":created,"atMs":context.now_ms,"turnCount":source.turns.len(),
            "insights":insights,"narrative":narrative,"moodLabel":mood["label"],
            "moodEmoji":mood["emoji"],
        });
        let count = dream_sources::with_light_result(
            &journal,
            authority,
            &source,
            cancel,
            &check,
            Some(&record),
            publish,
        )?
        .ok_or(StoreError::Corrupt)?;
        finish(context, &source, count)
    }
}

fn finish(
    context: &JobContext,
    source: &dream_sources::LightSource,
    insights: usize,
) -> Result<JobReport, EngineError> {
    context.note_count("turns", source.turns.len())?;
    context.note_count("insights", insights)?;
    context.mark_completed_key(&source.key)?;
    Ok(JobReport::completed())
}

fn insights(raw: &str) -> Vec<String> {
    if let Ok(value) = serde_json::from_str::<Value>(raw) {
        return value
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(Value::as_str)
            .filter(|line| line.encode_utf16().count() > 10)
            .take(3)
            .map(str::to_owned)
            .collect();
    }
    static MARKER: OnceLock<Option<regex::Regex>> = OnceLock::new();
    let marker = MARKER.get_or_init(|| regex::Regex::new(r"^\s*[-*•0-9]+[.)]?\s*").ok());
    raw.lines()
        .filter_map(|line| {
            let line = marker
                .as_ref()
                .map_or_else(|| line.into(), |marker| marker.replace(line, ""));
            let line = js_trim(&line);
            (11..300)
                .contains(&line.encode_utf16().count())
                .then(|| line.to_owned())
        })
        .take(3)
        .collect()
}

fn clean(raw: &str) -> String {
    let mut raw = js_trim(raw);
    if let Some(fence) = raw.strip_prefix("```") {
        raw = fence
            .trim_start_matches(|c: char| c.is_ascii_lowercase())
            .trim_start();
    }
    raw = js_trim(raw.strip_suffix("```").unwrap_or(raw));
    let raw = raw.strip_prefix(['"', '„']).unwrap_or(raw);
    let raw = raw.strip_suffix(['"', '“']).unwrap_or(raw);
    js_trim(raw).to_owned()
}

fn report(outcome: JobOutcome, reason: &str) -> JobReport {
    JobReport {
        outcome,
        reason: Some(reason.into()),
    }
}
