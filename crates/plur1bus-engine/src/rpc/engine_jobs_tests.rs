//! Status and the job registry through the actual process engine (RE-D157, RE-D158).
#![allow(clippy::unwrap_used, reason = "synthetic fixture failures are fatal")]
use super::*;
use crate::{contract::testing::FakeHost, store::directory::TrustedDirectory};
use std::{
    fs,
    path::Path,
    time::{Duration, Instant},
};

/// 2026-01-13T12:00:00Z, the parity clock.
const NOW: i64 = 1_768_305_600_000;

fn engine(root: &Path, neo: bool) -> (Arc<FakeHost>, ProcessEngine) {
    let host = Arc::new(FakeHost::new(
        root.join("state"),
        serde_json::from_value(json!({"baseDbPath":root.join("db"),"neo":{"enabled":neo}}))
            .unwrap(),
    ));
    host.set_now_ms(NOW);
    let engine = ProcessEngine::new(host.clone(), Some(Seam::FlatEmbedder)).unwrap();
    (host, engine)
}
fn scratch() -> tempfile::TempDir {
    tempfile::tempdir_in(fs::canonicalize(std::env::temp_dir()).unwrap()).unwrap()
}
fn alpha() -> AgentId {
    serde_json::from_value(json!("alpha")).unwrap()
}
fn options(trigger: &str) -> RunOptions {
    serde_json::from_value(json!({"trigger":trigger})).unwrap()
}
fn history(engine: &ProcessEngine) -> Vec<JobRun> {
    engine
        .jobs()
        .history(&alpha(), serde_json::from_value(json!({})).unwrap())
        .unwrap()
}
fn status(engine: &ProcessEngine) -> Value {
    serde_json::to_value(engine.status()).unwrap()
}
fn refused<T: std::fmt::Debug>(result: Result<T, EngineError>, expected: &str) {
    let detail = format!("{result:?}");
    assert!(
        matches!(result, Err(EngineError::NotAvailable { reason }) if reason == expected),
        "expected not-available/{expected}, got {detail}"
    );
}

#[test]
fn status_reports_journal_jobs_and_schema_from_real_sources_without_creating_files() {
    let temp = scratch();
    let base = temp.path().join("db");
    let (host, engine) = engine(temp.path(), false);
    let first = status(&engine);
    assert!(!base.exists(), "status created the store base");
    assert_eq!(first["ready"], true, "{first}");
    // The pin's model degradation is kept: warming models do not make the engine not ready.
    assert_eq!(
        first["degraded"],
        json!({"reason":"models-warming","capability":"embedding"})
    );
    assert_eq!(first["journal"], Value::Null);
    assert_eq!(first["jobs"], json!({"ledger":"ok","agents":[]}));
    assert_eq!(
        first["storeSchema"],
        json!({"current":"1","expected":"1"}),
        "a missing base is fresh: the pin writes marker 1 at engine creation and reports storeMigrator.current() (RE-D175)"
    );

    host.set_journal_backlog(Some(
        serde_json::from_value(json!({"entries":3,"oldestAt":1700})).unwrap(),
    ));
    engine.models().warm(&Cancel::never(), false).unwrap();
    let handle = engine.open(&alpha()).unwrap();
    fs::write(base.join("_schema.json"), br#"{"schemaVersion":"1"}"#).unwrap();
    let served = status(&engine);
    assert_eq!(served["ready"], true, "{served}");
    assert_eq!(served["degraded"], Value::Null, "{served}");
    assert_eq!(served["agents"], 1);
    assert_eq!(served["journal"], json!({"entries":3,"oldestAt":1700}));
    assert_eq!(served["storeSchema"]["current"], "1");
    assert_eq!(served["jobs"], json!({"ledger":"ok","agents":[]}));
    assert!(!base.join("_jobs").exists(), "status created the jobs root");
    (handle.close)().unwrap();
    engine.close(None).unwrap();
    assert_eq!(status(&engine)["ready"], false);
}

#[test]
fn the_registry_lists_twenty_jobs_and_owner_data_jobs_answer_a_fixed_reason() {
    let temp = scratch();
    let base = temp.path().join("db");
    // Neo is enabled: embedding-drain would read private Neo rows and has no bound authority.
    let (_host, engine) = engine(temp.path(), true);
    let specs = engine.jobs().list();
    assert_eq!(specs.len(), 20);
    for spec in specs {
        let expected = if engine.job_needs_authority(spec.name) {
            "job-authority-unbound"
        } else {
            crate::jobs::authority::refusal(spec.name)
        };
        // The cron context is no owner evidence, and an agent ID is no grant (F13).
        for trigger in ["manual", "cron"] {
            refused(
                engine
                    .jobs()
                    .run(spec.name, &alpha(), options(trigger), &Cancel::never()),
                expected,
            );
        }
    }
    assert!(history(&engine).is_empty());
    assert!(!base.exists(), "a refused job created files");
    assert_eq!(status(&engine)["jobs"], json!({"ledger":"ok","agents":[]}));
    assert_eq!(status(&engine)["ready"], true);
    engine.close(None).unwrap();
    refused(
        engine.jobs().run(
            JobName::GcRun,
            &alpha(),
            options("manual"),
            &Cancel::never(),
        ),
        "closed",
    );
}

#[test]
fn authorized_embedding_drain_updates_only_the_granted_owners_queue() {
    use crate::{
        context::{harness_user_principal, RequestContext, RouteVocabulary},
        jobs::authority::JobAuthority,
        neo::{capture_journal::CaptureJournal, merged::Layout},
    };

    let temp = scratch();
    let base = temp.path().join("db");
    let neo = base.join("_neo");
    let (host, engine) = engine(temp.path(), true);
    host.set_workspace(&alpha(), temp.path().to_owned());
    crate::store::paths::secure_dir(&neo).unwrap();
    let journal = CaptureJournal::open(
        &neo,
        host.clone(),
        engine_capture::workspace_capture_policy(&base),
    )
    .unwrap();
    let cancel = Cancel::never();
    let make_turn = |owner: &str, content: &str| -> TurnRecord {
        serde_json::from_value(json!({
            "agentId": "alpha", "runId": owner, "sessionKey": owner, "incognito": false,
            "messages": [{"role":"assistant","content":content}],
            "principal": {
                "agentId":"alpha", "channel":"telegram", "accountId":"fixture", "trust":"proved",
                "workspace":format!("workspace-dir:v1:{}",temp.path().display()),
                "user":harness_user_principal(owner),"chat":{"id":owner,"kind":"direct"}
            },
            "agent":{"origin":"user","background":false}
        }))
        .unwrap()
    };
    let first = make_turn("first", "I will write the migration guide.");
    let second = make_turn("second", "I will find the release checklist.");
    let first_ctx = RequestContext::build(&first.principal, &first.agent, host.as_ref()).unwrap();
    let second_ctx =
        RequestContext::build(&second.principal, &second.agent, host.as_ref()).unwrap();
    journal.record(&first, &first_ctx, &cancel).unwrap();
    journal.record(&second, &second_ctx, &cancel).unwrap();
    let queue = neo
        .join("workspaces")
        .join(Layout::for_key(&first_ctx.workspace_key).canonical)
        .join("embedding-queue.jsonl");
    let original = fs::read_to_string(&queue).unwrap();
    assert!(original.contains(&first_ctx.owner_user_id));
    assert!(original.contains(&second_ctx.owner_user_id));

    let scheduled: AgentContext =
        serde_json::from_value(json!({"origin":"cron","background":true})).unwrap();
    let authority = || {
        JobAuthority::from_host(
            host.as_ref(),
            JobName::EmbeddingDrain,
            &alpha(),
            first.principal.clone(),
            scheduled.clone(),
            RouteVocabulary::shared(),
        )
        .unwrap()
    };
    let dry_run: RunOptions = serde_json::from_value(json!({"dryRun":true})).unwrap();
    assert_eq!(
        engine
            .run_authorized_job(authority(), dry_run, &cancel)
            .unwrap()
            .reason
            .as_deref(),
        Some("dry_run_unsupported")
    );
    assert!(!base.join("_jobs").exists());

    let run = engine
        .run_authorized_job(authority(), options("harness"), &cancel)
        .unwrap();
    assert_eq!(run.outcome, JobOutcome::Completed);
    let updated = fs::read_to_string(queue).unwrap();
    let appended = updated.strip_prefix(&original).unwrap();
    assert!(!appended.is_empty());
    assert!(appended.contains(&first_ctx.owner_user_id));
    assert!(!appended.contains(&second_ctx.owner_user_id));
    assert_eq!(history(&engine)[0].run_id, run.run_id);
}

#[test]
fn authorized_episode_rebuild_matches_node_and_isolates_window_fallback() {
    use crate::{
        context::{harness_user_principal, RouteVocabulary},
        jobs::authority::JobAuthority,
        neo::merged::Layout,
    };

    let fixture: Value = serde_json::from_str(include_str!(
        "../../tests/fixtures/jobs/episode-rebuild.json"
    ))
    .unwrap();
    assert_eq!(fixture["now"], NOW);
    let temp = scratch();
    let (host, engine) = engine(temp.path(), true);
    host.set_workspace(&alpha(), temp.path().to_owned());
    let workspace = format!("workspace-dir:v1:{}", temp.path().display());
    let principal: Principal = serde_json::from_value(json!({
        "agentId":"alpha", "channel":"telegram", "accountId":"fixture", "trust":"proved",
        "workspace":workspace, "user":harness_user_principal("first"),
        "chat":{"id":"first","kind":"direct"}
    }))
    .unwrap();
    let authority = || {
        JobAuthority::from_host(
            host.as_ref(),
            JobName::EpisodesRebuild,
            &alpha(),
            principal.clone(),
            serde_json::from_value(json!({"origin":"cron","background":true})).unwrap(),
            RouteVocabulary::shared(),
        )
        .unwrap()
    };
    let partition = temp
        .path()
        .join("db/_neo/workspaces")
        .join(Layout::for_key(&workspace).canonical);
    crate::store::paths::secure_dir(&partition).unwrap();
    let stamp = |mut row: Value, owner: &str| {
        row["workspaceKey"] = json!(workspace);
        row["agentId"] = json!("alpha");
        row["ownerUserId"] = json!(harness_user_principal(owner));
        row["scope"] = json!("agent_private");
        row
    };
    let mut turns: Vec<_> = fixture["turns"]
        .as_array()
        .unwrap()
        .iter()
        .map(|row| stamp(row.clone(), "first"))
        .collect();
    let mut foreign = fixture["turns"][0].clone();
    foreign["id"] = json!("foreign");
    turns.push(stamp(foreign, "second"));
    let mut prior = stamp(fixture["old"].clone(), "first");
    // Legacy episode IDs can differ from those actually committed to the journal.
    prior["memoryIds"] = json!(["legacy-unresolved"]);
    let mut foreign = stamp(fixture["old"].clone(), "second");
    foreign["id"] = json!("foreign-episode");
    let lines = |rows: &[Value]| {
        rows.iter()
            .map(|row| format!("{row}\n"))
            .collect::<String>()
    };
    fs::write(partition.join("turn-journal.jsonl"), lines(&turns)).unwrap();
    let file = partition.join("episodes.jsonl");
    let original = lines(&[prior, foreign]);
    fs::write(&file, &original).unwrap();

    let run = || {
        engine
            .run_authorized_job(authority(), options("harness"), &Cancel::never())
            .unwrap()
    };
    assert_eq!(run().outcome, JobOutcome::Completed);
    let updated = fs::read_to_string(&file).unwrap();
    let row: Value = serde_json::from_str(updated.strip_prefix(&original).unwrap()).unwrap();
    let mut expected = fixture["expected"].as_object().unwrap().clone();
    let vividness = expected.remove("vividness").unwrap().as_f64().unwrap();
    for (field, value) in expected {
        assert_eq!(row[&field], value, "{field}");
    }
    assert!((row["vividness"].as_f64().unwrap() - vividness).abs() < 1e-12);
    assert_eq!(row["ownerUserId"], json!(harness_user_principal("first")));
    assert_eq!(run().outcome, JobOutcome::Completed);
    assert_eq!(fs::read_to_string(file).unwrap(), updated);
}

#[test]
fn capture_continues_an_open_episode_after_a_scheduled_rebuild() {
    use crate::{
        context::{harness_user_principal, RequestContext, RouteVocabulary},
        jobs::authority::JobAuthority,
        neo::{episode_store::EpisodeStore, merged::Layout},
    };

    let temp = scratch();
    let (host, engine) = engine(temp.path(), true);
    host.set_workspace(&alpha(), temp.path().to_owned());
    let workspace = format!("workspace-dir:v1:{}", temp.path().display());
    let root = temp.path().join("db/_neo");
    crate::store::paths::secure_dir(&root).unwrap();
    let episodes = EpisodeStore::open(
        &root,
        host.clone(),
        engine_capture::workspace_capture_policy(&temp.path().join("db")),
        engine.mood.pool(),
    )
    .unwrap();
    let make_turn = |run_id: &str, messages: Value| -> TurnRecord {
        serde_json::from_value(json!({
            "agentId":"alpha", "sessionKey":"alpha:direct:1", "runId":run_id, "incognito":false,
            "principal":{"agentId":"alpha", "channel":"telegram","accountId":"fixture",
                "trust":"proved","workspace":workspace,"user":harness_user_principal("first"),
                "chat":{"id":"first","kind":"direct"}},
            "agent":{"origin":"user","background":false},
            "messages":messages,
        }))
        .unwrap()
    };
    let first = make_turn(
        "first",
        json!([
            {"role":"user","content":"Please prepare the release notes."},
            {"role":"assistant","content":"I started drafting the release notes."},
        ]),
    );
    let ctx = RequestContext::build(&first.principal, &first.agent, host.as_ref()).unwrap();
    let cancel = Cancel::never();
    assert_eq!(episodes.process(&first, &ctx, &cancel).unwrap(), 1);
    let authority = JobAuthority::from_host(
        host.as_ref(),
        JobName::EpisodesRebuild,
        &alpha(),
        first.principal.clone(),
        serde_json::from_value(json!({"origin":"cron","background":true})).unwrap(),
        RouteVocabulary::shared(),
    )
    .unwrap();
    assert_eq!(
        engine
            .run_authorized_job(authority, options("harness"), &cancel)
            .unwrap()
            .outcome,
        JobOutcome::Completed
    );
    host.set_now_ms(NOW + 2000);
    let second = make_turn(
        "second",
        json!([
            {"role":"user","content":"Please prepare the release notes."},
            {"role":"assistant","content":"I started drafting the release notes."},
            {"role":"user","content":"Please add the Rust changes."},
            {"role":"assistant","content":"The Rust changes are now included."},
        ]),
    );
    assert_eq!(episodes.process(&second, &ctx, &cancel).unwrap(), 1);
    let path = root
        .join("workspaces")
        .join(Layout::for_key(&workspace).canonical)
        .join("episodes.jsonl");
    let rows: Vec<Value> = fs::read_to_string(path)
        .unwrap()
        .lines()
        .map(|line| serde_json::from_str(line).unwrap())
        .collect();
    assert_eq!(rows.len(), 3);
    assert_eq!(rows[1]["id"], rows[0]["id"]);
    assert_eq!(rows[2]["id"], rows[0]["id"]);
    assert_eq!(rows[1]["revision"], 1);
    assert_eq!(rows[2]["revision"], 2);
    assert_eq!(rows[2]["turnCount"], 4);
}

#[test]
fn stale_criticals_match_the_node_delta_only_for_the_granted_owner() {
    use crate::{
        capture::row_defaults::schema_defaults,
        context::{harness_user_principal, RouteVocabulary},
        jobs::authority::JobAuthority,
        ops::write::MutationStores,
    };

    let fixture: Value = serde_json::from_str(include_str!(
        "../../tests/fixtures/jobs/stale-criticals.json"
    ))
    .unwrap();
    assert_eq!(fixture["now"], NOW);
    let temp = scratch();
    let (host, engine) = engine(temp.path(), false);
    host.set_workspace(&alpha(), temp.path().to_owned());
    let owner = harness_user_principal("critical-owner");
    let workspace = format!("workspace-dir:v1:{}", temp.path().display());
    let principal: Principal = serde_json::from_value(json!({
        "agentId":"alpha","workspace":workspace,"user":owner,"channel":"telegram","accountId":"fixture",
        "chat":{"id":"fixture","kind":"direct"},"trust":"proved"
    })).unwrap();
    let background = AgentContext {
        origin: TurnOrigin::Cron,
        background: true,
        job_id: None,
        parent_run_id: None,
    };
    let grant = || {
        JobAuthority::from_host(
            host.as_ref(),
            JobName::AutoAcceptStale,
            &alpha(),
            principal.clone(),
            background.clone(),
            RouteVocabulary::shared(),
        )
        .unwrap()
    };
    let binding = grant();
    let cancel = Cancel::never();
    engine.open(&alpha()).unwrap();
    let store = engine
        .live_stores
        .existing_private(binding.request())
        .unwrap()
        .unwrap();
    let input: Vec<MemoryRow> = fixture["candidates"]
        .as_array()
        .unwrap()
        .iter()
        .map(|card| {
            let mut row = schema_defaults(vec![0.; 384]);
            row.id = card["id"].as_str().unwrap().into();
            row.type_ = card["type"].as_str().unwrap().into();
            row.confirmed = card["confirmed"].as_bool().unwrap();
            row.text = format!("Fixture card {}", row.id);
            row.created_at = card["createdAt"].as_i64().unwrap().into();
            row.agent_id = "alpha".into();
            row.stored_by = row.agent_id.clone();
            row.owner_user_id = owner.clone();
            row.workspace_id = workspace.clone();
            row.workspace_key = workspace.clone();
            row.status = "active".into();
            row
        })
        .collect();
    let mut excluded = Vec::new();
    for (index, field) in [
        "owner",
        "workspace",
        "ownerless",
        "deleted",
        "invalidated",
        "scope",
        "agent",
    ]
    .into_iter()
    .enumerate()
    {
        let mut row = input[0].clone();
        row.id = format!("00000000-0000-0000-0000-{:012}", 10 + index);
        match field {
            "owner" => row.owner_user_id = harness_user_principal("another-owner"),
            "workspace" => row.workspace_id = "workspace:v1:other".into(),
            "ownerless" => row.owner_user_id.clear(),
            "deleted" => row.status = "deleted".into(),
            "invalidated" => row.epistemic_status = "invalidated".into(),
            "scope" => row.scope = "workspace".into(),
            "agent" => row.agent_id = "other".into(),
            _ => unreachable!(),
        }
        excluded.push(row);
    }
    store.upsert(&input).unwrap();
    store.upsert(&excluded).unwrap();

    let run = engine
        .run_authorized_job(binding, options("harness"), &cancel)
        .unwrap();
    assert_eq!(run.outcome, JobOutcome::Completed, "{run:?}");
    for _ in 0..2 {
        for (original, expected) in input.iter().zip(fixture["rows"].as_array().unwrap()) {
            let row = store.get(&original.id).unwrap().unwrap();
            assert_eq!(Some(row.type_.as_str()), expected["type"].as_str());
            assert_eq!(row.confirmed, expected["confirmed"].as_bool().unwrap());
            assert_eq!(row.text, original.text);
        }
        for original in &excluded {
            let row = store.get(&original.id).unwrap().unwrap();
            assert_eq!(row.type_, original.type_, "{}", original.id);
            assert_eq!(row.confirmed, original.confirmed, "{}", original.id);
        }
        assert_eq!(
            engine
                .run_authorized_job(grant(), options("harness"), &cancel)
                .unwrap()
                .outcome,
            JobOutcome::Completed
        );
    }
}

#[test]
fn gc_archives_the_pinned_delta_without_removing_protected_or_foreign_rows() {
    use crate::{
        capture::row_defaults::schema_defaults,
        context::{harness_user_principal, RouteVocabulary},
        jobs::authority::JobAuthority,
        ops::write::MutationStores,
    };
    let golden: Value =
        serde_json::from_str(include_str!("../../tests/fixtures/jobs/gc.json")).unwrap();
    assert_eq!(golden["now"], NOW);
    let temp = scratch();
    let mut config = json!({"baseDbPath":temp.path().join("db"),"neo":{"enabled":false}});
    config["gc"] = golden["policy"].clone();
    let host = Arc::new(FakeHost::new(
        temp.path().join("state"),
        serde_json::from_value(config).unwrap(),
    ));
    host.set_now_ms(NOW);
    host.set_workspace(&alpha(), temp.path().to_owned());
    let engine = ProcessEngine::new(host.clone(), Some(Seam::FlatEmbedder)).unwrap();
    let owner = harness_user_principal("gc-owner");
    let workspace = format!("workspace-dir:v1:{}", temp.path().display());
    let principal: Principal = serde_json::from_value(json!({
        "agentId":"alpha","workspace":workspace,"user":owner,"channel":"telegram","accountId":"fixture",
        "chat":{"id":"fixture","kind":"direct"},"trust":"proved"
    })).unwrap();
    let grant = || {
        JobAuthority::from_host(
            host.as_ref(),
            JobName::GcRun,
            &alpha(),
            principal.clone(),
            AgentContext {
                origin: TurnOrigin::Cron,
                background: true,
                job_id: None,
                parent_run_id: None,
            },
            RouteVocabulary::shared(),
        )
        .unwrap()
    };
    let authority = grant();
    let cancel = Cancel::never();
    engine.open(&alpha()).unwrap();
    let store = engine
        .live_stores
        .existing_private(authority.request())
        .unwrap()
        .unwrap();
    let rows: Vec<MemoryRow> = golden["inputs"]
        .as_array()
        .unwrap()
        .iter()
        .map(|card| {
            let mut row = schema_defaults(vec![0.; 384]);
            row.id = card["id"].as_str().unwrap().into();
            row.text = format!("Fixture card {}", row.id);
            row.created_at = card["createdAt"].as_i64().unwrap().into();
            row.memory_strength = card["memoryStrength"].as_number().unwrap().clone();
            row.never_forget = card["neverForget"].as_number().unwrap().clone();
            row.memory_class = card["memoryClass"].as_str().unwrap().into();
            row.status = card["status"].as_str().unwrap().into();
            row.agent_id = "alpha".into();
            row.stored_by = row.agent_id.clone();
            row.owner_user_id = owner.clone();
            row.workspace_id = workspace.clone();
            row.workspace_key = workspace.clone();
            row
        })
        .collect();
    let mut other = rows[0].clone();
    other.id = "00000000-0000-0000-0000-000000000010".into();
    other.owner_user_id = harness_user_principal("another-owner");
    store.upsert(&rows).unwrap();
    store.upsert(std::slice::from_ref(&other)).unwrap();
    let run = engine
        .run_authorized_job(authority, options("harness"), &cancel)
        .unwrap();
    assert_eq!(run.outcome, JobOutcome::Completed, "{run:?}");
    for (row, expected) in rows.iter().zip(golden["rows"].as_array().unwrap()) {
        let current = store.get(&row.id).unwrap().unwrap();
        assert_eq!(Some(current.status.as_str()), expected["status"].as_str());
        assert_eq!(current.text, row.text);
    }
    assert_eq!(store.get(&other.id).unwrap().unwrap().status, "active");

    let directory = temp.path().join("archive/alpha");
    let mut archived: Vec<Value> = fs::read_dir(&directory)
        .unwrap()
        .map(|file| {
            let path = file.unwrap().path();
            serde_json::from_slice(&fs::read(path).unwrap()).unwrap()
        })
        .collect();
    archived.sort_by(|a, b| a["id"].as_str().cmp(&b["id"].as_str()));
    let expected = golden["archive"].as_array().unwrap();
    assert_eq!(archived.len(), expected.len());
    for (actual, expected) in archived.iter().zip(expected) {
        for field in [
            "id",
            "status",
            "memoryStrength",
            "memoryClass",
            "neverForget",
        ] {
            if field == "memoryStrength" || field == "neverForget" {
                assert_eq!(actual[field].as_f64(), expected[field].as_f64());
            } else {
                assert_eq!(actual[field], expected[field]);
            }
        }
        assert_eq!(actual["ownerUserId"], owner);
    }
    let again = engine
        .run_authorized_job(grant(), options("harness"), &cancel)
        .unwrap();
    assert_eq!(again.outcome, JobOutcome::Completed);
    assert_eq!(fs::read_dir(directory).unwrap().count(), archived.len());
}

#[test]
fn an_allowed_job_runs_and_its_run_is_in_the_ledger_history_and_status() {
    let temp = scratch();
    let base = temp.path().join("db");
    let (host, engine) = engine(temp.path(), false);
    // A dry run takes no session and writes no ledger entry.
    let dry = engine
        .jobs()
        .run(
            JobName::EmbeddingDrain,
            &alpha(),
            serde_json::from_value(json!({"dryRun":true})).unwrap(),
            &Cancel::never(),
        )
        .unwrap();
    assert_eq!(dry.reason.as_deref(), Some("dry_run_unsupported"));
    assert!(!base.join("_jobs/alpha").exists());
    let run = engine
        .jobs()
        .run(
            JobName::EmbeddingDrain,
            &alpha(),
            options("cron"),
            &Cancel::never(),
        )
        .unwrap();
    let wire = serde_json::to_value(&run).unwrap();
    assert_eq!(wire["job"], "embedding-drain");
    assert_eq!(wire["agentId"], "alpha");
    assert_eq!(wire["trigger"], "cron");
    assert_eq!(wire["outcome"], "skipped");
    assert_eq!(wire["reason"], "neo_disabled");
    let ledger = fs::read_to_string(base.join("_jobs/alpha/ledger.jsonl")).unwrap();
    assert_eq!(ledger.lines().count(), 1);
    assert!(ledger.contains(run.run_id.as_str()));
    let running = base.join("_jobs/alpha/running");
    assert!(!running.exists() || fs::read_dir(&running).unwrap().next().is_none());
    let listed = history(&engine);
    assert_eq!(listed.len(), 1);
    assert_eq!(serde_json::to_value(&listed[0]).unwrap(), wire);
    assert!(host
        .events()
        .iter()
        .any(|(name, payload)| name == "job.run" && payload["runId"] == wire["runId"]));

    let jobs = status(&engine)["jobs"].clone();
    assert_eq!(
        jobs,
        json!({"ledger":"ok","agents":[{
            "agentId":"alpha",
            "lastRuns":{"embedding-drain":{"runId":wire["runId"],"outcome":"skipped",
                "reason":"neo_disabled","trigger":"cron","startedAt":NOW,"finishedAt":NOW,"attempt":1}},
            "running":[],
            "breaker":{"sweep":"2026-01-13","sessions":0,"limit":3,"open":false},
            "unreadableLines":0}]})
    );
    assert_eq!(status(&engine)["ready"], true);
    // Allowing one job grants nothing else.
    refused(
        engine.jobs().run(
            JobName::KnowledgeUpdate,
            &alpha(),
            options("manual"),
            &Cancel::never(),
        ),
        "job-authority-unbound",
    );
    refused(
        engine.jobs().run(
            JobName::RemDream,
            &alpha(),
            options("manual"),
            &Cancel::never(),
        ),
        "not-implemented",
    );
    engine.close(None).unwrap();
}

/// RE-D175: the library composition writes nothing when it is built, and the first entry in a fresh base brings
/// the marker. The engine process writes it at its start (`main.rs`), so the process tests cannot show this.
#[test]
fn the_first_run_in_a_fresh_base_brings_the_marker_in_the_library_composition() {
    let temp = scratch();
    let base = temp.path().join("db");
    let (_host, engine) = engine(temp.path(), false);
    assert!(!base.join("_schema.json").exists());
    engine
        .jobs()
        .run(
            JobName::EmbeddingDrain,
            &alpha(),
            serde_json::from_value(json!({})).unwrap(),
            &Cancel::never(),
        )
        .unwrap();
    assert!(base.join("_jobs").is_dir(), "the run created its ledger");
    let marker: Value =
        serde_json::from_slice(&fs::read(base.join("_schema.json")).unwrap()).unwrap();
    assert_eq!(marker["schemaVersion"], "1");
    engine.close(None).unwrap();
}

/// Pin `engine/create-engine.js` (`jobs.run`): `trigger: opts?.trigger ?? "harness"`, for dry and real runs.
#[test]
fn a_run_without_a_trigger_is_a_harness_run_like_the_pin() {
    let temp = scratch();
    let (_host, engine) = engine(temp.path(), false);
    for options in [json!({}), json!({"dryRun":true}), json!({"dryRun":false})] {
        let run = engine
            .jobs()
            .run(
                JobName::EmbeddingDrain,
                &alpha(),
                serde_json::from_value(options.clone()).unwrap(),
                &Cancel::never(),
            )
            .unwrap();
        assert_eq!(
            serde_json::to_value(&run).unwrap()["trigger"],
            "harness",
            "{options}"
        );
    }
    // An explicit trigger is kept.
    let run = engine
        .jobs()
        .run(
            JobName::EmbeddingDrain,
            &alpha(),
            options("manual"),
            &Cancel::never(),
        )
        .unwrap();
    assert_eq!(serde_json::to_value(&run).unwrap()["trigger"], "manual");
    engine.close(None).unwrap();
}

#[test]
fn an_unusable_jobs_root_keeps_the_engine_not_ready() {
    let temp = scratch();
    let base = temp.path().join("db");
    let (_host, engine) = engine(temp.path(), false);
    let handle = engine.open(&alpha()).unwrap();
    assert_eq!(status(&engine)["ready"], true);
    fs::write(base.join("_jobs"), b"not a directory").unwrap();
    let broken = status(&engine);
    assert_eq!(broken["ready"], false, "{broken}");
    assert_eq!(
        broken["degraded"],
        json!({"reason":"composition-invalid","capability":"jobs"})
    );
    assert_eq!(broken["jobs"]["ledger"], "unavailable");
    assert!(engine
        .jobs()
        .run(
            JobName::EmbeddingDrain,
            &alpha(),
            options("manual"),
            &Cancel::never()
        )
        .is_err());
    assert_eq!(fs::read(base.join("_jobs")).unwrap(), b"not a directory");
    fs::remove_file(base.join("_jobs")).unwrap();
    assert_eq!(status(&engine)["ready"], true);
    (handle.close)().unwrap();
    engine.close(None).unwrap();
}

fn beta() -> AgentId {
    serde_json::from_value(json!("beta")).unwrap()
}
fn drain(engine: &ProcessEngine, agent: &AgentId, cancel: &Cancel) -> Result<JobRun, EngineError> {
    engine
        .jobs()
        .run(JobName::EmbeddingDrain, agent, options("manual"), cancel)
}

#[test]
fn one_agents_incomplete_job_recovery_affects_only_that_agent_and_is_retried() {
    let temp = scratch();
    let base = temp.path().join("db");
    let (_host, engine) = engine(temp.path(), false);
    let blocked = base.join("_jobs/alpha/ledger.jsonl");
    fs::create_dir_all(&blocked).unwrap();
    refused(
        drain(&engine, &alpha(), &Cancel::never()),
        "startup-recovery-incomplete",
    );
    // Isolation (RE-D160): the engine stays ready and another agent's jobs run.
    let after = status(&engine);
    assert_eq!(after["ready"], true, "{after}");
    assert_ne!(after["degraded"]["capability"], "jobs", "{after}");
    // The pin reports an unreadable ledger as `unavailable`; that is display, not readiness.
    assert_eq!(after["jobs"]["ledger"], "unavailable");
    drain(&engine, &beta(), &Cancel::never()).unwrap();
    // The same agent is retried on its next call.
    refused(
        drain(&engine, &alpha(), &Cancel::never()),
        "startup-recovery-incomplete",
    );
    fs::remove_dir(&blocked).unwrap();
    drain(&engine, &alpha(), &Cancel::never()).unwrap();
    let repaired = status(&engine);
    assert_eq!(repaired["ready"], true, "{repaired}");
    assert_eq!(repaired["jobs"]["ledger"], "ok");
    engine.close(None).unwrap();
}

#[test]
fn an_unsupported_or_malformed_schema_marker_keeps_the_engine_not_ready() {
    let temp = scratch();
    let base = temp.path().join("db");
    let (_host, engine) = engine(temp.path(), false);
    // A missing marker on a store that does not exist yet is legacy 0, as at the pin.
    assert_eq!(status(&engine)["ready"], true);
    let handle = engine.open(&alpha()).unwrap();
    let marker = base.join("_schema.json");
    for (bytes, current) in [
        (&br#"{"schemaVersion":"2"}"#[..], json!("2")),
        (&b"{not json"[..], Value::Null),
    ] {
        fs::write(&marker, bytes).unwrap();
        let broken = status(&engine);
        assert_eq!(broken["ready"], false, "{broken}");
        assert_eq!(
            broken["degraded"],
            json!({"reason":"schema-unsupported","capability":"store"})
        );
        assert_eq!(broken["storeSchema"]["current"], current);
    }
    fs::write(&marker, br#"{"schemaVersion":"1"}"#).unwrap();
    assert_eq!(status(&engine)["ready"], true);
    fs::remove_file(&marker).unwrap();
    assert_eq!(status(&engine)["ready"], true);
    (handle.close)().unwrap();
    engine.close(None).unwrap();
}

#[test]
fn a_held_session_lease_bounds_runs_and_never_blocks_history() {
    let temp = scratch();
    let base = temp.path().join("db");
    let (_host, engine) = engine(temp.path(), false);
    drain(&engine, &alpha(), &Cancel::never()).unwrap();
    let engine = Arc::new(engine);
    let agent_dir = base.join("_jobs/beta");
    fs::create_dir_all(&agent_dir).unwrap();
    // Another process holds beta's registry session lease.
    let held = TrustedDirectory::open(&agent_dir).unwrap();
    let lease = crate::store::kernel_lease::acquire(
        &held,
        "job-registry-session",
        &Cancel::never(),
        &mut || {},
    )
    .unwrap();
    // A run without a deadline ends with a fixed error after the session-start budget.
    let (done, finished) = mpsc::channel();
    let runner = engine.clone();
    let started = Instant::now();
    let worker = std::thread::spawn(move || {
        let _ = done.send(drain(&runner, &beta(), &Cancel::never()).map(|run| run.run_id));
    });
    std::thread::sleep(Duration::from_millis(200));
    // History of the waiting agent answers at once.
    let (sent, listed) = mpsc::channel();
    let reader = engine.clone();
    std::thread::spawn(move || {
        let _ = sent.send(
            reader
                .jobs()
                .history(&beta(), serde_json::from_value(json!({})).unwrap())
                .map(|runs| runs.len()),
        );
    });
    let listed = listed.recv_timeout(Duration::from_millis(500));
    assert!(
        matches!(listed, Ok(Ok(0))),
        "history waited or failed: {listed:?}"
    );
    let result = finished.recv_timeout(Duration::from_secs(8));
    assert!(started.elapsed() < Duration::from_secs(8));
    let result = result.unwrap();
    refused(result, "job-session-busy");
    worker.join().unwrap();
    // A cancelled (disconnected) caller ends its wait.
    let cancel = Cancel::never();
    let (done, finished) = mpsc::channel();
    let runner = engine.clone();
    let token = cancel.clone();
    let worker = std::thread::spawn(move || {
        let _ = done.send(drain(&runner, &beta(), &token).map(|run| run.run_id));
    });
    std::thread::sleep(Duration::from_millis(200));
    cancel.cancel();
    let result = finished.recv_timeout(Duration::from_secs(1)).unwrap();
    assert!(
        matches!(result, Err(EngineError::Cancelled(_))),
        "{result:?}"
    );
    worker.join().unwrap();
    // Nothing is left that blocks the next attempt, and alpha is unaffected.
    drop(lease);
    drain(&engine, &beta(), &Cancel::never()).unwrap();
    assert_eq!(history(&engine).len(), 1);
    assert_eq!(status(&engine)["ready"], true);
    engine.close(None).unwrap();
}

#[test]
fn ledgers_are_isolated_per_agent_and_damaged_ledgers_are_reported_not_fatal() {
    let temp = scratch();
    let base = temp.path().join("db");
    let (_host, engine) = engine(temp.path(), false);
    drain(&engine, &alpha(), &Cancel::never()).unwrap();
    assert!(engine
        .jobs()
        .history(&beta(), serde_json::from_value(json!({})).unwrap())
        .unwrap()
        .is_empty());
    let jobs = status(&engine)["jobs"].clone();
    assert_eq!(jobs["agents"].as_array().unwrap().len(), 1);
    assert_eq!(jobs["agents"][0]["agentId"], "alpha");
    // Corrupt lines are counted, not fatal.
    let ledger = base.join("_jobs/alpha/ledger.jsonl");
    let mut text = fs::read_to_string(&ledger).unwrap();
    text.push_str("{broken\n[1]\n");
    fs::write(&ledger, &text).unwrap();
    let damaged = status(&engine);
    assert_eq!(damaged["jobs"]["ledger"], "ok");
    assert_eq!(damaged["jobs"]["agents"][0]["unreadableLines"], 2);
    assert_eq!(damaged["ready"], true);
    // An over-limit ledger is unavailable for display; readiness stays (pin).
    fs::create_dir_all(base.join("_jobs/beta")).unwrap();
    fs::write(base.join("_jobs/beta/ledger.jsonl"), "{}\n".repeat(50_002)).unwrap();
    let over = status(&engine);
    assert_eq!(over["jobs"]["ledger"], "unavailable");
    assert_eq!(over["ready"], true);
    engine.close(None).unwrap();
}

#[test]
fn status_after_close_makes_no_host_callback_and_dry_runs_create_nothing() {
    let temp = scratch();
    let base = temp.path().join("db");
    let (host, engine) = engine(temp.path(), false);
    let dry = engine
        .jobs()
        .run(
            JobName::EmbeddingDrain,
            &alpha(),
            serde_json::from_value(json!({"dryRun":true})).unwrap(),
            &Cancel::never(),
        )
        .unwrap();
    assert_eq!(dry.reason.as_deref(), Some("dry_run_unsupported"));
    assert!(!base.exists(), "a dry run created files");
    host.set_journal_backlog(Some(
        serde_json::from_value(json!({"entries":1,"oldestAt":null})).unwrap(),
    ));
    assert_eq!(status(&engine)["journal"]["entries"], 1);
    engine.close(None).unwrap();
    let closed = status(&engine);
    assert_eq!(closed["ready"], false);
    assert_eq!(closed["journal"], Value::Null, "{closed}");
    assert_eq!(
        closed["degraded"],
        json!({"reason":"closed","capability":"engine"})
    );
}

#[test]
fn close_during_job_recovery_stays_within_its_budget() {
    let temp = scratch();
    let base = temp.path().join("db");
    let (_host, engine) = engine(temp.path(), false);
    let agent_dir = base.join("_jobs/alpha");
    fs::create_dir_all(&agent_dir).unwrap();
    // A previous registry session (another process) still holds this agent's lifecycle lease.
    let held = TrustedDirectory::open(&agent_dir).unwrap();
    let lease = crate::store::kernel_lease::acquire(
        &held,
        "job-registry-session",
        &Cancel::never(),
        &mut || {},
    )
    .unwrap();
    let engine = Arc::new(engine);
    let (done, finished) = mpsc::channel();
    let runner = engine.clone();
    let worker = std::thread::spawn(move || {
        let result = runner.jobs().run(
            JobName::EmbeddingDrain,
            &alpha(),
            options("manual"),
            &Cancel::never(),
        );
        let _ = done.send(result.map(|run| run.run_id));
    });
    // The run waits in its session start (recovery) for the held lease.
    assert!(finished.recv_timeout(Duration::from_millis(300)).is_err());
    let started = Instant::now();
    let _ = engine.close(Some(Duration::from_millis(300)));
    assert!(started.elapsed() < Duration::from_millis(1500));
    let result = finished.recv_timeout(Duration::from_secs(2)).unwrap();
    assert!(result.is_err(), "a run admitted after close: {result:?}");
    worker.join().unwrap();
    assert!(!agent_dir.join("ledger.jsonl").exists());
    assert!(!agent_dir.join("running").exists());
    drop(lease);
}

fn hold(dir: &Path, name: &str) -> crate::store::kernel_lease::KernelLease {
    let held = TrustedDirectory::open(dir).unwrap();
    crate::store::kernel_lease::acquire(&held, name, &Cancel::never(), &mut || {}).unwrap()
}

#[test]
fn marker_admission_is_bounded_and_history_reads_real_lines_meanwhile() {
    let temp = scratch();
    let base = temp.path().join("db");
    let (_host, engine) = engine(temp.path(), false);
    drain(&engine, &alpha(), &Cancel::never()).unwrap();
    let engine = Arc::new(engine);
    // After a successful start, another holder keeps the agent's ledger writer lease.
    let lease = hold(&base.join("_jobs/alpha"), "job-ledger-writer");
    let (done, finished) = mpsc::channel();
    let started = Instant::now();
    let workers: Vec<_> = (0..8)
        .map(|_| {
            let runner = engine.clone();
            let done = done.clone();
            std::thread::spawn(move || {
                let _ = done.send(drain(&runner, &alpha(), &Cancel::never()).map(|_| ()));
            })
        })
        .collect();
    std::thread::sleep(Duration::from_millis(200));
    // While admissions wait, history reads the real ledger line directly.
    let (sent, listed) = mpsc::channel();
    let reader = engine.clone();
    std::thread::spawn(move || {
        let _ = sent.send(
            reader
                .jobs()
                .history(&alpha(), serde_json::from_value(json!({})).unwrap())
                .map(|runs| runs.len()),
        );
    });
    let listed = listed.recv_timeout(Duration::from_secs(1));
    assert!(matches!(listed, Ok(Ok(1))), "{listed:?}");
    // Every run waits one admission budget (5 s, wall-clock deadline), all in parallel. The
    // limit lies below two budgets (10 s), so a run that waited twice fails; the 4 s margin
    // over one budget covers scheduling delay under load, not extra waiting.
    let limit = started + Duration::from_secs(9);
    for _ in 0..8 {
        let left = limit.saturating_duration_since(Instant::now());
        let result = finished.recv_timeout(left);
        assert!(result.is_ok(), "an admission waited longer than one budget");
        refused(result.unwrap(), "job-session-busy");
    }
    for worker in workers {
        worker.join().unwrap();
    }
    // Nothing is left behind: other methods answer, the next run is admitted after release.
    assert_eq!(status(&engine)["ready"], true);
    drop(lease);
    drain(&engine, &alpha(), &Cancel::never()).unwrap();
    assert_eq!(history(&engine).len(), 2);
    engine.close(None).unwrap();
}

#[allow(clippy::panic, reason = "the injected fault is the test")]
#[test]
fn a_panicking_session_start_ends_its_watcher() {
    let temp = scratch();
    let (_host, engine) = engine(temp.path(), false);
    engine
        .jobs
        .set_prepare_fault(Arc::new(|| std::panic::panic_any("injected")));
    let engine = Arc::new(engine);
    let (done, finished) = mpsc::channel();
    let runner = engine.clone();
    std::thread::spawn(move || {
        let outcome = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            drain(&runner, &alpha(), &Cancel::never()).map(|_| ())
        }));
        let _ = done.send(outcome.is_err());
    });
    let panicked = finished.recv_timeout(Duration::from_secs(5));
    assert!(
        matches!(panicked, Ok(true)),
        "the run did not return: {panicked:?}"
    );
    engine.close(None).unwrap();
}

#[cfg(unix)]
#[test]
fn a_fifo_schema_marker_answers_status_at_once_as_unsupported() {
    let temp = scratch();
    let base = temp.path().join("db");
    let (_host, engine) = engine(temp.path(), false);
    fs::create_dir_all(&base).unwrap();
    let marker = std::ffi::CString::new(
        base.join("_schema.json")
            .into_os_string()
            .into_encoded_bytes(),
    )
    .unwrap();
    // SAFETY: a valid NUL-terminated path in a test-owned directory.
    assert_eq!(unsafe { libc::mkfifo(marker.as_ptr(), 0o600) }, 0);
    let engine = Arc::new(engine);
    let (done, finished) = mpsc::channel();
    let reader = engine.clone();
    std::thread::spawn(move || {
        let _ = done.send(status(&reader));
    });
    let answered = finished.recv_timeout(Duration::from_secs(5));
    assert!(answered.is_ok(), "status blocked on a FIFO marker");
    let answered = answered.unwrap();
    assert_eq!(answered["ready"], false);
    assert_eq!(
        answered["degraded"],
        json!({"reason":"schema-unsupported","capability":"store"})
    );
    // An oversized marker is unsupported too.
    let big = temp.path().join("big");
    fs::create_dir_all(big.join("db")).unwrap();
    fs::write(
        big.join("db/_schema.json"),
        format!(
            "{{\"schemaVersion\":\"1\",\"pad\":\"{}\"}}",
            "x".repeat(70_000)
        ),
    )
    .unwrap();
    let (_host, other) = self::engine(&big, false);
    assert_eq!(status(&other)["degraded"]["reason"], "schema-unsupported");
}

#[test]
fn a_slow_ledger_read_does_not_hold_other_status_callers() {
    let temp = scratch();
    let base = temp.path().join("db");
    let (_host, engine) = engine(temp.path(), false);
    for agent in ["alpha", "beta"] {
        fs::create_dir_all(base.join("_jobs").join(agent)).unwrap();
        fs::write(base.join("_jobs").join(agent).join("ledger.jsonl"), "{}\n").unwrap();
    }
    let gate = Arc::new(testkit::FixtureGate::default());
    let first = Arc::new(AtomicBool::new(true));
    let hook_gate = gate.clone();
    engine
        .jobs
        .set_ledger_read_hook(Arc::new(move |agent: &str| {
            if agent == "alpha" && first.swap(false, Ordering::AcqRel) {
                hook_gate.block();
            }
        }));
    let engine = Arc::new(engine);
    let slow = engine.clone();
    let blocked = std::thread::spawn(move || status(&slow));
    assert!(gate.wait_entered(Duration::from_secs(5)));
    let (done, finished) = mpsc::channel();
    let quick = engine.clone();
    std::thread::spawn(move || {
        let _ = done.send(status(&quick));
    });
    let other = finished.recv_timeout(Duration::from_secs(5));
    gate.release();
    assert!(
        other.is_ok(),
        "a slow ledger read held another status caller"
    );
    assert_eq!(
        other.unwrap()["jobs"]["agents"].as_array().unwrap().len(),
        2
    );
    blocked.join().unwrap();
    engine.close(None).unwrap();
}

#[test]
fn agent_sessions_and_health_projections_are_bounded() {
    let temp = scratch();
    let base = temp.path().join("db");
    let (_host, engine) = engine(temp.path(), false);
    for index in 0..(engine_jobs::MAX_AGENT_SESSIONS + 4) {
        let agent: AgentId = serde_json::from_value(json!(format!("agent-{index}"))).unwrap();
        drain(&engine, &agent, &Cancel::never()).unwrap();
        assert!(engine.jobs.open_sessions() <= engine_jobs::MAX_AGENT_SESSIONS);
    }
    // An evicted agent starts a fresh session and keeps its ledger.
    let first: AgentId = serde_json::from_value(json!("agent-0")).unwrap();
    drain(&engine, &first, &Cancel::never()).unwrap();
    assert_eq!(
        engine
            .jobs()
            .history(&first, serde_json::from_value(json!({})).unwrap())
            .unwrap()
            .len(),
        2
    );
    let jobs = status(&engine)["jobs"].clone();
    assert_eq!(jobs["ledger"], "ok");
    assert!(engine.jobs.cached_projections() <= crate::jobs::registry::MAX_HEALTH_PROJECTIONS);
    assert!(base.join("_jobs").is_dir());
    engine.close(None).unwrap();
}

#[test]
fn the_status_priority_table_puts_the_schema_after_composition_invalid() {
    use super::StatusRank as R;
    let documented = [
        R::Closed,
        R::CompositionInvalid,
        R::SchemaUnsupported,
        R::EmbeddingFailed,
        R::CaptureNotServed,
        R::EmbeddingWarming,
        R::RerankerFailed,
        R::RerankerLoading,
        R::CaptureDeferred,
        R::CompositionPending,
    ];
    for pair in documented.windows(2) {
        assert!(
            pair[0] < pair[1],
            "{:?} must outrank {:?}",
            pair[0],
            pair[1]
        );
    }
    // Through the engine: an unsupported marker wins over warming models.
    let temp = scratch();
    let base = temp.path().join("db");
    let (_host, engine) = engine(temp.path(), false);
    fs::create_dir_all(&base).unwrap();
    fs::write(base.join("_schema.json"), br#"{"schemaVersion":"2"}"#).unwrap();
    assert_eq!(engine.models().status().embedder.state, ModelState::Loading);
    assert_eq!(status(&engine)["degraded"]["reason"], "schema-unsupported");
}

/// A fixture body with a visible effect: it counts its runs and, on its first run, takes the
/// agent's ledger writer lease and keeps it, so the run's settle cannot finish.
struct Effect {
    runs: std::sync::atomic::AtomicUsize,
    dir: std::path::PathBuf,
    held: Mutex<Option<crate::store::kernel_lease::KernelLease>>,
}
impl crate::jobs::registry::JobBody for Effect {
    fn name(&self) -> JobName {
        JobName::GcRun
    }
    fn run(
        &self,
        _context: &crate::jobs::registry::JobContext,
        _cancel: &Cancel,
    ) -> Result<crate::jobs::registry::JobReport, EngineError> {
        if self.runs.fetch_add(1, Ordering::SeqCst) == 0 {
            *self.held.lock().unwrap() = Some(hold(&self.dir, "job-ledger-writer"));
        }
        Ok(crate::jobs::registry::JobReport::completed())
    }
}

fn gc(engine: &ProcessEngine) -> Result<JobRun, EngineError> {
    engine.jobs().run(
        JobName::GcRun,
        &alpha(),
        options("manual"),
        &Cancel::never(),
    )
}

#[test]
fn a_run_whose_body_ran_is_reported_as_started_never_as_busy() {
    let temp = scratch();
    let base = temp.path().join("db");
    let agent_dir = base.join("_jobs/alpha");
    let body = Arc::new(Effect {
        runs: std::sync::atomic::AtomicUsize::new(0),
        dir: agent_dir.clone(),
        held: Mutex::new(None),
    });
    let (_host, engine) = engine(temp.path(), false);
    engine
        .jobs
        .set_fixture_body(body.clone(), Duration::from_millis(200));
    // The body runs, then its settle cannot take the writer lease within its budget.
    let first = gc(&engine);
    assert_eq!(body.runs.load(Ordering::SeqCst), 1);
    assert!(
        matches!(first, Err(EngineError::Cancelled(_))),
        "a run whose body ran must not answer busy: {first:?}"
    );
    // The run stays started: its marker remains for the next session start.
    let markers: Vec<String> = fs::read_dir(agent_dir.join("running"))
        .unwrap()
        .map(|entry| entry.unwrap().file_name().into_string().unwrap())
        .collect();
    assert_eq!(markers.len(), 1, "{markers:?}");
    let first_id = markers[0].strip_suffix(".started").unwrap().to_owned();
    *body.held.lock().unwrap() = None;
    // The registry's rule for the next call: a new run is admitted and runs its body.
    let second = gc(&engine).unwrap();
    assert_eq!(body.runs.load(Ordering::SeqCst), 2);
    assert_ne!(second.run_id, first_id);
    engine.close(None).unwrap();
    // The next session start records the started run in the ledger as failed/crash.
    let (_host, again) = self::engine(temp.path(), false);
    again
        .jobs
        .set_fixture_body(body.clone(), Duration::from_millis(200));
    gc(&again).unwrap();
    let rows = again
        .jobs()
        .history(&alpha(), serde_json::from_value(json!({})).unwrap())
        .unwrap();
    let recovered = rows.iter().find(|run| run.run_id == first_id);
    assert!(recovered.is_some(), "the started run is in the ledger");
    let recovered = recovered.unwrap();
    let wire = serde_json::to_value(recovered).unwrap();
    assert_eq!(wire["outcome"], "failed", "{wire}");
    assert_eq!(wire["reason"], "crash", "{wire}");
    again.close(None).unwrap();
}

#[test]
fn the_budget_ending_right_after_the_marker_leaves_no_orphan_and_answers_busy() {
    // An admission that cannot take the writer lease within its budget writes no marker and
    // leaves none behind; the run is not started (busy) and the next one is admitted.
    let temp = scratch();
    let base = temp.path().join("db");
    let (_host, engine) = engine(temp.path(), false);
    drain(&engine, &alpha(), &Cancel::never()).unwrap();
    let lease = hold(&base.join("_jobs/alpha"), "job-ledger-writer");
    refused(
        drain(&engine, &alpha(), &Cancel::never()),
        "job-session-busy",
    );
    let running = base.join("_jobs/alpha/running");
    assert!(!running.exists() || fs::read_dir(&running).unwrap().next().is_none());
    drop(lease);
    drain(&engine, &alpha(), &Cancel::never()).unwrap();
    engine.close(None).unwrap();
}
