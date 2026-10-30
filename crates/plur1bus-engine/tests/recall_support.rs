//! Shared host stub and golden helpers for the RE-04 recall tests.
#![allow(
    dead_code,
    clippy::unwrap_used,
    clippy::panic,
    reason = "parity helpers stop when a recorded golden or the Node realpath oracle is unusable"
)]

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::Mutex;

use plur1bus_engine::context::{
    TurnSignal, WorkspaceAliasBinding, WorkspaceAliases, WorkspacePathBinding,
};
use plur1bus_engine::contract::Cancel;
use plur1bus_engine::contract::{
    AgentId, Decision, EgressGate, EngineConfig, HostError, HostServices, JournalBacklog,
    LlmParams, LlmPort, LlmResult, MemoryRow, PlatformCapabilities, SecretPort, SecretValue,
    Target,
};
use serde_json::{json, Value};

pub struct TestHost {
    state_dir: PathBuf,
    config: EngineConfig,
    workspaces: Mutex<BTreeMap<String, PathBuf>>,
    platform: PlatformCapabilities,
}

impl TestHost {
    pub fn new(state_dir: PathBuf) -> Self {
        Self {
            state_dir,
            config: serde_json::from_value(json!({})).unwrap(),
            workspaces: Mutex::new(BTreeMap::new()),
            platform: PlatformCapabilities::default(),
        }
    }

    pub fn set_workspace(&self, agent: &str, path: PathBuf) {
        self.workspaces
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .insert(agent.to_owned(), path);
    }
}

impl HostServices for TestHost {
    fn state_dir(&self) -> &Path {
        &self.state_dir
    }

    fn config(&self) -> EngineConfig {
        self.config.clone()
    }

    fn workspace_dir(&self, agent: &AgentId) -> Result<Option<PathBuf>, HostError> {
        Ok(self
            .workspaces
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .get(agent.as_str())
            .cloned())
    }

    fn llm(&self) -> Option<&dyn LlmPort> {
        None
    }

    fn secrets(&self) -> Option<&dyn SecretPort> {
        None
    }

    fn egress(&self) -> &dyn EgressGate {
        self
    }

    fn emit(&self, _event: &str, _payload: Value) {}

    fn now_ms(&self) -> i64 {
        0
    }

    fn platform(&self) -> &PlatformCapabilities {
        &self.platform
    }

    fn journal_backlog(&self) -> Option<JournalBacklog> {
        None
    }
}

impl LlmPort for TestHost {
    fn complete(&self, _params: LlmParams, cancel: &Cancel) -> Result<LlmResult, HostError> {
        cancel.check()?;
        Err(HostError::Unavailable)
    }
}

impl SecretPort for TestHost {
    fn get(&self, _name: &str) -> Result<Option<SecretValue>, HostError> {
        Ok(None)
    }
}

impl EgressGate for TestHost {
    fn decide(&self, _target: &Target) -> Decision {
        Decision::Deny {
            reason: "test host denies outbound requests".to_owned(),
        }
    }
}

pub fn golden(name: &str) -> Value {
    let text = match name {
        "principals.json" => include_str!("fixtures/recall/golden/principals.json"),
        "workspaces.json" => include_str!("fixtures/recall/golden/workspaces.json"),
        "acl.json" => include_str!("fixtures/recall/golden/acl.json"),
        "auto-recall.json" => include_str!("fixtures/recall/golden/auto-recall.json"),
        other => panic!("unknown golden {other}"),
    };
    serde_json::from_str(text).unwrap()
}

pub fn node_realpath(path: &Path) -> String {
    let output = Command::new("node")
        .args([
            "--input-type=module",
            "-e",
            "import {realpathSync} from 'node:fs'; process.stdout.write(realpathSync(process.argv[1]));",
        ])
        .arg(path)
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "node realpath failed: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    String::from_utf8(output.stdout).unwrap()
}

pub fn memory_row(id: &str, agent: &str, scope: &str) -> MemoryRow {
    let schema: Value =
        serde_json::from_str(include_str!("../schema/engine-contract.schema.json")).unwrap();
    let mut fields = serde_json::Map::new();
    for (name, definition) in schema["$defs"]["MemoryRow"]["properties"]
        .as_object()
        .unwrap()
    {
        let value = match definition["type"].as_str().unwrap() {
            "string" => json!(""),
            "number" => json!(0),
            "boolean" => json!(false),
            "array" => json!([]),
            _ => json!(null),
        };
        fields.insert(name.clone(), value);
    }
    fields.insert("id".into(), json!(id));
    fields.insert("agentId".into(), json!(agent));
    fields.insert("scope".into(), json!(scope));
    fields.insert("text".into(), json!("note"));
    serde_json::from_value(Value::Object(fields)).unwrap()
}

pub fn prompt_text(value: &Value) -> String {
    if let Some(text) = value.as_str() {
        return text.to_owned();
    }
    let Some(parts) = value.get("parts").and_then(Value::as_array) else {
        return String::new();
    };
    let joiner = value
        .get("joiner")
        .and_then(Value::as_array)
        .map(|items| items.iter().filter_map(Value::as_str).collect::<String>())
        .unwrap_or_default();
    parts
        .iter()
        .filter_map(Value::as_str)
        .collect::<Vec<_>>()
        .join(&joiner)
}

pub fn turn_signal(value: &Value) -> TurnSignal {
    TurnSignal {
        prompt: prompt_text(&value["prompt"]),
        origin: text_field(value, "origin"),
        source: text_field(value, "source"),
        kind: text_field(value, "kind"),
        type_name: text_field(value, "type"),
        trigger: text_field(value, "trigger"),
        session_key: text_field(value, "sessionKey"),
        session_id: text_field(value, "sessionId"),
        run_id: text_field(value, "runId"),
    }
}

fn text_field(value: &Value, key: &str) -> String {
    value
        .get(key)
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_owned()
}

pub fn aliases_of(value: &Value) -> Option<WorkspaceAliases> {
    if !value.is_object() {
        return None;
    }
    let paths = value["paths"]
        .as_array()
        .into_iter()
        .flatten()
        .map(|entry| WorkspacePathBinding {
            path: entry["path"].as_str().unwrap_or("").to_owned(),
            workspace_key: entry["workspaceKey"].as_str().unwrap_or("").to_owned(),
        })
        .collect();
    let aliases = value["aliases"]
        .as_array()
        .into_iter()
        .flatten()
        .map(|entry| WorkspaceAliasBinding {
            alias: entry["alias"].as_str().unwrap_or("").to_owned(),
            workspace_key: entry["workspaceKey"].as_str().unwrap_or("").to_owned(),
        })
        .collect();
    Some(WorkspaceAliases { paths, aliases })
}

pub fn user_principal_pattern(value: &str) -> bool {
    let Some(hex) = value
        .strip_prefix("user:v1:")
        .or_else(|| value.strip_prefix("user:v2:"))
    else {
        return false;
    };
    hex.len() == 64
        && hex
            .bytes()
            .all(|byte| matches!(byte, b'0'..=b'9' | b'a'..=b'f'))
}
