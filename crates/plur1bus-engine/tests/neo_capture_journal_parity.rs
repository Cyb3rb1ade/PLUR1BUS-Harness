//! Actual C4 file output, with declared D130 stamps and temporary-path/ID normalization only.
#![allow(clippy::unwrap_used, clippy::panic, reason = "fixture assertions")]
#[path = "recall_support.rs"]
mod support;
use plur1bus_engine::{
    capture::shared_scope::CapturePolicy,
    context::{harness_user_principal, RequestContext},
    contract::{Cancel, EngineError, TurnRecord},
    neo::{capture_journal::CaptureJournal, merged::Layout},
};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{
    collections::HashMap,
    fs,
    sync::{atomic::Ordering, Arc},
};
struct Allow;
impl CapturePolicy for Allow {
    fn allowed(&self, _: &RequestContext) -> Result<bool, EngineError> {
        Ok(true)
    }
}
const FILES: [(&str, &str); 6] = [
    ("turns", "turn-journal.jsonl"),
    ("candidates", "memory-candidates.jsonl"),
    ("reactions", "reaction-ledger.jsonl"),
    ("behavior", "behavior-cards.jsonl"),
    ("embeddings", "embedding-queue.jsonl"),
    ("candidateIndex", "candidate-index.jsonl"),
];
fn replacements(rows: &Value, workspace: &str) -> HashMap<String, String> {
    let mut map = HashMap::from([(workspace.into(), "FIXTURE_WORKSPACE".into())]);
    for (kind, _) in FILES.iter().take(5) {
        for (i, row) in rows[kind].as_array().unwrap().iter().enumerate() {
            let id = row["id"].as_str().unwrap();
            assert!(map.insert(id.into(), format!("{kind}:{i}")).is_none());
        }
    }
    map
}
fn normalize(v: &mut Value, map: &HashMap<String, String>) {
    match v {
        Value::String(s) => {
            if let Some(replacement) = map.get(s) {
                *s = replacement.clone();
            }
        }
        Value::Array(a) => a.iter_mut().for_each(|v| normalize(v, map)),
        Value::Object(o) => {
            let old = std::mem::take(o);
            for (key, mut value) in old {
                normalize(&mut value, map);
                let key = map.get(&key).cloned().unwrap_or(key);
                assert!(o.insert(key, value).is_none());
            }
        }
        _ => {}
    }
}
#[test]
fn actual_five_turn_files_match_declared_node_projection_and_replay() {
    let fixture = include_str!("fixtures/capture/golden/neo-capture-journal.json");
    let exceptions: Value = serde_json::from_str(include_str!(
        "fixtures/capture/neo-capture-journal-exceptions.json"
    ))
    .unwrap();
    assert_eq!(
        format!("{:x}", Sha256::digest(fixture.as_bytes())),
        exceptions["nodeGoldenSha256"]
    );
    let golden: Value = serde_json::from_str(fixture).unwrap();
    let case = &golden["cases"][0];
    let root = support::canonical_tempdir();
    let host = Arc::new(support::TestHost::new(root.path().join("state")));
    host.set_workspace("alpha", root.path().into());
    let time = chrono::DateTime::parse_from_rfc3339(case["now"].as_str().unwrap())
        .unwrap()
        .timestamp_millis();
    host.time.store(time, Ordering::SeqCst);
    let owner = harness_user_principal("one");
    let turn: TurnRecord = serde_json::from_value(json!({
        "agentId":"alpha", "principal":{"agentId":"alpha", "workspace":format!("workspace-dir:v1:{}",root.path().display()),
            "user":owner,"channel":"telegram","accountId":"fixture","chat":{"id":"fixture","kind":"direct"},"trust":"proved"},
        "agent":{"origin":"user","background":false},"runId":case["event"]["runId"],
        "sessionKey":case["event"]["sessionKey"],"messages":case["event"]["messages"],"incognito":false
    })).unwrap();
    let ctx = RequestContext::build(&turn.principal, &turn.agent, host.as_ref()).unwrap();
    let journal = CaptureJournal::open(root.path(), host, Arc::new(Allow)).unwrap();
    let result = journal.record(&turn, &ctx, &Cancel::never()).unwrap();
    assert_eq!(
        json!({"turns":result.turns,"candidates":result.candidates,"reactions":result.reactions,"behaviorCards":result.behavior}),
        case["appended"]
    );
    let directory = root
        .path()
        .join("workspaces")
        .join(Layout::for_key(&ctx.workspace_key).canonical);
    let mut actual = json!({});
    for (key, file) in FILES {
        let rows: Vec<Value> = fs::read_to_string(directory.join(file))
            .unwrap()
            .lines()
            .map(|line| serde_json::from_str(line).unwrap())
            .collect();
        actual[key] = json!(rows);
    }
    let before = actual.clone();
    let mut expected = case["output"].clone();
    // RE-D62: owner-bound private capture. RE-D61 keeps those fields in the derived index.
    let workspace = case["workspace"].as_str().unwrap();
    for (key, _) in FILES {
        for row in expected[key].as_array_mut().unwrap() {
            for (field, value) in [
                ("agentId", "alpha"),
                ("ownerUserId", owner.as_str()),
                ("workspaceIdentity", workspace),
                ("scope", "agent_private"),
            ] {
                row[field] = json!(value);
                for nested in ["visibility", "origin"] {
                    if row.get(nested).is_none() {
                        row[nested] = json!({});
                    }
                    row[nested][field] = json!(value);
                }
            }
            if key == "candidateIndex" {
                row["origin"]["workspaceKey"] = json!(workspace);
            }
        }
    }
    let actual_map = replacements(&actual, &ctx.workspace_key);
    let expected_map = replacements(&expected, workspace);
    let mut actual_index: Value =
        serde_json::from_slice(&fs::read(directory.join("record-index.json")).unwrap()).unwrap();
    let mut expected_index = case["recordIndex"].clone();
    normalize(&mut actual_index, &actual_map);
    normalize(&mut expected_index, &expected_map);
    assert_eq!(
        actual_index, expected_index,
        "actual Node deduplication index"
    );
    normalize(&mut actual, &actual_map);
    normalize(&mut expected, &expected_map);
    for (key, _) in FILES {
        assert_eq!(actual[key], expected[key], "journal {key}");
    }
    let replay = journal.record(&turn, &ctx, &Cancel::never()).unwrap();
    assert_eq!(
        json!({"turns":replay.turns,"candidates":replay.candidates,"reactions":replay.reactions,"behaviorCards":replay.behavior}),
        case["replay"]
    );
    for (key, file) in FILES {
        let rows: Vec<Value> = fs::read_to_string(directory.join(file))
            .unwrap()
            .lines()
            .map(|line| serde_json::from_str(line).unwrap())
            .collect();
        assert_eq!(json!(rows), before[key]);
    }
}
