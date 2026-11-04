//! target rows cases for RS0.
use super::*;

#[test]
fn row6_accept_from_standalone() {
    let p = Pair::new();
    let out = at(&p.tgt, ev_accept(&p, 1), NOW);
    let mut exp = p.tgt.clone();
    exp.role = Role::Pending;
    exp.cluster_id = Some(p.cluster.clone());
    exp.highest_seen_epoch = 1;
    exp.handover = Some(Handover {
        id: p.hid.clone(),
        side: HandoverSide::Target,
        peer_node_id: p.src.node_id.clone(),
        peer_key_fingerprint: p.src.node_key_fingerprint.clone(),
        bundle_sha256: Some(p.sha.clone()),
        expected_epoch: Some(2),
        started_at_ms: NOW,
        lease_expires_at_ms: NOW + TTL,
        previous_role: Role::Standalone,
        previous_cluster_id: None,
        previous_epoch: 0,
    });
    stamp(&mut exp, NOW);
    assert_eq!(out, exp);
}

#[test]
fn row6_accept_guards() {
    let p = Pair::new();
    // source == self
    let mut ev = ev_accept(&p, 1);
    if let Event::Accept {
        source_node_id,
        target_is_fresh,
        ..
    } = &mut ev
    {
        *source_node_id = p.tgt.node_id.clone();
        *target_is_fresh = false;
    }
    assert_eq!(err(&p.tgt, ev, NOW), invalid("sourceNodeId"));
    // not fresh, no replace
    let mut ev = ev_accept(&p, 1);
    if let Event::Accept {
        target_is_fresh, ..
    } = &mut ev
    {
        *target_is_fresh = false;
    }
    assert_eq!(err(&p.tgt, ev, NOW), RoleError::TargetNotEmpty);
    // replace lets a non-fresh target through
    let mut ev = ev_accept(&p, 1);
    if let Event::Accept {
        target_is_fresh,
        replace,
        ..
    } = &mut ev
    {
        *target_is_fresh = false;
        *replace = true;
    }
    assert_eq!(at(&p.tgt, ev, NOW).role, Role::Pending);
    // bad inputs
    let mut ev = ev_accept(&p, 1);
    if let Event::Accept { cluster_id, .. } = &mut ev {
        *cluster_id = s("x");
    }
    assert_eq!(err(&p.tgt, ev, NOW), invalid("clusterId"));
    let mut ev = ev_accept(&p, 1);
    if let Event::Accept { bundle_sha256, .. } = &mut ev {
        *bundle_sha256 = s("x");
    }
    assert_eq!(err(&p.tgt, ev, NOW), invalid("bundleSha256"));
}

#[test]
fn row6_accept_from_client() {
    let p = Pair::new();
    // A client of `p.cluster` at epoch 2 with a frozen state.
    let (src_pair, client) = frozen_client_rec();
    let cluster = client.cluster_id.clone().unwrap();
    let hid = id();
    let ev = |bundle_epoch: u64, cluster_id: &str| Event::Accept {
        handover_id: hid.clone(),
        cluster_id: cluster_id.to_string(),
        bundle_epoch,
        bundle_sha256: p.sha.clone(),
        source_node_id: id(),
        source_key_fingerprint: fp("srv"),
        target_is_fresh: false,
        replace: false,
        lease_ttl_ms: TTL,
    };
    // Foreign cluster, then stale epoch.
    assert_eq!(err(&client, ev(2, &id()), NOW), RoleError::ForeignCluster);
    assert_eq!(
        err(&client, ev(1, &cluster), NOW),
        RoleError::StaleEpoch { got: 1, highest: 2 }
    );
    let out = at(&client, ev(2, &cluster), NOW);
    assert_eq!(out.role, Role::Pending);
    assert_eq!(out.epoch, 2);
    assert_eq!(out.cluster_id.as_deref(), Some(cluster.as_str()));
    assert_eq!(out.highest_seen_epoch, 2);
    assert_eq!(out.primary, client.primary);
    assert_eq!(out.frozen, client.frozen);
    let ho = out.handover.as_ref().unwrap();
    assert_eq!(ho.expected_epoch, Some(3));
    assert_eq!(ho.previous_role, Role::Client);
    assert_eq!(ho.previous_cluster_id.as_deref(), Some(cluster.as_str()));
    assert_eq!(ho.previous_epoch, 2);
    // A bundle from a later epoch raises the highest seen epoch.
    let out = at(&client, ev(5, &cluster), NOW);
    assert_eq!(out.highest_seen_epoch, 5);
    assert_eq!(out.epoch, 2);
    let _ = src_pair;
}

#[test]
fn row7_activate() {
    let p = Pair::new();
    let pe = at(&p.tgt, ev_accept(&p, 1), NOW);
    let out = at(&pe, ev_activate(&p, 2), NOW + 5);
    let mut exp = pe.clone();
    exp.role = Role::Primary;
    exp.epoch = 2;
    exp.highest_seen_epoch = 2;
    exp.primary = None;
    exp.handover = None;
    exp.frozen = None;
    exp.last_primary_contact_at_ms = None;
    stamp(&mut exp, NOW + 5);
    assert_eq!(out, exp);
}

#[test]
fn row7_activate_guards_in_order() {
    let p = Pair::new();
    let pe = at(&p.tgt, ev_accept(&p, 1), NOW);
    let tweak = |f: &dyn Fn(&mut Event)| {
        let mut ev = ev_activate(&p, 2);
        f(&mut ev);
        err(&pe, ev, NOW)
    };
    let bad = |f: &'static str| RoleError::CommitInvalid { field: f };
    assert_eq!(
        tweak(&|e| {
            if let Event::Activate {
                token_handover_id,
                token_cluster_id,
                ..
            } = e
            {
                *token_handover_id = id();
                *token_cluster_id = id();
            }
        }),
        bad("handoverId")
    );
    assert_eq!(
        tweak(&|e| {
            if let Event::Activate {
                token_cluster_id,
                token_target_node_id,
                ..
            } = e
            {
                *token_cluster_id = id();
                *token_target_node_id = id();
            }
        }),
        bad("clusterId")
    );
    assert_eq!(
        tweak(&|e| {
            if let Event::Activate {
                token_target_node_id,
                token_bundle_sha256,
                ..
            } = e
            {
                *token_target_node_id = id();
                *token_bundle_sha256 = hex_sha256("other");
            }
        }),
        bad("targetNodeId")
    );
    assert_eq!(
        tweak(&|e| {
            if let Event::Activate {
                token_bundle_sha256,
                token_epoch,
                ..
            } = e
            {
                *token_bundle_sha256 = hex_sha256("other");
                *token_epoch = 9;
            }
        }),
        bad("bundleSha256")
    );
    assert_eq!(
        tweak(&|e| {
            if let Event::Activate { token_epoch, .. } = e {
                *token_epoch = 3;
            }
        }),
        bad("epoch")
    );
    // The token epoch must not be behind a higher epoch seen meanwhile.
    let mut seen = pe.clone();
    seen.highest_seen_epoch = 5;
    assert_eq!(
        err(&seen, ev_activate(&p, 2), NOW),
        RoleError::StaleEpoch { got: 2, highest: 5 }
    );
}

#[test]
fn row8_discard() {
    let p = Pair::new();
    let pe = at(&p.tgt, ev_accept(&p, 1), NOW);
    let out = at(&pe, Event::Discard, NOW + 3);
    let mut exp = p.tgt.clone();
    stamp(&mut exp, NOW + 3);
    assert_eq!(
        out, exp,
        "discard from a fresh standalone restores it fully"
    );

    // From a client: the old client is restored, the highest seen epoch is kept.
    let (_, client) = frozen_client_rec();
    let cluster = client.cluster_id.clone().unwrap();
    let ev = Event::Accept {
        handover_id: id(),
        cluster_id: cluster,
        bundle_epoch: 4,
        bundle_sha256: hex_sha256("b"),
        source_node_id: id(),
        source_key_fingerprint: fp("srv"),
        target_is_fresh: false,
        replace: false,
        lease_ttl_ms: TTL,
    };
    let pe = at(&client, ev, NOW);
    let back = at(&pe, Event::Discard, NOW + 1);
    let mut exp = client.clone();
    exp.highest_seen_epoch = 4;
    stamp(&mut exp, NOW + 1);
    assert_eq!(back, exp);
}

#[test]
fn row9_force_takeover() {
    let (_, client) = frozen_client_rec(); // last contact START + 30
    let since = client.last_primary_contact_at_ms.unwrap();
    let min = 600_000;
    assert_eq!(
        err(
            &client,
            Event::ForceTakeover {
                min_unreachable_ms: min,
                confirmed: true
            },
            since + min - 1
        ),
        RoleError::TakeoverTooEarly { remaining_ms: 1 }
    );
    assert_eq!(
        err(
            &client,
            Event::ForceTakeover {
                min_unreachable_ms: min,
                confirmed: true
            },
            since
        ),
        RoleError::TakeoverTooEarly { remaining_ms: min }
    );
    // Unconfirmed is checked before the timer.
    assert_eq!(
        err(
            &client,
            Event::ForceTakeover {
                min_unreachable_ms: min,
                confirmed: false
            },
            since
        ),
        RoleError::Unconfirmed
    );
    let when = since + min;
    let out = at(
        &client,
        Event::ForceTakeover {
            min_unreachable_ms: min,
            confirmed: true,
        },
        when,
    );
    let mut exp = client.clone();
    exp.role = Role::Primary;
    exp.epoch = 3;
    exp.highest_seen_epoch = 3;
    exp.primary = None;
    exp.frozen = None;
    exp.last_primary_contact_at_ms = None;
    stamp(&mut exp, when);
    assert_eq!(out, exp);

    // Without a recorded contact `changed_at_ms` is the reference.
    let mut c = client_rec();
    c.last_primary_contact_at_ms = None;
    let since = c.changed_at_ms;
    assert_eq!(
        err(
            &c,
            Event::ForceTakeover {
                min_unreachable_ms: 10,
                confirmed: true
            },
            since + 4
        ),
        RoleError::TakeoverTooEarly { remaining_ms: 6 }
    );
}

#[test]
fn row10_restore_frozen() {
    let (_, client) = frozen_client_rec();
    let frozen = client.frozen.clone().unwrap();
    let ev = |confirmed: bool, demoted: u64| Event::RestoreFrozen {
        confirmed,
        server_demoted_epoch: demoted,
    };
    assert_eq!(
        err(&client, ev(false, 2), frozen.rollback_until_ms + 10),
        RoleError::Unconfirmed
    );
    assert_eq!(
        err(&client, ev(true, 2), frozen.rollback_until_ms + 1),
        RoleError::RollbackExpired
    );
    assert_eq!(
        err(&client, ev(true, 1), frozen.rollback_until_ms),
        RoleError::StaleEpoch { got: 1, highest: 2 }
    );
    let when = frozen.rollback_until_ms;
    let out = at(&client, ev(true, 4), when);
    let mut exp = client.clone();
    exp.role = Role::Primary;
    exp.epoch = 5;
    exp.highest_seen_epoch = 5;
    exp.primary = None;
    exp.frozen = None;
    exp.last_primary_contact_at_ms = None;
    stamp(&mut exp, when);
    assert_eq!(out, exp);
    // H larger than the demoted epoch wins.
    let mut high = client.clone();
    high.highest_seen_epoch = 8;
    assert_eq!(at(&high, ev(true, 2), when).epoch, 9);
    // A client without a frozen state cannot restore.
    assert_eq!(
        err(&client_rec(), ev(true, 9), START),
        RoleError::InvalidTransition {
            from: Role::Client,
            event: "restore-frozen"
        }
    );
}

#[test]
fn row11_observed_foreign_cluster() {
    for r in all_roles() {
        let ev = Event::Observed {
            peer_node_id: id(),
            peer_is_writer: false,
            cluster_id: id(),
            epoch: 9,
            primary: None,
        };
        assert_eq!(err(&r, ev, NOW), RoleError::ForeignCluster, "{:?}", r.role);
    }
    // A malformed cluster id is an input error.
    let r = primary_rec();
    let ev = Event::Observed {
        peer_node_id: id(),
        peer_is_writer: false,
        cluster_id: s("x"),
        epoch: 9,
        primary: None,
    };
    assert_eq!(err(&r, ev, NOW), invalid("clusterId"));
}

#[test]
fn row12_resolve_as_client() {
    let f = with_epoch(fenced_rec(), 1);
    let mut f = f;
    f.highest_seen_epoch = 3;
    let new_primary = node_ref(&id(), "other");
    assert_eq!(
        err(
            &f,
            Event::ResolveAsClient {
                epoch: 2,
                primary: new_primary.clone()
            },
            NOW
        ),
        RoleError::StaleEpoch { got: 2, highest: 3 }
    );
    assert_eq!(
        err(
            &f,
            Event::ResolveAsClient {
                epoch: 3,
                primary: nref(&f)
            },
            NOW
        ),
        invalid("primary")
    );
    let out = at(
        &f,
        Event::ResolveAsClient {
            epoch: 4,
            primary: new_primary.clone(),
        },
        NOW,
    );
    let mut exp = f.clone();
    exp.role = Role::Client;
    exp.epoch = 4;
    exp.highest_seen_epoch = 4;
    exp.primary = Some(new_primary);
    exp.frozen = None;
    exp.last_primary_contact_at_ms = Some(NOW);
    stamp(&mut exp, NOW);
    assert_eq!(out, exp);
}

#[test]
fn row13_join() {
    let me = rec0("me");
    let cluster = id();
    let primary = node_ref(&id(), "srv");
    let ev = |fresh: bool, epoch: u64, primary: NodeRef| Event::Join {
        cluster_id: cluster.clone(),
        epoch,
        primary,
        node_is_fresh: fresh,
    };
    assert_eq!(
        err(&me, ev(false, 1, primary.clone()), NOW),
        RoleError::TargetNotEmpty
    );
    assert_eq!(
        err(&me, ev(true, 0, primary.clone()), NOW),
        invalid("epoch")
    );
    assert_eq!(err(&me, ev(true, 1, nref(&me)), NOW), invalid("primary"));
    let out = at(&me, ev(true, 3, primary.clone()), NOW);
    let mut exp = me.clone();
    exp.role = Role::Client;
    exp.cluster_id = Some(cluster.clone());
    exp.epoch = 3;
    exp.highest_seen_epoch = 3;
    exp.primary = Some(primary);
    exp.last_primary_contact_at_ms = Some(NOW);
    stamp(&mut exp, NOW);
    assert_eq!(out, exp);
}

#[test]
fn row14_leave() {
    let (_, client) = frozen_client_rec();
    let until = client.frozen.as_ref().unwrap().rollback_until_ms;
    assert_eq!(
        err(&client, Event::Leave { confirmed: false }, until - 1),
        RoleError::Unconfirmed
    );
    let out = at(&client, Event::Leave { confirmed: true }, until - 1);
    let mut exp = rec0("x");
    exp.node_id = client.node_id.clone();
    exp.node_key_fingerprint = client.node_key_fingerprint.clone();
    exp.changed_at_ms = until - 1;
    exp.changed_by = s(ACTOR);
    assert_eq!(out, exp);
    // At or after the rollback deadline no confirmation is needed.
    let out = at(&client, Event::Leave { confirmed: false }, until);
    assert_eq!(out.role, Role::Standalone);
    // A client with no frozen state never needs confirmation.
    let plain = client_rec();
    let out = at(&plain, Event::Leave { confirmed: false }, NOW);
    assert_eq!(out.role, Role::Standalone);
    assert_eq!(out.cluster_id, None);
    assert_eq!(out.primary, None);
    assert_eq!(out.epoch, 0);
    assert_eq!(out.highest_seen_epoch, 0);
}
