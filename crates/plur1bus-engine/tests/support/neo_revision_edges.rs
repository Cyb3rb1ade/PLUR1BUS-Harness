//! Extra native C4 authority, concurrency and corruption regressions.
use super::*;

fn seeded() -> (Fixture, RevisionRequest) {
    let f = fixture();
    let case = cases().remove(4);
    let request = request(&case, source(&f, &case));
    (f, request)
}
fn apply(
    f: &Fixture,
    request: &RevisionRequest,
) -> Result<plur1bus_engine::neo::revisions::RevisionResult, EngineError> {
    f.store
        .apply(&f.principal, &f.agent, request, &Cancel::never())
}
fn append(path: impl AsRef<std::path::Path>, value: &Json) {
    use std::io::Write;
    writeln!(
        fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(path)
            .unwrap(),
        "{}",
        write_json(value)
    )
    .unwrap();
}
#[test]
fn future_or_foreign_latest_behavior_cannot_fall_back_to_an_owned_candidate() {
    for future in [false, true] {
        let (f, mut request) = seeded();
        fs::write(
            f.directory.join("memory-candidates.jsonl"),
            format!("{}\n", write_json(&request.expected)),
        )
        .unwrap();
        let mut latest = request.expected.clone();
        set(&mut latest, "updatedAt", text("2099-01-01T00:00:00.000Z"));
        if !future {
            set(
                &mut latest,
                "ownerUserId",
                text(&harness_user_principal("foreign")),
            );
        }
        append(f.directory.join("behavior-cards.jsonl"), &latest);
        if future {
            request.expected = latest;
        }
        assert!(apply(&f, &request).is_err());
        assert_eq!(rows(f.directory.join("behavior-cards.jsonl")).len(), 2);
        assert!(!f.workspace.join(".adaptive-learning").exists());
    }
}
#[test]
fn global_user_revision_preserves_other_agent_and_never_crosses_owner() {
    for foreign in [false, true] {
        let (f, mut request) = seeded();
        set(&mut request.expected, "scope", text("global_user"));
        set(&mut request.expected, "agentId", text("beta"));
        if foreign {
            set(
                &mut request.expected,
                "ownerUserId",
                text(&harness_user_principal("foreign")),
            );
        }
        fs::write(
            f.directory.join("behavior-cards.jsonl"),
            format!("{}\n", write_json(&request.expected)),
        )
        .unwrap();
        let result = apply(&f, &request);
        if foreign {
            assert!(result.is_err());
        } else {
            let result = result.unwrap();
            assert_eq!(field(&result.record, "agentId"), &text("beta"));
            assert_eq!(field(&result.record, "scope"), &text("global_user"));
            let queue = rows(f.directory.join("embedding-queue.jsonl"));
            assert_eq!(field(&queue[0], "agentId"), &text("beta"));
            assert_eq!(field(&queue[0], "scope"), &text("global_user"));
        }
    }
}
#[test]
fn scope_conflicts_missing_sources_and_ownerless_sources_are_refused() {
    for mode in ["nested", "missing", "ownerless"] {
        let (f, mut request) = seeded();
        match mode {
            "nested" => set(
                &mut request.expected,
                "visibility",
                parse_json("{\"scope\":\"global_user\"}").unwrap(),
            ),
            "ownerless" => set(&mut request.expected, "ownerUserId", text("")),
            _ => (),
        }
        fs::write(
            f.directory.join("behavior-cards.jsonl"),
            if mode == "missing" {
                String::new()
            } else {
                format!("{}\n", write_json(&request.expected))
            },
        )
        .unwrap();
        assert!(apply(&f, &request).is_err());
        assert!(!f.directory.join("native-revision-state.json").exists());
    }
}
#[test]
fn corrupt_or_torn_journals_are_not_repaired_without_an_exact_prepared_append() {
    for file in [
        "behavior-cards.jsonl",
        "memory-candidates.jsonl",
        "embedding-queue.jsonl",
        "candidate-index.jsonl",
    ] {
        for bytes in [b"broken\n".as_slice(), b"{\"torn\":".as_slice()] {
            let (f, request) = seeded();
            fs::write(f.directory.join(file), bytes).unwrap();
            assert!(apply(&f, &request).is_err());
            assert_eq!(fs::read(f.directory.join(file)).unwrap(), bytes);
        }
    }
}
#[test]
fn existing_unwritable_audit_refuses_before_revision_and_queue() {
    let (f, request) = seeded();
    fs::create_dir_all(f.workspace.join(".adaptive-learning/destructive-ops.jsonl")).unwrap();
    assert!(apply(&f, &request).is_err());
    assert_eq!(rows(f.directory.join("behavior-cards.jsonl")).len(), 1);
    assert!(!f.directory.join("embedding-queue.jsonl").exists());
}
#[test]
fn workspace_replacement_and_clock_regression_are_not_silently_accepted() {
    let (f, request) = seeded();
    f.host.time.store(1, Ordering::SeqCst);
    assert!(apply(&f, &request).is_err());
    f.host.time.store(1794139200000, Ordering::SeqCst);
    apply(&f, &request).unwrap();
    let moved = f.workspace.with_extension("saved");
    fs::rename(&f.workspace, moved).unwrap();
    fs::create_dir(&f.workspace).unwrap();
    assert!(apply(&f, &request).is_err());
}
#[test]
fn concurrent_same_request_has_one_revision_audit_and_queue() {
    let (f, request) = seeded();
    std::thread::scope(|scope| {
        let handles = (0..4)
            .map(|_| scope.spawn(|| apply(&f, &request)))
            .collect::<Vec<_>>();
        for handle in handles {
            handle.join().unwrap().unwrap();
        }
    });
    assert_eq!(rows(f.directory.join("behavior-cards.jsonl")).len(), 2);
    assert_eq!(rows(f.directory.join("embedding-queue.jsonl")).len(), 1);
    assert_eq!(
        rows(f.workspace.join(".adaptive-learning/destructive-ops.jsonl")).len(),
        1
    );
}
#[test]
fn older_receipt_cannot_apply_the_transition_again_after_a_later_decision() {
    let (f, request) = seeded();
    let first = apply(&f, &request).unwrap();
    let next = RevisionRequest {
        operation_id: uuid::Uuid::new_v4(),
        expected: first.record,
        action: Action::Demote,
    };
    let second = apply(&f, &next).unwrap();
    assert!(apply(&f, &request).is_err());
    assert_eq!(
        rows(f.directory.join("behavior-cards.jsonl")).last(),
        Some(&second.record)
    );
    assert_eq!(rows(f.directory.join("behavior-cards.jsonl")).len(), 3);
}

#[test]
fn newest_revision_wins_even_when_a_stale_copy_is_physically_last() {
    let case = cases().remove(5);
    let f = fixture();
    let current = source(&f, &case);
    append(
        f.directory.join("behavior-cards.jsonl"),
        &bound(&f, field(&case, "hint")),
    );
    let result = apply(&f, &request(&case, current)).unwrap();
    assert_eq!(result.record, bound(&f, field(&case, "revision")));
}
#[test]
fn pending_queue_is_preserved_but_a_foreign_pending_identity_cannot_suppress_work() {
    for foreign in [false, true] {
        let (f, request) = seeded();
        let result = apply(&f, &request).unwrap();
        let path = f.directory.join("embedding-queue.jsonl");
        let mut queue = rows(&path).remove(0);
        set(&mut queue, "status", text("pending"));
        if foreign {
            set(
                &mut queue,
                "ownerUserId",
                text(&harness_user_principal("foreign")),
            );
        }
        fs::write(&path, format!("{}\n", write_json(&queue))).unwrap();
        let next = RevisionRequest {
            operation_id: uuid::Uuid::new_v4(),
            expected: result.record,
            action: Action::Demote,
        };
        let result = apply(&f, &next);
        assert_eq!(result.is_err(), foreign);
        assert_eq!(rows(&path), vec![queue]);
        assert_eq!(
            rows(f.directory.join("behavior-cards.jsonl")).len(),
            if foreign { 2 } else { 3 }
        );
    }
}
#[test]
fn invalid_or_oversized_requests_create_no_plan() {
    for kind in ["nil", "id", "row"] {
        let (f, mut request) = seeded();
        match kind {
            "nil" => request.operation_id = uuid::Uuid::nil(),
            "id" => set(&mut request.expected, "id", text(&"x".repeat(1025))),
            _ => set(
                &mut request.expected,
                "opaque",
                text(&"x".repeat(1024 * 1024)),
            ),
        }
        assert!(apply(&f, &request).is_err());
        assert!(!f.directory.join("native-revision-state.json").exists());
        assert_eq!(rows(f.directory.join("behavior-cards.jsonl")).len(), 1);
    }
}

#[test]
fn full_historical_candidate_index_refuses_before_publishing_an_unreadable_index() {
    let f = fixture();
    let case = cases().remove(16);
    let request = request(&case, source(&f, &case));
    let index = (0..50_000)
        .map(|i| format!("{{\"id\":\"old-{i}\",\"status\":\"candidate\"}}\n"))
        .collect::<String>();
    let path = f.directory.join("candidate-index.jsonl");
    fs::write(&path, &index).unwrap();
    assert!(apply(&f, &request).is_err());
    assert_eq!(fs::read_to_string(&path).unwrap(), index);
    assert_eq!(rows(f.directory.join("memory-candidates.jsonl")).len(), 1);
    assert!(!f.directory.join("native-revision-state.json").exists());
}
#[cfg(unix)]
#[test]
fn symlinks_and_hardlinks_are_refused_without_touching_the_target() {
    for file in [
        "behavior-cards.jsonl",
        "native-revision-state.json",
        "candidate-index.jsonl",
        "record-index.json",
    ] {
        for hard in [false, true] {
            let (f, request) = seeded();
            let target = f._root.path().join("outside");
            fs::write(&target, b"{}\n").unwrap();
            let path = f.directory.join(file);
            if path.exists() {
                fs::remove_file(&path).unwrap();
            }
            if hard {
                fs::hard_link(&target, &path).unwrap();
            } else {
                std::os::unix::fs::symlink(&target, &path).unwrap();
            }
            assert!(apply(&f, &request).is_err());
            assert_eq!(fs::read(&target).unwrap(), b"{}\n");
        }
    }
}

#[cfg(feature = "testkit")]
#[path = "neo_revision_recovery.rs"]
mod recovery;
