//! Real filesystem collisions and mutations must not turn partial work into destructive success.
use super::*;
#[cfg(unix)]
#[test]
fn archive_audit_and_receipt_links_refuse_without_touching_outside_files() {
    for kind in ["archive", "audit", "receipt"] {
        for hard in [false, true] {
            let f = fixture::setup();
            let p = fixture::reopen(f.root.path());
            let req = request(&p);
            let merge = NativeMerge::new(p.reader, p.journal).with_observer(Arc::new(|s| {
                if s == "archived" {
                    Err(StoreError::Unavailable.into())
                } else {
                    Ok(())
                }
            }));
            assert!(merge
                .apply(&req, &p.principal, &p.agent, &Cancel::never())
                .is_err());
            drop(merge);
            let path = match kind {
                "archive" => f.root.path().join(format!(
                    "state/memory/_archive/alpha/2025-01-01T00-00-00-000Z-{}.json",
                    req.source.row.id
                )),
                "audit" => {
                    let p = f
                        .root
                        .path()
                        .join("workspace/.adaptive-learning/destructive-ops.jsonl");
                    std::fs::write(&p, "{}\n").unwrap();
                    p
                }
                _ => receipt(f.root.path()),
            };
            let outside = f.root.path().join("outside");
            std::fs::rename(&path, &outside).unwrap();
            let before = std::fs::read(&outside).unwrap();
            if hard {
                std::fs::hard_link(&outside, &path).unwrap();
            } else {
                std::os::unix::fs::symlink(&outside, &path).unwrap();
            }
            let p = fixture::reopen(f.root.path());
            let merge = NativeMerge::new(p.reader, p.journal);
            assert!(
                merge
                    .apply(&req, &p.principal, &p.agent, &Cancel::never())
                    .is_err(),
                "{kind} {hard}"
            );
            assert_eq!(std::fs::read(outside).unwrap(), before);
            assert!(p.store.get(&req.source.row.id).unwrap().is_some());
        }
    }
}
#[test]
fn source_or_replacement_mutation_after_store_refuses_before_delete() {
    for kind in ["source", "replacement"] {
        let f = fixture::setup();
        let p = fixture::reopen(f.root.path());
        let req = request(&p);
        let store = p.store.clone();
        let id = if kind == "source" {
            req.source.row.id.clone()
        } else {
            req.replacement.id.clone()
        };
        let merge = NativeMerge::new(p.reader, p.journal).with_observer(Arc::new(move |stage| {
            if stage == "replacement-write" {
                store.patch(
                    &id,
                    &RowPatch {
                        text: Some("changed under writer".into()),
                        ..Default::default()
                    },
                )?;
            }
            Ok(())
        }));
        assert!(merge
            .apply(&req, &p.principal, &p.agent, &Cancel::never())
            .is_err());
        assert!(p.store.get(&req.source.row.id).unwrap().is_some());
        assert!(!f
            .root
            .path()
            .join("workspace/.adaptive-learning/destructive-ops.jsonl")
            .exists());
    }
}
#[test]
fn metadata_bounds_and_false_epistemic_claims_refuse_before_any_archive() {
    for kind in [
        "metadata-size",
        "trusted",
        "lineage",
        "dimension",
        "nonfinite",
        "foreign",
    ] {
        let f = fixture::setup();
        let p = fixture::reopen(f.root.path());
        let mut req = request(&p);
        match kind {
            "metadata-size" => req.replacement.evidence_quote = "x".repeat(8 * 1024 * 1024 + 1),
            "trusted" => req.replacement.epistemic_status = "trusted".into(),
            "lineage" => req.replacement.merged_from = "[]".into(),
            "dimension" => req.replacement.vector.push(0.),
            "nonfinite" => req.replacement.vector[0] = f32::NAN,
            _ => req.replacement.owner_user_id = "other".into(),
        }
        let merge = NativeMerge::new(p.reader, p.journal);
        assert!(
            merge
                .apply(&req, &p.principal, &p.agent, &Cancel::never())
                .is_err(),
            "{kind}"
        );
        assert!(p.store.get(&req.source.row.id).unwrap().is_some());
        assert!(!f.root.path().join("state/memory/_archive").exists());
    }
}
#[test]
fn already_exact_replacement_is_verified_before_source_is_deleted() {
    let f = fixture::setup();
    let p = fixture::reopen(f.root.path());
    let req = request(&p);
    p.store
        .upsert(std::slice::from_ref(&req.replacement))
        .unwrap();
    let merge = NativeMerge::new(p.reader, p.journal);
    merge
        .apply(&req, &p.principal, &p.agent, &Cancel::never())
        .unwrap();
    assert!(p.store.get(&req.source.row.id).unwrap().is_none());
}
#[test]
fn state_directory_replacement_refuses_without_recreating_original_archive() {
    let f = fixture::setup();
    let p = fixture::reopen(f.root.path());
    let req = request(&p);
    let merge = NativeMerge::new(p.reader, p.journal).with_observer(Arc::new(|s| {
        if s == "prepared" {
            Err(StoreError::Unavailable.into())
        } else {
            Ok(())
        }
    }));
    assert!(merge
        .apply(&req, &p.principal, &p.agent, &Cancel::never())
        .is_err());
    drop(merge);
    let state = f.root.path().join("state");
    std::fs::rename(&state, f.root.path().join("old-state")).unwrap();
    std::fs::create_dir(&state).unwrap();
    let p = fixture::reopen(f.root.path());
    assert!(NativeMerge::open(p.reader, p.journal).is_err());
    assert!(p.store.get(&req.source.row.id).unwrap().is_some());
    assert!(!state.join("memory/_archive").exists());
}
