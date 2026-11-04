//! closed cases for RS0.
use super::*;

// ----
// Model: the closed table, unchanged results, §4.6
// ----

fn sample_events() -> Vec<Event> {
    let cluster = id();
    vec![
        Event::Prepare {
            handover_id: id(),
            target_node_id: id(),
            target_key_fingerprint: fp("t"),
            new_cluster_id: Some(cluster.clone()),
            lease_ttl_ms: TTL,
        },
        Event::BundleReady {
            bundle_sha256: hex_sha256("b"),
        },
        Event::RenewLease { lease_ttl_ms: TTL },
        Event::Abort,
        Event::Commit {
            receipt_handover_id: id(),
            receipt_bundle_sha256: hex_sha256("b"),
            receipt_target_node_id: id(),
            primary: node_ref(&id(), "t"),
            rollback_window_ms: RB,
        },
        Event::Accept {
            handover_id: id(),
            cluster_id: cluster.clone(),
            bundle_epoch: 1,
            bundle_sha256: hex_sha256("b"),
            source_node_id: id(),
            source_key_fingerprint: fp("s"),
            target_is_fresh: true,
            replace: false,
            lease_ttl_ms: TTL,
        },
        Event::Activate {
            token_handover_id: id(),
            token_cluster_id: cluster.clone(),
            token_epoch: 2,
            token_bundle_sha256: hex_sha256("b"),
            token_target_node_id: id(),
        },
        Event::Discard,
        Event::ForceTakeover {
            min_unreachable_ms: 1,
            confirmed: true,
        },
        Event::RestoreFrozen {
            confirmed: true,
            server_demoted_epoch: 9,
        },
        Event::Observed {
            peer_node_id: id(),
            peer_is_writer: false,
            cluster_id: cluster.clone(),
            epoch: 3,
            primary: None,
        },
        Event::ResolveAsClient {
            epoch: 3,
            primary: node_ref(&id(), "p"),
        },
        Event::Join {
            cluster_id: cluster,
            epoch: 3,
            primary: node_ref(&id(), "p"),
            node_is_fresh: true,
        },
        Event::Leave { confirmed: true },
    ]
}

/// The pairs §4.5 lists as allowed (`restore-frozen` on a client additionally needs a frozen state).
fn allowed(role: Role, event: &str) -> bool {
    use Role::*;
    match event {
        "prepare" => matches!(role, Standalone | Primary),
        "bundle-ready" | "abort" | "commit" => role == HandingOver,
        "renew-lease" => matches!(role, HandingOver | Pending),
        "accept" => matches!(role, Standalone | Client),
        "activate" | "discard" => role == Pending,
        "force-takeover" | "restore-frozen" | "leave" => role == Client,
        "observed" => true,
        "resolve-as-client" => role == Fenced,
        "join" => role == Standalone,
        other => panic!("unknown event {other}"),
    }
}

#[test]
fn closed_table_of_transitions() {
    let events = sample_events();
    let mut names: Vec<&str> = events.iter().map(Event::name).collect();
    names.sort_unstable();
    names.dedup();
    assert_eq!(names.len(), 14);
    let mut checked = 0;
    for rec in all_roles() {
        for ev in sample_events() {
            if allowed(rec.role, ev.name()) {
                continue;
            }
            let name = ev.name();
            assert_eq!(
                apply(&rec, ev, NOW, ACTOR),
                Err(RoleError::InvalidTransition {
                    from: rec.role,
                    event: name
                }),
                "{:?} + {name}",
                rec.role
            );
            checked += 1;
        }
    }
    // 6 roles x 14 events; the listed pairs are prepare 2, bundle-ready 1, renew-lease 2, abort 1, commit 1,
    // accept 2, activate 1, discard 1, force-takeover 1, restore-frozen 1, observed 6, resolve-as-client 1,
    // join 1, leave 1.
    let listed: usize = all_roles()
        .iter()
        .map(|r| {
            sample_events()
                .iter()
                .filter(|e| allowed(r.role, e.name()))
                .count()
        })
        .sum();
    assert_eq!(listed, 22);
    assert_eq!(checked, 6 * 14 - 22);
}

#[test]
fn invalid_input_record_is_refused_first() {
    let mut r = primary_rec();
    r.changed_by = String::new();
    assert_eq!(err(&r, Event::Abort, NOW), invalid("changedBy"));
}

#[test]
fn unchanged_results_are_identical_clones() {
    // Observed e < N on a client.
    let (_, client) = frozen_client_rec();
    let out = at(
        &client,
        observed(&client, 1, Some(node_ref(&id(), "x"))),
        NOW,
    );
    assert_eq!(out, client);
    // Observed e == N on a fenced node.
    let f = fenced_rec();
    assert_eq!(at(&f, observed(&f, f.epoch, None), NOW), f);
    // Observed e < N on a fenced node, a primary and a pending node.
    assert_eq!(at(&f, observed(&f, 0, None), NOW), f);
    let p = with_epoch(primary_rec(), 3);
    assert_eq!(at(&p, observed(&p, 2, None), NOW), p);
    assert_eq!(at(&p, observed(&p, 3, None), NOW), p);
    // Client e == N at the same instant as the stored contact.
    let mut c = client.clone();
    c.last_primary_contact_at_ms = Some(NOW);
    assert_eq!(at(&c, observed(&c, c.epoch, None), NOW), c);
}

#[test]
fn observed_primary_and_handing_over() {
    for base in [primary_rec(), handing_over_rec()] {
        let base = with_epoch(base, 3);
        // e > N: fenced
        let out = at(&base, observed(&base, 5, None), NOW);
        let mut exp = base.clone();
        exp.role = Role::Fenced;
        exp.highest_seen_epoch = 5;
        exp.handover = None;
        exp.primary = None;
        stamp(&mut exp, NOW);
        assert_eq!(out, exp, "{:?}", base.role);
        assert_eq!(out.epoch, 3, "epoch stays");
        assert!(!out.role.writers_allowed());
        // with a primary reference
        let who = node_ref(&id(), "new");
        let out = at(&base, observed(&base, 4, Some(who.clone())), NOW);
        assert_eq!(out.role, Role::Fenced);
        assert_eq!(out.primary, Some(who));
        // e == N: only H, nothing to change here
        assert_eq!(at(&base, observed(&base, 3, None), NOW), base);
        // e == N with a higher H: still H only (no role change)
        let mut hi = base.clone();
        hi.highest_seen_epoch = 6;
        assert_eq!(at(&hi, observed(&hi, 3, None), NOW), hi);
        // e < N: unchanged
        assert_eq!(at(&base, observed(&base, 2, None), NOW), base);
    }
}

#[test]
fn observed_client() {
    let (_, c) = frozen_client_rec(); // epoch 2
    let who = node_ref(&id(), "newer");
    // e > N, no primary: keep the old one
    let out = at(&c, observed(&c, 4, None), NOW);
    let mut exp = c.clone();
    exp.epoch = 4;
    exp.highest_seen_epoch = 4;
    exp.last_primary_contact_at_ms = Some(NOW);
    stamp(&mut exp, NOW);
    assert_eq!(out, exp);
    // e > N, with primary: replaced
    let out = at(&c, observed(&c, 4, Some(who.clone())), NOW);
    assert_eq!(out.primary, Some(who.clone()));
    assert_eq!(out.epoch, 4);
    // e == N: contact refreshed, primary replaced if given
    let out = at(&c, observed(&c, 2, Some(who.clone())), NOW);
    let mut exp = c.clone();
    exp.primary = Some(who);
    exp.last_primary_contact_at_ms = Some(NOW);
    stamp(&mut exp, NOW);
    assert_eq!(out, exp);
    let out = at(&c, observed(&c, 2, None), NOW);
    assert_eq!(out.last_primary_contact_at_ms, Some(NOW));
    assert_eq!(out.primary, c.primary);
    // e < N: unchanged
    assert_eq!(at(&c, observed(&c, 1, None), NOW), c);
    // Self-naming display metadata is dropped without suppressing the authenticated epoch update.
    let out = at(&c, observed(&c, 4, Some(nref(&c))), NOW);
    assert_eq!(out.role, Role::Client);
    assert_eq!(out.epoch, 4);
    assert_eq!(out.highest_seen_epoch, 4);
    assert_eq!(out.primary, c.primary);
}

#[test]
fn observed_pending() {
    // Pending from a standalone: epoch 0, expected epoch 2, H 1.
    let p = Pair::new();
    let pe = at(&p.tgt, ev_accept(&p, 1), NOW);
    // e <= expected: only H moves.
    let out = at(&pe, observed(&pe, 2, None), NOW + 1);
    let mut exp = pe.clone();
    exp.highest_seen_epoch = 2;
    stamp(&mut exp, NOW + 1);
    assert_eq!(out, exp);
    assert_eq!(out.role, Role::Pending);
    // e == N (0): unchanged
    assert_eq!(at(&pe, observed(&pe, 0, None), NOW + 1), pe);
    // e > expected: discard, back to a fresh standalone with H 0.
    let out = at(&pe, observed(&pe, 3, None), NOW + 2);
    let mut exp = p.tgt.clone();
    stamp(&mut exp, NOW + 2);
    assert_eq!(out, exp);

    // Pending from a client at epoch 2 (expected 3).
    let (_, client) = frozen_client_rec();
    let cluster = client.cluster_id.clone().unwrap();
    let pe = at(
        &client,
        Event::Accept {
            handover_id: id(),
            cluster_id: cluster,
            bundle_epoch: 2,
            bundle_sha256: hex_sha256("b"),
            source_node_id: id(),
            source_key_fingerprint: fp("srv"),
            target_is_fresh: false,
            replace: false,
            lease_ttl_ms: TTL,
        },
        NOW,
    );
    assert_eq!(at(&pe, observed(&pe, 1, None), NOW + 1), pe, "e < N");
    assert_eq!(at(&pe, observed(&pe, 2, None), NOW + 1), pe, "e == N");
    let mid = at(&pe, observed(&pe, 3, None), NOW + 1);
    assert_eq!(mid.role, Role::Pending);
    assert_eq!(mid.highest_seen_epoch, 3);
    let gone = at(&pe, observed(&pe, 4, None), NOW + 1);
    let mut exp = client.clone();
    exp.highest_seen_epoch = 4;
    stamp(&mut exp, NOW + 1);
    assert_eq!(gone, exp, "discard restores the client, H follows e");
}

#[test]
fn observed_fenced() {
    let f = fenced_rec(); // epoch 1, H 2
    let out = at(&f, observed(&f, 7, Some(node_ref(&id(), "x"))), NOW);
    let mut exp = f.clone();
    exp.highest_seen_epoch = 7;
    stamp(&mut exp, NOW);
    assert_eq!(out, exp, "primary reference is not stored on a fenced node");
    assert_eq!(at(&f, observed(&f, 2, None), NOW), f);
    assert_eq!(at(&f, observed(&f, 1, None), NOW), f);
}
