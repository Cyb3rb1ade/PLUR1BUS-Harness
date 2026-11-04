//! validation cases for RS0.
use super::*;

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
