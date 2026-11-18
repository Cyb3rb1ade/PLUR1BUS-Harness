//! `session/rewind.ts`: the audited conversation rewind, the bounded corrective lesson and the `/rewind` transcript command.
//! One service for `chat.rewind`, `session.rewind` and `/rewind`; it never performs memory correction or capture.
//!
//! What a rewind does, in order (every step is the TypeScript step): plan the target on an idle path; write the lesson (a
//! person's note verbatim, else the summarise port, else a deterministic note from the changed files and the failing check);
//! refuse when the caller's signals are already aborted; when files are asked for, reserve the path and let the files port
//! restore the tracked files (a destructive step behind a human approval, revalidated against the plan); then append the
//! overlay and the lesson in one store transaction, with the audit line written before the commit. The transcript itself is
//! never changed. A failed file restore leaves the transcript as it was and releases the reservation.
//!
//! The service holds no store: every call takes it. The summarise port, the notification and the files port are the ports of
//! R-K-2; nothing here calls a model.
use super::checkpoint_retention::{append_audit, SharedAudit};
use super::compaction::SummaryMessage;
use super::jstext::{len16, one_line};
use super::overlay::{failed_edit_cycles, rewind_result};
use super::rewind_checkpoints::{ProjectBinding, TurnApprover};
use super::rewind_git::{Cancel, RewindError};
use super::store_misc::AuditFn;
use super::types::{
    EventRecord, MessageRecord, MessageRole, RewindPlan, RewindRecord, RewindTarget, RewindTrigger,
};
use super::{Clock, RewindInput, RewindToken, SessionError, SessionKind, SessionStore};
use crate::approvals::js_json::J;
use crate::js::{is_js_space, utf16, utf16_len};
use serde_json::Value;
use std::rc::Rc;
use std::sync::Arc;

const MAX_LESSON_TOKENS: usize = 400;
const LESSON_PREFIX: &str = "Lesson from a discarded attempt: ";

fn body_chars() -> usize {
    MAX_LESSON_TOKENS * 4 - len16(LESSON_PREFIX)
}

fn trim(s: &str) -> &str {
    s.trim_matches(is_js_space)
}

/// `fitText`: at most `limit` UTF-16 units, one fewer when the cut would leave half of a surrogate pair.
pub fn fit_text(text: &str, limit: usize) -> String {
    let units = utf16(text);
    let mut end = limit;
    if units.len() > end && end > 0 && (0xD800..=0xDBFF).contains(&units[end - 1]) {
        end -= 1;
    }
    String::from_utf16_lossy(&units[..end.min(units.len())])
}

fn line(text: &str) -> String {
    fit_text(&one_line(text), 256)
}

/// The input of a file restore.
pub struct RestoreInput<'a> {
    /// The session.
    pub session_id: String,
    /// The last message that stays.
    pub parent_seq: i64,
    /// First hidden seq.
    pub hidden_from_seq: i64,
    /// Last hidden seq.
    pub hidden_to_seq: i64,
    /// The turn whose checkpoint holds the target's file state.
    pub checkpoint_turn_id: String,
    /// Who approves.
    pub approver: TurnApprover,
    /// The combined signal.
    pub signal: Cancel,
    /// Revalidation after the approval wait.
    pub validate: &'a mut dyn FnMut(&mut SessionStore) -> Result<(), RewindError>,
}

/// `RewindFilesPort`: file restore is available only through the trusted D115 checkpoint and approval integration.
pub trait RewindFilesPort {
    /// `capture`: snapshot before a turn. The default does nothing, as a port without `capture` does.
    fn capture(
        &self,
        _store: &mut SessionStore,
        _session_id: &str,
        _turn_id: &str,
        _person_id: &str,
        _signal: &Cancel,
    ) -> Result<(), RewindError> {
        Ok(())
    }
    /// `restore`.
    fn restore(&self, store: &mut SessionStore, input: RestoreInput<'_>)
        -> Result<(), RewindError>;
}

/// The `Summarizer` of the lesson writer: messages in, text out. An `Err` is a throw (a refused budget, no role).
pub trait LessonSummarizer {
    /// `summarize(messages, maxTokens, sessionId, caller)`.
    fn summarize(
        &self,
        messages: &[SummaryMessage],
        max_tokens: i64,
        session_id: &str,
        caller: Option<&J>,
    ) -> Result<String, String>;
}

/// `notify`: called after a write with the event it made.
pub type NotifyFn = Box<dyn Fn(&EventRecord) -> Result<(), String>>;
/// `onError`: called with a one-line description of a failure that does not stop the work.
pub type ErrorFn = Box<dyn Fn(&str)>;
/// `project`: the trusted D115 binding of a session and person, if any.
pub type ProjectFn = Box<dyn Fn(&str, &str) -> Option<ProjectBinding>>;

/// `RewindServiceDeps` without the store.
pub struct RewindServiceDeps {
    /// The audit sink; it must be available before a write.
    pub audit: SharedAudit,
    /// `now`.
    pub clock: Arc<dyn Clock>,
    /// The summarise port; absent means no model: the deterministic note.
    pub summarize: Option<Box<dyn LessonSummarizer>>,
    /// The files port.
    pub files: Option<Rc<dyn RewindFilesPort>>,
    /// The lifecycle signal.
    pub signal: Option<Cancel>,
    /// `notify(event)`: delivery cannot roll back a committed operation. An `Err` goes to `on_error`.
    pub notify: Option<NotifyFn>,
    /// `onError(error)`.
    pub on_error: Option<ErrorFn>,
    /// The trusted D115 card link and canonical bound worktree.
    pub project: Option<ProjectFn>,
    /// The live per-project opt-in; empty or absent is automatic rewind off.
    pub auto_projects: Option<Box<dyn Fn() -> Vec<String>>>,
}

/// `RewindRequest`: trusted caller metadata, supplied by the human RPC or the turn boundary, never copied from an agent tool
/// argument.
pub struct RewindRequest<'a> {
    /// The session.
    pub session_id: String,
    /// `toSeq`.
    pub to: RewindTarget,
    /// Who asked.
    pub actor: String,
    /// A person's note.
    pub lesson: Option<String>,
    /// User (the default) or agent.
    pub trigger: Option<RewindTrigger>,
    /// The caller identity, passed through to the summarise port.
    pub caller: Option<J>,
    /// The admitted transcript command itself.
    pub command_turn_id: Option<String>,
    /// Restore tracked files too.
    pub files: bool,
    /// Who approves the file restore.
    pub approver: Option<TurnApprover>,
    /// The caller's signal.
    pub signal: Option<Cancel>,
    /// Internal revalidation after summary/approval waits; never accepted from a transport.
    pub validate: Option<Box<dyn FnMut() -> Result<(), RewindError> + 'a>>,
}

impl RewindRequest<'_> {
    /// A request with the required members and nothing else.
    pub fn new(session_id: &str, to: RewindTarget, actor: &str) -> Self {
        RewindRequest {
            session_id: session_id.to_owned(),
            to,
            actor: actor.to_owned(),
            lesson: None,
            trigger: None,
            caller: None,
            command_turn_id: None,
            files: false,
            approver: None,
            signal: None,
            validate: None,
        }
    }
}

fn object(v: Option<&J>) -> J {
    match v {
        Some(o @ J::Obj(_)) => o.clone(),
        _ => J::Obj(Vec::new()),
    }
}

/// `/\bFAIL\b|^not ok\b|\berror\b|AssertionError/i` over one line.
fn is_failing_line(text: &str) -> bool {
    let units: Vec<u16> = utf16(text).into_iter().collect();
    let lower: Vec<u16> = units
        .iter()
        .map(|u| {
            if (0x41..=0x5a).contains(u) {
                u + 32
            } else {
                *u
            }
        })
        .collect();
    let find = |word: &str, bounded: bool, anchored: bool| -> bool {
        let w: Vec<u16> = word.encode_utf16().collect();
        if w.len() > lower.len() {
            return false;
        }
        (0..=lower.len() - w.len()).any(|i| {
            lower[i..i + w.len()] == w[..]
                && (!anchored || i == 0)
                && (!bounded
                    || (crate::js::is_boundary(&lower, i)
                        && crate::js::is_boundary(&lower, i + w.len())))
        })
    };
    // `\b` at the start of `fail`, `error` is a boundary test on a word character; for `not ok\b` only the end counts.
    let not_ok = {
        let w: Vec<u16> = "not ok".encode_utf16().collect();
        lower.len() >= w.len()
            && lower[..w.len()] == w[..]
            && crate::js::is_boundary(&lower, w.len())
    };
    find("fail", true, false)
        || not_ok
        || find("error", true, false)
        || find("assertionerror", false, false)
}

fn failing_line(value: &J) -> String {
    if let Some(J::Str(s)) = value.get("essence") {
        return line(s);
    }
    if let Some(J::Str(s)) = value.get("summary") {
        return line(s);
    }
    let output: Vec<&str> = [value.get("stderr"), value.get("stdout")]
        .into_iter()
        .filter_map(|v| match v {
            Some(J::Str(s)) => Some(s.as_str()),
            _ => None,
        })
        .collect();
    let joined = output.join("\n");
    line(
        joined
            .split('\n')
            .find(|l| is_failing_line(l))
            .unwrap_or("Check failed."),
    )
}

struct Facts {
    files: Vec<String>,
    failure: String,
    envelopes: Vec<SummaryMessage>,
}

fn is_failed(event: &EventRecord, value: &J) -> bool {
    event.data.get("isError") == Some(&J::Bool(true))
        || value.get("isError") == Some(&J::Bool(true))
        || value.get("ok") == Some(&J::Bool(false))
        || matches!(value.get("exitCode"), Some(J::Num(n)) if *n != 0.0)
}

fn lesson_facts(messages: &[MessageRecord], events: &[EventRecord]) -> Facts {
    let turns: std::collections::HashSet<&str> = messages
        .iter()
        .filter_map(|m| m.turn_id.as_deref())
        .collect();
    let mut calls: std::collections::HashMap<String, &EventRecord> =
        std::collections::HashMap::new();
    let mut files: Vec<String> = Vec::new();
    let mut envelopes = Vec::new();
    let mut failure = "No failing check recorded.".to_owned();
    for event in events {
        let Some(turn) = event.turn_id.as_deref().filter(|t| turns.contains(t)) else {
            continue;
        };
        let key = format!("{turn}:{}", super::jstext::js_string(event.data.get("id")));
        if event.kind == "tool.call" {
            calls.insert(key, event);
            continue;
        }
        let Some(call) = calls.get(&key) else {
            continue;
        };
        let name = super::jstext::js_string(call.data.get("name"));
        let args = object(call.data.get("args"));
        let value = rewind_result(event);
        let path = match args.get("path") {
            Some(J::Str(p)) => Some(p.as_str()),
            _ => None,
        };
        if (name == "file.edit" || name == "file.write")
            && value.get("isError") != Some(&J::Bool(true))
            && event.data.get("isError") != Some(&J::Bool(true))
        {
            if let Some(p) = path {
                let p = line(p);
                if files.len() < 64 && !files.contains(&p) {
                    files.push(p);
                }
            }
        }
        let failed = is_failed(event, &value);
        if ["code.check", "exec.run", "coding_complete"].contains(&name.as_str()) && failed {
            failure = failing_line(&value);
        }
        // Whitelist the H1 envelope fields. Artifact bodies and complete stdout/stderr are never summary input.
        let artifact_id = match object(value.get("artifact")).get("id") {
            Some(J::Str(id)) if !id.is_empty() && utf16_len(id) <= 256 => Some(id.clone()),
            _ => None,
        };
        let mut env = J::obj([("tool", J::s(&name))]);
        if let Some(p) = path {
            env.set("path", J::s(&line(p)));
        }
        env.set("failed", J::Bool(failed));
        if let Some(id) = artifact_id {
            env.set("artifact", J::obj([("id", J::s(&id))]));
        }
        if failed {
            env.set("essence", J::s(&failing_line(&value)));
        }
        envelopes.push(SummaryMessage {
            role: MessageRole::Tool,
            seq: event.seq,
            text: env.stringify(),
        });
    }
    Facts {
        files,
        failure,
        envelopes,
    }
}

/// The shared rewind service (`RewindService`).
pub struct RewindService {
    d: RewindServiceDeps,
}

impl RewindService {
    /// Creates the service.
    pub fn new(deps: RewindServiceDeps) -> Self {
        Self { d: deps }
    }

    fn report(&self, message: &str) {
        if let Some(f) = &self.d.on_error {
            f(message);
        }
    }

    fn lesson(
        &self,
        store: &SessionStore,
        input: &RewindRequest<'_>,
        plan: &RewindPlan,
    ) -> Result<String, RewindError> {
        let limit = body_chars();
        if let Some(l) = &input.lesson {
            if trim(l).is_empty() || utf16_len(l) > limit {
                return Err(SessionError::invalid(
                    "corrective note must contain text and fit within 1567 characters",
                    "rewind-lesson",
                )
                .into());
            }
        }
        // The raw plan is the immutable audit range. Summary input also excludes failed/recovered harness commands.
        let messages: Vec<MessageRecord> = store
            .context_messages(&input.session_id, None)?
            .into_iter()
            .filter(|m| m.seq >= plan.hidden_from_seq && m.seq <= plan.hidden_to_seq)
            .collect();
        let facts = lesson_facts(&messages, &store.context_tool_events(&input.session_id)?);
        let file_note = if facts.files.is_empty() {
            "Files changed: none recorded.".to_owned()
        } else {
            format!("Files changed: {}.", facts.files.join(", "))
        };
        let mut body = input
            .lesson
            .clone()
            .unwrap_or_else(|| format!("{file_note} {}", facts.failure));
        if input.lesson.is_none() {
            if let Some(summarizer) = &self.d.summarize {
                let mut all: Vec<SummaryMessage> = messages
                    .iter()
                    .map(|m| SummaryMessage {
                        role: m.role,
                        text: m.text.clone(),
                        seq: m.seq,
                    })
                    .collect();
                all.extend(facts.envelopes.iter().cloned());
                all.push(SummaryMessage {
                    role: MessageRole::System,
                    seq: plan.hidden_to_seq,
                    text: format!("Rewind facts: {file_note} {}", facts.failure),
                });
                match summarizer.summarize(
                    &all,
                    (limit / 4) as i64,
                    &input.session_id,
                    input.caller.as_ref(),
                ) {
                    Ok(distilled) => {
                        if !trim(&distilled).is_empty() {
                            body = trim(&distilled).to_owned();
                        }
                    }
                    Err(e) => self.report(&e),
                }
            }
        }
        // The note names changed files because conversation rewind deliberately leaves them changed (Q14).
        if !facts.files.is_empty() && !facts.files.iter().all(|p| body.contains(p.as_str())) {
            if input.lesson.is_none() {
                body = format!("{file_note} {body}");
            } else {
                // An accepted human note is verbatim. Optional file context uses only the remaining budget.
                let room = limit as i64 - len16(&body) as i64 - 1;
                let notice = if len16(&file_note) as i64 <= room {
                    file_note.clone()
                } else if room >= len16("Files changed: …") as i64 {
                    format!("{}…", fit_text(&file_note, (room - 1) as usize))
                } else {
                    String::new()
                };
                if !notice.is_empty() {
                    body = format!("{notice} {body}");
                }
            }
        }
        Ok(format!("{LESSON_PREFIX}{}", fit_text(&body, limit)))
    }

    fn notify(&self, event: &EventRecord) {
        if let Some(f) = &self.d.notify {
            if let Err(e) = f(event) {
                self.report(&e); // Delivery cannot roll back a committed operation; session.events replays it.
            }
        }
    }

    /// `rewind`: distill, revalidate, then atomically append the overlay and lesson. Concurrent changes refuse the stale plan.
    pub fn rewind(
        &self,
        store: &mut SessionStore,
        mut input: RewindRequest<'_>,
    ) -> Result<RewindRecord, RewindError> {
        let plan = store.plan_rewind(
            &input.session_id,
            input.to,
            input.command_turn_id.as_deref(),
            None,
        )?;
        let lesson = self.lesson(store, &input, &plan)?;
        let signal = match (&input.signal, &self.d.signal) {
            (Some(a), Some(b)) => Cancel::any(&[a, b]),
            (Some(a), None) | (None, Some(a)) => a.clone(),
            (None, None) => Cancel::new(),
        };
        signal.throw_if_aborted()?;
        if let Some(v) = input.validate.as_mut() {
            v()?;
        }
        let mut reservation: Option<RewindToken> = None;
        let result = self.apply(store, &mut input, &plan, lesson, &signal, &mut reservation);
        if let Some(token) = reservation {
            store.release_rewind(&input.session_id, token);
        }
        result
    }

    fn apply(
        &self,
        store: &mut SessionStore,
        input: &mut RewindRequest<'_>,
        plan: &RewindPlan,
        lesson: String,
        signal: &Cancel,
        reservation: &mut Option<RewindToken>,
    ) -> Result<RewindRecord, RewindError> {
        let sid = input.session_id.clone();
        let command = input.command_turn_id.clone();
        if input.files {
            let (Some(files), Some(approver)) = (
                self.d.files.as_ref(),
                input
                    .approver
                    .clone()
                    .filter(|a| a.person.as_deref().is_some_and(|p| !p.is_empty())),
            ) else {
                return Err(SessionError::conflict(
                    "approved D115 file checkpoint restore is unavailable",
                    "rewind-checkpoint-unavailable",
                )
                .into());
            };
            let commands = store.harness_command_turns(&sid)?;
            // The oldest discarded ordinary turn, including a hidden earlier attempt, captured the target's file state.
            // Commands never capture files; a missing checkpoint for that ordinary turn must still refuse the restore.
            let Some(checkpoint_turn_id) = plan
                .messages
                .iter()
                .find(|m| m.turn_id.as_ref().is_some_and(|t| !commands.contains(t)))
                .and_then(|m| m.turn_id.clone())
            else {
                return Err(SessionError::conflict(
                    "rewind checkpoint is unavailable",
                    "rewind-checkpoint-unavailable",
                )
                .into());
            };
            let token = store.reserve_rewind(&sid, command.as_deref())?;
            *reservation = Some(token);
            let mut user_validate = input.validate.take();
            let parent_seq = plan.parent_seq;
            let event_seq = plan.event_seq;
            let (vsid, vcommand, vsignal) = (sid.clone(), command.clone(), signal.clone());
            let mut validate = move |store: &mut SessionStore| -> Result<(), RewindError> {
                if let Some(v) = user_validate.as_mut() {
                    v()?;
                }
                vsignal.throw_if_aborted()?;
                let current = store.plan_rewind(
                    &vsid,
                    RewindTarget::Seq(parent_seq),
                    vcommand.as_deref(),
                    Some(token),
                )?;
                if current.event_seq != event_seq {
                    return Err(SessionError::conflict(
                        "session changed before approved file restore",
                        "rewind-stale",
                    )
                    .into());
                }
                Ok(())
            };
            files.restore(
                store,
                RestoreInput {
                    session_id: sid.clone(),
                    parent_seq,
                    hidden_from_seq: plan.hidden_from_seq,
                    hidden_to_seq: plan.hidden_to_seq,
                    checkpoint_turn_id,
                    approver,
                    signal: signal.clone(),
                    validate: &mut validate,
                },
            )?;
        }
        let actor = input.actor.clone();
        let audit = self.d.audit.clone();
        let clock = self.d.clock.clone();
        let mut audit_fn = |event: &super::RewindAuditEvent| -> Result<(), String> {
            let target = match event.detail.get("sessionId") {
                Some(J::Str(s)) => s.clone(),
                _ => String::new(),
            };
            let detail: Vec<(String, Value)> = event
                .detail
                .members()
                .into_iter()
                .map(|(k, v)| (k.to_owned(), v.to_value()))
                .collect();
            append_audit(&audit, clock.now(), &actor, event.action, &target, detail)
                .map_err(|e| e.to_string())
        };
        let audit_ref: AuditFn<'_> = &mut audit_fn;
        let rewind = store.rewind_path(
            &sid,
            RewindInput {
                to: RewindTarget::Seq(plan.parent_seq),
                lesson,
                actor: input.actor.clone(),
                trigger: input.trigger.unwrap_or(RewindTrigger::User),
                expected_event_seq: Some(plan.event_seq),
                audit: Some(audit_ref),
                command_turn_id: command,
                reservation: *reservation,
            },
        )?;
        if let Some(event) = store.list_events(&sid, plan.event_seq, 1)?.first() {
            self.notify(event);
        }
        Ok(rewind)
    }

    /// `afterTurn`: the turn-boundary sensor. Interactive and direct sessions only propose; automatic application needs
    /// every Q13 gate.
    pub fn after_turn(
        &self,
        store: &mut SessionStore,
        session_id: &str,
        person_id: &str,
        unattended: bool,
    ) -> Result<(), RewindError> {
        let Some(session) = store.get_session(session_id)? else {
            return Ok(());
        };
        if session.archived_at.is_some()
            || store.running_turn(&session.id)?.is_some()
            || store.rewind_reserved(&session.id)
        {
            return Ok(());
        }
        let cycles = failed_edit_cycles(&store.context_tool_events(&session.id)?);
        let Some(from_turn) = cycles
            .from_turn_id
            .clone()
            .filter(|_| cycles.failed_cycles >= 3 && !cycles.pending_edit)
        else {
            return Ok(());
        };
        let messages = store.context_messages(&session.id, None)?;
        let Some(first) = messages
            .iter()
            .find(|m| m.turn_id.as_deref() == Some(from_turn.as_str()))
        else {
            return Ok(());
        };
        let parent_seq = messages
            .iter()
            .rev()
            .find(|m| m.seq < first.seq)
            .map_or(0, |m| m.seq);
        let project = if session.kind == SessionKind::Card {
            self.d
                .project
                .as_ref()
                .and_then(|f| f(&session.id, person_id))
        } else {
            None
        };
        let auto = project.as_ref().filter(|p| {
            unattended
                && self
                    .d
                    .auto_projects
                    .as_ref()
                    .is_some_and(|f| f().contains(&p.project_id))
        });
        if let Some(project) = auto {
            let mut request = RewindRequest::new(
                &session.id,
                RewindTarget::Seq(parent_seq),
                &format!("agent:{}", session.agent_id),
            );
            request.trigger = Some(RewindTrigger::Agent);
            let (sid, person) = (session.id.clone(), person_id.to_owned());
            request.validate = Some(Box::new(move || {
                let current = self.d.project.as_ref().and_then(|f| f(&sid, &person));
                let enabled = self
                    .d
                    .auto_projects
                    .as_ref()
                    .is_some_and(|f| f().contains(&project.project_id));
                if !enabled
                    || current.as_ref().map(|c| c.root.as_str()) != Some(project.root.as_str())
                    || current.as_ref().map(|c| c.card_id.as_str())
                        != Some(project.card_id.as_str())
                    || current.as_ref().map(|c| c.project_id.as_str())
                        != Some(project.project_id.as_str())
                {
                    return Err(SessionError::conflict(
                        "automatic rewind project binding changed",
                        "rewind-project-changed",
                    )
                    .into());
                }
                Ok(())
            }));
            self.rewind(store, request)?;
        } else if let Some(event) = store.propose_rewind(
            &session.id,
            &super::RewindProposal {
                parent_seq,
                failed_cycles: cycles.failed_cycles,
                last_check_seq: cycles.last_check_seq,
                agent_id: session.agent_id.clone(),
            },
        )? {
            self.notify(&event);
        }
        Ok(())
    }

    /// `undo`: idempotent; lifts the overlay, the obsolete lesson stays stored but leaves the context view.
    pub fn undo(
        &self,
        store: &mut SessionStore,
        session_id: &str,
        rewind_id: &str,
        actor: &str,
        command_turn_id: Option<&str>,
    ) -> Result<RewindRecord, RewindError> {
        let before = store.last_event_seq(session_id)?.unwrap_or(0);
        let audit = self.d.audit.clone();
        let clock = self.d.clock.clone();
        let who = actor.to_owned();
        let mut audit_fn = |event: &super::RewindAuditEvent| -> Result<(), String> {
            let target = match event.detail.get("sessionId") {
                Some(J::Str(s)) => s.clone(),
                _ => String::new(),
            };
            let detail: Vec<(String, Value)> = event
                .detail
                .members()
                .into_iter()
                .map(|(k, v)| (k.to_owned(), v.to_value()))
                .collect();
            append_audit(&audit, clock.now(), &who, event.action, &target, detail)
                .map_err(|e| e.to_string())
        };
        let rewind = store.undo_rewind(
            session_id,
            rewind_id,
            actor,
            Some(&mut audit_fn),
            command_turn_id,
        )?;
        if let Some(event) = store.list_events(session_id, before, 1)?.first() {
            self.notify(event);
        }
        Ok(rewind)
    }
}

/// A transcript command contains data only. It is never interpreted as a shell command or model instruction.
#[derive(Clone, Debug, PartialEq)]
pub enum RewindCommand {
    /// `{ toSeq, lesson?, files? }`.
    Rewind {
        /// The target.
        to: RewindTarget,
        /// The note.
        lesson: Option<String>,
        /// `--files`.
        files: bool,
    },
    /// `{ undo }`.
    Undo(String),
}

fn words(text: &str) -> Result<Vec<String>, SessionError> {
    let bad = |m: &str| SessionError::invalid(m, "rewind-command");
    let mut result = Vec::new();
    let (mut token, mut quote, mut started) = (String::new(), None::<char>, false);
    let mut chars = text.chars();
    while let Some(c) = chars.next() {
        if c == '\\' && quote != Some('\'') {
            let Some(next) = chars.next() else {
                return Err(bad("incomplete rewind escape"));
            };
            token.push(next);
            started = true;
        } else if let Some(q) = quote {
            if c == q {
                quote = None;
            } else {
                token.push(c);
            }
        } else if c == '\'' || c == '"' {
            quote = Some(c);
            started = true;
        } else if is_js_space(c) {
            if started {
                result.push(std::mem::take(&mut token));
            }
            token.clear();
            started = false;
        } else {
            token.push(c);
            started = true;
        }
    }
    if quote.is_some() {
        return Err(bad("unclosed rewind quote"));
    }
    if started {
        result.push(token);
    }
    Ok(result)
}

/// `isRewindCommand`.
pub fn is_rewind_command(text: &str) -> bool {
    let t = trim(text);
    t.strip_prefix("/rewind")
        .is_some_and(|rest| rest.is_empty() || rest.starts_with(is_js_space))
}

/// `parseRewindCommand`: `None` for ordinary text; a malformed `/rewind` is refused before a turn starts.
pub fn parse_rewind_command(text: &str) -> Result<Option<RewindCommand>, SessionError> {
    if !is_rewind_command(text) {
        return Ok(None);
    }
    let bad = || SessionError::invalid("invalid rewind command", "rewind-command");
    let all = words(trim(text))?;
    let mut args: std::collections::VecDeque<String> = all.into_iter().skip(1).collect();
    if args.front().map(String::as_str) == Some("--undo") {
        let id_ok = |s: &str| {
            (1..=128).contains(&s.len())
                && s.bytes()
                    .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
        };
        if args.len() != 2 || !id_ok(&args[1]) {
            return Err(bad());
        }
        return Ok(Some(RewindCommand::Undo(args[1].clone())));
    }
    let (mut to, mut lesson, mut files) = (RewindTarget::Last, None::<String>, false);
    if let Some(first) = args.front() {
        if first == "last" || (!first.is_empty() && first.bytes().all(|b| b.is_ascii_digit())) {
            let target = args.pop_front().unwrap_or_default();
            if target != "last" {
                let n: f64 = target.parse().unwrap_or(f64::INFINITY);
                if !(n.is_finite() && n <= 9_007_199_254_740_991.0) {
                    return Err(bad());
                }
                to = RewindTarget::Seq(n as i64);
            }
        }
    }
    while let Some(flag) = args.pop_front() {
        if flag == "--files" && !files {
            files = true;
        } else if flag == "--lesson" && lesson.is_none() && !args.is_empty() {
            let text = args.pop_front().unwrap_or_default();
            if trim(&text).is_empty() || utf16_len(&text) > body_chars() {
                return Err(bad());
            }
            lesson = Some(text);
        } else {
            return Err(bad());
        }
    }
    Ok(Some(RewindCommand::Rewind { to, lesson, files }))
}
