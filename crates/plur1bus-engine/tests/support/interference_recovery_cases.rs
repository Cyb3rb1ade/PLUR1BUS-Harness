//! Startup must preflight all receipt files and retain the original current authority.
use super::*;
#[test]
fn startup_refuses_revocation_relocation_corruption_and_oversize_before_writes() {
    for mode in ["revoked", "relocated", "corrupt", "oversize", "cancel"] {
        let mut f = setup();
        f.ledger = f.ledger.with_observer(Arc::new(|stage| {
            if stage == "prepared" {
                Err(StoreError::Unavailable.into())
            } else {
                Ok(())
            }
        }));
        assert!(f
            .ledger
            .apply(&f.request, &f.principal, &f.agent, &Cancel::never())
            .is_err());
        let p = receipt(f.root.path());
        let parts = reopen_policy(f.root.path(), mode != "revoked");
        if mode == "relocated" {
            let moved = f.root.path().join("different");
            fs::create_dir(&moved).unwrap();
            parts.host.set_workspace("alpha", moved);
        }
        if mode == "corrupt" {
            fs::write(
                p.parent().unwrap().join("native-interference-invalid.json"),
                "{",
            )
            .unwrap();
        }
        if mode == "oversize" {
            fs::OpenOptions::new()
                .write(true)
                .open(p)
                .unwrap()
                .set_len(8 * 1024 * 1024 + 1)
                .unwrap();
        }
        let cancel = Cancel::never();
        if mode == "cancel" {
            cancel.cancel();
        }
        let adapter = NativeInterference::new(parts.reader, parts.journal);
        assert!(adapter.recover_pending(&cancel).is_err(), "{mode}");
        assert_eq!(
            parts
                .store
                .get("00000000-0000-4000-8000-000000000002")
                .unwrap()
                .unwrap()
                .memory_strength
                .as_f64()
                .unwrap(),
            0.8,
            "{mode}"
        );
    }
}
#[test]
fn receipt_inventory_cap_does_not_silently_remove_old_idempotency_receipts() {
    let mut f = setup();
    f.ledger
        .apply(&f.request, &f.principal, &f.agent, &Cancel::never())
        .unwrap();
    let p = receipt(f.root.path());
    let bytes = fs::read(&p).unwrap();
    for i in 1..512 {
        fs::write(
            p.parent()
                .unwrap()
                .join(format!("native-interference-cap-{i}.json")),
            &bytes,
        )
        .unwrap();
    }
    f.request.operation_id = uuid::Uuid::new_v4();
    assert!(f
        .ledger
        .apply(&f.request, &f.principal, &f.agent, &Cancel::never())
        .is_err());
    assert_eq!(fs::read(p).unwrap(), bytes);
}
#[test]
fn automatic_capture_waits_for_original_interference_recovery() {
    let mut f = setup();
    f.ledger = f.ledger.with_observer(Arc::new(|stage| {
        if stage == "prepared" {
            Err(StoreError::Unavailable.into())
        } else {
            Ok(())
        }
    }));
    assert!(f
        .ledger
        .apply(&f.request, &f.principal, &f.agent, &Cancel::never())
        .is_err());
    let parts = reopen(f.root.path());
    let turn:plur1bus_engine::contract::TurnRecord=serde_json::from_value(json!({"agentId":"alpha","principal":parts.principal,"agent":parts.agent,"runId":"automatic","sessionKey":"automatic","incognito":false,"messages":[{"role":"user","content":"Synthetic automatic capture"}]})).unwrap();
    let ctx = plur1bus_engine::context::RequestContext::build(
        &turn.principal,
        &turn.agent,
        parts.host.as_ref(),
    )
    .unwrap();
    assert!(parts.journal.record(&turn, &ctx, &Cancel::never()).is_err());
    assert!(!receipt(f.root.path())
        .parent()
        .unwrap()
        .join("turn-journal.jsonl")
        .exists());
    NativeInterference::open(parts.reader, parts.journal.clone()).unwrap();
    assert!(parts.journal.record(&turn, &ctx, &Cancel::never()).is_ok());
}
