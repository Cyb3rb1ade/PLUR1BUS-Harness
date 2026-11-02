//! Controller-authorized, narrow exception to the pinned Lens hydration behavior.
#![allow(
    clippy::unwrap_used,
    reason = "test fixtures and failed predicates stop verification"
)]

use plur1bus_engine::context::WorkspaceAliases;
use plur1bus_engine::recall::{
    acl::AclSubject,
    lens::{self, LensRequest},
    render::{RenderError, RenderHit},
};
use serde_json::{json, Value};
use std::collections::BTreeMap;

struct Rows(BTreeMap<String, Value>);
impl lens::LensHydrator for Rows {
    fn get(&self, id: &str) -> Result<Option<Value>, RenderError> {
        Ok(self.0.get(id).cloned())
    }
}

fn setup(enabled: Option<bool>) -> (LensRequest, Rows) {
    let user = format!("user:v2:{}", "a".repeat(64));
    let foreign = format!("user:v2:{}", "b".repeat(64));
    let base = RenderHit {
        entry: json!({"id":"base","text":"Dashboard architecture decisions"}),
        score: 0.9,
        source: "vector".into(),
        depth: None,
    };
    let config = enabled.map_or_else(
        || json!({}),
        |enabled| json!({"enabled":enabled,"maxLensMemories":1}),
    );
    let index = json!({"version":1,"memoryToCommunity":{"base":"c1"},"communities":{"c1":{
        "bridgeMemoryIds":["denied","allowed"],"representativeMemoryIds":["denied"],"fadedCandidateMemoryIds":["denied"]}}});
    let rows = Rows(BTreeMap::from([
        (
            "denied".into(),
            json!({"id":"denied","text":"Dashboard architecture denied evidence",
            "scope":"user","ownerUserId":foreign,"agentId":"fixture","storedBy":"fixture"}),
        ),
        (
            "allowed".into(),
            json!({"id":"allowed","text":"Dashboard architecture permitted evidence",
            "scope":"user","ownerUserId":user,"agentId":"fixture","storedBy":"fixture"}),
        ),
    ]));
    (
        LensRequest {
            base: vec![base],
            index,
            config,
            subject: AclSubject {
                agent_id: "fixture".into(),
                workspace_identity: String::new(),
                user_principal: user,
                aliases: Some(WorkspaceAliases::default()),
            },
        },
        rows,
    )
}

#[test]
fn default_enabled_and_disabled_never_return_a_foreign_user_row() {
    for enabled in [None, Some(true), Some(false)] {
        let (request, rows) = setup(enabled);
        let result = lens::select(&request, &rows).unwrap();
        assert!(
            result.iter().all(|hit| hit.entry["id"] != "denied"),
            "denied Lens row escaped"
        );
        assert_eq!(result.len(), usize::from(enabled != Some(false)));
        assert_eq!(request.base[0].entry["id"], "base");
    }
}

#[test]
fn denied_hydration_does_not_consume_the_role_or_total_cap() {
    let (mut request, rows) = setup(Some(true));
    request.config["maxBridgeMemories"] = json!(1);
    let result = lens::select(&request, &rows).unwrap();
    assert_eq!(result.len(), 1);
    assert_eq!(result[0].entry["id"], "allowed");
}

#[test]
fn truthy_nonstring_scope_and_conflicting_ownership_remain_denied() {
    for (scope, stored_by) in [
        (json!([]), "fixture"),
        (json!(["agent-private"]), "fixture"),
        (json!("user"), "other-agent"),
    ] {
        let (request, mut rows) = setup(Some(true));
        let row = rows.0.get_mut("denied").unwrap();
        row["scope"] = scope;
        row["storedBy"] = json!(stored_by);
        let result = lens::select(&request, &rows).unwrap();
        assert!(
            result.iter().all(|hit| hit.entry["id"] != "denied"),
            "invalid ownership escaped"
        );
    }
}
