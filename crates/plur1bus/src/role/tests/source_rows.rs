//! source rows cases for RS0.
use super::*;

// ----
// Model: transition rows
// ----

#[test]
fn row1_prepare_from_standalone() {
    let p = Pair::new();
    let out = at(&p.src, ev_prepare(&p), NOW);
    let mut exp = p.src.clone();
    exp.role = Role::HandingOver;
    exp.cluster_id = Some(p.cluster.clone());
    exp.epoch = 1;
    exp.highest_seen_epoch = 1;
    exp.handover = Some(Handover {
        id: p.hid.clone(),
        side: HandoverSide::Source,
        peer_node_id: p.tgt.node_id.clone(),
        peer_key_fingerprint: p.tgt.node_key_fingerprint.clone(),
        bundle_sha256: None,
        expected_epoch: None,
        started_at_ms: NOW,
        lease_expires_at_ms: NOW + TTL,
        previous_role: Role::Primary,
        previous_cluster_id: Some(p.cluster.clone()),
        previous_epoch: 1,
    });
    stamp(&mut exp, NOW);
    assert_eq!(out, exp);
    out.validate().unwrap();
}

#[test]
fn row1_guards() {
    let p = Pair::new();
    // new_cluster_id is checked before the target.
    let mut ev = ev_prepare(&p);
    if let Event::Prepare {
        new_cluster_id,
        target_node_id,
        ..
    } = &mut ev
    {
        *new_cluster_id = None;
        *target_node_id = p.src.node_id.clone();
    }
    assert_eq!(err(&p.src, ev, NOW), invalid("newClusterId"));
    let mut ev = ev_prepare(&p);
    if let Event::Prepare { target_node_id, .. } = &mut ev {
        *target_node_id = p.src.node_id.clone();
    }
    assert_eq!(err(&p.src, ev, NOW), invalid("targetNodeId"));
    let mut ev = ev_prepare(&p);
    if let Event::Prepare { target_node_id, .. } = &mut ev {
        *target_node_id = s("nope");
    }
    assert_eq!(err(&p.src, ev, NOW), invalid("targetNodeId"));
    let mut ev = ev_prepare(&p);
    if let Event::Prepare {
        target_key_fingerprint,
        ..
    } = &mut ev
    {
        *target_key_fingerprint = s("x");
    }
    assert_eq!(err(&p.src, ev, NOW), invalid("targetKeyFingerprint"));
}

#[test]
fn row1b_prepare_from_primary() {
    let prim = with_epoch(primary_rec(), 3);
    let p = Pair {
        src: prim.clone(),
        tgt: rec0("tgt"),
        cluster: prim.cluster_id.clone().unwrap(),
        hid: id(),
        sha: hex_sha256("bundle"),
    };
    let out = at(&prim, ev_prepare_existing(&p), NOW);
    let mut exp = prim.clone();
    exp.role = Role::HandingOver;
    exp.handover = Some(Handover {
        id: p.hid.clone(),
        side: HandoverSide::Source,
        peer_node_id: p.tgt.node_id.clone(),
        peer_key_fingerprint: p.tgt.node_key_fingerprint.clone(),
        bundle_sha256: None,
        expected_epoch: None,
        started_at_ms: NOW,
        lease_expires_at_ms: NOW + TTL,
        previous_role: Role::Primary,
        previous_cluster_id: prim.cluster_id.clone(),
        previous_epoch: 3,
    });
    stamp(&mut exp, NOW);
    assert_eq!(out, exp);
    // A primary must not name a new cluster.
    assert_eq!(err(&prim, ev_prepare(&p), NOW), invalid("newClusterId"));
    let mut ev = ev_prepare_existing(&p);
    if let Event::Prepare { target_node_id, .. } = &mut ev {
        *target_node_id = prim.node_id.clone();
    }
    assert_eq!(err(&prim, ev, NOW), invalid("targetNodeId"));
}

#[test]
fn row2_bundle_ready() {
    let p = Pair::new();
    let h = at(&p.src, ev_prepare(&p), NOW);
    let out = at(&h, ev_bundle(&p), NOW + 5);
    let mut exp = h.clone();
    exp.handover.as_mut().unwrap().bundle_sha256 = Some(p.sha.clone());
    stamp(&mut exp, NOW + 5);
    assert_eq!(out, exp);
    // A second bundle is refused.
    assert_eq!(
        err(&out, ev_bundle(&p), NOW + 6),
        RoleError::InvalidTransition {
            from: Role::HandingOver,
            event: "bundle-ready"
        }
    );
    // Bad hash.
    assert_eq!(
        err(
            &h,
            Event::BundleReady {
                bundle_sha256: s("abc")
            },
            NOW
        ),
        invalid("bundleSha256")
    );
}

#[test]
fn row3_renew_lease() {
    let p = Pair::new();
    let h = at(&p.src, ev_prepare(&p), NOW);
    let out = at(&h, Event::RenewLease { lease_ttl_ms: 777 }, NOW + TTL);
    let mut exp = h.clone();
    exp.handover.as_mut().unwrap().lease_expires_at_ms = NOW + TTL + 777;
    stamp(&mut exp, NOW + TTL);
    assert_eq!(out, exp);
    assert_eq!(
        err(&h, Event::RenewLease { lease_ttl_ms: 1 }, NOW + TTL + 1),
        RoleError::LeaseExpired
    );
    // Pending renews too.
    let pe = at(&p.tgt, ev_accept(&p, 1), NOW);
    let out = at(&pe, Event::RenewLease { lease_ttl_ms: 9 }, NOW + 1);
    assert_eq!(out.handover.unwrap().lease_expires_at_ms, NOW + 1 + 9);
    assert_eq!(
        err(&pe, Event::RenewLease { lease_ttl_ms: 9 }, NOW + TTL + 1),
        RoleError::LeaseExpired
    );
}

#[test]
fn row4_abort() {
    let p = Pair::new();
    let h = at(&p.src, ev_prepare(&p), NOW);
    let out = at(&h, Event::Abort, NOW + 1);
    let mut exp = h.clone();
    exp.role = Role::Primary;
    exp.epoch = 1;
    exp.cluster_id = Some(p.cluster.clone());
    exp.handover = None;
    stamp(&mut exp, NOW + 1);
    assert_eq!(out, exp);
    // Allowed after the lease expired too.
    let late = at(&h, Event::Abort, NOW + TTL * 10);
    assert_eq!(late.role, Role::Primary);
    assert_eq!(late.epoch, 1);
    // From a primary at a later epoch.
    let prim = with_epoch(primary_rec(), 4);
    let p2 = Pair {
        src: prim.clone(),
        tgt: rec0("t"),
        cluster: prim.cluster_id.clone().unwrap(),
        hid: id(),
        sha: hex_sha256("b"),
    };
    let h2 = at(&prim, ev_prepare_existing(&p2), NOW);
    let back = at(&h2, Event::Abort, NOW + 1);
    assert_eq!(back.role, Role::Primary);
    assert_eq!(back.epoch, 4);
    assert_eq!(back.handover, None);
}

#[test]
fn row5_commit() {
    let p = Pair::new();
    let h = at(&p.src, ev_prepare(&p), NOW);
    let h = at(&h, ev_bundle(&p), NOW);
    let when = NOW + 1000;
    let out = at(&h, ev_commit(&p), when);
    let mut exp = h.clone();
    exp.role = Role::Client;
    exp.epoch = 2;
    exp.highest_seen_epoch = 2;
    exp.primary = Some(nref(&p.tgt));
    exp.frozen = Some(Frozen {
        epoch: 1,
        bundle_sha256: p.sha.clone(),
        frozen_at_ms: when,
        rollback_until_ms: when + RB,
    });
    exp.handover = None;
    exp.last_primary_contact_at_ms = Some(when);
    stamp(&mut exp, when);
    assert_eq!(out, exp);
    out.validate().unwrap();
}

#[test]
fn row5_commit_guards_in_order() {
    let p = Pair::new();
    let prepared = at(&p.src, ev_prepare(&p), NOW);
    // Lease first.
    assert_eq!(
        err(&prepared, ev_commit(&p), NOW + TTL + 1),
        RoleError::LeaseExpired
    );
    // No bundle yet.
    assert_eq!(
        err(&prepared, ev_commit(&p), NOW),
        RoleError::ReceiptInvalid {
            field: "bundleSha256"
        }
    );
    let h = at(&prepared, ev_bundle(&p), NOW);
    let mutate = |f: &dyn Fn(&mut Event)| {
        let mut ev = ev_commit(&p);
        f(&mut ev);
        err(&h, ev, NOW)
    };
    let field = |f: &'static str| RoleError::ReceiptInvalid { field: f };
    assert_eq!(
        mutate(&|e| {
            if let Event::Commit {
                receipt_handover_id,
                receipt_bundle_sha256,
                ..
            } = e
            {
                *receipt_handover_id = id();
                *receipt_bundle_sha256 = hex_sha256("other");
            }
        }),
        field("handoverId")
    );
    assert_eq!(
        mutate(&|e| {
            if let Event::Commit {
                receipt_bundle_sha256,
                receipt_target_node_id,
                ..
            } = e
            {
                *receipt_bundle_sha256 = hex_sha256("other");
                *receipt_target_node_id = id();
            }
        }),
        field("bundleSha256")
    );
    assert_eq!(
        mutate(&|e| {
            if let Event::Commit {
                receipt_target_node_id,
                primary,
                ..
            } = e
            {
                *receipt_target_node_id = id();
                primary.node_id = id();
            }
        }),
        field("targetNodeId")
    );
    assert_eq!(
        mutate(&|e| {
            if let Event::Commit { primary, .. } = e {
                primary.node_id = id();
            }
        }),
        field("primary")
    );
    assert_eq!(
        mutate(&|e| {
            if let Event::Commit { primary, .. } = e {
                primary.node_key_fingerprint = fp("impostor");
            }
        }),
        field("primary")
    );
}
