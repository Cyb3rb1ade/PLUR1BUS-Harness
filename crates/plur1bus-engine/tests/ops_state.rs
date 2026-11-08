//! F4/RE-D31: state and fully paginated list share row visibility, across all scopes.
#![allow(clippy::unwrap_used, reason = "privacy invariants fail immediately")]
#[path = "recall_support.rs"]
mod support;
use plur1bus_engine::{
    context::{harness_user_principal, RequestContext},
    contract::{AgentContext, Principal, StoreError},
    embedding::EmbeddingProvider,
    ops::{
        context::OperationContext,
        memory::{MemoryReader, ReadSource, ReadStores, SourceKind},
    },
    recall::hash_embed::HashEmbedder,
    store::{
        tombstone::{content_fingerprint, TombstoneRegistry},
        Store,
    },
    text::json::parse_json,
};
use serde_json::json;
use std::{
    collections::{BTreeMap, HashSet},
    sync::Arc,
};

struct Sources(Vec<(SourceKind, Arc<Store>)>);
impl ReadStores for Sources {
    fn sources(&self, _: &RequestContext) -> Result<Vec<ReadSource>, StoreError> {
        Ok(self
            .0
            .iter()
            .map(|(kind, store)| ReadSource {
                kind: *kind,
                store: store.clone(),
                optional: *kind != SourceKind::Private,
            })
            .collect())
    }
}
fn principal(agent: &str, owner: &str, workspace: &std::path::Path) -> Principal {
    serde_json::from_value(json!({"agentId":agent,"workspace":format!("workspace-dir:v1:{}",workspace.display()), "user":harness_user_principal(owner),
        "channel":"telegram","accountId":"fixture","chat":{"id":"fixture","kind":"direct"},"trust":"proved"})).unwrap()
}
fn step(seed: &mut u64) -> u64 {
    *seed = seed.wrapping_mul(6_364_136_223_846_793_005).wrapping_add(1);
    *seed >> 32
}
#[test]
fn randomized_state_counts_equal_every_page_for_each_caller_and_scope() {
    for mut seed in [13_u64, 90210] {
        let root = support::canonical_tempdir();
        let base = root.path().join("store");
        let workspace = root.path().join("workspace");
        std::fs::create_dir_all(&workspace).unwrap();
        let host = Arc::new(support::TestHost::new(root.path().join("state")));
        for name in ["agent", "peer", "foreign"] {
            host.set_workspace(name, workspace.clone());
        }
        let callers = [
            principal("agent", "owner", &workspace),
            principal("peer", "owner", &workspace),
            principal("foreign", "other", &workspace),
        ];
        let agent: AgentContext =
            serde_json::from_value(json!({"origin":"user","background":false})).unwrap();
        let contexts = callers
            .iter()
            .map(|p| RequestContext::build(p, &agent, host.as_ref()).unwrap())
            .collect::<Vec<_>>();
        assert_eq!(contexts[0].owner_user_id, contexts[1].owner_user_id);
        assert!(!contexts[0].owner_user_id.is_empty());
        assert_ne!(contexts[0].owner_user_id, contexts[2].owner_user_id);
        let embedder = Arc::new(HashEmbedder::new());
        let mut identity = embedder.identity().clone();
        identity.dimension = 4.into();
        let mut stores = Vec::new();
        let mut tombstones = Vec::new();
        for (pool, kind, scope) in [
            (0, SourceKind::Private, "agent-private"),
            (1, SourceKind::Workspace, "workspace"),
            (2, SourceKind::User, "user"),
        ] {
            let store =
                Arc::new(Store::create(&base.join(format!("pool{pool}")), &identity, 4).unwrap());
            let mut rows = Vec::new();
            for n in 1..=150 {
                let r = step(&mut seed);
                let owner = &contexts[(r % 3) as usize];
                let number = pool * 1000 + n;
                let id = format!("00000000-0000-4000-8000-{number:012}");
                let mut row = support::memory_row(&id, owner.agent_id.as_str(), scope);
                row.vector = vec![1., n as f32, 0., 0.];
                row.status = "active".into();
                row.created_at = number.into();
                row.stored_by = owner.agent_id.as_str().into();
                row.owner_user_id = owner.owner_user_id.clone();
                row.workspace_id = owner.workspace_id.clone();
                if r.is_multiple_of(7) {
                    row.status = "deleted".into();
                }
                if r.is_multiple_of(11) {
                    row.epistemic_status = "invalidated".into();
                }
                if r.is_multiple_of(13) {
                    row.expires_at = 100.into();
                }
                if r.is_multiple_of(17) {
                    row.workspace_id = "workspace:v1:foreign-fixture".into();
                }
                if r.is_multiple_of(19) {
                    let tombstone = json!({"schemaVersion":1,"memoryId":id,"canonicalOriginId":id,
                        "agentId":owner.agent_id,"scope":scope,"workspaceId":row.workspace_id,
                        "ownerUserId":row.owner_user_id,"storedBy":row.stored_by,"status":"committed",
                        "contentFingerprint":content_fingerprint(&row.text),"opaque":"kept"});
                    tombstones.push((owner.agent_id.as_str().to_owned(), tombstone));
                }
                rows.push(row);
            }
            if pool == 0 {
                // More than the old maximum acquisition prefix is hidden from every caller.
                for n in 0..130 {
                    let mut row = support::memory_row(
                        &format!("00000000-0000-4000-8000-{:012}", 9000 + n),
                        "hidden",
                        "agent-private",
                    );
                    row.vector = vec![1., 0., 0., 0.];
                    row.status = "active".into();
                    row.created_at = (9000 + n).into();
                    rows.push(row);
                }
            }
            store.upsert(&rows).unwrap();
            stores.push((kind, store));
        }
        for (owner, tombstone) in tombstones {
            TombstoneRegistry::new(&base, &owner)
                .unwrap()
                .append(&parse_json(&tombstone.to_string()).unwrap())
                .unwrap();
        }
        let context = Arc::new(OperationContext::new(host));
        let reader = MemoryReader::new(context, Arc::new(Sources(stores)), embedder, base);
        for principal in &callers {
            let state =
                serde_json::to_value(reader.state_at(principal, &agent, 20_000).unwrap()).unwrap();
            let mut until = 20_000_i64;
            let mut counts = BTreeMap::<String, usize>::new();
            let mut seen = HashSet::new();
            loop {
                let query =
                    serde_json::from_value(json!({"since":0,"until":until,"limit":7})).unwrap();
                let page = reader.list_at(&query, principal, &agent, 20_000).unwrap();
                for card in &page.items {
                    assert!(
                        seen.insert(card.id.clone()),
                        "pagination must never repeat a card"
                    );
                    let scope = serde_json::to_value(card.scope)
                        .unwrap()
                        .as_str()
                        .unwrap()
                        .to_owned();
                    *counts.entry(scope).or_default() += 1;
                }
                if !page.truncated {
                    break;
                }
                let oldest = page
                    .items
                    .last()
                    .unwrap()
                    .created_at
                    .as_ref()
                    .unwrap()
                    .as_f64()
                    .unwrap() as i64;
                assert!(oldest <= until);
                until = oldest - 1;
                assert!(seen.len() < 1000, "pagination must terminate");
            }
            for (scope, key) in [
                ("agent-private", "agentPrivate"),
                ("workspace", "workspace"),
                ("user", "user"),
            ] {
                assert_eq!(
                    state["cards"][key].as_u64().unwrap() as usize,
                    *counts.get(scope).unwrap_or(&0),
                    "caller {} scope {scope}",
                    principal.agent_id.as_str()
                );
            }
            assert!(seen.len() > 20, "fixture must exercise multiple pages");
        }
    }
}

#[test]
fn state_filters_tombstone_scope_and_keeps_unreadable_counts_null_without_repair() {
    let root = support::canonical_tempdir();
    let base = root.path().join("store");
    let workspace = root.path().join("workspace");
    std::fs::create_dir_all(&workspace).unwrap();
    let host = Arc::new(support::TestHost::new(root.path().join("state")));
    host.set_workspace("agent", workspace.clone());
    let p = principal("agent", "owner", &workspace);
    let a = serde_json::from_value(json!({"origin":"user","background":false})).unwrap();
    let embedder = Arc::new(HashEmbedder::new());
    let mut identity = embedder.identity().clone();
    identity.dimension = 4.into();
    let store = Arc::new(Store::create(&base.join("agent"), &identity, 4).unwrap());
    let mut row = support::memory_row(
        "00000000-0000-4000-8000-000000000001",
        "agent",
        "agent-private",
    );
    row.status = "active".into();
    row.vector = vec![1., 0., 0., 0.];
    store.upsert(&[row]).unwrap();
    let registry = TombstoneRegistry::new(&base, "agent").unwrap();
    let mut path = None;
    for (n, scope) in [(2, "agent-private"), (3, "workspace"), (4, "user")] {
        let tombstone = json!({"schemaVersion":1,"memoryId":format!("00000000-0000-4000-8000-{n:012}"),
            "agentId":"agent","storedBy":"agent","scope":scope,"status":"committed",
            "workspaceId":"workspace:v1:foreign-fixture","ownerUserId":harness_user_principal("other"),
            "contentFingerprint":content_fingerprint("deleted fixture")});
        let line = tombstone.to_string();
        let line = format!("{},\"opaque\":\"\\ud800\"}}", &line[..line.len() - 1]);
        path = Some(registry.append(&parse_json(&line).unwrap()).unwrap());
    }
    let path = path.unwrap();
    let reader = MemoryReader::new(
        Arc::new(OperationContext::new(host)),
        Arc::new(Sources(vec![(SourceKind::Private, store)])),
        embedder,
        base,
    );
    let before = std::fs::read(&path).unwrap();
    let state = serde_json::to_value(reader.state_at(&p, &a, 100).unwrap()).unwrap();
    assert_eq!(state["cards"]["agentPrivate"], 1);
    assert_eq!(
        state["tombstones"], 1,
        "same-agent foreign-scope tombstones are hidden"
    );
    assert!(state["cards"]["workspace"].is_null());
    assert_eq!(std::fs::read(&path).unwrap(), before);
    use std::io::Write;
    std::fs::OpenOptions::new()
        .append(true)
        .open(&path)
        .unwrap()
        .write_all(b"{\"torn\":")
        .unwrap();
    let corrupt = std::fs::read(&path).unwrap();
    let state = serde_json::to_value(reader.state_at(&p, &a, 100).unwrap()).unwrap();
    assert!(state["tombstones"].is_null());
    assert!(state["cards"]["agentPrivate"].is_null());
    assert_eq!(
        std::fs::read(&path).unwrap(),
        corrupt,
        "read must never repair a torn tail"
    );
}
