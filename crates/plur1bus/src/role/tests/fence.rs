//! fence cases for RS0.
use super::*;

// ----
// Fence
// ----

#[test]
fn fence_compare() {
    let p = with_epoch(primary_rec(), 3);
    let c = p.cluster_id.clone().unwrap();
    assert_eq!(compare(&p, &c, 3, &id(), false), EpochVerdict::Same);
    assert_eq!(compare(&p, &c, 4, &id(), false), EpochVerdict::LocalBehind);
    assert_eq!(compare(&p, &c, 2, &id(), false), EpochVerdict::LocalAhead);
    assert_eq!(
        compare(&p, &id(), 3, &id(), false),
        EpochVerdict::ForeignCluster
    );
    assert_eq!(
        compare(&rec0("a"), &c, 0, &id(), false),
        EpochVerdict::ForeignCluster
    );
}

#[test]
fn fence_lease_boundaries() {
    let l = Lease::grant(1000, 500);
    assert_eq!(l.expires_at_ms(), 1500);
    assert!(l.is_live(1000));
    assert!(l.is_live(1500));
    assert!(!l.is_live(1501));
    assert!(!l.renew_due(1000, 300));
    assert!(!l.renew_due(1299, 300));
    assert!(l.renew_due(1300, 300));
    assert!(l.renew_due(5000, 300));
    assert_eq!(l.renew(1500), Some(Lease::grant(1500, 500)));
    assert_eq!(l.renew(1501), None);
    // Saturating.
    let big = Lease::grant(u64::MAX - 1, u64::MAX);
    assert_eq!(big.expires_at_ms(), u64::MAX);
    assert!(big.is_live(u64::MAX));
    assert!(big.renew_due(u64::MAX, u64::MAX));
    let _ = Lease::grant(u64::MAX, u64::MAX).renew(u64::MAX);
    assert_eq!(DEFAULT_LEASE_TTL_MS, 120_000);
    assert_eq!(DEFAULT_HEARTBEAT_MS, 30_000);
    assert_eq!(DEFAULT_TAKEOVER_MIN_UNREACHABLE_MS, 600_000);
    assert_eq!(DEFAULT_ROLLBACK_WINDOW_MS, 604_800_000);
    assert_eq!(HOLD_ENV, "PLUR1BUS_ROLE_HOLD");
}

#[test]
fn fence_takeover_wait() {
    let (_, client) = frozen_client_rec();
    let since = client.last_primary_contact_at_ms.unwrap();
    let min = 1000;
    assert_eq!(takeover_wait_ms(&client, since, min), min);
    assert_eq!(takeover_wait_ms(&client, since + 400, min), 600);
    assert_eq!(takeover_wait_ms(&client, since + min - 1, min), 1);
    assert_eq!(takeover_wait_ms(&client, since + min, min), 0);
    assert_eq!(takeover_wait_ms(&client, since + min + 99, min), 0);
    assert_eq!(takeover_wait_ms(&client, since, u64::MAX), u64::MAX - since);
    let mut no_contact = client.clone();
    no_contact.last_primary_contact_at_ms = None;
    assert_eq!(
        takeover_wait_ms(&no_contact, no_contact.changed_at_ms + 10, 100),
        90
    );
    for r in all_roles() {
        if r.role != Role::Client {
            assert_eq!(takeover_wait_ms(&r, NOW, 1), u64::MAX, "{:?}", r.role);
        }
    }
    // Consistent with ForceTakeover.
    let ev = |min| Event::ForceTakeover {
        min_unreachable_ms: min,
        confirmed: true,
    };
    let now = since + 123;
    let wait = takeover_wait_ms(&client, now, min);
    assert_eq!(
        err(&client, ev(min), now),
        RoleError::TakeoverTooEarly { remaining_ms: wait }
    );
}

#[test]
fn fence_writer_decision() {
    for r in all_roles() {
        let d = writer_decision(&Loaded::Valid(r.clone()));
        if r.role.writers_allowed() {
            assert_eq!(d, WriterDecision::Allowed, "{:?}", r.role);
        } else {
            assert_eq!(
                d,
                WriterDecision::Denied {
                    reason: "role-hold"
                },
                "{:?}",
                r.role
            );
        }
    }
    assert_eq!(writer_decision(&Loaded::Missing), WriterDecision::Allowed);
    assert_eq!(
        writer_decision(&Loaded::Corrupt { detail: s("x") }),
        WriterDecision::Denied {
            reason: "role-record-corrupt"
        }
    );
}

#[test]
fn fence_hold_env_value() {
    assert_eq!(hold_env_value(&rec0("a")), None);
    assert_eq!(hold_env_value(&primary_rec()), None);
    let (_, client) = frozen_client_rec();
    assert_eq!(hold_env_value(&client).as_deref(), Some("client:2"));
    assert_eq!(
        hold_env_value(&handing_over_rec()).as_deref(),
        Some("handing-over:1")
    );
    assert_eq!(hold_env_value(&pending_rec()).as_deref(), Some("pending:0"));
    assert_eq!(hold_env_value(&fenced_rec()).as_deref(), Some("fenced:1"));
}

#[test]
fn saturating_arithmetic_does_not_panic() {
    let p = Pair::new();
    let ev = Event::Prepare {
        handover_id: p.hid.clone(),
        target_node_id: p.tgt.node_id.clone(),
        target_key_fingerprint: p.tgt.node_key_fingerprint.clone(),
        new_cluster_id: Some(p.cluster.clone()),
        lease_ttl_ms: u64::MAX,
    };
    let h = at(&p.src, ev, u64::MAX - 5);
    assert_eq!(h.handover.as_ref().unwrap().lease_expires_at_ms, u64::MAX);
    let h = at(
        &h,
        Event::RenewLease {
            lease_ttl_ms: u64::MAX,
        },
        u64::MAX,
    );
    assert_eq!(h.handover.as_ref().unwrap().lease_expires_at_ms, u64::MAX);
    let h = at(&h, ev_bundle(&p), u64::MAX);
    let ev = Event::Commit {
        receipt_handover_id: p.hid.clone(),
        receipt_bundle_sha256: p.sha.clone(),
        receipt_target_node_id: p.tgt.node_id.clone(),
        primary: nref(&p.tgt),
        rollback_window_ms: u64::MAX,
    };
    let c = at(&h, ev, u64::MAX);
    assert_eq!(c.frozen.as_ref().unwrap().rollback_until_ms, u64::MAX);
    let r = apply(
        &c,
        Event::ForceTakeover {
            min_unreachable_ms: u64::MAX,
            confirmed: true,
        },
        u64::MAX,
        ACTOR,
    );
    assert!(r.is_ok() || matches!(r, Err(RoleError::TakeoverTooEarly { .. })));
    let mut top = c.clone();
    top.epoch = u64::MAX;
    top.highest_seen_epoch = u64::MAX;
    let r = apply(
        &top,
        Event::ForceTakeover {
            min_unreachable_ms: 0,
            confirmed: true,
        },
        u64::MAX,
        ACTOR,
    );
    assert_eq!(r, Err(RoleError::EpochExhausted));
    assert_eq!(takeover_wait_ms(&top, 0, u64::MAX), u64::MAX);
}
