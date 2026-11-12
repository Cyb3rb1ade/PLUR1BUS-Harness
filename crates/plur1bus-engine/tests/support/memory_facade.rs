//! The unchanged MemoryOps contract over real stores and common lifecycle.
use super::*;
use plur1bus_engine::ops::{
    facade::{MemoryPorts, NativeMemory},
    import::ImportStores,
    import_row::ImportEncoding,
    rebind::RebindStores,
    sharing::SharedStores,
    unimport::{FileUnimportEffects, UnimportStores},
    write::MutationStores,
};
struct Routes(Arc<Store>, Option<Arc<Store>>);
impl MutationStores for Routes {
    fn existing_private(&self, _: &RequestContext) -> Result<Option<Arc<Store>>, StoreError> {
        Ok(Some(self.0.clone()))
    }
}
impl SharedStores for Routes {
    fn supported(&self) -> bool {
        self.1.is_some()
    }
    fn target(&self, _: &RequestContext, _: MemoryShareTarget) -> Result<Arc<Store>, StoreError> {
        self.1.clone().ok_or(StoreError::Unavailable)
    }
}
impl ReadStores for Routes {
    fn sources(&self, _: &RequestContext) -> Result<Vec<ReadSource>, StoreError> {
        let mut sources = vec![ReadSource {
            store: self.0.clone(),
            kind: SourceKind::Private,
            optional: false,
        }];
        if let Some(store) = &self.1 {
            sources.push(ReadSource {
                store: store.clone(),
                kind: SourceKind::User,
                optional: false,
            });
        }
        Ok(sources)
    }
}
impl ImportStores for Routes {
    fn existing(&self, _: &RequestContext) -> Result<Option<Arc<Store>>, StoreError> {
        Ok(Some(self.0.clone()))
    }
    fn writable(&self, _: &RequestContext) -> Result<Arc<Store>, StoreError> {
        Ok(self.0.clone())
    }
}
impl RebindStores for Routes {
    fn existing(&self, _: &RequestContext) -> Result<Option<Arc<Store>>, StoreError> {
        Ok(Some(self.0.clone()))
    }
    fn writable(&self, _: &RequestContext) -> Result<Arc<Store>, StoreError> {
        Ok(self.0.clone())
    }
}
impl UnimportStores for Routes {
    fn existing(&self, _: &RequestContext) -> Result<Option<Arc<Store>>, StoreError> {
        Ok(Some(self.0.clone()))
    }
    fn writable(&self, _: &RequestContext) -> Result<Arc<Store>, StoreError> {
        Ok(self.0.clone())
    }
    fn shared_pools(&self, _: &RequestContext) -> Result<Vec<Arc<Store>>, StoreError> {
        Ok(self.1.iter().cloned().collect())
    }
}
fn native(f: &Fixture) -> (Arc<OperationContext>, NativeMemory) {
    native_with_shared(f, None)
}
fn native_with_shared(
    f: &Fixture,
    shared: Option<Arc<Store>>,
) -> (Arc<OperationContext>, NativeMemory) {
    let context = Arc::new(OperationContext::new(f.host.clone()));
    let routes = Arc::new(Routes(f.base.store.clone(), shared));
    let native = NativeMemory::new(
        context.clone(),
        f.base.root.path().join("store"),
        MemoryPorts {
            read: routes.clone(),
            mutation: routes.clone(),
            shared: routes.clone(),
            import: routes.clone(),
            rebind: routes.clone(),
            unimport: routes,
            unimport_effects: Arc::new(FileUnimportEffects),
            embedder: f.embed.clone(),
            sharing_providers: vec![f.embed.clone()],
            journal: Some(f.journal.clone()),
            jobs_root: None,
            import_encoding: ImportEncoding::default(),
        },
    );
    (context, native)
}
#[test]
fn frozen_facade_reads_and_closes_the_same_operation_generation() {
    let f = setup();
    let (context, native) = native(&f);
    let memory: &dyn MemoryOps = &native;
    assert!(memory
        .show(SOURCE, &f.base.principal, &f.base.agent)
        .is_ok());
    assert!(memory.state(&f.base.principal, &f.base.agent).is_ok());
    assert!(memory
        .stats(Some(&[SOURCE.into()]), &f.base.principal, &f.base.agent)
        .is_ok());
    assert!(memory
        .proposals()
        .list(
            MemoryProposalListQuery::default(),
            &f.base.principal,
            &f.base.agent
        )
        .is_ok());
    assert!(memory
        .curation()
        .list(
            MemoryCurationListQuery::default(),
            &f.base.principal,
            &f.base.agent
        )
        .is_ok());
    context.close();
    assert!(memory
        .show(SOURCE, &f.base.principal, &f.base.agent)
        .is_err());
    assert!(memory.state(&f.base.principal, &f.base.agent).is_err());
    assert!(memory
        .correct(
            SOURCE,
            "closed correction",
            &f.base.principal,
            &f.base.agent
        )
        .is_err());
    assert!(memory
        .forget(SOURCE, &f.base.principal, &f.base.agent)
        .is_err());
    assert!(memory
        .proposals()
        .list(
            MemoryProposalListQuery::default(),
            &f.base.principal,
            &f.base.agent
        )
        .is_err());
    assert!(memory
        .curation()
        .list(
            MemoryCurationListQuery::default(),
            &f.base.principal,
            &f.base.agent
        )
        .is_err());
    assert_eq!(f.base.store.get(SOURCE).unwrap().unwrap().status, "active");
}
#[test]
fn correction_effects_bind_each_original_human_caller() {
    let f = setup();
    let (_, native) = native(&f);
    let mut second = serde_json::to_value(&f.base.principal).unwrap();
    second["user"] = json!(plur1bus_engine::context::harness_user_principal("second"));
    let second: Principal = serde_json::from_value(second).unwrap();
    let second_context = RequestContext::build(&second, &f.base.agent, f.host.as_ref()).unwrap();
    let mut row = f.base.store.get(SOURCE).unwrap().unwrap();
    row.id = "00000000-0000-4000-8000-000000000003".into();
    row.owner_user_id = second_context.owner_user_id.clone();
    f.base.store.upsert(&[row.clone()]).unwrap();
    for (id, caller) in [(SOURCE, &f.base.principal), (row.id.as_str(), &second)] {
        let result = native
            .correct(
                id,
                "Corrected by the original caller",
                caller,
                &f.base.agent,
            )
            .unwrap();
        let successor = f.base.store.get(&result.id).unwrap().unwrap();
        let expected = RequestContext::build(caller, &f.base.agent, f.host.as_ref()).unwrap();
        assert_eq!(successor.owner_user_id, expected.owner_user_id);
        assert_eq!(f.base.store.get(id).unwrap().unwrap().status, "superseded");
    }
    let layout = plur1bus_engine::neo::merged::Layout::for_key(&second_context.workspace_key);
    let path = f
        .base
        .root
        .path()
        .join("neo/workspaces")
        .join(layout.canonical)
        .join("reconsolidation-events.jsonl");
    let events: Vec<Value> = std::fs::read_to_string(path)
        .unwrap()
        .lines()
        .map(|s| serde_json::from_str(s).unwrap())
        .collect();
    assert_eq!(events.len(), 2);
    assert_ne!(events[0]["ownerUserId"], events[1]["ownerUserId"]);
}
#[test]
fn explicit_empty_promotion_and_disabled_neo_keep_their_contracts() {
    let f = setup();
    f.host.config.lock().unwrap()["neo"] = json!({"enabled":false});
    let (_, native) = native(&f);
    let result = native
        .promote(
            serde_json::from_value(json!({"ids":[]})).unwrap(),
            &f.base.principal,
            &f.base.agent,
        )
        .unwrap();
    assert!(result.items.is_empty());
    assert!(!f.base.root.path().join("workspace/memory").exists());
    native
        .correct(
            SOURCE,
            "Neo disabled correction",
            &f.base.principal,
            &f.base.agent,
        )
        .unwrap();
    let ctx = RequestContext::build(&f.base.principal, &f.base.agent, f.host.as_ref()).unwrap();
    let layout = plur1bus_engine::neo::merged::Layout::for_key(&ctx.workspace_key);
    assert!(!f
        .base
        .root
        .path()
        .join("neo/workspaces")
        .join(layout.canonical)
        .join("reconsolidation-events.jsonl")
        .exists());
}

#[test]
fn import_link_and_rollback_share_the_actual_receipts_and_system_guard() {
    let f = setup();
    let (_, native) = native(&f);
    let memory: &dyn MemoryOps = &native;
    let system: AgentContext =
        serde_json::from_value(json!({"origin":"system","background":false})).unwrap();
    let request: MemoryImportRequest = serde_json::from_value(json!({
        "agentId":"alpha", "principal":f.base.principal,
        "cards":[{"idempotencyKey":"facade-import", "text":"A separate imported synthetic fact", "provenance":"imported", "sourceRef":"fixture:source;run=facade-run"}]
    })).unwrap();
    assert!(memory
        .import(
            request.clone(),
            &Cancel::never(),
            &f.base.principal,
            &f.base.agent
        )
        .is_err());
    let result = serde_json::to_value(
        memory
            .import(request, &Cancel::never(), &f.base.principal, &system)
            .unwrap(),
    )
    .unwrap();
    assert_eq!(result["created"], 1);
    let id = result["cards"][0]["id"].as_str().unwrap();
    memory
        .link(
            id,
            serde_json::from_value(json!({"sourceRef":"fixture:second", "provenance":"imported"}))
                .unwrap(),
            &f.base.principal,
            &system,
        )
        .unwrap();
    let ctx = RequestContext::build(&f.base.principal, &system, f.host.as_ref()).unwrap();
    let graph = f
        .base
        .root
        .path()
        .join("neo/workspaces")
        .join(plur1bus_engine::neo::merged::Layout::for_key(&ctx.workspace_key).canonical)
        .join("memory-graph.jsonl");
    std::fs::create_dir_all(graph.parent().unwrap()).unwrap();
    let edge = json!({"source":id,"target":id,"scope":"agent_private",
        "ownerUserId":ctx.owner_user_id,"agentId":ctx.agent_id.as_str(),"workspaceKey":ctx.workspace_key});
    std::fs::write(&graph, format!("{edge}\n")).unwrap();
    let request = serde_json::from_value(
        json!({"agentId":"alpha", "importRunId":"facade-run", "dryRun":false}),
    )
    .unwrap();
    let rollback = serde_json::to_value(
        memory
            .unimport(request, &Cancel::never(), &f.base.principal, &system)
            .unwrap(),
    )
    .unwrap();
    // Frozen import semantics leave agent-private rows without user/workspace evidence.
    // A caller-stamped edge cannot retroactively confer those missing row bindings.
    assert_eq!(rollback["derived"]["graphEdgesRemoved"], 0, "{rollback}");
    assert_eq!(rollback["derived"]["cleanupErrors"], 1, "{rollback}");
    assert_eq!(
        std::fs::read_to_string(&graph).unwrap(),
        format!("{edge}\n")
    );
    assert_eq!(f.base.store.get(id).unwrap().unwrap().status, "deleted");
    assert!(memory.show(id, &f.base.principal, &f.base.agent).is_err());
    assert_eq!(f.base.store.get(SOURCE).unwrap().unwrap().status, "active");
}

#[test]
fn accepting_a_shared_proposal_uses_the_sharers_current_neo_binding() {
    let f = setup();
    f.host
        .inner
        .set_workspace("beta", f.base.root.path().join("workspace"));
    let shared = Arc::new(
        Store::create_shared(&f.base.root.path().join("shared"), f.embed.identity(), 4).unwrap(),
    );
    let (_, native) = native_with_shared(&f, Some(shared.clone()));
    let memory: &dyn MemoryOps = &native;
    let shared_result = memory
        .share(
            SOURCE,
            MemoryShareTarget::User,
            ShareOptions::default(),
            &f.base.principal,
            &f.base.agent,
        )
        .unwrap();
    let shared_id = shared_result.shared_id;
    let mut other = serde_json::to_value(&f.base.principal).unwrap();
    other["agentId"] = json!("beta");
    let other: Principal = serde_json::from_value(other).unwrap();
    let proposal = memory
        .propose(
            &shared_id,
            "A proposed synthetic revision",
            ProposeOptions::default(),
            &other,
            &f.base.agent,
        )
        .unwrap();
    assert!(memory
        .proposals()
        .accept(&proposal.proposal_id, &other, &f.base.agent)
        .is_err());
    let accepted = memory
        .proposals()
        .accept(&proposal.proposal_id, &f.base.principal, &f.base.agent)
        .unwrap();
    let next = f.base.store.get(&accepted.source_id).unwrap().unwrap();
    assert_eq!(next.text, "A proposed synthetic revision");
    assert_eq!(
        next.owner_user_id,
        f.base.store.get(SOURCE).unwrap().unwrap().owner_user_id
    );
    assert_eq!(shared.get(&accepted.id).unwrap().unwrap().text, next.text);
    let ctx = RequestContext::build(&f.base.principal, &f.base.agent, f.host.as_ref()).unwrap();
    let layout = plur1bus_engine::neo::merged::Layout::for_key(&ctx.workspace_key);
    let events = std::fs::read_to_string(
        f.base
            .root
            .path()
            .join("neo/workspaces")
            .join(layout.canonical)
            .join("reconsolidation-events.jsonl"),
    )
    .unwrap();
    assert_eq!(events.lines().count(), 1);
    let event: Value = serde_json::from_str(events.lines().next().unwrap()).unwrap();
    assert_eq!(event["ownerUserId"], ctx.owner_user_id);
}

#[test]
fn config_and_workspace_drift_during_embedding_refuse_before_lance_mutation() {
    for change in ["config", "workspace"] {
        let f = setup();
        f.host.config.lock().unwrap()["neo"] = json!({"enabled":false});
        let (_, native) = native(&f);
        let host = f.host.clone();
        let elsewhere = f.base.root.path().join("elsewhere");
        std::fs::create_dir(&elsewhere).unwrap();
        *f.embed.effect.lock().unwrap() = Some(Arc::new(move || {
            if change == "config" {
                host.config.lock().unwrap()["neo"]["enabled"] = json!(true);
            } else {
                host.inner.set_workspace("alpha", elsewhere.clone());
            }
        }));
        assert!(
            native
                .correct(
                    SOURCE,
                    "Must not commit after drift",
                    &f.base.principal,
                    &f.base.agent
                )
                .is_err(),
            "{change}"
        );
        assert_eq!(
            f.base.store.get(SOURCE).unwrap().unwrap().status,
            "active",
            "{change}"
        );
    }
}

#[test]
fn source_rebinding_during_embedding_cannot_inherit_the_old_authority() {
    let f = setup();
    f.host.config.lock().unwrap()["neo"] = json!({"enabled":false});
    let (_, native) = native(&f);
    let store = f.base.store.clone();
    *f.embed.effect.lock().unwrap() = Some(Arc::new(move || {
        store
            .patch(
                SOURCE,
                &RowPatch {
                    owner_user_id: Some("user:replacement".into()),
                    ..Default::default()
                },
            )
            .unwrap();
    }));
    assert!(native
        .correct(
            SOURCE,
            "Must not supersede a rebound source",
            &f.base.principal,
            &f.base.agent
        )
        .is_err());
    let row = f.base.store.get(SOURCE).unwrap().unwrap();
    assert_eq!(row.owner_user_id, "user:replacement");
    assert_eq!(row.status, "active");
}
