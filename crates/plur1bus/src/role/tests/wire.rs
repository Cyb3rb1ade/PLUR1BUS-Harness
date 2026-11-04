//! wire cases for RS0.
use super::*;

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
