//! Real namespace pools backing the native private memory ports, without implicit creation.
#![allow(clippy::unwrap_used, reason = "isolated physical store assertions")]
#[path = "recall_support.rs"]
mod support;
use plur1bus_engine::{
    context::{harness_user_principal, RequestContext},
    contract::{EngineConfig, StoreError},
    embedding::EmbeddingProvider,
    ops::{
        import::ImportStores,
        memory::{ReadStores, SourceKind},
        private_routes::PrivateMemoryStores,
        rebind::RebindStores,
        write::MutationStores,
    },
    recall::{
        hash_embed::{HashEmbedder, HASH_DIMENSION},
        namespaces::NamespaceStores,
    },
    store::{RowPatch, Store},
};
use serde_json::json;
use std::{path::Path, sync::Arc};

fn context(root: &Path) -> RequestContext {
    let host = support::TestHost::new(root.join("state"));
    host.set_workspace("alpha", root.to_owned());
    let p = serde_json::from_value(json!({"agentId":"alpha","workspace":format!("workspace-dir:v1:{}",root.display()),"user":harness_user_principal("fixture"),"channel":"telegram","accountId":"fixture","chat":{"id":"fixture","kind":"direct"},"trust":"proved"})).unwrap();
    let a = serde_json::from_value(json!({"origin":"user","background":false})).unwrap();
    RequestContext::build(&p, &a, &host).unwrap()
}
fn namespaces() -> EngineConfig {
    serde_json::from_value(json!({"namespaces":{"activeWriteNamespace":"active","activeRecallNamespaces":["active"],"legacyReadOnlyNamespaces":["legacy"],"crossNamespaceRecall":true}})).unwrap()
}

#[test]
fn missing_private_sources_and_previews_create_nothing() {
    let root = support::canonical_tempdir();
    let base = root.path().join("absent");
    let routes = Arc::new(
        NamespaceStores::open(
            &base,
            &serde_json::from_value(json!({})).unwrap(),
            HashEmbedder::new().identity(),
            2,
        )
        .unwrap(),
    );
    let stores = PrivateMemoryStores::new(routes);
    let ctx = context(root.path());
    assert!(stores.sources(&ctx).unwrap().is_empty());
    assert!(stores.existing_private(&ctx).unwrap().is_none());
    assert!(ImportStores::existing(&stores, &ctx).unwrap().is_none());
    assert!(RebindStores::existing(&stores, &ctx).unwrap().is_none());
    assert!(!base.exists());
}

#[test]
fn explicit_writer_and_existing_reads_share_the_actual_active_pool() {
    let root = support::canonical_tempdir();
    let base = root.path().join("db");
    let identity = HashEmbedder::new().identity().clone();
    Store::create(&base.join("legacy/alpha"), &identity, HASH_DIMENSION).unwrap();
    let routes = Arc::new(NamespaceStores::open(&base, &namespaces(), &identity, 2).unwrap());
    let stores = PrivateMemoryStores::new(routes.clone());
    let ctx = context(root.path());
    let before = stores.sources(&ctx).unwrap();
    assert_eq!(before.len(), 1);
    assert!(!base.join("active/alpha").exists());
    assert!(matches!(
        before[0].store.patch("missing", &RowPatch::default()),
        Err(StoreError::ReadOnly)
    ));
    let writer = ImportStores::writable(&stores, &ctx).unwrap();
    assert!(Arc::ptr_eq(
        &writer,
        &RebindStores::writable(&stores, &ctx).unwrap()
    ));
    assert!(Arc::ptr_eq(
        &writer,
        &stores.existing_private(&ctx).unwrap().unwrap()
    ));
    assert!(Arc::ptr_eq(&writer, &routes.write_store("alpha").unwrap()));
    let after = stores.sources(&ctx).unwrap();
    assert_eq!(after.len(), 2);
    assert!(Arc::ptr_eq(&writer, &after[0].store));
    assert!(after
        .iter()
        .all(|source| source.kind == SourceKind::Private && !source.optional));
}

#[test]
fn corrupt_existing_table_and_identity_mismatch_are_not_empty_sources() {
    for mismatch in [false, true] {
        let root = support::canonical_tempdir();
        let base = root.path().join("db");
        let identity = HashEmbedder::new().identity().clone();
        if mismatch {
            let mut other = identity.clone();
            other.model = "different-real-identity".into();
            Store::create(&base.join("alpha"), &other, HASH_DIMENSION).unwrap();
        } else {
            std::fs::create_dir_all(base.join("alpha")).unwrap();
            std::fs::write(base.join("alpha/memories.lance"), b"not a table").unwrap();
        }
        let routes = Arc::new(
            NamespaceStores::open(
                &base,
                &serde_json::from_value(json!({})).unwrap(),
                &identity,
                2,
            )
            .unwrap(),
        );
        let stores = PrivateMemoryStores::new(routes);
        let ctx = context(root.path());
        assert!(stores.sources(&ctx).is_err());
        assert!(stores.existing_private(&ctx).is_err());
    }
}

#[test]
fn replaced_namespace_root_is_not_adopted_by_existing_lookups() {
    let root = support::canonical_tempdir();
    let base = root.path().join("db");
    let routes = Arc::new(
        NamespaceStores::open(&base, &namespaces(), HashEmbedder::new().identity(), 2).unwrap(),
    );
    let stores = PrivateMemoryStores::new(routes);
    std::fs::rename(&base, root.path().join("original-db")).unwrap();
    std::fs::create_dir(&base).unwrap();
    let ctx = context(root.path());
    assert!(stores.sources(&ctx).is_err());
    assert!(ImportStores::existing(&stores, &ctx).is_err());
    assert!(!base.join("active").exists());
}

#[test]
fn lazily_created_flat_root_is_pinned_even_when_the_original_agent_directory_is_moved_back() {
    let root = support::canonical_tempdir();
    let base = root.path().join("db");
    let routes = Arc::new(
        NamespaceStores::open(
            &base,
            &serde_json::from_value(json!({})).unwrap(),
            HashEmbedder::new().identity(),
            2,
        )
        .unwrap(),
    );
    let stores = PrivateMemoryStores::new(routes);
    let ctx = context(root.path());
    let held_store = ImportStores::writable(&stores, &ctx).unwrap();
    let displaced = root.path().join("original-db");
    std::fs::rename(&base, &displaced).unwrap();
    std::fs::create_dir(&base).unwrap();
    std::fs::rename(displaced.join("alpha"), base.join("alpha")).unwrap();
    assert!(stores.existing_private(&ctx).is_err());
    assert!(stores.sources(&ctx).is_err());
    assert!(held_store
        .count(&plur1bus_engine::store::RowFilter::default())
        .is_err());
}

#[test]
fn existing_legacy_lookup_preserves_its_resolved_identity_without_creating_the_active_route() {
    use plur1bus_engine::{contract::VectorSpaceIdentity, store::StoreIdentityResolver};
    struct Identities {
        active: VectorSpaceIdentity,
        legacy: VectorSpaceIdentity,
    }
    impl StoreIdentityResolver for Identities {
        fn expected_identity(
            &self,
            namespace: Option<&str>,
            agent: &str,
        ) -> Result<VectorSpaceIdentity, StoreError> {
            Ok(if namespace == Some("legacy") && agent == "alpha" {
                self.legacy.clone()
            } else {
                self.active.clone()
            })
        }
    }
    let root = support::canonical_tempdir();
    let active = HashEmbedder::new().identity().clone();
    let mut legacy = active.clone();
    legacy.model = "retained-exact-model".into();
    Store::create(&root.path().join("legacy/alpha"), &legacy, HASH_DIMENSION).unwrap();
    let routes = NamespaceStores::open_with_identity_resolver(
        root.path(),
        &namespaces(),
        &active,
        Arc::new(Identities {
            active: active.clone(),
            legacy: legacy.clone(),
        }),
        2,
    )
    .unwrap();
    let stores = PrivateMemoryStores::new(Arc::new(routes));
    let sources = stores.sources(&context(root.path())).unwrap();
    assert_eq!(sources.len(), 1);
    let identity_id = plur1bus_engine::embedding::identity::try_identity_id;
    assert_eq!(
        identity_id(sources[0].store.identity().unwrap()).unwrap(),
        identity_id(&legacy).unwrap()
    );
    assert!(!root.path().join("active/alpha").exists());
}

#[test]
fn leased_named_store_retains_the_outer_root_pin_after_its_pool_is_dropped() {
    let root = support::canonical_tempdir();
    let base = root.path().join("db");
    let routes =
        NamespaceStores::open(&base, &namespaces(), HashEmbedder::new().identity(), 2).unwrap();
    let held_store = routes.write_store("alpha").unwrap();
    drop(routes);
    let displaced = root.path().join("original-db");
    std::fs::rename(&base, &displaced).unwrap();
    std::fs::create_dir(&base).unwrap();
    std::fs::rename(displaced.join("active"), base.join("active")).unwrap();
    assert!(held_store
        .count(&plur1bus_engine::store::RowFilter::default())
        .is_err());
    assert!(held_store.patch("missing", &RowPatch::default()).is_err());
}

#[test]
fn replaced_lazy_root_without_a_table_is_an_error_not_an_absent_source() {
    let root = support::canonical_tempdir();
    let base = root.path().join("db");
    let routes = Arc::new(
        NamespaceStores::open(
            &base,
            &serde_json::from_value(json!({})).unwrap(),
            HashEmbedder::new().identity(),
            2,
        )
        .unwrap(),
    );
    let stores = PrivateMemoryStores::new(routes);
    let ctx = context(root.path());
    let _held_store = ImportStores::writable(&stores, &ctx).unwrap();
    std::fs::rename(&base, root.path().join("original-db")).unwrap();
    std::fs::create_dir(&base).unwrap();
    assert!(stores.sources(&ctx).is_err());
    assert!(stores.existing_private(&ctx).is_err());
    assert!(!base.join("alpha").exists());
}
