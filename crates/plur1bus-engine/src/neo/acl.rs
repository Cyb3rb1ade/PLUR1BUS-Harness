//! D130: explicit requesters, consistent bindings and the intersection of source scopes.
use crate::{
    context::{canonical_stored_workspace, is_user_principal, safe_agent_id, RequestContext},
    contract::{MemoryRow, StoreError},
    recall::acl as memory_acl,
    text::{
        js::{js_trim, JsString},
        json::TolerantJsonValue as Json,
    },
};
use serde::Serialize;

/// Canonical derived visibility fields; `ownerUserId` is the same name on writes and reads.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Visibility {
    /// agent_private, workspace_shared or global_user.
    pub scope: String,
    /// Authenticated requesting/owning agent.
    pub agent_id: String,
    /// Canonical workspace snapshot; empty when absent.
    pub workspace_identity: String,
    /// Canonical user principal; required for global_user.
    pub owner_user_id: String,
}
fn invalid() -> StoreError {
    StoreError::InvalidInput
}
fn field<'a>(value: &'a Json, key: &str) -> Result<Option<&'a Json>, StoreError> {
    let Json::Object(fields) = value else {
        return Err(invalid());
    };
    let mut found = None;
    for (name, value) in fields {
        if name == &JsString::from(key) {
            if found.is_some() {
                return Err(invalid());
            }
            found = Some(value);
        }
    }
    Ok(found)
}
fn nested<'a>(value: &'a Json, key: &str) -> Result<Option<&'a Json>, StoreError> {
    match field(value, key)? {
        None | Some(Json::Null) => Ok(None),
        Some(v @ Json::Object(_)) => Ok(Some(v)),
        _ => Err(invalid()),
    }
}
fn text(value: Option<&Json>) -> Result<Option<String>, StoreError> {
    match value {
        None | Some(Json::Null) => Ok(None),
        Some(Json::String(raw)) => {
            let value = raw.to_utf8_lossy();
            if JsString::from(value.as_str()) != *raw {
                return Err(invalid());
            }
            let value = js_trim(&value);
            Ok((!value.is_empty()).then(|| value.to_owned()))
        }
        _ => Err(invalid()),
    }
}
fn normalize_scope(value: &str) -> Result<&'static str, StoreError> {
    match value {
        "agent_private" | "agent-private" => Ok("agent_private"),
        "workspace_shared" | "workspace" => Ok("workspace_shared"),
        "global_user" | "user" => Ok("global_user"),
        _ => Err(invalid()),
    }
}
fn collect(
    nodes: &[Option<&Json>],
    keys: &[&str],
    normalize: impl Fn(&str) -> Result<String, StoreError>,
) -> Result<Option<String>, StoreError> {
    let mut result = None;
    for node in nodes.iter().flatten() {
        for key in keys {
            if let Some(value) = text(field(node, key)?)? {
                let value = normalize(&value)?;
                if result.as_ref().is_some_and(|old| old != &value) {
                    return Err(invalid());
                }
                result = Some(value);
            }
        }
    }
    Ok(result)
}
pub(super) fn bindings(record: &Json, ctx: &RequestContext) -> Result<Visibility, StoreError> {
    let visibility = nested(record, "visibility")?;
    let origin = nested(record, "origin")?;
    let acl = nested(record, "aclBindings")?;
    let scopes = collect(&[Some(record), visibility, origin, acl], &["scope"], |v| {
        normalize_scope(v).map(str::to_owned)
    })?;
    let nodes = [Some(record), visibility, origin, acl];
    let agent = collect(&nodes, &["agentId"], |v| {
        safe_agent_id(v).map_err(|_| invalid())
    })?
    .unwrap_or_default();
    let workspace = collect(
        &nodes,
        &["workspaceIdentity", "workspaceKey", "workspaceId"],
        |v| canonical_stored_workspace(v, ctx.aliases()).map_err(|_| invalid()),
    )?
    .unwrap_or_default();
    let owner = collect(&nodes, &["ownerUserId"], |v| {
        if is_user_principal(v) {
            Ok(v.into())
        } else {
            Err(invalid())
        }
    })?
    .unwrap_or_default();
    let legacy = collect(&nodes, &["ownerId"], |v| Ok(v.into()))?;
    if legacy.is_some_and(|legacy| owner.is_empty() || legacy != owner) {
        return Err(invalid());
    }
    let scope = scopes.unwrap_or_else(|| "agent_private".into());
    Ok(Visibility {
        scope,
        agent_id: agent,
        workspace_identity: workspace,
        owner_user_id: owner,
    })
}
/// A requester-free call is always invisible. Old agent-owned records retain only
/// their unambiguous private ownership; legacy ownerId cannot grant global_user access.
#[must_use]
pub fn visible(record: &Json, ctx: Option<&RequestContext>) -> bool {
    let Some(ctx) = ctx else {
        return false;
    };
    let Ok(binding) = bindings(record, ctx) else {
        return false;
    };
    match binding.scope.as_str() {
        "agent_private" => {
            !binding.agent_id.is_empty()
                && binding.agent_id == ctx.agent_id.as_str()
                && (binding.owner_user_id.is_empty() || binding.owner_user_id == ctx.owner_user_id)
        }
        "workspace_shared" => {
            !binding.workspace_identity.is_empty()
                && binding.workspace_identity == ctx.workspace_key
        }
        "global_user" => {
            !binding.owner_user_id.is_empty() && binding.owner_user_id == ctx.owner_user_id
        }
        _ => false,
    }
}
/// Derive visibility from the actual source rows, never a requested wider scope.
/// The caller still owns the source leases and must revalidate under its mutation lock.
/// User and workspace scopes are incomparable: a mixed set becomes agent-private.
pub fn derive(sources: &[MemoryRow], ctx: &RequestContext) -> Result<Visibility, StoreError> {
    if sources.is_empty() {
        return Err(invalid());
    }
    let mut private = false;
    let mut workspace = false;
    let mut user = false;
    for row in sources {
        if memory_acl::allowed(row, ctx).is_err() {
            return Err(invalid());
        }
        match row.scope.as_str() {
            "" | "agent-private" => {
                if !row.owner_user_id.is_empty() && row.owner_user_id != ctx.owner_user_id {
                    return Err(invalid());
                }
                private = true;
            }
            "workspace" => workspace = true,
            "user" => user = true,
            _ => return Err(invalid()),
        }
    }
    let scope = if private || (workspace && user) {
        "agent_private"
    } else if workspace {
        "workspace_shared"
    } else {
        "global_user"
    };
    if (scope == "workspace_shared" && ctx.workspace_key.is_empty())
        || (scope == "global_user" && !is_user_principal(&ctx.owner_user_id))
    {
        return Err(invalid());
    }
    Ok(Visibility {
        scope: scope.into(),
        agent_id: ctx.agent_id.to_string(),
        workspace_identity: ctx.workspace_key.clone(),
        owner_user_id: ctx.owner_user_id.clone(),
    })
}
