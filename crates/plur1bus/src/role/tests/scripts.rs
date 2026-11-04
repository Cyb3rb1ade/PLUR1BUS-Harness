//! scripts cases for RS0.
use super::*;

// ----
// Model: scripts
// ----

#[test]
fn full_handover_script() {
    let p = Pair::new();
    let c = p.cluster.clone();
    let (mut src, mut tgt) = (p.src.clone(), p.tgt.clone());
    let check = |src: &RoleRecord, tgt: &RoleRecord| {
        assert!(
            writers(&c, &[src, tgt]) <= 1,
            "two writers: {:?} / {:?}",
            src.role,
            tgt.role
        );
    };
    check(&src, &tgt);
    src = at(&src, ev_prepare(&p), NOW);
    check(&src, &tgt);
    assert_eq!(src.role, Role::HandingOver);
    src = at(&src, ev_bundle(&p), NOW + 10);
    check(&src, &tgt);
    tgt = at(&tgt, ev_accept(&p, src.epoch), NOW + 20);
    check(&src, &tgt);
    assert_eq!(tgt.role, Role::Pending);
    src = at(&src, ev_commit(&p), NOW + 30);
    check(&src, &tgt);
    tgt = at(&tgt, ev_activate(&p, src.epoch), NOW + 40);
    check(&src, &tgt);
    assert_eq!(tgt.role, Role::Primary);
    assert_eq!(tgt.epoch, 2);
    assert_eq!(src.role, Role::Client);
    assert_eq!(src.epoch, 2);
    assert_eq!(src.frozen.as_ref().unwrap().epoch, 1);
    assert_eq!(src.primary.as_ref().unwrap().node_id, tgt.node_id);
}

#[test]
fn failback_script() {
    // First handover.
    let p = Pair::new();
    let c = p.cluster.clone();
    let mut src = at(&p.src, ev_prepare(&p), NOW);
    src = at(&src, ev_bundle(&p), NOW + 1);
    let mut tgt = at(&p.tgt, ev_accept(&p, 1), NOW + 2);
    src = at(&src, ev_commit(&p), NOW + 3);
    tgt = at(&tgt, ev_activate(&p, 2), NOW + 4);
    assert!(src.frozen.is_some());

    // Hand back: the new primary (tgt) prepares, the old one (src, a client) accepts.
    let back = Pair {
        src: tgt.clone(),
        tgt: src.clone(),
        cluster: c.clone(),
        hid: id(),
        sha: hex_sha256("bundle-2"),
    };
    let check = |a: &RoleRecord, b: &RoleRecord| assert!(writers(&c, &[a, b]) <= 1);
    let mut new_src = at(&tgt, ev_prepare_existing(&back), NOW + 10);
    check(&new_src, &src);
    new_src = at(&new_src, ev_bundle(&back), NOW + 11);
    let mut new_tgt = at(&src, ev_accept(&back, new_src.epoch), NOW + 12);
    assert_eq!(new_tgt.role, Role::Pending);
    check(&new_src, &new_tgt);
    new_src = at(&new_src, ev_commit(&back), NOW + 13);
    check(&new_src, &new_tgt);
    new_tgt = at(&new_tgt, ev_activate(&back, new_src.epoch), NOW + 14);
    check(&new_src, &new_tgt);
    assert_eq!(new_tgt.role, Role::Primary);
    assert_eq!(new_tgt.epoch, 3);
    assert_eq!(new_src.role, Role::Client);
    assert_eq!(new_src.epoch, 3);
    assert_eq!(
        new_tgt.frozen, None,
        "frozen state is cleared on activation"
    );
    assert_eq!(new_tgt.primary, None);
    assert_eq!(new_src.frozen.as_ref().unwrap().epoch, 2);
}

#[test]
fn lease_scenarios() {
    let p = Pair::new();
    let h = at(&p.src, ev_prepare(&p), NOW);
    let h = at(&h, ev_bundle(&p), NOW);
    let expiry = NOW + TTL;
    // Commit exactly at expiry is fine, one ms later is not.
    assert_eq!(at(&h, ev_commit(&p), expiry).role, Role::Client);
    assert_eq!(err(&h, ev_commit(&p), expiry + 1), RoleError::LeaseExpired);
    // Renew before expiry extends it; the commit then succeeds beyond the original expiry.
    let renewed = at(&h, Event::RenewLease { lease_ttl_ms: TTL }, expiry - 1);
    assert_eq!(
        renewed.handover.as_ref().unwrap().lease_expires_at_ms,
        expiry - 1 + TTL
    );
    assert_eq!(at(&renewed, ev_commit(&p), expiry + 50).role, Role::Client);
    // Abort after expiry restores the primary at the previous epoch.
    let back = at(&h, Event::Abort, expiry + 1_000_000);
    assert_eq!(back.role, Role::Primary);
    assert_eq!(back.epoch, 1);
    assert_eq!(back.handover, None);
}

#[test]
fn forced_takeover_then_fencing() {
    // The old primary hands over, then the target dies; the client takes over after the timer.
    let (p, client) = frozen_client_rec(); // client epoch 2, contact START + 30
    let min = 600_000;
    let since = client.last_primary_contact_at_ms.unwrap();
    let force = Event::ForceTakeover {
        min_unreachable_ms: min,
        confirmed: true,
    };
    assert_eq!(
        err(
            &client,
            Event::ForceTakeover {
                min_unreachable_ms: min,
                confirmed: true
            },
            since + 100
        ),
        RoleError::TakeoverTooEarly {
            remaining_ms: min - 100
        }
    );
    let taker = at(&client, force, since + min);
    assert_eq!(taker.role, Role::Primary);
    assert_eq!(taker.epoch, 3);
    // The old primary (the pending target that was activated) sees epoch 3 and is fenced.
    let pe = at(&p.tgt, ev_accept(&p, 1), NOW);
    let old = at(&pe, ev_activate(&p, 2), NOW + 1);
    assert_eq!(old.role, Role::Primary);
    let fenced = at(&old, observed(&old, 3, Some(nref(&taker))), NOW + 2);
    assert_eq!(fenced.role, Role::Fenced);
    assert_eq!(fenced.epoch, 2);
    assert_eq!(fenced.highest_seen_epoch, 3);
    // The owner resolves it as a client of the new primary.
    let cl = at(
        &fenced,
        Event::ResolveAsClient {
            epoch: 3,
            primary: nref(&taker),
        },
        NOW + 3,
    );
    assert_eq!(cl.role, Role::Client);
    assert_eq!(cl.epoch, 3);
    assert_eq!(cl.primary, Some(nref(&taker)));
}
