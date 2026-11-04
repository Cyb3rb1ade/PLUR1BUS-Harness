//! properties cases for RS0.
use super::*;

// ----
// Property tests
// ----

fn pool_node(k: usize) -> String {
    uuid::Uuid::from_u128(10 + (k % 3) as u128).to_string()
}
fn pool_cluster(k: usize) -> String {
    uuid::Uuid::from_u128(100 + (k % 2) as u128).to_string()
}
fn pool_handover(k: usize) -> String {
    uuid::Uuid::from_u128(200 + (k % 2) as u128).to_string()
}
fn pool_sha(k: usize) -> String {
    hex_sha256(&format!("b{}", k % 2))
}
fn pool_ref(k: usize) -> NodeRef {
    node_ref(&pool_node(k), &format!("k{}", k % 3))
}

#[allow(clippy::too_many_arguments)]
fn gen_event(kind: u8, i: usize, j: usize, e: u64, step: u64, flag: bool) -> Event {
    let ttl = 60_000 + step / 2;
    match kind % 14 {
        0 => Event::Prepare {
            handover_id: pool_handover(i),
            target_node_id: pool_node(j),
            target_key_fingerprint: fp(&format!("k{}", j % 3)),
            new_cluster_id: flag.then(|| pool_cluster(i)),
            lease_ttl_ms: ttl,
        },
        1 => Event::BundleReady {
            bundle_sha256: pool_sha(i),
        },
        2 => Event::RenewLease { lease_ttl_ms: ttl },
        3 => Event::Abort,
        4 => Event::Commit {
            receipt_handover_id: pool_handover(i),
            receipt_bundle_sha256: pool_sha(j),
            receipt_target_node_id: pool_node(j),
            primary: pool_ref(j),
            rollback_window_ms: 100_000,
        },
        5 => Event::Accept {
            handover_id: pool_handover(i),
            cluster_id: pool_cluster(j),
            bundle_epoch: e,
            bundle_sha256: pool_sha(i),
            source_node_id: pool_node(j),
            source_key_fingerprint: fp(&format!("k{}", j % 3)),
            target_is_fresh: flag,
            replace: e.is_multiple_of(2),
            lease_ttl_ms: ttl,
        },
        6 => Event::Activate {
            token_handover_id: pool_handover(i),
            token_cluster_id: pool_cluster(j),
            token_epoch: e,
            token_bundle_sha256: pool_sha(i),
            token_target_node_id: pool_node(j),
        },
        7 => Event::Discard,
        8 => Event::ForceTakeover {
            min_unreachable_ms: step,
            confirmed: flag,
        },
        9 => Event::RestoreFrozen {
            confirmed: flag,
            server_demoted_epoch: e,
        },
        10 => Event::Observed {
            peer_node_id: id(),
            peer_is_writer: false,
            cluster_id: pool_cluster(i),
            epoch: e,
            primary: flag.then(|| pool_ref(j)),
        },
        11 => Event::ResolveAsClient {
            epoch: e,
            primary: pool_ref(j),
        },
        12 => Event::Join {
            cluster_id: pool_cluster(i),
            epoch: e,
            primary: pool_ref(j),
            node_is_fresh: flag,
        },
        _ => Event::Leave { confirmed: flag },
    }
}

proptest! {
    #[test]
    fn single_node_invariants(
        steps in prop::collection::vec((0u8..14, 0usize..3, 0usize..3, 0u64..7, 0u64..200_000, any::<bool>()), 0..=40)
    ) {
        let mut rec = RoleRecord::standalone(&pool_node(0), &fp("k0"), 0, "init");
        let mut now = 0u64;
        for (kind, i, j, e, step, flag) in steps {
            now += step;
            let ev = gen_event(kind, i, j, e, step, flag);
            let name = ev.name();
            let Ok(next) = apply(&rec, ev, now, ACTOR) else { continue };
            prop_assert!(next.validate().is_ok());
            if next.cluster_id.is_some() && next.cluster_id == rec.cluster_id {
                prop_assert!(next.epoch >= rec.epoch, "{name}: epoch {} -> {}", rec.epoch, next.epoch);
                prop_assert!(next.highest_seen_epoch >= rec.highest_seen_epoch, "{name}: H");
            }
            if !rec.role.writers_allowed() && next.role.writers_allowed() {
                let by_event = matches!(name, "activate" | "force-takeover" | "restore-frozen" | "abort");
                prop_assert!(by_event || next.role == Role::Standalone, "{name} gave writers to {:?}", next.role);
            }
            rec = next;
        }
    }

    #[test]
    fn cooperative_pair_never_has_two_writers(
        advances in prop::collection::vec(0u64..200_000, 6),
        extra_at in 0usize..6,
        extra_kind in 0u8..3,
        extra_epoch in 0u64..4,
    ) {
        let p = Pair::new();
        let c = p.cluster.clone();
        let mut src = p.src.clone();
        let mut tgt = p.tgt.clone();
        let mut now = NOW;
        let mut committed = false;
        let mut slots: Vec<Option<u8>> = vec![None; 6];
        slots[extra_at] = Some(extra_kind);
        for (n, adv) in advances.iter().enumerate() {
            now += adv;
            // The optional extra step runs first in its slot.
            if let Some(kind) = slots[n] {
                match kind {
                    0 => { if let Ok(r) = apply(&src, Event::Abort, now, ACTOR) { src = r; } }
                    1 => {
                        let ev = Event::Observed { peer_node_id: id(), peer_is_writer: false, cluster_id: c.clone(), epoch: extra_epoch, primary: None };
                        if let Ok(r) = apply(&src, ev, now, ACTOR) { src = r; }
                    }
                    _ => {
                        let ev = Event::Observed { peer_node_id: id(), peer_is_writer: false, cluster_id: c.clone(), epoch: extra_epoch, primary: None };
                        if let Ok(r) = apply(&tgt, ev, now, ACTOR) { tgt = r; }
                    }
                }
                prop_assert!(writers(&c, &[&src, &tgt]) <= 1);
            }
            match n {
                0 => { if let Ok(r) = apply(&src, ev_prepare(&p), now, ACTOR) { src = r; } }
                1 => { if let Ok(r) = apply(&src, ev_bundle(&p), now, ACTOR) { src = r; } }
                2 => { if let Ok(r) = apply(&tgt, ev_accept(&p, 1), now, ACTOR) { tgt = r; } }
                3 => {
                    if let Ok(r) = apply(&src, ev_commit(&p), now, ACTOR) { src = r; committed = true; }
                }
                4 if committed => {
                    if let Ok(r) = apply(&tgt, ev_activate(&p, 2), now, ACTOR) { tgt = r; }
                }
                _ => {}
            }
            prop_assert!(src.validate().is_ok() && tgt.validate().is_ok());
            prop_assert!(writers(&c, &[&src, &tgt]) <= 1, "after step {n}: {:?} / {:?}", src.role, tgt.role);
        }
    }
}
