//! C4 plan derivation and validation from the actual locked revision, never a stale hint grant.
use super::{
    acl,
    derived_fields::{field, object, str_field, text, validate_object},
    journal_io,
    merged_order::{self, truthy},
    revision_io as io,
    revisions::{Action, RevisionRequest, RevisionResult},
    status,
    turns::stable_id,
};
use crate::{
    context::RequestContext,
    contract::{Cancel, EngineError, StoreError},
    store::directory::TrustedDirectory,
    text::{
        js::JsString,
        json::{write_json, TolerantJsonValue as Json},
    },
};

/// Receipt versions bind audit origin and publication order; never reinterpret legacy receipts.
#[derive(Clone, Copy, Eq, PartialEq)]
pub(super) enum AuditMode {
    Tool,
    CurationFacade,
}
impl AuditMode {
    fn version(self) -> Json {
        Json::Number(if self == Self::Tool { "1" } else { "2" }.into())
    }
}
pub(super) fn audit_mode(state: &Json) -> Result<AuditMode, EngineError> {
    match field(state, "version")? {
        Json::Number(v) if v == "1" => Ok(AuditMode::Tool),
        Json::Number(v) if v == "2" => Ok(AuditMode::CurationFacade),
        _ => Err(StoreError::Corrupt.into()),
    }
}
pub(super) fn validate_mode(
    request: &RevisionRequest,
    ctx: &RequestContext,
    mode: AuditMode,
    cancel: &Cancel,
) -> Result<(), EngineError> {
    validate_request(request, ctx)?;
    if mode == AuditMode::CurationFacade {
        if !request.action.curation() {
            return Err(StoreError::InvalidInput.into());
        }
        let rows =
            super::curation::queue(std::slice::from_ref(&request.expected), &[], ctx, cancel)?;
        if rows.len() != 1 {
            return Err(StoreError::InvalidInput.into());
        }
    }
    Ok(())
}
pub(super) fn authority(row: &Json, ctx: &RequestContext) -> Result<acl::Visibility, StoreError> {
    validate_object(row)?;
    let binding = acl::bindings(row, ctx)?;
    if !acl::visible(row, Some(ctx))
        || binding.owner_user_id.is_empty()
        || binding.agent_id.is_empty()
        || binding.workspace_identity != ctx.workspace_key
    {
        return Err(StoreError::InvalidInput);
    }
    Ok(binding)
}
pub(super) fn validate_request(
    request: &RevisionRequest,
    ctx: &RequestContext,
) -> Result<(), EngineError> {
    if request.operation_id.is_nil()
        || write_json(&request.expected).len() > io::MAX_RECORD
        || journal_io::id(&request.expected)?.as_utf16_units().len() > 1024
    {
        return Err(StoreError::InvalidInput.into());
    }
    let _ = authority(&request.expected, ctx)?;
    Ok(())
}
pub(super) fn matches(
    state: &Json,
    request: &RevisionRequest,
    mode: AuditMode,
) -> Result<(), EngineError> {
    if audit_mode(state)? != mode
        || field(state, "operation")? != &text(&request.operation_id.to_string())
        || field(state, "action")? != &text(request.action.as_str())
        || field(state, "before")? != &request.expected
    {
        return Err(StoreError::InvalidInput.into());
    }
    Ok(())
}
pub(super) fn target(state: &Json) -> Result<&'static str, StoreError> {
    match str_field(state, "store")?.to_utf8_lossy().as_str() {
        "behavior" => Ok(io::TARGETS[0]),
        "candidates" => Ok(io::TARGETS[1]),
        _ => Err(StoreError::Corrupt),
    }
}
fn audit(
    ctx: &RequestContext,
    request: &RevisionRequest,
    origin: &str,
    now: &str,
    mode: AuditMode,
) -> Result<Json, StoreError> {
    let curation = request.action.curation();
    let mut values = vec![
        (
            "event",
            text(if curation {
                "curation.resolve"
            } else {
                "neo.status_transition"
            }),
        ),
        (
            "source",
            text(if mode == AuditMode::CurationFacade {
                "engine.memory.curation"
            } else if curation {
                "plur1bus_curation"
            } else {
                "plur1bus_memory"
            }),
        ),
        ("agentId", text(ctx.agent_id.as_str())),
        ("recordId", Json::String(journal_io::id(&request.expected)?)),
        ("action", text(request.action.as_str())),
    ];
    if !curation {
        values.extend([
            ("status", text(request.action.status().as_str())),
            ("store", text(origin)),
        ]);
    }
    values.extend([
        ("timestamp", text(now)),
        ("operationId", text(&request.operation_id.to_string())),
        ("ownerUserId", text(&ctx.owner_user_id)),
        ("workspaceKey", text(&ctx.workspace_key)),
        ("scope", text("agent_private")),
    ]);
    Ok(object(values))
}
fn queue(row: &Json, ctx: &RequestContext, now: &str) -> Result<Json, StoreError> {
    let binding = authority(row, ctx)?;
    let kind = if merged_order::field(row, "sourceSignals").is_some_and(truthy) {
        "behavior"
    } else if ["sourceTurnIds", "statement"]
        .iter()
        .all(|k| merged_order::field(row, k).is_some_and(truthy))
    {
        "memory"
    } else if merged_order::field(row, "role").is_some_and(truthy) {
        "turn"
    } else {
        "unknown"
    };
    let impact = ["impact", "risk", "priority"]
        .iter()
        .filter_map(|k| merged_order::field(row, k))
        .find(|v| truthy(v))
        .map(merged_order::string)
        .unwrap_or_default()
        .to_utf8_lossy()
        .to_lowercase();
    let impact = if ["critical", "high", "medium", "low"].contains(&impact.as_str()) {
        impact.as_str()
    } else {
        "low"
    };
    let target = journal_io::id(row)?;
    let id = stable_id(
        "embq",
        vec![text(kind), Json::String(target.clone()), text(impact)],
    );
    Ok(object(vec![
        ("id", Json::String(id)),
        ("targetId", Json::String(target)),
        ("targetType", text(kind)),
        ("workspaceKey", text(&binding.workspace_identity)),
        ("agentId", text(&binding.agent_id)),
        ("impact", text(impact)),
        (
            "status",
            merged_order::field(row, "embeddingStatus")
                .filter(|v| truthy(v))
                .cloned()
                .unwrap_or_else(|| text("pending")),
        ),
        ("queuedAt", text(now)),
        ("scope", text(&binding.scope)),
        ("ownerUserId", text(&binding.owner_user_id)),
    ]))
}
pub(super) struct Preparation<'a> {
    pub mode: AuditMode,
    pub dir: &'a TrustedDirectory,
    pub workspace: &'a TrustedDirectory,
    pub proof: &'a Json,
    pub caller: &'a Json,
    pub ctx: &'a RequestContext,
    pub cancel: &'a Cancel,
}
pub(super) fn prepare(
    preparation: &Preparation<'_>,
    request: &RevisionRequest,
    now: &str,
) -> Result<Json, EngineError> {
    let Preparation {
        mode,
        dir,
        workspace,
        proof,
        caller,
        ctx,
        cancel,
    } = *preparation;
    let (origin, current) =
        io::current(dir, proof, ctx, &journal_io::id(&request.expected)?, cancel)?;
    let _ = authority(&current, ctx)?;
    if current != request.expected {
        return Err(StoreError::InvalidInput.into());
    }
    let after = status::transition(&current, request.action.status(), &JsString::from(now))?;
    if merged_order::time(&after, true) < merged_order::time(&current, true) {
        return Err(StoreError::InvalidInput.into());
    }
    // Validate all input source files before preparing a private plan. A stale/foreign behavior
    // row can never be hidden by filtering it out and falling back to a candidate with that ID.
    for file in io::TARGETS {
        let _ = io::strict(dir, file, cancel)?;
    }
    let audit_dir = workspace.create_child(".adaptive-learning")?;
    let desired_queue = if request.action.curation() {
        Json::Null
    } else {
        queue(&after, ctx, now)?
    };
    let existing_queue = io::strict(dir, "embedding-queue.jsonl", cancel)?;
    let queue = if desired_queue == Json::Null {
        Json::Null
    } else {
        let id = journal_io::id(&desired_queue)?;
        let previous = existing_queue
            .iter()
            .rev()
            .find(|r| journal_io::id(r).ok().as_ref() == Some(&id));
        if let Some(previous) = previous {
            let _ = authority(previous, ctx)?;
        }
        if previous.is_some_and(|r| merged_order::field(r, "status") == Some(&text("pending"))) {
            Json::Null
        } else {
            desired_queue
        }
    };
    let file = if origin == "behavior" {
        io::TARGETS[0]
    } else {
        io::TARGETS[1]
    };
    Ok(object(vec![
        ("version", mode.version()),
        ("ownership", proof.clone()),
        ("caller", caller.clone()),
        ("operation", text(&request.operation_id.to_string())),
        ("action", text(request.action.as_str())),
        ("before", current),
        ("store", text(&origin)),
        ("now", text(now)),
        ("complete", Json::Bool(false)),
        (
            "appends",
            Json::Array(vec![
                io::append_plan(dir, file, after, cancel)?,
                io::append_plan(
                    &audit_dir,
                    "destructive-ops.jsonl",
                    audit(ctx, request, &origin, now, mode)?,
                    cancel,
                )?,
                io::append_plan(dir, "embedding-queue.jsonl", queue, cancel)?,
            ]),
        ),
    ]))
}
pub(super) fn validate(
    dir: &TrustedDirectory,
    proof: &Json,
    ctx: &RequestContext,
    state: &Json,
    cancel: &Cancel,
) -> Result<RevisionResult, EngineError> {
    validate_object(state)?;
    let mode = audit_mode(state)?;
    if field(state, "ownership")? != proof {
        return Err(StoreError::Corrupt.into());
    }
    let action =
        Action::parse(&str_field(state, "action")?.to_utf8_lossy()).ok_or(StoreError::Corrupt)?;
    let request = RevisionRequest {
        operation_id: uuid::Uuid::parse_str(&str_field(state, "operation")?.to_utf8_lossy())
            .map_err(|_| StoreError::Corrupt)?,
        expected: field(state, "before")?.clone(),
        action,
    };
    validate_mode(&request, ctx, mode, cancel)?;
    let now = str_field(state, "now")?;
    chrono::DateTime::parse_from_rfc3339(&now.to_utf8_lossy()).map_err(|_| StoreError::Corrupt)?;
    let after = status::transition(&request.expected, action.status(), now)?;
    if merged_order::time(&after, true) < merged_order::time(&request.expected, true) {
        return Err(StoreError::Corrupt.into());
    }
    let Json::Array(appends) = field(state, "appends")? else {
        return Err(StoreError::Corrupt.into());
    };
    if appends.len() != 3 || field(&appends[0], "row")? != &after {
        return Err(StoreError::Corrupt.into());
    }
    let origin = str_field(state, "store")?.to_utf8_lossy();
    let _ = target(state)?;
    if field(&appends[1], "row")? != &audit(ctx, &request, &origin, &now.to_utf8_lossy(), mode)? {
        return Err(StoreError::Corrupt.into());
    }
    let queued = field(&appends[2], "row")?;
    if queued != &Json::Null
        && (action.curation() || queued != &queue(&after, ctx, &now.to_utf8_lossy())?)
    {
        return Err(StoreError::Corrupt.into());
    }
    if !action.curation() && queued == &Json::Null {
        let wanted = queue(&after, ctx, &now.to_utf8_lossy())?;
        let existing = io::strict(dir, "embedding-queue.jsonl", cancel)?;
        let previous = existing
            .iter()
            .rev()
            .find(|r| journal_io::id(r).ok() == journal_io::id(&wanted).ok())
            .ok_or(StoreError::Corrupt)?;
        let _ = authority(previous, ctx)?;
        if field(previous, "status")? != &text("pending") {
            return Err(StoreError::Corrupt.into());
        }
    }
    let (current_origin, current) =
        io::current(dir, proof, ctx, &journal_io::id(&request.expected)?, cancel)?;
    let _ = authority(&current, ctx)?;
    if origin != current_origin || current != request.expected && current != after {
        return Err(StoreError::InvalidInput.into());
    }
    Ok(RevisionResult {
        record: after,
        store: origin,
    })
}
