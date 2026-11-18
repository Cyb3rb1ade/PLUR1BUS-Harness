//! Parity mode B for the session store (P4-K K5a, plan P4-40): TypeScript writes `sessions.sqlite` at every schema version,
//! Rust opens it, migrates it, reads everything and writes through the public write methods, TypeScript reads the result with
//! the product code; the reverse direction starts from a file Rust created (`tests/core-parity/sessions-b-driver.ts`, on the
//! P4-02 helper). Needs Node (`PLUR1BUS_NODE` or `node` on PATH) with the workspace's TypeScript sources.
#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use plur1bus_core::approvals::js_json::J;
use plur1bus_core::budget::{Clock, UuidIds};
use plur1bus_core::sessions::compaction::{
    default_compaction, CompactionHooks, Compactor, SummarizerMode, SummaryMessage,
};
use plur1bus_core::sessions::pruning::{
    default_prune, Decider, NoPruneHooks, PruneConfig, ToolPruner,
};
use plur1bus_core::sessions::{
    BeginOptions, CreateSessionInput, ListFilter, NewSummary, PruneDetail, ReasoningChange,
    RewindTarget, RewindTrigger, SessionKind, SessionPatch, SessionStore, SummaryState,
};
use serde_json::{json, Value};
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::Arc;

const ALICE: &str = "user:v1:alice";

fn root() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../..")
}

fn driver(command: &str, dir: &Path) -> String {
    driver_args(command, dir, &[])
}

fn driver_args(command: &str, dir: &Path, rest: &[&str]) -> String {
    let node = std::env::var_os("PLUR1BUS_NODE").unwrap_or_else(|| "node".into());
    let output = Command::new(&node)
        .current_dir(root())
        .args([
            "--experimental-strip-types",
            "--conditions=source",
            "--no-warnings=ExperimentalWarning",
            "tests/core-parity/sessions-b-driver.ts",
            command,
        ])
        .arg(dir)
        .args(rest)
        .output()
        .unwrap_or_else(|e| {
            panic!("could not run Node {node:?}: {e}. Install Node and run `pnpm test:prep`.")
        });
    assert!(
        output.status.success(),
        "sessions-b-driver {command}: {}{}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
    String::from_utf8(output.stdout).unwrap()
}

struct At(i64);
impl Clock for At {
    fn now(&self) -> i64 {
        self.0
    }
}

fn open(path: &Path, now: i64) -> SessionStore {
    SessionStore::open(path, Arc::new(At(now)), Arc::new(UuidIds)).unwrap()
}

fn copy(dir: &Path, from: &str, to: &str) -> PathBuf {
    let src = dir.join(from);
    let dst = dir.join(to);
    std::fs::copy(&src, &dst).unwrap();
    for suffix in ["-wal", "-shm"] {
        let w = dir.join(format!("{from}{suffix}"));
        if w.exists() {
            std::fs::copy(&w, dir.join(format!("{to}{suffix}"))).unwrap();
        }
    }
    dst
}

/// Writes through the public write methods of a store: a session, a turn with an event, offers, a summary, a title change.
fn write_through(s: &mut SessionStore, title: &str) -> String {
    let session = s
        .create_session(&CreateSessionInput {
            title: Some(title.to_owned()),
            ..CreateSessionInput::new(SessionKind::Direct, "bernd", ALICE)
        })
        .unwrap();
    let begun = s
        .begin_turn(&session.id, "hello from rust", 4, &BeginOptions::default())
        .unwrap();
    s.append_event(
        &begun.turn.id,
        plur1bus_core::sessions::EventType::Delta,
        J::obj([("text", J::s("ru"))]),
    )
    .unwrap();
    s.complete_turn(&begun.turn.id, "rust reply", 3, None)
        .unwrap()
        .unwrap();
    s.remember_tool_offers(&session.id, &["file.read"]).unwrap();
    s.add_summary(&NewSummary {
        session_id: session.id.clone(),
        from_seq: 1,
        to_seq: 2,
        text: "rust summary".into(),
        tokens: 2,
        tier: 1,
        state: SummaryState::Applied,
    })
    .unwrap();
    s.update_session(
        &session.id,
        &SessionPatch {
            title: Some(format!("{title} (renamed)")),
            pinned: Some(true),
            memory_mode: None,
        },
    )
    .unwrap();
    s.update_session(
        &session.id,
        &SessionPatch {
            title: Some(title.to_owned()),
            pinned: Some(false),
            memory_mode: None,
        },
    )
    .unwrap();
    session.id
}

#[test]
fn typescript_and_rust_share_session_files_in_both_directions() {
    let dir = tempfile_dir();
    driver("prepare", &dir);
    let manifest: Value =
        serde_json::from_str(&std::fs::read_to_string(dir.join("manifest.json")).unwrap()).unwrap();
    let now = manifest["now"].as_i64().unwrap();
    let version = manifest["version"].as_u64().unwrap() as u32;
    assert_eq!(version, plur1bus_core::sessions::migrations::SCHEMA_VERSION);
    let mut results = json!({"versions": {}});

    // Every version: Rust migrates the file, reads what TypeScript put there, writes.
    for v in 1..=version {
        let path = copy(
            &dir,
            &format!("sessions-v{v}.sqlite"),
            &format!("sessions-v{v}-rust.sqlite"),
        );
        let mut s = open(&path, now);
        assert_eq!(
            s.user_version().unwrap(),
            version,
            "v{v} is migrated to the latest version"
        );
        let mine = s
            .get_session(&format!("ses_b{v}"))
            .unwrap()
            .expect("the TypeScript session");
        assert_eq!(mine.title, format!("title v{v}"));
        let msgs = s.list_messages(&mine.id, &Default::default()).unwrap();
        assert_eq!(
            msgs.iter().map(|m| m.text.clone()).collect::<Vec<_>>(),
            vec![
                format!("alpha question v{v}"),
                format!("beta answer \u{fc}ber v{v}")
            ]
        );
        let hits = s
            .search_messages(
                &ListFilter {
                    owner: ALICE.into(),
                    ..Default::default()
                },
                "alpha",
            )
            .unwrap();
        assert_eq!(
            hits.len(),
            1,
            "v{v}: the full-text index covers the TypeScript rows"
        );
        let hits = s
            .search_messages(
                &ListFilter {
                    owner: ALICE.into(),
                    ..Default::default()
                },
                "\u{fc}ber",
            )
            .unwrap();
        assert_eq!(hits.len(), 1, "v{v}: unicode is found");
        let turns = s.list_turns(&mine.id).unwrap();
        assert_eq!(turns.len(), 1);
        let id = write_through(&mut s, &format!("rust on v{v}"));
        results["versions"][v.to_string()] = json!({"session": id});
    }

    // The latest version written by the product code.
    let ts_path = copy(&dir, "sessions-ts.sqlite", "sessions-ts-rust.sqlite");
    let ts_session = manifest["tsSession"].as_str().unwrap().to_owned();
    let ts_message;
    {
        let mut s = open(&ts_path, now);
        let turns = s.list_turns(&ts_session).unwrap();
        assert_eq!(turns.len(), 1);
        let msgs = s.list_messages(&ts_session, &Default::default()).unwrap();
        assert_eq!(msgs.len(), 2);
        ts_message = msgs[1].id.clone();
        assert_eq!(
            s.tool_offers(&ts_session).unwrap(),
            vec!["file.read".to_owned(), "exec.run".to_owned()]
        );
        assert_eq!(s.token_calibration("m").unwrap(), Some(1.5));
        assert_eq!(s.list_summaries(&ts_session, None).unwrap().len(), 1);
        let events = s.list_events(&ts_session, 0, 100).unwrap();
        assert_eq!(
            events.iter().map(|e| e.kind.as_str()).collect::<Vec<_>>(),
            ["turn.started", "delta", "turn.completed"]
        );
        let b = s
            .begin_turn(&ts_session, "rust asks next", 3, &BeginOptions::default())
            .unwrap();
        s.complete_turn(&b.turn.id, "rust answers", 2, None)
            .unwrap()
            .unwrap();
        s.remember_tool_offers(&ts_session, &["web.fetch"]).unwrap();
        s.set_token_factor("m", 1.25).unwrap();
        s.record_message_usage(&ts_message, "m", 9).unwrap();
        s.set_tool_visibility(
            &ts_session,
            "r2",
            false,
            "shown",
            Some(&PruneDetail {
                truncate: false,
                confidence: 0.25,
                tokens_saved: 1,
            }),
        )
        .unwrap();
        s.add_summary(&NewSummary {
            session_id: ts_session.clone(),
            from_seq: 3,
            to_seq: 4,
            text: "rust adds".into(),
            tokens: 1,
            tier: 1,
            state: SummaryState::Prepared,
        })
        .unwrap();
        s.set_model_profile(
            &ts_session,
            "fast",
            0,
            &ReasoningChange::Keep,
            Some(ALICE),
            None,
        )
        .unwrap();
        s.freeze_prompt_snapshot(&ts_session, "memory text")
            .unwrap();
    }

    // The reverse direction: a file Rust creates and fills, with a rewind.
    let fresh = dir.join("sessions-fresh-rust.sqlite");
    let fresh_session;
    {
        let mut s = open(&fresh, now);
        assert_eq!(s.user_version().unwrap(), version);
        fresh_session = write_through(&mut s, "fresh rust");
        let b = s
            .begin_turn(
                &fresh_session,
                "second rust turn",
                3,
                &BeginOptions::default(),
            )
            .unwrap();
        s.complete_turn(&b.turn.id, "second reply", 2, None)
            .unwrap()
            .unwrap();
        s.set_token_factor("m", 2.0).unwrap();
        s.set_tool_visibility(
            &fresh_session,
            "r1",
            true,
            "old",
            Some(&PruneDetail {
                truncate: true,
                confidence: 0.5,
                tokens_saved: 7,
            }),
        )
        .unwrap();
        let rec = s
            .rewind_path(
                &fresh_session,
                plur1bus_core::sessions::RewindInput {
                    to: RewindTarget::Last,
                    lesson: "rewind lesson".into(),
                    actor: ALICE.into(),
                    trigger: RewindTrigger::User,
                    expected_event_seq: None,
                    audit: None,
                    command_turn_id: None,
                    reservation: None,
                },
            )
            .unwrap();
        assert_eq!(rec.hidden_from_seq, 3);
    }
    results["session"] = json!(fresh_session);
    results["tsMessage"] = json!(ts_message);
    std::fs::write(dir.join("rust-results.json"), results.to_string()).unwrap();

    // TypeScript continues in a copy of the file Rust made; Rust reads it again and writes once more.
    driver("continue", &dir);
    {
        let cont = copy(
            &dir,
            "sessions-fresh-continued.sqlite",
            "sessions-fresh-continued-rust.sqlite",
        );
        let mut s = open(&cont, now + 2000);
        assert_eq!(
            s.get_session(&fresh_session).unwrap().unwrap().title,
            "renamed by typescript"
        );
        assert!(s.get_session(&fresh_session).unwrap().unwrap().pinned);
        let turns = s.list_turns(&fresh_session).unwrap();
        assert_eq!(turns.len(), 3, "two Rust turns and the TypeScript one");
        assert_eq!(
            s.tool_offers(&fresh_session).unwrap(),
            vec!["file.read".to_owned(), "web.fetch".to_owned()]
        );
        let b = s
            .begin_turn(&fresh_session, "rust again", 2, &BeginOptions::default())
            .unwrap();
        s.complete_turn(&b.turn.id, "again", 1, None)
            .unwrap()
            .unwrap();
    }

    let out: Value = serde_json::from_str(&driver("verify", &dir)).unwrap();
    assert_eq!(out["refUserVersion"], version, "{out}");
    assert_eq!(out["refJournal"], "wal");
    for v in 1..=version {
        let m = &out["migrated"][v.to_string()];
        assert_eq!(
            m["sameSchema"], true,
            "a v{v} file migrated by Rust has the schema TypeScript creates: {m}"
        );
        assert_eq!(m["userVersion"], version);
        assert_eq!(m["integrity"], "ok");
        assert_eq!(m["fk"], 0);
        assert_eq!(m["title"], format!("title v{v}"));
        assert_eq!(m["sessions"], 2, "the TypeScript row and the Rust row: {m}");
        assert_eq!(m["rustSession"], format!("rust on v{v}"));
        assert_eq!(m["rustTurns"], json!(["completed"]));
        assert_eq!(
            m["rustMessages"],
            json!([["user", "hello from rust"], ["assistant", "rust reply"]])
        );
        assert_eq!(
            m["rustEvents"],
            json!(["turn.started", "delta", "turn.completed"])
        );
        assert_eq!(m["hits"], 1);
        assert_eq!(m["journal"], "wal");
    }
    assert_eq!(
        out["fresh"]["sameSchema"], true,
        "a file Rust creates has the schema TypeScript creates: {out}"
    );
    assert_eq!(out["fresh"]["userVersion"], version);
    assert_eq!(out["fresh"]["integrity"], "ok");
    assert_eq!(out["fresh"]["journal"], "wal");
    assert_eq!(out["fresh"]["session"], "fresh rust");
    assert_eq!(out["fresh"]["offers"], json!(["file.read"]));
    assert_eq!(out["fresh"]["summaries"], json!(["rust summary"]));
    assert_eq!(out["fresh"]["rewinds"], 1);
    assert_eq!(out["fresh"]["factor"], 2.0);
    assert_eq!(
        out["fresh"]["visibility"],
        json!([["r1", true, "truncate"]])
    );
    assert!(
        out["fresh"]["hits"]
            .as_array()
            .unwrap()
            .iter()
            .any(|h| h.as_str().unwrap().contains("[rust]")),
        "{out}"
    );
    assert_eq!(out["ts"]["sameSchema"], true, "{out}");
    assert_eq!(out["ts"]["integrity"], "ok");
    assert_eq!(out["ts"]["session"], "ts session");
    assert_eq!(out["ts"]["turns"], json!(["completed", "completed"]));
    assert_eq!(
        out["ts"]["offers"],
        json!(["file.read", "exec.run", "web.fetch"])
    );
    assert_eq!(out["ts"]["factor"], 1.25);
    assert_eq!(out["ts"]["usage"], 9);
    assert_eq!(out["ts"]["summaries"], json!(["a summary", "rust adds"]));
    assert_eq!(out["continued"]["turns"], 4, "{out}");
    assert_eq!(out["continued"]["title"], "renamed by typescript");
    assert_eq!(out["continued"]["integrity"], "ok");
}

fn tempfile_dir() -> PathBuf {
    let dir = std::env::temp_dir().join(format!("p4k-sessions-b-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    dir
}

#[test]
fn a_file_from_a_newer_core_is_refused_and_left_untouched() {
    let dir = tempfile_dir().join("newer");
    std::fs::create_dir_all(&dir).unwrap();
    let path = dir.join("sessions.sqlite");
    {
        let c = rusqlite_conn(&path);
        c.execute_batch("PRAGMA user_version = 99; CREATE TABLE marker (x INTEGER)")
            .unwrap();
    }
    let before = std::fs::read(&path).unwrap();
    let err = SessionStore::open(&path, Arc::new(At(1)), Arc::new(UuidIds))
        .err()
        .expect("refused");
    assert_eq!(err.reason.as_deref(), Some("schema-too-new"));
    assert_eq!(std::fs::read(&path).unwrap(), before);
}

fn rusqlite_conn(path: &Path) -> plur1bus_store::rusqlite::Connection {
    plur1bus_store::rusqlite::Connection::open(path).unwrap()
}

// ---- maintenance (K5b): one side fills, one side compacts and prunes, the other keeps reading and writing --------------------

const NOW_MS: i64 = 1_791_288_000_000;

fn maint_dir() -> PathBuf {
    let dir = std::env::temp_dir().join(format!("p4k-sessions-maint-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    dir
}

fn tokens_of(t: &str) -> i64 {
    (t.encode_utf16().count() as f64 / 4.0).ceil() as i64
}

/// The recipe the TypeScript driver uses: twelve turns, tool pairs with long outputs in three of them.
fn fill_maintenance(s: &mut SessionStore, sid: &str) {
    for i in 0..12usize {
        let user = format!("q{i} {}", "u".repeat(300 + 7 * i));
        let assistant = format!("a{i} {}", "a".repeat(300 + 5 * i));
        let b = s
            .begin_turn(sid, &user, tokens_of(&user), &BeginOptions::default())
            .unwrap();
        if i == 3 || i == 5 || i == 8 {
            s.append_event(
                &b.turn.id,
                plur1bus_core::sessions::EventType::ToolCall,
                J::obj([
                    ("id", J::s(&format!("c{i}"))),
                    ("name", J::s("file.read")),
                    ("args", J::obj([("path", J::s(&format!("f{i}.txt")))])),
                ]),
            )
            .unwrap();
            s.append_event(
                &b.turn.id,
                plur1bus_core::sessions::EventType::ToolResult,
                J::obj([
                    ("id", J::s(&format!("c{i}"))),
                    ("output", J::s(&"o".repeat(2000 + i))),
                ]),
            )
            .unwrap();
        }
        s.complete_turn(&b.turn.id, &assistant, tokens_of(&assistant), None)
            .unwrap()
            .unwrap();
    }
}

struct Sum;
impl CompactionHooks for Sum {
    fn has_summarizer(&self) -> bool {
        true
    }
    fn summarize(
        &mut self,
        _store: &mut SessionStore,
        messages: &[SummaryMessage],
        _max_tokens: i64,
        _session_id: &str,
        _caller: Option<&J>,
    ) -> Result<String, String> {
        Ok(format!(
            "SUM:{}-{}:{}",
            messages[0].seq,
            messages[messages.len() - 1].seq,
            messages.len()
        ))
    }
}

fn maint_compactor() -> Compactor {
    let pruner = ToolPruner::new(
        PruneConfig {
            decider: Decider::Heuristic,
            keep_last_turns: 2,
            ..default_prune()
        },
        Box::new(NoPruneHooks),
    )
    .unwrap();
    let mut cfg = default_compaction(1000);
    cfg.summarizer = Some(SummarizerMode::Llm);
    Compactor::new(cfg, Box::new(Sum), Some(pruner)).unwrap()
}

/// The same upkeep the driver runs: a pruning run, the summary built after the turn, a new question, the swap, the answer,
/// a pruning run.
fn maintain(s: &mut SessionStore, sid: &str) -> Value {
    let mut comp = maint_compactor();
    let pruned_before = comp.pruner_mut().unwrap().run(s, sid).unwrap();
    let prepared = comp.after_turn(s, sid, None).unwrap();
    let question = format!("newest question {}", "n".repeat(200));
    let b = s
        .begin_turn(
            sid,
            &question,
            tokens_of(&question),
            &BeginOptions::default(),
        )
        .unwrap();
    let view = comp.prepare(s, sid).unwrap();
    s.complete_turn(&b.turn.id, "newest answer", 4, None)
        .unwrap()
        .unwrap();
    let pruned = comp.pruner_mut().unwrap().run(s, sid).unwrap();
    json!({"prepared": {"prepared": prepared}, "tokens": view.tokens, "swapped": view.compaction.swapped,
        "prunedBefore": pruned_before, "pruned": pruned})
}

fn maint_view(s: &SessionStore, sid: &str) -> Value {
    let v = maint_compactor().view(s, sid).unwrap();
    json!({"tokens": v.tokens,
        "summaries": v.summaries.iter().map(|x| json!([x.from_seq, x.to_seq, x.text])).collect::<Vec<_>>(),
        "messages": v.messages.iter().map(|m| json!([m.seq, m.role.as_str(), m.text.encode_utf16().count()])).collect::<Vec<_>>(),
        "hidden": v.hidden.iter().map(|h| h.reference.clone()).collect::<Vec<_>>()})
}

fn json_of(text: String) -> Value {
    serde_json::from_str(&text).unwrap()
}

#[test]
fn maintenance_agrees_across_languages_in_both_directions() {
    let dir = maint_dir();

    // TypeScript fills and compacts one copy; Rust compacts another copy of the same file; the two must be the same file.
    let a = json_of(driver("maint-fill", &dir));
    let sid = a["session"].as_str().unwrap().to_owned();
    let rust_a = copy(&dir, "maint-a.sqlite", "maint-a-rust.sqlite");
    {
        let mut s = open(&rust_a, NOW_MS);
        let ran = maintain(&mut s, &sid);
        assert_eq!(ran, a["ran"], "Rust compacts and prunes as TypeScript does");
        assert!(
            ran["swapped"] == true && ran["prunedBefore"].as_i64().unwrap() >= 3,
            "{ran}"
        );
    }
    let same = json_of(driver_args(
        "maint-same",
        &dir,
        &["maint-a-ts.sqlite", "maint-a-rust.sqlite", "maint-a.json"],
    ));
    assert_eq!(same["same"], true, "{same}");
    assert!(
        same["summaries"].as_i64().unwrap() >= 1 && same["hidden"].as_i64().unwrap() >= 3,
        "{same}"
    );
    // TypeScript reads the view of the file Rust compacted as Rust does, and keeps writing into it.
    {
        let s = open(&rust_a, NOW_MS);
        let ts_view = json_of(driver_args(
            "maint-view",
            &dir,
            &["maint-a-rust.sqlite", &sid],
        ));
        assert_eq!(
            maint_view(&s, &sid),
            ts_view,
            "the same context view of the same file"
        );
    }
    let turns_before = {
        let s = open(&rust_a, NOW_MS);
        s.list_turns(&sid).unwrap().len()
    };
    let cont = json_of(driver_args(
        "maint-continue",
        &dir,
        &["maint-a-rust.sqlite", &sid],
    ));
    assert_eq!(
        cont["turns"].as_u64().unwrap() as usize,
        turns_before + 1,
        "{cont}"
    );
    {
        let s = open(&rust_a, NOW_MS + 3000);
        assert_eq!(s.list_turns(&sid).unwrap().len(), turns_before + 1);
        let last = s
            .list_messages(&sid, &Default::default())
            .unwrap()
            .pop()
            .unwrap();
        assert_eq!(last.text, "typescript answer");
    }

    // The reverse: Rust fills, TypeScript compacts a copy, Rust compacts another; then Rust reads and writes the TypeScript file.
    let filled = dir.join("maint-b-filled.sqlite");
    let sid_b = {
        let mut s = open(&filled, NOW_MS);
        let id = s
            .create_session(&CreateSessionInput {
                title: Some("maintenance".to_owned()),
                ..CreateSessionInput::new(SessionKind::Direct, "bernd", ALICE)
            })
            .unwrap()
            .id;
        fill_maintenance(&mut s, &id);
        id
    };
    std::fs::write(
        dir.join("maint-b-rust-filled.json"),
        json!({"session": sid_b}).to_string(),
    )
    .unwrap();
    let b = json_of(driver("maint-compact", &dir));
    assert_eq!(b["session"], sid_b.as_str());
    let rust_b = copy(&dir, "maint-b-filled.sqlite", "maint-b-rust.sqlite");
    {
        let mut s = open(&rust_b, NOW_MS);
        assert_eq!(maintain(&mut s, &sid_b), b["ran"], "{b}");
    }
    let same = json_of(driver_args(
        "maint-same",
        &dir,
        &[
            "maint-b-ts.sqlite",
            "maint-b-rust.sqlite",
            "maint-b-rust-filled.json",
        ],
    ));
    assert_eq!(same["same"], true, "{same}");
    assert!(
        same["summaries"].as_i64().unwrap() >= 1 && same["hidden"].as_i64().unwrap() >= 3,
        "{same}"
    );
    let ts_file = dir.join("maint-b-ts.sqlite");
    {
        let s = open(&ts_file, NOW_MS);
        let ts_view = json_of(driver_args(
            "maint-view",
            &dir,
            &["maint-b-ts.sqlite", &sid_b],
        ));
        assert_eq!(
            maint_view(&s, &sid_b),
            ts_view,
            "Rust reads the compacted TypeScript file as TypeScript does"
        );
    }
    {
        let mut s = open(&ts_file, NOW_MS + 4000);
        let b2 = s
            .begin_turn(&sid_b, "rust after typescript", 6, &BeginOptions::default())
            .unwrap();
        s.complete_turn(&b2.turn.id, "rust answer", 3, None)
            .unwrap()
            .unwrap();
        let mut comp = maint_compactor();
        comp.after_turn(&mut s, &sid_b, None).unwrap();
    }
    let count = json_of(driver_args(
        "maint-count",
        &dir,
        &["maint-b-ts.sqlite", &sid_b],
    ));
    assert_eq!(count["turns"], 14, "{count}");
    assert_eq!(count["last"], "rust answer");
}
