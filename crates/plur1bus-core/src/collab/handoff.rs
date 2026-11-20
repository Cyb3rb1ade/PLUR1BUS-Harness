//! Collaboration contract validation, authority checks and receiver tickets (D104).
//! The contract keeps JavaScript's JSON member order for the byte ceiling and ticket digest.
use super::errors::{CollabError, CollabErrorCode as C};
use super::ids::CollabIds;
use super::store::R;
use crate::approvals::store::{ApprovalRecord, Status};
use crate::budget::Clock;
use crate::rbac::audit::{AuditEvent, AuditSink};
use crate::toolcall::json::{parse, V};
use crate::toolcall::validation::{assert_schema, validate_arguments, Issue};
use plur1bus_config::js_date::date_parse;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::sync::LazyLock;

const HANDOFF_TOKEN_CAP: usize = 2000;
const CONTRACT_KEYS: &[&str] = &[
    "kind",
    "from",
    "to",
    "task",
    "constraints",
    "authority",
    "budget",
    "returnContract",
    "doneWhen",
];

static HANDOFF_SCHEMA: LazyLock<Option<V>> = LazyLock::new(|| {
    parse(include_str!(
        "../../../../packages/core/src/collab/schemas/handoff.schema.json"
    ))
});
static ACK_SCHEMA: LazyLock<Option<V>> = LazyLock::new(|| {
    parse(include_str!(
        "../../../../packages/core/src/collab/schemas/ack.schema.json"
    ))
});
static RETURN_SCHEMA: LazyLock<Option<V>> = LazyLock::new(|| {
    parse(include_str!(
        "../../../../packages/core/src/collab/schemas/return.schema.json"
    ))
});

/// Trusted authority from dispatch and its chain-backed stores.
pub struct HandoffContext<'a> {
    /// The authenticated person on whose behalf the turn runs.
    pub person: &'a str,
    /// The calling task.
    pub task_id: &'a str,
    /// The calling session.
    pub session_id: &'a str,
    /// The calling agent.
    pub from_agent: &'a str,
    /// The project of the calling task.
    pub project_id: &'a str,
    /// The trusted contract properties frozen before producer repair.
    pub expected: Option<&'a V>,
    /// Whether the handoff must describe prior attempts.
    pub has_history: bool,
    /// Time source used to check expiry.
    pub clock: &'a dyn Clock,
    /// Chain-backed approval lookup (ApprovalStore::get).
    pub approval: &'a dyn Fn(&str) -> R<Option<ApprovalRecord>>,
    /// Chain-backed grant lookup (GrantStore::get). A read error prevents fallback or execution.
    pub grant: &'a dyn Fn(&str) -> R<Option<Value>>,
    /// Receives the audited refusal, with no untrusted payload.
    pub audit: &'a mut dyn AuditSink,
}

/// One opportunity for the sender to repair invalid content.
pub type Repair<'a> = dyn FnMut(&V, &[String]) -> R<V> + 'a;

pub(super) fn property<'a>(value: &'a V, path: &[&str]) -> &'a V {
    path.iter()
        .try_fold(value, |value, key| value.get(key))
        .unwrap_or(&V::Null)
}

fn nonempty(value: &V) -> bool {
    value.as_arr().is_some_and(|items| !items.is_empty())
}

pub(super) fn deadline(contract: &V) -> Option<i64> {
    date_parse(&property(contract, &["budget", "deadline"]).as_js()?.lossy())
}

fn issues_for(value: &V, has_history: bool) -> Vec<String> {
    let Some(schema) = HANDOFF_SCHEMA.as_ref() else {
        return vec!["unsupported handoff schema".to_owned()];
    };
    let mut issues: Vec<String> = match validate_arguments(schema, Some(value), None) {
        Ok(issues) => issues
            .iter()
            .map(|issue: &Issue| format!("{}: {}", issue.path.lossy(), issue.message.lossy()))
            .collect(),
        Err(_) => return vec!["unsupported handoff schema".to_owned()],
    };
    if !issues.is_empty() {
        return issues;
    }
    if value.stringify().len() > HANDOFF_TOKEN_CAP {
        issues.push("handoff exceeds 2000 tokens; move content to artifact references".to_owned());
    }
    let kind = property(value, &["kind"]);
    if !kind.is_str("consult") && !nonempty(property(value, &["doneWhen"])) {
        issues.push("/doneWhen: acceptance criteria required".to_owned());
    }
    if kind.is_str("handoff") && value.get("state").is_none() {
        issues.push("/state: required for ownership transfer".to_owned());
    }
    if has_history && value.get("triedAndFailed").is_none() {
        issues.push("/triedAndFailed: required when there is history".to_owned());
    }
    if deadline(value).is_none() {
        issues.push("/budget/deadline: invalid date".to_owned());
    }
    if assert_schema(property(value, &["returnContract", "outputSchema"])).is_err() {
        issues.push("/returnContract/outputSchema: unsupported output schema".to_owned());
    }
    issues
}

fn refuse(ctx: &mut HandoffContext<'_>, reason: &str) -> CollabError {
    let _ = ctx.audit.append(&AuditEvent {
        at: ctx.clock.now(),
        user: ctx.person.to_owned(),
        host: String::new(),
        action: "handoff.refused".to_owned(),
        target: ctx.task_id.to_owned(),
        detail: vec![("reason".to_owned(), json!(reason))],
    });
    CollabError::with_reason(C::Unauthorized, "handoff authority refused", reason)
}

fn approval_matches(a: &ApprovalRecord, ctx: &HandoffContext<'_>) -> bool {
    a.status == Status::Approved
        && a.delegable
        && a.expires_at > ctx.clock.now() as f64
        && a.bound.principal == ctx.person
        && a.bound.task_id == ctx.task_id
        && a.bound.session_id == ctx.session_id
        && a.bound.subject_id == ctx.from_agent
        && a.bound.subject_kind == "agent"
}

fn grant_matches(g: &Value, ctx: &HandoffContext<'_>) -> bool {
    matches!(g.get("revoked"), None | Some(Value::Bool(false)))
        && g.get("consumedAt").is_none()
        && g.get("delegable").and_then(Value::as_bool) == Some(true)
        && g["person"].as_str() == Some(ctx.person)
        && g["agent"].as_str() == Some(ctx.from_agent)
        && g["taskId"].as_str() == Some(ctx.task_id)
        && match g.get("expiresAt") {
            None | Some(Value::Null) => true,
            Some(expiry) => expiry.as_f64().is_some_and(|n| n > ctx.clock.now() as f64),
        }
}

fn authority_matches(id: &str, ctx: &HandoffContext<'_>) -> bool {
    match (ctx.approval)(id) {
        Ok(Some(a)) => approval_matches(&a, ctx),
        Ok(None) => (ctx.grant)(id).is_ok_and(|g| g.is_some_and(|g| grant_matches(&g, ctx))),
        Err(_) => false,
    }
}

fn verify_authority(h: &V, ctx: &mut HandoffContext<'_>) -> R<()> {
    if ctx.expected.is_some_and(|expected| {
        CONTRACT_KEYS
            .iter()
            .any(|key| match (h.get(key), expected.get(key)) {
                (None, None) => false,
                (Some(actual), Some(expected)) => !actual.deep_equal(expected),
                _ => true,
            })
    }) {
        return Err(refuse(ctx, "handoff-contract-mismatch"));
    }
    if !property(h, &["task", "id"]).is_str(ctx.task_id)
        || !property(h, &["task", "project"]).is_str(ctx.project_id)
        || !property(h, &["from", "agent"]).is_str(ctx.from_agent)
        || !property(h, &["from", "session"]).is_str(ctx.session_id)
    {
        return Err(refuse(ctx, "handoff-binding"));
    }
    if deadline(h).is_none_or(|end| end <= ctx.clock.now()) {
        return Err(refuse(ctx, "handoff-expired"));
    }
    let ids = property(h, &["authority", "approvalsHeld"])
        .as_arr()
        .ok_or_else(|| refuse(ctx, "approval-mismatch"))?;
    for id in ids {
        let id = id.as_js().and_then(|s| String::from_utf16(s.units()).ok());
        if id.is_none_or(|id| !authority_matches(&id, ctx)) {
            return Err(refuse(ctx, "approval-mismatch"));
        }
    }
    Ok(())
}

/// Validates a sender's handoff, with at most one repair of its content. Refusals of authority are final.
pub fn prepare_handoff(
    mut input: V,
    ctx: &mut HandoffContext<'_>,
    repair: Option<&mut Repair<'_>>,
) -> R<V> {
    let mut issues = issues_for(&input, ctx.has_history);
    if !issues.is_empty() {
        if let Some(repair) = repair {
            input = repair(&input, &issues)?;
            issues = issues_for(&input, ctx.has_history);
        }
    }
    if !issues.is_empty() {
        return Err(CollabError::with_reason(
            C::Invalid,
            format!("invalid handoff: {}", issues.join("; ")),
            "handoff-invalid",
        ));
    }
    verify_authority(&input, ctx)?;
    Ok(input)
}

/// Receiver ticket for an immutable handoff and the original trusted dispatch context.
pub struct HandoffTicket<'ctx, 'ports> {
    /// SHA-256 of the canonical wire bytes as received by the ticket.
    pub digest: String,
    handoff: V,
    context: &'ctx mut HandoffContext<'ports>,
    acked: bool,
    started: bool,
}

impl<'ctx, 'ports> HandoffTicket<'ctx, 'ports> {
    /// Verify the contract and its authority before asking a target to acknowledge it.
    pub fn new(handoff: V, context: &'ctx mut HandoffContext<'ports>) -> R<Self> {
        if !issues_for(&handoff, context.has_history).is_empty() {
            return Err(CollabError::new(C::Invalid, "invalid handoff ticket"));
        }
        verify_authority(&handoff, context)?;
        let digest = format!("{:x}", Sha256::digest(handoff.stringify()));
        Ok(Self {
            digest,
            acked: property(&handoff, &["kind"]).is_str("consult"),
            handoff,
            context,
            started: false,
        })
    }

    /// The immutable contract held by this ticket.
    pub fn handoff(&self) -> &V {
        &self.handoff
    }

    /// Record a positive acknowledgment that refers to this handoff.
    pub fn acknowledge(&mut self, ack: &V) -> R<()> {
        if !ACK_SCHEMA
            .as_ref()
            .is_some_and(|schema| schema_matches(schema, ack))
        {
            return Err(CollabError::new(C::Invalid, "invalid handoff ack"));
        }
        if !property(ack, &["inReplyTo"]).deep_equal(property(&self.handoff, &["id"]))
            || !property(ack, &["status"]).is_str("ok")
            || nonempty(property(ack, &["blockingQuestions"]))
        {
            return Err(CollabError::new(
                C::Conflict,
                "receiver has not accepted handoff",
            ));
        }
        self.acked = true;
        Ok(())
    }

    /// Recheck live authority and release the contract to the receiver once.
    pub fn start(&mut self) -> R<&V> {
        if !self.acked || self.started {
            return Err(CollabError::new(
                C::Conflict,
                "handoff needs ack and may start only once",
            ));
        }
        verify_authority(&self.handoff, self.context)?;
        self.started = true;
        Ok(&self.handoff)
    }
}

fn schema_matches(schema: &V, value: &V) -> bool {
    validate_arguments(schema, Some(value), None).is_ok_and(|issues| issues.is_empty())
}

/// Validate the report against the original handoff and its return schema.
pub fn validate_return(input: &V, handoff: &V) -> R<()> {
    if !RETURN_SCHEMA
        .as_ref()
        .is_some_and(|schema| schema_matches(schema, input))
    {
        return Err(CollabError::new(C::Invalid, "invalid return envelope"));
    }
    let cap = property(handoff, &["returnContract", "maxTokens"]).as_f64();
    if !property(input, &["inReplyTo"]).deep_equal(property(handoff, &["id"]))
        || cap.is_none_or(|cap| cap < input.stringify().len() as f64)
    {
        return Err(CollabError::new(
            C::Invalid,
            "return binding or token cap exceeded",
        ));
    }
    let status = property(input, &["status"]);
    if status.is_str("done") || status.is_str("done_with_concerns") {
        if property(handoff, &["returnContract", "citationsRequired"]).truthy()
            && !nonempty(property(input, &["citations"]))
        {
            return Err(CollabError::new(C::Invalid, "return needs citations"));
        }
        if !schema_matches(
            property(handoff, &["returnContract", "outputSchema"]),
            property(input, &["output"]),
        ) {
            return Err(CollabError::new(
                C::Invalid,
                "return output schema mismatch",
            ));
        }
    }
    Ok(())
}

/// Validate a report, with at most one repair against the unchanged contract.
pub fn prepare_return(mut input: V, handoff: &V, repair: Option<&mut Repair<'_>>) -> R<V> {
    if let Err(error) = validate_return(&input, handoff) {
        let Some(repair) = repair else {
            return Err(error);
        };
        input = repair(&input, &[error.message])?;
        validate_return(&input, handoff)?;
    }
    Ok(input)
}

/// Prefix bounded by UTF-8 bytes, ending at a complete code point.
pub fn bounded_excerpt(text: &str, max_bytes: usize) -> &str {
    &text[..text.floor_char_boundary(max_bytes)]
}

/// Adapter-authored report for a plain-text target, with a bounded excerpt and explicit unverified provenance.
pub fn return_from_text(
    handoff: &V,
    text: &str,
    usage: V,
    partial: bool,
    artifacts: V,
    ids: &dyn CollabIds,
) -> V {
    let clipped = text.len() > 600;
    let mut concerns = vec![if partial {
        "Interrupted; available output only"
    } else {
        "Delegate report; external verification required"
    }];
    if clipped {
        concerns.push("Excerpt; see referenced full output or delegation transcript.");
    }
    let mut output = bounded_excerpt(text, 600).to_owned();
    if clipped {
        output.push_str("\n[excerpt]");
    }
    V::obj([
        ("schema", V::s("plur1bus.return/1")),
        ("id", V::s(&ids.new_id("rt"))),
        ("inReplyTo", property(handoff, &["id"]).clone()),
        (
            "status",
            V::s(if partial {
                "partial"
            } else {
                "done_with_concerns"
            }),
        ),
        ("summary", V::s(bounded_excerpt(text, 200))),
        ("doneWhen", V::Arr(vec![])),
        ("changes", V::Arr(vec![])),
        ("artifacts", artifacts),
        ("concerns", V::strs(&concerns)),
        ("blockedBy", V::Null),
        ("needs", V::Arr(vec![])),
        ("assumptionsChecked", V::Arr(vec![])),
        ("learned", V::Arr(vec![])),
        ("suggestedNext", V::Arr(vec![])),
        ("usage", usage),
        ("output", V::s(&output)),
    ])
}

#[cfg(test)]
#[path = "handoff_vectors.rs"]
mod vectors;
