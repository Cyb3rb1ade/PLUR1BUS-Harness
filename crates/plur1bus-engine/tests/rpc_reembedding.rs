//! RE-D166: re-embedding plan/apply/resume/status/validate over the authenticated Core
//! maintenance grant in the engine process, with the library's single-batch calls.
// Process fixtures panic on a failed setup or RPC answer so a test cannot pass vacuously.
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

#[allow(
    dead_code,
    reason = "This integration test uses only part of the shared engine process fixture."
)]
mod rpc_process_support;

use rpc_process_support::{assert_unauthorized, home, process_test, EngineProcess, RawConnection};
use serde_json::{json, Value};
use std::fs;
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

const INSTANCE: &str = "00000000-0000-4000-8000-000000000166";
/// Private process hook: while `<dir>/hold` exists, the flat target provider waits in its
/// passage batch (it writes `<dir>/held`), until the file is removed or the call is cancelled.
const HOLD: &str = "PLUR1BUS_TEST_REEMBEDDING_HOLD";
const BATCH: u64 = 8;
const WAIT: Duration = Duration::from_secs(20);

struct Fixture {
    home: tempfile::TempDir,
    hold: PathBuf,
}

impl Fixture {
    fn home(&self) -> &Path {
        self.home.path()
    }
    fn start(&self) -> EngineProcess {
        EngineProcess::start_with_seam_env(self.home(), "flat-embedder", &[(HOLD, &self.hold)])
    }
    fn hold(&self) {
        fs::write(self.hold.join("hold"), b"").unwrap();
    }
    fn release(&self) {
        fs::remove_file(self.hold.join("hold")).unwrap();
    }
    fn wait_held(&self) {
        let deadline = Instant::now() + WAIT;
        while !self.hold.join("held").exists() {
            assert!(
                Instant::now() < deadline,
                "the apply never reached its hook"
            );
            std::thread::sleep(Duration::from_millis(5));
        }
    }
    fn generation(&self, migration: &str) -> PathBuf {
        self.home()
            .join("state/lancedb/generations")
            .join(format!("generation-{migration}"))
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

/// The committed store-v1 fixture as agent a1's active table, as the parity lane copies it.
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
    let hold = home.path().join("hook");
    private_dir(&hold);
    Fixture { home, hold }
}

fn publish_core(home: &Path) {
    let pid_file = home.join("run/core.pid");
    fs::write(&pid_file, format!("{} {INSTANCE}\n", std::process::id())).unwrap();
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

fn plan_params(migration: &str) -> Value {
    json!({"request":{"id":migration,"target":{"fingerprint":{
        "provider":"openai","model":"synthetic-target","dimensions":8
    }}}})
}

fn token_params(migration: &str, token: &str) -> Value {
    json!({"request":{"id":migration,"token":token}})
}

fn completed(record: &Value) -> u64 {
    record["cursor"]["completedRows"].as_u64().unwrap()
}

/// Plan and run the first durable batch; returns (token, total source rows).
fn plan_and_first_batch(peer: &mut RawConnection, migration: &str) -> (String, u64) {
    let planned = ok(call(
        peer,
        10,
        "engine.admin.reembedding.plan",
        plan_params(migration),
    ));
    let token = planned["confirmation"]["token"]
        .as_str()
        .unwrap()
        .to_owned();
    let rows: u64 = planned["plan"]["source"]["tables"]
        .as_array()
        .unwrap()
        .iter()
        .map(|table| table["rowCount"].as_u64().unwrap())
        .sum();
    assert!(
        rows > BATCH,
        "the fixture needs at least two batches: {rows}"
    );
    let applied = ok(call(
        peer,
        11,
        "engine.admin.reembedding.apply",
        token_params(migration, &token),
    ));
    assert_eq!(applied["state"], "running", "{applied}");
    assert_eq!(completed(&applied), BATCH, "{applied}");
    (token, rows)
}

/// Explicit resumes, one durable batch each, until the copy reaches validating.
fn resume_to_validating(peer: &mut RawConnection, migration: &str, token: &str, rows: u64) -> u64 {
    let mut calls = 0;
    for id in 100..120 {
        let record = ok(call(
            peer,
            id,
            "engine.admin.reembedding.resume",
            token_params(migration, token),
        ));
        calls += 1;
        if record["state"] == "validating" {
            assert_eq!(completed(&record), rows, "{record}");
            return calls;
        }
        assert_eq!(record["state"], "running", "{record}");
    }
    panic!("resume did not reach validating");
}

fn status(peer: &mut RawConnection, id: u64, migration: &str) -> Value {
    ok(call(
        peer,
        id,
        "engine.admin.reembedding.status",
        json!({"id":migration}),
    ))
}

fn validate(peer: &mut RawConnection, id: u64, migration: &str) -> Value {
    call(
        peer,
        id,
        "engine.admin.reembedding.validate",
        json!({"request":{"id":migration}}),
    )
}

fn assert_copied(fixture: &Fixture, migration: &str) {
    let manifest: Value = serde_json::from_slice(
        &fs::read(fixture.generation(migration).join("generation.json")).unwrap(),
    )
    .unwrap();
    let tables = manifest["tables"].as_object().unwrap();
    assert!(!tables.is_empty());
    for (table, declaration) in tables {
        assert_eq!(
            declaration["writtenRows"], declaration["sourceRows"],
            "{table}: {manifest}"
        );
    }
    assert_eq!(manifest["dimensions"], 8);
}

#[test]
fn reembedding_is_served_only_over_the_core_grant_and_every_call_is_audited() {
    let _serial = process_test();
    let fixture = fixture();
    let mut engine = fixture.start();
    let audit = fixture.home().join("state/engine-maintenance.jsonl");
    let mut peer = connect(&engine);
    let migration = "rx-served";

    // No live Core peer: refused before any work, nothing audited or planned.
    let refused = call(
        &mut peer,
        2,
        "engine.admin.reembedding.plan",
        plan_params(migration),
    );
    assert_unauthorized(&refused);
    assert_eq!(refused["error"]["data"]["reason"], "core-link-required");
    assert!(!audit.exists());
    assert!(!fixture.home().join("state/lancedb/generations").exists());

    publish_core(fixture.home());
    let planned = ok(call(
        &mut peer,
        3,
        "engine.admin.reembedding.plan",
        plan_params(migration),
    ));
    let token = planned["confirmation"]["token"]
        .as_str()
        .unwrap()
        .to_owned();
    assert!(token.starts_with("reemb_v1_"));
    assert_eq!(planned["planDigest"], planned["record"]["planDigest"]);
    assert_eq!(planned["record"]["state"], "planned");
    assert_eq!(planned["plan"]["target"]["probeStatus"], "passed");
    assert_eq!(
        planned["confirmation"]["persisted"],
        planned["record"]["confirmation"]
    );
    // The durable record and its status carry only the proof hash.
    assert!(!planned["record"].to_string().contains(&token));
    let rows: u64 = planned["plan"]["source"]["tables"]
        .as_array()
        .unwrap()
        .iter()
        .map(|table| table["rowCount"].as_u64().unwrap())
        .sum();
    assert!(rows > BATCH);
    let planned_status = status(&mut peer, 4, migration);
    assert_eq!(planned_status["state"], "planned");
    assert!(!planned_status.to_string().contains(&token));
    assert_eq!(status(&mut peer, 5, "missing"), Value::Null);

    // The library's confirmation check: a different proof is refused and changes nothing.
    let mut wrong = token.clone();
    let last = wrong.pop().unwrap();
    wrong.push(if last == 'A' { 'B' } else { 'A' });
    let refused_apply = call(
        &mut peer,
        6,
        "engine.admin.reembedding.apply",
        token_params(migration, &wrong),
    );
    assert_eq!(reason(&refused_apply), "invalid-input");
    assert_eq!(status(&mut peer, 7, migration)["state"], "planned");
    // Validation needs a complete copy.
    assert_eq!(reason(&validate(&mut peer, 8, migration)), "invalid-input");

    let applied = ok(call(
        &mut peer,
        11,
        "engine.admin.reembedding.apply",
        token_params(migration, &token),
    ));
    assert_eq!(applied["state"], "running");
    assert_eq!(completed(&applied), BATCH);
    let resumes = resume_to_validating(&mut peer, migration, &token, rows);
    let validated = ok(validate(&mut peer, 12, migration));
    assert_eq!(validated["state"], "ready_to_switch", "{validated}");
    assert_eq!(validated["receipts"]["validation"]["semanticRecall"], true);
    assert_copied(&fixture, migration);

    // rollback and switch stay fail closed (F7): no engine-owned activation in RX.
    for (id, method) in [
        (13, "engine.admin.reembedding.rollback"),
        (14, "engine.admin.reembedding.switch"),
    ] {
        assert_eq!(
            reason(&call(&mut peer, id, method, json!({}))),
            "operation-unavailable"
        );
    }
    assert_eq!(status(&mut peer, 15, migration)["state"], "ready_to_switch");

    let entries: Vec<Value> = fs::read_to_string(&audit)
        .unwrap()
        .lines()
        .map(|line| serde_json::from_str(line).unwrap())
        .collect();
    let text = fs::read_to_string(&audit).unwrap();
    assert!(!text.contains(&token) && !text.contains(&wrong));
    // plan, four status, refused apply, refused validate, apply, resumes, validate, status.
    assert_eq!(entries.len() as u64, 9 + resumes, "{text}");
    let methods: Vec<&str> = entries
        .iter()
        .map(|entry| entry["method"].as_str().unwrap())
        .collect();
    assert_eq!(methods[0], "engine.admin.reembedding.plan");
    assert_eq!(methods[3], "engine.admin.reembedding.apply");
    assert_eq!(methods[5], "engine.admin.reembedding.validate");
    assert_eq!(
        methods
            .iter()
            .filter(|m| **m == "engine.admin.reembedding.resume")
            .count() as u64,
        resumes
    );
    for entry in &entries {
        assert_eq!(entry["kind"], "engine-maintenance");
        assert_eq!(entry["actor"], "core-maintenance");
        assert!(entry["coreLink"].as_str().unwrap().starts_with(INSTANCE));
        assert!(
            entry["target"] == json!({"id":migration})
                || entry["target"] == json!({"id":"missing"}),
            "{entry}"
        );
        assert!(entry.get("principal").is_none());
    }
    drop(peer);
    engine.close_stdin();
    assert!(engine.wait_for_exit().success(), "{}", engine.diagnostics());
}

#[test]
fn a_held_apply_refuses_a_second_and_leaves_status_and_recall_running() {
    let _serial = process_test();
    let fixture = fixture();
    let mut engine = fixture.start();
    publish_core(fixture.home());
    let mut peer = connect(&engine);
    let migration = "rx-held";
    let (token, _) = plan_and_first_batch(&mut peer, migration);

    fixture.hold();
    send(
        &mut peer,
        20,
        "engine.admin.reembedding.resume",
        token_params(migration, &token),
    );
    fixture.wait_held();

    // At most one apply/resume per engine: the library's typed busy refusal.
    let mut other = connect(&engine);
    for (id, method) in [
        (2, "engine.admin.reembedding.resume"),
        (3, "engine.admin.reembedding.apply"),
    ] {
        let busy = call(&mut other, id, method, token_params(migration, &token));
        assert_eq!(reason(&busy), "lock-busy", "{busy}");
    }
    // Status reads the record while the batch runs.
    let running = status(&mut other, 4, migration);
    assert_eq!(running["state"], "running");
    assert_eq!(completed(&running), BATCH);

    // Recall of an agent runs against the active generation meanwhile. (Capture needs the
    // Core's workspace callbacks; the in-process test covers it: rpc/maintenance_tests.rs.)
    let mut data = connect(&engine);
    ok(call(&mut data, 2, "engine.open", json!({"agentId":"a1"})));
    let principal = json!({"agentId":"a1","workspace":format!("workspace:v1:{}", "b".repeat(64)),
        "channel":"telegram","accountId":"fixture","chat":{"id":"rx-held","kind":"direct"},"trust":"inferred"});
    let recalled = ok(call(
        &mut data,
        3,
        "engine.recall",
        json!({"query":{"query":"archive test project labels","principal":principal,
            "agent":{"origin":"user","background":false}}}),
    ));
    assert!(recalled["blocks"].is_array(), "{recalled}");

    fixture.release();
    let resumed = ok(reply(&mut peer, 20));
    assert!(
        resumed["state"] == "running" || resumed["state"] == "validating",
        "{resumed}"
    );
    assert!(completed(&resumed) > BATCH, "{resumed}");
    drop((peer, other, data));
    engine.close_stdin();
    assert!(engine.wait_for_exit().success(), "{}", engine.diagnostics());
}

#[test]
fn close_cancels_a_held_apply_within_its_budget_and_resume_continues_after_restart() {
    let _serial = process_test();
    let fixture = fixture();
    let mut engine = fixture.start();
    publish_core(fixture.home());
    let mut peer = connect(&engine);
    let migration = "rx-close";
    let (token, rows) = plan_and_first_batch(&mut peer, migration);

    fixture.hold();
    send(
        &mut peer,
        20,
        "engine.admin.reembedding.resume",
        token_params(migration, &token),
    );
    fixture.wait_held();
    let mut control = connect(&engine);
    let started = Instant::now();
    send(&mut control, 2, "engine.shutdown", json!({"budgetMs":2000}));
    assert!(engine.wait_for_exit().success(), "{}", engine.diagnostics());
    assert!(
        started.elapsed() < Duration::from_secs(5),
        "{:?}",
        started.elapsed()
    );
    // The held call ends without a result: cancelled or cut off with its connection.
    if let Ok(Some(response)) = peer.response() {
        assert!(response.get("result").is_none(), "{response}");
    }
    drop((peer, control));

    fixture.release();
    let mut engine = fixture.start();
    let mut peer = connect(&engine);
    // No step ran after close: the durable cursor is the first batch's.
    let record = status(&mut peer, 2, migration);
    assert_eq!(record["state"], "running", "{record}");
    assert_eq!(completed(&record), BATCH);
    resume_to_validating(&mut peer, migration, &token, rows);
    assert_eq!(
        ok(validate(&mut peer, 3, migration))["state"],
        "ready_to_switch"
    );
    assert_copied(&fixture, migration);
    drop(peer);
    engine.close_stdin();
    assert!(engine.wait_for_exit().success(), "{}", engine.diagnostics());
}

#[test]
fn sigkill_inside_an_apply_batch_resumes_to_a_consistent_validated_generation() {
    let _serial = process_test();
    let fixture = fixture();
    let mut engine = fixture.start();
    publish_core(fixture.home());
    let mut peer = connect(&engine);
    let migration = "rx-kill";
    let (token, rows) = plan_and_first_batch(&mut peer, migration);

    fixture.hold();
    send(
        &mut peer,
        20,
        "engine.admin.reembedding.resume",
        token_params(migration, &token),
    );
    fixture.wait_held();
    engine.kill_and_wait();
    drop(peer);

    fixture.release();
    let mut engine = fixture.start();
    let mut peer = connect(&engine);
    let record = status(&mut peer, 2, migration);
    assert_eq!(record["state"], "running", "{record}");
    assert_eq!(completed(&record), BATCH);
    resume_to_validating(&mut peer, migration, &token, rows);
    let validated = ok(validate(&mut peer, 3, migration));
    assert_eq!(validated["state"], "ready_to_switch");
    assert_eq!(completed(&validated), rows);
    assert_copied(&fixture, migration);
    drop(peer);
    engine.close_stdin();
    assert!(engine.wait_for_exit().success(), "{}", engine.diagnostics());
}
