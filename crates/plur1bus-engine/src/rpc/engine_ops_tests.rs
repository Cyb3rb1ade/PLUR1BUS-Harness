//! RE-D165: the remaining memory operations over the process RPC surface.
#![allow(clippy::unwrap_used, reason = "isolated fixture errors are fatal")]

use super::*;
use crate::{
    context::{harness_user_principal, RequestContext},
    contract::testing::FakeHost,
    rpc::methods::{self, WireError},
    store::{OpenMode, Store},
};
use std::path::PathBuf;

const LIVE: &str = "11111111-1111-4111-8111-111111111111";
const FOREIGN: &str = "22222222-2222-4222-8222-222222222222";
const SECOND: &str = "33333333-3333-4333-8333-333333333333";

struct Fixture {
    _temp: tempfile::TempDir,
    base: PathBuf,
    workspace: PathBuf,
    host: Arc<FakeHost>,
    engine: ProcessEngine,
}

impl Fixture {
    fn new(extra: Value) -> Self {
        let temp =
            tempfile::tempdir_in(std::fs::canonicalize(std::env::temp_dir()).unwrap()).unwrap();
        let root = temp.path().to_owned();
        let state = root.join("state");
        let base = root.join("db");
        let workspace = root.join("workspace");
        std::fs::create_dir(&workspace).unwrap();
        let config = with(
            json!({"baseDbPath": base, "namespaces": {"activeWriteNamespace":"current"}}),
            extra,
        );
        let host = Arc::new(FakeHost::new(
            state,
            serde_json::from_value(config).unwrap(),
        ));
        for agent in ["agent", "other"] {
            host.set_workspace(&agent.parse().unwrap(), workspace.clone());
        }
        host.set_now_ms(10_000);
        let engine = ProcessEngine::new(host.clone(), Some(Seam::FlatEmbedder)).unwrap();
        Self {
            _temp: temp,
            base,
            workspace,
            host,
            engine,
        }
    }

    fn identity(&self) -> VectorSpaceIdentity {
        self.engine
            .embedding()
            .identities()
            .remove(0)
            .space
            .unwrap()
    }

    fn width(&self) -> usize {
        self.identity().dimension.as_u64().unwrap() as usize
    }

    fn private(&self) -> Store {
        Store::create(
            &self.base.join("current/agent"),
            &self.identity(),
            self.width(),
        )
        .unwrap()
    }

    fn reopen(&self) -> Store {
        Store::open(
            &self.base.join("current/agent"),
            OpenMode::ReadOnly,
            Some(&self.identity()),
        )
        .unwrap()
    }

    fn card(&self, id: &str, agent: &str, text: &str) -> MemoryRow {
        let mut row = adopt_tests::row(vec![1.; self.width()]);
        row.id = id.into();
        row.agent_id = agent.into();
        row.text = text.into();
        row.created_at = 2_000.into();
        row
    }

    /// A caller without a user principal (no Neo partition), as in the parity fixture.
    fn plain(&self, agent: &str) -> Value {
        json!({"p":{"agentId":agent,"workspace":"workspace:v1:fixture","channel":"cli",
            "accountId":"fixture","chat":{"id":"fixture","kind":"direct"},"trust":"inferred"},
            "a":{"origin":"user","background":false}})
    }

    /// A proved user-owned caller bound to the fixture workspace.
    fn user(&self, agent: &str) -> Value {
        let mut request = self.plain(agent);
        let context = RequestContext::build(
            &serde_json::from_value(request["p"].clone()).unwrap(),
            &serde_json::from_value(request["a"].clone()).unwrap(),
            self.host.as_ref(),
        )
        .unwrap();
        request["p"]["workspace"] = json!(context.workspace_key);
        request["p"]["trust"] = json!("proved");
        request["p"]["channel"] = json!("telegram");
        request["p"]["user"] = json!(harness_user_principal("synthetic-owner"));
        request
    }

    fn call(&self, method: &str, request: &Value) -> Result<Value, WireError> {
        methods::dispatch(&self.engine, method, request, &Cancel::never())
    }
}

fn with(mut request: Value, fields: Value) -> Value {
    if let Value::Object(fields) = fields {
        for (key, value) in fields {
            request[key] = value;
        }
    }
    request
}

fn background(mut request: Value) -> Value {
    request["a"]["background"] = json!(true);
    request
}

#[test]
fn process_correct_supersedes_the_owned_card_and_refuses_other_callers() {
    let f = Fixture::new(json!({"neo":{"enabled":false}}));
    f.private()
        .upsert(&[
            f.card(LIVE, "agent", "The meeting is on Monday"),
            f.card(FOREIGN, "other", "Another agent's card"),
        ])
        .unwrap();
    let request = with(
        f.plain("agent"),
        json!({"id":LIVE,"newText":"The meeting is on Tuesday"}),
    );
    assert_eq!(
        f.call("engine.memory.correct", &background(request.clone()))
            .unwrap_err()
            .reason,
        "denied"
    );
    let foreign = with(request.clone(), json!({"id":FOREIGN}));
    assert_eq!(
        f.call("engine.memory.correct", &foreign)
            .unwrap_err()
            .reason,
        "not-found"
    );
    let corrected = f.call("engine.memory.correct", &request).unwrap();
    assert_eq!(corrected["archived"], true);
    let successor = corrected["id"].as_str().unwrap();
    assert_ne!(successor, LIVE);
    let store = f.reopen();
    assert_eq!(store.get(LIVE).unwrap().unwrap().status, "superseded");
    assert_eq!(
        store.get(successor).unwrap().unwrap().text,
        "The meeting is on Tuesday"
    );
    assert_eq!(
        store.get(FOREIGN).unwrap().unwrap().text,
        "Another agent's card"
    );
    assert!(f
        .workspace
        .join(".adaptive-learning/destructive-ops.jsonl")
        .is_file());
    f.engine.close(None).unwrap();
    assert_eq!(
        f.call("engine.memory.correct", &request)
            .unwrap_err()
            .reason,
        "closed"
    );
}

#[test]
fn process_correct_without_a_user_principal_skips_neo_instead_of_failing() {
    // Neo enabled (the default): an owner without a user principal has no Neo partition,
    // so the correction is stored without Neo effects (RE-D155, RE-D165).
    let f = Fixture::new(json!({}));
    f.private()
        .upsert(&[f.card(LIVE, "agent", "The color is blue")])
        .unwrap();
    let request = with(
        f.plain("agent"),
        json!({"id":LIVE,"newText":"The color is green"}),
    );
    let corrected = f.call("engine.memory.correct", &request).unwrap();
    let successor = corrected["id"].as_str().unwrap();
    assert_eq!(
        f.reopen().get(successor).unwrap().unwrap().text,
        "The color is green"
    );
    let neo = f.base.join("_neo");
    assert!(neo.is_dir());
    assert!(!neo.join("workspaces").exists());
}

/// §5 negative vector (RX3 C7): the store guard's category check never blocks `/share` of
/// a card that already carries a category, known or legacy.
#[test]
fn share_with_an_existing_category_stays_allowed() {
    let f = Fixture::new(json!({"neo":{"enabled":false}}));
    let mut known = f.card(LIVE, "agent", "Prefers tea in the afternoon");
    known.category = "preference".into();
    let mut legacy = f.card(SECOND, "agent", "Uses the old deploy script");
    legacy.category = "legacy-kind".into();
    f.private().upsert(&[known, legacy]).unwrap();
    for id in [LIVE, SECOND] {
        let request = with(f.user("agent"), json!({"id":id,"target":"user"}));
        let shared = f.call("engine.memory.share", &request).unwrap();
        assert_eq!(shared["sourceId"], id);
        assert_eq!(shared["target"], "user");
        assert_ne!(shared["sharedId"], id);
    }
}

#[test]
fn process_share_propose_and_proposals_follow_the_sharer_and_refuse_strangers() {
    let f = Fixture::new(json!({"neo":{"enabled":false}}));
    f.private()
        .upsert(&[f.card(LIVE, "agent", "The office opens at nine")])
        .unwrap();
    let sharer = f.user("agent");
    let proposer = f.user("other");
    assert_eq!(
        f.call(
            "engine.memory.share",
            &with(f.plain("agent"), json!({"id":LIVE,"target":"user"}))
        )
        .unwrap_err()
        .reason,
        "denied",
        "a user target needs a proved user principal"
    );
    let shared = f
        .call(
            "engine.memory.share",
            &with(sharer.clone(), json!({"id":LIVE,"target":"user"})),
        )
        .unwrap();
    let shared_id = shared["sharedId"].as_str().unwrap().to_owned();
    let propose = |text: &str| {
        f.call(
            "engine.memory.propose",
            &with(
                proposer.clone(),
                json!({"sharedId":shared_id,"newText":text}),
            ),
        )
    };
    assert_eq!(
        f.call(
            "engine.memory.propose",
            &with(
                sharer.clone(),
                json!({"sharedId":shared_id,"newText":"Opens at ten"})
            )
        )
        .unwrap_err()
        .reason,
        "invalid-input",
        "the sharer corrects directly instead of proposing"
    );
    let first = propose("The office opens at ten").unwrap();
    assert_eq!(first["sharerAgentId"], "agent");
    let listed = f
        .call(
            "engine.memory.proposals.list",
            &with(sharer.clone(), json!({"q":{"status":"pending"}})),
        )
        .unwrap();
    assert_eq!(listed["items"][0]["id"], first["proposalId"]);
    // Another user of the same agent never reaches the proposal.
    let mut stranger = with(sharer.clone(), json!({"proposalId":first["proposalId"]}));
    stranger["p"]["user"] = json!(harness_user_principal("synthetic-stranger"));
    for method in [
        "engine.memory.proposals.reject",
        "engine.memory.proposals.accept",
    ] {
        assert_eq!(f.call(method, &stranger).unwrap_err().reason, "not-found");
    }
    let rejected = f
        .call(
            "engine.memory.proposals.reject",
            &with(sharer.clone(), json!({"proposalId":first["proposalId"]})),
        )
        .unwrap();
    assert_eq!(rejected["status"], "rejected");

    let second = propose("The office opens at eight").unwrap();
    let accepted = f
        .call(
            "engine.memory.proposals.accept",
            &with(sharer.clone(), json!({"proposalId":second["proposalId"]})),
        )
        .unwrap();
    assert_eq!(accepted["proposalId"], second["proposalId"]);
    // The sharer's original is corrected first; its successor is the new source.
    assert_ne!(accepted["sourceId"], LIVE);
    assert_eq!(f.reopen().get(LIVE).unwrap().unwrap().status, "superseded");
    let shown = f
        .call(
            "engine.memory.show",
            &with(proposer.clone(), json!({"id":accepted["id"]})),
        )
        .unwrap();
    assert_eq!(shown["text"], "The office opens at eight");
    f.engine.close(None).unwrap();
    assert_eq!(
        f.call(
            "engine.memory.proposals.list",
            &with(sharer, json!({"q":{}}))
        )
        .unwrap_err()
        .reason,
        "closed"
    );
}

fn import_two(f: &Fixture) -> Value {
    let mut request = f.plain("agent");
    request["a"]["origin"] = json!("system");
    request["req"] = json!({"agentId":"agent","principal":request["p"],"dryRun":false,
        "importRunId":"fixture-run","cards":[
            {"idempotencyKey":"note-1","text":"The release review is on Thursday afternoon.",
             "kind":"decision","provenance":"imported","sourceRef":"fixture:note","createdAt":5_000},
            {"idempotencyKey":"note-2","text":"The backup runs every night at two.",
             "kind":"fact","provenance":"imported","sourceRef":"fixture:note","createdAt":5_000}]});
    let imported = f.call("engine.memory.import", &request).unwrap();
    assert_eq!(imported["created"], 2.0, "{imported}");
    imported
}

#[test]
fn process_unimport_previews_without_neo_and_keeps_modified_cards() {
    let f = Fixture::new(json!({"neo":{"enabled":false}}));
    let imported = import_two(&f);
    let modified = imported["cards"][0]["id"].as_str().unwrap().to_owned();
    let untouched = imported["cards"][1]["id"].as_str().unwrap().to_owned();
    // A later edit of the first card: unimport keeps it (C3 `kept-modified`).
    Store::open(
        &f.base.join("current/agent"),
        OpenMode::ReadWrite,
        Some(&f.identity()),
    )
    .unwrap()
    .patch(
        &modified,
        &crate::store::RowPatch {
            text: Some("Edited after the import.".into()),
            ..Default::default()
        },
    )
    .unwrap();

    let mut request = f.plain("agent");
    request["req"] = json!({"agentId":"agent","importRunId":"fixture-run","dryRun":true});
    assert_eq!(
        f.call("engine.memory.unimport", &request)
            .unwrap_err()
            .reason,
        "denied"
    );
    request["a"]["origin"] = json!("system");
    let preview = f.call("engine.memory.unimport", &request).unwrap();
    assert_eq!(preview["dryRun"], true);
    assert_eq!(preview["selected"], 2.0);
    assert!(!f.base.join("_neo").exists(), "a preview composes no Neo");

    request["req"]["dryRun"] = json!(false);
    let applied = f.call("engine.memory.unimport", &request).unwrap();
    let outcome = |id: &str| {
        applied["cards"]
            .as_array()
            .unwrap()
            .iter()
            .find(|card| card["id"] == id)
            .unwrap()["outcome"]
            .clone()
    };
    assert_eq!(outcome(&modified), "kept-modified");
    assert_eq!(outcome(&untouched), "unimported");
    assert_eq!(applied["derived"]["jobsSinceImport"], json!([]));
    // KNOWN-GAP F14/RE-D129: no Neo partition without a user principal, so the graph cleanup
    // is refused and counted, never claimed as done.
    assert_eq!(applied["derived"]["cleanupErrors"], 1.0);
    assert_eq!(applied["derived"]["graphEdgesRemoved"], 0.0);
    let store = f.reopen();
    assert_eq!(store.get(&untouched).unwrap().unwrap().status, "deleted");
    assert_eq!(
        store.get(&modified).unwrap().unwrap().text,
        "Edited after the import."
    );
    let repeated = f.call("engine.memory.unimport", &request).unwrap();
    assert_eq!(repeated["unimported"], 0.0);
}

/// An unimport waiting for its own agent's import lease holds nothing another owner needs:
/// the engine-wide mutation gate is taken only after the lease (RE-D165).
#[test]
fn an_unimport_waiting_for_its_lease_never_holds_other_owners_writes() {
    let f = Fixture::new(json!({"neo":{"enabled":false}}));
    import_two(&f);
    Store::create(&f.base.join("current/other"), &f.identity(), f.width())
        .unwrap()
        .upsert(&[f.card(FOREIGN, "other", "The other owner's card")])
        .unwrap();
    // The test holds the agent's import lease, as a running import would.
    let held = crate::ops::import_lock::acquire(
        &f.base,
        "agent",
        &Cancel::never(),
        Duration::from_secs(5),
    )
    .unwrap();
    let mut request = f.plain("agent");
    request["a"]["origin"] = json!("system");
    request["req"] = json!({"agentId":"agent","importRunId":"fixture-run","dryRun":false});
    std::thread::scope(|scope| {
        let waiting = scope.spawn(|| {
            let cancel = Cancel::with_deadline(std::time::Instant::now() + Duration::from_secs(60));
            methods::dispatch(&f.engine, "engine.memory.unimport", &request, &cancel)
        });
        // Only an ordering aid: whichever runs first, the forget must not wait for the lease.
        std::thread::sleep(Duration::from_millis(300));
        let (sender, receiver) = mpsc::channel();
        let forget = with(f.plain("other"), json!({"id":FOREIGN}));
        let fixture = &f;
        scope.spawn(move || {
            let _ = sender.send(fixture.call("engine.memory.forget", &forget));
        });
        let forgotten = receiver.recv_timeout(Duration::from_secs(30));
        assert!(
            !waiting.is_finished(),
            "the unimport still waits for its lease"
        );
        assert_eq!(forgotten.unwrap().unwrap()["archived"], true);
        drop(held);
        let applied = waiting.join().unwrap().unwrap();
        assert_eq!(applied["unimported"], 2.0, "{applied}");
    });
}

#[test]
fn process_stats_return_counters_without_query_text_and_per_agent() {
    let f = Fixture::new(json!({"neo":{"enabled":false}}));
    f.private()
        .upsert(&[
            f.card(LIVE, "agent", "The garden gate is green"),
            f.card(FOREIGN, "other", "Another agent's card"),
        ])
        .unwrap();
    let stats = crate::store::recall_stats::RecallStats::new(&f.base).unwrap();
    let secret = "which colour is the garden gate";
    stats
        .record(
            "agent",
            &[LIVE.into(), FOREIGN.into()],
            secret,
            9_000.,
            &Cancel::never(),
        )
        .unwrap();
    let request = with(f.plain("agent"), json!({"ids":[LIVE, FOREIGN, SECOND]}));
    let result = f.call("engine.memory.stats", &request).unwrap();
    assert_eq!(result["agentId"], "agent");
    let items = result["items"].as_array().unwrap();
    assert_eq!(
        items.len(),
        1,
        "hidden and missing cards are omitted: {result}"
    );
    assert_eq!(items[0]["id"], LIVE);
    assert_eq!(items[0]["recalls"], 1.0);
    let wire = result.to_string();
    assert!(!wire.contains(secret) && !wire.contains("garden"));
    let other = f
        .call(
            "engine.memory.stats",
            &with(f.plain("other"), json!({"ids":[FOREIGN]})),
        )
        .unwrap();
    // Isolation per agent: the other agent never sees this agent's counters.
    assert_eq!(other["agentId"], "other");
    assert_eq!(other["items"], json!([]), "{other}");
    let too_many: Vec<String> = (0..501)
        .map(|n| format!("{n:08}-0000-4000-8000-000000000000"))
        .collect();
    assert_eq!(
        f.call(
            "engine.memory.stats",
            &with(f.plain("agent"), json!({"ids":too_many}))
        )
        .unwrap_err()
        .reason,
        "invalid-input"
    );
}

#[test]
fn process_promote_publishes_in_the_foreground_and_starts_no_job() {
    let disabled = Fixture::new(json!({}));
    let request = with(disabled.user("agent"), json!({"req":{"ids":[LIVE]}}));
    let skipped = disabled.call("engine.memory.promote", &request).unwrap();
    assert_eq!(
        skipped["items"][0]["reason"], "disabled",
        "schicht15 is off by default"
    );

    let f = Fixture::new(json!({"schicht15":{"enabled":true}}));
    f.private()
        .upsert(&[f.card(LIVE, "agent", "Deploys need two reviewers")])
        .unwrap();
    let request = with(f.user("agent"), json!({"req":{"ids":[LIVE]}}));
    assert_eq!(
        f.call("engine.memory.promote", &background(request.clone()))
            .unwrap_err()
            .reason,
        "denied"
    );
    let promoted = f.call("engine.memory.promote", &request).unwrap();
    assert_eq!(promoted["agentId"], "agent");
    assert_eq!(promoted["items"][0]["id"], LIVE);
    assert_eq!(promoted["items"][0]["outcome"], "promoted", "{promoted}");
    let knowledge = std::fs::read_to_string(f.workspace.join("memory/KNOWLEDGE.md")).unwrap();
    assert!(knowledge.contains("Deploys need two reviewers"));
    // F13: nothing is planned for `knowledge-update`; no job root or ledger appears.
    assert!(!f.base.join("_jobs").exists());
    let again = f.call("engine.memory.promote", &request).unwrap();
    assert_eq!(again["items"][0]["reason"], "already-promoted");
    // Fail closed: an owner without a user principal has no Neo partition to fence on.
    let plain = with(f.plain("agent"), json!({"req":{"ids":[LIVE]}}));
    assert_eq!(
        f.call("engine.memory.promote", &plain).unwrap_err().reason,
        "invalid-input"
    );
}

#[test]
fn process_curation_reads_the_callers_journal_and_refuses_other_callers() {
    let f = Fixture::new(json!({}));
    let request = with(f.user("agent"), json!({"q":{}}));
    let listed = f.call("engine.memory.curation.list", &request).unwrap();
    assert_eq!(listed["agentId"], "agent");
    assert_eq!(listed["items"], json!([]));
    assert_eq!(listed["truncated"], false);
    assert_eq!(
        f.call("engine.memory.curation.list", &background(request.clone()))
            .unwrap_err()
            .reason,
        "denied"
    );
    let keep = with(f.user("agent"), json!({"id":"candidate-1"}));
    assert_eq!(
        f.call("engine.memory.curation.keep", &keep)
            .unwrap_err()
            .reason,
        "not-found"
    );
    let drop = with(f.user("agent"), json!({"id":"candidate-1","action":"drop"}));
    assert_eq!(
        f.call("engine.memory.curation.resolve", &drop)
            .unwrap_err()
            .reason,
        "not-found"
    );
    // Fail closed: no Neo partition without a user principal.
    let plain = with(f.plain("agent"), json!({"q":{}}));
    assert_eq!(
        f.call("engine.memory.curation.list", &plain)
            .unwrap_err()
            .reason,
        "invalid-input"
    );
    f.engine.close(None).unwrap();
    assert_eq!(
        f.call("engine.memory.curation.list", &request)
            .unwrap_err()
            .reason,
        "closed"
    );
}

#[test]
fn admin_share_and_forget_stay_unavailable_and_unconfigured_ops_stay_pending() {
    let f = Fixture::new(json!({"neo":{"enabled":false}}));
    for method in ["engine.admin.share", "engine.admin.forget"] {
        let request = with(f.user("agent"), json!({"id":LIVE,"target":"user"}));
        assert_eq!(
            f.call(method, &request).unwrap_err().reason,
            "composition-pending"
        );
    }
    let temp = tempfile::tempdir_in(std::fs::canonicalize(std::env::temp_dir()).unwrap()).unwrap();
    let host = Arc::new(FakeHost::new(
        temp.path().join("state"),
        serde_json::from_value(json!({})).unwrap(),
    ));
    let engine = ProcessEngine::new(host, Some(Seam::FlatEmbedder)).unwrap();
    let plain = f.plain("agent");
    for (method, fields) in [
        ("engine.memory.correct", json!({"id":LIVE,"newText":"x"})),
        ("engine.memory.share", json!({"id":LIVE,"target":"user"})),
        (
            "engine.memory.propose",
            json!({"sharedId":LIVE,"newText":"x"}),
        ),
        ("engine.memory.proposals.list", json!({"q":{}})),
        ("engine.memory.stats", json!({})),
        ("engine.memory.promote", json!({"req":{"ids":[LIVE]}})),
        ("engine.memory.curation.list", json!({"q":{}})),
        (
            "engine.memory.unimport",
            json!({"req":{"agentId":"agent","importRunId":"run"}}),
        ),
    ] {
        let request = with(plain.clone(), fields);
        assert_eq!(
            methods::dispatch(&engine, method, &request, &Cancel::never())
                .unwrap_err()
                .reason,
            "composition-pending",
            "{method}"
        );
    }
    assert!(!temp.path().join("state").exists());
}
