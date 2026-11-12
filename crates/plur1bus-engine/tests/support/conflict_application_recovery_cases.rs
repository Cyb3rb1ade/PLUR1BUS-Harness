//! Actual restart, original-caller preflight and primary-commit crash boundaries.
use super::*;
struct Reopened {
    reader: Arc<MemoryReader>,
    journal: Arc<CaptureJournal>,
    store: Arc<Store>,
    host: Arc<support::TestHost>,
    principal: Principal,
    agent: AgentContext,
}
fn reopen(root: &std::path::Path, allowed: bool) -> Reopened {
    let workspace = root.join("workspace");
    let base = root.join("store");
    let host = Arc::new(support::TestHost::new(root.join("state")));
    host.set_workspace("alpha", workspace.clone());
    host.time
        .store(1735689600000 + 30 * 86400000, Ordering::SeqCst);
    let principal: Principal = serde_json::from_value(json!({
        "agentId":"alpha", "workspace":format!("workspace-dir:v1:{}",workspace.display()),
        "user":harness_user_principal("fixture"), "channel":"telegram", "accountId":"fixture",
        "chat":{"id":"fixture", "kind":"direct"}, "trust":"proved"
    }))
    .unwrap();
    let agent: AgentContext =
        serde_json::from_value(json!({"origin":"user","background":false})).unwrap();
    let store = Arc::new(
        Store::open(
            &base.join("alpha"),
            plur1bus_engine::store::OpenMode::ReadWrite,
            None,
        )
        .unwrap(),
    );
    let policy = Arc::new(Policy {
        allowed: allowed.into(),
        stop_after_log: false.into(),
        log: workspace.join(".adaptive-learning/conflict-log.jsonl"),
    });
    let journal = Arc::new(CaptureJournal::open(&root.join("neo"), host.clone(), policy).unwrap());
    let reader = Arc::new(MemoryReader::new(
        Arc::new(OperationContext::new(host.clone())),
        Arc::new(Sources(store.clone())),
        Arc::new(Embed(store.identity().unwrap().clone())),
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
fn receipt(root: &std::path::Path) -> std::path::PathBuf {
    for dir in fs::read_dir(root.join("neo/workspaces")).unwrap() {
        for entry in fs::read_dir(dir.unwrap().path()).unwrap() {
            let path = entry.unwrap().path();
            if path
                .file_name()
                .unwrap()
                .to_string_lossy()
                .starts_with("native-conflict-application-")
            {
                return path;
            }
        }
    }
    panic!("missing original confirmation receipt");
}
fn pending_fixture() -> (Fixture, String) {
    let mut f = owned_fixture();
    let proposal = propose(&f);
    let plan = f
        .ledger
        .prepare_application(
            &request(&f, &proposal),
            &f.principal,
            &f.agent,
            &Cancel::never(),
        )
        .unwrap();
    let verifier = Verifier {
        fingerprint: plan.fingerprint().into(),
        calls: 0.into(),
        allowed: true,
    };
    let proof = uuid::Uuid::new_v4().to_string();
    let auth = ApplicationAuthorization {
        verifier: &verifier,
        proof: &proof,
    };
    f.ledger = f.ledger.with_application_observer(Arc::new(|stage| {
        if stage == "confirmed" {
            Err(StoreError::Unavailable.into())
        } else {
            Ok(())
        }
    }));
    assert!(f
        .ledger
        .apply_application(&plan, Some(&auth), &f.principal, &f.agent, &Cancel::never())
        .is_err());
    assert!(!fs::read_to_string(receipt(f.root.path()))
        .unwrap()
        .contains(&proof));
    (f, plan.review()["successorId"].as_str().unwrap().into())
}
#[test]
fn fresh_component_recovers_saved_original_plan_without_a_new_confirmation_or_clock() {
    let (f, successor) = pending_fixture();
    let parts = reopen(f.root.path(), true);
    let ledger = ConflictLedger::open(parts.reader, parts.journal).unwrap();
    assert_eq!(ledger.recover_applications(&Cancel::never()).unwrap(), 0);
    let next = parts.store.get(&successor).unwrap().unwrap();
    assert_eq!(next.updated_at.as_f64(), Some(1735689600000.));
    assert_eq!(next.text, "Combined synthetic decision");
    assert_eq!(
        parts
            .store
            .get(&f.request.existing.row.id)
            .unwrap()
            .unwrap()
            .superseded_by,
        successor
    );
}
#[test]
fn startup_refuses_changed_authority_sources_forged_successor_and_bad_receipts_before_writes() {
    for mode in [
        "revoked", "moved", "source", "forged", "corrupt", "oversize", "cancel",
    ] {
        let (f, successor) = pending_fixture();
        let parts = reopen(f.root.path(), mode != "revoked");
        if mode == "moved" {
            let path = f.root.path().join("moved");
            fs::create_dir(&path).unwrap();
            parts.host.set_workspace("alpha", path);
        }
        if mode == "source" {
            parts
                .store
                .patch(
                    &f.request.existing.row.id,
                    &RowPatch {
                        text: Some("changed".into()),
                        ..Default::default()
                    },
                )
                .unwrap();
        }
        if mode == "forged" {
            use sha2::{Digest, Sha256};
            let path = receipt(f.root.path());
            let mut value: Value = serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
            value["plan"]["successor"]["ownerUserId"] = json!("forged-owner");
            value["fingerprint"] = json!(format!(
                "sha256:{:x}",
                Sha256::digest(serde_json::to_vec(&value["plan"]).unwrap())
            ));
            fs::write(path, serde_json::to_vec(&value).unwrap()).unwrap();
        }
        if mode == "corrupt" {
            fs::write(
                receipt(f.root.path()).with_file_name("native-conflict-application-invalid.json"),
                "{",
            )
            .unwrap();
        }
        if mode == "oversize" {
            fs::OpenOptions::new()
                .write(true)
                .open(receipt(f.root.path()))
                .unwrap()
                .set_len(8 * 1024 * 1024 + 1)
                .unwrap();
        }
        let cancel = Cancel::never();
        if mode == "cancel" {
            cancel.cancel();
        }
        assert!(
            ConflictLedger::new(parts.reader, parts.journal)
                .recover_applications(&cancel)
                .is_err(),
            "{mode}"
        );
        assert!(parts.store.get(&successor).unwrap().is_none(), "{mode}");
        assert_eq!(
            parts
                .store
                .get(&f.request.existing.row.id)
                .unwrap()
                .unwrap()
                .status,
            "active",
            "{mode}"
        );
    }
}
#[cfg(unix)]
#[test]
fn application_sigkill_child() {
    let Some(root) = std::env::var_os("PLUR1BUS_CONFLICT_APPLICATION_TEST_ROOT") else {
        return;
    };
    let stage = std::env::var("PLUR1BUS_CONFLICT_APPLICATION_TEST_STAGE").unwrap();
    let parts = reopen(std::path::Path::new(&root), true);
    let ledger = ConflictLedger::new(parts.reader, parts.journal).with_application_observer(
        Arc::new(move |at| {
            if at == stage {
                unsafe {
                    libc::kill(libc::getpid(), libc::SIGKILL);
                }
            }
            Ok(())
        }),
    );
    let id = "00000000-0000-4000-8000-000000000001";
    let proposal = ledger
        .find_resolution(id, &parts.principal, &parts.agent, &Cancel::never())
        .unwrap()
        .unwrap();
    let plan = ledger
        .prepare_application(
            &ApplicationRequest {
                operation_id: uuid::Uuid::new_v4(),
                memory_id: id,
                expected_proposal: &proposal,
                vector: vec![1., 0., 0., 0.],
                identity: parts.store.identity().unwrap(),
            },
            &parts.principal,
            &parts.agent,
            &Cancel::never(),
        )
        .unwrap();
    let verifier = Verifier {
        fingerprint: plan.fingerprint().into(),
        calls: 0.into(),
        allowed: true,
    };
    let proof = uuid::Uuid::new_v4().to_string();
    ledger
        .apply_application(
            &plan,
            Some(&ApplicationAuthorization {
                verifier: &verifier,
                proof: &proof,
            }),
            &parts.principal,
            &parts.agent,
            &Cancel::never(),
        )
        .unwrap();
    panic!("fault boundary not reached");
}
#[cfg(unix)]
#[test]
fn sigkill_after_confirmation_successor_supersede_or_completion_recovers_one_version_chain() {
    use std::os::unix::process::ExitStatusExt;
    for stage in ["confirmed", "successor", "superseded", "complete"] {
        let f = owned_fixture();
        propose(&f);
        let status = std::process::Command::new(std::env::current_exe().unwrap())
            .args([
                "--exact",
                "application_cases::recovery_cases::application_sigkill_child",
                "--nocapture",
            ])
            .env("PLUR1BUS_CONFLICT_APPLICATION_TEST_ROOT", f.root.path())
            .env("PLUR1BUS_CONFLICT_APPLICATION_TEST_STAGE", stage)
            .status()
            .unwrap();
        assert_eq!(status.signal(), Some(libc::SIGKILL), "{stage}");
        let parts = reopen(f.root.path(), true);
        let saved: Value =
            serde_json::from_slice(&fs::read(receipt(f.root.path())).unwrap()).unwrap();
        let ledger = ConflictLedger::open(parts.reader, parts.journal).unwrap();
        assert_eq!(ledger.recover_applications(&Cancel::never()).unwrap(), 0);
        let id = saved["plan"]["successor"]["id"].as_str().unwrap();
        assert_eq!(
            serde_json::to_value(parts.store.get(id).unwrap().unwrap()).unwrap(),
            saved["plan"]["successor"]
        );
        assert_eq!(
            parts
                .store
                .get(&f.request.existing.row.id)
                .unwrap()
                .unwrap()
                .superseded_by,
            id
        );
        assert_eq!(
            parts
                .store
                .scan(&plur1bus_engine::store::RowFilter::default(), 10)
                .unwrap()
                .len(),
            3
        );
    }
}

#[test]
fn pending_confirmation_fences_other_native_writers_until_original_recovery() {
    use plur1bus_engine::{
        capture::interference::InterferenceOptions,
        ops::interference::{InterferenceRequest, NativeInterference},
    };
    let (f, _) = pending_fixture();
    let parts = reopen(f.root.path(), true);
    let request = InterferenceRequest {
        operation_id: uuid::Uuid::new_v4(),
        source: parts
            .store
            .get_record(&f.request.new.row.id)
            .unwrap()
            .unwrap(),
        options: InterferenceOptions::default(),
    };
    let interference = NativeInterference::new(parts.reader.clone(), parts.journal.clone());
    assert!(interference
        .apply(&request, &parts.principal, &parts.agent, &Cancel::never())
        .is_err());
    let turn: plur1bus_engine::contract::TurnRecord = serde_json::from_value(json!({
        "agentId":"alpha","principal":parts.principal,"agent":parts.agent,"runId":"automatic","sessionKey":"automatic",
        "incognito":false,"messages":[{"role":"user","content":"Synthetic automatic capture"}]
    })).unwrap();
    let ctx = RequestContext::build(&turn.principal, &turn.agent, parts.host.as_ref()).unwrap();
    assert!(parts.journal.record(&turn, &ctx, &Cancel::never()).is_err());
    assert!(!receipt(f.root.path())
        .parent()
        .unwrap()
        .join("turn-journal.jsonl")
        .exists());
    ConflictLedger::open(parts.reader, parts.journal.clone()).unwrap();
    assert!(parts.journal.record(&turn, &ctx, &Cancel::never()).is_ok());
}
#[test]
fn completed_receipt_never_recreates_deleted_or_changed_rows_and_missing_receipt_never_guesses() {
    for mode in ["changed", "deleted", "lost"] {
        let f = owned_fixture();
        let proposal = propose(&f);
        let plan = f
            .ledger
            .prepare_application(
                &request(&f, &proposal),
                &f.principal,
                &f.agent,
                &Cancel::never(),
            )
            .unwrap();
        let verifier = Verifier {
            fingerprint: plan.fingerprint().into(),
            calls: 0.into(),
            allowed: true,
        };
        let proof = uuid::Uuid::new_v4().to_string();
        let auth = ApplicationAuthorization {
            verifier: &verifier,
            proof: &proof,
        };
        let first = f
            .ledger
            .apply_application(&plan, Some(&auth), &f.principal, &f.agent, &Cancel::never())
            .unwrap();
        if mode == "changed" {
            f.store
                .patch(
                    &first.new_id,
                    &RowPatch {
                        text: Some("subsequent edit".into()),
                        ..Default::default()
                    },
                )
                .unwrap();
        }
        if mode == "deleted" {
            f.store
                .patch(
                    &first.new_id,
                    &RowPatch {
                        status: Some("deleted".into()),
                        ..Default::default()
                    },
                )
                .unwrap();
        }
        if mode == "lost" {
            fs::remove_file(receipt(f.root.path())).unwrap();
        }
        assert!(
            f.ledger
                .apply_application(&plan, Some(&auth), &f.principal, &f.agent, &Cancel::never())
                .is_err(),
            "{mode}"
        );
        assert_eq!(verifier.calls.load(Ordering::SeqCst), 1, "{mode}");
    }
}
#[test]
fn concurrent_confirmations_commit_one_successor_and_one_verified_plan() {
    let f = owned_fixture();
    let proposal = propose(&f);
    let plan = f
        .ledger
        .prepare_application(
            &request(&f, &proposal),
            &f.principal,
            &f.agent,
            &Cancel::never(),
        )
        .unwrap();
    let verifier = Verifier {
        fingerprint: plan.fingerprint().into(),
        calls: 0.into(),
        allowed: true,
    };
    let proof = uuid::Uuid::new_v4().to_string();
    let auth = ApplicationAuthorization {
        verifier: &verifier,
        proof: &proof,
    };
    std::thread::scope(|scope| {
        let calls = (0..4)
            .map(|_| {
                scope.spawn(|| {
                    f.ledger.apply_application(
                        &plan,
                        Some(&auth),
                        &f.principal,
                        &f.agent,
                        &Cancel::never(),
                    )
                })
            })
            .collect::<Vec<_>>();
        let results = calls
            .into_iter()
            .map(|call| call.join().unwrap().unwrap())
            .collect::<Vec<_>>();
        assert_eq!(results.iter().filter(|result| !result.replayed).count(), 1);
        assert!(results
            .iter()
            .all(|result| result.new_id == results[0].new_id));
    });
    assert_eq!(verifier.calls.load(Ordering::SeqCst), 1);
    assert_eq!(
        f.store
            .scan(&plur1bus_engine::store::RowFilter::default(), 10)
            .unwrap()
            .len(),
        3
    );
}
