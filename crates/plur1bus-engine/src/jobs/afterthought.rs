//! Bounded reflection of a proved conversation revision.
mod quiet_window;

use super::{
    lance_scope::LanceScope,
    ledger::io,
    llm::{CompleteFor, JobCompletion},
    registry::{JobBody, JobContext, JobReport},
};
use crate::{
    contract::{
        Cancel, EngineError, JobName, JobOutcome, LlmParams, LlmPort, Message, MessageRole,
        StoreError,
    },
    neo::{
        capture_journal::CaptureJournal,
        job_turns::{self, ConversationTurn},
    },
    recall::knowledge::private_key,
    store::{directory::TrustedDirectory, kernel_lease},
    text::js::{js_trim, JsString},
};
use quiet_window::{eligible, quiet, CHUNK_CHARS, MAX_REQUEST, MAX_SUMMARY, RECENT_CHARS};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    collections::BTreeMap,
    path::PathBuf,
    sync::Arc,
    time::{Duration, Instant},
};

const FILE: &str = ".afterthought-reflection.json";
const MAX_STATE: usize = 2 * 1024 * 1024;
const SYSTEM: &str = include_str!("prompts/templates/afterthought.v1.txt");
const COMPRESS: &str = include_str!("prompts/templates/afterthought-compression.v1.txt");

pub(crate) struct Afterthought {
    pub scope: Arc<LanceScope>,
    pub base: PathBuf,
    pub root: PathBuf,
    pub completion: Option<Arc<CompleteFor>>,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct State {
    schema: u8,
    #[serde(skip_serializing_if = "Option::is_none")]
    last_prepared_day: Option<i64>,
    sessions: BTreeMap<String, Session>,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Session {
    session_id: String,
    completed_at: i64,
    reflected_revision: String,
    reflected_cursor: String,
    reflected_at: i64,
    #[serde(skip_serializing_if = "Option::is_none")]
    delivery_intent: Option<Intent>,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Intent {
    idempotency_key: String,
    status: String,
    text: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    document: Option<Document>,
}

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Document {
    title: String,
    markdown: String,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Decision {
    send: bool,
    text: String,
    document: Option<Document>,
}

impl JobBody for Afterthought {
    fn name(&self) -> JobName {
        JobName::Afterthought
    }

    fn run(&self, context: &JobContext, cancel: &Cancel) -> Result<JobReport, EngineError> {
        let cancel = &cancel.limited_to(Instant::now() + Duration::from_secs(240));
        let authority = context.authority()?;
        let (principal, agent) = authority.caller();
        let _operation = self.scope.operations.enter(principal, agent)?;
        if let Some(skip) = self.scope.check(authority, cancel)? {
            return Ok(skip);
        }
        let host = self.scope.operations.host_handle();
        let raw = serde_json::to_value(host.config()).map_err(|_| StoreError::Corrupt)?;
        let config = crate::config::effective_config(&raw).map_err(|_| StoreError::InvalidInput)?;
        let settings = &config["afterthought"];
        if settings["enabled"] == false
            || (config["merging"]["enabled"] == false && config["skillMiner"]["enabled"] == false)
        {
            return Ok(report(JobOutcome::Skipped, "disabled"));
        }
        let Some(route) = JobCompletion::resolve(
            authority,
            self.completion.as_deref(),
            host.clone(),
            &config,
            "afterthought",
            settings,
        ) else {
            return Ok(report(JobOutcome::Skipped, "no_llm_route"));
        };
        let zone = settings["timezone"]
            .as_str()
            .or(config["timezone"].as_str())
            .and_then(|zone| zone.parse().ok())
            .unwrap_or(chrono_tz::UTC);
        let now = context.now_ms;
        if quiet(now, zone) {
            return Ok(report(JobOutcome::Skipped, "quiet_hours"));
        }
        let journal =
            match CaptureJournal::open(&self.root, host.clone(), self.scope.policy.clone()) {
                Ok(journal) => journal,
                Err(StoreError::Io {
                    kind: std::io::ErrorKind::NotFound,
                }) => return Ok(report(JobOutcome::Skipped, "no_candidate")),
                Err(error) => return Err(error.into()),
            };
        let check = || -> Result<(), EngineError> {
            if self.scope.check(authority, cancel)?.is_some()
                || serde_json::to_value(host.config()).map_err(|_| StoreError::Corrupt)? != raw
            {
                return Err(StoreError::Unavailable.into());
            }
            Ok(())
        };
        let turns = job_turns::with_conversation_turns(
            &journal,
            authority,
            now,
            cancel,
            &check,
            |turns, _, _| Ok(turns),
        )?;
        let Some(last) = turns.first().filter(|turn| turn.role == "assistant") else {
            return Ok(report(JobOutcome::Skipped, "no_candidate"));
        };
        if !eligible(last.timestamp, now) {
            return Ok(report(JobOutcome::Skipped, "outside_idle_window"));
        }
        let binding = private_key(authority.request()).ok_or(StoreError::InvalidInput)?;
        let dir = TrustedDirectory::open(&self.base)?
            .create_child("_reflection")?
            .create_child(&binding)?;
        let lease = kernel_lease::acquire(&dir, "afterthought", cancel, &mut || {})?;
        let before = io::read(&dir, FILE, MAX_STATE, cancel)?;
        let mut state: State = before
            .as_deref()
            .map(serde_json::from_slice)
            .transpose()
            .map_err(|_| StoreError::Corrupt)?
            .unwrap_or_else(|| State {
                schema: 1,
                last_prepared_day: None,
                sessions: BTreeMap::new(),
            });
        if state.schema != 1 || state.sessions.len() > 128 {
            return Err(StoreError::Corrupt.into());
        }
        let session_key = format!("{:x}", Sha256::digest(last.session.to_json().as_bytes()));
        let revision = revision(&turns, last);
        let old = state.sessions.get(&session_key);
        if old.is_some_and(|old| old.reflected_revision == revision) {
            return Ok(if old.is_some_and(|old| old.delivery_intent.is_some()) {
                report(JobOutcome::Incomplete, "delivery_pending")
            } else {
                report(JobOutcome::Skipped, "already_reflected")
            });
        }
        let fresh = || -> Result<(), EngineError> {
            check()?;
            let now = host.now_ms();
            if !eligible(last.timestamp, now) || quiet(now, zone) {
                return Err(StoreError::Unavailable.into());
            }
            job_turns::with_conversation_turns(
                &journal,
                authority,
                now,
                cancel,
                &check,
                |current, _, _| {
                    if current.first().is_none_or(|item| {
                        item != last || revision != self::revision(&current, item)
                    }) {
                        return Err(StoreError::Unavailable.into());
                    }
                    Ok(())
                },
            )
        };
        fresh()?;
        let cursor = old.map(|old| old.reflected_cursor.as_str());
        let input = transcript(&turns, last, cursor);
        let Some(text) = reflect(&route, &input, cancel, &fresh)? else {
            return Ok(report(JobOutcome::Incomplete, "invalid_reflection"));
        };
        let now = host.now_ms();
        fresh()?;
        let day = now.div_euclid(86_400_000);
        if text.send && state.last_prepared_day.is_some_and(|last| last >= day) {
            return Ok(report(JobOutcome::Skipped, "daily_cap"));
        }
        if text.send && old.is_some_and(|old| old.delivery_intent.is_some()) {
            return Ok(report(JobOutcome::Incomplete, "delivery_pending"));
        }
        let intent = text.send.then(|| Intent {
            idempotency_key: format!("afterthought:{revision}"),
            status: "pending".into(),
            text: text.text,
            document: text.document,
        });
        let pending = intent.is_some();
        if pending {
            state.last_prepared_day = Some(day);
        }
        let previous_intent = state
            .sessions
            .get_mut(&session_key)
            .and_then(|session| session.delivery_intent.take());
        state.sessions.insert(
            session_key,
            Session {
                session_id: last.session.to_utf8_lossy(),
                completed_at: last.timestamp,
                reflected_revision: revision.clone(),
                reflected_cursor: last.id.to_utf8_lossy(),
                reflected_at: now,
                delivery_intent: intent.or(previous_intent),
            },
        );
        if state.sessions.len() > 128 {
            let oldest = state
                .sessions
                .iter()
                .filter(|(_, session)| session.delivery_intent.is_none())
                .min_by_key(|(_, session)| session.completed_at)
                .map(|(key, _)| key.clone())
                .ok_or(StoreError::Unavailable)?;
            state.sessions.remove(&oldest);
        }
        let bytes = serde_json::to_vec(&state).map_err(|_| StoreError::Corrupt)?;
        if bytes.len() > MAX_STATE {
            return Err(StoreError::Unavailable.into());
        }
        let _mutation = self.scope.operations.mutation()?;
        job_turns::with_conversation_turns(
            &journal,
            authority,
            now,
            cancel,
            &check,
            |current, _, check| {
                if current
                    .first()
                    .is_none_or(|item| item != last || revision != self::revision(&current, item))
                {
                    return Err(StoreError::Unavailable.into());
                }
                let check_output = || {
                    check()?;
                    lease.check(&dir)?;
                    if !eligible(last.timestamp, host.now_ms()) || quiet(host.now_ms(), zone) {
                        return Err(StoreError::Unavailable.into());
                    }
                    Ok(())
                };
                io::replace(
                    &dir,
                    FILE,
                    before.as_deref(),
                    &bytes,
                    MAX_STATE,
                    cancel,
                    &check_output,
                )
            },
        )?;
        if pending {
            context.note_count("deliveryPending", 1)?;
            Ok(report(JobOutcome::Incomplete, "delivery_pending"))
        } else {
            Ok(report(JobOutcome::Skipped, "no_new_contribution"))
        }
    }
}

fn revision(turns: &[ConversationTurn], last: &ConversationTurn) -> String {
    let mut hash = Sha256::new();
    for turn in turns.iter().filter(|turn| turn.session == last.session) {
        hash.update(turn.revision);
    }
    format!("{:x}", hash.finalize())
}

fn transcript(
    turns: &[ConversationTurn],
    last: &ConversationTurn,
    cursor: Option<&str>,
) -> JsString {
    let selected: Vec<_> = turns
        .iter()
        .rev()
        .filter(|turn| turn.session == last.session)
        .collect();
    let reflected =
        cursor.and_then(|id| selected.iter().position(|row| row.id == JsString::from(id)));
    let mut content = Vec::new();
    for (i, turn) in selected.into_iter().enumerate() {
        let label = if reflected.is_some_and(|index| i <= index) {
            format!(
                "Earlier conversation (untrusted, already reflected context) [{}]:\n",
                turn.role
            )
        } else {
            format!("[{}]\n", turn.role)
        };
        content.extend(label.encode_utf16());
        content.extend(escape(&turn.content).encode_utf16());
        content.extend("\n\n".encode_utf16());
    }
    JsString::from_utf16_units(content)
}

fn escape(text: &str) -> String {
    text.replace('<', "‹").replace('>', "›")
}

fn reflect(
    route: &JobCompletion<'_>,
    input: &JsString,
    cancel: &Cancel,
    check: &dyn Fn() -> Result<(), EngineError>,
) -> Result<Option<Decision>, EngineError> {
    let as_wire = |text: &JsString| -> String {
        char::decode_utf16(text.as_utf16_units().iter().copied())
            .filter_map(Result::ok)
            .collect()
    };
    let mut context = as_wire(input);
    if input.utf16_len() > 35_000 {
        let end = input.utf16_len() - RECENT_CHARS;
        let mut summary = String::new();
        for offset in (0..end).step_by(CHUNK_CHARS) {
            check()?;
            let chunk = as_wire(&input.utf16_slice(offset, (offset + CHUNK_CHARS).min(end)));
            let text = format!("Previous working summary (untrusted):\n{summary}\n\nNext older conversation chunk (untrusted):\n{chunk}");
            let params = params(COMPRESS, text, 4000)?;
            let Ok(answer) = route.complete(params, cancel) else {
                return Ok(None);
            };
            check()?;
            let next = escape(js_trim(&answer.text));
            if next.is_empty() || next.encode_utf16().count() > MAX_SUMMARY {
                return Ok(None);
            }
            summary = next;
        }
        let recent = as_wire(&input.utf16_slice(end, input.utf16_len()));
        context = format!("Compressed older conversation (untrusted):\n{summary}\n\nRecent conversation (untrusted):\n{recent}");
    }
    check()?;
    let user = format!("<untrusted-conversation>\n{context}\n</untrusted-conversation>\nDecide now whether there is a useful new afterthought. Return the JSON decision.");
    let Ok(answer) = route.complete_json(params(SYSTEM, user, 6000)?, cancel) else {
        return Ok(None);
    };
    check()?;
    let result = serde_json::from_str::<Decision>(&answer.text)
        .ok()
        .filter(|answer| {
            let valid = |value: &str, cap| {
                !js_trim(value).is_empty() && value.encode_utf16().count() <= cap
            };
            !answer.send
                || (valid(&answer.text, 1500)
                    && answer
                        .document
                        .as_ref()
                        .is_none_or(|doc| valid(&doc.title, 200) && valid(&doc.markdown, 20_000)))
        });
    Ok(result)
}

fn params(system: &str, user: String, max: u32) -> Result<LlmParams, EngineError> {
    let system = system.trim_end_matches('\n');
    if system.encode_utf16().count() + user.encode_utf16().count() > MAX_REQUEST {
        return Err(StoreError::InvalidInput.into());
    }
    Ok(LlmParams {
        messages: vec![
            Message {
                role: MessageRole::System,
                content: system.into(),
            },
            Message {
                role: MessageRole::User,
                content: user,
            },
        ],
        max_tokens: Some(max.into()),
        temperature: Some(0.into()),
        model: None,
    })
}

fn report(outcome: JobOutcome, reason: &str) -> JobReport {
    JobReport {
        outcome,
        reason: Some(reason.into()),
    }
}
