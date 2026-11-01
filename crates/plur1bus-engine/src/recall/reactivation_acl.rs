//! Reuse T1 ACL for every reactivation row and both bound graph endpoints.

use super::acl::{self, AclMemory, AclSubject};
use super::render_value::text;
use crate::context::{canonical_stored_workspace, safe_agent_id, WorkspaceAliases};
use serde_json::{json, Value};

fn live(memory: &Value, now: f64) -> bool {
    let status = memory
        .get("status")
        .filter(|v| !v.is_null())
        .unwrap_or(&memory["plur1bus_status"]);
    if !status.is_null() && status != "active" {
        return false;
    }
    if super::score::normalize_epistemic_status(memory["epistemicStatus"].as_str().unwrap_or(""))
        == "invalidated"
    {
        return false;
    }
    let expiry = &memory["expiresAt"];
    expiry.is_null()
        || expiry
            .as_f64()
            .is_some_and(|n| n == 0.0 || (n.is_finite() && n > now))
}

fn acl_memory(memory: &Value) -> Option<AclMemory> {
    super::render_access::memory(memory)
}

fn tuple(memory: &Value, subject: &AclSubject) -> Option<Value> {
    let row = acl_memory(memory)?;
    acl::check_access(Some(subject), Some(&row)).ok()?;
    let agent = if row.agent_id.trim().is_empty() {
        &row.stored_by
    } else {
        &row.agent_id
    };
    let agent = if agent.trim().is_empty() {
        String::new()
    } else {
        safe_agent_id(agent.trim()).ok()?
    };
    let scope = if row.scope.is_empty() {
        "agent-private"
    } else {
        row.scope.as_str()
    };
    let aliases = subject.aliases.as_ref()?;
    let workspace = if row.workspace_id.trim().is_empty() {
        &row.workspace_key
    } else {
        &row.workspace_id
    };
    let workspace = canonical_stored_workspace(workspace.trim(), aliases).ok()?;
    Some(json!({"schemaVersion":1,"scope":scope,"agentId":agent,
        "workspaceIdentity":workspace,"ownerUserId":row.owner_user_id.trim()}))
}

pub(super) fn authorized(
    memory: &Value,
    subject: Option<&AclSubject>,
    expected: Option<&Value>,
    now: f64,
) -> bool {
    if memory["id"].is_null() || text(&memory["id"]).trim().is_empty() || !live(memory, now) {
        return false;
    }
    if let Some(subject) = subject {
        if subject.agent_id.trim().is_empty() || subject.aliases.is_none() {
            return false;
        }
        let Some(actual) = tuple(memory, subject) else {
            return false;
        };
        expected.is_none_or(|expected| same_tuple(&actual, expected))
    } else {
        expected.is_none()
            && [
                "scope",
                "agentId",
                "storedBy",
                "workspaceId",
                "workspaceKey",
                "ownerUserId",
            ]
            .iter()
            .all(|key| memory[key].is_null() || memory[key] == "")
    }
}

fn same_tuple(a: &Value, b: &Value) -> bool {
    a["schemaVersion"].as_f64() == b["schemaVersion"].as_f64()
        && ["scope", "agentId", "workspaceIdentity", "ownerUserId"]
            .iter()
            .all(|key| a[key] == b[key])
}

fn endpoint(edge: &Value, key: &str, subject: &AclSubject) -> Option<Value> {
    let ownership = &edge[key];
    if ownership["schemaVersion"].as_f64() != Some(1.0) {
        return None;
    }
    let row = json!({"id":"endpoint","scope":ownership["scope"],"agentId":ownership["agentId"],
        "storedBy":ownership["agentId"],"workspaceId":ownership["workspaceIdentity"],
        "workspaceKey":ownership["workspaceIdentity"],"ownerUserId":ownership["ownerUserId"]});
    // Serialized tuples are canonical independently of local aliases.
    let canonical_subject = AclSubject {
        aliases: Some(WorkspaceAliases::default()),
        ..subject.clone()
    };
    let actual = tuple(&row, &canonical_subject)?;
    same_tuple(&actual, ownership).then_some(actual)
}

pub(super) fn safe_edges(edges: &[Value], subject: Option<&AclSubject>) -> Vec<Value> {
    let Some(subject) = subject else {
        return edges
            .iter()
            .filter(|edge| {
                edge["needsRebuild"] != true
                    && edge["sourceOwnership"].is_null()
                    && edge["targetOwnership"].is_null()
                    && edge["ownership"].is_null()
            })
            .cloned()
            .collect();
    };
    if subject.aliases.is_none() {
        return Vec::new();
    }
    edges
        .iter()
        .filter(|edge| {
            edge["ownershipStatus"] == "bound"
                && edge["needsRebuild"] != true
                && !text(&edge["source"]).trim().is_empty()
                && !text(&edge["target"]).trim().is_empty()
                && endpoint(edge, "sourceOwnership", subject).is_some()
                && endpoint(edge, "targetOwnership", subject).is_some()
        })
        .cloned()
        .collect()
}
