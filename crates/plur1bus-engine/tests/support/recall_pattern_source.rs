//! Request-bound pattern metadata composed with actual namespace recall and rendering.
use super::*;
use plur1bus_engine::contract::EngineError;
use plur1bus_engine::{neo::merged::Layout, recall::pattern_source::BoundPatternSource};
use serde_json::Value;
use std::path::{Path, PathBuf};
fn setup(fixture: &Fixture) -> (PathBuf, PathBuf, Value) {
    let root = fixture.root.path().join("neo");
    let directory = root
        .join("workspaces")
        .join(Layout::for_key(&fixture.context.workspace_key).canonical);
    std::fs::create_dir_all(&directory).unwrap();
    let pattern = json!({"id":"pattern-fixture","agentId":"agent","scope":"agent_private",
        "patternName":"Observed fixture pattern","description":"Synthetic provisional relation",
        "memberIds":["visible","second"],"confidence":1,"createdAt":0});
    (root, directory.join("pattern-analysis.jsonl"), pattern)
}
fn write(file: &Path, rows: &[Value]) {
    let lines = rows
        .iter()
        .map(Value::to_string)
        .collect::<Vec<_>>()
        .join("\n");
    std::fs::write(file, lines).unwrap();
}
#[test]
fn source_filters_before_tail_and_does_not_revive_a_hidden_latest_revision() {
    let fixture = Fixture::new(false);
    let (root, file, pattern) = setup(&fixture);
    let source = BoundPatternSource::open(&root, &fixture.context).unwrap();
    let mut rows = vec![pattern.clone()];
    for index in 1..=150 {
        let mut hidden = pattern.clone();
        hidden["id"] = json!(format!("foreign-{index}"));
        hidden["agentId"] = json!("foreign");
        hidden["createdAt"] = json!(index);
        rows.push(hidden);
    }
    write(&file, &rows);
    assert_eq!(
        source.read_for(&fixture.context, &Cancel::never()).unwrap(),
        vec![pattern.clone()]
    );
    let mut hidden_latest = pattern;
    hidden_latest["agentId"] = json!("foreign");
    hidden_latest["createdAt"] = json!(200);
    rows.push(hidden_latest);
    write(&file, &rows);
    assert!(source
        .read_for(&fixture.context, &Cancel::never())
        .unwrap()
        .is_empty());
}
#[test]
fn source_is_read_only_context_bound_and_refuses_root_replacement() {
    let fixture = Fixture::new(false);
    let (root, file, pattern) = setup(&fixture);
    write(&file, &[pattern]);
    let before = std::fs::read(&file).unwrap();
    let source = BoundPatternSource::open(&root, &fixture.context).unwrap();
    assert_eq!(
        source
            .read_for(&fixture.context, &Cancel::never())
            .unwrap()
            .len(),
        1
    );
    assert_eq!(std::fs::read(&file).unwrap(), before);
    let mut other = fixture.context.clone();
    other.agent_id = serde_json::from_value(json!("foreign")).unwrap();
    assert!(source.read_for(&other, &Cancel::never()).is_err());
    let cancel = Cancel::never();
    cancel.cancel();
    assert!(matches!(
        source.read_for(&fixture.context, &cancel),
        Err(EngineError::Cancelled(_))
    ));
    std::fs::rename(&root, fixture.root.path().join("old-neo")).unwrap();
    std::fs::create_dir(root).unwrap();
    assert!(source.read_for(&fixture.context, &Cancel::never()).is_err());
}
#[test]
fn source_bounds_to_one_hundred_latest_records_and_skips_ambiguous_json() {
    let fixture = Fixture::new(false);
    let (root, file, pattern) = setup(&fixture);
    let mut rows = Vec::new();
    for index in 0..110 {
        let mut p = pattern.clone();
        p["id"] = json!(format!("pattern-{index}"));
        p["createdAt"] = json!(index);
        rows.push(p);
    }
    write(&file, &rows);
    let source = BoundPatternSource::open(&root, &fixture.context).unwrap();
    let actual = source.read_for(&fixture.context, &Cancel::never()).unwrap();
    assert_eq!(actual, rows[10..]);
    let ambiguous = pattern
        .to_string()
        .replace("\"confidence\":1", "\"confidence\":1,\"confidence\":1");
    std::fs::write(&file, &ambiguous).unwrap();
    assert!(source
        .read_for(&fixture.context, &Cancel::never())
        .unwrap()
        .is_empty());
    assert_eq!(std::fs::read_to_string(file).unwrap(), ambiguous);
}
fn add_second(fixture: &Fixture) {
    let mut row = fixture.store.get("visible").unwrap().unwrap();
    row.id = "second".into();
    row.text = "Second synthetic fixture".into();
    fixture.store.upsert(&[row]).unwrap();
}
#[test]
fn actual_runtime_uses_authorized_patterns_and_discards_caller_snapshot_fallback() {
    let fixture = Fixture::new(false);
    add_second(&fixture);
    let (root, file, pattern) = setup(&fixture);
    write(&file, std::slice::from_ref(&pattern));
    let source = BoundPatternSource::open(&root, &fixture.context).unwrap();
    let cancel = Cancel::never();
    let mut request = fixture.request(&cancel);
    request.pattern_source = Some(&source);
    request.render.config =
        json!({"recall":{"dedup":false},"continuityEngine":{"tasteGate":{"enabled":false}}});
    let mut fallback = pattern;
    fallback["patternName"] = json!("Untrusted fallback");
    request.render.patterns = vec![fallback];
    let result = plur1bus_engine::recall::runtime::run(request)
        .unwrap()
        .to_json_line()
        .unwrap();
    assert!(result.contains("Observed fixture pattern"), "{result}");
    assert!(!result.contains("Untrusted fallback"));
    std::fs::write(file, "").unwrap();
    let mut request = fixture.request(&cancel);
    request.pattern_source = Some(&source);
    let result = plur1bus_engine::recall::runtime::run(request)
        .unwrap()
        .to_json_line()
        .unwrap();
    assert!(!result.contains("Observed fixture pattern"));
}
#[test]
fn runtime_refuses_source_failure_but_does_not_read_disabled_patterns() {
    let fixture = Fixture::new(false);
    let (root, file, pattern) = setup(&fixture);
    write(&file, &[pattern]);
    let source = BoundPatternSource::open(&root, &fixture.context).unwrap();
    std::fs::rename(&root, fixture.root.path().join("old-neo")).unwrap();
    std::fs::create_dir(root).unwrap();
    let cancel = Cancel::never();
    let mut request = fixture.request(&cancel);
    request.pattern_source = Some(&source);
    assert!(plur1bus_engine::recall::runtime::run(request).is_err());
    let mut request = fixture.request(&cancel);
    request.pattern_source = Some(&source);
    request.render.config = json!({"continuityEngine":{"patternSurfacing":{"enabled":false}}});
    assert!(plur1bus_engine::recall::runtime::run(request).is_ok());
}

#[test]
fn global_user_patterns_cross_agents_but_never_cross_users() {
    let mut fixture = Fixture::new(false);
    let owner = plur1bus_engine::context::principal_key("telegram", "fixture", "owner");
    let principal: Principal = serde_json::from_value(json!({"agentId":"agent","workspace":"workspace:v1:agent-private",
        "user":owner,"channel":"telegram","accountId":"fixture","chat":{"id":"owner","kind":"direct"},"trust":"proved"})).unwrap();
    let agent: AgentContext =
        serde_json::from_value(json!({"origin":"user","background":false})).unwrap();
    fixture.context = RequestContext::build(
        &principal,
        &agent,
        &support::TestHost::new(fixture.root.path().to_owned()),
    )
    .unwrap();
    let (root, file, mut shared) = setup(&fixture);
    shared["scope"] = json!("global_user");
    shared["agentId"] = json!("other-agent");
    shared["ownerUserId"] = json!(fixture.context.owner_user_id);
    let mut foreign = shared.clone();
    foreign["id"] = json!("foreign");
    foreign["ownerUserId"] = json!(plur1bus_engine::context::principal_key(
        "telegram", "fixture", "foreign"
    ));
    write(&file, &[shared.clone(), foreign]);
    let source = BoundPatternSource::open(&root, &fixture.context).unwrap();
    assert_eq!(
        source.read_for(&fixture.context, &Cancel::never()).unwrap(),
        vec![shared]
    );
}
#[test]
fn cancellation_after_namespace_selection_skips_patterns_and_preserves_degradation() {
    let fixture = Fixture::new(false);
    add_second(&fixture);
    let (root, file, pattern) = setup(&fixture);
    write(&file, std::slice::from_ref(&pattern));
    let source = BoundPatternSource::open(&root, &fixture.context).unwrap();
    std::fs::rename(&root, fixture.root.path().join("old-neo")).unwrap();
    std::fs::create_dir(root).unwrap();
    let cancel = Cancel::never();
    let filter = AbortFilter(cancel.clone());
    let ranker = AbortRanker {
        caller: cancel.clone(),
        calls: AtomicUsize::new(0),
    };
    let mut request = fixture.request(&cancel);
    request.pipeline.reranker = Some(&ranker);
    request.pattern_source = Some(&source);
    request.filter = Some(&filter);
    request.render.patterns = vec![pattern];
    let result = plur1bus_engine::recall::runtime::run(request).unwrap();
    assert!(cancel.is_cancelled());
    assert_eq!(ranker.calls.load(Ordering::SeqCst), 0);
    assert_eq!(
        result.degraded,
        Some(json!({"reason":"aborted","capability":"recall"}))
    );
    assert!(!result
        .to_json_line()
        .unwrap()
        .contains("Observed fixture pattern"));
}
#[test]
fn native_source_marker_binds_unchanged_node_metadata_and_render_references() {
    use sha2::{Digest, Sha256};
    let marker: Value = serde_json::from_str(include_str!(
        "../fixtures/recall/pattern-source-native-exceptions.json"
    ))
    .unwrap();
    assert_eq!(
        format!(
            "{:x}",
            Sha256::digest(include_bytes!("../fixtures/capture/golden/neo-merged.json"))
        ),
        marker["metadataGoldenSha256"]
    );
    assert_eq!(
        format!(
            "{:x}",
            Sha256::digest(include_bytes!(
                "../fixtures/recall/golden/render/render-plain.json"
            ))
        ),
        marker["renderGoldenSha256"]
    );
}
