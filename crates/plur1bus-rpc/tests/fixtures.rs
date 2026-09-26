//! Every fixture in packages/rpc-schema/fixtures must deserialize into the generated Rust types
//! and serialize back to the same JSON. This is the Rust half of spec criterion 7.
use plur1bus_rpc::types::{self, ErrorCode};
use serde::{de::DeserializeOwned, Serialize};
use serde_json::Value;
use std::collections::BTreeSet;
use std::{fs, path::PathBuf};

fn fixtures() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../packages/rpc-schema/fixtures")
}
/// Every `*.json` file in a fixture directory as (stem, parsed value), sorted by stem.
fn load_dir(dir: &str) -> Vec<(String, Value)> {
    let mut out: Vec<(String, Value)> = fs::read_dir(fixtures().join(dir))
        .unwrap()
        .map(|e| e.unwrap().path())
        .filter(|p| p.extension().is_some_and(|x| x == "json"))
        .map(|p| {
            let stem = p.file_stem().unwrap().to_string_lossy().to_string();
            let v = serde_json::from_str(&fs::read_to_string(&p).unwrap()).unwrap();
            (stem, v)
        })
        .collect();
    out.sort_by(|a, b| a.0.cmp(&b.0));
    out
}

fn round_trip<T: DeserializeOwned + Serialize>(v: &Value, what: &str) {
    let typed: T = serde_json::from_value(v.clone()).unwrap_or_else(|e| panic!("{what}: {e}"));
    let back = serde_json::to_value(&typed).unwrap();
    assert_eq!(&back, v, "{what}: serialize(deserialize(x)) != x");
}

fn pair<P: DeserializeOwned + Serialize, R: DeserializeOwned + Serialize>(name: &str, f: &Value) {
    round_trip::<P>(&f["params"], &format!("{name} params"));
    round_trip::<R>(&f["result"], &format!("{name} result"));
}

/// Dispatch by fixture file name; a fixture without an arm fails the test.
fn method_fixture(name: &str, f: &Value) {
    use types::*;
    match name {
        "core.auth" => pair::<CoreAuthParams, CoreAuthResult>(name, f),
        "core.status" => pair::<CoreStatusParams, CoreStatusResult>(name, f),
        "core.shutdown" => pair::<CoreShutdownParams, CoreShutdownResult>(name, f),
        "memory.recall" => pair::<MemoryRecallParams, MemoryRecallResult>(name, f),
        "memory.capture" => pair::<MemoryCaptureParams, MemoryCaptureResult>(name, f),
        "memory.checkpoint" => pair::<MemoryCheckpointParams, MemoryCheckpointResult>(name, f),
        "memory.list" => pair::<MemoryListParams, MemoryListResult>(name, f),
        "memory.show" => pair::<MemoryShowParams, MemoryShowResult>(name, f),
        "memory.forget" => pair::<MemoryForgetParams, MemoryForgetResult>(name, f),
        "memory.correct" => pair::<MemoryCorrectParams, MemoryCorrectResult>(name, f),
        "memory.share" => pair::<MemoryShareParams, MemoryShareResult>(name, f),
        "memory.state" => pair::<MemoryStateParams, MemoryStateResult>(name, f),
        "memory.propose" => pair::<MemoryProposeParams, MemoryProposeResult>(name, f),
        "memory.proposals.list" => {
            pair::<MemoryProposalsListParams, MemoryProposalsListResult>(name, f)
        }
        "memory.proposals.accept" => {
            pair::<MemoryProposalsAcceptParams, MemoryProposalsAcceptResult>(name, f)
        }
        "memory.proposals.reject" => {
            pair::<MemoryProposalsRejectParams, MemoryProposalsRejectResult>(name, f)
        }
        "agent.list" => pair::<AgentListParams, AgentListResult>(name, f),
        "agent.open" => pair::<AgentOpenParams, AgentOpenResult>(name, f),
        "agent.close" => pair::<AgentCloseParams, AgentCloseResult>(name, f),
        "agent.status" => pair::<AgentStatusParams, AgentStatusResult>(name, f),
        "jobs.list" => pair::<JobsListParams, JobsListResult>(name, f),
        "jobs.run" => pair::<JobsRunParams, JobsRunResult>(name, f),
        "jobs.history" => pair::<JobsHistoryParams, JobsHistoryResult>(name, f),
        "events.subscribe" => pair::<EventsSubscribeParams, EventsSubscribeResult>(name, f),
        "events.unsubscribe" => pair::<EventsUnsubscribeParams, EventsUnsubscribeResult>(name, f),
        other => panic!("fixtures/methods/{other}.json has no Rust type mapping in this test"),
    }
}

/// Every ErrorCode variant. The exhaustive match makes a new schema code a compile error here.
fn all_error_codes() -> BTreeSet<ErrorCode> {
    let all = [
        ErrorCode::EUnauthorized,
        ErrorCode::ERpcVersion,
        ErrorCode::ENotAvailable,
        ErrorCode::ECoreUnavailable,
        ErrorCode::EInvalidParams,
        ErrorCode::EAgentUnknown,
        ErrorCode::EConfigInvalid,
        ErrorCode::EModuleUnknown,
        ErrorCode::EInternal,
        ErrorCode::ELocked,
        ErrorCode::ENotFound,
        ErrorCode::EDenied,
        ErrorCode::EApprovalRequired,
        ErrorCode::EConflict,
        ErrorCode::EStorage,
    ];
    for c in all {
        match c {
            ErrorCode::EUnauthorized
            | ErrorCode::ERpcVersion
            | ErrorCode::ENotAvailable
            | ErrorCode::ECoreUnavailable
            | ErrorCode::EInvalidParams
            | ErrorCode::EAgentUnknown
            | ErrorCode::EConfigInvalid
            | ErrorCode::EModuleUnknown
            | ErrorCode::EInternal
            | ErrorCode::ELocked
            | ErrorCode::ENotFound
            | ErrorCode::EDenied
            | ErrorCode::EApprovalRequired
            | ErrorCode::EConflict
            | ErrorCode::EStorage => {}
        }
    }
    all.into_iter().collect()
}

#[test]
fn every_method_fixture_round_trips() {
    let files = load_dir("methods");
    assert!(!files.is_empty());
    for (name, f) in &files {
        method_fixture(name, f);
    }
}

#[test]
fn every_error_fixture_round_trips_and_covers_every_error_code() {
    let mut seen = BTreeSet::new();
    for (name, v) in load_dir("errors") {
        round_trip::<types::Response>(&v, &format!("errors/{name} response"));
        round_trip::<types::ErrorObject>(&v["error"], &format!("errors/{name} error object"));
        let resp: types::Response = serde_json::from_value(v.clone()).unwrap();
        let code = resp
            .error
            .expect("error fixture carries an error")
            .data
            .expect("error data")
            .error;
        assert_eq!(
            code.to_string(),
            name,
            "errors/{name}.json carries code {code}"
        );
        seen.insert(code);
    }
    assert_eq!(
        seen,
        all_error_codes(),
        "error fixtures must cover every ErrorCode exactly"
    );
}

#[test]
fn every_notification_fixture_round_trips() {
    let files = load_dir("notifications");
    assert!(!files.is_empty());
    for (name, v) in &files {
        match name.as_str() {
            "engine.event" => round_trip::<types::EngineEventNotification>(v, name),
            "agent.activity" => round_trip::<types::AgentActivityNotification>(v, name),
            "core.state" => round_trip::<types::CoreStateNotification>(v, name),
            "recall.completed" => round_trip::<types::RecallCompletedNotification>(v, name),
            "recall.degraded" => round_trip::<types::RecallDegradedNotification>(v, name),
            "recall.block-clipped" => round_trip::<types::RecallBlockClippedNotification>(v, name),
            "recall.block-dropped" => round_trip::<types::RecallBlockDroppedNotification>(v, name),
            "job.run" => round_trip::<types::JobRunNotification>(v, name),
            "memory.proposal" => round_trip::<types::MemoryProposalNotification>(v, name),
            "dream.completed" => round_trip::<types::DreamCompletedNotification>(v, name),
            "acl.denied" => round_trip::<types::AclDeniedNotification>(v, name),
            "embedding.identity.changed" => {
                round_trip::<types::EmbeddingIdentityChangedNotification>(v, name)
            }
            other => panic!("fixtures/notifications/{other}.json has no Rust type mapping"),
        }
    }
}

#[test]
fn journal_line_type_matches_schema_fixture_shape() {
    let v = serde_json::json!({ "v": 1, "id": "11111111-1111-4111-8111-111111111111", "at": 1, "agentId": "bernd", "sessionKey": "s1",
        "caller": { "channel": "cli", "accountId": "h", "userId": "u" }, "messages": [{ "role": "user", "content": "x" }] });
    round_trip::<types::JournalLine>(&v, "journal line");
}
