//! Optional serialized endpoint tuples must agree with native private cleanup authority.
use super::{
    derived_fields::{text, validate_object},
    merged_order::field,
};
use crate::{context::RequestContext, text::json::TolerantJsonValue as Json};

pub(super) fn private_cleanup_binding(edge: &Json, ctx: &RequestContext) -> bool {
    if !matches!(field(edge, "needsRebuild"), None | Some(Json::Bool(false))) {
        return false;
    }
    let claims = [
        "ownershipStatus",
        "sourceOwnership",
        "targetOwnership",
        "ownership",
    ];
    if claims.iter().all(|name| field(edge, name).is_none()) {
        // Native top-level ownership and actual private rows remain mandatory in the caller.
        return true;
    }
    if field(edge, "ownershipStatus") != Some(&text("bound")) {
        return false;
    }
    let Some(nested) = field(edge, "ownership") else {
        return false;
    };
    if validate_object(nested).is_err() {
        return false;
    }
    [
        field(edge, "sourceOwnership"),
        field(edge, "targetOwnership"),
        field(nested, "source"),
        field(nested, "target"),
    ]
    .into_iter()
    .all(|value| value.is_some_and(|value| tuple(value, ctx)))
}
fn tuple(value: &Json, ctx: &RequestContext) -> bool {
    validate_object(value).is_ok()
        && matches!(field(value, "schemaVersion"), Some(Json::Number(n)) if n.parse::<f64>().ok() == Some(1.))
        && field(value, "scope") == Some(&text("agent-private"))
        && field(value, "agentId") == Some(&text(ctx.agent_id.as_str()))
        && field(value, "ownerUserId") == Some(&text(&ctx.owner_user_id))
        && field(value, "workspaceIdentity") == Some(&text(&ctx.workspace_key))
}
