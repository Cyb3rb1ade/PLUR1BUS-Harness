//! Actual Neo files and Lance rows at the graph-to-namespace boundary.
use super::*;
use plur1bus_engine::neo::merged::Layout;
use plur1bus_engine::recall::graph_source::BoundGraphSource;
use serde_json::Value;
use std::path::PathBuf;

const FIRST: &str = "11111111-1111-4111-8111-111111111111";
const SECOND: &str = "22222222-2222-4222-8222-222222222222";
struct Fixture {
    _root: tempfile::TempDir,
    neo: PathBuf,
    file: PathBuf,
    context: RequestContext,
    store: Store,
    embedder: Flat,
}
impl Fixture {
    fn new() -> Self {
        let root = support::canonical_tempdir();
        let host = TestHost::new(root.path().to_owned());
        let context = context(&host);
        let neo = root.path().join("neo");
        let directory = neo
            .join("workspaces")
            .join(Layout::for_key(&context.workspace_key).canonical);
        std::fs::create_dir_all(&directory).unwrap();
        let embedder = Flat::new();
        let store = Store::create(
            &root.path().join("store"),
            embedder.identity(),
            HASH_DIMENSION,
        )
        .unwrap();
        for id in [FIRST, SECOND] {
            let mut item = row(id, "owner", "agent-private");
            item.owner_user_id = context.owner_user_id.clone();
            item.workspace_id = context.workspace_key.clone();
            item.workspace_key = context.workspace_key.clone();
            store.upsert(&[item]).unwrap();
        }
        Self {
            _root: root,
            neo,
            file: directory.join("memory-graph.jsonl"),
            context,
            store,
            embedder,
        }
    }
    fn source(&self) -> BoundGraphSource {
        BoundGraphSource::open(&self.neo, &self.context).unwrap()
    }
    fn edge(&self, recorded: &Value) -> Value {
        let golden: Value =
            serde_json::from_str(include_str!("../fixtures/ops/golden/graph-ownership.json"))
                .unwrap();
        let mut edge = recorded.clone();
        edge["id"] = json!("edge");
        edge["createdAt"] = json!(1000);
        edge["source"] = json!(FIRST);
        edge["target"] = json!(SECOND);
        edge["scope"] = json!("agent_private");
        edge["agentId"] = json!("owner");
        edge["ownerUserId"] = json!(self.context.owner_user_id);
        edge["workspaceIdentity"] = json!(self.context.workspace_key);
        for path in [
            "/sourceOwnership",
            "/targetOwnership",
            "/ownership/source",
            "/ownership/target",
        ] {
            if let Some(tuple) = edge.pointer_mut(path).filter(|v| v.is_object()) {
                if tuple["agentId"] == golden["context"]["agentId"] {
                    tuple["agentId"] = json!("owner");
                }
                if tuple["workspaceIdentity"] == golden["context"]["workspaceIdentity"] {
                    tuple["workspaceIdentity"] = json!(self.context.workspace_key);
                }
                if tuple["ownerUserId"] == golden["context"]["userPrincipal"] {
                    tuple["ownerUserId"] = json!(self.context.owner_user_id);
                }
            }
        }
        edge
    }
    fn valid(&self) -> Value {
        let golden: Value =
            serde_json::from_str(include_str!("../fixtures/ops/golden/graph-ownership.json"))
                .unwrap();
        self.edge(&golden["cases"][0]["input"])
    }
    fn write(&self, edge: &Value) {
        std::fs::write(&self.file, format!("{edge}\n")).unwrap();
    }
    fn read(&self, source: &BoundGraphSource) -> Vec<plur1bus_engine::recall::graph::GraphEdge> {
        source
            .read_for(&self.store, &self.context, 1000, None, &Cancel::never())
            .unwrap()
    }
}

#[test]
fn graph_source_checks_all_recorded_endpoint_claims_against_actual_rows() {
    use sha2::{Digest, Sha256};
    let marker: Value = serde_json::from_str(include_str!(
        "../fixtures/ops/recall-graph-native-exceptions.json"
    ))
    .unwrap();
    assert_eq!(
        format!(
            "{:x}",
            Sha256::digest(include_bytes!(
                "../fixtures/ops/golden/graph-ownership.json"
            ))
        ),
        marker["nodeGoldenSha256"]
    );
    let fixture = Fixture::new();
    let source = fixture.source();
    let golden: Value =
        serde_json::from_str(include_str!("../fixtures/ops/golden/graph-ownership.json")).unwrap();
    for case in golden["cases"].as_array().unwrap() {
        fixture.write(&fixture.edge(&case["input"]));
        let edges = fixture.read(&source);
        assert_eq!(
            edges.len(),
            usize::from(
                marker["nativeAllowedCases"]
                    .as_array()
                    .unwrap()
                    .contains(&case["name"])
            ),
            "{}",
            case["name"]
        );
        if let Some(edge) = edges.first() {
            assert_eq!(edge.source, FIRST);
            assert_eq!(edge.target, SECOND);
            assert_eq!(edge.strength, 0.8);
        }
    }
}
#[test]
fn graph_source_checks_current_rows_and_never_reuses_another_tables_endpoints() {
    let fixture = Fixture::new();
    fixture.write(&fixture.valid());
    let source = fixture.source();
    assert_eq!(fixture.read(&source).len(), 1);
    let mut target = fixture.store.get(SECOND).unwrap().unwrap();
    target.owner_user_id = principal_key("telegram", "default", "someone-else");
    fixture.store.upsert(&[target.clone()]).unwrap();
    assert!(fixture.read(&source).is_empty());
    target.owner_user_id = fixture.context.owner_user_id.clone();
    target.status = "deleted".into();
    fixture.store.upsert(&[target.clone()]).unwrap();
    assert!(fixture.read(&source).is_empty());
    target.status = "active".into();
    target.valid_until = 500.into();
    fixture.store.upsert(&[target]).unwrap();
    assert!(source
        .read_for(
            &fixture.store,
            &fixture.context,
            1000,
            Some(1000),
            &Cancel::never()
        )
        .unwrap()
        .is_empty());
    let other = Store::create(
        &fixture._root.path().join("other"),
        fixture.embedder.identity(),
        HASH_DIMENSION,
    )
    .unwrap();
    assert!(source
        .read_for(&other, &fixture.context, 1000, None, &Cancel::never())
        .unwrap()
        .is_empty());
}
#[test]
fn graph_source_rejects_duplicate_claims_and_preserves_file_bytes() {
    let fixture = Fixture::new();
    let edge = fixture.valid().to_string();
    let ambiguous = edge.replace(
        "\"schemaVersion\":1",
        "\"schemaVersion\":1,\"schemaVersion\":1",
    );
    std::fs::write(&fixture.file, &ambiguous).unwrap();
    assert!(fixture.read(&fixture.source()).is_empty());
    assert_eq!(std::fs::read_to_string(&fixture.file).unwrap(), ambiguous);
}
#[test]
fn graph_source_binds_context_cancellation_and_physical_root() {
    let fixture = Fixture::new();
    fixture.write(&fixture.valid());
    let source = fixture.source();
    let mut other = fixture.context.clone();
    other.owner_user_id = principal_key("telegram", "default", "someone-else");
    assert!(source
        .read_for(&fixture.store, &other, 1000, None, &Cancel::never())
        .is_err());
    std::fs::rename(&fixture.neo, fixture._root.path().join("old-neo")).unwrap();
    std::fs::create_dir(&fixture.neo).unwrap();
    assert!(source
        .read_for(
            &fixture.store,
            &fixture.context,
            1000,
            None,
            &Cancel::never()
        )
        .is_err());
}
#[test]
fn namespace_pipeline_uses_bound_source_without_legacy_edge_fallback() {
    let fixture = Fixture::new();
    fixture.write(&fixture.valid());
    let source = fixture.source();
    let denials = Denials::default();
    let cancel = Cancel::never();
    let mut pipeline = pipeline(&fixture.context, &fixture.embedder, &denials, None, &cancel);
    pipeline.bound_graph = Some(&source);
    pipeline.flags.associative = true;
    assert!(pipeline
        .recall(
            None,
            &fixture.store,
            CanonicalSource::Skip,
            &RequestQueries::new("fixture")
        )
        .is_ok());
    std::fs::rename(&fixture.neo, fixture._root.path().join("old-neo")).unwrap();
    std::fs::create_dir(&fixture.neo).unwrap();
    assert!(pipeline
        .recall(
            None,
            &fixture.store,
            CanonicalSource::Skip,
            &RequestQueries::new("fixture")
        )
        .is_err());
}

#[test]
fn private_graph_cannot_claim_another_users_actual_private_row() {
    let fixture = Fixture::new();
    let foreign = principal_key("telegram", "default", "someone-else");
    let mut edge = fixture.valid();
    edge["sourceOwnership"]["ownerUserId"] = json!(foreign);
    edge["ownership"]["source"]["ownerUserId"] = json!(foreign);
    let mut first = fixture.store.get(FIRST).unwrap().unwrap();
    first.owner_user_id = foreign;
    fixture.store.upsert(&[first]).unwrap();
    fixture.write(&edge);
    assert!(fixture.read(&fixture.source()).is_empty());
}

#[test]
fn newest_hidden_or_unbound_revision_does_not_restore_an_older_edge() {
    let fixture = Fixture::new();
    let first = fixture.valid();
    for hidden in [false, true] {
        let mut last = first.clone();
        last["createdAt"] = json!(2000);
        if hidden {
            last["ownerUserId"] = json!(principal_key("telegram", "default", "other"));
        } else {
            last["ownershipStatus"] = json!("unbound");
        }
        std::fs::write(&fixture.file, format!("{first}\n{last}\n")).unwrap();
        assert!(fixture.read(&fixture.source()).is_empty());
    }
}
#[test]
fn graph_source_cancellation_and_traversal_bound_are_explicit() {
    let fixture = Fixture::new();
    let mut lines = String::new();
    for index in 0..450 {
        let mut edge = fixture.valid();
        edge["id"] = json!(format!("edge-{index}"));
        edge["createdAt"] = json!(index + 1);
        lines.push_str(&format!("{edge}\n"));
    }
    std::fs::write(&fixture.file, lines).unwrap();
    let source = fixture.source();
    assert_eq!(fixture.read(&source).len(), 400);
    let cancel = Cancel::never();
    cancel.cancel();
    assert!(matches!(
        source.read_for(&fixture.store, &fixture.context, 1000, None, &cancel),
        Err(StageError::Embed(EmbedError::Cancelled(_)))
    ));
}
struct ReplacingProvider<'a> {
    flat: &'a Flat,
    root: &'a std::path::Path,
    moved: PathBuf,
}
impl EmbeddingProvider for ReplacingProvider<'_> {
    fn identity(&self) -> &plur1bus_engine::contract::VectorSpaceIdentity {
        self.flat.identity()
    }
    fn embed(
        &self,
        texts: &[String],
        kind: EmbedKind,
        cancel: &Cancel,
    ) -> Result<Vec<Vec<f32>>, EmbedError> {
        if kind == EmbedKind::Query {
            std::fs::rename(self.root, &self.moved).unwrap();
            std::fs::create_dir(self.root).unwrap();
        }
        self.flat.embed(texts, kind, cancel)
    }
}
#[test]
fn graph_source_is_read_after_provider_callbacks() {
    let fixture = Fixture::new();
    fixture.write(&fixture.valid());
    let source = fixture.source();
    let provider = ReplacingProvider {
        flat: &fixture.embedder,
        root: &fixture.neo,
        moved: fixture._root.path().join("old-neo"),
    };
    let denials = Denials::default();
    let cancel = Cancel::never();
    let mut pipeline = pipeline(&fixture.context, &provider, &denials, None, &cancel);
    pipeline.bound_graph = Some(&source);
    pipeline.flags.associative = true;
    assert!(pipeline
        .recall(
            None,
            &fixture.store,
            CanonicalSource::Skip,
            &RequestQueries::new("fixture")
        )
        .is_err());
    assert!(provider.moved.exists());
}
