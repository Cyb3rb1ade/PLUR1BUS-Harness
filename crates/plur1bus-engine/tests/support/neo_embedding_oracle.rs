//! Actual Node outputs are kept untouched; authority stamping is explicit native test input.
use super::*;
const FILES: [(&str, &str); 5] = [
    ("turns", "turn-journal.jsonl"),
    ("candidates", "memory-candidates.jsonl"),
    ("behavior", "behavior-cards.jsonl"),
    ("embeddings", "embedding-queue.jsonl"),
    ("candidateIndex", "candidate-index.jsonl"),
];
pub(super) fn authorize(row: &Value, f: &Fixture) -> Value {
    let mut row = row.clone();
    let owner = if row["ownerUserId"]
        .as_str()
        .is_some_and(|v| v.ends_with(&"2".repeat(64)))
    {
        harness_user_principal("two")
    } else {
        f.context.owner_user_id.clone()
    };
    for key in ["origin", "visibility", "aclBindings"] {
        if let Some(node) = row.get_mut(key).and_then(Value::as_object_mut) {
            node.insert("scope".into(), json!("agent_private"));
            node.insert("agentId".into(), json!("alpha"));
            node.insert("ownerUserId".into(), json!(owner));
            for key in ["workspaceKey", "workspaceIdentity", "workspaceId"] {
                if node.contains_key(key) {
                    node.insert(key.into(), json!(f.context.workspace_key));
                }
            }
        }
    }
    row["ownerUserId"] = json!(owner);
    row["agentId"] = json!("alpha");
    row["scope"] = json!("agent_private");
    row["workspaceKey"] = json!(f.context.workspace_key);
    row
}
pub(super) fn input(f: &Fixture, case: &Value) {
    fs::create_dir_all(&f.directory).unwrap();
    for (key, file) in FILES {
        let text: String = case["input"][key]
            .as_array()
            .unwrap()
            .iter()
            .map(|row| format!("{}\n", authorize(row, f)))
            .collect();
        fs::write(f.directory.join(file), text).unwrap();
    }
    if !case["input"]["recordIndex"].is_null() {
        fs::write(
            f.directory.join("record-index.json"),
            serde_json::to_vec(&case["input"]["recordIndex"]).unwrap(),
        )
        .unwrap();
    }
}
pub(super) fn recorded(name: &str) -> Value {
    let fixture: Value = serde_json::from_str(include_str!(
        "../fixtures/capture/golden/neo-embedding-drain.json"
    ))
    .unwrap();
    fixture["cases"]
        .as_array()
        .unwrap()
        .iter()
        .find(|v| v["spec"]["name"] == name)
        .unwrap()
        .clone()
}
#[test]
fn actual_node_queue_cases_match_counts_calls_manifest_vectors_and_target_revisions() {
    let fixture: Value = serde_json::from_str(include_str!(
        "../fixtures/capture/golden/neo-embedding-drain.json"
    ))
    .unwrap();
    let exceptions = [
        "latest-physical-revision",
        "foreign-target-is-not-authorized-by-node-drain",
        "cancel-after-first-result",
        "failed-attempt-budget",
    ];
    let mut compared = 0;
    for case in fixture["cases"].as_array().unwrap() {
        let name = case["spec"]["name"].as_str().unwrap();
        if exceptions.contains(&name) {
            continue;
        }
        let f = setup();
        input(&f, case);
        for round in case["rounds"].as_array().unwrap() {
            let mode = round["options"]["provider"]
                .as_str()
                .or(case["spec"]["provider"].as_str())
                .unwrap_or("normal");
            let provider = Arc::new(Embedder::new());
            *provider.mode.lock().unwrap() = mode.into();
            let mood = Arc::new(plur1bus_engine::capture::emotion_pool::EmotionalPool::new(
                f.host.clone(),
                json!({}),
            ));
            let episodes = Arc::new(
                EpisodeStore::open(f.root.path(), f.host.clone(), f.policy.clone(), mood).unwrap(),
            );
            let worker = EmbeddingDrain::new(
                episodes,
                if mode == "none" {
                    None
                } else {
                    Some(provider.clone())
                },
            )
            .unwrap();
            let max = round["options"]["maxItems"].as_i64().unwrap_or(100).max(0) as usize;
            let max = if round["options"]["maxItems"].as_i64().is_some_and(|v| v < 0) {
                1
            } else {
                max
            };
            let impact = match round["options"]["impact"].as_str().unwrap_or("low") {
                "medium" => Impact::Medium,
                "high" => Impact::High,
                "critical" => Impact::Critical,
                "all" => Impact::All,
                _ => Impact::Low,
            };
            let result = worker
                .drain(
                    &f.turn.principal,
                    &f.turn.agent,
                    &DrainOptions {
                        max_items: max,
                        impact,
                    },
                    &Cancel::never(),
                )
                .unwrap_or_else(|e| panic!("{name}: {e:?}"));
            assert_eq!(
                json!([
                    result.processed,
                    result.pending,
                    result.skipped,
                    result.deferred
                ]),
                json!([
                    round["result"]["processed"],
                    round["result"]["pending"],
                    round["result"]["skipped"],
                    round["result"]["deferred"]
                ]),
                "{name}"
            );
            let calls: Vec<_> = round["calls"]
                .as_array()
                .unwrap()
                .iter()
                .map(|v| v["text"].as_str().unwrap().to_owned())
                .collect();
            assert_eq!(*provider.calls.lock().unwrap(), calls, "{name}");
            let manifest: Value = fs::read(f.directory.join("vector-index.json"))
                .ok()
                .map(|v| serde_json::from_slice(&v).unwrap())
                .unwrap_or(Value::Null);
            assert_eq!(manifest, round["output"]["manifest"], "{name}");
            if !manifest.is_null() {
                let bytes = fs::read(f.directory.join(manifest["file"].as_str().unwrap())).unwrap();
                let floats: Vec<_> = bytes
                    .chunks_exact(4)
                    .map(|b| f32::from_le_bytes(b.try_into().unwrap()))
                    .collect();
                assert_eq!(json!(floats), round["output"]["vectors"], "{name}");
            }
            for (key, file) in FILES.into_iter().take(4) {
                let expected: Vec<_> = round["output"][key]
                    .as_array()
                    .unwrap()
                    .iter()
                    .map(|v| {
                        let mut v = authorize(v, &f);
                        // Native provider errors deliberately do not persist provider-supplied text.
                        if v["reason"] == "embedder_failed:fixture provider refused" {
                            v["reason"] = json!("embedder_failed");
                        }
                        v
                    })
                    .collect();
                assert_eq!(rows(&f.directory, file), expected, "{name} {file}");
            }
            compared += 1;
        }
    }
    assert_eq!(compared, 30);
}

#[test]
fn explicit_native_exceptions_are_bound_to_actual_node_bytes() {
    use sha2::{Digest, Sha256};
    let exceptions: Value = serde_json::from_str(include_str!(
        "../fixtures/capture/neo-embedding-drain-exceptions.json"
    ))
    .unwrap();
    assert_eq!(exceptions["decision"], "RE-D66");
    assert_eq!(
        exceptions["nodeGoldenSha256"],
        format!(
            "{:x}",
            Sha256::digest(include_bytes!(
                "../fixtures/capture/golden/neo-embedding-drain.json"
            ))
        )
    );
    assert_eq!(exceptions["exceptions"].as_array().unwrap().len(), 8);
}
