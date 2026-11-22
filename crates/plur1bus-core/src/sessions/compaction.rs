//! `session/compaction.ts`: progressive compaction (D23, ADR-010 L1/L2/L14, ADR-003 "hide, don't delete"). It decides what a
//! model still sees of a session: which messages stay, which are cut with a pointer, which a summary replaces. Deterministic
//! and synchronous apart from the pre-swap checkpoint and the optional summary model, both of which are ports here
//! ([`CompactionHooks`]); no model call and no network happen in this module.
//!
//! The TypeScript `Compactor` owns its store. Here every method is lent the store, and the hooks are lent it too: a summary
//! call that runs while "another task" writes (the stale-revision checks after an `await`) is a hook that writes through the
//! store it was lent. Rounding and division are JavaScript's (`Math.floor`, `Math.ceil`, doubles), lengths are UTF-16 units.
use super::jstext::{head, js_string, len16, one_line, slice};
use super::overlay::{active_summaries, RewindRange};
use super::pruning::{PruneRunError, ToolPair, ToolPruner};
use super::store::SessionStore;
use super::tokens::count as meter_count;
use super::*;
use crate::approvals::js_json::J;
use std::collections::{HashMap, HashSet};

/// `CompactionConfig.summarizer`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SummarizerMode {
    /// `"llm"`: the wired summarizer, when there is one.
    Llm,
    /// `"digest"`: never call the summarizer.
    Digest,
}

/// `CompactionConfig`.
#[derive(Clone, Debug, PartialEq)]
pub struct CompactionConfig {
    /// The model's context window in tokens (8192 fallback only when the read-only catalogue has no window).
    pub window_tokens: i64,
    /// `summarizer`; `None` is `undefined` (the summarizer is used when wired).
    pub summarizer: Option<SummarizerMode>,
    /// D23: prepare a summary above this share of the window (default 0.65).
    pub soft_ratio: f64,
    /// D23: swap it in (and never assemble more) above this share (default 0.88). The L14 bound is `hardRatio * window`.
    pub hard_ratio: f64,
    /// The bound on the summary a session carries (default 15 % of the window), tiered merges included.
    pub summary_max_tokens: i64,
    /// L1/L2: one message is cut to this size in the context view, with a pointer (default 10 %).
    pub max_message_tokens: i64,
}

/// `defaultCompaction(windowTokens = 8192)`.
pub fn default_compaction(window_tokens: i64) -> CompactionConfig {
    CompactionConfig {
        window_tokens,
        summarizer: None,
        soft_ratio: 0.65,
        hard_ratio: 0.88,
        summary_max_tokens: (window_tokens as f64 * 0.15).floor() as i64,
        max_message_tokens: (window_tokens as f64 * 0.1).floor() as i64,
    }
}

/// `estimateTokens`: a crude, monotonic, deterministic estimate (4 UTF-16 units per token, rounded up).
pub fn estimate_tokens(text: &str) -> i64 {
    len16(text).div_ceil(4) as i64
}

/// `truncateWithPointer`: the text, or its head plus a note that says how many characters were cut and where the original is.
pub fn truncate_with_pointer(text: &str, max_tokens: i64, pointer: &str) -> (String, bool) {
    if estimate_tokens(text) <= max_tokens {
        return (text.to_owned(), false);
    }
    let note = format!("\n[truncated {} chars; {pointer}]", len16(text));
    let room = (max_tokens * 4 - len16(&note) as i64).max(0) as usize;
    let joined = format!("{}{note}", slice(text, 0, room));
    (head(&joined, (max_tokens * 4).max(0)), true)
}

/// `digest`'s input: what a summary line needs of a message.
#[derive(Clone, Debug, PartialEq)]
pub struct SummaryMessage {
    /// The role.
    pub role: MessageRole,
    /// The text.
    pub text: String,
    /// The seq.
    pub seq: i64,
}

const LINE_CHARS: usize = 160;
/// A loaded skill's instructions are what the model works from: a successful `skill.load` pair is kept whole up to this size.
const SKILL_LOAD: &str = "skill.load";
const MAX_WHOLE_SKILL_PAIR_CHARS: usize = 256 * 1024;

/// `digest`: the deterministic summariser, one capped line per message.
pub fn digest(messages: &[SummaryMessage]) -> String {
    messages
        .iter()
        .map(|m| {
            format!(
                "{}#{}: {}",
                m.role.as_str(),
                m.seq,
                slice(&one_line(&m.text), 0, LINE_CHARS)
            )
        })
        .collect::<Vec<_>>()
        .join("\n")
}

/// `fitTail`: the newest lines of `text` within `max_tokens`; the elided older ones leave one marker line ("hide, don't
/// delete": the transcript still has them). Total: always within the bound.
pub fn fit_tail(text: &str, max_tokens: i64) -> String {
    if estimate_tokens(text) <= max_tokens {
        return text.to_owned();
    }
    let lines: Vec<&str> = text.split('\n').collect();
    let marker = |dropped: usize| format!("[\u{2026} {dropped} earlier lines elided]");
    // The joined text is the marker plus a newline and the line for each line left; its length is kept as a running sum.
    let mut left = lines.len();
    let mut start = 0;
    let mut tail_units: usize = lines.iter().map(|l| 1 + len16(l)).sum();
    let mut dropped = 0;
    while left > 0 && (len16(&marker(dropped)) + tail_units).div_ceil(4) as i64 > max_tokens {
        tail_units -= 1 + len16(lines[start]);
        start += 1;
        left -= 1;
        dropped += 1;
    }
    let mut parts = vec![marker(dropped)];
    parts.extend(lines[start..].iter().map(|l| (*l).to_owned()));
    let out = parts.join("\n");
    if estimate_tokens(&out) <= max_tokens {
        out
    } else {
        head(&out, max_tokens * 4)
    }
}

/// What the hooks may answer to a pre-swap checkpoint.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum CheckpointAnswer {
    /// The engine took the checkpoint.
    Done,
    /// The session is incognito (D92 section 3.3): nothing was taken.
    Skipped,
}

/// `{ sessionId, fromSeq, toSeq }` of a `beforeSwap`.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SwapInfo {
    /// The session.
    pub session_id: String,
    /// First seq of the segment.
    pub from_seq: i64,
    /// Last seq of the segment.
    pub to_seq: i64,
}

/// `CompactionHooks`: the ports of the compactor. Every method has an answer for "not wired": a default hook does nothing, so a
/// `Compactor` without hooks is `new Compactor(store, cfg)`.
pub trait CompactionHooks {
    /// Whether a summarizer is wired (`hooks.summarizer` is set).
    fn has_summarizer(&self) -> bool {
        false
    }
    /// The summarizer: messages in, a summary or an error text out. The store is lent so a double can write during the call.
    fn summarize(
        &mut self,
        _store: &mut SessionStore,
        _messages: &[SummaryMessage],
        _max_tokens: i64,
        _session_id: &str,
        _caller: Option<&J>,
    ) -> Result<String, String> {
        Err("no summarizer".to_owned())
    }
    /// Whether a pre-swap checkpoint is wired (`hooks.beforeSwap` is set).
    fn has_before_swap(&self) -> bool {
        false
    }
    /// D23: the engine checkpoint `compaction` that precedes every swap.
    fn before_swap(
        &mut self,
        _store: &mut SessionStore,
        _info: &SwapInfo,
    ) -> Result<CheckpointAnswer, String> {
        Ok(CheckpointAnswer::Done)
    }
    /// `emit("compaction.summary.created", attrs)`.
    fn emit(&mut self, _event: &str, _attrs: &J) {}
    /// `onError(what, err)`.
    fn on_error(&mut self, _what: &str, _err: &str) {}
}

/// Hooks that are none.
#[derive(Clone, Copy, Debug, Default)]
pub struct NoHooks;
impl CompactionHooks for NoHooks {}

/// A completed tool call/result pair the view carries as one message.
#[derive(Clone, Debug, PartialEq)]
pub struct ToolCallRef {
    /// The call id.
    pub id: String,
    /// The tool name.
    pub name: String,
    /// Whether `text` is the whole, unclipped pair.
    pub whole: bool,
}

/// One message of a [`ContextView`].
#[derive(Clone, Debug, PartialEq)]
pub struct ViewMessage {
    /// The message id, or the pair's reference.
    pub id: String,
    /// The role.
    pub role: MessageRole,
    /// The text, clipped.
    pub text: String,
    /// The seq (a pair takes the seq of its turn's first message).
    pub seq: i64,
    /// The turn.
    pub turn_id: Option<String>,
    /// Set on a completed tool call/result pair.
    pub tool_call: Option<ToolCallRef>,
}

/// One hidden tool result.
#[derive(Clone, Debug, PartialEq)]
pub struct HiddenRef {
    /// The reference.
    pub reference: String,
    /// The reason, when there is one.
    pub reason: Option<String>,
}

/// `ContextView.compaction`.
#[derive(Clone, Debug, PartialEq, Default)]
pub struct CompactionInfo {
    /// Whether a summary was swapped in.
    pub swapped: bool,
    /// First seq of the swapped segment.
    pub from_seq: Option<i64>,
    /// Last seq of the swapped segment.
    pub to_seq: Option<i64>,
    /// View size before the swap.
    pub tokens_before: Option<i64>,
    /// View size after.
    pub tokens_after: Option<i64>,
    /// `done`, `failed` or `skipped`.
    pub checkpoint: Option<&'static str>,
}

/// `ContextView`.
#[derive(Clone, Debug, PartialEq)]
pub struct ContextView {
    /// The applied summaries.
    pub summaries: Vec<SummaryRecord>,
    /// The messages the model sees.
    pub messages: Vec<ViewMessage>,
    /// The size of all of it.
    pub tokens: i64,
    /// The hidden tool results.
    pub hidden: Vec<HiddenRef>,
    /// Messages cut with a pointer, or dropped from the view.
    pub clipped: i64,
    /// What the last `prepare` did.
    pub compaction: CompactionInfo,
}

/// What `explain` answers: metadata only.
#[derive(Clone, Debug, PartialEq)]
pub struct Explanation {
    /// Applied summaries.
    pub summary_count: usize,
    /// The newest 50 pruning rows.
    pub decisions: Vec<PruneExplanation>,
    /// Whether there were more.
    pub truncated: bool,
    /// The metrics.
    pub metrics: PruneMetrics,
}

/// An error out of a maintenance service: a store error, or what a port threw that TypeScript does not catch.
#[derive(Clone, Debug, PartialEq)]
pub enum MaintError {
    /// A [`SessionError`].
    Session(SessionError),
    /// An error the TypeScript code lets escape (`TypeError` on a malformed decider answer).
    Thrown {
        /// `error.name`.
        name: String,
    },
    /// `new Error("invalid compaction config")`.
    Config(String),
}

impl From<SessionError> for MaintError {
    fn from(e: SessionError) -> Self {
        Self::Session(e)
    }
}
impl From<PruneRunError> for MaintError {
    fn from(e: PruneRunError) -> Self {
        match e {
            PruneRunError::Session(e) => Self::Session(e),
            PruneRunError::Thrown { name } => Self::Thrown { name },
        }
    }
}

struct Segment {
    messages: Vec<ViewMessage>,
    from_seq: i64,
    to_seq: i64,
}

struct SwapResult {
    swapped: bool,
    from_seq: i64,
    to_seq: i64,
    checkpoint: Option<&'static str>,
}

/// `activeSummaries([{ fromSeq, toSeq }], rewinds).length > 0`.
fn range_active(from: i64, to: i64, rewinds: &[RewindRange]) -> bool {
    !rewinds
        .iter()
        .filter(|r| r.undone_at.is_none())
        .any(|r| from <= r.hidden_to_seq && to >= r.hidden_from_seq)
}

/// `Compactor`.
pub struct Compactor {
    /// The base configuration.
    pub cfg: CompactionConfig,
    hooks: Box<dyn CompactionHooks>,
    pruner: Option<ToolPruner>,
    stopped: bool,
    models: HashMap<String, (String, CompactionConfig)>,
}

impl Compactor {
    /// `new Compactor(store, cfg, hooks)`; a configuration that is not usable is refused.
    pub fn new(
        cfg: CompactionConfig,
        hooks: Box<dyn CompactionHooks>,
        pruner: Option<ToolPruner>,
    ) -> Result<Self, MaintError> {
        if cfg.window_tokens <= 0
            || cfg.max_message_tokens < 0
            || cfg.summary_max_tokens < 0
            || !(cfg.soft_ratio > 0.0 && cfg.soft_ratio < cfg.hard_ratio && cfg.hard_ratio < 1.0)
        {
            return Err(MaintError::Config("invalid compaction config".to_owned()));
        }
        Ok(Self {
            cfg,
            hooks,
            pruner,
            stopped: false,
            models: HashMap::new(),
        })
    }

    /// The pruner the compactor drives, when it has one.
    pub fn pruner(&self) -> Option<&ToolPruner> {
        self.pruner.as_ref()
    }

    /// The pruner, mutable.
    pub fn pruner_mut(&mut self) -> Option<&mut ToolPruner> {
        self.pruner.as_mut()
    }

    /// `stop()`.
    pub fn stop(&mut self) {
        self.stopped = true;
    }

    /// `configureModel(sessionId, model, windowTokens?)`: the session's bounds follow the model's window when it has one
    /// (zero counts as none, as `windowTokens ?` does).
    pub fn configure_model(&mut self, session_id: &str, model: &str, window_tokens: Option<i64>) {
        let cfg = match window_tokens {
            Some(w) if w != 0 => CompactionConfig {
                window_tokens: w,
                summary_max_tokens: self
                    .cfg
                    .summary_max_tokens
                    .min((w as f64 * 0.15).floor() as i64),
                max_message_tokens: self
                    .cfg
                    .max_message_tokens
                    .min((w as f64 * 0.1).floor() as i64),
                ..self.cfg.clone()
            },
            _ => self.cfg.clone(),
        };
        self.models
            .insert(session_id.to_owned(), (model.to_owned(), cfg));
    }

    /// `configFor`.
    pub fn config_for(&self, session_id: &str) -> &CompactionConfig {
        self.models.get(session_id).map_or(&self.cfg, |m| &m.1)
    }

    fn model_of(&self, session_id: &str) -> &str {
        self.models.get(session_id).map_or("", |m| m.0.as_str())
    }

    /// `count(sessionId, text, id?)`: the measured count of a recorded usage for this exact text, else the calibrated estimate.
    pub fn count(
        &self,
        store: &SessionStore,
        session_id: &str,
        text: &str,
        id: Option<&str>,
    ) -> Result<i64, SessionError> {
        let model = self.model_of(session_id);
        let measured = match id {
            Some(id) if !id.is_empty() => store.message_usage(id, model, text)?,
            _ => None,
        };
        meter_count(store, model, text, measured.map(|m| m as f64))
    }

    /// `hardLimit` of the base configuration.
    pub fn hard_limit(&self) -> i64 {
        (self.cfg.window_tokens as f64 * self.cfg.hard_ratio).floor() as i64
    }

    /// `softLimit` of the base configuration.
    pub fn soft_limit(&self) -> i64 {
        (self.cfg.window_tokens as f64 * self.cfg.soft_ratio).floor() as i64
    }

    fn summary_bound(&self, store: &SessionStore, session_id: &str) -> Result<i64, SessionError> {
        let factor = store.token_factor(self.model_of(session_id))?;
        Ok((self.config_for(session_id).summary_max_tokens as f64 / factor).floor() as i64)
    }

    fn applied(
        &self,
        store: &SessionStore,
        session_id: &str,
    ) -> Result<Vec<SummaryRecord>, SessionError> {
        let listed = store.list_summaries(session_id, Some(SummaryState::Applied))?;
        let rewinds = store.summary_rewinds(session_id)?;
        let summaries = active_summaries(&listed, &rewinds);
        // Undo can revive a wider original while a replacement of its kept prefix still exists. Render that prefix once.
        Ok(summaries
            .iter()
            .filter(|s| {
                !summaries.iter().any(|o| {
                    o.id != s.id
                        && o.from_seq <= s.from_seq
                        && o.to_seq >= s.to_seq
                        && (o.from_seq < s.from_seq || o.to_seq > s.to_seq)
                })
            })
            .cloned()
            .collect())
    }

    fn prepared(
        &self,
        store: &SessionStore,
        session_id: &str,
    ) -> Result<Vec<SummaryRecord>, SessionError> {
        let listed = store.list_summaries(session_id, Some(SummaryState::Prepared))?;
        let rewinds = store.summary_rewinds(session_id)?;
        Ok(active_summaries(&listed, &rewinds))
    }

    /// `view(sessionId)`: what the next model call sees of the history: applied summaries plus the uncovered messages, each
    /// message capped.
    pub fn view(&self, store: &SessionStore, session_id: &str) -> Result<ContextView, MaintError> {
        let cfg = self.config_for(session_id);
        let summaries = self.applied(store, session_id)?;
        let covered = |seq: i64| {
            summaries
                .iter()
                .any(|s| seq >= s.from_seq && seq <= s.to_seq)
        };
        let mut clipped = 0;
        let pairs: Vec<ToolPair> = match &self.pruner {
            Some(p) => p.view(store, session_id)?,
            None => vec![],
        };
        let mut after_seq = 0;
        // Rewind may leave gaps; only a continuously covered prefix can be omitted from the database read. Explicitly restored
        // tool references still need their original turn anchors, even inside a summary.
        if !pairs.iter().any(|p| p.restored) {
            let mut sorted: Vec<&SummaryRecord> = summaries.iter().collect();
            sorted.sort_by_key(|s| s.from_seq);
            for s in sorted {
                if s.from_seq > after_seq + 1 {
                    break;
                }
                after_seq = after_seq.max(s.to_seq);
            }
        }
        let source = store.context_messages(session_id, Some(after_seq))?;
        let lessons: HashSet<String> = store
            .rewinds(session_id)?
            .into_iter()
            .filter_map(|r| r.lesson_message_id)
            .collect();
        let mut messages: Vec<ViewMessage> = Vec::new();
        for m in source.iter().filter(|m| !covered(m.seq)) {
            let (text, truncated) = truncate_with_pointer(
                &m.text,
                cfg.max_message_tokens,
                &format!("full text is message {} in the session transcript", m.id),
            );
            if truncated {
                clipped += 1;
            }
            // Providers hoist system messages. A distilled lesson stays after the kept conversation, below system rank.
            messages.push(ViewMessage {
                id: m.id.clone(),
                role: if lessons.contains(&m.id) {
                    MessageRole::User
                } else {
                    m.role
                },
                text,
                seq: m.seq,
                turn_id: m.turn_id.clone(),
                tool_call: None,
            });
        }
        for pair in &pairs {
            let Some(first) = source
                .iter()
                .find(|m| m.turn_id.as_deref() == Some(pair.turn_id.as_str()))
            else {
                continue;
            };
            if covered(first.seq) && !pair.restored {
                continue;
            }
            let keep_whole = pair.call.data.get("name").and_then(J::as_str) == Some(SKILL_LOAD)
                && !pair.hidden
                && pair.result.data.get("isError") != Some(&J::Bool(true))
                && len16(&pair.text) <= MAX_WHOLE_SKILL_PAIR_CHARS;
            let (text, truncated) = if keep_whole {
                (pair.text.clone(), false)
            } else {
                truncate_with_pointer(
                    &pair.text,
                    cfg.max_message_tokens,
                    &format!("originals {}, event:{}", pair.reference, pair.result.seq),
                )
            };
            if truncated {
                clipped += 1;
            }
            messages.push(ViewMessage {
                id: pair.reference.clone(),
                role: MessageRole::Tool,
                text,
                seq: first.seq,
                turn_id: Some(pair.turn_id.clone()),
                tool_call: Some(ToolCallRef {
                    id: js_string(pair.call.data.get("id")),
                    name: js_string(pair.call.data.get("name")),
                    whole: !pair.hidden && !truncated,
                }),
            });
        }
        let paired: HashSet<&str> = pairs.iter().map(|p| p.reference.as_str()).collect();
        for call in store.context_tool_events(session_id)? {
            let reference = format!("event:{}", call.seq);
            if call.kind != "tool.call" || paired.contains(reference.as_str()) {
                continue;
            }
            let Some(first) = source.iter().find(|m| m.turn_id == call.turn_id) else {
                continue;
            };
            if covered(first.seq) {
                continue;
            }
            let raw =
                J::obj([("call", call.data.clone()), ("result", J::s("pending"))]).stringify();
            let (text, truncated) = truncate_with_pointer(
                &raw,
                cfg.max_message_tokens,
                &format!("original call {reference}"),
            );
            if truncated {
                clipped += 1;
            }
            messages.push(ViewMessage {
                id: reference,
                role: MessageRole::Tool,
                text,
                seq: first.seq,
                turn_id: call.turn_id.clone(),
                tool_call: None,
            });
        }
        messages.sort_by_key(|m| m.seq);
        let mut tokens = 0;
        for s in &summaries {
            tokens += self.count(store, session_id, &s.text, None)?;
        }
        for m in &messages {
            tokens += self.count(store, session_id, &m.text, Some(&m.id))?;
        }
        Ok(ContextView {
            summaries,
            messages,
            tokens,
            hidden: pairs
                .iter()
                .filter(|p| p.hidden)
                .map(|p| HiddenRef {
                    reference: p.reference.clone(),
                    reason: p.reason.clone().filter(|r| !r.is_empty()),
                })
                .collect(),
            clipped,
            compaction: CompactionInfo::default(),
        })
    }

    /// `explain`: metadata only; no original tool text or arguments are exposed.
    pub fn explain(
        &self,
        store: &SessionStore,
        session_id: &str,
    ) -> Result<Explanation, MaintError> {
        let rows = store.prune_explanation(session_id)?;
        let truncated = rows.len() > 50;
        let decisions = rows[rows.len().saturating_sub(50)..].to_vec();
        Ok(Explanation {
            summary_count: self.applied(store, session_id)?.len(),
            decisions,
            truncated,
            metrics: store.prune_metrics(session_id)?,
        })
    }

    /// `restoreToolRef`.
    pub fn restore_tool_ref(
        &mut self,
        store: &mut SessionStore,
        session_id: &str,
        reference: &str,
    ) -> Result<bool, MaintError> {
        match &mut self.pruner {
            Some(p) => Ok(p.restore(store, session_id, reference)?),
            None => Ok(false),
        }
    }

    /// `prepare`: called with the new user message already stored; guarantees the returned view is within the hard limit
    /// (L14), swapping a summary in when it is not. Never cuts inside a turn and never cuts the newest turn.
    pub fn prepare(
        &mut self,
        store: &mut SessionStore,
        session_id: &str,
    ) -> Result<ContextView, MaintError> {
        let cfg = self.config_for(session_id);
        let hard_limit = (cfg.window_tokens as f64 * cfg.hard_ratio).floor() as i64;
        let mut v = self.view(store, session_id)?;
        if v.tokens <= hard_limit {
            return Ok(v);
        }
        let before = v.tokens;
        let res = self.swap(store, session_id, &v)?;
        v = self.view(store, session_id)?;
        // The bound is unconditional (L14): if even the newest turn does not fit, its oldest messages leave the *view* (the
        // store keeps them) until it does.
        while v.tokens > hard_limit && v.messages.len() > 1 {
            let dropped = v.messages.remove(0);
            v.tokens -= self.count(store, session_id, &dropped.text, Some(&dropped.id))?;
            v.clipped += 1;
        }
        // Even a single hostile message or oversized configured summary must respect L14.
        if v.tokens > hard_limit {
            v.summaries = vec![];
            v.tokens = 0;
            let factor = store.token_factor(self.model_of(session_id))?;
            v.messages = match v.messages.last() {
                Some(newest) => {
                    let mut m = newest.clone();
                    m.text = fit_tail(
                        &m.text,
                        ((hard_limit as f64 / factor).floor() as i64).max(0),
                    );
                    vec![m]
                }
                None => vec![],
            };
            let mut tokens = 0;
            for m in &v.messages {
                tokens += self.count(store, session_id, &m.text, None)?;
            }
            v.tokens = tokens;
            v.clipped += 1;
        }
        v.compaction = CompactionInfo {
            swapped: res.swapped,
            from_seq: res.swapped.then_some(res.from_seq),
            to_seq: res.swapped.then_some(res.to_seq),
            tokens_before: Some(before),
            tokens_after: Some(v.tokens),
            checkpoint: res.checkpoint,
        };
        Ok(v)
    }

    /// `afterTurn`: above the soft threshold, build (but do not swap in) the summary of the oldest segment (D23).
    pub fn after_turn(
        &mut self,
        store: &mut SessionStore,
        session_id: &str,
        caller: Option<&J>,
    ) -> Result<bool, MaintError> {
        if self.stopped
            || store.running_turn(session_id)?.is_some()
            || store.rewind_reserved(session_id)
        {
            return Ok(false);
        }
        if let Some(p) = &mut self.pruner {
            p.run(store, session_id)?;
        }
        if self.stopped {
            return Ok(false);
        }
        let cfg = self.config_for(session_id).clone();
        let v = self.view(store, session_id)?;
        if v.tokens <= (cfg.window_tokens as f64 * cfg.soft_ratio).floor() as i64 {
            return Ok(false);
        }
        if !self.prepared(store, session_id)?.is_empty() {
            return Ok(false);
        }
        let Some(seg) = self.segment(store, &v, &cfg, session_id)? else {
            return Ok(false);
        };
        let revision = store.last_event_seq(session_id)?;
        let older = self.mergeable(store, session_id, &v.summaries, &seg)?;
        let from_seq = older
            .iter()
            .map(|s| s.from_seq)
            .min()
            .unwrap_or(seg.from_seq);
        let tier = older.iter().map(|s| s.tier + 1).fold(1, i64::max);
        let input: Vec<SummaryMessage> = older
            .iter()
            .map(|s| SummaryMessage {
                role: MessageRole::System,
                text: s.text.clone(),
                seq: s.from_seq,
            })
            .chain(seg.messages.iter().map(|m| SummaryMessage {
                role: m.role,
                text: m.text.clone(),
                seq: m.seq,
            }))
            .collect();
        let mut body = digest(&input);
        if self.cfg.summarizer != Some(SummarizerMode::Digest) && self.hooks.has_summarizer() {
            let bound = self.summary_bound(store, session_id)?;
            match self
                .hooks
                .summarize(store, &input, bound, session_id, caller)
            {
                Ok(text) => body = text,
                Err(err) => self.hooks.on_error("compaction summary", &err),
            }
        }
        // A foreground swap while the model ran invalidates this prepared segment.
        if self.stopped
            || store.last_event_seq(session_id)? != revision
            || !self.prepared(store, session_id)?.is_empty()
            || self
                .applied(store, session_id)?
                .iter()
                .any(|s| s.from_seq <= seg.to_seq && s.to_seq >= seg.from_seq)
        {
            return Ok(false);
        }
        let bound = self.summary_bound(store, session_id)?;
        let text = marked(&body, from_seq, seg.to_seq, bound);
        let tokens = self.count(store, session_id, &text, None)?;
        store.add_summary(&NewSummary {
            session_id: session_id.to_owned(),
            from_seq,
            to_seq: seg.to_seq,
            text,
            tokens,
            tier,
            state: SummaryState::Prepared,
        })?;
        self.hooks.emit(
            "compaction.summary.created",
            &J::obj([
                ("sessionId", J::s(session_id)),
                ("fromSeq", J::Num(from_seq as f64)),
                ("toSeq", J::Num(seg.to_seq as f64)),
                ("tier", J::Num(tier as f64)),
            ]),
        );
        Ok(true)
    }

    /// The oldest whole turns of the uncovered tail whose removal brings the view down to the soft threshold; the newest turn
    /// stays.
    fn segment(
        &self,
        store: &SessionStore,
        v: &ContextView,
        cfg: &CompactionConfig,
        session_id: &str,
    ) -> Result<Option<Segment>, SessionError> {
        let mut groups: Vec<Vec<&ViewMessage>> = Vec::new();
        for m in &v.messages {
            match groups.last_mut() {
                Some(last) if m.turn_id.is_some() && last[0].turn_id == m.turn_id => last.push(m),
                _ => groups.push(vec![m]),
            }
        }
        if groups.len() < 2 {
            return Ok(None); // only the newest turn is left: nothing may be cut
        }
        let target = (cfg.window_tokens as f64 * cfg.soft_ratio * 0.5).floor() as i64;
        let rewinds = store.summary_rewinds(session_id)?;
        let mut tokens = v.tokens;
        let mut cut: Vec<ViewMessage> = Vec::new();
        let mut i = 0;
        while i < groups.len() - 1 && tokens > target {
            // A summary records one inclusive source range. Never cross a discarded gap and claim to cover its originals.
            let from = cut.first().map_or(groups[i][0].seq, |m| m.seq);
            let to = groups[i].last().map_or(0, |m| m.seq);
            if !range_active(from, to, &rewinds) {
                break;
            }
            for m in &groups[i] {
                cut.push((*m).clone());
                tokens -= self.count(store, session_id, &m.text, Some(&m.id))?;
            }
            i += 1;
        }
        let (Some(first), Some(last)) = (cut.first(), cut.last()) else {
            return Ok(None);
        };
        Ok(Some(Segment {
            from_seq: first.seq,
            to_seq: last.seq,
            messages: cut,
        }))
    }

    fn mergeable(
        &self,
        store: &SessionStore,
        session_id: &str,
        summaries: &[SummaryRecord],
        segment: &Segment,
    ) -> Result<Vec<SummaryRecord>, SessionError> {
        let rewinds = store.summary_rewinds(session_id)?;
        Ok(summaries
            .iter()
            .filter(|s| {
                s.to_seq < segment.from_seq && range_active(s.from_seq, segment.to_seq, &rewinds)
            })
            .cloned()
            .collect())
    }

    fn swap(
        &mut self,
        store: &mut SessionStore,
        session_id: &str,
        v: &ContextView,
    ) -> Result<SwapResult, SessionError> {
        let none = SwapResult {
            swapped: false,
            from_seq: 0,
            to_seq: 0,
            checkpoint: None,
        };
        let cfg = self.config_for(session_id).clone();
        let Some(seg) = self.segment(store, v, &cfg, session_id)? else {
            return Ok(none);
        };
        let revision = store.last_event_seq(session_id)?;
        let mut checkpoint: &'static str = "skipped";
        if self.hooks.has_before_swap() {
            // RULING: a failed pre-swap checkpoint does not stop the swap (the L14 bound wins over a missed memory write); it
            // is reported in the turn's compaction data and logged.
            let info = SwapInfo {
                session_id: session_id.to_owned(),
                from_seq: seg.from_seq,
                to_seq: seg.to_seq,
            };
            match self.hooks.before_swap(store, &info) {
                Ok(CheckpointAnswer::Skipped) => checkpoint = "skipped",
                Ok(CheckpointAnswer::Done) => checkpoint = "done",
                Err(e) => {
                    checkpoint = "failed";
                    self.hooks.on_error("compaction checkpoint", &e);
                }
            }
        }
        if store.last_event_seq(session_id)? != revision {
            return Ok(none);
        }
        let older = self.mergeable(store, session_id, &v.summaries, &seg)?;
        let from_seq = older
            .iter()
            .map(|s| s.from_seq)
            .min()
            .unwrap_or(seg.from_seq);
        let prepared_all = self.prepared(store, session_id)?;
        let prepared = prepared_all
            .iter()
            .find(|p| p.to_seq <= seg.to_seq && p.from_seq == from_seq);
        let as_summary = |m: &ViewMessage| SummaryMessage {
            role: m.role,
            text: m.text.clone(),
            seq: m.seq,
        };
        let new_text = match prepared {
            Some(p) => {
                let rest: Vec<SummaryMessage> = seg
                    .messages
                    .iter()
                    .filter(|m| m.seq > p.to_seq)
                    .map(as_summary)
                    .collect();
                [p.text.clone(), digest(&rest)].join("\n")
            }
            None => {
                let all: Vec<SummaryMessage> = seg.messages.iter().map(as_summary).collect();
                older
                    .iter()
                    .map(|s| s.text.clone())
                    .chain(std::iter::once(digest(&all)))
                    .collect::<Vec<_>>()
                    .join("\n")
            }
        };
        let bound = self.summary_bound(store, session_id)?;
        let merged = marked(&new_text, from_seq, seg.to_seq, bound);
        let tier = older.iter().map(|s| s.tier + 1).fold(1, i64::max);
        let supersede: Vec<String> = older
            .iter()
            .map(|s| s.id.clone())
            .chain(
                prepared_all
                    .iter()
                    .filter(|s| s.from_seq >= from_seq && s.to_seq <= seg.to_seq)
                    .map(|s| s.id.clone()),
            )
            .collect();
        let tokens = self.count(store, session_id, &merged, None)?;
        store.replace_summaries(
            &supersede,
            &NewSummary {
                session_id: session_id.to_owned(),
                from_seq,
                to_seq: seg.to_seq,
                text: merged,
                tokens,
                tier,
                state: SummaryState::Applied,
            },
        )?;
        Ok(SwapResult {
            swapped: true,
            from_seq: seg.from_seq,
            to_seq: seg.to_seq,
            checkpoint: Some(checkpoint),
        })
    }
}

/// `#marked`: the summary text with its pointer line, within `max` tokens.
fn marked(body: &str, from: i64, to: i64, max: i64) -> String {
    let marker = format!("[summary; originals messages {from}-{to} in transcript]\n");
    let joined = format!(
        "{marker}{}",
        fit_tail(body, (max - estimate_tokens(&marker)).max(0))
    );
    head(&joined, (max * 4).max(0))
}
