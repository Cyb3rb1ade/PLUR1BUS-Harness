//! `session/memory-port.ts`: the turn loop's one door to the engine (no second memory loop). The loop calls `recall` once
//! before a turn and `capture` once after it. Here is the door as a trait ([`TurnMemory`]) with a recording double
//! ([`RecordingMemory`]), the closed codes, and the decisions the engine-backed port makes before it asks the engine at all
//! ([`recall_gate`], [`capture_gate`]).
//!
//! Not ported: `engineTurnMemory` itself. It resolves the caller's identity, reads the channel context (an
//! `AsyncLocalStorage`), joins the engine's blocks and calls the engine's `recall`, `capture` and `checkpoint`; all of that is
//! the engine, identity and channel code, which sit behind this trait. There are no recorded TypeScript vectors for it (the
//! real port needs an engine, an agent registry and an identity service); the gates below are checked against the TypeScript
//! text by unit tests.
use std::collections::BTreeMap;

/// Why the port did not hand a capture to the engine: a fixed code, never a text taken from a policy or a message.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum CaptureSkipReason {
    /// `channel-policy`.
    ChannelPolicy,
    /// `scope-not-permitted`.
    ScopeNotPermitted,
    /// `core-stopping`.
    CoreStopping,
}

impl CaptureSkipReason {
    /// The wire code.
    pub fn as_str(self) -> &'static str {
        match self {
            Self::ChannelPolicy => "channel-policy",
            Self::ScopeNotPermitted => "scope-not-permitted",
            Self::CoreStopping => "core-stopping",
        }
    }
}

/// What a capture did. A port that returns nothing makes no statement.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum CaptureOutcome {
    /// `{ submitted: true }`.
    Submitted,
    /// `{ submitted: false, reason }`.
    Skipped(CaptureSkipReason),
}

/// The scopes a recall may read.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct RecallScopes {
    /// The workspace.
    pub workspace: bool,
    /// The person's `user` scope.
    pub user: bool,
    /// The agent-private scope.
    pub agent_private: bool,
}

/// `Degraded`: a recall that could not do all it was asked.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Degraded {
    /// A fixed reason.
    pub reason: String,
    /// What was degraded.
    pub capability: String,
    /// A fixed detail, when there is one.
    pub detail: Option<String>,
}

/// One block of a recall.
#[derive(Clone, Debug, PartialEq)]
pub struct RecallBlock {
    /// The card name.
    pub name: String,
    /// The text.
    pub text: String,
    /// Whether the block may be dropped to fit.
    pub droppable: Option<bool>,
    /// Its size in characters.
    pub chars: Option<f64>,
}

/// What a recall answers.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct RecallResult {
    /// The joined text.
    pub text: String,
    /// The card ids.
    pub card_ids: Option<Vec<String>>,
    /// The blocks.
    pub blocks: Option<Vec<RecallBlock>>,
    /// Set when the recall was degraded.
    pub degraded: Option<Degraded>,
}

/// The arguments of a recall.
#[derive(Clone, Debug, PartialEq)]
pub struct RecallRequest {
    /// The agent.
    pub agent_id: String,
    /// The person the caller authenticated as, when there is one.
    pub authenticated_person: Option<String>,
    /// The query.
    pub query: String,
    /// The scopes, when the turn narrows them.
    pub scopes: Option<RecallScopes>,
}

/// One message of a capture.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct CaptureMessage {
    /// `user` or `assistant`.
    pub role: String,
    /// The text.
    pub content: String,
}

/// One tool result of a capture's sources.
#[derive(Clone, Debug, PartialEq)]
pub struct CaptureTool {
    /// The output.
    pub content: String,
    /// When it happened.
    pub timestamp: f64,
    /// The tool.
    pub tool_name: String,
    /// The call id.
    pub tool_call_id: String,
    /// Whether it was an error.
    pub is_error: bool,
}

/// Source metadata from the Core's persisted messages and its own dispatcher.
#[derive(Clone, Debug, PartialEq)]
pub struct CaptureSources {
    /// When the user message was stored.
    pub user_at: f64,
    /// When the assistant message was stored.
    pub assistant_at: f64,
    /// The tool results.
    pub tools: Vec<CaptureTool>,
}

/// The arguments of a capture.
#[derive(Clone, Debug, PartialEq)]
pub struct CaptureRequest {
    /// The agent.
    pub agent_id: String,
    /// The session.
    pub session_id: String,
    /// The turn.
    pub turn_id: String,
    /// The messages.
    pub messages: Vec<CaptureMessage>,
    /// The sources.
    pub sources: Option<CaptureSources>,
    /// Derived by the core from the session; never a client parameter.
    pub incognito: bool,
    /// Where the capture came from, for the log line.
    pub provenance: BTreeMap<String, String>,
}

/// Why a checkpoint was asked for.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum CheckpointReason {
    /// Before a compaction swap.
    Compaction,
    /// At the end of a session.
    SessionEnd,
}

/// `TurnMemory`: one call per turn before the provider runs (`recall`), one after it (`capture`, never for an incognito
/// session), and the `compaction` checkpoint before a swap (never for an incognito session).
pub trait TurnMemory {
    /// Never fails for a degraded recall (it answers `degraded`).
    fn recall(&mut self, request: &RecallRequest) -> Result<RecallResult, String>;
    /// `None` is a port that makes no statement (the turn loop ignores the result).
    fn capture(&mut self, request: &CaptureRequest) -> Result<Option<CaptureOutcome>, String>;
    /// The checkpoint.
    fn checkpoint(&mut self, agent_id: &str, reason: CheckpointReason) -> Result<(), String>;
}

/// What the channel's behaviour says about capturing memory.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ChannelCapture {
    /// No channel policy applies, or the policy allows a full capture.
    Full,
    /// `none`.
    None,
    /// `provenance-only`: a log line, no message text reaches the engine.
    ProvenanceOnly,
}

/// The answer before the engine is asked, with the log line TypeScript writes with it.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct GateAnswer<T> {
    /// What the port answers instead of asking the engine.
    pub answer: T,
    /// The log event, when one is written (`info` or `warn` by its name).
    pub log: Option<&'static str>,
}

/// `recall`'s first checks: no engine memory in this behaviour scope is a degraded answer; narrowed scopes the ACL cannot
/// enforce (it cannot exclude the workspace or the agent-private scope) fail closed. `None` means the engine is asked.
pub fn recall_gate(
    permits_engine_memory: bool,
    scopes: Option<&RecallScopes>,
) -> Option<GateAnswer<RecallResult>> {
    if !permits_engine_memory {
        return Some(GateAnswer {
            answer: RecallResult {
                degraded: Some(Degraded {
                    reason: "behaviour-scope-unavailable".to_owned(),
                    capability: "recall".to_owned(),
                    detail: None,
                }),
                ..RecallResult::default()
            },
            log: None,
        });
    }
    let scopes = scopes.filter(|s| !(s.workspace && s.agent_private))?;
    let detail = [
        (!scopes.workspace).then_some("workspace"),
        (!scopes.agent_private).then_some("agent-private"),
    ]
    .into_iter()
    .flatten()
    .collect::<Vec<_>>()
    .join(", ");
    Some(GateAnswer {
        answer: RecallResult {
            degraded: Some(Degraded {
                reason: "scope-not-enforceable".to_owned(),
                capability: "recall".to_owned(),
                detail: Some(detail),
            }),
            ..RecallResult::default()
        },
        log: Some("memory.recall.refused"),
    })
}

/// `capture`'s first checks, in TypeScript's order: the channel policy, the behaviour scope, a stopping core. `None` means the
/// engine is asked.
pub fn capture_gate(
    policy: ChannelCapture,
    permits_engine_memory: bool,
    stopping: bool,
) -> Option<GateAnswer<CaptureOutcome>> {
    match policy {
        ChannelCapture::None => {
            return Some(GateAnswer {
                answer: CaptureOutcome::Skipped(CaptureSkipReason::ChannelPolicy),
                log: None,
            })
        }
        ChannelCapture::ProvenanceOnly => {
            return Some(GateAnswer {
                answer: CaptureOutcome::Skipped(CaptureSkipReason::ChannelPolicy),
                log: Some("channel.capture.provenance"),
            })
        }
        ChannelCapture::Full => {}
    }
    if !permits_engine_memory {
        return Some(GateAnswer {
            answer: CaptureOutcome::Skipped(CaptureSkipReason::ScopeNotPermitted),
            log: Some("channel.capture.refused"),
        });
    }
    if stopping {
        return Some(GateAnswer {
            answer: CaptureOutcome::Skipped(CaptureSkipReason::CoreStopping),
            log: None,
        });
    }
    None
}

/// A double that records what it was asked and answers what it was told to.
#[derive(Default)]
pub struct RecordingMemory {
    /// Every recall asked.
    pub recalls: Vec<RecallRequest>,
    /// Every capture asked.
    pub captures: Vec<CaptureRequest>,
    /// Every checkpoint asked.
    pub checkpoints: Vec<(String, CheckpointReason)>,
    /// What a recall answers.
    pub recall_answer: RecallResult,
    /// What a capture answers.
    pub capture_answer: Option<CaptureOutcome>,
    /// An error every call answers with, when set.
    pub fail_with: Option<String>,
}

impl TurnMemory for RecordingMemory {
    fn recall(&mut self, request: &RecallRequest) -> Result<RecallResult, String> {
        self.recalls.push(request.clone());
        match &self.fail_with {
            Some(e) => Err(e.clone()),
            None => Ok(self.recall_answer.clone()),
        }
    }
    fn capture(&mut self, request: &CaptureRequest) -> Result<Option<CaptureOutcome>, String> {
        self.captures.push(request.clone());
        match &self.fail_with {
            Some(e) => Err(e.clone()),
            None => Ok(self.capture_answer),
        }
    }
    fn checkpoint(&mut self, agent_id: &str, reason: CheckpointReason) -> Result<(), String> {
        self.checkpoints.push((agent_id.to_owned(), reason));
        match &self.fail_with {
            Some(e) => Err(e.clone()),
            None => Ok(()),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn scopes(workspace: bool, user: bool, agent_private: bool) -> RecallScopes {
        RecallScopes {
            workspace,
            user,
            agent_private,
        }
    }

    #[test]
    fn a_recall_without_engine_memory_is_degraded_before_the_scopes_are_looked_at() {
        let a = recall_gate(false, Some(&scopes(false, false, false))).unwrap();
        assert_eq!(
            a.answer.degraded.unwrap().reason,
            "behaviour-scope-unavailable"
        );
        assert_eq!(a.log, None);
    }

    #[test]
    fn scopes_the_acl_cannot_enforce_fail_closed_with_the_names_in_order() {
        let both = recall_gate(true, Some(&scopes(false, true, false))).unwrap();
        assert_eq!(
            both.answer.degraded.unwrap().detail.as_deref(),
            Some("workspace, agent-private")
        );
        assert_eq!(both.log, Some("memory.recall.refused"));
        let one = recall_gate(true, Some(&scopes(true, true, false))).unwrap();
        assert_eq!(
            one.answer.degraded.unwrap().detail.as_deref(),
            Some("agent-private")
        );
        let other = recall_gate(true, Some(&scopes(false, false, true))).unwrap();
        assert_eq!(
            other.answer.degraded.unwrap().detail.as_deref(),
            Some("workspace")
        );
    }

    #[test]
    fn a_recall_the_acl_can_enforce_goes_to_the_engine() {
        assert!(recall_gate(true, None).is_none());
        assert!(recall_gate(true, Some(&scopes(true, false, true))).is_none());
        assert!(recall_gate(true, Some(&scopes(true, true, true))).is_none());
    }

    #[test]
    fn the_capture_gates_run_in_typescripts_order() {
        use CaptureSkipReason::*;
        let ask = |p, perm, stop| capture_gate(p, perm, stop).map(|a| (a.answer, a.log));
        assert_eq!(
            ask(ChannelCapture::None, false, true),
            Some((CaptureOutcome::Skipped(ChannelPolicy), None))
        );
        assert_eq!(
            ask(ChannelCapture::ProvenanceOnly, false, true),
            Some((
                CaptureOutcome::Skipped(ChannelPolicy),
                Some("channel.capture.provenance")
            ))
        );
        assert_eq!(
            ask(ChannelCapture::Full, false, true),
            Some((
                CaptureOutcome::Skipped(ScopeNotPermitted),
                Some("channel.capture.refused")
            ))
        );
        assert_eq!(
            ask(ChannelCapture::Full, true, true),
            Some((CaptureOutcome::Skipped(CoreStopping), None))
        );
        assert_eq!(ask(ChannelCapture::Full, true, false), None);
    }

    #[test]
    fn the_double_records_every_call_and_answers_what_it_was_told() {
        let mut m = RecordingMemory {
            capture_answer: Some(CaptureOutcome::Submitted),
            ..RecordingMemory::default()
        };
        let req = RecallRequest {
            agent_id: "bernd".into(),
            authenticated_person: None,
            query: "q".into(),
            scopes: None,
        };
        assert_eq!(m.recall(&req).unwrap(), RecallResult::default());
        m.checkpoint("bernd", CheckpointReason::Compaction).unwrap();
        let cap = CaptureRequest {
            agent_id: "bernd".into(),
            session_id: "s".into(),
            turn_id: "t".into(),
            messages: vec![],
            sources: None,
            incognito: false,
            provenance: BTreeMap::new(),
        };
        assert_eq!(m.capture(&cap).unwrap(), Some(CaptureOutcome::Submitted));
        assert_eq!(
            (m.recalls.len(), m.captures.len(), m.checkpoints.len()),
            (1, 1, 1)
        );
        m.fail_with = Some("engine down".into());
        assert_eq!(
            m.checkpoint("bernd", CheckpointReason::SessionEnd)
                .unwrap_err(),
            "engine down"
        );
        assert_eq!(CaptureSkipReason::CoreStopping.as_str(), "core-stopping");
    }
}
