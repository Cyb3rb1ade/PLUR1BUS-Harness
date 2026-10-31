//! Request-context parity against the pinned Node engine.
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

use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};

use plur1bus_engine::context::{
    harness_user_principal, principal_key, should_skip_auto_recall_for_internal_turn,
    user_pool_key, workspace_pool_key, RequestContext, RouteVocabulary,
};
use plur1bus_engine::contract::{AgentContext, EngineError, Principal};
use serde_json::Value;
use support::{golden, node_realpath, turn_signal, user_principal_pattern, TestHost};

#[test]
fn principal_key_equals_the_core_and_the_node_engine() {
    let recorded = golden("principals.json");
    for triple in recorded["triples"].as_array().unwrap() {
        let channel = triple["channel"].as_str().unwrap();
        let account = triple["accountId"].as_str().unwrap();
        let user = triple["userId"].as_str().unwrap();
        let key = principal_key(channel, account, user);
        assert_eq!(
            key,
            triple["userPrincipal"].as_str().unwrap(),
            "{channel}/{account}/{user}"
        );
        assert_eq!(key, format!("user:v1:{}", triple["hash"].as_str().unwrap()));
    }
    let sample = principal_key("cli", "mac.local", "ada");
    assert_eq!(workspace_pool_key("workspace:v1:main").len(), 64);
    assert!(workspace_pool_key("workspace:v1:main").starts_with("w-"));
    assert_eq!(user_pool_key(&sample).len(), 64);
    assert!(user_pool_key(&sample).starts_with("u-"));
    assert!(harness_user_principal("ada").starts_with("user:v2:"));
    assert_eq!(harness_user_principal("ada").len(), "user:v2:".len() + 64);
}

#[test]
fn build_resolves_workspace_ids_the_way_the_node_engine_does() {
    let recorded = golden("workspaces.json");
    let scratch = tempfile::tempdir().unwrap();
    let mut raw_dirs = BTreeMap::new();
    let mut real_dirs = BTreeMap::new();
    for agent in ["alpha", "beta", "gamma"] {
        let directory = scratch.path().join(agent);
        fs::create_dir(&directory).unwrap();
        real_dirs.insert(agent, node_realpath(&directory));
        raw_dirs.insert(agent, directory);
    }
    assert_eq!(
        recorded["reservedRegisterError"].as_str().unwrap(),
        register_reserved().as_str()
    );
    for case in recorded["cases"].as_array().unwrap() {
        let name = case["name"].as_str().unwrap();
        let directory = host_dir(&case["input"], &raw_dirs, scratch.path());
        let input = substitute_dirs(&case["input"], &real_dirs);
        let built = build_case(name, &input, directory, scratch.path());
        if case["ok"].as_bool().unwrap() {
            let context = built.unwrap_or_else(|error| panic!("{name}: {error}"));
            assert_context(
                name,
                &context,
                &substitute_dirs(&case["context"], &real_dirs),
            );
        } else {
            assert_build_error(name, built, case["error"].as_str().unwrap());
        }
    }
}

#[test]
fn canonicalize_matches_node_realpath() {
    let scratch = tempfile::tempdir().unwrap();
    let directory = scratch.path().join("Agent Folder");
    fs::create_dir(&directory).unwrap();
    let expected = node_realpath(&directory);
    let host = TestHost::new(scratch.path().to_path_buf());
    host.set_workspace("alpha", directory);
    let vocabulary = RouteVocabulary::seeded();
    let principal = principal_of(&serde_json::json!({
        "agentId": "alpha",
        "workspace": format!("workspace-dir:v1:{expected}"),
        "channel": "telegram",
        "accountId": "default",
        "chat": {"id": "1", "kind": "direct"},
        "trust": "proved"
    }));
    let context = RequestContext::build_with(&principal, &agent_of(), &host, &vocabulary).unwrap();
    assert_eq!(context.workspace_id, format!("workspace-dir:v1:{expected}"));
    assert_eq!(context.workspace_key, context.workspace_id);
}

#[test]
fn auto_recall_skip_matches_the_node_engine() {
    let recorded = golden("auto-recall.json");
    for case in recorded["cases"].as_array().unwrap() {
        let name = case["name"].as_str().unwrap();
        let skip = should_skip_auto_recall_for_internal_turn(
            &turn_signal(&case["event"]),
            &turn_signal(&case["ctx"]),
        );
        assert_eq!(skip, case["skip"].as_bool().unwrap(), "{name}");
    }
}

fn register_reserved() -> String {
    match RouteVocabulary::seeded().register("main") {
        Ok(name) => name,
        Err(EngineError::Invalid { message, .. }) => message,
        Err(error) => panic!("{error}"),
    }
}

fn build_case(
    name: &str,
    input: &Value,
    directory: Option<PathBuf>,
    scratch: &Path,
) -> Result<RequestContext, EngineError> {
    let principal = principal_of(input);
    let host = TestHost::new(scratch.to_path_buf());
    if let Some(directory) = directory {
        host.set_workspace(input["agentId"].as_str().unwrap(), directory);
    }
    if input["channel"].as_str() == Some("cli") {
        let vocabulary = RouteVocabulary::seeded();
        if name == "proved-registered-cli" {
            vocabulary.register("cli").unwrap();
        }
        return RequestContext::build_with(&principal, &agent_of(), &host, &vocabulary);
    }
    RequestContext::build(&principal, &agent_of(), &host)
}

fn host_dir(input: &Value, raw_dirs: &BTreeMap<&str, PathBuf>, scratch: &Path) -> Option<PathBuf> {
    let directory = input["facts"]
        .get("workspaceDir")
        .and_then(Value::as_str)
        .unwrap_or("");
    if directory.is_empty() {
        return None;
    }
    if let Some(agent) = directory
        .strip_prefix("__DIR_")
        .and_then(|rest| rest.strip_suffix("__"))
    {
        return raw_dirs.get(agent).cloned();
    }
    if directory.contains("missing-alpha") {
        return Some(scratch.join("missing-alpha"));
    }
    None
}

fn assert_context(name: &str, context: &RequestContext, expected: &Value) {
    assert_eq!(
        context.agent_id.as_str(),
        expected["agentId"].as_str().unwrap(),
        "{name}"
    );
    assert_eq!(
        context.workspace_id,
        expected["workspaceId"].as_str().unwrap(),
        "{name}"
    );
    assert_eq!(
        context.workspace_key,
        expected["workspaceIdentity"].as_str().unwrap(),
        "{name}"
    );
    assert_eq!(
        context.owner_user_id,
        expected["userPrincipal"].as_str().unwrap(),
        "{name}"
    );
    assert_eq!(context.principal_key, context.owner_user_id, "{name}");
    assert_eq!(
        context.channel(),
        expected["channel"].as_str().unwrap(),
        "{name}"
    );
    assert_eq!(
        context.account_id(),
        expected["accountId"].as_str().unwrap(),
        "{name}"
    );
    assert_eq!(
        context.chat_id(),
        expected["chatId"].as_str().unwrap(),
        "{name}"
    );
    assert_eq!(
        context.chat_kind(),
        expected["chatKind"].as_str().unwrap(),
        "{name}"
    );
    assert_eq!(
        context.trust(),
        expected["trust"].as_str().unwrap(),
        "{name}"
    );
    assert!(!context.background());
    assert_eq!(context.origin_wire(), "user");
    let workspace = expected["workspaceIdentity"].as_str().unwrap();
    let user = expected["userPrincipal"].as_str().unwrap();
    let mut scopes = vec!["agent-private".to_owned()];
    if !workspace.is_empty() {
        scopes.push("workspace".to_owned());
    }
    if user_principal_pattern(user) {
        scopes.push("user".to_owned());
    }
    let actual: Vec<String> = context
        .visible_scopes
        .iter()
        .map(|scope| {
            serde_json::to_value(scope)
                .unwrap()
                .as_str()
                .unwrap()
                .to_owned()
        })
        .collect();
    assert_eq!(actual, scopes, "{name}");
    if context.trust() == "proved" && user_principal_pattern(user) {
        assert!(actual.iter().any(|scope| scope == "user"), "{name}");
    }
    if context.trust() == "inferred" {
        assert!(!actual.iter().any(|scope| scope == "user"), "{name}");
    }
    if !workspace.is_empty() {
        assert!(actual.iter().any(|scope| scope == "workspace"), "{name}");
    }
}

fn assert_build_error(name: &str, built: Result<RequestContext, EngineError>, expected: &str) {
    match built {
        Err(EngineError::Invalid { field, message }) if name == "proved-missing-dir" => {
            assert_eq!(field, "workspaceDir", "{name}: {message}");
        }
        Err(EngineError::Invalid { field, message }) => {
            assert_eq!(message, expected, "{name}");
            if message == "conflicting workspace identity" {
                assert_eq!(field, "workspace");
            }
            if message.starts_with("Invalid agent ID:") {
                assert_eq!(field, "agentId");
            }
        }
        Ok(_) => panic!("{name} was accepted"),
        Err(error) => panic!("{name}: {error}"),
    }
}

fn substitute_dirs(value: &Value, real_dirs: &BTreeMap<&str, String>) -> Value {
    match value {
        Value::String(text) => {
            let mut text = text.clone();
            for (agent, real) in real_dirs {
                text = text.replace(&format!("__DIR_{agent}__"), real);
            }
            Value::String(text)
        }
        Value::Array(items) => Value::Array(
            items
                .iter()
                .map(|item| substitute_dirs(item, real_dirs))
                .collect(),
        ),
        Value::Object(map) => {
            let mut copy = serde_json::Map::new();
            for (key, item) in map {
                copy.insert(key.clone(), substitute_dirs(item, real_dirs));
            }
            Value::Object(copy)
        }
        other => other.clone(),
    }
}

fn principal_of(input: &Value) -> Principal {
    let mut object = input.as_object().unwrap().clone();
    object.remove("facts");
    object.remove("registerCli");
    object.remove("name_uses_cli");
    serde_json::from_value(Value::Object(object)).unwrap()
}

fn agent_of() -> AgentContext {
    serde_json::from_value(serde_json::json!({"origin": "user", "background": false})).unwrap()
}
