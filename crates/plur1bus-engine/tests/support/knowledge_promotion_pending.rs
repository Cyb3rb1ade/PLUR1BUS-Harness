use super::*;

fn publish_pending(f: &Fixture) -> Result<MemoryPromotionResult, EngineError> {
    publisher(f).run_pending(&f.base.principal, &f.base.agent, &Cancel::never())
}
#[test]
fn native_pending_selection_publishes_only_visible_private_sources_and_repeat_is_empty() {
    let f = setup_promotion();
    pending(&f);
    let first = serde_json::to_value(publish_pending(&f).unwrap()).unwrap();
    assert_eq!(first["items"].as_array().unwrap().len(), 1);
    assert_eq!(first["items"][0]["id"], SOURCE);
    assert_eq!(first["items"][0]["outcome"], "promoted");
    let second = serde_json::to_value(publish_pending(&f).unwrap()).unwrap();
    assert_eq!(second["items"], json!([]));
    assert_eq!(
        std::fs::read_to_string(document(f.base.root.path()))
            .unwrap()
            .matches("<!-- plur1bus-promotion:")
            .count(),
        1
    );
    assert_eq!(f.host.calls.load(Ordering::SeqCst), 0);
    assert_eq!(f.embed.calls.load(Ordering::SeqCst), 0);
}
#[test]
fn native_pending_selection_never_discloses_hidden_missing_or_nonprivate_ids() {
    for kind in ["hidden", "missing", "own-user-scope"] {
        let f = setup_promotion();
        pending(&f);
        let before = std::fs::read(queue_path(f.base.root.path())).unwrap();
        if kind == "missing" {
            f.base.store.delete(&[SOURCE]).unwrap();
        } else {
            let mut row = f.base.store.get(SOURCE).unwrap().unwrap();
            row.scope = "user".into();
            if kind == "hidden" {
                row.owner_user_id = plur1bus_engine::context::harness_user_principal("foreign");
            }
            f.base.store.upsert(&[row]).unwrap();
        }
        let result = serde_json::to_value(publish_pending(&f).unwrap()).unwrap();
        assert_eq!(result["items"], json!([]), "{kind}");
        assert_eq!(
            std::fs::read(queue_path(f.base.root.path())).unwrap(),
            before,
            "{kind}"
        );
        assert!(!document(f.base.root.path()).exists());
    }
}
#[test]
fn pending_selection_checks_disabled_cancel_and_foreground_admission() {
    let f = setup_promotion();
    pending(&f);
    f.host.config.lock().unwrap()["schicht15"]["enabled"] = json!(false);
    let before = std::fs::read(queue_path(f.base.root.path())).unwrap();
    let result = serde_json::to_value(publish_pending(&f).unwrap()).unwrap();
    assert_eq!(result["items"][0]["reason"], "disabled");
    assert_eq!(
        std::fs::read(queue_path(f.base.root.path())).unwrap(),
        before
    );
    assert!(!document(f.base.root.path()).exists());
    let cancel = Cancel::never();
    cancel.cancel();
    assert!(publisher(&f)
        .run_pending(&f.base.principal, &f.base.agent, &cancel)
        .is_err());
    let cron: AgentContext =
        serde_json::from_value(json!({"origin":"cron","background":true})).unwrap();
    assert!(publisher(&f)
        .run_pending(&f.base.principal, &cron, &Cancel::never())
        .is_err());
    assert_eq!(
        std::fs::read(queue_path(f.base.root.path())).unwrap(),
        before
    );
}
#[test]
fn a_selected_source_or_workspace_cannot_change_before_the_inner_publication() {
    for kind in ["source", "workspace"] {
        let f = setup_promotion();
        pending(&f);
        let before = std::fs::read(queue_path(f.base.root.path())).unwrap();
        let store = f.base.store.clone();
        let root = f.base.root.path().to_owned();
        let observed = root.clone();
        let writer = publisher(&f).with_observer(Arc::new(move |phase| {
            if phase == "promotion-pending-selected" {
                if kind == "source" {
                    let mut row = store.get(SOURCE).unwrap().unwrap();
                    row.scope = "user".into();
                    row.owner_user_id = plur1bus_engine::context::harness_user_principal("foreign");
                    store.upsert(&[row]).unwrap();
                } else {
                    std::fs::rename(observed.join("workspace"), observed.join("held-workspace"))
                        .unwrap();
                    std::fs::create_dir(observed.join("workspace")).unwrap();
                }
            }
            Ok(())
        }));
        assert!(writer
            .run_pending(&f.base.principal, &f.base.agent, &Cancel::never())
            .is_err());
        assert!(!document(&root).exists());
        let queue = if kind == "workspace" {
            root.join("held-workspace/.adaptive-learning/knowledge-pending.json")
        } else {
            queue_path(&root)
        };
        assert_eq!(std::fs::read(queue).unwrap(), before);
    }
}

#[test]
fn changed_pending_bytes_are_not_published_or_overwritten() {
    let f = setup_promotion();
    pending(&f);
    let path = queue_path(f.base.root.path());
    let changed = path.clone();
    let writer = publisher(&f).with_observer(Arc::new(move |phase| {
        if phase == "promotion-pending-selected" {
            let mut state: Value =
                serde_json::from_slice(&std::fs::read(&changed).unwrap()).unwrap();
            state["pending"]
                .as_array_mut()
                .unwrap()
                .retain(|entry| entry["memoryId"] != SOURCE);
            state["pendingCount"] = json!(1);
            std::fs::write(&changed, state.to_string()).unwrap();
        }
        Ok(())
    }));
    assert!(writer
        .run_pending(&f.base.principal, &f.base.agent, &Cancel::never())
        .is_err());
    let after: Value = serde_json::from_slice(&std::fs::read(path).unwrap()).unwrap();
    assert_eq!(after["pendingCount"], 1);
    assert!(!document(f.base.root.path()).exists());
}
#[test]
fn native_pending_respects_cap_and_lock_while_explicit_empty_stays_empty() {
    let f = setup_promotion();
    pending(&f);
    f.host.config.lock().unwrap()["schicht15"]["maxPromotionsPerRun"] = json!(1);
    let mut second = f.base.store.get(SOURCE).unwrap().unwrap();
    second.id = SECOND.into();
    second.text = "Second private decision".into();
    f.base.store.upsert(&[second]).unwrap();
    let path = queue_path(f.base.root.path());
    let mut queue: Value = serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
    queue["pending"]
        .as_array_mut()
        .unwrap()
        .push(json!({"sourceAgent":"alpha","memoryId":SECOND,"importance":0.7}));
    let queue = plur1bus_engine::capture::knowledge_pending::normalize(
        &parse_json(&queue.to_string()).unwrap(),
        1735689600000,
        &Cancel::never(),
    )
    .unwrap();
    std::fs::write(
        &path,
        plur1bus_engine::capture::knowledge_pending::encode(&queue, &Cancel::never()).unwrap(),
    )
    .unwrap();
    let empty = serde_json::to_value(publish(&f, &[]).unwrap()).unwrap();
    assert_eq!(empty["items"], json!([]));
    assert!(!document(f.base.root.path()).exists());
    let lock = plur1bus_engine::store::lock::Lock::try_acquire(
        &path.parent().unwrap().join("knowledge-update.lock"),
        std::time::Duration::from_secs(300),
        None,
    )
    .unwrap()
    .unwrap();
    let busy = serde_json::to_value(publish_pending(&f).unwrap()).unwrap();
    assert_eq!(busy["items"].as_array().unwrap().len(), 2);
    assert!(busy["items"]
        .as_array()
        .unwrap()
        .iter()
        .all(|item| item["reason"] == "lock-busy"));
    drop(lock);
    let first = serde_json::to_value(publish_pending(&f).unwrap()).unwrap();
    assert_eq!(first["items"][0]["outcome"], "promoted");
    assert_eq!(first["items"][1]["reason"], "cap-reached");
    let second = serde_json::to_value(publish_pending(&f).unwrap()).unwrap();
    assert_eq!(second["items"].as_array().unwrap().len(), 1);
    assert_eq!(second["items"][0]["outcome"], "promoted");
    assert_eq!(
        std::fs::read_to_string(document(f.base.root.path()))
            .unwrap()
            .matches("<!-- plur1bus-promotion:")
            .count(),
        2
    );
}
