//! The receipt format `plur1bus.decisionreceipt/1` (D133 section 3.3, ruling 1): identifiers, hashes, classes, counters and
//! times, and nothing else. Every string a receipt holds is an identifier of a fixed shape or a member of a closed set, so a
//! sentence cannot be stored in it by accident; [`capture`] copies no content out of a decision input.
use crate::decision::types::{
    BackendName, DecisionContext, DecisionInput, DecisionResult, DecisionValue,
};
use crate::triage::Shape;
use serde::{Deserialize, Serialize};

/// The `schema` member of every receipt.
pub const SCHEMA: &str = "plur1bus.decisionreceipt/1";
/// Most candidates (and most used or reloaded tools) a receipt names.
pub const MAX_IDS: usize = 256;
const MAX_RULES: usize = 32;
const MAX_ERROR_CLASSES: usize = 64;

/// Why a receipt, a report or a call was refused. A value never appears in a message: only the name of the field does.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ReceiptError {
    /// A field is not what the format allows.
    Invalid(&'static str),
    /// A required field is missing.
    Missing(&'static str),
    /// The principal may not do this.
    Denied,
    /// A receipt for this turn and use case exists already.
    Duplicate,
    /// No receipt has this id.
    UnknownReceipt,
    /// The follow-up of this receipt was recorded already.
    OutcomeAlready,
    /// A rule of the live path or of the adoption refused it; the text names the rule.
    Refused(&'static str),
    /// A port failed or is missing.
    Port(&'static str),
    /// The file was written by a newer schema; it was not touched.
    NewerSchema {
        /// Its `user_version`.
        found: u32,
        /// What this build supports.
        supported: u32,
    },
    /// The store failed.
    Store(String),
}

impl std::fmt::Display for ReceiptError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Invalid(x) => write!(f, "decision receipt: `{x}` is invalid"),
            Self::Missing(x) => write!(f, "decision receipt: `{x}` is missing"),
            Self::Denied => f.write_str("decision receipt: not permitted"),
            Self::Duplicate => {
                f.write_str("decision receipt: one exists for this turn and use case")
            }
            Self::UnknownReceipt => f.write_str("decision receipt: unknown receipt"),
            Self::OutcomeAlready => {
                f.write_str("decision receipt: the outcome was recorded already")
            }
            Self::Refused(x) => write!(f, "decision receipt: refused ({x})"),
            Self::Port(x) => write!(f, "decision receipt: port `{x}` failed"),
            Self::NewerSchema { found, supported } => {
                write!(
                    f,
                    "decision receipt store: schema v{found} is newer than v{supported}"
                )
            }
            Self::Store(x) => write!(f, "decision receipt store: {x}"),
        }
    }
}

impl std::error::Error for ReceiptError {}

impl From<plur1bus_store::StoreError> for ReceiptError {
    fn from(e: plur1bus_store::StoreError) -> Self {
        match e {
            plur1bus_store::StoreError::NewerSchema {
                found, supported, ..
            } => Self::NewerSchema { found, supported },
            // The text of a SQLite error names a table or a column, never a value that was stored.
            other => Self::Store(other.to_string()),
        }
    }
}

impl From<plur1bus_store::rusqlite::Error> for ReceiptError {
    fn from(e: plur1bus_store::rusqlite::Error) -> Self {
        Self::Store(e.to_string())
    }
}

/// An identifier: 1 to 128 of `A-Z a-z 0-9 . _ : / @ -`.
pub fn is_identifier(s: &str) -> bool {
    !s.is_empty()
        && s.len() <= 128
        && s.bytes().all(|b| {
            b.is_ascii_alphanumeric() || matches!(b, b'.' | b'_' | b':' | b'/' | b'@' | b'-')
        })
}

fn ident(field: &'static str, s: &str) -> Result<(), ReceiptError> {
    if is_identifier(s) {
        Ok(())
    } else {
        Err(ReceiptError::Invalid(field))
    }
}

fn ident_list(field: &'static str, list: &[String], max: usize) -> Result<(), ReceiptError> {
    if list.len() > max {
        return Err(ReceiptError::Invalid(field));
    }
    for (i, s) in list.iter().enumerate() {
        ident(field, s)?;
        if list[..i].contains(s) {
            return Err(ReceiptError::Invalid(field));
        }
    }
    Ok(())
}

/// Lower-case SHA-256 in hex.
pub fn is_hash(s: &str) -> bool {
    s.len() == 64 && s.bytes().all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f'))
}

fn unit(x: f64) -> bool {
    x.is_finite() && (0.0..=1.0).contains(&x)
}

/// What a decision was for. The use cases of the first version of D133.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ReceiptUseCase {
    /// Message triage.
    Triage,
    /// The model tier.
    Routing,
    /// The tool offer (`CapabilityIndex.route`).
    Tools,
}

impl ReceiptUseCase {
    /// The spelling in the store and in the format.
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Triage => "triage",
            Self::Routing => "routing",
            Self::Tools => "tools",
        }
    }
}

/// Why the host did not accept an answer: a closed set, no text.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum RejectReason {
    /// The answer was malformed.
    Invalid,
    /// The answer named something that was not offered.
    NotACandidate,
    /// The confidence was below the floor of the use case.
    BelowFloor,
    /// The privacy rules did not allow it.
    Privacy,
    /// Another reason.
    Other,
}

/// The host's verdict on an answer.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "status", rename_all = "kebab-case")]
pub enum Validation {
    /// The host took the answer.
    Accepted,
    /// The host refused it.
    Rejected {
        /// Why.
        reason: RejectReason,
    },
}

/// What the service answered: a choice among the candidates or an abstention.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ReceiptResult {
    /// The chosen candidate; `None` is an abstention.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub choice: Option<String>,
    /// The probability of each candidate, in the order of `candidates`; empty when there is none.
    pub distribution: Vec<f64>,
    /// The confidence.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub confidence: Option<f64>,
}

/// The fallback that decided instead of the selector.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Fallback {
    /// The role that was used, an identifier.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub role: Option<String>,
    /// The rules that applied, identifiers.
    pub rules: Vec<String>,
}

/// How many times a class of tool error occurred.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ToolErrorCount {
    /// The class, an identifier.
    pub class: String,
    /// How many.
    pub count: u32,
}

/// What happened after the turn ended (D133, D2).
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Outcome {
    /// The tools the turn used.
    pub used: Vec<String>,
    /// The tools it reloaded with `capabilities.search`.
    pub reloaded: Vec<String>,
    /// Tool errors by class.
    pub tool_errors: Vec<ToolErrorCount>,
}

impl Outcome {
    /// Checks the shape.
    pub fn validate(&self) -> Result<(), ReceiptError> {
        ident_list("outcome.used", &self.used, MAX_IDS)?;
        ident_list("outcome.reloaded", &self.reloaded, MAX_IDS)?;
        if self.tool_errors.len() > MAX_ERROR_CLASSES {
            return Err(ReceiptError::Invalid("outcome.toolErrors"));
        }
        for (i, e) in self.tool_errors.iter().enumerate() {
            ident("outcome.toolErrors", &e.class)?;
            let twice = self.tool_errors[..i].iter().any(|o| o.class == e.class);
            if e.count == 0 || twice {
                return Err(ReceiptError::Invalid("outcome.toolErrors"));
            }
        }
        Ok(())
    }
}

/// One receipt as it is stored and listed.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Receipt {
    /// `plur1bus.decisionreceipt/1`.
    pub schema: String,
    /// The receipt id.
    pub id: String,
    /// The turn.
    pub turn_id: String,
    /// The session.
    pub session_id: String,
    /// The agent.
    pub agent: String,
    /// The message the decision was about; a replay reads its text with the rights of the session store.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub message_id: Option<String>,
    /// The use case.
    pub use_case: ReceiptUseCase,
    /// Epoch milliseconds, from the clock when the receipt was written.
    pub at: i64,
    /// `role`, `laya`, `kev` or `jev`; none when a rule decided.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub backend: Option<String>,
    /// The model revision the backend named.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model_revision: Option<String>,
    /// The version of the calibration record in force (ADR-015).
    pub calibration_version: u32,
    /// The prompt version.
    pub prompt_version: String,
    /// The candidates: categories, profiles or tool ids.
    pub candidates: Vec<String>,
    /// The hash of the capability registry the tool offer was made from.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub registry_hash: Option<String>,
    /// The answer.
    pub result: ReceiptResult,
    /// The host's verdict.
    pub validation: Validation,
    /// The fallback, when one decided.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub fallback: Option<Fallback>,
    /// How long the decision took.
    pub duration_ms: u64,
    /// Tokens sent.
    pub tokens_in: u64,
    /// Tokens received.
    pub tokens_out: u64,
    /// What happened after the turn, once known.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub outcome: Option<Outcome>,
}

impl Receipt {
    /// Checks every field against the format.
    pub fn validate(&self) -> Result<(), ReceiptError> {
        if self.schema != SCHEMA {
            return Err(ReceiptError::Invalid("schema"));
        }
        ident("id", &self.id)?;
        ident("turnId", &self.turn_id)?;
        ident("sessionId", &self.session_id)?;
        ident("agent", &self.agent)?;
        ident("promptVersion", &self.prompt_version)?;
        for (name, v) in [
            ("messageId", &self.message_id),
            ("modelRevision", &self.model_revision),
        ] {
            if let Some(v) = v {
                ident(name, v)?;
            }
        }
        if self.at < 0 {
            return Err(ReceiptError::Invalid("at"));
        }
        if let Some(b) = &self.backend {
            if BackendName::parse(b).is_none() {
                return Err(ReceiptError::Invalid("backend"));
            }
        }
        if self.candidates.is_empty() {
            return Err(ReceiptError::Missing("candidates"));
        }
        ident_list("candidates", &self.candidates, MAX_IDS)?;
        if self.registry_hash.as_deref().is_some_and(|h| !is_hash(h)) {
            return Err(ReceiptError::Invalid("registryHash"));
        }
        if let Some(c) = &self.result.choice {
            if !self.candidates.contains(c) {
                return Err(ReceiptError::Invalid("result.choice"));
            }
        }
        let d = &self.result.distribution;
        if !(d.is_empty() || d.len() == self.candidates.len()) || !d.iter().all(|p| unit(*p)) {
            return Err(ReceiptError::Invalid("result.distribution"));
        }
        if self.result.confidence.is_some_and(|c| !unit(c)) {
            return Err(ReceiptError::Invalid("result.confidence"));
        }
        if let Some(f) = &self.fallback {
            if let Some(r) = &f.role {
                ident("fallback.role", r)?;
            }
            ident_list("fallback.rules", &f.rules, MAX_RULES)?;
        }
        if let Some(o) = &self.outcome {
            o.validate()?;
        }
        Ok(())
    }
}

/// A receipt before the store gives it an id and a time.
#[derive(Clone, Debug, PartialEq)]
pub struct ReceiptDraft {
    /// The turn.
    pub turn_id: String,
    /// The session.
    pub session_id: String,
    /// The agent.
    pub agent: String,
    /// The message the decision was about.
    pub message_id: Option<String>,
    /// The use case.
    pub use_case: ReceiptUseCase,
    /// The backend that answered.
    pub backend: Option<String>,
    /// The model revision.
    pub model_revision: Option<String>,
    /// The version of the calibration record in force.
    pub calibration_version: u32,
    /// The prompt version.
    pub prompt_version: String,
    /// The candidate ids.
    pub candidates: Vec<String>,
    /// The registry hash of a tool offer.
    pub registry_hash: Option<String>,
    /// The answer.
    pub result: ReceiptResult,
    /// The host's verdict.
    pub validation: Validation,
    /// The fallback.
    pub fallback: Option<Fallback>,
    /// Duration in milliseconds.
    pub duration_ms: u64,
    /// Tokens sent.
    pub tokens_in: u64,
    /// Tokens received.
    pub tokens_out: u64,
}

impl ReceiptDraft {
    pub(crate) fn into_receipt(self, id: String, at: i64) -> Receipt {
        Receipt {
            schema: SCHEMA.to_owned(),
            id,
            turn_id: self.turn_id,
            session_id: self.session_id,
            agent: self.agent,
            message_id: self.message_id,
            use_case: self.use_case,
            at,
            backend: self.backend,
            model_revision: self.model_revision,
            calibration_version: self.calibration_version,
            prompt_version: self.prompt_version,
            candidates: self.candidates,
            registry_hash: self.registry_hash,
            result: self.result,
            validation: self.validation,
            fallback: self.fallback,
            duration_ms: self.duration_ms,
            tokens_in: self.tokens_in,
            tokens_out: self.tokens_out,
            outcome: None,
        }
    }

    /// Checks the draft the way the store checks the receipt.
    pub fn validate(&self) -> Result<(), ReceiptError> {
        self.clone()
            .into_receipt("pending".to_owned(), 0)
            .validate()
    }
}

/// What the host knows when a decision is done. The decision input is read for the ids of its options and nothing else.
pub struct Decided<'a> {
    /// The use case of the receipt.
    pub use_case: ReceiptUseCase,
    /// Who asked: only the agent, session and turn ids are read.
    pub context: &'a DecisionContext,
    /// The input: only the ids of its options are read, never `state`, `question`, descriptions, features or levels.
    pub input: &'a DecisionInput,
    /// The candidate ids when the options of the input are not the candidates (the tool offer, triage shapes).
    pub candidates: Option<&'a [String]>,
    /// What the decision service returned.
    pub result: &'a DecisionResult,
    /// The message the decision was about.
    pub message_id: Option<&'a str>,
    /// The prompt version.
    pub prompt_version: &'a str,
    /// The version of the calibration record in force.
    pub calibration_version: u32,
    /// The registry hash of a tool offer.
    pub registry_hash: Option<&'a str>,
    /// The host's verdict.
    pub validation: Validation,
    /// The fallback that decided, if one did.
    pub fallback: Option<Fallback>,
    /// Tokens sent and received.
    pub tokens: (u64, u64),
}

/// The wire name of a triage shape.
pub(crate) fn shape_name(s: Shape) -> &'static str {
    match s {
        Shape::Chat => "chat",
        Shape::Single => "single",
        Shape::Multi => "multi",
        Shape::Followup => "followup",
    }
}

const SHAPES: [&str; 4] = ["chat", "single", "multi", "followup"];

/// Makes the draft of one decision. Nothing of the content of the input or of the answer is copied.
pub fn capture(d: &Decided<'_>) -> Result<ReceiptDraft, ReceiptError> {
    let session_id = d
        .context
        .session_id
        .clone()
        .ok_or(ReceiptError::Missing("sessionId"))?;
    let turn_id = d
        .context
        .turn_id
        .clone()
        .ok_or(ReceiptError::Missing("turnId"))?;
    let candidates: Vec<String> = match (d.candidates, &d.input.options) {
        (Some(c), _) => c.to_vec(),
        (None, Some(options)) => options.iter().map(|o| o.id.clone()).collect(),
        (None, None) if d.use_case == ReceiptUseCase::Triage => {
            SHAPES.iter().map(|s| (*s).to_owned()).collect()
        }
        (None, None) => Vec::new(),
    };
    let (backend, model_revision, result, millis) = match d.result {
        Ok(ok) => {
            let result = match &ok.value {
                DecisionValue::Choice { id, probabilities } => ReceiptResult {
                    choice: Some(id.clone()),
                    distribution: probabilities.iter().map(|(_, p)| *p).collect(),
                    confidence: Some(ok.confidence).filter(|c| c.is_finite()),
                },
                DecisionValue::Triage(t) => ReceiptResult {
                    choice: Some(shape_name(t.shape()).to_owned()),
                    distribution: Vec::new(),
                    confidence: Some(ok.confidence).filter(|c| c.is_finite()),
                },
                _ => return Err(ReceiptError::Invalid("result")),
            };
            (
                Some(ok.backend.as_str().to_owned()),
                ok.model_revision.clone(),
                result,
                ok.elapsed_ms,
            )
        }
        Err(e) => (
            e.attempted.last().map(|b| b.as_str().to_owned()),
            None,
            ReceiptResult {
                choice: None,
                distribution: Vec::new(),
                confidence: None,
            },
            e.elapsed_ms,
        ),
    };
    let draft = ReceiptDraft {
        turn_id,
        session_id,
        agent: d.context.agent_id.clone(),
        message_id: d.message_id.map(str::to_owned),
        use_case: d.use_case,
        backend,
        model_revision,
        calibration_version: d.calibration_version,
        prompt_version: d.prompt_version.to_owned(),
        candidates,
        registry_hash: d.registry_hash.map(str::to_owned),
        result,
        validation: d.validation,
        fallback: d.fallback.clone(),
        duration_ms: if millis.is_finite() && millis > 0.0 {
            millis.round() as u64
        } else {
            0
        },
        tokens_in: d.tokens.0,
        tokens_out: d.tokens.1,
    };
    draft.validate()?;
    Ok(draft)
}
