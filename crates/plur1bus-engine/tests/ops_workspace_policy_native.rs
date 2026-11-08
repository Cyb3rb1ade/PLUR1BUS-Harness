//! F6: caller-bound native policies, shared ACL visibility and durable invalidation.
#![allow(clippy::unwrap_used, clippy::panic, reason = "integration assertions")]
#[path = "recall_support.rs"]
mod support;
use plur1bus_engine::{
    context::harness_user_principal,
    contract::{AgentContext, EngineError, Principal, WorkspacePolicyOps},
    ops::{
        context::OperationContext,
        workspace_policy::{PolicyError, PolicyStore},
        workspace_policy_ops::{CallerPolicy, PolicyInvalidation},
    },
};
use serde_json::{json, Value};
use std::{
    fs,
    path::Path,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
};
struct Invalidation {
    store: Arc<PolicyStore>,
    seen: Mutex<Vec<Value>>,
    fail: AtomicBool,
}
impl PolicyInvalidation for Invalidation {
    fn invalidate(&self, agent: &str, workspace: &str) -> Result<(), PolicyError> {
        let committed = self
            .store
            .get(&json!({"agentId":agent,"workspaceIdentity":workspace}))?;
        self.seen.lock().unwrap().push(committed);
        if self.fail.load(Ordering::SeqCst) {
            Err(PolicyError::Storage)
        } else {
            Ok(())
        }
    }
}
fn principal(agent: &str, workspace: &Path, proved: bool) -> Principal {
    serde_json::from_value(json!({"agentId":agent,"workspace":format!("workspace-dir:v1:{}",workspace.display()),"user":harness_user_principal("synthetic-user"),"channel":"telegram","accountId":"fixture","chat":{"id":"fixture","kind":"direct"},"trust":if proved{"proved"}else{"inferred"}})).unwrap()
}
fn context(origin: &str, background: bool) -> AgentContext {
    serde_json::from_value(json!({"origin":origin,"background":background})).unwrap()
}
fn result(r: Result<Value, EngineError>) -> Value {
    match r {
        Ok(v) => json!({"value":v}),
        Err(EngineError::MemoryOp(e)) => json!({"error":e.code}),
        Err(e) => panic!("{e:?}"),
    }
}
#[test]
fn native_policies_filter_common_workspace_acl_and_authorize_before_read_or_write() {
    let temp = support::canonical_tempdir();
    let wa = temp.path().join("a");
    let wb = temp.path().join("b");
    fs::create_dir(&wa).unwrap();
    fs::create_dir(&wb).unwrap();
    let host = Arc::new(support::TestHost::new(temp.path().join("state")));
    host.set_workspace("agent", wa.clone());
    host.set_workspace("peer", wa.clone());
    host.set_workspace("foreign", wb.clone());
    host.time.store(1000, Ordering::SeqCst);
    let ctx = Arc::new(OperationContext::new(host));
    let store = Arc::new(PolicyStore::new(&temp.path().join("state")).unwrap());
    let invalidation = Arc::new(Invalidation {
        store: store.clone(),
        seen: Mutex::new(vec![]),
        fail: AtomicBool::new(false),
    });
    let facade = CallerPolicy::new(ctx.clone(), store.clone(), invalidation.clone());
    let wi = |w: &Path| format!("workspace-dir:v1:{}", w.display());
    for (agent, w) in [("agent", &wa), ("peer", &wa), ("foreign", &wb)] {
        store.set(&json!({"agentId":agent,"workspaceIdentity":wi(w),"enabled":true,"expectedRevision":0,"actorId":"synthetic-setup"}),1).unwrap();
    }
    let user = context("user", false);
    let pa = principal("agent", &wa, true);
    let pb = principal("foreign", &wb, true);
    let pi = principal("agent", &wa, false);
    let pn = principal("missing", &wa, false);
    assert_eq!(facade.get(&pa, &user).unwrap()["agentId"], "agent");
    let listed = facade.list(&pa, &user).unwrap();
    assert_eq!(
        listed
            .as_array()
            .unwrap()
            .iter()
            .map(|r| r["agentId"].as_str().unwrap())
            .collect::<Vec<_>>(),
        ["agent", "peer"]
    );
    assert_eq!(
        facade.list(&pb, &user).unwrap().as_array().unwrap().len(),
        1
    );
    assert_eq!(facade.list(&pi, &user).unwrap(), listed);
    assert_eq!(facade.list(&pn, &user).unwrap(), json!([]));
    assert_eq!(result(facade.get(&pn, &user)), json!({"error":"denied"}));
    let path = temp.path().join("state/control/workspace-policy.json");
    let before = fs::read(&path).unwrap();
    let patch = json!({"enabled":false,"expectedRevision":1});
    for (p, a, patch) in [
        (&pi, user.clone(), patch.clone()),
        (&pa, context("user", true), patch.clone()),
        (&pa, context("system", false), patch.clone()),
        (
            &pa,
            user.clone(),
            json!({"enabled":false,"expectedRevision":1,"actorId":"fabricated-owner"}),
        ),
        (
            &pa,
            user.clone(),
            json!({"enabled":false,"expectedRevision":1,"agentId":"peer"}),
        ),
        (
            &pa,
            user.clone(),
            json!({"enabled":false,"expectedRevision":1,"workspaceIdentity":wi(&wb)}),
        ),
    ] {
        assert_eq!(result(facade.set(patch, p, &a)), json!({"error":"denied"}));
    }
    assert_eq!(fs::read(&path).unwrap(), before);
    assert!(invalidation.seen.lock().unwrap().is_empty());
    let changed = facade.set(patch.clone(), &pa, &user).unwrap();
    assert_eq!(changed["enabled"], false);
    assert_eq!(changed["actorId"], harness_user_principal("synthetic-user"));
    assert_eq!(changed["revision"], 2);
    assert_eq!(
        invalidation.seen.lock().unwrap().as_slice(),
        std::slice::from_ref(&changed)
    );
    assert_eq!(
        result(facade.set(patch, &pa, &user)),
        json!({"error":"conflict"})
    );
    invalidation.fail.store(true, Ordering::SeqCst);
    assert_eq!(
        result(facade.set(json!({"enabled":true,"expectedRevision":2}), &pa, &user)),
        json!({"error":"storage"})
    );
    assert_eq!(facade.get(&pa, &user).unwrap()["revision"], 3);
    assert_eq!(facade.get(&pa, &user).unwrap()["enabled"], true);
    // No-identity requests do not probe a corrupt global file; authorized readers fail closed.
    fs::write(&path, "{broken").unwrap();
    assert_eq!(facade.list(&pn, &user).unwrap(), json!([]));
    assert_eq!(result(facade.list(&pa, &user)), json!({"error":"storage"}));
    let forged = principal("agent", &wb, true);
    assert_eq!(
        result(facade.list(&forged, &user)),
        json!({"error":"denied"})
    );
    assert_eq!(fs::read_to_string(&path).unwrap(), "{broken");
    ctx.close();
    assert_eq!(result(facade.get(&pa, &user)), json!({"error":"storage"}));
}
#[test]
fn native_read_defaults_do_not_create_policy_state() {
    let temp = support::canonical_tempdir();
    let w = temp.path().join("workspace");
    fs::create_dir(&w).unwrap();
    let root = temp.path().join("state");
    let host = Arc::new(support::TestHost::new(root.clone()));
    host.set_workspace("agent", w.clone());
    let store = Arc::new(PolicyStore::new(&root).unwrap());
    let callback = Arc::new(Invalidation {
        store: store.clone(),
        seen: Mutex::new(vec![]),
        fail: AtomicBool::new(false),
    });
    let facade = CallerPolicy::new(Arc::new(OperationContext::new(host)), store, callback);
    let p = principal("agent", &w, true);
    let a = context("user", false);
    assert_eq!(facade.get(&p, &a).unwrap()["source"], "default");
    assert_eq!(facade.list(&p, &a).unwrap(), json!([]));
    assert!(!root.join("control").exists());
}
