//! RE-D170: `engine.snapshot.create`, `engine.snapshot.verify` and `engine.tombstones.reapply`
//! over the authenticated Core snapshot grant in the engine process.
// Process fixtures panic on a failed setup or RPC answer so a test cannot pass vacuously.
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

#[allow(
    dead_code,
    reason = "This integration test uses only part of the shared engine process fixture."
)]
mod rpc_process_support;

use plur1bus_engine::store::{OpenMode, RowFilter, Store};
use rpc_process_support::{assert_unauthorized, home, process_test, EngineProcess, RawConnection};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

const INSTANCE: &str = "00000000-0000-4000-8000-000000000170";
/// Private process hook: while `<dir>/hold` exists, a create waits after its first copied file
/// (it writes `<dir>/held`), until the file is removed or the call is cancelled.
const HOLD: &str = "PLUR1BUS_TEST_SNAPSHOT_HOLD";
/// Private process hook: the free bytes the disk-space check sees.
const FREE: &str = "PLUR1BUS_TEST_SNAPSHOT_FREE_BYTES";
const WAIT: Duration = Duration::from_secs(30);

struct Fixture {
    home: tempfile::TempDir,
    hold: PathBuf,
}

impl Fixture {
    fn home(&self) -> &Path {
        self.home.path()
    }
    fn state(&self) -> PathBuf {
        self.home().join("state")
    }
    fn base(&self) -> PathBuf {
        self.state().join("lancedb")
    }
    fn staging_root(&self) -> PathBuf {
        self.state().join("backup-staging")
    }
    fn engine_root(&self) -> PathBuf {
        self.state().join("memory/.snapshots")
    }
    fn start(&self) -> EngineProcess {
        EngineProcess::start_with_seam_env(self.home(), "flat-embedder", &[(HOLD, &self.hold)])
    }
    fn hold(&self) {
        fs::write(self.hold.join("hold"), b"").unwrap();
    }
    fn release(&self) {
        let _ = fs::remove_file(self.hold.join("hold"));
    }
    fn wait_for(&self, name: &str) {
        let deadline = Instant::now() + WAIT;
        while !self.hold.join(name).exists() {
            assert!(Instant::now() < deadline, "the create never reached {name}");
            std::thread::sleep(Duration::from_millis(5));
        }
    }
    fn audit(&self) -> Vec<Value> {
        fs::read_to_string(self.state().join("engine-maintenance.jsonl"))
            .unwrap_or_default()
            .lines()
            .map(|line| serde_json::from_str(line).unwrap())
            .collect()
    }
}

fn private_dir(path: &Path) {
    fs::create_dir_all(path).unwrap();
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(path, fs::Permissions::from_mode(0o700)).unwrap();
    }
}

fn copy_tree(from: &Path, to: &Path) {
    private_dir(to);
    for entry in fs::read_dir(from).unwrap() {
        let entry = entry.unwrap();
        let target = to.join(entry.file_name());
        if entry.file_type().unwrap().is_dir() {
            copy_tree(&entry.path(), &target);
        } else {
            fs::copy(entry.path(), &target).unwrap();
        }
    }
}

/// The committed store-v1 fixture as agent a1's active table, plus the pin's memory side
/// files and a derived cache that a new snapshot must omit (RE-D41).
fn fixture() -> Fixture {
    let home = home();
    let source = Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/store-v1");
    let base = home.path().join("state/lancedb");
    private_dir(&home.path().join("state"));
    private_dir(&base);
    for name in ["memories.lance", "_embedding_identity.lance"] {
        copy_tree(&source.join(name), &base.join("a1").join(name));
    }
    fs::copy(source.join("_schema.json"), base.join("_schema.json")).unwrap();
    private_dir(&base.join("llm-result-cache-v1"));
    fs::write(base.join("llm-result-cache-v1/cache.db"), b"derived").unwrap();
    fs::write(base.join("llm-result-cache-v1/cache.db-wal"), b"derived").unwrap();
    let memory = home.path().join("state/memory");
    private_dir(&memory.join("_archive/a1"));
    fs::write(
        memory.join("_archive/a1/2026-01.jsonl"),
        b"{\"id\":\"archived\"}\n",
    )
    .unwrap();
    fs::write(memory.join("run-state.json"), b"{\"runs\":1}\n").unwrap();
    let hold = home.path().join("hook");
    private_dir(&hold);
    Fixture { home, hold }
}

fn publish_core(home: &Path, pid: u32) {
    let pid_file = home.join("run/core.pid");
    fs::write(&pid_file, format!("{pid} {INSTANCE}\n")).unwrap();
    plur1bus_engine::store::paths::secure_file(&pid_file).unwrap();
}

fn connect(engine: &EngineProcess) -> RawConnection {
    let mut peer = RawConnection::connect(engine.address());
    peer.set_read_timeout(WAIT);
    let hello = peer.call(
        1,
        "engine.auth",
        json!({"token":engine.token(),"clientId":"core-fixture"}),
    );
    assert_eq!(hello["result"]["pid"], engine.pid());
    peer
}

/// The answer to `id`, skipping engine notifications on the same socket.
fn reply(peer: &mut RawConnection, id: u64) -> Value {
    loop {
        let response = peer.response().unwrap().expect("RPC response before EOF");
        if response.get("id") == Some(&json!(id)) {
            return response;
        }
        assert!(response.get("method").is_some(), "{response}");
    }
}

fn send(peer: &mut RawConnection, id: u64, method: &str, params: Value) {
    let mut request = json!({"jsonrpc":"2.0","id":id,"method":method});
    request["params"] = params;
    peer.send(request);
}

fn call(peer: &mut RawConnection, id: u64, method: &str, params: Value) -> Value {
    send(peer, id, method, params);
    reply(peer, id)
}

fn ok(mut response: Value) -> Value {
    assert!(response.get("error").is_none(), "{response}");
    response["result"].take()
}

fn reason(response: &Value) -> &str {
    assert!(response.get("result").is_none(), "{response}");
    response["error"]["data"]["reason"].as_str().unwrap()
}

fn create(peer: &mut RawConnection, id: u64, out: &Path) -> Value {
    call(peer, id, "engine.snapshot.create", json!({"out":out}))
}

fn verify(peer: &mut RawConnection, id: u64, dir: &Path) -> Value {
    call(peer, id, "engine.snapshot.verify", json!({"dir":dir}))
}

fn entries(dir: &Path) -> Vec<String> {
    let mut names: Vec<String> = match fs::read_dir(dir) {
        Ok(entries) => entries
            .map(|entry| entry.unwrap().file_name().into_string().unwrap())
            .collect(),
        Err(_) => Vec::new(),
    };
    names.sort();
    names
}

fn tree(root: &Path) -> BTreeMap<String, (u64, String)> {
    fn walk(root: &Path, dir: &Path, out: &mut BTreeMap<String, (u64, String)>) {
        for entry in fs::read_dir(dir).unwrap() {
            let entry = entry.unwrap();
            let path = entry.path();
            if entry.file_type().unwrap().is_dir() {
                walk(root, &path, out);
            } else {
                let bytes = fs::read(&path).unwrap();
                let relative = path.strip_prefix(root).unwrap();
                let relative = relative
                    .components()
                    .map(|c| c.as_os_str().to_str().unwrap())
                    .collect::<Vec<_>>()
                    .join("/");
                out.insert(
                    relative,
                    (bytes.len() as u64, format!("{:x}", Sha256::digest(&bytes))),
                );
            }
        }
    }
    let mut out = BTreeMap::new();
    walk(root, root, &mut out);
    out
}

#[test]
fn snapshot_methods_require_the_live_core_peer_and_create_nothing_without_it() {
    let _serial = process_test();
    let fixture = fixture();
    let mut engine = fixture.start();
    let mut peer = connect(&engine);
    let staging = fixture.staging_root();
    let attempts = |peer: &mut RawConnection, first: u64| {
        [
            create(peer, first, &staging),
            verify(
                peer,
                first + 1,
                &staging.join("plur1bus-20260101T000000Z-snapshot"),
            ),
            call(peer, first + 2, "engine.tombstones.reapply", json!({})),
        ]
    };
    for response in attempts(&mut peer, 2) {
        assert_unauthorized(&response);
        assert_eq!(response["error"]["data"]["reason"], "core-link-required");
    }
    // A published record of another process (here: the engine itself) is not this socket's peer.
    publish_core(fixture.home(), engine.pid());
    for response in attempts(&mut peer, 5) {
        assert_unauthorized(&response);
    }
    assert!(!staging.exists());
    assert!(!fixture.engine_root().exists());
    assert!(fixture.audit().is_empty());
    // With the actual peer the same socket is served.
    publish_core(fixture.home(), std::process::id());
    let created = ok(create(&mut peer, 8, &staging));
    assert!(Path::new(created["dir"].as_str().unwrap()).is_dir());
    fs::remove_file(fixture.home().join("run/core.pid")).unwrap();
    assert_unauthorized(&create(&mut peer, 9, &staging));
    drop(peer);
    engine.close_stdin();
    assert!(engine.wait_for_exit().success());
}

#[test]
fn create_publishes_a_pin_shaped_manifest_that_verify_and_the_audit_agree_with() {
    let _serial = process_test();
    let fixture = fixture();
    let mut engine = fixture.start();
    publish_core(fixture.home(), std::process::id());
    let mut peer = connect(&engine);
    for (id, root) in [(2, fixture.staging_root()), (10, fixture.engine_root())] {
        let created = ok(create(&mut peer, id, &root));
        let name = created["id"].as_str().unwrap().to_owned();
        let dir = root.join(&name);
        assert_eq!(created["dir"], json!(dir));
        let (prefix, suffix) = name.split_at("plur1bus-".len());
        assert_eq!(prefix, "plur1bus-");
        assert_eq!(&suffix[15..], "Z-snapshot", "{name}");
        assert!(suffix[..8].bytes().all(|b| b.is_ascii_digit()) && &suffix[8..9] == "T");
        assert_eq!(created["pruned"], json!([]));
        assert_eq!(created["warnings"], json!([]));
        // No staging residue next to the published snapshot.
        assert_eq!(entries(&root), vec![name.clone()]);

        let raw = fs::read_to_string(dir.join("snapshot.json")).unwrap();
        assert!(raw.ends_with("}\n") && raw.starts_with("{\n  \"schema\""));
        let manifest: Value = serde_json::from_str(&raw).unwrap();
        let keys: Vec<_> = manifest.as_object().unwrap().keys().cloned().collect();
        let mut sorted_keys = vec![
            "schema",
            "id",
            "createdAt",
            "label",
            "pluginVersion",
            "baseDbPath",
            "contents",
            "bytes",
            "fileCount",
            "files",
        ];
        // serde_json orders object keys; the raw text proves the pin's key order.
        let mut positions: Vec<usize> = sorted_keys
            .iter()
            .map(|key| raw.find(&format!("\"{key}\":")).unwrap())
            .collect();
        let order = positions.clone();
        positions.sort_unstable();
        assert_eq!(order, positions, "manifest key order differs from the pin");
        sorted_keys.sort_unstable();
        let mut actual_keys: Vec<&str> = keys.iter().map(String::as_str).collect();
        actual_keys.sort_unstable();
        assert_eq!(actual_keys, sorted_keys);
        assert_eq!(manifest["schema"], "plur1bus.snapshot/1");
        assert_eq!(manifest["id"], json!(name));
        assert_eq!(manifest["label"], Value::Null);
        assert_eq!(manifest["pluginVersion"], Value::Null);
        assert_eq!(manifest["baseDbPath"], json!(fixture.base()));
        assert!(manifest["createdAt"].as_str().unwrap().ends_with('Z'));
        assert_eq!(
            manifest["contents"],
            json!(["store", "memory/_archive", "memory/run-state.json"])
        );
        let actual = tree(&dir);
        let files = manifest["files"].as_array().unwrap();
        assert_eq!(manifest["fileCount"], json!(files.len()));
        assert_eq!(created["files"], json!(files.len()));
        assert_eq!(
            actual.len(),
            files.len() + 1,
            "only snapshot.json is unlisted"
        );
        let mut total = 0;
        let mut previous: Option<Vec<u16>> = None;
        for file in files {
            let path = file["path"].as_str().unwrap();
            let key: Vec<u16> = path.encode_utf16().collect();
            assert!(
                previous.as_ref().is_none_or(|p| *p < key),
                "files are sorted"
            );
            previous = Some(key);
            let (bytes, hash) = &actual[path];
            assert_eq!(file["bytes"], json!(bytes));
            assert_eq!(file["sha256"], json!(hash));
            total += bytes;
            assert!(!path.starts_with("store/llm-result-cache-v1"), "{path}");
        }
        assert_eq!(manifest["bytes"], json!(total));
        assert_eq!(created["bytes"], json!(total));
        assert!(actual.contains_key("memory/_archive/a1/2026-01.jsonl"));
        assert!(actual.contains_key("memory/run-state.json"));
        assert!(actual
            .keys()
            .any(|path| path.starts_with("store/a1/memories.lance/_versions/")));
        assert!(!dir.join("store/llm-result-cache-v1").exists());

        let verified = ok(verify(&mut peer, id + 1, &dir));
        assert_eq!(
            verified,
            json!({"id":name,"files":files.len(),"bytes":total})
        );
        // A changed payload is a digest mismatch, as at the pin.
        let archived = dir.join("memory/run-state.json");
        fs::write(&archived, b"{\"runs\":2}\n").unwrap();
        assert_eq!(reason(&verify(&mut peer, id + 2, &dir)), "digest-mismatch");
        fs::write(&archived, b"{\"runs\":1}\n").unwrap();
        assert_eq!(
            reason(&verify(
                &mut peer,
                id + 3,
                &root.join("plur1bus-20260101T000000Z-absent")
            )),
            "not-found"
        );
    }
    let audit = fixture.audit();
    assert_eq!(audit.len(), 2, "verify is read-only and not audited");
    for entry in &audit {
        assert_eq!(entry["kind"], "engine-snapshot");
        assert_eq!(entry["method"], "engine.snapshot.create");
        assert_eq!(entry["actor"], "core-snapshot");
        assert!(entry["coreLink"].as_str().unwrap().starts_with(INSTANCE));
        assert!(entry["at"].as_f64().is_some());
        let target = entry["target"].as_object().unwrap();
        assert_eq!(target.keys().collect::<Vec<_>>(), vec!["id"]);
        assert!(target["id"].as_str().unwrap().starts_with("plur1bus-"));
        assert!(!entry.to_string().contains(fixture.home().to_str().unwrap()));
    }
    drop(peer);
    engine.close_stdin();
    assert!(engine.wait_for_exit().success());
}

#[cfg(unix)]
#[test]
fn only_the_two_trusted_roots_are_accepted_and_a_refusal_creates_nothing() {
    let _serial = process_test();
    let fixture = fixture();
    let mut engine = fixture.start();
    publish_core(fixture.home(), std::process::id());
    let mut peer = connect(&engine);
    let elsewhere = fixture.home().join("elsewhere");
    private_dir(&elsewhere);
    let staging = fixture.staging_root();
    let dotted = fixture.state().join("memory/../backup-staging");
    let relative = PathBuf::from("state/backup-staging");
    for (id, out) in [
        (2, elsewhere.clone()),
        (3, fixture.state()),
        (4, staging.join("nested")),
        (5, dotted.clone()),
        (6, relative),
        (7, fixture.base()),
    ] {
        assert_eq!(
            reason(&create(&mut peer, id, &out)),
            "unsafe-path",
            "{out:?}"
        );
    }
    assert!(!staging.exists());
    assert!(!fixture.engine_root().exists());
    assert_eq!(entries(&elsewhere), Vec::<String>::new());
    // A symlinked root is refused before anything is created through it.
    std::os::unix::fs::symlink(&elsewhere, &staging).unwrap();
    assert_eq!(reason(&create(&mut peer, 8, &staging)), "unsafe-path");
    assert_eq!(entries(&elsewhere), Vec::<String>::new());
    fs::remove_file(&staging).unwrap();
    // Every refused create is audited without its path.
    let audit = fixture.audit();
    assert_eq!(audit.len(), 7);
    for entry in &audit {
        assert_eq!(entry["target"], json!({"invalid":true}));
        assert!(!entry.to_string().contains("elsewhere"));
    }

    let created = ok(create(&mut peer, 9, &staging));
    let name = created["id"].as_str().unwrap();
    let dir = staging.join(name);
    for (id, dir) in [
        (10, staging.clone()),
        (11, elsewhere.join(name)),
        (12, dir.join("store")),
        (13, staging.join(format!("{name}.tmp-123"))),
        (14, staging.join("not-a-snapshot")),
        (15, staging.join("../backup-staging").join(name)),
    ] {
        if id == 13 {
            fs::create_dir(&dir).unwrap();
        }
        assert_eq!(
            reason(&verify(&mut peer, id, &dir)),
            "unsafe-path",
            "{dir:?}"
        );
    }
    // The verified snapshot is a real child, not a symlink to one.
    let link = staging.join("plur1bus-20260101T000000Z-link");
    std::os::unix::fs::symlink(&dir, &link).unwrap();
    assert_eq!(reason(&verify(&mut peer, 16, &link)), "unsafe-path");
    ok(verify(&mut peer, 17, &dir));
    drop(peer);
    engine.close_stdin();
    assert!(engine.wait_for_exit().success());
}

#[test]
fn prune_keeps_the_newest_five_and_never_touches_foreign_entries() {
    let _serial = process_test();
    let fixture = fixture();
    let mut engine = fixture.start();
    publish_core(fixture.home(), std::process::id());
    let mut peer = connect(&engine);
    let root = fixture.engine_root();
    let mut created = Vec::new();
    for id in 0..5 {
        let result = ok(create(&mut peer, 2 + id, &root));
        assert_eq!(result["pruned"], json!([]));
        created.push(result["id"].as_str().unwrap().to_owned());
    }
    // Foreign entries: a directory without manifest, a legacy tarball, an unrelated name.
    private_dir(&root.join("plur1bus-19990101T000000Z-unfinished"));
    fs::write(root.join("legacy.tar.gz"), b"tar").unwrap();
    private_dir(&root.join("keep-me"));
    let sixth = ok(create(&mut peer, 9, &root));
    assert_eq!(sixth["pruned"], json!([created[0]]));
    let mut expected: Vec<String> = created[1..].to_vec();
    expected.push(sixth["id"].as_str().unwrap().to_owned());
    expected.extend([
        "keep-me".to_owned(),
        "legacy.tar.gz".to_owned(),
        "plur1bus-19990101T000000Z-unfinished".to_owned(),
    ]);
    expected.sort();
    assert_eq!(entries(&root), expected);
    drop(peer);
    engine.close_stdin();
    assert!(engine.wait_for_exit().success());
}

#[test]
fn a_held_create_refuses_a_second_at_once_and_a_revoked_grant_leaves_nothing() {
    let _serial = process_test();
    let fixture = fixture();
    let mut engine = fixture.start();
    publish_core(fixture.home(), std::process::id());
    let root = fixture.staging_root();
    let mut holder = connect(&engine);
    fixture.hold();
    send(
        &mut holder,
        2,
        "engine.snapshot.create",
        json!({"out":root}),
    );
    fixture.wait_for("held");
    let staged = entries(&root);
    assert_eq!(staged.len(), 1, "{staged:?}");
    assert!(staged[0].contains(".tmp-"), "{staged:?}");

    // A second create, on another connection and for the other root, never waits.
    let mut other = connect(&engine);
    let started = Instant::now();
    let busy = create(&mut other, 2, &fixture.engine_root());
    assert_eq!(reason(&busy), "engine-busy");
    assert!(started.elapsed() < Duration::from_secs(5));
    // Verify and reapply are not serialized behind the create.
    assert_eq!(
        reason(&verify(
            &mut other,
            3,
            &root.join("plur1bus-20260101T000000Z-absent")
        )),
        "not-found"
    );
    ok(call(&mut other, 4, "engine.tombstones.reapply", json!({})));

    // Closing the holder's connection revokes its grant; the copy stops and is removed.
    drop(holder);
    fixture.wait_for("cancelled");
    let deadline = Instant::now() + WAIT;
    while !entries(&root).is_empty() {
        assert!(Instant::now() < deadline, "{:?}", entries(&root));
        std::thread::sleep(Duration::from_millis(5));
    }
    fixture.release();
    // The single create slot is free again.
    let created = ok(create(&mut other, 5, &root));
    assert_eq!(
        entries(&root),
        vec![created["id"].as_str().unwrap().to_owned()]
    );
    drop(other);
    engine.close_stdin();
    assert!(engine.wait_for_exit().success());
}

#[test]
fn insufficient_disk_is_refused_before_any_staging_is_created() {
    let _serial = process_test();
    let fixture = fixture();
    let mut engine = EngineProcess::start_with_seam_env(
        fixture.home(),
        "flat-embedder",
        &[(FREE, Path::new("1024"))],
    );
    publish_core(fixture.home(), std::process::id());
    let mut peer = connect(&engine);
    let root = fixture.staging_root();
    assert_eq!(reason(&create(&mut peer, 2, &root)), "insufficient-disk");
    assert_eq!(entries(&root), Vec::<String>::new());
    drop(peer);
    engine.close_stdin();
    assert!(engine.wait_for_exit().success());
}

#[test]
fn sigkill_during_the_copy_never_publishes_and_the_next_create_sweeps_the_staging() {
    let _serial = process_test();
    let fixture = fixture();
    let root = fixture.staging_root();
    let mut engine = fixture.start();
    publish_core(fixture.home(), std::process::id());
    let mut peer = connect(&engine);
    fixture.hold();
    send(&mut peer, 2, "engine.snapshot.create", json!({"out":root}));
    fixture.wait_for("held");
    let killed_pid = engine.pid();
    engine.kill_and_wait();
    drop(peer);
    let staged = entries(&root);
    assert_eq!(staged.len(), 1, "{staged:?}");
    assert!(
        staged[0].ends_with(&format!(".tmp-{killed_pid}")),
        "only the staging directory exists: {staged:?}"
    );
    assert!(!fs::read_dir(root.join(&staged[0]))
        .unwrap()
        .any(|entry| entry.unwrap().file_name() == "snapshot.json"));

    fixture.release();
    fs::remove_file(fixture.hold.join("held")).unwrap();
    let mut engine = fixture.start();
    let mut peer = connect(&engine);
    let created = ok(create(&mut peer, 2, &root));
    let name = created["id"].as_str().unwrap().to_owned();
    assert_eq!(
        entries(&root),
        vec![name.clone()],
        "the dead create's staging was swept"
    );
    ok(verify(&mut peer, 3, &root.join(name)));
    drop(peer);
    engine.close_stdin();
    assert!(engine.wait_for_exit().success());
}

fn registry_line(memory_id: &str, status: &str, tombstone: &str) -> String {
    json!({"schemaVersion":1,"tombstoneId":tombstone,"memoryId":memory_id,
        "canonicalOriginId":memory_id,"agentId":"a1","scope":"agent-private",
        "deletedAt":"2026-01-13T12:00:00.000Z","actor":"principal:a1","actorType":"human",
        "reason":"MemoryOps.forget","sourceOp":"forget","contentFingerprint":"a".repeat(64),
        "status":status})
    .to_string()
}

#[test]
fn reapply_over_the_grant_soft_deletes_the_active_rows_and_is_idempotent() {
    let _serial = process_test();
    let fixture = fixture();
    let table = fixture.base().join("a1");
    let active: Vec<String> = {
        let store = Store::open(&table, OpenMode::ReadOnly, None).unwrap();
        let filter = RowFilter {
            status: Some("active".into()),
            ..RowFilter::default()
        };
        let mut ids: Vec<String> = store
            .scan(&filter, 100)
            .unwrap()
            .into_iter()
            .map(|row| row.id)
            .collect();
        ids.sort();
        ids
    };
    assert!(active.len() >= 3, "{active:?}");
    let registry = fixture.state().join("_tombstones");
    private_dir(&registry);
    let lines = [
        registry_line(
            &active[0],
            "committed",
            "e1000000-0000-4000-8000-000000000001",
        ),
        registry_line(
            &active[1],
            "committed",
            "e1000000-0000-4000-8000-000000000002",
        ),
        registry_line(
            "10000000-0000-4000-8000-00000000dead",
            "committed",
            "e1000000-0000-4000-8000-000000000003",
        ),
        registry_line(&active[2], "failed", "e1000000-0000-4000-8000-000000000004"),
    ];
    let registry_file = registry.join("a1.jsonl");
    fs::write(&registry_file, lines.join("\n") + "\n").unwrap();
    let registry_before = fs::read(&registry_file).unwrap();

    let mut engine = fixture.start();
    publish_core(fixture.home(), std::process::id());
    let mut peer = connect(&engine);
    let first = ok(call(&mut peer, 2, "engine.tombstones.reapply", json!({})));
    let entry = |id: &str| json!({"agent":"a1","memoryId":id});
    assert_eq!(
        first,
        json!({"mode":"apply","applied":[entry(&active[0]),entry(&active[1])],"alreadyTombstoned":[],
            "notFound":[entry("10000000-0000-4000-8000-00000000dead")],"errors":[],"registryErrors":[],
            "activeAfterReapply":[]})
    );
    let second = ok(call(&mut peer, 3, "engine.tombstones.reapply", json!({})));
    assert_eq!(second["applied"], json!([]));
    assert_eq!(
        second["alreadyTombstoned"],
        json!([entry(&active[0]), entry(&active[1])])
    );
    assert_eq!(second["errors"], json!([]));
    // The engine neither rewrites the registry nor reads or writes the CLI's restore marker.
    assert_eq!(fs::read(&registry_file).unwrap(), registry_before);
    assert!(!fixture.state().join(".restore-reapply-tombstones").exists());
    drop(peer);
    engine.close_stdin();
    assert!(engine.wait_for_exit().success());

    let store = Store::open(&table, OpenMode::ReadOnly, None).unwrap();
    for (id, status) in [
        (&active[0], "deleted"),
        (&active[1], "deleted"),
        (&active[2], "active"),
    ] {
        let row = store.get(id).unwrap().unwrap();
        assert_eq!(row.status, status, "{id}");
    }
    assert_eq!(
        store.get(&active[0]).unwrap().unwrap().epistemic_status,
        "invalidated"
    );
    let audit = fixture.audit();
    assert_eq!(audit.len(), 2);
    for entry in audit {
        assert_eq!(entry["kind"], "engine-snapshot");
        assert_eq!(entry["method"], "engine.tombstones.reapply");
        assert_eq!(entry["actor"], "core-snapshot");
        assert_eq!(entry["target"], json!({}));
        assert!(!entry.to_string().contains(&active[0]));
    }
}

fn node(arguments: &[&str]) -> Value {
    let root = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../..");
    let result = std::process::Command::new("node")
        .arg(root.join("crates/plur1bus-engine/tests/node/snapshot-check.mjs"))
        .args(arguments)
        .current_dir(root.join("packages/core"))
        .output()
        .unwrap();
    assert!(
        result.status.success(),
        "Node snapshot check failed: {}",
        String::from_utf8_lossy(&result.stderr)
    );
    serde_json::from_slice(&result.stdout).unwrap()
}

#[test]
fn node_pin_and_rust_verify_each_others_snapshots() {
    let _serial = process_test();
    let fixture = fixture();
    let root = fixture.staging_root();
    // (a) The pin's createSnapshot below the Core's staging root, verified by the engine.
    let node_created = node(&[
        "--create",
        fixture.state().to_str().unwrap(),
        fixture.base().to_str().unwrap(),
        root.to_str().unwrap(),
    ]);
    assert!(node_created.get("reason").is_none(), "{node_created}");
    let node_dir = PathBuf::from(node_created["dir"].as_str().unwrap());
    let mut engine = fixture.start();
    publish_core(fixture.home(), std::process::id());
    let mut peer = connect(&engine);
    let verified = ok(verify(&mut peer, 2, &node_dir));
    assert_eq!(verified["id"], node_created["id"]);
    assert_eq!(verified["files"], node_created["files"]);
    assert_eq!(verified["bytes"], node_created["bytes"]);
    // The pin still copies the derived cache (RE-D41 is a deliberate Rust deviation).
    assert!(node_dir.join("store/llm-result-cache-v1/cache.db").exists());

    // (b) The engine's create, verified by the pin's verifySnapshot.
    let created = ok(create(&mut peer, 3, &root));
    let report = node(&["--verify", created["dir"].as_str().unwrap()]);
    assert_eq!(
        report,
        json!({"id":created["id"],"files":created["files"],"bytes":created["bytes"]})
    );
    // The pin's manifest for the same sources lists the same non-cache payload.
    let manifest = |dir: &Path| -> BTreeMap<String, Value> {
        let manifest: Value =
            serde_json::from_slice(&fs::read(dir.join("snapshot.json")).unwrap()).unwrap();
        manifest["files"]
            .as_array()
            .unwrap()
            .iter()
            .filter(|f| {
                !f["path"]
                    .as_str()
                    .unwrap()
                    .starts_with("store/llm-result-cache-v1/")
            })
            .map(|f| (f["path"].as_str().unwrap().to_owned(), f.clone()))
            .collect()
    };
    assert_eq!(
        manifest(Path::new(created["dir"].as_str().unwrap())),
        manifest(&node_dir)
    );
    // And a tampered engine snapshot is a digest mismatch for the pin too.
    fs::write(
        Path::new(created["dir"].as_str().unwrap()).join("memory/run-state.json"),
        b"tampered",
    )
    .unwrap();
    assert_eq!(
        node(&["--verify", created["dir"].as_str().unwrap()]),
        json!({"reason":"digest-mismatch"})
    );
    drop(peer);
    engine.close_stdin();
    assert!(engine.wait_for_exit().success());
}

/// M8: a create or reapply with missing or invalid parameters from the Core link is refused
/// as invalid and audited as `{"invalid":true}`; verify stays unaudited; a peer that is not
/// the Core link is refused before any audit.
#[test]
fn invalid_create_and_reapply_calls_are_audited_as_invalid() {
    let _serial = process_test();
    let fixture = fixture();
    let mut engine = fixture.start();
    let mut peer = connect(&engine);
    let invalid = |response: &Value| {
        assert_eq!(
            response["error"]["data"]["error"], "E_INVALID_PARAMS",
            "{response}"
        );
        assert_eq!(response["error"]["code"], -32602, "{response}");
    };
    // Not the Core link: refused before the audit, as every snapshot call.
    assert_unauthorized(&call(&mut peer, 2, "engine.snapshot.create", json!({})));
    assert!(fixture.audit().is_empty());
    publish_core(fixture.home(), std::process::id());
    invalid(&call(&mut peer, 3, "engine.snapshot.create", json!({})));
    invalid(&call(
        &mut peer,
        4,
        "engine.snapshot.create",
        json!({"out":5}),
    ));
    invalid(&call(
        &mut peer,
        5,
        "engine.snapshot.create",
        json!({"out":fixture.staging_root(),"label":""}),
    ));
    invalid(&call(
        &mut peer,
        6,
        "engine.tombstones.reapply",
        json!({"apply":false}),
    ));
    invalid(&call(&mut peer, 7, "engine.snapshot.verify", json!({})));
    let audit = fixture.audit();
    let methods: Vec<_> = audit.iter().map(|e| e["method"].clone()).collect();
    assert_eq!(
        methods,
        [
            "engine.snapshot.create",
            "engine.snapshot.create",
            "engine.snapshot.create",
            "engine.tombstones.reapply"
        ]
    );
    for entry in &audit {
        assert_eq!(entry["kind"], "engine-snapshot");
        assert_eq!(entry["actor"], "core-snapshot");
        assert_eq!(entry["target"], json!({"invalid":true}));
        assert!(entry["coreLink"].as_str().unwrap().starts_with(INSTANCE));
    }
    assert!(!fixture.staging_root().exists());
    // The connection stays usable after the refusals.
    ok(call(&mut peer, 8, "engine.tombstones.reapply", json!({})));
    drop(peer);
    engine.close_stdin();
    assert!(engine.wait_for_exit().success());
}
