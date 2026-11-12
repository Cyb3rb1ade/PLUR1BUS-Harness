//! Native D130, provider-space, source revision and cancellation exceptions.
use super::oracle::{input, recorded};
use super::*;
fn all() -> DrainOptions {
    DrainOptions {
        impact: Impact::All,
        ..DrainOptions::default()
    }
}
#[test]
fn foreign_targets_hidden_queue_and_tombstones_never_reach_provider() {
    for mode in ["foreign", "queue", "deleted"] {
        let f = setup();
        input(
            &f,
            &recorded("foreign-target-is-not-authorized-by-node-drain"),
        );
        if mode == "queue" {
            let mut q = rows(&f.directory, "embedding-queue.jsonl");
            q[0]["ownerUserId"] = json!(harness_user_principal("two"));
            fs::write(
                f.directory.join("embedding-queue.jsonl"),
                q.iter().map(|v| format!("{v}\n")).collect::<String>(),
            )
            .unwrap();
        }
        if mode == "deleted" {
            input(&f, &recorded("provider-normal"));
            let mut t = rows(&f.directory, "turn-journal.jsonl");
            t[0]["deleted"] = json!(true);
            fs::write(
                f.directory.join("turn-journal.jsonl"),
                t.iter().map(|v| format!("{v}\n")).collect::<String>(),
            )
            .unwrap();
        }
        let p = Arc::new(Embedder::new());
        let worker = drain(&f, p.clone());
        let result = worker
            .drain(&f.turn.principal, &f.turn.agent, &all(), &Cancel::never())
            .unwrap();
        assert_eq!(result.processed, 1);
        assert_eq!(result.pending, 0);
        assert_eq!(result.skipped, usize::from(mode != "queue"));
        assert_eq!(
            *p.calls.lock().unwrap(),
            vec!["Second durable fixture fact"]
        );
    }
}
#[test]
fn semantic_revision_wins_over_a_later_physical_old_timestamp() {
    let f = setup();
    input(&f, &recorded("latest-physical-revision"));
    let p = Arc::new(Embedder::new());
    drain(&f, p.clone())
        .drain(&f.turn.principal, &f.turn.agent, &all(), &Cancel::never())
        .unwrap();
    assert_eq!(p.calls.lock().unwrap()[0], "First durable fixture fact");
    assert_eq!(
        rows(&f.directory, "turn-journal.jsonl")[3]["content"],
        "First durable fixture fact"
    );
}
#[test]
fn failed_attempts_consume_budget_and_do_not_persist_provider_error_text() {
    let f = setup();
    input(&f, &recorded("failed-attempt-budget"));
    let p = Arc::new(Embedder::new());
    p.fail.store(true, Ordering::SeqCst);
    let result = drain(&f, p.clone())
        .drain(
            &f.turn.principal,
            &f.turn.agent,
            &DrainOptions {
                max_items: 1,
                ..all()
            },
            &Cancel::never(),
        )
        .unwrap();
    assert_eq!(result.deferred, 1);
    assert_eq!(result.pending, 1);
    assert_eq!(p.calls.lock().unwrap().len(), 1);
    assert_eq!(
        rows(&f.directory, "embedding-queue.jsonl").last().unwrap()["reason"],
        "embedder_failed"
    );
}
#[test]
fn cancellation_or_revocation_during_inference_publishes_no_plan_or_vector() {
    for revoke in [false, true] {
        let f = setup();
        input(&f, &recorded("provider-normal"));
        let p = Arc::new(Embedder::new());
        let policy = f.policy.clone();
        *p.action.lock().unwrap() = Some(Arc::new(move |cancel| {
            if revoke {
                policy.allowed.store(false, Ordering::SeqCst);
            } else {
                cancel.cancel();
            }
        }));
        let worker = drain(&f, p.clone());
        let before = fs::read(f.directory.join("embedding-queue.jsonl")).unwrap();
        assert!(worker
            .drain(&f.turn.principal, &f.turn.agent, &all(), &Cancel::never())
            .is_err());
        assert_eq!(p.calls.lock().unwrap().len(), 1);
        assert_eq!(
            fs::read(f.directory.join("embedding-queue.jsonl")).unwrap(),
            before
        );
        assert!(!f.directory.join("vector-index.json").exists());
        assert!(!fs::read_dir(&f.directory).unwrap().any(|v| v
            .unwrap()
            .file_name()
            .to_string_lossy()
            .starts_with("native-embedding-pending-")));
    }
}
#[test]
fn provider_side_effect_cannot_disclose_a_changed_next_target() {
    let f = setup();
    input(&f, &recorded("provider-normal"));
    let p = Arc::new(Embedder::new());
    let directory = f.directory.clone();
    *p.action.lock().unwrap() = Some(Arc::new(move |_| {
        let mut targets = rows(&directory, "turn-journal.jsonl");
        targets[1]["ownerUserId"] = json!(harness_user_principal("two"));
        fs::write(
            directory.join("turn-journal.jsonl"),
            targets.iter().map(|v| format!("{v}\n")).collect::<String>(),
        )
        .unwrap();
    }));
    assert!(drain(&f, p.clone())
        .drain(&f.turn.principal, &f.turn.agent, &all(), &Cancel::never())
        .is_err());
    assert_eq!(p.calls.lock().unwrap().len(), 1);
    assert!(!f.directory.join("vector-index.json").exists());
}
#[test]
fn unbound_legacy_sidecar_and_changed_model_are_refused_before_inference() {
    let f = setup();
    input(&f, &recorded("provider-normal"));
    let p = Arc::new(Embedder::new());
    let worker = drain(&f, p);
    worker
        .drain(
            &f.turn.principal,
            &f.turn.agent,
            &DrainOptions {
                max_items: 1,
                ..all()
            },
            &Cancel::never(),
        )
        .unwrap();
    let mut replacement = Embedder::new();
    replacement.identity.model = "another-fixture".into();
    let replacement = Arc::new(replacement);
    assert!(drain(&f, replacement.clone())
        .drain(&f.turn.principal, &f.turn.agent, &all(), &Cancel::never())
        .is_err());
    assert!(replacement.calls.lock().unwrap().is_empty());
    fs::remove_file(f.directory.join("native-vector-space.json")).unwrap();
    let p = Arc::new(Embedder::new());
    assert!(drain(&f, p.clone())
        .drain(&f.turn.principal, &f.turn.agent, &all(), &Cancel::never())
        .is_err());
    assert!(p.calls.lock().unwrap().is_empty());
}

#[test]
fn repeated_target_keeps_vector_appends_but_only_the_final_metadata_revision() {
    let f = setup();
    input(&f, &recorded("provider-normal"));
    let mut queue = rows(&f.directory, "embedding-queue.jsonl");
    let mut duplicate = queue[0].clone();
    duplicate["id"] = json!("same-target-high-impact");
    duplicate["impact"] = json!("high");
    queue.push(duplicate);
    fs::write(
        f.directory.join("embedding-queue.jsonl"),
        queue.iter().map(|v| format!("{v}\n")).collect::<String>(),
    )
    .unwrap();
    let p = Arc::new(Embedder::new());
    let result = drain(&f, p.clone())
        .drain(&f.turn.principal, &f.turn.agent, &all(), &Cancel::never())
        .unwrap();
    assert_eq!(result.processed, 3);
    assert_eq!(p.calls.lock().unwrap().len(), 3);
    assert_eq!(
        fs::read(f.directory.join("vectors.0.f32")).unwrap().len(),
        36
    );
    let manifest: Value =
        serde_json::from_slice(&fs::read(f.directory.join("vector-index.json")).unwrap()).unwrap();
    assert_eq!(manifest["entries"]["turn-first"]["offset"], 24);
    let turns = rows(&f.directory, "turn-journal.jsonl");
    assert_eq!(turns.len(), 4);
    assert_eq!(turns[2]["embeddingImpact"], "high");
}

#[test]
fn capture_hook_reserves_budget_and_does_not_embed_incognito_or_cancelled_work() {
    use plur1bus_engine::{
        capture::{emotion_pool::EmotionalPool, pipeline::NeoCaptureHook},
        neo::capture_hook::NativeNeoCaptureHook,
    };
    use std::time::{Duration, Instant};
    let f = setup();
    f.journal
        .process(&f.turn, &f.context, &Cancel::never())
        .unwrap();
    let p = Arc::new(Embedder::new());
    let hook = NativeNeoCaptureHook::open(
        f.root.path(),
        f.host.clone(),
        f.policy.clone(),
        Arc::new(EmotionalPool::new(f.host.clone(), json!({}))),
    )
    .unwrap()
    .with_embedder(p.clone())
    .unwrap();
    for cancel in [
        Cancel::never(),
        Cancel::with_deadline(Instant::now() + Duration::from_secs(12)),
    ] {
        hook.after_capture(&f.turn, &f.context, &cancel).unwrap();
    }
    let mut private = f.turn.clone();
    private.incognito = true;
    hook.after_capture(
        &private,
        &f.context,
        &Cancel::with_deadline(Instant::now() + Duration::from_secs(60)),
    )
    .unwrap();
    let cancelled = Cancel::never();
    cancelled.cancel();
    hook.after_capture(&f.turn, &f.context, &cancelled).unwrap();
    assert!(p.calls.lock().unwrap().is_empty());
    hook.after_capture(
        &f.turn,
        &f.context,
        &Cancel::with_deadline(Instant::now() + Duration::from_secs(60)),
    )
    .unwrap();
    assert_eq!(p.calls.lock().unwrap().len(), 12);
}
