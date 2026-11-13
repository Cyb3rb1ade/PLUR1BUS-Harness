//! Exact-owner persona evolution with guarded persistent markers.
use super::{
    content_guard,
    lance_scope::LanceScope,
    ledger::io,
    llm::{CompleteFor, JobCompletion},
    registry::{JobBody, JobContext, JobReport},
    reply_feedback,
};
use crate::{
    context::RequestContext,
    contract::{
        Cancel, EngineError, JobName, JobOutcome, LlmParams, LlmPort, Message, MessageRole,
        StoreError,
    },
    neo::{capture_journal::CaptureJournal, job_turns},
    recall::{knowledge::private_key, locale::LocaleMessage},
    store::{directory::TrustedDirectory, kernel_lease},
    text::js::{js_trim, utf16_slice, JsString},
};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::{
    path::{Path, PathBuf},
    sync::Arc,
    time::{Duration, Instant},
};

const ROOT: &str = "_reflection";
const FILE: &str = "persona-voice.json";
const MAX_BYTES: usize = 128 * 1024;
const DAY_MS: i64 = 86_400_000;
const SYSTEM: &str = include_str!("prompts/templates/persona-evolve.v1.txt");

pub(crate) struct PersonaEvolve {
    pub scope: Arc<LanceScope>,
    pub base: PathBuf,
    pub root: PathBuf,
    pub completion: Option<Arc<CompleteFor>>,
}

#[derive(Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Voice {
    seed: Vec<String>,
    learned: Vec<String>,
    last_evolved_at: Option<i64>,
    last_outcome_timestamp: Option<i64>,
}

impl Voice {
    fn decode(before: Option<&[u8]>) -> Result<Self, EngineError> {
        let voice: Self = before
            .map(serde_json::from_slice)
            .transpose()
            .map_err(|_| StoreError::Corrupt)?
            .unwrap_or_default();
        if voice.seed.len() + voice.learned.len() > 100
            || voice
                .seed
                .iter()
                .chain(&voice.learned)
                .any(|line| content_guard::persona_marker(line).is_err())
        {
            return Err(StoreError::Corrupt.into());
        }
        Ok(voice)
    }
}

impl JobBody for PersonaEvolve {
    fn name(&self) -> JobName {
        JobName::PersonaEvolve
    }

    fn run(&self, context: &JobContext, cancel: &Cancel) -> Result<JobReport, EngineError> {
        let cancel = &cancel.limited_to(Instant::now() + Duration::from_secs(90));
        let authority = context.authority()?;
        let (principal, agent) = authority.caller();
        let _operation = self.scope.operations.enter(principal, agent)?;
        if let Some(skip) = self.scope.check(authority, cancel)? {
            return Ok(skip);
        }
        let host = self.scope.operations.host_handle();
        let raw = serde_json::to_value(host.config()).map_err(|_| StoreError::Corrupt)?;
        let config = crate::config::effective_config(&raw).map_err(|_| StoreError::InvalidInput)?;
        let settings = &config["personaVoice"];
        let Some(route) = JobCompletion::resolve(
            authority,
            self.completion.as_deref(),
            host.clone(),
            &config,
            "persona-voice",
            settings,
        )
        .filter(|_| settings["enabled"] != false && config["skillMiner"]["enabled"] != false) else {
            return Ok(report(JobOutcome::Skipped, "not_configured"));
        };
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
                }) => {
                    return Ok(report(JobOutcome::Skipped, "too_few_outcomes"));
                }
                Err(error) => return Err(error.into()),
            };
        let now = context.now_ms;
        let turns = job_turns::with_conversation_turns(
            &journal,
            authority,
            now,
            cancel,
            &check,
            |rows, _| Ok(rows),
        )?;
        let replies = reply_feedback::collect(&turns, cancel)?;
        let binding = private_key(authority.request()).ok_or(StoreError::InvalidInput)?;
        let dir = TrustedDirectory::open(&self.base)?
            .create_child(ROOT)?
            .create_child(&binding)?;
        let lease = kernel_lease::acquire(&dir, "persona-evolve", cancel, &mut || {})?;
        let before = io::read(&dir, FILE, MAX_BYTES, cancel)?;
        let mut voice = Voice::decode(before.as_deref())?;
        let days = settings["minDaysBetween"]
            .as_f64()
            .unwrap_or(2.)
            .clamp(0., 3650.);
        if voice
            .last_evolved_at
            .is_some_and(|at| (now.saturating_sub(at) as f64) < days * DAY_MS as f64)
        {
            return Ok(report(JobOutcome::Skipped, "too_soon"));
        }
        let fresh: Vec<_> = replies
            .iter()
            .rev()
            .filter(|reply| {
                reply.response.timestamp >= now.saturating_sub(7 * DAY_MS)
                    && voice
                        .last_outcome_timestamp
                        .is_none_or(|at| reply.response.timestamp > at)
            })
            .take(300)
            .collect();
        let minimum = settings["minOutcomes"]
            .as_f64()
            .unwrap_or(10.)
            .clamp(1., 300.)
            .ceil() as usize;
        context.note_count("outcomes", fresh.len())?;
        if fresh.len() < minimum {
            return Ok(report(JobOutcome::Skipped, "too_few_outcomes"));
        }
        let positive: Vec<_> = fresh
            .iter()
            .copied()
            .filter(|reply| {
                matches!(
                    reply.classification,
                    "confirmed_or_continued" | "continued_topic" | "acknowledged"
                )
            })
            .collect();
        let negative: Vec<_> = fresh
            .iter()
            .copied()
            .filter(|reply| {
                matches!(
                    reply.classification,
                    "ignored_or_topic_shifted" | "rejected" | "corrected"
                )
            })
            .collect();
        context.note_count("positive", positive.len())?;
        context.note_count("negative", negative.len())?;
        if positive.len() <= negative.len() {
            return Ok(report(JobOutcome::Skipped, "no_positive_trend"));
        }
        let locale_messages: Vec<_> = turns
            .iter()
            .rev()
            .map(|turn| LocaleMessage {
                role: Some(turn.role),
                content: Some(&turn.content),
            })
            .collect();
        let locale = super::persona_locale::detect_language(&locale_messages);
        check()?;
        let answer = route.complete(
            prompt(&voice, &positive, &negative, fresh.len(), locale),
            &cancel.limited_to(Instant::now() + Duration::from_secs(30)),
        );
        cancel.check()?;
        let Some(action) = answer.ok().and_then(|answer| parse(&answer.text)) else {
            return Ok(report(JobOutcome::Incomplete, "llm_no_marker"));
        };
        let mut changed = false;
        let mut reason = "llm_none";
        if let Some((index, marker)) = action {
            if content_guard::persona_marker(&marker).is_err() {
                return Ok(report(JobOutcome::Incomplete, "invalid_persona_marker"));
            }
            if voice.seed.contains(&marker) || voice.learned.contains(&marker) {
                reason = "duplicate_marker";
            } else {
                if let Some(slot) = index.and_then(|index| voice.learned.get_mut(index)) {
                    *slot = marker;
                } else {
                    let max = settings["maxBullets"]
                        .as_f64()
                        .unwrap_or(24.)
                        .clamp(6., 100.) as usize;
                    let available = max.saturating_sub(voice.seed.len());
                    if available == 0 {
                        return Ok(report(JobOutcome::Skipped, "seed_fills_profile"));
                    }
                    voice.learned.push(marker);
                    if voice.learned.len() > available {
                        voice.learned.drain(..voice.learned.len() - available);
                    }
                }
                changed = true;
                voice.last_evolved_at = Some(now);
            }
        }
        voice.last_outcome_timestamp = fresh.first().map(|reply| reply.response.timestamp);
        let next = serde_json::to_vec(&voice).map_err(|_| StoreError::Corrupt)?;
        let _mutation = self.scope.operations.mutation()?;
        job_turns::with_conversation_turns(
            &journal,
            authority,
            now,
            cancel,
            &check,
            |current, check| {
                if current != turns {
                    return Err(StoreError::Unavailable.into());
                }
                let check_output = || {
                    check()?;
                    lease.check(&dir)?;
                    Ok(())
                };
                io::replace(
                    &dir,
                    FILE,
                    before.as_deref(),
                    &next,
                    MAX_BYTES,
                    cancel,
                    &check_output,
                )
            },
        )?;
        context.note_count("evolved", usize::from(changed))?;
        Ok(if changed {
            JobReport::completed()
        } else {
            report(JobOutcome::Skipped, reason)
        })
    }
}

fn prompt(
    voice: &Voice,
    positive: &[&reply_feedback::Reply<'_>],
    negative: &[&reply_feedback::Reply<'_>],
    total: usize,
    locale: &str,
) -> LlmParams {
    let profile = format!(
        "Geschuetzter Kern (nicht aenderbar):\n{}\n\nGelernte Zeilen (nummeriert, ersetzbar):\n{}",
        if voice.seed.is_empty() {
            "(keiner)".into()
        } else {
            voice.seed.join("\n")
        },
        if voice.learned.is_empty() {
            "(noch keine)".into()
        } else {
            voice
                .learned
                .iter()
                .enumerate()
                .map(|(i, line)| format!("{}. {line}", i + 1))
                .collect::<Vec<_>>()
                .join("\n")
        },
    );
    let evidence = |items: &[&reply_feedback::Reply<'_>]| {
        let excerpts: Vec<_> = items
            .iter()
            .take(6)
            .map(|entry| {
                let clip = |text: &str| {
                    let line = text.split_whitespace().collect::<Vec<_>>().join(" ");
                    utf16_slice(&line, 0, 400).to_utf8_lossy()
                };
                format!(
                    "[{}]\nNutzer: {}\nAgent: {}\nReaktion: {}",
                    entry.classification,
                    clip(&entry.prompt.content),
                    clip(&entry.assistant.content),
                    clip(&entry.response.content)
                )
            })
            .collect();
        content_guard::dream_evidence(
            &excerpts.iter().map(String::as_str).collect::<Vec<_>>(),
            6,
            1400,
        )
    };
    let input = format!("{}\n\nPositive Belege ({} von {total} Outcomes):\n{}\n\nNegative Belege ({} von {total} Outcomes):\n{}",
        utf16_slice(&profile, 0, 4000).to_utf8_lossy(), positive.len(), evidence(positive), negative.len(), evidence(negative));
    let system = format!(
        "{}\nSprache des Markers: {locale}.",
        SYSTEM.trim_end_matches('\n')
    );
    LlmParams {
        messages: vec![
            Message {
                role: MessageRole::System,
                content: system,
            },
            Message {
                role: MessageRole::User,
                content: input,
            },
        ],
        model: None,
        max_tokens: Some(400.into()),
        temperature: Some(0.into()),
    }
}

fn parse(reply: &str) -> Option<Option<(Option<usize>, String)>> {
    let mut lines = reply.lines().map(js_trim).filter(|line| !line.is_empty());
    let line = lines.next()?;
    if lines.next().is_some() {
        return None;
    }
    if line.eq_ignore_ascii_case("NONE") {
        return Some(None);
    }
    if line.starts_with("- ") {
        return Some(Some((None, line.into())));
    }
    let (action, marker) = line.split_once(':')?;
    let marker = js_trim(marker).to_owned();
    if action.trim().eq_ignore_ascii_case("ADD") {
        return Some(Some((None, marker)));
    }
    let (action, index) = action.trim().split_once(' ')?;
    let index = index.trim().parse::<usize>().ok()?.checked_sub(1);
    action
        .eq_ignore_ascii_case("REPLACE")
        .then_some(Some((index, marker)))
}

pub(crate) fn read_voice(
    base: &Path,
    request: &RequestContext,
    raw: &Value,
    cancel: &Cancel,
) -> Result<JsString, EngineError> {
    if request.background()
        || request.chat_kind() != "private"
        || raw["personaVoice"]["enabled"] == false
    {
        return Ok(JsString::default());
    }
    let Some(binding) = private_key(request) else {
        return Ok(JsString::default());
    };
    let dir = match TrustedDirectory::open(base)?
        .open_child(ROOT)
        .and_then(|dir| dir.open_child(&binding))
    {
        Ok(dir) => dir,
        Err(StoreError::Io {
            kind: std::io::ErrorKind::NotFound,
        }) => return Ok(JsString::default()),
        Err(error) => return Err(error.into()),
    };
    let before = io::read(&dir, FILE, MAX_BYTES, cancel)?;
    let voice = Voice::decode(before.as_deref())?;
    let lines = voice
        .seed
        .into_iter()
        .chain(voice.learned)
        .collect::<Vec<_>>();
    if lines.is_empty() {
        return Ok(JsString::default());
    }
    let max = raw["personaVoice"]["maxDirectiveChars"]
        .as_u64()
        .unwrap_or(3200)
        .clamp(200, 16_000) as usize;
    Ok(utf16_slice(
        &format!("Stimm-Profil:\n{}", lines.join("\n")),
        0,
        max,
    ))
}

fn report(outcome: JobOutcome, reason: &str) -> JobReport {
    JobReport {
        outcome,
        reason: Some(reason.into()),
    }
}
