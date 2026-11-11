//! RE-D166 in one process: re-embedding beside the composed engine over the same store base.
#![allow(clippy::unwrap_used, reason = "isolated fixture errors are fatal")]

use super::*;
use crate::{
    contract::{testing::FakeHost, *},
    rpc::{engine::ProcessEngine, methods},
};
use serde_json::json;
use std::{
    fs,
    path::Path,
    time::{Duration, Instant},
};

fn host(root: &Path) -> Arc<FakeHost> {
    let config = json!({
        "baseDbPath":root.join("db"),
        "neo":{"enabled":false},
        "namespaces":{"activeWriteNamespace":"current"},
        "duplicateThreshold":1.01
    });
    let host = Arc::new(FakeHost::new(
        root.join("state"),
        serde_json::from_value(config).unwrap(),
    ));
    host.set_now_ms(1_768_305_600_000);
    let workspace = root.join("workspace-agent");
    fs::create_dir_all(&workspace).unwrap();
    host.set_workspace(&"agent".parse().unwrap(), workspace);
    host
}

fn principal() -> Value {
    json!({"agentId":"agent","workspace":"workspace:v1:fixture","channel":"cli",
        "accountId":"fixture","chat":{"id":"fixture","kind":"direct"},"trust":"inferred"})
}

fn capture(engine: &ProcessEngine, run: &str, text: &str) -> Value {
    let turn: TurnRecord =
        serde_json::from_value(json!({"agentId":"agent","principal":principal(),
        "agent":{"origin":"user","background":false},"sessionKey":"agent:agent:main",
        "runId":run,"incognito":false,"messages":[{"role":"user","content":text},
        {"role":"assistant","content":"I recorded that."}]}))
        .unwrap();
    let handle = engine
        .capture(turn, serde_json::from_value(json!({})).unwrap())
        .unwrap();
    serde_json::to_value(handle.done.recv_timeout(Duration::from_secs(60)).unwrap()).unwrap()
}

fn plan_request() -> Value {
    json!({"id":"held","target":{"fingerprint":{
        "provider":"openai","model":"synthetic-target","dimensions":8
    }}})
}

fn code(error: &EngineError) -> Option<MemoryOpErrorCode> {
    match error {
        EngineError::MemoryOp(error) => Some(error.code),
        _ => None,
    }
}

#[test]
fn capture_and_recall_run_during_a_held_apply_and_the_library_refuses_the_changed_source() {
    let scratch = tempfile::tempdir_in(fs::canonicalize(std::env::temp_dir()).unwrap()).unwrap();
    let root = scratch.path();
    let host = host(root);
    let engine = ProcessEngine::new(host.clone(), Some(Seam::FlatEmbedder)).unwrap();
    for (run, text) in [
        (
            "source-1",
            "Please remember that the archive project uses green labels.",
        ),
        (
            "source-2",
            "Please remember that the release train leaves on Thursdays.",
        ),
    ] {
        assert!(capture(&engine, run, text)["stored"].as_u64().unwrap() >= 1);
    }
    let hold = root.join("hook");
    fs::create_dir_all(&hold).unwrap();
    let maintenance = Arc::new(ProcessMaintenance::compose(
        host.clone(),
        Some(Seam::FlatEmbedder),
        Some(hold.clone()),
    ));
    let grant = MaintenanceGrant::for_test(Cancel::never());
    let cancel = Cancel::never();
    let planned = maintenance.plan(&grant, plan_request(), &cancel).unwrap();
    // The named writer namespace is the inventoried source; the target lies beside it.
    let tables = planned["plan"]["source"]["tables"].as_array().unwrap();
    assert_eq!(tables.len(), 1, "{planned}");
    assert_eq!(tables[0]["tableId"], "agent/memories");
    let token = planned["confirmation"]["token"]
        .as_str()
        .unwrap()
        .to_owned();

    fs::write(hold.join("hold"), b"").unwrap();
    let worker = {
        let maintenance = maintenance.clone();
        let token = token.clone();
        std::thread::spawn(move || {
            let grant = MaintenanceGrant::for_test(Cancel::never());
            maintenance.apply(&grant, json!({"id":"held","token":token}), &Cancel::never())
        })
    };
    let deadline = Instant::now() + Duration::from_secs(60);
    while !hold.join("held").exists() {
        assert!(
            Instant::now() < deadline,
            "the apply never reached its hook"
        );
        std::thread::sleep(Duration::from_millis(5));
    }

    // One apply/resume per engine: the coordinator's busy refusal, typed on the wire.
    let busy = maintenance
        .resume(&grant, json!({"id":"held","token":token}), &cancel)
        .unwrap_err();
    assert_eq!(code(&busy), Some(MemoryOpErrorCode::LockBusy), "{busy:?}");
    assert_eq!(
        maintenance.status(&grant, "held", &cancel).unwrap()["state"],
        "running"
    );
    // Capture and recall work against the active generation while the batch is held.
    let during = capture(&engine, "during", "Please remember the blue deploy window.");
    assert!(during["stored"].as_u64().unwrap() >= 1, "{during}");
    let recalled = methods::dispatch(
        &engine,
        "engine.recall",
        &json!({"query":{"query":"deploy window","principal":principal(),
            "agent":{"origin":"user","background":false}}}),
        &cancel,
    )
    .unwrap();
    assert!(recalled["blocks"].is_array(), "{recalled}");

    fs::remove_file(hold.join("hold")).unwrap();
    let applied = worker.join().unwrap().unwrap();
    // The held batch completes; the capture changed the source, which the library refuses at
    // its next source check: a new plan is needed, nothing reaches the active generation.
    let refused = if applied["state"] == "running" {
        maintenance.resume(&grant, json!({"id":"held","token":token}), &cancel)
    } else {
        assert_eq!(applied["state"], "validating", "{applied}");
        maintenance.validate(&grant, "held", &cancel)
    }
    .unwrap_err();
    // The pin's fixed drift text (R1), which the Core classifies as final source drift.
    assert!(
        matches!(&refused, EngineError::Invalid { field, message }
            if field == "engine.reembedding" && message == "reembedding source version drift"),
        "{refused:?}"
    );
    assert!(root
        .join("db/generations/generation-held/generation.json")
        .exists());
    let audit = fs::read_to_string(root.join("state/engine-maintenance.jsonl")).unwrap();
    assert!(!audit.contains(&token));
    assert!(!audit.contains("deploy window"));
    engine.close(Some(Duration::from_secs(10))).unwrap();
}

#[test]
fn person_bound_reembedding_ports_stay_fail_closed() {
    let scratch = tempfile::tempdir_in(fs::canonicalize(std::env::temp_dir()).unwrap()).unwrap();
    let engine = ProcessEngine::new(host(scratch.path()), Some(Seam::FlatEmbedder)).unwrap();
    let person: Principal = serde_json::from_value(principal()).unwrap();
    let agent: AgentContext =
        serde_json::from_value(json!({"origin":"user","background":false})).unwrap();
    let ops = engine.admin().reembedding();
    for result in [
        ops.plan(&person, &agent),
        ops.apply(&person, &agent),
        ops.resume(&person, &agent),
        ops.validate(&person, &agent),
        ops.status(&person, &agent),
        ops.rollback(&person, &agent),
        ops.switch(&person, &agent),
    ] {
        assert!(
            matches!(result, Err(EngineError::NotAvailable { .. })),
            "{result:?}"
        );
    }
}

#[test]
fn without_a_store_base_reembedding_stays_composition_pending() {
    let scratch = tempfile::tempdir_in(fs::canonicalize(std::env::temp_dir()).unwrap()).unwrap();
    let host = Arc::new(FakeHost::new(
        scratch.path().join("state"),
        serde_json::from_value(json!({})).unwrap(),
    ));
    let maintenance = ProcessMaintenance::new(host);
    let grant = MaintenanceGrant::for_test(Cancel::never());
    let error = maintenance
        .status(&grant, "any", &Cancel::never())
        .unwrap_err();
    assert!(
        matches!(&error, EngineError::NotAvailable { reason } if reason == "composition-pending"),
        "{error:?}"
    );
    assert!(!scratch.path().join("state").exists());
}

#[test]
fn a_revoked_grant_admits_no_method_and_audits_nothing() {
    let scratch = tempfile::tempdir_in(fs::canonicalize(std::env::temp_dir()).unwrap()).unwrap();
    let root = scratch.path();
    let maintenance = ProcessMaintenance::compose(host(root), Some(Seam::FlatEmbedder), None);
    let link = Cancel::never();
    let grant = MaintenanceGrant::for_test(link.clone());
    link.cancel();
    let cancel = Cancel::never();
    let request = json!({"id":"revoked","token":"no-proof"});
    for result in [
        maintenance.plan(&grant, plan_request(), &cancel),
        maintenance.apply(&grant, request.clone(), &cancel),
        maintenance.resume(&grant, request, &cancel),
        maintenance.status(&grant, "revoked", &cancel),
        maintenance.validate(&grant, "revoked", &cancel),
    ] {
        assert!(
            matches!(result, Err(EngineError::Cancelled(_))),
            "{result:?}"
        );
    }
    assert!(!root.join("state/engine-maintenance.jsonl").exists());
    assert!(!root.join("db/control/reembedding-state.json").exists());
}

#[test]
fn an_incomplete_apply_request_is_audited_and_refused_by_the_library() {
    let scratch = tempfile::tempdir_in(fs::canonicalize(std::env::temp_dir()).unwrap()).unwrap();
    let root = scratch.path();
    let maintenance = ProcessMaintenance::compose(host(root), Some(Seam::FlatEmbedder), None);
    let grant = MaintenanceGrant::for_test(Cancel::never());
    let cancel = Cancel::never();
    for request in [json!({}), json!({"id":"incomplete"}), json!({"token":"x"})] {
        assert!(maintenance.apply(&grant, request, &cancel).is_err());
    }
    let audit = fs::read_to_string(root.join("state/engine-maintenance.jsonl")).unwrap();
    let entries: Vec<Value> = audit
        .lines()
        .map(|line| serde_json::from_str(line).unwrap())
        .collect();
    assert_eq!(entries.len(), 3, "{audit}");
    assert_eq!(entries[0]["target"], json!({"invalid":true}));
    assert_eq!(entries[1]["target"], json!({"id":"incomplete"}));
    assert_eq!(entries[2]["target"], json!({"invalid":true}));
    assert!(entries
        .iter()
        .all(|entry| entry["method"] == "engine.admin.reembedding.apply"));
}

#[test]
fn planning_the_active_vector_space_answers_the_pins_unchanged_fingerprint_text() {
    let scratch = tempfile::tempdir_in(fs::canonicalize(std::env::temp_dir()).unwrap()).unwrap();
    let root = scratch.path();
    let host = host(root);
    let engine = ProcessEngine::new(host.clone(), Some(Seam::FlatEmbedder)).unwrap();
    assert!(
        capture(&engine, "source", "Please remember the green labels.")["stored"]
            .as_u64()
            .unwrap()
            >= 1
    );
    let maintenance = ProcessMaintenance::compose(host, Some(Seam::FlatEmbedder), None);
    let grant = MaintenanceGrant::for_test(Cancel::never());
    let cancel = Cancel::never();
    let planned = maintenance.plan(&grant, plan_request(), &cancel).unwrap();
    let source = planned["plan"]["source"]["fingerprint"].clone();
    let same = maintenance
        .plan(
            &grant,
            json!({"id":"same","target":{"fingerprint":source}}),
            &cancel,
        )
        .unwrap_err();
    assert!(
        matches!(&same, EngineError::Invalid { field, message }
            if field == "engine.reembedding"
                && message == "reembedding plan does not change the embedding fingerprint"),
        "{same:?}"
    );
    engine.close(Some(Duration::from_secs(10))).unwrap();
}
