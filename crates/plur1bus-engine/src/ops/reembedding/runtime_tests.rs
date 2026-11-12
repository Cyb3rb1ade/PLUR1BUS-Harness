#![allow(
    clippy::unwrap_used,
    reason = "concrete host/provider runtime tests with network-denying ports"
)]
use super::*;
use crate::contract::*;
use std::sync::atomic::{AtomicUsize, Ordering};
struct Host {
    root: PathBuf,
    config: EngineConfig,
    platform: PlatformCapabilities,
    decisions: AtomicUsize,
}
impl EgressGate for Host {
    fn decide(&self, _: &Target) -> Decision {
        self.decisions.fetch_add(1, Ordering::SeqCst);
        Decision::Deny {
            reason: "test denies all network".into(),
        }
    }
}
impl HostServices for Host {
    fn state_dir(&self) -> &Path {
        &self.root
    }
    fn config(&self) -> EngineConfig {
        self.config.clone()
    }
    fn workspace_dir(&self, _: &AgentId) -> Result<Option<PathBuf>, HostError> {
        Ok(None)
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
    fn emit(&self, _: &str, _: Value) {}
    fn now_ms(&self) -> i64 {
        1234
    }
    fn platform(&self) -> &PlatformCapabilities {
        &self.platform
    }
    fn journal_backlog(&self) -> Option<JournalBacklog> {
        None
    }
}
fn root() -> tempfile::TempDir {
    tempfile::tempdir_in(std::fs::canonicalize(std::env::temp_dir()).unwrap()).unwrap()
}
fn setup(root: &Path) -> (NativeRuntime, Arc<Host>) {
    let config=crate::config::validate(&json!({"baseDbPath":root.join("active"),"embedding":{"provider":"openai","model":"synthetic-source","dimensions":3}})).unwrap();
    let host = Arc::new(Host {
        root: root.join("host"),
        config,
        platform: PlatformCapabilities::default(),
        decisions: AtomicUsize::new(0),
    });
    let backend=Arc::new(GenerationBackend::new(super::super::backend::BackendConfig{
        state_root:root.join("state"),active_root:root.join("active"),active_shared_base:root.join("active"),namespace:None,active_generation:"active".into(),active_selection:json!({"mode":"generation","generation":"active"}),active_fingerprint:json!({"provider":"openai","model":"synthetic-source","dimensions":3}),active_secret_ref:None,config_revision:None,
    }).unwrap());
    (
        NativeRuntime::new(host.clone(), backend, &root.join("state")).unwrap(),
        host,
    )
}
#[test]
fn real_runtime_reads_capacity_policy_and_missing_artifacts_without_creating_state() {
    let root = root();
    let (runtime, host) = setup(root.path());
    let cancel = Cancel::never();
    assert_eq!(runtime.now_ms(), 1234);
    assert!(runtime.free_bytes(&cancel).unwrap() > 0);
    assert_eq!(
        write_json(&runtime.policy_snapshot(&cancel).unwrap().unwrap()),
        "[]"
    );
    let model = "intfloat/multilingual-e5-small";
    let profile = embedding::artifacts::pinned_profile(model, None).unwrap();
    let fp=raw(&json!({"provider":"local-transformers","model":model,"revision":profile.revision,"dimensions":384})).unwrap();
    assert!(!runtime.artifacts_verified(&fp, &cancel).unwrap());
    assert!(!host.root.exists());
    assert!(!root.path().join("state").exists());
    assert!(!root.path().join("active").exists());
    assert_eq!(host.decisions.load(Ordering::SeqCst), 0);
    let cancelled = Cancel::never();
    cancelled.cancel();
    assert_eq!(runtime.free_bytes(&cancelled), Err(Error::Cancelled));
    assert_eq!(runtime.policy_snapshot(&cancelled), Err(Error::Cancelled));
    let policy = PolicyStore::new(&root.path().join("state")).unwrap();
    // The actual persisted policy, not an empty runtime substitute, drives subsequent snapshots.
    policy.set(&json!({"agentId":"agent-a","workspaceIdentity":"workspace:v1:synthetic","enabled":false,"expectedRevision":0,"actorId":"synthetic-operator"}),1234).unwrap();
    let disabled = value(&runtime.policy_snapshot(&cancel).unwrap().unwrap()).unwrap();
    assert_eq!(disabled.as_array().unwrap().len(), 1);
    assert_eq!(disabled[0]["enabled"], false);
    policy.set(&json!({"agentId":"agent-a","workspaceIdentity":"workspace:v1:synthetic","enabled":true,"expectedRevision":1,"actorId":"synthetic-operator"}),1235).unwrap();
    let enabled = value(&runtime.policy_snapshot(&cancel).unwrap().unwrap()).unwrap();
    assert_eq!(enabled[0]["enabled"], true);
    assert_ne!(enabled, disabled);
    std::fs::create_dir_all(root.path().join("state/control")).unwrap();
    std::fs::write(
        root.path().join("state/control/workspace-policy.json"),
        b"invalid state",
    )
    .unwrap();
    assert!(policy.list().is_err());
    assert_eq!(runtime.policy_snapshot(&cancel), Err(Error::Host));
}
#[test]
fn actual_remote_factory_preserves_identity_and_releases_its_owned_lease() {
    let root = root();
    let (runtime, host) = setup(root.path());
    let cancel = Cancel::never();
    let fp = embedding::fingerprint::normalize_fingerprint(
        &json!({"provider":"openai","model":"synthetic-target","dimensions":3}),
        &json!([]),
    )
    .unwrap();
    let provider = runtime
        .create_provider(&raw(&json!({"fingerprint":fp})).unwrap(), &cancel)
        .unwrap();
    let expected = embedding::identity::identity_from_value(&fp).unwrap();
    assert_eq!(
        crate::store::identity::identity_id(provider.identity()).unwrap(),
        crate::store::identity::identity_id(&expected).unwrap()
    );
    assert_eq!(host.decisions.load(Ordering::SeqCst), 0);
    assert!(!host.root.exists());
    provider.close().unwrap();
    provider.close().unwrap();
    assert_eq!(
        provider.embed(&["synthetic".into()], EmbedKind::Query, &cancel),
        Err(Error::Closed)
    );
    let cancelled = Cancel::never();
    cancelled.cancel();
    assert!(matches!(
        runtime.create_provider(&raw(&json!({"fingerprint":fp})).unwrap(), &cancelled),
        Err(Error::Cancelled)
    ));
}
#[test]
fn local_target_configuration_round_trip_keeps_max_tokens_and_owned_cache() {
    let root = root();
    let (runtime, host) = setup(root.path());
    let raw_config = json!({"provider":"local-transformers","local":{"model":"intfloat/multilingual-e5-small","maxTokens":256,"cacheDir":host.root.join("models")}});
    let normalized = embedding::normalize::normalize_embedding_config(&raw_config).unwrap();
    let fp = embedding::fingerprint::fingerprint_from_normalized(&normalized).unwrap();
    let specification = json!({"fingerprint":fp});
    let (config, cache) = runtime.projected_config(&specification).unwrap();
    let projected = serde_json::to_value(&config).unwrap();
    assert_eq!(projected["embedding"]["local"]["maxTokens"], 256);
    assert_eq!(cache, host.root.join("models"));
    let provider = runtime
        .create_provider(&raw(&specification).unwrap(), &Cancel::never())
        .unwrap();
    assert_eq!(
        crate::store::identity::identity_id(provider.identity()).unwrap(),
        crate::store::identity::identity_id(
            &embedding::identity::identity_from_value(&fp).unwrap()
        )
        .unwrap()
    );
    provider.close().unwrap();
    assert!(!cache.exists());
    assert_eq!(host.decisions.load(Ordering::SeqCst), 0);
}
struct DroppedProvider {
    identity: VectorSpaceIdentity,
    dropped: Arc<AtomicUsize>,
}
impl Drop for DroppedProvider {
    fn drop(&mut self) {
        self.dropped.fetch_add(1, Ordering::SeqCst);
    }
}
impl EmbeddingProvider for DroppedProvider {
    fn identity(&self) -> &VectorSpaceIdentity {
        &self.identity
    }
    fn embed(
        &self,
        texts: &[String],
        _: EmbedKind,
        _: &Cancel,
    ) -> Result<Vec<Vec<f32>>, EmbedError> {
        Ok(texts.iter().map(|_| vec![0.1, 0.2, 0.3]).collect())
    }
}
#[test]
fn lease_widens_actual_float32_values_and_drops_provider_exactly_once() {
    let dropped = Arc::new(AtomicUsize::new(0));
    let identity = embedding::identity::identity_from_value(
        &json!({"provider":"openai","model":"synthetic","dimensions":3}),
    )
    .unwrap();
    let lease = ProviderLease::new(Box::new(DroppedProvider {
        identity,
        dropped: dropped.clone(),
    }));
    let vectors = lease
        .embed(&["synthetic".into()], EmbedKind::Passage, &Cancel::never())
        .unwrap();
    assert_eq!(
        vectors,
        vec![vec![
            f64::from(0.1f32),
            f64::from(0.2f32),
            f64::from(0.3f32)
        ]]
    );
    assert_eq!(dropped.load(Ordering::SeqCst), 0);
    lease.close().unwrap();
    lease.close().unwrap();
    drop(lease);
    assert_eq!(dropped.load(Ordering::SeqCst), 1);
}
#[cfg(unix)]
#[test]
fn capacity_refuses_links_without_following_them() {
    let root = root();
    let path = root.path().join("linked");
    std::os::unix::fs::symlink(root.path(), &path).unwrap();
    assert_eq!(
        available_bytes(&path.join("missing"), &Cancel::never()),
        Err(Error::Host)
    );
}

#[test]
fn actual_node_local_identity_discrepancy_is_bound_only_for_explicit_matching_plans() {
    let fixture: Value = serde_json::from_str(include_str!(
        "../../../tests/fixtures/ops/golden/reembedding-provider-identity.json"
    ))
    .unwrap();
    let root = root();
    let (runtime, host) = setup(root.path());
    assert_eq!(fixture["cases"].as_array().unwrap().len(), 6);
    for case in fixture["cases"].as_array().unwrap() {
        let target = json!({"fingerprint":case["fingerprint"]});
        let (config, _) = runtime.projected_config(&target).unwrap();
        let legacy = embedding::build_embedding_owned(&config, host.clone()).unwrap();
        assert_eq!(
            serde_json::to_value(legacy.identity()).unwrap(),
            case["actualIdentity"]
        );
        let bound =
            embedding::planned::build_for_fingerprint(&config, host.clone(), &case["fingerprint"])
                .unwrap();
        assert_eq!(
            serde_json::to_value(bound.identity()).unwrap(),
            case["plannedIdentity"]
        );
        assert_eq!(
            crate::store::identity::identity_id(bound.identity()).unwrap(),
            case["plannedId"]
        );
        if case.get("rustException").is_some() {
            assert_ne!(case["plannedId"], case["actualId"]);
        } else {
            assert_eq!(case["plannedId"], case["actualId"]);
        }
        let mut wrong = case["fingerprint"].clone();
        wrong["dimensions"] = json!(1);
        assert!(embedding::planned::build_for_fingerprint(&config, host.clone(), &wrong).is_err());
        drop(bound);
        drop(legacy);
    }
    assert!(!host.root.exists());
    assert_eq!(host.decisions.load(Ordering::SeqCst), 0);
}
