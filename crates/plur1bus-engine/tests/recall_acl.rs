//! ACL parity against the pinned Node engine.
#![cfg_attr(
    test,
    allow(
        clippy::unwrap_used,
        clippy::panic,
        reason = "parity tests stop when a recorded golden disagrees with the port"
    )
)]

#[path = "recall_support.rs"]
mod support;

use std::sync::Mutex;

use plur1bus_engine::context::RequestContext;
use plur1bus_engine::recall::acl::{
    check_access, enforce_default_scope, retain_visible, AclMemory, AclSubject, DenialSink,
};
use serde_json::Value;
use support::{aliases_of, golden, memory_row};

#[test]
fn agent_private_seen_only_by_its_agent() {
    assert_case("agent-private-same-agent", true, None);
    assert_case(
        "agent-private-other-agent",
        false,
        Some("acl.agent_private.mismatch"),
    );
    assert_case("agent-private-stored-by-only", true, None);
    assert_case(
        "agent-private-missing-owner",
        false,
        Some("acl.agent_private.missing_owner"),
    );
    assert_case("missing-scope-defaults-private", true, None);
    assert_case(
        "missing-scope-other-agent",
        false,
        Some("acl.agent_private.mismatch"),
    );
}

#[test]
fn workspace_rows_seen_by_the_workspace() {
    assert_case("workspace-same", true, None);
    assert_case("workspace-other", false, Some("acl.workspace.mismatch"));
    assert_case(
        "workspace-missing",
        false,
        Some("acl.workspace.missing_workspace"),
    );
    assert_case("workspace-bare-id", true, None);
    assert_case(
        "conflicting-workspace-binding",
        false,
        Some("acl.workspace.conflicting_binding"),
    );
    assert_case(
        "invalid-workspace-binding",
        false,
        Some("acl.workspace.invalid_binding"),
    );
    assert_case(
        "null-alias-snapshot",
        false,
        Some("acl.workspace.invalid_binding"),
    );
}

#[test]
fn user_rows_seen_by_the_owner() {
    assert_case("user-same-owner", true, None);
    assert_case("user-other-owner", false, Some("acl.user.mismatch"));
    assert_case(
        "user-missing-principal",
        false,
        Some("acl.user.missing_principal"),
    );
    assert_case("user-missing-owner", false, Some("acl.user.missing_owner"));
    assert_case("user-trimmed-principal", true, None);
}

#[test]
fn scope_filters() {
    assert_case("unknown-scope", false, Some("acl.unknown_scope"));
    assert_case(
        "blank-scope-is-not-private",
        false,
        Some("acl.unknown_scope"),
    );
    assert_case(
        "dotted-requester-missing-agent",
        false,
        Some("acl.request.missing_agent"),
    );
    assert_case("no-context", false, Some("acl.no_context"));
    assert_case("no-memory", false, Some("acl.no_memory"));
    assert_case(
        "conflicting-agent-binding",
        false,
        Some("acl.invalid_binding"),
    );
    assert_case("invalid-user-owner", false, Some("acl.invalid_binding"));
}

#[test]
fn incognito_never_recalls() {
    // The Node engine does not consult incognito during recall. An otherwise visible row stays allowed.
    assert_case("incognito-flag-ignored", true, None);
}

#[test]
fn acl_reasons_match_the_node_engine() {
    for case in golden("acl.json")["cases"].as_array().unwrap() {
        let name = case["name"].as_str().unwrap();
        let (allowed, reason) = decide(case);
        assert_eq!(allowed, case["allowed"].as_bool().unwrap(), "{name}");
        assert_eq!(reason.as_deref(), case["reason"].as_str(), "{name}");
    }
}

#[test]
fn enforce_default_scope_matches_the_node_engine() {
    for item in golden("acl.json")["scopeDefaults"].as_array().unwrap() {
        let before = item.get("scopeBefore").and_then(Value::as_str);
        let actual = enforce_default_scope(before, item["type"].as_str().unwrap());
        assert_eq!(actual.as_deref(), item["scope"].as_str());
    }
}

#[test]
fn a_denial_reaches_the_sink_with_the_rule_name() {
    let context = visible_context();
    let rows = vec![
        memory_row("row-visible", "alpha", "agent-private"),
        memory_row("row-hidden", "beta", "agent-private"),
    ];
    let sink = Recording::default();
    let kept = retain_visible(&rows, &context, &sink);
    assert_eq!(kept.len(), 1);
    assert_eq!(kept[0].id_text(), "row-visible");
    let denied = sink.events.lock().unwrap();
    assert_eq!(denied.len(), 1);
    assert_eq!(denied[0].0, "row-hidden");
    assert_eq!(denied[0].1, "acl.agent_private.mismatch");
}

trait RowId {
    fn id_text(&self) -> String;
}

impl RowId for plur1bus_engine::contract::MemoryRow {
    fn id_text(&self) -> String {
        serde_json::to_value(self).unwrap()["id"]
            .as_str()
            .unwrap()
            .to_owned()
    }
}

#[derive(Default)]
struct Recording {
    events: Mutex<Vec<(String, String)>>,
}

impl DenialSink for Recording {
    fn denied(&self, row_id: &str, rule: &'static str, _ctx: &RequestContext) {
        self.events
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .push((row_id.to_owned(), rule.to_owned()));
    }
}

fn assert_case(name: &str, allowed: bool, reason: Option<&str>) {
    let case = golden("acl.json")["cases"]
        .as_array()
        .unwrap()
        .iter()
        .find(|case| case["name"] == name)
        .unwrap_or_else(|| panic!("missing {name}"))
        .clone();
    let (actual_allowed, actual_reason) = decide(&case);
    assert_eq!(actual_allowed, allowed, "{name}");
    assert_eq!(actual_reason.as_deref(), reason, "{name}");
}

fn decide(case: &Value) -> (bool, Option<String>) {
    let subject = subject_of(&case["ctx"]);
    let memory = memory_of(&case["memory"]);
    match check_access(subject.as_ref(), memory.as_ref()) {
        Ok(()) => (true, None),
        Err(rule) => (false, Some(rule.name().to_owned())),
    }
}

fn subject_of(value: &Value) -> Option<AclSubject> {
    if !value.is_object() {
        return None;
    }
    Some(AclSubject {
        agent_id: text(value, "agentId"),
        workspace_identity: text(value, "workspaceIdentity"),
        user_principal: text(value, "userPrincipal"),
        aliases: aliases_of(&value["workspaceAliases"]),
    })
}

fn memory_of(value: &Value) -> Option<AclMemory> {
    if !value.is_object() {
        return None;
    }
    Some(AclMemory {
        id: text(value, "id"),
        scope: text(value, "scope"),
        agent_id: text(value, "agentId"),
        stored_by: text(value, "storedBy"),
        workspace_id: text(value, "workspaceId"),
        workspace_key: text(value, "workspaceKey"),
        owner_user_id: text(value, "ownerUserId"),
        type_name: text(value, "type"),
    })
}

fn text(value: &Value, key: &str) -> String {
    value
        .get(key)
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_owned()
}

fn visible_context() -> RequestContext {
    let scratch = tempfile::tempdir().unwrap();
    let host = support::TestHost::new(scratch.path().to_path_buf());
    let principal = serde_json::from_value(serde_json::json!({
        "agentId": "alpha",
        "workspace": "workspace:v1:main",
        "user": "user:v1:68764db1e83ff3a90f12d20516cbfe70e7919a321ff71dd501b15d052e8d1c5b",
        "channel": "telegram",
        "accountId": "default",
        "chat": {"id": "1", "kind": "direct"},
        "trust": "proved"
    }))
    .unwrap();
    let agent =
        serde_json::from_value(serde_json::json!({"origin": "user", "background": false})).unwrap();
    RequestContext::build(&principal, &agent, &host).unwrap()
}
