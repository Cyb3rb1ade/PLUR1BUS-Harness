//! Actual Node derived ACL observations with explicit D130 exceptions.
#![allow(clippy::unwrap_used, clippy::panic, reason = "fixture assertions")]
#[path = "recall_support.rs"]
mod support;
use plur1bus_engine::{
    context::RequestContext,
    contract::{AgentContext, Principal},
    neo::acl,
    text::json::parse_json,
};
use serde_json::{json, Value};
fn context(request: &Value, host: &support::TestHost) -> Option<RequestContext> {
    if request.as_object().unwrap().is_empty() {
        return None;
    }
    let p:Principal=serde_json::from_value(json!({"agentId":request["agentId"],"workspace":request["workspaceIdentity"],"user":request["ownerUserId"],"channel":"telegram","accountId":"fixture-account","chat":{"id":"fixture-chat","kind":"direct"},"trust":"proved"})).unwrap();
    let a: AgentContext =
        serde_json::from_value(json!({"origin":"user","background":false})).unwrap();
    let ctx = RequestContext::build(&p, &a, host).unwrap();
    assert_eq!(ctx.trust(), "proved");
    assert_eq!(ctx.workspace_key, request["workspaceIdentity"]);
    assert_eq!(ctx.owner_user_id, request["ownerUserId"]);
    Some(ctx)
}
#[test]
fn canonical_user_scope_and_explicit_requester_obey_d130() {
    let f: Value =
        serde_json::from_str(include_str!("fixtures/capture/golden/neo-acl.json")).unwrap();
    let exceptions: Value =
        serde_json::from_str(include_str!("fixtures/capture/neo-acl-exceptions.json")).unwrap();
    use sha2::{Digest, Sha256};
    assert_eq!(
        format!(
            "{:x}",
            Sha256::digest(include_bytes!("fixtures/capture/golden/neo-acl.json"))
        ),
        exceptions["nodeGoldenSha256"]
    );
    let root = support::canonical_tempdir();
    let host = support::TestHost::new(root.path().join("state"));
    for case in f["reads"].as_array().unwrap() {
        let ctx = context(&case["requester"], &host);
        let record = parse_json(&case["record"].to_string()).unwrap();
        let expected = exceptions["reads"]
            .as_array()
            .unwrap()
            .iter()
            .find(|v| v["name"] == case["name"] && v["index"] == case["index"])
            .map(|v| v["visible"].as_bool().unwrap())
            .unwrap_or(case["derived"].as_bool().unwrap());
        assert_eq!(
            acl::visible(&record, ctx.as_ref()),
            expected,
            "{} / {}",
            case["name"],
            case["index"]
        );
    }
}
#[test]
fn derived_visibility_is_the_narrowest_source_and_rejects_foreign_sources() {
    use plur1bus_engine::capture::row_defaults::schema_defaults;
    let f: Value =
        serde_json::from_str(include_str!("fixtures/capture/golden/neo-acl.json")).unwrap();
    let root = support::canonical_tempdir();
    let host = support::TestHost::new(root.path().join("state"));
    let ctx=context(&json!({"agentId":"alpha","workspaceIdentity":"workspace:v1:one","ownerUserId":f["ownerA"]}),&host).unwrap();
    let mut private = schema_defaults(vec![1.]);
    private.id = "source-private".into();
    private.agent_id = "alpha".into();
    private.stored_by = "alpha".into();
    let mut workspace = private.clone();
    workspace.scope = "workspace".into();
    workspace.workspace_id = ctx.workspace_key.clone();
    workspace.workspace_key = ctx.workspace_key.clone();
    let mut user = private.clone();
    user.scope = "user".into();
    user.owner_user_id = ctx.owner_user_id.clone();
    for (sources, expected) in [
        (vec![user.clone()], "global_user"),
        (vec![workspace.clone()], "workspace_shared"),
        (vec![private.clone()], "agent_private"),
        (vec![user.clone(), workspace.clone()], "agent_private"),
        (vec![private.clone(), user.clone()], "agent_private"),
        (
            vec![user.clone(), workspace.clone(), private.clone()],
            "agent_private",
        ),
    ] {
        let stamp = acl::derive(&sources, &ctx).unwrap();
        let record = parse_json(&json!({"visibility":stamp}).to_string()).unwrap();
        assert_eq!(serde_json::to_value(&stamp).unwrap()["scope"], expected);
        assert!(acl::visible(&record, Some(&ctx)));
    }
    assert!(acl::derive(&[], &ctx).is_err());
    user.owner_user_id = f["ownerB"].as_str().unwrap().into();
    assert!(acl::derive(&[private.clone(), user], &ctx).is_err());
    private.agent_id = "foreign".into();
    private.stored_by = "foreign".into();
    assert!(acl::derive(&[private], &ctx).is_err());
}

#[test]
fn ambiguous_or_ill_formed_authority_is_never_repaired_into_visibility() {
    let f: Value =
        serde_json::from_str(include_str!("fixtures/capture/golden/neo-acl.json")).unwrap();
    let root = support::canonical_tempdir();
    let host = support::TestHost::new(root.path().join("state"));
    let ctx=context(&json!({"agentId":"alpha","workspaceIdentity":"workspace:v1:one","ownerUserId":f["ownerA"]}),&host).unwrap();
    for raw in [
        r#"{"agentId":"alpha","agentId":"beta"}"#,
        r#"{"agentId":"alpha","visibility":[]}"#,
        r#"{"agentId":"alpha","visibility":{"scope":"agent_private","scope":"global_user"}}"#,
        r#"{"agentId":"alpha","visibility":{"scope":"agent_private","agentId":"alpha\ud800"}}"#,
        r#"{"agentId":"alpha","ownerUserId":42}"#,
        r#"{"agentId":"alpha","ownerUserId":"user:v1:invalid"}"#,
        r#"{"agentId":"alpha","scope":"user","visibility":{"scope":"agent_private"}}"#,
    ] {
        assert!(
            !acl::visible(&parse_json(raw).unwrap(), Some(&ctx)),
            "{raw}"
        );
    }
}
