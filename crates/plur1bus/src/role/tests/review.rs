//! Regression evidence for the controller review of RS0.
use super::*;

#[test]
fn equal_epoch_forced_takeovers_converge_after_contact() {
    let a = client_rec();
    let mut b = a.clone();
    b.node_id = id();
    b.node_key_fingerprint = fp("second-client");
    let takeover = || Event::ForceTakeover {
        min_unreachable_ms: 0,
        confirmed: true,
    };
    let first = at(&a, takeover(), NOW);
    let second = at(&b, takeover(), NOW);
    assert_eq!(first.epoch, second.epoch);
    let seen = |peer: &RoleRecord| Event::Observed {
        peer_node_id: peer.node_id.clone(),
        peer_is_writer: peer.role.writers_allowed(),
        cluster_id: peer.cluster_id.clone().unwrap(),
        epoch: peer.epoch,
        primary: Some(nref(peer)),
    };
    let first = at(&first, seen(&second), NOW + 1);
    let second = at(&second, seen(&first), NOW + 1);
    assert_eq!(
        usize::from(first.role.writers_allowed()) + usize::from(second.role.writers_allowed()),
        1
    );
}

#[test]
fn higher_epoch_fences_even_with_malformed_or_self_naming_primary() {
    let rec = primary_rec();
    let mut bad = nref(&rec);
    bad.node_id = "invalid".into();
    for primary in [bad, nref(&rec)] {
        let result = apply(
            &rec,
            Event::Observed {
                peer_node_id: id(),
                peer_is_writer: false,
                cluster_id: rec.cluster_id.clone().unwrap(),
                epoch: rec.epoch + 1,
                primary: Some(primary),
            },
            NOW,
            ACTOR,
        )
        .expect("descriptive metadata cannot block fencing");
        assert_eq!(result.role, Role::Fenced);
        assert_eq!(result.highest_seen_epoch, rec.epoch + 1);
        assert_eq!(result.primary, None);
    }
}

#[test]
fn a_stored_writer_cannot_change_cluster_or_reset_to_standalone() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("role.json");
    let rec = with_epoch(primary_rec(), 9);
    save(&path, &rec).unwrap();
    let mut other = rec.clone();
    other.cluster_id = Some(id());
    other.epoch = 1;
    other.highest_seen_epoch = 1;
    assert!(save(&path, &other).is_err());
    let stand = RoleRecord::standalone(&rec.node_id, &rec.node_key_fingerprint, NOW, ACTOR);
    assert!(save(&path, &stand).is_err());
    assert_eq!(load(&path), Loaded::Valid(rec));
}

#[test]
fn concurrent_saves_are_serialized_and_never_persist_a_failed_epoch() {
    use std::sync::{Arc, Barrier};
    let dir = tempfile::tempdir().unwrap();
    let path = Arc::new(dir.path().join("role.json"));
    let rec = Arc::new(primary_rec());
    save(&path, &rec).unwrap();
    let start = Arc::new(Barrier::new(8));
    let threads: Vec<_> = (0..8)
        .map(|worker| {
            let (path, rec, start) = (path.clone(), rec.clone(), start.clone());
            std::thread::spawn(move || {
                start.wait();
                (1..=25)
                    .map(|i| {
                        let epoch = 1 + worker * 25 + i;
                        save(&path, &with_epoch((*rec).clone(), epoch))
                    })
                    .collect::<Vec<_>>()
            })
        })
        .collect();
    for thread in threads {
        for result in thread.join().unwrap() {
            assert!(
                matches!(result, Ok(()) | Err(RoleError::StaleEpoch { .. })),
                "{result:?}"
            );
        }
    }
    assert!(matches!(load(&path), Loaded::Valid(rec) if rec.epoch == 201));
}

proptest::proptest! {
    #[test]
    fn competing_forced_writers_have_one_deterministic_survivor(
        epoch in 1u64..1000, left in 1u128..32, right in 1u128..32, reverse in proptest::bool::ANY,
    ) {
        proptest::prop_assume!(left != right);
        let mut a = with_epoch(client_rec(), epoch);
        a.node_id = uuid::Uuid::from_u128(left).to_string();
        let mut b = a.clone();
        b.node_id = uuid::Uuid::from_u128(right).to_string();
        b.node_key_fingerprint = fp("second-property-client");
        let take = || Event::ForceTakeover { min_unreachable_ms: 0, confirmed: true };
        let mut a = at(&a, take(), NOW);
        let mut b = at(&b, take(), NOW);
        let seen = |peer: &RoleRecord| Event::Observed {
            cluster_id: peer.cluster_id.clone().unwrap(), epoch: peer.epoch,
            peer_node_id: peer.node_id.clone(), peer_is_writer: peer.role.writers_allowed(), primary: Some(nref(peer)),
        };
        let (a_message, b_message) = (seen(&a), seen(&b));
        if reverse { b = at(&b, a_message, NOW + 1); a = at(&a, b_message, NOW + 1); }
        else { a = at(&a, b_message, NOW + 1); b = at(&b, a_message, NOW + 1); }
        proptest::prop_assert_eq!(usize::from(a.role.writers_allowed()) + usize::from(b.role.writers_allowed()), 1);
        proptest::prop_assert_eq!(a.role.writers_allowed(), a.node_id < b.node_id);
        proptest::prop_assert_eq!(a.highest_seen_epoch, epoch + 1);
        proptest::prop_assert_eq!(b.highest_seen_epoch, epoch + 1);
    }
}

#[test]
fn epoch_exhaustion_refuses_every_new_authority_path() {
    let top = with_epoch(client_rec(), u64::MAX);
    let force = apply(
        &top,
        Event::ForceTakeover {
            min_unreachable_ms: 0,
            confirmed: true,
        },
        NOW,
        ACTOR,
    );
    assert_eq!(force, Err(RoleError::EpochExhausted));
    let (_, frozen) = frozen_client_rec();
    let restore = apply(
        &frozen,
        Event::RestoreFrozen {
            confirmed: true,
            server_demoted_epoch: u64::MAX,
        },
        frozen.frozen.as_ref().unwrap().frozen_at_ms,
        ACTOR,
    );
    assert_eq!(restore, Err(RoleError::EpochExhausted));
    let p = Pair::new();
    let accept = apply(&p.tgt, ev_accept(&p, u64::MAX), NOW, ACTOR);
    assert_eq!(accept, Err(RoleError::EpochExhausted));
    let mut p = Pair::new();
    p.src = with_epoch(primary_rec(), u64::MAX);
    let h = at(&p.src, ev_prepare_existing(&p), NOW);
    let h = at(&h, ev_bundle(&p), NOW + 1);
    assert_eq!(
        apply(&h, ev_commit(&p), NOW + 2, ACTOR),
        Err(RoleError::EpochExhausted)
    );
    assert_eq!(RoleError::EpochExhausted.code(), "E_CONFLICT");
    assert_eq!(RoleError::EpochExhausted.reason(), "role-epoch-exhausted");
}

#[test]
fn backward_wall_clock_does_not_mutate_a_lease_or_enable_takeover() {
    let lease = Lease::grant(NOW, TTL);
    assert!(lease.is_live(NOW - TTL));
    assert_eq!(lease.expires_at_ms(), NOW + TTL);
    assert!(!lease.renew_due(NOW - TTL, DEFAULT_HEARTBEAT_MS));
    let mut client = client_rec();
    client.last_primary_contact_at_ms = Some(NOW);
    assert_eq!(
        takeover_wait_ms(&client, NOW - TTL, DEFAULT_TAKEOVER_MIN_UNREACHABLE_MS),
        DEFAULT_TAKEOVER_MIN_UNREACHABLE_MS + TTL
    );
}

#[cfg(unix)]
#[test]
fn loading_a_fifo_refuses_without_waiting_for_a_writer() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("role.json");
    assert!(std::process::Command::new("mkfifo")
        .arg(&path)
        .status()
        .unwrap()
        .success());
    assert!(matches!(load(&path), Loaded::Corrupt { .. }));
}

#[test]
fn a_role_lock_holds_back_publication_until_the_guard_drops() {
    use std::sync::mpsc::{channel, RecvTimeoutError};
    use std::time::Duration;
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("role.json");
    let rec = primary_rec();
    save(&path, &rec).unwrap();
    let guard = crate::role::atomic::lock(&path).unwrap();
    let (ready, entered) = channel();
    let (done, completed) = channel();
    let worker_path = path.clone();
    let next = with_epoch(rec.clone(), 2);
    let worker = std::thread::spawn(move || {
        ready.send(()).unwrap();
        let result = save(&worker_path, &next);
        done.send(()).unwrap();
        result
    });
    entered.recv_timeout(Duration::from_secs(10)).unwrap();
    let blocked = matches!(
        completed.recv_timeout(Duration::from_secs(1)),
        Err(RecvTimeoutError::Timeout)
    );
    let while_locked = load(&path);
    drop(guard);
    let result = worker.join().unwrap();
    assert!(blocked, "publication escaped the held role lock");
    assert_eq!(while_locked, Loaded::Valid(rec));
    result.unwrap();
    assert!(matches!(load(&path), Loaded::Valid(rec) if rec.epoch == 2));
}
