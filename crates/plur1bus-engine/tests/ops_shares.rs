//! Real Node share oracles, including sensitivity, source races and shared-origin reads.
#![allow(
    clippy::unwrap_used,
    clippy::panic,
    reason = "recorded fixtures fail immediately"
)]
#[path = "recall_support.rs"]
mod support;
use plur1bus_engine::{
    context::RequestContext,
    contract::{
        Cancel, EmbedError, EmbedKind, EngineError, MemoryRow, MemoryShareTarget, StoreError,
        VectorSpaceIdentity,
    },
    embedding::EmbeddingProvider,
    ops::{
        context::OperationContext,
        memory::{MemoryReader, ReadSource, ReadStores, SourceKind},
        sharing::{ShareServices, SharedStores},
        write::{MemoryWriter, MutationStores},
    },
    recall::hash_embed::HashEmbedder,
    store::{OpenMode, RowFilter, RowPatch, Store},
};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{
    collections::BTreeMap,
    sync::{
        atomic::{AtomicBool, AtomicUsize, Ordering},
        Arc, Mutex,
    },
};
struct Pools {
    private: Arc<Store>,
    workspace: Arc<Store>,
    user: Arc<Store>,
    unsupported: AtomicBool,
    target_fail_at: Option<usize>,
    target_calls: AtomicUsize,
}
impl ReadStores for Pools {
    fn sources(&self, _: &RequestContext) -> Result<Vec<ReadSource>, StoreError> {
        Ok(vec![
            ReadSource {
                store: self.private.clone(),
                kind: SourceKind::Private,
                optional: false,
            },
            ReadSource {
                store: self.workspace.clone(),
                kind: SourceKind::Workspace,
                optional: true,
            },
            ReadSource {
                store: self.user.clone(),
                kind: SourceKind::User,
                optional: true,
            },
        ])
    }
}
impl MutationStores for Pools {
    fn existing_private(&self, _: &RequestContext) -> Result<Option<Arc<Store>>, StoreError> {
        Ok(Some(self.private.clone()))
    }
}
impl SharedStores for Pools {
    fn supported(&self) -> bool {
        !self.unsupported.load(Ordering::SeqCst)
    }
    fn unsupported_reason(&self) -> &str {
        "fixture"
    }
    fn target(
        &self,
        _: &RequestContext,
        scope: MemoryShareTarget,
    ) -> Result<Arc<Store>, StoreError> {
        let call = self.target_calls.fetch_add(1, Ordering::SeqCst) + 1;
        if self.target_fail_at == Some(call) {
            return Err(StoreError::Corrupt);
        }
        Ok(match scope {
            MemoryShareTarget::Workspace => self.workspace.clone(),
            MemoryShareTarget::User => self.user.clone(),
        })
    }
}
struct Provider {
    identity: VectorSpaceIdentity,
    calls: Mutex<Vec<String>>,
    source: Arc<Store>,
    id: String,
    fail: bool,
    change: bool,
    wrong: bool,
}
impl EmbeddingProvider for Provider {
    fn identity(&self) -> &VectorSpaceIdentity {
        &self.identity
    }
    fn embed(
        &self,
        texts: &[String],
        _: EmbedKind,
        _: &Cancel,
    ) -> Result<Vec<Vec<f32>>, EmbedError> {
        self.calls.lock().unwrap().extend_from_slice(texts);
        if self.fail {
            return Err(EmbedError::Unavailable);
        }
        if self.change {
            self.source
                .patch(
                    &self.id,
                    &RowPatch {
                        text: Some("changed while embedding".into()),
                        ..Default::default()
                    },
                )
                .unwrap();
        }
        Ok(texts
            .iter()
            .map(|_| {
                if self.wrong {
                    vec![1., 0.]
                } else {
                    vec![0., 1., 0., 0.]
                }
            })
            .collect())
    }
}
fn wire<T: serde::Serialize>(result: Result<T, EngineError>) -> Value {
    match result {
        Ok(v) => json!({"value":v}),
        Err(EngineError::MemoryOp(e)) => {
            let mut value = json!({"error":e.code.to_string()});
            if !e.detail().is_empty() {
                value["detail"] = Value::Object(
                    e.detail()
                        .iter()
                        .map(|(k, v)| (k.as_str().to_owned(), json!(v.as_str())))
                        .collect(),
                );
            }
            value
        }
        Err(e) => panic!("unexpected {e:?}"),
    }
}
fn normalize(
    value: &mut Value,
    root: &str,
    ids: &BTreeMap<String, String>,
    key: &str,
    workspace: bool,
) {
    match value {
        Value::Number(n) => *n = serde_json::Number::from_f64(n.as_f64().unwrap()).unwrap(),
        Value::String(s) => {
            if let Some(id) = ids.get(s) {
                *s = id.clone();
            } else if key == "shareIdempotencyKey" && workspace {
                *s = "<workspace-share-key>".into();
            } else if key == "shareProvenance" {
                let mut v: Value = serde_json::from_str(s).unwrap();
                if v["targetScope"] == "workspace" {
                    v["targetPrincipalHash"] = json!("<workspace-hash>");
                }
                // Node's stored order is checked independently, before JSON comparison.
                *s=format!("{{\"schemaVersion\":1,\"action\":{},\"targetScope\":{},\"targetPrincipalHash\":{},\"sourceMemoryId\":{},\"sourceAgentId\":{},\"sharedAt\":{}}}",v["action"],v["targetScope"],v["targetPrincipalHash"],v["sourceMemoryId"],v["sourceAgentId"],v["sharedAt"]);
            } else {
                *s = s.replace(root, "<work>");
            }
        }
        Value::Array(items) => items
            .iter_mut()
            .for_each(|v| normalize(v, root, ids, "", workspace)),
        Value::Object(fields) => fields
            .iter_mut()
            .for_each(|(k, v)| normalize(v, root, ids, k, workspace)),
        _ => {}
    }
}
fn shared_rows(store: &Store, principal: &str, target: MemoryShareTarget) -> Value {
    let rows = store.scan(&RowFilter::default(), 100).unwrap();
    Value::Array(
        rows.into_iter()
            .map(|row| {
                let record = store.get_record(&row.id).unwrap().unwrap();
                let metadata = record.sharing.unwrap();
                let mut value = serde_json::to_value(row).unwrap();
                let source = metadata.source_memory_id.as_str();
                let agent = metadata.source_agent_id.as_str();
                let text = value["text"].as_str().unwrap();
                let text_hash = format!("{:x}", Sha256::digest(text.as_bytes()));
                let key = format!(
                    "{:x}",
                    Sha256::digest(
                        format!(
                            "explicit_share\0{target}\0{principal}\0{agent}\0{source}\0{text_hash}"
                        )
                        .as_bytes()
                    )
                );
                assert_eq!(metadata.share_idempotency_key, key);
                let provenance: Value = serde_json::from_str(&metadata.share_provenance).unwrap();
                assert_eq!(
                    provenance["targetPrincipalHash"],
                    format!("{:x}", Sha256::digest(principal.as_bytes()))
                );
                value.as_object_mut().unwrap().extend(
                    serde_json::to_value(metadata)
                        .unwrap()
                        .as_object()
                        .unwrap()
                        .clone(),
                );
                value
            })
            .collect(),
    )
}
fn legacy_shared(path: &std::path::Path) -> Store {
    fn copy(source: &std::path::Path, dest: &std::path::Path) {
        std::fs::create_dir_all(dest).unwrap();
        for entry in std::fs::read_dir(source).unwrap() {
            let entry = entry.unwrap();
            let target = dest.join(entry.file_name());
            if entry.file_type().unwrap().is_dir() {
                copy(&entry.path(), &target);
            } else {
                std::fs::copy(entry.path(), target).unwrap();
            }
        }
    }
    copy(
        &std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("tests/fixtures/ops/shared-store-node"),
        path,
    );
    let store = Store::open(path, OpenMode::ReadWrite, None).unwrap();
    assert!(store.identity().is_none());
    for row in store.scan(&RowFilter::default(), 10).unwrap() {
        store.delete(&[&row.id]).unwrap();
    }
    store
}
#[test]
fn shares_match_node_oracles_and_read_back_with_origin_deduplication() {
    let golden: Value =
        serde_json::from_str(include_str!("fixtures/ops/golden/shares.json")).unwrap();
    for case in golden["cases"].as_array().unwrap() {
        let root = support::canonical_tempdir();
        let base = root.path().join("store");
        let workspace = root.path().join("workspace");
        std::fs::create_dir(&workspace).unwrap();
        let mut identity = HashEmbedder::new().identity().clone();
        identity.dimension = 4.into();
        let private = Arc::new(Store::create(&base.join("agent"), &identity, 4).unwrap());
        let shared_workspace = Arc::new(if case["identified"] == true {
            Store::create_shared(&root.path().join("shared-workspace"), &identity, 4).unwrap()
        } else {
            legacy_shared(&root.path().join("shared-workspace"))
        });
        let shared_user = Arc::new(if case["identified"] == true {
            Store::create_shared(&root.path().join("shared-user"), &identity, 4).unwrap()
        } else {
            legacy_shared(&root.path().join("shared-user"))
        });
        let original: MemoryRow = serde_json::from_value(case["original"].clone()).unwrap();
        private.upsert(std::slice::from_ref(&original)).unwrap();
        let pools = Arc::new(Pools {
            private: private.clone(),
            workspace: shared_workspace,
            user: shared_user,
            unsupported: AtomicBool::new(case["unsupported"] == true),
            target_fail_at: None,
            target_calls: AtomicUsize::new(0),
        });
        let host = Arc::new(support::TestHost::new(root.path().join("state")));
        if case["noWorkspace"] != true {
            host.set_workspace("agent", workspace.clone());
        }
        let context = Arc::new(OperationContext::new(host));
        if case["wrongProvider"] == true {
            identity.revision = "different".into();
        }
        let provider = Arc::new(Provider {
            identity,
            calls: Mutex::new(Vec::new()),
            source: private.clone(),
            id: original.id.clone(),
            fail: case["embedFailure"] == true,
            change: case["sourceChanged"] == true,
            wrong: case["wrongWidth"] == true,
        });
        let reader = Arc::new(MemoryReader::new(
            context.clone(),
            pools.clone(),
            provider.clone(),
            base.clone(),
        ));
        let writer = MemoryWriter::new(context, pools.clone(), base).with_sharing(ShareServices {
            reader: reader.clone(),
            stores: pools.clone(),
            providers: if case["noProvider"] == true {
                vec![]
            } else {
                vec![provider.clone()]
            },
        });
        let p: plur1bus_engine::contract::Principal =
            serde_json::from_value(support::replace_fixture_text(
                &case["principal"],
                "<work>",
                root.path().to_str().unwrap(),
            ))
            .unwrap();
        let a = serde_json::from_value(case.get("context").unwrap_or(&golden["agent"]).clone())
            .unwrap();
        let options =
            serde_json::from_value(json!({"allowSensitive":case["allowSensitive"]==true})).unwrap();
        let target = if case["target"] == "user" {
            MemoryShareTarget::User
        } else {
            MemoryShareTarget::Workspace
        };
        let mut results = Vec::new();
        for _ in 0..if case["repeat"] == true { 2 } else { 1 } {
            results.push(wire(writer.share_at(
                case["id"].as_str().unwrap_or(&original.id),
                target,
                &p,
                &a,
                &options,
                golden["now"].as_i64().unwrap(),
            )));
        }
        let workspace_rows = shared_rows(
            &pools.workspace,
            p.workspace.as_str(),
            MemoryShareTarget::Workspace,
        );
        let user_rows = shared_rows(
            &pools.user,
            p.user.as_deref().map_or("", |v| v.as_str()),
            MemoryShareTarget::User,
        );
        let ids = workspace_rows
            .as_array()
            .unwrap()
            .iter()
            .chain(user_rows.as_array().unwrap())
            .enumerate()
            .map(|(i, row)| {
                (
                    row["id"].as_str().unwrap().to_owned(),
                    format!("shared-{}", i + 1),
                )
            })
            .collect::<BTreeMap<_, _>>();
        let read_agent = serde_json::from_value(golden["agent"].clone()).unwrap();
        let shows = ids
            .keys()
            .map(|id| {
                serde_json::to_value(
                    reader
                        .show_at(id, &p, &read_agent, golden["now"].as_i64().unwrap())
                        .unwrap(),
                )
                .unwrap()
            })
            .collect::<Vec<_>>();
        let listed = wire(reader.list_at(
            &serde_json::from_value(json!({"since":0,"limit":100})).unwrap(),
            &p,
            &read_agent,
            golden["now"].as_i64().unwrap(),
        ));
        let list = listed.get("value").cloned().unwrap_or(listed);
        let mut actual = json!({"results":results,"workspaceRows":workspace_rows,"userRows":user_rows,"shows":shows,"list":list,"after":private.get(&original.id).unwrap().unwrap(),"embedCalls":provider.calls.lock().unwrap().clone()});
        let mut expected = json!({"results":case["results"],"workspaceRows":case["workspaceRows"],"userRows":case["userRows"],"shows":case["shows"],"list":case["list"],"after":case["after"],"embedCalls":case["embedCalls"]});
        normalize(
            &mut actual,
            root.path().to_str().unwrap(),
            &ids,
            "",
            target == MemoryShareTarget::Workspace,
        );
        normalize(
            &mut expected,
            "<work>",
            &BTreeMap::new(),
            "",
            target == MemoryShareTarget::Workspace,
        );
        assert_eq!(actual, expected, "{}", case["name"]);
    }
}

struct MutationProvider {
    identity: VectorSpaceIdentity,
    calls: Mutex<Vec<String>>,
    fail_at: Option<usize>,
}
impl EmbeddingProvider for MutationProvider {
    fn identity(&self) -> &VectorSpaceIdentity {
        &self.identity
    }
    fn embed(
        &self,
        texts: &[String],
        _: EmbedKind,
        _: &Cancel,
    ) -> Result<Vec<Vec<f32>>, EmbedError> {
        let mut calls = self.calls.lock().unwrap();
        calls.extend_from_slice(texts);
        if self.fail_at == Some(calls.len()) {
            return Err(EmbedError::Unavailable);
        }
        Ok(texts.iter().map(|_| vec![0., 1., 0., 0.]).collect())
    }
}
fn mutation_normalize(value: &mut Value, root: &str, ids: &BTreeMap<String, String>, key: &str) {
    match value {
        Value::Number(n) => *n = serde_json::Number::from_f64(n.as_f64().unwrap()).unwrap(),
        Value::String(s) => {
            if key == "shareIdempotencyKey" {
                *s = "<share-key>".into();
            } else if key == "shareProvenance" {
                let mut v: Value = serde_json::from_str(s).unwrap();
                v["targetPrincipalHash"] = json!("<principal-hash>");
                mutation_normalize(&mut v, root, ids, "");
                *s=format!("{{\"schemaVersion\":1,\"action\":{},\"targetScope\":{},\"targetPrincipalHash\":{},\"sourceMemoryId\":{},\"sourceAgentId\":{},\"sharedAt\":{}}}",v["action"],v["targetScope"],v["targetPrincipalHash"],v["sourceMemoryId"],v["sourceAgentId"],v["sharedAt"].as_f64().unwrap() as i64);
            } else {
                *s = s.replace(root, "<work>");
                for (id, name) in ids {
                    *s = s.replace(id, name);
                }
            }
        }
        Value::Array(items) => items
            .iter_mut()
            .for_each(|v| mutation_normalize(v, root, ids, "")),
        Value::Object(fields) => fields
            .iter_mut()
            .for_each(|(k, v)| mutation_normalize(v, root, ids, k)),
        _ => {}
    }
}
fn row_projection(store: &Store) -> Vec<Value> {
    store
        .scan(&RowFilter::default(), 100)
        .unwrap()
        .into_iter()
        .map(|row| {
            let mut value = serde_json::to_value(&row).unwrap();
            if let Some(metadata) = store.get_record(&row.id).unwrap().unwrap().sharing {
                value.as_object_mut().unwrap().extend(
                    serde_json::to_value(metadata)
                        .unwrap()
                        .as_object()
                        .unwrap()
                        .clone(),
                );
            }
            let keys = [
                "id",
                "text",
                "summary",
                "status",
                "scope",
                "agentId",
                "storedBy",
                "ownerUserId",
                "workspaceId",
                "workspaceKey",
                "epistemicStatus",
                "sourceMemoryId",
                "sourceAgentId",
                "previousVersion",
                "supersededBy",
            ];
            value
                .as_object_mut()
                .unwrap()
                .retain(|k, _| keys.contains(&k.as_str()));
            value
        })
        .collect()
}
#[test]
fn shared_mutations_match_node_including_partial_failure_recovery_and_archives() {
    let golden: Value =
        serde_json::from_str(include_str!("fixtures/ops/golden/shared-mutations.json")).unwrap();
    let share_golden: Value =
        serde_json::from_str(include_str!("fixtures/ops/golden/shares.json")).unwrap();
    for case in golden["cases"].as_array().unwrap() {
        let root = support::canonical_tempdir();
        let base = root.path().join("store");
        let state = root.path().join("state");
        let workspace = root.path().join("workspace");
        std::fs::create_dir(&workspace).unwrap();
        let mut identity = HashEmbedder::new().identity().clone();
        identity.dimension = 4.into();
        let private = Arc::new(Store::create(&base.join("agent"), &identity, 4).unwrap());
        let original: MemoryRow = serde_json::from_value(case["original"].clone()).unwrap();
        private.upsert(std::slice::from_ref(&original)).unwrap();
        let pools = Arc::new(Pools {
            private: private.clone(),
            workspace: Arc::new(legacy_shared(&root.path().join("shared-workspace"))),
            user: Arc::new(legacy_shared(&root.path().join("shared-user"))),
            unsupported: AtomicBool::new(false),
            target_fail_at: if case["retractFailure"] == true {
                Some(3)
            } else {
                None
            },
            target_calls: AtomicUsize::new(0),
        });
        let host = Arc::new(support::TestHost::new(state.clone()));
        host.set_workspace("agent", workspace.clone());
        host.set_workspace("peer", workspace.clone());
        let context = Arc::new(OperationContext::new(host));
        let provider = Arc::new(MutationProvider {
            identity,
            calls: Mutex::new(Vec::new()),
            fail_at: if case["embedFailure"] == true {
                Some(2)
            } else if case["reshareFailure"] == true {
                Some(3)
            } else {
                None
            },
        });
        let reader = Arc::new(MemoryReader::new(
            context.clone(),
            pools.clone(),
            provider.clone(),
            base.clone(),
        ));
        let writer = MemoryWriter::new(context, pools.clone(), base)
            .with_corrections(plur1bus_engine::ops::correction::CorrectionServices {
                embedder: provider.clone(),
                effects: None,
            })
            .with_sharing(ShareServices {
                reader,
                stores: pools.clone(),
                providers: vec![provider.clone()],
            });
        let p: plur1bus_engine::contract::Principal =
            serde_json::from_value(support::replace_fixture_text(
                &case["principal"],
                "<work>",
                root.path().to_str().unwrap(),
            ))
            .unwrap();
        let initial: plur1bus_engine::contract::Principal =
            serde_json::from_value(support::replace_fixture_text(
                &share_golden["cases"][0]["principal"],
                "<work>",
                root.path().to_str().unwrap(),
            ))
            .unwrap();
        let agent = serde_json::from_value(golden["agent"].clone()).unwrap();
        let caller =
            serde_json::from_value(case.get("context").unwrap_or(&golden["agent"]).clone())
                .unwrap();
        let now = golden["now"].as_i64().unwrap();
        let target = if case["target"] == "user" {
            MemoryShareTarget::User
        } else {
            MemoryShareTarget::Workspace
        };
        let shared = writer
            .share_at(
                &original.id,
                target,
                &initial,
                &agent,
                &serde_json::from_value(json!({})).unwrap(),
                now,
            )
            .unwrap();
        if case["originalGone"] == true {
            private
                .patch(
                    &original.id,
                    &RowPatch {
                        status: Some("superseded".into()),
                        ..Default::default()
                    },
                )
                .unwrap();
        }
        if case["archiveFailure"] == true {
            std::fs::create_dir_all(state.join("memory")).unwrap();
            std::fs::write(state.join("memory/_archive"), "blocked").unwrap();
        }
        if case["auditFailure"] == true {
            std::fs::write(workspace.join(".adaptive-learning"), "blocked").unwrap();
        }
        let mut results = Vec::new();
        for _ in 0..if case["repeat"] == true { 2 } else { 1 } {
            results.push(if case["op"] == "forget" {
                wire(writer.forget_at(&shared.shared_id, &p, &caller, now))
            } else {
                wire(writer.correct_at(
                    &shared.shared_id,
                    "Updated shared evidence",
                    &p,
                    &caller,
                    now,
                ))
            });
        }
        let rows = row_projection(&private);
        let copies = row_projection(if target == MemoryShareTarget::User {
            &pools.user
        } else {
            &pools.workspace
        });
        let mut ids = BTreeMap::from([(shared.shared_id.clone(), "old-shared".to_owned())]);
        for row in &rows {
            if row["id"] != original.id {
                ids.insert(row["id"].as_str().unwrap().to_owned(), "new-source".into());
            }
        }
        for row in &copies {
            if row["id"] != shared.shared_id {
                ids.insert(row["id"].as_str().unwrap().to_owned(), "new-shared".into());
            }
        }
        let audit =
            std::fs::read_to_string(workspace.join(".adaptive-learning/destructive-ops.jsonl"))
                .map(|s| {
                    s.lines()
                        .map(|line| serde_json::from_str::<Value>(line).unwrap())
                        .collect::<Vec<_>>()
                })
                .unwrap_or_default();
        let archives = std::fs::read_dir(state.join("memory/_archive/agent"))
            .map(|entries| {
                entries
                    .map(|entry| {
                        serde_json::from_slice::<Value>(
                            &std::fs::read(entry.unwrap().path()).unwrap(),
                        )
                        .unwrap()
                    })
                    .collect::<Vec<_>>()
            })
            .unwrap_or_default();
        assert!(!root.path().join("_tombstones/agent.jsonl").exists());
        let mut actual = json!({"results":results,"rows":rows,"copies":copies,"audit":audit,"archives":archives,"embeddingCalls":provider.calls.lock().unwrap()[1..]});
        let mut expected = json!({"results":case["results"],"rows":case["rows"],"copies":case["copies"],"audit":case["audit"],"archives":case["archives"],"embeddingCalls":case["embeddingCalls"]});
        mutation_normalize(&mut actual, root.path().to_str().unwrap(), &ids, "");
        mutation_normalize(&mut expected, "<work>", &BTreeMap::new(), "");
        for key in ["rows", "copies", "archives"] {
            actual[key]
                .as_array_mut()
                .unwrap()
                .sort_by(|a, b| a["id"].as_str().cmp(&b["id"].as_str()));
        }
        assert_eq!(actual, expected, "{}", case["name"]);
    }
}

#[test]
fn proposal_oracles_preserve_pool_acl_staleness_events_and_durable_resolution() {
    use plur1bus_engine::{
        contract::MemoryProposalsOps,
        ops::{correction::CorrectionServices, proposals::Proposals},
    };
    let golden_text = include_str!("fixtures/ops/golden/proposals.json");
    let golden: Value = serde_json::from_str(golden_text).unwrap();
    let exception: Value =
        serde_json::from_str(include_str!("fixtures/ops/golden/proposal-exceptions.json")).unwrap();
    assert_eq!(
        exception["goldenSha256"],
        format!("{:x}", Sha256::digest(golden_text))
    );
    for case in golden["cases"].as_array().unwrap() {
        let root = support::canonical_tempdir();
        let base = root.path().join("store");
        let state = root.path().join("state");
        let workspace = root.path().join("workspace");
        std::fs::create_dir(&workspace).unwrap();
        let mut identity = HashEmbedder::new().identity().clone();
        identity.dimension = 4.into();
        let private = Arc::new(Store::create(&base.join("agent"), &identity, 4).unwrap());
        let original: MemoryRow = serde_json::from_value(case["original"].clone()).unwrap();
        private.upsert(std::slice::from_ref(&original)).unwrap();
        let pools = Arc::new(Pools {
            private: private.clone(),
            workspace: Arc::new(legacy_shared(&root.path().join("shared-workspace"))),
            user: Arc::new(legacy_shared(&root.path().join("shared-user"))),
            unsupported: AtomicBool::new(false),
            target_fail_at: None,
            target_calls: AtomicUsize::new(0),
        });
        let host = Arc::new(support::TestHost::new(state.clone()));
        for a in ["agent", "peer", "foreign"] {
            host.set_workspace(a, workspace.clone());
        }
        let context = Arc::new(OperationContext::new(host.clone()));
        let provider = Arc::new(MutationProvider {
            identity,
            calls: Mutex::new(Vec::new()),
            fail_at: if case["embedFailure"] == true {
                Some(2)
            } else {
                None
            },
        });
        let reader = Arc::new(MemoryReader::new(
            context.clone(),
            pools.clone(),
            provider.clone(),
            base.clone(),
        ));
        let writer = Arc::new(
            MemoryWriter::new(context, pools.clone(), base)
                .with_corrections(CorrectionServices {
                    embedder: provider.clone(),
                    effects: None,
                })
                .with_sharing(ShareServices {
                    reader,
                    stores: pools.clone(),
                    providers: vec![provider],
                }),
        );
        let principal = |key: &str| {
            serde_json::from_value::<plur1bus_engine::contract::Principal>(
                support::replace_fixture_text(&case[key], "<work>", root.path().to_str().unwrap()),
            )
            .unwrap()
        };
        let p = principal("principal");
        let proposer = principal("proposer");
        let resolver = principal("resolver");
        let a = serde_json::from_value(golden["agent"].clone()).unwrap();
        let now = golden["now"].as_i64().unwrap();
        let target = if case["target"] == "user" {
            MemoryShareTarget::User
        } else {
            MemoryShareTarget::Workspace
        };
        let shared = writer
            .share_at(
                &original.id,
                target,
                &p,
                &a,
                &serde_json::from_value(json!({})).unwrap(),
                now,
            )
            .unwrap();
        let proposals = Proposals::new(writer);
        if case["auditFailure"] == true {
            std::fs::write(workspace.join(".adaptive-learning"), "blocked").unwrap();
        }
        let mut results = vec![];
        let mut proposal_id = None;
        let text = case["text"].as_str().unwrap_or(if case["same"] == true {
            &original.text
        } else {
            "Proposal changes synthetic evidence"
        });
        let opts = serde_json::from_value(if case.get("note").is_some() {
            json!({"note":case["note"]})
        } else {
            json!({})
        })
        .unwrap();
        let caller = if case["background"] == true {
            serde_json::from_value(json!({"origin":"user","background":true})).unwrap()
        } else {
            a.clone()
        };
        for _ in 0..if case["repeat"] == true { 2 } else { 1 } {
            let result = wire(proposals.propose_at(
                if case["private"] == true {
                    &original.id
                } else if case["missing"] == true {
                    "00000000-0000-4000-8000-000000000099"
                } else {
                    &shared.shared_id
                },
                text,
                &opts,
                &proposer,
                &caller,
                now,
            ));
            if let Some(id) = result["value"]["proposalId"].as_str() {
                proposal_id = Some(id.to_owned());
            }
            results.push(result);
        }
        let shared_store = if target == MemoryShareTarget::User {
            &pools.user
        } else {
            &pools.workspace
        };
        if case["changed"] == true {
            shared_store
                .patch(
                    &shared.shared_id,
                    &RowPatch {
                        text: Some("changed after proposal".into()),
                        ..Default::default()
                    },
                )
                .unwrap();
        }
        if case["gone"] == true {
            shared_store
                .patch(
                    &shared.shared_id,
                    &RowPatch {
                        status: Some("deleted".into()),
                        ..Default::default()
                    },
                )
                .unwrap();
        }
        if case["corrupt"] == true {
            std::fs::create_dir_all(root.path().join("_proposals/foreign")).unwrap();
            std::fs::write(
                root.path().join("_proposals/foreign/broken.json"),
                "{broken",
            )
            .unwrap();
        }
        if case["resolveAuditFailure"] == true {
            std::fs::remove_dir_all(workspace.join(".adaptive-learning")).unwrap();
            std::fs::write(workspace.join(".adaptive-learning"), "blocked").unwrap();
        }
        if let Some(id) = proposal_id
            .as_ref()
            .filter(|_| case.get("resolve").is_some())
        {
            pools
                .unsupported
                .store(case["unsupported"] == true, Ordering::SeqCst);
            for _ in 0..if case["repeatResolve"] == true { 2 } else { 1 } {
                results.push(if case["resolve"] == "accept" {
                    wire(proposals.accept_at(id, &resolver, &a, now))
                } else {
                    wire(
                        proposals.reject_at(
                            id,
                            &serde_json::from_value(json!({"note":"declined synthetic proposal"}))
                                .unwrap(),
                            &resolver,
                            &a,
                            now,
                        ),
                    )
                });
            }
        }
        let mut foreign = p.clone();
        foreign.agent_id = "foreign".parse().unwrap();
        let mut other = p.clone();
        other.user = Some(
            format!("user:v1:{:x}", Sha256::digest("other-user"))
                .parse()
                .unwrap(),
        );
        let mut lists = serde_json::Map::new();
        for (name, who) in [
            ("sharer", &p),
            ("proposer", &proposer),
            ("foreign", &foreign),
            ("otherUser", &other),
        ] {
            lists.insert(
                name.into(),
                serde_json::to_value(
                    proposals
                        .list(serde_json::from_value(json!({})).unwrap(), who, &a)
                        .unwrap(),
                )
                .unwrap(),
            );
        }
        let records = std::fs::read_dir(root.path().join("_proposals/agent"))
            .map(|entries| {
                entries
                    .map(|entry| {
                        serde_json::from_slice::<Value>(
                            &std::fs::read(entry.unwrap().path()).unwrap(),
                        )
                        .unwrap()
                    })
                    .collect::<Vec<_>>()
            })
            .unwrap_or_default();
        let mut ids = BTreeMap::from([(shared.shared_id.clone(), "old-shared".into())]);
        for row in private.scan(&RowFilter::default(), 100).unwrap() {
            if row.id != original.id {
                ids.insert(row.id, "new-source".into());
            }
        }
        for row in shared_store.scan(&RowFilter::default(), 100).unwrap() {
            if row.id != shared.shared_id {
                ids.insert(row.id, "new-shared".into());
            }
        }
        for record in &records {
            ids.insert(record["id"].as_str().unwrap().to_owned(), "proposal".into());
        }
        let mut actual = json!({"results":results,"records":records,"lists":lists,"events":host.events.lock().unwrap().clone()});
        let mut expected = json!({"results":case["results"],"records":case["records"],"lists":case["lists"],"events":case["events"]});
        fn normalize_proposal(value: &mut Value, root: &str, ids: &BTreeMap<String, String>) {
            mutation_normalize(value, root, ids, "");
            fn pools(v: &mut Value) {
                match v {
                    Value::Object(fields) => {
                        for (k, v) in fields {
                            if k == "poolKey" && v.as_str().is_some_and(|s| s.starts_with("w-")) {
                                *v = json!("<workspace-pool>");
                            } else {
                                pools(v);
                            }
                        }
                    }
                    Value::Array(items) => {
                        for v in items {
                            pools(v);
                        }
                    }
                    _ => {}
                }
            }
            pools(value);
        }
        normalize_proposal(&mut actual, root.path().to_str().unwrap(), &ids);
        normalize_proposal(&mut expected, "<work>", &BTreeMap::new());
        if case["name"] == exception["case"] {
            for who in ["sharer", "proposer", "foreign", "otherUser"] {
                assert_eq!(expected["lists"][who]["unreadable"].as_f64(), Some(1.));
                expected["lists"][who]["unreadable"] = json!(0.0);
            }
        }
        assert_eq!(actual, expected, "{}", case["name"]);
        if case["name"] == "user-pending" {
            let id = proposal_id.as_ref().unwrap();
            let path = root
                .path()
                .join("_proposals/agent")
                .join(format!("{id}.json"));
            let original_file = std::fs::read_to_string(&path).unwrap();
            let mut malformed: Value = serde_json::from_str(&original_file).unwrap();
            malformed["newText"] = json!(7);
            std::fs::write(&path, malformed.to_string()).unwrap();
            assert_eq!(
                wire(proposals.accept_at(id, &other, &a, now)),
                json!({"error":"not-found"})
            );
            assert_eq!(
                wire(proposals.accept_at(id, &p, &a, now)),
                json!({"error":"storage"})
            );
            let mut folded = p.clone();
            folded.agent_id = "AGENT".parse().unwrap();
            host.set_workspace("AGENT", workspace.clone());
            assert_eq!(
                wire(proposals.accept_at(id, &folded, &a, now)),
                json!({"error":"not-found"})
            );
            let original_file = original_file.trim_end();
            let opaque = format!(
                "{},\"status\":\"pending\",\"opaque\":\"\\ud800\"}}",
                &original_file[..original_file.len() - 1]
            );
            std::fs::write(&path, opaque).unwrap();
            let reject_opts =
                serde_json::from_value(json!({"note":"resolution preserves opaque fields"}))
                    .unwrap();
            let results = std::thread::scope(|scope| {
                let one = scope.spawn(|| wire(proposals.reject_at(id, &reject_opts, &p, &a, now)));
                let two = scope.spawn(|| wire(proposals.reject_at(id, &reject_opts, &p, &a, now)));
                [one.join().unwrap(), two.join().unwrap()]
            });
            assert_eq!(
                results.iter().filter(|r| r.get("value").is_some()).count(),
                1
            );
            assert_eq!(
                results.iter().filter(|r| r["error"] == "conflict").count(),
                1
            );
            let persisted = std::fs::read_to_string(&path).unwrap();
            assert!(persisted.contains("\\ud800"));
            let events = host.events.lock().unwrap();
            assert_eq!(
                events
                    .iter()
                    .filter(|event| event["payload"]["status"] == "rejected")
                    .count(),
                1
            );
        }
    }
}
