//! Authorized bulk demotion policy; CA5 supplies Neo IO and context classification.

use super::render_value::{number, text, truthy};
use crate::text::js::JsString;
use serde::Serialize;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};

/// Complete-scan limit from the pin; hitting it cannot be treated as a full preview.
pub const SCAN_LIMIT: usize = 10_000;

/// Existing Neo implementation, without granting T5 a production Neo store.
pub trait BehaviorConflictStore {
    /// None means the scan is unavailable or incomplete.
    fn read_cards(&self, limit: usize) -> Option<Vec<Value>>;
    /// The CA5-owned `isInjectedContextText` policy, not a T5 reimplementation.
    fn is_injected_text(&self, text: &str) -> bool;
    /// Append transitions; None matches a non-array receipt, Some is the written count.
    fn append_cards(&mut self, cards: &[Value]) -> Option<usize>;
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Scope {
    agent_id: String,
    workspace_key: String,
    owner_id: String,
}

fn first(value: &Value, keys: &[&str]) -> String {
    keys.iter()
        .find_map(|key| value.get(key).filter(|v| truthy(v)))
        .map_or_else(String::new, text)
}

fn scope(requester: &Value) -> Scope {
    Scope {
        agent_id: first(requester, &["requesterAgentId", "agentId"]),
        workspace_key: first(requester, &["requesterWorkspaceKey", "workspaceIdentity"]),
        owner_id: first(requester, &["requesterOwnerId", "ownerUserId"]),
    }
}

fn in_scope(card: &Value, scope: &Scope) -> bool {
    let agent = text(&card["agentId"]);
    let workspace = text(&card["workspaceKey"]);
    let mut owner = first(card, &["ownerId", "ownerUserId"]);
    if owner.is_empty() {
        owner = text(&card["visibility"]["ownerUserId"]);
    }
    if agent.is_empty() && workspace.is_empty() && owner.is_empty() {
        return false;
    }
    ![
        (&agent, &scope.agent_id),
        (&workspace, &scope.workspace_key),
        (&owner, &scope.owner_id),
    ]
    .iter()
    .any(|(stored, request)| !stored.is_empty() && !request.is_empty() && stored != request)
}

fn statement(card: &Value) -> String {
    first(card, &["statement", "content", "text", "summary"])
}

fn failure(reason: &str) -> Value {
    json!({"ok":false,"reason":reason})
}

/// Preview only injected conflicts in the requester's explicit scope.
#[must_use]
pub fn preview(store: &dyn BehaviorConflictStore, requester: &Value) -> Value {
    let scope = scope(requester);
    if scope.agent_id.is_empty() && scope.workspace_key.is_empty() && scope.owner_id.is_empty() {
        return failure("unauthorized");
    }
    let Some(cards) = store
        .read_cards(SCAN_LIMIT)
        .filter(|cards| cards.len() < SCAN_LIMIT)
    else {
        return failure("incomplete_scan");
    };
    let hits = cards
        .iter()
        .filter(|card| {
            card["status"] == "conflict"
                && store.is_injected_text(&statement(card))
                && in_scope(card, &scope)
        })
        .collect::<Vec<_>>();
    let mut ids = hits
        .iter()
        .map(|card| text(&card["id"]))
        .collect::<Vec<_>>();
    ids.sort_by(|a, b| a.encode_utf16().cmp(b.encode_utf16()));
    #[derive(Serialize)]
    struct Fingerprint<'a> {
        scope: &'a Scope,
        count: usize,
        ids: &'a [String],
    }
    let payload = serde_json::to_vec(&Fingerprint {
        scope: &scope,
        count: ids.len(),
        ids: &ids,
    })
    .unwrap_or_default();
    let hash = format!("{:x}", Sha256::digest(payload));
    let examples = hits
        .iter()
        .take(5)
        .map(|card| {
            json!({"id":card["id"],
        "statement":JsString::from(statement(card)).utf16_slice(0,160).to_utf8_lossy()})
        })
        .collect::<Vec<_>>();
    json!({"ok":true,"count":ids.len(),"ids":ids,"hash":hash,"examples":examples})
}

/// Recheck count/hash and every selected card before appending any transition.
#[must_use]
pub fn apply(
    store: &mut dyn BehaviorConflictStore,
    requester: &Value,
    authorized: bool,
    expected_hash: &str,
    expected_count: usize,
    now_ms: f64,
) -> Value {
    if !authorized {
        return failure("unauthorized");
    }
    let preview = preview(store, requester);
    if preview["ok"] != true {
        return preview;
    }
    if preview["hash"] != expected_hash || preview["count"].as_u64() != Some(expected_count as u64)
    {
        return failure("drift");
    }
    if expected_count == 0 {
        return json!({"ok":true,"dropped":0});
    }
    let Some(cards) = store.read_cards(SCAN_LIMIT) else {
        return failure("incomplete_scan");
    };
    let mut updates = Vec::new();
    for id in preview["ids"].as_array().into_iter().flatten() {
        let Some(card) = cards.iter().rfind(|card| card["id"] == *id) else {
            return failure("drift");
        };
        if card["status"] != "conflict" || !store.is_injected_text(&statement(card)) {
            return failure("drift");
        }
        let Some(update) = demote(card, now_ms) else {
            return failure("unavailable");
        };
        updates.push(update);
    }
    if store
        .append_cards(&updates)
        .is_some_and(|count| count != updates.len())
    {
        return failure("incomplete_write");
    }
    json!({"ok":true,"dropped":expected_count})
}

fn demote(card: &Value, now_ms: f64) -> Option<Value> {
    let mut update = card.clone();
    update["status"] = json!("demoted");
    let Ok(timestamp) = super::render_date::iso_timestamp(now_ms) else {
        return None;
    };
    update["updatedAt"] = json!(timestamp);
    let salience = card
        .get("salience")
        .filter(|v| !v.is_null())
        .map_or(0.5, number);
    update["salience"] = json!((salience - 0.25).clamp(0.0, 1.0));
    update["embeddingStatus"] = json!("stale");
    Some(update)
}
