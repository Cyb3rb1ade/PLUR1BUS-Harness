//! Strict raw-row adaptation into the existing canonical request ACL.

use super::acl::{self, AclMemory, AclSubject};
use super::render_value::{text, truthy};
use serde_json::Value;

pub(super) fn memory(value: &Value) -> Option<AclMemory> {
    if !value.is_object() {
        return None;
    }
    for key in [
        "agentId",
        "storedBy",
        "workspaceId",
        "workspaceKey",
        "ownerUserId",
    ] {
        if !value[key].is_null() && !value[key].is_string() {
            return None;
        }
    }
    let scope = if truthy(&value["scope"]) {
        value["scope"].as_str()?.to_owned()
    } else {
        String::new()
    };
    Some(AclMemory {
        id: text(&value["id"]),
        scope,
        agent_id: text(&value["agentId"]),
        stored_by: text(&value["storedBy"]),
        workspace_id: text(&value["workspaceId"]),
        workspace_key: text(&value["workspaceKey"]),
        owner_user_id: text(&value["ownerUserId"]),
        type_name: String::new(),
        dream_narrative: value["origin"] == "dream" && value["memoryClass"] == "dream",
    })
}

pub(super) fn allowed(value: &Value, subject: &AclSubject) -> bool {
    memory(value).is_some_and(|row| acl::check_access(Some(subject), Some(&row)).is_ok())
}
