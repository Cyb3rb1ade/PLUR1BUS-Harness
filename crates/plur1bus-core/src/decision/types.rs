//! The data and the ports of the decision service (`packages/core/src/decision/types.ts`).
use crate::approvals::js_json::J;
use crate::triage::TriageDecision;
use serde_json::Value;
use std::sync::Arc;

/// The backends a decision can run on.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum BackendName {
    /// The configured decision role, through the admitted production router.
    Role,
    /// A local native backend.
    Laya,
    /// The local System One endpoint.
    Kev,
    /// The cloud System One endpoint.
    Jev,
}

impl BackendName {
    /// The TypeScript spelling.
    pub fn as_str(self) -> &'static str {
        match self {
            BackendName::Role => "role",
            BackendName::Laya => "laya",
            BackendName::Kev => "kev",
            BackendName::Jev => "jev",
        }
    }

    /// The backend of a TypeScript spelling.
    pub fn parse(text: &str) -> Option<BackendName> {
        [
            BackendName::Role,
            BackendName::Laya,
            BackendName::Kev,
            BackendName::Jev,
        ]
        .into_iter()
        .find(|b| b.as_str() == text)
    }
}

/// What a decision is for. Each use case has its own time budget and confidence floor.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum UseCase {
    /// Message triage.
    Triage,
    /// Routing.
    Routing,
    /// Pruning of completed tool pairs.
    Pruning,
    /// Skill selection.
    Skills,
    /// Placement.
    Placement,
    /// Zoom into a branch of the memory tree.
    Zoom,
    /// Compaction.
    Compaction,
}

impl UseCase {
    /// The TypeScript spelling.
    pub fn as_str(self) -> &'static str {
        match self {
            UseCase::Triage => "triage",
            UseCase::Routing => "routing",
            UseCase::Pruning => "pruning",
            UseCase::Skills => "skills",
            UseCase::Placement => "placement",
            UseCase::Zoom => "zoom",
            UseCase::Compaction => "compaction",
        }
    }

    /// The default time budget in milliseconds.
    pub fn budget_ms(self) -> f64 {
        match self {
            UseCase::Triage | UseCase::Skills => 2000.0,
            UseCase::Routing | UseCase::Placement | UseCase::Compaction => 200.0,
            UseCase::Pruning => 100.0,
            UseCase::Zoom => 150.0,
        }
    }

    /// The default confidence floor.
    pub fn floor(self) -> f64 {
        match self {
            UseCase::Triage => 0.0,
            UseCase::Zoom => 0.35,
            _ => 0.7,
        }
    }
}

/// The portable primitives, and the D105 compatibility bridge.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum Primitive {
    /// The probability that a statement is true.
    Noul,
    /// One of the supplied options.
    Choice,
    /// A score over ordered levels.
    Score,
    /// Message triage through the decision role; not a fourth portable primitive.
    TriageCompat,
}

impl Primitive {
    /// The TypeScript spelling.
    pub fn as_str(self) -> &'static str {
        match self {
            Primitive::Noul => "noul",
            Primitive::Choice => "choice",
            Primitive::Score => "score",
            Primitive::TriageCompat => "triage-compat",
        }
    }
}

/// Why a decision gave no answer.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum Failure {
    /// No backend could be asked.
    Unavailable,
    /// The shared deadline passed.
    Timeout,
    /// The input or the backend's answer was malformed.
    Invalid,
    /// The answer was below the confidence floor of the use case.
    LowConfidence,
    /// The content may not leave this machine, or cloud was not admitted.
    Privacy,
    /// The turn was cancelled.
    Cancelled,
}

impl Failure {
    /// The TypeScript spelling.
    pub fn as_str(self) -> &'static str {
        match self {
            Failure::Unavailable => "unavailable",
            Failure::Timeout => "timeout",
            Failure::Invalid => "invalid",
            Failure::LowConfidence => "low-confidence",
            Failure::Privacy => "privacy",
            Failure::Cancelled => "cancelled",
        }
    }
}

/// The turn's cancellation (`AbortSignal`), a port.
pub trait Cancel: Send + Sync {
    /// Whether the turn was cancelled.
    fn cancelled(&self) -> bool;
}

/// A signal that is never raised.
#[derive(Clone, Copy, Debug, Default)]
pub struct NeverCancelled;

impl Cancel for NeverCancelled {
    fn cancelled(&self) -> bool {
        false
    }
}

/// The trusted chat request of the turn the decision belongs to. Never serialised to a System One backend; the role
/// backend hands its members to the router.
#[derive(Clone, Debug, PartialEq)]
pub struct ChatContext {
    /// The principal of the turn.
    pub principal: Option<String>,
    /// The project of the turn.
    pub project_id: Option<String>,
    /// The role of the turn; a decision never asks for another decision.
    pub role: Option<String>,
    /// The whole request as the turn loop holds it (an object; `principal`, `projectId` and `role` are in it too).
    pub request: J,
}

/// Who asks, and under which admission. Built by composition, never read from RPC or tool parameters.
#[derive(Clone)]
pub struct DecisionContext {
    /// The agent.
    pub agent_id: String,
    /// The session.
    pub session_id: Option<String>,
    /// The turn.
    pub turn_id: Option<String>,
    /// The principal; falls back to the chat request's.
    pub principal: Option<String>,
    /// The turn's cancellation.
    pub cancel: Arc<dyn Cancel>,
    /// The locale.
    pub locale: Option<String>,
    /// An absolute deadline on the monotonic clock, shared by a caller across several decisions.
    pub deadline: Option<f64>,
    /// Raw tool output and the like: only a local backend may see the content.
    pub force_local: bool,
    /// Trusted content admission for a cloud System One; denied unless set.
    pub cloud_eligible: bool,
    /// The chat request of the turn.
    pub chat: Option<ChatContext>,
}

impl DecisionContext {
    /// A context for an agent, with nothing admitted and no cancellation.
    pub fn new(agent_id: &str) -> Self {
        Self {
            agent_id: agent_id.to_owned(),
            session_id: None,
            turn_id: None,
            principal: None,
            cancel: Arc::new(NeverCancelled),
            locale: None,
            deadline: None,
            force_local: false,
            cloud_eligible: false,
            chat: None,
        }
    }
}

/// One feature of a decision input.
#[derive(Clone, Debug, PartialEq)]
pub enum Feature {
    /// Text of at most 1024 code units.
    Text(String),
    /// A finite number.
    Number(f64),
    /// A flag.
    Flag(bool),
}

impl Feature {
    /// The feature as JSON.
    pub fn to_j(&self) -> J {
        match self {
            Feature::Text(s) => J::s(s),
            Feature::Number(n) => J::Num(*n),
            Feature::Flag(b) => J::Bool(*b),
        }
    }
}

/// One option of a choice.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ChoiceOption {
    /// The id the backend answers with.
    pub id: String,
    /// What the option means. Untrusted data to the backend, like the state.
    pub description: String,
}

/// The input of a decision.
#[derive(Clone, Debug, PartialEq)]
pub struct DecisionInput {
    /// What the decision is for.
    pub use_case: UseCase,
    /// The untrusted data to evaluate.
    pub state: String,
    /// The question about it.
    pub question: String,
    /// Up to 32 features, in the caller's order.
    pub features: Option<Vec<(String, Feature)>>,
    /// The options of a choice.
    pub options: Option<Vec<ChoiceOption>>,
    /// The ordered levels of a score.
    pub levels: Option<Vec<String>>,
}

impl DecisionInput {
    /// The features as the object TypeScript holds (a repeated name keeps its first place and its last value).
    pub fn features_j(&self) -> Option<J> {
        self.features.as_ref().map(|list| {
            let mut j = J::Obj(Vec::new());
            for (name, value) in list {
                j.set(name, value.to_j());
            }
            j
        })
    }
}

/// What a backend is asked.
#[derive(Clone)]
pub struct DecisionRequest {
    /// The input.
    pub input: DecisionInput,
    /// The id of this decision.
    pub request_id: String,
    /// The primitive.
    pub primitive: Primitive,
    /// The one shared deadline on the monotonic clock.
    pub deadline: f64,
    /// Who asks.
    pub context: DecisionContext,
    /// Effective local-only requirement at admission, including live installation and agent policy.
    pub local_required: bool,
}

/// How a backend failed.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum BackendError {
    /// `DecisionBackendError(reason)`.
    Reason(Failure),
    /// The backend stopped because the deadline passed or the turn was cancelled; the client says which. (TypeScript
    /// races the backend against a timer and the signal; here the backend has to keep the deadline it is handed.)
    Interrupted,
    /// Anything else a backend throws: the answer counts as invalid.
    Other,
}

/// Backend port: store independent, one shared monotonic deadline, finite normalised JSON answers. A native backend
/// must independently prove hardware and locale eligibility before automatic selection.
pub trait DecisionBackend: Send + Sync {
    /// Whether the backend keeps the content on this machine for this context; `Ok(None)` when it is not available.
    /// `Err` is a backend that failed to say (the next backend is tried).
    fn local(&self, context: &DecisionContext) -> Result<Option<bool>, BackendError>;

    /// Whether the backend has an eligibility check at all; automatic selection skips `laya` and `kev` without one.
    fn has_eligible(&self) -> bool {
        false
    }

    /// Whether the backend may be asked for this context.
    fn eligible(&self, _context: &DecisionContext) -> Result<bool, BackendError> {
        Ok(true)
    }

    /// Runs one request and returns the backend's raw answer.
    fn run(&self, request: &DecisionRequest, cancel: &dyn Cancel) -> Result<J, BackendError>;
}

/// The accepted value of a decision.
#[derive(Clone, Debug, PartialEq)]
pub enum DecisionValue {
    /// The probability that the statement is true.
    Noul {
        /// The probability.
        probability: f64,
    },
    /// The chosen option and the probability of every option, in the order of the input.
    Choice {
        /// The chosen id.
        id: String,
        /// `(id, probability)` per option.
        probabilities: Vec<(String, f64)>,
    },
    /// The expected level and the probability of every level.
    Score {
        /// The expected level index.
        score: f64,
        /// The probability per level.
        probabilities: Vec<f64>,
    },
    /// A validated triage decision.
    Triage(TriageDecision),
}

impl DecisionValue {
    /// The value as the TypeScript object.
    pub fn to_j(&self) -> J {
        match self {
            DecisionValue::Noul { probability } => J::obj([("probability", J::Num(*probability))]),
            DecisionValue::Choice { id, probabilities } => {
                let mut map = J::Obj(Vec::new());
                for (option, p) in probabilities {
                    map.set(option, J::Num(*p));
                }
                J::obj([("id", J::s(id)), ("probabilities", map)])
            }
            DecisionValue::Score {
                score,
                probabilities,
            } => J::obj([
                ("score", J::Num(*score)),
                (
                    "probabilities",
                    J::Arr(probabilities.iter().map(|p| J::Num(*p)).collect()),
                ),
            ]),
            DecisionValue::Triage(decision) => decision.as_j().clone(),
        }
    }
}

/// Where a confidence comes from.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ConfidenceSource {
    /// Derived from the probability itself (`noul`).
    Derived,
    /// The backend's calibrated confidence.
    Backend,
    /// The role model's own word.
    Uncalibrated,
}

impl ConfidenceSource {
    /// The TypeScript spelling.
    pub fn as_str(self) -> &'static str {
        match self {
            ConfidenceSource::Derived => "derived",
            ConfidenceSource::Backend => "backend",
            ConfidenceSource::Uncalibrated => "uncalibrated",
        }
    }
}

/// An accepted decision.
#[derive(Clone, Debug, PartialEq)]
pub struct DecisionSuccess {
    /// The id of this decision.
    pub request_id: String,
    /// The backend that answered.
    pub backend: BackendName,
    /// Time taken on the monotonic clock.
    pub elapsed_ms: f64,
    /// The model that answered, when the backend named one.
    pub model_revision: Option<String>,
    /// The value.
    pub value: DecisionValue,
    /// The confidence; NaN where a triage decision carried none.
    pub confidence: f64,
    /// Where it comes from.
    pub confidence_source: ConfidenceSource,
}

/// A decision without an answer.
#[derive(Clone, Debug, PartialEq)]
pub struct DecisionError {
    /// The id of this decision.
    pub request_id: String,
    /// Time taken on the monotonic clock.
    pub elapsed_ms: f64,
    /// Why.
    pub reason: Failure,
    /// The backends that were asked, in order.
    pub attempted: Vec<BackendName>,
}

/// `DecisionResult<T>`.
pub type DecisionResult = Result<DecisionSuccess, DecisionError>;

fn attempted_j(attempted: &[BackendName]) -> J {
    J::Arr(attempted.iter().map(|b| J::s(b.as_str())).collect())
}

/// A result as the TypeScript object, members in TypeScript's order.
pub fn result_j(result: &DecisionResult) -> J {
    match result {
        Ok(ok) => {
            let mut j = J::obj([
                ("ok", J::Bool(true)),
                ("requestId", J::s(&ok.request_id)),
                ("elapsedMs", J::Num(ok.elapsed_ms)),
                ("backend", J::s(ok.backend.as_str())),
            ]);
            if let Some(revision) = &ok.model_revision {
                j.set("modelRevision", J::s(revision));
            }
            j.set("value", ok.value.to_j());
            j.set("confidence", J::Num(ok.confidence));
            j.set("confidenceSource", J::s(ok.confidence_source.as_str()));
            j.set("reasonCode", J::s("accepted"));
            j
        }
        Err(e) => J::obj([
            ("ok", J::Bool(false)),
            ("requestId", J::s(&e.request_id)),
            ("elapsedMs", J::Num(e.elapsed_ms)),
            ("reason", J::s(e.reason.as_str())),
            ("attempted", attempted_j(&e.attempted)),
        ]),
    }
}

/// The bounded record of one decision for telemetry: ids, names, numbers; never the state, the question or the answer.
#[derive(Clone, Debug, PartialEq)]
pub struct DecisionEvent {
    /// The id of the decision.
    pub request_id: String,
    /// The primitive.
    pub primitive: Primitive,
    /// The use case.
    pub use_case: UseCase,
    /// The backends that were asked.
    pub attempted: Vec<BackendName>,
    /// Time taken.
    pub elapsed_ms: f64,
    /// `None` is accepted.
    pub failure: Option<Failure>,
    /// The backend that answered.
    pub backend: Option<BackendName>,
    /// The model that answered (not reported when empty).
    pub model_revision: Option<String>,
    /// The confidence of an accepted decision.
    pub confidence: Option<f64>,
    /// Where it comes from.
    pub confidence_source: Option<ConfidenceSource>,
}

impl DecisionEvent {
    /// The event as the TypeScript object.
    pub fn to_j(&self) -> J {
        let outcome = self.failure.map_or("accepted", Failure::as_str);
        let mut j = J::obj([
            ("requestId", J::s(&self.request_id)),
            ("primitive", J::s(self.primitive.as_str())),
            ("useCase", J::s(self.use_case.as_str())),
            ("attempted", attempted_j(&self.attempted)),
            ("elapsedMs", J::Num(self.elapsed_ms)),
            ("outcome", J::s(outcome)),
            ("reasonCode", J::s(outcome)),
        ]);
        if let Some(backend) = self.backend {
            j.set("backend", J::s(backend.as_str()));
        }
        if let Some(revision) = &self.model_revision {
            j.set("modelRevision", J::s(revision));
        }
        if let (Some(confidence), Some(source)) = (self.confidence, self.confidence_source) {
            j.set("confidence", J::Num(confidence));
            j.set("confidenceSource", J::s(source.as_str()));
        }
        j
    }
}

/// The live configuration (`HarnessConfig` as JSON), a port. It is read again before a backend is asked, so a switch
/// to "local only" during a decision is honoured.
pub trait DecisionConfig: Send + Sync {
    /// The current configuration.
    fn config(&self) -> Value;
}

/// Where request ids come from (`randomUUID()`).
pub use crate::budget::IdSource;
/// The monotonic clock of the decision service (`performance.now()`), in milliseconds.
pub use crate::provider_auth::ports::Clock;
