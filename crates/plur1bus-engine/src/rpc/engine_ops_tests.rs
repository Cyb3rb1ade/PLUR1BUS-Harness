//! RE-D165: the remaining memory operations over the process RPC surface.
#![allow(clippy::unwrap_used, reason = "isolated fixture errors are fatal")]

use super::*;
use crate::{
    context::{harness_user_principal, RequestContext},
    contract::testing::FakeHost,
    rpc::methods::{self, WireError},
    store::{OpenMode, Store},
};
use std::{path::PathBuf, sync::atomic::AtomicBool};

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
    // No Neo partition: the Neo root is neither opened nor created (RE-D165).
    assert!(!f.base.join("_neo").exists());
}

/// R4: the Neo root is created only for an admitted caller with a Neo partition, and never
/// with Neo switched off.
#[test]
fn the_neo_root_appears_only_for_an_admitted_user_caller_with_neo_enabled() {
    let off = Fixture::new(json!({"neo":{"enabled":false}}));
    off.private()
        .upsert(&[off.card(LIVE, "agent", "The color is blue")])
        .unwrap();
    let request = with(
        off.user("agent"),
        json!({"id":LIVE,"newText":"The color is red"}),
    );
    assert_eq!(
        off.call("engine.memory.correct", &request).unwrap()["archived"],
        true
    );
    assert!(!off.base.join("_neo").exists(), "Neo off: never created");

    let on = Fixture::new(json!({}));
    on.private()
        .upsert(&[on.card(LIVE, "agent", "The color is blue")])
        .unwrap();
    let request = with(
        on.user("agent"),
        json!({"id":LIVE,"newText":"The color is red"}),
    );
    let mut system = request.clone();
    system["a"]["origin"] = json!("system");
    // A system caller may promote, so only correct and curation refuse it here.
    for (refused, promote) in [(background(request.clone()), true), (system, false)] {
        assert_eq!(
            on.call("engine.memory.correct", &refused)
                .unwrap_err()
                .reason,
            "denied"
        );
        if promote {
            let promote = with(refused.clone(), json!({"req":{"ids":[LIVE]}}));
            assert!(on.call("engine.memory.promote", &promote).is_err());
        }
        assert!(on
            .call(
                "engine.memory.curation.list",
                &with(refused, json!({"q":{}}))
            )
            .is_err());
    }
    assert!(
        !on.base.join("_neo").exists(),
        "refused callers create nothing"
    );
    assert_eq!(
        on.call("engine.memory.correct", &request).unwrap()["archived"],
        true
    );
    assert!(on.base.join("_neo").is_dir());
}

/// §5 negative vector (RX3 C7), kept as a regression guard: share never validates the
/// card's category. The C7 store guard (`ops::memory_guards`) applies only to the capture
/// store path (`capture/normal_store.rs`), as at the pin, where share and correct do not
/// call it either; this test would turn red if a future share path did.
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
    let mut stranger_list = with(sharer.clone(), json!({"q":{}}));
    stranger_list["p"]["user"] = json!(harness_user_principal("synthetic-stranger"));
    assert_eq!(
        f.call("engine.memory.proposals.list", &stranger_list)
            .unwrap()["items"],
        json!([])
    );
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
    // Another agent's run, asked for by this caller: refused before anything is read.
    let mut mismatch = request.clone();
    mismatch["req"]["agentId"] = json!("other");
    assert_eq!(
        f.call("engine.memory.unimport", &mismatch)
            .unwrap_err()
            .reason,
        "invalid-input"
    );
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
    // Isolation per agent: the other agent sees a card with the same ID in its own store,
    // so visibility does not hide anything; its counters are its own (zero), never these.
    Store::create(&f.base.join("current/other"), &f.identity(), f.width())
        .unwrap()
        .upsert(&[f.card(LIVE, "other", "The other agent's garden gate")])
        .unwrap();
    let other = f
        .call(
            "engine.memory.stats",
            &with(f.plain("other"), json!({"ids":[LIVE]})),
        )
        .unwrap();
    assert_eq!(other["agentId"], "other");
    assert_eq!(other["items"].as_array().unwrap().len(), 1, "{other}");
    assert_eq!(other["items"][0]["id"], LIVE);
    assert_eq!(other["items"][0]["recalls"], 0.0, "{other}");
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
    // Another owner's card is never published, and its text never reaches the document.
    Store::open(
        &f.base.join("current/agent"),
        OpenMode::ReadWrite,
        Some(&f.identity()),
    )
    .unwrap()
    .upsert(&[f.card(FOREIGN, "other", "Another owner's secret rule")])
    .unwrap();
    let foreign = with(f.user("agent"), json!({"req":{"ids":[FOREIGN]}}));
    let refused = f.call("engine.memory.promote", &foreign).unwrap();
    assert_eq!(refused["items"][0]["outcome"], "skipped", "{refused}");
    assert_eq!(refused["items"][0]["reason"], "not-found");
    assert!(
        !std::fs::read_to_string(f.workspace.join("memory/KNOWLEDGE.md"))
            .unwrap()
            .contains("secret rule")
    );
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

/// The caller's own C4 behavior card, bound to its workspace partition, as capture writes it.
fn seed_behavior(f: &Fixture, request: &Value) {
    let context = RequestContext::build(
        &serde_json::from_value(request["p"].clone()).unwrap(),
        &serde_json::from_value(request["a"].clone()).unwrap(),
        f.host.as_ref(),
    )
    .unwrap();
    let directory = f
        .base
        .join("_neo/workspaces")
        .join(crate::neo::merged::Layout::for_key(&context.workspace_key).canonical);
    std::fs::create_dir_all(&directory).unwrap();
    let record = json!({"id":"beh_revision","workspaceKey":context.workspace_key,
        "agentId":"agent","scope":"agent_private","ownerUserId":context.owner_user_id,
        "status":"conflict","confidence":0.5,"salience":0.4,"embeddingStatus":"pending",
        "createdAt":"2026-11-08T10:00:00.000Z","statement":"Synthetic fixture decision",
        "sourceSignals":["reaction-one"]});
    std::fs::write(
        directory.join("behavior-cards.jsonl"),
        format!("{record}\n"),
    )
    .unwrap();
}

#[test]
fn process_curation_resolves_the_callers_candidate_and_hides_it_from_other_owners() {
    let f = Fixture::new(json!({}));
    f.host.set_now_ms(1_794_139_200_000);
    let owner = with(f.user("agent"), json!({"q":{}}));
    // The first call creates the Neo root for this admitted owner.
    assert_eq!(
        f.call("engine.memory.curation.list", &owner).unwrap()["items"],
        json!([])
    );
    seed_behavior(&f, &owner);
    let listed = f.call("engine.memory.curation.list", &owner).unwrap();
    assert_eq!(listed["items"].as_array().unwrap().len(), 1, "{listed}");
    assert_eq!(listed["items"][0]["id"], "beh_revision");

    let mut stranger = owner.clone();
    stranger["p"]["user"] = json!(harness_user_principal("synthetic-stranger"));
    assert_eq!(
        f.call("engine.memory.curation.list", &stranger).unwrap()["items"],
        json!([])
    );
    assert_eq!(
        f.call(
            "engine.memory.curation.keep",
            &with(stranger, json!({"id":"beh_revision"}))
        )
        .unwrap_err()
        .reason,
        "not-found"
    );

    let kept = f
        .call(
            "engine.memory.curation.keep",
            &with(f.user("agent"), json!({"id":"beh_revision"})),
        )
        .unwrap();
    assert_eq!(kept["ok"], true);
    assert_eq!(kept["status"], "promoted");
    assert_eq!(
        f.call("engine.memory.curation.list", &owner).unwrap()["items"],
        json!([])
    );
    let audit =
        std::fs::read_to_string(f.workspace.join(".adaptive-learning/destructive-ops.jsonl"))
            .unwrap();
    assert!(audit.contains("engine.memory.curation"));
}

/// R1: a hung embedding under the mutation gate. Another owner's write waits only for the
/// gate budget and gets `engine-busy`; capture and recall are not involved at all; the hung
/// call ends after its embedding budget; afterwards the other owner's write succeeds.
#[test]
fn a_hung_embedding_holds_the_gate_only_within_its_budget() {
    let f = Fixture::new(json!({"neo":{"enabled":false}}));
    f.host.set_now_ms(1_768_305_600_000);
    f.private()
        .upsert(&[f.card(LIVE, "agent", "The garden gate is green")])
        .unwrap();
    Store::create(&f.base.join("current/other"), &f.identity(), f.width())
        .unwrap()
        .upsert(&[f.card(FOREIGN, "other", "The other owner's card")])
        .unwrap();
    let (entered, hung) = mpsc::channel::<()>();
    let entered = Mutex::new(entered);
    // The hook stands for a provider that never answers: it returns only when the call's
    // own token ends (budget or shutdown).
    let hook: engine_memory::EmbedHook = Arc::new(move |token: &Cancel| {
        let _ = entered
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .send(());
        while !token.is_cancelled() {
            std::thread::sleep(Duration::from_millis(2));
        }
    });
    let embed_budget = Duration::from_secs(3);
    f.engine
        .set_memory_budgets(embed_budget, Duration::from_millis(200), Some(hook));
    let correct = with(
        f.plain("agent"),
        json!({"id":LIVE,"newText":"The garden gate is blue"}),
    );
    let forget = with(f.plain("other"), json!({"id":FOREIGN}));
    std::thread::scope(|scope| {
        let (sender, finished) = mpsc::channel();
        let (fixture, correct) = (&f, &correct);
        scope.spawn(move || {
            let _ = sender.send(fixture.call("engine.memory.correct", correct));
        });
        hung.recv_timeout(Duration::from_secs(30)).unwrap();
        let entered = std::time::Instant::now();
        // Another owner's write: refused as busy after the gate wait, not after the hang.
        assert_eq!(
            f.call("engine.memory.forget", &forget).unwrap_err().reason,
            "engine-busy"
        );
        // Recall and capture of the other owner never take the gate.
        let recall = methods::dispatch(
            &f.engine,
            "engine.recall",
            &json!({"query":{"query":"Which card is this?","principal":f.plain("other")["p"],
                "agent":{"origin":"user","background":false}},"options":{"reranker":"off"}}),
            &Cancel::never(),
        );
        assert!(recall.is_ok(), "{recall:?}");
        let turn: TurnRecord = serde_json::from_value(json!({"agentId":"other",
            "principal":f.plain("other")["p"],"agent":{"origin":"user","background":false},
            "sessionKey":"agent:other:main","runId":"run-gate","incognito":false,
            "messages":[{"role":"user","content":"Please remember that the gate test uses blue."},
                {"role":"assistant","content":"Noted."}]}))
        .unwrap();
        let handle = f
            .engine
            .capture(turn, serde_json::from_value(json!({})).unwrap())
            .unwrap();
        assert!(handle.done.recv_timeout(Duration::from_secs(60)).is_ok());
        // The holder ends after its embedding budget with the library's error for an
        // unavailable provider. Without the budget it would hang: the engine is then closed
        // so the scope can end, and the test fails here instead of hanging.
        let ended = finished.recv_timeout(embed_budget + Duration::from_secs(10));
        if ended.is_err() {
            let _ = f.engine.close(Some(Duration::from_secs(5)));
        }
        assert!(
            ended.is_ok(),
            "the holder did not end within its embedding budget"
        );
        assert_eq!(ended.unwrap().unwrap_err().reason, "storage");
        assert!(entered.elapsed() >= embed_budget - Duration::from_millis(50));
    });
    f.engine
        .set_memory_budgets(Duration::from_secs(15), Duration::from_secs(20), None);
    assert_eq!(
        f.call("engine.memory.forget", &forget).unwrap()["archived"],
        true
    );
    assert_eq!(
        f.reopen().get(LIVE).unwrap().unwrap().text,
        "The garden gate is green"
    );
}

/// R1: `close` during a hung embedding ends the hung call through its token and stays
/// within its budget.
#[test]
fn close_ends_a_hung_embedding_within_its_budget() {
    let f = Fixture::new(json!({"neo":{"enabled":false}}));
    f.private()
        .upsert(&[f.card(LIVE, "agent", "The garden gate is green")])
        .unwrap();
    let (entered, hung) = mpsc::channel::<()>();
    let entered = Mutex::new(entered);
    let hook: engine_memory::EmbedHook = Arc::new(move |token: &Cancel| {
        let _ = entered
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .send(());
        while !token.is_cancelled() {
            std::thread::sleep(Duration::from_millis(2));
        }
    });
    f.engine.set_memory_budgets(
        Duration::from_secs(600),
        Duration::from_secs(600),
        Some(hook),
    );
    let correct = with(
        f.plain("agent"),
        json!({"id":LIVE,"newText":"The garden gate is blue"}),
    );
    std::thread::scope(|scope| {
        let hung_call = scope.spawn(|| f.call("engine.memory.correct", &correct));
        hung.recv_timeout(Duration::from_secs(30)).unwrap();
        let closing = std::time::Instant::now();
        let budget = Duration::from_secs(5);
        let _ = f.engine.close(Some(budget));
        assert!(closing.elapsed() < budget + Duration::from_secs(5));
        assert!(hung_call.join().unwrap().is_err());
    });
    assert_eq!(
        f.reopen().get(LIVE).unwrap().unwrap().text,
        "The garden gate is green"
    );
}

/// R3: the status reports shared memory as the share calls find it.
#[test]
fn status_reports_shared_memory_as_share_calls_find_it() {
    let f = Fixture::new(json!({"neo":{"enabled":false}}));
    f.private()
        .upsert(&[f.card(LIVE, "agent", "Prefers tea in the afternoon")])
        .unwrap();
    // Before any share decision the status reports the cautious value.
    assert!(!f.engine.status().shared_memory.supported);
    let shared = f.call(
        "engine.memory.share",
        &with(f.user("agent"), json!({"id":LIVE,"target":"user"})),
    );
    let after = f.engine.status().shared_memory;
    let expected = cfg!(any(target_os = "linux", target_os = "macos", windows));
    assert_eq!(after.supported, expected);
    assert_eq!(shared.is_ok(), after.supported, "{shared:?}");
    let mode = serde_json::to_value(after.mode).unwrap();
    if cfg!(target_os = "linux") {
        assert_eq!(mode, "fd-capability");
    } else if cfg!(any(target_os = "macos", windows)) {
        assert_eq!(mode, "verified-path");
    }
    // Without a store base the frozen report stays: nothing is served.
    let temp = tempfile::tempdir_in(std::fs::canonicalize(std::env::temp_dir()).unwrap()).unwrap();
    let host = Arc::new(FakeHost::new(
        temp.path().join("state"),
        serde_json::from_value(json!({})).unwrap(),
    ));
    let unconfigured = ProcessEngine::new(host, Some(Seam::FlatEmbedder)).unwrap();
    assert!(!unconfigured.status().shared_memory.supported);

    // A fresh base without any store: share is unsupported, and so is the status.
    let fresh = Fixture::new(json!({"neo":{"enabled":false}}));
    let refused = fresh.call(
        "engine.memory.share",
        &with(fresh.user("agent"), json!({"id":LIVE,"target":"user"})),
    );
    assert_eq!(refused.unwrap_err().reason, "unsupported");
    assert!(!fresh.engine.status().shared_memory.supported);
    assert!(!fresh.base.exists());

    // Composed routes whose pinned base was replaced afterwards: share refuses as
    // unsupported, and the status follows it.
    let request = with(f.user("agent"), json!({"id":LIVE,"target":"workspace"}));
    if f.engine.status().shared_memory.supported {
        std::fs::rename(&f.base, f.base.with_extension("moved")).unwrap();
        std::fs::create_dir(&f.base).unwrap();
        let refused = f.call("engine.memory.share", &request);
        assert!(refused.is_err(), "{refused:?}");
        assert!(!f.engine.status().shared_memory.supported);
    }
}

/// R2 (fix 2): at most four callers wait for the gate; a fifth and sixth are refused at once,
/// so a connection's request slots stay free and a recall is served meanwhile.
#[test]
fn gate_waiters_are_capped_and_recall_is_served_meanwhile() {
    let f = Fixture::new(json!({"neo":{"enabled":false}}));
    f.private()
        .upsert(&[f.card(LIVE, "agent", "The garden gate is green")])
        .unwrap();
    let others: Vec<String> = (0..6).map(|n| format!("other{n}")).collect();
    for other in &others {
        f.host
            .set_workspace(&other.parse().unwrap(), f.workspace.clone());
        Store::create(
            &f.base.join("current").join(other),
            &f.identity(),
            f.width(),
        )
        .unwrap()
        .upsert(&[f.card(FOREIGN, other, "Another owner's card")])
        .unwrap();
    }
    let release = Arc::new(AtomicBool::new(false));
    let (entered, hung) = mpsc::channel::<()>();
    let entered = Mutex::new(entered);
    let held = release.clone();
    let hook: engine_memory::EmbedHook = Arc::new(move |_token: &Cancel| {
        let _ = entered
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .send(());
        while !held.load(Ordering::Acquire) {
            std::thread::sleep(Duration::from_millis(2));
        }
    });
    f.engine.set_memory_budgets(
        Duration::from_secs(600),
        Duration::from_secs(600),
        Some(hook),
    );
    let correct = with(
        f.plain("agent"),
        json!({"id":LIVE,"newText":"The garden gate is blue"}),
    );
    std::thread::scope(|scope| {
        let holder = scope.spawn(|| f.call("engine.memory.correct", &correct));
        hung.recv_timeout(Duration::from_secs(30)).unwrap();
        let (sender, results) = mpsc::channel();
        for other in &others {
            let sender = sender.clone();
            let request = with(f.plain(other), json!({"id":FOREIGN}));
            let fixture = &f;
            scope.spawn(move || {
                let _ = sender.send(fixture.call("engine.memory.forget", &request));
            });
        }
        // Two come back at once as busy while four wait.
        for _ in 0..2 {
            let refused = results.recv_timeout(Duration::from_secs(30)).unwrap();
            assert_eq!(refused.unwrap_err().reason, "engine-busy");
        }
        let end = std::time::Instant::now() + Duration::from_secs(30);
        while f.engine.operations.mutation_waiters() != 4 {
            assert!(std::time::Instant::now() < end, "four waiters expected");
            std::thread::yield_now();
        }
        assert!(results.try_recv().is_err());
        let recall = methods::dispatch(
            &f.engine,
            "engine.recall",
            &json!({"query":{"query":"Which card is this?","principal":f.plain("other0")["p"],
                "agent":{"origin":"user","background":false}},"options":{"reranker":"off"}}),
            &Cancel::never(),
        );
        assert!(recall.is_ok(), "{recall:?}");
        release.store(true, Ordering::Release);
        assert_eq!(holder.join().unwrap().unwrap()["archived"], true);
        for _ in 0..4 {
            let forgotten = results.recv_timeout(Duration::from_secs(60)).unwrap();
            assert_eq!(forgotten.unwrap()["archived"], true);
        }
    });
}

/// I1 (fix 2): a correction's Neo effects get their budget from their first use, after the
/// gate: a correction that waited for the gate nearly its whole wait still writes its event.
#[test]
fn neo_effects_after_a_long_gate_wait_still_run_in_full() {
    let f = Fixture::new(json!({"neo":{"agentEndBudgetMs":1000}}));
    let request = with(
        f.user("agent"),
        json!({"id":LIVE,"newText":"The meeting is on Tuesday"}),
    );
    let context = RequestContext::build(
        &serde_json::from_value(request["p"].clone()).unwrap(),
        &serde_json::from_value(request["a"].clone()).unwrap(),
        f.host.as_ref(),
    )
    .unwrap();
    let mut card = f.card(LIVE, "agent", "The meeting is on Monday");
    card.stored_by = "agent".into();
    card.owner_user_id = context.owner_user_id.clone();
    card.workspace_key = context.workspace_key.clone();
    f.private()
        .upsert(&[card, f.card(FOREIGN, "other", "The holder's card")])
        .unwrap();
    Store::create(&f.base.join("current/other"), &f.identity(), f.width())
        .unwrap()
        .upsert(&[f.card(FOREIGN, "other", "The holder's card")])
        .unwrap();
    // The holder (another owner's correct) hangs in its embedding until released; only the
    // first embedding call blocks.
    let release = Arc::new(AtomicBool::new(false));
    let first = Arc::new(AtomicBool::new(true));
    let (entered, hung) = mpsc::channel::<()>();
    let entered = Mutex::new(entered);
    let (held, once) = (release.clone(), first.clone());
    let hook: engine_memory::EmbedHook = Arc::new(move |_token: &Cancel| {
        if !once.swap(false, Ordering::AcqRel) {
            return;
        }
        let _ = entered
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .send(());
        while !held.load(Ordering::Acquire) {
            std::thread::sleep(Duration::from_millis(2));
        }
    });
    let gate = Duration::from_secs(3);
    f.engine
        .set_memory_budgets(Duration::from_secs(1), gate, Some(hook));
    let holder = with(
        f.plain("other"),
        json!({"id":FOREIGN,"newText":"The holder's card, corrected"}),
    );
    std::thread::scope(|scope| {
        let holding = scope.spawn(|| f.call("engine.memory.correct", &holder));
        hung.recv_timeout(Duration::from_secs(30)).unwrap();
        let waiting = scope.spawn(|| f.call("engine.memory.correct", &request));
        let end = std::time::Instant::now() + Duration::from_secs(30);
        while f.engine.operations.mutation_waiters() != 1 {
            assert!(
                std::time::Instant::now() < end,
                "the correction waits for the gate"
            );
            std::thread::yield_now();
        }
        // Keep it waiting just under its gate wait (2.5 of 3 s), then release the holder.
        std::thread::sleep(gate - Duration::from_millis(500));
        release.store(true, Ordering::Release);
        // The holder itself ran past its 1 s embedding budget and failed; that is not tested.
        let _ = holding.join().unwrap();
        let corrected = waiting.join().unwrap().unwrap();
        assert_eq!(corrected["archived"], true);
    });
    let events = f
        .base
        .join("_neo/workspaces")
        .join(crate::neo::merged::Layout::for_key(&context.workspace_key).canonical)
        .join("reconsolidation-events.jsonl");
    let events = std::fs::read_to_string(events).unwrap();
    assert!(events.contains(LIVE), "the event was written: {events}");
}

/// M3/M4 (fix 2): accept and an applying unimport of refused callers create no Neo state;
/// refused callers get `denied` from promote and curation; with Neo off and no Neo state,
/// promote answers `skipped/disabled` and curation an empty list; a Neo root that cannot be
/// created leaves correct without Neo and refuses promote and curation.
#[test]
fn neo_state_is_created_only_for_authorized_calls_and_neo_off_answers_as_disabled() {
    let on = Fixture::new(json!({}));
    let mut background_user = with(on.user("agent"), json!({"proposalId":LIVE}));
    background_user["a"]["background"] = json!(true);
    assert_eq!(
        on.call("engine.memory.proposals.accept", &background_user)
            .unwrap_err()
            .reason,
        "denied"
    );
    let mut unimport = with(
        on.user("agent"),
        json!({"req":{"agentId":"agent","importRunId":"fixture-run","dryRun":false}}),
    );
    assert_eq!(
        on.call("engine.memory.unimport", &unimport)
            .unwrap_err()
            .reason,
        "denied"
    );
    unimport["a"]["origin"] = json!("system");
    unimport["req"]["agentId"] = json!("other");
    assert_eq!(
        on.call("engine.memory.unimport", &unimport)
            .unwrap_err()
            .reason,
        "invalid-input"
    );
    let promote = with(background(on.user("agent")), json!({"req":{"ids":[LIVE]}}));
    assert_eq!(
        on.call("engine.memory.promote", &promote)
            .unwrap_err()
            .reason,
        "denied"
    );
    let curation = with(background(on.user("agent")), json!({"q":{}}));
    assert_eq!(
        on.call("engine.memory.curation.list", &curation)
            .unwrap_err()
            .reason,
        "denied"
    );
    // A correct of a card the caller cannot see stops at the library's ACL check.
    on.private()
        .upsert(&[on.card(FOREIGN, "other", "Another owner's card")])
        .unwrap();
    let foreign = with(on.user("agent"), json!({"id":FOREIGN,"newText":"x"}));
    assert_eq!(
        on.call("engine.memory.correct", &foreign)
            .unwrap_err()
            .reason,
        "not-found"
    );
    assert!(!on.base.join("_neo").exists());

    let off = Fixture::new(json!({"neo":{"enabled":false},"schicht15":{"enabled":true}}));
    let promoted = off
        .call(
            "engine.memory.promote",
            &with(off.user("agent"), json!({"req":{"ids":[LIVE]}})),
        )
        .unwrap();
    assert_eq!(promoted["items"][0]["outcome"], "skipped", "{promoted}");
    assert_eq!(promoted["items"][0]["reason"], "disabled");
    let listed = off
        .call(
            "engine.memory.curation.list",
            &with(off.user("agent"), json!({"q":{}})),
        )
        .unwrap();
    assert_eq!(listed["items"], json!([]));
    assert_eq!(listed["agentId"], "agent");
    assert_eq!(
        off.call(
            "engine.memory.curation.keep",
            &with(off.user("agent"), json!({"id":"beh_revision"}))
        )
        .unwrap_err()
        .reason,
        "not-found"
    );
    assert!(!off.base.join("_neo").exists());

    // A Neo root that cannot be created: a regular file stands where it would go.
    let blocked = Fixture::new(json!({}));
    std::fs::create_dir_all(&blocked.base).unwrap();
    std::fs::write(blocked.base.join("_neo"), "not a directory").unwrap();
    blocked
        .private()
        .upsert(&[blocked.card(LIVE, "agent", "The color is blue")])
        .unwrap();
    let corrected = blocked
        .call(
            "engine.memory.correct",
            &with(
                blocked.user("agent"),
                json!({"id":LIVE,"newText":"The color is red"}),
            ),
        )
        .unwrap();
    assert_eq!(corrected["archived"], true);
    for (method, fields) in [
        ("engine.memory.promote", json!({"req":{"ids":[LIVE]}})),
        ("engine.memory.curation.list", json!({"q":{}})),
    ] {
        assert_eq!(
            blocked
                .call(method, &with(blocked.user("agent"), fields))
                .unwrap_err()
                .reason,
            "invalid-input",
            "{method}"
        );
    }
    assert!(blocked.base.join("_neo").is_file());
}
