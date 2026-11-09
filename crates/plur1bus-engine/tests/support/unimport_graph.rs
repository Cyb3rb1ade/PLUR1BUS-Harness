//! Real rollback plus caller-bound canonical graph deletion; existing Node rollback fixtures.
use super::*;
use plur1bus_engine::{
    capture::shared_scope::CapturePolicy,
    neo::{capture_journal::CaptureJournal, merged::Layout},
};
type PolicyHook = Box<dyn FnMut() + Send>;
struct Policy(AtomicBool, Mutex<Option<PolicyHook>>);
impl CapturePolicy for Policy {
    fn allowed(&self, _: &RequestContext) -> Result<bool, EngineError> {
        if let Some(hook) = self.1.lock().unwrap().as_mut() {
            hook();
        }
        Ok(self.0.load(Ordering::SeqCst))
    }
}
fn fixture() -> (Fixture, PathBuf, Arc<Policy>, Value) {
    let g = golden();
    let c = g["cases"]
        .as_array()
        .unwrap()
        .iter()
        .find(|c| c["name"] == "user-binding-provided")
        .unwrap();
    let mut f = Fixture::new(&g, c, false);
    f.p = f.req.principal.take().unwrap();
    let ctx = RequestContext::build(&f.p, &f.a, f.host.as_ref()).unwrap();
    let root = f.root.path().join("neo");
    fs::create_dir(&root).unwrap();
    let policy = Arc::new(Policy(AtomicBool::new(true), Mutex::new(None)));
    let journal = Arc::new(CaptureJournal::open(&root, f.host.clone(), policy.clone()).unwrap());
    f.ops = f.ops.with_graph_cleanup(journal);
    let directory = root
        .join("workspaces")
        .join(Layout::for_key(&ctx.workspace_key).canonical);
    fs::create_dir_all(&directory).unwrap();
    let mut row = f
        .routes
        .store
        .scan(&RowFilter::default(), 5)
        .unwrap()
        .remove(0);
    // Native D130 extension of the real rollback fixture, not a modified Node golden.
    row.scope = "agent-private".into();
    row.workspace_key = ctx.workspace_key.clone();
    row.workspace_id = ctx.workspace_key.clone();
    f.routes.store.upsert(&[row.clone()]).unwrap();
    let ledger = f.root.path().join("store/_imports/agent.jsonl");
    let mut receipt: Value = serde_json::from_slice(&fs::read(&ledger).unwrap()).unwrap();
    receipt["digest"] =
        serde_json::to_value(plur1bus_engine::ops::import_primitives::import_row_digest(
            &parse_json(&serde_json::to_string(&row).unwrap()).unwrap(),
        ))
        .unwrap();
    fs::write(ledger, format!("{receipt}\n")).unwrap();
    let edge = json!({"source":row.id,"target":row.id,"scope":"agent_private",
        "ownerUserId":ctx.owner_user_id,"agentId":ctx.agent_id.as_str(),"workspaceKey":ctx.workspace_key});
    (f, directory.join("memory-graph.jsonl"), policy, edge)
}
fn install(path: &Path, rows: &[Value]) {
    fs::write(
        path,
        rows.iter().map(|r| format!("{r}\n")).collect::<String>(),
    )
    .unwrap();
}
#[test]
fn deletes_all_owned_revisions_and_retries_without_deleting_foreign_or_opaque_bytes() {
    let (f, path, _, edge) = fixture();
    let mut foreign = edge.clone();
    foreign["ownerUserId"] = json!("user:v1:foreign");
    let mut ownerless = edge.clone();
    ownerless.as_object_mut().unwrap().remove("ownerUserId");
    let opaque = format!(" \n{foreign}\n{ownerless}\nnot-json\n{{\"source\":");
    fs::write(&path, format!("{edge}\n{edge}\n{opaque}")).unwrap();
    let result = f.call();
    assert_eq!(result["value"]["unimported"], 1, "{result}");
    assert_eq!(
        result["value"]["derived"]["graphEdgesRemoved"], 2,
        "{result}"
    );
    assert_eq!(fs::read_to_string(&path).unwrap(), opaque);
    let again = f.call();
    assert_eq!(again["value"]["derived"]["graphEdgesRemoved"], 0, "{again}");
    assert_eq!(fs::read_to_string(&path).unwrap(), opaque);
}
#[test]
fn revoked_policy_reports_cleanup_failure_after_card_commit_and_retry_converges() {
    let (f, path, policy, edge) = fixture();
    install(&path, std::slice::from_ref(&edge));
    let before = fs::read(&path).unwrap();
    policy.0.store(false, Ordering::SeqCst);
    let result = f.call();
    assert_eq!(result["value"]["unimported"], 1, "{result}");
    assert_eq!(result["value"]["derived"]["cleanupErrors"], 1, "{result}");
    assert_eq!(fs::read(&path).unwrap(), before);
    policy.0.store(true, Ordering::SeqCst);
    assert_eq!(f.call()["value"]["derived"]["graphEdgesRemoved"], 1);
    assert!(fs::read(&path).unwrap().is_empty());
}
#[test]
fn root_replaced_during_archive_is_not_rebound_for_cleanup() {
    let (f, path, _, edge) = fixture();
    install(&path, std::slice::from_ref(&edge));
    let workspace = f.root.path().join("workspace");
    let original = f.root.path().join("old-workspace");
    *f.effects.after_archive.lock().unwrap() = Some(Box::new(move || {
        fs::rename(&workspace, original).unwrap();
        fs::create_dir(&workspace).unwrap();
    }));
    let before = fs::read(&path).unwrap();
    let result = f.call();
    assert_eq!(result["value"]["unimported"], 1, "{result}");
    assert_eq!(result["value"]["derived"]["cleanupErrors"], 1, "{result}");
    assert_eq!(fs::read(&path).unwrap(), before);
}
#[test]
fn a_binding_in_the_request_does_not_replace_the_original_operator() {
    let (mut f, path, _, edge) = fixture();
    install(&path, std::slice::from_ref(&edge));
    f.req.principal = Some(f.p);
    f.p = serde_json::from_value(golden()["principal"].clone()).unwrap();
    let before = fs::read(&path).unwrap();
    let result = f.call();
    assert_eq!(result["value"]["unimported"], 1, "{result}");
    assert_eq!(result["value"]["derived"]["cleanupErrors"], 1, "{result}");
    assert_eq!(fs::read(&path).unwrap(), before);
}
#[test]
fn preview_and_cancel_do_not_open_or_rewrite_graph() {
    let (mut f, path, _, edge) = fixture();
    install(&path, std::slice::from_ref(&edge));
    let before = fs::read(&path).unwrap();
    f.req.dry_run = Some(true);
    let _ = f.call();
    f.req.dry_run = Some(false);
    f.cancel.cancel();
    let _ = f.call();
    assert_eq!(fs::read(&path).unwrap(), before);
}

fn after_staging(policy: &Policy, path: &Path, mut action: impl FnMut() + Send + 'static) {
    let dir = path.parent().unwrap().to_owned();
    let mut fired = false;
    *policy.1.lock().unwrap() = Some(Box::new(move || {
        if !fired
            && fs::read_dir(&dir).unwrap().any(|e| {
                e.unwrap()
                    .file_name()
                    .to_string_lossy()
                    .starts_with(".native-neo-cap-")
            })
        {
            fired = true;
            action();
        }
    }));
}
#[test]
fn losing_import_lease_after_staging_preserves_graph() {
    let (f, path, policy, edge) = fixture();
    install(&path, std::slice::from_ref(&edge));
    let before = fs::read(&path).unwrap();
    let lock = f.root.path().join("store/_imports/.locks/agent.lock");
    after_staging(&policy, &path, move || {
        let mut value: Value = serde_json::from_slice(&fs::read(&lock).unwrap()).unwrap();
        value["nonce"] = json!(uuid::Uuid::new_v4().to_string());
        fs::write(&lock, value.to_string()).unwrap();
    });
    let result = f.call();
    assert_eq!(result["value"]["unimported"], 1, "{result}");
    assert_eq!(result["value"]["derived"]["cleanupErrors"], 1, "{result}");
    assert_eq!(fs::read(&path).unwrap(), before);
}
#[test]
fn changed_source_bytes_after_staging_are_not_overwritten() {
    let (f, path, policy, edge) = fixture();
    install(&path, std::slice::from_ref(&edge));
    let changed = format!("{edge}\nforeign replacement\n");
    let target = path.clone();
    let new_bytes = changed.clone();
    after_staging(&policy, &path, move || {
        fs::write(&target, &new_bytes).unwrap();
    });
    let result = f.call();
    assert_eq!(result["value"]["derived"]["cleanupErrors"], 1, "{result}");
    assert_eq!(fs::read_to_string(&path).unwrap(), changed);
}
#[test]
fn a_rebound_deleted_source_after_staging_no_longer_authorizes_graph() {
    let (f, path, policy, edge) = fixture();
    install(&path, std::slice::from_ref(&edge));
    let before = fs::read(&path).unwrap();
    let store = f.routes.store.clone();
    let id = edge["source"].as_str().unwrap().to_owned();
    after_staging(&policy, &path, move || {
        let mut row = store.get(&id).unwrap().unwrap();
        row.owner_user_id = plur1bus_engine::context::harness_user_principal("another-user");
        store.upsert(&[row]).unwrap();
    });
    let result = f.call();
    assert_eq!(result["value"]["derived"]["cleanupErrors"], 1, "{result}");
    assert_eq!(fs::read(&path).unwrap(), before);
}

#[test]
fn duplicate_keys_and_foreign_peer_cannot_authorize_edge_removal() {
    let (f, path, _, edge) = fixture();
    let mut peer = f
        .routes
        .store
        .get(edge["source"].as_str().unwrap())
        .unwrap()
        .unwrap();
    peer.id = uuid::Uuid::new_v4().to_string();
    peer.owner_user_id = plur1bus_engine::context::harness_user_principal("foreign-peer");
    f.routes.store.upsert(&[peer.clone()]).unwrap();
    let mut peer_edge = edge.clone();
    peer_edge["target"] = json!(peer.id);
    let duplicate = format!(
        "{{\"source\":{},{}\n",
        edge["source"],
        edge.to_string().trim_start_matches('{')
    );
    let before = format!("{duplicate}{peer_edge}\n");
    fs::write(&path, &before).unwrap();
    let result = f.call();
    assert_eq!(result["value"]["unimported"], 1, "{result}");
    assert_eq!(result["value"]["derived"]["graphEdgesRemoved"], 0);
    assert_eq!(fs::read_to_string(&path).unwrap(), before);
}
fn stamped(raw: &str, binding: &Value) -> String {
    raw.split_inclusive('\n')
        .map(|line| {
            if let Ok(mut row) = serde_json::from_str::<Value>(line) {
                for key in ["source", "target"] {
                    if row[key] == "gone" || row[key] == "peer" {
                        row[key] = binding["source"].clone();
                    }
                }
                for key in ["scope", "ownerUserId", "agentId", "workspaceKey"] {
                    row[key] = binding[key].clone();
                }
                format!("{row}{}", if line.ends_with('\n') { "\n" } else { "" })
            } else {
                line.to_owned()
            }
        })
        .collect()
}
#[test]
fn recorded_node_revision_counts_and_replay_match_with_explicit_native_ownership() {
    let bytes = include_bytes!("../fixtures/ops/golden/unimport-graph.json");
    let golden: Value = serde_json::from_slice(bytes).unwrap();
    let marker: Value = serde_json::from_str(include_str!(
        "../fixtures/ops/unimport-graph-native-exceptions.json"
    ))
    .unwrap();
    assert_eq!(
        format!("{:x}", Sha256::digest(bytes)),
        marker["nodeGoldenSha256"]
    );
    assert_eq!(golden["recordedFrom"]["node"], "v24.21.0");
    assert_eq!(golden["cases"].as_array().unwrap().len(), 6);
    for name in ["all-revisions", "no-match", "absent"] {
        let case = golden["cases"]
            .as_array()
            .unwrap()
            .iter()
            .find(|c| c["name"] == name)
            .unwrap();
        let (f, path, _, edge) = fixture();
        if let Some(raw) = case["before"].as_str() {
            fs::write(&path, stamped(raw, &edge)).unwrap();
        }
        let result = f.call();
        assert_eq!(
            result["value"]["derived"]["graphEdgesRemoved"], case["result"]["removed"],
            "{name}: {result}"
        );
        match case["after"].as_str() {
            Some(raw) => assert_eq!(fs::read_to_string(&path).unwrap(), stamped(raw, &edge)),
            None => assert!(!path.exists()),
        }
        assert_eq!(
            f.call()["value"]["derived"]["graphEdgesRemoved"],
            case["replay"]["removed"]
        );
    }
}

#[test]
fn serialized_endpoint_ownership_must_agree_with_original_private_sources() {
    let bytes = include_bytes!("../fixtures/ops/golden/graph-ownership.json");
    let recorded: Value = serde_json::from_slice(bytes).unwrap();
    let marker: Value = serde_json::from_str(include_str!(
        "../fixtures/ops/graph-ownership-native-exceptions.json"
    ))
    .unwrap();
    assert_eq!(
        format!("{:x}", Sha256::digest(bytes)),
        marker["nodeGoldenSha256"]
    );
    assert_eq!(recorded["recordedFrom"]["node"], "v24.21.0");
    for case in recorded["cases"].as_array().unwrap() {
        let (f, path, _, mut edge) = fixture();
        let original_id = edge["source"].clone();
        for (key, value) in case["input"].as_object().unwrap() {
            edge[key] = value.clone();
        }
        edge["source"] = original_id.clone();
        edge["target"] = original_id;
        let workspace = edge["workspaceKey"].clone();
        let owner = edge["ownerUserId"].clone();
        // Bind the recorder caller to this actual fixture caller; foreign owners stay foreign.
        for pointer in [
            "/sourceOwnership",
            "/targetOwnership",
            "/ownership/source",
            "/ownership/target",
        ] {
            if let Some(tuple) = edge.pointer_mut(pointer) {
                if tuple["workspaceIdentity"] == recorded["context"]["workspaceIdentity"] {
                    tuple["workspaceIdentity"] = workspace.clone();
                }
                if tuple["ownerUserId"] == recorded["context"]["userPrincipal"] {
                    tuple["ownerUserId"] = owner.clone();
                }
            }
        }
        let expected = marker["cases"]
            .as_array()
            .unwrap()
            .iter()
            .find(|m| m["name"] == case["name"])
            .map_or(!case["filtered"].as_array().unwrap().is_empty(), |m| {
                m["nativeAllow"].as_bool().unwrap()
            });
        install(&path, std::slice::from_ref(&edge));
        let result = f.call();
        assert_eq!(
            result["value"]["unimported"], 1,
            "{}: {result}",
            case["name"]
        );
        assert_eq!(
            result["value"]["derived"]["graphEdgesRemoved"],
            usize::from(expected),
            "{}: {result}",
            case["name"]
        );
        if expected {
            assert!(fs::read(&path).unwrap().is_empty());
        } else {
            assert_eq!(fs::read_to_string(&path).unwrap(), format!("{edge}\n"));
        }
    }
}

#[test]
fn duplicate_nested_owner_claim_is_preserved_even_when_both_values_match() {
    let (f, path, _, mut edge) = fixture();
    let tuple = json!({"schemaVersion":1,"scope":"agent-private","agentId":edge["agentId"],
        "workspaceIdentity":edge["workspaceKey"],"ownerUserId":edge["ownerUserId"]});
    edge["ownershipStatus"] = json!("bound");
    edge["sourceOwnership"] = tuple.clone();
    edge["targetOwnership"] = tuple.clone();
    edge["ownership"] = json!({"source":tuple,"target":tuple});
    let single = format!("\"sourceOwnership\":{}", edge["sourceOwnership"]);
    let duplicate = format!(
        "\"sourceOwnership\":{{\"ownerUserId\":{},{}",
        edge["ownerUserId"],
        edge["sourceOwnership"].to_string().trim_start_matches('{')
    );
    let raw = format!("{}\n", edge.to_string().replacen(&single, &duplicate, 1));
    assert_ne!(raw, format!("{edge}\n"));
    fs::write(&path, &raw).unwrap();
    let result = f.call();
    assert_eq!(result["value"]["unimported"], 1, "{result}");
    assert_eq!(result["value"]["derived"]["graphEdgesRemoved"], 0);
    assert_eq!(result["value"]["derived"]["cleanupErrors"], 1);
    assert_eq!(fs::read_to_string(&path).unwrap(), raw);
}
