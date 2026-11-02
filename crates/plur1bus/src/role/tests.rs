//! Unit and property tests for the role model, the record store and the fence helpers.
use super::fence::*;
use super::model::*;
use super::store::*;
use proptest::prelude::*;
use sha2::{Digest, Sha256};

const START: u64 = 1_000_000;
const NOW: u64 = 2_000_000;
const TTL: u64 = 120_000;
const RB: u64 = 500_000;
const ACTOR: &str = "tester";

// ----
// Helpers (no literals that look like hashes or keys: everything is derived from short labels)
// ----

fn hex_sha256(label: &str) -> String {
    Sha256::digest(label.as_bytes())
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect()
}

fn fp(label: &str) -> String {
    format!("sha256:{}", &hex_sha256(label)[..43])
}

fn id() -> String {
    uuid::Uuid::new_v4().to_string()
}

fn node_ref(node_id: &str, label: &str) -> NodeRef {
    NodeRef {
        node_id: node_id.to_string(),
        node_key_fingerprint: fp(label),
        display_name: "server".to_string(),
        reach: Reach {
            kind: ReachKind::Ssh,
            reference: "profile-1".to_string(),
        },
    }
}

fn nref(rec: &RoleRecord) -> NodeRef {
    NodeRef {
        node_id: rec.node_id.clone(),
        node_key_fingerprint: rec.node_key_fingerprint.clone(),
        display_name: "server".to_string(),
        reach: Reach {
            kind: ReachKind::Ssh,
            reference: "profile-1".to_string(),
        },
    }
}

fn rec0(label: &str) -> RoleRecord {
    RoleRecord::standalone(&id(), &fp(label), START, "init")
}

fn s(v: &str) -> String {
    v.to_string()
}

fn at(rec: &RoleRecord, ev: Event, now: u64) -> RoleRecord {
    apply(rec, ev, now, ACTOR).expect("transition")
}

fn err(rec: &RoleRecord, ev: Event, now: u64) -> RoleError {
    apply(rec, ev, now, ACTOR).expect_err("transition must fail")
}

fn invalid(field: &'static str) -> RoleError {
    RoleError::InvalidInput { field }
}

/// A source node, a fresh target node and the identifiers of one handover.
struct Pair {
    src: RoleRecord,
    tgt: RoleRecord,
    cluster: String,
    hid: String,
    sha: String,
}

impl Pair {
    fn new() -> Pair {
        Pair {
            src: rec0("src"),
            tgt: rec0("tgt"),
            cluster: id(),
            hid: id(),
            sha: hex_sha256("bundle"),
        }
    }
}

fn ev_prepare(p: &Pair) -> Event {
    Event::Prepare {
        handover_id: p.hid.clone(),
        target_node_id: p.tgt.node_id.clone(),
        target_key_fingerprint: p.tgt.node_key_fingerprint.clone(),
        new_cluster_id: Some(p.cluster.clone()),
        lease_ttl_ms: TTL,
    }
}

fn ev_prepare_existing(p: &Pair) -> Event {
    Event::Prepare {
        handover_id: p.hid.clone(),
        target_node_id: p.tgt.node_id.clone(),
        target_key_fingerprint: p.tgt.node_key_fingerprint.clone(),
        new_cluster_id: None,
        lease_ttl_ms: TTL,
    }
}

fn ev_bundle(p: &Pair) -> Event {
    Event::BundleReady {
        bundle_sha256: p.sha.clone(),
    }
}

fn ev_accept(p: &Pair, bundle_epoch: u64) -> Event {
    Event::Accept {
        handover_id: p.hid.clone(),
        cluster_id: p.cluster.clone(),
        bundle_epoch,
        bundle_sha256: p.sha.clone(),
        source_node_id: p.src.node_id.clone(),
        source_key_fingerprint: p.src.node_key_fingerprint.clone(),
        target_is_fresh: true,
        replace: false,
        lease_ttl_ms: TTL,
    }
}

fn ev_commit(p: &Pair) -> Event {
    Event::Commit {
        receipt_handover_id: p.hid.clone(),
        receipt_bundle_sha256: p.sha.clone(),
        receipt_target_node_id: p.tgt.node_id.clone(),
        primary: nref(&p.tgt),
        rollback_window_ms: RB,
    }
}

fn ev_activate(p: &Pair, epoch: u64) -> Event {
    Event::Activate {
        token_handover_id: p.hid.clone(),
        token_cluster_id: p.cluster.clone(),
        token_epoch: epoch,
        token_bundle_sha256: p.sha.clone(),
        token_target_node_id: p.tgt.node_id.clone(),
    }
}

fn writers(cluster: &str, recs: &[&RoleRecord]) -> usize {
    recs.iter()
        .filter(|r| r.role.writers_allowed() && r.cluster_id.as_deref() == Some(cluster))
        .count()
}

fn join_ev(cluster: &str, epoch: u64, primary: NodeRef) -> Event {
    Event::Join {
        cluster_id: cluster.to_string(),
        epoch,
        primary,
        node_is_fresh: true,
    }
}

/// A primary at epoch 1 (standalone → prepare → abort).
fn primary_rec() -> RoleRecord {
    let p = Pair::new();
    let h = at(&p.src, ev_prepare(&p), START + 10);
    at(&h, Event::Abort, START + 20)
}

fn with_epoch(mut r: RoleRecord, n: u64) -> RoleRecord {
    r.epoch = n;
    r.highest_seen_epoch = n;
    if let Some(h) = r.handover.as_mut() {
        h.previous_epoch = n;
    }
    r
}

fn handing_over_rec() -> RoleRecord {
    let p = Pair::new();
    at(&p.src, ev_prepare(&p), START + 10)
}

/// A client at epoch 1 with no frozen state (joined).
fn client_rec() -> RoleRecord {
    let me = rec0("me");
    let primary = node_ref(&id(), "srv");
    at(&me, join_ev(&id(), 1, primary), START + 10)
}

/// A client that handed over: epoch 2, frozen at epoch 1.
fn frozen_client_rec() -> (Pair, RoleRecord) {
    let p = Pair::new();
    let h = at(&p.src, ev_prepare(&p), START + 10);
    let h = at(&h, ev_bundle(&p), START + 20);
    let c = at(&h, ev_commit(&p), START + 30);
    (p, c)
}

fn pending_rec() -> RoleRecord {
    let p = Pair::new();
    at(&p.tgt, ev_accept(&p, 1), START + 10)
}

fn fenced_rec() -> RoleRecord {
    let p = primary_rec();
    let c = p.cluster_id.clone().unwrap();
    at(
        &p,
        Event::Observed {
            peer_node_id: id(),
            peer_is_writer: false,
            cluster_id: c,
            epoch: 2,
            primary: None,
        },
        START + 30,
    )
}

fn all_roles() -> Vec<RoleRecord> {
    vec![
        rec0("a"),
        primary_rec(),
        client_rec(),
        handing_over_rec(),
        pending_rec(),
        fenced_rec(),
    ]
}

fn observed(rec: &RoleRecord, epoch: u64, primary: Option<NodeRef>) -> Event {
    Event::Observed {
        peer_node_id: id(),
        peer_is_writer: false,
        cluster_id: rec.cluster_id.clone().expect("cluster"),
        epoch,
        primary,
    }
}

#[path = "tests/closed.rs"]
mod closed;
#[path = "tests/fence.rs"]
mod fence;
#[path = "tests/properties.rs"]
mod properties;
#[path = "tests/review.rs"]
mod review;
#[path = "tests/scripts.rs"]
mod scripts;
#[path = "tests/source_rows.rs"]
mod source_rows;
#[path = "tests/store.rs"]
mod store;
#[path = "tests/target_rows.rs"]
mod target_rows;
#[path = "tests/validation.rs"]
mod validation;
#[path = "tests/wire.rs"]
mod wire;

fn stamp(r: &mut RoleRecord, now: u64) {
    r.changed_at_ms = now;
    r.changed_by = s(ACTOR);
}
