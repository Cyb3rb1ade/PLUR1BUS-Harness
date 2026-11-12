//! Actual private Lance weakening is preceded by a durable original-caller plan.
#![allow(clippy::unwrap_used, clippy::panic, reason = "fixture assertions")]
#![cfg(feature = "testkit")]
#[path = "../recall_support.rs"]
pub(super) mod support;
use plur1bus_engine::{
    capture::{interference::InterferenceOptions, shared_scope::CapturePolicy},
    context::{harness_user_principal, RequestContext},
    contract::{AgentContext, Cancel, EngineError, Principal, StoreError},
    embedding::{EmbedError, EmbedKind, EmbeddingProvider, VectorSpaceIdentity},
    neo::capture_journal::CaptureJournal,
    ops::{
        context::OperationContext,
        interference::{InterferenceRequest, NativeInterference},
        memory::{MemoryReader, ReadSource, ReadStores, SourceKind},
    },
    recall::hash_embed::HashEmbedder,
    store::{OpenMode, Store},
};
use serde_json::json;
use std::{
    fs,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    },
};
struct Sources(Arc<Store>);
impl ReadStores for Sources {
    fn sources(&self, _: &RequestContext) -> Result<Vec<ReadSource>, StoreError> {
        Ok(vec![ReadSource {
            store: self.0.clone(),
            kind: SourceKind::Private,
            optional: false,
        }])
    }
}
struct Embed(VectorSpaceIdentity);
impl EmbeddingProvider for Embed {
    fn identity(&self) -> &VectorSpaceIdentity {
        &self.0
    }
    fn embed(&self, _: &[String], _: EmbedKind, _: &Cancel) -> Result<Vec<Vec<f32>>, EmbedError> {
        panic!("interference must not infer")
    }
}
pub struct Policy {
    pub allowed: AtomicBool,
}
impl CapturePolicy for Policy {
    fn allowed(&self, _: &RequestContext) -> Result<bool, EngineError> {
        Ok(self.allowed.load(Ordering::SeqCst))
    }
}
pub struct Fixture {
    pub root: tempfile::TempDir,
    pub store: Arc<Store>,
    pub ledger: NativeInterference,
    pub principal: Principal,
    pub agent: AgentContext,
    pub request: InterferenceRequest,
    pub policy: Arc<Policy>,
}
pub fn setup() -> Fixture {
    let root = support::canonical_tempdir();
    let workspace = root.path().join("workspace");
    let neo = root.path().join("neo");
    fs::create_dir(&workspace).unwrap();
    fs::create_dir(&neo).unwrap();
    let host = Arc::new(support::TestHost::new(root.path().join("state")));
    host.set_workspace("alpha", workspace.clone());
    host.time.store(1735689600000, Ordering::SeqCst);
    let principal:Principal=serde_json::from_value(json!({"agentId":"alpha","workspace":format!("workspace-dir:v1:{}",workspace.display()),"user":harness_user_principal("fixture"),"channel":"telegram","accountId":"fixture","chat":{"id":"fixture","kind":"direct"},"trust":"proved"})).unwrap();
    let agent: AgentContext =
        serde_json::from_value(json!({"origin":"user","background":false})).unwrap();
    let ctx = RequestContext::build(&principal, &agent, host.as_ref()).unwrap();
    let mut identity = HashEmbedder::new().identity().clone();
    identity.dimension = 4.into();
    let base = root.path().join("store");
    let store = Arc::new(Store::create(&base.join("alpha"), &identity, 4).unwrap());
    let mut new = support::memory_row(
        "00000000-0000-4000-8000-000000000001",
        "alpha",
        "agent-private",
    );
    new.stored_by = "alpha".into();
    new.status = "active".into();
    new.owner_user_id = ctx.owner_user_id.clone();
    new.workspace_key = ctx.workspace_key.clone();
    new.workspace_id = ctx.workspace_key.clone();
    new.vector = vec![1., 0., 0., 0.];
    new.text = "A synthetic decision".into();
    new.category = "decision".into();
    let mut existing = new.clone();
    existing.id = "00000000-0000-4000-8000-000000000002".into();
    existing.agent_id = "alpha".into();
    existing.stored_by = "alpha".into();
    existing.scope = "agent-private".into();
    existing.memory_strength = serde_json::Number::from_f64(0.8).unwrap();
    existing.created_at = serde_json::Number::from_f64(1735689600000.).unwrap();
    existing.text = "Another synthetic decision".into();
    store.upsert(&[new.clone(), existing.clone()]).unwrap();
    let policy = Arc::new(Policy {
        allowed: AtomicBool::new(true),
    });
    let journal = Arc::new(CaptureJournal::open(&neo, host.clone(), policy.clone()).unwrap());
    let reader = Arc::new(MemoryReader::new(
        Arc::new(OperationContext::new(host)),
        Arc::new(Sources(store.clone())),
        Arc::new(Embed(identity)),
        base,
    ));
    let ledger = NativeInterference::new(reader, journal);
    let request = InterferenceRequest {
        operation_id: uuid::Uuid::new_v4(),
        source: store.get_record(&new.id).unwrap().unwrap(),
        options: InterferenceOptions::default(),
    };
    Fixture {
        root,
        store,
        ledger,
        principal,
        agent,
        request,
        policy,
    }
}

pub struct Reopened {
    pub reader: Arc<MemoryReader>,
    pub journal: Arc<CaptureJournal>,
    pub store: Arc<Store>,
    pub host: Arc<support::TestHost>,
    pub principal: Principal,
    pub agent: AgentContext,
}
pub fn reopen_policy(root: &std::path::Path, allowed: bool) -> Reopened {
    let workspace = root.join("workspace");
    let base = root.join("store");
    let host = Arc::new(support::TestHost::new(root.join("state")));
    host.set_workspace("alpha", workspace.clone());
    host.time.store(1735689600000, Ordering::SeqCst);
    let principal:Principal=serde_json::from_value(json!({"agentId":"alpha","workspace":format!("workspace-dir:v1:{}",workspace.display()),"user":harness_user_principal("fixture"),"channel":"telegram","accountId":"fixture","chat":{"id":"fixture","kind":"direct"},"trust":"proved"})).unwrap();
    let agent = serde_json::from_value(json!({"origin":"user","background":false})).unwrap();
    let store = Arc::new(Store::open(&base.join("alpha"), OpenMode::ReadWrite, None).unwrap());
    let identity = store.identity().unwrap().clone();
    let policy = Arc::new(Policy {
        allowed: AtomicBool::new(allowed),
    });
    let journal = Arc::new(CaptureJournal::open(&root.join("neo"), host.clone(), policy).unwrap());
    let reader = Arc::new(MemoryReader::new(
        Arc::new(OperationContext::new(host.clone())),
        Arc::new(Sources(store.clone())),
        Arc::new(Embed(identity)),
        base,
    ));
    Reopened {
        reader,
        journal,
        store,
        host,
        principal,
        agent,
    }
}

pub fn reopen(root: &std::path::Path) -> Reopened {
    reopen_policy(root, true)
}
