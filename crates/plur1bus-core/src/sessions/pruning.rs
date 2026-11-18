//! `session/pruning.ts`: ADR-003 "hide only in the context view; the append-only events are the retrieval source". The pruner
//! decides which old tool results a model no longer sees in full, keeps everything a reference still points at, and writes only
//! visibility rows (and, for a three-way verdict, the `compaction.prune` event) in one transaction.
//!
//! The Laya decision backend is a port ([`PruneHooks::decide`]); the timer and the abort signal of the TypeScript worker are
//! the port's answer ([`DeciderOutcome::TimedOut`]) and [`PruneHooks::aborted`], and `performance.now()` is
//! [`PruneHooks::now_ms`]. The decider is lent the store so a double can write while it "awaits", as another task would.
use super::jstext::{contains_any_ci, js_string, len16, slice, tail};
use super::store::SessionStore;
use super::*;
use crate::approvals::js_json::J;
use sha2::{Digest, Sha256};
use std::collections::{HashMap, HashSet};
use std::sync::OnceLock;
use std::time::Instant;

/// `PruneConfig.decider`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Decider {
    /// The local CPU backend, with the heuristic as its fallback.
    Laya,
    /// Age and size only.
    Heuristic,
    /// Nothing is hidden.
    Off,
}

/// `PruneConfig`.
#[derive(Clone, Debug, PartialEq)]
pub struct PruneConfig {
    /// Whether pruning runs at all.
    pub enabled: bool,
    /// The newest turns whose results are never hidden.
    pub keep_last_turns: i64,
    /// The decider.
    pub decider: Decider,
    /// The time budget of one run in milliseconds.
    pub max_ms: f64,
    /// Results per decider call.
    pub batch_size: i64,
}

/// `DEFAULT_PRUNE_CONFIDENCE`: the floor when no configuration supplies one; equals the `decision.confidence.pruning` default.
pub const DEFAULT_PRUNE_CONFIDENCE: f64 = 0.7;

/// `defaultPrune()`.
pub fn default_prune() -> PruneConfig {
    PruneConfig {
        enabled: true,
        keep_last_turns: 3,
        decider: Decider::Laya,
        max_ms: 100.0,
        batch_size: 16,
    }
}

/// `ToolPair`: a completed tool call with its result.
#[derive(Clone, Debug, PartialEq)]
pub struct ToolPair {
    /// `event:<call seq>`.
    pub reference: String,
    /// The turn.
    pub turn_id: String,
    /// The `tool.call` event.
    pub call: EventRecord,
    /// The `tool.result` event.
    pub result: EventRecord,
    /// What the view shows: the pair as JSON, or the stub when hidden.
    pub text: String,
    /// Hidden.
    pub hidden: bool,
    /// Explicitly restored.
    pub restored: bool,
    /// The stored reason, if a row exists.
    pub reason: Option<String>,
}

/// What a decider port answers.
#[derive(Clone, Debug, PartialEq)]
pub enum DeciderOutcome {
    /// The answer (`null` is `None`: unavailable or over budget, which falls back to the heuristic). The value is the JSON the
    /// backend returned; it is checked here exactly as TypeScript checks it.
    Answer(Option<J>),
    /// The call threw: nothing is hidden.
    Threw,
    /// The time budget ran out while the call was pending: the run's own signal aborts.
    TimedOut,
}

/// `PruneHooks`.
pub trait PruneHooks {
    /// Whether a decider is wired (`hooks.decide`).
    fn has_decider(&self) -> bool {
        false
    }
    /// `LayaDecisionPort`: one batch and the task text in, relevance verdicts out.
    fn decide(
        &mut self,
        _store: &mut SessionStore,
        _batch: &[ToolPair],
        _task: &str,
    ) -> DeciderOutcome {
        DeciderOutcome::Answer(None)
    }
    /// `minConfidence?.()`: the configured floor, read per run.
    fn min_confidence(&self) -> Option<f64> {
        None
    }
    /// `hooks.signal?.aborted`.
    fn aborted(&self) -> bool {
        false
    }
    /// `emit`.
    fn emit(&mut self, _event: &str, _attrs: &J) {}
    /// `performance.now()`.
    fn now_ms(&self) -> f64 {
        static BASE: OnceLock<Instant> = OnceLock::new();
        BASE.get_or_init(Instant::now).elapsed().as_secs_f64() * 1000.0
    }
}

/// Hooks that are none.
#[derive(Clone, Copy, Debug, Default)]
pub struct NoPruneHooks;
impl PruneHooks for NoPruneHooks {}

/// What a pruning run can throw.
#[derive(Clone, Debug, PartialEq)]
pub enum PruneRunError {
    /// A store error.
    Session(SessionError),
    /// An error TypeScript lets escape: a decider answer with a `null` element makes `a.ref` throw a `TypeError`.
    Thrown {
        /// `error.name`.
        name: String,
    },
}

impl From<SessionError> for PruneRunError {
    fn from(e: SessionError) -> Self {
        Self::Session(e)
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Mode {
    Truncate,
    Drop,
}

/// `prunedText`: the deterministic context view; estimates use these exact rendered characters, never stored output rewrites.
fn pruned_text(pair: &ToolPair, mode: Mode) -> String {
    let args = pair.call.data.get("args");
    let args_json = match args {
        None | Some(J::Null) => "{}".to_owned(),
        Some(other) => other.stringify(),
    };
    let args_hash = hex(&Sha256::digest(args_json.as_bytes()));
    let is_error = pair.result.data.get("isError") == Some(&J::Bool(true));
    let stub = format!(
        "call {}; args-sha256 {args_hash}; status {}",
        slice(&js_string(pair.call.data.get("name")), 0, 100),
        if is_error { "error" } else { "ok" }
    );
    if mode == Mode::Drop {
        return format!(
            "[tool output hidden; originals {}, event:{}; {stub}]",
            pair.reference, pair.result.seq
        );
    }
    let output = match pair.result.data.get("output") {
        None | Some(J::Null) => String::new(),
        other => js_string(other),
    };
    format!(
        "{stub}\n{}\n[truncated by compaction: {} tokens, ref {}]\n{}",
        slice(&output, 0, 256),
        len16(&pair.text).div_ceil(4),
        pair.reference,
        tail(&output, 256)
    )
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

struct Boundary {
    pending: Vec<EventRecord>,
    turns: HashMap<String, TurnRecord>,
    latest: i64,
    assistant: String,
}

fn call_key(e: &EventRecord) -> String {
    format!(
        "{}:{}",
        e.turn_id.as_deref().unwrap_or("null"),
        js_string(e.data.get("id"))
    )
}

/// `ToolPruner`.
pub struct ToolPruner {
    /// The configuration.
    pub cfg: PruneConfig,
    hooks: Box<dyn PruneHooks>,
}

impl ToolPruner {
    /// `new ToolPruner(store, cfg, hooks)`; an unusable configuration is refused with `invalid prune config`.
    pub fn new(cfg: PruneConfig, hooks: Box<dyn PruneHooks>) -> Result<Self, String> {
        if cfg.batch_size < 1
            || cfg.keep_last_turns < 1
            || !cfg.max_ms.is_finite()
            || cfg.max_ms <= 0.0
        {
            return Err("invalid prune config".to_owned());
        }
        Ok(Self { cfg, hooks })
    }

    /// `view`: every completed pair of the active turns, hidden ones as their stub.
    pub fn view(
        &self,
        store: &SessionStore,
        session_id: &str,
    ) -> Result<Vec<ToolPair>, SessionError> {
        let visibility: HashMap<String, ToolVisibility> = store
            .tool_visibility(session_id)?
            .into_iter()
            .map(|v| (v.reference.clone(), v))
            .collect();
        let boundary = self.boundary(store, session_id)?;
        let mut pending: HashMap<String, EventRecord> = HashMap::new();
        let mut pairs = Vec::new();
        for event in store.context_tool_events(session_id)? {
            let id = call_key(&event);
            if event.kind == "tool.call" {
                pending.insert(id, event);
                continue;
            }
            let Some(call) = pending.get(&id).cloned() else {
                continue;
            };
            let Some(turn_id) = call.turn_id.clone() else {
                continue;
            };
            pending.remove(&id);
            let reference = format!("event:{}", call.seq);
            let state = visibility.get(&reference);
            // A referenced result is immediately visible, even if the next job has not run yet.
            let raw =
                J::obj([("call", call.data.clone()), ("result", event.data.clone())]).stringify();
            let mut pair = ToolPair {
                reference,
                turn_id,
                call,
                result: event,
                text: raw,
                hidden: state.is_some_and(|s| s.hidden),
                restored: state.is_some_and(|s| !s.hidden),
                reason: state.map(|s| s.reason.clone()),
            };
            if self.protected(&pair, &boundary) {
                pair.hidden = false;
            }
            if pair.hidden {
                let mode = if state.is_some_and(|s| s.truncate) {
                    Mode::Truncate
                } else {
                    Mode::Drop
                };
                pair.text = pruned_text(&pair, mode);
            }
            pairs.push(pair);
        }
        Ok(pairs)
    }

    fn boundary(&self, store: &SessionStore, session_id: &str) -> Result<Boundary, SessionError> {
        let turns = store.list_turns(session_id)?;
        let mut pending: Vec<(String, EventRecord)> = Vec::new();
        for event in store.context_tool_events(session_id)? {
            let key = call_key(&event);
            if event.kind == "tool.call" {
                // `Map.set` of a present key keeps its position and takes the new value.
                match pending.iter_mut().find(|(k, _)| *k == key) {
                    Some(slot) => slot.1 = event,
                    None => pending.push((key, event)),
                }
            } else {
                pending.retain(|(k, _)| *k != key);
            }
        }
        Ok(Boundary {
            pending: pending.into_iter().map(|(_, e)| e).collect(),
            latest: turns.last().map_or(0, |t| t.seq),
            turns: turns.into_iter().map(|t| (t.id.clone(), t)).collect(),
            assistant: store.latest_assistant_context(session_id)?,
        })
    }

    fn protected(&self, pair: &ToolPair, boundary: &Boundary) -> bool {
        let turn = boundary.turns.get(&pair.turn_id);
        if turn.is_none_or(|t| {
            t.state != TurnState::Completed || t.seq > boundary.latest - self.cfg.keep_last_turns
        }) || pair.restored
        {
            return true;
        }
        // A loaded skill's instructions stay in the context until a summary covers their turn: the turn provider sends the
        // pair exactly as the view holds it, so a hidden stub would silently take the skill away.
        if pair.call.data.get("name").and_then(J::as_str) == Some("skill.load")
            && pair.result.data.get("isError") != Some(&J::Bool(true))
        {
            return true;
        }
        // The background worker cannot weaken approval/audit evidence, even when a model says "no".
        let both = J::obj([
            ("call", pair.call.data.clone()),
            ("result", pair.result.data.clone()),
        ])
        .stringify();
        if contains_any_ci(
            &both,
            &[
                "approval",
                "audit",
                "grant",
                "attest",
                "permission",
                "policy",
            ],
        ) {
            return true;
        }
        if boundary
            .pending
            .iter()
            .any(|c| c.turn_id.as_deref() == Some(pair.turn_id.as_str()))
        {
            return true;
        }
        let mut refs = vec![
            pair.reference.clone(),
            format!("event:{}", pair.result.seq),
            js_string(pair.call.data.get("id")),
            pair.turn_id.clone(),
            js_string(pair.call.data.get("name")),
        ];
        if let Some(args) = pair.call.data.get("args") {
            collect_refs(args, "", &mut refs);
        }
        if let Some(parsed) = J::parse(&js_string(pair.result.data.get("output"))) {
            collect_refs(&parsed, "", &mut refs);
        }
        refs.iter().any(|r| {
            !r.is_empty()
                && (boundary.assistant.contains(r.as_str())
                    || boundary.pending.iter().any(|c| {
                        let args = match c.data.get("args") {
                            None | Some(J::Null) => "{}".to_owned(),
                            Some(a) => a.stringify(),
                        };
                        args.contains(r.as_str())
                    }))
        })
    }

    /// `restore`: an explicit restore shows the output again and counts a refetch.
    pub fn restore(
        &mut self,
        store: &mut SessionStore,
        session_id: &str,
        reference: &str,
    ) -> Result<bool, SessionError> {
        let pair = self
            .view(store, session_id)?
            .into_iter()
            .find(|p| p.reference == reference);
        let state = store
            .tool_visibility(session_id)?
            .into_iter()
            .find(|p| p.reference == reference);
        if pair.is_none() || !state.is_some_and(|s| s.hidden) {
            return Ok(false);
        }
        store.set_tool_visibility(session_id, reference, false, "explicit-restore", None)?;
        store.record_tool_refetch(session_id, reference)?;
        self.hooks.emit(
            "compaction.prune.restored",
            &J::obj([("sessionId", J::s(session_id)), ("ref", J::s(reference))]),
        );
        Ok(true)
    }

    /// `metrics`.
    pub fn metrics(
        &self,
        store: &SessionStore,
        session_id: &str,
    ) -> Result<PruneMetrics, SessionError> {
        store.prune_metrics(session_id)
    }

    /// `run`: hide what no turn, assistant text or pending call refers to any more. Returns how many results it hid.
    ///
    /// TypeScript shares one in-flight run per session; a synchronous run cannot be entered twice, so there is nothing to share.
    pub fn run(
        &mut self,
        store: &mut SessionStore,
        session_id: &str,
    ) -> Result<i64, PruneRunError> {
        if self.hooks.aborted()
            || !self.cfg.enabled
            || self.cfg.decider == Decider::Off
            || store.running_turn(session_id)?.is_some()
            || store.rewind_reserved(session_id)
        {
            return Ok(0);
        }
        let started = self.hooks.now_ms();
        let revision = store.last_event_seq(session_id)?;
        let initial = self.boundary(store, session_id)?;
        let candidates: Vec<ToolPair> = self
            .view(store, session_id)?
            .into_iter()
            .filter(|p| !p.hidden && !self.protected(p, &initial))
            .collect();
        if candidates.is_empty() {
            return Ok(0);
        }
        let task = store
            .context_messages(session_id, None)?
            .into_iter()
            .rfind(|m| m.role == MessageRole::User)
            .map_or_else(String::new, |m| m.text);
        struct Proposal {
            pair: ToolPair,
            reason: String,
            detail: Option<PruneDetail>,
        }
        let mut proposed: Vec<Proposal> = Vec::new();
        for batch in candidates.chunks(self.cfg.batch_size as usize) {
            if self.hooks.aborted() || self.hooks.now_ms() - started >= self.cfg.max_ms {
                return Ok(0);
            }
            let heuristic = |batch: &[ToolPair]| -> J {
                J::Arr(
                    batch
                        .iter()
                        .map(|p| {
                            J::obj([
                                ("ref", J::s(&p.reference)),
                                ("relevant", J::Bool(len16(&p.text) < 1024)),
                                ("reason", J::s("old-large-unreferenced")),
                            ])
                        })
                        .collect(),
                )
            };
            let answer: J = if self.cfg.decider == Decider::Laya && self.hooks.has_decider() {
                let outcome = self.hooks.decide(store, batch, &task);
                match outcome {
                    DeciderOutcome::Threw => return Ok(0),
                    // The run's own abort (the time budget) ends the run, as the caller's signal does.
                    DeciderOutcome::TimedOut => return Ok(0),
                    DeciderOutcome::Answer(answer) => {
                        if self.hooks.aborted() {
                            return Ok(0);
                        }
                        // Unavailable or a budget refusal, never a timeout.
                        answer.unwrap_or_else(|| heuristic(batch))
                    }
                }
            } else {
                heuristic(batch)
            };
            if !valid_answer(&answer, batch)? {
                continue;
            }
            // Re-check all boundaries after the await. A new foreground turn makes this stale batch unusable.
            if self.hooks.aborted()
                || store.running_turn(session_id)?.is_some()
                || store.last_event_seq(session_id)? != revision
            {
                return Ok(0);
            }
            let floor = self
                .hooks
                .min_confidence()
                .unwrap_or(DEFAULT_PRUNE_CONFIDENCE);
            let fresh = self.boundary(store, session_id)?;
            let visibility: HashSet<String> = store
                .tool_visibility(session_id)?
                .into_iter()
                .map(|v| v.reference)
                .collect();
            let J::Arr(decisions) = &answer else {
                continue;
            };
            for decision in decisions {
                let reference = decision.get("ref").and_then(J::as_str).unwrap_or("");
                let Some(pair) = batch.iter().find(|p| p.reference == reference) else {
                    continue;
                };
                let verdict = decision.get("verdict");
                let confidence = decision.get("confidence");
                if let Some(v) = verdict {
                    let word = v.as_str();
                    let conf = confidence.and_then(J::as_f64);
                    let ok = matches!(word, Some("keep" | "truncate" | "drop"))
                        && conf.is_some_and(|c| c.is_finite() && c >= floor && c <= 1.0)
                        && word != Some("keep");
                    if !ok {
                        continue;
                    }
                }
                let relevant = decision.get("relevant") == Some(&J::Bool(true));
                if relevant || self.protected(pair, &fresh) || visibility.contains(&pair.reference)
                {
                    continue;
                }
                let detail = match (verdict.and_then(J::as_str), confidence.and_then(J::as_f64)) {
                    (Some(word), Some(c)) => {
                        let mode = if word == "truncate" {
                            Mode::Truncate
                        } else {
                            Mode::Drop
                        };
                        let saved = len16(&pair.text).div_ceil(4) as i64
                            - len16(&pruned_text(pair, mode)).div_ceil(4) as i64;
                        Some(PruneDetail {
                            truncate: mode == Mode::Truncate,
                            confidence: c,
                            tokens_saved: saved.max(0),
                        })
                    }
                    _ => None,
                };
                proposed.push(Proposal {
                    pair: pair.clone(),
                    reason: decision
                        .get("reason")
                        .and_then(J::as_str)
                        .unwrap_or("")
                        .to_owned(),
                    detail,
                });
            }
        }
        if self.hooks.aborted()
            || self.hooks.now_ms() - started >= self.cfg.max_ms
            || store.running_turn(session_id)?.is_some()
            || store.rewind_reserved(session_id)
            || store.last_event_seq(session_id)? != revision
        {
            return Ok(0);
        }
        let boundary = self.boundary(store, session_id)?;
        let visibility: HashSet<String> = store
            .tool_visibility(session_id)?
            .into_iter()
            .map(|v| v.reference)
            .collect();
        let changes: Vec<&Proposal> = proposed
            .iter()
            .filter(|p| {
                !self.protected(&p.pair, &boundary) && !visibility.contains(&p.pair.reference)
            })
            .collect();
        let rows: Vec<VisibilityChange> = changes
            .iter()
            .map(|p| VisibilityChange {
                reference: p.pair.reference.clone(),
                hidden: true,
                reason: p.reason.clone(),
                turn_id: Some(p.pair.turn_id.clone()),
                detail: p.detail.clone(),
            })
            .collect();
        store.set_tool_visibilities(session_id, &rows)?;
        for p in &changes {
            let mut attrs = J::obj([
                ("sessionId", J::s(session_id)),
                ("ref", J::s(&p.pair.reference)),
            ]);
            if let Some(d) = &p.detail {
                attrs.set("mode", J::s(if d.truncate { "truncate" } else { "drop" }));
                attrs.set("confidence", J::Num(d.confidence));
                attrs.set("tokensSaved", J::Num(d.tokens_saved as f64));
            }
            self.hooks.emit("compaction.prune.hidden", &attrs);
        }
        Ok(changes.len() as i64)
    }
}

/// `collect`: the strings under a key that names a path, reference, address or id are references the assistant may use later.
fn collect_refs(value: &J, key: &str, refs: &mut Vec<String>) {
    match value {
        J::Str(s)
            if contains_any_ci(key, &["path", "ref", "uri", "url", "id"]) && len16(s) >= 4 =>
        {
            refs.push(s.clone());
        }
        J::Obj(_) => {
            for (k, v) in value.members() {
                collect_refs(v, k, refs);
            }
        }
        J::Arr(items) => {
            for (i, v) in items.iter().enumerate() {
                collect_refs(v, &i.to_string(), refs);
            }
        }
        _ => {}
    }
}

/// The shape check of a decider answer: an array of exactly the batch, each element naming one batch ref once, with a boolean
/// `relevant` and a non-blank reason of at most 256 units. `Err` is the `TypeError` of reading `.ref` of a `null` element.
fn valid_answer(answer: &J, batch: &[ToolPair]) -> Result<bool, PruneRunError> {
    let J::Arr(items) = answer else {
        return Ok(false);
    };
    if items.len() != batch.len() {
        return Ok(false);
    }
    if items.iter().any(|a| matches!(a, J::Null)) {
        return Err(PruneRunError::Thrown {
            name: "TypeError".to_owned(),
        });
    }
    let refs: Vec<Option<&str>> = items
        .iter()
        .map(|a| a.get("ref").and_then(J::as_str))
        .collect();
    // Anything that is not a string naming a batch ref makes the answer invalid below, so counting such refs as one more
    // distinct value cannot change the verdict.
    let distinct: HashSet<Option<&str>> = refs.iter().copied().collect();
    if distinct.len() != batch.len() {
        return Ok(false);
    }
    Ok(!items.iter().enumerate().any(|(i, a)| {
        let ref_ok = refs[i].is_some_and(|r| batch.iter().any(|p| p.reference == r));
        let relevant_ok = matches!(a.get("relevant"), Some(J::Bool(_)));
        let reason = a.get("reason").and_then(J::as_str);
        !ref_ok
            || !relevant_ok
            || reason
                .is_none_or(|r| r.trim_matches(crate::js::is_js_space).is_empty() || len16(r) > 256)
    }))
}

/// `HiddenToolOutput`: a tool output the pruner hid from the context view; the original is read back from the events.
#[derive(Clone, Debug, PartialEq)]
pub struct HiddenToolOutput {
    /// The reference.
    pub reference: String,
    /// The stored reason.
    pub reason: String,
    /// The tool.
    pub name: String,
    /// The call id.
    pub call_id: String,
    /// The turn.
    pub turn_id: String,
    /// The arguments, when the call had any.
    pub args: Option<J>,
    /// The output text.
    pub output: String,
    /// `isError`, when the result carried one.
    pub is_error: Option<bool>,
}

/// `hiddenToolOutputs`: the outputs whose stored visibility is hidden, newest last. Only the session's own transcript readers
/// call this; it never writes, so the event log and the context view are unchanged.
pub fn hidden_tool_outputs(
    store: &SessionStore,
    session_id: &str,
) -> Result<Vec<HiddenToolOutput>, SessionError> {
    let hidden: HashMap<String, String> = store
        .tool_visibility(session_id)?
        .into_iter()
        .filter(|v| v.hidden)
        .map(|v| (v.reference, v.reason))
        .collect();
    if hidden.is_empty() {
        return Ok(vec![]);
    }
    let events = store.tool_events(session_id)?;
    let mut results: HashMap<String, &EventRecord> = HashMap::new();
    for e in &events {
        if e.kind == "tool.result" {
            if let Some(t) = &e.turn_id {
                results.insert(format!("{t}:{}", js_string(e.data.get("id"))), e);
            }
        }
    }
    let mut out = Vec::new();
    for call in &events {
        let reference = format!("event:{}", call.seq);
        let (Some(turn_id), Some(reason)) = (&call.turn_id, hidden.get(&reference)) else {
            continue;
        };
        if call.kind != "tool.call" {
            continue;
        }
        let result = results.get(&format!("{turn_id}:{}", js_string(call.data.get("id"))));
        out.push(HiddenToolOutput {
            reference,
            reason: reason.clone(),
            name: js_string(call.data.get("name")),
            call_id: js_string(call.data.get("id")),
            turn_id: turn_id.clone(),
            args: call.data.get("args").cloned(),
            output: match result.and_then(|r| r.data.get("output")) {
                None | Some(J::Null) => String::new(),
                other => js_string(other),
            },
            is_error: result.and_then(|r| r.data.get("isError")).map(|v| {
                // `Boolean(value)`.
                match v {
                    J::Null => false,
                    J::Bool(b) => *b,
                    J::Num(n) => *n != 0.0,
                    J::Str(s) => !s.is_empty(),
                    _ => true,
                }
            }),
        });
    }
    Ok(out)
}
