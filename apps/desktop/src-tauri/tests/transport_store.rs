//! The `connection-transport.json` sidecar (transport choice spec §3.2, R10; package T2).
use plur1bus_desktop::connections::{Connection, Kind, Origin, Store};
use plur1bus_desktop::transport::{
    PublicAck, StoreMode, Transport, TransportEntry, TransportStore, TransportStoreError,
};
use sha2::{Digest, Sha256};
use std::fs;
use std::path::Path;
use uuid::Uuid;

const SIDECAR: &str = "connection-transport.json";

fn row(kind: Kind, origin: &str) -> Connection {
    Connection::new(
        "Desk".into(),
        kind,
        Origin::parse(origin).unwrap(),
        "installation".into(),
        "device".into(),
        "hint".into(),
    )
}

/// Writes `connections.json` with the real connection store and returns its rows.
fn seed(dir: &Path, rows: &[Connection]) {
    let store = Store::open(dir);
    for r in rows {
        store.upsert(r.clone()).unwrap();
    }
}

fn digest(path: &Path) -> Vec<u8> {
    Sha256::digest(fs::read(path).unwrap()).to_vec()
}

fn sidecar(dir: &Path) -> serde_json::Value {
    serde_json::from_slice(&fs::read(dir.join(SIDECAR)).unwrap()).unwrap()
}

fn corrupt_copies(dir: &Path) -> Vec<String> {
    let mut names: Vec<String> = fs::read_dir(dir)
        .unwrap()
        .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
        .filter(|n| n.starts_with("connection-transport.json.corrupt-"))
        .collect();
    names.sort();
    names
}

fn direct_acked() -> TransportEntry {
    let mut e = TransportEntry::new(Transport::Direct);
    e.public_ack = Some(PublicAck::now());
    e
}

#[test]
fn connections_json_is_byte_identical_after_set_remove_gc() {
    let dir = tempfile::tempdir().unwrap();
    let a = row(Kind::Remote, "https://harness.corp.example");
    let b = row(Kind::Remote, "https://nas.tail1234.ts.net");
    seed(dir.path(), &[a.clone(), b.clone()]);
    let connections = dir.path().join("connections.json");
    let before = digest(&connections);
    let modified = fs::metadata(&connections).unwrap().modified().unwrap();
    let store = TransportStore::open(dir.path());
    store.set(a.id, direct_acked()).unwrap();
    store
        .set(b.id, TransportEntry::new(Transport::Tailscale))
        .unwrap();
    store.remove(b.id).unwrap();
    store.gc(&[a.id]).unwrap();
    store.gc(&[]).unwrap();
    assert_eq!(digest(&connections), before);
    assert_eq!(
        fs::metadata(&connections).unwrap().modified().unwrap(),
        modified
    );
    assert_eq!(Store::open(dir.path()).load().unwrap(), vec![a, b]);
}

#[test]
fn set_get_remove_round_trip() {
    let dir = tempfile::tempdir().unwrap();
    let a = row(Kind::Remote, "https://harness.corp.example");
    seed(dir.path(), std::slice::from_ref(&a));
    let store = TransportStore::open(dir.path());
    assert_eq!(store.mode(), StoreMode::ReadWrite);
    assert_eq!(store.get(a.id), None);
    let entry = direct_acked();
    store.set(a.id, entry.clone()).unwrap();
    assert_eq!(store.get(a.id), Some(entry.clone()));
    assert_eq!(store.effective(&a), entry);
    let json = sidecar(dir.path());
    assert_eq!(json["version"], 1);
    let stored = &json["connections"][a.id.to_string()];
    assert_eq!(stored["transport"], "direct");
    assert_eq!(stored["publicAck"]["classifier"], "iana-special-2025-10-09");
    assert!(stored["publicAck"]["atMs"].is_u64());
    store.remove(a.id).unwrap();
    assert_eq!(store.get(a.id), None);
    assert_eq!(sidecar(dir.path())["connections"], serde_json::json!({}));
    // Removing an id without an entry is fine and leaves the file alone.
    let before = fs::read(dir.path().join(SIDECAR)).unwrap();
    store.remove(Uuid::now_v7()).unwrap();
    assert_eq!(fs::read(dir.path().join(SIDECAR)).unwrap(), before);
}

#[test]
fn missing_entry_is_the_derived_default() {
    let dir = tempfile::tempdir().unwrap();
    let ts = row(Kind::Remote, "https://nas.tail1234.ts.net");
    let ts_ip = row(Kind::Remote, "https://100.101.1.2:7443");
    let ts_v6 = row(Kind::Remote, "https://[fd7a:115c:a1e0::5]:7443");
    let corp = row(Kind::Remote, "https://harness.corp.example");
    let cgnat_edge = row(Kind::Remote, "https://100.128.0.1");
    let bundled = row(Kind::Bundled, "http://127.0.0.1:18700");
    seed(
        dir.path(),
        &[
            ts.clone(),
            ts_ip.clone(),
            ts_v6.clone(),
            corp.clone(),
            cgnat_edge.clone(),
            bundled.clone(),
        ],
    );
    let store = TransportStore::open(dir.path());
    for (c, want) in [
        (&ts, Transport::Tailscale),
        (&ts_ip, Transport::Tailscale),
        (&ts_v6, Transport::Tailscale),
        (&corp, Transport::Direct),
        (&cgnat_edge, Transport::Direct),
        (&bundled, Transport::Direct),
    ] {
        let e = store.effective(c);
        assert_eq!(e.transport, want, "{}", c.origin.as_str());
        assert_eq!(e.public_ack, None);
        assert!(e.extra.is_empty());
    }
    // Deriving a default writes nothing.
    assert!(!dir.path().join(SIDECAR).exists());
}

#[test]
fn unknown_fields_survive_a_write() {
    let dir = tempfile::tempdir().unwrap();
    let a = row(Kind::Remote, "https://harness.corp.example");
    let b = row(Kind::Remote, "https://other.corp.example");
    seed(dir.path(), &[a.clone(), b.clone()]);
    fs::write(
        dir.path().join(SIDECAR),
        serde_json::to_vec(&serde_json::json!({
            "version": 1,
            "futureTop": { "keep": true },
            "connections": {
                a.id.to_string(): { "transport": "tailscale", "futureField": [1, 2] }
            }
        }))
        .unwrap(),
    )
    .unwrap();
    let store = TransportStore::open(dir.path());
    let got = store.get(a.id).unwrap();
    assert_eq!(got.transport, Transport::Tailscale);
    assert_eq!(
        got.extra.get("futureField"),
        Some(&serde_json::json!([1, 2]))
    );
    store
        .set(b.id, TransportEntry::new(Transport::Direct))
        .unwrap();
    let json = sidecar(dir.path());
    assert_eq!(json["futureTop"], serde_json::json!({ "keep": true }));
    assert_eq!(
        json["connections"][a.id.to_string()],
        serde_json::json!({ "transport": "tailscale", "futureField": [1, 2] })
    );
    assert_eq!(
        json["connections"][b.id.to_string()],
        serde_json::json!({ "transport": "direct" })
    );
    // Rewriting an entry from what `get` returned keeps its unknown fields as well.
    let mut again = store.get(a.id).unwrap();
    again.transport = Transport::Direct;
    store.set(a.id, again).unwrap();
    assert_eq!(
        sidecar(dir.path())["connections"][a.id.to_string()]["futureField"],
        serde_json::json!([1, 2])
    );
}

#[test]
fn newer_version_is_read_only_and_untouched() {
    let dir = tempfile::tempdir().unwrap();
    let a = row(Kind::Remote, "https://nas.tail1234.ts.net");
    seed(dir.path(), std::slice::from_ref(&a));
    let body = serde_json::to_vec(&serde_json::json!({
        "version": 2,
        "connections": { a.id.to_string(): { "transport": "direct", "newShape": true } }
    }))
    .unwrap();
    fs::write(dir.path().join(SIDECAR), &body).unwrap();
    let store = TransportStore::open(dir.path());
    assert_eq!(store.mode(), StoreMode::ReadOnlyNewer);
    // Derived defaults apply; the newer file's entries are not interpreted.
    assert_eq!(store.get(a.id), None);
    assert_eq!(store.effective(&a).transport, Transport::Tailscale);
    let err = store
        .set(a.id, TransportEntry::new(Transport::Direct))
        .unwrap_err();
    assert_eq!(err, TransportStoreError::ReadOnly);
    assert_eq!(err.code(), "transport-store-readonly");
    assert_eq!(store.remove(a.id), Err(TransportStoreError::ReadOnly));
    assert_eq!(store.gc(&[]), Err(TransportStoreError::ReadOnly));
    assert_eq!(fs::read(dir.path().join(SIDECAR)).unwrap(), body);
    assert!(corrupt_copies(dir.path()).is_empty());
}

#[test]
fn garbage_sidecar_is_renamed_and_defaults_apply() {
    let a = row(Kind::Remote, "https://nas.tail1234.ts.net");
    let oversized = {
        let mut v = b"{\"version\":1,\"connections\":{},\"pad\":\"".to_vec();
        v.extend(std::iter::repeat_n(b'x', 1024 * 1024));
        v.extend(b"\"}");
        v
    };
    let wrong_types = serde_json::to_vec(&serde_json::json!({
        "version": 1,
        "connections": { a.id.to_string(): { "transport": "carrier-pigeon" } }
    }))
    .unwrap();
    let cases: Vec<(&str, Vec<u8>)> = vec![
        ("not json", b"{ not json".to_vec()),
        ("array", b"[]".to_vec()),
        ("no version", b"{\"connections\":{}}".to_vec()),
        ("version 0", b"{\"version\":0,\"connections\":{}}".to_vec()),
        (
            "version string",
            b"{\"version\":\"1\",\"connections\":{}}".to_vec(),
        ),
        (
            "bad id",
            b"{\"version\":1,\"connections\":{\"nope\":{\"transport\":\"direct\"}}}".to_vec(),
        ),
        ("wrong types", wrong_types),
        ("oversized", oversized),
    ];
    for (label, body) in cases {
        let dir = tempfile::tempdir().unwrap();
        seed(dir.path(), std::slice::from_ref(&a));
        let connections = dir.path().join("connections.json");
        let before = digest(&connections);
        fs::write(dir.path().join(SIDECAR), &body).unwrap();
        let store = TransportStore::open(dir.path());
        assert_eq!(
            store.effective(&a).transport,
            Transport::Tailscale,
            "{label}"
        );
        assert_eq!(store.get(a.id), None, "{label}");
        assert!(!dir.path().join(SIDECAR).exists(), "{label}");
        let copies = corrupt_copies(dir.path());
        assert_eq!(copies.len(), 1, "{label}: {copies:?}");
        assert_eq!(
            fs::read(dir.path().join(&copies[0])).unwrap(),
            body,
            "{label}"
        );
        assert_eq!(digest(&connections), before, "{label}");
        assert!(corrupt_connections(dir.path()).is_empty(), "{label}");
        // The store works again afterwards.
        assert_eq!(store.mode(), StoreMode::ReadWrite, "{label}");
        store
            .set(a.id, TransportEntry::new(Transport::Direct))
            .unwrap();
        assert_eq!(store.effective(&a).transport, Transport::Direct, "{label}");
        // A write that meets the corrupt file first moves it aside and succeeds in the same call.
        fs::write(dir.path().join(SIDECAR), &body).unwrap();
        store
            .set(a.id, TransportEntry::new(Transport::Direct))
            .unwrap();
        assert_eq!(corrupt_copies(dir.path()).len(), 2, "{label}");
        assert_eq!(
            store.get(a.id),
            Some(TransportEntry::new(Transport::Direct)),
            "{label}"
        );
        assert_eq!(digest(&connections), before, "{label}");
    }
}

fn corrupt_connections(dir: &Path) -> Vec<String> {
    fs::read_dir(dir)
        .unwrap()
        .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
        .filter(|n| n.starts_with("connections.json.corrupt-"))
        .collect()
}

#[test]
fn entries_exist_only_for_remote_rows() {
    let dir = tempfile::tempdir().unwrap();
    let bundled = row(Kind::Bundled, "http://127.0.0.1:18700");
    let local = row(Kind::Local, "http://localhost:18701");
    seed(dir.path(), &[bundled.clone(), local.clone()]);
    let store = TransportStore::open(dir.path());
    for id in [bundled.id, local.id] {
        assert_eq!(
            store.set(id, TransportEntry::new(Transport::Direct)),
            Err(TransportStoreError::NotRemote)
        );
    }
    // An id that is not in connections.json at all is refused too.
    assert_eq!(
        store.set(Uuid::now_v7(), TransportEntry::new(Transport::Direct)),
        Err(TransportStoreError::NotRemote)
    );
    assert!(!dir.path().join(SIDECAR).exists());
}

#[test]
fn gc_drops_ids_not_in_connections_json() {
    let dir = tempfile::tempdir().unwrap();
    let a = row(Kind::Remote, "https://harness.corp.example");
    let b = row(Kind::Remote, "https://other.corp.example");
    seed(dir.path(), &[a.clone(), b.clone()]);
    let stale = Uuid::now_v7();
    fs::write(
        dir.path().join(SIDECAR),
        serde_json::to_vec(&serde_json::json!({
            "version": 1,
            "connections": {
                a.id.to_string(): { "transport": "direct" },
                stale.to_string(): { "transport": "tailscale" }
            }
        }))
        .unwrap(),
    )
    .unwrap();
    let store = TransportStore::open(dir.path());
    let live: Vec<Uuid> = Store::open(dir.path())
        .load()
        .unwrap()
        .iter()
        .map(|c| c.id)
        .collect();
    store.gc(&live).unwrap();
    let json = sidecar(dir.path());
    let ids: Vec<&String> = json["connections"].as_object().unwrap().keys().collect();
    assert_eq!(ids, vec![&a.id.to_string()]);
    // Any later write drops entries whose id left connections.json as well.
    fs::write(
        dir.path().join(SIDECAR),
        serde_json::to_vec(&serde_json::json!({
            "version": 1,
            "connections": { stale.to_string(): { "transport": "tailscale" } }
        }))
        .unwrap(),
    )
    .unwrap();
    store
        .set(b.id, TransportEntry::new(Transport::Tailscale))
        .unwrap();
    let json = sidecar(dir.path());
    let ids: Vec<&String> = json["connections"].as_object().unwrap().keys().collect();
    assert_eq!(ids, vec![&b.id.to_string()]);
}

#[cfg(unix)]
#[test]
fn sidecar_is_written_with_mode_0600() {
    use std::os::unix::fs::PermissionsExt;
    let dir = tempfile::tempdir().unwrap();
    let a = row(Kind::Remote, "https://harness.corp.example");
    seed(dir.path(), std::slice::from_ref(&a));
    let store = TransportStore::open(dir.path());
    store
        .set(a.id, TransportEntry::new(Transport::Direct))
        .unwrap();
    let mode = fs::metadata(dir.path().join(SIDECAR))
        .unwrap()
        .permissions()
        .mode();
    assert_eq!(mode & 0o777, 0o600);
}

#[cfg(unix)]
#[test]
fn store_works_with_a_read_only_connections_json() {
    use std::os::unix::fs::PermissionsExt;
    let dir = tempfile::tempdir().unwrap();
    let a = row(Kind::Remote, "https://harness.corp.example");
    seed(dir.path(), std::slice::from_ref(&a));
    let connections = dir.path().join("connections.json");
    fs::set_permissions(&connections, fs::Permissions::from_mode(0o400)).unwrap();
    let store = TransportStore::open(dir.path());
    store
        .set(a.id, TransportEntry::new(Transport::Direct))
        .unwrap();
    store.gc(&[a.id]).unwrap();
    store.remove(a.id).unwrap();
    assert_eq!(
        fs::metadata(&connections).unwrap().permissions().mode() & 0o777,
        0o400
    );
}

#[test]
fn unreadable_connections_json_refuses_writes_and_keeps_it() {
    let dir = tempfile::tempdir().unwrap();
    fs::write(dir.path().join("connections.json"), b"{ broken").unwrap();
    let store = TransportStore::open(dir.path());
    let err = store
        .set(Uuid::now_v7(), TransportEntry::new(Transport::Direct))
        .unwrap_err();
    assert_eq!(err, TransportStoreError::Connections);
    assert_eq!(
        fs::read(dir.path().join("connections.json")).unwrap(),
        b"{ broken"
    );
    assert!(corrupt_connections(dir.path()).is_empty());
    assert!(!dir.path().join(SIDECAR).exists());
}

#[test]
fn stored_origin_failing_the_host_rules_defaults_to_direct() {
    let dir = tempfile::tempdir().unwrap();
    let odd = row(Kind::Remote, "https://nas_box.tail1234.ts.net");
    seed(dir.path(), std::slice::from_ref(&odd));
    let store = TransportStore::open(dir.path());
    assert_eq!(store.effective(&odd).transport, Transport::Direct);
}

#[test]
fn error_codes_are_stable() {
    let cases = [
        (TransportStoreError::ReadOnly, "transport-store-readonly"),
        (TransportStoreError::NotRemote, "transport-store-not-remote"),
        (
            TransportStoreError::Connections,
            "transport-store-connections-unreadable",
        ),
        (TransportStoreError::Io, "transport-store-io"),
        (TransportStoreError::TooLarge, "transport-store-too-large"),
    ];
    for (err, code) in cases {
        assert_eq!(err.code(), code);
        assert!(err.to_string().starts_with("transport store: "), "{err}");
    }
}

#[test]
fn readers_never_move_aside_a_sidecar_a_writer_just_stored() {
    // Readers race a writer over a corrupt sidecar. The corrupt file is moved aside under the write lock only, after
    // a fresh read, so the writer's entry always survives.
    for round in 0..40 {
        let dir = tempfile::tempdir().unwrap();
        let a = row(Kind::Remote, "https://harness.corp.example");
        seed(dir.path(), std::slice::from_ref(&a));
        fs::write(dir.path().join(SIDECAR), b"{ corrupt").unwrap();
        let store = std::sync::Arc::new(TransportStore::open(dir.path()));
        let start = std::sync::Arc::new(std::sync::Barrier::new(5));
        let mut threads = Vec::new();
        for _ in 0..4 {
            let (store, start, a) = (store.clone(), start.clone(), a.clone());
            threads.push(std::thread::spawn(move || {
                start.wait();
                for _ in 0..25 {
                    let _ = store.effective(&a);
                    let _ = store.mode();
                }
            }));
        }
        start.wait();
        store.set(a.id, direct_acked()).unwrap();
        for t in threads {
            t.join().unwrap();
        }
        let got = store
            .get(a.id)
            .unwrap_or_else(|| panic!("round {round}: entry lost"));
        assert!(got.public_ack.is_some(), "round {round}");
        assert_eq!(corrupt_copies(dir.path()).len(), 1, "round {round}");
    }
}
