//! Real shared routing, read-only acquisition and explicit provenance migration.
#![allow(clippy::unwrap_used, reason = "isolated physical store assertions")]
#[path = "recall_support.rs"]
mod support;
use plur1bus_engine::{
    context::{harness_user_principal, RequestContext},
    contract::MemoryShareTarget,
    embedding::EmbeddingProvider,
    recall::hash_embed::HashEmbedder,
    store::{shared_pool::SharedPool, OpenMode, RowFilter, Store},
};
use serde_json::{json, Value};
use std::{path::Path, sync::Arc};
fn context(root: &Path, user: &str, workspace: &str) -> RequestContext {
    let host = support::TestHost::new(root.join("state"));
    let p = serde_json::from_value(json!({"agentId":"alpha","workspace":workspace,"user":harness_user_principal(user),"channel":"telegram","accountId":"fixture","chat":{"id":"fixture","kind":"direct"},"trust":"proved"})).unwrap();
    let a = serde_json::from_value(json!({"origin":"user","background":false})).unwrap();
    RequestContext::build(&p, &a, &host).unwrap()
}
fn golden() -> Value {
    serde_json::from_str(include_str!("fixtures/ops/golden/shared-routes.json")).unwrap()
}
#[test]
fn real_pools_follow_recorded_node_paths_and_never_create_on_read() {
    let root = support::canonical_tempdir();
    let base = root.path().join("db");
    let g = golden();
    let ctx = context(
        root.path(),
        "fixture",
        g["context"]["workspaceIdentity"].as_str().unwrap(),
    );
    let pool = SharedPool::open(&base, HashEmbedder::new().identity(), 2).unwrap();
    assert!(pool
        .existing(&ctx, MemoryShareTarget::Workspace)
        .unwrap()
        .is_none());
    assert!(!base.exists());
    let writer = pool.writable(&ctx, MemoryShareTarget::Workspace).unwrap();
    assert!(Arc::ptr_eq(
        &writer,
        &pool.writable(&ctx, MemoryShareTarget::Workspace).unwrap()
    ));
    assert!(base
        .join(g["expected"]["workspacePath"].as_str().unwrap())
        .join("memories.lance")
        .exists());
    assert!(pool
        .existing(&ctx, MemoryShareTarget::User)
        .unwrap()
        .is_none());
    let user = pool.writable(&ctx, MemoryShareTarget::User).unwrap();
    assert!(base
        .join(g["expected"]["userPath"].as_str().unwrap())
        .join("memories.lance")
        .exists());
    let other = context(root.path(), "different-fixture", &ctx.workspace_id);
    assert!(pool
        .existing(&other, MemoryShareTarget::User)
        .unwrap()
        .is_none());
    let same = context(root.path(), "fixture", "workspace:v1:another");
    assert!(Arc::ptr_eq(
        &user,
        &pool.writable(&same, MemoryShareTarget::User).unwrap()
    ));
}
#[test]
fn existing_legacy_read_does_not_migrate_and_writer_retains_stored_identity() {
    let root = support::canonical_tempdir();
    let base = root.path().join("db");
    let g = golden();
    let ctx = context(
        root.path(),
        "fixture",
        g["context"]["workspaceIdentity"].as_str().unwrap(),
    );
    let path = base.join(g["expected"]["workspacePath"].as_str().unwrap());
    let active = HashEmbedder::new().identity().clone();
    let mut old = active.clone();
    old.model = "retained-shared-model".into();
    drop(Store::create(&path, &old, 384).unwrap());
    let pool = SharedPool::open(&base, &active, 2).unwrap();
    let read = pool
        .existing(&ctx, MemoryShareTarget::Workspace)
        .unwrap()
        .unwrap();
    assert!(read
        .arrow_schema()
        .field_with_name("shareProvenance")
        .is_err());
    drop(read);
    let write = pool.writable(&ctx, MemoryShareTarget::Workspace).unwrap();
    assert_eq!(write.identity().unwrap().model, "retained-shared-model");
    assert!(write
        .arrow_schema()
        .field_with_name("shareProvenance")
        .is_ok());
    assert_eq!(write.count(&RowFilter::default()).unwrap(), 0);
}
#[test]
fn replaced_shared_root_refuses_new_and_retained_handles() {
    let root = support::canonical_tempdir();
    let base = root.path().join("db");
    let ctx = context(
        root.path(),
        "fixture",
        "workspace:v1:shared-routing-fixture",
    );
    let pool = SharedPool::open(&base, HashEmbedder::new().identity(), 2).unwrap();
    let held = pool.writable(&ctx, MemoryShareTarget::Workspace).unwrap();
    let shared = base.join(".plur1bus-shared");
    let displaced = base.join("displaced");
    std::fs::rename(&shared, &displaced).unwrap();
    std::fs::create_dir(&shared).unwrap();
    std::fs::rename(displaced.join("workspaces"), shared.join("workspaces")).unwrap();
    assert!(pool.existing(&ctx, MemoryShareTarget::Workspace).is_err());
    assert!(held.count(&RowFilter::default()).is_err());
    assert!(!pool.supported());
    std::fs::rename(shared.join("workspaces"), displaced.join("workspaces")).unwrap();
    std::fs::remove_dir(&shared).unwrap();
    std::fs::rename(&displaced, &shared).unwrap();
    assert!(pool.writable(&ctx, MemoryShareTarget::Workspace).is_err());
}
#[test]
fn explicit_shared_migration_resumes_only_missing_columns() {
    let root = support::canonical_tempdir();
    let mut identity = HashEmbedder::new().identity().clone();
    identity.dimension = 4.into();
    let path = root.path().join("shared");
    let fixture: Value =
        serde_json::from_str(include_str!("fixtures/ops/golden/shared-store.json")).unwrap();
    let mut value = fixture["expected"]["row"].clone();
    value["id"] = json!("00000000-0000-4000-8000-000000000002");
    let mut card = value.clone();
    for field in [
        "sourceMemoryId",
        "sourceAgentId",
        "shareIdempotencyKey",
        "shareProvenance",
    ] {
        card.as_object_mut().unwrap().remove(field);
    }
    let row = serde_json::from_value(card).unwrap();
    let sharing = serde_json::from_value(value.clone()).unwrap();
    let original = Store::create_shared(&path, &identity, 4).unwrap();
    original
        .upsert_shared(&[(row, sharing)], root.path())
        .unwrap();
    drop(original);
    let runtime = tokio::runtime::Runtime::new().unwrap();
    runtime.block_on(async {
        let db = lancedb::connect(path.to_str().unwrap())
            .execute()
            .await
            .unwrap();
        let table = db.open_table("memories").execute().await.unwrap();
        table
            .drop_columns(&["sourceAgentId", "shareProvenance"])
            .await
            .unwrap();
    });
    assert!(Store::open(&path, OpenMode::ReadOnly, None).is_err());
    let mut store = Store::open_shared_write(&path).unwrap();
    store.ensure_shared_columns().unwrap();
    store.ensure_shared_columns().unwrap();
    let repaired = store
        .get_record(value["id"].as_str().unwrap())
        .unwrap()
        .unwrap();
    let sharing = repaired.sharing.unwrap();
    assert_eq!(
        sharing.source_memory_id,
        value["sourceMemoryId"].as_str().unwrap()
    );
    assert_eq!(
        sharing.share_idempotency_key,
        value["shareIdempotencyKey"].as_str().unwrap()
    );
    assert_eq!(repaired.row.text, value["text"].as_str().unwrap());
    assert_eq!(sharing.source_agent_id, "");
    assert_eq!(sharing.share_provenance, "{}");
    assert!(store
        .has_live_shared_origin(&sharing.source_memory_id, "agent")
        .is_err());
    assert!(!store
        .has_live_shared_origin("00000000-0000-4000-8000-000000000099", "agent")
        .unwrap());
    store
        .patch(
            value["id"].as_str().unwrap(),
            &plur1bus_engine::store::RowPatch {
                status: Some("deleted".into()),
                ..Default::default()
            },
        )
        .unwrap();
    assert!(!store
        .has_live_shared_origin(&sharing.source_memory_id, "agent")
        .unwrap());
    let names: Vec<_> = store
        .arrow_schema()
        .fields()
        .iter()
        .map(|f| f.name())
        .filter(|s| {
            [
                "sourceMemoryId",
                "sourceAgentId",
                "shareIdempotencyKey",
                "shareProvenance",
            ]
            .contains(&s.as_str())
        })
        .cloned()
        .collect();
    assert_eq!(
        serde_json::to_value(names).unwrap(),
        golden()["expected"]["repairedColumns"]
    );
}

#[cfg(unix)]
#[test]
fn shared_root_permissions_are_never_silently_repaired_or_ignored_by_cached_writes() {
    use std::os::unix::fs::PermissionsExt;
    for cached in [false, true] {
        let root = support::canonical_tempdir();
        let base = root.path().join("db");
        let ctx = context(root.path(), "fixture", "workspace:v1:fixture");
        let pool = SharedPool::open(&base, HashEmbedder::new().identity(), 2).unwrap();
        if cached {
            let _ = pool.writable(&ctx, MemoryShareTarget::User).unwrap();
        }
        let shared = base.join(".plur1bus-shared");
        std::fs::create_dir_all(&shared).unwrap();
        std::fs::set_permissions(&shared, std::fs::Permissions::from_mode(0o755)).unwrap();
        assert!(pool.writable(&ctx, MemoryShareTarget::User).is_err());
        assert_eq!(
            std::fs::metadata(&shared).unwrap().permissions().mode() & 0o777,
            0o755
        );
    }
}

#[test]
fn composed_memory_ports_order_real_sources_and_unimport_never_creates_shared_pools() {
    use plur1bus_engine::{
        ops::{
            import::ImportStores,
            memory::{ReadStores, SourceKind},
            private_routes::PrivateMemoryStores,
            routes::MemoryStores,
            sharing::SharedStores,
            unimport::UnimportStores,
        },
        recall::namespaces::NamespaceStores,
    };
    let root = support::canonical_tempdir();
    let base = root.path().join("db");
    let identity = HashEmbedder::new().identity().clone();
    let private = PrivateMemoryStores::new(Arc::new(
        NamespaceStores::open(
            &base,
            &serde_json::from_value(json!({})).unwrap(),
            &identity,
            2,
        )
        .unwrap(),
    ));
    let stores = MemoryStores::new(
        private,
        Arc::new(SharedPool::open(&base, &identity, 2).unwrap()),
    );
    let ctx = context(root.path(), "fixture", "workspace:v1:fixture");
    assert!(stores.sources(&ctx).unwrap().is_empty());
    assert!(stores.shared_pools(&ctx).unwrap().is_empty());
    assert!(!base.exists());
    let _private = ImportStores::writable(&stores, &ctx).unwrap();
    let _workspace = stores.target(&ctx, MemoryShareTarget::Workspace).unwrap();
    let _user = stores.target(&ctx, MemoryShareTarget::User).unwrap();
    let sources = stores.sources(&ctx).unwrap();
    assert_eq!(
        sources.iter().map(|s| s.kind).collect::<Vec<_>>(),
        vec![SourceKind::Private, SourceKind::Workspace, SourceKind::User]
    );
    assert!(!sources[0].optional && sources[1].optional && sources[2].optional);
    let shared = stores.shared_pools(&ctx).unwrap();
    assert_eq!(shared.len(), 2);
    assert!(shared[0].patch("missing", &Default::default()).is_err());
    assert!(Arc::ptr_eq(&shared[0], &sources[1].store));
}

#[test]
fn stronger_native_failures_are_bound_to_the_unmodified_node_observations() {
    use sha2::{Digest, Sha256};
    let bytes = include_bytes!("fixtures/ops/golden/shared-routes.json");
    let marker: Value = serde_json::from_str(include_str!(
        "fixtures/ops/shared-routes-native-exceptions.json"
    ))
    .unwrap();
    assert_eq!(
        marker["goldenSha256"],
        format!("{:x}", Sha256::digest(bytes))
    );
    let observed = golden();
    assert_eq!(observed["expected"]["partialReadCount"], 0);
    assert!(observed["expected"]["taintedRead"].is_null());
    assert_eq!(observed["expected"]["permissions"][1]["writeAllowed"], true);
    assert_eq!(marker["ruling"], "RE-D127");
}
