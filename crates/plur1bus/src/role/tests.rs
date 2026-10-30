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
        cluster_id: rec.cluster_id.clone().expect("cluster"),
        epoch,
        primary,
    }
}

// ----
// Model: wire format
// ----

#[test]
fn wire_values_and_writers() {
    let cases = [
        (Role::Standalone, "standalone", true),
        (Role::Primary, "primary", true),
        (Role::Client, "client", false),
        (Role::HandingOver, "handing-over", false),
        (Role::Pending, "pending", false),
        (Role::Fenced, "fenced", false),
    ];
    for (role, wire, writers) in cases {
        assert_eq!(serde_json::to_string(&role).unwrap(), format!("\"{wire}\""));
        assert_eq!(role.as_str(), wire);
        assert_eq!(role.writers_allowed(), writers, "{wire}");
        let back: Role = serde_json::from_str(&format!("\"{wire}\"")).unwrap();
        assert_eq!(back, role);
    }
    assert_eq!(
        serde_json::to_string(&ReachKind::Tailnet).unwrap(),
        "\"tailnet\""
    );
    assert_eq!(
        serde_json::to_string(&HandoverSide::Target).unwrap(),
        "\"target\""
    );
    assert_eq!(ROLE_SCHEMA, "plur1bus.role/1");
}

#[test]
fn standalone_record_is_valid_and_minimal_json() {
    let r = RoleRecord::standalone("00000000-0000-4000-8000-000000000001", &fp("n"), 42, "init");
    r.validate().unwrap();
    assert_eq!(r.role, Role::Standalone);
    assert_eq!(r.epoch, 0);
    assert_eq!(r.highest_seen_epoch, 0);
    assert_eq!(r.schema, ROLE_SCHEMA);
    let v = serde_json::to_value(&r).unwrap();
    let obj = v.as_object().unwrap();
    for k in [
        "schema",
        "role",
        "epoch",
        "nodeId",
        "nodeKeyFingerprint",
        "highestSeenEpoch",
        "changedAtMs",
        "changedBy",
    ] {
        assert!(obj.contains_key(k), "missing {k}");
    }
    for k in [
        "clusterId",
        "primary",
        "handover",
        "frozen",
        "lastPrimaryContactAtMs",
    ] {
        assert!(!obj.contains_key(k), "unexpected {k}");
    }
}

#[test]
fn round_trip_every_role() {
    for r in all_roles() {
        r.validate().unwrap();
        let text = serde_json::to_string(&r).unwrap();
        let back: RoleRecord = serde_json::from_str(&text).unwrap();
        assert_eq!(back, r, "{}", r.role.as_str());
    }
    let (_, c) = frozen_client_rec();
    let back: RoleRecord = serde_json::from_str(&serde_json::to_string(&c).unwrap()).unwrap();
    assert_eq!(back, c);
}

#[test]
fn json_key_names() {
    let p = Pair::new();
    let h = at(&p.src, ev_prepare(&p), NOW);
    let h = at(&h, ev_bundle(&p), NOW);
    let v = serde_json::to_value(&h).unwrap();
    for k in ["clusterId", "handover"] {
        assert!(v.get(k).is_some(), "{k}");
    }
    let ho = v.get("handover").unwrap();
    for k in [
        "id",
        "side",
        "peerNodeId",
        "peerKeyFingerprint",
        "bundleSha256",
        "startedAtMs",
        "leaseExpiresAtMs",
        "previousRole",
        "previousClusterId",
        "previousEpoch",
    ] {
        assert!(ho.get(k).is_some(), "handover.{k}");
    }
    assert!(ho.get("expectedEpoch").is_none());
    let (_, c) = frozen_client_rec();
    let v = serde_json::to_value(&c).unwrap();
    assert!(v["primary"]["reach"]["ref"].is_string());
    assert_eq!(v["primary"]["reach"]["kind"], "ssh");
    for k in ["epoch", "bundleSha256", "frozenAtMs", "rollbackUntilMs"] {
        assert!(v["frozen"].get(k).is_some(), "frozen.{k}");
    }
    assert!(v.get("lastPrimaryContactAtMs").is_some());
}

#[test]
fn unknown_fields_are_refused() {
    let (_, client) = frozen_client_rec();
    let pending = pending_rec();
    let cases: Vec<(&RoleRecord, &[&str])> = vec![
        (&client, &[]),
        (&pending, &["handover"]),
        (&client, &["primary"]),
        (&client, &["primary", "reach"]),
        (&client, &["frozen"]),
    ];
    for (rec, path) in cases {
        let mut v = serde_json::to_value(rec).unwrap();
        let mut cur = &mut v;
        for k in path {
            cur = cur.get_mut(*k).unwrap();
        }
        cur.as_object_mut()
            .unwrap()
            .insert("bogus".into(), serde_json::json!(1));
        assert!(
            serde_json::from_value::<RoleRecord>(v).is_err(),
            "{path:?} accepted an unknown key"
        );
    }
}

// ----
// Model: validation
// ----

fn expect_invalid(mut r: RoleRecord, field: &'static str, f: impl FnOnce(&mut RoleRecord)) {
    f(&mut r);
    assert_eq!(r.validate(), Err(invalid(field)), "field {field}");
}

#[test]
fn validate_schema_and_identifiers() {
    let p = primary_rec();
    expect_invalid(p.clone(), "schema", |r| r.schema = s("plur1bus.role/2"));
    expect_invalid(p.clone(), "nodeId", |r| r.node_id = s("not-a-uuid"));
    expect_invalid(p.clone(), "nodeId", |r| {
        r.node_id = r.node_id.to_uppercase()
    });
    expect_invalid(p.clone(), "nodeId", |r| {
        r.node_id = r.node_id.replace('-', "")
    });
    expect_invalid(p.clone(), "clusterId", |r| r.cluster_id = Some(s("nope")));
    expect_invalid(p.clone(), "clusterId", |r| {
        r.cluster_id = r.cluster_id.take().map(|c| c.to_uppercase())
    });
    // Any UUID version is fine.
    let mut ok = p.clone();
    ok.node_id = uuid::Uuid::from_u128(7).to_string();
    ok.validate().unwrap();
    let mut ok = p;
    ok.node_id = uuid::Uuid::nil().to_string();
    ok.validate().unwrap();
}

#[test]
fn validate_fingerprints_and_hashes() {
    let p = primary_rec();
    expect_invalid(p.clone(), "nodeKeyFingerprint", |r| {
        r.node_key_fingerprint = s("sha256:short")
    });
    expect_invalid(p.clone(), "nodeKeyFingerprint", |r| {
        r.node_key_fingerprint = format!("sha256:{}+", &hex_sha256("x")[..42])
    });
    expect_invalid(p.clone(), "nodeKeyFingerprint", |r| {
        r.node_key_fingerprint = format!("sha512:{}", &hex_sha256("x")[..43])
    });
    expect_invalid(p.clone(), "nodeKeyFingerprint", |r| {
        r.node_key_fingerprint = format!("sha256:{}", &hex_sha256("x")[..44])
    });
    // `-` and `_` are legal.
    let mut ok = p;
    ok.node_key_fingerprint = format!("sha256:{}-_", &hex_sha256("x")[..41]);
    ok.validate().unwrap();

    let pending = pending_rec();
    expect_invalid(pending.clone(), "handover.bundleSha256", |r| {
        r.handover.as_mut().unwrap().bundle_sha256 = Some(hex_sha256("b")[..63].to_string())
    });
    expect_invalid(pending.clone(), "handover.bundleSha256", |r| {
        r.handover.as_mut().unwrap().bundle_sha256 = Some(hex_sha256("b").to_uppercase())
    });
    expect_invalid(pending.clone(), "handover.peerKeyFingerprint", |r| {
        r.handover.as_mut().unwrap().peer_key_fingerprint = s("x")
    });
    expect_invalid(pending.clone(), "handover.peerNodeId", |r| {
        r.handover.as_mut().unwrap().peer_node_id = s("x")
    });
    expect_invalid(pending.clone(), "handover.id", |r| {
        r.handover.as_mut().unwrap().id = s("x")
    });

    let (_, client) = frozen_client_rec();
    expect_invalid(client.clone(), "frozen.bundleSha256", |r| {
        r.frozen.as_mut().unwrap().bundle_sha256 = hex_sha256("b").to_uppercase()
    });
    expect_invalid(client.clone(), "frozen.bundleSha256", |r| {
        r.frozen.as_mut().unwrap().bundle_sha256 = hex_sha256("b")[..63].to_string()
    });
    expect_invalid(client.clone(), "frozen.rollbackUntilMs", |r| {
        let f = r.frozen.as_mut().unwrap();
        f.rollback_until_ms = f.frozen_at_ms - 1;
    });
    expect_invalid(client.clone(), "primary.nodeId", |r| {
        r.primary.as_mut().unwrap().node_id = s("x")
    });
    expect_invalid(client.clone(), "primary.nodeKeyFingerprint", |r| {
        r.primary.as_mut().unwrap().node_key_fingerprint = s("x")
    });
    expect_invalid(client, "primary.nodeId", |r| {
        r.primary.as_mut().unwrap().node_id = r.node_id.clone()
    });
}

#[test]
fn validate_free_text() {
    let (_, client) = frozen_client_rec();
    expect_invalid(client.clone(), "changedBy", |r| {
        r.changed_by = String::new()
    });
    expect_invalid(client.clone(), "changedBy", |r| r.changed_by = s("a\u{7}b"));
    expect_invalid(client.clone(), "changedBy", |r| {
        r.changed_by = "x".repeat(129)
    });
    expect_invalid(client.clone(), "primary.displayName", |r| {
        r.primary.as_mut().unwrap().display_name = String::new()
    });
    expect_invalid(client.clone(), "primary.displayName", |r| {
        r.primary.as_mut().unwrap().display_name = "x".repeat(129)
    });
    expect_invalid(client.clone(), "primary.displayName", |r| {
        r.primary.as_mut().unwrap().display_name = s("a\nb")
    });
    expect_invalid(client.clone(), "primary.reach.ref", |r| {
        r.primary.as_mut().unwrap().reach.reference = String::new()
    });
    expect_invalid(client.clone(), "primary.reach.ref", |r| {
        r.primary.as_mut().unwrap().reach.reference = "x".repeat(257)
    });
    expect_invalid(client.clone(), "primary.reach.ref", |r| {
        r.primary.as_mut().unwrap().reach.reference = s("a\u{0}b")
    });
    // Limits are inclusive.
    let mut ok = client;
    ok.changed_by = "x".repeat(128);
    ok.primary.as_mut().unwrap().display_name = "x".repeat(128);
    ok.primary.as_mut().unwrap().reach.reference = "x".repeat(256);
    ok.validate().unwrap();
}

#[test]
fn validate_epochs() {
    let p = primary_rec();
    expect_invalid(p.clone(), "highestSeenEpoch", |r| r.highest_seen_epoch = 0);
    let mut ok = p;
    ok.highest_seen_epoch = 9;
    ok.validate().unwrap();
}

#[test]
fn validate_per_role_columns() {
    // Standalone
    let st = rec0("a");
    expect_invalid(st.clone(), "clusterId", |r| r.cluster_id = Some(id()));
    expect_invalid(st.clone(), "epoch", |r| {
        r.epoch = 1;
        r.highest_seen_epoch = 1
    });
    expect_invalid(st.clone(), "primary", |r| {
        r.primary = Some(node_ref(&id(), "p"))
    });
    expect_invalid(st.clone(), "handover", |r| {
        r.handover = handing_over_rec().handover
    });
    expect_invalid(st.clone(), "frozen", |r| {
        r.frozen = frozen_client_rec().1.frozen
    });
    expect_invalid(st.clone(), "highestSeenEpoch", |r| r.highest_seen_epoch = 1);
    expect_invalid(st, "lastPrimaryContactAtMs", |r| {
        r.last_primary_contact_at_ms = Some(1)
    });

    // Primary
    let pr = primary_rec();
    expect_invalid(pr.clone(), "clusterId", |r| r.cluster_id = None);
    expect_invalid(pr.clone(), "epoch", |r| r.epoch = 0);
    expect_invalid(pr.clone(), "primary", |r| {
        r.primary = Some(node_ref(&id(), "p"))
    });
    expect_invalid(pr.clone(), "handover", |r| {
        r.handover = handing_over_rec().handover
    });
    expect_invalid(pr, "frozen", |r| r.frozen = frozen_client_rec().1.frozen);

    // Client
    let (_, cl) = frozen_client_rec();
    expect_invalid(cl.clone(), "clusterId", |r| r.cluster_id = None);
    expect_invalid(cl.clone(), "epoch", |r| r.epoch = 0);
    expect_invalid(cl.clone(), "primary", |r| r.primary = None);
    expect_invalid(cl.clone(), "handover", |r| {
        r.handover = handing_over_rec().handover
    });
    let mut no_frozen = cl;
    no_frozen.frozen = None;
    no_frozen.validate().unwrap();

    // HandingOver
    let ho = handing_over_rec();
    expect_invalid(ho.clone(), "clusterId", |r| r.cluster_id = None);
    expect_invalid(ho.clone(), "epoch", |r| r.epoch = 0);
    expect_invalid(ho.clone(), "primary", |r| {
        r.primary = Some(node_ref(&id(), "p"))
    });
    expect_invalid(ho.clone(), "handover", |r| r.handover = None);
    expect_invalid(ho.clone(), "handover.side", |r| {
        r.handover.as_mut().unwrap().side = HandoverSide::Target
    });
    expect_invalid(ho.clone(), "handover.peerNodeId", |r| {
        r.handover.as_mut().unwrap().peer_node_id = r.node_id.clone()
    });
    expect_invalid(ho, "frozen", |r| r.frozen = frozen_client_rec().1.frozen);

    // Pending
    let pe = pending_rec();
    pe.validate().unwrap();
    expect_invalid(pe.clone(), "clusterId", |r| r.cluster_id = None);
    expect_invalid(pe.clone(), "handover", |r| r.handover = None);
    expect_invalid(pe.clone(), "handover.side", |r| {
        r.handover.as_mut().unwrap().side = HandoverSide::Source
    });
    expect_invalid(pe.clone(), "handover.bundleSha256", |r| {
        r.handover.as_mut().unwrap().bundle_sha256 = None
    });
    expect_invalid(pe.clone(), "handover.expectedEpoch", |r| {
        r.handover.as_mut().unwrap().expected_epoch = None
    });
    let mut with_primary = pe.clone();
    with_primary.primary = Some(node_ref(&id(), "p"));
    with_primary.frozen = frozen_client_rec().1.frozen;
    with_primary.validate().unwrap();

    // Fenced
    let fe = fenced_rec();
    fe.validate().unwrap();
    expect_invalid(fe.clone(), "clusterId", |r| r.cluster_id = None);
    expect_invalid(fe.clone(), "epoch", |r| r.epoch = 0);
    expect_invalid(fe.clone(), "handover", |r| {
        r.handover = handing_over_rec().handover
    });
    expect_invalid(fe.clone(), "frozen", |r| {
        r.frozen = frozen_client_rec().1.frozen
    });
    let mut with_primary = fe;
    with_primary.primary = Some(node_ref(&id(), "p"));
    with_primary.validate().unwrap();
}

#[test]
fn error_reasons_and_codes() {
    let table: Vec<(RoleError, &str, &str)> = vec![
        (
            RoleError::InvalidTransition {
                from: Role::Client,
                event: "abort",
            },
            "role-invalid-transition",
            "E_CONFLICT",
        ),
        (invalid("x"), "role-invalid-input", "E_INVALID_PARAMS"),
        (
            RoleError::StaleEpoch { got: 1, highest: 2 },
            "role-stale-epoch",
            "E_INVALID_PARAMS",
        ),
        (
            RoleError::ForeignCluster,
            "role-bundle-foreign-cluster",
            "E_INVALID_PARAMS",
        ),
        (
            RoleError::TargetNotEmpty,
            "role-target-not-empty",
            "E_CONFLICT",
        ),
        (
            RoleError::LeaseExpired,
            "role-lease-expired",
            "E_NOT_AVAILABLE",
        ),
        (
            RoleError::ReceiptInvalid { field: "x" },
            "role-receipt-invalid",
            "E_INVALID_PARAMS",
        ),
        (
            RoleError::CommitInvalid { field: "x" },
            "role-commit-invalid",
            "E_INVALID_PARAMS",
        ),
        (
            RoleError::TakeoverTooEarly { remaining_ms: 5 },
            "role-takeover-too-early",
            "E_DENIED",
        ),
        (RoleError::Unconfirmed, "role-unconfirmed", "E_DENIED"),
        (
            RoleError::RollbackExpired,
            "role-rollback-expired",
            "E_CONFLICT",
        ),
        (
            RoleError::RecordCorrupt { detail: s("d") },
            "role-record-corrupt",
            "E_STORAGE",
        ),
        (RoleError::Io { detail: s("d") }, "io", "E_STORAGE"),
    ];
    for (e, reason, code) in table {
        assert_eq!(e.reason(), reason);
        assert_eq!(e.code(), code);
        let text = e.to_string();
        assert!(text.starts_with(reason), "{text}");
        let _: &dyn std::error::Error = &e;
    }
}

// ----
// Model: transition rows
// ----

fn stamp(r: &mut RoleRecord, now: u64) {
    r.changed_at_ms = now;
    r.changed_by = s(ACTOR);
}

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
            cluster_id: id(),
            epoch: 9,
            primary: None,
        };
        assert_eq!(err(&r, ev, NOW), RoleError::ForeignCluster, "{:?}", r.role);
    }
    // A malformed cluster id is an input error.
    let r = primary_rec();
    let ev = Event::Observed {
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
    // a client cannot be told that it is the primary
    assert_eq!(
        err(&c, observed(&c, 4, Some(nref(&c))), NOW),
        invalid("primary")
    );
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

// ----
// Store
// ----

#[test]
fn store_missing_file() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("role.json");
    let loaded = load(&path);
    assert!(matches!(loaded, Loaded::Missing));
    assert_eq!(writer_decision(&loaded), WriterDecision::Allowed);
}

#[test]
fn store_save_load_round_trip() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("state").join("role.json");
    let r = primary_rec();
    save(&path, &r).unwrap();
    match load(&path) {
        Loaded::Valid(back) => assert_eq!(back, r),
        other => panic!("{other:?}"),
    }
    let bytes = std::fs::read(&path).unwrap();
    assert_eq!(bytes.last(), Some(&b'\n'));
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mode = std::fs::metadata(&path).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode, 0o600);
    }
    let leftovers: Vec<_> = std::fs::read_dir(path.parent().unwrap())
        .unwrap()
        .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
        .filter(|n| n.contains(".tmp-"))
        .collect();
    assert!(leftovers.is_empty(), "{leftovers:?}");
    // Overwriting with the same record, and with a newer epoch in the same cluster, works.
    save(&path, &r).unwrap();
    let newer = with_epoch(r, 3);
    save(&path, &newer).unwrap();
    assert!(matches!(load(&path), Loaded::Valid(b) if b == newer));
}

#[test]
fn store_corrupt_is_never_overwritten() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("role.json");
    std::fs::write(&path, b"\x00\xffgarbage").unwrap();
    let loaded = load(&path);
    assert!(matches!(loaded, Loaded::Corrupt { .. }));
    assert_eq!(
        writer_decision(&loaded),
        WriterDecision::Denied {
            reason: "role-record-corrupt"
        }
    );
    let r = primary_rec();
    assert!(matches!(
        save(&path, &r),
        Err(RoleError::RecordCorrupt { .. })
    ));
    assert_eq!(std::fs::read(&path).unwrap(), b"\x00\xffgarbage");
}

#[test]
fn store_rejects_bad_files() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("role.json");
    let r = primary_rec();
    let good = serde_json::to_value(&r).unwrap();
    let write =
        |v: &serde_json::Value| std::fs::write(&path, serde_json::to_vec(v).unwrap()).unwrap();
    let is_corrupt = |path: &std::path::Path| matches!(load(path), Loaded::Corrupt { .. });

    // unknown field
    let mut v = good.clone();
    v["bogus"] = serde_json::json!(1);
    write(&v);
    assert!(is_corrupt(&path));
    // wrong schema
    let mut v = good.clone();
    v["schema"] = serde_json::json!("plur1bus.role/9");
    write(&v);
    assert!(is_corrupt(&path));
    // fails validate()
    let mut v = good.clone();
    v["epoch"] = serde_json::json!(0);
    write(&v);
    assert!(is_corrupt(&path));
    // not JSON object at all
    std::fs::write(&path, b"[]").unwrap();
    assert!(is_corrupt(&path));
    // invalid UTF-8
    std::fs::write(&path, [0xff, 0xfe, 0xfd]).unwrap();
    assert!(is_corrupt(&path));
    // too large
    let big = vec![b' '; (MAX_RECORD_BYTES + 1) as usize];
    std::fs::write(&path, &big).unwrap();
    assert!(is_corrupt(&path));
    // a directory
    let d = dir.path().join("as-dir");
    std::fs::create_dir(&d).unwrap();
    assert!(is_corrupt(&d));
    // the untouched record still loads
    write(&good);
    assert!(matches!(load(&path), Loaded::Valid(_)));
}

#[cfg(unix)]
#[test]
fn store_rejects_symlink() {
    let dir = tempfile::tempdir().unwrap();
    let real = dir.path().join("real.json");
    let link = dir.path().join("role.json");
    save(&real, &primary_rec()).unwrap();
    std::os::unix::fs::symlink(&real, &link).unwrap();
    assert!(matches!(load(&link), Loaded::Corrupt { .. }));
    assert!(matches!(
        save(&link, &primary_rec()),
        Err(RoleError::RecordCorrupt { .. })
    ));
}

#[test]
fn store_save_checks() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("role.json");
    // invalid record
    let mut bad = primary_rec();
    bad.epoch = 0;
    assert_eq!(save(&path, &bad), Err(invalid("epoch")));
    assert!(matches!(load(&path), Loaded::Missing));

    let r = with_epoch(primary_rec(), 4);
    save(&path, &r).unwrap();
    // epoch regression in the same cluster
    let mut lower = r.clone();
    lower.epoch = 3;
    lower.highest_seen_epoch = 4;
    assert_eq!(
        save(&path, &lower),
        Err(RoleError::StaleEpoch { got: 3, highest: 4 })
    );
    // highest-seen regression
    let mut lower_h = r.clone();
    lower_h.highest_seen_epoch = 4;
    let mut higher = r.clone();
    higher.highest_seen_epoch = 6;
    save(&path, &higher).unwrap();
    assert_eq!(
        save(&path, &lower_h),
        Err(RoleError::StaleEpoch { got: 4, highest: 6 })
    );
    // changed node id
    let mut other = higher.clone();
    other.node_id = id();
    assert_eq!(save(&path, &other), Err(invalid("nodeId")));
    // a different cluster is allowed (join or fresh accept), even with a lower epoch
    let mut moved = higher.clone();
    moved.cluster_id = Some(id());
    moved.epoch = 1;
    moved.highest_seen_epoch = 1;
    save(&path, &moved).unwrap();
    // leaving: a standalone record after a cluster record
    let mut stand = rec0("x");
    stand.node_id = moved.node_id.clone();
    stand.node_key_fingerprint = moved.node_key_fingerprint.clone();
    save(&path, &stand).unwrap();
    assert!(matches!(load(&path), Loaded::Valid(b) if b == stand));
    // and a cluster record after a standalone one
    save(&path, &moved).unwrap();
}

// ----
// Fence
// ----

#[test]
fn fence_compare() {
    let p = with_epoch(primary_rec(), 3);
    let c = p.cluster_id.clone().unwrap();
    assert_eq!(compare(&p, &c, 3), EpochVerdict::Same);
    assert_eq!(compare(&p, &c, 4), EpochVerdict::LocalBehind);
    assert_eq!(compare(&p, &c, 2), EpochVerdict::LocalAhead);
    assert_eq!(compare(&p, &id(), 3), EpochVerdict::ForeignCluster);
    assert_eq!(compare(&rec0("a"), &c, 0), EpochVerdict::ForeignCluster);
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
    )
    .unwrap();
    assert_eq!(r.epoch, u64::MAX);
    assert_eq!(takeover_wait_ms(&top, 0, u64::MAX), u64::MAX);
}

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
                        let ev = Event::Observed { cluster_id: c.clone(), epoch: extra_epoch, primary: None };
                        if let Ok(r) = apply(&src, ev, now, ACTOR) { src = r; }
                    }
                    _ => {
                        let ev = Event::Observed { cluster_id: c.clone(), epoch: extra_epoch, primary: None };
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
